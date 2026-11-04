// node --test worker/test/snapshot.test.mjs — snapshot.js (04/11/2026 Make burn): the one cached reader of the
// Make status snapshot, fresh-after-own-write, the stale gate for senders/dialer, the sheet-write outbox,
// the brain's make_down check, and the senders in index.js refusing a stale snapshot.
// Make is a stub on globalThis.fetch; KV is a Map. Nothing leaves.
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot, snapInfo, snapWhy, markSnapDirty, noteSheetWrite, noteHookWrite, sheetWrite, drainSheetQueue, sheetQueueSize,
  makeStatus, parseRange, opsFromBatch, K, CLASSES, FAIL_BACKOFF_SEC } from '../snapshot.js';
import { runBrain, CHECKS } from '../brain.js';
import { _runShirDispatch, _drainPartyNudges } from '../index.js';

const MIN = 60e3;
/* a KV double; `over(m)` is a second isolate looking at the same namespace (its own memo) */
const over = m => ({ m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }) });
const kv = (init = {}) => over(new Map(Object.entries(init)));
const STATUS = 'https://hook.test/status', BRAIN = 'https://hook.test/brain';
const env = (rate = kv(), x = {}) => ({ RATE: rate, HOOK_STATUS: STATUS, BRAIN_HOOK: BRAIN, ...x });

/* the sheet behind the stub: 2 events, 3 guests (values start at sheet row 2) */
let sheet, makeUp, statusCalls, slowGate;
const fresh = () => ({
  events: { values: [['', 'tok-a', 'דנה'], ['', 'tok-b', 'רון']] },
  guests: { values: [['', '', 'G-1', 'אורח 1', '0520000001', ...Array(10).fill(''), ''], ['', '', 'G-2', 'אורח 2', '0520000002'], ['', '', 'G-3', 'אורח 3', '0520000003']] },
  leads: { values: [] },
});
let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === STATUS) {
      statusCalls++;
      if (slowGate) await slowGate;
      return makeUp ? new Response(JSON.stringify(sheet)) : new Response('Accepted', { status: 200 });   /* a paused scenario */
    }
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; mock.timers.reset(); });
beforeEach(() => { sheet = fresh(); makeUp = true; statusCalls = 0; slowGate = null; });
const rsvpOf = (raw, gid) => String((raw.guests.values.find(g => g[2] === gid) || [])[15] || '');

/* ── pure ── */
test('parseRange / opsFromBatch: only single-tab cell ranges on the snapshot tabs are patchable', () => {
  assert.deepEqual(parseRange('אורחים!V12'), { key: 'guests', r1: 12, r2: 12, c1: 21, c2: 21 });
  assert.deepEqual(parseRange("'אירועים'!S5:V5"), { key: 'events', r1: 5, r2: 5, c1: 18, c2: 21 });
  assert.equal(parseRange('מוח שירות!B1'), null, 'not a snapshot tab');
  assert.equal(parseRange('אורחים!A1'), null, 'the header row is not in values[]');
  assert.deepEqual(opsFromBatch([{ range: 'אירועים!S3:U3', values: [['כן', 5, null]] }]), [{ k: 'events', row: 1, cells: { 18: 'כן', 19: '5', 20: '' } }]);
  assert.equal(opsFromBatch([{ range: 'אורחים!V2', values: [['x']] }, { range: 'לוג!A1', values: [['y']] }]), null, 'one unpatchable range → the whole batch is');
  assert.equal(CLASSES.send.maxStale, 900); assert.equal(CLASSES.dial.maxStale, 900);
  for (const c of ['ops', 'brain', 'background']) assert.equal(CLASSES[c].dirty, 'none', c + ' never refetches because something polled');
});

/* ── cache ── */
test('cache: one Make read serves every class inside its max age, in this isolate (memo) and in another (KV)', async () => {
  const rate = kv(); const e = env(rate);
  const a = await readSnapshot(e, 'ops');
  assert.equal(statusCalls, 1); assert.equal(snapInfo(a).source, 'fresh');
  for (const cls of ['ops', 'guest', 'send', 'dial', 'dashboard', 'brain', 'background']) assert.ok(await readSnapshot(e, cls), cls);
  assert.equal(statusCalls, 1, 'all served from the memo');
  const other = env(over(rate.m));
  const b = await readSnapshot(other, 'guest');
  assert.equal(statusCalls, 1, 'another isolate is served from snapcache'); assert.equal(snapInfo(b).source, 'kv');
  assert.ok(rate.m.has(K.cache) && rate.m.has(K.last), 'snapcache + snaplast written');
});

test('cache: a miss after max age (300 s for every class); write class always reads', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const e = env();
    await readSnapshot(e, 'ops'); assert.equal(statusCalls, 1);
    mock.timers.tick(150e3);
    for (const c of ['ops', 'guest', 'dashboard', 'send', 'dial', 'brain']) await readSnapshot(e, c);
    assert.equal(statusCalls, 1, '150 s < 300 s for every class');
    await readSnapshot(e, 'write'); assert.equal(statusCalls, 2, 'write: a real read every time');
    mock.timers.tick(301e3);
    await readSnapshot(e, 'guest'); assert.equal(statusCalls, 3, 'past 300 s');
    await readSnapshot(e, 'brain'); assert.equal(statusCalls, 3, 'and that one read serves the rest');
  } finally { mock.timers.reset(); }
});

test('cache: dirty forces a refetch for guest/send/dial/dashboard, never for ops/brain/background', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const rate = kv(); const e = env(rate);
    await readSnapshot(e, 'ops'); assert.equal(statusCalls, 1);
    mock.timers.tick(1000);
    await markSnapDirty(e, 'all');
    mock.timers.tick(1000);
    await readSnapshot(e, 'ops'); await readSnapshot(e, 'background'); await readSnapshot(e, 'brain');
    assert.equal(statusCalls, 1, 'screens ignore dirty');
    await readSnapshot(e, 'guest'); assert.equal(statusCalls, 2, 'guest honours dirty');
    await readSnapshot(e, 'send'); await readSnapshot(e, 'dashboard'); assert.equal(statusCalls, 2, 'one refetch clears it for everyone');
    /* act-dirty (a call result) → only senders/dialer */
    mock.timers.tick(1000); await markSnapDirty(e, 'act'); mock.timers.tick(1000);
    await readSnapshot(e, 'guest'); assert.equal(statusCalls, 2, 'guest ignores act-dirty');
    await readSnapshot(e, 'dial'); assert.equal(statusCalls, 3, 'dial honours act-dirty');
    /* a dirty marker from ANOTHER isolate reaches this one through KV */
    mock.timers.tick(1000); await markSnapDirty(env(over(rate.m)), 'all'); mock.timers.tick(1000);
    await readSnapshot(e, 'guest'); assert.equal(statusCalls, 4);
  } finally { mock.timers.reset(); }
});

test('single-flight: concurrent misses in one isolate cost one Make read', async () => {
  const e = env(); let open; slowGate = new Promise(r => { open = r; });
  const ps = ['ops', 'send', 'dial', 'guest', 'brain', 'background', 'probe'].map(c => readSnapshot(e, c));
  await new Promise(r => setTimeout(r, 10)); open();
  const out = await Promise.all(ps);
  assert.equal(statusCalls, 1); assert.ok(out.every(x => x && x.events));
});

/* ── fresh after own write ── */
test('own write: sheetWrite patches the cached copy — the next read in this isolate AND another sees the cell, no Make read', async () => {
  const rate = kv(); const e = env(rate);
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
  await readSnapshot(e, 'guest'); assert.equal(statusCalls, 1);
  mock.timers.tick(1000);   /* the write comes after the read (a stub answers inside the same millisecond) */
  const posted = [];
  const ok = await sheetWrite(e, [{ range: 'אורחים!P3', values: [['מגיע']] }], async (_, d) => { posted.push(d); return true; });
  assert.equal(ok, true); assert.equal(posted.length, 1);
  assert.equal(rsvpOf(await readSnapshot(e, 'guest'), 'G-2'), 'מגיע', 'memo patched');
  assert.equal(rsvpOf(await readSnapshot(env(over(rate.m)), 'guest'), 'G-2'), 'מגיע', 'other isolate: snapcache + the snappatch overlay');
  assert.equal(statusCalls, 1, 'no Make read for any of it');
  assert.equal(rate.m.has(K.dirty), false, 'a patchable write does not mark dirty');
  } finally { mock.timers.reset(); }
});

test('own write: a write landing while a fetch is in flight is applied on top of the fetched copy', async () => {
  const e = env(); let open; slowGate = new Promise(r => { open = r; });
  const p = readSnapshot(e, 'guest');
  await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 2));
  await noteSheetWrite(e, [{ range: 'אורחים!P2', values: [['לא מגיע']] }]);   /* the sheet stub still says '' */
  open();
  assert.equal(rsvpOf(await p, 'G-1'), 'לא מגיע');
});

test('own write: a call_result (guest reply / Shir) patches rsvp+party by guest_id and makes only the dialer/senders refetch', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const e = env();
    await readSnapshot(e, 'guest'); mock.timers.tick(1000);
    await noteHookWrite(e, JSON.stringify({ event_type: 'call_result', guest_id: 'G-3', rsvp: 'מגיע', party: '4', tries: '__keep__' }));
    mock.timers.tick(1000);
    const g = await readSnapshot(e, 'guest');
    assert.equal(statusCalls, 1); assert.equal(rsvpOf(g, 'G-3'), 'מגיע'); assert.equal(g.guests.values[2][16], '4');
    await readSnapshot(e, 'dial'); assert.equal(statusCalls, 2, 'tries/call_status are Make-computed → the dialer refetches');
    /* any other HOOK_EVENTS payload (guest file, event form) → dirty for everyone fresh */
    mock.timers.tick(1000); await noteHookWrite(e, JSON.stringify({ event_type: 'guests_file', token: 'tok-a' })); mock.timers.tick(1000);
    await readSnapshot(e, 'guest'); assert.equal(statusCalls, 3);
  } finally { mock.timers.reset(); }
});

/* ── Make down ── */
test('Make down: a failed read backs off 60 s for every caller, then screens get the last good copy marked stale', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const rate = kv(); const e = env(rate);
    await readSnapshot(e, 'ops'); assert.equal(statusCalls, 1);
    makeUp = false; mock.timers.tick(6 * MIN);
    const s = await readSnapshot(e, 'ops');
    assert.equal(statusCalls, 2); assert.ok(s && s.events, 'served');
    assert.equal(snapInfo(s).stale, true); assert.equal(snapInfo(s).stale_since, '2026-11-04T09:00:00.000Z');
    for (let i = 0; i < 5; i++) await readSnapshot(e, 'probe');
    await readSnapshot(env(over(rate.m)), 'ops');
    assert.equal(statusCalls, 2, `no Make call inside the ${FAIL_BACKOFF_SEC} s backoff, from any isolate`);
    mock.timers.tick(61e3); await readSnapshot(e, 'ops'); assert.equal(statusCalls, 3, 'tries again after the backoff');
    const st = await makeStatus(e);
    assert.equal(st.reader.ok, false); assert.equal(st.reader.fails, 2);
    makeUp = true; mock.timers.tick(61e3);
    await readSnapshot(e, 'ops');
    assert.equal((await makeStatus(e)).reader.ok, true, 'one good read closes it'); assert.equal(rate.m.has(K.fail), false);
  } finally { mock.timers.reset(); }
});

test('stale gate: send/dial never get a snapshot older than 15 min (why snapshot-stale); 5 min old is still allowed; probe gets nothing stale', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const e = env(kv({ [K.last]: JSON.stringify({ at: Date.now() - 20 * MIN, raw: fresh() }) }));
    makeUp = false;
    assert.equal(await readSnapshot(e, 'send'), null); assert.equal(snapWhy(e), 'snapshot-stale');
    assert.equal(await readSnapshot(e, 'dial'), null); assert.equal(snapWhy(e), 'snapshot-stale');
    const o = await readSnapshot(e, 'ops'); assert.ok(o, 'a screen still shows it'); assert.equal(snapInfo(o).stale, true);
    const e2 = env(kv({ [K.last]: JSON.stringify({ at: Date.now() - 5 * MIN, raw: fresh() }) }));
    assert.ok(await readSnapshot(e2, 'send'), '5 minutes old: allowed');
    assert.equal(await readSnapshot(e2, 'probe'), null, 'probe: a real answer or nothing');
    const e3 = env(kv());
    assert.equal(await readSnapshot(e3, 'ops'), null); assert.equal(snapWhy(e3), 'snapshot-unreadable');
  } finally { mock.timers.reset(); }
});

test('stale gate in the Worker: the dialer skips with why snapshot-stale and rings nobody; party nudges are kept, not deleted', async () => {
  /* Wednesday 11:00 Israel: inside both windows */
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    makeUp = false;
    const rate = kv({ [K.last]: JSON.stringify({ at: Date.now() - 20 * MIN, raw: fresh() }), 'awaitparty:G-1': JSON.stringify({ phone: '972520000001', gid: 'G-1', token: 'tok-a', at: Date.now() }) });
    const e = env(rate, { RETELL_KEY: 'rk', SHIR_FROM: '+972500000000' });
    const r = await _runShirDispatch(e, { force: true, quiet: true });
    assert.deepEqual(r, { ok: false, why: 'snapshot-stale' });
    const n = await _drainPartyNudges(e);
    assert.equal(n.why, 'snapshot-stale'); assert.ok(rate.m.has('awaitparty:G-1'), 'the nudge waits for a real snapshot');
    /* a fresh-enough copy (Make answers again) → the dialer runs */
    makeUp = true; mock.timers.tick(61e3);
    const r2 = await _runShirDispatch(e, { force: true, quiet: true });
    assert.equal(r2.ok, true, JSON.stringify(r2));
  } finally { mock.timers.reset(); }
});

/* ── the outbox ── */
test('outbox: a failed write is queued (returns false), the next write goes BEHIND it, the drain replays oldest first', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const rate = kv(); const e = env(rate); let up = false; const posted = [];
    const post = async (_, d) => { if (!up) return false; posted.push(d[0].values[0][0]); return true; };
    assert.equal(await sheetWrite(e, [{ range: 'אורחים!P2', values: [['מגיע']] }], post), false);
    assert.equal(await sheetQueueSize(e), 1); assert.ok(rate.m.get(K.qPending));
    mock.timers.tick(5e3);
    assert.equal(await sheetWrite(e, [{ range: 'אורחים!P2', values: [['לא מגיע']] }], post), false, 'inside the write backoff: queued without knocking');
    assert.equal(await sheetQueueSize(e), 2);
    let d = await drainSheetQueue(e, post);
    assert.equal(d.ok, false); assert.equal(d.why, 'make-still-down'); assert.equal(await sheetQueueSize(e), 2, 'nothing lost');
    up = true; mock.timers.tick(91e3);
    /* Make is back: a new write first drains the queue, then lands — the newest value wins */
    assert.equal(await sheetWrite(e, [{ range: 'אורחים!P2', values: [['מתלבט']] }], post), true);
    assert.deepEqual(posted, ['מגיע', 'לא מגיע', 'מתלבט']);
    assert.equal(await sheetQueueSize(e), 0); assert.equal(rate.m.has(K.qPending), false, 'cleared: list empty and the last enqueue > 90 s ago');
    assert.equal((await makeStatus(e)).writer.ok, true);
  } finally { mock.timers.reset(); }
});

test('outbox: the pacer drain is capped per tick, keeps order across ticks, and keeps sheetq:pending while list() may lag', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const rate = kv(); const e = env(rate); const fail = async () => false;
    for (let i = 0; i < 30; i++) { await sheetWrite(e, [{ range: `אורחים!P${i + 2}`, values: [[String(i)]] }], fail); mock.timers.tick(10); }
    assert.equal(await sheetQueueSize(e), 30);
    const seen = []; const ok = async (_, d) => { seen.push(Number(d[0].values[0][0])); return true; };
    let d = await drainSheetQueue(e, ok, { cap: 25 });
    assert.deepEqual([d.drained, d.left], [25, 5]);
    d = await drainSheetQueue(e, ok, { cap: 25 });
    assert.deepEqual([d.drained, d.left], [5, 0]);
    assert.deepEqual(seen, [...Array(30).keys()], 'oldest first, across two ticks');
    assert.ok(rate.m.get(K.qPending), 'the last enqueue is < 90 s old: list() could still be missing one');
    mock.timers.tick(91e3);
    d = await drainSheetQueue(e, ok); assert.equal(rate.m.has(K.qPending), false);
    assert.ok(rate.m.get(K.dirty), 'a drained write marks the snapshot dirty');
    assert.deepEqual(await drainSheetQueue(e, ok), { ok: true, drained: 0, left: 0, idle: true });
  } finally { mock.timers.reset(); }
});

test('outbox: while Make is down readers already see the queued value (patched), screens marked stale', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const rate = kv(); const e = env(rate);
    await readSnapshot(e, 'ops');
    makeUp = false; mock.timers.tick(1000);
    await sheetWrite(e, [{ range: 'אורחים!P4', values: [['מגיע']] }], async () => false);
    mock.timers.tick(6 * MIN);
    const o = await readSnapshot(e, 'ops');
    assert.equal(rsvpOf(o, 'G-3'), 'מגיע'); assert.equal(snapInfo(o).stale, true);
  } finally { mock.timers.reset(); }
});

/* ── brain: make_down ── */
test('brain make_down: P1 only on the 2nd failing tick, Hebrew text + outbox size, Slack gate key make_down, opens once and closes once', async () => {
  const rate = kv(); const e = env(rate);
  const slack = [], resolved = [];
  const d = { ilDate: () => '2026-11-04', makeStatus, auditQueryEx: async () => ({ items: [] }), snapshotCached: async () => null,
    slackSend: async (_, t, o) => { slack.push({ t, key: o.key }); }, resolveSlack: async (_, k) => { resolved.push(k); } };
  const tick = (now) => runBrain(e, d, { only: 'make_down', now, sleep: async () => {} });
  assert.ok(CHECKS.some(c => c.id === 'make_down'));
  makeUp = false;
  await readSnapshot(e, 'ops');                                     /* the reader fails */
  await sheetWrite(e, [{ range: 'אורחים!P2', values: [['מגיע']] }], async () => false);
  await sheetWrite(e, [{ range: 'אורחים!P3', values: [['מגיע']] }], async () => false);
  const T = Date.now();
  await tick(T);
  assert.equal(slack.length, 0, 'one failing tick is not an outage');
  await tick(T + 10 * MIN);
  assert.equal(slack.length, 1); assert.equal(slack[0].key, 'make_down');
  assert.match(slack[0].t, /Make מושהה\/לא עונה — קריאה וכתיבה לגיליון לא עובדות/);
  assert.match(slack[0].t, /תור כתיבות ממתין: 2/);
  const f = JSON.parse(rate.m.get('brain:finding:make_down'));
  assert.equal(f.severity, 'P1'); assert.equal(f.slack_key, 'make_down');
  await tick(T + 20 * MIN);
  assert.equal(slack.length, 1, 'still down: silent (re-alert is 6 h, and the gate dedups by key)');
  /* Make is back */
  makeUp = true; rate.m.delete(K.fail); await drainSheetQueue(e, async () => true);
  await tick(T + 30 * MIN);
  assert.deepEqual(resolved, ['make_down'], 'closed under the same key');
  assert.equal(JSON.parse(rate.m.get('brain:finding:make_down')).state, 'resolved');
});

test('outbox: when the inline drain cannot empty the queue, a new write is queued behind it, never written ahead of older values', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T09:00:00Z') });
  try {
    const e = env(); const seen = [];
    for (let i = 0; i < 12; i++) { await sheetWrite(e, [{ range: 'אורחים!P2', values: [[String(i)]] }], async () => false); mock.timers.tick(10); }
    mock.timers.tick(61e3);
    const ok = async (_, d) => { seen.push(d[0].values[0][0]); return true; };
    assert.equal(await sheetWrite(e, [{ range: 'אורחים!P2', values: [['new']] }], ok), false, 'queued: 2 older values were still waiting');
    assert.deepEqual(seen, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 'the inline drain took 10');
    await drainSheetQueue(e, ok);
    assert.deepEqual(seen.slice(10), ['10', '11', 'new'], 'the pacer finishes in order; the newest value lands last');
  } finally { mock.timers.reset(); }
});
