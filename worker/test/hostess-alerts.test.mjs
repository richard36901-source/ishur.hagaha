import test from 'node:test'; import assert from 'node:assert/strict';
import { keyTok, daysUntil, arrivalOf, bookingChanged, dateSetText, reminderText, dueKind, alertDateSet, hostessReminders } from '../hostess-alerts.js';

const B = { n: 2, date: '2027-01-06', reception: '19:00', venue: 'אולם הדוגמה', city: 'אשדוד', client: 'לקוח לדוגמה' };
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };
const prefixOf = store => async (env, p) => Object.fromEntries([...store.m].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v]));
const at = (day, hm) => Date.parse(`${day}T${hm}:00+02:00`);   /* Israel winter time */

test('days until the event, and the arrival time is 40 minutes before the reception', () => {
  assert.equal(daysUntil('2027-01-06', '2026-12-30'), 7); assert.equal(daysUntil('2027-01-06', '2027-01-05'), 1); assert.equal(daysUntil('', '2027-01-05'), null);
  assert.equal(arrivalOf('19:00'), '18:20'); assert.equal(arrivalOf('00:20'), '23:40'); assert.equal(arrivalOf('soon'), '');
});
test('a booking counts as changed only when the date or the number of hostesses changed', () => {
  assert.equal(bookingChanged(null, B), true); assert.equal(bookingChanged({ ...B }, { ...B, venue: 'אחר' }), false);
  assert.equal(bookingChanged(B, { ...B, date: '2027-01-07' }), true); assert.equal(bookingChanged(B, { ...B, n: 3 }), true); assert.equal(bookingChanged(null, { ...B, date: '' }), false);
});
test('date-set text: title, one fact per line, action footer and the screen link', () => {
  const t = dateSetText({ ...B, tok8: 'abcd1234' }, null).split('\n');
  assert.match(t[0], /נקבע תאריך/); assert.equal(t[1], ''); assert.ok(t.includes('• לקוח לדוגמה')); assert.ok(t.includes('• 06/01/2027 · 2 דיילות')); assert.ok(t.includes('• אולם הדוגמה, אשדוד'));
  assert.ok(t.includes('• הגעה 18:20 (קבלת פנים 19:00)')); assert.match(t[t.length - 2], /^מה לעשות: /); assert.match(t[t.length - 1], /^https:\/\/ishur\.io\/next\/calendar\.html$/);
  assert.match(dateSetText({ ...B, tok8: 'x' }, { ...B, date: '2027-01-05' }), /התאריך השתנה\* \(היה 05\/01\/2027\)/);
});
test('reminder text says who is assigned, or that nobody is', () => {
  assert.match(reminderText(B, 'd7', ['דנה']), /בעוד שבוע[\s\S]*משובצות: דנה[\s\S]*מה לעשות: לאשר הגעה/);
  assert.match(reminderText(B, 'd1', []), /האירוע מחר[\s\S]*עוד לא שובצו דיילות[\s\S]*מה לעשות: לשבץ דיילות עכשיו/);
});
test('due only exactly 7 days and 1 day before', () => {
  assert.equal(dueKind(B, '2026-12-30'), 'd7'); assert.equal(dueKind(B, '2027-01-05'), 'd1');
  for (const d of ['2026-12-29', '2026-12-31', '2027-01-04', '2027-01-06', '2027-01-07']) assert.equal(dueKind(B, d), null);
});
test('date alert: sent for a new or changed booking, silent when the form is saved again unchanged', async () => {
  const sent = []; const post = async (t, o) => sent.push([t, o]);
  assert.equal((await alertDateSet({}, 'abcd1234', B, null, { post })).sent, true);
  assert.equal((await alertDateSet({}, 'abcd1234', B, { ...B }, { post })).sent, false);
  assert.equal((await alertDateSet({}, 'abcd1234', { ...B, date: '2027-01-08' }, B, { post })).sent, true);
  assert.equal(sent.length, 2); assert.equal(sent[0][1].important, true); assert.doesNotMatch(sent[0][1].key, /\d/); assert.notEqual(sent[0][1].key, sent[1][1].key);
});
test('reminders: once per event and kind, not before 09:00, two events on one day both go out, a moved date arms it again', async () => {
  const tokA = 'aaaaaaaa-0000-4000-8000-000000000001', tokB = 'bbbbbbbb-0000-4000-8000-000000000002';
  const store = kv({ ['hostessbook:' + tokA]: JSON.stringify(B), ['hostessbook:' + tokB]: JSON.stringify({ ...B, client: 'לקוח שני' }), 'staff:972500000001': JSON.stringify({ name: 'דנה' }), 'hostassign:aaaaaaaa': JSON.stringify(['972500000001']) });
  const env = { RATE: store }, sent = []; const post = async (t, o) => sent.push([t, o]); const kvPrefix = prefixOf(store);
  assert.equal((await hostessReminders(env, { now: at('2026-12-30', '08:30'), post, kvPrefix })).sent, 0);
  assert.equal((await hostessReminders(env, { now: at('2026-12-30', '09:10'), post, kvPrefix })).sent, 2);
  assert.equal((await hostessReminders(env, { now: at('2026-12-30', '09:20'), post, kvPrefix })).sent, 0);
  assert.equal((await hostessReminders(env, { now: at('2026-12-31', '10:00'), post, kvPrefix })).sent, 0);
  assert.equal((await hostessReminders(env, { now: at('2027-01-05', '09:10'), post, kvPrefix })).sent, 2);
  assert.equal(sent.length, 4); assert.notEqual(sent[0][1].key, sent[1][1].key); assert.doesNotMatch(sent[0][1].key, /\d/);
  const a = sent.find(([t]) => /לקוח לדוגמה/.test(t) && /בעוד שבוע/.test(t))[0]; assert.match(a, /משובצות: דנה/);
  const b = sent.find(([t]) => /לקוח שני/.test(t) && /בעוד שבוע/.test(t))[0]; assert.match(b, /עוד לא שובצו/);
  await store.put('hostessbook:' + tokA, JSON.stringify({ ...B, date: '2027-01-12' }));
  assert.equal((await hostessReminders(env, { now: at('2027-01-05', '11:00'), post, kvPrefix })).sent, 1);   /* 7 days before the new date */
  assert.equal((await hostessReminders(env, { now: at('2027-01-05', '22:00'), post, kvPrefix })).sent, 0);   /* quiet hours */
});

test('event ids that differ only in digits still get different Slack keys', () => { assert.notEqual(keyTok('12ab34cd'), keyTok('56ab78cd')); assert.doesNotMatch(keyTok('12ab34cd'), /\d/); });
