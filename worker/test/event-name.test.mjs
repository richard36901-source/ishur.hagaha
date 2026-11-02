import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventDisplayName } from '../index.js';

const ev = []; ev[2] = 'Eleonora'; ev[5] = 'חתונה'; ev[34] = 'הדר ויצחק';

test('guest-facing event name uses the hosts column, never the client name', () => {
  assert.equal(eventDisplayName(ev), 'החתונה של הדר ויצחק');
  assert.equal(eventDisplayName(ev, { article: false }), 'חתונה של הדר ויצחק');
  assert.ok(!eventDisplayName(ev).includes('Eleonora'));
});

test('falls back to the client name only when the hosts column is empty', () => {
  const e2 = []; e2[2] = 'דנה'; e2[5] = 'בר מצווה';
  assert.equal(eventDisplayName(e2), 'הבר מצווה של דנה');
});

test('lint: no lifecycle stage builds evName from ev[2] directly (02/11 incident)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const bad = src.split('\n').filter(l => /const evName = occasion \?/.test(l));
  assert.deepEqual(bad, [], 'use eventDisplayName(ev) instead: ' + bad.join(' | '));
});
