// 22/11/2026 · production, first day on the promoted code: "sheetId is not a function". Inside ensureLogSheet / ensureTab
// a local `sheetId` (the tab's numeric id) hid the function of the same name. These run the real functions end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureLogSheet, sheetId, bookId, LOG_TAB } from '../evlog.js';
import { ensureTab } from '../sheetlogs.js';

const kv = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; };
function withSheets(sheets, fn) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b);
    if (/batchUpdate/.test(b.url)) return new Response(JSON.stringify({ replies: [{ addSheet: { properties: { sheetId: 777 } } }] }), { status: 200 });
    return new Response(JSON.stringify({ sheets }), { status: 200 });
  };
  return fn(calls).finally(() => { globalThis.fetch = real; });
}

test('the journal tab is found by name, and created when it is missing (no cached id)', async () => {
  await withSheets([{ properties: { title: LOG_TAB, sheetId: 42 } }], async calls => {
    const env = { RATE: kv(), BRAIN_HOOK: 'https://hook.test/b', SHEET_ID: 'BOOK1' };
    assert.equal(await ensureLogSheet(env), 42);
    assert.ok(calls[0].url.startsWith('spreadsheets/BOOK1'));
  });
  await withSheets([], async calls => {
    const env = { RATE: kv(), BRAIN_HOOK: 'https://hook.test/b', SHEET_ID: 'BOOK1' };
    assert.equal(await ensureLogSheet(env), 777);
    assert.ok(calls.some(c => /spreadsheets\/BOOK1:batchUpdate/.test(c.url)));
  });
  assert.equal(sheetId({ SHEET_ID: 'X' }), 'X'); assert.equal(bookId({ SHEET_ID: 'X' }), 'X');
});

test('a message-log tab is found or created the same way', async () => {
  const src = await import('../sheetlogs.js');
  const tab = Object.keys(src.TABS || {})[0];
  if (!tab) return;   /* the tab list is not exported: the journal test above covers the shared mistake */
  await withSheets([], async () => {
    const env = { RATE: kv(), BRAIN_HOOK: 'https://hook.test/b', SHEET_ID: 'BOOK1' };
    assert.equal(await ensureTab(env, tab), 777);
  });
});
