import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { retryDayAllowed } from '../eventday.js';

test('a refused invitation is retried the next day only while the event is at least two days away (Richard 25/11)', () => {
  assert.equal(retryDayAllowed('2026-12-10', '2026-11-26'), true);
  assert.equal(retryDayAllowed('2026-11-28', '2026-11-26'), true);
  assert.equal(retryDayAllowed('2026-11-27', '2026-11-26'), false, 'the day before the event');
  assert.equal(retryDayAllowed('2026-11-26', '2026-11-26'), false, 'the day of the event');
  assert.equal(retryDayAllowed('2026-11-20', '2026-11-26'), false, 'an event that passed');
  assert.equal(retryDayAllowed('2026-12-01', '2026-11-30'), false, 'across a month end');
  assert.equal(retryDayAllowed('', '2026-11-26'), true, 'no date: as before');
});

test('the daily retry asks the rule before reopening an event', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const i = src.indexOf("await env.RATE.put('autoretry:' + today");
  const block = src.slice(i, i + 3500);
  assert.match(block, /if \(!retryDayAllowed\(evDate\[token\], today\)\) continue;/);
});
