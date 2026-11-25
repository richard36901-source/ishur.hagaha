// node --test worker/test/kvmeter.test.mjs — 25/11 the KV bill: every KV call counted by prefix, with no KV read of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meterEnv, meterOf, beginInvocation, endInvocation, flushIsolate, dailyRollup, KVMETER_KEY, FLUSH_MS, prefixOf } from '../kvmeter.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init)); const md = new Map(); const n = { get: 0, list: 0, put: 0, del: 0 };
  return { m, md, n,
    get: async k => { n.get++; return m.has(k) ? m.get(k) : null; },
    getWithMetadata: async k => { n.get++; return { value: m.has(k) ? m.get(k) : null, metadata: md.get(k) || null }; },
    put: async (k, v, o = {}) => { n.put++; m.set(k, String(v)); if (o.metadata) md.set(k, o.metadata); },
    delete: async k => { n.del++; m.delete(k); },
    list: async ({ prefix = '' } = {}) => { n.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: md.get(name) || null })), list_complete: true }; } };
}

test('prefixOf: first segment of the key', () => {
  assert.equal(prefixOf('wsent:c1c5fcf5-0000:1:972500000001'), 'wsent');
  assert.equal(prefixOf('cfg'), 'cfg'); assert.equal(prefixOf(''), '(empty)');
});

test('meterEnv: one wrapper per namespace for the whole isolate (memos keyed by env.RATE keep working), values pass through', async () => {
  const RATE = kv({ 'a:1': 'x' });
  const e1 = meterEnv({ RATE }), e2 = meterEnv({ RATE });
  assert.equal(e1.RATE, e2.RATE, 'same wrapper object on every invocation');
  assert.equal(meterEnv(e1).RATE, e1.RATE, 'wrapping a wrapped env is a no-op');
  assert.equal(await e1.RATE.get('a:1'), 'x');
  assert.equal(meterEnv({}).RATE, undefined);
});

test('per invocation: one log line only above the threshold, with the top prefixes; the meter itself adds zero reads', async () => {
  const RATE = kv(); const env = meterEnv({ RATE, KV_METER_LOG: '5' }); const lines = [];
  const f = beginInvocation(env, 'cron */10');
  for (let i = 0; i < 4; i++) await env.RATE.get('wsent:t:' + i);
  await env.RATE.list({ prefix: 'log:' }); await env.RATE.put('x:1', '1');
  assert.equal(await endInvocation(env, f, { log: l => lines.push(l) }), null, '5 calls is not above 5');
  assert.equal(lines.length, 0);
  const g = beginInvocation(env, 'POST /api/x');
  for (let i = 0; i < 7; i++) await env.RATE.get('wsent:t:' + i);
  await env.RATE.getWithMetadata('cfg:a');
  const line = await endInvocation(env, g, { log: l => lines.push(l) });
  assert.equal(lines.length, 1); assert.equal(line, lines[0]);
  assert.match(line, /^kvmeter POST \/api\/x get=8 list=0 put=0 del=0 /);
  assert.match(line, /top: wsent=7 cfg=1$/);
  assert.equal(RATE.n.get, 4 + 8, 'the raw namespace saw only the code\'s own reads');
  assert.equal(RATE.n.list, 1);
});

test('isolate totals: flushed as a put with the numbers in metadata, at most every FLUSH_MS; daily rollup sums them with lists only', async () => {
  const RATE = kv(); const env = meterEnv({ RATE }); const t0 = Date.parse('2026-11-25T08:00:00Z');
  meterOf(env).st.tot.day = '2026-11-25'; meterOf(env).st.lastFlush = t0;
  for (let i = 0; i < 10; i++) await env.RATE.get('stream:x:' + i);
  await env.RATE.list({ prefix: 'opsrun:' });
  assert.equal(await flushIsolate(env, { now: t0 + 1000 }), false, 'too soon');
  assert.equal(await flushIsolate(env, { now: t0 + FLUSH_MS + 1 }), true);
  const iso = [...RATE.m.keys()].find(k => k.startsWith('kvm:2026-11-25:'));
  assert.ok(iso); assert.deepEqual(RATE.md.get(iso).g, 10); assert.equal(RATE.md.get(iso).l, 1);
  assert.equal(await flushIsolate(env, { now: t0 + 2 * FLUSH_MS + 2 }), false, 'nothing new → no write');
  /* a second isolate of the same day */
  const RATE2 = RATE; const other = { g: 5, l: 2, p: 1, d: 0, top: [['stream', 3], ['cfg', 2]] };
  await RATE2.put('kvm:2026-11-25:zzzz', '1', { metadata: other });
  const before = { ...RATE.n };
  const sum = await dailyRollup(env, '2026-11-25');
  assert.equal(RATE.n.get, before.get, 'the rollup reads no value');
  assert.equal(sum.get, 15); assert.equal(sum.list, 3); assert.equal(sum.isolates, 2); assert.equal(sum.top.stream, 13);
  assert.equal(JSON.parse(RATE.m.get(KVMETER_KEY('2026-11-25'))).get, 15, 'one key for the day');
});

test('a day change flushes the old day and starts the new one at zero', async () => {
  const RATE = kv(); const env = meterEnv({ RATE }); const st = meterOf(env).st;
  st.tot.day = '2026-11-24'; await env.RATE.get('a:1');
  assert.equal(await flushIsolate(env, { now: Date.parse('2026-11-25T08:00:00Z') }), true);
  assert.ok([...RATE.m.keys()].some(k => k.startsWith('kvm:2026-11-24:')));
  assert.equal(st.tot.day, '2026-11-25'); assert.equal(st.tot.get, 0);
});
