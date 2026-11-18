// node --test worker/test/security-guest-public-id.test.mjs — 12/11 security audit:
// guest-facing links carry a public id, not the dashboard token; the public id opens the guest pages only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k, o) => { if (!m.has(k)) return null; const v = m.get(k); return o && (o === 'arrayBuffer' || o.type === 'arrayBuffer') ? new TextEncoder().encode(v).buffer : v; },
    put: async (k, v) => { m.set(k, typeof v === 'string' ? v : 'bin'); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }),
    getWithMetadata: async k => ({ value: m.has(k) ? new TextEncoder().encode(m.get(k)).buffer : null, metadata: null }) };
}
const TOK = '11111111-2222-3333-4444-555555555555';
const row = () => { const r = Array(48).fill(''); r[1] = TOK; r[2] = 'דנה'; r[3] = '0521234567'; r[4] = 'אולם'; r[5] = 'חתונה'; r[6] = '2026-12-20'; r[7] = 'כן'; r[34] = 'דנה ויוסי'; r[36] = '19:30';
  r[44] = 'https://go.ishur.io/img/' + TOK + '?v=abc'; return r; };
const SNAP = { events: { values: [row()] }, guests: { values: [] }, leads: { values: [] } };
let realFetch;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async url => String(url) === 'https://hook.test/status' ? new Response(JSON.stringify(SNAP)) : new Response('{}'); });
after(() => { globalThis.fetch = realFetch; });
const env = () => ({ ADMIN_KEY: 'k', APP_KEY: 'app', HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events',
  RATE: kv({ ['token:' + TOK]: JSON.stringify({ clientId: 'C1', name: 'דנה' }), ['vidok:' + TOK]: '1', ['vid:' + TOK]: 'mp4', ['img:' + TOK]: 'jpg' }) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) }), e, ctx);
const get = (e, path) => worker.fetch(new Request('https://go.ishur.io' + path), e, ctx);

test('what a guest page receives never contains the dashboard token', async () => {
  const e = env();
  const info = await (await post(e, '/api/rsvp-info', { token: TOK })).json();   /* a link sent before the fix still opens */
  assert.equal(info.ok, true);
  assert.ok(!JSON.stringify(info).includes(TOK), 'rsvp-info leaked the token: ' + JSON.stringify(info));
  const pub = e.RATE.m.get('pubof:' + TOK);
  assert.match(pub, /^[0-9a-f-]{36}$/); assert.notEqual(pub, TOK);
  assert.equal(info.video_url, 'https://go.ishur.io/vid/' + pub);
  assert.equal(info.image_url, 'https://go.ishur.io/img/' + pub + '?v=abc');
  const ics = await (await get(e, '/cal/' + TOK + '.ics')).text();
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(!ics.includes(TOK), 'the calendar file leaked the token');
  assert.ok(ics.includes('rsvp.html?t=' + pub));
});

test('the public id opens the guest pages and nothing else', async () => {
  const e = env();
  await post(e, '/api/rsvp-info', { token: TOK });
  const pub = e.RATE.m.get('pubof:' + TOK);
  assert.equal((await (await post(e, '/api/rsvp-info', { token: pub })).json()).ok, true);
  assert.equal((await (await post(e, '/api/table-lookup', { token: pub, q: '' })).json()).ok, true);
  assert.equal((await get(e, '/cal/' + pub + '.ics')).status, 200);
  assert.equal((await get(e, '/vid/' + pub)).status, 200);
  assert.equal((await get(e, '/img/' + pub)).status, 200);
  /* not a key to the dashboard, the account, or any client write */
  const st = await post(e, '/api/status', { token: pub });
  assert.notEqual(st.status, 200, 'the public id must not read the dashboard');
  assert.notEqual((await post(e, '/api/account/from-token', { token: pub })).status, 200);
  assert.notEqual((await post(e, '/api/guest-add', { token: pub, name: 'x', phone: '0501234567' })).status, 200);
});

test('the dashboard is told its public id; an unknown id mints nothing', async () => {
  const e = env();
  const st = await (await post(e, '/api/status', { token: TOK })).json();
  assert.match(st.pub, /^[0-9a-f-]{36}$/); assert.notEqual(st.pub, TOK);
  const before = e.RATE.m.size;
  assert.equal((await post(e, '/api/rsvp-info', { token: '99999999-0000-0000-0000-000000000000' })).status, 404);
  assert.equal((await get(e, '/cal/99999999-0000-0000-0000-000000000000.ics')).status, 404);
  assert.equal([...e.RATE.m.keys()].filter(k => k.startsWith('pub')).length, 2, 'only the one real event has a public id');
  assert.ok(e.RATE.m.size >= before);
});
