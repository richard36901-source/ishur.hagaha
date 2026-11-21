// 22/11/2026 · the run ring is queried without reading every row (it was ~3,000 KV reads per query, four queries every ten minutes)
import test from 'node:test';
import assert from 'node:assert/strict';
import { listRuns, getRun, runStats, RING_PREFIX } from '../ops-run.js';

const INV = 9999999999999;
function ring(rows) {
  const m = new Map(), meta = new Map(); const n = { get: 0, list: 0 };
  for (const r of rows) { const k = `${RING_PREFIX}${String(INV - Date.parse(r.started_at)).padStart(13, '0')}:${r.id}`; m.set(k, JSON.stringify(r)); meta.set(k, { a: r.automation_id, s: r.status, p: r.parent_id || '' }); }
  const names = [...m.keys()].sort();
  return { n, env: { RATE: {
    get: async k => { n.get++; return m.has(k) ? m.get(k) : null; },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { n.list++; const all = names.filter(x => x.startsWith(prefix)); const from = cursor ? Number(cursor) : 0; const page = all.slice(from, from + limit);
      return { keys: page.map(name => ({ name, metadata: meta.get(name) })), list_complete: from + limit >= all.length, cursor: String(from + limit) }; },
  } } };
}
const T0 = Date.parse('2026-11-21T00:00:00Z');
const rows = [];
const AUTOS = ['d_pacer', 'plan_precompute', 'calendar_build', 'audit_meta', 'brain_tick', 'notify'];
for (let i = 0; i < 6000; i++) { const a = AUTOS[i % AUTOS.length]; rows.push({ id: 'r' + i, automation_id: a, parent_id: i === 4001 ? 'r4000' : null, started_at: new Date(T0 + i * 30e3).toISOString(), ended_at: new Date(T0 + i * 30e3 + 900).toISOString(), status: i % 500 === 7 ? 'failed' : 'ok', triggered_by: 'cron', counts_json: '{"ms":900}' }); }

test('listRuns reads only the rows it returns: one automation, a time range, a limit', async () => {
  const { env, n } = ring(rows);
  const from = new Date(T0 + 5000 * 30e3).toISOString();
  const r = await listRuns(env, { automation_id: 'plan_precompute', from, limit: 50 });
  assert.equal(r.items.length, 50); assert.ok(r.items.every(x => x.automation_id === 'plan_precompute' && x.started_at >= from));
  assert.equal(r.items[0].id, 'r5995', 'newest first'); assert.ok(r.next_cursor);
  assert.ok(n.get <= 100, 'gets: ' + n.get + ' (was every row of the ring)');
  assert.ok(n.list <= 2, 'the listing stops once it is past `from`: ' + n.list);
  /* the next page continues where the first ended */
  const r2 = await listRuns(env, { automation_id: 'plan_precompute', from, limit: 50, cursor: r.next_cursor });
  assert.ok(r2.items.length > 0 && r2.items[0].started_at < r.items[49].started_at);
});

test('failed runs in a window: only the failed rows are read', async () => {
  const { env, n } = ring(rows);
  const r = await listRuns(env, { status: 'failed', from: new Date(T0).toISOString(), limit: 100 });
  assert.equal(r.items.length, 12); assert.ok(r.items.every(x => x.status === 'failed'));
  assert.equal(n.get, 12);
});

test('runStats counts from the listing alone; getRun is one read plus its children', async () => {
  const { env, n } = ring(rows);
  const since = new Date(T0 + 3000 * 30e3).toISOString();
  const s = await runStats(env, since);
  assert.equal(n.get, 0, 'no row is read for the counts');
  const total = Object.values(s.stats).reduce((a, o) => a + o.runs_24h, 0);
  assert.equal(total, 3000);
  assert.equal(s.stats.d_pacer.last_started_at, rows[5994].started_at);
  assert.equal(s.stats.plan_precompute.by_status.failed, rows.slice(3000).filter(r => r.automation_id === 'plan_precompute' && r.status === 'failed').length);
  const g = await getRun(env, 'r4000');
  assert.equal(g.run.id, 'r4000'); assert.deepEqual(g.children.map(c => c.id), ['r4001']);
  assert.equal(n.get, 2);
  assert.equal(await getRun(env, 'nope'), null);
});
