import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStaff, ackText } from '../staff.js';

test('a hostess line becomes arrive / chuppah / leave, with her own time when she wrote one', () => {
  assert.deepEqual(parseStaff('הגעתי'), { kind: 'arrive', time: '' });
  assert.deepEqual(parseStaff('הגעתי 18:20'), { kind: 'arrive', time: '18:20' });
  assert.deepEqual(parseStaff('חופה ב 20.45'), { kind: 'chuppah', time: '20:45' });
  assert.deepEqual(parseStaff('סיימתי, עזבתי'), { kind: 'leave', time: '' });
  assert.equal(parseStaff('יש בעיה עם הרשימה').kind, 'note');
  assert.equal(parseStaff('   '), null);
});
test('the answer she gets states what was recorded and when', () => {
  assert.equal(ackText('דנה', { kind: 'arrive', time: '' }, '18:22', 'מור ונועם'), 'הגעה נרשמה ✓ 18:22 · מור ונועם');
  assert.ok(ackText('דנה', { kind: 'note', time: '' }, '18:22', '').includes('הגעתי / חופה / עזבתי'));
});
