// node --test worker/test/ops-inbox.test.mjs — Phase 4a: /api/ops/messages (one row per message), inbox, thread, control,
// and the change-log rows of the manual-control routes. Everything stubbed; nothing is sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker, { CHANGE_ROUTES } from '../index.js';
import { groupMessages, pageMessages, inboxView, threadView, directory, outText } from '../ops-inbox.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const plus = n => ilDay(new Date(Date.now() + n * 864e5));
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'דנה לקוחה'; ev[3] = '0521111111'; ev[5] = 'חתונה'; ev[6] = plus(5); ev[7] = 'כן'; ev[43] = 'כן'; ev[34] = 'אורי ויצחק';
  const g = (n, rsvp) => { const r = Array(31).fill(''); r[28] = TOK; r[3] = 'אורח ' + n; r[4] = '05200000' + n + '1'; r[15] = rsvp; return r; };
  return { events: { values: [ev] }, guests: { values: [g(1, 'מגיע'), g(2, '')] } };
}
let realFetch;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (u) => (String(u) === 'https://hook.test/status' ? new Response(JSON.stringify(snapshot())) : new Response('{}')); });
after(() => { globalThis.fetch = realFetch; });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const env = (init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_PHONE_IDS_GUESTS: 'B', WA_TOKEN_GUESTS: 't', WA_PHONE_ID_CLIENT: 'N', WA_TOKEN: 'ct', RATE: kv(init) });
const get = (e, path) => worker.fetch(new Request('https://go.ishur.io' + path, { headers: { 'X-Admin-Key': 'k' } }), e, ctx);

const T0 = Date.now() - 3 * 3600e3;
const row = (kind, dt, o) => ({ kind, ts: T0 + dt, at: new Date(T0 + dt).toISOString(), id: kind + dt, ok: true, ...o });
const OUT = [
  row('wa_out', 0, { phone: '972520000011', token: TOK, area: 'שיר', detail: 'שלום אורח 1, הוזמנת…', data: { phone_id: 'A', wamid: 'w1', template: 'hazmana_ishur' } }),
  row('wa_out', 1000, { phone: '972520000021', token: TOK, area: 'שיר', ok: false, detail: '(#131049) limited · שלום אורח 2', data: { phone_id: 'B', wamid: '', template: 'hazmana_ishur', error: '(#131049) limited' } }),
  row('wa_out', 2000, { phone: '972521111111', area: 'נועה', detail: 'היי דנה', data: { phone_id: 'N', wamid: 'w3', template: '' } }),
];
const ST = [row('wa_status', 100, { data: { wamid: 'w1', status: 'sent' } }), row('wa_status', 200, { data: { wamid: 'w1', status: 'delivered' } }), row('wa_status', 300, { data: { wamid: 'w1', status: 'read' } }),
  row('wa_status', 2100, { ok: false, detail: '131026 undeliverable', data: { wamid: 'w3', status: 'failed' } })];
const IN = [row('wa_in', 5000, { phone: '972520000011', area: 'שיר', detail: 'מגיע עם 2' }), row('wa_in', 26 * 3600e3, { phone: '972521111111', area: 'נועה', detail: 'מאוחר מדי' })];

test('groupMessages: one row per message, latest status wins, failed carries the Meta code, reply within 24h only', () => {
  const dir = directory(snapshot());
  const { items, inbound } = groupMessages(OUT, ST, IN, { numbers: { A: { label: 'שיר #1', role: 'guests' }, B: { label: 'שיר #2', role: 'guests' }, N: { label: 'נועה', role: 'client' } }, clientIds: ['N'], dir });
  assert.equal(items.length, 3, 'three sends, four status rows → three rows');
  const w1 = items.find(x => x.wamid === 'w1');
  assert.equal(w1.status, 'read'); assert.equal(w1.statuses.length, 3); assert.equal(w1.number.label, 'שיר #1');
  assert.equal(w1.type, 'wave'); assert.equal(w1.event, 'אורי ויצחק'); assert.equal(w1.to_name, 'אורח 1');
  assert.equal(w1.reply.text, 'מגיע עם 2');
  const rej = items.find(x => x.to === '972520000021');
  assert.equal(rej.status, 'failed'); assert.equal(rej.error_code, '131049'); assert.equal(rej.text, 'שלום אורח 2');
  const noa = items.find(x => x.wamid === 'w3');
  assert.equal(noa.status, 'failed'); assert.equal(noa.error_code, '131026'); assert.equal(noa.type, 'reply'); assert.equal(noa.to_role, 'client');
  assert.equal(noa.reply, null, 'an inbound 26h later is not a reply');
  assert.equal(inbound.length, 2); assert.equal(inbound.find(x => x.text === 'מגיע עם 2').in_reply_to.id, 'w1');
  const p = pageMessages({ items, inbound }, { tab: 'failed' });
  assert.equal(p.items.length, 2); assert.equal(p.counts.all, 3); assert.equal(p.counts.replies, 2);
  const p1 = pageMessages({ items, inbound }, { limit: 2 }); assert.equal(p1.items.length, 2); assert.ok(p1.next_cursor);
  assert.equal(pageMessages({ items, inbound }, { cursor: p1.next_cursor }).items.length, 1);
  assert.equal(outText({ ok: true, detail: 'x · y' }), 'x · y');
});

test('inboxView: unread first, role badges, 24h window, takeover', () => {
  const now = Date.now(); const dir = directory(snapshot());
  const v = inboxView([
    { phone: '972521111111', last_ts: now - 1000, last_dir: 'out', ch: ['client'] },
    { phone: '972530000000', last_ts: now - 5000, last_dir: 'in', last_in_ts: now - 5000, ch: ['client'] },
    { phone: '972520000011', last_ts: now - 30 * 3600e3, last_dir: 'in', ch: ['guests'] },
  ], { leads: new Set(['972530000000']), humans: new Set(['972530000000']), dir, now });
  assert.deepEqual(v.map(x => x.role), ['lead', 'guest', 'client']);
  assert.equal(v[0].unread, true); assert.equal(v[0].window_open, true); assert.equal(v[0].human, true);
  assert.equal(v[1].window_open, false, '30h old inbound → window closed');
  assert.equal(v[2].event, 'אורי ויצחק'); assert.equal(v[2].token, TOK);
});

test('threadView: bubbles sorted, window from the last inbound, channel from the last message', () => {
  const now = Date.now();
  const t = threadView({ phone: '972520000011', messages: [{ ts: now - 1000, dir: 'out', text: 'b', id: 'x', status: 'read', ch: 'guests' }, { ts: now - 3600e3, dir: 'in', text: 'a', ch: 'guests' }], ai_off: false }, { now, dir: directory(snapshot()) });
  assert.deepEqual(t.messages.map(m => m.text), ['a', 'b']); assert.equal(t.window.open, true); assert.equal(t.channel, 'guests'); assert.equal(t.role, 'guest');
  assert.equal(threadView({ phone: '1', messages: [{ ts: now - 25 * 3600e3, dir: 'in', text: 'a' }] }, { now }).window.open, false);
  assert.ok(t.templates.length >= 5);
});

test('routes: messages / inbox / thread / control through the Worker', async () => {
  const day = ilDay(new Date(T0)).replace(/-/g, '');
  const init = {};
  for (const r of [...OUT, ...ST, ...IN]) init[`stream:${ilDay(new Date(r.ts)).replace(/-/g, '')}:${r.ts}:${r.kind}`] = JSON.stringify(r);
  init['conv:972530000000'] = JSON.stringify({ phone: '972530000000', last_ts: Date.now() - 1000, last_dir: 'in', last_in_ts: Date.now() - 1000, ch: ['client'], last_text: 'היי' });
  init['lead:972530000000'] = '{}'; init['log:972530000000:' + (Date.now() - 1000)] = JSON.stringify({ dir: 'in', text: 'היי', ch: 'client' });
  init['hold:' + TOK] = '1';
  const e = env(init);
  const m = await (await get(e, '/api/ops/messages?day=' + ilDay(new Date(T0)))).json();
  assert.equal(m.ok, true, JSON.stringify(m)); assert.equal(m.items.length, 3); assert.equal(m.items.find(x => x.wamid === 'w1').status, 'read');
  assert.ok(day);
  const f = await (await get(e, '/api/ops/messages?tab=failed&day=' + ilDay(new Date(T0)))).json(); assert.equal(f.items.length, 2);
  const ib = await (await get(e, '/api/ops/inbox')).json();
  assert.equal(ib.items[0].role, 'lead'); assert.equal(ib.items[0].unread, true); assert.equal(ib.counts.unread, 1);
  const th = await (await get(e, '/api/ops/thread?phone=0530000000')).json();
  assert.equal(th.role, 'lead'); assert.equal(th.messages.length, 1); assert.equal(th.window.open, true);
  assert.equal((await get(e, '/api/ops/thread?phone=')).status, 400);
  const c = await (await get(e, '/api/ops/control')).json();
  assert.equal(c.events.length, 1); assert.equal(c.events[0].hold, true); assert.equal(c.events[0].guests, 2); assert.equal(c.events[0].pending, 1);
  assert.ok(![...e.RATE.m.keys()].some(k => k.startsWith('chg:')), 'reads write no change rows');
});

test('change log: the manual-control routes each get a spec; reads and dry runs do not log', () => {
  for (const p of ['/api/pause', '/api/brain-toggle', '/api/pacer', '/api/daily-run', '/api/event-flag', '/api/block-phone', '/api/ipn-replay']) assert.ok(CHANGE_ROUTES[p], p);
  assert.equal(CHANGE_ROUTES['/api/daily-run'].when({ dry: true }, {}), false);
  assert.equal(CHANGE_ROUTES['/api/daily-run'].when({ dry: false }, {}), true);
  assert.equal(CHANGE_ROUTES['/api/event-flag'].when({ token: TOK, flag: 'hold' }, {}), false, 'a read');
  assert.match(CHANGE_ROUTES['/api/event-flag'].summary({ token: TOK, flag: 'hold', on: true }, {}), /השהיית אירוע הופעל · אירוע c1c5fcf5/);
  assert.equal(CHANGE_ROUTES['/api/block-phone'].when({ phone: '0521234567' }, {}), false);
  assert.match(CHANGE_ROUTES['/api/block-phone'].summary({ phone: '0521234567', blocked: true }, {}), /052\*\*\*\*567 נחסם/);
  assert.equal(CHANGE_ROUTES['/api/ipn-replay'].when({ id: 'ipnmiss:1' }, { ok: false }), false);
});

test('change log end to end: POST /api/event-flag hold on → one chg: row of kind hold', async () => {
  const e = env();
  const r = await worker.fetch(new Request('https://go.ishur.io/api/event-flag', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify({ admin_key: 'k', token: TOK, flag: 'hold', on: true, who: 'Richard' }) }), e, ctx);
  assert.equal(r.status, 200);
  const rows = [...e.RATE.m.entries()].filter(([k]) => k.startsWith('chg:')).map(([, v]) => JSON.parse(v));
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'hold');
});
