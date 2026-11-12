// node --test worker/test/security-monday-hook.test.mjs — 12/11 security audit: the monday webhook is closed when no key is configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
const hook = (e, k) => worker.fetch(new Request('https://go.ishur.io/api/monday-hook' + (k == null ? '' : '?k=' + k), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { type: 'create_item', pulseName: 'x' } }) }), e, ctx);
test('monday-hook: no key configured → 403; wrong key → 403; the challenge handshake still answers', async () => {
  assert.equal((await hook({}, null)).status, 403);
  assert.equal((await hook({ ADMIN_KEY: 'secret-key' }, 'nope')).status, 403);
  assert.equal((await hook({ ADMIN_KEY: 'secret-key' }, null)).status, 403);
  const r = await worker.fetch(new Request('https://go.ishur.io/api/monday-hook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: 'abc' }) }), {}, ctx);
  assert.equal((await r.json()).challenge, 'abc');
});
