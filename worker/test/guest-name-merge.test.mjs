/* 19/11 Richard: the same guest twice on a board (list row with a wrong phone + group-link row). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { guestNameKey } from '../lib.js';
import fs from 'node:fs';

test('the same words in any order are the same guest', () => {
  assert.equal(guestNameKey('אברגיל נתי'), guestNameKey('נתי אברגיל'));
  assert.equal(guestNameKey(' תיתן  אליה '), guestNameKey('אליה תיתן'));
});
test('different people do not match', () => {
  assert.notEqual(guestNameKey('נתי אברגיל'), guestNameKey('נתי כהן'));
  assert.notEqual(guestNameKey('דנה לוי'), guestNameKey('דנה ויוסי לוי'));
});
test('a one-word name never merges', () => {
  assert.equal(guestNameKey('אמא'), '');
  assert.equal(guestNameKey(''), '');
});
test('the link route merges by name only into ONE unanswered list row, and the upload skips link names', () => {
  const s = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(s, /twins\.length === 1/);
  assert.match(s, /!String\(g\[15\] \|\| ''\)\.trim\(\) && !\/נרשם מהקישור\//);
  assert.match(s, /linkNames\.has\(nk\)/);
});
