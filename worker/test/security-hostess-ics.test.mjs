// node --test worker/test/security-hostess-ics.test.mjs — 12/11 security audit: the hostess calendar feed
// (client names, venues, phones) cannot be located with the public APP_KEY from config.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../index.js';
function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null, metadata: null }) }; }
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
const env = () => ({ ADMIN_KEY: 'admin-secret', APP_KEY: 'public-app-key', RATE: kv({ 'hostessbook:tok': JSON.stringify({ date: '2026-12-20', start: '2026-12-20T15:00:00.000Z', end: '2026-12-20T23:00:00.000Z', n: 1, client: 'דנה', phone: '972521234567' }) }) });
test('the feed is not at the address derived from the public APP_KEY', async () => {
  const guess = createHash('sha256').update('public-app-key|hostess-ics').digest('hex').slice(0, 24);
  const r = await worker.fetch(new Request('https://go.ishur.io/cal/hostess-' + guess + '.ics'), env(), ctx);
  assert.equal(r.status, 404);
});
test('the admin still gets a working address', async () => {
  const e = env();
  const j = await (await worker.fetch(new Request('https://go.ishur.io/api/hostess-ics-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'admin-secret' }) }), e, ctx)).json();
  assert.match(j.url, /^https:\/\/go\.ishur\.io\/cal\/hostess-[0-9a-f]{24}\.ics$/);
  const r = await worker.fetch(new Request(j.url), e, ctx);
  assert.equal(r.status, 200); assert.ok((await r.text()).includes('BEGIN:VEVENT'));
  assert.equal((await worker.fetch(new Request('https://go.ishur.io/api/hostess-ics-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'x' }) }), e, ctx)).status, 403);
});
