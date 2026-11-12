// node --test worker/test/security-purchase-sum.test.mjs — 12/11 security audit:
// the pkg:/q: code in cField1 passes through the payer's browser, so it must never grant more than the money that arrived.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { purchaseCovered, priceQuote } from '../paylink.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
let realFetch;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async () => new Response('ok', { status: 200 }); });
after(() => { globalThis.fetch = realFetch; });
const env = (init = {}) => ({ ADMIN_KEY: 'k', GROW_KEY: 'gk', HOOK_GROW: 'https://hook.test/grow', SLACK_ALERT_HOOK: 'https://hook.test/slack', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const ipn = (e, body) => worker.fetch(new Request('https://go.ishur.io/api/grow-ipn?k=gk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, ctx);
const tokenOf = (e, ref) => e.RATE.m.get('grow:' + ref);

test('purchaseCovered: the stored quote sum, or the server price of the code, is the floor', () => {
  assert.equal(purchaseCovered({ sum: 1990, plan: 'premium', records: 100 }, '1990').ok, true);
  assert.equal(purchaseCovered({ sum: 1990, plan: 'premium', records: 100 }, '1990.00').ok, true);
  assert.equal(purchaseCovered({ sum: 1990, plan: 'premium', records: 100 }, '99').ok, false);
  const list = priceQuote({ plan: 'premium', records: 900, phone: '0501234567', name: 'דנה', addons: {} }).quote.sum;
  assert.equal(purchaseCovered({ plan: 'premium', records: 900 }, String(list)).ok, true);
  assert.equal(purchaseCovered({ plan: 'premium', records: 900 }, String(Math.round(list * 0.8))).ok, true, 'friend discount is legitimate');
  assert.equal(purchaseCovered({ plan: 'premium', records: 900 }, '99').ok, false);
  assert.equal(purchaseCovered({ plan: 'premium', records: 900 }, '').ok, false, 'no sum → not covered');
  assert.equal(purchaseCovered({ plan: 'nope', records: 900 }, '99999').ok, false, 'unpriceable code → not covered');
});

test('IPN: a cheap page paid with a forged premium code grants nothing from the code', async () => {
  const e = env();
  const r = await ipn(e, { paymentDesc: '50 מוזמנים בסיס', paymentSum: '99', asmachta: 'F1', payerPhone: '0501234567', fullName: 'תוקף',
    cField1: 'pkg:premium:900;design:1;host:3;travel:1;wave:1;calls:1' });
  assert.equal(r.status, 200);
  const token = tokenOf(e, 'F1');
  assert.match(token, /^[0-9a-f-]{36}$/, 'the payment itself still opens an event (by its description)');
  for (const k of ['hostess:', 'design:', 'extrasend:', 'callsaddon:']) assert.equal(e.RATE.m.get(k + token), undefined, k + ' must not be granted');
  const paid = JSON.parse(e.RATE.m.get('paid:' + token) || '{}');
  assert.equal(paid.tier, 50); assert.notEqual(paid.plan, 'premium');
});

test('IPN: a forged quote id pointing at somebody else\'s big quote is not honoured either', async () => {
  const e = env({ 'quote:0123456789ab': JSON.stringify({ id: '0123456789ab', plan: 'premium', records: 900, design: true, hostesses: 2, travel: false, extra_wave: true, calls: false, sum: 5000 }) });
  await ipn(e, { paymentDesc: '50 מוזמנים בסיס', paymentSum: '99', asmachta: 'F2', payerPhone: '0501234567', fullName: 'תוקף', cField1: 'q:0123456789ab' });
  const token = tokenOf(e, 'F2');
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(e.RATE.m.get('hostess:' + token), undefined);
  assert.equal(e.RATE.m.get('quotepaid:0123456789ab'), undefined);
  assert.equal(JSON.parse(e.RATE.m.get('paid:' + token) || '{}').tier, 50);
});

test('IPN: an honest paid quote still grants everything (no regression)', async () => {
  const e = env({ 'quote:aaaaaaaaaaaa': JSON.stringify({ id: 'aaaaaaaaaaaa', plan: 'basic', records: 50, design: false, hostesses: 1, travel: false, extra_wave: false, calls: false, sum: 1840 }) });
  await ipn(e, { paymentDesc: '50 רשומות בסיס + דיילת אחת', paymentSum: '1840', asmachta: 'H1', payerPhone: '0501234567', fullName: 'אבי', cField1: 'q:aaaaaaaaaaaa|pkg:basic:50;design:0;host:1;travel:0;wave:0;calls:0' });
  const token = tokenOf(e, 'H1');
  assert.equal(JSON.parse(e.RATE.m.get('hostess:' + token)).n, 1);
});
