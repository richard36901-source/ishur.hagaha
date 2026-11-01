// node --test worker/test/past-events.test.mjs
// R10 / P10: nothing is dialled for an event whose date has passed, and the
// calls board files such guests under "אירוע עבר", not "בתור".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { shouldDial, ilDate } from '../shir.js';
const require = createRequire(import.meta.url);
const { aggregateCalls } = require('../../assets/callboard.js');

const TODAY = '2026-11-02';
const YESTERDAY = '2026-11-01';

test('shouldDial refuses yesterday\'s event and accepts today / tomorrow', () => {
  assert.equal(shouldDial({ event_date: YESTERDAY, tries: 0 }, TODAY), false);
  assert.equal(shouldDial({ event_date: TODAY, tries: 0 }, TODAY), true);
  assert.equal(shouldDial({ event_date: '2026-11-03', tries: 0 }, TODAY), true);
  assert.equal(shouldDial({ event_date: '', tries: 0 }, TODAY), true, 'no date = not a past event');
  assert.equal(shouldDial({ event_date: '2026-12-01', capped: true }, TODAY), false, 'capped stays refused');
});

test('shouldDial uses the Israeli calendar day, not UTC', () => {
  /* 23:30 UTC on 01/11 is already 01:30 on 02/11 in Israel */
  const late = new Date('2026-11-01T23:30:00Z');
  assert.equal(ilDate(late), '2026-11-02');
  assert.equal(shouldDial({ event_date: '2026-11-01' }, ilDate(late)), false);
});

test('calls board: a past event\'s guests count as "אירוע עבר", never "בתור"', () => {
  const NOW = Date.parse('2026-11-02T10:00:00Z');
  const board = {
    window: { open: true },
    waiting: [
      { kind: 'guest', name: 'א', phone: '972500000055', event: 'ישן', event_date: YESTERDAY, tries: 0, max_tries: 3, state: 'waiting' },
      { kind: 'guest', name: 'ב', phone: '972500000056', event: 'ישן', event_date: YESTERDAY, tries: 1, max_tries: 3, state: 'waiting' },
      { kind: 'guest', name: 'ג', phone: '972500000057', event: 'חדש', event_date: '2026-11-09', tries: 0, max_tries: 3, state: 'waiting' },
    ],
    done: [],
  };
  const out = aggregateCalls({ board, rows: [], range: 'today', now: NOW, today: TODAY });
  const old = out.events.find(e => e.name === 'ישן');
  const fresh = out.events.find(e => e.name === 'חדש');
  assert.ok(old && fresh);
  assert.equal(old.queue.waiting, 0, 'past event: 0 in queue');
  assert.equal(old.queue.past, 2, 'past event: both guests filed as past');
  assert.ok(old.guests.every(g => g.state === 'past'));
  assert.equal(fresh.queue.waiting, 1);
  assert.equal(fresh.queue.past, 0);
});
