// node --test worker/test/ops-capacity.test.mjs — pure parts of ops.js: planner, projection, blast radius, aggregates
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCapacity, capacityModel, projectItems, downstream, blastRadius, switchFor, aggregateWa, aggregateCalls, callBucket, compareRealtime, ilDayStartMs, ilDayOf, ticksLeftToday, reasonOf, balanceStatus } from '../ops.js';
import { callWindowState } from '../shir.js';

const T = '2026-11-08';   /* a Sunday; 2026-11-14 is Shabbat */
const it = (day, token, count, type = 'w1', extra = {}) => ({ day, token, tok8: token.slice(0, 8), name: 'ev ' + token[0], type, count, upper_bound: true, ...extra });

test('capacityModel: unverified = shared 250 − margin; verified = per-number ≥1000, summed', () => {
  const s = capacityModel({ verified: false, numbers: [{ id: 'A', tier: 'TIER_250' }, { id: 'B', tier: 'TIER_250' }], portfolioLimit: 250, margin: 20 });
  assert.equal(s.model, 'shared'); assert.equal(s.capacity_per_day, 230);
  const v = capacityModel({ verified: true, numbers: [{ id: 'A', tier: 'TIER_250' }, { id: 'B', tier: 'TIER_1K' }] });
  assert.equal(v.model, 'per_number'); assert.equal(v.capacity_per_day, 2000);
});

test('planCapacity: per-day planned vs capacity, overflow, held flagged not counted, Shabbat capacity 0', () => {
  const model = { capacity_per_day: 230, today_remaining: 100, verified: false };
  const items = [it(T, 'aaaa1111', 80), it(T, 'bbbb2222', 60), it('2026-11-09', 'cccc3333', 50, 'daybefore'), it('2026-11-09', 'dddd4444', 40, 'w1', { held: true }), it('2026-11-14', 'eeee5555', 10, 'thanks')];
  const p = planCapacity({ today: T, days: 14, items, model });
  assert.equal(p.days.length, 14);
  const d0 = p.days[0], d1 = p.days[1], sat = p.days.find(d => d.day === '2026-11-14');
  assert.equal(d0.capacity, 100); assert.equal(d0.planned, 140); assert.equal(d0.overflow, 40);
  assert.equal(d1.capacity, 230); assert.equal(d1.planned, 50); assert.equal(d1.held_planned, 40);
  assert.ok(d1.by_event.find(e => e.token === 'dddd4444').held);
  assert.equal(sat.open, false); assert.equal(sat.capacity, 0); assert.equal(sat.overflow, 10);
  assert.deepEqual(p.totals.overflow_days, [T, '2026-11-14']);
});

test('recommendations: fits / move to earliest whole-day window / split over N days with the verification note — deterministic', () => {
  const model = { capacity_per_day: 230, today_remaining: 100, verified: false };
  const items = [it(T, 'aaaa1111', 80), it(T, 'bbbb2222', 60), it(T, 'cccc3333', 500)];
  const a = planCapacity({ today: T, days: 14, items, model });
  const b = planCapacity({ today: T, days: 14, items: items.slice().reverse(), model });
  assert.deepEqual(a.recommendations, b.recommendations, 'input order does not change the answer');
  const r = Object.fromEntries(a.recommendations.map(x => [x.tok8, x]));
  assert.equal(r.aaaa1111.kind, 'fits'); assert.equal(r.aaaa1111.day, T);
  assert.equal(r.bbbb2222.kind, 'move'); assert.equal(r.bbbb2222.day, '2026-11-09');   /* 20 left today; tomorrow has 230 */
  assert.equal(r.cccc3333.kind, 'split'); assert.equal(r.cccc3333.days_needed, 3);
  assert.equal(r.cccc3333.needs_capacity_by, T);
  assert.match(r.cccc3333.he, /אימות העסק ממתין/);
  assert.equal(r.cccc3333.split.reduce((n, s) => n + s.count, 0) + r.cccc3333.unplaced, 500);
  const v = planCapacity({ today: T, days: 14, items: [it(T, 'cccc3333', 2500)], model: { capacity_per_day: 2000, today_remaining: 2000, verified: true } });
  assert.match(v.recommendations[0].he, /להוסיף מספר שולח/);
});

test('projectItems: waves (flag closes, w2 = unanswered/מתלבט, w3 needs extrasend), daybefore/table/thanks, hold flagged, Shabbat skipped', () => {
  const g = (phone, rsvp, table = '') => ({ phone, rsvp, table, name: '', id: '' });
  const events = [
    { token: 'aaaa1111-0000', name: 'A', date: '2026-11-12', plan: 'pro', waves: { 1: '2026-11-07', 2: '2026-11-10', 3: '2026-11-11' } },
    { token: 'bbbb2222-0000', name: 'B', date: '2026-11-15', plan: 'basic', waves: { 1: '2026-11-14', 2: '', 3: '' } },
  ];
  const guests = { 'aaaa1111-0000': [g('1', 'מגיע', '3'), g('2', ''), g('3', 'מתלבט'), g('4', 'לא מגיע'), g('4', 'לא מגיע')], 'bbbb2222-0000': [g('5', ''), g('6', 'מגיע')] };
  const flags = { 'aaaa1111-0000': { wave1: false }, 'bbbb2222-0000': { hold: true } };
  const items = projectItems({ events, guests, flags, today: T, days: 14 });
  const key = x => `${x.tok8}|${x.type}|${x.day}|${x.count}|${x.held ? 'H' : ''}`;
  assert.deepEqual(items.map(key).sort(), [
    'aaaa1111|daybefore|2026-11-11|1|', 'aaaa1111|table|2026-11-12|1|', 'aaaa1111|thanks|2026-11-13|1|',
    'aaaa1111|w1|2026-11-08|3|', 'aaaa1111|w2|2026-11-10|2|',
    'bbbb2222|daybefore|2026-11-15|1|H', 'bbbb2222|w1|2026-11-15|2|H',   /* B: nobody has a table yet → no table message */
  ].sort());
});

test('downstream / blast radius: pacer stops its own children fully and the engine only partly (morning cron still runs it)', () => {
  const d = downstream('d_pacer');
  const by = Object.fromEntries(d.map(x => [x.id, x]));
  assert.equal(by.d_engine.fully_stopped, false); assert.deepEqual(by.d_engine.other_parents, ['t_morning']);
  assert.equal(by.shir_dispatch.fully_stopped, true); assert.equal(by.autoretry.fully_stopped, true);
  assert.equal(by.wave1.fully_stopped, false);
  const items = [it(T, 'aaaa1111', 80), it('2026-11-09', 'bbbb2222', 30, 'daybefore'), it('2026-11-20', 'cccc3333', 99)];
  const br = blastRadius('wave1', { items, today: T, days: 7 });
  assert.equal(br.messages_next_days.total, 80); assert.deepEqual(br.events_affected.map(e => e.tok8), ['aaaa1111']);
  const bp = blastRadius('d_pacer', { items, today: T, days: 7, calls: { queued: 12, callbacks: 2 } });
  assert.equal(bp.messages_next_days.total, 0); assert.equal(bp.messages_next_days.partial_total, 110);
  assert.deepEqual(bp.calls_stopped, { queued: 12, callbacks: 2 });
  assert.equal(switchFor('wave_retry'), 'manual_blasts'); assert.equal(switchFor('report7'), null); assert.equal(switchFor('nope'), null);
});

test('aggregateWa: per number sent/rejected/async-failed by code, by event and reason; other days and SMS ignored', () => {
  const ts = ilDayStartMs(T) + 10 * 3600e3, yd = ilDayStartMs(T) - 3600e3;
  const out = [
    { kind: 'wa_out', ts, at: new Date(ts).toISOString(), ok: true, token: 'aaaa1111-x', data: { phone_id: 'A', wamid: 'w1', template: 'hazmana_ishur' } },
    { kind: 'wa_out', ts, ok: true, token: 'aaaa1111-x', data: { phone_id: 'A', wamid: 'w2', template: 'ishur_yom_lifnei' } },
    { kind: 'wa_out', ts, ok: true, token: '', data: { phone_id: 'B', wamid: 'w3', template: '' } },
    { kind: 'wa_out', ts, ok: false, token: '', data: { phone_id: 'B', template: 'hazmana_ishur', error: '131048 spam rate' } },
    { kind: 'wa_out', ts, ok: true, data: { channel: 'sms' } },
    { kind: 'wa_out', ts: yd, ok: true, data: { phone_id: 'A', template: 'hazmana_ishur' } },
  ];
  const st = [{ kind: 'wa_status', ts, data: { wamid: 'w1', status: 'failed' }, detail: '131049 marketing' }];
  const a = aggregateWa(out, st, { today: T, numbers: ['A', 'B', 'C'] });
  assert.equal(a.A.sent_today, 2); assert.equal(a.A.failed_async_today, 1); assert.deepEqual(a.A.failed_by_code, { 131049: 1 });
  assert.deepEqual(a.A.by_event.aaaa1111, { total: 2, wave: 1, daybefore: 1 });
  assert.equal(a.B.sent_today, 1); assert.equal(a.B.rejected_today, 1); assert.deepEqual(a.B.failed_by_code, { 131048: 1 }); assert.equal(a.B.by_reason.reply, 1);
  assert.equal(a.C.sent_today, 0);
  assert.equal(reasonOf({ data: { template: 'ishur_doch', phone_id: 'N' } }, { clientIds: ['N'] }), 'client');
});

test('aggregateCalls + callBucket: dialed/answered/voicemail/no-answer per event, queue, remaining', () => {
  const s = ilDayStartMs(T) + 11 * 3600e3;
  const calls = [
    { start_timestamp: s, end_timestamp: s + 60e3, call_status: 'ended', disconnection_reason: 'user_hangup', metadata: { token: 'aaaa1111-x' }, call_cost: { combined_cost: 25 } },
    { start_timestamp: s, end_timestamp: s + 20e3, call_status: 'ended', disconnection_reason: 'voicemail_reached', metadata: { token: 'aaaa1111-x' } },
    { start_timestamp: s, call_status: 'not_connected', disconnection_reason: 'dial_no_answer', metadata: { token: 'bbbb2222-x' } },
    { start_timestamp: s, call_status: 'ongoing', metadata: {} },
    { start_timestamp: s, direction: 'inbound', call_status: 'ended' },
    { start_timestamp: s - 86400e3, call_status: 'ended', disconnection_reason: 'user_hangup' },
  ];
  const q = [{ token: 'aaaa1111-x', capped: false }, { token: 'cccc3333-x', capped: false }, { token: 'cccc3333-x', capped: true }];
  const a = aggregateCalls(calls, { dayStartMs: ilDayStartMs(T), queue: q, ticksLeft: 1, paceCalls: 6 });
  assert.deepEqual([a.dialed, a.answered, a.voicemail, a.no_answer, a.in_progress, a.inbound], [4, 1, 1, 1, 1, 1]);
  assert.equal(a.cost_usd, 0.25); assert.equal(a.queued, 2); assert.equal(a.remaining_today, 2); assert.equal(a.capacity_left_today, 6);
  assert.deepEqual(a.by_event.aaaa1111, { dialed: 2, answered: 1, voicemail: 1, no_answer: 0, in_progress: 0, queued: 1 });
  assert.equal(callBucket({ call_status: 'ended', end_timestamp: 1, start_timestamp: 1 }), 'no_answer');
});

test('compareRealtime: equal → ok; one row off → names the number', () => {
  const ts = ilDayStartMs(T) + 3600e3;
  const items = [{ kind: 'wa_out', ts, ok: true, data: { phone_id: 'A', template: 'hazmana_ishur' } }, { kind: 'wa_out', ts, ok: true, data: { phone_id: 'A', template: 'hazmana_ishur' } }];
  const rt = { today: T, audit_until_ts: ts, wa: { numbers: [{ phone_id: 'A', sent_today: 2, rejected_today: 0 }], totals: { sent_today: 2 } } };
  assert.equal(compareRealtime(rt, items).ok, true);
  rt.wa.numbers[0].sent_today = 3;
  const bad = compareRealtime(rt, items);
  assert.equal(bad.ok, false); assert.ok(bad.checks.find(c => c.check === 'wa.A.sent_today' && !c.ok));
});

test('helpers: Israel day start, ticks left, balance status', () => {
  assert.equal(ilDayOf(ilDayStartMs(T)), T); assert.notEqual(ilDayOf(ilDayStartMs(T) - 1), T);
  assert.equal(ilDayOf(ilDayStartMs('2026-07-01')), '2026-07-01');
  const tue1900 = Date.parse('2026-11-10T17:01:00Z');   /* 19:01 IL winter */
  assert.equal(ticksLeftToday(callWindowState, tue1900), 9);   /* 19:10 … 20:30 */
  assert.equal(balanceStatus(5, 10), 'low'); assert.equal(balanceStatus(50, 10), 'ok'); assert.equal(balanceStatus(null, 10), 'ok'); assert.equal(balanceStatus(5, 10, 'x'), 'error');
});

test('rolled plan: overflow spreads FIFO over the next open days, never on Shabbat / no-contact days, Friday capped', () => {
  const TUE = '2026-11-03';                 /* Tue; Fri 06/11, Shabbat 07/11, Sun 08/11 */
  const model = { capacity_per_day: 230, today_remaining: 68, verified: false, friday_capacity: 100 };
  const items = [it(TUE, 'ab699ac0', 176, 'subevent', { name: 'זגורי' }), it('2026-11-04', '6a3155cc', 507, 'w1', { name: 'מור ונועם' }), it('2026-11-05', 'held0000', 40, 'w2', { held: true })];
  const p = planCapacity({ today: TUE, days: 14, items, model, isNoContactDay: d => d === '2026-11-10' });
  const by = Object.fromEntries(p.days.map(d => [d.day, d]));
  assert.equal(by[TUE].out, 68); assert.deepEqual(by[TUE].rolled.map(x => [x.event, x.n, x.from_day]), [['זגורי', 68, TUE]]);
  assert.equal(by['2026-11-04'].out, 230);
  assert.deepEqual(by['2026-11-04'].rolled.map(x => [x.event, x.n, x.from_day]), [['זגורי', 108, TUE], ['מור ונועם', 122, '2026-11-04']]);
  assert.equal(by['2026-11-04'].rolled_in, 108);
  assert.equal(by['2026-11-05'].out, 230); assert.equal(by['2026-11-05'].rolled_in, 230);
  assert.equal(by['2026-11-06'].capacity, 100); assert.equal(by['2026-11-06'].out, 100);
  assert.equal(by['2026-11-07'].out, 0); assert.equal(by['2026-11-07'].rolled.length, 0);   /* Shabbat */
  assert.equal(by['2026-11-08'].out, 507 - 122 - 230 - 100);                                  /* Sunday: the rest = 55 */
  assert.equal(by['2026-11-10'].out, 0);                                                      /* no-contact day */
  assert.ok(p.days.every(d => d.rolled.every(x => x.type !== 'w2')), 'held items never roll');
  assert.equal(p.totals.out, 176 + 507); assert.equal(p.totals.unplaced, 0);
  const sum = p.days.reduce((n, d) => n + d.out, 0); assert.equal(sum, 683);
  assert.ok(p.days.every(d => d.out <= d.capacity));
});

test('rolled plan: what does not fit in the horizon is returned as unplaced; without friday_capacity Friday = full day', () => {
  const p = planCapacity({ today: '2026-11-03', days: 3, items: [it('2026-11-03', 'aaaa1111', 800)], model: { capacity_per_day: 230, today_remaining: 230 } });
  assert.deepEqual(p.days.map(d => d.out), [230, 230, 230]);
  assert.equal(p.totals.unplaced, 110); assert.equal(p.unplaced[0].from_day, '2026-11-03');
  const f = planCapacity({ today: '2026-11-06', days: 1, items: [it('2026-11-06', 'aaaa1111', 300)], model: { capacity_per_day: 230, today_remaining: 230 } });
  assert.equal(f.days[0].out, 230);
});
