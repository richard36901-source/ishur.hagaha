import test from 'node:test';
import assert from 'node:assert/strict';
import { waveRestOf } from '../index.js';

const g = (name, phone, rsvp = '') => { const r = new Array(29).fill(''); r[3] = name; r[4] = phone; r[15] = rsvp; return r; };

test('wave-rest: only guests never reached and never answered', () => {
  const guests = [g('א', '0501111111'), g('ב', '0502222222'), g('ג', '0503333333', 'מגיע'), g('ד', '0504444444'), g('ה', ''), g('א כפול', '050-1111111')];
  const rest = waveRestOf(guests, new Set(['972502222222']), new Set(['972504444444']));
  assert.deepEqual(rest, [{ name: 'א', phone: '972501111111' }]);
});
test('wave-rest: everyone reached → nothing to send', () => {
  assert.deepEqual(waveRestOf([g('א', '0501111111')], new Set(['972501111111']), new Set()), []);
});
test('wave-rest: a declined or undecided guest is not re-invited', () => {
  assert.deepEqual(waveRestOf([g('א', '0501111111', 'לא מגיע'), g('ב', '0502222222', 'מתלבט')], new Set(), new Set()), []);
});
