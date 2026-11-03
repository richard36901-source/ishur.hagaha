// node --test worker/test/noa-cadence.test.mjs
// R2 / P2: 5 attempts on days 0 / +1 / +3 / +7 / +14, hour bands rotate
// 10–12 → 13–16 → 17–20, never Saturday or a no-contact day, max 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cadenceNextAt, ilDateAt, ilWeekday, MAX_ATTEMPTS, DAY_OFFSETS } from '../noa.js';
import { callWindowState, isNoContactDay } from '../shir.js';

const il = iso => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const ilDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
const ilMins = iso => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)); const g = t => Number((p.find(x => x.type === t) || {}).value); return (g('hour') % 24) * 60 + g('minute'); };
const dayDiff = (a, b) => Math.round((Date.parse(ilDay(b) + 'T12:00:00Z') - Date.parse(ilDay(a) + 'T12:00:00Z')) / 864e5);

test('ilDateAt builds an Israel-local instant (winter UTC+2, summer UTC+3)', () => {
  assert.equal(ilDateAt('2026-11-02', 13 * 60).toISOString(), '2026-11-02T11:00:00.000Z');
  assert.equal(ilDateAt('2026-07-01', 13 * 60).toISOString(), '2026-07-01T10:00:00.000Z');
  assert.equal(ilWeekday('2026-11-01'), 'Sun');
  assert.equal(ilWeekday('2026-11-07'), 'Sat');
});

test('5 attempts at day offsets 0/1/3/7/14 with rotating hour bands, then null', () => {
  /* Sunday 01/11/2026 11:00 Israel */
  const first = ilDateAt('2026-11-01', 11 * 60);
  const attempts = [];
  const got = [];
  let now = first;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const next = cadenceNextAt(attempts, now, callWindowState, { first_at: first.toISOString() });
    assert.ok(next, `attempt ${i + 1} must be scheduled`);
    got.push(next);
    attempts.push({ at: next, call_id: 'c' + i });
    now = new Date(Date.parse(next) + 60000);   // the call just happened
  }
  assert.equal(cadenceNextAt(attempts, now, callWindowState, { first_at: first.toISOString() }), null, 'no 6th attempt');
  assert.deepEqual(got.map(n => dayDiff(first.toISOString(), n)), DAY_OFFSETS, 'day offsets ' + got.map(il).join(' | '));
  /* day 0: right now (inside band 10–12). Then 13:00, 17:00, 10:00, 13:00. */
  assert.equal(got[0], first.toISOString(), 'first attempt = the next open slot, i.e. now');
  assert.deepEqual(got.slice(1).map(ilMins), [13 * 60, 17 * 60, 10 * 60, 13 * 60], 'bands rotate ' + got.map(il).join(' | '));
  for (const n of got) {
    assert.equal(callWindowState(new Date(n)).open, true, 'inside the calling window: ' + il(n));
    assert.notEqual(ilWeekday(ilDay(n)), 'Sat');
    assert.equal(isNoContactDay(ilDay(n)), false);
  }
});

test('attempt 0 when today\'s early bands have passed: next band today, else tomorrow 10:00', () => {
  /* Sunday 19:30 — band 17–20 still open → now */
  const eve = ilDateAt('2026-11-01', 19 * 60 + 30);
  assert.equal(cadenceNextAt([], eve), eve.toISOString());
  /* Sunday 20:15 — every band is behind us → Monday 10:00 */
  const late = ilDateAt('2026-11-01', 20 * 60 + 15);
  const n = cadenceNextAt([], late);
  assert.equal(ilDay(n), '2026-11-02');
  assert.equal(ilMins(n), 10 * 60);
});

test('never Saturday: +1 from a Friday lands on Sunday', () => {
  const fri = ilDateAt('2026-11-06', 10 * 60);
  const n = cadenceNextAt([{ at: fri.toISOString() }], new Date(fri.getTime() + 60000), callWindowState, { first_at: fri.toISOString() });
  assert.equal(ilWeekday(ilDay(n)), 'Sun', il(n));
  assert.equal(ilDay(n), '2026-11-08');
  assert.equal(ilMins(n), 13 * 60, 'attempt #2 keeps its 13–16 band on the day it moved to');
});

test('Friday attempts sit in 09:30–13:00 whatever the rotation says', () => {
  /* Thursday 05/11 first attempt → +1 = Friday 06/11 */
  const thu = ilDateAt('2026-11-05', 11 * 60);
  const n = cadenceNextAt([{ at: thu.toISOString() }], new Date(thu.getTime() + 60000), callWindowState, { first_at: thu.toISOString() });
  assert.equal(ilDay(n), '2026-11-06');
  assert.equal(ilWeekday(ilDay(n)), 'Fri');
  assert.equal(ilMins(n), 9 * 60 + 30, il(n));
  assert.equal(callWindowState(new Date(n)).open, true);
});

test('never a no-contact day: Rosh Hashana 2026 is skipped (and the Shabbat inside it)', () => {
  /* Thursday 10/09/2026 → +1 = 11/09 (ערב ר"ה), 12/09 Sat, 13/09 ר"ה → Monday 14/09 */
  const thu = ilDateAt('2026-09-10', 11 * 60);
  const n = cadenceNextAt([{ at: thu.toISOString() }], new Date(thu.getTime() + 60000), callWindowState, { first_at: thu.toISOString() });
  assert.equal(ilDay(n), '2026-09-14', il(n));
  assert.equal(isNoContactDay(ilDay(n)), false);
  assert.equal(ilMins(n), 13 * 60);
});

test('max 5: five attempts already made → null, even with a custom window', () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ at: ilDateAt('2026-11-0' + (1 + i), 11 * 60).toISOString() }));
  assert.equal(cadenceNextAt(five, new Date()), null);
  assert.equal(cadenceNextAt(five.slice(0, 4), ilDateAt('2026-11-20', 11 * 60), () => ({ open: false, why: 'test' })), null, 'a window that never opens yields nothing');
});

test('voicemail / no-answer attempts count toward the cadence (they are attempts)', () => {
  const first = ilDateAt('2026-11-01', 11 * 60);
  const attempts = [{ at: first.toISOString(), reached: false, outcome: 'לא ענה' }, { at: ilDateAt('2026-11-02', 13 * 60).toISOString(), reached: false, outcome: 'voicemail' }];
  const n = cadenceNextAt(attempts, ilDateAt('2026-11-02', 13 * 60 + 5), callWindowState, { first_at: first.toISOString() });
  assert.equal(dayDiff(first.toISOString(), n), 3, 'third attempt is day +3 regardless of how the first two ended');
});
