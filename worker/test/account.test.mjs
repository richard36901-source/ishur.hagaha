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
test('review-claim: 409 before scores, 30 then 50 after high scores, repeat is idempotent, low score 409', async () => {
  const e = env();
  assert.equal((await post(e, '/api/review-claim', { token: TOK2, kind: 'video' })).error, 'not-scored');
  assert.equal((await post(e, '/api/review-claim', { token: TOK2, kind: 'x' })).status, 400);
  await post(e, '/api/feedback', { token: TOK2, nps: 9, exp: 9 });
  let r = await post(e, '/api/review-claim', { token: TOK2, kind: 'video' });
  assert.equal(r.status, 200); assert.equal(r.ils, 30); assert.equal(r.balance_ils, 30); assert.equal(r.video, true);
  r = await post(e, '/api/review-claim', { token: TOK2, kind: 'google' });
  assert.equal(r.ils, 20); assert.equal(r.balance_ils, 50); assert.equal(r.google, true);
  r = await post(e, '/api/review-claim', { token: TOK2, kind: 'google' });
  assert.equal(r.already, true); assert.equal(r.balance_ils, 50, 'no double credit');
  const led = JSON.parse(e.RATE.m.get('credit:' + PHONE)); assert.equal(led.entries.length, 2);
  await post(e, '/api/feedback', { token: TOK3, nps: 4, exp: 9 });
  assert.equal((await post(e, '/api/review-claim', { token: TOK3, kind: 'video' })).error, 'low-score');
  /* and the personal area shows it */
  const s = await login(e); const me = await post(e, '/api/account/me', { session: s });
  assert.equal(me.credit.balance_ils, 50); assert.equal(me.credit.entries[0].kind_he, 'ביקורת בגוגל'); assert.equal(me.events[1].next, 'done');
});
test('dashboard gate /api/otp-send uses the same ladder (guests number when Noa is unpaid)', async () => {
  metaMode = 'noa-131042';
  const e = env();
  const { sha256Hex } = await import('../lib.js');
  const nonce = 'n1', stamp_ts = Date.now(); const sig = await sha256Hex(`app|${nonce}|${stamp_ts}`);
  const r = await post(e, '/api/otp-send', { phone: '0521234567', app: 'ishur-web', nonce, stamp_ts, sig });
  assert.equal(r.status, 200); assert.equal(r.via, 'whatsapp-guests');
});
