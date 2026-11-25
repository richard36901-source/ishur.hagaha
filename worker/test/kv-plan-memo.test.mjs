// node --test worker/test/kv-plan-memo.test.mjs — 25/11 the KV bill: one plan build reads a KV prefix once
// (buildCapacity and subsNow both walked every sub-event's shsent:/wst:/shrsvp: keys: ~850 reads a tick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precomputePlans, memoPrefix } from '../ops-plan.js';
import { buildCapacity, sendsByDay, callsByDay } from '../ops.js';
import { kvPrefix as realKvPrefix } from '../lib.js';

const kv = (init = {}) => { const m = new Map(Object.entries(init)); const n = { get: 0, list: 0 };
  return { m, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => { n.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }; } }; };

test('memoPrefix: one underlying call per prefix, a failed call is retried', async () => {
  let calls = 0, boom = true;
  const f = memoPrefix(async (e, p) => { calls++; if (p === 'x:' && boom) { boom = false; throw new Error('KV'); } return { [p]: 1 }; });
  assert.deepEqual(await Promise.all([f(null, 'a:'), f(null, 'a:'), f(null, 'b:')]), [{ 'a:': 1 }, { 'a:': 1 }, { 'b:': 1 }]);
  assert.equal(calls, 2);
  await assert.rejects(f(null, 'x:')); assert.deepEqual(await f(null, 'x:'), { 'x:': 1 }); assert.equal(calls, 4);
});

const NOW = Date.parse('2026-11-25T10:00:00Z'); const SUB = '11111111-0000-4000-8000-000000000001', PAR = 'c1c5fcf5-0000-4000-8000-0000000000aa';
function raw() {
  const ev = Array(50).fill(''); ev[1] = PAR; ev[2] = 'לקוח'; ev[6] = '2026-11-30'; ev[7] = 'כן'; ev[43] = 'כן'; ev[39] = '2026-11-25';
  const guests = []; for (let i = 0; i < 60; i++) { const g = Array(31).fill(''); g[28] = PAR; g[2] = 'G' + i; g[3] = 'אורח'; g[4] = '0520000' + String(i).padStart(3, '0'); guests.push(g); }
  return { events: { values: [ev] }, guests: { values: guests } };
}
function setup() {
  const init = { ['subevent:' + SUB]: JSON.stringify({ parent: PAR, kind: 'shabbat', name: 'שבת חתן', template: 't' }) };
  for (let i = 0; i < 60; i += 2) { const p = '9725200000' + String(i).padStart(2, '0').slice(-2); init[`shsent:${SUB}:9725200000${String(i).padStart(2, '0')}`] = '1'; init[`wst:${SUB}:shabbat:9725200000${String(i).padStart(2, '0')}`] = 'delivered'; void p; }
  const env = { RATE: kv(init) }; const prefixes = [];
  const d = { ilDate: (x = new Date(NOW)) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(x), snapshotCached: async () => raw(), clientPhoneId: () => 'N', guestPhoneIds: () => ['A'],
    kvPrefix: async (e, pre) => { prefixes.push(pre); return realKvPrefix(e, pre); },
    auditQueryEx: async () => ({ items: [], truncated: false, ops: 1, failed: 0 }), sendBoardData: async () => ({ events: [] }), sendingPaused: async () => false, sendWindowState: () => ({ open: true }), callWindowState: () => ({ open: true }),
    isNoContactDay: () => false, isTestEventRow: () => false, planKeyOf: () => 'pro', normPhone: x => { let s = String(x || '').replace(/\D/g, ''); if (s.startsWith('0')) s = '972' + s.slice(1); return s; },
    waCapInfo: async () => null, guestCapacity: async () => ({ remaining: 100, limit: 250, margin: 10, numbers: [] }) };
  const fns = { sendsByDay, callsByDay, buildCapacity, buildCallRounds: async () => ({ ok: true, events: [], totals: {} }), buildRealtime: async () => ({ ok: true, today: '2026-11-25', wa: { numbers: [], totals: {} }, cap: { remaining: 100 }, queue: { sends: {}, calls: {} }, make: {}, noa: {} }) };
  return { env, d, fns, prefixes };
}

test('a plan build reads each sub-event prefix once; the plan is the same as with a plain kvPrefix', async () => {
  const a = setup();
  const r = await precomputePlans(a.env, a.d, a.fns, { now: NOW, periods: ['today'] });
  const subPrefixes = a.prefixes.filter(p => /^(shsent|wst|shrsvp|subevent):/.test(p));
  assert.equal(subPrefixes.length, new Set(subPrefixes).size, 'no prefix read twice: ' + subPrefixes.join(' '));
  assert.ok(subPrefixes.includes(`shsent:${SUB}:`));
  const subs = (r.plans.today.subevents || r.plans.today.subs || []);
  void subs;
  /* the composed plan does not depend on the memo: compare with each prefix read fresh by a non-memo build of the same pieces */
  const b = setup(); const capMemo = await buildCapacity(b.env, { ...b.d, kvPrefix: memoPrefix(b.d.kvPrefix) }, NOW, 3);
  const c = setup(); const capPlain = await buildCapacity(c.env, c.d, NOW, 3);
  const strip = x => JSON.parse(JSON.stringify(x, (k, v) => (k === 'at' ? undefined : v)));
  assert.deepEqual(strip(capMemo), strip(capPlain));
  assert.ok(b.env.RATE.n.get < c.env.RATE.n.get || b.env.RATE.n.get === c.env.RATE.n.get);
});
