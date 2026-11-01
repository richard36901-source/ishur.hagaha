// node --test worker/test/send-board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSendBoard, typeOf, failGroup, codeOf, phoneLabel, eventsFromRaw } from '../send-board.js';

const TOK = 'ec9f3b84-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-11-01T07:00:00Z');
const ev = { token: TOK, name: 'הדר ויצחק', date: '2026-11-02', plan: 'basic', waves: { 1: '2026-10-18', 2: '2026-10-23', 3: '' }, held: false, eventday: null };
const g = (n, rsvp = 'מגיע', table = '') => ({ name: 'אורח ' + n, phone: '97250000000' + n, id: 'G' + n, rsvp, table });
const guests = { [TOK]: [g(1), g(2), g(3), g(4), g(5), g(6, 'לא מגיע'), g(7, 'מגיע', '12')] };
const out = (n, wamid, tmpl, extra = {}) => ({ kind: 'wa_out', ts: T0 + n, at: new Date(T0 + n).toISOString(), ok: true, token: TOK, phone: '97250000000' + n, detail: '', data: { phone_id: '1107514695777584', wamid, template: tmpl, error: '' }, ...extra });
const st = (n, wamid, status, code = '', dt = 1000) => ({ kind: 'wa_status', ts: T0 + n + dt, at: '', token: '', phone: '97250000000' + n, detail: status === 'failed' ? code + ' Spam Rate limit hit' : 'marketing', data: { wamid, status, wave: '' } });

const base = () => ({
  today: '2026-11-01', now: T0 + 1e6, events: [ev], guests,
  waOut: [
    out(1, 'A', 'ishur_yom_lifnei_f'), out(2, 'B', 'ishur_yom_lifnei_f'), out(3, 'C', 'ishur_yom_lifnei_f'), out(4, 'D', 'ishur_yom_lifnei_f'),
    out(7, 'E', 'ishur_shulchan', { token: '' }),   // table messages carry no token (index.js:5090)
  ],
  waStatus: [
    st(1, 'A', 'delivered'), st(1, 'A', 'read', '', 5000),
    st(2, 'B', 'delivered'),
    st(3, 'C', 'failed', '131048'),
    st(4, 'D', 'failed', '131026'),
    st(7, 'E', 'delivered'),
  ],
  waIn: [{ kind: 'wa_in', phone: '972500000001', ts: T0 + 9000 }],
  gates: { paused: false, cap_all: false, window: { open: false, why: 'hours' } },
  coverageFrom: '2026-10-22',
});

test('per-type counts come from wa_status joined to wa_out by wamid', () => {
  const r = aggregateSendBoard(base());
  const e = r.events[0];
  assert.equal(e.invited, 7);
  const db = e.types.find(t => t.key === 'daybefore');
  assert.equal(db.audience, 6, 'confirmed guests only (6 is לא מגיע)');
  assert.equal(db.sent, 4, 'four accepted by Meta');
  assert.equal(db.delivered, 2, 'A (read) + B');
  assert.equal(db.read, 1);
  // C hit the cap: reopened → ממתין, not נכשל (rule inference, no markers)
  assert.equal(db.pending.reopened, 1);
  // D 131026: never retried (index.js:2944) → final failure, group לא בוואטסאפ
  assert.equal(db.failed.total, 1);
  assert.equal(db.failed.notwa, 1);
  // guest 5 + guest 7 never got a day-before; window is closed
  assert.equal(db.pending.window, 2);
  assert.equal(db.pending.total, 3);
  assert.ok(db.inferred > 0, 'decision made without markers is flagged');
  assert.equal(db.answered, 1, 'guest 1 replied after the send');
  assert.equal(db.people.read[0].number, '055-972-6673');
});

test('a table message without a token is placed by the guest phone', () => {
  const e = aggregateSendBoard(base()).events[0];
  const tb = e.types.find(t => t.key === 'table');
  assert.equal(tb.audience, 1);
  assert.equal(tb.sent, 1);
  assert.equal(tb.delivered, 1);
});

test('the engine marker overrides inference: marker still set → final failure', () => {
  const inp = base();
  inp.markers = { [`${TOK}|daybefore|972500000003`]: { m: '1', wst: null, err: null, dead: null } };
  const db = aggregateSendBoard(inp).events[0].types.find(t => t.key === 'daybefore');
  assert.equal(db.pending.reopened, 0);
  assert.equal(db.failed.cap, 1);
  assert.equal(db.failed.total, 2);
});

test('marker gone → reopened, even for a non-cap code', () => {
  const inp = base();
  inp.markers = { [`${TOK}|daybefore|972500000004`]: { m: null, wst: null, err: null, dead: null } };
  const db = aggregateSendBoard(inp).events[0].types.find(t => t.key === 'daybefore');
  assert.equal(db.failed.total, 0);
  assert.equal(db.pending.reopened, 2);
});

test('waves before the audit log are "unknown", never "not sent"', () => {
  const e = aggregateSendBoard(base()).events[0];
  const w1 = e.types.find(t => t.key === 'w1');
  assert.equal(w1.sent, 0);
  assert.equal(w1.pending.total, 0);
  assert.equal(w1.unknown, 6, 'everyone but the decliner');
});

test('KV marker path: wst delivered counts as delivered without an audit row', () => {
  const inp = base();
  inp.markers = { [`${TOK}|w1|972500000002`]: { m: '1', wst: 'read', err: null, dead: null } };
  const w1 = aggregateSendBoard(inp).events[0].types.find(t => t.key === 'w1');
  assert.equal(w1.delivered, 1);
  assert.equal(w1.read, 1);
  assert.equal(w1.sources.kv, 1);
});

test('holds and caps explain a never-sent guest', () => {
  const inp = base(); inp.events = [{ ...ev, held: true }];
  let db = aggregateSendBoard(inp).events[0].types.find(t => t.key === 'daybefore');
  assert.equal(db.pending.hold, 2);
  inp.events = [ev]; inp.gates = { cap_all: true, window: { open: true } };
  db = aggregateSendBoard(inp).events[0].types.find(t => t.key === 'daybefore');
  assert.equal(db.pending.cap, 2);
});

test('typeOf: one invite template, three waves, split by the IL date', () => {
  assert.equal(typeOf({ template: 'hazmana_ishur_img_u', at: Date.parse('2026-10-18T08:00:00Z') }, ev), 'w1');
  assert.equal(typeOf({ template: 'hazmana_ishur_img_u', at: Date.parse('2026-10-23T08:00:00Z') }, ev), 'w2');
  assert.equal(typeOf({ template: 'x', wave: 'eventday' }, ev), 'eventday');
  assert.equal(typeOf({ template: 'ishur_toda_orach_v2' }, ev), 'thanks');
  assert.equal(typeOf({ template: '' }, ev), null);
});

test('Meta codes → Hebrew groups', () => {
  assert.equal(failGroup('131048'), 'cap');
  assert.equal(failGroup('131026'), 'notwa');
  assert.equal(failGroup('130472'), 'experiment');
  assert.equal(failGroup('131050'), 'blocked');
  assert.equal(failGroup('131049'), 'other');
  assert.equal(failGroup('999999'), 'other');
  assert.equal(codeOf('131048 Spam Rate limit hit'), '131048');
  assert.equal(codeOf('131049: blah'), '131049');
  assert.equal(phoneLabel('1409632775565601'), '055-308-9799');
});

test('eventsFromRaw keeps the wave-audit filter (paid, not cancelled, file up)', () => {
  const row = (tok, paid = 'כן', cancel = '', file = 'כן') => { const r = Array(45).fill(''); r[1] = tok; r[2] = 'לקוח'; r[6] = '2026-11-02'; r[7] = paid; r[27] = cancel; r[43] = file; r[39] = '2026-10-18'; return r; };
  const graw = Array(31).fill(''); graw[28] = TOK; graw[3] = 'דנה'; graw[4] = '050-1234567'; graw[15] = 'מגיע';
  const raw = { events: { values: [row(TOK), row('aaaaaaaa-1', 'לא'), row('bbbbbbbb-1', 'כן', 'כן')] }, guests: { values: [graw] } };
  const { events, guests: gs } = eventsFromRaw(raw, '2026-11-01');
  assert.equal(events.length, 1);
  assert.equal(gs[TOK][0].phone, '972501234567');
});
