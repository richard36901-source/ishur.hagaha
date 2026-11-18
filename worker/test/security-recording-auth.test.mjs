// node --test worker/test/security-recording-auth.test.mjs — 12/11 security audit, pass 2: an admin page can fetch a
// kept recording with the key in a header (X-Admin-Key), so the key does not have to ride in the URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../index.js';
function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async (k, t) => m.has(k) ? (t === 'arrayBuffer' ? new TextEncoder().encode(m.get(k)).buffer : m.get(k)) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async () => ({ keys: [], list_complete: true }), getWithMetadata: async () => ({ value: null, metadata: null }) }; }
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const env = () => ({ ADMIN_KEY: 'raw-admin-key', RATE: kv({ 'rec:call_1': 'AUDIO', 'recmeta:call_1': JSON.stringify({ mime: 'audio/wav', name: 'a.wav' }) }) });
const get = (e, path, headers = {}) => worker.fetch(new Request('https://go.ishur.io' + path, { headers: { Origin: 'https://ishur.io', ...headers } }), e, ctx);

test('the key in a header opens the recording, and the answer is readable from the admin pages', async () => {
  const e = env();
  const r = await get(e, '/rec/call_1', { 'X-Admin-Key': 'raw-admin-key' });
  assert.equal(r.status, 200); assert.equal(await r.text(), 'AUDIO');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://ishur.io');
  /* a signed admin session works the same way */
  const nonce = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + 'ab'.repeat(12);
  const sess = 'sess.' + nonce + '.' + crypto.createHmac('sha256', 'raw-admin-key').update('sess2:' + nonce).digest('hex').slice(0, 32);
  assert.equal((await get(e, '/rec/call_1', { 'X-Admin-Key': sess })).status, 200);
});
test('no key, a wrong key or a forged session: refused; a signed link still works without any key', async () => {
  const e = env();
  assert.equal((await get(e, '/rec/call_1')).status, 403);
  assert.equal((await get(e, '/rec/call_1', { 'X-Admin-Key': 'nope' })).status, 403);
  assert.equal((await get(e, '/rec/call_1', { 'X-Admin-Key': 'sess.' + 'a'.repeat(32) + '.' + 'b'.repeat(32) })).status, 403);
  const exp = Date.now() + 3600e3;
  const s = crypto.createHash('sha256').update(`rec|call_1|${exp}|raw-admin-key`).digest('hex').slice(0, 32);
  assert.equal((await get(e, `/rec/call_1?e=${exp}&s=${s}`)).status, 200);
  assert.equal((await get(e, `/rec/call_1?e=${exp}&s=${'0'.repeat(32)}`)).status, 403);
});
