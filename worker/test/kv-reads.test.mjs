// node --test worker/test/kv-reads.test.mjs — 21/11 the Cloudflare bill: three jobs re-read old days on every tick.
// A past day that did not fit is tried once a day (counters, plan); the calendar keeps days older than three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CNT from '../counters.js';
import { precomputePlans, PLAN_DAY_KEY, PAST_DAY_OPS } from '../ops-plan.js';
import { sendsByDay, callsByDay } from '../ops.js';
import { readLogValues, CAL_DAY_KEY, calDayOf } from '../calendar-log.js';

const kv = (init = {}) => { const m = new Map(Object.entries(init)); const n = { get: 0, put: 0 };
  return { m, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; }, put: async (k, v, o) => { n.put++; m.set(k, String(v)); (kv.ttl = kv.ttl || {})[k] = o && o.expirationTtl; }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) }; };

test('counters: a past day whose audit read was cut is marked and not read again on the next tick; a complete day is still marked done', async () => {
  const e = { RATE: kv() }; const now = Date.parse('2026-11-21T10:00:00Z'); const asked = [];
  const d = { auditQueryEx: async (_, q) => { asked.push(q.from); return { items: [], truncated: q.from === '20261119' }; } };
  const r1 = await CNT.backfillCounters(e, d, { now, perRun: 2, converge: false });
  assert.deepEqual(r1.map(x => [x.day, x.ok]), [['2026-11-19', false], ['2026-11-18', true]]);
  assert.equal(await e.RATE.get('cnt:bf:2026-11-19'), 'cut'); assert.equal(kv.ttl['cnt:bf:2026-11-19'], CNT.RETRY_CUT_S);
  assert.equal(await e.RATE.get('cnt:bf:2026-11-18'), '1'); assert.ok(kv.ttl['cnt:bf:2026-11-18'] > 300 * 86400);
  assert.equal(await e.RATE.get('cnt:2026-11-19:wa_out'), null, 'a cut read writes no counter');
  asked.length = 0;
  const r2 = await CNT.backfillCounters(e, d, { now: now + 600e3, perRun: 2, converge: false });
  assert.ok(!asked.includes('20261119'), 'the cut day is not read again ten minutes later');
  assert.deepEqual(r2.map(x => x.day), ['2026-11-17', '2026-11-16'], 'the tick moves on to the next days');
  e.RATE.m.delete('cnt:bf:2026-11-19'); asked.length = 0;   /* a day later the marker has expired */
  await CNT.backfillCounters(e, d, { now: now + 600e3, perRun: 1, converge: false });
  assert.deepEqual([...new Set(asked)], ['20261119'], 'and it is tried again');
});

const NOW = Date.parse('2026-11-04T13:40:00Z'), RT = { ok: true, today: '2026-11-04', wa: { numbers: [], totals: {} }, cap: { remaining: 100 }, queue: { sends: {}, calls: {} }, make: {}, noa: {} };
function harness(cutDays) {
  const env = { RATE: kv() }; const audit = [];
  const d = { ilDate: (x = new Date(NOW)) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(x), snapshotCached: async () => null, clientPhoneId: () => 'N',
    kvPrefix: async (e, pre) => Object.fromEntries([...e.RATE.m.entries()].filter(([k]) => k.startsWith(pre))),
    auditQueryEx: async (e, q) => { audit.push(q); return { items: [], truncated: !!q.from && cutDays.includes(q.from) }; },
    sendBoardData: async () => ({ events: [] }), sendingPaused: async () => false, sendWindowState: () => ({ open: true }), callWindowState: () => ({ open: true }), isNoContactDay: () => false, isTestEventRow: () => false, planKeyOf: () => 'pro', normPhone: x => x };
  const fns = { sendsByDay, callsByDay, buildCapacity: async () => ({ ok: true, days: [] }), buildCallRounds: async () => ({ ok: true, events: [], totals: {} }), buildRealtime: async () => RT };
  return { env, d, fns, audit };
}
test('plan: a past day that did not fit is kept for a day (still truncated), is not read again, and no longer blocks the days after it', async () => {
  const h = harness(['20261101']);   /* week of 04/11: Sun 01, Mon 02, Tue 03 are past */
  const r1 = await precomputePlans(h.env, h.d, h.fns, { now: NOW, periods: ['week'], pastDayBudget: 1 });
  assert.deepEqual([...new Set(h.audit.filter(q => q.from).map(q => q.from))], ['20261101'], 'tick 1 reads the one day its allowance covers');
  assert.ok(h.audit.filter(q => q.from).every(q => q.budget === PAST_DAY_OPS));
  const cut = JSON.parse(h.env.RATE.m.get(PLAN_DAY_KEY('2026-11-01')));
  assert.deepEqual([cut.cut, cut.final, cut.truncated], [true, false, true]); assert.equal(kv.ttl[PLAN_DAY_KEY('2026-11-01')], 86400);
  assert.equal(r1.plans.week.audit_truncated, true);
  h.audit.length = 0;
  await precomputePlans(h.env, h.d, h.fns, { now: NOW + 600e3, periods: ['week'], pastDayBudget: 1 });
  assert.deepEqual([...new Set(h.audit.filter(q => q.from).map(q => q.from))], ['20261102'], 'tick 2 does not re-read the cut day and reaches the next one');
  assert.equal(JSON.parse(h.env.RATE.m.get(PLAN_DAY_KEY('2026-11-02'))).final, true);
  h.audit.length = 0;
  const r3 = await precomputePlans(h.env, h.d, h.fns, { now: NOW + 1200e3, periods: ['week'], pastDayBudget: 1 });
  await precomputePlans(h.env, h.d, h.fns, { now: NOW + 1800e3, periods: ['week'], pastDayBudget: 1 });
  assert.equal(h.audit.filter(q => q.from && q.from !== '20261103').length, 0); assert.equal(h.audit.filter(q => q.from === '20261103').length, 3, 'the last day is read once, then nothing past is read');
  assert.equal(r3.plans.week.audit_truncated, true, 'the cut day keeps the plan marked as incomplete');
});

test('calendar log: the last three days are read live; an older day is read once, then costs one read; nothing is kept from a failed read', async () => {
  const now = Date.parse('2026-11-21T10:00:00Z'); const at = (day, i) => Date.parse(day + 'T09:00:00Z') + i;
  const entries = {}; const add = (day, i, v) => { entries[`log:97250${i}:${at(day, i)}`] = JSON.stringify(v); };
  for (let i = 0; i < 40; i++) add('2026-11-10', i, { dir: i % 4 ? 'out' : 'in', at: 'x', tok: 'aaaa1111', ch: 'guests', tmpl: 't1', status: 'delivered', text: 'ש'.repeat(300), secret: 'not-kept' });
  for (let i = 0; i < 7; i++) add('2026-11-21', i, { dir: 'out', tmpl: 'today', status: 'sent' });
  for (let i = 0; i < 5; i++) add('2026-11-19', i, { dir: 'out', tmpl: 'two-days', status: 'sent' });
  const e = { RATE: kv(entries) }; const names = Object.keys(entries);
  const a = await readLogValues(e, names, { now });
  assert.deepEqual(a.stats, { reads: 40 + 1 + 7 + 5, live_days: 2, cached_days: 0, built_days: 1 });
  const kept = JSON.parse(e.RATE.m.get(CAL_DAY_KEY('2026-11-10')));
  assert.equal(kept.n, 40); assert.equal(Object.keys(kept.v).length, 30, 'only outgoing messages are kept');
  assert.ok(!JSON.stringify(kept).includes('not-kept')); assert.equal(Object.values(kept.v)[0].text.length, 120);
  e.RATE.n.get = 0;
  const b = await readLogValues(e, names, { now: now + 600e3 });
  assert.deepEqual(b.stats, { reads: 1 + 7 + 5, live_days: 2, cached_days: 1, built_days: 0 }); assert.equal(e.RATE.n.get, 13);
  /* what the calendar shows is the same from the kept copy as from the log */
  const shown = vals => names.map((n, i) => { let v = null; try { v = JSON.parse(vals[i]); } catch {} return v && v.dir === 'out' ? [n, v.at, v.tok, v.ch, v.tmpl, v.type, v.ok, v.status, v.error, String(v.text || '').slice(0, 120)] : null; });
  assert.deepEqual(shown(b.vals), shown(a.vals));
  /* a new message on the old day → that day is rebuilt */
  const late = `log:972509:${at('2026-11-10', 99)}`; e.RATE.m.set(late, JSON.stringify({ dir: 'out', tmpl: 'late' }));
  const c = await readLogValues(e, [...names, late], { now: now + 1200e3 }); assert.equal(c.stats.built_days, 1); assert.equal(JSON.parse(c.vals[names.length]).tmpl, 'late');
  /* a failed read: shown as far as it came back, nothing kept */
  const f = { RATE: kv(entries) }; const get0 = f.RATE.get; let k = 0; f.RATE.get = async key => { if (key.startsWith('log:') && calDayOf(Number(key.split(':').pop())) === '2026-11-10' && ++k === 5) throw new Error('Too many API requests'); return get0(key); };
  const g = await readLogValues(f, names, { now }); assert.equal(g.stats.built_days, 0); assert.equal(f.RATE.m.has(CAL_DAY_KEY('2026-11-10')), false);
  assert.equal(g.vals.filter(Boolean).length, 40 + 7 + 5 - 1);
});
