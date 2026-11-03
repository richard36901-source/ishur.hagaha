// node --test worker/test/ops-killswitch.test.mjs — every wired kill switch (auto:off:<id>):
// the automation reports skipped and makes ZERO calls to Meta / Retell / Telnyx (fetch is counted).
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker, { _runPacer, _sendWave, _drainPartyNudges, _runShirDispatch, _runShirCallbacks, _runEventDayBlasts } from '../index.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'לקוח'; ev[5] = 'חתונה'; ev[6] = '2026-11-20'; ev[7] = 'כן'; ev[43] = 'כן'; ev[34] = 'אורי'; ev[39] = '2026-11-03';
  const g = (n, rsvp) => { const r = Array(31).fill(''); r[28] = TOK; r[2] = 'G' + n; r[3] = 'אורח ' + n; r[4] = '05200000' + n + '1'; r[15] = rsvp; r[21] = 'נדרשת שיחה'; return r; };
  return { events: { values: [ev] }, guests: { values: [g(1, 'מגיע'), g(2, ''), g(3, '')] } };
}
let realFetch, calls = [];
const external = () => calls.filter(u => /graph\.facebook\.com|api\.retellai\.com|api\.telnyx\.com/.test(u));
const sends = () => calls.filter(u => /graph\.facebook\.com\/v[\d.]+\/\d+\/messages|create-phone-call|api\.telnyx\.com\/v2\/messages/.test(u));
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()), { status: 200 });
    return new Response('{}', { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });
const env = (kvInit = {}, extra = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', RETELL_KEY: 'rk', SHIR_FROM: '+972500000000', TELNYX_KEY: 'tk', TELNYX_SMS_FROM: '+972500000001', RATE: kv(kvInit), ...extra });
const OFF = id => ({ ['auto:off:' + id]: JSON.stringify({ at: '2026-11-03T08:00:00Z', by: 'test' }) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...body }) }), e, ctx);

test('d_pacer off → runPacer returns skipped before anything (no KV writes, no fetch)', async () => {
  const e = env(OFF('d_pacer'));
  const keys = [...e.RATE.m.keys()];
  const r = await _runPacer(e);
  assert.deepEqual(r, { ok: true, skipped: 'off:d_pacer' });
  assert.equal(calls.length, 0);
  assert.deepEqual([...e.RATE.m.keys()], keys, 'not even the Slack-flush marker');
});

for (const k of [1, 2, 3]) test(`wave${k} off → sendWave held+skipped, wave stays open, zero fetch`, async () => {
  const ev = snapshot().events.values[0];
  const e = env(OFF('wave' + k));
  const r = await _sendWave(e, ev, TOK, snapshot().guests.values, { key: k, col: 38 + k }, false, { left: 25 });
  assert.equal(r.skipped, 'off:wave' + k); assert.equal(r.held, true); assert.equal(r.sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(e.RATE.m.has(`wave:${TOK}:${k}`), false);
});

test('event_day_blast off → skipped before the template check, zero fetch', async () => {
  const job = { [`edblast:${TOK}`]: JSON.stringify({ at: '2026-01-01', template: 'ishur_yom_haerua' }) };
  const r = await _runEventDayBlasts(env({ ...job, ...OFF('event_day_blast') }));
  assert.deepEqual(r, { ok: true, skipped: 'off:event_day_blast' });
  assert.equal(calls.length, 0);
});

test('party_nudges off → skipped, zero fetch', async () => {
  const r = await _drainPartyNudges(env({ ...OFF('party_nudges'), 'awaitparty:9725200000011': JSON.stringify({ phone: '972520000011', token: TOK }) }));
  assert.deepEqual(r, { sent: 0, skipped: 'off:party_nudges' });
  assert.equal(calls.length, 0);
});

test('shir_dispatch off → skipped, zero Retell calls (control: on → reads the snapshot)', async () => {
  const r = await _runShirDispatch(env(OFF('shir_dispatch')), { max: 6, force: true });
  assert.deepEqual(r, { ok: true, dialed: 0, skipped: 'off:shir_dispatch' });
  assert.equal(calls.length, 0);
  await _runShirDispatch(env(), { max: 6, force: true });
  assert.ok(calls.length > 0, 'control run did reach out');
});

test('shir_callbacks off → skipped, zero Retell calls', async () => {
  const r = await _runShirCallbacks(env({ ...OFF('shir_callbacks'), 'cbq:972520000011': JSON.stringify({ phone: '972520000011', at: Date.now() - 3600e3 }) }), { max: 3, force: true });
  assert.deepEqual(r, { dialed: 0, skipped: 'off:shir_callbacks' });
  assert.equal(calls.length, 0);
});

test('autoretry off → pacer skips it inside the send window: markers kept, autoretry:<day> not burned, no sends', async () => {
  /* Tuesday 03/11/2026 11:00 Israel — send + call windows open */
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-03T09:00:00Z') });
  try {
    const marks = { [`wferr:${TOK}:1:972520000021`]: '130472', [`wave:${TOK}:1`]: '2026-11-03' };
    const e = env({ ...OFF('autoretry'), ...marks });
    const r = await _runPacer(e);
    assert.deepEqual(r.autoretry, { skipped: 'off:autoretry' });
    for (const k of Object.keys(marks)) assert.ok(e.RATE.m.has(k), k + ' kept');
    assert.equal(e.RATE.m.has('autoretry:2026-11-03'), false);
    assert.equal(sends().length, 0);
    /* control: switch on → the day's retry marker is written (the block ran) */
    const e2 = env(marks);
    await _runPacer(e2);
    assert.ok(e2.RATE.m.has('autoretry:2026-11-03'));
  } finally { mock.timers.reset(); }
});

test('manual_blasts off → gift-blast / subevent-send / sms-blast / wave-retry answer 423 with zero fetch; dry previews still open', async () => {
  const e = env({ ...OFF('manual_blasts'), 'subevent:11111111-0000-4000-8000-000000000000': JSON.stringify({ parent: TOK, kind: 'shabbat', template: 'x' }) });
  for (const [path, body] of [['/api/gift-blast', { token: TOK, dry: false }], ['/api/subevent-send', { token: '11111111-0000-4000-8000-000000000000', dry: false }],
    ['/api/sms-blast', { list: [{ phone: '0520000011', text: 'x' }] }], ['/api/wave-retry', { token: TOK, wave: 1, dry: true }]]) {
    calls = [];
    const r = await post(e, path, body);
    assert.equal(r.status, 423, path);
    assert.equal((await r.json()).skipped, 'off:manual_blasts');
    assert.equal(calls.length, 0, path + ' made no call');
  }
  const dry = await post(e, '/api/gift-blast', { token: TOK });
  assert.notEqual(dry.status, 423, 'a dry gift-blast preview is not blocked');
  const bad = await post(e, '/api/gift-blast', { admin_key: 'nope', token: TOK, dry: false });
  assert.equal(bad.status, 403, 'wrong key still gets 403, not a hint that the switch exists');
});

test('scheduled */10 with d_pacer off: the ledger (KV ring) records runPacer as skipped', async () => {
  const e = env(OFF('d_pacer'));
  const waits = [];
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, e, { waitUntil: p => waits.push(p) });
  await Promise.allSettled(waits);
  const rows = [...e.RATE.m.entries()].filter(([k]) => k.startsWith('opsrun:')).map(([, v]) => JSON.parse(v));
  const pacer = rows.find(r => r.automation_id === 'd_pacer');
  assert.ok(pacer, 'pacer row exists'); assert.equal(pacer.status, 'skipped');
  assert.equal(JSON.parse(pacer.counts_json).skip_reason, 'off:d_pacer');
  assert.ok(rows.length >= 10, 'every */10 job got a ledger row: ' + rows.map(r => r.automation_id).join(','));
});
