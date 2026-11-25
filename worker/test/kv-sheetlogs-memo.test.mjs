// node --test worker/test/kv-sheetlogs-memo.test.mjs — 25/11 the KV bill: while the sheet refuses rows, the pending row
// keys (written once, never changed) are not re-read on every tick; a flushed (deleted) row is never written twice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { logRow, logUpdate, flushSheetLogs } from '../sheetlogs.js';

function kv() { const m = new Map(), ghosts = new Set(), n = { get: 0 };
  return { m, ghosts, n, get: async k => { n.get++; return m.has(k) ? m.get(k) : null; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); ghosts.add(k); },
    /* lagLists: a deleted key still shows in the listing for a while, as Cloudflare's list does */
    list: async ({ prefix = '', limit = 1000 } = {}) => ({ keys: [...new Set([...m.keys(), ...(kv.lag ? ghosts : [])])].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name })), list_complete: true }) }; }
let realFetch, sheetUp = false, appended = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (url, init) => {
  let b = {}; try { b = JSON.parse(init && init.body || '{}'); } catch {}
  if (!sheetUp) return new Response('down', { status: 500 });
  const p = b.payload ? JSON.parse(b.payload) : {}; const rq = (p.requests || [])[0] || {};
  if (rq.appendCells) { appended.push(...rq.appendCells.rows); return new Response(JSON.stringify({ replies: [{}] }), { status: 200 }); }
  return new Response(JSON.stringify({ replies: [{}], sheets: [] }), { status: 200 }); }; });
after(() => { globalThis.fetch = realFetch; });

test('pending rows are read once per isolate while the sheet is down; flushed rows are never appended twice', async () => {
  const RATE = kv(); const env = { RATE, BRAIN_HOOK: 'https://hook.test/sheet' };
  const real = Date.now; let t = Date.parse('2026-11-25T17:00:00Z');
  try {
    Date.now = () => t;
    for (let i = 0; i < 40; i++) await logRow(env, 'msg_guests', { id: 'w' + i, phone: '97250000' + i, text: 'הזמנה ' + i });
    for (let i = 0; i < 10; i++) await logUpdate(env, 'msg_guests', 'w' + i, { read: 'נקרא' });
    for (const tab of ['msg_guests', 'msg_clients', 'calls', 'callqueue', 'traffic']) RATE.m.set('slog:sid:' + tab, '7');
    t += 600e3;
    RATE.n.get = 0; await flushSheetLogs(env); const first = RATE.n.get;
    assert.ok(first >= 50, 'first tick reads the rows: ' + first);
    t += 600e3; RATE.n.get = 0; await flushSheetLogs(env);
    assert.ok(RATE.n.get <= 6, 'second tick while the sheet is down: ' + RATE.n.get + ' reads (was ' + first + ')');
    assert.equal(appended.length, 0);
    sheetUp = true; t += 600e3; await flushSheetLogs(env);
    assert.equal(appended.length, 40, 'every row once (updates merged into their rows)');
    assert.equal([...RATE.m.keys()].filter(k => k.startsWith('slog:msg_guests:')).length, 0);
    kv.lag = true; t += 600e3; await flushSheetLogs(env);
    assert.equal(appended.length, 40, 'a listing that still shows the deleted keys appends nothing again');
  } finally { Date.now = real; kv.lag = false; }
});
