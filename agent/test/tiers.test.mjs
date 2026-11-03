import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TIERS } from '../src/tools.js';
import { gateTool, handleApproval, payloadHash } from '../src/gate.js';
import { runAgent, MAX_ITERATIONS } from '../src/claude.js';
import { baseEnv, recFetch } from './helpers.mjs';

const TOK = 'ec9f3b84-0000-4000-8000-000000000000';
const NOON_IL = new Date('2026-11-02T10:00:00Z');   // 12:00 Israel
const NIGHT_IL = new Date('2026-11-02T20:30:00Z');  // 22:30 Israel
const ctxFor = (requester, f) => ({ requester, channel: 'C_HAGAA', thread_ts: '1.1', actions: [], approvals: [], fetch: f });
const ishurCalls = f => f.to('https://go.ishur.io');

test('every tool has exactly one static tier', () => {
  for (const t of TOOLS) assert.ok(['green', 'yellow', 'red'].includes(t.tier), t.name);
  assert.equal(new Set(TOOLS.map(t => t.name)).size, TOOLS.length, 'tool names unique');
  assert.equal(TIERS.daily_run_dry, 'green');
  assert.equal(TIERS.automations, 'green');
  assert.equal(TIERS.event_hold_on, 'yellow');
  assert.equal(TIERS.wave_retry, 'red', 'wave-retry mutates engine KV even when dry');
  assert.equal(TIERS.event_flag_set, 'red');
  assert.equal(TIERS.guest_edit, 'red');
  assert.equal(TIERS.meta_write, 'red');
  assert.equal(TIERS.ads_write, 'red');
});

test('green executes with AGENT_WRITE=off, for anyone', async () => {
  const f = recFetch(() => ({ status: 200, body: { ok: true, tier: 'TIER_250' } }));
  const r = await gateTool(baseEnv(), ctxFor('U_RANDOM', f), 'cap_status', {});
  assert.equal(r.ok, true);
  assert.equal(ishurCalls(f).length, 1);
});

test('yellow is blocked when AGENT_WRITE=off (no HTTP call)', async () => {
  const f = recFetch();
  const ctx = ctxFor('U_RICHARD', f);
  const r = await gateTool(baseEnv({ AGENT_WRITE: 'off' }), ctx, 'event_hold_on', { token: TOK });
  assert.equal(r.blocked, true);
  assert.equal(f.calls.length, 0);
  assert.equal(ctx.actions.length, 0);
});

test('yellow runs when AGENT_WRITE=on for staff, and is recorded for the reply', async () => {
  const f = recFetch(() => ({ status: 200, body: { ok: true, flag: 'hold', on: true } }));
  const ctx = ctxFor('U_SHALEV', f);
  const r = await gateTool(baseEnv({ AGENT_WRITE: 'on' }), ctx, 'event_hold_on', { token: TOK });
  assert.equal(r.ok, true);
  assert.equal(ishurCalls(f).length, 1);
  assert.deepEqual(ishurCalls(f)[0].body, { admin_key: 'test-admin-key', token: TOK, flag: 'hold', on: true });
  assert.equal(ctx.actions.length, 1);
});

test('yellow is blocked for a non-staff requester even with AGENT_WRITE=on', async () => {
  const f = recFetch();
  const r = await gateTool(baseEnv({ AGENT_WRITE: 'on' }), ctxFor('U_RANDOM', f), 'event_hold_on', { token: TOK });
  assert.equal(r.blocked, true);
  assert.equal(f.calls.length, 0);
});

test('red is blocked entirely when AGENT_WRITE=off (no approval, no KV, no call)', async () => {
  const env = baseEnv({ AGENT_WRITE: 'off' }); const f = recFetch();
  const r = await gateTool(env, ctxFor('U_RICHARD', f), 'wave_retry', { token: TOK, wave: '1', dry: true });
  assert.equal(r.blocked, true);
  assert.equal(f.calls.length, 0);
  assert.equal(env.AGENT_KV.m.size, 0);
});

async function makePending(requester = 'U_SHALEV') {
  const env = baseEnv({ AGENT_WRITE: 'on' });
  const f = recFetch(url => url.startsWith('https://slack.com') ? { status: 200, body: { ok: true, ts: '2.2' } } : { status: 200, body: { ok: true } });
  const ctx = ctxFor(requester, f);
  const args = { token: TOK, flag: 'hold', on: false, reason: 'release' };
  const r = await gateTool(env, ctx, 'event_flag_set', args);
  return { env, f, ctx, r, args };
}

test('red never executes directly: it stores {payload,hash,requester,ts} and posts an אשר button', async () => {
  const { env, f, r, args } = await makePending('U_SHALEV');
  assert.equal(r.pending_approval, true);
  assert.equal(ishurCalls(f).length, 0, 'no call to go.ishur.io before approval');
  const rec = JSON.parse(env.AGENT_KV.m.get('appr:' + r.approval_id));
  assert.deepEqual(rec.payload, { tool: 'event_flag_set', args });
  assert.equal(rec.hash, await payloadHash(rec.payload));
  assert.equal(rec.requester, 'U_SHALEV');
  assert.equal(rec.status, 'pending');
  assert.ok(Number(rec.ts) > 0);
  const post = f.to('https://slack.com/api/chat.postMessage')[0].body;
  const btn = post.blocks.find(b => b.type === 'actions').elements[0];
  assert.equal(btn.text.text, 'אשר');
  assert.deepEqual(JSON.parse(btn.value), { id: r.approval_id, hash: rec.hash });
});

const click = (user, value) => ({ type: 'block_actions', user: { id: user }, actions: [{ action_id: 'approve', value: JSON.stringify(value) }] });

test('approval by a non-Richard user (Shalev) is rejected and nothing runs', async () => {
  const { env, r } = await makePending('U_SHALEV');
  const rec = JSON.parse(env.AGENT_KV.m.get('appr:' + r.approval_id));
  const f2 = recFetch();
  const out = await handleApproval(env, click('U_SHALEV', { id: r.approval_id, hash: rec.hash }), { fetch: f2, now: NOON_IL });
  assert.equal(out.status, 'not-richard');
  assert.equal(f2.calls.length, 0);
  assert.equal(JSON.parse(env.AGENT_KV.m.get('appr:' + r.approval_id)).status, 'pending');
});

test('Richard approves: the exact stored payload runs once; a second click does nothing', async () => {
  const { env, r, args } = await makePending('U_SHALEV');
  const rec = JSON.parse(env.AGENT_KV.m.get('appr:' + r.approval_id));
  const f2 = recFetch(() => ({ status: 200, body: { ok: true, flag: 'hold', on: false } }));
  const out = await handleApproval(env, click('U_RICHARD', { id: r.approval_id, hash: rec.hash }), { fetch: f2, now: NOON_IL });
  assert.equal(out.status, 'executed');
  assert.equal(f2.calls.length, 1);
  assert.equal(f2.calls[0].url, 'https://go.ishur.io/api/event-flag');
  assert.deepEqual(f2.calls[0].body, { admin_key: 'test-admin-key', ...args });
  const again = await handleApproval(env, click('U_RICHARD', { id: r.approval_id, hash: rec.hash }), { fetch: f2, now: NOON_IL });
  assert.equal(again.status, 'already-done');
  assert.equal(f2.calls.length, 1, 'executed exactly once');
});

test('hash mismatch (stored payload tampered) is rejected', async () => {
  const { env, r } = await makePending();
  const rec = JSON.parse(env.AGENT_KV.m.get('appr:' + r.approval_id));
  const origHash = rec.hash;
  rec.payload.args.flag = 'extrasend';                       // tamper the stored payload
  env.AGENT_KV.m.set('appr:' + r.approval_id, JSON.stringify(rec));
  const f2 = recFetch();
  const out = await handleApproval(env, click('U_RICHARD', { id: r.approval_id, hash: origHash }), { fetch: f2, now: NOON_IL });
  assert.equal(out.status, 'hash-mismatch');
  assert.equal(f2.calls.length, 0);
});

test('hash mismatch (button hash differs from stored) is rejected', async () => {
  const { env, r } = await makePending();
  const f2 = recFetch();
  const out = await handleApproval(env, click('U_RICHARD', { id: r.approval_id, hash: 'f'.repeat(64) }), { fetch: f2, now: NOON_IL });
  assert.equal(out.status, 'hash-mismatch');
  assert.equal(f2.calls.length, 0);
});

test('approval is refused if AGENT_WRITE was turned off after the request', async () => {
  const { env, r } = await makePending();
  const rec = JSON.parse(env.AGENT_KV.m.get('appr:' + r.approval_id));
  env.AGENT_WRITE = 'off';
  const f2 = recFetch();
  const out = await handleApproval(env, click('U_RICHARD', { id: r.approval_id, hash: rec.hash }), { fetch: f2, now: NOON_IL });
  assert.equal(out.status, 'write-off');
  assert.equal(f2.calls.length, 0);
});

test('a red tool that reaches people is refused outside 09:00–21:00 Israel time', async () => {
  const { env, r } = await makePending();
  const rec = JSON.parse(env.AGENT_KV.m.get('appr:' + r.approval_id));
  const f2 = recFetch();
  const out = await handleApproval(env, click('U_RICHARD', { id: r.approval_id, hash: rec.hash }), { fetch: f2, now: NIGHT_IL });
  assert.equal(out.status, 'outside-window');
  assert.equal(f2.calls.length, 0);
});

/* the model asking for a red tool through the full loop still cannot execute it */
function anthropicScript(steps) {
  let i = 0;
  return recFetch(url => {
    if (url.startsWith('https://api.anthropic.com')) return { status: 200, body: steps[Math.min(i++, steps.length - 1)] };
    if (url.startsWith('https://slack.com')) return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true } };
  });
}

test('runAgent: model calls a red tool → only an approval is created; go.ishur.io untouched', async () => {
  const f = anthropicScript([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'daily_run', input: { budget: 30 } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ממתין לאישור ריצארד.' }] },
  ]);
  const env = baseEnv({ AGENT_WRITE: 'on' });
  const ctx = ctxFor('U_RICHARD', f);
  const out = await runAgent(env, [{ role: 'user', content: 'תריץ את המנוע' }], ctx);
  assert.equal(out.text, 'ממתין לאישור ריצארד.');
  assert.equal(ishurCalls(f).length, 0);
  assert.equal(ctx.approvals.length, 1);
  const second = f.to('https://api.anthropic.com')[1].body;
  const tr = second.messages.at(-1).content[0];
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.tool_use_id, 'tu1');
  assert.match(tr.content, /pending_approval/);
  const first = f.to('https://api.anthropic.com')[0];
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.init.headers['anthropic-version'], '2026-10-21');
});

test('runAgent: the tool loop is bounded', async () => {
  const f = anthropicScript([{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'cap_status', input: {} }] }]);
  const out = await runAgent(baseEnv(), [{ role: 'user', content: 'x' }], ctxFor('U_RICHARD', f));
  assert.equal(out.stop, 'max_iterations');
  assert.equal(f.to('https://api.anthropic.com').length, MAX_ITERATIONS);
});
