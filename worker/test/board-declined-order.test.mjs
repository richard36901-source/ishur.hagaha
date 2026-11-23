// node --test worker/test/board-declined-order.test.mjs — 23/11 Shalev: on the "לא מגיעים" tab whoever pressed last is on top
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const a = html.indexOf("if (filter === 'confirmed' || filter === 'declined') list =");
const endMark = '}).map(function (x) { return x.g; });';
const b = html.indexOf(endMark, a);
assert.ok(a > 0 && b > a, 'the board sort block is in dashboard.html');
const order = new Function('filter', 'list', html.slice(a, b + endMark.length) + '\nreturn list;');
const G = (name, status, at_ts) => ({ name, status, at_ts });
const names = l => l.map(g => g.name).join(',');

test('"לא מגיעים": the newest press first, down to the oldest', () => {
  const list = [G('a', 'declined', '2026-11-20T10:00:00'), G('b', 'declined', '2026-11-23T13:00:00'), G('c', 'declined', '2026-11-22T09:30:00')];
  assert.equal(names(order('declined', list)), 'b,c,a');
});
test('the same time keeps the upload order; a row with no time goes last', () => {
  const list = [G('a', 'declined', ''), G('b', 'declined', '2026-11-23T13:00:00'), G('c', 'declined', '2026-11-23T13:00:00')];
  assert.equal(names(order('declined', list)), 'b,c,a');
});
test('"אישרו" still sorts the same way, every other tab keeps the upload order', () => {
  const list = [G('a', 'confirmed', '2026-11-20T10:00:00'), G('b', 'confirmed', '2026-11-23T13:00:00')];
  assert.equal(names(order('confirmed', list)), 'b,a');
  assert.equal(names(order('all', list)), 'a,b');
  assert.equal(names(order('pending', list)), 'a,b');
});
