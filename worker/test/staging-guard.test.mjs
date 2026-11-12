// node --test worker/test/staging-guard.test.mjs — dev-staging (12/11/2026): the hard egress guard.
// In staging (STAGING="1") every outbound fetch is wrapped: WhatsApp / Retell only to the allowlist, no
// writes to CRM/billing hosts, unknown hosts blocked, EMAIL.send blocked. Production: nothing installed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStagingGuard, uninstallStagingGuard, isStaging, isAllowedPhone, decide, wrapEmail, BLOCKED } from '../staging-guard.js';

const ALLOW = '972545764327,972526979535';
function kv() { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; }
function env(extra = {}) { return { STAGING: '1', STAGING_ALLOWLIST: ALLOW, RATE: kv(), ...extra }; }
const calls = [];
const realFetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"ok":true}', { status: 200 }); };
let saved;
beforeEach(() => { calls.length = 0; saved = globalThis.fetch; globalThis.fetch = realFetch; });
afterEach(() => { uninstallStagingGuard(); globalThis.fetch = saved; });

test('isStaging: only the literal "1"', () => {
  assert.equal(isStaging({ STAGING: '1' }), true);
  assert.equal(isStaging({ STAGING: 'true' }), false);
  assert.equal(isStaging({}), false);
  assert.equal(isStaging(null), false);
});

test('isAllowedPhone: digits in any Israeli form, nothing else', () => {
  const e = env();
  assert.equal(isAllowedPhone(e, '972545764327'), true);
  assert.equal(isAllowedPhone(e, '+972545764327'), true);
  assert.equal(isAllowedPhone(e, '0545764327'), true);
  assert.equal(isAllowedPhone(e, '972501234567'), false);
  assert.equal(isAllowedPhone(e, ''), false);
  assert.equal(isAllowedPhone({ STAGING: '1' }, '972545764327'), false, 'empty allowlist allows nobody');
});

test('production: STAGING unset → fetch identity unchanged, decide() allows everything', () => {
  const before = globalThis.fetch;
  installStagingGuard({});
  assert.equal(globalThis.fetch, before);
  assert.equal(decide({}, 'https://graph.facebook.com/v21.0/1/messages', 'POST', JSON.stringify({ to: '972501234567' })).ok, true);
});

test('WhatsApp to a non-allowlisted number is blocked, never reaches the network, and is journaled', async () => {
  const e = env();
  installStagingGuard(e);
  const r = await fetch('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', to: '972501234567', type: 'text', text: { body: 'hi' } }) });
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.ok, false); assert.equal(j.error, BLOCKED); assert.equal(j.to, '972501234567');
  assert.equal(calls.length, 0);
  await new Promise(r => setTimeout(r, 0));
  assert.ok([...e.RATE.m.keys()].some(k => k.startsWith('stagingblock:')), 'journal row written');
});

test('WhatsApp to an allowlisted number passes through', async () => {
  installStagingGuard(env());
  const r = await fetch('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body: JSON.stringify({ to: '972545764327', type: 'text' }) });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
});

test('Graph reads (templates) are allowed; a Request object is inspected too', async () => {
  installStagingGuard(env());
  const r = await fetch('https://graph.facebook.com/v21.0/999/message_templates?name=x');
  assert.equal(r.status, 200);
  const req = new Request('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body: JSON.stringify({ to: '972501234567' }) });
  const b = await fetch(req);
  assert.equal(b.status, 403);
  assert.equal(calls.length, 1);
});

test('Retell create-phone-call: to_number outside the allowlist is blocked, inside passes', async () => {
  installStagingGuard(env());
  const bad = await fetch('https://api.retellai.com/v2/create-phone-call', { method: 'POST', body: JSON.stringify({ from_number: '+972555077733', to_number: '+972501234567' }) });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).to, '972501234567');
  const good = await fetch('https://api.retellai.com/v2/create-phone-call', { method: 'POST', body: JSON.stringify({ to_number: '+972526979535' }) });
  assert.equal(good.status, 200);
  assert.equal(calls.length, 1);
});

test('read-only hosts: GET passes, POST blocked (Monday, Telnyx, Linear, Cloudflare, googleapis)', async () => {
  installStagingGuard(env());
  for (const u of ['https://api.monday.com/v2', 'https://api.telnyx.com/v2/balance', 'https://api.linear.app/graphql', 'https://api.cloudflare.com/client/v4/graphql', 'https://sheets.googleapis.com/v4/x']) {
    assert.equal((await fetch(u)).status, 200, 'GET ' + u);
    assert.equal((await fetch(u, { method: 'POST', body: '{}' })).status, 403, 'POST ' + u);
  }
  assert.equal(calls.length, 5);
});

test('billing/payment hosts and unknown hosts are blocked outright; allowed hosts pass', async () => {
  installStagingGuard(env());
  for (const u of ['https://api.morning.co/idp/v1/oauth/token', 'https://api.greeninvoice.co.il/api/v1/x', 'https://secure.meshulam.co.il/api/x', 'https://example.com/anything', 'https://go.ishur.io/api/x']) {
    assert.equal((await fetch(u)).status, 403, u);
  }
  assert.equal(calls.length, 0);
  for (const u of ['https://hooks.slack.com/services/x', 'https://hook.eu2.make.com/abc', 'https://api.anthropic.com/v1/messages', 'https://us.i.posthog.com/i/v0/e/']) {
    assert.equal((await fetch(u, { method: 'POST', body: '{}' })).status, 200, u);
  }
  assert.equal(calls.length, 4);
});

test('a body that is not JSON on a send endpoint is blocked (fail closed)', async () => {
  installStagingGuard(env());
  const r = await fetch('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body: 'to=972545764327' });
  assert.equal(r.status, 403);
});

test('install is idempotent: wrapping twice keeps one layer', () => {
  const e = env();
  installStagingGuard(e);
  const once = globalThis.fetch;
  installStagingGuard(e);
  assert.equal(globalThis.fetch, once);
});

test('wrapEmail: staging send is refused without touching the binding; production untouched', async () => {
  let sent = 0;
  const binding = { send: async () => { sent++; return { ok: true }; } };
  const e = wrapEmail(env({ EMAIL: binding }));
  const r = await e.EMAIL.send({ to: 'x@y' });
  assert.equal(r.ok, false); assert.equal(r.error, BLOCKED); assert.equal(sent, 0);
  const p = wrapEmail({ EMAIL: binding });
  assert.equal(p.EMAIL, binding);
});
