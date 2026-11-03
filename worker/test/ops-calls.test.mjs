// node --test worker/test/ops-calls.test.mjs — Phase 4b call center: outcome mapping, cost math, aggregation,
// round "why not dialing", typed-confirm gating, manual-call queue, Shir admin read — pure + through the real Worker fetch().
// Retell / Make are stubbed; nothing dials, nothing is sent.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { record } from '../audit.js';
import { mapOutcome, costSplit, telnyxRate, callCostRollup, assignAttempts, callMatches, whyNotDialing, roundCards, eligibleRoundIds, roundConfirmWord, turns, timelineRow, OUTCOMES } from '../ops-calls.js';
import { callCostRollup as fromOps, buildCallCosts } from '../ops.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
const TOK2 = 'beefbeef-0000-4000-8000-0000000000bb';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const plus = n => ilDay(new Date(Date.now() + n * 864e5));

/* ── pure ─────────────────────────────────────────────────────────────── */
test('mapOutcome: every stored shape lands on one key', () => {
  assert.equal(mapOutcome({ outcome: 'מגיע', duration_s: 40 }), 'coming');
  assert.equal(mapOutcome({ outcome: 'לא מגיע', duration_s: 30 }), 'not_coming');
  assert.equal(mapOutcome({ outcome: 'מתלבט', duration_s: 30 }), 'maybe');
  assert.equal(mapOutcome({ answer: 'ענה - מתלבט', duration_s: 30 }), 'maybe');
  assert.equal(mapOutcome({ answer: 'לחייג שוב', duration_s: 12 }), 'callback');
  assert.equal(mapOutcome({ answer: 'ביקש לא להתקשר יותר', duration_s: 9 }), 'do_not_call');
  assert.equal(mapOutcome({ disconnection: 'voicemail_reached', duration_s: 20 }), 'voicemail');
  assert.equal(mapOutcome({ disconnection: 'dial_no_answer' }), 'no_answer');
  assert.equal(mapOutcome({ disconnection: 'dial_busy' }), 'no_answer');
  assert.equal(mapOutcome({ disconnection: 'dial_failed' }), 'failed');
  assert.equal(mapOutcome({ disconnection: 'user_hangup', duration_s: 0 }), 'no_answer', 'no duration = nobody talked');
  assert.equal(mapOutcome({ disconnection: 'user_hangup', duration_s: 25 }), 'answered', 'talked but no answer recorded');
  for (const k of ['coming', 'not_coming', 'maybe', 'callback', 'voicemail', 'no_answer', 'answered', 'failed', 'do_not_call']) assert.ok(OUTCOMES[k], 'Hebrew label for ' + k);
});

test('cost math: Retell ₪ as stored, Telnyx per started minute, null rate stays null (not 0)', () => {
  assert.equal(telnyxRate({}), null);
  assert.equal(telnyxRate({ TELNYX_ILS_PER_MIN: '0.12' }), 0.12);
  assert.ok(Math.abs(telnyxRate({ TELNYX_USD_PER_MIN: '0.01' }) - 0.037) < 1e-9);
  assert.deepEqual(costSplit({ cost: 0.41, duration_s: 61 }, 0.1), { retell: 0.41, telnyx: 0.2, total: 0.61, minutes: 2 });
  assert.deepEqual(costSplit({ cost: 0.2, duration_s: 0 }, 0.1), { retell: 0.2, telnyx: 0, total: 0.2, minutes: 0 });
  assert.deepEqual(costSplit({ cost: 0.333, duration_s: 30 }, null), { retell: 0.33, telnyx: null, total: 0.33, minutes: 1 });
});

const rowsFix = (rate) => [
  { day: '2026-11-02', kind: 'guest', tok8: 'c1c5fcf5', event: 'אורי ויצחק', duration_s: 61, cost: costSplit({ cost: 0.5, duration_s: 61 }, rate) },
  { day: '2026-11-03', kind: 'guest', tok8: 'c1c5fcf5', event: 'אורי ויצחק', duration_s: 30, cost: costSplit({ cost: 0.25, duration_s: 30 }, rate) },
  { day: '2026-11-03', kind: 'guest', tok8: 'beefbeef', event: 'דנה', duration_s: 0, cost: costSplit({ cost: 0.05, duration_s: 0 }, rate) },
  { day: '2026-11-03', kind: 'lead', tok8: '', event: '', duration_s: 120, cost: costSplit({ cost: 1, duration_s: 120 }, rate) },
];
test('callCostRollup: per day + per event + total add up; leads get their own bucket; ops.js re-exports it', () => {
  const r = callCostRollup(rowsFix(0.1), { rate: 0.1 });
  assert.equal(fromOps, callCostRollup);
  assert.equal(r.currency, 'ILS'); assert.equal(r.telnyx_basis, 'estimate');
  assert.deepEqual(r.by_day.map(x => x.day), ['2026-11-03', '2026-11-02']);
  assert.equal(r.total.calls, 4); assert.equal(r.total.connected, 3); assert.equal(r.total.minutes, 2 + 1 + 0 + 2);
  assert.equal(r.total.retell, 1.8); assert.equal(r.total.telnyx, 0.5); assert.equal(r.total.total, 2.3);
  assert.equal(r.by_day.reduce((n, d) => n + d.total, 0).toFixed(2), r.total.total.toFixed(2));
  assert.equal(r.by_event.reduce((n, d) => n + d.total, 0).toFixed(2), r.total.total.toFixed(2));
  const ev = Object.fromEntries(r.by_event.map(x => [x.key, x]));
  assert.equal(ev.c1c5fcf5.calls, 2); assert.equal(ev.c1c5fcf5.retell, 0.75); assert.equal(ev.lead.event, 'נועה · לידים');
  const u = callCostRollup(rowsFix(null), { rate: null });
  assert.equal(u.total.telnyx, null, 'unknown Telnyx rate is reported as unknown'); assert.equal(u.telnyx_basis, 'unknown'); assert.equal(u.total.total, 1.8);
});

test('assignAttempts: nth call per guest in time order; filters by event / outcome list / number / agent', () => {
  const rows = assignAttempts([
    { id: 'c3', ts: 3, guest_id: 'G-a-1' }, { id: 'c1', ts: 1, guest_id: 'G-a-1' }, { id: 'c2', ts: 2, guest_id: 'G-a-2' }, { id: 'c4', ts: 4, phone: '972521111111' }, { id: 'c5', ts: 5, phone: '972521111111' }]);
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.id, r.attempt])), { c1: 1, c2: 1, c3: 2, c4: 1, c5: 2 });
  const r = { tok8: 'c1c5fcf5', event: 'אורי', outcome: 'voicemail', phone: '972521234567', agent: 'שיר', kind: 'guest' };
  assert.ok(callMatches(r, { event: TOK })); assert.ok(!callMatches(r, { event: 'beefbeef' }));
  assert.ok(callMatches(r, { outcome: 'no_answer,voicemail' })); assert.ok(!callMatches(r, { outcome: 'coming' }));
  assert.ok(callMatches(r, { number: '052-123' })); assert.ok(callMatches(r, { number: '0521234567' })); assert.ok(!callMatches(r, { number: '0549' }));
  assert.ok(callMatches(r, { agent: 'שיר' })); assert.ok(callMatches(r, { agent: 'guest' })); assert.ok(!callMatches(r, { agent: 'נועה' }));
});

test('whyNotDialing: every gate gives its own reason; clean gates → []', () => {
  const open = { open: true };
  assert.deepEqual(whyNotDialing({ window: open, queued: 3, remaining: 2, capacityLeft: 10 }), []);
  const codes = g => whyNotDialing({ window: open, queued: 3, remaining: 2, capacityLeft: 10, ...g }).map(x => x.code);
  assert.deepEqual(codes({ paused: true }), ['paused']);
  assert.deepEqual(codes({ window: { open: false, why: 'after-hours' } }), ['window']);
  assert.match(whyNotDialing({ window: { open: false, why: 'after-hours' }, queued: 1, remaining: 1 })[0].he, /after-hours/);
  assert.deepEqual(codes({ offDispatch: true, hold: true, stopped: { by: 'Richard' } }), ['off:shir_dispatch', 'hold', 'stopped']);
  assert.deepEqual(codes({ capReached: true }), ['daily-cap']);
  assert.deepEqual(codes({ planNoCalls: true }), ['plan']);
  assert.deepEqual(codes({ eventPassed: true }), ['event-passed']);
  assert.deepEqual(codes({ queued: 0 }), ['empty']);
  assert.deepEqual(codes({ queued: 0, capped: 4 }), ['all-capped']);
  assert.deepEqual(codes({ remaining: 0 }), ['done-today']);
  assert.deepEqual(codes({ capacityLeft: 0 }), ['no-capacity']);
  assert.deepEqual(codes({ noContactDay: true, notConfigured: true, offPacer: true }), ['not-configured', 'off:d_pacer', 'no-contact-day']);
});

function evRow(tok, { plan = 'pro', date = plus(5), name = 'אורי ויצחק', cancelled = '' } = {}) { const ev = Array(50).fill(''); ev[1] = tok; ev[2] = 'לקוח'; ev[5] = 'חתונה'; ev[6] = date; ev[34] = name; ev[31] = plan; ev[27] = cancelled; return ev; }
function gRow(tok, n, { rsvp = '', flag = 'נדרשת שיחה', tries = '0', phone } = {}) { const r = Array(31).fill(''); r[28] = tok; r[2] = `G-${tok.slice(0, 8)}-${n}`; r[3] = 'אורח ' + n; r[4] = phone || '97252000000' + n; r[15] = rsvp; r[21] = flag; r[29] = tries; return r; }
test('roundCards: queued / capped / remaining today / plan-without-calls / today results per event', () => {
  const today = ilDay();
  const queue = [
    { guest_id: 'G-c1c5fcf5-1', token: TOK, event_name: 'אורי', event_date: plus(5), plan: 'premium', max_tries: 3, capped: false },
    { guest_id: 'G-c1c5fcf5-2', token: TOK, event_name: 'אורי', event_date: plus(5), plan: 'premium', max_tries: 3, capped: false },
    { guest_id: 'G-c1c5fcf5-3', token: TOK, event_name: 'אורי', event_date: plus(5), plan: 'premium', max_tries: 3, capped: true },
  ];
  const raw = { events: { values: [evRow(TOK, { plan: 'premium' }), evRow(TOK2, { plan: 'basic', name: 'דנה' })] }, guests: { values: [gRow(TOK2, 1), gRow(TOK2, 2, { flag: '' })] } };
  const todayRows = [{ kind: 'guest', token: TOK, event: 'אורי', duration_s: 40, outcome: 'coming', cost: { total: 0.4 } }, { kind: 'guest', token: TOK, duration_s: 0, outcome: 'no_answer', cost: { total: 0.05 } }];
  const cards = roundCards({ queue, raw, today, todayRows, triedToday: new Set(['G-c1c5fcf5-1']), gates: { window: { open: true } }, perEvent: { [TOK]: { stopped: null } }, capacityLeft: 30 });
  const a = cards.find(c => c.token === TOK), b = cards.find(c => c.token === TOK2);
  assert.equal(a.queued, 2); assert.equal(a.capped, 1); assert.equal(a.remaining_today, 1, 'G-1 already tried today');
  assert.equal(a.dialed_today, 2); assert.equal(a.answered_today, 1); assert.equal(a.cost_today, 0.45); assert.deepEqual(a.outcomes_today, { coming: 1, no_answer: 1 });
  assert.equal(a.will_dial, true); assert.deepEqual(a.why, []); assert.equal(a.confirm_word, 'c1c5fcf5');
  assert.equal(b.plan_no_calls, true); assert.equal(b.queued, 1); assert.equal(b.will_dial, false); assert.deepEqual(b.why.map(x => x.code), ['plan']);
  const stopped = roundCards({ queue, raw: null, today, gates: { window: { open: true } }, perEvent: { [TOK]: { stopped: { at: 'x', by: 'Richard' } } }, capacityLeft: 30 })[0];
  assert.equal(stopped.will_dial, false); assert.deepEqual(stopped.why.map(x => x.code), ['stopped']);
});

test('eligibleRoundIds: this event, no definite RSVP, Israeli mobile only', () => {
  const raw = { guests: { values: [gRow(TOK, 1), gRow(TOK, 2, { rsvp: 'מגיע' }), gRow(TOK, 3, { rsvp: 'מתלבט' }), gRow(TOK, 4, { phone: '14155550100' }), gRow(TOK2, 5), gRow(TOK, 6, { phone: '0521234567' })] } };
  assert.deepEqual(eligibleRoundIds(raw, TOK), ['G-c1c5fcf5-1', 'G-c1c5fcf5-3', 'G-c1c5fcf5-6']);
  assert.equal(roundConfirmWord(TOK), 'c1c5fcf5');
});

test('turns: Retell transcript_object first, plain "Agent:/User:" text as fallback', () => {
  assert.deepEqual(turns({ transcript_object: [{ role: 'agent', content: 'היי' }, { role: 'user', content: 'כן' }] }), [{ role: 'agent', text: 'היי' }, { role: 'user', text: 'כן' }]);
  assert.deepEqual(turns({ transcript: 'Agent: שלום\nUser: מגיעים שניים' }), [{ role: 'agent', text: 'שלום' }, { role: 'user', text: 'מגיעים שניים' }]);
});

test('timelineRow: audit call record → row (no transcript in the list, recording flag only)', () => {
  const r = timelineRow({ ts: Date.now(), phone: '972520000001', token: TOK, cost: 0.37, detail: 'Agent: היי', data: { call_id: 'call_abc123def', guest_name: 'דנה', guest_id: 'G-c1c5fcf5-1', event_name: 'אורי', outcome: 'מגיע', duration_s: 70, recording: '/rec/call_abc123def', agent: 'שיר', disconnection: 'agent_hangup', summary: 'אישרה' } }, 0.1);
  assert.equal(r.outcome, 'coming'); assert.equal(r.outcome_he, 'מגיע'); assert.equal(r.kind, 'guest'); assert.equal(r.tok8, 'c1c5fcf5');
  assert.deepEqual(r.cost, { retell: 0.37, telnyx: 0.2, total: 0.57, minutes: 2 });
  assert.equal(r.has_recording, true); assert.equal(r.has_transcript, true); assert.equal('transcript' in r, false); assert.equal('recording' in r, false);
});

/* ── through the Worker ───────────────────────────────────────────────── */
function kv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, { v: String(v) }]));
  return { m, get: async (k, t) => m.has(k) ? (t === 'arrayBuffer' ? new TextEncoder().encode(m.get(k).v).buffer : m.get(k).v) : null,
    put: async (k, v, o = {}) => { m.set(k, { v: String(v), meta: o.metadata }); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: m.get(name).meta })), list_complete: true }),
    getWithMetadata: async k => ({ value: m.has(k) ? m.get(k).v : null, metadata: m.has(k) ? m.get(k).meta : null }) };
}
const has = (e, k) => e.RATE.m.has(k);
const val = (e, k) => e.RATE.m.has(k) ? e.RATE.m.get(k).v : null;
function snapshot() {
  return { events: { values: [evRow(TOK, { plan: 'premium' })] }, guests: { values: [gRow(TOK, 1), gRow(TOK, 2), gRow(TOK, 3, { tries: '3' }), gRow(TOK, 4, { rsvp: 'מגיע', flag: '' })] } };
}
let realFetch, calls = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, init });
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()));
    if (u === 'https://hook.test/events') return new Response('ok', { status: 200 });
    if (/\/v2\/get-call\/call_live0001/.test(u)) return new Response(JSON.stringify({ call_id: 'call_live0001', start_timestamp: Date.now() - 90e3, end_timestamp: Date.now() - 20e3, to_number: '+972520000001', disconnection_reason: 'agent_hangup', metadata: { token: TOK }, transcript_object: [{ role: 'agent', content: 'היי, מדברת שיר' }, { role: 'user', content: 'מגיעים' }], call_analysis: { call_summary: 'האורח אישר הגעה', user_sentiment: 'Positive', custom_analysis_data: { outcome: 'מגיע', party_size: 2 } } }));
    if (/get-call\//.test(u)) return new Response('{}', { status: 404 });
    if (/\/get-agent\//.test(u)) return new Response(JSON.stringify({ agent_id: 'a', response_engine: { llm_id: 'llm_1' }, voice_id: '11labs-Shir', voice_speed: 1.05, language: 'he-IL', interruption_sensitivity: 0.8, enable_backchannel: true, post_call_analysis_data: [{ name: 'outcome' }] }));
    if (/\/get-retell-llm\/llm_1/.test(u)) return new Response(JSON.stringify({ llm_id: 'llm_1', model: 'gpt-4.1', begin_message: '', general_prompt: 'את שיר' }));
    if (/create-phone-call|v2\/create/.test(u)) throw new Error('a test must never dial');
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });
const env = (init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events', RETELL_KEY: 'rk', SHIR_FROM: '+972500000000', TELNYX_ILS_PER_MIN: '0.1', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { headers: key ? { 'X-Admin-Key': key } : {} }), e, ctx);
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...body }) }), e, ctx);
async function seedCalls(e) {
  const t = Date.now() - 3 * 3600e3;
  const mk = (i, data, cost, dt = 0) => record(e, { kind: 'call', area: data.agent || 'שיר', action: '📞', ok: true, phone: data.phone || '972520000001', token: data.token ?? TOK, detail: data.detail || 'Agent: היי\nUser: כן', cost, data: { call_id: 'call_seed000' + i, guest_name: 'אורח', event_name: 'אורי ויצחק', duration_s: 0, agent: 'שיר', ...data }, ts: t + i * 60e3 + dt });
  await mk(1, { guest_id: 'G-c1c5fcf5-1', disconnection: 'dial_no_answer' }, 0.05);
  await mk(2, { guest_id: 'G-c1c5fcf5-1', outcome: 'מגיע', duration_s: 65, recording: '/rec/call_seed0002', disconnection: 'agent_hangup' }, 0.6);
  await mk(3, { guest_id: 'G-c1c5fcf5-2', disconnection: 'voicemail_reached', duration_s: 18 }, 0.2);
  await mk(4, { agent: 'נועה', phone: '972541111111', token: '', guest_id: '', answer: 'לחייג שוב', duration_s: 40 }, 0.4);
}

test('routes: auth on every new call route', async () => {
  const e = env();
  for (const p of ['calls', 'call?id=call_x123456', 'call-rounds', 'manual-calls', 'shir', 'call-costs']) assert.equal((await get(e, '/api/ops/' + p, 'wrong')).status, 403, p);
});

test('GET /api/ops/calls: today timeline, outcomes, attempts, costs, filters', async () => {
  const e = env(); await seedCalls(e);
  const j = await (await get(e, '/api/ops/calls')).json();
  assert.equal(j.ok, true); assert.equal(j.items.length, 4);
  const by = Object.fromEntries(j.items.map(r => [r.id, r]));
  assert.equal(by.call_seed0001.outcome, 'no_answer'); assert.equal(by.call_seed0002.outcome, 'coming'); assert.equal(by.call_seed0003.outcome, 'voicemail'); assert.equal(by.call_seed0004.outcome, 'callback');
  assert.equal(by.call_seed0004.kind, 'lead'); assert.equal(by.call_seed0004.agent, 'נועה');
  assert.equal(by.call_seed0001.attempt, 1); assert.equal(by.call_seed0002.attempt, 2, 'second call to the same guest'); assert.equal(j.attempt_basis, 'range');
  assert.ok(j.items[0].ts >= j.items[1].ts, 'newest first');
  assert.deepEqual(by.call_seed0002.cost, { retell: 0.6, telnyx: 0.2, total: 0.8, minutes: 2 });
  assert.equal(j.costs.total.calls, 4); assert.equal(j.costs.total.retell, 1.25); assert.equal(j.costs.total.telnyx, 0.1 * (0 + 2 + 1 + 1));
  assert.deepEqual(j.counts, { no_answer: 1, coming: 1, voicemail: 1, callback: 1 });
  assert.equal((await (await get(e, '/api/ops/calls?outcome=coming,voicemail')).json()).items.length, 2);
  assert.equal((await (await get(e, '/api/ops/calls?event=c1c5fcf5')).json()).items.length, 3);
  assert.equal((await (await get(e, '/api/ops/calls?number=054-1111111')).json()).items.length, 1);
  assert.equal((await (await get(e, '/api/ops/calls?agent=נועה'.replace('נועה', encodeURIComponent('נועה')))).json()).items.length, 1);
  const pg = await (await get(e, '/api/ops/calls?limit=3')).json();
  assert.equal(pg.items.length, 3); assert.ok(pg.cursor);
  const pg2 = await (await get(e, '/api/ops/calls?limit=3&cursor=' + encodeURIComponent(pg.cursor))).json();
  assert.equal(pg2.items.length, 1); assert.equal(new Set([...pg.items, ...pg2.items].map(r => r.id)).size, 4);
  const wk = await (await get(e, '/api/ops/calls?week=1')).json();
  assert.equal(wk.from, plus(-6)); assert.equal(wk.items.length, 4);
  assert.ok(!calls.some(c => /create-phone-call/.test(c.u)), 'nothing dialed');
});

test('GET /api/ops/call: Retell transcript turns + summary + a SIGNED Worker recording link that /rec/ accepts', async () => {
  const e = env({ 'recmeta:call_live0001': JSON.stringify({ at: new Date().toISOString(), phone: '972520000001', agent: 'שיר', mime: 'audio/wav', bytes: 5, name: 'x.wav', token: TOK, duration_ms: 70000, outcome: 'מגיע' }), 'rec:call_live0001': 'RIFF0' });
  const j = await (await get(e, '/api/ops/call?id=call_live0001')).json();
  assert.equal(j.ok, true); assert.equal(j.transcript.length, 2); assert.equal(j.transcript[0].role, 'agent'); assert.equal(j.summary, 'האורח אישר הגעה');
  assert.equal(j.analysis.party_size, 2); assert.equal(j.call.outcome, 'coming'); assert.equal(j.sources.retell, true);
  assert.match(j.recording.url, /^https:\/\/go\.ishur\.io\/rec\/call_live0001\?e=\d+&s=[0-9a-f]{32}$/);
  assert.ok(Date.parse(j.recording.expires_at) - Date.now() <= 86400e3 + 5000, 'link lives ≤ 1 day');
  const u = new URL(j.recording.url);
  const rec = await worker.fetch(new Request('https://go.ishur.io' + u.pathname + u.search), e, ctx);
  assert.equal(rec.status, 200, 'the signed link plays without the admin key'); assert.equal(rec.headers.get('Content-Type'), 'audio/wav');
  const bad = await worker.fetch(new Request('https://go.ishur.io' + u.pathname + '?e=' + u.searchParams.get('e') + '&s=' + '0'.repeat(32)), e, ctx);
  assert.equal(bad.status, 403, 'a forged signature is refused');
  assert.equal((await get(e, '/api/ops/call?id=nope')).status, 400);
  assert.equal((await get(e, '/api/ops/call?id=call_missing99')).status, 404);
});

test('GET /api/ops/call: falls back to the audit transcript when Retell no longer has the call', async () => {
  const e = env(); await seedCalls(e);
  const j = await (await get(e, '/api/ops/call?id=call_seed0002&day=' + ilDay())).json();
  assert.equal(j.ok, true); assert.equal(j.transcript_source, 'audit'); assert.deepEqual(j.transcript.map(t => t.role), ['agent', 'user']);
  assert.equal(j.call.outcome, 'coming'); assert.equal(j.recording, null); assert.equal(j.recording_missing, 'no-metadata');
});

test('GET /api/ops/call-rounds: per-event card with queue numbers and reasons; stop flag shows up', async () => {
  const e = env({ ['callstop:' + TOK]: JSON.stringify({ at: 'x', by: 'Richard' }) });
  const j = await (await get(e, '/api/ops/call-rounds')).json();
  assert.equal(j.ok, true); assert.equal(j.events.length, 1);
  const c = j.events[0];
  assert.equal(c.tok8, 'c1c5fcf5'); assert.equal(c.queued, 2); assert.equal(c.capped, 1);
  assert.equal(c.will_dial, false); assert.ok(c.why.some(w => w.code === 'stopped'));
  assert.equal(typeof j.capacity_left_today, 'number'); assert.ok('window' in j && Array.isArray(j.global_why));
});

test('POST /api/ops/call-round: no confirm → preview, nothing written; typed tok8 → stop / start; dispatch honours the stop', async () => {
  const e = env();
  const p = await (await post(e, '/api/ops/call-round', { token: TOK, action: 'stop' })).json();
  assert.equal(p.applied, false); assert.equal(p.confirm_required, 'c1c5fcf5'); assert.equal(has(e, 'callstop:' + TOK), false);
  const w = await (await post(e, '/api/ops/call-round', { token: TOK, action: 'stop', confirm: 'stop' })).json();
  assert.equal(w.applied, false, 'a wrong word is not a confirm');
  const s = await (await post(e, '/api/ops/call-round', { token: TOK, action: 'stop', confirm: 'c1c5fcf5', reason: 'הלקוח ביקש' })).json();
  assert.equal(s.applied, true); assert.equal(JSON.parse(val(e, 'callstop:' + TOK)).reason, 'הלקוח ביקש');
  assert.ok([...e.RATE.m.keys()].some(k => k.startsWith('chg:')), 'change log entry');
  assert.ok([...e.RATE.m.entries()].some(([k, v]) => k.startsWith('stream:') && JSON.parse(v.v).kind === 'admin'), 'audit row');
  const { _runShirDispatch } = await import('../index.js');
  const d = await _runShirDispatch(e, { force: true, quiet: true });
  assert.equal(d.dialed, 0); assert.equal(d.blocked, 2, 'both open guests skipped because the round is stopped');
  assert.ok(!calls.some(c => /create-phone-call/.test(c.u)));
  const pe = await (await post(e, '/api/ops/call-round', { token: TOK, action: 'start', extra: true })).json();
  assert.equal(pe.applied, false); assert.equal(pe.extra_round_guests, 3, 'G-1, G-2, G-3 (G-4 said מגיע)'); assert.equal(has(e, 'callstop:' + TOK), true);
  const st = await (await post(e, '/api/ops/call-round', { token: TOK, action: 'start', extra: true, confirm: 'c1c5fcf5' })).json();
  assert.equal(st.applied, true); assert.equal(has(e, 'callstop:' + TOK), false);
  const job = JSON.parse(val(e, 'callround:' + TOK)); assert.equal(job.at, ilDay()); assert.deepEqual(job.guest_ids, ['G-c1c5fcf5-1', 'G-c1c5fcf5-2', 'G-c1c5fcf5-3']);
  assert.equal((await post(e, '/api/ops/call-round', { token: 'x', action: 'stop', confirm: 'x' })).status, 400);
  assert.equal((await post(e, '/api/ops/call-round', { token: TOK, action: 'dial', confirm: 'c1c5fcf5' })).status, 400);
  assert.equal((await get(e, '/api/ops/call-round')).status, 405);
});

test('manual calls: list with notes; note saves/clears; done writes through the call_result writer', async () => {
  const e = env();
  const n = await (await post(e, '/api/ops/manual-calls', { action: 'note', guest_id: 'G-c1c5fcf5-1', note: 'לחזור אחרי 18:00' })).json();
  assert.equal(n.ok, true); assert.equal(JSON.parse(val(e, 'mcnote:G-c1c5fcf5-1')).text, 'לחזור אחרי 18:00');
  const l = await (await get(e, '/api/ops/manual-calls')).json();
  assert.equal(l.ok, true); assert.equal(l.items.length, 3); assert.equal(l.open, 2);
  assert.equal(l.items.find(x => x.guest_id === 'G-c1c5fcf5-1').note.text, 'לחזור אחרי 18:00');
  assert.equal(l.items.find(x => x.guest_id === 'G-c1c5fcf5-3').capped, true);
  const bad = await post(e, '/api/ops/manual-calls', { action: 'done', guest_id: 'G-c1c5fcf5-1', outcome: 'whatever' });
  assert.equal(bad.status, 400);
  const dn = await (await post(e, '/api/ops/manual-calls', { action: 'done', guest_id: 'G-c1c5fcf5-1', outcome: 'מגיע', tries: 0 })).json();
  assert.equal(dn.ok, true); assert.equal(dn.rsvp, 'מגיע');
  const w = calls.find(c => c.u === 'https://hook.test/events'); assert.ok(w, 'the Make writer was called');
  const body = JSON.parse(w.init.body); assert.equal(body.event_type, 'call_result'); assert.equal(body.guest_id, 'G-c1c5fcf5-1'); assert.equal(body.rsvp, 'מגיע');
  await post(e, '/api/ops/manual-calls', { action: 'note', guest_id: 'G-c1c5fcf5-1', note: '' });
  assert.equal(has(e, 'mcnote:G-c1c5fcf5-1'), false);
  assert.equal((await post(e, '/api/ops/manual-calls', { action: 'note', guest_id: 'x', note: 'a' })).status, 400);
});

test('GET /api/ops/shir: prompt version, begin_message, voice settings — read only (no PATCH to Retell)', async () => {
  const e = env({ 'vpmeta:shir_out': JSON.stringify({ head: 2, list: [{ n: 1, at: 'a', note: 'בסיס', chars: 5 }, { n: 2, at: 'b', note: 'קצר יותר', chars: 5 }] }), 'vp:shir_out:2': JSON.stringify({ prompt: 'את שיר' }) });
  const j = await (await get(e, '/api/ops/shir')).json();
  assert.equal(j.ok, true); assert.equal(j.head, 2); assert.equal(j.history[0].n, 2); assert.equal(j.begin_message, ''); assert.equal(j.model, 'gpt-4.1');
  assert.equal(j.voice.voice_id, '11labs-Shir'); assert.equal(j.voice.language, 'he-IL'); assert.equal(j.live_matches_head, true); assert.equal(j.edit_via, '/api/voice-prompt');
  assert.ok(calls.every(c => !c.init.method || c.init.method === 'GET'), 'only GETs to Retell');
  assert.equal((await get(e, '/api/ops/shir?agent=nope')).status, 400);
});

test('buildCallCosts (finance hook) + GET /api/ops/call-costs agree with the timeline', async () => {
  const e = env(); await seedCalls(e);
  const j = await (await get(e, '/api/ops/call-costs')).json();
  assert.equal(j.ok, true); assert.equal(j.total.calls, 4); assert.equal(j.total.retell, 1.25); assert.equal(j.from, plus(-6));
  assert.equal(typeof buildCallCosts, 'function');
});
