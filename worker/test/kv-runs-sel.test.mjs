// node --test worker/test/kv-runs-sel.test.mjs — 25/11 the KV bill: the brain reads only brain_* run rows from the ring
// (it read the newest 200 of every automation on each tick and threw most away). Same rows, same order, same cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRun, listRuns } from '../ops-run.js';

function kv() {
  const m = new Map(), md = new Map(), n = { get: 0 };
  return { m, md, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; }, put: async (k, v, o) => { m.set(k, String(v)); if (o && o.metadata) md.set(k, o.metadata); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(); const s = Number(cursor) || 0; const keys = all.slice(s, s + limit).map(name => ({ name, metadata: md.get(name) || null })); const done = s + limit >= all.length; return { keys, list_complete: done, ...(done ? {} : { cursor: String(s + limit) }) }; } };
}
test('listRuns with sel: the brain_* rows among the newest N are exactly the ones the full read gave; other rows are not read', async () => {
  const RATE = kv(); const env = { RATE }; const real = Date.now; let t = Date.parse('2026-11-25T08:00:00Z');
  try {
    Date.now = () => t;
    const ids = ['runPacer', 'brain_health', 'notify', 'brain_fix:x', 'calendar_build', 'auditMeta', 'brain_fix:y'];
    for (let i = 0; i < 700; i++) { t += 7000; await withRun(env, ids[(i * 5) % 7 === 0 ? 1 : i % 7], async () => ({ ok: true })); }
    /* a row written without metadata (older writer): it is read and decided after reading, as before */
    const legacy = [...RATE.m.keys()].find(k => k.startsWith('opsrun:')); RATE.md.delete(legacy);
    t += 60e3;
    for (const f of [{ from: new Date(t - 7 * 86400e3).toISOString(), limit: 200 }, { from: new Date(t - 3600e3).toISOString(), limit: 50 }, { limit: 200, cursor: new Date(t - 3000e3).toISOString() }]) {
      RATE.n.get = 0; const full = (await listRuns(env, f)).items.filter(r => /^brain_/.test(r.automation_id)); const g1 = RATE.n.get;
      RATE.n.get = 0; const sel = (await listRuns(env, f, { sel: m => /^brain_/.test(String(m.a || '')) })).items.filter(r => /^brain_/.test(r.automation_id)); const g2 = RATE.n.get;
      assert.deepEqual(sel, full, JSON.stringify(f));
      assert.ok(full.length > 0);
      assert.ok(g2 <= Math.ceil(g1 * 0.65), `${JSON.stringify(f)}: ${g2} reads with sel, ${g1} without (brain rows are ~57% of this ring; ~10% in production)`);
    }
  } finally { Date.now = real; }
});
