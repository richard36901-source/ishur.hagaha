/* 24/11/2026: a guest who was removed keeps the row and its id. New guests were numbered "live rows + 1", so a list
   of 357 live rows whose ids reach 358 (one removed in the middle) would have received a second 358. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { nextGuestSeq } from '../parse.js';

const T = '36bd2cda-0000-4000-8000-000000000000', T8 = T.slice(0, 8);
const row = (id, ac) => { const r = new Array(29).fill(''); r[2] = id; r[28] = ac; return r; };

test('a removed guest in the middle: the next id is past the highest, never a repeat', () => {
  const rows = [];
  for (let i = 1; i <= 358; i++) rows.push(row(`G-${T8}-${i}`, i === 13 ? 'removed-req:' + T8 : T));
  const live = rows.filter(r => r[28] === T);
  assert.equal(live.length, 357);
  const next = nextGuestSeq(rows, T8);
  assert.equal(next, 359);
  const ids = new Set(live.map(r => r[2]));
  for (let i = 0; i < 119; i++) { const id = `G-${T8}-${next + i}`; assert.ok(!ids.has(id), id + ' is already taken'); ids.add(id); }
  assert.equal(ids.size, 357 + 119);
});

test('nothing removed: numbering continues exactly as before (rows + 1)', () => {
  const rows = []; for (let i = 1; i <= 40; i++) rows.push(row(`G-${T8}-${i}`, T));
  assert.equal(nextGuestSeq(rows, T8), 41);
  assert.equal(nextGuestSeq([], T8), 1);
  assert.equal(nextGuestSeq(null, T8), 1);
});

test('other events and link registrations do not move the counter', () => {
  const rows = [row(`G-${T8}-1`, T), row(`G-${T8}-2`, T), row('G-aaaaaaaa-900', 'aaaaaaaa-x'), row(`G-${T8}-L7`, T), row(`G-${T8}-77x`, T)];
  assert.equal(nextGuestSeq(rows, T8), 3);
  assert.equal(nextGuestSeq(rows, T8, 'L'), 8);
});

test('a first or replacing upload starts after ids that removed guests still hold', () => {
  const sheet = [row(`G-${T8}-13`, 'removed-req:' + T8), row(`G-${T8}-1`, T), row(`G-${T8}-2`, T)];
  const left = sheet.filter(g => g[28] !== T);          /* what handleGuestFile counts when it is not a merge */
  assert.equal(nextGuestSeq(left, T8), 14);
});

test('no place in the Worker numbers a guest from the count of live rows any more', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(!/row\[2\] = 'G-' \+ token\.slice\(0, 8\) \+ '-' \+ \(existingRows \+ i \+ 1\)/.test(src));
  assert.ok(!/row\[2\] = 'G-' \+ tok\.slice\(0, 8\) \+ '-' \+ \(gRows\.length \+ 1\)/.test(src));
  assert.ok(!/row\[2\] = 'G-' \+ token\.slice\(0, 8\) \+ '-' \+ \(i \+ 1\)/.test(src));
  assert.equal((src.match(/nextGuestSeq\(/g) || []).length, 4);
});
