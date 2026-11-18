import test from 'node:test'; import assert from 'node:assert/strict';
import { handleLeadsMonday, shapeUpdates, hookUrl, WEBHOOK_EVENTS } from '../leads-monday.js';
const kv = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } }; };
const D = gql => ({ deny: (s, e) => new Response(JSON.stringify({ ok: false, error: e }), { status: s }), okJson: o => new Response(JSON.stringify(o)), isAdmin: (env, k) => k === 'k', gql });
const post = (env, body, gql) => handleLeadsMonday(new Request('https://x', { method: 'POST', body: JSON.stringify({ admin_key: 'k', ...body }) }), env, '', D(gql)).then(r => r.json());
test('updates of a lead: newest thread entries, trimmed, empty ones dropped; a wrong key is refused', async () => {
  assert.deepEqual(shapeUpdates([{ updates: [{ id: 1, text_body: ' דיברנו, חוזרת מחר ', created_at: 'T', creator: { name: 'שלו' } }, { id: 2, text_body: '' }] }]), [{ id: '1', at: 'T', who: 'שלו', text: 'דיברנו, חוזרת מחר' }]);
  const env = { MONDAY_API_TOKEN: 't', RATE: kv() }; let asked = null;
  const r = await post(env, { updates_of: 'm123' }, async (e, q, v) => { asked = v; return { items: [{ updates: [{ id: 9, text_body: 'x', created_at: 'T', creator: null }] }] }; });
  assert.deepEqual([r.ok, r.updates.length, asked.i], [true, 1, ['123']]);
  assert.equal((await handleLeadsMonday(new Request('https://x', { method: 'POST', body: JSON.stringify({ admin_key: 'no', updates_of: 1 }) }), env, '', D(async () => ({})))).status, 403);
  assert.equal((await post(env, { updates_of: 5 }, async () => { throw new Error('down'); })).error, 'monday-read-failed');
});
test('webhooks: need the secret, register each event once, status lists them, remove clears them; the secret rides only in the URL', async () => {
  const env = { MONDAY_API_TOKEN: 't', RATE: kv() }; const calls = [];
  const gql = async (e, q, v) => { calls.push([/create_webhook/.test(q) ? 'create' : 'delete', v]); return /create_webhook/.test(q) ? { create_webhook: { id: 'w' + calls.length } } : { delete_webhook: { id: v.i } }; };
  assert.equal((await post(env, { webhook: 'register' }, gql)).error, 'no-webhook-secret');
  env.MONDAY_WEBHOOK_SECRET = 's3cret';
  let r = await post(env, { webhook: 'register' }, gql); assert.equal(r.ok, true); assert.deepEqual(r.registered, WEBHOOK_EVENTS); assert.equal(calls.length, WEBHOOK_EVENTS.length);
  assert.ok(calls.every(c => c[1].u === hookUrl(env) && c[1].b === '18432553641')); assert.match(hookUrl(env), /^https:\/\/go\.ishur\.io\/webhooks\/monday-leads\?k=s3cret$/);
  r = await post(env, { webhook: 'register' }, gql); assert.equal(calls.length, WEBHOOK_EVENTS.length, 'a second register adds nothing');
  r = await post(env, { webhook: 'status' }, gql); assert.deepEqual([r.secret_set, r.registered.length], [true, WEBHOOK_EVENTS.length]); assert.ok(!JSON.stringify(r).includes('s3cret'));
  r = await post(env, { webhook: 'remove' }, gql); assert.deepEqual([r.ok, r.registered], [true, []]); assert.equal(env.RATE.m.size, 0);
});
