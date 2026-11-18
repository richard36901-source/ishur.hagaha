import test from 'node:test'; import assert from 'node:assert/strict';
import { swrKey, swrServe, swrReset, HARD_MAX_S } from '../swr.js';
const kv = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };

test('key: only the listed reads; a conversation, a search or a long query is never cached; the admin key is not part of it', () => {
  assert.equal(swrKey('/api/floor', { admin_key: 'a' }), 'floor:{}'); assert.equal(swrKey('/api/floor', { admin_key: 'b' }), 'floor:{}');
  assert.equal(swrKey('/api/inbox', { admin_key: 'a', channel: 'guests' }), 'inbox:{"channel":"guests"}');
  assert.equal(swrKey('/api/inbox', { admin_key: 'a', phone: '972500000001' }), ''); assert.equal(swrKey('/api/inbox', { admin_key: 'a', q: 'דנה' }), '');
  assert.equal(swrKey('/api/calls-log', { b: 2, a: 1 }), swrKey('/api/calls-log', { a: 1, b: 2 }));
  assert.equal(swrKey('/api/floor', { admin_key: 'a', app: 'ishur-web', nonce: 'n1', stamp_ts: 1, sig: 's' }), 'floor:{}', 'the page stamp is ignored');
  assert.equal(swrKey('/api/wa-send', {}), ''); assert.equal(swrKey('/api/ops-stats', { x: 'y'.repeat(300) }), ''); assert.equal(swrKey('/api/floor', null), '');
});
test('first request builds; the next ones get the kept answer at once; an old one is rebuilt behind the response; a very old one is rebuilt first', async () => {
  swrReset(); const env = { RATE: kv() }; let n = 0; const jobs = []; const ctx = { waitUntil: p => jobs.push(p) };
  const call = now => swrServe({ pathname: '/api/floor', body: { admin_key: 'k' }, env, ctx, now, produce: async () => JSON.stringify({ ok: true, n: ++n }) });
  const t0 = Date.now();
  let r = await call(t0); assert.deepEqual([r.cached, JSON.parse(r.text).n, n], [false, 1, 1]);
  r = await call(t0 + 2000); assert.deepEqual([r.cached, JSON.parse(r.text).n, n, jobs.length], [true, 1, 1, 0], 'fresh enough: no rebuild');
  r = await call(t0 + 9000); assert.deepEqual([r.cached, JSON.parse(r.text).n, jobs.length], [true, 1, 1], 'stale: old answer now, rebuild queued');
  await Promise.all(jobs); assert.equal(n, 2);
  r = await call(Date.now() + 1000); assert.equal(JSON.parse(r.text).n, 2);
  r = await call(Date.now() + (HARD_MAX_S + 5) * 1000); assert.deepEqual([r.cached, JSON.parse(r.text).n], [false, 3], 'older than the hard limit: built before answering');
});
test('another isolate finds it in KV; a failed build is not kept; an uncacheable request returns nothing', async () => {
  swrReset(); const env = { RATE: kv() }; const ctx = { waitUntil() {} };
  await swrServe({ pathname: '/api/ops-stats', body: {}, env, ctx, produce: async () => '{"ok":true,"v":1}' });
  swrReset(); let built = 0;
  const r = await swrServe({ pathname: '/api/ops-stats', body: {}, env, ctx, produce: async () => { built++; return '{"ok":true,"v":2}'; } });
  assert.deepEqual([r.cached, JSON.parse(r.text).v, built], [true, 1, 0]);
  swrReset(); const e2 = { RATE: kv() };
  assert.equal(await swrServe({ pathname: '/api/floor', body: {}, env: e2, ctx, produce: async () => null }), null); assert.equal(e2.RATE.m.size, 0);
  assert.equal(await swrServe({ pathname: '/api/inbox', body: { phone: '9725' }, env: e2, ctx, produce: async () => 'x' }), null);
});
