/* 25/11/2026: a brit at 14:00 received "מחכים לראותכם היום" at 16:34. An event-day message never goes out once the event has started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventStarted } from '../eventday.js';

test('eventStarted: at or after the reception time', () => {
  assert.equal(eventStarted('14:00', '16:34'), true);
  assert.equal(eventStarted('14:00', '14:00'), true);
  assert.equal(eventStarted('14:00', '13:59'), false);
  assert.equal(eventStarted('19:30', '09:05'), false);
  assert.equal(eventStarted('', '16:34'), false, 'no time on record: not blocked');
  assert.equal(eventStarted('בשעות הערב', '16:34'), false);
  assert.equal(eventStarted('9:00', '10:00:12'), true);
});

test('both event-day stages check the time before sending', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal((src.match(/eventStarted\((ev|evRow)\[36\], ilTime\(\)\)/g) || []).length, 2);
  const a = src.indexOf("if (!token || !paid || cancelled || date !== today) continue;"), g = src.indexOf('eventStarted(ev[36], ilTime())', a), send = src.indexOf("const evName = guestEventName(ev, { article: false });", a);
  assert.ok(a > 0 && g > a && g < send, 'the check comes before anything is prepared for sending');
});
