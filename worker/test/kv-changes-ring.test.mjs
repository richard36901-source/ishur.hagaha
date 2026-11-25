// node --test worker/test/kv-changes-ring.test.mjs — 25/11 the KV bill: "changes since the last tick" reads only the keys
// whose name (time) and metadata (kind) can match, instead of the whole ring every ten minutes. Same answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordChange, listChanges, KINDS } from '../changes.js';

function kv() {
  const m = new Map(), md = new Map(), n = { get: 0 };
  return { m, md, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; }, put: async (k, v, o) => { m.set(k, String(v)); if (o && o.metadata) md.set(k, o.metadata); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: md.get(name) || null })), list_complete: true }) };
}
test('listChanges: same items for from / before / to / kind filters; reads only what can match', async () => {
  const RATE = kv(); const env = { RATE }; const kinds = Object.keys(KINDS); const t0 = Date.parse('2026-11-01T08:00:00Z');
  for (let i = 0; i < 300; i++) await recordChange(env, { kind: kinds[i % kinds.length], who: 'admin', summary_he: 'שינוי ' + i }, t0 + i * 3 * 3600e3);
  const all = [...RATE.m.values()].map(v => JSON.parse(v));
  const ref = f => all.filter(r => (!f.kind || f.kind.split(',').includes(r.kind)) && (!f.from || r.at >= f.from) && (!f.to || r.at <= f.to) && (!f.before || r.at < f.before)).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, f.limit || 100).map(r => r.id);
  const cases = [{ from: new Date(t0 + 290 * 3 * 3600e3 + 1).toISOString(), limit: 200 }, { kind: kinds[1] }, { kind: kinds[0] + ',' + kinds[2], from: new Date(t0 + 100 * 3 * 3600e3).toISOString() },
    { cursor: new Date(t0 + 50 * 3 * 3600e3).toISOString() }, { to: new Date(t0 + 20 * 3 * 3600e3).toISOString(), limit: 200 }, {}];
  for (const f of cases) {
    RATE.n.get = 0;
    const r = await listChanges(env, f);
    assert.deepEqual(r.items.map(x => x.id), ref({ ...f, before: f.cursor }), JSON.stringify(f));
    if (f.from && !f.kind) assert.ok(RATE.n.get <= 10, `since the last tick: ${RATE.n.get} reads (was 300)`);
  }
});
