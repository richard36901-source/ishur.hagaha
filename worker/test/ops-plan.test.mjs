// node --test worker/test/ops-plan.test.mjs — the pure "מתוכנן מול בוצע" composer (ops-plan.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composePlan, periodRange, cronFires, dayList, ilAt, PLAN_CRONS, STATUS_HE } from '../ops-plan.js';

const TODAY = '2026-11-04';                                  /* Wednesday */
const NOW = Date.parse('2026-11-04T10:00:00Z');              /* 12:00 Israel (UTC+2 in November) */
const EV = [
  { token: 'aaaa1111-0000-4000-8000-000000000001', name: 'נועה ויונתן', date: '2026-11-04', time: '19:30', occasion: 'חתונה' },
  { token: 'bbbb2222-0000-4000-8000-000000000002', name: 'דנה ורועי', date: '2026-11-12', time: '20:00', occasion: 'חתונה' },
  { token: 'cccc3333-0000-4000-8000-000000000003', name: 'שיר ואלון', date: '2026-10-30', time: '19:00', occasion: 'בר מצווה' },
];
const base = (over = {}) => ({ period: 'today', today: TODAY, now: NOW, send_window: { open: true }, call_window: { open: true }, paused: false, next_tick_at: '2026-11-04T10:10:00.000Z', events: EV, ...over });
const flat = p => p.days.flatMap(d => d.items);
const find = (p, id) => flat(p).find(i => i.id === id);

test('periodRange: today / Israel week (Sun–Sat) / calendar month', () => {
  assert.deepEqual(periodRange('today', TODAY), { from: TODAY, to: TODAY });
  assert.deepEqual(periodRange('week', TODAY), { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(periodRange('week', '2026-11-07'), { from: '2026-11-01', to: '2026-11-07' });   /* Saturday stays in its week */
  assert.deepEqual(periodRange('month', TODAY), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(periodRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(dayList('2026-11-01', '2026-11-07').length, 7);
});

test('cronFires: once per Israel day, the evening 17/18/19 UTC cron keeps only the 21:00 IL fire, Monday-only crons skip other days', () => {
  const days = dayList('2026-11-01', '2026-11-07');
  const eng = cronFires({ expr: '35 6 * * *' }, days);
  assert.equal(Object.keys(eng).length, 7); assert.equal(eng['2026-11-04'], '2026-11-04T06:35:00.000Z');
  const dig = cronFires({ expr: '0 17,18,19 * * *', il_hour: 21 }, days);
  assert.equal(dig['2026-11-04'], '2026-11-04T19:00:00.000Z');                  /* winter: 21:00 IL = 19:00 UTC */
  const mon = cronFires({ expr: '35 6 * * *', dow: [1] }, days);
  assert.deepEqual(Object.keys(mon), ['2026-11-02']);
  assert.ok(PLAN_CRONS.every(c => c.id && c.expr));
});

test('ilAt: Israel wall-clock → ISO (DST-safe)', () => {
  assert.equal(ilAt('2026-11-04', '09:00'), '2026-11-04T07:00:00.000Z');
  assert.equal(ilAt('2026-07-04', '09:00'), '2026-07-04T06:00:00.000Z');
});

test('today: a send that finished is בוצע, one half way is בתהליך (X מתוך Y), one not started is ממתין at the next tick, a dropped day-before is לא קרה', () => {
  const p = composePlan(base({
    sends: [{ day: TODAY, tok8: 'aaaa1111', type: 'table', sent: 40, failed: 2 }, { day: TODAY, tok8: 'bbbb2222', type: 'w1', sent: 30, failed: 0 }],
    capacity: { days: [{ day: TODAY, open: true, capacity: 68, planned: 176, overflow: 108, out: 68,
      rolled: [{ tok8: 'bbbb2222', event: 'דנה ורועי', type: 'w1', n: 68, from_day: TODAY }, { tok8: 'dddd4444', event: 'אירוע ד', type: 'thanks', n: 12, from_day: TODAY }],
      by_event: [{ tok8: 'eeee5555', name: 'אירוע ה', type: 'daybefore', count: 20, dropped: true }] }] },
    board: { events: [{ short: 'aaaa1111', name: 'נועה ויונתן', types: [{ key: 'table', due: TODAY, audience: 40, sent: 40, failed: { total: 2 }, pending: { total: 0 } }] },
      { short: 'bbbb2222', name: 'דנה ורועי', types: [{ key: 'w1', due: TODAY, audience: 98, sent: 30, failed: 0, pending: { total: 68, queue: 68 } }] }] },
  }));
  assert.equal(p.days.length, 1); assert.equal(p.from, TODAY);
  const tbl = find(p, `send:aaaa1111|table:${TODAY}`);
  assert.equal(tbl.status, 'done'); assert.equal(tbl.done_n, 40); assert.equal(tbl.failed_n, 2); assert.match(tbl.reason_he, /2 נכשלו/); assert.equal(tbl.status_he, STATUS_HE.done);
  const w1 = find(p, `send:bbbb2222|w1:${TODAY}`);
  assert.equal(w1.status, 'in_progress'); assert.equal(w1.done_n, 30); assert.equal(w1.planned_n, 98); assert.equal(w1.of, 98); assert.equal(w1.planned_at, '2026-11-04T10:10:00.000Z');
  const th = find(p, `send:dddd4444|thanks:${TODAY}`);
  assert.equal(th.status, 'waiting'); assert.equal(th.planned_n, 12); assert.equal(th.planned_at, '2026-11-04T10:10:00.000Z'); assert.match(th.label_he, /הודעת תודה · אירוע ד/);
  const db = find(p, `send:eeee5555|daybefore:${TODAY}`);
  assert.equal(db.status, 'missed'); assert.match(db.reason_he, /יום-לפני לא יצא/);
  assert.deepEqual(p.totals, { planned: 5, done: 1, in_progress: 2, waiting: 1, missed: 1 });   /* + the event taking place today (in_progress) */
  assert.equal(p.next.label_he, th.label_he); assert.equal(p.next.at, th.planned_at);
});

test('today: the window is closed for the day → an unsent planned send is לא קרה with the reason; paused → עצירה כללית; before 09:00 → ממתין at 09:00; cap → ממתין with מכסה', () => {
  const cap = { days: [{ day: TODAY, open: true, capacity: 230, planned: 50, overflow: 0, rolled: [{ tok8: 'bbbb2222', event: 'דנה ורועי', type: 'w2', n: 50, from_day: TODAY }], by_event: [] }] };
  const shut = composePlan(base({ now: Date.parse('2026-11-04T19:00:00Z'), send_window: { open: false, why: 'hours' }, capacity: cap }));
  const a = find(shut, `send:bbbb2222|w2:${TODAY}`); assert.equal(a.status, 'missed'); assert.equal(a.reason_he, 'חלון סגור');
  const paused = composePlan(base({ paused: true, capacity: cap }));
  const b = find(paused, `send:bbbb2222|w2:${TODAY}`); assert.equal(b.status, 'missed'); assert.equal(b.reason_he, 'עצירה כללית');
  const early = composePlan(base({ now: Date.parse('2026-11-04T05:30:00Z'), send_window: { open: false, why: 'hours' }, capacity: cap }));
  const c = find(early, `send:bbbb2222|w2:${TODAY}`); assert.equal(c.status, 'waiting'); assert.equal(c.planned_at, ilAt(TODAY, '09:00'));
  const capped = composePlan(base({ sends_why: 'cap', capacity: cap }));
  const d = find(capped, `send:bbbb2222|w2:${TODAY}`); assert.equal(d.status, 'waiting'); assert.match(d.reason_he, /מכסה/);
});

test('week: past days show done / missed from the audit + board, today in progress, future days planned with capacity warnings and rolled-from notes; days carry totals', () => {
  const p = composePlan(base({ period: 'week',
    sends: [{ day: '2026-11-02', tok8: 'cccc3333', type: 'thanks', sent: 25, failed: 1 }, { day: '2026-11-03', tok8: 'aaaa1111', type: 'daybefore', sent: 60, failed: 0 }, { day: TODAY, tok8: 'aaaa1111', type: 'table', sent: 10, failed: 0 }],
    capacity: { days: [
      { day: TODAY, open: true, capacity: 68, planned: 40, overflow: 0, rolled: [{ tok8: 'aaaa1111', event: 'נועה ויונתן', type: 'table', n: 30, from_day: TODAY }], by_event: [] },
      { day: '2026-11-05', open: true, capacity: 230, planned: 507, overflow: 277, rolled: [{ tok8: 'bbbb2222', event: 'דנה ורועי', type: 'w1', n: 230, from_day: '2026-11-05' }], by_event: [] },
      { day: '2026-11-06', open: true, capacity: 100, planned: 0, overflow: 0, rolled: [{ tok8: 'bbbb2222', event: 'דנה ורועי', type: 'w1', n: 100, from_day: '2026-11-05' }], by_event: [] },
      { day: '2026-11-07', open: false, capacity: 0, planned: 0, overflow: 0, rolled: [], by_event: [] }] },
    board: { events: [
      { short: 'cccc3333', name: 'שיר ואלון', types: [{ key: 'thanks', due: '2026-11-02', audience: 25, sent: 25, failed: 1, pending: { total: 0 } }] },
      { short: 'ffff6666', name: 'אירוע ו', held: true, types: [{ key: 'w2', due: '2026-11-01', audience: 80, sent: 0, failed: 0, pending: { total: 80, hold: 80 } }] },
      { short: 'gggg7777', name: 'אירוע ז', types: [{ key: 'w1', due: '2026-11-03', audience: 120, sent: 0, failed: 0, pending: { total: 120, cap: 120 } }] }] },
  }));
  assert.equal(p.days.length, 7); assert.deepEqual(p.days.map(d => d.dow_he), ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']);
  assert.ok(p.days[0].past && p.days[3].today && p.days[4].future);
  assert.equal(find(p, 'send:cccc3333|thanks:2026-11-02').status, 'done');
  const held = find(p, 'send:ffff6666|w2:2026-11-01'); assert.equal(held.status, 'missed'); assert.equal(held.reason_he, 'החזקה (hold)'); assert.equal(held.planned_n, 80);
  const capd = find(p, 'send:gggg7777|w1:2026-11-03'); assert.equal(capd.status, 'missed'); assert.equal(capd.reason_he, 'מכסה');
  assert.equal(find(p, 'send:aaaa1111|table:2026-11-04').status, 'in_progress');
  const f1 = find(p, 'send:bbbb2222|w1:2026-11-05'); assert.equal(f1.status, 'waiting'); assert.match(f1.reason_he, /עמוס: 507 מתוכננות מול תקרה 230/); assert.equal(f1.planned_at, ilAt('2026-11-05', '09:00'));
  const f2 = find(p, 'send:bbbb2222|w1:2026-11-06'); assert.equal(f2.status, 'waiting'); assert.match(f2.reason_he, /נדחה מ-05\/11 \(מכסה\)/);
  assert.equal(p.days[6].items.length, 0, 'nothing on Shabbat'); assert.equal(p.days[6].open, false);
  assert.equal(p.days[4].capacity.overflow, 277);
  assert.equal(p.days[1].totals.done, 1);
  const sum = p.days.reduce((n, d) => n + d.totals.planned, 0); assert.equal(sum, p.totals.planned);
});

test('calls: past rounds from the audit (dialed / answered), today from the round cards (done / in progress / waiting / missed), the queue rolls to the next open call day; plan-without-calls never shows', () => {
  const rounds = { events: [
    { tok8: 'aaaa1111', name: 'נועה ויונתן', date: '2026-11-04', queued: 4, remaining_today: 0, dialed_today: 5, answered_today: 3, outcomes_today: { coming: 2, voicemail: 1 }, will_dial: false, why: [{ code: 'done-today', he: 'כל הממתינים כבר חויגו היום' }] },
    { tok8: 'bbbb2222', name: 'דנה ורועי', date: '2026-11-12', queued: 6, remaining_today: 4, dialed_today: 2, answered_today: 1, outcomes_today: {}, will_dial: true, why: [] },
    { tok8: 'hhhh8888', name: 'אירוע ח', date: '2026-11-20', queued: 3, remaining_today: 3, dialed_today: 0, answered_today: 0, outcomes_today: {}, will_dial: true, why: [] },
    { tok8: 'iiii9999', name: 'אירוע ט', date: '2026-11-20', queued: 1, remaining_today: 0, dialed_today: 1, answered_today: 0, outcomes_today: { failed: 1 }, plan_no_calls: true, will_dial: false, why: [{ code: 'plan', he: 'החבילה לא כוללת שיחות' }] },
  ] };
  const p = composePlan(base({ period: 'week', call_rounds: rounds, calls_done: [{ day: '2026-11-02', tok8: 'cccc3333', name: 'שיר ואלון', n: 9, answered: 4 }] }));
  const past = find(p, 'call:cccc3333:2026-11-02'); assert.equal(past.status, 'done'); assert.equal(past.done_n, 9); assert.equal(past.answered, 4);
  const a = find(p, `call:aaaa1111:${TODAY}`); assert.equal(a.status, 'done'); assert.match(a.reason_he, /5 חיוגים · 3 נענו · מגיע 2, תא קולי 1/);
  const b = find(p, `call:bbbb2222:${TODAY}`); assert.equal(b.status, 'in_progress'); assert.equal(b.planned_n, 6); assert.equal(b.done_n, 2);
  const h = find(p, `call:hhhh8888:${TODAY}`); assert.equal(h.status, 'waiting'); assert.equal(h.planned_at, '2026-11-04T10:10:00.000Z');
  assert.equal(find(p, 'call:bbbb2222:2026-11-05').planned_n, 2, 'the 2 beyond today roll to tomorrow');
  assert.ok(!flat(p).some(i => i.event.tok8 === 'iiii9999'), 'plan without calls is not planned');
  const shut = composePlan(base({ now: Date.parse('2026-11-04T19:30:00Z'), call_window: { open: false, why: 'hours' }, call_rounds: { events: [rounds.events[2]] } }));
  const hs = find(shut, `call:hhhh8888:${TODAY}`); assert.equal(hs.status, 'missed'); assert.match(hs.reason_he, /חלון/);
});

test('lead sends from 4499: done with the failed count and the 131042 flag; today with nothing yet = ממתין; empty past days are skipped', () => {
  const p = composePlan(base({ period: 'week', lead_sends: { by_day: { '2026-11-02': { sent: 12, failed: 2 }, '2026-11-03': { sent: 0, failed: 0 } }, billing_131042: true } }));
  const a = find(p, 'leads:2026-11-02'); assert.equal(a.status, 'done'); assert.equal(a.done_n, 12); assert.equal(a.failed_n, 2); assert.match(a.reason_he, /2 נכשלו/);
  assert.equal(find(p, 'leads:2026-11-03'), undefined);
  const t = find(p, `leads:${TODAY}`); assert.equal(t.status, 'waiting'); assert.match(t.reason_he, /131042/);
});

test('crons: ran = בוצע at its real time, failed = לא קרה with the error, not run after its slot = לא קרה, later today / future = ממתין at the fire time', () => {
  const crons = [{ id: 'd_engine', expr: '35 6 * * *', name_he: 'המנוע היומי', runs: [{ started_at: '2026-11-04T06:35:10.000Z', status: 'ok' }, { started_at: '2026-11-02T06:35:10.000Z', status: 'failed', error: 'sheet 500' }] },
    { id: 'journal_digest', expr: '0 17,18,19 * * *', il_hour: 21, name_he: 'דוח יומי', runs: [] }];
  const p = composePlan(base({ period: 'week', crons }));
  const ran = find(p, `cron:d_engine:${TODAY}`); assert.equal(ran.status, 'done'); assert.equal(ran.planned_at, '2026-11-04T06:35:10.000Z');
  const bad = find(p, 'cron:d_engine:2026-11-02'); assert.equal(bad.status, 'missed'); assert.match(bad.reason_he, /sheet 500/);
  const none = find(p, 'cron:d_engine:2026-11-03'); assert.equal(none.status, 'missed'); assert.match(none.reason_he, /לא רץ \(היה אמור ב-08:35\)/);
  const later = find(p, `cron:journal_digest:${TODAY}`); assert.equal(later.status, 'waiting'); assert.equal(later.planned_at, '2026-11-04T19:00:00.000Z');
  assert.equal(find(p, 'cron:d_engine:2026-11-06').status, 'waiting');
  assert.equal(find(p, 'cron:journal_digest:2026-11-01').status, 'missed');
});

test('events and hostess shifts: past = בוצע, today = בתהליך / by the clock, future = ממתין, cancelled shift = לא קרה; sub-event reminder states', () => {
  const asg = [{ id: 'h1', date: TODAY, start: '18:00', end: '23:00', hostess_name: 'מאיה', event_token: EV[0].token, status: 'confirmed' },
    { id: 'h2', date: TODAY, start: '08:00', end: '11:00', hostess_name: 'רוני', event_token: EV[0].token, status: 'confirmed' },
    { id: 'h3', date: '2026-11-12', start: '18:00', end: '23:00', hostess_name: 'מאיה', event_token: EV[1].token, status: 'cancelled' }];
  const subrecs = { 'ssss1111-0000-4000-8000-000000000011': { parent: EV[0].token, name: 'שבת חתן', reminder_at: '2026-11-05T10:00', reminder_n: 44 },
    'ssss2222-0000-4000-8000-000000000012': { parent: EV[1].token, name: 'שבת חתן ב', reminder_at: '2026-11-02T10:00', reminder_started_at: '2026-11-02T08:00:00Z', reminder_completed_at: '2026-11-02T08:30:00Z' },
    'ssss3333-0000-4000-8000-000000000013': { parent: EV[1].token, name: 'שבת חתן ג', reminder_at: '2026-11-03T10:00' } };
  const p = composePlan(base({ period: 'month', assignments: asg, subrecs }));
  assert.equal(find(p, 'event:aaaa1111').status, 'in_progress'); assert.equal(find(p, 'event:bbbb2222').status, 'waiting');
  assert.equal(find(p, 'event:bbbb2222').planned_at, ilAt('2026-11-12', '20:00'));
  assert.equal(find(p, 'hostess:h1').status, 'waiting'); assert.equal(find(p, 'hostess:h2').status, 'done'); assert.equal(find(p, 'hostess:h3').status, 'missed');
  assert.equal(find(p, 'subrem:ssss1111').status, 'waiting'); assert.equal(find(p, 'subrem:ssss1111').planned_n, 44);
  assert.equal(find(p, 'subrem:ssss2222').status, 'done'); assert.equal(find(p, 'subrem:ssss3333').status, 'missed');
  assert.equal(p.days.length, 30); assert.equal(p.from, '2026-11-01'); assert.equal(p.to, '2026-11-30');
  /* 2026-10-30 is outside November: not in the month view; it is בוצע in a week that holds it */
  assert.equal(find(p, 'event:cccc3333'), undefined);
  assert.equal(find(composePlan(base({ today: '2026-10-31', now: Date.parse('2026-10-31T10:00:00Z'), period: 'week' })), 'event:cccc3333').status, 'done');
});

test('empty input → an honest empty plan (no items, zero totals, no next), deterministic order inside a day', () => {
  const p = composePlan(base({ events: [] }));
  assert.deepEqual(p.totals, { planned: 0, done: 0, in_progress: 0, waiting: 0, missed: 0 }); assert.equal(p.next, null);
  const a = composePlan(base({ crons: [{ id: 'd_engine', expr: '35 6 * * *', runs: [] }], assignments: [{ id: 'x', date: TODAY, start: '08:00', end: '09:00', hostess_name: 'א', event_token: EV[0].token, status: 'confirmed' }] }));
  const b = composePlan(base({ assignments: [{ id: 'x', date: TODAY, start: '08:00', end: '09:00', hostess_name: 'א', event_token: EV[0].token, status: 'confirmed' }], crons: [{ id: 'd_engine', expr: '35 6 * * *', runs: [] }] }));
  assert.deepEqual(a.days[0].items.map(i => i.id), b.days[0].items.map(i => i.id));
  assert.ok(a.days[0].items.every(i => ['done', 'in_progress', 'waiting', 'missed'].includes(i.status) && i.status_he && i.label_he && i.deep_link && /Z$/.test(i.planned_at)));
});
