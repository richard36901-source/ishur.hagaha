import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extraSendWave } from '../index.js';

const W3 = { key: 3, col: 41, onlyUnanswered: false };
test('an extra send bought for the unanswered goes only to them and the undecided (Richard 25/11)', () => {
  assert.equal(extraSendWave(W3, JSON.stringify({ at: 'x', scope: 'unanswered' })).onlyUnanswered, true);
  assert.equal(extraSendWave(W3, JSON.stringify({ at: 'x', scope: 'all' })).onlyUnanswered, false);
  assert.equal(extraSendWave(W3, '2026-11-25T16:44:46.993Z').onlyUnanswered, false, 'the old plain-date value = everybody, as before');
  assert.equal(extraSendWave(W3, null).onlyUnanswered, false);
  assert.equal(W3.onlyUnanswered, false, 'the shared wave table is not changed');
});
test('the scheduler hands wave 3 through extraSendWave', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /const waveUse = wave\.key === 3 \? extraSendWave\(wave,/);
  assert.match(src, /sendWave\(env, ev, token, guests, waveUse, dry, wb\)/);
});
