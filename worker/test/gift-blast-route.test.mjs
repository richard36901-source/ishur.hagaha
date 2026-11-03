// node --test worker/test/gift-blast-route.test.mjs — POST /api/gift-blast and GET /gift/<slug> through the real Worker fetch()
// Meta and the sheet are stubbed (globalThis.fetch); nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
const BIT = 'https://www.bitpay.co.il/app/me/ABC', PB = 'https://links.payboxapp.com/XYZ';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const today = ilDay();
const yesterday = ilDay(new Date(Date.now() - 864e5));

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k, o) => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
function snapshot(date) {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'לקוח'; ev[5] = 'חתונה'; ev[6] = date; ev[7] = 'כן'; ev[34] = 'אורי ויצחק';
  const g = (n, rsvp) => { const r = Array(31).fill(''); r[28] = TOK; r[2] = 'G' + n; r[3] = 'אורח ' + n; r[4] = '050000000' + n; r[15] = rsvp; return r; };
  return { events: { values: [ev] }, guests: { values: [g(1, 'מגיע'), g(2, 'לא מגיע'), g(3, ''), g(4, 'מגיע')] } };
}
let realFetch, snapDate = yesterday, sent = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot(snapDate)), { status: 200 });
    if (/message_templates\?name=/.test(u)) { const name = decodeURIComponent(u.match(/name=([^&]+)/)[1]); return new Response(JSON.stringify({ data: [{ name, status: 'APPROVED', category: 'MARKETING' }] })); }
    if (/\/messages$/.test(u)) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + sent.length }] })); }
    return new Response('{}', { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });
const env = (extra = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't',
  RATE: kv({ ['giftlinks:' + TOK]: JSON.stringify({ on: true, bit: BIT, paybox: PB }) }), ...extra });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, body) => worker.fetch(new Request('https://go.ishur.io/api/gift-blast', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify({ admin_key: 'k', token: TOK, ...body }) }), e, ctx).then(r => r.json());

test('refuses on the event day itself (whatever the hour)', async () => {
  snapDate = today;
  const r = await post(env(), {});
  assert.equal(r.ok, false); assert.equal(r.refused, 'event-day');
});

test('dry run (default): per-guest list, confirmed → ishur_toda_matana, declined → ishur_matana, nothing sent', async () => {
  snapDate = yesterday; sent = [];
  const r = await post(env(), { max: 10 });
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format());
  if (r.refused) { assert.ok(['outside-09-21', 'send-window-closed'].includes(r.refused), 'only a clock refusal is acceptable here: ' + r.refused + ' at ' + hour); return; }
  assert.equal(r.ok, true); assert.equal(r.dry, true);
  assert.deepEqual(r.guests.map(g => [g.kind, g.template, g.action]), [['thanks', 'ishur_toda_matana', 'send'], ['declined', 'ishur_matana', 'send'], ['thanks', 'ishur_toda_matana', 'send']]);
  assert.ok(r.guests.every(g => /\*\*\*\*/.test(g.phone)), 'phones are masked');
  assert.equal(sent.length, 0, 'dry sends nothing');
  assert.equal(r.gift_links.page, 'https://go.ishur.io/gift/c1c5fcf5');
});

test('GET /gift/<8 chars> shows the links; unknown slug → 404 page', async () => {
  snapDate = yesterday;
  const r = await worker.fetch(new Request('https://go.ishur.io/gift/c1c5fcf5'), env(), ctx);
  assert.equal(r.status, 200);
  const h = await r.text(); assert.ok(h.includes(BIT) && h.includes(PB) && h.includes('אורי ויצחק'));
  assert.ok(!h.includes(TOK), 'never the full token');
  const n = await worker.fetch(new Request('https://go.ishur.io/gift/deadbeef'), env(), ctx);
  assert.equal(n.status, 404);
});

test('real run (stubbed Meta): sends with the gift button, marks each guest once, second run sends nothing', async () => {
  snapDate = yesterday; sent = [];
  const e = env();
  const r = await post(e, { dry: false, max: 10 });
  if (r.refused) { assert.ok(['outside-09-21', 'send-window-closed'].includes(r.refused)); return; }
  assert.equal(r.counts.sent, 3);
  assert.equal(sent.length, 3);
  for (const b of sent) {
    const btn = b.template.components.find(c => c.type === 'button');
    assert.deepEqual(btn.parameters, [{ type: 'text', text: 'c1c5fcf5' }]);
    assert.ok(['ishur_toda_matana', 'ishur_matana'].includes(b.template.name));
  }
  assert.ok(e.RATE.m.has(`gift:${TOK}:972500000002`));
  assert.ok(e.RATE.m.has(`s3t:${TOK}:972500000001`), 'the day-after thank-you will not repeat');
  sent = [];
  const again = await post(e, { dry: false, max: 10 });
  assert.equal(sent.length, 0);
  assert.ok(again.guests.every(g => g.action === 'skip'));
});

test('variant fallback: when ishur_toda_matana is PENDING but ishur_toda_matana2 is APPROVED, the blast uses the 2 variant', async () => {
  snapDate = yesterday; sent = [];
  const e = env();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const s = String(u);
    if (/message_templates\?name=/.test(s)) {
      const name = decodeURIComponent(s.match(/name=([^&]+)/)[1]);
      const ok = name.endsWith('2');
      return new Response(JSON.stringify({ data: [{ name, status: ok ? 'APPROVED' : 'PENDING', category: ok ? 'UTILITY' : 'MARKETING' }] }));
    }
    return realFetch(u, o);
  };
  try {
    const r = await post(e, { max: 10 });
    if (r.refused) { assert.ok(['outside-09-21', 'send-window-closed'].includes(r.refused)); return; }
    assert.equal(r.ok, true);
    assert.equal(r.templates.thanks, 'ishur_toda_matana2');
    assert.equal(r.templates.declined, 'ishur_matana2');
    assert.ok(r.guests.every(g => g.template.endsWith('2')), JSON.stringify(r.guests));
  } finally { globalThis.fetch = realFetch; }
});
