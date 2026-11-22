// 22/11/2026 · the clients screen sends a client their sign-in code
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminSendPin, pinFor } from '../account.js';

const kv = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; };
const NOON = new Date('2026-11-22T10:00:00Z'), NIGHT = new Date('2026-11-22T20:30:00Z');   /* 12:00 and 22:30 in Israel */
function deps(over = {}) {
  const sent = [], logs = [];
  return { sent, logs, d: { overBudget: async () => false, logEvent: async (e, r) => { logs.push(r); }, sendText: async (e, phone, text, ch) => { sent.push({ phone, text, ch }); return { ok: true }; }, ...over } };
}
const env = () => ({ RATE: kv(), ADMIN_KEY: 'k' });
const PHONE = '972501234567';

test('the code goes to the client on WhatsApp, with the same wording as when they ask for it themselves', async () => {
  const e = env(), x = deps();
  const r = await adminSendPin(e, x.d, PHONE, { now: NOON });
  assert.deepEqual(r, { ok: true, via: 'whatsapp' });
  const pin = await pinFor(e, PHONE);
  assert.equal(x.sent.length, 1); assert.equal(x.sent[0].phone, PHONE); assert.equal(x.sent[0].ch, 'client');
  assert.ok(x.sent[0].text.includes(pin) && x.sent[0].text.startsWith('קוד הכניסה שלכם ללוח הבקרה'));
  assert.equal(x.logs[0].ok, true); assert.ok(!JSON.stringify(x.logs).includes(pin), 'the code is never written to the journal');
  assert.ok(!('pin' in r), 'and never returned to the screen');
});

test('nothing is sent at night or past the hourly limit', async () => {
  const x = deps();
  assert.deepEqual(await adminSendPin(env(), x.d, PHONE, { now: NIGHT }), { ok: false, why: 'quiet-hours' });
  const y = deps({ overBudget: async () => true });
  assert.deepEqual(await adminSendPin(env(), y.d, PHONE, { now: NOON }), { ok: false, why: 'rate-limited' });
  assert.equal(x.sent.length + y.sent.length, 0);
});
