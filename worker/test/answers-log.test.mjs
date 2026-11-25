/* 25/11/2026: the answers log - who answered, how, and the proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { methodOf, rowOf, listRows, eventsOf, handleAnswersLog } from '../answers-log.js';

const T = '851832d9-0000-4000-8000-000000000000';
const G = (id, name, rsvp, n, w, note, at) => { const g = Array(31).fill(''); g[2] = id; g[3] = name; g[4] = '97250000000' + id.slice(-1); g[5] = '2'; g[13] = n || ''; g[15] = rsvp || ''; g[22] = w || ''; g[24] = note || ''; g[25] = at || ''; g[28] = T; return g; };
const guests = [G('G-1', 'דנה', 'מגיע', '2', 'ענה בוואטסאפ', '', '2026-11-20T10:00:00Z'), G('G-2', 'רון', 'מגיע', '1', 'ענה', '', '2026-11-24T10:00:00Z'), G('G-3', 'מיה', 'לא מגיע', '', 'סומן ידנית (מארח)', '', '2026-11-25T10:00:00Z'),
  G('G-4', 'גל', 'מגיע', '1', '', 'נרשם מהקישור · לא בהודעות', '2026-11-21T10:00:00Z'), G('G-5', 'טל', '', '', 'לא ענה', ''), G('G-6', 'נועה', 'מתלבט', '', 'ענה - מתלבט', '', '2026-11-22T10:00:00Z'), G('G-7', 'שי', 'לא מגיע', '', 'לא ענה', '', '2026-11-23T10:00:00Z')];
const ev = Array(45).fill(''); ev[1] = T; ev[2] = 'שילת'; ev[34] = 'שילת ושי'; ev[6] = '2026-11-26';
const raw = { events: { values: [ev] }, guests: { values: guests } };

test('how an answer was given is read from the row', () => {
  assert.deepEqual(guests.map(methodOf), ['wa', 'call', 'manual', 'link', 'none', 'call', 'unknown']);
  assert.equal(rowOf(guests[1]).method_he, 'שיחת טלפון');
});

test('the list filters, counts seats and puts the newest answer first', () => {
  const all = listRows(raw, T);
  assert.equal(all.counts.all, 7); assert.equal(all.counts.confirmed, 3); assert.equal(all.counts.seats, 4); assert.equal(all.counts.none, 1); assert.equal(all.counts.manual, 2);
  assert.deepEqual(listRows(raw, T, { filter: 'confirmed' }).rows.map(r => r.id), ['G-2', 'G-4', 'G-1']);
  assert.deepEqual(listRows(raw, T, { filter: 'call' }).rows.map(r => r.id), ['G-2', 'G-6']);
  assert.deepEqual(listRows(raw, T, { q: 'מיה' }).rows.map(r => r.id), ['G-3']);
  assert.equal(eventsOf(raw, '2026-11-25')[0].confirmed, 3);
});

const deps = (over = {}) => ({ adminKeyOk: async (e, k) => k === 'K', okJson: o => new Response(JSON.stringify(o), { status: 200 }), deny: (s, e) => new Response(JSON.stringify({ ok: false, error: e }), { status: s }),
  normPhone: p => String(p || '').replace(/\D/g, ''), ilDate: () => '2026-11-25', logEvent: async () => {}, readSnapshot: async () => raw, auditQuery: async () => [], recordingLink: async (e, id) => 'https://go.ishur.io/rec/' + id + '?e=1&s=x', writeAnswer: async () => true, ...over });
const call = (body, d = deps(), env = { RATE: null }) => handleAnswersLog(new Request('https://x/api/answers-log', { method: 'POST', body: JSON.stringify(body) }), env, 'o', d).then(async r => ({ status: r.status, j: await r.json() }));

test('admin only; the proof carries the WhatsApp lines and the calls with a recording link', async () => {
  assert.equal((await call({ token: T })).status, 403);
  assert.equal((await call({ admin_key: 'K' })).j.events.length, 1);
  const store = { 'log:972500000002:1795500000000': JSON.stringify({ dir: 'out', type: 'template', text: 'הוזמנתם' }), 'log:972500000002:1795500100000': JSON.stringify({ dir: 'in', type: 'button', text: 'מגיע' }) };
  const env = { RATE: { list: async ({ prefix }) => ({ keys: Object.keys(store).filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), get: async k => store[k] || null } };
  const d = deps({ auditQuery: async () => [{ ts: 1795500200000, phone: '972500000002', detail: 'Agent: מגיעים?\nUser: כן', data: { call_id: 'call_1', guest_id: 'G-2', outcome: 'מגיע', answer: 'ענה', duration_s: 20, recording: '/rec/call_1' } },
    { ts: 1795500300000, phone: '972599999999', detail: '', data: { call_id: 'call_x', guest_id: 'G-9' } }] });
  const p = (await call({ admin_key: 'K', action: 'proof', token: T, guest_id: 'G-2' }, d, env)).j;
  assert.equal(p.whatsapp.length, 2); assert.equal(p.whatsapp[1].dir, 'in'); assert.equal(p.whatsapp[1].text, 'מגיע');
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].id, 'call_1'); assert.match(p.calls[0].recording, /\/rec\/call_1\?e=/); assert.match(p.calls[0].transcript, /User: כן/);
});

test('a correction by the team is written through the answer writer and says it was set by hand', async () => {
  let wrote = null;
  const d = deps({ writeAnswer: async (e, guest, outcome, party) => { wrote = { guest, outcome, party }; return true; } });
  const r = (await call({ admin_key: 'K', action: 'set', token: T, guest_id: 'G-5', rsvp: 'מגיע', party: 3 }, d)).j;
  assert.equal(r.ok, true); assert.equal(wrote.outcome, 'מגיע'); assert.equal(wrote.party, 3); assert.equal(wrote.guest.answer_label, 'תוקן ידנית (צוות)'); assert.equal(wrote.guest.by_client, true);
  assert.equal((await call({ admin_key: 'K', action: 'set', token: T, guest_id: 'G-5', rsvp: 'אולי' }, d)).status, 400);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("answer: String(guest.answer_label || 'ענה בוואטסאפ').slice(0, 40)") && src.includes("answer_label: 'סומן ידנית (מארח)'"), 'a manual mark on the board is no longer written as a WhatsApp answer');
});
