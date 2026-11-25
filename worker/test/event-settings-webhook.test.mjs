/* 25/11/2026 הגדרות מתקדמות, end to end through the real WhatsApp webhook (worker.fetch), no network:
   a guest confirms, gets the gift line on the confirmation, then the event's questions one by one. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

const N6673 = '1107514695777584';
const TOK = 'c1c5fcf5-0000-4000-8000-0000000000cc';
const PHONE = '972501113333';
const BIT = 'https://www.bitpay.co.il/app/me/ABC';
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const tiers = JSON.stringify({ tier: 'TIER_250', numbers: [{ id: N6673, tier: 'TIER_250' }] });
function kv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, { v: String(v) }]));
  return {
    m, peek: k => (m.has(k) ? m.get(k).v : null),
    get: async k => (m.has(k) ? m.get(k).v : null),
    put: async (k, v, o = {}) => { m.set(k, { v: String(v), meta: o.metadata }); },
    delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name, metadata: m.get(name).meta })), list_complete: true }),
    getWithMetadata: async () => ({ value: null }),
  };
}
let realFetch, sent = [], sheetWrites = [];
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'לקוח'; ev[5] = 'חתונה'; ev[6] = '2099-01-01'; ev[7] = 'כן'; ev[34] = 'שוהם ושי';
  const g = Array(31).fill(''); g[28] = TOK; g[2] = 'G9'; g[3] = 'דנה'; g[4] = '0501113333'; g[15] = '';
  return { events: { values: [ev] }, guests: { values: [g] } };
}
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()), { status: 200 });
    if (u === 'https://hook.test/events') { try { sheetWrites.push(JSON.parse(init.body)); } catch { sheetWrites.push(init.body); } return new Response('{}', { status: 200 }); }
    if (/graph\.facebook\.com\/v21\.0\/\d+\/messages$/.test(u)) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + sent.length }] })); }
    return new Response('{}', { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });

const env0 = (store = {}) => ({ WA_PHONE_ID_GUESTS: N6673, WA_TOKEN_GUESTS: 't', WA_VERIFY: 'v', HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events',
  RATE: kv({ 'wa:cap': tiers, [`gsend:${N6673}:${day}`]: '3', ...store }) });
let n = 0;
async function inbound(env, m) {
  const payload = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: N6673 }, contacts: [{ wa_id: PHONE, profile: { name: 'דנה' } }],
    messages: [{ id: 'wamid.in' + (++n), from: PHONE, ...m }] } }] }] };
  const r = await worker.fetch(new Request('https://go.ishur.io/api/wa-webhook?t=v', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), env, { waitUntil: () => {}, passThroughOnException: () => {} });
  assert.equal(r.status, 200);
}
const toGuest = () => sent.filter(s => s.to === PHONE);
const bodyText = s => (s.text && s.text.body) || (s.interactive && s.interactive.body && s.interactive.body.text) || '';

test('webhook: yes with a count → confirmation carries the gift line → shuttle → food (list) → own question → thanks; a typed "לא" answers the bus', async () => {
  sent = []; sheetWrites = [];
  const env = env0({
    ['giftlinks:' + TOK]: JSON.stringify({ on: true, bit: BIT }),
    ['evsettings:' + TOK]: JSON.stringify({ questions: { shuttle: { on: true, details: 'מבאר שבע ב-18:00' }, food: { on: true }, custom: { on: true, q: 'תצטרכו חניה?' } } }),
  });
  await inbound(env, { type: 'button', button: { text: 'מגיע/ה', payload: 'מגיע/ה' } });
  await inbound(env, { type: 'text', text: { body: '2' } });
  let out = toGuest();
  const conf = out.find(s => /רשמנו 2/.test(bodyText(s)));
  assert.ok(conf, 'the count confirmation went out: ' + JSON.stringify(out.map(bodyText)));
  assert.ok(bodyText(conf).includes('לנוחיותכם אפשר להעניק מתנה ישירות כאן: https://go.ishur.io/gift/' + TOK.slice(0, 8)), 'the gift line rides on the confirmation');
  assert.ok(env.RATE.peek(`gift:${TOK}:${PHONE}`), 'marked once per guest');
  const q1 = out[out.length - 1];
  assert.equal(q1.interactive.type, 'button'); assert.match(bodyText(q1), /מבאר שבע ב-18:00/);
  const writesBefore = sheetWrites.length;
  /* a typed "לא" — the parser alone would read it as "לא מגיע" */
  await inbound(env, { type: 'text', text: { body: 'לא' } });
  assert.equal(sheetWrites.length, writesBefore, 'nothing was written to the guest\'s RSVP');
  out = toGuest();
  assert.equal(out[out.length - 1].interactive.type, 'list', 'next: the food list');
  await inbound(env, { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'fq:food:1', title: 'צמחוני' } } });
  out = toGuest();
  assert.match(bodyText(out[out.length - 1]), /תצטרכו חניה/);
  await inbound(env, { type: 'text', text: { body: 'כן, רכב אחד' } });
  out = toGuest();
  assert.match(bodyText(out[out.length - 1]), /תודה, רשמנו/);
  const rec = JSON.parse(env.RATE.peek(`fqa:${TOK}:G9`));
  assert.equal(rec.shuttle, 'לא'); assert.equal(rec.food, 'צמחוני'); assert.equal(rec.custom, 'כן, רכב אחד'); assert.equal(rec.via, 'whatsapp');
  assert.equal(sheetWrites.length, writesBefore, 'no answer to a question touched the RSVP');
});

test('webhook: "לא נוכל" while the own question is open is a cancellation, not the answer', async () => {
  sent = []; sheetWrites = [];
  const env = env0({ ['evsettings:' + TOK]: JSON.stringify({ questions: { custom: { on: true, q: 'תצטרכו חניה?' } } }) });
  await inbound(env, { type: 'button', button: { text: 'מגיע/ה', payload: 'מגיע/ה' } });
  await inbound(env, { type: 'text', text: { body: '3' } });
  assert.match(bodyText(toGuest()[toGuest().length - 1]), /תצטרכו חניה/);
  const before = sheetWrites.length;
  await inbound(env, { type: 'text', text: { body: 'לא נוכל' } });
  assert.equal(env.RATE.peek(`fqa:${TOK}:G9`), null, 'not stored as the answer');
  assert.ok(sheetWrites.length > before, 'the RSVP flow handled it (a write went to the sheet)');
  assert.match(bodyText(toGuest()[toGuest().length - 1]), /לא תגיעו|תודה שהודעתם|תודה שעדכנתם/);
});

test('webhook: no settings → the old single question (extraq) still runs, and no gift line without links', async () => {
  sent = []; sheetWrites = [];
  const env = env0({ ['extraq:' + TOK]: JSON.stringify({ id: 'bus', q: 'צריכים הסעה?' }) });
  await inbound(env, { type: 'button', button: { text: 'מגיע/ה', payload: 'מגיע/ה' } });
  await inbound(env, { type: 'text', text: { body: '2' } });
  const out = toGuest();
  assert.ok(!out.some(s => /לנוחיותכם/.test(bodyText(s))));
  assert.match(bodyText(out[out.length - 1]), /צריכים הסעה/);
  /* 25/11 fix: a typed "לא" answers the old question too (it used to be read as "לא מגיע") */
  const before = sheetWrites.length;
  await inbound(env, { type: 'text', text: { body: 'לא' } });
  assert.equal(sheetWrites.length, before, 'no RSVP write');
  assert.equal(JSON.parse(env.RATE.peek(`xqa:${TOK}:${PHONE}`)).a, 'לא');
});
