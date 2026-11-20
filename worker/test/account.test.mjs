// node --test worker/test/account.test.mjs — the personal area (account.js) through the real Worker fetch().
// Snapshot hook stubbed; Meta / Slack / email never leave the machine (fetch stub records and answers).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import * as A from '../account.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init)), ttl = new Map();
  return { m, ttl, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v, o) => { m.set(k, typeof v === 'string' ? v : String(v)); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) };
}
const TOK = '11111111-2222-3333-4444-555555555555', TOK2 = 'aaaaaaaa-2222-3333-4444-555555555555', TOK3 = 'bbbbbbbb-2222-3333-4444-555555555555';
const PHONE = '972521234567', OTHER = '972529999999';
/* events: [_, token, name, phone(D), venue(E), occasion(F), date(G), paid(H), ...]; cancelled = [27]; event_name = [34] */
const row = (tok, name, phone, date, paid = 'כן') => { const r = Array(47).fill(''); r[1] = tok; r[2] = name; r[3] = phone; r[4] = 'אולם'; r[5] = 'חתונה'; r[6] = date; r[7] = paid; r[34] = name + ' והחברים'; return r; };
const SNAP = { events: { values: [row(TOK, 'דנה', '0521234567', '2026-12-20'), row(TOK2, 'דנה', '0521234567', '2026-10-01'), row(TOK3, 'יוסי', '0529999999', '2026-09-01')] }, guests: { values: [] },
  leads: { values: [['', 'דנה', '0521234567', 'dana@example.com']] } };
let realFetch; let calls = [];
let metaMode = 'ok';   // 'ok' | 'noa-131042' | 'all-fail'
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(SNAP));
    calls.push({ u, body: init.body ? String(init.body) : '' });
    if (/graph\.facebook\.com\/v[\d.]+\/([^/]+)\/messages/.test(u)) {
      const pid = u.match(/\/([^/]+)\/messages/)[1];
      const fail = metaMode === 'all-fail' || (metaMode === 'noa-131042' && pid === 'NOA');
      if (fail) return new Response(JSON.stringify({ error: { code: 131042, message: 'Business eligibility payment issue' } }), { status: 400 });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + pid }] }));
    }
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; metaMode = 'ok'; });
const emailSent = [];
const env = (init = {}, extra = {}) => ({ ADMIN_KEY: 'k', APP_KEY: 'app', HOOK_STATUS: 'https://hook.test/status', WA_TOKEN: 't', WA_PHONE_ID_CLIENT: 'NOA', WA_PHONE_ID_GUESTS: 'SHIR', WA_TOKEN_GUESTS: 'tg', RAFFLE: JSON.stringify({ on: false }), RATE: kv(init),
  EMAIL: { send: async msg => { emailSent.push(msg); return { messageId: 'em1' }; } }, ...extra });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) }), e, ctx).then(r => r.json().then(j => ({ status: r.status, ...j })));
const otpCode = e => JSON.parse(e.RATE.m.get('acctotp:' + PHONE)).code;
async function login(e) { await post(e, '/api/account/otp', { phone: '0521234567' }); const r = await post(e, '/api/account/login', { phone: '0521234567', code: otpCode(e) }); assert.equal(r.status, 200); return r.session; }

test('pure: routeOf is 6-and-up on both scores', () => {
  assert.equal(A.routeOf(6, 6), 'high'); assert.equal(A.routeOf(5, 6), 'low'); assert.equal(A.routeOf(10, 5), 'low'); assert.equal(A.routeOf(0, 0), 'low');
});
test('pure: ledger balance, dates, review state, events view', () => {
  assert.equal(A.ledgerBalance({ entries: [{ ils: 30 }, { ils: 20 }], redeemed: [{ ils: 10 }] }), 40);
  assert.equal(A.ledgerBalance(null), 0);
  assert.equal(A.isoDay('2026-12-20'), '2026-12-20'); assert.equal(A.isoDay('5/1/2026'), '2026-01-05'); assert.equal(A.isoDay('x'), '');
  assert.equal(A.isPast('2026-10-01', '2026-11-12'), true); assert.equal(A.isPast('2026-11-12', '2026-11-12'), false); assert.equal(A.isPast('', '2026-11-12'), false);
  assert.deepEqual(A.reviewState(null), { scored: false, route: '', video: false, google: false, nps: null, exp: null });
  const v = A.eventsView([{ token: 'b', event_name: 'B', event_date: '2026-10-01' }, { token: 'a', event_name: 'A', event_date: '2026-12-20' }, { token: 'c', event_name: 'C', event_date: '2026-09-01' }],
    { b: { nps: 8, exp: 9, route: 'high', google_at: 'x' }, c: { nps: 3, exp: 9, route: 'low' } }, '2026-11-12');
  assert.deepEqual(v.map(e => e.token), ['a', 'b', 'c'], 'upcoming first, then past newest first');
  assert.equal(v[0].past, false); assert.equal(v[0].next, 'none');
  assert.equal(v[1].next, 'claim'); assert.equal(v[1].review.google, true); assert.equal(v[1].review.video, false);
  assert.equal(v[2].next, 'none', 'low score: nothing offered');
  assert.equal(A.eventsView([{ token: 'd', event_date: '2026-01-01' }], {}, '2026-11-12')[0].next, 'score');
  assert.equal(A.eventsView([{ token: 'd', event_date: '2026-01-01' }], { d: { nps: 9, exp: 9, video_at: 'x', google_at: 'y' } }, '2026-11-12')[0].next, 'done');
  assert.match(v[0].dashboard_url, /dashboard\.html\?t=a$/);
});
test('pure: email from the leads sheet by phone', () => {
  assert.equal(A.emailFromLeads(SNAP, PHONE), 'dana@example.com'); assert.equal(A.emailFromLeads(SNAP, OTHER), '');
  assert.equal(A.validEmail('a@b.co'), true); assert.equal(A.validEmail('nope'), false);
});
test('pure: session mint + verify, tamper → empty', async () => {
  const e = env(); const safeEqual = (a, b) => a === b;
  const s = await A.mintSession(e, PHONE);
  assert.match(s, /^acct\.972521234567\.[0-9a-f]{32}\.[0-9a-f]{32}$/);
  assert.equal(await A.verifySession(e, s, safeEqual), PHONE);
  assert.equal(await A.verifySession(e, s.slice(0, -1) + (s.endsWith('0') ? '1' : '0'), safeEqual), '');
  assert.equal(await A.verifySession(e, s.replace(PHONE, OTHER), safeEqual), '', 'phone swap breaks the signature');
  assert.equal(await A.verifySession({ ADMIN_KEY: 'other', RATE: e.RATE }, s, safeEqual), '', 'another key');
});

test('otp: 404 for a phone with no paid event, 400 bad phone', async () => {
  const e = env();
  assert.equal((await post(e, '/api/account/otp', { phone: '0501111111' })).status, 404);
  assert.equal((await post(e, '/api/account/otp', { phone: 'abc' })).status, 400);
});
test('otp: 200, code stored 10 min, ishur_kod goes to Noa; 3/h per phone', async () => {
  const e = env();
  const r = await post(e, '/api/account/otp', { phone: '0521234567' });
  assert.equal(r.status, 200); assert.equal(r.via, 'whatsapp');
  assert.equal(e.RATE.ttl.get('acctotp:' + PHONE), 600);
  assert.match(otpCode(e), /^\d{6}$/);
  const meta = calls.filter(c => /\/NOA\/messages/.test(c.u)); assert.equal(meta.length, 1); assert.match(meta[0].body, /ishur_kod/); assert.ok(meta[0].body.includes(otpCode(e)));
  await post(e, '/api/account/otp', { phone: '0521234567' }); await post(e, '/api/account/otp', { phone: '0521234567' });
  assert.equal((await post(e, '/api/account/otp', { phone: '0521234567' })).status, 429);
});
test('otp ladder: Noa 131042 → the guests number; both fail → email from the leads sheet; no email → 502', async () => {
  metaMode = 'noa-131042';
  let e = env(); let r = await post(e, '/api/account/otp', { phone: '0521234567' });
  assert.equal(r.status, 200); assert.equal(r.via, 'whatsapp-guests');
  assert.ok(calls.some(c => /\/SHIR\/messages/.test(c.u) && /ishur_kod/.test(c.body)), 'ishur_kod left from the guests phone id');
  metaMode = 'all-fail'; emailSent.length = 0;
  e = env(); r = await post(e, '/api/account/otp', { phone: '0521234567' });
  assert.equal(r.status, 200); assert.equal(r.via, 'email'); assert.equal(r.to, 'd***@example.com');
  assert.equal(emailSent.length, 1); assert.equal(emailSent[0].to, 'dana@example.com'); assert.ok(emailSent[0].text.includes(otpCode(e)));
  e = env(); r = await post(e, '/api/account/otp', { phone: '0529999999' });
  assert.equal(r.status, 502); assert.equal(r.error, 'send-failed');
  metaMode = 'all-fail'; e = env({ ['contact:' + OTHER]: JSON.stringify({ email: 'yossi@example.com' }) }); r = await post(e, '/api/account/otp', { phone: '0529999999' });
  assert.equal(r.via, 'email', 'the contact card email wins when the leads sheet has none');
});
test('login: 5 wrong tries delete the code; right code → acct. session; code is single-use', async () => {
  const e = env(); await post(e, '/api/account/otp', { phone: '0521234567' });
  for (let i = 0; i < 5; i++) assert.equal((await post(e, '/api/account/login', { phone: '0521234567', code: '000000' })).status, 403);
  assert.equal(e.RATE.m.has('acctotp:' + PHONE), false, 'code gone after 5 tries');
  calls = []; await post(e, '/api/account/otp', { phone: '0521234567' });
  const code = otpCode(e);
  const r = await post(e, '/api/account/login', { phone: '0521234567', code });
  assert.equal(r.status, 200); assert.match(r.session, /^acct\./);
  assert.equal((await post(e, '/api/account/login', { phone: '0521234567', code })).status, 403, 'single use');
});
test('me: 2 events with past flags + review states; 403 tampered; logout revokes', async () => {
  const e = env({ ['fb:' + TOK2]: JSON.stringify({ nps: 9, exp: 8, route: 'high', google_at: '2026-10-03T00:00:00Z' }) });
  const s = await login(e);
  const me = await post(e, '/api/account/me', { session: s });
  assert.equal(me.status, 200); assert.equal(me.phone, PHONE);
  assert.equal(me.events.length, 2);
  assert.equal(me.events[0].token, TOK); assert.equal(me.events[0].past, false);
  assert.equal(me.events[1].token, TOK2); assert.equal(me.events[1].past, true); assert.equal(me.events[1].next, 'claim'); assert.equal(me.events[1].review.google, true);
  assert.equal(me.credit.balance_ils, 0); assert.match(me.credit.redeem_url, /wa\.me\/972559504499/);
  assert.equal(me.contact.marketing, false);
  assert.equal((await post(e, '/api/account/me', { session: s.slice(0, -2) + 'zz' })).status, 403);
  assert.equal((await post(e, '/api/account/me', { session: 'x' })).status, 403);
  assert.equal((await post(e, '/api/account/logout', { session: s })).status, 200);
  assert.equal((await post(e, '/api/account/me', { session: s })).status, 403, 'revoked');
});
test('contact: bad email 400, saved email + marketing false show in me', async () => {
  const e = env(); const s = await login(e);
  assert.equal((await post(e, '/api/account/contact', { session: s, email: 'nope' })).status, 400);
  assert.equal((await post(e, '/api/account/contact', { session: s, phone_alt: '123' })).status, 400);
  const r = await post(e, '/api/account/contact', { session: s, email: 'Dana@Example.com', phone_alt: '052-000-0000', marketing: false });
  assert.equal(r.status, 200); assert.equal(r.contact.phone_alt, '972520000000');
  const me = await post(e, '/api/account/me', { session: s });
  assert.equal(me.contact.email, 'Dana@Example.com'); assert.equal(me.contact.marketing, false);
  await post(e, '/api/account/contact', { session: s, marketing: true });
  assert.equal((await post(e, '/api/account/me', { session: s })).contact.marketing, true);
});
test('feedback: route high at 6/6, low at 5/6; response carries scored/video/google/balance', async () => {
  const e = env();
  let r = await post(e, '/api/feedback', { token: TOK2, nps: 6, exp: 6 });
  assert.equal(r.status, 200); assert.equal(r.route, 'high'); assert.equal(r.scored, true); assert.equal(r.video, false); assert.equal(r.balance_ils, 0);
  r = await post(e, '/api/feedback', { token: TOK3, nps: 5, exp: 6 }); assert.equal(r.route, 'low');
  r = await post(e, '/api/feedback', { token: TOK2, state: true }); assert.equal(r.scored, true); assert.equal(r.route, 'high');
});
/* 21/11/2026 Richard: a Google review earns no credit and may come from any score (Google's "Rating Manipulation" policy).
   Before that this test expected ₪20 for Google and a 50 balance. */
test('review-claim: 409 before scores; video 30 after high scores; Google records with no credit, from any score; idempotent', async () => {
  const e = env();
  assert.equal((await post(e, '/api/review-claim', { token: TOK2, kind: 'video' })).error, 'not-scored');
  assert.equal((await post(e, '/api/review-claim', { token: TOK2, kind: 'x' })).status, 400);
  await post(e, '/api/feedback', { token: TOK2, nps: 9, exp: 9 });
  let r = await post(e, '/api/review-claim', { token: TOK2, kind: 'video' });
  assert.equal(r.status, 200); assert.equal(r.ils, 30); assert.equal(r.balance_ils, 30); assert.equal(r.video, true);
  r = await post(e, '/api/review-claim', { token: TOK2, kind: 'google' });
  assert.equal(r.ils, 0); assert.equal(r.balance_ils, 30, 'a Google review adds no credit'); assert.equal(r.google, true);
  r = await post(e, '/api/review-claim', { token: TOK2, kind: 'google' });
  assert.equal(r.already, true); assert.equal(r.balance_ils, 30);
  const led = JSON.parse(e.RATE.m.get('credit:' + PHONE)); assert.equal(led.entries.length, 1, 'only the video earned a credit');
  await post(e, '/api/feedback', { token: TOK3, nps: 4, exp: 9 });
  assert.equal((await post(e, '/api/review-claim', { token: TOK3, kind: 'video' })).error, 'low-score');
  r = await post(e, '/api/review-claim', { token: TOK3, kind: 'google' });
  assert.equal(r.status, 200); assert.equal(r.ils, 0); assert.equal(r.google, true, 'a low score may leave a Google review too');
  /* and the personal area shows it */
  const s = await login(e); const me = await post(e, '/api/account/me', { session: s });
  assert.equal(me.credit.balance_ils, 30); assert.equal(me.credit.entries[0].kind_he, 'המלצת וידאו'); assert.equal(me.events[1].next, 'done');
});
test('dashboard gate /api/otp-send uses the same ladder (guests number when Noa is unpaid)', async () => {
  metaMode = 'noa-131042';
  const e = env();
  const { sha256Hex } = await import('../lib.js');
  const nonce = 'n1', stamp_ts = Date.now(); const sig = await sha256Hex(`app|${nonce}|${stamp_ts}`);
  const r = await post(e, '/api/otp-send', { phone: '0521234567', app: 'ishur-web', nonce, stamp_ts, sig });
  assert.equal(r.status, 200); assert.equal(r.via, 'whatsapp-guests');
});
test('setup-template is an admin route, not swallowed by the account prefix', async () => {
  const e = env();
  assert.equal((await post(e, '/api/account/setup-template', { admin_key: 'wrong' })).error, 'bad-admin-key');
  const r = await post(e, '/api/account/setup-template', { admin_key: 'k', check: true });
  assert.equal(r.status, 200); assert.equal(r.exists, false);
  assert.ok(calls.some(c => /1378764257421712\/message_templates\?name=ishur_kod/.test(c.u)), 'read the guests WABA');
});

test('email account (no event yet): code by email, login registers the user, me shows no events, and the session never opens phone data', async () => {
  const e = env(); const post = (path, body) => worker.fetch(new Request('https://go.ishur.io/api/account/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify(body) }), e, {});
  assert.equal((await post('email-otp', { email: 'not-an-email' })).status, 400);
  emailSent.length = 0;
  assert.equal((await post('email-otp', { email: ' New@Example.com ' })).status, 200);
  assert.equal(emailSent.length, 1); const rec = JSON.parse(e.RATE.m.get('acctotpe:new@example.com')); assert.match(rec.code, /^\d{6}$/); assert.equal(e.RATE.ttl.get('acctotpe:new@example.com'), 600);
  assert.equal((await post('email-login', { email: 'new@example.com', code: rec.code === '000000' ? '111111' : '000000' })).status, 403);
  const ok = await (await post('email-login', { email: 'new@example.com', code: rec.code })).json();
  assert.equal(ok.ok, true); assert.equal(ok.new_user, true); assert.match(ok.session, /^acctm\.[0-9a-f]+\.[0-9a-f]{32}\.[0-9a-f]{32}$/);
  assert.ok(e.RATE.m.get('acctuser:new@example.com')); assert.equal((await post('email-login', { email: 'new@example.com', code: rec.code })).status, 403, 'single use');
  const me = await (await post('me', { session: ok.session })).json(); assert.deepEqual([me.ok, me.kind, me.email, me.events], [true, 'email', 'new@example.com', []]);
  assert.equal((await post('contact', { session: ok.session, email: 'x@y.co' })).status, 403, 'an email account has no phone to edit');
  assert.equal(await A.verifySession(e, ok.session, (a, b) => a === b), '', 'never accepted as a phone session');
  const phoneSess = await A.mintSession(e, PHONE); assert.equal(await A.verifyEmailSession(e, phoneSess, (a, b) => a === b), '', 'and a phone session is not an email one');
  const forged = ok.session.replace(/^acctm\.[0-9a-f]+/, 'acctm.' + [...new TextEncoder().encode('dana@example.com')].map(b => b.toString(16).padStart(2, '0')).join(''));
  assert.equal((await post('me', { session: forged })).status, 403, 'changing the email breaks the signature');
  await post('logout', { session: ok.session }); assert.equal((await post('me', { session: ok.session })).status, 403);
  for (let i = 0; i < 3; i++) await post('email-otp', { email: 'many@example.com' });
  assert.equal((await post('email-otp', { email: 'many@example.com' })).status, 429, '3 codes an hour per email');
});

/* 17/11 Richard: phone + a 4-digit PIN we set */
test('pin: derived PIN is 4 digits, stable per phone, different per phone; a reset overrides it', async () => {
  const { pinFor, resetPin } = await import('../account.js');
  const e = env();
  const a = await pinFor(e, PHONE), b = await pinFor(e, OTHER);
  assert.match(a, /^\d{4}$/); assert.equal(a, await pinFor(e, PHONE)); assert.notEqual(a, b);
  assert.equal(await pinFor(e, 'abc'), '');
  const n = await resetPin(e, PHONE); assert.match(n, /^\d{4}$/); assert.equal(await pinFor(e, PHONE), n);
});
test('pin-login: right PIN → session that me accepts (and me shows the PIN); wrong PIN 403; a phone without an event 403', async () => {
  const { pinFor } = await import('../account.js');
  const e = env(); const pin = await pinFor(e, PHONE);
  const wrong = pin === '0001' ? '0002' : '0001';
  assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin: wrong })).status, 403);
  const r = await post(e, '/api/account/pin-login', { phone: '0521234567', pin });
  assert.equal(r.status, 200); assert.match(r.session, /^acct\.972521234567\./);
  const me = await post(e, '/api/account/me', { session: r.session });
  assert.equal(me.status, 200); assert.equal(me.pin, pin); assert.equal(me.events.length, 2);
  const e2 = env(); const none = '972521112233';
  assert.equal((await post(e2, '/api/account/pin-login', { phone: '0521112233', pin: await pinFor(e2, none) })).status, 403);
  assert.equal((await post(e2, '/api/account/pin-login', { phone: '0521234567', pin: '12' })).status, 403);
});
test('pin-login: guessing is capped per hour even with the right PIN afterwards; the day cap locks the PIN until a WhatsApp-code login', async () => {
  const { pinFor, PIN_HOUR } = await import('../account.js');
  const e = env(); const pin = await pinFor(e, PHONE); const wrong = pin === '0001' ? '0002' : '0001';
  for (let i = 0; i < PIN_HOUR; i++) assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin: wrong })).status, 403);
  assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin })).status, 429);
  const e3 = env({ 'acctpinlock:972521234567': 'x' });
  const lk = await post(e3, '/api/account/pin-login', { phone: '0521234567', pin: await pinFor(e3, PHONE) });
  assert.equal(lk.status, 429); assert.equal(lk.error, 'pin-locked');
  await login(e3);
  assert.equal(e3.RATE.m.has('acctpinlock:972521234567'), false);
  assert.equal((await post(e3, '/api/account/pin-login', { phone: '0521234567', pin: await pinFor(e3, PHONE) })).status, 200);
});
test('client-pin (admin): returns the same PIN the client signs in with; reset replaces it; no admin key 403', async () => {
  const { pinFor } = await import('../account.js');
  const e = env();
  assert.equal((await post(e, '/api/client-pin', { phone: '0521234567' })).status, 403);
  const a = await post(e, '/api/client-pin', { admin_key: 'k', phone: '0521234567' });
  assert.equal(a.status, 200); assert.equal(a.pin, await pinFor(e, PHONE));
  const b = await post(e, '/api/client-pin', { admin_key: 'k', phone: '0521234567', reset: true });
  assert.match(b.pin, /^\d{4}$/); assert.equal(await pinFor(e, PHONE), b.pin);
});

/* 17/11 Richard ("תנעל"): the board link needs the PIN too */
const stamped = async (e, body) => { const nonce = 'n1', ts = String(Date.now()); const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${e.APP_KEY}|${nonce}|${ts}`)); return { ...body, app: 'x', nonce, stamp_ts: ts, sig: [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('') }; };
test('board lock: off → the link opens as before; on → 401 pin-required, then the PIN gives a session that opens it; another client\'s session does not', async () => {
  const { pinFor } = await import('../account.js');
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }) });
  const open0 = await post(e, '/api/status', await stamped(e, { token: TOK }));
  if (open0.status === 404) return assert.fail('token record key differs: adjust the fixture');
  assert.equal(open0.status, 200);
  await e.RATE.put('cfg:board_pin', '1');
  const locked = await post(e, '/api/status', await stamped(e, { token: TOK }));
  assert.equal(locked.status, 401); assert.equal(locked.error, 'pin-required'); assert.equal(locked.to, '67');
  assert.equal((await post(e, '/api/account/from-token', { token: TOK })).status, 403);
  assert.equal((await post(e, '/api/account/board-pin', { token: TOK, pin: (await pinFor(e, PHONE)) === '0001' ? '0002' : '0001' })).status, 403);
  const r = await post(e, '/api/account/board-pin', { token: TOK, pin: await pinFor(e, PHONE) });
  assert.equal(r.status, 200);
  assert.equal((await post(e, '/api/status', await stamped(e, { token: TOK, board_session: r.session }))).status, 200);
  const { mintSession } = await import('../account.js');
  assert.equal((await post(e, '/api/status', await stamped(e, { token: TOK, board_session: await mintSession(e, OTHER) }))).status, 401);
  const adm = await post(e, '/api/status', await stamped(e, { token: TOK, admin_key: 'k' }));
  assert.equal(adm.status, 200);
  /* 18/11 incident: the admin's browser got the call queue instead of the board, and the board showed no data */
  assert.ok(adm.event && Array.isArray(adm.guests), 'an admin opening a client board gets the board itself');
  assert.equal(adm.queue, undefined);
});
test('board-pin-send: the PIN goes to the phone on file only, 3 an hour', async () => {
  const { pinFor } = await import('../account.js');
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }) });
  const r = await post(e, '/api/account/board-pin-send', { token: TOK });
  assert.equal(r.status, 200); assert.equal(r.to, '67');
  const sent = calls.filter(c => /\/messages/.test(c.u));
  assert.ok(sent.length >= 1); assert.ok(sent.every(c => JSON.parse(c.body).to === PHONE)); assert.ok(sent[0].body.includes(await pinFor(e, PHONE)));
  await post(e, '/api/account/board-pin-send', { token: TOK }); await post(e, '/api/account/board-pin-send', { token: TOK });
  assert.equal((await post(e, '/api/account/board-pin-send', { token: TOK })).status, 429);
});
/* 18/11 incident: a correct PIN looped back to the code card when the token record's phone was not the sheet's owner cell */
test('board lock: the phone the PIN was checked against opens the board even when the events sheet lists another owner', async () => {
  const { pinFor } = await import('../account.js');
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: OTHER, name: 'דנה', clientId: 'c1' }), 'cfg:board_pin': '1' });
  const r = await post(e, '/api/account/board-pin', { token: TOK, pin: await pinFor(e, OTHER) });
  assert.equal(r.status, 200);
  assert.equal((await post(e, '/api/status', await stamped(e, { token: TOK, board_session: r.session }))).status, 200);
});

/* 18/11 Richard: the thank-you page shows the client's sign-in code once, right after paying */
test('claim: the answer carries the PIN the first time and inside 30 minutes; later only the token', async () => {
  const { pinFor } = await import('../account.js');
  const mk = extra => env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }), 'grow:REF1': TOK, ...extra });
  const e = mk({});
  const a = await post(e, '/api/claim', await stamped(e, { ref: 'REF1' }));
  assert.equal(a.token, TOK); assert.equal(a.pin, await pinFor(e, PHONE)); assert.equal(a.pin_phone, '0521234567');
  assert.equal((await post(e, '/api/claim', await stamped(e, { ref: 'REF1' }))).pin, a.pin, 'a reload inside the window still shows it');
  const old = mk({ ['pinshown:' + TOK]: String(Date.now() - 31 * 60000) });
  const b = await post(old, '/api/claim', await stamped(old, { ref: 'REF1' }));
  assert.equal(b.token, TOK); assert.equal(b.pin, undefined);
});

/* 18/11 Richard: a client email typed in the clients screen; link buttons then go by WhatsApp and by email */
test('client-contact (admin): set, read, clear, bad email refused, no key 403', async () => {
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }) });
  assert.equal((await post(e, '/api/client-contact', { token: TOK })).status, 403);
  assert.equal((await post(e, '/api/client-contact', { admin_key: 'k', token: TOK })).email, '');
  assert.equal((await post(e, '/api/client-contact', { admin_key: 'k', token: TOK, email: 'not-an-email' })).status, 400);
  assert.equal((await post(e, '/api/client-contact', { admin_key: 'k', token: TOK, email: ' dana@example.com ' })).email, 'dana@example.com');
  assert.equal((await post(e, '/api/client-contact', { admin_key: 'k', phone: '0521234567' })).email, 'dana@example.com');
  assert.equal((await post(e, '/api/client-contact', { admin_key: 'k', token: TOK, email: '' })).email, '');
});

/* 18/11 Richard: with the lock on, only the board asks for the code; the upload page works from its link with a reduced answer */
test('board lock: the upload page gets the event and counts without a code, never the guest list', async () => {
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }), 'cfg:board_pin': '1' });
  const up = await post(e, '/api/status', await stamped(e, { token: TOK, view: 'upload' }));
  assert.equal(up.status, 200); assert.ok(up.event); assert.ok(up.totals); assert.equal(up.limited, true);
  for (const k of ['guests', 'gifts', 'invoices', 'checkin', 'changes']) assert.equal(up[k], undefined, k + ' must not be sent without a code');
  assert.equal((await post(e, '/api/status', await stamped(e, { token: TOK }))).status, 401);
  assert.equal((await post(e, '/api/status', await stamped(e, { token: TOK, view: 'dashboard' }))).status, 401);
});

/* 18/11 Richard: replace a client's phone on one event from the clients screen */
test('client-phone (admin): refuses a bad number and a missing key; an unknown event is 404', async () => {
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }) });
  assert.equal((await post(e, '/api/client-phone', { token: TOK, phone: '0541112233' })).status, 403);
  assert.equal((await post(e, '/api/client-phone', { admin_key: 'k', token: TOK, phone: '03-1234567' })).status, 400);
  assert.equal((await post(e, '/api/client-phone', { admin_key: 'k', token: 'zz', phone: '0541112233' })).status, 400);
  assert.equal((await post(e, '/api/client-phone', { admin_key: 'k', token: '99999999-9999-4999-8999-999999999999', phone: '0541112233' })).status, 404);
  const same = await post(e, '/api/client-phone', { admin_key: 'k', token: TOK, phone: '0521234567' });
  assert.equal(same.status, 200); assert.equal(same.changed, false);
});
test('client-phone (admin): a real change writes column D of the event row, moves the token record, and the PIN follows the new phone', async () => {
  const { pinFor } = await import('../account.js');
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }), 'contact:972521234567': JSON.stringify({ email: 'dana@example.com' }) }, { BRAIN_HOOK: 'https://hook.test/brain' });
  /* the sheet writer answers like Sheets does when cells were written */
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { if (String(url) === 'https://hook.test/brain') { calls.push({ u: String(url), body: init.body ? String(init.body) : '' }); return new Response(JSON.stringify({ totalUpdatedCells: 1 })); } return prevFetch(url, init); };
  const before = calls.length;
  const r = await post(e, '/api/client-phone', { admin_key: 'k', token: TOK, phone: '054-1112233' });
  globalThis.fetch = prevFetch;
  if (r.status === 502) return assert.fail('the test env has no sheet writer: ' + JSON.stringify(r));
  assert.equal(r.status, 200); assert.equal(r.changed, true); assert.equal(r.phone, '972541112233'); assert.equal(r.was, PHONE);
  assert.equal(JSON.parse(e.RATE.m.get('token:' + TOK)).phone, '972541112233');
  assert.equal(JSON.parse(e.RATE.m.get('token:' + TOK)).clientId, 'c1');
  const wrote = calls.slice(before).map(c => String(c.body || '')).filter(x => /אירועים!D\d+/.test(x));
  assert.equal(wrote.length, 1, 'exactly one write, to column D'); assert.ok(wrote[0].includes('0541112233'));
  assert.equal(JSON.parse(e.RATE.m.get('contact:972541112233')).email, 'dana@example.com');
  assert.equal((await post(e, '/api/client-pin', { admin_key: 'k', token: TOK })).pin, await pinFor(e, '972541112233'));
});

/* 18/11 incident: the board opened without a personal link (home-screen app) asked for a one-time code only; clients typed their fixed code and were refused */
test('board gate (phone + code): the fixed 4-digit code signs in and returns the events and a board session; a wrong one is refused; a right one is never rate-counted', async () => {
  const { pinFor } = await import('../account.js');
  const e = env({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567', name: 'דנה', clientId: 'c1' }) });
  const pin = await pinFor(e, PHONE), wrong = pin === '0001' ? '0002' : '0001';
  const bad = await post(e, '/api/status', await stamped(e, { phone: '0521234567', code: wrong }));
  assert.equal(bad.status, 403); assert.equal(bad.error, 'bad-login');
  for (let i = 0; i < 9; i++) { const ok = await post(e, '/api/status', await stamped(e, { phone: '0521234567', code: pin })); assert.equal(ok.status, 200, 'reload ' + i); assert.ok(ok.events.length >= 1); assert.match(ok.board_session, /^acct\./); }
  await e.RATE.put('cfg:board_pin', '1');
  const ok2 = await post(e, '/api/status', await stamped(e, { phone: '0521234567', code: pin }));
  assert.equal((await post(e, '/api/status', await stamped(e, { token: ok2.events[0].token, board_session: ok2.board_session }))).status, 200, 'the session from the gate opens the locked board');
  assert.equal((await post(e, '/api/status', await stamped(e, { phone: '0531234567', code: await pinFor(e, '972531234567') }))).status, 404, 'a right code for a number with no event');
});
