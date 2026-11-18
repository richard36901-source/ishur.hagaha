import test from 'node:test'; import assert from 'node:assert/strict';
import { payRowsByDay, dayList } from '../ops-money.js';
const kv = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };
test('days are listed newest first, both ends included', () => { assert.deepEqual(dayList('2026-11-14', '2026-11-16'), ['2026-11-16', '2026-11-15', '2026-11-14']); });
test('payment rows by day: past days are read once and kept, today and yesterday always live, a cold start fills in steps, a cut day is not kept', async () => {
  const env = { RATE: kv() }; const reads = []; let cutDay = '';
  const d = { auditQueryEx: async (e, q) => { const day = q.from.slice(0, 4) + '-' + q.from.slice(4, 6) + '-' + q.from.slice(6); reads.push(day); return day === cutDay ? { items: [], truncated: true } : { items: [{ day, ref: 'r' + day }], truncated: false, ops: 10 }; } };
  let r = await payRowsByDay(env, d, { from: '2026-11-01', today: '2026-11-16', maxFill: 5 });
  assert.equal(r.truncated, true, 'not everything is in yet'); assert.equal(reads.length, 7, 'today + yesterday + 5 past days'); assert.equal(r.items.length, 7); assert.equal(new Date(r.oldest_ts).toISOString().slice(0, 10), '2026-11-10');
  assert.ok(env.RATE.m.has('payday:2026-11-14')); assert.ok(!env.RATE.m.has('payday:2026-11-16') && !env.RATE.m.has('payday:2026-11-15'), 'live days are never kept');
  reads.length = 0; r = await payRowsByDay(env, d, { from: '2026-11-01', today: '2026-11-16', maxFill: 5 }); assert.deepEqual(reads.slice(0, 2), ['2026-11-16', '2026-11-15']); assert.equal(reads.length, 7, 'kept days are not read again; five more are filled');
  reads.length = 0; r = await payRowsByDay(env, d, { from: '2026-11-01', today: '2026-11-16', maxFill: 5 }); assert.equal(r.truncated, false); assert.equal(r.items.length, 16); assert.equal(new Date(r.oldest_ts).toISOString().slice(0, 10), '2026-11-01');
  reads.length = 0; r = await payRowsByDay(env, d, { from: '2026-11-01', today: '2026-11-16', maxFill: 5 }); assert.deepEqual(reads, ['2026-11-16', '2026-11-15'], 'a warm call reads only the two live days'); assert.equal(r.items.length, 16);
  const e2 = { RATE: kv() }; cutDay = '2026-11-13';
  r = await payRowsByDay(e2, d, { from: '2026-11-10', today: '2026-11-16' }); assert.equal(r.truncated, true); assert.ok(!e2.RATE.m.has('payday:2026-11-13'), 'a day whose read was cut is not kept'); assert.ok(e2.RATE.m.has('payday:2026-11-14')); assert.ok(!e2.RATE.m.has('payday:2026-11-12'), 'and nothing older is assumed');
});

test('a busy day gets the whole remaining budget; filling stops when too little is left for another day', async () => {
  const run = async (heavyOps) => { const env = { RATE: kv() }; const got = [];
    const d = { auditQueryEx: async (e, q) => { got.push(q.budget); return { items: [], truncated: false, ops: q.from === '20261114' ? heavyOps : 100 }; } };
    return { r: await payRowsByDay(env, d, { from: '2026-11-10', today: '2026-11-16', opsBudget: 2800 }), got }; };
  const a = await run(2000);   /* 100 + 100 live, 2000 for the busy day, 600 left: the cheap days after it still fit */
  assert.deepEqual(a.got, [900, 900, 2600, 600, 500, 400, 300]); assert.equal(a.r.truncated, false);
  const b = await run(2500);   /* the busy day leaves 100: too little for a whole day, so the older days wait for the next call */
  assert.deepEqual(b.got, [900, 900, 2600]); assert.equal(b.r.truncated, true);
});

test('a day too big for one request: its partial rows are kept, it is named as a gap, it is not retried, and the older days still get read', async () => {
  const env = { RATE: kv() }; const reads = [];
  const d = { auditQueryEx: async (e, q) => { reads.push(q.from); return q.from === '20261112' ? { items: [{ ref: 'part' }], truncated: true, ops: q.budget } : { items: [{ ref: q.from }], truncated: false, ops: 20 }; } };
  let r = await payRowsByDay(env, d, { from: '2026-11-10', today: '2026-11-16' });
  assert.deepEqual(r.gaps, ['2026-11-12']); assert.equal(r.truncated, true); assert.ok(env.RATE.m.has('paydayx:2026-11-12')); assert.ok(r.items.some(x => x.ref === 'part'));
  reads.length = 0; r = await payRowsByDay(env, d, { from: '2026-11-10', today: '2026-11-16' });
  assert.ok(!reads.includes('20261112'), 'the big day is not read again'); assert.deepEqual(r.gaps, ['2026-11-12']); assert.equal(r.truncated, false, 'the range itself is now covered'); assert.ok(env.RATE.m.has('payday:2026-11-10')); assert.equal(new Date(r.oldest_ts).toISOString().slice(0, 10), '2026-11-10');
});
