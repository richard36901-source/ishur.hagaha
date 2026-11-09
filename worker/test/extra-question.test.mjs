import test from 'node:test';
import assert from 'node:assert/strict';
import { extraAnswerOf } from '../index.js';

test('extraAnswerOf: buttons map to כן / לא', () => {
  assert.equal(extraAnswerOf('כן 🚌', 'xq:bus:yes'), 'כן');
  assert.equal(extraAnswerOf('לא', 'xq:bus:no'), 'לא');
});
test('extraAnswerOf: bare text answers', () => {
  for (const t of ['כן', 'כן!', 'בטח', 'מעוניינים', 'כן תודה']) assert.equal(extraAnswerOf(t, ''), 'כן', t);
  for (const t of ['לא', 'לא תודה', 'לא צריך']) assert.equal(extraAnswerOf(t, ''), 'לא', t);
});
test('extraAnswerOf: anything else is not an answer (falls through to the normal flow)', () => {
  for (const t of ['אנחנו 4', 'מה השעה?', 'לא מגיעים', '']) assert.equal(extraAnswerOf(t, ''), '', t);
});
