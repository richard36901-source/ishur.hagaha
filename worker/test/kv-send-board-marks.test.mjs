// node --test worker/test/kv-send-board-marks.test.mjs — 25/11 the KV bill: a send-board build reads only the per-guest
// marker keys that exist (one listing per event + kind + wave), not four reads per guest and due type. Same board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendBoardData } from '../send-board.js';

const T1 = 'aaaa1111-0000-4000-8000-000000000001', T2 = 'bbbb2222-0000-4000-8000-000000000002';
function raw() {
  const ev = (t, date) => { const e = Array(50).fill(''); e[1] = t; e[2] = 'לקוח'; e[5] = 'חתונה'; e[6] = date; e[7] = 'כן'; e[43] = 'כן'; e[34] = 'אירוע ' + t.slice(0, 4); e[39] = '2026-11-20'; e[40] = '2026-11-23'; e[41] = ''; return e; };
  const guests = []; for (const t of [T1, T2]) for (let i = 0; i < 60; i++) { const g = Array(31).fill(''); g[28] = t; g[2] = 'G' + i; g[3] = 'אורח ' + i; g[4] = '05' + (t === T1 ? '2' : '3') + '000' + String(i).padStart(4, '0'); g[15] = i % 4 === 0 ? 'מגיע' : i % 4 === 1 ? 'לא מגיע' : ''; g[30] = i % 4 === 0 ? String(i) : ''; guests.push(g); }
  return { events: { values: [ev(T1, '2026-11-26'), ev(T2, '2026-11-24')] }, guests: { values: guests } };
}
function kv(listOk) {
  const m = new Map(); const n = { get: 0, list: 0 };
  const ph = (t, i) => '9725' + (t === T1 ? '2' : '3') + '000' + String(i).padStart(4, '0');
  for (const t of [T1, T2]) for (let i = 0; i < 60; i++) {
    if (i % 3 === 0) m.set(`wsent:${t}:1:${ph(t, i)}`, '1');
    if (i % 3 === 0 && i % 2) m.set(`wst:${t}:1:${ph(t, i)}`, i % 5 ? 'delivered' : 'read');
    if (i % 7 === 0) m.set(`wferr:${t}:1:${ph(t, i)}`, '131049');
    if (i === 14) m.set(`wdead:${t}:1:${ph(t, i)}`, '1');
    if (i % 5 === 0) m.set(`wsent:${t}:2:${ph(t, i)}`, i === 10 ? 'skip' : '1');
    if (t === T2 && i % 4 === 0) m.set(`s5d:${t}:${ph(t, i)}`, '1');
  }
  return { m, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; }, put: async (k, v) => { m.set(k, String(v)); },
    list: async ({ prefix = '' } = {}) => { n.list++; if (!listOk) throw new Error('list down'); return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }; } };
}
const deps = { snapshotCached: async () => raw(), auditQuery: async () => [], isTestEventRow: () => false, planKeyOf: () => 'premium', ilDate: () => '2026-11-25',
  sendWindowState: () => ({ open: true }), sendingPaused: async () => false, kvPrefix: async () => ({}), guestPhoneIds: () => ['A'], normPhone: x => x };

test('send board: identical with the listing as with a read per key; reads only the markers that exist', async () => {
  const old = kv(false), neu = kv(true);
  const a = await sendBoardData({ RATE: old }, deps, { force: true, days: 3 });
  const b = await sendBoardData({ RATE: neu }, deps, { force: true, days: 3 });
  const strip = x => JSON.parse(JSON.stringify(x, (k, v) => (k === 'generated_at' || k === 'now' || k === 'at' ? undefined : v)));
  assert.deepEqual(strip(b), strip(a));
  assert.ok(a.events.length === 2 && a.events.some(e => e.types.some(t => t.sent > 0)), 'the fixture produces a real board');
  const markerKeys = [...neu.m.keys()].filter(k => /^(wsent|wst|wferr|wdead|s5d):/.test(k)).length;
  assert.ok(neu.n.get <= markerKeys + 30, `reads ${neu.n.get} (markers that exist: ${markerKeys}); the per-key path read ${old.n.get}`);
  assert.ok(old.n.get > 3 * neu.n.get);
});
