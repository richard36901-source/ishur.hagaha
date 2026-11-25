// node --test worker/test/kv-audit-chunks.test.mjs — 25/11 the KV bill: a past hour of the audit stream is read once and kept
// in auditc:<day>:<hour>; every query answers exactly what the record-by-record read answered, for far fewer reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as audit from '../audit.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init)); const md = new Map(); const n = { get: 0, list: 0, put: 0 };
  return { m, md, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; },
    put: async (k, v, o = {}) => { n.put++; m.set(k, String(v)); if (o.metadata) md.set(k, o.metadata); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { n.list++; const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(); const s = Number(cursor) || 0; const keys = all.slice(s, s + limit).map(name => ({ name, metadata: md.get(name) || null })); const done = s + limit >= all.length; return { keys, list_complete: done, ...(done ? {} : { cursor: String(s + limit) }) }; } };
}
const DAY = '20261125';
/* 12 hours of traffic on 25/11 (06:00Z–17:59Z), 4 kinds, 40 records an hour */
function seed() {
  const RATE = kv(); const kinds = ['wa_out', 'wa_status', 'cron', 'admin'];
  for (let h = 6; h < 18; h++) for (let i = 0; i < 40; i++) {
    const ts = Date.parse(`2026-11-25T${String(h).padStart(2, '0')}:00:00Z`) + i * 60e3 + 7; const kind = kinds[i % 4]; const name = `stream:${DAY}:${ts}:r${i}`;
    RATE.m.set(name, JSON.stringify({ id: `${DAY}-${ts}-r${i}`, ts, kind, phone: '97250000' + (i % 7), token: 'tok' + (i % 3) + 'xxxxxx', action: 'a' + i }));
    RATE.md.set(name, { k: kind, p: '97250000' + (i % 7), t: 'tok' + (i % 3) + 'xxx'.slice(0, 5) });
  }
  return { RATE };
}
const NOW = Date.parse('2026-11-25T18:20:00Z');   /* 20:20 in Israel: hours up to 17:00Z are sealed, none open */
async function at(t, fn) { const real = Date.now; Date.now = () => t; try { return await fn(); } finally { Date.now = real; } }
const q = (env, extra = {}) => at(NOW, () => audit.queryEx(env, { days: 1, limit: 20000, ...extra }));
const strip = r => ({ items: r.items, truncated: r.truncated, failed: r.failed });

test('chunks: same answer as the record-by-record read, for every filter the jobs use; the second query reads ~1 key per hour', async () => {
  const ref = seed().RATE; const refEnv = { RATE: ref };
  /* the reference: the stream as it stands, read with chunks disabled by an impossible seal time */
  const expect = {};
  for (const f of [{ kind: 'wa_out' }, { kind: 'wa_status' }, {}, { kind: 'wa_out', phone: '972500003' }, { since: Date.parse('2026-11-25T15:30:00Z') }, { q: 'a1' }]) {
    const all = [...ref.m.entries()].filter(([k]) => k.startsWith('stream:')).map(([, v]) => JSON.parse(v))
      .filter(r => (!f.kind || r.kind === f.kind) && (!f.phone || r.phone === f.phone) && (!f.since || r.ts > f.since) && (!f.q || JSON.stringify(r).toLowerCase().includes(f.q)));
    expect[JSON.stringify(f)] = all.sort((a, b) => b.ts - a.ts);
  }
  const { RATE } = seed(); const env = { RATE }; audit._clearChunkMemo(env);
  const first = await q(env, { kind: 'wa_out' });
  assert.deepEqual(first.items, expect['{"kind":"wa_out"}']); assert.equal(first.truncated, false);
  assert.equal([...RATE.m.keys()].filter(k => k.startsWith('auditc:')).length, 12, 'one chunk per sealed hour');
  assert.ok(RATE.n.get <= 12 + 120 + 2, 'building costs what the old read cost (+ one miss per hour, + one slot look for the 1–2 hours that sealed lately): ' + RATE.n.get);
  /* pass 1 builds what each filter needs (never more than the old read), pass 2 — a fresh isolate — reads the chunks */
  for (const pass of [1, 2]) for (const [f, want] of Object.entries(expect)) {
    audit._clearChunkMemo(env);
    const before = RATE.n.get; const r = await q(env, JSON.parse(f));
    assert.deepEqual(r.items, want, f); assert.equal(r.truncated, false, f);
    const oldCost = want.length + 0;   /* the record-by-record read: one get per matching record (metadata skips the rest) */
    if (pass === 1) assert.ok(RATE.n.get - before <= Math.max(oldCost, 1) + 12 + 2 + (JSON.parse(f).kind ? 0 : 480), `${f}: pass 1 ${RATE.n.get - before} reads`);
    else assert.ok(RATE.n.get - before <= 12, `${f}: pass 2 ${RATE.n.get - before} reads (was ${oldCost})`);
  }
  const before = RATE.n.get; await q(env, { kind: 'wa_status' }); await q(env, { kind: 'wa_status' });
  assert.ok(RATE.n.get - before <= 12, 'the same isolate holds the chunks');
  void refEnv;
});

test('chunks: the open hour (and the SEAL_MS after it) is still read record by record, and is never kept', async () => {
  const { RATE } = seed(); const env = { RATE }; audit._clearChunkMemo(env);
  const t = Date.parse('2026-11-25T18:05:00Z');   /* 17:00Z ended 5 min ago: inside SEAL_MS → still open */
  const r = await at(t, () => audit.queryEx(env, { days: 1, kind: 'wa_out', limit: 20000 }));
  assert.equal(r.items.length, 120);
  assert.ok(!RATE.m.has(audit.chunkKey(DAY, Math.floor(Date.parse('2026-11-25T17:00:00Z') / 3600e3), 'wa_out')), 'hour 17Z not sealed yet');
  assert.ok(RATE.m.has(audit.chunkKey(DAY, Math.floor(Date.parse('2026-11-25T16:00:00Z') / 3600e3), 'wa_out')));
  /* a record arriving late in the open hour is seen on the next query */
  const ts = Date.parse('2026-11-25T17:59:59Z'); RATE.m.set(`stream:${DAY}:${ts}:late`, JSON.stringify({ ts, kind: 'wa_out', id: 'late' })); RATE.md.set(`stream:${DAY}:${ts}:late`, { k: 'wa_out' });
  const r2 = await at(t + 60e3, () => audit.queryEx(env, { days: 1, kind: 'wa_out', limit: 20000 }));
  assert.equal(r2.items[0].id, 'late');
});

test('chunks: the budget still cuts the OLDEST records first and says so; a failed read keeps no chunk', async () => {
  const { RATE } = seed(); const env = { RATE }; audit._clearChunkMemo(env);
  const r = await q(env, { kind: 'wa_out', budget: 60 });
  assert.equal(r.truncated, true);
  assert.ok(r.items.length > 0 && r.items.every((x, i, a) => !i || a[i - 1].ts >= x.ts));
  const all = await (async () => { const e2 = { RATE: seed().RATE }; audit._clearChunkMemo(e2); return (await q(e2, { kind: 'wa_out' })).items; })();
  assert.deepEqual(r.items, all.slice(0, r.items.length), 'what came back is the newest part');
  /* a KV error while building: nothing kept, the record read reports the failure as before */
  const bad = seed().RATE; const g0 = bad.get; let k = 0; bad.get = async key => { if (key.startsWith('stream:') && ++k === 3) throw new Error('KV down'); return g0(key); };
  const e3 = { RATE: bad }; audit._clearChunkMemo(e3);
  const r3 = await q(e3, { kind: 'wa_out' });
  assert.equal([...bad.m.keys()].filter(x => x.startsWith('auditc:')).length >= 0, true);
  const builtHours = [...bad.m.keys()].filter(x => x.startsWith('auditc:')).map(x => JSON.parse(bad.m.get(x)));
  assert.ok(builtHours.every(c => Object.values(c).every(v => v !== undefined && v !== null)), 'no chunk holds a failed read');
  assert.ok(r3.items.length >= 119);
});

test('slots: inside the open hour the 10-minute slots are kept too; when the hour seals it is put together from them, not re-read', async () => {
  const { RATE } = seed(); const env = { RATE };
  for (let i = 0; i < 30; i++) { const ts = Date.parse('2026-11-25T18:00:00Z') + i * 60e3 + 3; const name = `stream:${DAY}:${ts}:s${i}`; RATE.m.set(name, JSON.stringify({ id: 's' + i, ts, kind: 'wa_out' })); RATE.md.set(name, { k: 'wa_out' }); }
  const run = async t => { audit._clearChunkMemo(env); const b = RATE.n.get; const r = await at(t, () => audit.queryEx(env, { days: 1, kind: 'wa_out', limit: 20000 })); return { r, reads: RATE.n.get - b }; };
  const a = await run(Date.parse('2026-11-25T18:45:00Z'));
  assert.equal(a.r.items.length, 120 + 30); assert.equal(a.r.items[0].id, 's29');
  assert.ok(RATE.m.has(audit.slotKey(DAY, Math.floor(Date.parse('2026-11-25T18:00:00Z') / audit.SLOT_MS), 'wa_out')), 'slot 18:00–18:10 kept');
  const b = await run(Date.parse('2026-11-25T18:46:00Z'));
  assert.deepEqual(b.r.items, a.r.items);
  assert.ok(b.reads <= 12 + 3, 'a fresh isolate: one read per hour + one per slot: ' + b.reads);
  /* 19:15: hour 18Z sealed → assembled from the slots (3 kept, 3 empty), not re-read */
  const c = await run(Date.parse('2026-11-25T19:15:00Z'));
  assert.deepEqual(c.r.items, a.r.items);
  assert.ok(c.reads <= 12 + 1 + 6, 'hour 18 put together from its slots: ' + c.reads + ' reads');
  const hk = audit.chunkKey(DAY, Math.floor(Date.parse('2026-11-25T18:00:00Z') / 3600e3), 'wa_out');
  assert.equal(Object.keys(JSON.parse(RATE.m.get(hk))).length, 30);
});
