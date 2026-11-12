// node --test worker/test/security-login-hardening.test.mjs — 12/11 security audit, pass 2: the login routes
// (admin code, personal-area code, the old board gate) count guesses in a way a parallel burst cannot outrun,
// are limited per IP as well as per phone, and a signed admin session ends 30 days after its last use.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../index.js';

let NOW = Date.parse('2026-11-12T10:00:00Z'); const realNow = Date.now;
/* KV double that honours TTLs against the test clock, and — like the real KV — lets a burst of parallel
   requests all read the value from before any of them wrote */
function kv(init = {}) {
  const m = new Map(Object.entries(init)), exp = new Map();
  const live = k => { if (exp.has(k) && exp.get(k) <= NOW) { m.delete(k); exp.delete(k); } return m.has(k); };
  return { m, exp, get: async k => { const v = live(k) ? m.get(k) : null; await new Promise(r => setTimeout(r, 2)); return v; },
    put: async (k, v, o) => { m.set(k, String(v)); if (o && o.expirationTtl) exp.set(k, NOW + o.expirationTtl * 1000); else if (o && o.expiration) exp.set(k, o.expiration * 1000); else exp.delete(k); },
    delete: async k => { m.delete(k); exp.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => live(k) && k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
    getWithMetadata: async k => ({ value: live(k) ? m.get(k) : null, metadata: null }) };
}
const TOK = '11111111-2222-3333-4444-555555555555';
const row = (tok, name, phone, date) => { const r = Array(47).fill(''); r[1] = tok; r[2] = name; r[3] = phone; r[4] = 'אולם'; r[5] = 'חתונה'; r[6] = date; r[7] = 'כן'; return r; };
const SNAP = { events: { values: [row(TOK, 'דנה', '0521234567', '2026-12-20')] }, guests: { values: [] }, leads: { values: [] } };
let realFetch;
before(() => { Date.now = () => NOW; realFetch = globalThis.fetch; globalThis.fetch = async (u) => {
  if (String(u) === 'https://hook.test/status') return new Response(JSON.stringify(SNAP));
  if (/graph\.facebook\.com/.test(String(u))) return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }));
  return new Response('{}'); }; });
after(() => { Date.now = realNow; globalThis.fetch = realFetch; });
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
const ADMIN = '972545764327', CLIENT = '972521234567';
const env = (init = {}) => ({ ADMIN_KEY: 'raw-admin-key', APP_KEY: 'app', ADMIN_PHONES: ADMIN, HOOK_STATUS: 'https://hook.test/status', SLACK_ALERT_HOOK: 'https://hook.test/slack',
  WA_TOKEN: 't', WA_PHONE_ID_CLIENT: 'NOA', WA_PHONE_ID_GUESTS: 'SHIR', WA_TOKEN_GUESTS: 'tg', RAFFLE: JSON.stringify({ on: false }), RATE: kv(init) });
const post = (e, path, body, ip = '1.2.3.4') => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }), e, ctx)
  .then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const adminOk = async (e, key) => (await post(e, '/api/admin/home', { admin_key: key, calls: [] })).status !== 403;
const adminOkBody = async (e, key) => (await post(e, '/api/lead-pings', { admin_key: key })).status !== 403;
const wrong = code => String(code === '111111' ? '222222' : '111111');
const hmac32 = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex').slice(0, 32);

test('admin login: a parallel burst of guesses gets five tries, not thirty', async () => {
  const e = env(); await post(e, '/api/admin-otp', { phone: ADMIN });
  const code = JSON.parse(e.RATE.m.get('adminotp:' + ADMIN)).code;
  const burst = []; for (let i = 0; i < 30; i++) burst.push(post(e, '/api/admin-login', { phone: ADMIN, code: wrong(code) }, '7.7.7.' + i));
  burst.push(post(e, '/api/admin-login', { phone: ADMIN, code }, '7.7.8.1'));
  const res = await Promise.all(burst);
  assert.equal(res[30].status, 403, 'the 31st parallel attempt must not be evaluated, even with the right code');
  assert.equal((await post(e, '/api/admin-login', { phone: ADMIN, code }, '7.7.8.2')).status, 403, 'the code is dead after the burst');
});

test('admin login: five wrong guesses kill the code; a fresh code still logs the owner in', async () => {
  const e = env(); await post(e, '/api/admin-otp', { phone: ADMIN });
  const c1 = JSON.parse(e.RATE.m.get('adminotp:' + ADMIN)).code;
  for (let i = 0; i < 5; i++) assert.equal((await post(e, '/api/admin-login', { phone: ADMIN, code: wrong(c1) }, '8.8.8.' + i)).status, 403);
  assert.equal(e.RATE.m.has('adminotp:' + ADMIN), false, 'code invalidated on the fifth wrong try');
  await post(e, '/api/admin-otp', { phone: ADMIN });
  const c2 = JSON.parse(e.RATE.m.get('adminotp:' + ADMIN)).code;
  const r = await post(e, '/api/admin-login', { phone: ADMIN, code: c2 }, '8.8.9.1');
  assert.equal(r.status, 200); assert.match(r.token, /^sess\.[0-9a-f]{32}\.[0-9a-f]{32}$/);
  assert.equal((await post(e, '/api/admin-login', { phone: ADMIN, code: c2 }, '8.8.9.2')).status, 403, 'single use');
});

test('admin login + code request: limited per IP', async () => {
  const e = env();
  for (let i = 0; i < 20; i++) await post(e, '/api/admin-login', { phone: '97250000' + String(1000 + i), code: '123456' }, '5.5.5.5');
  await post(e, '/api/admin-otp', { phone: ADMIN }, '6.6.6.6');
  const code = JSON.parse(e.RATE.m.get('adminotp:' + ADMIN)).code;
  assert.equal((await post(e, '/api/admin-login', { phone: ADMIN, code }, '5.5.5.5')).status, 403, 'an IP that already guessed 20 times this hour is refused');
  assert.equal((await post(e, '/api/admin-login', { phone: ADMIN, code }, '6.6.6.6')).status, 200, 'the owner on another IP is not affected');
  const e2 = env();
  for (let i = 0; i < 10; i++) await post(e2, '/api/admin-otp', { phone: '0500000000' }, '4.4.4.4');
  const r = await post(e2, '/api/admin-otp', { phone: ADMIN }, '4.4.4.4');
  assert.equal(r.status, 200, 'the answer never tells'); assert.equal(e2.RATE.m.has('adminotp:' + ADMIN), false, 'no code is minted for an IP over its hourly budget');
});

test('admin session: 30 days sliding, the raw key never expires', async () => {
  const t0 = NOW; const e = env(); await post(e, '/api/admin-otp', { phone: ADMIN });
  const { token } = await post(e, '/api/admin-login', { phone: ADMIN, code: JSON.parse(e.RATE.m.get('adminotp:' + ADMIN)).code }, '9.9.9.1');
  assert.ok(await adminOk(e, token), 'works at once'); assert.ok(await adminOkBody(e, token), 'works in a JSON body too');
  NOW = t0 + 20 * 86400e3; assert.ok(await adminOk(e, token), 'day 20');
  NOW = t0 + 45 * 86400e3; assert.ok(await adminOk(e, token), 'day 45: used on day 20, so still inside 30 days of the last use');
  NOW = t0 + 80 * 86400e3; assert.equal(await adminOk(e, token), false, 'day 80: 35 days unused'); assert.equal(await adminOkBody(e, token), false);
  assert.ok(await adminOk(e, 'raw-admin-key'), 'the raw admin key keeps working'); assert.ok(await adminOkBody(e, 'raw-admin-key'));
  const forged = token.replace(/\.[0-9a-f]{32}$/, '.' + '0'.repeat(32));
  NOW = t0; assert.equal(await adminOk(e, forged), false, 'a token with a wrong signature');
  NOW = t0;
});

test('admin session: one minted before this change keeps working, then follows the same 30-day rule', async () => {
  const t0 = NOW; const nonce = 'ab'.repeat(16); const old = 'sess.' + nonce + '.' + hmac32('raw-admin-key', 'sess:' + nonce);
  const e = env({ ['adminsess:' + nonce]: JSON.stringify({ phone: ADMIN, at: '2026-09-15T08:00:00.000Z' }) });
  assert.ok(await adminOk(e, old), 'an existing session is not logged out'); assert.ok(await adminOkBody(e, old));
  NOW = Date.parse('2026-12-10T10:00:00Z'); assert.ok(await adminOk(e, old), 'still in on 10/12');
  NOW = Date.parse('2027-01-05T10:00:00Z'); assert.ok(await adminOk(e, old), '26 days after its last use');
  NOW = Date.parse('2027-03-01T10:00:00Z'); assert.equal(await adminOk(e, old), false, '55 days unused');
  /* an old session nobody used: valid through the grace month, gone after it */
  const n2 = 'cd'.repeat(16); const idle = 'sess.' + n2 + '.' + hmac32('raw-admin-key', 'sess:' + n2);
  const e2 = env({ ['adminsess:' + n2]: JSON.stringify({ phone: ADMIN, at: '2026-09-15T08:00:00.000Z' }) });
  NOW = Date.parse('2026-12-20T10:00:00Z'); assert.equal(await adminOk(e2, idle), false, 'never used in the grace month');
  /* revocation still wins */
  NOW = t0; const e3 = env({ ['adminsess:' + nonce]: JSON.stringify({ phone: ADMIN, at: '2026-09-15T08:00:00.000Z' }), ['adminrev:' + nonce]: '1' });
  assert.equal(await adminOk(e3, old), false, 'revoked');
  NOW = t0;
});

test('personal-area login: parallel burst gets five tries; limited per IP', async () => {
  const e = env(); await post(e, '/api/account/otp', { phone: CLIENT });
  const code = JSON.parse(e.RATE.m.get('acctotp:' + CLIENT)).code;
  const burst = []; for (let i = 0; i < 30; i++) burst.push(post(e, '/api/account/login', { phone: CLIENT, code: wrong(code) }, '3.3.3.' + i));
  burst.push(post(e, '/api/account/login', { phone: CLIENT, code }, '3.3.4.1'));
  const res = await Promise.all(burst);
  assert.notEqual(res[30].status, 200, 'the 31st parallel attempt must not log in');
  const e2 = env();
  for (let i = 0; i < 30; i++) await post(e2, '/api/account/login', { phone: '97252' + String(1000000 + i), code: '123456' }, '2.2.2.2');
  await post(e2, '/api/account/otp', { phone: CLIENT }, '2.2.2.9');
  const c2 = JSON.parse(e2.RATE.m.get('acctotp:' + CLIENT)).code;
  assert.notEqual((await post(e2, '/api/account/login', { phone: CLIENT, code: c2 }, '2.2.2.2')).status, 200, 'an IP that guessed 30 times this hour');
  assert.equal((await post(e2, '/api/account/login', { phone: CLIENT, code: c2 }, '2.2.2.9')).status, 200, 'the client on another IP gets in');
});

test('old board gate (phone + code on /api/status): parallel burst gets six tries at most', async () => {
  const e = env({ ['otp:' + CLIENT]: JSON.stringify({ code: '654321', tries: 0, exp: Math.floor(NOW / 1000) + 600 }) });
  const stamp = async () => { const nonce = crypto.randomBytes(8).toString('hex'), stamp_ts = String(NOW); return { app: 'ishur-web', nonce, stamp_ts, sig: crypto.createHash('sha256').update(`app|${nonce}|${stamp_ts}`).digest('hex') }; };
  const e1 = { ...e, HOOK_STATUS: 'https://hook.test/status' };
  const burst = []; for (let i = 0; i < 30; i++) burst.push(post(e1, '/api/status', { ...(await stamp()), phone: CLIENT, code: '111111' }, '1.1.1.' + i));
  burst.push(post(e1, '/api/status', { ...(await stamp()), phone: CLIENT, code: '654321' }, '1.1.2.1'));
  const res = await Promise.all(burst);
  assert.notEqual(res[30].status, 200, 'the 31st parallel attempt must not log in');
});
