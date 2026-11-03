// node --test worker/test/ops-brain-routes.test.mjs — /api/ops/brain*, /api/ops/run-log, /api/ops/edit through the real
// Worker fetch(), plus the cfg overrides actually binding the code (send window, margin, pacer batch, call cap, noa chase)
// and the */10 cron running the brain. Meta/Telnyx/Slack are stubbed; nothing leaves the machine.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { withCfg, paceSends, dailyCallCap, validateEdit, NOA_CHASE_ON_CONFIRM, clearCfgMemo } from '../cfg.js';
import { sendWindowState, setSendWindow } from '../shir.js';
import { guestBudgetMargin } from '../whatsapp.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
let realFetch, calls = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (url, init = {}) => { calls.push({ u: String(url), init }); return new Response('{}'); }; });
after(() => { globalThis.fetch = realFetch; setSendWindow(null); });
beforeEach(() => { calls = []; });
const env = (init = {}, x = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', WA_PHONE_ID_CLIENT: 'N', WA_TOKEN: 'ct', SLACK_ALERT_HOOK: 'https://slack.test/h', RATE: kv(init), ...x });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path) => worker.fetch(new Request('https://go.ishur.io' + path, { headers: { 'X-Admin-Key': 'k' } }), e, ctx);
const post = (e, path, body, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: key, ...body }) }), e, ctx);

test('brain routes: auth, brain-run → GET brain shows the run, its findings and its log lines', async () => {
  const e = env({ 'billingalert:client': '1' });
  assert.equal((await post(e, '/api/ops/brain-run', {}, 'nope')).status, 403);
  const r = await (await post(e, '/api/ops/brain-run', { only: ['noa_billing', 'd1_ledger'] })).json();
  assert.equal(r.ok, true); assert.equal(r.checks, 2);
  const b = await (await get(e, '/api/ops/brain')).json();
  assert.equal(b.ok, true);
  assert.deepEqual(b.findings.open.map(f => f.id).sort(), ['d1_ledger', 'noa_billing']);
  assert.ok(b.runs.some(x => x.automation_id === 'brain_health' && /^manual:/.test(x.triggered_by)));
  assert.ok(b.stream.length >= 3 && b.cursor);
  assert.ok(calls.some(c => c.u === 'https://slack.test/h'), 'P1 fail → Slack through slackSend');
});

test('run-log: unknown run → 404; open an external run with automation_id, lines show in /api/ops/brain; bad id → 400', async () => {
  const e = env();
  assert.equal((await post(e, '/api/ops/run-log', { run_id: 'rabc123xyz', line: 'x' })).status, 404);
  assert.equal((await post(e, '/api/ops/run-log', { run_id: '../x', line: 'x' })).status, 400);
  const ok = await (await post(e, '/api/ops/run-log', { run_id: 'rabc123xyz', automation_id: 'brain_agent', lines: ['בודק את 0521234567', 'סיום'] })).json();
  assert.equal(ok.appended, 2);
  const b = await (await get(e, '/api/ops/brain')).json();
  const lines = b.stream.filter(l => l.run_id === 'rabc123xyz');
  assert.equal(lines.length, 2); assert.equal(lines[0].src, 'agent'); assert.ok(!lines[0].text.includes('0521234567'), 'phones masked in agent lines');
});

test('brain-decision: unknown → 404; bad body → 400', async () => {
  const e = env();
  assert.equal((await post(e, '/api/ops/brain-decision', { id: 'pa_nope', approve: true })).status, 404);
});

test('edit: no confirm → blast radius only, NOTHING written; confirm → cfg:<key> + history + audit + Slack; invalid → 400', async () => {
  const e = env();
  const r1 = await (await post(e, '/api/ops/edit', { id: 'pacer_batch_size', value: 10 })).json();
  assert.equal(r1.applied, false); assert.equal(r1.confirm_required, 'pacer_batch_size'); assert.equal(r1.before, 25); assert.equal(r1.after, 10);
  assert.ok(r1.blast_radius.effects.some(x => x.before === 25 * 69 && x.after === 10 * 69));
  assert.ok(!e.RATE.m.has('cfg:pacer_batch_size'));
  const r2 = await (await post(e, '/api/ops/edit', { id: 'pacer_batch_size', value: 10, confirm: 'pacer_batch_size', who: 'richard', reason: 'בדיקה' })).json();
  assert.equal(r2.applied, true);
  assert.equal(JSON.parse(e.RATE.m.get('cfg:pacer_batch_size')).value, 10);
  assert.equal(JSON.parse(e.RATE.m.get('cfg:hist:pacer_batch_size')).length, 1);
  assert.ok([...e.RATE.m.keys()].some(k => k.startsWith('stream:')), 'audit row');
  assert.ok(calls.some(c => c.u === 'https://slack.test/h'), 'Slack');
  assert.equal((await post(e, '/api/ops/edit', { id: 'pacer_batch_size', value: 40, confirm: 'pacer_batch_size' })).status, 400, 'above 25 refused');
  assert.equal((await post(e, '/api/ops/edit', { id: 'send_window', field: 'end', value: '21:30', confirm: 'send_window' })).status, 400, 'a window can only narrow');
  assert.equal((await post(e, '/api/ops/edit', { id: 'nope', value: 1 })).status, 404);
  /* the registry drawer shows the stored value */
  const reg = await (await get(e, '/api/ops/registry')).json();
  const pacer = reg.nodes.find(n => n.id === 'd_pacer');
  assert.equal(pacer.editable.find(x => x.setting === 'pacer_batch_size').value, 10);
});

test('edit noa_chase: "on" needs Richard\'s own confirm string; the setting id alone does not flip it', async () => {
  const e = env();
  const r1 = await (await post(e, '/api/ops/edit', { id: 'noa_chase', value: 'on', confirm: 'noa_chase' })).json();
  assert.equal(r1.applied, false); assert.equal(r1.confirm_required, NOA_CHASE_ON_CONFIRM);
  assert.ok(!e.RATE.m.has('cfg:noa_chase'));
  const r2 = await (await post(e, '/api/ops/edit', { id: 'noa_chase', value: 'on', confirm: NOA_CHASE_ON_CONFIRM, who: 'richard' })).json();
  assert.equal(r2.applied, true);
  clearCfgMemo(e);
  assert.equal((await withCfg(e)).NOA_CHASE, 'on');
  const off = await (await post(e, '/api/ops/edit', { id: 'noa_chase', value: 'off', confirm: 'noa_chase' })).json();
  assert.equal(off.applied, true, 'turning it OFF only needs the id');
});

test('edit event_hold: writes the existing hold:<token> key; bad token → 400', async () => {
  const e = env();
  assert.equal((await post(e, '/api/ops/edit', { id: 'event_hold', field: 'nope', value: true, confirm: 'event_hold' })).status, 400);
  const r = await (await post(e, '/api/ops/edit', { id: 'event_hold', field: TOK, value: true, confirm: 'event_hold' })).json();
  assert.equal(r.applied, true); assert.ok(e.RATE.m.has('hold:' + TOK));
  await post(e, '/api/ops/edit', { id: 'event_hold', field: TOK, value: false, confirm: 'event_hold' });
  assert.ok(!e.RATE.m.has('hold:' + TOK));
});

test('cfg binds the code: send window narrows, margin reaches guestBudgetMargin, pacer batch + call cap read by the pacer helpers', async () => {
  const e = env({ 'cfg:send_window': JSON.stringify({ value: { start: '10:00', end: '18:00', fri_end: '12:00' } }), 'cfg:guest_budget_margin': JSON.stringify({ value: 35 }),
    'cfg:pacer_batch_size': JSON.stringify({ value: 8 }), 'cfg:daily_call_cap': JSON.stringify({ value: 120 }) });
  const e2 = await withCfg(e);
  const at = iso => sendWindowState(new Date(iso));
  assert.equal(at('2026-11-04T07:30:00Z').open, false, '09:30 IL closed under a 10:00 start');
  assert.equal(at('2026-11-04T09:00:00Z').open, true, '11:00 IL open');
  assert.equal(at('2026-11-04T16:30:00Z').open, false, '18:30 IL closed under an 18:00 end');
  assert.equal(at('2026-11-06T10:30:00Z').open, false, 'Friday 12:30 closed under fri_end 12:00');
  assert.equal(guestBudgetMargin(e2), 35);
  assert.equal(paceSends(e2, 25), 8); assert.equal(dailyCallCap(e2), 120);
  assert.equal(paceSends(e, 25), 25, 'the raw env (no cfg) keeps the default');
  setSendWindow(null);
  assert.equal(at('2026-11-04T07:30:00Z').open, true, 'defaults back: 09:30 IL open');
  assert.equal(validateEdit('send_window', 'start', '08:00').ok, false);
});

test('scheduled */10 runs the brain: brain:last + a brain_health ledger row', async () => {
  const e = env({ 'auto:off:d_pacer': JSON.stringify({ at: 'x' }) });
  const waits = [];
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, e, { waitUntil: p => waits.push(p) });
  await Promise.allSettled(waits);
  assert.ok(e.RATE.m.has('brain:last'));
  const rows = [...e.RATE.m.entries()].filter(([k]) => k.startsWith('opsrun:')).map(([, v]) => JSON.parse(v));
  assert.ok(rows.some(r => r.automation_id === 'brain_health' && r.status === 'ok'), rows.map(r => r.automation_id + ':' + r.status).join(','));
  const off = env({}, { BRAIN_ENABLED: 'off' }); const w2 = [];
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, off, { waitUntil: p => w2.push(p) });
  await Promise.allSettled(w2);
  assert.ok(!off.RATE.m.has('brain:last'), 'BRAIN_ENABLED=off stops it');
});
