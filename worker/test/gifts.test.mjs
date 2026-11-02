// node --test worker/test/gifts.test.mjs — 02/11 gift links (Bit / PayBox)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { giftActive, declineGiftText, eventDayGiftSlot, eventHasSeating, giftVariantName, giftButtonComponent, planGiftBlast, giftPageHtml, giftKey, cleanLink } from '../gifts.js';
import { sayDeclined } from '../index.js';

const BIT = 'https://www.bitpay.co.il/app/me/ABC';
const PB = 'https://links.payboxapp.com/XYZ';
const TOK = 'c1c5fcf5-0000-4000-8000-000000000001';
function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; }

test('links: only when on AND at least one real Bit/PayBox link', () => {
  assert.equal(giftActive({ on: true, bit: BIT, paybox: '' }), true);
  assert.equal(giftActive({ on: false, bit: BIT, paybox: PB }), false);
  assert.equal(giftActive({ on: true, bit: '', paybox: '' }), false);
  assert.equal(giftActive({ on: true, bit: 'https://evil.example/x' }), false);
  assert.equal(giftActive(null), false);
  assert.equal(cleanLink('http://paybox.co.il/a'), 'https://paybox.co.il/a');
});

test('decline text: plural "תרצו", both links on their own lines, no "הנחה"', () => {
  const t = declineGiftText({ on: true, bit: BIT, paybox: PB });
  assert.equal(t, `תודה שעדכנתם 🙏 אם תרצו לתת מתנה לבעלי השמחה, אפשר כאן:\nביט: ${BIT}\nפייבוקס: ${PB}`);
  assert.ok(!t.includes('הנחה'));
  assert.equal(declineGiftText({ on: true, bit: '', paybox: PB }), `תודה שעדכנתם 🙏 אם תרצו לתת מתנה לבעלי השמחה, אפשר כאן:\nפייבוקס: ${PB}`);
  assert.equal(declineGiftText({ on: false, bit: BIT }), '');
});

test('event day: NEVER both gift lines — seating → table only, no seating → event-day only, off → none', () => {
  for (const giftOn of [true, false]) for (const hasSeating of [true, false]) {
    const slot = eventDayGiftSlot({ giftOn, hasSeating });
    const onTable = slot === 'table', onEventDay = slot === 'eventday';
    assert.ok(!(onTable && onEventDay), 'never both');
    if (!giftOn) assert.equal(slot, null);
    else assert.equal(slot, hasSeating ? 'table' : 'eventday');
  }
});

test('index.js wiring: the table stage asks for slot "table", the event-day blast for "eventday" — the same function decides both', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const calls = src.split('\n').filter(l => /eventDayGiftSlot\(/.test(l));
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.ok(calls.some(l => /=== 'table'/.test(l)) && calls.some(l => /=== 'eventday'/.test(l)));
  assert.ok(calls.every(l => /eventHasSeating\(/.test(l)), 'both sides read seating the same way');
});

test('seating = a confirmed guest of THIS event with a table', () => {
  const g = (tok, rsvp, table) => { const r = []; r[28] = tok; r[15] = rsvp; r[30] = table; return r; };
  assert.equal(eventHasSeating([g(TOK, 'מגיע', '12')], TOK), true);
  assert.equal(eventHasSeating([g(TOK, 'לא מגיע', '12'), g('other', 'מגיע', '3')], TOK), false);
  assert.equal(eventHasSeating([g(TOK, 'מגיע', '')], TOK), false);
});

test('gift variants and the URL-button suffix (8 chars of the token, never the full token)', () => {
  assert.equal(giftVariantName('ishur_shulchan'), 'ishur_shulchan_matana');
  assert.equal(giftVariantName('ishur_shulchan_f'), 'ishur_shulchan_matana');
  assert.equal(giftVariantName('ishur_yom_haerua'), 'ishur_yom_haerua_matana');
  assert.equal(giftVariantName('ishur_c_abc_1'), '');
  assert.deepEqual(giftButtonComponent(TOK), { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'c1c5fcf5' }] });
});

test('template files: valid JSON, URL button on go.ishur.io, body never starts/ends with a variable, no newline in examples', () => {
  for (const n of ['ishur_shulchan_matana', 'ishur_yom_haerua_matana', 'ishur_toda_matana', 'ishur_matana']) {
    const t = JSON.parse(readFileSync(new URL(`../templates/${n}.json`, import.meta.url), 'utf8'));
    assert.equal(t.payload.name, n);
    const body = t.payload.components.find(c => c.type === 'BODY');
    assert.ok(!/^\s*\{\{/.test(body.text) && !/\}\}\s*$/.test(body.text), n + ': variable at start/end is rejected by Meta');
    assert.ok(!/\n\n\n/.test(body.text));
    const vars = (body.text.match(/\{\{\d+\}\}/g) || []).length;
    assert.equal(body.example.body_text[0].length, vars, n + ': one example per variable');
    for (const ex of body.example.body_text[0]) assert.ok(!/[\n\t]/.test(ex));
    const btn = t.payload.components.find(c => c.type === 'BUTTONS').buttons[0];
    assert.equal(btn.url, 'https://go.ishur.io/gift/{{1}}');
    assert.ok(btn.text.length <= 25);
    assert.ok(!body.text.includes('הנחה'));
  }
});

const base = (o = {}) => ({ today: '2026-11-03', eventDate: '2026-11-02', hour: 11, windowOpen: true, gl: { on: true, bit: BIT, paybox: PB }, room: 500, max: 100,
  templates: { thanks: 'ishur_toda_matana', declined: 'ishur_matana' },
  guests: [
    { phone: '972500000001', name: 'א', rsvp: 'מגיע' }, { phone: '972500000002', name: 'ב', rsvp: 'לא מגיע' },
    { phone: '972500000003', name: 'ג', rsvp: '' }, { phone: '972500000004', name: 'ד', rsvp: 'מתלבט' },
    { phone: '972500000001', name: 'א-כפול', rsvp: 'מגיע' }, { phone: '972500000005', name: 'ה', rsvp: 'לא מגיע' },
  ], ...o });

test('gift blast: confirmed → thank-you+gift, declined → gift, nobody else, phones deduped', () => {
  const r = planGiftBlast(base());
  assert.equal(r.refuse, false);
  assert.deepEqual(r.list.map(x => [x.phone.slice(-1), x.kind, x.template, x.action]), [
    ['1', 'thanks', 'ishur_toda_matana', 'send'], ['2', 'declined', 'ishur_matana', 'send'], ['5', 'declined', 'ishur_matana', 'send']]);
  assert.deepEqual(r.counts, { thanks: 1, declined: 2, send: 3, hold: 0, skip: 0 });
});

test('gift blast refuses: event day, before, >7 days after, 21:00+, before 09:00, window closed, links off', () => {
  assert.equal(planGiftBlast(base({ today: '2026-11-02' })).why, 'event-day');
  assert.equal(planGiftBlast(base({ today: '2026-11-01' })).why, 'before-event');
  assert.equal(planGiftBlast(base({ today: '2026-11-12' })).why, 'too-late');
  assert.equal(planGiftBlast(base({ hour: 21 })).why, 'outside-09-21');
  assert.equal(planGiftBlast(base({ hour: 8 })).why, 'outside-09-21');
  assert.equal(planGiftBlast(base({ windowOpen: false })).why, 'send-window-closed');
  assert.equal(planGiftBlast(base({ gl: { on: false, bit: BIT } })).why, 'gift-links-off');
});

test('gift blast: never more than the cap room (held: cap) or max; marks and opt-outs skip', () => {
  const r = planGiftBlast(base({ room: 1 }));
  assert.deepEqual(r.list.map(x => x.action + ':' + x.reason), ['send:', 'hold:held: cap', 'hold:held: cap']);
  const m = planGiftBlast(base({ max: 2 }));
  assert.deepEqual(m.list.map(x => x.action + ':' + x.reason), ['send:', 'send:', 'hold:max-reached']);
  const s = planGiftBlast(base({ sentMarks: new Set(['972500000002']), blocked: new Set(['972500000005']) }));
  assert.deepEqual(s.list.map(x => x.action + ':' + x.reason), ['send:', 'skip:already-got-gift-message', 'skip:optout-or-wrong-number']);
  const t = planGiftBlast(base({ templates: { thanks: '', declined: 'ishur_matana' } }));
  assert.equal(t.list[0].reason, 'template-not-approved');
});

test('decline reply: gift links exactly once per guest, plain thank-you otherwise', async () => {
  const env = { RATE: kv({ ['giftlinks:' + TOK]: JSON.stringify({ on: true, bit: BIT, paybox: PB }) }) };
  const said = []; const say = async t => { said.push(t); return { ok: true }; };
  const guest = { token: TOK, guest_id: 'G1' };
  await sayDeclined(env, guest, '0500000009', say, 'חבל שלא תהיו');
  await sayDeclined(env, guest, '0500000009', say, 'חבל שלא תהיו');
  assert.ok(said[0].includes(BIT) && said[0].includes(PB));
  assert.equal(said[1], 'חבל שלא תהיו');
  assert.ok(env.RATE.m.has(giftKey(TOK, '972500000009')));
});

test('decline reply: links off / empty → plain text, no flag; failed send → no flag (retry next time)', async () => {
  const said = []; const say = async t => { said.push(t); return { ok: true }; };
  const off = { RATE: kv({ ['giftlinks:' + TOK]: JSON.stringify({ on: false, bit: BIT }) }) };
  await sayDeclined(off, { token: TOK }, '0500000009', say, 'plain');
  assert.equal(said.pop(), 'plain'); assert.equal(off.RATE.m.size, 1);
  const none = { RATE: kv({}) };
  await sayDeclined(none, { token: TOK }, '0500000009', say, 'plain');
  assert.equal(said.pop(), 'plain');
  const fail = { RATE: kv({ ['giftlinks:' + TOK]: JSON.stringify({ on: true, paybox: PB }) }) };
  await sayDeclined(fail, { token: TOK }, '0500000009', async () => ({ ok: false }), 'plain');
  assert.ok(!fail.RATE.m.has(giftKey(TOK, '972500000009')));
});

test('gift page: only the links that exist, escaped; empty state when off', () => {
  const h = giftPageHtml({ on: true, bit: BIT, paybox: '' }, 'הדר <ויצחק>');
  assert.ok(h.includes(BIT) && !h.includes('פייבוקס</a>') && h.includes('&lt;ויצחק&gt;'));
  assert.ok(giftPageHtml({ on: false, bit: BIT }, 'x').includes('אין כרגע קישור'));
});

test('lint: the table message never gets a definite article (template says ב{{2}})', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const i = src.indexOf("'ishur_shulchan', [gname, evName, table]");
  const before = src.slice(Math.max(0, i - 4000), i);
  const line = before.split('\n').filter(l => /const evName = (?:guestEventName|eventDisplayName)\(/.test(l))   /* integration 02/11: audit P0 swapped in guestEventName (no client-name fallback) */.pop();
  assert.ok(line && /article: false/.test(line), line);
});
