/* ============================================================================
   ishur.io · subevent.js · linked "RSVP variant" sub-events (Richard 03/11)
   ----------------------------------------------------------------------------
   A sub-event is a KV-backed VIRTUAL event that mirrors its parent's guest
   rows live (no copy, no drift) and sends exactly ONE message. First kind:
   'shabbat' (שבת חתן) — buttons עם לינה / בלי לינה / לא מגיע/ה.

   KV
     subevent:<sub>            = { parent, kind:'shabbat', template, name, created }
     subevents:<parent>        = [<sub>, ...]            (index for the parent board)
     shrsvp:<sub>:<phone>      = { status: with_stay|no_stay|no|undecided, n, at, raw, await }
     shsent:<sub>:<phone>      = { at, wamid, tmpl }     (idempotency: one message per guest)
     shwamid:<wamid>           = <sub>                   (a reply quoting our message → this sub)
     shctx:<phone>             = <sub>                   (free text after our message → this sub)
   The parent's sheet columns (RSVP O/P …) are NEVER written from here.

   §1 pure (unit-tested) · §2 routes (I/O via deps, so this file never imports index.js)
   ========================================================================== */
import { partyFromText, isQuestion } from './whatsapp.js';

export const SUBEVENT_KINDS = { shabbat: { he: 'שבת חתן', type_he: 'שבת חתן · הודעה אחת' } };
export const SHABBAT_BUTTONS = ['מגיע/ה עם לינה', 'מגיע/ה בלי לינה', 'לא מגיע/ה'];
export const STATUS_HE = { with_stay: 'מגיעים עם לינה', no_stay: 'מגיעים בלי לינה', no: 'לא מגיעים', undecided: 'מתלבטים', none: 'לא ענו' };
export const FALLBACK_NAME = 'אורחים יקרים';

const clean = t => String(t || '').replace(/[‎‏]/g, '').trim();

/* the ONLY template variable: {{1}} = the guest's own name (g[3]). Never the
   paying client (column C), never an event name. 02/11 "של Eleonora" incident. */
export function shabbatParams(guest, cleanParam = s => s) {
  const n = clean(cleanParam(String((guest && guest.name) || '')));
  return [n || FALLBACK_NAME];
}
export function renderBody(bodyText, params) {
  return String(bodyText || '').replace(/\{\{(\d+)\}\}/g, (m, i) => (params[Number(i) - 1] ?? m));
}

/* a tapped button → status ('' when not one of ours) */
export function statusFromButton(text) {
  const t = clean(text);
  if (t === SHABBAT_BUTTONS[0]) return 'with_stay';
  if (t === SHABBAT_BUTTONS[1]) return 'no_stay';
  if (t === SHABBAT_BUTTONS[2]) return 'no';
  return '';
}

/* free text → { status?, n? }. Order matters: doubt first ("אולי עם לינה"),
   then "בלי לינה" (before "לינה"), then a no, then "לינה". */
const UNSURE = /(אולי|לא\s*(יודע|יודעת|יודעים|בטוח|בטוחה|בטוחים|סגור|סגורים)|עוד לא|עדיין לא|נעדכן|אעדכן|נבדוק|אבדוק|מתלבט|מתלבטת|מתלבטים|תלוי|יכול להיות)/;
const NO_STAY = /((בלי|ללא|לא\s*צריכ\S*|לא\s*צריך|בלי\s*ל)\s*לינה|לא\s*(נישן|נלון|ישנים|לנים)|רק\s*(לסעודה|לתפילה|ליום|בשבת בבוקר))/;
const NO = /((^|\s)לא\s*(מגיע|מגיעה|מגיעים|נגיע|נבוא|אגיע|אבוא|נוכל|נצליח|אוכל|יכול|יכולה|יכולים)|לצערנו|לצערי|^לא[.!]?$|לא\s*מסתדר)/;
const WITH_STAY = /(עם\s*לינה|^לינה|\sלינה|נישן|נלון|ישנים אצל|לנים)/;
export function parseShabbatText(text) {
  const t = clean(text);
  if (!t) return null;
  const b = statusFromButton(t);
  if (b) return { status: b };
  if (isQuestion(t) || UNSURE.test(t)) return { status: 'undecided' };
  const n = partyFromText(t) || null;
  if (NO_STAY.test(t)) return n ? { status: 'no_stay', n } : { status: 'no_stay' };
  if (NO.test(t)) return { status: 'no' };
  if (WITH_STAY.test(t)) return n ? { status: 'with_stay', n } : { status: 'with_stay' };
  if (n) return { n };
  if (/^(כן|מגיע|מגיעה|מגיעים|נגיע|אגיע|בטח|ברור)[\s.!]*$/.test(t)) return { status: 'yes' };   /* coming, lodging unknown */
  return null;
}

/* merge a parsed reply into the stored record → { rec, reply } (reply = what
   Shir says; never an event name, Richard 03/11) */
export function applyShabbatReply(prev, parsed, raw, now = new Date().toISOString()) {
  const p = prev || {};
  if (!parsed) return { rec: null, reply: '' };
  let status = parsed.status || p.status || '';
  let n = parsed.n || 0;
  if (parsed.status === 'yes') status = (p.status === 'with_stay' || p.status === 'no_stay') ? p.status : 'yes';
  const coming = status === 'with_stay' || status === 'no_stay';
  if (status === 'no' || status === 'undecided') n = 0;
  else if (!n && coming) n = (p.status === status || p.status === 'yes') ? (p.n || 0) : 0;
  const rec = { status: status || 'undecided', n: n || 0, at: now, raw: String(raw || '').slice(0, 200), await: '' };
  let reply;
  if (status === 'no') reply = 'תודה שעדכנתם 🙏';
  else if (status === 'undecided') reply = 'אין לחץ, אפשר לעדכן כאן בכל רגע 🙂';
  else if (coming && n) reply = `מעולה, רשמנו ${n} 🙏`;
  else if (coming) { rec.await = 'count'; reply = 'איזה כיף! כמה תהיו בסך הכל?'; }
  else if (n) { rec.status = 'yes'; rec.await = 'stay'; reply = `רשמנו ${n}. עם לינה או בלי לינה?`; }
  else { rec.status = 'yes'; rec.await = 'stay'; reply = 'איזה כיף! עם לינה או בלי לינה?'; }
  return { rec, reply };
}
/* is this guest still in the middle of the conversation? (keeps shctx open) */
export function shabbatOpen(rec) { return !rec || !!rec.await; }

/* the dashboard summary. guests: [{phone,name}] (parent rows, live); rsvps: {phone: rec} */
export function summarizeShabbat(guests, rsvps) {
  const s = { with_stay: { guests: 0, people: 0 }, no_stay: { guests: 0, people: 0 }, no: { guests: 0 }, undecided: { guests: 0 }, no_reply: { guests: 0 }, total: 0 };
  const list = []; const seen = new Set();
  for (const g of guests || []) {
    const ph = String(g.phone || ''); if (!ph || seen.has(ph)) continue; seen.add(ph);
    s.total++;
    const r = (rsvps || {})[ph];
    let st = r && r.status ? r.status : 'none';
    if (st === 'yes') st = 'undecided';   /* coming, lodging not said yet: not counted as a lodging answer */
    if (st === 'with_stay' || st === 'no_stay') { s[st].guests++; s[st].people += Math.max(1, Number(r.n) || 0); }
    else if (st === 'no') s.no.guests++;
    else if (st === 'undecided') s.undecided.guests++;
    else s.no_reply.guests++;
    list.push({ name: g.name || '', status: st, status_he: STATUS_HE[st] || '', n: r && (st === 'with_stay' || st === 'no_stay') ? Math.max(1, Number(r.n) || 0) : 0 });
  }
  return { counts: s, guests: list };
}

/* who gets the ONE message. Pure.
   rows: raw parent guest rows [{phone,name,rawPhone}] (phone '' = empty/invalid) */
export function planShabbatSend({ approved, windowOpen, held, cancelled, eventPassed, rows, sentMarks = new Set(), blocked = new Set(), room = 0, max = 50, dry = true }) {
  const refuse = (why, extra = {}) => ({ refuse: true, why, list: [], counts: {}, ...extra });
  if (cancelled) return refuse('parent-cancelled');
  if (held) return refuse('parent-on-hold');
  if (eventPassed) return refuse('parent-event-passed');
  const empty = (rows || []).filter(r => !r.phone).map(r => r.name || '(ללא שם)');
  if (!approved && !dry) return refuse('template-not-approved');
  if (!dry && empty.length) return refuse('guest-rows-with-empty-phone', { empty_phone: empty });
  if (!dry && !windowOpen) return refuse('send-window-closed');
  const list = []; const seen = new Set(); let n = 0;
  const roomN = Math.max(0, Number(room) || 0), maxN = Math.max(0, Number(max) || 0);
  for (const g of rows || []) {
    if (!g.phone || seen.has(g.phone)) continue; seen.add(g.phone);
    const row = { phone: g.phone, name: g.name || '' };
    if (sentMarks.has(g.phone)) { list.push({ ...row, action: 'skip', reason: 'already-sent' }); continue; }
    if (blocked.has(g.phone)) { list.push({ ...row, action: 'skip', reason: 'optout-or-wrong-number' }); continue; }
    if (!approved) { list.push({ ...row, action: 'hold', reason: 'template-not-approved' }); continue; }
    if (n >= roomN) { list.push({ ...row, action: 'hold', reason: 'held: cap' }); continue; }
    if (n >= maxN) { list.push({ ...row, action: 'hold', reason: 'max-reached' }); continue; }
    n++; list.push({ ...row, action: 'send', reason: '' });
  }
  const counts = { send: 0, hold: 0, skip: 0, total: list.length };
  for (const x of list) counts[x.action]++;
  return { refuse: false, why: '', list, counts, empty_phone: empty };
}

/* which sub-event does an inbound guest message belong to? '' = the normal flow.
   ctxSub: shwamid:<context.id> value; ctxOther: context.id is one of OUR other
   messages (wamid:<id> exists, not a sub); openSub: shctx:<phone> value */
export function routeToSub({ ctxSub, ctxOther, openSub, type }) {
  if (ctxSub) return ctxSub;
  if (ctxOther) return '';
  if (openSub && (type === 'text' || type === 'button' || type === 'interactive')) return openSub;
  return '';
}

/* ── §2 KV helpers + routes ─────────────────────────────────────────────── */
export async function getSub(env, sub) {
  if (!env.RATE || !/^[0-9a-f-]{36}$/.test(String(sub || ''))) return null;
  try { const r = JSON.parse((await env.RATE.get('subevent:' + sub)) || 'null'); return r && r.parent ? { token: sub, ...r } : null; } catch { return null; }
}
export async function subsOf(env, parent) {
  try { return JSON.parse((await env.RATE.get('subevents:' + parent)) || '[]') || []; } catch { return []; }
}
export function parentGuests(raw, parent, normPhone) {
  const out = [];
  for (const g of (raw && raw.guests && raw.guests.values) || []) {
    if (String(g[28] || '').trim() !== parent) continue;
    out.push({ phone: normPhone(g[4] || '') || '', name: String(g[3] || '').trim(), id: String(g[2] || '').trim() });
  }
  return out;
}
const mask = p => String(p).replace(/^972/, '0').replace(/(\d{3})\d{4}(\d{3})$/, '$1-****-$2');

/* POST /api/subevent {admin_key, parent_token, kind, template, name} */
export async function handleSubeventCreate(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  const parent = String(b.parent_token || '').trim(), kind = String(b.kind || '').trim(), template = String(b.template || '').trim(), name = String(b.name || '').trim().slice(0, 80);
  if (!/^[0-9a-f-]{36}$/.test(parent)) return d.deny(400, 'bad-parent', origin);
  if (!SUBEVENT_KINDS[kind]) return d.deny(400, 'bad-kind', origin);
  if (!/^[a-z0-9_]{3,512}$/.test(template)) return d.deny(400, 'bad-template', origin);
  if (!name) return d.deny(400, 'bad-name', origin);
  if (await getSub(env, parent)) return d.deny(400, 'parent-is-a-subevent', origin);
  const raw = await d.fetchSnapshot(env);
  if (!raw) return d.deny(502, 'reader-failed', origin);
  if (!d.eventRowOf(raw, parent)) return d.deny(404, 'unknown-parent', origin);
  const list = await subsOf(env, parent);
  for (const s of list) { const r = await getSub(env, s); if (r && r.kind === kind && r.template === template) return d.okJson({ ok: true, existed: true, token: s, ...r, dashboard: 'https://ishur.io/dashboard.html?t=' + s }, origin); }
  const sub = crypto.randomUUID();
  const rec = { parent, kind, template, name, created: new Date().toISOString() };
  await env.RATE.put('subevent:' + sub, JSON.stringify(rec));
  await env.RATE.put('subevents:' + parent, JSON.stringify(list.concat(sub)));
  await d.logEvent(env, { area: 'אירוע', action: 'נוצר תת-אירוע ' + SUBEVENT_KINDS[kind].he, ok: true, token: parent, detail: `${name} · ${template} · ${sub}` }).catch(() => {});
  return d.okJson({ ok: true, token: sub, ...rec, dashboard: 'https://ishur.io/dashboard.html?t=' + sub }, origin);
}

/* POST /api/subevent-send {admin_key, token, dry=true, max=50} */
export async function handleSubeventSend(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  const sub = await getSub(env, String(b.token || '').trim());
  if (!sub) return d.deny(404, 'unknown-subevent', origin);
  const dry = b.dry !== false;
  const max = Math.max(1, Math.min(500, Number(b.max) || 50));
  const raw = await d.fetchSnapshot(env);
  if (!raw) return d.deny(502, 'reader-failed', origin);
  const ev = d.eventRowOf(raw, sub.parent);
  if (!ev) return d.deny(404, 'unknown-parent', origin);
  const today = d.ilDate();
  const evDate = String(ev[6] || '').trim().slice(0, 10);
  const cancelled = String(ev[27] || '').trim() === 'כן';
  const held = !!(await env.RATE.get('hold:' + sub.parent).catch(() => null));
  const rows = parentGuests(raw, sub.parent, d.normPhone);
  const sentMarks = new Set(), blocked = new Set();
  for (let i = 0; i < rows.length; i += 25) {
    await Promise.all(rows.slice(i, i + 25).map(async g => {
      if (!g.phone) return;
      if (await env.RATE.get(`shsent:${sub.token}:${g.phone}`).catch(() => null)) sentMarks.add(g.phone);
      if (await d.phoneBlocked(env, g.phone) || await d.wrongNum(env, sub.parent, g.phone)) blocked.add(g.phone);
    }));
  }
  const [tpl, cap, paused, capAll] = await Promise.all([
    d.templateDetails(env, sub.template),
    d.guestCapacity(env).catch(() => ({ remaining: 0, limit: 0, used: 0, scope: '' })),
    d.sendingPaused(env).catch(() => false),
    env.RATE.get('wacap:guests').catch(() => null),
  ]);
  const approved = tpl.status === 'APPROVED';
  const win = d.sendWindowState();
  const windowOpen = !!win.open && !d.isNoContactDay(today) && !paused && !capAll;
  const plan = planShabbatSend({ approved, windowOpen, held, cancelled, eventPassed: /^\d{4}-\d{2}-\d{2}$/.test(evDate) && evDate < today,
    rows, sentMarks, blocked, room: cap.remaining, max, dry });
  const head = { token: sub.token, parent: sub.parent.slice(0, 8), name: sub.name, kind: sub.kind, template: sub.template, template_status: tpl.status || 'unknown', dry, max,
    window: { ...win, paused, no_contact_day: d.isNoContactDay(today), cap_all: !!capAll }, cap: { scope: cap.scope, limit: cap.limit, used: cap.used, remaining: cap.remaining },
    parent_hold: held, parent_cancelled: cancelled, empty_phone_rows: plan.empty_phone || [] };
  if (plan.refuse) return d.okJson({ ok: false, refused: plan.why, ...head, empty_phone_rows: plan.empty_phone || head.empty_phone_rows }, origin);
  if (dry) {
    const preview = plan.list.slice(0, 5).map(x => { const params = shabbatParams(x, d.cleanParam); return { name: x.name, params, body: renderBody(tpl.body, params) }; });
    return d.okJson({ ok: true, ...head, would_refuse_real: !approved ? 'template-not-approved' : (plan.empty_phone || []).length ? 'guest-rows-with-empty-phone' : !windowOpen ? 'send-window-closed' : '',
      preview: { body_template: tpl.body || '', footer: tpl.footer || '', buttons: tpl.buttons && tpl.buttons.length ? tpl.buttons : SHABBAT_BUTTONS, guests: preview },
      counts: plan.counts, guests: plan.list.map(x => ({ ...x, phone: mask(x.phone) })) }, origin);
  }
  let sent = 0, failed = 0; const results = [];
  for (const x of plan.list) {
    if (x.action !== 'send') { results.push({ ...x, phone: mask(x.phone) }); continue; }
    const gk = `shsent:${sub.token}:${x.phone}`;
    if (await env.RATE.get(gk).catch(() => null)) { results.push({ ...x, phone: mask(x.phone), action: 'skip', reason: 'already-sent' }); continue; }
    const params = shabbatParams(x, d.cleanParam);
    const wa = await d.sendTemplate(env, x.phone, sub.template, params, '', 'he', 'guests', { token: sub.token, wave: 'shabbat', name: params[0], who: 'שיר (' + SUBEVENT_KINDS[sub.kind].he + ')' });
    if (wa.ok) {
      sent++;
      await env.RATE.put(gk, JSON.stringify({ at: new Date().toISOString(), wamid: wa.id || '', tmpl: sub.template }), { expirationTtl: 120 * 86400 }).catch(() => {});
      if (wa.id) await env.RATE.put('shwamid:' + wa.id, sub.token, { expirationTtl: 60 * 86400 }).catch(() => {});
      await env.RATE.put('shctx:' + x.phone, sub.token, { expirationTtl: 14 * 86400 }).catch(() => {});
      await d.noteGuestSend(env, wa, sub.token, 'shabbat', x.phone, gk);
      results.push({ ...x, phone: mask(x.phone), result: 'sent', wamid: wa.id || '' });
    } else {
      failed++;
      results.push({ ...x, phone: mask(x.phone), result: wa.held ? 'held' : 'failed', error: String(wa.error || '').slice(0, 160) });
      if (wa.held) break;
    }
  }
  await d.logEvent(env, { area: 'שליחה', action: 'תת-אירוע ' + SUBEVENT_KINDS[sub.kind].he + ' · הודעה אחת', ok: !failed, review: !!failed, token: sub.parent, detail: `${sub.name} · נשלחו ${sent} · נכשלו ${failed} · ממתינים ${plan.counts.hold} · דולגו ${plan.counts.skip}` }).catch(() => {});
  return d.okJson({ ok: true, ...head, counts: { ...plan.counts, sent, failed }, guests: results }, origin);
}

/* GET /api/subevent-summary?token=<sub> — client-safe (the token is the key,
   like the dashboard). Names and statuses only, no phones. */
export async function handleSubeventSummary(request, env, origin, d) {
  const u = new URL(request.url);
  const sub = await getSub(env, String(u.searchParams.get('token') || '').trim());
  if (!sub) return d.deny(404, 'unknown-subevent', origin);
  const raw = await d.snapshotCached(env);
  if (!raw) return d.deny(502, 'reader-failed', origin);
  const ev = d.eventRowOf(raw, sub.parent) || [];
  const rows = parentGuests(raw, sub.parent, d.normPhone);
  const recs = await d.kvPrefix(env, `shrsvp:${sub.token}:`);
  const rsvps = {}; for (const [ph, v] of Object.entries(recs)) { try { rsvps[ph] = JSON.parse(v); } catch {} }
  const sum = summarizeShabbat(rows, rsvps);
  const sentN = Object.keys(await d.kvPrefix(env, `shsent:${sub.token}:`)).length;
  return d.okJson({ ok: true, subevent: { token: sub.token, kind: sub.kind, kind_he: SUBEVENT_KINDS[sub.kind].he, name: sub.name, parent: sub.parent, hosts: String(ev[34] || '').trim(), sent: sentN, ...sum } }, origin);
}

/* the inbound hook: returns true when the message was handled here */
export async function handleShabbatInbound(env, { sub, from, text, say, normPhone, logEvent }) {
  const p = normPhone(from);
  const k = `shrsvp:${sub}:${p}`;
  let prev = null; try { prev = JSON.parse((await env.RATE.get(k)) || 'null'); } catch {}
  let parsed = parseShabbatText(text);
  /* a bare number only means a count when we asked for one */
  if (parsed && !parsed.status && parsed.n && !(prev && prev.await)) parsed = { n: parsed.n };
  if (!parsed) { if (!prev || prev.await) { await say('לא הבנו 🙂 אפשר לענות: עם לינה / בלי לינה / לא מגיעים'); return true; } return false; }
  const { rec, reply } = applyShabbatReply(prev, parsed, text);
  await env.RATE.put(k, JSON.stringify(rec), { expirationTtl: 120 * 86400 });
  if (!shabbatOpen(rec)) await env.RATE.delete('shctx:' + p).catch(() => {});
  else await env.RATE.put('shctx:' + p, sub, { expirationTtl: 14 * 86400 }).catch(() => {});
  await say(reply);
  await logEvent(env, { area: 'ווצאפ', action: 'תת-אירוע · תשובת אורח: ' + (STATUS_HE[rec.status] || rec.status), ok: true, phone: p, token: sub, detail: `"${String(text).slice(0, 80)}"${rec.n ? ' · ' + rec.n : ''}` }).catch(() => {});
  return true;
}

/* the admin send-board row(s): one per sub-event, its single message type.
   Read-only. token filter matches the sub OR its parent (8+ chars). */
export async function subeventBoard(env, raw, { kvPrefix, normPhone, token = '' }) {
  const all = await kvPrefix(env, 'subevent:').catch(() => ({}));
  const out = [];
  for (const [sub, v] of Object.entries(all)) {
    let r = null; try { r = JSON.parse(v); } catch {}
    if (!r || !r.parent) continue;
    if (token && !sub.startsWith(token.slice(0, 8)) && !r.parent.startsWith(token.slice(0, 8))) continue;
    const rows = parentGuests(raw, r.parent, normPhone);
    const phones = [...new Set(rows.map(g => g.phone).filter(Boolean))];
    const [sentM, wst, replies] = await Promise.all([kvPrefix(env, `shsent:${sub}:`), kvPrefix(env, `wst:${sub}:shabbat:`), kvPrefix(env, `shrsvp:${sub}:`)]);
    const t = { invited: phones.length, sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, replied: 0 };
    for (const p of phones) {
      const st = wst[p];
      if (sentM[p]) t.sent++; else t.pending++;
      if (st === 'delivered') t.delivered++;
      else if (st === 'read') { t.delivered++; t.read++; }
      else if (st === 'failed') t.failed++;
      if (replies[p]) t.replied++;
    }
    out.push({ token: sub, parent: r.parent, name: r.name, kind: r.kind, template: r.template, empty_phone_rows: rows.filter(g => !g.phone).length,
      types: [{ key: r.kind, he: (SUBEVENT_KINDS[r.kind] || {}).type_he || r.kind, ...t }] });
  }
  return out;
}
