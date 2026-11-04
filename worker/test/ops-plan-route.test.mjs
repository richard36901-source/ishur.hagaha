// node --test worker/test/ops-plan-route.test.mjs — the סקירה plan through the real Worker fetch() (opsDeps, planFns, the real
// buildRealtime / buildCallRounds / buildCapacity): the status numbers equal /api/ops/realtime and /api/ops/call-rounds
// over the same KV, the pacer tick writes plan:today / week / month, and the route then answers from KV.
// Meta / Retell / Make are stubbed (same stubs as ops-routes.test.mjs); nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import * as audit from '../audit.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const plus = n => ilDay(new Date(Date.now() + n * 864e5));
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v, o) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'לקוח'; ev[5] = 'חתונה'; ev[6] = plus(5); ev[7] = 'כן'; ev[43] = 'כן'; ev[34] = 'אורי ויצחק'; ev[39] = plus(1); ev[31] = 'pro';
  const g = (n, rsvp) => { const r = Array(31).fill(''); r[28] = TOK; r[2] = 'G' + n; r[3] = 'אורח ' + n; r[4] = '05200000' + n + '1'; r[15] = rsvp; return r; };
  return { events: { values: [ev] }, guests: { values: [g(1, 'מגיע'), g(2, ''), g(3, ''), g(4, 'לא מגיע')] } };
}
let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()));
    if (/fields=business_verification_status/.test(u)) return new Response(JSON.stringify({ business_verification_status: 'not_verified' }));
    if (/messaging_limit_tier/.test(u)) return new Response(JSON.stringify({ messaging_limit_tier: 'TIER_250', quality_rating: 'GREEN', display_phone_number: '055' }));
    if (/v3\/list-calls/.test(u)) return new Response(JSON.stringify([{ call_id: 'c1', start_timestamp: Date.now() - 60e3, end_timestamp: Date.now() - 30e3, call_status: 'ended', disconnection_reason: 'user_hangup', metadata: { token: TOK } }]));
    if (/get-concurrency/.test(u)) return new Response(JSON.stringify({ current_concurrency: 0, concurrency_limit: 20 }));
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
const env = (init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_PHONE_IDS_GUESTS: 'B', WA_TOKEN_GUESTS: 't', WA_PHONE_ID_CLIENT: 'N', WA_TOKEN: 'ct',
  RETELL_KEY: 'rk', SHIR_FROM: '+972500000000', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path) => worker.fetch(new Request('https://go.ishur.io' + path, { headers: { 'X-Admin-Key': 'k' } }), e, ctx);

/* today's audit rows: 3 guest sends (one rejected), Noa 4499 → 3 lead messages, 2 of them failing 131042 afterwards */
async function seed(e) {
  for (let i = 0; i < 3; i++) await audit.record(e, { kind: 'wa_out', ok: i < 2, token: TOK, phone: '97252000000' + i, detail: i < 2 ? '' : 'error 131026', data: { phone_id: 'A', template: 'ishur_invite_v3', wave: 1, wamid: 'g' + i, error: i < 2 ? '' : '(#131026) undeliverable' } });
  for (let i = 0; i < 3; i++) await audit.record(e, { kind: 'wa_out', ok: true, phone: '97254000000' + i, data: { phone_id: 'N', template: 'noa_followup', wamid: 'n' + i } });
  for (let i = 0; i < 2; i++) await audit.record(e, { kind: 'wa_status', ok: false, detail: 'failed 131042 business eligibility payment issue', data: { status: 'failed', wamid: 'n' + i } });
}

test('route: the plan\'s status numbers are /api/ops/realtime\'s and /api/ops/call-rounds\' exactly (same KV, real builders)', async () => {
  const e = env({ 'billingalert:client': '1' });
  await seed(e);
  const [p, rt, rounds] = [await (await get(e, '/api/ops/plan?period=today&fresh=1')).json(), await (await get(e, '/api/ops/realtime')).json(), await (await get(e, '/api/ops/call-rounds')).json()];
  assert.equal(p.ok, true, JSON.stringify(p).slice(0, 300)); assert.equal(p.served, 'fresh');
  const n = p.status.numbers, T = rt.wa.totals;
  assert.equal(T.sent_today, 5); assert.equal(T.rejected_today, 1); assert.equal(T.failed_async_today, 2);
  assert.equal(n.wa_sent, T.sent_today); assert.equal(n.wa_rejected, T.rejected_today); assert.equal(n.wa_failed_async, T.failed_async_today);
  const noa = rt.wa.numbers.find(x => x.role === 'client');
  assert.equal(n.noa_sent, noa.sent_today); assert.equal(n.noa_failed, noa.rejected_today + noa.failed_async_today);
  assert.equal(n.calls_dialed, rounds.totals.dialed_today); assert.equal(n.calls_left, rounds.totals.remaining_today);
  const lead = p.days[0].items.find(i => i.kind === 'lead_sends');
  assert.equal(lead.sent_n, 3); assert.equal(lead.failed_n, 2); assert.equal(lead.done_n, 1); assert.equal(lead.needs_you, true);
  assert.ok(p.status.problems.some(x => x.code === '131042' && x.needs_you));
  assert.ok(p.days[0].items.every(i => String(i.label_he).trim() && String(i.event.name).trim()), 'no nameless row');
  for (const k of ['snapshot', 'audit_today', 'capacity', 'send_board', 'call_rounds', 'realtime']) assert.equal(typeof p.sources.ms[k], 'number', 'timed ' + k);
});

test('route: a pacer tick writes plan:today / plan:week / plan:month; the next GET is served from KV', async () => {
  const e = env();
  const tick = await (await worker.fetch(new Request('https://go.ishur.io/api/pacer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k' }) }), e, ctx)).json();
  assert.equal(tick.ok, true); assert.ok(tick.plan && tick.plan.ok, JSON.stringify(tick.plan).slice(0, 300)); assert.match(tick.plan.line, /^היום:/);
  for (const k of ['plan:today', 'plan:week', 'plan:month']) assert.ok(e.RATE.m.has(k), k);
  const r = await (await get(e, '/api/ops/plan?period=week')).json();
  assert.equal(r.served, 'kv'); assert.equal(r.cached, true); assert.equal(r.days.length, 7);
});
