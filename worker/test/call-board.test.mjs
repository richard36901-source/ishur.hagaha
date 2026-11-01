// node --test worker/test/call-board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { aggregateCalls, classify } = require('../../assets/callboard.js');

const NOW = Date.parse('2026-11-01T18:00:00Z');
const row = (id, data, extra = {}) => ({ kind: 'call', ts: NOW - 3600e3, at: '', area: 'שיר', phone: '972500000001', token: 'c1c5fcf5-x', cost: 0.5, detail: 'שיר: שלום', event: { event: 'אורי', date: '2026-11-02' },
  data: { call_id: id, guest_name: 'אילן', guest_id: 'G1', event_name: 'אורי', outcome: '', answer: '', duration_s: 0, recording: '', disconnection: '', ...data }, ...extra });

test('classify follows the webhook rules (shir.js:528-575)', () => {
  assert.deepEqual(classify(row('a', { disconnection: 'voicemail_reached' })), { reach: 'voicemail', outcome: '' });
  assert.equal(classify(row('b', { disconnection: 'dial_no_answer', answer: 'לא ענה' })).reach, 'noanswer');
  assert.equal(classify(row('c', { outcome: 'מגיע', answer: 'ענה', duration_s: 40, disconnection: 'user_hangup' })).outcome, 'coming');
  assert.equal(classify(row('d', { outcome: '__keep__', answer: 'ביקש לא להתקשר יותר', duration_s: 20 })).reach, 'dnc');
  assert.equal(classify(row('e', { outcome: '__keep__', answer: 'שיחה ללא תוצאה ברורה', duration_s: 6, disconnection: 'user_hangup' })).outcome, 'redial');
  assert.equal(classify(row('f', { duration_s: 30, disconnection: 'user_hangup' }), true).outcome, 'transfer');
});

test('per event: queue, dialed, outcomes, tries, cost, avg duration', () => {
  const board = {
    window: { open: false, next: 'בחלון הבא' },
    waiting: [
      { kind: 'guest', name: 'א', phone: '972500000055', event: 'גל', event_date: '2026-10-13', tries: 0, max_tries: 1, state: 'waiting' },
      { kind: 'guest', name: 'ב', phone: '972500000009', event: 'אורי', event_date: '2026-11-02', tries: 1, max_tries: 1, state: 'capped' },
      { kind: 'guest', name: 'ג', phone: '972500000008', event: 'אורי', event_date: '2026-11-02', tries: 0, max_tries: 1, state: 'waiting' },
      { kind: 'lead', name: 'ליד', phone: '972500000007', state: 'waiting' },
    ],
    done: [{ id: 'x3', state: 'problem' }],
  };
  const rows = [
    row('x1', { outcome: 'מגיע', answer: 'ענה', duration_s: 40, disconnection: 'user_hangup' }),
    row('x2', { disconnection: 'dial_no_answer', answer: 'לא ענה' }, { cost: 0 }),
    row('x3', { duration_s: 20, disconnection: 'user_hangup' }),
    row('old', { outcome: 'לא מגיע', duration_s: 30, disconnection: 'user_hangup' }, { ts: NOW - 3 * 864e5 }),
  ];
  const today = aggregateCalls({ board, rows, range: 'today', now: NOW });
  const uri = today.events.find(e => e.name === 'אורי');
  assert.equal(uri.queue.waiting, 1);
  assert.equal(uri.queue.capped, 1);
  assert.equal(uri.dialed, 3);
  assert.equal(uri.answered, 2);
  assert.equal(uri.noanswer, 1);
  assert.equal(uri.outcomes.coming, 1);
  assert.equal(uri.outcomes.transfer, 1, 'needs_review on the Retell board → להעביר לריצארד');
  assert.equal(uri.avg_duration_s, 30);
  assert.equal(uri.cost_today, 1);
  assert.equal(uri.tries, 1); assert.equal(uri.max_tries, 2);
  // Gal: event passed → never dialed (shouldDial) → shown as "past", not "בתור"
  const gal = today.events.find(e => e.name === 'גל');
  assert.equal(gal.queue.past, 1);
  assert.equal(gal.queue.waiting, 0);
  assert.equal(gal.dialed, 0);
  const week = aggregateCalls({ board, rows, range: '7', now: NOW }).events.find(e => e.name === 'אורי');
  assert.equal(week.dialed, 4);
  assert.equal(week.outcomes.not_coming, 1);
  assert.equal(week.cost_total, 1.5, '0.5 + 0 (x2) + 0.5 + 0.5');
  assert.equal(week.cost_today, 1, 'x1 + x3 only');
});
