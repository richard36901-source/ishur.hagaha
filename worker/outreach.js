/* ============================================================================
   ishur.io · outreach.js · B2B outreach to event venues ("פנייה לאולמות")
   ----------------------------------------------------------------------------
   Built 02/11/2026 (main-executer). Spec: docs/OUTREACH-2026-11-02.md, copy
   and rules: "WA AUTOSCALE/venues/outreach-2026-11-02.md" (approved texts, no
   "הנחה", pacing).

   NOT LIVE until two things happen in the morning:
     1. `npx wrangler email sending enable ishur.io`   (Email Sending binding)
     2. OUTREACH_ENABLED = "on" in wrangler.toml [vars]   (default "off")
   With the flag off, `send` refuses and returns the plan it WOULD have sent.
   Nothing here is called from a cron: every batch is a human click.

   Routes (mounted in index.js):
     POST /api/outreach   {admin_key, action, ...}
         import  {rows:[csv row objects]}          → venue:<id> records
         list                                      → venues + status + outs
         status                                    → flags, window, template
         plan    {channel:'email'|'wa', limit}     → the next batch (dry)
         send    {channel, limit, dry}             → sends (flag-gated)
         stats                                     → per channel × variant
     GET  /px/<token>.gif                           → marks opened (public)
     GET  /r/<token>?u=<url>                        → marks clicked, 302 (public)
   Tokens are HMAC(id) so nobody can enumerate venue ids from the pixel.

   KV (env.RATE):
     venue:<id>             { id, name, city, email, whatsapp, contact, website,
                              source, notes, status, at, updated }
     venueph:<972…>         id      (reply lookup by WhatsApp number)
     venueem:<email>        id      (reply lookup by email)
     out:<id>:<channel>     { variant, at, subject, message_id, opened_at,
                              clicked_at, replied_at, optout_at, error }
     outreach:first:<ch>    YYYY-MM-DD of the first real send (pacing week 1)
     outreach:day:<ch>:<d>  sends today (the pacing counter, TTL 3 days)
     outreach:tmpl          cached template status (10 min)
   status: new → sent → replied | optout | bounced     (error keeps 'new')

   Layout: §1 pure helpers (unit-tested) · §2 copy · §3 KV · §4 handlers.
   ========================================================================== */

import { hashUnit } from './ab.js';

/* ── §1a constants ─────────────────────────────────────────────────────────── */
export const CHANNELS = ['email', 'wa'];
export const PACING = { email: { week1: 10, after: 20 }, wa: 15 };
export const WINDOW = { days: new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu']), from: 10 * 60, to: 16 * 60 };
export const SKIP_STATUS = new Set(['sent', 'replied', 'optout', 'bounced']);
export const TEMPLATE = 'ishur_venue_intro';
export const CLIENT_WABA = '1060242146337688';
export const FROM = { email: 'richard@ishur.io', name: 'ריצארד טומסקי · ishur.io' };
export const REPLY_TO = 'richard@ishur.io';
export const WA_LINK = 'https://wa.me/972559504499';
export const PARTNERS_URL = 'https://ishur.io/partners.html?utm_source=outreach&utm_medium=email&utm_campaign=venues';
export const TRACK_BASE = 'https://go.ishur.io';
const ALLOWED_REDIRECT = /^https:\/\/([a-z0-9-]+\.)*(ishur\.io|wa\.me)(\/|$)/i;

/* ── §1b subject + body variants. Assignment is sticky by venue id. ────────
   B subject as Richard dictated. Body has one variant for now; add a second
   entry to BODY and the hash picks it — nothing else changes. */
export const SUBJECT = {
  A: v => `${v}`,
  B: v => `${v} — מספר סופי לכל אירוע`,
};
export function assignVariant(id, keys = Object.keys(SUBJECT)) {
  const u = hashUnit('outreach|' + String(id));
  return keys[Math.min(keys.length - 1, Math.floor(u * keys.length))];
}

/* ── §1c ids + phones ───────────────────────────────────────────────────────── */
export function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}
export function normEmail(e) { return String(e || '').trim().toLowerCase(); }
/* short FNV-1a hash of "email|phone" — same venue in two CSVs → same id */
export function venueId(email, phone) {
  const s = normEmail(email) + '|' + normPhone(phone);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = s.length - 1; i >= 0; i--) { h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x01000193) >>> 0; }
  return (h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}
/* the WhatsApp number of a CSV row: the one marked "(WhatsApp)", else the
   first Israeli mobile (05x). Ad call-tracking numbers (notes) are never used
   for WhatsApp on their own. */
export function pickWhatsapp(phoneField) {
  const parts = String(phoneField || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
  const marked = parts.find(p => /whatsapp/i.test(p));
  if (marked) { const n = normPhone(marked); if (/^9725\d{8}$/.test(n)) return n; }
  for (const p of parts) { const n = normPhone(p); if (/^9725\d{8}$/.test(n)) return n; }
  return '';
}
export function parseRow(row, source = '') {
  const g = k => String(row[k] == null ? '' : row[k]).trim();
  const email = normEmail(g('email'));
  const whatsapp = pickWhatsapp(g('phone_whatsapp') || g('whatsapp') || g('phone'));
  const name = g('name');
  if (!name || (!email && !whatsapp)) return null;
  return {
    id: venueId(email, whatsapp), name, city: g('city'), email, whatsapp,
    contact: g('contact_name') || g('contact'), website: g('website'),
    source: source || g('source_url'), notes: g('notes'),
  };
}

/* ── §1d time: Israel calendar, outreach window Sun–Thu 10:00–16:00 ────────── */
export function ilParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return { day: get('weekday'), mins: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}
export function ilDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}
/* channel 'wa' also needs the house send window (shir.js sendWindowState),
   passed in so this file stays free of shir.js. Email: the hours alone. */
export function outreachWindow(channel, now = new Date(), sendWindowState = null) {
  const { day, mins } = ilParts(now);
  if (!WINDOW.days.has(day)) return { open: false, why: day === 'Fri' || day === 'Sat' ? 'weekend' : 'day' };
  if (mins < WINDOW.from || mins > WINDOW.to) return { open: false, why: 'hours' };
  if (channel === 'wa' && typeof sendWindowState === 'function') {
    const s = sendWindowState(now);
    if (!s.open) return { open: false, why: 'send-window:' + (s.why || '') };
  }
  return { open: true };
}
/* email: 10/day during the first 7 calendar days after the first real send,
   then 20/day. WhatsApp: 15/day flat. */
export function dailyLimit(channel, firstDayIso, todayIso) {
  if (channel === 'wa') return PACING.wa;
  if (!firstDayIso) return PACING.email.week1;
  const days = Math.floor((Date.parse(todayIso + 'T00:00:00Z') - Date.parse(firstDayIso + 'T00:00:00Z')) / 864e5);
  return days >= 7 ? PACING.email.after : PACING.email.week1;
}
export function venueAddress(v, channel) { return channel === 'email' ? (v.email || '') : (v.whatsapp || ''); }

/* ── §1e the plan (pure) ───────────────────────────────────────────────────
   venues: all venue records · outs: { "<id>:<channel>": out } · sentToday:
   the pacing counter · returns the batch and why the rest was skipped. */
export function planBatch({ venues, outs = {}, channel, limit, sentToday = 0, firstDay = '', today, now = new Date(), sendWindowState = null, force = false }) {
  if (!CHANNELS.includes(channel)) return { ok: false, error: 'bad-channel' };
  const todayIso = today || ilDate(now);
  const cap = dailyLimit(channel, firstDay, todayIso);
  const room = Math.max(0, cap - sentToday);
  const want = Math.max(0, Math.min(Number(limit) || room, room));
  const window = outreachWindow(channel, now, sendWindowState);
  const skipped = { status: 0, no_address: 0, already: 0 };
  const batch = [];
  const sorted = [...venues].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.name).localeCompare(String(b.name), 'he'));
  for (const v of sorted) {
    if (SKIP_STATUS.has(v.status)) { skipped.status++; continue; }
    if (!venueAddress(v, channel)) { skipped.no_address++; continue; }
    const o = outs[v.id + ':' + channel];
    if (o && o.at && !o.error) { skipped.already++; continue; }
    if (batch.length >= want) continue;
    batch.push({ id: v.id, name: v.name, city: v.city, to: venueAddress(v, channel), variant: assignVariant(v.id), subject: channel === 'email' ? SUBJECT[assignVariant(v.id)](v.name) : '' });
  }
  const eligible = venues.length - skipped.status - skipped.no_address - skipped.already;
  return { ok: true, channel, today: todayIso, cap, sent_today: sentToday, room, window, batch, eligible, skipped,
    blocked: !force && !window.open ? 'window:' + window.why : (room === 0 ? 'daily-cap' : '') };
}

/* ── §1f tracking tokens: HMAC-SHA256(kind|id) with a server secret ─────── */
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function secretOf(env) { return String((env && (env.OUTREACH_SECRET || env.ADMIN_KEY)) || ''); }
export async function makeToken(env, id, kind = 'o') {
  const s = secretOf(env); if (!s) throw new Error('no-secret');
  const sig = (await hmacHex(s, `${kind}|${id}`)).slice(0, 20);
  return `${kind}${id}.${sig}`;
}
/* returns { id, kind } or null. Constant-time compare on the signature. */
export async function verifyToken(env, token) {
  const m = /^([oc])([0-9a-f]{12})\.([0-9a-f]{20})$/.exec(String(token || ''));
  if (!m) return null;
  const s = secretOf(env); if (!s) return null;
  const want = (await hmacHex(s, `${m[1]}|${m[2]}`)).slice(0, 20);
  let diff = 0; for (let i = 0; i < 20; i++) diff |= want.charCodeAt(i) ^ m[3].charCodeAt(i);
  return diff === 0 ? { id: m[2], kind: m[1] } : null;
}
export function safeRedirect(u) {
  const s = String(u || '').trim();
  return ALLOWED_REDIRECT.test(s) && !/[\s<>"']/.test(s) ? s : '';
}

/* ── §2 the copy. Approved 02/11 (outreach-2026-11-02.md). Never "הנחה". ── */
export const EMAIL_TEXT = (who) => `שלום ${who},

אני ריצארד מ-ishur.io. אנחנו עושים לזוגות את אישורי ההגעה בוואטסאפ: הזמנה עם כפתור "מגיע / לא מגיע", תזכורות, ושיחה טלפונית למי שלא ענה. בסוף יש מספר סופי ומדויק, שבוע לפני האירוע.

מה זה נותן לאולם שלכם:
- מספר מגיעים אמיתי לכל אירוע, בקישור שרואים בזמן אמת. פחות מנות מבוזבזות ופחות ויכוחים על מינימום.
- הזוגות שלכם מקבלים 10% הטבה עם קוד אישי של האולם.
- בלי עלות ובלי התחייבות מצדכם. רק להעביר לזוגות קישור או QR.

אפשר 10 דקות שיחה השבוע? או תכתבו לי בוואטסאפ 055-950-4499.

ריצארד טומסקי
ishur.io`;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function emailBody({ who, partnersUrl, waUrl, pixelUrl }) {
  const text = EMAIL_TEXT(who) + `\n\nפרטים לאולמות: ${partnersUrl}\nוואטסאפ: ${waUrl}\n\nלהסרה השיבו 'הסר'`;
  const p = s => `<p style="margin:0 0 14px">${esc(s)}</p>`;
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#FAF8F1;font-family:Heebo,Arial,sans-serif;color:#1B2420;direction:rtl">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;font-size:16px;line-height:1.6;text-align:right">
${p(`שלום ${who},`)}
${p('אני ריצארד מ-ishur.io. אנחנו עושים לזוגות את אישורי ההגעה בוואטסאפ: הזמנה עם כפתור "מגיע / לא מגיע", תזכורות, ושיחה טלפונית למי שלא ענה. בסוף יש מספר סופי ומדויק, שבוע לפני האירוע.')}
${p('מה זה נותן לאולם שלכם:')}
<ul style="margin:0 0 14px;padding-inline-start:20px">
<li>מספר מגיעים אמיתי לכל אירוע, בקישור שרואים בזמן אמת. פחות מנות מבוזבזות ופחות ויכוחים על מינימום.</li>
<li>הזוגות שלכם מקבלים 10% הטבה עם קוד אישי של האולם.</li>
<li>בלי עלות ובלי התחייבות מצדכם. רק להעביר לזוגות קישור או QR.</li>
</ul>
${p('אפשר 10 דקות שיחה השבוע? או תכתבו לי בוואטסאפ 055-950-4499.')}
<p style="margin:18px 0"><a href="${esc(partnersUrl)}" style="display:inline-block;background:#0F2E22;color:#F8F4EA;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600">פרטים לאולמות</a>
&nbsp; <a href="${esc(waUrl)}" style="color:#0F2E22">לכתוב לי בוואטסאפ</a></p>
${p('ריצארד טומסקי')}
<p style="margin:0 0 24px"><a href="https://ishur.io" style="color:#A8853C;text-decoration:none">ishur.io</a></p>
<p style="margin:0;font-size:12px;color:#7A847C">להסרה השיבו 'הסר'</p>
</div><img src="${esc(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0"></body></html>`;
  return { html, text };
}
export function emailFor(env, venue, variant, base = TRACK_BASE) {
  return (async () => {
    const tok = await makeToken(env, venue.id, 'o'), ctok = await makeToken(env, venue.id, 'c');
    const r = u => `${base}/r/${ctok}?u=${encodeURIComponent(u)}`;
    const who = venue.contact || venue.name;
    const subject = SUBJECT[variant](venue.name);
    const { html, text } = emailBody({ who, partnersUrl: r(PARTNERS_URL), waUrl: r(WA_LINK), pixelUrl: `${base}/px/${tok}.gif` });
    return {
      to: venue.email, from: { email: FROM.email, name: FROM.name }, replyTo: REPLY_TO, subject, html, text,
      headers: { 'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=${encodeURIComponent('הסר')}>` },
    };
  })();
}

/* ── §2b email send, degrading with named errors (never throws) ───────────── */
export async function sendEmail(env, msg) {
  if (!env || !env.EMAIL || typeof env.EMAIL.send !== 'function') return { ok: false, error: 'email-binding-missing' };
  try {
    const r = await env.EMAIL.send(msg);
    return { ok: true, message_id: String((r && (r.messageId || r.message_id)) || '') };
  } catch (e) {
    const code = String((e && e.code) || '');
    if (code === 'E_SENDER_NOT_VERIFIED' || code === 'E_SENDER_DOMAIN_NOT_AVAILABLE' || /not (verified|onboarded|enabled)/i.test(String(e && e.message))) return { ok: false, error: 'email-domain-not-enabled', code };
    if (code === 'E_RECIPIENT_SUPPRESSED' || code === 'E_DELIVERY_FAILED') return { ok: false, error: 'bounced', code };
    return { ok: false, error: 'email-failed', code, detail: String((e && e.message) || e).slice(0, 200) };
  }
}

/* ── §3 KV helpers ───────────────────────────────────────────────────────────── */
const kvOf = env => (env && env.RATE) || null;
async function getJson(kv, k) { try { return JSON.parse((await kv.get(k)) || 'null'); } catch { return null; } }
async function listKeys(kv, prefix) {
  const out = []; let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys || []) out.push(k.name);
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}
export async function loadVenues(env) {
  const kv = kvOf(env); if (!kv) return [];
  const keys = await listKeys(kv, 'venue:');
  const out = [];
  for (const k of keys) { const v = await getJson(kv, k); if (v && v.id) out.push(v); }
  return out;
}
export async function loadOuts(env) {
  const kv = kvOf(env); if (!kv) return {};
  const keys = await listKeys(kv, 'out:');
  const out = {};
  for (const k of keys) { const o = await getJson(kv, k); if (o) out[k.slice(4)] = o; }
  return out;
}
async function saveVenue(env, v) {
  const kv = kvOf(env);
  await kv.put('venue:' + v.id, JSON.stringify(v));
  if (v.whatsapp) await kv.put('venueph:' + v.whatsapp, v.id);
  if (v.email) await kv.put('venueem:' + v.email, v.id);
}
async function setStatus(env, id, status, patch = {}) {
  const kv = kvOf(env);
  const v = await getJson(kv, 'venue:' + id); if (!v) return null;
  Object.assign(v, patch, { status, updated: new Date().toISOString() });
  await kv.put('venue:' + id, JSON.stringify(v));
  return v;
}
async function patchOut(env, id, channel, patch) {
  const kv = kvOf(env);
  const o = (await getJson(kv, `out:${id}:${channel}`)) || {};
  Object.assign(o, patch);
  await kv.put(`out:${id}:${channel}`, JSON.stringify(o));
  return o;
}
async function counter(env, channel, day) { return Number((await kvOf(env).get(`outreach:day:${channel}:${day}`)) || 0); }
async function bump(env, channel, day) {
  const n = (await counter(env, channel, day)) + 1;
  await kvOf(env).put(`outreach:day:${channel}:${day}`, String(n), { expirationTtl: 3 * 86400 });
  return n;
}

/* template status on the CLIENT WABA, same Graph call index.js's
   templateApproved makes, cached 10 min. deps.fetch for tests. */
export async function templateStatus(env, deps = {}) {
  const kv = kvOf(env);
  const c = kv ? await kv.get('outreach:tmpl').catch(() => null) : null;
  if (c) return c;
  const token = deps.clientToken ? deps.clientToken(env) : (env && env.WA_TOKEN);
  let status = 'UNKNOWN';
  try {
    const f = deps.fetch || fetch;
    const r = await f(`https://graph.facebook.com/v21.0/${CLIENT_WABA}/message_templates?name=${TEMPLATE}&fields=name,status`, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    const t = ((j && j.data) || []).find(x => x.name === TEMPLATE);
    status = t ? String(t.status || 'UNKNOWN') : 'NOT_FOUND';
  } catch { status = 'UNKNOWN'; }
  if (kv && status !== 'UNKNOWN') await kv.put('outreach:tmpl', status, { expirationTtl: 600 }).catch(() => {});
  return status;
}

/* ── §3b stats (pure over venues + outs) ───────────────────────────────────── */
export function computeStats(venues, outs) {
  const blank = () => ({ sent: 0, opened: 0, clicked: 0, replied: 0, optout: 0, bounced: 0, failed: 0 });
  const by = { email: { all: blank(), A: blank(), B: blank() }, wa: { all: blank(), A: blank(), B: blank() } };
  const vmap = new Map(venues.map(v => [v.id, v]));
  for (const [k, o] of Object.entries(outs)) {
    const [id, ch] = k.split(':'); if (!by[ch]) continue;
    const vs = o.variant && by[ch][o.variant] ? by[ch][o.variant] : null;
    const add = f => { by[ch].all[f]++; if (vs) vs[f]++; };
    if (o.error) { add('failed'); continue; }
    if (o.at) add('sent');
    if (o.opened_at) add('opened');
    if (o.clicked_at) add('clicked');
    if (o.replied_at) add('replied');
    if (o.optout_at) add('optout');
    const v = vmap.get(id); if (v && v.status === 'bounced' && o.bounced) add('bounced');
  }
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const lead = Object.entries(by.email).filter(([k]) => k !== 'all').map(([k, s]) => ({ variant: k, subject: SUBJECT[k]('<אולם>'), sent: s.sent, open_rate: rate(s.opened, s.sent), click_rate: rate(s.clicked, s.sent), reply_rate: rate(s.replied, s.sent) }))
    .sort((a, b) => (b.reply_rate || 0) - (a.reply_rate || 0) || (b.open_rate || 0) - (a.open_rate || 0));
  const statuses = {};
  for (const v of venues) statuses[v.status || 'new'] = (statuses[v.status || 'new'] || 0) + 1;
  return { by, leading: lead[0] && lead[0].sent ? lead[0] : null, subjects: lead, statuses, total: venues.length };
}

/* ── §3c reply / opt-out hook ───────────────────────────────────────────────
   Call from the WhatsApp inbound path on the CLIENT channel (Noa's number)
   BEFORE Noa's auto-reply logic, and from any email-reply reader:
       const hit = await noteOutreachReply(env, { channel:'wa', from, text }, { slackSend });
       if (hit) { ...skip the lead flow for this message... }
   Returns null when `from` is not a venue in KV (so the normal flow runs). */
export async function noteOutreachReply(env, { channel = 'wa', from, text = '' } = {}, deps = {}) {
  const kv = kvOf(env); if (!kv) return null;
  const key = channel === 'email' ? 'venueem:' + normEmail(from) : 'venueph:' + normPhone(from);
  const id = await kv.get(key); if (!id) return null;
  const v = await getJson(kv, 'venue:' + id); if (!v) return null;
  const t = String(text || '').trim();
  const now = new Date().toISOString();
  let kind = 'text';
  if (/לא רלוונטי/.test(t) || /^(הסר|הסירו|תסירו|unsubscribe|stop)(\s|$)/i.test(t)) kind = 'optout';
  else if (/^כן|שלחו פרטים|מעוניין|מעוניינת|רלוונטי/.test(t)) kind = 'yes';
  if (kind === 'optout') {
    await setStatus(env, id, 'optout', { optout_at: now, optout_via: channel });
    await patchOut(env, id, channel, { optout_at: now });
  } else {
    await setStatus(env, id, 'replied', { replied_at: now, replied_via: channel, last_reply: t.slice(0, 200) });
    await patchOut(env, id, channel, { replied_at: now, reply: t.slice(0, 200) });
    if (kind === 'yes' && typeof deps.slackSend === 'function') {
      await deps.slackSend(env, `🏛️ *אולם ענה כן · ${v.name}*\n\n${v.city ? v.city + ' · ' : ''}${channel === 'wa' ? 'וואטסאפ ' + (v.whatsapp || '') : 'מייל ' + (v.email || '')}\n"${t.slice(0, 120)}"\n\n→ ריצארד: לקבוע שיחה ולשלוח את דף השותפים`, { urgent: true }).catch(() => {});
    }
  }
  if (typeof deps.stream === 'function') deps.stream(env, { kind: 'outreach', area: 'אולמות', action: `תשובה · ${kind} · ${v.name}`, ok: true, phone: v.whatsapp || '', detail: t.slice(0, 300), data: { id, channel, kind } }).catch(() => {});
  return { id, name: v.name, kind, channel };
}

/* ── §4 the handlers ────────────────────────────────────────────────────────── */
function enabled(env) { return String((env && env.OUTREACH_ENABLED) || '') === 'on'; }

export async function handleOutreach(request, env, origin, deps) {
  const { isAdmin, okJson, deny } = deps;
  let b = {};
  try { b = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, b.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!kvOf(env)) return okJson({ ok: false, error: 'no-kv' }, origin);
  const action = String(b.action || 'status');
  const now = deps.now ? deps.now() : new Date();
  const today = ilDate(now);

  if (action === 'status') {
    const tmpl = await templateStatus(env, deps);
    return okJson({
      ok: true, enabled: enabled(env), email_binding: !!(env.EMAIL && typeof env.EMAIL.send === 'function'),
      template: { name: TEMPLATE, status: tmpl, approved: tmpl === 'APPROVED' },
      window: { email: outreachWindow('email', now), wa: outreachWindow('wa', now, deps.sendWindowState) },
      today, sent_today: { email: await counter(env, 'email', today), wa: await counter(env, 'wa', today) },
      first: { email: await kvOf(env).get('outreach:first:email'), wa: await kvOf(env).get('outreach:first:wa') },
      pacing: PACING,
    }, origin);
  }

  if (action === 'import') {
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const source = String(b.source || '').slice(0, 80);
    let added = 0, updated = 0, skipped = 0;
    for (const row of rows.slice(0, 2000)) {
      const p = parseRow(row || {}, source);
      if (!p) { skipped++; continue; }
      const old = await getJson(kvOf(env), 'venue:' + p.id);
      const v = old ? { ...old, ...p, status: old.status, at: old.at, updated: new Date().toISOString() } : { ...p, status: 'new', at: new Date().toISOString() };
      await saveVenue(env, v);
      old ? updated++ : added++;
    }
    if (deps.stream) deps.stream(env, { kind: 'outreach', area: 'אולמות', action: `ייבוא · ${added} חדשים · ${updated} עודכנו`, ok: true, data: { added, updated, skipped, source } }).catch(() => {});
    return okJson({ ok: true, added, updated, skipped }, origin);
  }

  if (action === 'list' || action === 'stats') {
    const venues = await loadVenues(env);
    const outs = await loadOuts(env);
    const stats = computeStats(venues, outs);
    if (action === 'stats') return okJson({ ok: true, ...stats }, origin);
    const rows = venues.map(v => ({ ...v, out: { email: outs[v.id + ':email'] || null, wa: outs[v.id + ':wa'] || null }, variant: assignVariant(v.id) }))
      .sort((a, b) => String(b.updated || b.at || '').localeCompare(String(a.updated || a.at || '')));
    return okJson({ ok: true, venues: rows, stats, enabled: enabled(env) }, origin);
  }

  if (action === 'plan' || action === 'send') {
    const channel = String(b.channel || 'email');
    if (!CHANNELS.includes(channel)) return okJson({ ok: false, error: 'bad-channel' }, origin);
    const dry = action === 'plan' || b.dry === true;
    const venues = await loadVenues(env);
    const outs = await loadOuts(env);
    const firstDay = (await kvOf(env).get('outreach:first:' + channel)) || '';
    const plan = planBatch({ venues, outs, channel, limit: b.limit, sentToday: await counter(env, channel, today), firstDay, today, now, sendWindowState: deps.sendWindowState });
    if (dry) return okJson({ ...plan, dry: true, enabled: enabled(env) }, origin);
    if (!enabled(env)) return okJson({ ...plan, dry: true, sent: [], error: 'outreach-off', hint: 'OUTREACH_ENABLED is not "on"' }, origin);
    if (plan.blocked) return okJson({ ...plan, dry: true, sent: [], error: plan.blocked }, origin);
    if (channel === 'wa') {
      const st = await templateStatus(env, deps);
      if (st !== 'APPROVED') return okJson({ ...plan, dry: true, sent: [], error: 'template-not-approved', template_status: st }, origin);
    }
    const sent = [], failed = [];
    for (const item of plan.batch) {
      const v = venues.find(x => x.id === item.id);
      const at = new Date().toISOString();
      let r;
      if (channel === 'email') {
        const msg = await emailFor(env, v, item.variant, deps.trackBase || env.OUTREACH_TRACK_BASE || TRACK_BASE);
        r = await sendEmail(env, msg);
      } else {
        try {
          const w = await deps.sendTemplate(env, v.whatsapp, TEMPLATE, [v.name], '', 'he', 'client', { who: 'ריצארד (פנייה לאולמות)' });
          r = w && w.ok ? { ok: true, message_id: String(w.id || '') } : { ok: false, error: 'wa-failed', detail: String((w && (w.error || w.detail || w.status)) || '').slice(0, 200) };
        } catch (e) { r = { ok: false, error: 'wa-failed', detail: String(e && e.message || e).slice(0, 200) }; }
      }
      if (r.ok) {
        await patchOut(env, v.id, channel, { variant: item.variant, at, subject: item.subject, message_id: r.message_id, error: '' });
        await setStatus(env, v.id, 'sent', { ['sent_' + channel]: at });
        if (!firstDay) { await kvOf(env).put('outreach:first:' + channel, today); }
        await bump(env, channel, today);
        sent.push({ id: v.id, name: v.name, to: item.to, variant: item.variant, message_id: r.message_id });
        if (deps.stream) deps.stream(env, { kind: 'outreach', area: 'אולמות', action: `נשלח · ${channel} · ${v.name} · ${item.variant}`, ok: true, phone: channel === 'wa' ? v.whatsapp : '', detail: item.subject || TEMPLATE, data: { id: v.id, channel, variant: item.variant, message_id: r.message_id } }).catch(() => {});
      } else {
        await patchOut(env, v.id, channel, { variant: item.variant, error: r.error, error_at: at, detail: r.detail || r.code || '' });
        if (r.error === 'bounced') await setStatus(env, v.id, 'bounced');
        failed.push({ id: v.id, name: v.name, error: r.error, detail: r.detail || r.code || '' });
        if (deps.stream) deps.stream(env, { kind: 'outreach', area: 'אולמות', action: `נכשל · ${channel} · ${v.name} · ${r.error}`, ok: false, review: true, detail: r.detail || '', data: { id: v.id, channel, error: r.error } }).catch(() => {});
        /* the domain is not enabled: every further send would fail the same way */
        if (r.error === 'email-domain-not-enabled' || r.error === 'email-binding-missing') return okJson({ ...plan, dry: false, sent, failed, error: r.error, stopped: true }, origin);
      }
    }
    return okJson({ ...plan, dry: false, sent, failed }, origin);
  }

  return okJson({ ok: false, error: 'bad-action' }, origin);
}

/* GET /px/<token>.gif and GET /r/<token>?u=… — public, HMAC-gated. */
const GIF = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59]);
export async function handleOutreachTrack(request, env, url, deps = {}) {
  const gif = () => new Response(GIF, { status: 200, headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private', 'Content-Length': String(GIF.length) } });
  if (url.pathname.startsWith('/px/')) {
    const tok = url.pathname.slice(4).replace(/\.gif$/, '');
    const v = await verifyToken(env, tok);
    if (v && v.kind === 'o' && kvOf(env)) {
      const o = await getJson(kvOf(env), `out:${v.id}:email`);
      if (o && o.at && !o.opened_at) {
        await patchOut(env, v.id, 'email', { opened_at: new Date().toISOString() });
        if (deps.stream) deps.stream(env, { kind: 'outreach', area: 'אולמות', action: 'נפתח · email', ok: true, req: request, data: { id: v.id, variant: o.variant } }).catch(() => {});
      }
    }
    return gif();
  }
  if (url.pathname.startsWith('/r/')) {
    const tok = url.pathname.slice(3);
    const v = await verifyToken(env, tok);
    const to = safeRedirect(url.searchParams.get('u'));
    if (!v || v.kind !== 'c' || !to) return new Response('not found', { status: 404 });
    if (kvOf(env)) {
      const o = await getJson(kvOf(env), `out:${v.id}:email`);
      if (o && o.at) {
        const patch = { clicked_at: o.clicked_at || new Date().toISOString(), clicks: (Number(o.clicks) || 0) + 1 };
        if (!o.opened_at) patch.opened_at = patch.clicked_at;
        await patchOut(env, v.id, 'email', patch);
        if (deps.stream) deps.stream(env, { kind: 'outreach', area: 'אולמות', action: 'קליק · email', ok: true, req: request, detail: to.slice(0, 200), data: { id: v.id, variant: o.variant } }).catch(() => {});
      }
    }
    return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
  }
  return new Response('not found', { status: 404 });
}
