// 22/11/2026 · a payment that arrived without the payer's phone is kept, and runs as a real payment once the phone is known
import test from 'node:test';
import assert from 'node:assert/strict';
import { parkPayment, drainParked, PARK_PREFIX } from '../parked-payments.js';

const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); }, list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }) }; };
const FLAT = { asmachta: '5089', paymentSum: '50', paymentDesc: '50 מוזמנים בסיס', fullName: 'א ב', payerPhone: '' };

test('a payment without a phone is kept once, and nothing runs until a phone is set', async () => {
  const env = { RATE: kv() }; const ran = [];
  assert.equal(await parkPayment(env, '5089', FLAT), true);
  await parkPayment(env, '5089', { ...FLAT, paymentSum: '999' });   /* Grow repeating the notice does not replace the first copy */
  assert.equal(JSON.parse(env.RATE.m.get(PARK_PREFIX + '5089')).flat.paymentSum, '50');
  const r = await drainParked(env, async f => { ran.push(f); return new Response('ok', { status: 200 }); });
  assert.deepEqual(r, { waiting: 1, done: 0, failed: 0 }); assert.equal(ran.length, 0);
  assert.equal(await parkPayment(env, '', FLAT), false, 'no reference, nothing to key it by');
});

test('once the phone is set the payment runs through the real path with that phone, and is removed', async () => {
  const env = { RATE: kv() }; const ran = [], logs = [];
  await parkPayment(env, '5089', FLAT);
  const rec = JSON.parse(env.RATE.m.get(PARK_PREFIX + '5089')); rec.phone = '050-632-6554'; env.RATE.m.set(PARK_PREFIX + '5089', JSON.stringify(rec));
  const r = await drainParked(env, async f => { ran.push(f); return new Response('created', { status: 200 }); }, { log: async x => { logs.push(x); } });
  assert.deepEqual(r, { waiting: 0, done: 1, failed: 0 });
  assert.equal(ran[0].payerPhone, '972506326554'); assert.equal(ran[0].asmachta, '5089'); assert.equal('_simulated' in ran[0], false, 'a real payment, not a simulation');
  assert.equal(env.RATE.m.has(PARK_PREFIX + '5089'), false); assert.equal(logs[0].ok, true);
  assert.deepEqual(await drainParked(env, async () => { throw new Error('must not run twice'); }), { waiting: 0, done: 0, failed: 0 });
});

test('a run that fails, throws, or is still incomplete leaves the payment waiting; a bad phone never runs', async () => {
  const env = { RATE: kv() };
  await parkPayment(env, 'A', FLAT); await parkPayment(env, 'B', FLAT); await parkPayment(env, 'C', FLAT); await parkPayment(env, 'D', FLAT);
  const set = (ref, phone) => { const r = JSON.parse(env.RATE.m.get(PARK_PREFIX + ref)); r.phone = phone; env.RATE.m.set(PARK_PREFIX + ref, JSON.stringify(r)); };
  set('A', '0506326554'); set('B', '0506326554'); set('C', '0506326554'); set('D', '12345');
  const r = await drainParked(env, async f => { if (f.asmachta) {} const ref = [...env.RATE.m.keys()]; return null; });
  assert.equal(r.failed, 3); assert.equal(r.waiting, 1); assert.equal(env.RATE.m.size, 4);
  const r2 = await drainParked(env, async () => new Response('accepted-incomplete', { status: 200 }));
  assert.equal(r2.done, 0); assert.equal(env.RATE.m.size, 4);
  const r3 = await drainParked(env, async () => { throw new Error('boom'); });
  assert.equal(r3.failed, 3); assert.equal(env.RATE.m.size, 4);
});
