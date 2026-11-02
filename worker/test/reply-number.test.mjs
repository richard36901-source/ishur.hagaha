// node --test worker/test/reply-number.test.mjs — 02/11: a reply leaves from the guest number the guest wrote to
// (a free-text reply from the other number dies on 131047: no open window with it)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { pickGuestPhone, pinGuestPhone } from '../whatsapp.js';

const N6673 = '1107514695777584', N9799 = '1409632775565601';
const TOK = 'c1c5fcf5-0000-4000-8000-0000000000bb';
const BIT = 'https://www.bitpay.co.il/app/me/ABC', PB = 'https://links.payboxapp.com/XYZ';
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const tiers = JSON.stringify({ tier: 'TIER_250', numbers: [{ id: N6673, tier: 'TIER_250' }, { id: N9799, tier: 'TIER_250' }] });
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
const baseEnv = (store = {}) => ({ WA_PHONE_ID_GUESTS: N6673, WA_PHONE_IDS_GUESTS: N9799, WA_TOKEN_GUESTS: 't', RATE: kv({ 'wa:cap': tiers, [`gsend:${N6673}:${day}`]: '3', [`gsend:${N9799}:${day}`]: '120', ...store }) });

test('reply (free text): the pinned number, even when the other one has fewer sends', async () => {
  const e = baseEnv({ 'gph:972501112222': N9799 });
  assert.equal(await pickGuestPhone(e, { template: false, to: '972501112222' }), N9799);
  assert.equal(await pickGuestPhone(e, { template: false, to: '972509998888' }), N6673, 'no known number → least used');
});

test('reply: an explicit phone_id (the webhook metadata) wins over the stored pin', async () => {
  const e = baseEnv({ 'gph:972501112222': N6673 });
  assert.equal(await pickGuestPhone(e, { template: false, to: '972501112222', pinned: N9799 }), N9799);
});

test('reply: still from the pinned number when the cap is full or that number is held (replies are not capped)', async () => {
  const e = baseEnv({ 'gph:972501112222': N9799, [`gsend:${N9799}:${day}`]: '400', ['wacap:' + N9799]: '1' });
  assert.equal(await pickGuestPhone(e, { template: false, to: '972501112222' }), N9799);
});

test('template: prefers the pinned number while it has room; least-used when it is held; none when no room', async () => {
  const e = baseEnv({ 'gph:972501112222': N9799 });
  assert.equal(await pickGuestPhone(e, { template: true, to: '972501112222' }), N9799);
  const held = baseEnv({ 'gph:972501112222': N9799, ['wacap:' + N9799]: '1' });
  assert.equal(await pickGuestPhone(held, { template: true, to: '972501112222' }), N6673);
  const full = baseEnv({ 'gph:972501112222': N9799, [`gsend:${N6673}:${day}`]: '200', [`gsend:${N9799}:${day}`]: '30' });
  assert.equal(await pickGuestPhone(full, { template: true, to: '972501112222' }), '');
});

test('pinGuestPhone ignores a non-guest number (4499 never becomes a guest pin)', async () => {
  const e = baseEnv();
  await pinGuestPhone(e, '0501112222', '1218978741299669');
  assert.equal(e.RATE.m.get('gph:972501112222'), undefined);
  await pinGuestPhone(e, '0501112222', N9799);
  assert.equal(e.RATE.m.get('gph:972501112222'), N9799);
});

/* end to end through the real webhook: guest presses "לא מגיע/ה" on 9799 */
let realFetch, sent = [];
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'לקוח'; ev[5] = 'חתונה'; ev[6] = '2099-01-01'; ev[7] = 'כן'; ev[34] = 'אורי ויצחק';
  const g = Array(31).fill(''); g[28] = TOK; g[2] = 'G1'; g[3] = 'דנה'; g[4] = '0501112222'; g[15] = '';
  return { events: { values: [ev] }, guests: { values: [g] } };
}
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()), { status: 200 });
    if (u === 'https://hook.test/events') return new Response('{}', { status: 200 });
    if (/graph\.facebook\.com\/v21\.0\/\d+\/messages$/.test(u)) { sent.push({ pid: u.match(/v21\.0\/(\d+)\/messages/)[1], body: JSON.parse(init.body) }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + sent.length }] })); }
    return new Response('{}', { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });

test('webhook: a guest who wrote to 055-308-9799 gets the decline (gift) reply FROM 9799, though 6673 has fewer sends', async () => {
  sent = [];
  const env = { ...baseEnv({ ['giftlinks:' + TOK]: JSON.stringify({ on: true, bit: BIT, paybox: PB }) }), WA_VERIFY: 'v', HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events' };
  const payload = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: N9799 }, contacts: [{ wa_id: '972501112222', profile: { name: 'דנה' } }],
    messages: [{ id: 'wamid.in1', from: '972501112222', type: 'button', button: { text: 'לא מגיע/ה', payload: 'לא מגיע/ה' } }] } }] }] };
  const r = await worker.fetch(new Request('https://go.ishur.io/api/wa-webhook?t=v', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), env, { waitUntil: () => {}, passThroughOnException: () => {} });
  assert.equal(r.status, 200);
  const replies = sent.filter(s => s.body.type === 'text' && s.body.to === '972501112222');
  assert.ok(replies.length >= 1, 'a reply went out: ' + JSON.stringify(sent.map(s => s.body.type)));
  for (const s of replies) assert.equal(s.pid, N9799, 'reply must leave from the number the guest wrote to');
  assert.ok(replies.some(s => s.body.text.body.includes(BIT) && s.body.text.body.includes(PB)), 'the decline reply carries the gift links');
  assert.equal(env.RATE.m.get('gph:972501112222'), N9799, 'the number is remembered for later replies and templates');
});
