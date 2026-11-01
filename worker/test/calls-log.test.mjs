// node --test worker/test/calls-log.test.mjs
// Synthetic data only: no real names or phones (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, dayList, rowFromAudit, rowFromSheet, classifyCall, matches, toCsv, decodeCursor, nextAttempt, handleCallsLog } from '../calls-log.js';

const at = (day, hh, mm = 0) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`);
const rec = (id, day, hh, data = {}, extra = {}) => ({ kind: 'call', ts: at(day, hh), at: '', area: data.agent || 'שיר', phone: '972500000' + String(id).padStart(3, '0').slice(-3), token: 'tok-aaaa', cost: 0.37, detail: 'שיר: שלום',
  event: { event: 'אירוע א', date: '2026-11-02' }, data: { call_id: 'call_' + id, guest_name: 'אורח ' + id, guest_id: 'G' + id, event_name: 'אירוע א', outcome: '', answer: '', duration_s: 0, disconnection: 'dial_no_answer', agent: 'שיר', ...data }, ...extra });

/* three IL days, newest first: 01/11 has 3 calls, 31/10 none, 30/10 has 2 */
const DB = {
  '2026-11-01': [rec(1, '2026-11-01', 10), rec(2, '2026-11-01', 11, { outcome: 'מגיע', answer: 'ענה', duration_s: 40, disconnection: 'user_hangup' }), rec(3, '2026-11-01', 12, { outcome: '__keep__', answer: 'שיחה ללא תוצאה ברורה', duration_s: 6, disconnection: 'user_hangup' })],
  '2026-10-31': [],
  '2026-10-30': [rec(4, '2026-10-30', 10, { agent: 'נועה' }), rec(5, '2026-10-30', 11, { duration_s: 20, disconnection: 'user_hangup', outcome: 'לא מגיע', answer: 'ענה' })],
};
const readDay = async d => (DB[d] || []).map(rowFromAudit);
const days = dayList('2026-10-30', '2026-11-01');

test('dayList is newest first and inclusive', () => {
  assert.deepEqual(days, ['2026-11-01', '2026-10-31', '2026-10-30']);
  assert.deepEqual(dayList('2026-11-02', '2026-11-01'), []);
});

test('cursor walks across day boundaries: every row once, newest first', async () => {
  const seen = []; let cursor = null, pages = 0;
  do {
    const p = await paginate({ days, readDay, cursor, limit: 2 });
    seen.push(...p.rows.map(r => r.id)); cursor = p.cursor; pages++;
    assert.ok(pages < 10, 'terminates');
  } while (cursor);
  assert.deepEqual(seen, ['call_3', 'call_2', 'call_1', 'call_5', 'call_4']);
  assert.equal(pages, 3);
});

test('page 1 ends mid-day → cursor points inside that day', async () => {
  const p = await paginate({ days, readDay, limit: 2 });
  const c = decodeCursor(p.cursor);
  assert.equal(c.day, '2026-11-01');
  assert.equal(c.id, 'call_2');
});

test('a filter that empties a page: rows [] but a cursor while days remain (maxDays bound)', async () => {
  const p = await paginate({ days, readDay, limit: 100, filter: { agent: 'נועה' }, maxDays: 2 });
  assert.equal(p.rows.length, 0);
  assert.equal(p.partial, true);
  assert.equal(decodeCursor(p.cursor).day, '2026-10-30');
  assert.deepEqual(p.day_counts['2026-11-01'], { calls: 0, review: 0 });
  const p2 = await paginate({ days, readDay, limit: 100, filter: { agent: 'נועה' }, cursor: p.cursor, maxDays: 2 });
  assert.deepEqual(p2.rows.map(r => r.id), ['call_4']);
  assert.equal(p2.cursor, null);
});

test('a filter with nothing anywhere ends with cursor null', async () => {
  const p = await paginate({ days, readDay, limit: 100, filter: { q: 'אין-כזה' } });
  assert.deepEqual(p.rows, []);
  assert.equal(p.cursor, null);
});

test('classify + review rule', () => {
  assert.equal(classifyCall({ outcome: '', answer: '', dur: 0, disc: 'dial_no_answer' }).state, 'noanswer');
  assert.equal(classifyCall({ outcome: '', answer: '', dur: 0, disc: 'voicemail_reached' }).voicemail, true);
  assert.deepEqual(classifyCall({ outcome: 'מגיע', answer: 'ענה', dur: 40, disc: 'user_hangup' }), { state: 'done', review: false, voicemail: false });
  assert.equal(classifyCall({ outcome: '', answer: 'שיחה ללא תוצאה ברורה', dur: 6, disc: 'user_hangup' }).review, true);
  assert.equal(classifyCall({ outcome: '', answer: '', dur: 3, disc: 'error_llm_websocket_open' }).state, 'failed');
  const r = rowFromAudit(rec(9, '2026-11-01', 9, {}, { phone: '972555074446' }));
  assert.equal(r.kind, 'inbound', 'our own line stored as phone = inbound');
  assert.equal(r.phone, '');
  assert.equal(matches(rowFromAudit(DB['2026-11-01'][2]), { state: 'review' }), true);
});

test('CSV: BOM, Hebrew header, quoting, formula guard, local phone', () => {
  const rows = DB['2026-11-01'].map(rowFromAudit);
  rows[0].summary = '=HYPERLINK("x")'; rows[0].name = 'א"ב';
  const csv = toCsv(rows);
  assert.ok(csv.startsWith('﻿"תאריך"'));
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[1].includes('"א""ב"'));
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines[1].includes('"0500000001"'));
  assert.ok(!toCsv(rows, false).startsWith('﻿'));
});

test('sheet rows (before the audit log) parse into the same shape', () => {
  const r = rowFromSheet(['20/10/2026 12:30:05', 'שיר', 'יוצאת', '972500000777', 'אורח ש', 'אורח (אישור הגעה)', 'tok', 'הסתיימה', '35', 'מגיע', 'סיכום', 'Positive', '0.4', 'user_hangup', 'call_s1']);
  assert.equal(r.day, '2026-10-20'); assert.equal(r.state, 'done'); assert.equal(r.review, false); assert.equal(r.kind, 'guest');
  assert.equal(rowFromSheet(['not a date']), null);
});

test('next attempt: capped, past event, open window, tried today', () => {
  const cws = d => { const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(d)); return { open: h >= 10 && h < 20 }; };
  const now = at('2026-11-02', 11);
  assert.equal(nextAttempt({ state: 'capped' }, { now, today: '2026-11-02', callWindowState: cws }).he, 'מוצה');
  assert.match(nextAttempt({ state: 'waiting', event_date: '2026-10-13' }, { now, today: '2026-11-02', callWindowState: cws }).he, /האירוע עבר/);
  assert.equal(nextAttempt({ state: 'waiting', event_date: '2026-11-09' }, { now, today: '2026-11-02', callWindowState: cws }).at, now);
  const t = nextAttempt({ state: 'waiting', event_date: '2026-11-09' }, { now, today: '2026-11-02', callWindowState: cws, lastCallDay: '2026-11-02' }).at;
  assert.ok(t > now && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(t)) === '2026-11-03');
});

test('the route is read-only: zero KV put/delete, count_day + csv + queue', async () => {
  const writes = [];
  const RATE = { get: async () => null, list: async () => ({ keys: [], list_complete: true }), put: async (k) => writes.push('put ' + k), delete: async (k) => writes.push('del ' + k) };
  const env = { RATE };
  const deps = {
    isAdmin: (e, k) => k === 'K', okJson: (o) => new Response(JSON.stringify(o)), deny: (s, r) => new Response(JSON.stringify({ ok: false, error: r }), { status: s }), cors: () => ({}),
    auditQuery: async (e, q) => { assert.equal(q.from, q.to, 'one day per read'); const d = `${q.from.slice(0, 4)}-${q.from.slice(4, 6)}-${q.from.slice(6)}`; return DB[d] || []; },
    ilDate: () => '2026-11-01', callWindowState: () => ({ open: false, why: 'hours' }),
    fetchSnapshot: async () => ({}), buildCallQueue: () => ({ queue: [{ guest_id: 'G7', name: 'אורח 7', phone: '972500000007', event_name: 'אירוע ב', event_date: '2026-10-13', tries: 0, max_tries: 1, capped: false }] }),
    kvPrefix: async () => ({ '972500000008': JSON.stringify({ name: 'ליד 8', occ: 'חתונה' }) }),
  };
  const call = async b => handleCallsLog(new Request('https://x/api/calls-log', { method: 'POST', body: JSON.stringify(b) }), env, '', deps);
  assert.equal((await call({ admin_key: 'no' })).status, 403);
  const j = await (await call({ admin_key: 'K', from: '2026-10-30', to: '2026-11-01', queue: true })).json();
  assert.equal(j.rows.length, 5); assert.equal(j.cursor, null);
  assert.equal(j.queue.length, 2);
  assert.equal(j.queue[0].state, 'past'); assert.match(j.queue[0].next_he, /האירוע עבר/);
  const c = await (await call({ admin_key: 'K', count_day: '2026-11-01' })).json();
  assert.deepEqual([c.calls, c.review], [3, 1]);
  const csv = await (await call({ admin_key: 'K', from: '2026-10-30', to: '2026-11-01', format: 'csv' })).text();
  assert.equal(csv.split('\r\n').length, 6);
  assert.deepEqual(writes, [], 'no KV writes at all');
});
