// node --test worker/test/identity.test.mjs — Sign in with Apple / Google (identity.js + the account routes).
// A key pair made here stands in for Apple's and Google's signing keys; their key URLs are stubbed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import * as I from '../identity.js';
import { pinFor } from '../account.js';

const b64u = b => Buffer.from(b).toString('base64url');
let keys, other, JWK;
async function jwt(claims, { key = keys.privateKey, kid = 'k1' } = {}) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p));
  return h + '.' + p + '.' + b64u(new Uint8Array(sig));
}
const now = () => Math.floor(Date.now() / 1000);
const apple = (x = {}) => ({ iss: 'https://appleid.apple.com', aud: 'io.ishur.client', sub: 'apple-user-1', email: 'x@privaterelay.appleid.com', iat: now(), exp: now() + 600, ...x });
const google = (x = {}) => ({ iss: 'https://accounts.google.com', aud: 'g-ios-client', sub: 'google-user-1', email: 'dana@gmail.com', email_verified: true, iat: now(), exp: now() + 600, ...x });

/* the sheet (events) for the route tests: one paid event on 0521234567 */
const TOK = '11111111-2222-3333-4444-555555555555';
const row = (tok, name, phone, date) => { const r = Array(47).fill(''); r[1] = tok; r[2] = name; r[3] = phone; r[4] = 'אולם'; r[5] = 'חתונה'; r[6] = date; r[7] = 'כן'; r[34] = name; return r; };
const SNAP = { events: { values: [row(TOK, 'דנה', '0521234567', '2026-12-20')] }, guests: { values: [] }, leads: { values: [] } };
let realFetch, keyFetches = 0;
before(async () => {
  keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  JWK = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(SNAP));
    if (u === 'https://appleid.apple.com/auth/keys' || u === 'https://www.googleapis.com/oauth2/v3/certs') { keyFetches++; return new Response(JSON.stringify({ keys: [JWK] })); }
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { I._resetKeyCache(); keyFetches = 0; });

const ENV = { GOOGLE_CLIENT_IDS: 'g-ios-client,g-web-client' };
test('a genuine Apple token is accepted: provider, sub, email', async () => {
  const r = await I.verifyIdToken(ENV, 'apple', await jwt(apple()));
  assert.deepEqual([r.ok, r.provider, r.sub], [true, 'apple', 'apple-user-1']);
});
test('a genuine Google token is accepted for any of the configured client ids', async () => {
  assert.equal((await I.verifyIdToken(ENV, 'google', await jwt(google({ aud: 'g-web-client' })))).ok, true);
});
test('refused: another key, wrong audience, wrong issuer, expired, unknown provider, junk', async () => {
  assert.equal((await I.verifyIdToken(ENV, 'apple', await jwt(apple(), { key: other.privateKey }))).error, 'bad-signature');
  assert.equal((await I.verifyIdToken(ENV, 'apple', await jwt(apple({ aud: 'com.someone.else' })))).error, 'bad-audience');
  assert.equal((await I.verifyIdToken(ENV, 'apple', await jwt(apple({ iss: 'https://evil.example' })))).error, 'bad-issuer');
  assert.equal((await I.verifyIdToken(ENV, 'apple', await jwt(apple({ exp: now() - 3600 })))).error, 'expired');
  assert.equal((await I.verifyIdToken(ENV, 'facebook', 'a.b.c')).error, 'unknown-provider');
  assert.equal((await I.verifyIdToken(ENV, 'apple', 'not-a-token')).error, 'bad-token');
  /* an Apple token offered as Google: Google's issuer check fails */
  assert.equal((await I.verifyIdToken(ENV, 'google', await jwt(apple({ aud: 'g-ios-client' })))).error, 'bad-issuer');
});
test('Google is refused while no client id is configured', async () => {
  assert.equal((await I.verifyIdToken({}, 'google', await jwt(google()))).error, 'not-configured');
});
test('the provider keys are fetched once and reused; an unknown key id fetches them again once', async () => {
  await I.verifyIdToken(ENV, 'apple', await jwt(apple())); await I.verifyIdToken(ENV, 'apple', await jwt(apple()));
  assert.equal(keyFetches, 1);
  assert.equal((await I.verifyIdToken(ENV, 'apple', await jwt(apple(), { kid: 'rotated' }))).error, 'unknown-key');
  assert.equal(keyFetches, 2);
});

/* routes, through the real Worker */
function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) }; }
const env = (extra = {}) => ({ ADMIN_KEY: 'k', APP_KEY: 'app', HOOK_STATUS: 'https://hook.test/status', RATE: kv(), GOOGLE_CLIENT_IDS: 'g-ios-client', ...extra });
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) }), e, { waitUntil: () => {}, passThroughOnException: () => {} }).then(async r => ({ status: r.status, ...(await r.json()) }));

test('first sign-in with the code, link Apple, then Apple signs in; the app code is refused from then on, the website code is not', async () => {
  const e = env(), pin = await pinFor(e, '972521234567');
  const first = await post(e, '/api/account/pin-login', { phone: '0521234567', pin, app: 1 });
  assert.equal(first.status, 200, 'not linked yet: the code works in the app');
  const link = await post(e, '/api/account/link-identity', { session: first.session, provider: 'apple', id_token: await jwt(apple()) });
  assert.equal(link.status, 200); assert.deepEqual(link.linked, ['apple']);
  assert.deepEqual((await post(e, '/api/account/identities', { session: first.session })).linked, ['apple']);
  const viaApple = await post(e, '/api/account/id-login', { provider: 'apple', id_token: await jwt(apple()) });
  assert.equal(viaApple.status, 200); assert.match(viaApple.session, /^acct\.972521234567\./);
  assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin, app: 1 })).error, 'use-identity');
  assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin })).status, 200, 'the website keeps the code');
});
test('a wrong code is still "bad-login" for a linked phone (the link is not revealed to a guesser)', async () => {
  const e = env(), pin = await pinFor(e, '972521234567');
  const s = (await post(e, '/api/account/pin-login', { phone: '0521234567', pin, app: 1 })).session;
  await post(e, '/api/account/link-identity', { session: s, provider: 'apple', id_token: await jwt(apple()) });
  const wrong = pin === '0001' ? '0002' : '0001';
  assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin: wrong, app: 1 })).error, 'bad-login');
});
test('an Apple account nobody linked cannot sign in; a forged token cannot either', async () => {
  const e = env();
  assert.equal((await post(e, '/api/account/id-login', { provider: 'apple', id_token: await jwt(apple({ sub: 'stranger' })) })).error, 'not-linked');
  assert.equal((await post(e, '/api/account/id-login', { provider: 'apple', id_token: await jwt(apple(), { key: other.privateKey }) })).error, 'bad-signature');
});
test('one Apple account cannot be linked to two phones', async () => {
  const e = env();
  await I.linkIdentity(e, '972521234567', { provider: 'apple', sub: 'apple-user-1' });
  const s2 = await (await import('../account.js')).mintSession(e, '972529999999');
  assert.equal((await post(e, '/api/account/link-identity', { session: s2, provider: 'apple', id_token: await jwt(apple()) })).error, 'linked-elsewhere');
});
test('the App Store reviewer\'s demo phone keeps the code in the app even when linked', async () => {
  const e = env({ REVIEW_PHONE: '0521234567' }), pin = await pinFor(e, '972521234567');
  await I.linkIdentity(e, '972521234567', { provider: 'apple', sub: 'apple-user-1' });
  assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin, app: 1 })).status, 200);
});
test('an admin unlinks a phone: the code works in the app again and the Apple account no longer signs in', async () => {
  const e = env(), pin = await pinFor(e, '972521234567');
  await I.linkIdentity(e, '972521234567', { provider: 'apple', sub: 'apple-user-1' });
  assert.equal((await post(e, '/api/account/unlink-identity', { admin_key: 'nope', phone: '0521234567' })).status, 403);
  assert.equal((await post(e, '/api/account/unlink-identity', { admin_key: 'k', phone: '0521234567' })).removed, 1);
  assert.equal((await post(e, '/api/account/pin-login', { phone: '0521234567', pin, app: 1 })).status, 200);
  assert.equal((await post(e, '/api/account/id-login', { provider: 'apple', id_token: await jwt(apple()) })).error, 'not-linked');
});
