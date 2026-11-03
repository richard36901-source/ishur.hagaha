// node --test worker/test/salesflow-routes.test.mjs — 03/11 site prefill + sales flow through the real Worker fetch()
// Grow/Make, Meta, Monday and Slack are stubbed (globalThis.fetch); nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { sha256Hex } from '../lib.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
let realFetch, hook = [], waSent = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/grow-link') { hook.push(JSON.parse(init.body)); return new Response(JSON.stringify({ url: 'https://pay.grow.test/abc' })); }
    if (/\/messages$/.test(u)) { waSent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + waSent.length }] })); }
    return new Response('{}', { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const APP_KEY = 'appk';
const env = (extra = {}) => ({ ADMIN_KEY: 'k', APP_KEY, GROW_LINK_HOOK: 'https://hook.test/grow-link', GROW_KEY: 'gk', RATE: kv(), ...extra });
async function stamp(b) { const nonce = 'n' + Math.random().toString(36).slice(2), ts = Date.now(); return { ...b, app: 'ishur', nonce, stamp_ts: ts, sig: await sha256Hex(`${APP_KEY}|${nonce}|${ts}`) }; }
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io', 'CF-Connecting-IP': '1.2.3.' + Math.floor(Math.random() * 200) }, body: JSON.stringify(body) }), e, ctx);

test('/api/quote-from-site: stamped, server-priced, the pkg code rides in cField1, quote stored', async () => {
  hook = []; const e = env();
  const r = await (await post(e, '/api/quote-from-site', await stamp({ plan: 'pro', records: 300, hostesses: 0, design: true, name: 'דנה כהן', phone: '0501234567', occasion: 'wedding', event_date: '2027-03-15', src: 'noa', sum: 1 }))).json();
  assert.equal(r.ok, true); assert.equal(r.url, 'https://pay.grow.test/abc'); assert.equal(r.sum, 379 + 79, 'the client sum is ignored');
  assert.equal(hook.length, 1); assert.equal(hook[0].sum, 458);
  assert.match(hook[0].cField1, /^q:[0-9a-f]{12}\|pkg:pro:300;design:1;host:0;travel:0;wave:0;calls:0$/);
  const q = JSON.parse(e.RATE.m.get('quote:' + r.id)); assert.equal(q.src, 'noa'); assert.equal(q.design, true);
  assert.equal((await post(e, '/api/quote-from-site', { plan: 'pro', records: 300, name: 'x', phone: '0501234567' })).status, 403, 'unstamped → refused');
  const bad = await (await post(e, '/api/quote-from-site', await stamp({ plan: 'gold', records: 300, name: 'דנה', phone: '0501234567' }))).json();
  assert.equal(bad.ok, false); assert.equal(bad.why, 'bad-plan');
});

test('the IPN of a site-prefill payment grants the design and keeps the package', async () => {
  hook = []; const e = env({ HOOK_GROW: 'https://hook.test/grow-writer' });
  const r = await (await post(e, '/api/quote-from-site', await stamp({ plan: 'pro', records: 300, design: true, name: 'דנה כהן', phone: '0501234567', occasion: 'wedding' }))).json();
  const cField1 = hook[0].cField1;
  globalThis.fetch = (prev => async (url, init) => (String(url) === 'https://hook.test/grow-writer' ? new Response('ok', { status: 200 }) : prev(url, init)))(globalThis.fetch);
  const ipn = { asmachta: 'T' + Date.now(), payerPhone: '0501234567', paymentSum: '458', paymentDesc: hook[0].description, fullName: 'דנה כהן', cField1, _simulated: true };
  const res = await worker.fetch(new Request('https://go.ishur.io/api/grow-ipn?k=gk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ipn) }), e, ctx);
  assert.equal(res.status, 200);
  const token = e.RATE.m.get('grow:' + ipn.asmachta);
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(e.RATE.m.get('design:' + token)).status, 'paid', 'design granted');
  assert.equal(JSON.parse(e.RATE.m.get('paid:' + token)).tier, 300);
  assert.ok(e.RATE.m.get('quotepaid:' + r.id), 'quote marked paid');
});

test('/api/hostess-check: 300 records → 2 hostesses; a design order carries the pkg code, free inside a bundle', async () => {
  hook = []; const e = env();
  const d = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  let j = await (await post(e, '/api/hostess-check', { date: d, city: 'תל אביב', guests: '300', plan: 'basic', link: false })).json();
  assert.equal(j.n, 2, '300 records → 2 hostesses'); assert.equal(j.hostess_price, 1990);
  j = await (await post(e, '/api/hostess-check', { offer: 'winter1990', design: true, date: d, city: 'תל אביב', guests: '700', plan: 'basic', name: 'דנה', phone: '0501234567' })).json();
  assert.equal(j.total, 1990, 'bundle total, design free'); assert.equal(j.design_price, 0);
  assert.match(hook.at(-1).cField2, /\|pkg:premium:700;design:1;host:2;/); assert.match(hook.at(-1).description, /עיצוב הזמנה במתנה/);
  j = await (await post(e, '/api/hostess-check', { design: true, date: d, city: 'תל אביב', guests: '200', plan: 'basic', link: false })).json();
  assert.equal(j.total, 199 + 1790 + 79, 'no bundle → design ₪79 on top'); assert.equal(j.n, 1);
});

test('inbound on 4499: flag off → the flow never answers; flag on → a new lead gets the questions', async () => {
  const msg = (from, text) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'C' }, contacts: [{ profile: { name: 'דנה' } }], messages: [{ id: 'wamid.in' + Math.random(), from, type: 'text', text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
  const send = (e, body) => worker.fetch(new Request('https://go.ishur.io/api/wa-webhook?t=vt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, ctx);
  const base = { WA_VERIFY: 'vt', WA_PHONE_ID_CLIENT: 'C', WA_TOKEN_CLIENT: 't', WA_PHONE_ID: 'C', WA_TOKEN: 't' };
  waSent = [];
  const off = env(base);
  await send(off, msg('972501112233', 'חתונה 650'));
  assert.ok(!off.RATE.m.has('sf:972501112233'), 'flag off: no flow state');
  const on = env({ ...base, SALES_FLOW: 'on' });
  await send(on, msg('972501112244', 'חתונה 650'));
  const st = on.RATE.m.get('sf:972501112244');
  assert.ok(st, 'flag on: flow started');
  const s = JSON.parse(st);
  assert.equal(s.step, 1); assert.equal(s.occasion, 'wedding'); assert.equal(s.guests, 650);
  assert.ok(s.pending || waSent.some(m => /נשמח לעזור עם החתונה/.test(JSON.stringify(m))), 'the questions went out (or wait for 09:00)');
});
