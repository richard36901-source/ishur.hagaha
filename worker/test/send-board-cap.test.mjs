// node --test worker/test/send-board-cap.test.mjs — 02/11 send board: codes, gift type, cap + 3-day plan
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSendBoard, typeOf, plannedByDay, capBoard, handleSendBoard, BOARD_CODES } from '../send-board.js';
import { planVsCapacity, numberState, capacity } from '../budget.js';

const TOK = 'ec9f3b84-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-11-03T07:00:00Z');
const g = (n, rsvp = 'מגיע', table = '') => ({ name: 'אורח ' + n, phone: '97250000000' + n, id: 'G' + n, rsvp, table });
const out = (n, wamid, tmpl) => ({ kind: 'wa_out', ts: T0 + n, at: '', ok: true, token: TOK, phone: '97250000000' + n, detail: '', data: { phone_id: '1107514695777584', wamid, template: tmpl, error: '' } });
const fail = (n, wamid, code) => ({ kind: 'wa_status', ts: T0 + n + 1000, at: '', token: '', phone: '97250000000' + n, detail: code + ' x', data: { wamid, status: 'failed', wave: '' } });

test('failures are broken out by Meta code; the board codes are the five Richard named', () => {
  assert.deepEqual(BOARD_CODES, ['131048', '131049', '131047', '131042', '130472']);
  const ev = { token: TOK, name: 'א', date: '2026-11-04', plan: 'premium', waves: { 1: '', 2: '', 3: '' }, held: false, eventday: null };
  const r = aggregateSendBoard({ today: '2026-11-03', events: [ev], guests: { [TOK]: [g(1), g(2), g(3)] },
    waOut: [out(1, 'A', 'ishur_yom_lifnei_f'), out(2, 'B', 'ishur_yom_lifnei_f'), out(3, 'C', 'ishur_yom_lifnei_f')],
    waStatus: [fail(1, 'A', '131049'), fail(2, 'B', '131049'), fail(3, 'C', '131042')],
    markers: { [`${TOK}|daybefore|972500000001`]: { m: '1' }, [`${TOK}|daybefore|972500000002`]: { m: '1' }, [`${TOK}|daybefore|972500000003`]: { m: '1' } },
    gates: { window: { open: true } } });
  const db = r.events[0].types.find(t => t.key === 'daybefore');
  assert.equal(db.failed.total, 3);
  assert.deepEqual(db.failed.codes, { 131049: 2, 131042: 1 });
});

test('typeOf: table twins and gift templates', () => {
  assert.equal(typeOf({ template: 'ishur_shulchan_f' }), 'table');
  assert.equal(typeOf({ template: 'ishur_shulchan_matana' }), 'table');
  assert.equal(typeOf({ template: 'ishur_yom_haerua_matana' }), 'eventday');
  assert.equal(typeOf({ template: 'ishur_matana' }), 'gift');
  assert.equal(typeOf({ template: 'ishur_toda_matana' }), 'thanks');
  assert.equal(typeOf({ template: 'ishur_toda_matana', wave: 'gift' }), 'gift');
});

test('gift type: audience = declined guests, only when links are on; due the day after', () => {
  const ev = { token: TOK, name: 'א', date: '2026-11-02', plan: 'premium', waves: { 1: '', 2: '', 3: '' }, held: false, eventday: null, gift_on: true };
  const guests = { [TOK]: [g(1), g(2, 'לא מגיע'), g(3, 'לא מגיע')] };
  const mk = { [`${TOK}|gift|972500000002`]: { m: '{"via":"decline"}' } };
  const r = aggregateSendBoard({ today: '2026-11-03', events: [ev], guests, markers: mk, gates: { window: { open: true } } });
  const gift = r.events[0].types.find(t => t.key === 'gift');
  assert.equal(gift.audience, 2); assert.equal(gift.sent, 1); assert.equal(gift.due, '2026-11-03');
  assert.equal(gift.pending.queue, 1);
  const off = aggregateSendBoard({ today: '2026-11-03', events: [{ ...ev, gift_on: false }], guests, gates: { window: { open: true } } });
  assert.ok(!off.events[0].types.find(t => t.key === 'gift'));
});

test('plannedByDay: today = queue+window+cap+reopened (holds excluded); later days = scheduled', () => {
  const events = [{ types: [
    { due: '2026-11-03', pending: { queue: 10, window: 5, cap: 20, reopened: 2, hold: 99, scheduled: 0 } },
    { due: '2026-11-04', pending: { scheduled: 300 } },
    { due: '2026-11-09', pending: { scheduled: 50 } },
  ] }];
  assert.deepEqual(plannedByDay(events, '2026-11-03', 3), { '2026-11-03': 37, '2026-11-04': 300 });
});

test('capBoard: red warning when the plan is over the room, numbers labelled', () => {
  const cap = capacity([numberState({ id: '1107514695777584', limit: 250, dayUsed: 240 }), numberState({ id: '1409632775565601', limit: 250, dayUsed: 0 })], { scope: 'portfolio', portfolioLimit: 250 });
  const plan = planVsCapacity({ '2026-11-03': 37, '2026-11-04': 300 }, { today: '2026-11-03', remainingNow: cap.remaining, limit: cap.limit });
  const b = capBoard(cap, plan);
  assert.equal(b.remaining, 10); assert.equal(b.warning, true);
  assert.deepEqual(b.plan.map(d => d.over), [true, true, false]);
  assert.equal(b.numbers[0].label, '055-972-6673'); assert.equal(b.numbers[1].label, '055-308-9799');
});

test('route: the cap section is attached (and recomputed even on a cache hit)', async () => {
  const store = new Map();
  const env = { RATE: { get: async k => store.has(k) ? store.get(k) : null, put: async (k, v) => { store.set(k, String(v)); }, list: async () => ({ keys: [] }) } };
  let capCalls = 0;
  const deps = {
    isAdmin: () => true, okJson: (d) => d, deny: (s, e) => ({ denied: e }),
    snapshotCached: async () => ({ events: { values: [] }, guests: { values: [] } }),
    auditQuery: async () => [], isTestEventRow: () => false, planKeyOf: () => 'premium',
    ilDate: (d) => '2026-11-03', sendWindowState: () => ({ open: true }), sendingPaused: async () => false,
    kvPrefix: async () => ({}), guestPhoneIds: () => ['A', 'B'],
    guestCapacity: async () => { capCalls++; return capacity([numberState({ id: 'A', limit: 250, dayUsed: capCalls * 10 })], { scope: 'portfolio', portfolioLimit: 250 }); },
  };
  const req = () => ({ json: async () => ({ admin_key: 'k' }) });
  const a = await handleSendBoard(req(), env, '*', deps);
  assert.equal(a.cap.remaining, 240); assert.equal(a.cap.plan.length, 3); assert.equal(a.cap.warning, false);
  const b = await handleSendBoard(req(), env, '*', deps);
  assert.equal(b.cached, true); assert.equal(b.cap.remaining, 230, 'fresh cap on a cached board');
});
