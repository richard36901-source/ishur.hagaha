// node --test worker/test/ops-run.test.mjs — the runs ledger (ops-run.js): D1 path, KV fallback, statuses, readers
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRun, listRuns, getRun, runStats, isOff, statusOf, RING_PREFIX } from '../ops-run.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }) };
}
/* a tiny D1 stand-in: INSERT / UPDATE / SELECT on one table, enough for ops-run.js */
function d1({ fail = false } = {}) {
  const rows = new Map(); const calls = [];
  const COLS = ['id', 'automation_id', 'parent_id', 'started_at', 'ended_at', 'status', 'triggered_by', 'counts_json', 'cost_usd', 'tokens_in', 'tokens_out', 'summary', 'error', 'logs_ref'];
  return { rows, calls, prepare(sql) { return { bind(...a) { return {
    async run() { calls.push(sql); if (fail) throw new Error('D1 down');
      if (sql.startsWith('INSERT')) { const r = {}; COLS.forEach((c, i) => r[c] = a[i]); rows.set(r.id, r); return { meta: { changes: 1 } }; }
      if (sql.startsWith('UPDATE')) { const r = rows.get(a[9]); if (!r) return { meta: { changes: 0 } }; Object.assign(r, { ended_at: a[0], status: a[1], counts_json: a[2], cost_usd: a[3], tokens_in: a[4], tokens_out: a[5], summary: a[6], error: a[7], logs_ref: a[8] }); return { meta: { changes: 1 } }; }
      return { meta: {} }; },
    async all() { calls.push(sql); if (fail) throw new Error('D1 down');
      let list = [...rows.values()];
      if (sql.includes('GROUP BY')) { const g = {}; for (const r of list.filter(r => r.started_at >= a[0])) { const k = r.automation_id + '|' + r.status; g[k] = g[k] || { automation_id: r.automation_id, status: r.status, n: 0, last: '' }; g[k].n++; if (r.started_at > g[k].last) g[k].last = r.started_at; } return { results: Object.values(g) }; }
      if (sql.includes('parent_id = ?') && sql.includes('ORDER BY started_at') && !sql.includes('DESC')) return { results: list.filter(r => r.parent_id === a[0]) };
      let i = 0; const where = (sql.match(/WHERE (.*) ORDER/) || [])[1] || '';
      for (const cond of where ? where.split(' AND ') : []) { const v = a[i++]; const [col, op] = cond.split(' '); list = list.filter(r => op === '=' ? r[col] === v : op === '>=' ? r[col] >= v : op === '<=' ? r[col] <= v : r[col] < v); }
      list.sort((x, y) => x.started_at < y.started_at ? 1 : -1);
      return { results: list.slice(0, a[i]) }; },
    async first() { calls.push(sql); if (fail) throw new Error('D1 down'); return rows.get(a[0]) || null; },
  }; } }; } };
}

test('withRun without D1: one KV ring row per finished run, status ok, the audit cron row carries run_id', async () => {
  const env = { RATE: kv() };
  const out = await withRun(env, 'lead_pings', async run => { run.count('sent', 2); return { ok: true, n: 2 }; }, { job: 'drainLeadPings' });
  assert.deepEqual(out, { ok: true, n: 2 });
  const ring = [...env.RATE.m.keys()].filter(k => k.startsWith(RING_PREFIX));
  assert.equal(ring.length, 1);
  const row = JSON.parse(env.RATE.m.get(ring[0]));
  assert.equal(row.automation_id, 'lead_pings'); assert.equal(row.status, 'ok'); assert.equal(JSON.parse(row.counts_json).sent, 2);
  const auditRow = [...env.RATE.m.entries()].find(([k]) => k.startsWith('stream:'));
  assert.ok(auditRow, 'audit.job still wrote its cron row');
  assert.equal(JSON.parse(auditRow[1]).data.run_id, row.id);
});

test('withRun with D1: insert on start, update on end; KV ring untouched', async () => {
  const db = d1(); const env = { RATE: kv(), OPS_DB: db };
  await withRun(env, 'd_pacer', async () => ({ ok: true }));
  assert.equal(db.rows.size, 1);
  const r = [...db.rows.values()][0];
  assert.equal(r.status, 'ok'); assert.ok(r.ended_at);
  assert.equal([...env.RATE.m.keys()].filter(k => k.startsWith(RING_PREFIX)).length, 0);
});

test('D1 throwing never breaks the job: falls back to the KV ring', async () => {
  const env = { RATE: kv(), OPS_DB: d1({ fail: true }) };
  const out = await withRun(env, 'd_pacer', async () => ({ ok: true, sends: 3 }));
  assert.equal(out.sends, 3);
  assert.equal([...env.RATE.m.keys()].filter(k => k.startsWith(RING_PREFIX)).length, 1);
});

test('statuses: failed rethrows, skipped from {skipped}/{paused}/run.skip, partial from ok:false', async () => {
  const env = { RATE: kv() };
  await assert.rejects(withRun(env, 'a', async () => { throw new Error('boom'); }), /boom/);
  await withRun(env, 'b', async () => ({ ok: true, skipped: 'off:b' }));
  await withRun(env, 'c', async run => { run.skip('window'); return { ok: true }; });
  await withRun(env, 'd', async () => ({ ok: false, why: 'x' }));
  const { items } = await listRuns(env, {});
  const st = Object.fromEntries(items.map(r => [r.automation_id, r]));
  assert.equal(st.a.status, 'failed'); assert.match(st.a.error, /boom/);
  assert.equal(st.b.status, 'skipped'); assert.equal(st.b.counts.skip_reason, 'off:b');
  assert.equal(st.c.status, 'skipped'); assert.equal(st.c.counts.skip_reason, 'window');
  assert.equal(st.d.status, 'partial');
  assert.equal(statusOf({ paused: true }), 'skipped');
});

test('children: run.child links parent_id; getRun returns the row + its children (KV and D1)', async () => {
  for (const env of [{ RATE: kv() }, { RATE: kv(), OPS_DB: d1() }]) {
    let pid = '';
    await withRun(env, 'd_pacer', async run => { pid = run.id; await run.child('shir_dispatch', async () => ({ dialed: 1 })); await run.child('doctor', async () => ({ ok: true })); return { ok: true }; });
    const r = await getRun(env, pid);
    assert.equal(r.run.automation_id, 'd_pacer');
    assert.deepEqual(r.children.map(c => c.automation_id).sort(), ['doctor', 'shir_dispatch']);
    assert.ok(r.children.every(c => c.parent_id === pid && c.triggered_by === 'parent:d_pacer'));
  }
});

test('listRuns: filters + cursor paging (KV path), same answer shape as D1', async () => {
  const env = { RATE: kv() };
  for (let i = 0; i < 5; i++) { await withRun(env, i % 2 ? 'x' : 'y', async () => ({ ok: true })); await new Promise(r => setTimeout(r, 3)); }
  const p1 = await listRuns(env, { limit: 2 });
  assert.equal(p1.items.length, 2); assert.ok(p1.next_cursor);
  const p2 = await listRuns(env, { limit: 2, cursor: p1.next_cursor });
  assert.equal(p2.items.length, 2);
  assert.ok(p2.items.every(r => r.started_at < p1.items[1].started_at));
  const ys = await listRuns(env, { automation_id: 'y' });
  assert.equal(ys.items.length, 3);
  const st = await runStats(env, new Date(Date.now() - 3600e3).toISOString());
  assert.equal(st.stats.y.runs_24h, 3); assert.equal(st.stats.x.runs_24h, 2);
});

test('isOff: key present → true; KV error → false (fail open)', async () => {
  assert.equal(await isOff({ RATE: kv({ 'auto:off:d_pacer': '{}' }) }, 'd_pacer'), true);
  assert.equal(await isOff({ RATE: kv() }, 'd_pacer'), false);
  assert.equal(await isOff({ RATE: { get: async () => { throw new Error('kv'); } } }, 'd_pacer'), false);
});
