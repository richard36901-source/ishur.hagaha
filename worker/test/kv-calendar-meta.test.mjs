// node --test worker/test/kv-calendar-meta.test.mjs — 25/11 the KV bill: the calendar's live days come from the log
// listing's metadata (written with every log entry), not one read per message; what the calendar shows is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLogValues, putLog, logMeta, listLogKeys } from '../calendar-log.js';

function kv() {
  const m = new Map(), md = new Map(), n = { get: 0, list: 0, put: 0 };
  return { m, md, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; },
    put: async (k, v, o = {}) => { n.put++; m.set(k, String(v)); if (o && o.metadata) md.set(k, o.metadata); else md.delete(k); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { n.list++; const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(); const s = Number(cursor) || 0; const keys = all.slice(s, s + limit).map(name => ({ name, ...(md.has(name) ? { metadata: md.get(name) } : {}) })); const done = s + limit >= all.length; return { keys, list_complete: done, ...(done ? {} : { cursor: String(s + limit) }) }; } };
}
const now = Date.parse('2026-11-25T18:00:00Z');
/* what buildCalendarMonth takes from a value (index.js) */
const shown = (names, vals) => names.map((n, i) => { let v = null; try { v = JSON.parse(vals[i]); } catch {} return v && v.dir === 'out' ? [n, v.at, v.tok, v.ch, v.tmpl, v.type, v.ok, v.status, v.error, String(v.text || '').slice(0, 120)] : null; });

test('logMeta: outgoing → the calendar fields; anything else → {c:0}; too big for 1 KB → none (read as before)', () => {
  const out = { dir: 'out', type: 'template', text: 'ש'.repeat(900), ok: true, error: '', ch: 'guests', id: 'wamid.X', status: 'sent', tmpl: 'hazmana_ishur', tok: 'c1c5fcf5', at: '2026-11-25T10:00:00.000Z', params: ['a', 'b'], buttons: [{ t: 1 }] };
  const m = logMeta(out);
  assert.deepEqual(Object.keys(m.c).sort(), ['at', 'ch', 'dir', 'error', 'ok', 'status', 'text', 'tmpl', 'tok', 'type']);
  assert.equal(m.c.text.length, 120); assert.equal(m.c.params, undefined);
  assert.deepEqual(logMeta({ dir: 'in', text: 'hi' }), { c: 0 });
  assert.equal(logMeta({ ...out, error: 'x'.repeat(2000) }), undefined);
});

test('live days: answered from metadata with zero reads; shows exactly what the record-by-record read shows; old entries and a status update stay correct', async () => {
  const RATE = kv(); const env = { RATE };
  const day = (d, h) => Date.parse(`2026-11-${d}T${h}:00:00Z`);
  const recs = [];
  for (let i = 0; i < 60; i++) {
    const ts = day(i % 2 ? '25' : '24', String(8 + (i % 9)).padStart(2, '0')) + i;
    const key = `log:9725000${String(i).padStart(5, '0')}:${ts}`;
    const rec = i % 5 === 0 ? { dir: 'in', type: 'text', text: 'שלום ' + i, ch: 'guests', at: new Date(ts).toISOString() }
      : { dir: 'out', type: 'template', text: 'הזמנה ' + 'א'.repeat(i * 3), ok: i % 7 !== 0, error: i % 7 ? '' : '131049 x', ch: 'guests', id: 'w' + i, status: 'sent', tmpl: 't' + (i % 3), tok: 'abcd1234', at: new Date(ts).toISOString(), params: ['x'] };
    recs.push([key, rec]); await putLog(env, key, rec);
  }
  /* two entries written before metadata existed */
  RATE.m.set('log:972500099999:' + day('25', '09'), JSON.stringify({ dir: 'out', tmpl: 'old', status: 'delivered', ok: true, text: 'ישן' }));
  RATE.m.set('log:972500099998:' + day('25', '09'), JSON.stringify({ dir: 'in', text: 'old in' }));
  /* a status update rewrites the entry the way the webhook does (value + metadata) */
  const [lk, cur] = recs[3]; const up = { ...cur, status: 'read', status_at: 1 }; const m = logMeta(up); await RATE.put(lk, JSON.stringify(up), m ? { metadata: m } : undefined);

  const { names, meta } = await listLogKeys(env);
  assert.equal(names.length, 62);
  const ref = await readLogValues(env, names, { now });               /* the old way: one read per entry */
  RATE.n.get = 0;
  const neu = await readLogValues(env, names, { now, meta });
  assert.deepEqual(shown(names, neu.vals), shown(names, ref.vals), 'the calendar shows the same rows, fields and statuses');
  assert.equal(RATE.n.get, 2, 'only the two entries without metadata were read');
  assert.equal(neu.stats.from_meta, 60);
  assert.equal(JSON.parse(neu.vals[names.indexOf(lk)]).status, 'read', 'the updated status is what the metadata says');
});
