// node --test worker/test/fixes-2026-11-23.test.mjs — 23/11: every tab of an uploaded workbook is read; call rounds that wait
// behind the one dialer are not "stuck"; a rejected template is said once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseGuestFile, guestsFromRows } from '../parse.js';
import { CHECKS } from '../brain.js';

const book = tabs => { const wb = XLSX.utils.book_new(); for (const [name, rows] of tabs) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name); const b = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const HEAD = ['שם', 'מספר טלפון', 'כמות מוזמנים'];

test('upload: a workbook with several tabs gives the guests of ALL tabs (it used to stop after the first)', () => {
  const buf = book([
    ['חברים', [HEAD, ['דנה', '0501111111', 2], ['יוסי', '0502222222', 1]]],
    ['משפחה', [HEAD, ['רותי', '0503333333', 4], ['דנה שוב', '0501111111', 1], ['בלי טלפון טוב', '12345', 1]]],
    ['עבודה', [['אבי', '0504444444', 1]]],   /* a tab with no header row: its first row is a guest */
  ]);
  const { guests, skipped } = guestsFromRows(parseGuestFile('list.xlsx', buf));
  assert.deepEqual(guests.map(g => g.name), ['דנה', 'יוסי', 'רותי', 'אבי']);
  assert.deepEqual(guests.map(g => g.phone), ['972501111111', '972502222222', '972503333333', '972504444444']);
  assert.equal(Number(guests.find(g => g.name === 'רותי').party), 4);
  assert.equal(skipped.length, 2, 'the repeated number and the bad number are reported, not lost');
  assert.ok(skipped.some(x => /כפול/.test(x.why)) && skipped.some(x => /לא תקין/.test(x.why)));
});

test('upload: one tab still reads exactly as before, and an empty second tab changes nothing', () => {
  const one = guestsFromRows(parseGuestFile('a.xlsx', book([['גיליון1', [HEAD, ['דנה', '0501111111', 2]]]])));
  const two = guestsFromRows(parseGuestFile('a.xlsx', book([['גיליון1', [HEAD, ['דנה', '0501111111', 2]]], ['ריק', [[]]]])));
  assert.deepEqual(one.guests, two.guests); assert.equal(one.guests.length, 1); assert.equal(one.skipped.length, 0);
});

function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; }
const TODAY = '2026-11-23', NOW = Date.parse('2026-11-23T08:31:00Z');
const item = (id, done, planned, status) => ({ id, kind: 'call', label_he: 'סבב שיחות של שיר · ' + id, status, done_n: done, planned_n: planned, planned_at: new Date(NOW - 3600e3).toISOString() });
const planOf = items => ({ today: TODAY, days: [{ items }] });

test('brain planned_not_progressing: rounds that wait while another round is being dialled are not stuck; when nothing moves for 30 minutes they are', async () => {
  const chk = CHECKS.find(c => c.id === 'planned_not_progressing');
  const env = { RATE: kv() };
  const d = { sendWindowState: () => ({ open: true }), callWindowState: () => ({ open: true }), sendingPaused: async () => false };
  const run = async (at, items) => { env.RATE.m.set('plan:today', JSON.stringify({ at, data: planOf(items) })); return chk.run({ env, d, now: at, today: TODAY, log: () => {} }); };
  assert.deepEqual(await run(NOW, [item('a', 0, 100, 'in_progress'), item('b', 0, 234, 'waiting'), item('c', 0, 296, 'waiting')]), []);
  /* 31 minutes later: a moved 10 → 20 → 30, b and c still 0 */
  await run(NOW + 10 * 60e3, [item('a', 10, 100, 'in_progress'), item('b', 0, 234, 'waiting'), item('c', 0, 296, 'waiting')]);
  await run(NOW + 20 * 60e3, [item('a', 20, 100, 'in_progress'), item('b', 0, 234, 'waiting'), item('c', 0, 296, 'waiting')]);
  const f = await run(NOW + 31 * 60e3, [item('a', 30, 100, 'in_progress'), item('b', 0, 234, 'waiting'), item('c', 0, 296, 'waiting')]);
  assert.deepEqual(f, [], 'b and c wait for their turn');
  /* the dialer stops: nobody moves for 30 minutes → all three are reported */
  const g = await run(NOW + 62 * 60e3, [item('a', 30, 100, 'in_progress'), item('b', 0, 234, 'waiting'), item('c', 0, 296, 'waiting')]);
  assert.deepEqual(g.map(x => x.data.item_id).sort(), ['a', 'b', 'c']);
});

test('23/11 call pace: a calls-only cron on the 5s, wired to the calls part, batch size untouched', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(/^crons = \[[^\]]*"5,15,25,35,45,55 \* \* \* \*"/m.test(toml), 'the cron is in wrangler.toml');
  const i = src.indexOf("startsWith('5,15,25')");
  assert.ok(i > 0);
  const block = src.slice(i, src.indexOf('return;', i));
  assert.ok(block.includes("part: 'calls'") && !block.includes("part: 'main'"), 'calls only');
  assert.ok(src.indexOf("startsWith('5,15,25')") < src.indexOf("startsWith('5-55/10')"), 'checked before the plan tick');
  assert.ok(/Number\(env\.CALL_PARALLEL\) \|\| 10/.test(src), '10 at a time stays');
});
