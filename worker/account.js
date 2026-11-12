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

export const CREDIT_ILS = { video: 30, google: 20 };
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
const nonceOf = token => (String(token || '').match(/^acct\.\d+\.([0-9a-f]{32})\./) || [])[1] || '';

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
export async function handleAccount(request, env, origin, url, d) {
  const path = url.pathname.replace(/^\/api\/account\//, '');
  if (request.method !== 'POST') return d.deny(404, 'unknown-account-route', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

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
    const rec = await d.tokenRecord(env, tok);
    const phone = rec ? d.normPhone(rec.phone || '') : '';
    if (!/^972\d{8,9}$/.test(phone)) return d.deny(403, 'bad-token', origin);
    const session = await mintSession(env, phone);
    await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה לאזור האישי מהלוח', ok: true, phone, token: tok }).catch(() => {});
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
    const session = await mintSession(env, phone);
    await d.logEvent(env, { area: 'אזור אישי', action: 'כניסה לאזור האישי', ok: true, phone }).catch(() => {});
    return d.okJson({ ok: true, session }, origin);
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
      ok: true, phone, today: d.today(),
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
  if (!CREDIT_ILS[kind]) return d.deny(400, 'bad-kind', origin);
  if (await d.overBudget(env, 'rl:claim:' + token, 10, 3600)) return d.deny(429, 'slow-down', origin);
  const raw = await d.readSnapshot(env, 'guest').catch(() => null);
  const ev = ((raw && raw.events && raw.events.values) || []).find(r => String((r || [])[1] || '').trim().toLowerCase() === token);
  if (!ev) return d.deny(404, 'bad-token', origin);
  const phone = d.normPhone(ev[3] || '');
  const fb = (await kvJson(env, 'fb:' + token)) || {};
  const st = reviewState(fb);
  if (!st.scored) return d.deny(409, 'not-scored', origin);
  if (st.route !== 'high') return d.deny(409, 'low-score', origin);
  if (fb[kind + '_at']) return d.okJson({ ok: true, already: true, ils: 0, balance_ils: ledgerBalance(await readLedger(env, phone)) }, origin);
  fb[kind + '_at'] = new Date().toISOString();
  await env.RATE.put('fb:' + token, JSON.stringify(fb));
  const ils = CREDIT_ILS[kind];
  const balance = await addCredit(env, phone, { kind: 'review_' + kind, ils, token });
  const evName = String(ev[34] || ev[2] || token.slice(0, 8)).trim();
  await d.logEvent(env, { area: 'סוף-אירוע', action: `${KIND_HE['review_' + kind]} נרשמה · ₪${ils} זיכוי (יתרה ₪${balance})`, ok: true, token, phone }).catch(() => {});
  await d.slackSend(env, `⭐ *${KIND_HE['review_' + kind]}* · ${evName} · ${phone}\n₪${ils} נזקפו לזיכוי · יתרה ₪${balance}`, { oneoff: true }).catch(() => {});
  return d.okJson({ ok: true, ils, balance_ils: balance, video: !!fb.video_at, google: !!fb.google_at }, origin);
}
