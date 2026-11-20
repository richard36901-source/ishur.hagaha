// node --test worker/test/app-push.test.mjs — the client app's push module (app-push.js). Spec P4, P6.
// APNs is never reached: fetch is stubbed and records what would have been sent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../app-push.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } };
}
const PHONE = '972521234567', DEV = 'a'.repeat(64), TOK = '11111111-2222-3333-4444-555555555555';
const at = (h, m = 0) => new Date(Date.UTC(2026, 10, 24, h - 2, m));   // Israel is UTC+2 on 24/11/2026
let sent, env, apnsStatus;
const send = async (envx, device, payload) => { sent.push({ device, payload }); return { status: apnsStatus }; };
beforeEach(() => { sent = []; apnsStatus = 200; env = { RATE: kv({ 'cfg:app_push': '1' }) }; });

test('payloads never carry a phone number', () => {
  for (const kind of ['answer', 'daily', 'failed']) {
    const p = P.buildPush(kind, { guest: 'דנה 0521234567', seats: 3, status: 'confirmed', event: 'נועה ויונתן 052-1234567', token: TOK, confirmed: 41, pending: 12, failed: 6, answered: 9 });
    assert.doesNotMatch(JSON.stringify(p), /\d{7,}/, kind);
    assert.ok(p.title && p.body);
  }
});
test('answer text says who and how many', () => {
  assert.equal(P.buildPush('answer', { guest: 'דנה כהן', seats: 3, status: 'confirmed' }).body, 'דנה כהן אישר/ה הגעה, 3 מגיעים');
  assert.match(P.buildPush('failed', { failed: 6 }).body, /ההזמנה לא הגיעה ל-6 מוזמנים/);
});
test('quiet hours are 21:00–09:00 Israel time', () => {
  assert.equal(P.quiet(at(23)), true); assert.equal(P.quiet(at(8, 59)), true); assert.equal(P.quiet(at(3)), true);
  assert.equal(P.quiet(at(9)), false); assert.equal(P.quiet(at(20, 59)), false); assert.equal(P.quiet(at(21)), true);
});
test('a 23:00 answer is not sent and shows up in the 09:00 summary', async () => {
  await P.register(env, PHONE, { device: DEV, platform: 'ios' });
  const r = await P.notifyAnswer(env, PHONE, { token: TOK, guest: 'דנה', seats: 2, status: 'confirmed' }, { now: at(23), send });
  assert.equal(r.sent, 0); assert.equal(r.held, true); assert.equal(sent.length, 0);
  const s = await P.dailySummary(env, PHONE, { token: TOK, event: 'נועה ויונתן', confirmed: 40, pending: 10 }, { now: at(9), send });
  assert.equal(s.sent, 1); assert.match(sent[0].payload.body, /1 תשובות חדשות|תשובה חדשה/);
  assert.equal((await P.read(env, PHONE)).held.length, 0);
});
test('daytime answer goes out; each kind respects its switch', async () => {
  await P.register(env, PHONE, { device: DEV, platform: 'ios' });
  assert.equal((await P.notifyAnswer(env, PHONE, { token: TOK, guest: 'דנה', seats: 2, status: 'confirmed' }, { now: at(12), send })).sent, 1);
  await P.setPrefs(env, PHONE, { answer: false });
  assert.equal((await P.notifyAnswer(env, PHONE, { token: TOK, guest: 'רון', seats: 1, status: 'declined' }, { now: at(12), send })).sent, 0);
  assert.equal(sent.length, 1);
});
test('nothing is sent while the switch cfg:app_push is off', async () => {
  await env.RATE.delete('cfg:app_push'); await P.register(env, PHONE, { device: DEV, platform: 'ios' });
  assert.equal((await P.notifyAnswer(env, PHONE, { token: TOK, guest: 'דנה', seats: 2, status: 'confirmed' }, { now: at(12), send })).sent, 0);
  assert.equal(sent.length, 0);
});
test('a device APNs no longer knows (410) is dropped', async () => {
  await P.register(env, PHONE, { device: DEV, platform: 'ios' }); apnsStatus = 410;
  await P.notifyAnswer(env, PHONE, { token: TOK, guest: 'דנה', seats: 2, status: 'confirmed' }, { now: at(12), send });
  assert.equal((await P.read(env, PHONE)).devices.length, 0);
});
test('register validates the token and keeps at most 5 devices; unregister removes', async () => {
  assert.equal((await P.register(env, PHONE, { device: 'short', platform: 'ios' })).ok, false);
  for (let i = 0; i < 7; i++) await P.register(env, PHONE, { device: String(i).repeat(64), platform: 'ios' });
  assert.equal((await P.read(env, PHONE)).devices.length, 5);
  await P.unregister(env, PHONE, '6'.repeat(64));
  assert.equal((await P.read(env, PHONE)).devices.some(d => d.device === '6'.repeat(64)), false);
});
test('routes: a session is required; delete-request writes a journal row', async () => {
  const log = [];
  const d = { okJson: (o) => new Response(JSON.stringify(o), { status: 200 }), deny: (s, e) => new Response(JSON.stringify({ ok: false, error: e }), { status: s }),
    verifySession: async (e, s) => (s === 'good' ? PHONE : ''), isAdmin: (e, k) => k === 'admin', logEvent: async (e, row) => { log.push(row); } };
  const call = (path, body) => P.handleApp(new Request('https://x/api/app/' + path, { method: 'POST', body: JSON.stringify(body) }), env, '', new URL('https://x/api/app/' + path), d);
  assert.equal((await call('delete-request', { session: 'bad' })).status, 401);
  const ok = await call('delete-request', { session: 'good' });
  assert.equal(ok.status, 200); assert.equal(log.length, 1); assert.equal(log[0].review, true); assert.equal(log[0].phone, PHONE);
  assert.equal((await call('push-register', { session: 'bad', device: DEV, platform: 'ios' })).status, 401);
  assert.equal((await call('push-register', { session: 'good', device: DEV, platform: 'ios' })).status, 200);
  assert.equal((await P.read(env, PHONE)).devices.length, 1);
  assert.equal((await call('push-prefs', { session: 'good', prefs: { daily: false } })).status, 200);
  assert.equal((await P.read(env, PHONE)).prefs.daily, false);
  assert.equal((await call('push-unregister', { session: 'good', device: DEV })).status, 200);
  assert.equal((await call('push-test', { admin_key: 'nope', phone: PHONE })).status, 403);
});

test('answerHook: maps the sheet status, finds the client by the event token, stays quiet on anything odd', async () => {
  await P.register(env, PHONE, { device: DEV, platform: 'ios' });
  const d = { tokenRecord: async (e, t) => (t === TOK ? { phone: PHONE } : null) };
  assert.equal((await P.answerHook(env, d, { token: TOK, name: 'דנה כהן' }, 'מגיע', 3, { now: at(12), send })).sent, 1);
  assert.equal(sent[0].payload.body, 'דנה כהן אישר/ה הגעה, 3 מגיעים');
  assert.equal((await P.answerHook(env, d, { token: 'nope', name: 'x' }, 'מגיע', 1, { now: at(12), send })).sent, 0);
  assert.equal((await P.answerHook(env, d, { token: TOK, name: 'x' }, '__keep__', 1, { now: at(12), send })).sent, 0);
  assert.equal((await P.answerHook(env, { tokenRecord: async () => { throw new Error('kv down'); } }, { token: TOK, name: 'x' }, 'מגיע', 1, { now: at(12), send })).sent, 0);
  assert.equal(sent.length, 1);
});
test('morningRun: once a day, only in the 09:00 hour, one summary per client with the app', async () => {
  env.RATE.list = async ({ prefix }) => ({ keys: [...env.RATE.m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) });
  await P.register(env, PHONE, { device: DEV, platform: 'ios' });
  await P.notifyAnswer(env, PHONE, { token: TOK, guest: 'דנה', seats: 2, status: 'confirmed' }, { now: at(23), send });
  const d = { readSnapshot: async () => ({}), eventsForPhone: () => [{ token: TOK, event_name: 'נועה ויונתן', event_date: '2026-12-19' }], buildDashboard: () => ({ totals: { confirmed_seats: 41, pending: 12 } }) };
  assert.equal((await P.morningRun(env, d, { now: at(8, 50), send })).ran, false);
  const r = await P.morningRun(env, d, { now: at(9, 0), send });
  assert.equal(r.ran, true); assert.equal(r.sent, 1);
  assert.match(sent[0].payload.body, /תשובה חדשה אחת · 41 מגיעים · 12 עוד לא ענו/);
  assert.doesNotMatch(JSON.stringify(sent[0].payload), /\d{7,}/);
  assert.equal((await P.morningRun(env, d, { now: at(9, 10), send })).ran, false);
  assert.equal(sent.length, 1);
});
