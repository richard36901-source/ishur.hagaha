/* ============================================================================
   ishur.io · account.js · the client's personal area (Richard 12/11/2026)
   ----------------------------------------------------------------------------
   account.html: phone → one-time code → session → the client's events (past
   ones greyed with only the missing review step), credit balance (reviews
   ₪30 video / ₪20 Google; referral-program appends to the same ledger later),
   contact preferences (email, alternative phone, marketing opt-in).

   Code delivery ladder (Noa 4499 is unpaid — 131042 — on 12/11):
     1. ishur_kod from Noa (client channel)
     2. the same template from the guests number (Shir) — ~₪0.02
     3. email (Cloudflare Email Sending) when the client has one
     4. nothing worked → 502 send-failed, the page offers WhatsApp to Noa

   KV: acctotp:<phone> {code, tries}            10 min
       acctsess:<nonce> {phone, at}             90 days (listing / revocation)
       acctrev:<nonce>  '1'                     revoked session
       credit:<phone>   {entries:[{kind, ils, at, token}], redeemed:[]}
       contact:<phone>  {email, phone_alt, marketing, at}
       fb:<token>       gains video_at / google_at

   Session token: acct.<phone>.<nonce>.<sig>, sig = HMAC-SHA256(ADMIN_KEY,
   'acct:'+nonce+':'+phone)[0..32]. Verifies on any edge without a KV read
   (KV is eventually consistent); the KV row only revokes. Never in a URL.
   ========================================================================== */
import { verifyIdToken, linkIdentity, phoneForIdentity, linkedTo, unlinkAll, PROVIDERS } from './identity.js';

/* 21/11 Richard: no credit for a Google review. Google's policy ("Rating Manipulation") forbids incentives and asking
   only satisfied customers, so a Google review is asked of everyone and earns nothing. The video testimonial is our
   own content and keeps its credit. */
export const CREDIT_ILS = { video: 30 };
const CLAIM_KINDS = { video: 1, google: 1 };
export const KIND_HE = { review_video: 'המלצת וידאו', review_google: 'ביקורת בגוגל', referral: 'הפניית חבר' };
export const OTP_TTL = 600, OTP_TRIES = 5, SESSION_DAYS = 90;
const WA_NOA = '972559504499';

/* feedback gate: 6 and up on both scores (Richard 12/11: "שש ויותר תשאיר") */
export function routeOf(nps, exp) { return Math.min(Number(nps) || 0, Number(exp) || 0) >= 6 ? 'high' : 'low'; }

export function ledgerBalance(l) {
  const sum = a => (Array.isArray(a) ? a : []).reduce((n, e) => n + (Number(e && e.ils) || 0), 0);
  return Math.max(0, sum(l && l.entries) - sum(l && l.redeemed));
}

/* 'YYYY-MM-DD' (the sheet) or 'DD/MM/YYYY' → ISO day, '' when unreadable */
export function isoDay(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
export function isPast(date, today) { const d = isoDay(date); return !!d && d < today; }

/* review state of one event from its fb: record */
export function reviewState(fb) {
  const f = fb || {};
  const scored = !!(f.nps && f.exp);
  return { scored, route: scored ? (f.route || routeOf(f.nps, f.exp)) : '', video: !!f.video_at, google: !!f.google_at, nps: f.nps || null, exp: f.exp || null };
}

/* eventsForPhone() rows + fb records → the list the page renders */
export function eventsView(evs, fbs, today, base = 'https://ishur.io') {
  const rows = (evs || []).map(e => {
    const past = isPast(e.event_date, today);
    const review = reviewState(fbs && fbs[e.token]);
    let next = 'none';
    if (past) {
      if (!review.scored) next = 'score';
      else if (review.route === 'high' && !(review.video && review.google)) next = 'claim';
      else if (review.route === 'high') next = 'done';
    }
    return {
      token: e.token, name: e.event_name || '', occasion: e.occasion || '', date: isoDay(e.event_date), venue: e.venue_name || '', city: e.venue_city || '',
      past, review, next,
      dashboard_url: `${base}/dashboard.html?t=${e.token}`, feedback_url: `${base}/feedback.html?t=${e.token}`,
    };
  });
  const up = rows.filter(r => !r.past).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
  const done = rows.filter(r => r.past).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return [...up, ...done];
}

/* ── session ─────────────────────────────────────────────────────────────── */
async function hmac32(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export function sessionSig(env, nonce, phone) { return hmac32(env.ADMIN_KEY, `acct:${nonce}:${phone}`); }
export async function mintSession(env, phone) {
  const nonce = hex(16), sig = await sessionSig(env, nonce, phone);
  if (env.RATE) await env.RATE.put('acctsess:' + nonce, JSON.stringify({ phone, at: new Date().toISOString() }), { expirationTtl: SESSION_DAYS * 86400 }).catch(() => {});
  return `acct.${phone}.${nonce}.${sig}`;
}
/* → phone, or '' */
export async function verifySession(env, token, safeEqual) {
  const m = String(token || '').match(/^acct\.(972\d{8,9})\.([0-9a-f]{32})\.([0-9a-f]{32})$/);
  if (!m || !env.ADMIN_KEY) return '';
  if (!safeEqual(m[3], await sessionSig(env, m[2], m[1]))) return '';
  if (env.RATE && await env.RATE.get('acctrev:' + m[2]).catch(() => null)) return '';
  return m[1];
}
/* an email-only account: acctm.<email as hex>.<nonce>.<sig>. A different prefix and signing label than a phone session, so neither can pass as the other. */
const toHex = s => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new TextDecoder().decode(new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16))));
export async function mintEmailSession(env, email) { const nonce = hex(16); return `acctm.${toHex(email)}.${nonce}.${await hmac32(env.ADMIN_KEY, `acctm:${nonce}:${email}`)}`; }
export async function verifyEmailSession(env, token, safeEqual) {
  const m = String(token || '').match(/^acctm\.([0-9a-f]{6,480})\.([0-9a-f]{32})\.([0-9a-f]{32})$/);
  if (!m || !env.ADMIN_KEY) return '';
  const email = fromHex(m[1]); if (!validEmail(email)) return '';
  if (!safeEqual(m[3], await hmac32(env.ADMIN_KEY, `acctm:${m[2]}:${email}`))) return '';
  if (env.RATE && await env.RATE.get('acctrev:' + m[2]).catch(() => null)) return '';
  return email;
}
/* ── 17/11 Richard: the client signs in with the phone on file + a 4-digit PIN that we set ─────────────
   The PIN is derived from the phone (so it can be shown again next to every board link without being stored);
   acctpin:<phone> overrides it after a reset. Four digits are few, so guessing is what is limited: PIN_HOUR tries
   an hour and PIN_DAY a day per phone (every try counts, before the compare), and the day limit locks the PIN
   (acctpinlock:) until the owner signs in once with the WhatsApp code. */
export const PIN_HOUR = 6, PIN_DAY = 20;
/* 21/11 App Store review (Apple 2.1: the demo account "must not expire"). The phone in env REVIEW_PHONE (the demo
   client, a test phone whose event sends nothing) is never locked and has no per-phone cap, so a reviewer who mistypes
   cannot lock it. The per-IP cap still applies. Worst case for a guesser: an invented event that sends nothing. */
export function isReviewPhone(env, phone) {
  const r = String((env && env.REVIEW_PHONE) || '').replace(/\D/g, '').replace(/^0/, '972');
  return !!r && String(phone || '') === r;
}
const WEAK_PIN = p => /^(\d)\1{3}$/.test(p) || p === '1234' || p === '4321' || p === '0123';
export async function pinFor(env, phone) {
  phone = String(phone || '');
  if (!/^972\d{8,9}$/.test(phone)) return '';
  const own = env.RATE ? await env.RATE.get('acctpin:' + phone).catch(() => null) : null;
  if (own && /^\d{4}$/.test(own)) return own;
  if (!env.ADMIN_KEY) return '';
  const h = await hmac32(env.ADMIN_KEY, 'pin:' + phone);
  for (let i = 0; i + 8 <= h.length; i += 8) { const pin = String(parseInt(h.slice(i, i + 8), 16) % 10000).padStart(4, '0'); if (!WEAK_PIN(pin)) return pin; }
  return '2580';
}
export async function resetPin(env, phone) {
  let pin; do { pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0'); } while (WEAK_PIN(pin));
  await env.RATE.put('acctpin:' + phone, pin);
  await env.RATE.delete('acctpinlock:' + phone).catch(() => {});
  return pin;
}
const nonceOf = token => (String(token || '').match(/^acct\.\d+\.([0-9a-f]{32})\./) || [])[1] || '';

/* one budget for both ways in (the personal area and the board link). → null when the PIN is right, else [status, error] */
export async function tryPin(env, d, phone, pin, ip) {
  if ((d.memOver && d.memOver('acctpini:' + ip, 30, 3600)) || await d.overBudget(env, 'rl:acctpini:' + ip, 30, 3600)) return [429, 'rate-limited'];
  if (isReviewPhone(env, phone)) { const want = await pinFor(env, phone); return want && d.safeEqual(pin, want) ? null : [403, 'bad-login']; }
  if (await env.RATE.get('acctpinlock:' + phone).catch(() => null)) return [429, 'pin-locked'];
  if (await d.overBudget(env, 'rl:acctpind:' + phone, PIN_DAY, 86400)) {
    await env.RATE.put('acctpinlock:' + phone, new Date().toISOString(), { expirationTtl: 30 * 86400 }).catch(() => {});
    await d.logEvent(env, { area: 'אזור אישי', action: 'קוד הכניסה ננעל אחרי יותר מדי ניסיונות', ok: false, review: true, phone }).catch(() => {});
    return [429, 'pin-locked'];
  }
  if (await d.overBudget(env, 'rl:acctpinh:' + phone, PIN_HOUR, 3600)) return [429, 'rate-limited'];
  const want = await pinFor(env, phone);
  return want && d.safeEqual(pin, want) ? null : [403, 'bad-login'];
}
/* 17/11 Richard ("תנעל"): with cfg:board_pin = 1 the board link alone does not open the board. The page must also
   carry a session of a phone this event belongs to (the PIN, the WhatsApp code or the personal area give one).
   Off switch: delete cfg:board_pin. → true when the request may see the event */
export async function boardLockOn(env) { try { return !!env.RATE && (await env.RATE.get('cfg:board_pin')) === '1'; } catch { return false; } }
export async function boardSessionOk(env, d, raw, token, session) {
  const phone = await verifySession(env, session, d.safeEqual);
  if (!phone) return false;
  /* 18/11: the PIN is checked against the phone on the token record, so that same phone must open the board.
     Asking the events sheet alone (paid, not cancelled, same owner cell) sent clients back to the code card
     after a correct code whenever the sheet row and the record disagreed. */
  try { const rec = d.tokenRecord ? await d.tokenRecord(env, token) : null; if (rec && d.normPhone(rec.phone || '') === phone) return true; } catch {}
  return d.eventsForPhone(raw, phone).some(e => e.token === token);
}
const tail = phone => String(phone || '').slice(-2);

/* ── KV helpers ──────────────────────────────────────────────────────────── */
async function kvJson(env, k) { try { return JSON.parse(await env.RATE.get(k)) || null; } catch { return null; } }
export async function readLedger(env, phone) { return (await kvJson(env, 'credit:' + phone)) || { entries: [], redeemed: [] }; }
export async function addCredit(env, phone, entry) {
  const l = await readLedger(env, phone);
  l.entries = Array.isArray(l.entries) ? l.entries : [];
  l.entries.push({ ...entry, at: entry.at || new Date().toISOString() });
  await env.RATE.put('credit:' + phone, JSON.stringify(l));
  return ledgerBalance(l);
}
export async function readContact(env, phone) { return (await kvJson(env, 'contact:' + phone)) || { email: '', phone_alt: '', marketing: null }; }

/* the email we know for this phone: the contact card first, then the leads sheet (column D) */
export function emailFromLeads(raw, phone) {
  const last9 = String(phone || '').slice(-9);
  for (const r of (raw && raw.leads && raw.leads.values) || []) {
    if (String((r || [])[2] || '').replace(/\D/g, '').endsWith(last9) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(r[3] || '').trim())) return String(r[3]).trim();
  }
  return '';
}
export const validEmail = e => /^[^@\s]{1,64}@[^@\s]{1,255}\.[a-z]{2,}$/i.test(String(e || '').trim());

/* ── the delivery ladder ─────────────────────────────────────────────────── */
export async function sendLoginCode(env, phone, code, { email = '', d }) {
  const tried = [];
  let r = await d.sendOtpTemplate(env, phone, code, 'client').catch(e => ({ ok: false, error: String(e && e.message) }));
  if (r && r.ok) return { ok: true, via: 'whatsapp' };
  tried.push('noa: ' + (r && r.error));
  r = await d.sendOtpTemplate(env, phone, code, 'guests').catch(e => ({ ok: false, error: String(e && e.message) }));
  if (r && r.ok) return { ok: true, via: 'whatsapp-guests' };
  tried.push('guests: ' + (r && r.error));
  if (email && d.sendEmail) {
    const e = await d.sendEmail(env, {
      to: email, from: { email: 'info@ishur.io', name: 'ishur.io' }, subject: `${code} · קוד הכניסה לאזור האישי`,
      text: `קוד הכניסה שלכם לאזור האישי ב-ishur.io: ${code}\nתקף 10 דקות, לשימוש חד-פעמי. אם לא ביקשתם אותו, התעלמו מההודעה.`,
      html: `<div dir="rtl" style="font-family:Heebo,Arial,sans-serif;font-size:16px;color:#111"><p>קוד הכניסה שלכם לאזור האישי ב-ishur.io:</p><p style="font-size:28px;letter-spacing:.3em;font-weight:700">${code}</p><p style="color:#555;font-size:13px">תקף 10 דקות, לשימוש חד-פעמי. אם לא ביקשתם אותו, התעלמו מההודעה.</p></div>`,
    }).catch(e2 => ({ ok: false, error: String(e2 && e2.message) }));
    if (e && e.ok) return { ok: true, via: 'email', to: email.replace(/^(.).*@/, '$1***@') };
    tried.push('email: ' + (e && e.error));
  }
  return { ok: false, error: 'send-failed', tried };
}

/* ── routes ──────────────────────────────────────────────────────────────── */
const code6 = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

/* POST /api/account/otp · login · me · logout · contact */
/* 22/11 Richard: "send the sign-in code to the client" from the clients screen. The same message and the same order as
   when the client asks for it on the board: a WhatsApp text inside the 24h window, otherwise the ishur_kod template or
   the email on file. Only to the phone of the event, only 09:00–21:00 (no WhatsApp to clients at night), 5 an hour. */
export async function adminSendPin(env, d, phone, { now = new Date() } = {}) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(now));
  if (hour < 9 || hour >= 21) return { ok: false, why: 'quiet-hours' };
  if (await d.overBudget(env, 'rl:apinsend:' + phone, 5, 3600)) return { ok: false, why: 'rate-limited' };
  const pin = await pinFor(env, phone);
  let sent = d.sendText ? await d.sendText(env, phone, `קוד הכניסה שלכם ללוח הבקרה ולאזור האישי ב-ishur.io: ${pin}\nהוא קבוע, כדאי לשמור אותו.`, 'client').catch(() => null) : null;
  let via = 'whatsapp';
  if (!sent || !sent.ok) { const r = await sendLoginCode(env, phone, pin, { email: '', d }); sent = r; via = (r && r.via) || ''; }
  const ok = !!(sent && sent.ok);
  await d.logEvent(env, { area: 'אזור אישי', action: ok ? `קוד הכניסה הקבוע נשלח ללקוח ע"י מנהל (${via})` : 'קוד הכניסה הקבוע לא נשלח (מנהל)', ok, review: !ok, phone }).catch(() => {});
  return ok ? { ok: true, via } : { ok: false, why: 'send-failed' };
}

export async function handleAccount(request, env, origin, url, d) {
  const path = url.pathname.replace(/^\/api\/account\//, '');
  if (request.method !== 'POST') return d.deny(404, 'unknown-account-route', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  /* 18/11: clients typed the right PIN and saw "wrong code"; nothing recorded why. Every refused PIN sign-in now leaves a journal row with the reason. */
  const pinFail = (why, x = {}) => d.logEvent(env, { area: 'אזור אישי', action: 'כניסה עם קוד קבוע נדחתה: ' + why, ok: false, review: true, phone: x.phone || '', token: String(x.token || '').slice(0, 8),
    detail: `${path} · ${String(request.headers.get('User-Agent') || '').slice(0, 90)} · ${String(request.headers.get('Origin') || '').slice(0, 40)}` }).catch(() => {});

  if (path === 'otp') {
    const phone = d.normPhone(b.phone || '');
    if (!/^972\d{8,9}$/.test(phone)) return d.deny(400, 'bad-phone', origin);
    if (await d.overBudget(env, 'rl:acctotp:' + phone, 3, 3600)) return d.deny(429, 'rate-limited', origin);
    if (await d.overBudget(env, 'rl:acctotpi:' + ip, 10, 3600)) return d.deny(429, 'rate-limited', origin);
    const raw = await d.readSnapshot(env, 'dashboard').catch(() => null);
    if (!raw) return d.deny(502, 'reader-failed', origin);
    const evs = d.eventsForPhone(raw, phone);
    if (!evs.length) return d.deny(404, 'no-events', origin);
    const code = code6();
    await env.RATE.put('acctotp:' + phone, JSON.stringify({ code, tries: 0, at: Date.now(), id: crypto.randomUUID() }), { expirationTtl: OTP_TTL });
    const contact = await readContact(env, phone);
    const email = validEmail(contact.email) ? contact.email.trim() : emailFromLeads(raw, phone);
    const sent = await sendLoginCode(env, phone, code, { email, d });
    await d.logEvent(env, { area: 'אזור אישי', action: sent.ok ? `קוד כניסה נשלח (${sent.via})` : 'קוד כניסה לא נשלח', ok: sent.ok, review: !sent.ok, phone, token: evs[0].token, detail: sent.ok ? '' : (sent.tried || []).join(' · ').slice(0, 300) }).catch(() => {});
    if (!sent.ok) return d.deny(502, 'send-failed', origin);
    return d.okJson({ ok: true, via: sent.via, to: sent.to || '' }, origin);
  }

  /* 12/11 Richard: whoever comes from their own board (the personal link) is already
     identified by the event token — no phone, no code. The code stays for a bare visit. */
  if (path === 'from-token') {
    const tok = String(b.token || '').trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(tok)) return d.deny(403, 'bad-token', origin);
    if (await d.overBudget(env, 'rl:accttok:' + ip, 40, 3600)) return d.deny(429, 'rate-limited', origin);
    /* 17/11: with the board locked, the link alone is not an identity any more. The board already holds a session, and the page sends that one */
    if (await boardLockOn(env)) return d.deny(403, 'pin-required', origin);
    const rec = await d.tokenRecord(env, tok);
    const phone = rec ? d.normPhone(rec.phone || '') : '';
    if (!/^972\d{8,9}$/.test(phone)) return d.deny(403, 'bad-token', origin);
    const session = await mintSession(env, phone);
    await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה לאזור האישי מהלוח', ok: true, phone, token: tok }).catch(() => {});
    return d.okJson({ ok: true, session }, origin);
  }

  /* the board link + the PIN: the phone is the one the event was bought with, so only the PIN is typed */
  if (path === 'board-pin' || path === 'board-pin-send') {
    const tok = String(b.token || '').trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(tok)) { await pinFail('הקישור לא בצורת טוקן (' + String(b.token || '').length + ' תווים)'); return d.deny(403, 'bad-token', origin); }
    if (await d.overBudget(env, 'rl:bpintok:' + ip, 60, 3600)) { await pinFail('יותר מדי ניסיונות מאותה כתובת', { token: tok }); return d.deny(429, 'rate-limited', origin); }
    const rec = await d.tokenRecord(env, tok);
    const phone = rec ? d.normPhone(rec.phone || '') : '';
    if (!/^972\d{8,9}$/.test(phone)) { await pinFail(rec ? 'אין טלפון תקין ברשומת האירוע' : 'אין רשומת אירוע לטוקן', { token: tok }); return d.deny(403, 'bad-token', origin); }
    if (path === 'board-pin-send') {
      /* Richard: "תשלח למי שמבקש" — the PIN goes only to the phone on file, never to a number the visitor types */
      if (await d.overBudget(env, 'rl:bpinsend:' + phone, 3, 3600) || await d.overBudget(env, 'rl:bpinsendd:' + phone, 6, 86400)) return d.deny(429, 'rate-limited', origin);
      const pin = await pinFor(env, phone);
      let sent = d.sendText ? await d.sendText(env, phone, `קוד הכניסה שלכם ללוח הבקרה ולאזור האישי ב-ishur.io: ${pin}\nהוא קבוע, כדאי לשמור אותו.`, 'client').catch(() => null) : null;
      let via = 'whatsapp';
      if (!sent || !sent.ok) { const r = await sendLoginCode(env, phone, pin, { email: '', d }); sent = r; via = r.via || ''; }
      await d.logEvent(env, { area: 'אזור אישי', action: sent && sent.ok ? `קוד הכניסה הקבוע נשלח לבקשת הלקוח (${via})` : 'קוד הכניסה הקבוע לא נשלח', ok: !!(sent && sent.ok), review: !(sent && sent.ok), phone, token: tok }).catch(() => {});
      if (!sent || !sent.ok) return d.deny(502, 'send-failed', origin);
      return d.okJson({ ok: true, to: tail(phone) }, origin);
    }
    const pin = String(b.pin || '').replace(/\D/g, '');
    if (pin.length !== 4) { await pinFail('הגיעו ' + pin.length + ' ספרות במקום 4 (נשלחו ' + String(b.pin || '').length + ' תווים)', { phone, token: tok }); return d.deny(403, 'bad-login', origin); }
    const bad = await tryPin(env, d, phone, pin, ip);
    if (bad) { await pinFail(bad[1] === 'bad-login' ? 'הקוד שהוקלד שונה מהקוד של הלקוח' : bad[1], { phone, token: tok }); return d.deny(bad[0], bad[1], origin); }
    const session = await mintSession(env, phone);
    await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה ללוח הבקרה עם קוד קבוע', ok: true, phone, token: tok }).catch(() => {});
    return d.okJson({ ok: true, session }, origin);
  }

  if (path === 'pin-login') {
    const phone = d.normPhone(b.phone || '');
    const pin = String(b.pin || '').replace(/\D/g, '');
    if (!/^972\d{8,9}$/.test(phone) || pin.length !== 4) { await pinFail(pin.length !== 4 ? 'הגיעו ' + pin.length + ' ספרות במקום 4' : 'מספר טלפון לא תקין', { phone }); return d.deny(403, 'bad-login', origin); }
    const bad = await tryPin(env, d, phone, pin, ip);
    if (bad) { await pinFail(bad[1] === 'bad-login' ? 'הקוד שהוקלד שונה מהקוד של הלקוח' : bad[1], { phone }); return d.deny(bad[0], bad[1], origin); }
    const raw = await d.readSnapshot(env, 'dashboard').catch(() => null);
    if (!raw) { await pinFail('הגיליון לא נקרא', { phone }); return d.deny(502, 'reader-failed', origin); }
    if (!d.eventsForPhone(raw, phone).length) { await pinFail('הקוד נכון אבל אין אירוע משולם על המספר הזה בגיליון', { phone }); return d.deny(403, 'bad-login', origin); }
    /* 22/11 Richard: once a phone is linked to Apple or Google, the APP signs it in only that way (the website keeps the
       code; the App Store reviewer's demo phone stays on the code). Asked only after a correct code, so this tells a
       guesser nothing. */
    if (b.app && !isReviewPhone(env, phone) && (await linkedTo(env, phone)).length) return d.deny(403, 'use-identity', origin);
    const session = await mintSession(env, phone);
    await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה לאזור האישי עם קוד קבוע', ok: true, phone }).catch(() => {});
    return d.okJson({ ok: true, session }, origin);
  }

  if (path === 'login') {
    const phone = d.normPhone(b.phone || '');
    const code = String(b.code || '').replace(/\D/g, '');
    if (!/^972\d{8,9}$/.test(phone) || code.length !== 6) return d.deny(403, 'bad-login', origin);
    if (await d.overBudget(env, 'rl:acctlogin:' + phone, 20, 3600)) return d.deny(429, 'rate-limited', origin);
    /* 12/11 security: guesses are limited per IP too; each guess is counted (in this isolate, then on the
       record) before the code is compared, so a parallel burst cannot buy more than OTP_TRIES tries */
    if ((d.memOver && d.memOver('acctlogini:' + ip, 30, 3600)) || await d.overBudget(env, 'rl:acctlogini:' + ip, 30, 3600)) return d.deny(429, 'rate-limited', origin);
    const rec = await kvJson(env, 'acctotp:' + phone);
    if (!rec) return d.deny(403, 'bad-login', origin);
    const left = Math.max(60, OTP_TTL - Math.floor((Date.now() - (rec.at || Date.now())) / 1000));
    if (d.otpAttemptAllowed) { if (!(await d.otpAttemptAllowed(env, 'acctotp:' + phone, rec, OTP_TRIES, left))) return d.deny(403, 'bad-login', origin); }
    else rec.tries = (rec.tries || 0) + 1;
    if (rec.tries > OTP_TRIES || !d.safeEqual(code, String(rec.code))) {
      if (rec.tries >= OTP_TRIES) await env.RATE.delete('acctotp:' + phone).catch(() => {});
      else if (!d.otpAttemptAllowed) await env.RATE.put('acctotp:' + phone, JSON.stringify(rec), { expirationTtl: left });
      return d.deny(403, 'bad-login', origin);
    }
    await env.RATE.delete('acctotp:' + phone).catch(() => {});
    await env.RATE.delete('acctpinlock:' + phone).catch(() => {});   /* the WhatsApp code proves the owner: a locked PIN opens again */
    const session = await mintSession(env, phone);
    await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה לאזור האישי', ok: true, phone }).catch(() => {});
    return d.okJson({ ok: true, session }, origin);
  }

  /* 16/11 Richard: someone with no event yet registers with an email and gets a code there. The account is the
     email itself and never claims a phone, so it can never open another person's events: events are reached only
     by the phone they were bought with (the code to that phone, or the personal link). */
  if (path === 'email-otp') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email) || email.length > 120) return d.deny(400, 'bad-email', origin);
    if (await d.overBudget(env, 'rl:acctotpe:' + email, 3, 3600)) return d.deny(429, 'rate-limited', origin);
    if (await d.overBudget(env, 'rl:acctotpi:' + ip, 10, 3600)) return d.deny(429, 'rate-limited', origin);
    if (!d.sendEmail) return d.deny(502, 'send-failed', origin);
    const code = code6();
    await env.RATE.put('acctotpe:' + email, JSON.stringify({ code, tries: 0, at: Date.now() }), { expirationTtl: OTP_TTL });
    const e = await d.sendEmail(env, { to: email, from: { email: 'info@ishur.io', name: 'ishur.io' }, subject: `${code} · קוד הכניסה לאזור האישי`,
      text: `קוד הכניסה שלכם לאזור האישי ב-ishur.io: ${code}\nתקף 10 דקות, לשימוש חד-פעמי. אם לא ביקשתם אותו, התעלמו מההודעה.`,
      html: `<div dir="rtl" style="font-family:Heebo,Arial,sans-serif;font-size:16px;color:#111"><p>קוד הכניסה שלכם לאזור האישי ב-ishur.io:</p><p style="font-size:28px;letter-spacing:.3em;font-weight:700">${code}</p><p style="color:#555;font-size:13px">תקף 10 דקות, לשימוש חד-פעמי. אם לא ביקשתם אותו, התעלמו מההודעה.</p></div>` }).catch(e2 => ({ ok: false, error: String(e2 && e2.message) }));
    await d.logEvent(env, { area: 'אזור אישי', action: e && e.ok ? 'קוד כניסה נשלח למייל (משתמש בלי אירוע)' : 'קוד כניסה למייל לא נשלח', ok: !!(e && e.ok), review: !(e && e.ok), detail: e && e.ok ? '' : String((e && e.error) || '').slice(0, 120) }).catch(() => {});
    if (!e || !e.ok) return d.deny(502, 'send-failed', origin);
    return d.okJson({ ok: true, via: 'email' }, origin);
  }
  if (path === 'email-login') {
    const email = String(b.email || '').trim().toLowerCase(), code = String(b.code || '').replace(/\D/g, '');
    if (!validEmail(email) || code.length !== 6) return d.deny(403, 'bad-login', origin);
    if (await d.overBudget(env, 'rl:acctlogine:' + email, 20, 3600)) return d.deny(429, 'rate-limited', origin);
    if ((d.memOver && d.memOver('acctlogini:' + ip, 30, 3600)) || await d.overBudget(env, 'rl:acctlogini:' + ip, 30, 3600)) return d.deny(429, 'rate-limited', origin);
    const rec = await kvJson(env, 'acctotpe:' + email);
    if (!rec) return d.deny(403, 'bad-login', origin);
    rec.tries = (rec.tries || 0) + 1;
    const left = Math.max(60, OTP_TTL - Math.floor((Date.now() - (rec.at || Date.now())) / 1000));
    if (rec.tries > OTP_TRIES || !d.safeEqual(code, String(rec.code))) {
      if (rec.tries >= OTP_TRIES) await env.RATE.delete('acctotpe:' + email).catch(() => {}); else await env.RATE.put('acctotpe:' + email, JSON.stringify(rec), { expirationTtl: left });
      return d.deny(403, 'bad-login', origin);
    }
    await env.RATE.delete('acctotpe:' + email).catch(() => {});
    const prev = await kvJson(env, 'acctuser:' + email);
    await env.RATE.put('acctuser:' + email, JSON.stringify({ email, at: (prev && prev.at) || new Date().toISOString(), last: new Date().toISOString() }));
    if (!prev) await d.logEvent(env, { area: 'אזור אישי', action: 'משתמש חדש נרשם במייל (עוד בלי אירוע)', ok: true }).catch(() => {});
    return d.okJson({ ok: true, session: await mintEmailSession(env, email), new_user: !prev }, origin);
  }
  const mail = await verifyEmailSession(env, b.session, d.safeEqual);
  if (mail) {
    if (path === 'me') return d.okJson({ ok: true, kind: 'email', email: mail, events: [], today: d.today() }, origin);
    if (path === 'logout') { const n = (String(b.session).match(/\.([0-9a-f]{32})\.[0-9a-f]{32}$/) || [])[1]; if (n) await env.RATE.put('acctrev:' + n, '1', { expirationTtl: SESSION_DAYS * 86400 }).catch(() => {}); return d.okJson({ ok: true }, origin); }
    return d.deny(403, 'email-account', origin);
  }

  /* 22/11 Sign in with Apple / Google (identity.js): a linked account signs in to the app */
  if (path === 'id-login') {
    if (!PROVIDERS.includes(b.provider)) return d.deny(400, 'unknown-provider', origin);
    if ((d.memOver && d.memOver('idlogin:' + ip, 30, 3600)) || await d.overBudget(env, 'rl:idlogin:' + ip, 30, 3600)) return d.deny(429, 'rate-limited', origin);
    const id = await verifyIdToken(env, b.provider, b.id_token);
    if (!id.ok) { await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה עם ' + b.provider + ' נדחתה: ' + id.error, ok: false }).catch(() => {}); return d.deny(id.error === 'not-configured' ? 503 : 403, id.error, origin); }
    const owner = await phoneForIdentity(env, id);
    if (!owner) return d.deny(404, 'not-linked', origin);
    await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה לאפליקציה עם ' + (b.provider === 'apple' ? 'Apple' : 'Google'), ok: true, phone: owner }).catch(() => {});
    return d.okJson({ ok: true, session: await mintSession(env, owner) }, origin);
  }
  /* an admin unlinks a phone (the client lost the Apple/Google account; the code then works in the app once more) */
  if (path === 'unlink-identity') {
    if (!env.ADMIN_KEY || !d.safeEqual(String(b.admin_key || ''), String(env.ADMIN_KEY))) return d.deny(403, 'bad-admin-key', origin);
    return d.okJson({ ok: true, removed: await unlinkAll(env, d.normPhone(b.phone || '')) }, origin);
  }

  /* everything below needs a session */
  const phone = await verifySession(env, b.session, d.safeEqual);
  if (!phone) return d.deny(403, 'bad-session', origin);

  if (path === 'logout') {
    const n = nonceOf(b.session);
    await env.RATE.put('acctrev:' + n, '1', { expirationTtl: SESSION_DAYS * 86400 }).catch(() => {});
    await env.RATE.delete('acctsess:' + n).catch(() => {});
    return d.okJson({ ok: true }, origin);
  }

  /* 22/11 link Apple / Google to this phone (asked in the app right after the first sign-in with the code) */
  if (path === 'link-identity') {
    if (!PROVIDERS.includes(b.provider)) return d.deny(400, 'unknown-provider', origin);
    const id = await verifyIdToken(env, b.provider, b.id_token);
    if (!id.ok) return d.deny(id.error === 'not-configured' ? 503 : 403, id.error, origin);
    const r = await linkIdentity(env, phone, id);
    if (!r.ok) return d.deny(409, r.error, origin);
    await d.logEvent(env, { area: 'אזור אישי', action: 'חשבון ' + (b.provider === 'apple' ? 'Apple' : 'Google') + ' חובר לאפליקציה', ok: true, phone }).catch(() => {});
    return d.okJson({ ok: true, linked: r.linked }, origin);
  }
  if (path === 'identities') {
    const mine = await linkedTo(env, phone);
    return d.okJson({ ok: true, linked: mine.map(x => x.provider), review: isReviewPhone(env, phone) }, origin);
  }

  if (path === 'contact') {
    const c = await readContact(env, phone);
    if (b.email !== undefined) { const e = String(b.email || '').trim(); if (e && !validEmail(e)) return d.deny(400, 'bad-email', origin); c.email = e; }
    if (b.phone_alt !== undefined) { const p = b.phone_alt ? d.normPhone(b.phone_alt) : ''; if (p && !/^9725\d{8}$/.test(p)) return d.deny(400, 'bad-phone', origin); c.phone_alt = p; }
    if (b.marketing !== undefined) { if (typeof b.marketing !== 'boolean') return d.deny(400, 'bad-marketing', origin); c.marketing = b.marketing; }
    c.at = new Date().toISOString();
    await env.RATE.put('contact:' + phone, JSON.stringify(c));
    await d.logEvent(env, { area: 'אזור אישי', action: `פרטי קשר עודכנו${b.marketing !== undefined ? (b.marketing ? ' · דיוור: כן' : ' · דיוור: לא') : ''}`, ok: true, phone, detail: [c.email ? 'מייל' : '', c.phone_alt ? 'טלפון חלופי' : ''].filter(Boolean).join(' · ') }).catch(() => {});
    return d.okJson({ ok: true, contact: c }, origin);
  }

  if (path === 'me') {
    const raw = await d.readSnapshot(env, 'dashboard').catch(() => null);
    if (!raw) return d.deny(502, 'reader-failed', origin);
    const evs = d.eventsForPhone(raw, phone);
    const fbs = {};
    await Promise.all(evs.map(async e => { fbs[e.token] = await kvJson(env, 'fb:' + e.token); }));
    const [ledger, contact] = await Promise.all([readLedger(env, phone), readContact(env, phone)]);
    const balance = ledgerBalance(ledger);
    return d.okJson({
      ok: true, phone, today: d.today(), pin: await pinFor(env, phone),   /* 17/11: shown in the personal area, so a client who came in from the board link knows it */
      /* 12/11 Richard: each event card shows its numbers (invited / coming / not yet answered) */
      events: (() => {
        const st = {};
        for (const g of ((raw.guests && raw.guests.values) || [])) {
          const t = String((g || [])[28] || '').trim(); if (!t) continue;
          const s = st[t] || (st[t] = { total: 0, yes: 0, no: 0, pending: 0 });
          const r = String(g[15] || '').trim();
          s.total++; if (r === 'מגיע') s.yes++; else if (r === 'לא מגיע') s.no++; else s.pending++;
        }
        return eventsView(evs, fbs, d.today()).map(e => ({ ...e, stats: st[e.token] || { total: 0, yes: 0, no: 0, pending: 0 } }));
      })(),
      credit: { balance_ils: balance, entries: (ledger.entries || []).slice(-50).reverse().map(e => ({ kind: e.kind, kind_he: KIND_HE[e.kind] || e.kind, ils: e.ils, at: e.at, token8: String(e.token || '').slice(0, 8) })), redeem_url: `https://wa.me/${WA_NOA}?text=${encodeURIComponent(`היי נועה, יש לי ₪${balance} זיכוי באזור האישי ואני רוצה לממש`)}` },
      contact: { email: contact.email || '', phone_alt: contact.phone_alt || '', marketing: contact.marketing === true },
      /* 12/11 Richard: the "הזמן חבר" card works here exactly as on the board — for the nearest event that is not over */
      referral: await (async () => {
        const t = d.today();
        const live = evs.filter(e => !isPast(e.event_date, t)).sort((a, b) => (isoDay(a.event_date) || '9').localeCompare(isoDay(b.event_date) || '9'))[0] || evs[0];
        if (!live || !d.referralSummary) return null;
        try { return { token: live.token, ...(await d.referralSummary(env, live.token)) }; } catch { return null; }
      })(),
    }, origin);
  }
  return d.deny(404, 'unknown-account-route', origin);
}

/* POST /api/review-claim {token, kind:'video'|'google'} — token-authed like /api/feedback; the
   credit goes to the owner phone (column D). Idempotent per (token, kind). */
export async function handleReviewClaim(request, env, origin, d) {
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  const token = String(b.token || '').trim().toLowerCase();
  const kind = String(b.kind || '');
  if (!/^[0-9a-f-]{20,40}$/.test(token)) return d.deny(400, 'bad-token', origin);
  if (!CLAIM_KINDS[kind]) return d.deny(400, 'bad-kind', origin);
  if (await d.overBudget(env, 'rl:claim:' + token, 10, 3600)) return d.deny(429, 'slow-down', origin);
  const raw = await d.readSnapshot(env, 'guest').catch(() => null);
  const ev = ((raw && raw.events && raw.events.values) || []).find(r => String((r || [])[1] || '').trim().toLowerCase() === token);
  if (!ev) return d.deny(404, 'bad-token', origin);
  const phone = d.normPhone(ev[3] || '');
  const fb = (await kvJson(env, 'fb:' + token)) || {};
  const st = reviewState(fb);
  if (!st.scored) return d.deny(409, 'not-scored', origin);
  if (kind === 'video' && st.route !== 'high') return d.deny(409, 'low-score', origin);
  if (fb[kind + '_at']) return d.okJson({ ok: true, already: true, ils: 0, balance_ils: ledgerBalance(await readLedger(env, phone)) }, origin);
  fb[kind + '_at'] = new Date().toISOString();
  await env.RATE.put('fb:' + token, JSON.stringify(fb));
  const ils = CREDIT_ILS[kind] || 0;
  const balance = ils ? await addCredit(env, phone, { kind: 'review_' + kind, ils, token }) : ledgerBalance(await readLedger(env, phone));
  const evName = String(ev[34] || ev[2] || token.slice(0, 8)).trim();
  await d.logEvent(env, { area: 'סוף-אירוע', action: `${KIND_HE['review_' + kind]} נרשמה` + (ils ? ` · ₪${ils} זיכוי (יתרה ₪${balance})` : ' (ללא זיכוי)'), ok: true, token, phone }).catch(() => {});
  await d.slackSend(env, `⭐ *${KIND_HE['review_' + kind]}* · ${evName} · ${phone}` + (ils ? `\n₪${ils} נזקפו לזיכוי · יתרה ₪${balance}` : ''), { oneoff: true }).catch(() => {});
  return d.okJson({ ok: true, ils, balance_ils: balance, video: !!fb.video_at, google: !!fb.google_at }, origin);
}
