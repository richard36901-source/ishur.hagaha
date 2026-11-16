// node --test worker/test/auth.test.mjs — login, users, page permissions, action log (16/11). Off by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../index.js';
import { isAdmin, cors } from '../lib.js';
import { verifyGoogleJwt, claimsError, canSee, canLayer, allowedPages, planUserChange, ensureSeed, getUser, listUsers, createSession, readSession, destroySession,
  logAction, queryActions, authGate, handleAuth, getJwks, PAGES, SESSION_DAYS, isSessionToken, ilDay } from '../auth.js';

const CLIENT = 'test-client.apps.googleusercontent.com';
const OWNER = 'richardtomskiy@gmail.com', STAFF = 'shalevdrix3@gmail.com';

/* an in-memory KV that counts every call, keeps metadata and honours nothing but the map */
function kv(init = {}) {
  const m = new Map(Object.entries(init)), meta = new Map(), n = { get: 0, put: 0, list: 0, delete: 0 };
  return { m, meta, n,
    get: async k => { n.get++; return m.has(k) ? m.get(k) : null; },
    put: async (k, v, o = {}) => { n.put++; m.set(k, String(v)); if (o.metadata) meta.set(k, o.metadata); },
    delete: async k => { n.delete++; m.delete(k); meta.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) => { n.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name, metadata: meta.get(name) })), list_complete: true }; },
    getWithMetadata: async () => ({ value: null }) };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const b64u = v => Buffer.from(v).toString('base64url');
const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const JWKS = [{ ...(await webcrypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'kid1', use: 'sig' }];
async function jwt(claims = {}, { key = pair.privateKey, kid = 'kid1', alg = 'RS256' } = {}) {
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 600, email: OWNER, email_verified: true, name: 'R', ...claims };
  const head = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload));
  return head + '.' + b64u(new Uint8Array(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head))));
}
const jwksFetch = (count = { n: 0 }) => async () => { count.n++; return new Response(JSON.stringify({ keys: JWKS })); };
const authPost = (e, path, body, headers = {}, d = { fetch: jwksFetch() }) => handleAuth(new Request('https://go.ishur.io/api/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), e, 'https://ishur.io', new URL('https://go.ishur.io/api/auth/' + path), d);
const envWith = (init = {}) => ({ ADMIN_KEY: 'k', RATE: kv(init) });

test('Google token: a valid one passes; wrong audience, expired, unverified email, bad issuer, foreign key, alg none all fail', async () => {
  const opt = { clientId: CLIENT, keys: JWKS };
  assert.deepEqual(await verifyGoogleJwt(await jwt(), opt), { ok: true, email: OWNER, name: 'R' });
  assert.equal((await verifyGoogleJwt(await jwt({ iss: 'accounts.google.com', email_verified: 'true', email: 'Richardtomskiy@Gmail.com' }), opt)).email, OWNER);
  assert.equal((await verifyGoogleJwt(await jwt({ aud: 'someone-else' }), opt)).error, 'bad-audience');
  assert.equal((await verifyGoogleJwt(await jwt({ exp: Math.floor(Date.now() / 1000) - 5 }), opt)).error, 'expired');
  assert.equal((await verifyGoogleJwt(await jwt({ email_verified: false }), opt)).error, 'email-not-verified');
  assert.equal((await verifyGoogleJwt(await jwt({ iss: 'https://evil.example' }), opt)).error, 'bad-issuer');
  assert.equal((await verifyGoogleJwt(await jwt({}, { key: other.privateKey }), opt)).error, 'bad-signature');
  assert.equal((await verifyGoogleJwt(await jwt({}, { kid: 'nope' }), opt)).error, 'unknown-key');
  assert.equal((await verifyGoogleJwt(await jwt({}, { alg: 'none' }), opt)).error, 'bad-alg');
  const t = await jwt(); const parts = t.split('.');
  assert.equal((await verifyGoogleJwt(parts[0] + '.' + b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, exp: 9999999999, email: 'x@y.co', email_verified: true })) + '.' + parts[2], opt)).error, 'bad-signature', 'a changed payload');
  assert.equal((await verifyGoogleJwt('garbage', opt)).error, 'bad-token');
  assert.equal(claimsError({ iss: 'accounts.google.com', aud: CLIENT, exp: 9999999999, email: 'a@b.co', email_verified: true }, { clientId: '' }), 'bad-audience', 'no client id never matches');
});

test('sign-in route: not-configured without a client id; allow-list only; a session comes back; JWKS is cached', async () => {
  const e0 = envWith();
  assert.equal((await authPost(e0, 'google', { credential: await jwt() })).status, 503);
  assert.equal((await (await authPost(e0, 'google', { credential: await jwt() })).json()).error, 'not-configured');
  const cfg0 = await (await handleAuth(new Request('https://go.ishur.io/api/auth/config'), e0, '', new URL('https://go.ishur.io/api/auth/config'))).json();
  assert.deepEqual(cfg0, { ok: true, configured: false, client_id: '', enforce: false });

  const e = envWith({ 'cfg:google_client_id': CLIENT }); const count = { n: 0 }; const d = { fetch: jwksFetch(count) };
  const r = await authPost(e, 'google', { credential: await jwt() }, {}, d); const j = await r.json();
  assert.equal(r.status, 200); assert.ok(isSessionToken(j.session)); assert.equal(j.user.role, 'owner'); assert.deepEqual(j.pages, PAGES.map(p => p.id));
  assert.ok((await getUser(e, OWNER)).last_login, 'last_login is stamped');
  assert.equal((await getUser(e, STAFF)).role, 'staff', 'the second user was seeded');
  const stranger = await authPost(e, 'google', { credential: await jwt({ email: 'stranger@gmail.com' }) }, {}, d);
  assert.equal(stranger.status, 403); assert.equal((await stranger.json()).error, 'not-allowed');
  assert.equal((await authPost(e, 'google', { credential: await jwt({ aud: 'x' }) }, {}, d)).status, 401);
  assert.equal((await authPost(e, 'google', { credential: await jwt({}, { kid: 'rotated' }) }, {}, d)).status, 401);
  assert.equal(count.n, 1, 'Google keys fetched once, then read from KV; an unknown key id does not refetch within a minute');
  assert.equal((await getJwks(e, { fetchFn: jwksFetch(count), force: true, now: Date.now() + 61 * 1000 })).length, 1); assert.equal(count.n, 2, 'an unknown key id refetches after a minute');
  assert.equal((await getJwks(e, { fetchFn: jwksFetch(count), now: Date.now() + 2 * 3600 * 1000 })).length, 1); assert.equal(count.n, 3, 'refetched once the stored copy (written at +61 s above) is over an hour old');
  /* a switched-off user cannot sign in */
  const u = await getUser(e, STAFF); e.RATE.m.set('user:' + STAFF, JSON.stringify({ ...u, active: false }));
  assert.equal((await authPost(e, 'google', { credential: await jwt({ email: STAFF }) }, {}, d)).status, 403);
});

test('seed: two users only into an empty store, once, never over an existing record', async () => {
  const e = envWith();
  assert.equal(await ensureSeed(e), true);
  assert.deepEqual((await listUsers(e)).map(u => [u.email, u.role, u.pages, u.active]), [[OWNER, 'owner', 'all', true], [STAFF, 'staff', 'all', true]]);
  e.RATE.m.delete('user:' + STAFF);
  assert.equal(await ensureSeed(e), false, 'the marker stops a second seed'); assert.equal(await getUser(e, STAFF), null);
  const e2 = envWith({ 'user:a@b.co': JSON.stringify({ email: 'a@b.co', role: 'owner', pages: 'all', layers: 'all', active: true }) });
  assert.equal(await ensureSeed(e2), false); assert.equal((await listUsers(e2)).length, 1, 'a store with users is left alone');
});

test('sessions: create, read, 30-day end, logout, and a switched-off user loses every session', async () => {
  const e = envWith(); await ensureSeed(e);
  const now = Date.now(), tok = await createSession(e, STAFF, now);
  assert.match(tok, /^us\.[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(e.RATE.m.get('usess:' + tok.slice(3))).email, STAFF);
  assert.equal((await readSession(e, tok, now + 1000)).email, STAFF);
  assert.equal((await readSession(e, tok, now + (SESSION_DAYS - 1) * 86400000)).email, STAFF);
  assert.equal(await readSession(e, tok, now + SESSION_DAYS * 86400000), null, 'ended after 30 days');
  assert.equal(await readSession(e, 'us.' + '0'.repeat(64)), null); assert.equal(await readSession(e, 'k'), null); assert.equal(await readSession(e, 'sess.' + 'a'.repeat(48)), null);
  const u = await getUser(e, STAFF); e.RATE.m.set('user:' + STAFF, JSON.stringify({ ...u, active: false }));
  assert.equal(await readSession(e, tok, now + 1000), null, 'switched off = out at once');
  e.RATE.m.set('user:' + STAFF, JSON.stringify(u));
  await destroySession(e, tok); assert.equal(await readSession(e, tok, now + 1000), null);
});

test('canSee / canLayer: owner and "all" see everything, a list sees its items, unknown ids and inactive users see nothing', () => {
  const staff = { email: 's@x.co', role: 'staff', pages: ['sales', 'clients'], layers: ['sends'], active: true };
  assert.equal(canSee(staff, 'sales'), true); assert.equal(canSee(staff, 'money'), false); assert.equal(canSee(staff, 'nope'), false);
  assert.equal(canLayer(staff, 'sends'), true); assert.equal(canLayer(staff, 'money'), false);
  assert.deepEqual(allowedPages(staff), ['sales', 'clients']);
  assert.equal(canSee({ role: 'owner', pages: [], active: true }, 'system'), true);
  assert.equal(canSee({ role: 'staff', pages: 'all', active: true }, 'control'), true);
  assert.equal(canSee({ ...staff, active: false }, 'sales'), false); assert.equal(canSee(null, 'sales'), false);
  assert.deepEqual(PAGES.map(p => p.id), ['data', 'money', 'sales', 'clients', 'sends', 'journal', 'control', 'system']);
});

test('user changes: owner only; unknown pages dropped; the last owner cannot be removed or demoted', async () => {
  const owner = { email: OWNER, role: 'owner', pages: 'all', layers: 'all', active: true }, staff = { email: STAFF, role: 'staff', pages: 'all', layers: 'all', active: true };
  assert.deepEqual(planUserChange(staff, { email: 'n@x.co' }, null, [owner, staff]), { ok: false, error: 'owner-only' });
  assert.equal(planUserChange(owner, { email: 'not an email' }, null, []).error, 'bad-email');
  const n = planUserChange(owner, { email: ' New@X.co ', name: '<b>דנה</b>', role: 'admin', pages: ['sales', 'hack', 'sales'], layers: 'all' }, null, [owner]).user;
  assert.deepEqual([n.email, n.name, n.role, n.pages, n.layers, n.active], ['new@x.co', 'bדנה/b', 'staff', ['sales'], 'all', true]);
  assert.equal(planUserChange(owner, { email: OWNER, active: false }, owner, [owner, staff]).error, 'last-owner');
  assert.equal(planUserChange(owner, { email: OWNER, role: 'staff' }, owner, [owner, staff]).error, 'last-owner');
  assert.equal(planUserChange(owner, { email: OWNER, active: false }, owner, [owner, { ...staff, role: 'owner' }]).ok, true);
  const keep = planUserChange(owner, { email: STAFF, pages: ['data'] }, { ...staff, created_at: 'X', last_login: 'Y' }, [owner, staff]).user;
  assert.deepEqual([keep.pages, keep.layers, keep.created_at, keep.last_login, keep.role], [['data'], 'all', 'X', 'Y', 'staff'], 'fields not sent are kept');

  /* through the route */
  const e = envWith(); await ensureSeed(e);
  const so = await createSession(e, OWNER), ss = await createSession(e, STAFF);
  assert.equal((await authPost(e, 'users', { action: 'list' })).status, 401, 'no session');
  assert.equal((await authPost(e, 'users', { action: 'list', admin_key: 'k' })).status, 401, 'the shared key is not a user');
  assert.equal((await authPost(e, 'users', { action: 'list', session: ss })).status, 403, 'staff cannot manage users');
  assert.equal((await authPost(e, 'actions', { session: ss })).status, 403);
  const up = await (await authPost(e, 'users', { action: 'upsert', user: { email: 'dana@x.co', name: 'דנה', pages: ['sales'], layers: [] } }, { 'x-ishur-session': so })).json();
  assert.equal(up.users.length, 3); assert.deepEqual((await getUser(e, 'dana@x.co')).pages, ['sales']);
  assert.equal((await authPost(e, 'users', { action: 'deactivate', email: OWNER, session: so })).status, 400, 'last owner');
  assert.equal((await authPost(e, 'users', { action: 'deactivate', email: 'dana@x.co', session: so })).status, 200);
  assert.equal((await getUser(e, 'dana@x.co')).active, false);
  const me = await (await authPost(e, 'me', { session: ss })).json();
  assert.equal(me.user.email, STAFF); assert.equal(me.pages.length, 8); assert.equal(me.enforce, false);
  assert.equal((await authPost(e, 'logout', { session: ss })).status, 200); assert.equal((await authPost(e, 'me', { session: ss })).status, 401);
});

test('action log: key shape, metadata, last N days, filter by user, newest first', async () => {
  const e = envWith(); const now = Date.parse('2026-11-16T10:00:00Z');
  const k = await logAction(e, { u: OWNER, a: 'pause · on', p: '/api/pause' }, now);
  assert.match(k, /^act:2026-11-16:\d{13}:[0-9a-f]{8}$/);
  assert.deepEqual(e.RATE.meta.get(k), { u: OWNER, a: 'pause · on', p: '/api/pause' });
  await logAction(e, { u: STAFF, a: 'client-link', p: '/api/client-link' }, now - 3600000);
  await logAction(e, { u: STAFF, a: 'old', p: '/api/x' }, now - 3 * 86400000);
  await logAction(e, { u: STAFF, a: 'older', p: '/api/x' }, now - 20 * 86400000);
  assert.equal(await logAction(e, { u: '', a: 'x', p: '/x' }, now), '', 'no user, no row');
  assert.deepEqual((await queryActions(e, { days: 7, now })).map(r => r.a), ['pause · on', 'client-link', 'old']);
  assert.deepEqual((await queryActions(e, { days: 1, now })).map(r => r.u), [OWNER, STAFF]);
  assert.deepEqual((await queryActions(e, { days: 7, user: STAFF, now })).map(r => r.a), ['client-link', 'old']);
  assert.equal((await queryActions(e, { days: 30, now })).length, 4); assert.equal((await queryActions(e, { days: 30, limit: 2, now })).length, 2);
  assert.equal(ilDay(Date.parse('2026-11-16T22:30:00Z')), '2026-11-17', 'the day is the Israel day');
});

const apiReq = (path, body, headers = {}) => new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io', ...headers }, body: JSON.stringify(body) });

test('switch OFF: a request with only the shared key is the SAME request, with no KV write and no KV read beyond the switch itself', async () => {
  const e = envWith();
  for (const rq of [apiReq('/api/pause', { admin_key: 'k', paused: true }), apiReq('/api/status', { token: 'x' }), apiReq('/api/leads', { admin_key: 'wrong' }),
    new Request('https://go.ishur.io/api/ops/realtime', { headers: { 'X-Admin-Key': 'k', Origin: 'https://ishur.io' } }), new Request('https://go.ishur.io/api/ops/realtime', { headers: { 'X-Admin-Key': 'k' } }),
    apiReq('/api/account/x', { session: 'acct.972501234567.' + 'a'.repeat(32) + '.' + 'b'.repeat(32) }), new Request('https://go.ishur.io/api/grow-ipn', { method: 'POST', body: 'a=1' })]) {
    const g = await authGate(rq, e, ctx, {});
    assert.equal(g.request, rq, rq.url + ' is passed through as the same object'); assert.equal(g.response, undefined);
  }
  assert.equal(e.RATE.n.put, 0); assert.equal(e.RATE.n.delete, 0); assert.equal(e.RATE.n.list, 0);
  assert.deepEqual([...e.RATE.m.keys()], [], 'nothing was written');
  /* a caller that is not a browser, or presents no key, costs no KV read at all */
  const e2 = envWith();
  await authGate(new Request('https://go.ishur.io/api/ops/realtime', { headers: { 'X-Admin-Key': 'k' } }), e2, ctx, {});
  await authGate(apiReq('/api/status', { token: 'x' }), e2, ctx, {});
  assert.equal(e2.RATE.n.get, 0);
  /* a broken store never blocks: the gate lets the request through */
  const e3 = { ADMIN_KEY: 'k', RATE: { get: async () => { throw new Error('kv down'); } } };
  const rq = apiReq('/api/pause', { admin_key: 'k' }); assert.equal((await authGate(rq, e3, ctx, {})).request, rq);
  assert.equal((await authGate(rq, { ADMIN_KEY: 'k' }, ctx, {})).request, rq, 'no KV binding');
  assert.equal(isAdmin({ ADMIN_KEY: 'k' }, 'k'), true); assert.equal(isAdmin({ ADMIN_KEY: 'k' }, 'us.' + 'a'.repeat(64)), false, 'isAdmin itself is unchanged');
});

test('switch OFF, through the whole Worker: the shared key answers as before, a wrong key is still 403, nothing is logged', async () => {
  const e = envWith();
  const home = body => worker.fetch(apiReq('/api/admin/home', body), e, ctx);
  assert.equal((await home({ admin_key: 'nope', calls: [] })).status, 403);
  const j = await (await home({ admin_key: 'k', calls: [{ p: '/api/referrals', m: 'POST', b: {} }] })).json();
  assert.equal(j.ok, true); assert.equal(j.results[0].s, 200);
  assert.equal([...e.RATE.m.keys()].filter(k => /^(act:|usess:|user:|cfg:auth)/.test(k)).length, 0);
});

test('a user session works in place of the key (switch off or on), is stripped from the body, and writes are logged under the user', async () => {
  const e = envWith(); await ensureSeed(e); const tok = await createSession(e, STAFF);
  const isRead = (p, m, b) => p === '/api/leads' && !b.action;
  /* body field */
  let g = await authGate(apiReq('/api/pause', { session: tok, paused: true }), e, ctx, { isRead });
  assert.equal(g.user.email, STAFF); assert.deepEqual(await g.request.clone().json(), { paused: true, admin_key: 'k' }); assert.equal(g.request.headers.get('x-admin-key'), 'k');
  /* header, GET */
  g = await authGate(new Request('https://go.ishur.io/api/ops/realtime', { headers: { 'x-ishur-session': tok } }), e, ctx, { isRead });
  assert.equal(g.request.headers.get('x-admin-key'), 'k'); assert.equal(g.request.headers.get('x-ishur-session'), null);
  g = await authGate(new Request('https://go.ishur.io/api/ops/realtime', { headers: { Authorization: 'Bearer ' + tok } }), e, ctx, { isRead });
  assert.equal(g.request.headers.get('x-admin-key'), 'k'); assert.equal(g.request.headers.get('Authorization'), null, 'a session as a Bearer token on /api/ops/');
  /* header + a JSON body that had no key at all: the key is added so the handler's own check passes */
  g = await authGate(apiReq('/api/leads', { q: 'x' }, { 'x-ishur-session': tok }), e, ctx, { isRead });
  assert.deepEqual(await g.request.json(), { q: 'x', admin_key: 'k' });
  /* the token sitting where the old pages put the key */
  g = await authGate(apiReq('/api/leads', { admin_key: tok, action: 'close' }), e, ctx, { isRead });
  assert.equal((await g.request.json()).admin_key, 'k');
  const log = await queryActions(e, { days: 1 });
  assert.deepEqual(log.map(r => [r.u, r.a, r.p]).sort(), [[STAFF, 'leads · close', '/api/leads'], [STAFF, 'pause', '/api/pause']], 'two writes logged; the GET and the read are not');
  /* an unknown or ended token is not a key */
  const bad = apiReq('/api/pause', { admin_key: 'us.' + 'f'.repeat(64) });
  assert.equal((await authGate(bad, e, ctx, { isRead })).request, bad);
  /* end to end through the Worker: the session opens an admin route, and a batch of reads is not logged */
  const before = (await queryActions(e, { days: 1 })).length;
  const r = await worker.fetch(apiReq('/api/admin/home', { session: tok, calls: [{ p: '/api/referrals', m: 'POST', b: {} }] }), e, ctx);
  const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.results[0].s, 200);
  assert.equal((await worker.fetch(apiReq('/api/admin/home', { session: 'us.' + 'f'.repeat(64), calls: [] }), e, ctx)).status, 403);
  assert.equal((await queryActions(e, { days: 1 })).length, before);
});

test('switch ON: the shared key alone is refused from a browser, still accepted from automation; a session passes; no key = untouched', async () => {
  const e = envWith({ 'cfg:auth_enforce': 'on' }); await ensureSeed(e); const tok = await createSession(e, OWNER);
  const g = await authGate(apiReq('/api/pause', { admin_key: 'k', paused: true }), e, ctx, {});
  assert.equal(g.response.status, 401); assert.equal((await g.response.json()).error, 'login-required');
  assert.equal(g.response.headers.get('Access-Control-Allow-Origin'), 'https://ishur.io');
  assert.equal((await authGate(new Request('https://go.ishur.io/api/ops/realtime', { headers: { 'X-Admin-Key': 'k', 'Sec-Fetch-Site': 'cross-site' } }), e, ctx, {})).response.status, 401);
  assert.equal((await authGate(new Request('https://go.ishur.io/api/ops/realtime', { headers: { Authorization: 'Bearer k', Origin: 'https://ishur.io' } }), e, ctx, {})).response.status, 401, 'the key as a Bearer token is the same key');
  const auto = new Request('https://go.ishur.io/api/pause', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Make' }, body: JSON.stringify({ admin_key: 'k' }) });
  assert.equal((await authGate(auto, e, ctx, {})).request, auto, 'no Origin / Sec-Fetch = automation, untouched');
  const guest = apiReq('/api/status', { token: 'x' }); assert.equal((await authGate(guest, e, ctx, {})).request, guest, 'a request with no admin key is never refused');
  assert.equal((await authGate(apiReq('/api/pause', { session: tok, paused: true }), e, ctx, {})).response, undefined);
  assert.equal((await worker.fetch(apiReq('/api/admin/home', { admin_key: 'k', calls: [] }), e, ctx)).status, 401);
  const viaSession = await worker.fetch(apiReq('/api/admin/home', { session: tok, calls: [{ p: '/api/referrals', m: 'POST', b: {} }] }), e, ctx);
  assert.equal(viaSession.status, 200); assert.equal((await viaSession.json()).results[0].s, 200, 'the inner calls of a batch are not refused');
  e.RATE.m.set('cfg:auth_enforce', 'off');
  assert.equal((await worker.fetch(apiReq('/api/admin/home', { admin_key: 'k', calls: [] }), e, ctx)).status, 200, 'switching it off restores the key at once');
});

test('the routes are mounted and the browser may send the session header', async () => {
  const e = envWith();
  const r = await worker.fetch(new Request('https://go.ishur.io/api/auth/config', { headers: { Origin: 'https://ishur.io' } }), e, ctx);
  assert.deepEqual(await r.json(), { ok: true, configured: false, client_id: '', enforce: false });
  assert.equal((await worker.fetch(apiReq('/api/auth/google', { credential: 'x.y.z' }), e, ctx)).status, 503);
  assert.equal((await worker.fetch(apiReq('/api/auth/me', {}), e, ctx)).status, 401);
  assert.match(cors('https://ishur.io')['Access-Control-Allow-Headers'], /X-Ishur-Session/);
  assert.match(cors('https://ishur.io')['Access-Control-Allow-Headers'], /X-Admin-Key/);
});

test('enforceOn: "on", a start time in the past, a start time in the future, anything else', async () => {
  const { enforceOn } = await import('../auth.js');
  const env = (v) => ({ RATE: { get: async () => v } });
  assert.equal(await enforceOn(env('on')), true);
  assert.equal(await enforceOn(env(new Date(Date.now() - 60e3).toISOString())), true);
  assert.equal(await enforceOn(env(new Date(Date.now() + 3600e3).toISOString())), false);
  assert.equal(await enforceOn(env('')), false); assert.equal(await enforceOn(env(null)), false); assert.equal(await enforceOn(env('off')), false);
});

test('track: screens and clicks of a signed-in user land in the action log under that user; no session, no log', async () => {
  const e = envWith(); await ensureSeed(e);
  const ss = await createSession(e, STAFF);
  assert.equal((await authPost(e, 'track', { items: [{ a: 'לחץ: שמירה', p: 'clients.html' }] })).status, 401);
  const r = await (await authPost(e, 'track', { session: ss, items: [{ a: 'פתח מסך', p: 'clients.html' }, { a: 'לחץ: <b>שמירה</b>', p: 'clients.html#designs' }, { a: '' }, ...Array.from({ length: 40 }, (_, i) => ({ a: 'לחץ: ' + i, p: 'x' }))] })).json();
  assert.equal(r.logged, 29, 'at most 30 items a batch, empty ones skipped');
  const mine = await queryActions(e, { user: STAFF, limit: 100 });
  assert.equal(mine.length, 29); assert.ok(mine.every(x => x.u === STAFF)); assert.ok(mine.some(x => x.a === 'פתח מסך' && x.p === 'clients.html')); assert.ok(mine.some(x => x.a === 'לחץ: bשמירה/b'));
  assert.equal((await queryActions(e, { user: OWNER })).length, 0);
});
