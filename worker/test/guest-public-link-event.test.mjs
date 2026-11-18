// node --test worker/test/guest-public-link-event.test.mjs — 15/11: an answer through an event's public link lands on THAT event's row
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, typeof v === 'string' ? v : 'bin'); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }),
    getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) };
}
const HENNA = 'aaaaaaaa-2222-3333-4444-555555555555', WEDDING = 'bbbbbbbb-2222-3333-4444-555555555555';
const evRow = (tok, date, occ) => { const r = Array(48).fill(''); r[1] = tok; r[2] = 'שילת'; r[5] = occ; r[6] = date; r[7] = 'כן'; r[34] = 'שילת ושי'; return r; };
const gRow = (tok, id, o = {}) => { const r = Array(31).fill(''); r[2] = id; r[3] = 'אופיר'; r[4] = '0521234567'; r[28] = tok; r[8] = o.sent1 || ''; r[15] = o.rsvp || ''; return r; };
const SNAP = { events: { values: [evRow(HENNA, '2099-01-01', 'חינה'), evRow(WEDDING, '2099-02-01', 'חתונה')] },
  guests: { values: [gRow(HENNA, 'G-aaaaaaaa-7', { sent1: '2098-12-20 09:00' }), gRow(WEDDING, 'G-bbbbbbbb-9')] }, leads: { values: [] } };
let realFetch, hookBodies;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (url, init) => {
  if (String(url) === 'https://hook.test/status') return new Response(JSON.stringify(SNAP));
  if (String(url) === 'https://hook.test/events') { try { hookBodies.push(JSON.parse(init.body)); } catch {} return new Response('{}'); }
  return new Response('{}'); }; });
after(() => { globalThis.fetch = realFetch; });
const env = () => ({ ADMIN_KEY: 'k', APP_KEY: 'app', HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events',
  RATE: kv({ ['token:' + HENNA]: JSON.stringify({ clientId: 'C1', name: 'שילת' }), ['token:' + WEDDING]: JSON.stringify({ clientId: 'C1', name: 'שילת' }) }) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body, ip) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }), e, ctx);

for (const [label, tok, want, ip] of [['the wedding link', WEDDING, 'G-bbbbbbbb-9', '9.9.9.1'], ['the henna link', HENNA, 'G-aaaaaaaa-7', '9.9.9.2']]) {
  test(`a guest on both lists answers through ${label}: only that event's row is written`, async () => {
    hookBodies = [];
    const r = await post(env(), '/api/rsvp-self', { token: tok, name: 'אופיר', phone: '0521234567', party: 2 }, ip);
    assert.equal((await r.json()).existing, true);
    const writes = hookBodies.filter(b => b.event_type === 'call_result');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].guest_id, want);
    assert.equal(writes[0].rsvp, 'מגיע');
  });
}
