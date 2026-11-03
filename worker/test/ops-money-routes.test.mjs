// /api/ops/{finance,ads,templates,feedback,invoice-resend,template-variant} through the real Worker fetch().
// Graph/Meta stubbed; records every outbound request so the tests prove nothing is sent without confirm.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'דנה כהן'; ev[3] = '972501234567'; ev[5] = 'חתונה'; ev[6] = '2026-11-20'; ev[7] = 'כן'; ev[8] = '449'; ev[25] = '2026-10-15 10:00'; ev[34] = 'דנה ואבי'; ev[31] = 'premium';
  return { events: { values: [ev] }, guests: { values: [] } };
}
let realFetch, calls = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, method: init.method || 'GET' });
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()));
    if (/\/insights\?level=ad/.test(u)) return new Response(JSON.stringify({ data: [{ campaign_id: '120250670197650731', campaign_name: 'שלו', adset_id: 's', ad_id: 'a', spend: '120', impressions: '900', clicks: '30', actions: [{ action_type: 'lead', value: '2' }] }] }));
    if (/message_templates\?name=/.test(u)) return new Response(JSON.stringify({ data: [{ name: 'hazmana', language: 'he', category: 'UTILITY', components: [{ type: 'BODY', text: 'שלום' }] }] }));
    if (/message_templates\?fields=/.test(u)) return new Response(JSON.stringify({ data: [{ id: '1', name: 'hazmana', status: 'APPROVED', category: 'UTILITY', language: 'he' }, { id: '2', name: 'pend', status: 'PENDING', language: 'he' }] }));
    if (/message_templates$/.test(u)) return new Response(JSON.stringify({ id: 'new', status: 'PENDING' }));
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });
const env = (init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_TOKEN_GUESTS: 't', WA_TOKEN: 'ct', META_ADS_TOKEN: 'mt', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path) => worker.fetch(new Request('https://go.ishur.io' + path, { headers: { 'X-Admin-Key': 'k' } }), e, ctx);
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...body }) }), e, ctx);

test('finance: sheet revenue, P&L months, per-event row, invoice pending, cached second time', async () => {
  const e = env({ 'adspend:2026-10': '1000', 'fixedcost:2026-10': JSON.stringify([{ name: 'Make', ils: 50 }]), 'evcost:c1c5fcf5': '3000' });
  const r = await (await get(e, '/api/ops/finance?range=90d')).json();
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.revenue.total, 449);
  const oct = r.pnl.find(p => p.month === '2026-10');
  assert.equal(oct.revenue, 449); assert.equal(oct.costs.ads, 1000); assert.equal(oct.costs.fixed, 50); assert.equal(oct.net, -601);
  assert.equal(r.events[0].tok8, 'c1c5fcf5'); assert.equal(r.events[0].msgs_cost, 30); assert.equal(r.events[0].margin, 419);
  assert.equal(r.invoices[0].status, 'pending');
  assert.equal((await (await get(e, '/api/ops/finance?range=90d')).json()).cached, true);
  const m = await (await post(e, '/api/ops/finance', { set_manual: { month: '2026-10', vendor: 'monday', ils: 120 } })).json();
  assert.deepEqual(m.manual, { monday: 120 });
  assert.equal((await post(e, '/api/ops/finance', { set_manual: { month: '2026-10', vendor: 'nope', ils: 1 } })).status, 400);
});

test('invoice-resend: no invoice → 404; without confirm → preview only, nothing sent', async () => {
  const e = env();
  assert.equal((await post(e, '/api/ops/invoice-resend', { token: TOK })).status, 404);
  e.RATE.m.set('invoice:' + TOK, JSON.stringify({ url: 'https://inv/1', number: '7' })); e.RATE.m.set('invoicetmpl', 'ishur_heshbonit');
  const r = await (await post(e, '/api/ops/invoice-resend', { token: TOK })).json();
  assert.equal(r.applied, false); assert.equal(r.preview.confirm_required, 'c1c5fcf5'); assert.equal(r.preview.url, 'https://inv/1');
  assert.ok(!calls.some(c => /\/messages/.test(c.u)), 'no WhatsApp request');
});

test('ads: Shalev campaign flagged read-only; templates across WABAs; variant needs typed confirm', async () => {
  const e = env();
  const a = await (await get(e, '/api/ops/ads?range=30d')).json();
  assert.equal(a.campaigns[0].read_only, true); assert.equal(a.campaigns[0].cpl, 60);
  const t = await (await get(e, '/api/ops/templates')).json();
  assert.equal(t.templates.length, 6);
  assert.ok(t.templates.filter(x => x.pending).every(x => x.pending_since));
  calls = [];
  const v1 = await (await post(e, '/api/ops/template-variant', { waba: 'guests', name: 'hazmana', new_name: 'hazmana_v9' })).json();
  assert.equal(v1.applied, false); assert.equal(v1.confirm_required, 'hazmana_v9');
  assert.ok(!calls.some(c => c.method === 'POST'), 'no POST to Meta without confirm');
  const v2 = await (await post(e, '/api/ops/template-variant', { waba: 'guests', name: 'hazmana', new_name: 'hazmana_v9', confirm: 'hazmana_v9' })).json();
  assert.equal(v2.applied, true); assert.ok(calls.some(c => c.method === 'POST' && /message_templates$/.test(c.u)));
});

test('feedback: list + roll-up from fb: keys', async () => {
  const e = env({ ['fb:' + TOK]: JSON.stringify({ nps: 10, exp: 9, at: '2026-10-30T10:00:00Z' }), ['fb:' + TOK + ':2']: JSON.stringify({ nps: 8, exp: 8, at: '2026-10-31T10:00:00Z', note: 'מעולה' }) });
  const r = await (await get(e, '/api/ops/feedback')).json();
  assert.equal(r.feedback.length, 2); assert.equal(r.feedback[1].who, 1);
  assert.equal(r.events[0].name, 'דנה ואבי'); assert.equal(r.events[0].avg_nps, 9); assert.equal(r.totals.notes, 1);
});
