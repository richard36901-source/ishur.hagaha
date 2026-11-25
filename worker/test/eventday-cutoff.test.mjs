/* 25/11/2026 Richard: the event-day message must reach guests at least 2 hours before the event (ev[36]).
   Anything not sent by then, retries included, is cancelled, never sent late. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EVENT_DAY_CUTOFF_MIN, eventDayCutoffAt, pastEventDayCutoff, eventDayOver, eventDayRetryAllowed } from '../eventday.js';

test('the cutoff is 120 minutes, one constant', () => {
  assert.equal(EVENT_DAY_CUTOFF_MIN, 120);
  assert.equal(eventDayCutoffAt('19:30'), 17 * 60 + 30);
  assert.equal(eventDayCutoffAt('19:30', 60), 18 * 60 + 30);
});

test('pastEventDayCutoff: from two hours before the reception time', () => {
  assert.equal(pastEventDayCutoff('19:30', '17:29'), false);
  assert.equal(pastEventDayCutoff('19:30', '17:30'), true);
  assert.equal(pastEventDayCutoff('19:30', '18:45'), true);
  assert.equal(pastEventDayCutoff('14:00', '11:59'), false);
  assert.equal(pastEventDayCutoff('14:00', '12:00:30'), true);
});

test('edge: an event at 10:00 is cut from 08:00, before the send window opens', () => {
  assert.equal(pastEventDayCutoff('10:00', '07:59'), false);
  assert.equal(pastEventDayCutoff('10:00', '09:00'), true);
});

test('edge: an event after midnight is cut for its whole day', () => {
  assert.equal(eventDayCutoffAt('00:30'), -90);
  assert.equal(pastEventDayCutoff('00:30', '00:00'), true);
  assert.equal(pastEventDayCutoff('01:59', '09:00'), true);
});

test('edge: no readable time is not cut (same rule as eventStarted)', () => {
  assert.equal(pastEventDayCutoff('', '18:00'), false);
  assert.equal(pastEventDayCutoff('בשעות הערב', '18:00'), false);
  assert.equal(pastEventDayCutoff('19:30', ''), false);
});

test('eventDayOver: a job left from a past event day is never sent the next morning', () => {
  assert.equal(eventDayOver('2026-11-24', '2026-11-25'), true);
  assert.equal(eventDayOver('2026-11-25', '2026-11-25'), false);
  assert.equal(eventDayOver('', '2026-11-25'), false);
});

test('eventDayRetryAllowed: a failed send is reopened only before the cutoff on the event day', () => {
  const today = '2026-11-25';
  assert.equal(eventDayRetryAllowed({ date: today, time: '19:30' }, today, '16:00'), true);
  assert.equal(eventDayRetryAllowed({ date: today, time: '19:30' }, today, '17:30'), false);
  assert.equal(eventDayRetryAllowed({ date: '2026-11-24', time: '19:30' }, today, '10:00'), false);
  assert.equal(eventDayRetryAllowed({ date: '2026-11-26', time: '19:30' }, today, '18:00'), true, 'tomorrow\'s event is not today\'s cutoff');
  assert.equal(eventDayRetryAllowed({ date: today, time: '' }, today, '18:00'), true);
});

test('both event-day stages and the retry path apply the cutoff', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  /* stage 4 (table / combo): before preparing, and per guest inside the loop */
  const a = src.indexOf("if (!token || !paid || cancelled || date !== today) continue;");
  const g = src.indexOf('pastEventDayCutoff(ev[36], ilTime())', a), send = src.indexOf("const evName = guestEventName(ev, { article: false });", a);
  assert.ok(a > 0 && g > a && g < send);
  assert.ok(src.indexOf("if (!dry && pastEventDayCutoff(ev[36], ilTime())) break;", a) > send);
  /* the hand-set event-day blast: the job is deleted (cancelled) and checked per guest */
  const b = src.indexOf('async function runEventDayBlasts');
  const c = src.indexOf('pastEventDayCutoff(evRow[36], ilTime()) || eventDayOver(evRow[6], today)', b);
  assert.ok(b > 0 && c > b && src.indexOf("await env.RATE.delete('edblast:' + token)", c) - c < 800);
  assert.ok(src.indexOf('if (pastEventDayCutoff(evRow && evRow[36], ilTime()))', b) > c);
  /* the status-webhook retry (reopenEdMark) refuses after the cutoff */
  const r = src.indexOf('async function reopenEdMark');
  assert.ok(r > 0 && src.indexOf('eventDayRetryAllowed(', r) - r < 600);
});

test('the late alert names how many guests lost the message, and says nothing when nobody was waiting', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('const pending = await eventDayPendingCount(env, token, gRows);'));
  assert.ok(src.includes('if (pending) await alert(env, \'הודעת יום האירוע\''));
  /* the hand-set blast: a cancelled / held event is reported as such before the cutoff */
  const b = src.indexOf('async function runEventDayBlasts');
  assert.ok(src.indexOf("skipped: 'cancelled-or-hold'", b) < src.indexOf("skipped: 'event-day-cutoff'", b));
});
