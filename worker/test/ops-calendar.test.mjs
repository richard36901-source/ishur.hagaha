// node --test worker/test/ops-calendar.test.mjs — the pure calendar merge: chips per state, rolled + ghost, closed, counts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonth, sendsByDay, closedFromPay, callsByDay, planCapacity, monthDays } from '../ops.js';

const TODAY = '2026-11-03';
const ts = (day, h = 10) => Date.parse(day + 'T' + String(h - 2).padStart(2, '0') + ':00:00Z');   /* Israel = UTC+2 in Nov */
const EV = [{ token: 'aaaa1111-x', name: 'זוג א', date: '2026-11-09', occasion: 'חתונה', time: '19:30', client_id: 'C-501234567', waves: { 1: '2026-11-01', 2: '2026-11-04' } },
  { token: 'bbbb2222-x', name: 'זוג ב', date: '2026-11-30', occasion: 'חתונה', time: '20:00', waves: { 1: '2026-11-04' } }];

test('monthDays: whole month, Israel dates', () => { assert.equal(monthDays('2026-11').length, 30); assert.equal(monthDays('2026-02').length, 28); });

test('sendsByDay: per day/event/type counts; delivered and failed from statuses; templates kept', () => {
  const out = [
    { kind: 'wa_out', ts: ts('2026-11-01'), token: 'aaaa1111-x', ok: true, data: { template: 'ishur_hazmana', wamid: 'm1' } },
    { kind: 'wa_out', ts: ts('2026-11-01'), token: 'aaaa1111-x', ok: true, data: { template: 'ishur_hazmana', wamid: 'm2' } },
    { kind: 'wa_out', ts: ts('2026-11-01'), token: 'aaaa1111-x', ok: false, data: { template: 'ishur_hazmana', error: '131048' } },
    { kind: 'wa_out', ts: ts('2026-11-03'), token: 'cccc3333-s', ok: true, data: { template: 'ishur_shabbat_x', wamid: 'm3' } },
  ];
  const st = [{ kind: 'wa_status', data: { wamid: 'm1', status: 'delivered' } }, { kind: 'wa_status', data: { wamid: 'm1', status: 'read' } }, { kind: 'wa_status', data: { wamid: 'm2', status: 'failed' } }];
  const s = sendsByDay(out, st, { events: EV, subTemplates: new Set(['ishur_shabbat_x']) });
  const a = s.find(x => x.tok8 === 'aaaa1111');
  assert.deepEqual([a.day, a.type, a.sent, a.delivered, a.failed, a.template], ['2026-11-01', 'w1', 2, 1, 2, 'ishur_hazmana']);
  assert.equal(s.find(x => x.tok8 === 'cccc3333').type, 'subevent');
});

test('calendarMonth: done / partial with completion date / planned / held / rolled with a ghost on the original day', () => {
  const plan = planCapacity({ today: TODAY, days: 7, model: { capacity_per_day: 230, today_remaining: 68 },
    items: [{ day: TODAY, token: 'cccc3333-s', tok8: 'cccc3333', name: 'שבת חתן', type: 'subevent', count: 176 }, { day: '2026-11-04', token: 'bbbb2222-x', tok8: 'bbbb2222', name: 'זוג ב', type: 'w1', count: 507 }] });
  const board = { events: [
    { short: 'aaaa1111', name: 'זוג א', held: false, types: [{ key: 'w1', due: '2026-11-01', audience: 40, sent: 30, delivered: 25, failed: { total: 2 }, pending: { total: 10, hold: 0, queue: 10 } }, { key: 'w2', due: '2026-11-04', audience: 12, sent: 0, pending: { total: 12, hold: 12 } }] },
    { short: 'bbbb2222', name: 'זוג ב', held: false, types: [{ key: 'w1', due: '2026-11-04', audience: 507, sent: 0, pending: { total: 507, scheduled: 507, hold: 0 } }] }],
    subevents: [{ token: 'cccc3333-s', name: 'שבת חתן', template: 'ishur_shabbat_x', types: [{ key: 'shabbat', invited: 176, sent: 0, pending: 176 }] }] };
  const sends = [{ day: '2026-11-01', tok8: 'aaaa1111', type: 'w1', sent: 30, delivered: 25, failed: 2, template: 'ishur_hazmana' }];
  const cal = calendarMonth({ month: '2026-11', today: TODAY, events: EV, board, capDays: plan.days, sends, perDay: 230, fridayCap: 230,
    calls: { done: [{ day: '2026-11-02', tok8: 'aaaa1111', n: 9, answered: 4 }], planned: [{ day: TODAY, tok8: 'aaaa1111', n: 6 }] },
    closed: [{ day: '2026-11-02', at: '2026-11-02T09:00:00Z', ref: 'r1', event: 'זוג א', package: 'פרמיום', records: 300, sum: 1490 }] });
  const day = d => cal.days.find(x => x.date === d);
  assert.equal(cal.days.length, 30);
  const w1 = day('2026-11-01').items.find(i => i.type === 'w1');
  assert.equal(w1.state, 'partial'); assert.equal(w1.sent, 30); assert.equal(w1.of, 40); assert.equal(w1.template, 'ishur_hazmana');
  assert.equal(day('2026-11-01').used, 30);
  const held = cal.days.flatMap(d => d.items).find(i => i.state === 'held');
  assert.deepEqual([held.tok8, held.type, held.n], ['aaaa1111', 'w2', 12]);
  /* rolled: 108 of the sub-event moved 03/11 → 04/11; ghost left on 03/11 */
  const t = day(TODAY), w = day('2026-11-04');
  assert.ok(t.items.some(i => i.state === 'planned' && i.type === 'subevent' && i.n === 68));
  const ghost = t.items.find(i => i.state === 'ghost'); assert.deepEqual([ghost.n, ghost.to_day], [108, '2026-11-04']);
  const rolled = w.items.find(i => i.state === 'rolled'); assert.deepEqual([rolled.n, rolled.from_day, rolled.type], [108, TODAY, 'subevent']);
  assert.ok(w.items.some(i => i.state === 'planned' && i.tok8 === 'bbbb2222' && i.n === 122));
  assert.equal(w.used, 230); assert.equal(w.capacity, 230);
  assert.equal(day('2026-11-07').closed_reason, 'shabbat'); assert.equal(day('2026-11-07').items.length, 0);
  assert.equal(day('2026-11-06').limited, 'friday');
  assert.ok(day('2026-11-02').items.some(i => i.kind === 'call' && i.state === 'done' && i.answered === 4));
  assert.ok(t.items.some(i => i.kind === 'call' && i.state === 'planned' && i.n === 6));
  const cl = day('2026-11-02').items.find(i => i.kind === 'closed'); assert.deepEqual([cl.package, cl.records, cl.sum], ['פרמיום', 300, 1490]);
  assert.deepEqual(day('2026-11-09').events, [{ tok8: 'aaaa1111', name: 'זוג א', type: 'חתונה', time: '19:30' }]);
  assert.ok(cal.events.some(e => e.tok8 === 'bbbb2222'));
  /* every message of the plan is on exactly one non-ghost chip */
  const placed = cal.days.flatMap(d => d.items).filter(i => i.kind === 'send' && ['planned', 'rolled'].includes(i.state)).reduce((n, i) => n + i.n, 0);
  assert.equal(placed, plan.totals.out);
});

test('closedFromPay: ishur packages only, deduped by asmachta, matched to the event by client id; callsByDay counts Shir only', () => {
  const parse = d => /רשומות/.test(d) ? { tier: Number(d.match(/(\d+)/)[1]), planText: 'פרמיום', hostess: 0 } : null;
  const rows = [
    { kind: 'pay', ts: ts('2026-11-02'), data: { ipn: { paymentDesc: '300 רשומות פרמיום', paymentSum: '1490', asmachta: 'A1', payerPhone: '0501234567', fullName: 'X' } } },
    { kind: 'pay', ts: ts('2026-11-02'), data: { ipn: { paymentDesc: '300 רשומות פרמיום', paymentSum: '1490', asmachta: 'A1', payerPhone: '0501234567' } } },
    { kind: 'pay', ts: ts('2026-11-02'), data: { ipn: { paymentDesc: 'עסק אחר', paymentSum: '99', asmachta: 'A2' } } },
  ];
  const c = closedFromPay(rows, { parsePaidDesc: parse, events: EV });
  assert.equal(c.length, 1); assert.deepEqual([c[0].day, c[0].event, c[0].tok8, c[0].records, c[0].sum, c[0].package], ['2026-11-02', 'זוג א', 'aaaa1111', 300, 1490, 'פרמיום']);
  const k = callsByDay([{ kind: 'call', ts: ts('2026-11-02'), token: 'aaaa1111-x', data: { agent: 'שיר', outcome: 'מגיע' } }, { kind: 'call', ts: ts('2026-11-02'), token: 'aaaa1111-x', data: { agent: 'שיר' } }, { kind: 'call', ts: ts('2026-11-02'), token: 'zzzz', data: { agent: 'נועה' } }]);
  assert.deepEqual(k, [{ day: '2026-11-02', tok8: 'aaaa1111', name: '', n: 2, answered: 1 }]);
});
