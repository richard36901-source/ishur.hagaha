// node --test worker/test/kv-reads.test.mjs — 21/11 the Cloudflare bill: three jobs re-read old days on every tick.
// A past day that did not fit is tried once a day (counters, plan); the calendar keeps days older than three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CNT from '../counters.js';
import { precomputePlans, PLAN_DAY_KEY, PAST_DAY_OPS } from '../ops-plan.js';
import { sendsByDay, callsByDay } from '../ops.js';
import { readLogValues, CAL_DAY_KEY, calDayOf, BATCH } from '../calendar-log.js';

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
function harness(cutDays, boom = [], init = {}) {
  const env = { RATE: kv(init) }; const audit = [];
  const d = { ilDate: (x = new Date(NOW)) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(x), snapshotCached: async () => null, clientPhoneId: () => 'N',
    kvPrefix: async (e, pre) => Object.fromEntries([...e.RATE.m.entries()].filter(([k]) => k.startsWith(pre))),
    auditQueryEx: async (e, q) => { audit.push(q); if (q.from && boom.includes(q.from)) { if (boom.mode === 'throw') throw new Error('KV down'); return { items: [], truncated: true, ops: 40, failed: 3 }; } const cut = !!q.from && cutDays.includes(q.from); return { items: [], truncated: cut, ops: cut ? q.budget : 12, failed: 0 }; },
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
  assert.deepEqual(a.stats, { reads: 40 + 1 + 7 + 5, failed: 0, live_days: 2, cached_days: 0, built_days: 1, failed_days: 0, put_failed: 0 });
  const kept = JSON.parse(e.RATE.m.get(CAL_DAY_KEY('2026-11-10')));
  assert.equal(kept.n, 40); assert.equal(Object.keys(kept.v).length, 30, 'only outgoing messages are kept');
  assert.ok(!JSON.stringify(kept).includes('not-kept')); assert.equal(Object.values(kept.v)[0].text.length, 120);
  e.RATE.n.get = 0;
  const b = await readLogValues(e, names, { now: now + 600e3 });
  assert.deepEqual(b.stats, { reads: 1 + 7 + 5, failed: 0, live_days: 2, cached_days: 1, built_days: 0, failed_days: 0, put_failed: 0 }); assert.equal(e.RATE.n.get, 13);
  /* what the calendar shows is the same from the kept copy as from the log */
  const shown = vals => names.map((n, i) => { let v = null; try { v = JSON.parse(vals[i]); } catch {} return v && v.dir === 'out' ? [n, v.at, v.tok, v.ch, v.tmpl, v.type, v.ok, v.status, v.error, String(v.text || '').slice(0, 120)] : null; });
  assert.deepEqual(shown(b.vals), shown(a.vals));
  /* a new message on the old day → that day is rebuilt */
  const late = `log:972509:${at('2026-11-10', 99)}`; e.RATE.m.set(late, JSON.stringify({ dir: 'out', tmpl: 'late' }));
  const c = await readLogValues(e, [...names, late], { now: now + 1200e3 }); assert.equal(c.stats.built_days, 1); assert.equal(JSON.parse(c.vals[names.length]).tmpl, 'late');
  /* a failed read: shown as far as it came back, nothing kept */
  const f = { RATE: kv(entries) }; const get0 = f.RATE.get; let k = 0; f.RATE.get = async key => { if (key.startsWith('log:') && calDayOf(Number(key.split(':').pop())) === '2026-11-10' && ++k === 5) throw new Error('Too many API requests'); return get0(key); };
  const g = await readLogValues(f, names, { now }); assert.equal(g.stats.built_days, 0); assert.equal(g.stats.failed, 1); assert.equal(g.stats.failed_days, 1); assert.equal(f.RATE.m.has(CAL_DAY_KEY('2026-11-10')), false);
  assert.equal(g.vals.filter(Boolean).length, 40 + 7 + 5 - 1);
});

test('plan: a past day whose read FAILED (KV error or a query that threw) keeps nothing and is read again on the next tick', async () => {
  for (const mode of ['failed', 'throw']) {
    const boom = ['20261101']; boom.mode = mode; const h = harness([], boom);
    await precomputePlans(h.env, h.d, h.fns, { now: NOW, periods: ['week'], pastDayBudget: 1 });
    assert.equal(h.env.RATE.m.has(PLAN_DAY_KEY('2026-11-01')), false, mode + ': nothing kept');
    h.audit.length = 0;
    await precomputePlans(h.env, h.d, h.fns, { now: NOW + 600e3, periods: ['week'], pastDayBudget: 1 });
    assert.ok(h.audit.some(q => q.from === '20261101'), mode + ': read again ten minutes later');
  }
});

test('plan: what the pacer reads (plan:today) does not depend on past days — kept, cut or missing', async () => {
  const past = (day, extra = {}) => JSON.stringify({ day, sends: [{ day, tok8: 'c2f63d20', type: 'w2', sent: 50, delivered: 40, failed: 3, template: 't' }], calls: [{ day, tok8: 'c2f63d20', dialed: 9, answered: 4 }], lead: { sent: 7, failed: 2 }, truncated: false, final: true, ...extra });
  const run = async init => { const h = harness([], [], init); const r = await precomputePlans(h.env, h.d, h.fns, { now: NOW }); const strip = p => JSON.parse(JSON.stringify({ days: p.days, tomorrow: p.tomorrow, status: p.status }, (k, v) => (k === 'audit_truncated' ? undefined : v))); return { today: strip(r.plans.today), week: strip(r.plans.week), kv: JSON.parse(h.env.RATE.m.get('plan:today')).data }; };
  const none = await run({});
  const kept = await run({ [PLAN_DAY_KEY('2026-11-02')]: past('2026-11-02'), [PLAN_DAY_KEY('2026-11-03')]: past('2026-11-03') });
  const cut = await run({ [PLAN_DAY_KEY('2026-11-02')]: past('2026-11-02', { final: false, cut: true, truncated: true }), [PLAN_DAY_KEY('2026-11-03')]: past('2026-11-03') });
  assert.notDeepEqual(kept.week.days, none.week.days, 'the past days do reach the week view (so this test sees them)');
  assert.deepEqual(kept.today, none.today); assert.deepEqual(cut.today, none.today);
  assert.deepEqual(kept.kv.days, none.kv.days, 'the rows the pacer counts from are the same');
});

test('calendar log: when a build can only complete part of the month, the days that came back whole are kept and the next builds finish the rest', async () => {
  /* production 21/11: the month fired at once failed in bulk and no old day was ever kept. Here each build gets 1,000 good reads, then every read fails. */
  const now = Date.parse('2026-11-21T10:00:00Z'); const entries = {};
  for (let d = 1; d <= 21; d++) { const day = '2026-11-' + String(d).padStart(2, '0'); for (let i = 0; i < 200; i++) entries[`log:9725${String(d).padStart(2, '0')}${i}:${Date.parse(day + 'T09:00:00Z') + i}`] = JSON.stringify({ dir: 'out', tmpl: 't', status: 'sent' }); }
  const e = { RATE: kv(entries) }; const names = Object.keys(entries); const get0 = e.RATE.get; let left = 0, inFlight = 0, peak = 0;
  e.RATE.get = async key => { inFlight++; peak = Math.max(peak, inFlight); try { await null; if (--left < 0) throw new Error('Too many API requests'); return await get0(key); } finally { inFlight--; } };
  const kept = () => [...e.RATE.m.keys()].filter(k => k.startsWith('callog:')).length;
  const seen = [];
  for (let build = 0; build < 20 && kept() < 18; build++) { left = 1000; const r = await readLogValues(e, names, { now: now + build * 600e3 }); seen.push(kept()); assert.equal(r.vals.slice(-600).filter(Boolean).length, 600, 'the live days are always shown'); }
  assert.equal(kept(), 18, 'every day older than three is kept in the end: ' + seen.join(','));
  assert.ok(seen[0] >= 1 && seen.every((n, i) => !i || n >= seen[i - 1]), 'each build adds days: ' + seen.join(','));
  assert.ok(peak <= BATCH, 'never more than a batch of reads in flight: ' + peak);
  left = 1e9; e.RATE.n.get = 0; const r = await readLogValues(e, names, { now: now + 7200e3 });
  assert.equal(r.stats.reads, 600 + 18); assert.equal(r.stats.cached_days, 18); assert.equal(r.stats.failed, 0); assert.equal(r.vals.filter(Boolean).length, names.length);
});
