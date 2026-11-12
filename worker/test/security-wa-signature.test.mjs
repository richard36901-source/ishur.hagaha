// node --test worker/test/security-wa-signature.test.mjs — 12/11 security audit, pass 2: the WhatsApp inbound
// webhook checks Meta's X-Hub-Signature-256 once the app secret exists, and behaves exactly as before without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../index.js';
function kv() { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null, metadata: null }) }; }
let realFetch, slack = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (u, init = {}) => { if (String(u).includes('hook.test/slack')) slack.push(String(init.body || '')); return new Response('{}'); }; });
after(() => { globalThis.fetch = realFetch; });
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const sign = (secret, body = BODY) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const post = (e, t, sig, body = BODY) => worker.fetch(new Request('https://go.ishur.io/api/wa-webhook?t=' + t, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) }, body }), e, ctx);
const base = () => ({ ADMIN_KEY: 'k', WA_VERIFY: 'tok-client', WA_VERIFY_GUESTS: 'tok-guests', SLACK_ALERT_HOOK: 'https://hook.test/slack', RATE: kv() });

test('no app secret: the webhook answers as before, with or without a signature header', async () => {
  const e = base();
  assert.equal((await post(e, 'tok-client')).status, 200);
  assert.equal((await post(e, 'tok-guests', 'sha256=' + '0'.repeat(64))).status, 200);
  assert.equal((await post(e, 'wrong')).status, 403);
});

test('client app secret set: a missing or wrong signature is refused, the right one passes', async () => {
  const e = { ...base(), META_APP_SECRET: 'client-secret' };
  slack = [];
  assert.equal((await post(e, 'tok-client')).status, 403, 'missing header');
  assert.equal((await post(e, 'tok-client', sign('other-secret'))).status, 403, 'signed with another secret');
  assert.equal((await post(e, 'tok-client', sign('client-secret', BODY + ' '))).status, 403, 'signature of a different body');
  assert.equal((await post(e, 'tok-client', 'sha256=zz')).status, 403, 'malformed header');
  assert.equal((await post(e, 'tok-client', sign('client-secret'))).status, 200, 'valid signature');
  assert.ok(e.RATE.m.has('wasigbad:client'), 'the refusal is recorded once per channel');
  assert.ok(slack.length <= 1, 'four refusals raise one alert at most, got ' + slack.length);
});

test('only one secret set: only that channel is verified', async () => {
  const e = { ...base(), META_APP_SECRET: 'client-secret' };
  assert.equal((await post(e, 'tok-guests')).status, 200, 'guests channel has no secret yet, unchanged');
  const g = { ...base(), META_APP_SECRET_GUESTS: 'guests-secret' };
  assert.equal((await post(g, 'tok-client')).status, 200, 'client channel has no secret yet, unchanged');
  assert.equal((await post(g, 'tok-guests')).status, 403);
  assert.equal((await post(g, 'tok-guests', sign('client-secret'))).status, 403, 'the other app\'s secret does not sign for this channel');
  assert.equal((await post(g, 'tok-guests', sign('guests-secret'))).status, 200);
});

test('both secrets set: each channel accepts only its own app secret; the GET handshake is untouched', async () => {
  const e = { ...base(), META_APP_SECRET: 'client-secret', META_APP_SECRET_GUESTS: 'guests-secret' };
  assert.equal((await post(e, 'tok-client', sign('client-secret'))).status, 200);
  assert.equal((await post(e, 'tok-guests', sign('guests-secret'))).status, 200);
  assert.equal((await post(e, 'tok-client', sign('guests-secret'))).status, 403);
  const r = await worker.fetch(new Request('https://go.ishur.io/api/wa-webhook?hub.mode=subscribe&hub.verify_token=tok-client&hub.challenge=42'), e, ctx);
  assert.equal(r.status, 200); assert.equal(await r.text(), '42');
});
