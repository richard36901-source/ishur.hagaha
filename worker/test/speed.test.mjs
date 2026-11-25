// node --test worker/test/speed.test.mjs — 26/11 track-speed: the admin pages and the client board load faster.
// §1 client-flags reads the events in parallel (same answer, same reads); §2 the overview reads answer from a copy that is
// ≤ 2 min old and dropped by any admin change; §3 ux.js no longer makes every page load twice on a cold open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../index.js';
import { clientFlags } from '../speed.js';
import { swrKey, swrServe, swrReset, swrBust, swrHook, OVERVIEW, BUST_KEY } from '../swr.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* a KV fake that counts every call and can answer slowly (lat ms per call, like a real KV round trip) */
function kv(init = {}, lat = 0) {
  const m = new Map(Object.entries(init)); const n = { get: 0, put: 0, list: 0 };
  return { m, n,
    get: async k => { n.get++; if (lat) await sleep(lat); return m.has(k) ? m.get(k) : null; },
    put: async (k, v) => { n.put++; m.set(k, String(v)); },
    delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => { n.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
    getWithMetadata: async () => ({ value: null }) };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

/* ── §1 client-flags ───────────────────────────────────────────────────── */
const tok = i => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
function flagData(N) {
  const d = {};
  for (let i = 0; i < N; i++) {
    const t = tok(i);
    if (i % 5 === 0) d['inactive:' + t] = '1';
    if (i % 3 === 0) d['addon:' + t] = JSON.stringify({ n: i });
    if (i % 4 === 0) d['extrasend:' + t] = '1';
    if (i % 6 === 0) d['callsaddon:' + t] = '1';
    if (i % 2 === 0) d['wave:' + t + ':1'] = '1'; else if (i % 7 === 0) d['wpos:' + t + ':1'] = '12';
    if (i % 9 === 0) d['vidok:' + t] = '1';
    if (i % 8 === 0) { d['hold:' + t] = '1'; d['holdtill:' + t] = '2026-12-01'; }
    if (i % 10 === 0) d['cstop:' + t] = JSON.stringify({ at: '2026-11-25', by: 'client' });
  }
  return d;
}
const stopDeps = { clientStopOf: async (env, t) => { const v = await env.RATE.get('cstop:' + t); return v ? JSON.parse(v) : null; }, publicStop: cs => ({ at: cs.at }) };
/* the handler as it was before 26/11 (one event after another), kept here as the reference answer */
async function serialFlags(env, toks, deps) {
  const out = {};
  for (const t of toks) {
    const [inactive, addon, extra, calls, wave, vid, hold, holdtill, wpos] = await Promise.all(['inactive:' + t, 'addon:' + t, 'extrasend:' + t, 'callsaddon:' + t, 'wave:' + t + ':1', 'vidok:' + t, 'hold:' + t, 'holdtill:' + t, 'wpos:' + t + ':1'].map(k => env.RATE.get(k).catch(() => null)));
    out[t] = { active: !inactive, addon: addon ? (JSON.parse(addon).n || 0) : 0, extrasend: !!extra, calls: !!calls, sent: !!wave, sending: !wave && (parseInt(wpos, 10) || 0) > 0, video: !!vid, hold: !!hold, hold_till: holdtill || '' };
    { const cs = await deps.clientStopOf(env, t); if (cs) out[t].client_stop = deps.publicStop(cs); }
  }
  return out;
}

test('client-flags: byte-identical answer and the same number of KV reads as the old serial loop', async () => {
  const toks = Array.from({ length: 120 }, (_, i) => tok(i));
  const a = { RATE: kv(flagData(120)) }, b = { RATE: kv(flagData(120)) };
  const old = await serialFlags(a, toks, stopDeps), neu = await clientFlags(b, toks, stopDeps);
  assert.equal(JSON.stringify(neu), JSON.stringify(old), 'same flags, same key order');
  assert.equal(b.RATE.n.get, a.RATE.n.get); assert.equal(b.RATE.n.get, 120 * 10);
  assert.ok(Object.values(neu).some(f => f.client_stop) && Object.values(neu).some(f => f.sending), 'the fixture covers every flag');
});
test('client-flags: with a 20 ms KV, 100 events take a fraction of the serial time', async () => {
  const toks = Array.from({ length: 100 }, (_, i) => tok(i));
  let t0 = Date.now(); await serialFlags({ RATE: kv(flagData(100), 20) }, toks, stopDeps); const serialMs = Date.now() - t0;
  t0 = Date.now(); await clientFlags({ RATE: kv(flagData(100), 20) }, toks, stopDeps); const parMs = Date.now() - t0;
  assert.ok(parMs * 5 < serialMs, `parallel ${parMs} ms vs serial ${serialMs} ms`);
});
test('client-flags route: admin key required, answers through speed.js', async () => {
  const env = { ADMIN_KEY: 'k', RATE: kv(flagData(3)) };
  const call = body => worker.fetch(new Request('https://go.ishur.io/api/client-flags', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify(body) }), env, ctx);
  assert.equal((await call({ admin_key: 'no', tokens: [tok(0)] })).status, 403);
  const j = await (await call({ admin_key: 'k', tokens: [tok(0), tok(1), 'not-a-token', tok(2)] })).json();
  assert.deepEqual(Object.keys(j.flags), [tok(0), tok(1), tok(2)]);
  assert.equal(j.flags[tok(0)].active, false); assert.equal(j.flags[tok(1)].active, true); assert.equal(j.flags[tok(0)].sent, true);
});

/* ── §2 overview copies ────────────────────────────────────────────────── */
test('overview key: only the plain overview question; an event, an action, a search or a guest is always live', () => {
  assert.equal(swrKey('/api/leads', { admin_key: 'a', nonce: 'n', stamp_ts: 1, sig: 's', app: 'w' }), 'leads:{}');
  assert.equal(swrKey('/api/traffic', { admin_key: 'a', days: 90 }), 'traffic:{"days":90}');
  assert.equal(swrKey('/api/future-log', { admin_key: 'a', days: 14, session: 'us.x' }), 'future-log:{"days":14}');
  assert.equal(swrKey('/api/answers-log', { admin_key: 'a' }), 'answers-log:{}');
  assert.equal(swrKey('/api/answers-log', { admin_key: 'a', token: tok(1) }), '', 'one event: live');
  assert.equal(swrKey('/api/answers-log', { admin_key: 'a', action: 'set', rsvp: 'מגיע' }), '', 'a change: never');
  assert.equal(swrKey('/api/future-log', { admin_key: 'a', action: 'live' }), '', 'live calls: live');
  assert.equal(swrKey('/api/referrals', { admin_key: 'a', act: 'approve' }), '');
  assert.equal(swrKey('/api/traffic', { admin_key: 'a', days: { x: 1 } }), '');
  for (const p of Object.keys(OVERVIEW)) assert.ok(OVERVIEW[p].hard <= 120 && OVERVIEW[p].soft < OVERVIEW[p].hard, p + ': never older than 2 minutes');
});
test('overview: two opens build once; past soft it is rebuilt behind; past 2 minutes it is built first', async () => {
  swrReset(); const env = { RATE: kv() }; let n = 0; const jobs = []; const c = { waitUntil: p => jobs.push(p) };
  const call = now => swrServe({ pathname: '/api/leads', body: { admin_key: 'k' }, env, ctx: c, now, produce: async () => JSON.stringify({ ok: true, n: ++n }) });
  const t0 = Date.now();
  let r = await call(t0); assert.deepEqual([r.cached, n], [false, 1]);
  r = await call(t0 + 5000); assert.deepEqual([r.cached, JSON.parse(r.text).n, n, jobs.length], [true, 1, 1, 0]);
  r = await call(t0 + 60e3); assert.deepEqual([r.cached, jobs.length], [true, 1]); await Promise.all(jobs); assert.equal(n, 2);
  r = await call(Date.now() + 121e3); assert.deepEqual([r.cached, JSON.parse(r.text).n], [false, 3], 'older than 2 minutes: never shown');
});
test('an admin change drops every overview copy (this isolate and, through KV, the others); the old heavy routes keep theirs', async () => {
  swrReset(); const env = { RATE: kv() }; let n = 0, f = 0;
  const leads = () => swrServe({ pathname: '/api/leads', body: {}, env, ctx, produce: async () => JSON.stringify({ ok: true, n: ++n }) });
  const floor = () => swrServe({ pathname: '/api/floor', body: {}, env, ctx, produce: async () => JSON.stringify({ ok: true, f: ++f }) });
  await leads(); await floor(); assert.equal((await leads()).cached, true);
  await sleep(2); await swrBust(env); assert.ok(env.RATE.m.get(BUST_KEY));
  const r = await leads(); assert.deepEqual([r.cached, JSON.parse(r.text).n], [false, 2], 'built again after the change');
  assert.equal((await floor()).cached, true, 'the live floor keeps its own rules');
  /* another isolate: memory empty, the copy and the bust marker come from KV */
  await sleep(2); await swrBust(env); swrReset();
  const r2 = await leads(); assert.deepEqual([r2.cached, n], [false, 3]);
});
test('a copy whose build started before the change is not kept as fresh', async () => {
  swrReset(); const env = { RATE: kv() }; let n = 0;
  const slow = swrServe({ pathname: '/api/cost-log', body: {}, env, ctx, produce: async () => { await sleep(15); return JSON.stringify({ ok: true, n: ++n }); } });
  await sleep(5); await swrBust(env); await slow;
  const r = await swrServe({ pathname: '/api/cost-log', body: {}, env, ctx, produce: async () => JSON.stringify({ ok: true, n: ++n }) });
  assert.deepEqual([r.cached, n], [false, 2]);
});
test('swrHook: serves only an admin; a change on an overview route drops the copies and goes through', async () => {
  swrReset(); const env = { RATE: kv() }; let built = 0;
  const deps = { isAdmin: (e, k) => k === 'k', cors: () => ({}), fetchMain: async () => { built++; return new Response(JSON.stringify({ ok: true, built })); } };
  const req = body => new Request('https://go.ishur.io/api/answers-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const url = new URL('https://go.ishur.io/api/answers-log');
  assert.equal(await swrHook({ request: req({ admin_key: 'no' }), url, env, ctx, origin: '', deps }), null, 'not an admin: falls through to the route');
  const a = await swrHook({ request: req({ admin_key: 'k' }), url, env, ctx, origin: '', deps }); assert.equal((await a.json()).built, 1);
  const b = await swrHook({ request: req({ admin_key: 'k' }), url, env, ctx, origin: '', deps }); assert.equal((await b.json()).built, 1); assert.equal(b.headers.get('x-ishur-age'), '0');
  await sleep(2);
  assert.equal(await swrHook({ request: req({ admin_key: 'k', action: 'set', token: tok(1), guest_id: 'G1', rsvp: 'מגיע' }), url, env, ctx, origin: '', deps }), null, 'the change itself runs on the real route');
  const c = await swrHook({ request: req({ admin_key: 'k' }), url, env, ctx, origin: '', deps }); assert.equal((await c.json()).built, 2, 'and the list after it is fresh');
});
test('the audit tap: an admin write drops the copies, an admin read does not', async () => {
  swrReset(); const env = { ADMIN_KEY: 'k', RATE: kv() };
  const post = (p, body) => worker.fetch(new Request('https://go.ishur.io' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify(body) }), env, ctx);
  await post('/api/client-flags', { admin_key: 'k', tokens: [] });
  assert.equal(env.RATE.m.get(BUST_KEY), undefined, 'a read is not a change');
  await post('/api/client-active', { admin_key: 'k', token: tok(1), active: false }).catch(() => null);
  assert.ok(env.RATE.m.get(BUST_KEY), 'a change marks the copies stale');
});

/* ── §3 ux.js: one load per open ───────────────────────────────────────── */
function uxWindow(stored = {}) {
  const ss = new Map(Object.entries(stored)); const events = []; const net = [];
  const node = () => new Proxy(function () {}, { get: (t, k) => (k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains: () => false } : k === 'style' ? {} : k === 'querySelectorAll' ? () => [] : k === 'querySelector' || k === 'getElementById' || k === 'closest' ? () => null : k === Symbol.toPrimitive ? () => '' : node()), set: () => true, apply: () => node() });
  const document = { readyState: 'complete', documentElement: node(), head: { appendChild() {} }, body: { appendChild() {} }, createElement: () => node(), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, hidden: false };
  const w = { document, location: { pathname: '/next/clients.html', search: '', hostname: 'ishur.io', href: 'https://ishur.io/next/clients.html' },
    sessionStorage: { getItem: k => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: k => ss.delete(k) },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async (url, opts) => { net.push(url); return new Response(JSON.stringify({ ok: true, v: 'net' }), { status: 200 }); },
    addEventListener() {}, dispatchEvent: e => { events.push(e.type); return true; },
    CustomEvent: class { constructor(t) { this.type = t; } }, Response, Promise, JSON, setTimeout, clearTimeout, setInterval: () => 0, requestAnimationFrame: f => f(),
    MutationObserver: class { observe() {} }, navigator: { userAgent: 'node' }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  w.window = w; w.self = w;
  vm.createContext(w); vm.runInContext(readFileSync(new URL('../../assets/ux.js', import.meta.url), 'utf8'), w);
  return { w, events, ss, net };
}
test('ux.js: a cold open (nothing cached) does not tell the page to load again; a changed cached copy still does', async () => {
  const url = 'https://go.ishur.io/api/status', body = JSON.stringify({ admin_key: 'k', view: 'biz' });
  const cold = uxWindow();
  const j = await (await cold.w.fetch(url, { method: 'POST', body })).json(); assert.equal(j.v, 'net');
  await sleep(400);
  assert.deepEqual(cold.events, [], 'no ishur:fresh: the page already shows this answer');
  assert.ok([...cold.ss.keys()].some(k => k.startsWith('ishur_swr:')), 'and the copy is kept for the next open');
  const key = [...cold.ss.keys()].find(k => k.startsWith('ishur_swr:'));
  const warm = uxWindow({ [key]: JSON.stringify({ ok: true, v: 'old' }) });
  const j2 = await (await warm.w.fetch(url, { method: 'POST', body })).json(); assert.equal(j2.v, 'old', 'the kept copy at once');
  await sleep(400);
  assert.deepEqual(warm.events, ['ishur:fresh'], 'the newer answer repaints the page');
});

/* ── §4 the team panel: one /api/team 'me' per minute per tab, not one per page ── */
function tpWindow(stored = {}) {
  const ss = new Map(Object.entries(stored)); const calls = [];
  const node = () => new Proxy(function () {}, { get: (t, k) => (k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains: () => false } : k === 'style' || k === 'dataset' ? {} : k === 'querySelectorAll' ? () => [] : k === 'querySelector' || k === 'closest' ? () => null : k === 'parentNode' ? null : k === Symbol.toPrimitive ? () => '' : node()), set: () => true, apply: () => node() });
  const document = { readyState: 'complete', documentElement: node(), head: node(), body: node(), createElement: () => node(), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, visibilityState: 'visible' };
  const ME = { ok: true, me: { email: 'a@x', name: 'A' }, team: [], items: [{ id: 'i1', status: 'open' }], counts: { badge: 1 }, pages: [], page_of: {} };
  const w = { document, location: { pathname: '/next/clients.html', search: '', hash: '', hostname: 'ishur.io' },
    sessionStorage: { getItem: k => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: k => ss.delete(k) },
    localStorage: { getItem: k => (k === 'ishur_calls_key' ? 'us.session-abcdefghijkl' : null), setItem() {} },
    fetch: async (url, opts) => { const b = JSON.parse(opts.body); calls.push(b.op); return new Response(JSON.stringify(b.op === 'me' ? ME : { ok: true, items: [], counts: {} })); },
    setInterval: () => 0, setTimeout, clearTimeout, Promise, JSON, Date, Response };
  w.window = w; vm.createContext(w); vm.runInContext(readFileSync(new URL('../../assets/teampanel.js', import.meta.url), 'utf8'), w);
  return { calls, ss, w };
}
test('team panel: the first page asks once and keeps the answer; the next page within a minute does not ask; an older copy paints and is asked again', async () => {
  const a = tpWindow(); await sleep(20);
  assert.deepEqual(a.calls, ['me']); const kept = a.ss.get('ishur_tp_me'); assert.ok(kept && JSON.parse(kept).j.me.email === 'a@x');
  const b = tpWindow({ ishur_tp_me: kept }); await sleep(20);
  assert.deepEqual(b.calls, [], 'next page, same tab, under a minute: no request');
  const old = JSON.parse(kept); old.at -= 2 * 60000;
  const c = tpWindow({ ishur_tp_me: JSON.stringify(old) }); await sleep(20);
  assert.deepEqual(c.calls, ['me'], 'older copy: painted, then asked again');
  const other = JSON.parse(kept); other.k = 'someone-else';
  const d = tpWindow({ ishur_tp_me: JSON.stringify(other) }); await sleep(20);
  assert.deepEqual(d.calls, ['me'], "another session's copy is never used");
});
