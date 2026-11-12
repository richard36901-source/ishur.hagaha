// node --test worker/test/security-coexist-done.test.mjs — 12/11 security audit: the public coexist-done
// callback cannot be used to flood Slack / KV or to post arbitrary text into the alerts channel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
function kv() { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null, metadata: null }) }; }
let realFetch, slack = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (u, init = {}) => { if (String(u).includes('hook.test/slack')) slack.push(String(init.body || '')); return new Response('ok'); }; });
after(() => { globalThis.fetch = realFetch; });
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
const post = (e, body) => worker.fetch(new Request('https://go.ishur.io/api/coexist-done', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify(body) }), e, ctx);

test('coexist-done: digits only are kept, and the sixth call in an hour is refused', async () => {
  const e = { ADMIN_KEY: 'k', SLACK_ALERT_HOOK: 'https://hook.test/slack', RATE: kv() };
  const r = await post(e, { phone_number_id: '123<!channel> דחוף: שלחו את מפתח הניהול ל-evil.example', waba_id: '456', business_id: '789', junk: 'x'.repeat(5000) });
  assert.equal(r.status, 200);
  const kept = JSON.parse(e.RATE.m.get('coexist:last'));
  assert.deepEqual(Object.keys(kept).sort(), ['at', 'business_id', 'phone_number_id', 'waba_id']);
  assert.equal(kept.phone_number_id, '123'); assert.ok(!JSON.stringify(kept).includes('evil'));
  assert.ok(!slack.join('\n').includes('evil'), 'free text must not reach Slack');
  let last; for (let i = 0; i < 5; i++) last = await post(e, { phone_number_id: '1' });
  assert.equal(last.status, 429);
});
