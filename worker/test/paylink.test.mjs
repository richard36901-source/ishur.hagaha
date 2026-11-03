// node --test worker/test/paylink.test.mjs — pay links v2: server pricing, Grow IPN classification
// (package + design no longer swallowed by the design-only path), add-on grants, Slack close line.
// Everything outbound is stubbed; nothing leaves the machine.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { priceQuote, readQuoteRef, closeMessage, addonList } from '../paylink.js';
import { isDesignPayment } from '../design.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
let realFetch, calls = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, body: init.body ? String(init.body) : '' });
    if (u === 'https://hook.test/grow-link') return new Response(JSON.stringify({ url: 'https://pay.grow.link/TEST-LINK' }));
    if (u === 'https://hook.test/grow') return new Response('ok', { status: 200 });
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });
const env = (init = {}) => ({ ADMIN_KEY: 'k', GROW_KEY: 'gk', HOOK_GROW: 'https://hook.test/grow', GROW_LINK_HOOK: 'https://hook.test/grow-link',
  SLACK_ALERT_HOOK: 'https://hook.test/slack', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, ctx);
const ipn = (e, flat) => post(e, '/api/grow-ipn?k=gk', flat);
const slackTexts = () => calls.filter(c => c.u === 'https://hook.test/slack').map(c => JSON.parse(c.body).text);
const tokenOf = (e, ref) => e.RATE.m.get('grow:' + ref);

/* ── pricing ── */
test('priceQuote: sum from the tables, human description, machine code', () => {
  const r = priceQuote({ plan: 'basic', records: 100, addons: { design: true, hostesses: 2 }, name: 'דנה כהן', phone: '050-1234567', occasion: 'wedding' });
  assert.equal(r.ok, true);
  assert.equal(r.quote.sum, 99 + 79 + 1990);
  assert.equal(r.quote.description, '100 רשומות בסיס + עיצוב הזמנה + 2 דיילות');
  assert.equal(r.quote.code, 'pkg:basic:100;design:1;host:2;travel:0;wave:0;calls:0');
  assert.equal(r.quote.phone, '972501234567');
  const t = priceQuote({ plan: 'premium', records: 300, addons: { hostesses: 1, travel: true, extra_wave: true, calls: true }, name: 'אבי', phone: '0521111111' });
  /* calls are already in premium → not charged; wave = ceil(0.3*300+20)=110; travel 1 hostess = 250 */
  assert.equal(t.quote.sum, 449 + 1790 + 250 + 110);
  assert.equal(t.quote.calls, false);
  assert.equal(priceQuote({ plan: 'basic', records: 200, addons: { calls: true }, name: 'אבי', phone: '0521111111' }).quote.sum, 199 + Math.ceil(2 * 200 + 20));
});
test('priceQuote: refuses what it cannot price or trust', () => {
  const base = { plan: 'basic', records: 100, name: 'דנה', phone: '0501234567' };
  assert.equal(priceQuote({ ...base, plan: 'gold' }).why, 'bad-plan');
  assert.equal(priceQuote({ ...base, records: 150 }).why, 'bad-records');
  assert.equal(priceQuote({ ...base, phone: '12345' }).why, 'bad-phone');
  assert.equal(priceQuote({ ...base, phone: '' }).why, 'bad-phone');
  assert.equal(priceQuote({ ...base, addons: { hostesses: 3 } }).why, 'hostesses-unpriced');
  assert.equal(priceQuote({ ...base, addons: { travel: true } }).why, 'travel-without-hostesses');
  assert.equal(priceQuote({ ...base, event_date: '2026-13-40' }).why, 'bad-date');
  assert.equal(priceQuote({ ...base, sum: 1 }).quote.sum, 99, 'a client sum is ignored');
});

/* ── /api/pay-link ── */
test('/api/pay-link structured: stores quote:<id> for 30 days and sends q:<id>|code in cField1', async () => {
  const e = env();
  const j = await (await post(e, '/api/pay-link', { admin_key: 'k', plan: 'basic', records: 100, addons: { design: true, hostesses: 2 }, name: 'דנה כהן', phone: '0501234567', occasion: 'wedding', event_date: '2026-12-20', sum: 5 })).json();
  assert.equal(j.ok, true); assert.equal(j.url, 'https://pay.grow.link/TEST-LINK'); assert.equal(j.sum, 2168);
  const sent = JSON.parse(calls.find(c => c.u === 'https://hook.test/grow-link').body);
  assert.equal(sent.sum, 2168); assert.equal(sent.cField1, `q:${j.id}|pkg:basic:100;design:1;host:2;travel:0;wave:0;calls:0`);
  assert.equal(sent.phone, '0501234567'); assert.equal(sent.description, '100 רשומות בסיס + עיצוב הזמנה + 2 דיילות');
  const q = JSON.parse(e.RATE.m.get('quote:' + j.id));
  assert.equal(q.event_date, '2026-12-20'); assert.equal(q.hostesses, 2); assert.equal(q.url, j.url);
  assert.equal((await post(e, '/api/pay-link', { admin_key: 'k', plan: 'basic', records: 100, name: 'דנה', phone: '' })).status, 400);
  assert.equal((await post(e, '/api/pay-link', { admin_key: 'bad', plan: 'basic', records: 100, name: 'דנה', phone: '0501234567' })).status, 403);
});
test('/api/pay-link legacy free-form path still works', async () => {
  const e = env();
  const j = await (await post(e, '/api/pay-link', { admin_key: 'k', sum: 1990, tier: 800, plan: 'premium', hostess: 2, note: 'playbook' })).json();
  assert.equal(j.ok, true); assert.equal(j.description, '800 רשומות הכל כלול + 2 דיילות'); assert.equal(j.sum, 1990);
});

/* ── IPN classification ── */
test('isDesignPayment: design-only true; package + design false; pkg code false', () => {
  assert.equal(isDesignPayment({ paymentDesc: 'עיצוב הזמנה' }), true);
  assert.equal(isDesignPayment({ paymentDesc: '100 רשומות בסיס + עיצוב הזמנה' }), false);
  assert.equal(isDesignPayment({ paymentDesc: 'עיצוב הזמנה', cField1: 'q:0123456789ab|pkg:basic:100;design:1' }), false);
  assert.equal(isDesignPayment({ paymentDesc: '50 מוזמנים בסיס' }), false);
});
test('(a) "100 רשומות בסיס + עיצוב הזמנה" (old free-form link) creates an event AND marks design paid', async () => {
  const e = env();
  const r = await ipn(e, { paymentDesc: '100 רשומות בסיס + עיצוב הזמנה', paymentSum: '178', asmachta: 'A1', payerPhone: '0501234567', fullName: 'דנה כהן' });
  assert.equal(await r.text(), 'ok');
  const token = tokenOf(e, 'A1');
  assert.match(token, /^[0-9a-f-]{36}$/, 'a real event token was minted');
  assert.ok(e.RATE.m.get('token:' + token));
  assert.ok(calls.some(c => c.u === 'https://hook.test/grow' && JSON.parse(c.body).kind === 'payment'), 'event writer called');
  assert.equal(JSON.parse(e.RATE.m.get('design:' + token)).status, 'paid');
  assert.equal(JSON.parse(e.RATE.m.get('paid:' + token)).tier, 100);
});
test('(b) "עיצוב הזמנה" alone still goes the design path (no event)', async () => {
  const e = env();
  const tok = '11111111-2222-4333-8444-555555555555';
  const r = await ipn(e, { paymentDesc: 'עיצוב הזמנה', paymentSum: '79', asmachta: 'D1', payerPhone: '0501234567', fullName: 'דנה', cField1: tok });
  assert.equal(await r.text(), 'design-paid');
  assert.equal(e.RATE.m.get('grow:D1'), 'design');
  assert.equal(JSON.parse(e.RATE.m.get('design:' + tok)).status, 'paid');
  assert.ok(!calls.some(c => c.u === 'https://hook.test/grow'), 'no event writer call');
});
test('(c) a quote with 2 hostesses records them on the event; design + wave granted; Slack close line', async () => {
  const e = env();
  const j = await (await post(e, '/api/pay-link', { admin_key: 'k', plan: 'pro', records: 400, addons: { design: true, hostesses: 2, travel: true, extra_wave: true }, name: 'דנה כהן', phone: '0501234567', occasion: 'wedding', event_date: '2026-12-20' })).json();
  assert.equal(j.ok, true);
  const cf1 = JSON.parse(calls.find(c => c.u === 'https://hook.test/grow-link').body).cField1;
  calls = [];
  /* the description contains "גל תזכורת" — must not be read as an add-on to an existing event */
  const r = await ipn(e, { paymentDesc: j.description, paymentSum: String(j.sum), asmachta: 'Q1', payerPhone: '0501234567', fullName: 'דנה כהן', cField1: cf1, cField2: 'wedding' });
  assert.equal(await r.text(), 'ok');
  const token = tokenOf(e, 'Q1');
  assert.match(token, /^[0-9a-f-]{36}$/);
  const h = JSON.parse(e.RATE.m.get('hostess:' + token));
  assert.equal(h.n, 2); assert.equal(h.travel_included, 500); assert.equal(h.date, '2026-12-20'); assert.equal(h.quote, j.id);
  assert.equal(JSON.parse(e.RATE.m.get('design:' + token)).status, 'paid');
  assert.ok(e.RATE.m.get('extrasend:' + token));
  const paid = JSON.parse(e.RATE.m.get('paid:' + token));
  assert.equal(paid.tier, 400); assert.equal(paid.plan, 'pro'); assert.equal(paid.hostess, 2);
  assert.equal(JSON.parse(e.RATE.m.get('quotepaid:' + j.id)).token, token);
  const close = slackTexts().find(t => t.includes('נסגר'));
  assert.ok(close, 'close line posted');
  for (const part of ['דנה כהן', '0501234567', 'חתונה 20/12/2026', 'חבילה פרמיום', '400 רשומות', 'עיצוב הזמנה, 2 דיילות, נסיעות, גל שלישי', `₪${j.sum}`, 'dashboard.html?t=' + token, 'upload.html?t=' + token])
    assert.ok(close.includes(part), 'close line has ' + part + '\n' + close);
});
test('quote id lost from KV: the code in cField1 alone still grants', async () => {
  const e = env();
  const r = await ipn(e, { paymentDesc: '50 רשומות בסיס + דיילת אחת', paymentSum: '1840', asmachta: 'C1', payerPhone: '0501234567', fullName: 'אבי', cField1: 'q:aaaaaaaaaaaa|pkg:basic:50;design:0;host:1;travel:0;wave:0;calls:0' });
  assert.equal(await r.text(), 'ok');
  const token = tokenOf(e, 'C1');
  assert.equal(JSON.parse(e.RATE.m.get('hostess:' + token)).n, 1);
  assert.equal(e.RATE.m.get('design:' + token), undefined);
});

/* ── Slack formatter ── */
test('closeMessage: exact shape, no date → "תאריך טרם", no add-ons → "ללא"', () => {
  const t = 'abcdef12-0000-4000-8000-000000000000';
  assert.equal(closeMessage({ name: 'דנה', phone: '972501234567', occasion: 'bar', event_date: '', plan: 'basic', records: 100, addons: [], sum: 99, token: t }),
    `🎉 נסגר: דנה · 0501234567 · בר מצווה תאריך טרם · חבילה בסיס · 100 רשומות · תוספות: ללא · ₪99 · https://ishur.io/dashboard.html?t=${t} · https://ishur.io/upload.html?t=${t}`);
  assert.equal(closeMessage({ name: 'דנה', phone: '0501234567', occasion: 'wedding', event_date: '2026-12-20', plan: 'premium', records: 300, addons: addonList({ design: true, hostesses: 1 }), sum: 2068, token: t }),
    `🎉 נסגר: דנה · 0501234567 · חתונה 20/12/2026 · חבילה הכל כלול · 300 רשומות · תוספות: עיצוב הזמנה, דיילת אחת · ₪2068 · https://ishur.io/dashboard.html?t=${t} · https://ishur.io/upload.html?t=${t}`);
});
test('readQuoteRef parses id + code; null when absent', () => {
  const r = readQuoteRef({ cField1: 'q:0123456789ab|pkg:premium:300;design:1;host:2;travel:1;wave:0;calls:0' });
  assert.equal(r.id, '0123456789ab'); assert.deepEqual(r.code, { plan: 'premium', records: 300, design: true, hostesses: 2, travel: true, extra_wave: false, calls: false });
  assert.equal(readQuoteRef({ cField1: 'special' }), null);
});
