// node --test worker/test/security-headers.test.mjs — 12/11 security audit: baseline response headers on every answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
test('API answers carry HSTS, nosniff and a referrer policy (errors and preflights too)', async () => {
  for (const rq of [new Request('https://go.ishur.io/api/ops/overview'), new Request('https://go.ishur.io/api/status', { method: 'OPTIONS' }),
    new Request('https://go.ishur.io/api/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), new Request('https://go.ishur.io/img/nope')]) {
    const r = await worker.fetch(rq, { ADMIN_KEY: 'k' }, ctx);
    assert.match(r.headers.get('Strict-Transport-Security') || '', /max-age=\d+/, rq.url);
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff', rq.url);
    assert.ok(r.headers.get('Referrer-Policy'), rq.url);
  }
  const r = await worker.fetch(new Request('https://go.ishur.io/api/ops/overview'), { ADMIN_KEY: 'k' }, ctx);
  assert.equal(r.status, 403); assert.equal((await r.json()).ok, false, 'the body still arrives intact');
});
