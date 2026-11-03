import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySlackSignature, hmacHex } from '../src/slack.js';
import { handleEvents, handleInteractive } from '../src/index.js';
import { baseEnv, signedRequest, fakeCtx } from './helpers.mjs';

const SECRET = 'sign-secret';
const H = o => new Headers(o);

test('valid v0 signature inside the window is accepted', async () => {
  const ts = 1_800_000_000, body = '{"a":1}';
  const sig = 'v0=' + await hmacHex(SECRET, `v0:${ts}:${body}`);
  const r = await verifySlackSignature(SECRET, H({ 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig }), body, ts + 10);
  assert.deepEqual(r, { ok: true });
});

test('wrong secret / tampered body is rejected', async () => {
  const ts = 1_800_000_000, body = '{"a":1}';
  const sig = 'v0=' + await hmacHex('other', `v0:${ts}:${body}`);
  assert.equal((await verifySlackSignature(SECRET, H({ 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig }), body, ts)).why, 'bad-signature');
  const good = 'v0=' + await hmacHex(SECRET, `v0:${ts}:${body}`);
  assert.equal((await verifySlackSignature(SECRET, H({ 'x-slack-request-timestamp': String(ts), 'x-slack-signature': good }), '{"a":2}', ts)).why, 'bad-signature');
});

test('timestamp older or newer than 5 minutes is rejected (replay)', async () => {
  const ts = 1_800_000_000, body = 'x';
  const sig = 'v0=' + await hmacHex(SECRET, `v0:${ts}:${body}`);
  const h = H({ 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig });
  assert.equal((await verifySlackSignature(SECRET, h, body, ts + 301)).why, 'stale');
  assert.equal((await verifySlackSignature(SECRET, h, body, ts - 301)).why, 'stale');
  assert.equal((await verifySlackSignature(SECRET, h, body, ts + 300)).ok, true);
});

test('missing headers / missing secret are rejected', async () => {
  assert.equal((await verifySlackSignature(SECRET, H({}), 'x')).why, 'missing-headers');
  assert.equal((await verifySlackSignature('', H({ 'x-slack-request-timestamp': '1', 'x-slack-signature': 'v0=00' }), 'x')).why, 'no-secret');
});

test('/slack/events: bad signature → 401, nothing queued', async () => {
  const env = baseEnv(); const ctx = fakeCtx();
  const req = await signedRequest('/slack/events', '{"type":"url_verification","challenge":"c"}', SECRET, { sig: 'v0=deadbeef' });
  const res = await handleEvents(req, env, ctx);
  assert.equal(res.status, 401);
  assert.equal(ctx.pending.length, 0);
});

test('/slack/events: url_verification echoes the challenge', async () => {
  const env = baseEnv(); const ctx = fakeCtx();
  const res = await handleEvents(await signedRequest('/slack/events', '{"type":"url_verification","challenge":"abc123"}', SECRET), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'abc123');
});

test('/slack/events: acks immediately, work goes to waitUntil, retries with the same event_id are deduped', async () => {
  const env = baseEnv(); const ctx = fakeCtx();
  const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', event: { type: 'reaction_added', channel: 'C_HAGAA' } });
  const r1 = await handleEvents(await signedRequest('/slack/events', body, SECRET), env, ctx);
  assert.equal(r1.status, 200);
  assert.equal(ctx.pending.length, 1);
  const r2 = await handleEvents(await signedRequest('/slack/events', body, SECRET, { headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' } }), env, ctx);
  const j2 = await r2.json();
  assert.equal(j2.duplicate, true);
  assert.equal(j2.retry, '1');
  assert.equal(ctx.pending.length, 1, 'retry must not start a second run');
  await ctx.done();
});

test('/slack/interactive: bad signature → 401', async () => {
  const env = baseEnv(); const ctx = fakeCtx();
  const res = await handleInteractive(await signedRequest('/slack/interactive', 'payload=%7B%7D', SECRET, { sig: 'v0=00' }), env, ctx);
  assert.equal(res.status, 401);
  assert.equal(ctx.pending.length, 0);
});
