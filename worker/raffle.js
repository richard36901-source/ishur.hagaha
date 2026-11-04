/* ============================================================================
   ishur.io · raffle.js · review raffle (Richard 03/11/2026)
   ----------------------------------------------------------------------------
   feedback.html → after the 1–10 scores and the free text: "מגישים = נכנסים
   להגרלה". Tickets: a video review = 2, a Google review (click-through +
   "סיימתי", a claim only) = 1, both = 3. One entry per phone per event.
   Each ticket is a unique random 4-digit number (1000–9999).

   Claims (03/11, coordinator): the video = VideoAsk (brain testimonialLink)
   opened + "שלחתי"; Google = brain reviewLink opened + "סיימתי". Both are
   claims; Richard ticks "אומת" per entry in the ops tab and only verified
   tickets enter the draw.

   Storage: KV raffle:<id> (id = <event token>.<phone>) + index raffle:idx,
   ticket locks raffle:t:<n>, winner raffle:winner. When OPS_DB is bound the
   same row is mirrored into D1 raffle_entries (migrations/0006_raffle.sql)
   and the admin list reads D1 first, KV on any failure.

   Config: RAFFLE below mirrors config.js RAFFLE (a test keeps them equal).
   env.RAFFLE (JSON var) overrides for staging/tests. on:false → every route
   answers {on:false} and the page shows the old flow.

   Sends: the ticket numbers go out on WhatsApp ONLY when the entrant wrote
   to us within the last 24h (free-text window) and it is 09:00–21:00 Israel
   time, not paused, not opted out. Otherwise they are shown on screen only.
   The draw is admin-only, typed confirm 'draw', never automatic.
   ========================================================================== */
import { recordChange } from './changes.js';
import { lastInboundTs } from './inbound.js';

export const RAFFLE = {
  on: false,
  prize_he: '₪1,000 או PlayStation 5 חדש',
  draw_at: '2027-06-01T15:00:00Z',
  google_review_url: '',   // '' → the brain sheet's reviewLink at runtime; still empty → Google step hidden
  video_url: '',           // '' → the brain sheet's testimonialLink (VideoAsk) at runtime
  video_max_sec: 60,
};
export const TICKETS = { video: 2, google: 1 };
export const DRAW_CONFIRM = 'draw';
const IDX = 'raffle:idx', WIN = 'raffle:winner';

/* config + the live links from the brain sheet (Richard changes them there) */
export async function raffleCfgLive(env, d) {
  const c = raffleCfg(env);
  if ((!c.google_review_url || !c.video_url) && d && d.getBrain) {
    const b = await d.getBrain(env).catch(() => null) || {};
    if (!c.google_review_url) c.google_review_url = httpsOr(b.reviewLink);
    if (!c.video_url) c.video_url = httpsOr(b.testimonialLink);
  }
  return c;
}
const httpsOr = v => /^https:\/\//.test(String(v || '').trim()) ? String(v).trim() : '';
export function raffleCfg(env = {}) {
  let o = env.RAFFLE;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const c = { ...RAFFLE, ...(o && typeof o === 'object' ? o : {}) };
  c.on = c.on === true || c.on === 'true';
  c.video_max_sec = Math.max(5, Math.min(300, Number(c.video_max_sec) || 60));
  c.google_review_url = httpsOr(c.google_review_url);
  c.video_url = httpsOr(c.video_url);
  return c;
}
/* what the page may see */
export function publicCfg(c) {
  if (!c.on) return { ok: true, on: false };
  return { ok: true, on: true, prize_he: c.prize_he, draw_at: c.draw_at, google: !!c.google_review_url, google_review_url: c.google_review_url, video: !!c.video_url, video_url: c.video_url, video_max_sec: c.video_max_sec, tickets: TICKETS, drawn: false };
}

/* the count rule: video 2, google 1, both 3 (Google counts only when the URL is configured) */
export function ticketCount(entry, c = { google_review_url: 'x' }) {
  const v = !!(entry && (entry.video_claimed_at || entry.video_media || entry.video_link));
  const g = !!(entry && entry.google_claimed_at && c.google_review_url);
  return (v ? TICKETS.video : 0) + (g ? TICKETS.google : 0);
}

/* unbiased uniform integer in [0, n) from crypto */
export function randInt(n, rng = crypto) {
  if (!(n > 0)) throw new Error('n');
  const lim = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  for (;;) { rng.getRandomValues(a); if (a[0] < lim) return a[0] % n; }
}
export function newTicketNumber(rng = crypto) { return String(1000 + randInt(9000, rng)); }

export function entryId(token, phone) { return `${String(token).toLowerCase()}.${phone}`; }


async function kvJson(env, k) { try { return JSON.parse(await env.RATE.get(k)) || null; } catch { return null; } }
async function readIdx(env) { const a = await kvJson(env, IDX); return Array.isArray(a) ? a : []; }

/* give `entry` exactly ticketCount() tickets, adding new unique numbers only (existing ones never change) */
export async function topUpTickets(env, entry, c, rng = crypto) {
  entry.tickets = Array.isArray(entry.tickets) ? entry.tickets : [];
  entry.ticket_src = entry.ticket_src || {};
  const added = [];
  const have = src => entry.tickets.filter(t => entry.ticket_src[t] === src).length;
  const need = [];
  if (entry.video_claimed_at || entry.video_media || entry.video_link) for (let i = have('video'); i < TICKETS.video; i++) need.push('video');
  if (entry.google_claimed_at && c.google_review_url) for (let i = have('google'); i < TICKETS.google; i++) need.push('google');
  for (const src of need) {
    let n = '', tries = 0;
    do { n = newTicketNumber(rng); tries++; } while ((await env.RATE.get('raffle:t:' + n)) && tries < 200);
    if (tries >= 200) throw new Error('no-free-ticket');
    await env.RATE.put('raffle:t:' + n, entry.id);
    entry.tickets.push(n); entry.ticket_src[n] = src; added.push(n);
  }
  return added;
}

const D1_COLS = ['id', 'token', 'phone', 'name', 'who', 'nps', 'exp', 'text', 'video_media', 'video_link', 'video_claimed_at', 'video_verified', 'google_claimed_at', 'google_verified', 'tickets_json', 'created_at', 'updated_at', 'ip'];
async function saveEntry(env, e) {
  e.updated_at = new Date().toISOString();
  await env.RATE.put('raffle:' + e.id, JSON.stringify(e));
  const idx = await readIdx(env);
  if (!idx.includes(e.id)) { idx.push(e.id); await env.RATE.put(IDX, JSON.stringify(idx)); }
  if (env.OPS_DB) {
    const row = { ...e, tickets_json: JSON.stringify({ t: e.tickets || [], src: e.ticket_src || {} }), video_verified: e.video_verified ? 1 : 0, google_verified: e.google_verified ? 1 : 0, nps: e.rating ? e.rating.nps : null, exp: e.rating ? e.rating.exp : null };
    try { await env.OPS_DB.prepare(`INSERT OR REPLACE INTO raffle_entries (${D1_COLS.join(',')}) VALUES (${D1_COLS.map(() => '?').join(',')})`).bind(...D1_COLS.map(k => row[k] ?? null)).run(); } catch {}
  }
}
export async function listEntries(env) {
  if (env.OPS_DB) {
    try {
      const r = await env.OPS_DB.prepare('SELECT * FROM raffle_entries ORDER BY created_at DESC').all();
      return (r.results || []).map(x => { const tj = JSON.parse(x.tickets_json || '{}'); return { ...x, video_verified: !!x.video_verified, google_verified: !!x.google_verified, rating: { nps: x.nps, exp: x.exp }, tickets: tj.t || [], ticket_src: tj.src || {} }; });
    } catch {}
  }
  const ids = await readIdx(env);
  const out = (await Promise.all(ids.map(id => kvJson(env, 'raffle:' + id)))).filter(Boolean);
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function ilHour(now = Date.now()) { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(now))) % 24; }
/* may we send the numbers on WhatsApp? only inside an open conversation */
export async function canWhatsApp(env, phone, now = Date.now()) {
  if (!phone) return 'no-phone';
  if (await env.RATE.get('paused')) return 'paused';
  if ((await env.RATE.get('optout:' + phone)) || (await env.RATE.get('block:' + phone))) return 'optout';
  const conv = await kvJson(env, 'conv:' + phone);
  const t = lastInboundTs(conv);
  if (!t || now - t > 24 * 3600e3) return 'no-open-conversation';
  const h = ilHour(now); if (h < 9 || h >= 21) return 'quiet-hours';
  return '';
}
export function drawDateHe(iso) {
  try { return new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date(iso)); } catch { return String(iso).slice(0, 10); }
}
export function ticketsText(c, tickets) {
  return `תודה שהשתתפתם בהגרלה של ishur.io 🎉\nמספרי הכרטיסים שלכם: ${tickets.join(', ')}\nההגרלה: ${drawDateHe(c.draw_at)} · הפרס: ${c.prize_he}\nתנאי ההגרלה: https://ishur.io/raffle-terms.html`;
}

/* ── public routes: /api/raffle/config · /api/raffle/enter · /api/raffle/claim-google ── */
export async function handleRaffle(request, env, origin, url, d) {
  const c = await raffleCfgLive(env, d);
  const path = url.pathname.replace(/^\/api\/raffle\//, '');
  if (path === 'config' && request.method === 'GET') {
    const p = publicCfg(c);
    if (c.on && env.RATE) p.drawn = !!(await env.RATE.get(WIN));
    return d.okJson(p, origin);
  }
  if (request.method !== 'POST' || (path !== 'enter' && path !== 'claim-google')) return d.deny(404, 'unknown-raffle-route', origin);
  if (!c.on) return d.deny(409, 'raffle-off', origin);
  if (!env.RATE) return d.deny(503, 'no-store', origin);
  if (await env.RATE.get(WIN)) return d.deny(409, 'raffle-closed', origin);
  if (Date.now() > Date.parse(c.draw_at)) return d.deny(409, 'raffle-closed', origin);
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  const token = String(b.token || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{20,40}$/.test(token)) return d.deny(400, 'bad-token', origin);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (d.overBudget && await d.overBudget(env, 'rl:raffle:' + token, 30, 3600)) return d.deny(429, 'slow-down', origin);
  const raw = await d.fetchSnapshot(env).catch(() => null);
  const ev = ((raw && raw.events && raw.events.values) || []).find(r => String((r || [])[1] || '').trim().toLowerCase() === token);
  if (!ev) return d.deny(404, 'bad-token', origin);
  const who = String(b.who || '') === '2' ? '2' : '';
  /* the host's phone is on the event; the partner (p=2) types theirs */
  const phone = who ? d.normPhone(b.phone || '') : d.normPhone(ev[3] || '');
  if (!/^\d{11,15}$/.test(phone)) return d.deny(400, 'bad-phone', origin);
  const name = (who ? String(b.name || '') : String(ev[2] || b.name || '')).trim().slice(0, 80);
  const id = entryId(token, phone);
  const fb = await kvJson(env, 'fb:' + token + (who ? ':2' : '')) || {};
  let e = await kvJson(env, 'raffle:' + id);
  const now = new Date().toISOString();
  if (!e) e = { id, token, phone, name, who: who ? 2 : 1, rating: { nps: fb.nps || null, exp: fb.exp || null }, text: String(fb.note || '').slice(0, 1500), video_media: '', video_link: '', video_claimed_at: '', video_verified: false, google_claimed_at: '', google_verified: false, tickets: [], created_at: now, ip };
  if (name && !e.name) e.name = name;
  if (fb.nps) e.rating = { nps: fb.nps, exp: fb.exp };
  if (fb.note) e.text = String(fb.note).slice(0, 1500);
  /* enter = the video (VideoAsk) claim: opened the link and pressed "שלחתי" */
  if (path === 'enter') {
    if (!c.video_url) return d.deny(409, 'video-off', origin);
    if (b.done !== true) return d.deny(400, 'confirm-done', origin);
    if (!e.video_claimed_at) e.video_claimed_at = now;
  } else {
    if (!c.google_review_url) return d.deny(409, 'google-off', origin);
    if (b.done !== true) return d.deny(400, 'confirm-done', origin);
    if (!e.google_claimed_at) e.google_claimed_at = now;
  }
  let added;
  try { added = await topUpTickets(env, e, c); } catch { return d.deny(503, 'no-free-ticket', origin); }
  await saveEntry(env, e);
  let wa = 'nothing-new';
  if (added.length) {
    wa = await canWhatsApp(env, phone);
    if (!wa && d.sendText) {
      const r = await d.sendText(env, phone, ticketsText(c, e.tickets), 'client', { who: 'הגרלת ביקורות', token }).catch(() => null);
      wa = r && r.ok ? 'sent' : 'send-failed';
    }
    if (d.slackSend) await d.slackSend(env, `🎟️ *הגרלה* · ${e.name || phone} · ${path === 'enter' ? 'סרטון' : 'ביקורת בגוגל'} → כרטיסים ${e.tickets.join(', ')}`, { urgent: false, oneoff: true }).catch(() => {});   /* oneoff: one raffle entry */
  }
  return d.okJson({ ok: true, tickets: e.tickets, added, video: !!e.video_claimed_at, google: !!e.google_claimed_at, draw_at: c.draw_at, prize_he: c.prize_he, whatsapp: wa === 'sent' }, origin);
}

/* ── admin: GET /api/ops/raffle · POST /api/ops/raffle/draw ── */
export async function buildRaffle(env, d) {
  const c = await raffleCfgLive(env, d);
  const entries = await listEntries(env);
  const tickets = entries.reduce((s, e) => s + (e.tickets || []).length, 0);
  return { ok: true, config: { ...c }, entries, counts: { entries: entries.length, tickets, video: entries.filter(e => e.video_claimed_at).length, google: entries.filter(e => e.google_claimed_at).length, verified_tickets: entries.reduce((s, e) => s + verifiedTickets(e).length, 0) }, winner: await kvJson(env, WIN), confirm_word: DRAW_CONFIRM };
}
/* a ticket is in the draw only after a person checked its claim (the "אומת" toggle) */
export function verifiedTickets(e) {
  const src = e.ticket_src || {};
  return (e.tickets || []).filter(t => (src[t] === 'video' && e.video_verified) || (src[t] === 'google' && e.google_verified));
}
export async function verifyEntry(env, body) {
  const id = String(body.id || ''), field = String(body.field || '');
  if (field !== 'video' && field !== 'google') return { status: 400, body: { ok: false, error: 'field=video|google' } };
  const e = await kvJson(env, 'raffle:' + id);
  if (!e) return { status: 404, body: { ok: false, error: 'not-found' } };
  if (!e[field + '_claimed_at']) return { status: 409, body: { ok: false, error: 'not-claimed' } };
  if (await env.RATE.get(WIN)) return { status: 409, body: { ok: false, error: 'already-drawn' } };
  e[field + '_verified'] = body.value !== false;
  e[field + '_verified_at'] = new Date().toISOString();
  await saveEntry(env, e);
  return { status: 200, body: { ok: true, entry: e } };
}
export async function drawRaffle(env, body, rng = crypto) {
  if (String(body.confirm || '') !== DRAW_CONFIRM) return { status: 400, body: { ok: false, error: 'confirm-required', confirm_required: DRAW_CONFIRM } };
  const prev = await kvJson(env, WIN);
  if (prev) return { status: 409, body: { ok: false, error: 'already-drawn', winner: prev } };
  const entries = await listEntries(env);
  const pool = [];
  for (const e of entries) for (const t of verifiedTickets(e)) pool.push({ t, e });
  if (!pool.length) return { status: 409, body: { ok: false, error: 'no-verified-tickets' } };
  const pick = pool[randInt(pool.length, rng)];
  const c = raffleCfg(env);
  const winner = { ticket: pick.t, entry_id: pick.e.id, name: pick.e.name, phone: pick.e.phone, token: pick.e.token, pool: pool.length, entries: entries.length, at: new Date().toISOString(), by: String(body.who || 'admin'), prize_he: c.prize_he };
  await env.RATE.put(WIN, JSON.stringify(winner));
  await recordChange(env, { kind: 'raffle', actor: 'Richard', summary_he: `הגרלת ביקורות: זכה כרטיס ${pick.t} (${pick.e.name || pick.e.phone}) מתוך ${pool.length} כרטיסים`, details: winner, revert: { possible: false, how: 'none' } });
  return { status: 200, body: { ok: true, winner } };
}
