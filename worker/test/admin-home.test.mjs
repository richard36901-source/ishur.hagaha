// node --test worker/test/admin-home.test.mjs — /api/admin/home: one request for a whole admin view (12/11 אדמין אחד)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { homeReadOk } from '../index.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const env = () => ({ ADMIN_KEY: 'k', RATE: kv() });
const post = (e, body) => worker.fetch(new Request('https://go.ishur.io/api/admin/home', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify(body) }), e, ctx);

test('only reads ride in a batch: listed POST routes without an action field, and GET /api/ops/*', () => {
  assert.equal(homeReadOk('/api/referrals', 'POST', {}), true);
  assert.equal(homeReadOk('/api/staff', 'POST', {}), true);
  assert.equal(homeReadOk('/api/staff', 'POST', { act: 'add', name: 'x' }), false, 'a write through a read route');
  assert.equal(homeReadOk('/api/pause', 'POST', { paused: true }), false);
  assert.equal(homeReadOk('/api/client-link', 'POST', {}), false, 'a send route is never batchable');
  assert.equal(homeReadOk('/api/ops/plan?period=week', 'GET'), true);
  assert.equal(homeReadOk('/api/ops/toggle', 'POST', { id: 'x', enabled: false }), false);
  assert.equal(homeReadOk('/api/admin/home', 'POST', {}), false, 'no nesting');
  assert.equal(homeReadOk('https://evil.example/api/status', 'POST', {}), false);
});
test('the route needs the admin key and answers each call in order', async () => {
  const e = env();
  assert.equal((await post(e, { admin_key: 'nope', calls: [] })).status, 403);
  const j = await (await post(e, { admin_key: 'k', calls: [{ p: '/api/referrals', m: 'POST', b: {} }, { p: '/api/client-link', m: 'POST', b: { token: 'x' } }, { p: '/api/staff', m: 'POST', b: {} }] })).json();
  assert.equal(j.ok, true); assert.equal(j.results.length, 3);
  assert.equal(j.results[0].s, 200); assert.equal(JSON.parse(j.results[0].t).ok, true);
  assert.equal(j.results[1].s, 400, 'the send route is refused inside the batch');
  assert.equal(JSON.parse(j.results[2].t).ok, true);
});
test('realtime is served from the 60-second copy when one exists', async () => {
  const e = env(); e.RATE.m.set('homecache:realtime', '{"ok":true,"from":"cache"}');
  const j = await (await post(e, { admin_key: 'k', calls: [{ p: '/api/ops/realtime', m: 'GET' }] })).json();
  assert.equal(j.results[0].cached, true); assert.equal(JSON.parse(j.results[0].t).from, 'cache');
});

test('event-flag: the read is batchable, a write (any `on`, even false) is not', () => {
  assert.equal(homeReadOk('/api/event-flag', 'POST', { token: 'x', flag: 'hold' }), true);
  assert.equal(homeReadOk('/api/event-flag', 'POST', { token: 'x', flag: 'hold', on: false }), false);
  assert.equal(homeReadOk('/api/event-flag', 'POST', { token: 'x', flag: 'hold', on: true }), false);
});
