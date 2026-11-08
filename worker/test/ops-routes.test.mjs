// node --test worker/test/ops-routes.test.mjs — /api/ops/* through the real Worker fetch(): auth, toggle confirm,
// registry/code/runs/live/realtime/capacity/balances shapes. Meta/Retell/Telnyx are stubbed; nothing leaves the machine.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { withRun } from '../ops-run.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const plus = n => ilDay(new Date(Date.now() + n * 864e5));
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'לקוח'; ev[5] = 'חתונה'; ev[6] = plus(5); ev[7] = 'כן'; ev[43] = 'כן'; ev[34] = 'אורי ויצחק'; ev[39] = plus(1); ev[31] = 'pro';
  const g = (n, rsvp) => { const r = Array(31).fill(''); r[28] = TOK; r[2] = 'G' + n; r[3] = 'אורח ' + n; r[4] = '05200000' + n + '1'; r[15] = rsvp; return r; };
  return { events: { values: [ev] }, guests: { values: [g(1, 'מגיע'), g(2, ''), g(3, ''), g(4, 'לא מגיע')] } };
}
let realFetch, calls = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, init });
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()));
    if (u === 'https://api.telnyx.com/v2/balance') return new Response(JSON.stringify({ data: { balance: '42.50', available_credit: '42.50', credit_limit: '0', currency: 'USD' } }));
    if (/\/act_1944903292858482\?/.test(u)) return new Response(JSON.stringify({ balance: '1200', amount_spent: '30000', spend_cap: '50000', currency: 'ILS', account_status: 1 }));
    if (/fields=business_verification_status/.test(u)) return new Response(JSON.stringify({ business_verification_status: 'not_verified' }));
    if (/pricing_analytics/.test(u)) return new Response(JSON.stringify({ pricing_analytics: { data: [{ data_points: [{ cost: 1.25, volume: 40 }, { cost: 0.75, volume: 10 }] }] } }));
    if (/messaging_limit_tier/.test(u)) return new Response(JSON.stringify({ messaging_limit_tier: 'TIER_250', quality_rating: 'GREEN', display_phone_number: '055' }));
    if (/v3\/list-calls/.test(u)) return new Response(JSON.stringify([{ call_id: 'c1', start_timestamp: Date.now() - 60e3, end_timestamp: Date.now() - 30e3, call_status: 'ended', disconnection_reason: 'user_hangup', metadata: { token: TOK } }]));
    if (/get-concurrency/.test(u)) return new Response(JSON.stringify({ current_concurrency: 0, concurrency_limit: 20 }));
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });
const env = (init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_PHONE_IDS_GUESTS: 'B', WA_TOKEN_GUESTS: 't', WA_PHONE_ID_CLIENT: 'N', WA_TOKEN: 'ct',
  RETELL_KEY: 'rk', SHIR_FROM: '+972500000000', TELNYX_KEY: 'tk', META_ADS_TOKEN: 'mt', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { headers: key ? { 'X-Admin-Key': key } : {} }), e, ctx);
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...body }) }), e, ctx);

test('auth: no key / wrong key → 403; header key, Bearer and POST body all work', async () => {
  const e = env();
  assert.equal((await get(e, '/api/ops/registry', '')).status, 403);
  assert.equal((await get(e, '/api/ops/registry', 'wrong')).status, 403);
  assert.equal((await get(e, '/api/ops/registry')).status, 200);
  assert.equal((await worker.fetch(new Request('https://go.ishur.io/api/ops/registry', { headers: { Authorization: 'Bearer k' } }), e, ctx)).status, 200);
  assert.equal((await post(e, '/api/ops/registry', {})).status, 200);
  assert.equal((await get(e, '/api/ops/nope')).status, 404);
});

test('toggle: without confirm → blast radius, NOTHING written; with confirm → auto:off:<id> + audit row; on again with confirm → key gone', async () => {
  const e = env();
  const r1 = await (await post(e, '/api/ops/toggle', { id: 'wave1', enabled: false })).json();
  assert.equal(r1.applied, false); assert.equal(r1.confirm_required, 'wave1');
  assert.ok(r1.blast_radius && r1.blast_radius.messages_next_days.total === 3, 'wave 1 tomorrow: 3 guests (not "לא מגיע")');
  assert.deepEqual(r1.blast_radius.events_affected.map(x => x.tok8), ['c1c5fcf5']);
  assert.equal(e.RATE.m.has('auto:off:wave1'), false);
  const r2 = await (await post(e, '/api/ops/toggle', { id: 'wave1', enabled: false, confirm: 'wave1', reason: 'test' })).json();
  assert.equal(r2.applied, true); assert.equal(r2.enabled_now, false);
  assert.equal(JSON.parse(e.RATE.m.get('auto:off:wave1')).reason, 'test');
  assert.ok([...e.RATE.m.entries()].some(([k, v]) => k.startsWith('stream:') && JSON.parse(v).kind === 'admin' && /wave1/.test(JSON.parse(v).action)));
  const reg = await (await get(e, '/api/ops/registry')).json();
  assert.equal(reg.nodes.find(n => n.id === 'wave1').state.enabled, false);
  assert.equal(reg.nodes.find(n => n.id === 'wave2').state.enabled, true);
  const r3 = await (await post(e, '/api/ops/toggle', { id: 'wave1', enabled: true, confirm: 'wave1' })).json();
  assert.equal(r3.applied, true); assert.equal(e.RATE.m.has('auto:off:wave1'), false);
});

test('toggle: a node without a wired switch → 409; wave_retry resolves to manual_blasts; GET → 405', async () => {
  const e = env();
  assert.equal((await post(e, '/api/ops/toggle', { id: 'report7', enabled: false, confirm: 'report7' })).status, 409);
  assert.equal((await post(e, '/api/ops/toggle', { id: 'nope', enabled: false })).status, 404);
  const r = await (await post(e, '/api/ops/toggle', { id: 'wave_retry', enabled: false, confirm: 'manual_blasts' })).json();
  assert.equal(r.switch_id, 'manual_blasts'); assert.ok(e.RATE.m.has('auto:off:manual_blasts'));
  assert.equal((await get(e, '/api/ops/toggle')).status, 405);
});

test('registry: every node has ops metadata + code_ref; code?id= returns the function text', async () => {
  const e = env();
  const reg = await (await get(e, '/api/ops/registry')).json();
  assert.ok(reg.nodes.length >= 60);
  for (const n of reg.nodes) { assert.ok(n.owner && Array.isArray(n.side_effects) && n.risk && n.desc_he, n.id); assert.ok(n.code_ref, n.id + ' code_ref'); }
  const p = reg.nodes.find(n => n.id === 'd_pacer');
  assert.deepEqual(p.kill_switch, { key: 'auto:off:d_pacer', wired: true }); assert.ok(p.state.next_fire);
  const c = await (await get(e, '/api/ops/code?id=d_pacer')).json();
  assert.ok(c.source.startsWith('async function runPacer(env, run = null')); /* 08/11: runPacer gained { part } on 04/11; the snapshot was stale until now */ assert.ok(c.line_end > c.line_start);
  assert.equal((await get(e, '/api/ops/code?id=nope')).status, 404);
});

test('runs / run / live: ledger rows (KV ring before D1 exists) with children and linked audit rows', async () => {
  const e = env();
  let id = '';
  await withRun(e, 'd_pacer', async run => { id = run.id; await run.child('doctor', async () => ({ ok: true })); return { ok: true }; }, { job: 'runPacer' });
  const runs = await (await get(e, '/api/ops/runs?automation_id=d_pacer')).json();
  assert.equal(runs.source, 'kv'); assert.equal(runs.items.length, 1); assert.equal(runs.items[0].id, id);
  const one = await (await get(e, '/api/ops/run?id=' + id)).json();
  assert.equal(one.children.length, 1); assert.ok(one.audit.some(a => a.run_match), 'the audit cron row is linked by run_id');
  const live = await (await get(e, '/api/ops/live?since=0')).json();
  assert.ok(live.items.some(x => x.type === 'run' && x.id === id)); assert.ok(live.items.some(x => x.type === 'audit'));
  assert.ok(live.items.length <= 200); assert.ok(live.cursor);
  const later = await (await get(e, '/api/ops/live?since=' + live.cursor)).json();
  assert.equal(later.items.length, 0, 'nothing newer than the cursor');
  assert.equal((await get(e, '/api/ops/run?id=nope')).status, 404);
});

test('realtime: per-number rows, cap, queue reasons, calls today, Noa, pacer — and it writes nothing but caches', async () => {
  const today = ilDay();
  const e = env({ 'pacer:last': JSON.stringify({ at: new Date().toISOString(), sends: { ran: false, why: 'nothing-pending' } }), 'billingalert:client': '1' });
  const r = await (await get(e, '/api/ops/realtime')).json();
  assert.equal(r.ok, true); assert.equal(r.today, today);
  assert.deepEqual(r.wa.numbers.map(n => [n.phone_id, n.role]), [['A', 'guests'], ['B', 'guests'], ['N', 'client']]);
  assert.ok('tier' in r.wa.numbers[0] && 'remaining' in r.wa.numbers[0] && 'failed_by_code' in r.wa.numbers[0]);
  assert.ok(r.cap && typeof r.cap.remaining === 'number');
  assert.equal(typeof r.queue.sends.why, 'string'); assert.notEqual(r.queue.sends.why, 'will-send', 'pacer:pending is not armed in this fixture');
  assert.equal(r.calls.dialed, 1); assert.equal(r.calls.answered, 1);
  assert.equal(r.noa.billing_131042, true); assert.ok(r.pacer.last_tick_at);
  const writes = [...e.RATE.m.keys()].filter(k => !/^(pacer:last|billingalert:client|wa:cap|snapcache.*|snap.*)$/.test(k));
  assert.deepEqual(writes.filter(k => !k.startsWith('stream:')), [], 'no state writes besides caches');
});

test('capacity: 14 days, shared model while unverified, the wave planned tomorrow', async () => {
  const e = env();
  const r = await (await get(e, '/api/ops/capacity')).json();
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300)); assert.equal(r.days.length, 14);
  assert.equal(r.model.model, 'shared'); assert.equal(r.verification.status, 'not_verified');
  const tomorrow = r.days.find(d => d.day === plus(1));
  if (tomorrow.open) assert.ok(tomorrow.by_event.some(x => x.type === 'w1' && x.count === 3));
  assert.ok(Array.isArray(r.recommendations));
});

test('balances: every vendor has the contract fields; telnyx equals the API; cache 10 min; manual set', async () => {
  const e = env();
  const r = await (await get(e, '/api/ops/balances')).json();
  const by = Object.fromEntries(r.vendors.map(v => [v.vendor, v]));
  assert.deepEqual(Object.keys(by).sort(), ['anthropic', 'cloudflare', 'meta_ads', 'meta_wa', 'retell', 'telnyx']);
  for (const v of r.vendors) for (const f of ['vendor', 'amount', 'currency', 'source', 'checked_at', 'dashboard_url', 'topup_url', 'auto_topup', 'status']) assert.ok(f in v, v.vendor + '.' + f);
  assert.equal(by.telnyx.amount, 42.5); assert.equal(by.telnyx.source, 'api'); assert.equal(by.telnyx.status, 'ok');
  assert.equal(by.meta_ads.amount, 200); assert.equal(by.meta_ads.extra.balance_owed, 12);
  assert.equal(by.meta_wa.amount, 4); /* 2 WABAs × 2.00 */
  assert.equal(by.retell.source, 'manual'); assert.equal(by.cloudflare.source, 'manual');
  calls = [];
  const again = await (await get(e, '/api/ops/balances')).json();
  assert.equal(again.cached, true); assert.equal(calls.length, 0);
  const set = await (await post(e, '/api/ops/balances', { set: { vendor: 'retell', amount: 7, currency: 'USD', auto_topup: 'on' } })).json();
  assert.equal(set.ok, true);
  const after = await (await get(e, '/api/ops/balances')).json();
  const rt = after.vendors.find(v => v.vendor === 'retell');
  assert.equal(rt.amount, 7); assert.equal(rt.status, 'low'); assert.equal(rt.auto_topup, 'on');
});

test('calendar: route returns the month grid with the projected wave, every day once, closed Shabbat, read-only besides caches', async () => {
  const e = env();
  const month = plus(1).slice(0, 7);
  const r = await (await get(e, '/api/ops/calendar?month=' + month)).json();
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300)); assert.equal(r.month, month);
  const [y, m] = month.split('-').map(Number); assert.equal(r.days.length, new Date(Date.UTC(y, m, 0)).getUTCDate());
  for (const d of r.days) { assert.ok(d.date.startsWith(month)); if (d.dow === 6) { assert.equal(d.open, false); assert.equal(d.capacity, 0); assert.equal(d.items.filter(i => ['planned', 'rolled'].includes(i.state)).length, 0); } }
  const t1 = r.days.find(d => d.date === plus(1));
  if (t1 && t1.open) assert.ok(t1.items.some(i => i.type === 'w1' && i.state === 'planned' && i.n === 3), JSON.stringify(t1.items));
  const evDay = r.days.find(d => d.date === plus(5)); if (evDay) assert.deepEqual(evDay.events.map(x => [x.name, x.type]), [['אורי ויצחק', 'חתונה']]);
  assert.ok(Array.isArray(r.events));
  const bad = await (await get(e, '/api/ops/calendar?month=2026-13')).json();
  assert.equal(bad.month, ilDay().slice(0, 7), 'a bad month falls back to this month');
  assert.ok([...e.RATE.m.keys()].some(k => k.startsWith('opscal:')), '5-minute cache written');
});

/* 04/11 מתוכנן מול בוצע (ops-plan.js) through the real router: shape, periods, cache */
test('plan: GET /api/ops/plan?period= → the three periods, day cells with totals, items with the 4-state contract; second call is served from the 5-minute cache', async () => {
  const e = env();
  const p = await (await get(e, '/api/ops/plan?period=week')).json();
  assert.equal(p.ok, true); assert.equal(p.period, 'week'); assert.equal(p.days.length, 7);
  assert.deepEqual(Object.keys(p.totals), ['planned', 'done', 'in_progress', 'waiting', 'missed']);
  assert.ok(p.days.every(d => d.day && d.dow_he && Array.isArray(d.items) && d.totals && 'open' in d));
  assert.ok(p.days.flatMap(d => d.items).every(i => ['done', 'in_progress', 'waiting', 'missed'].includes(i.status) && i.status_he && i.label_he && i.deep_link && i.planned_at && i.event && 'planned_n' in i && 'done_n' in i && 'failed_n' in i));
  assert.ok(p.days.flatMap(d => d.items).some(i => i.kind === 'cron'), 'the once-a-day crons are planned');
  assert.equal(p.sources.capacity, true); assert.equal(p.sources.snapshot, true);
  assert.equal(p.days.find(d => d.day === ilDay()).today, true);
  const t = await (await get(e, '/api/ops/plan')).json(); assert.equal(t.period, 'today'); assert.equal(t.days.length, 1);
  const m = await (await get(e, '/api/ops/plan?period=month')).json(); assert.ok(m.days.length >= 28 && m.from.endsWith('-01'));
  const again = await (await get(e, '/api/ops/plan?period=week')).json(); assert.equal(again.cached, true);
  const fresh = await (await get(e, '/api/ops/plan?period=week&fresh=1')).json(); assert.ok(!fresh.cached);
  assert.equal((await (await get(e, '/api/ops/plan?period=zzz')).json()).period, 'today');
});
