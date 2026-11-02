// node --test worker/test/inbound-leads.test.mjs
// 02/11 audit of the client/lead side (docs/AUDIT-INBOUND-LEADS-2026-11-02.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAppAutoReply, chaseStopReason, lastInboundTs, leadAlertHeader, REPLY_GRACE_MS } from '../inbound.js';
import { touchConversation } from '../whatsapp.js';
import { digitsIl, phoneVariants, findItemByPhone, mondayUpsertLead, mondayMarkWon } from '../monday.js';

function fakeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}

/* ── the WhatsApp Business app's away message (echo of 02/11 15:38:26Z) ── */
const AWAY = 'היי 🙂 הגעתם לאישורי הגעה · ishur.io\nאנחנו עונים בימים א-ה, בין 10:00 ל-17:00,\nנחזור אליכם בהקדם.\nבינתיים אפשר לראות מחירים ולהתחיל אירוע באתר: ishur.io';

test('the app away message is recognised; Richard typing is not', () => {
  assert.equal(isAppAutoReply(AWAY), true);
  assert.equal(isAppAutoReply('היי, בודק'), false);
  assert.equal(isAppAutoReply('היי, הסתדרת?'), false);
  assert.equal(isAppAutoReply(''), false);
  assert.equal(isAppAutoReply('Away!', { WA_APP_AUTOREPLY: '^Away' }), true, 'env override');
  assert.equal(isAppAutoReply(AWAY, { WA_APP_AUTOREPLY: '(' }), true, 'a broken override falls back to the default');
});

/* ── "לא סיימת" must not chase a lead who is already talking to us ── */
/* Maya Cohen's real records from KV, 02/11 */
const MAYA_REC = { name: 'מאיה כהן', source: 'וואטסאפ נכנס', page: 'whatsapp', type: 'whatsapp_in', at: '2026-11-02T10:24:07.953Z', consent: true, seen: 2, types: ['whatsapp_in', 'lead'], t1: '2026-11-02T11:05:54.650Z', t1d: '2026-11-02' };
const MAYA_CONV = { phone: '972507536247', msgs: 3, first_ts: 1793615046939, last_ts: 1793617550296, last_dir: 'out', ch: ['client'] };

test('Maya (wrote first on WhatsApp) stops the chase — she got ishur_lo_siyem at 11:05 and would get _2 tomorrow', () => {
  assert.equal(chaseStopReason({ rec: MAYA_REC, conv: MAYA_CONV, human: null }), 'whatsapp-first');
});

test('a site lead whose inbound landed 1 s BEFORE rec.at counts as answered (the old strict > missed it)', () => {
  const rec = { at: '2026-11-02T10:24:07.953Z', types: ['lead'] };
  const conv = { last_in_ts: Date.parse('2026-11-02T10:24:06.939Z'), last_ts: Date.parse('2026-11-02T10:24:09Z'), last_dir: 'out' };
  assert.equal(chaseStopReason({ rec, conv }), 'answered');
});

test('a site lead who never wrote keeps the chase; an inbound long before the form does not count', () => {
  const rec = { at: '2026-11-02T10:00:00Z', types: ['lead_partial', 'lead'] };
  assert.equal(chaseStopReason({ rec, conv: null }), '');
  const old = { last_in_ts: Date.parse('2026-11-02T10:00:00Z') - REPLY_GRACE_MS - 1000, last_dir: 'in' };
  assert.equal(chaseStopReason({ rec, conv: old }), '');
});

test('a chat a human took (human:/aioff:) stops the chase', () => {
  assert.equal(chaseStopReason({ rec: { at: '2026-11-02T10:00:00Z', types: ['lead'] }, conv: null, human: '{"via":"phone"}' }), 'human');
});

test('lastInboundTs: the new field wins; old records fall back to last_dir', () => {
  assert.equal(lastInboundTs({ last_in_ts: 5, last_ts: 9, last_dir: 'out' }), 5);
  assert.equal(lastInboundTs({ last_ts: 9, last_dir: 'in' }), 9);
  assert.equal(lastInboundTs({ last_ts: 9, last_dir: 'out' }), 0);
  assert.equal(lastInboundTs(null), 0);
});

test('touchConversation keeps the last INBOUND time after a later echo', async () => {
  const kv = fakeKv();
  const env = { RATE: kv };
  await touchConversation(env, '972507536247', { ts: 1000, dir: 'in', text: 'Hello! I filled out your form', ch: 'client' });
  await touchConversation(env, '972507536247', { ts: 3000, dir: 'out', text: 'away', ch: 'client' });
  const c = JSON.parse(kv.store.get('conv:972507536247'));
  assert.equal(c.last_dir, 'out');
  assert.equal(c.last_in_ts, 1000);
  assert.equal(lastInboundTs(c), 1000);
});

test('Slack titles say when the person was already known', () => {
  assert.equal(leadAlertHeader('meta', ''), '🆕 *ליד חדש מטופס מטא*');
  assert.match(leadAlertHeader('meta', 'lead'), /ליד קיים מילא טופס מטא/);
  assert.match(leadAlertHeader('meta', 'client'), /לקוח קיים/);
  assert.match(leadAlertHeader('whatsapp', 'monday'), /כבר היה במאנדיי/);
  assert.equal(leadAlertHeader('whatsapp', ''), '🆕 *ליד חדש מוואטסאפ (נועה 4499)*');
});

/* ── Monday: one item per person, whatever the phone format; never eat notes ── */
test('digitsIl folds every Israeli spelling onto one key', () => {
  for (const s of ['0507536247', '050-753-6247', '+972507536247', '972507536247', '+972 50-753-6247', '+972-50-753-6247', '507536247', '00972507536247', '9720507536247', ' 050 753 6247 '])
    assert.equal(digitsIl(s), '972507536247', s);
});

test('phoneVariants covers the formats Monday shows for manual items', () => {
  const v = phoneVariants('972507536247');
  for (const s of ['0507536247', '972507536247', '+972507536247', '050-753-6247', '+972 50-753-6247', '+972-50-753-6247']) assert.ok(v.includes(s), s);
});

/* a Monday API double: a board of items, records every mutation */
function mondayStub(items) {
  const calls = [];
  const COLS = { 'טלפון': 'phone_mm7g3mjv', 'מייל': 'email_mm7gj1rb', 'כמות': 'numeric_mm7g6kn3', 'סטטוס': 'status', 'טיפול': 'color_mm7g6y7g',
    'אירוע': 'text_ev', 'חבילה': 'text_pl', 'מחיר': 'num_pr', 'שלב': 'text_st', 'כניסות': 'num_n', 'מקור': 'text_src', 'עדכונים': 'text_upd', 'נכנס לראשונה': 'date_first', 'הערות': 'long_notes' };
  const kv = fakeKv();
  kv.store.set('monday:cols:18432553641', JSON.stringify(COLS));
  const asItem = it => ({ id: it.id, name: it.name, column_values: [{ id: COLS['טלפון'], text: it.phone || '' }, { id: COLS['הערות'], text: it.notes || '' }] });
  globalThis.fetch = async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    calls.push({ query, variables });
    let data = {};
    if (query.includes('items_page_by_column_values')) data = { items_page_by_column_values: { items: items.filter(it => variables.v.includes(it.phone)).map(asItem) } };
    else if (query.includes('items_page(limit:500)')) data = { boards: [{ items_page: { cursor: null, items: items.map(asItem) } }] };
    else if (query.includes('change_multiple_column_values')) data = { change_multiple_column_values: { id: variables.i } };
    else if (query.includes('create_item')) data = { create_item: { id: 'NEW1' } };
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { env: { RATE: kv, MONDAY_API_TOKEN: 't' }, calls, COLS };
}

test('a manual item typed "+972-50-753-6247 " (not one of the exact spellings) is found by the scan, not duplicated', async () => {
  const { env, calls } = mondayStub([{ id: 'M1', name: 'מאיה כהן', phone: '+972-50-753-6247 ', notes: 'ריצארד: מתחתנת 9.9, לחזור אליה אחרי 18:00' }]);
  const r = await mondayUpsertLead(env, '972507536247', { name: 'מאיה כהן', types: ['whatsapp_in'], at: '2026-11-02T10:24:07Z', seen: 1, page: 'whatsapp', source: 'וואטסאפ נכנס' });
  assert.equal(r.created, false);
  assert.equal(r.id, 'M1');
  assert.equal(r.matched, 'scan');
  assert.equal(calls.filter(c => c.query.includes('create_item')).length, 0, 'no duplicate item');
});

test('a manual item with the phone only in its NAME is found and gets the phone column filled', async () => {
  const { env, calls, COLS } = mondayStub([{ id: 'M2', name: 'ענת 050-301-4947', phone: '', notes: '' }]);
  const r = await mondayUpsertLead(env, '972503014947', { name: 'Anat', types: ['whatsapp_in'], at: '2026-11-02T08:55:41Z' });
  assert.equal(r.id, 'M2');
  const mut = calls.find(c => c.query.includes('change_multiple_column_values'));
  assert.deepEqual(JSON.parse(mut.variables.v)[COLS['טלפון']], { phone: '0503014947', countryShortName: 'IL' });
});

test('an update never blanks Richard\'s columns and never replaces his notes', async () => {
  const { env, calls, COLS } = mondayStub([{ id: 'M1', name: 'מאיה', phone: '0507536247', notes: 'ריצארד: מתחתנת 9.9' }]);
  await mondayUpsertLead(env, '972507536247', { name: 'מאיה', occasion: '', plan: '', price: '', types: ['whatsapp_in'], at: '2026-11-02T10:24:07Z', seen: 1, source: 'וואטסאפ נכנס', page: 'whatsapp', notes: 'טופס מטא: דיילות 1990' });
  const v = JSON.parse(calls.find(c => c.query.includes('change_multiple_column_values')).variables.v);
  for (const col of ['אירוע', 'חבילה', 'מחיר', 'מקור', 'נכנס לראשונה', 'סטטוס', 'טיפול', 'טלפון']) assert.ok(!(COLS[col] in v), `${col} untouched`);
  assert.equal(v[COLS['הערות']].text, 'ריצארד: מתחתנת 9.9\nטופס מטא: דיילות 1990', 'appended, not replaced');
});

test('the same note twice is not appended twice', async () => {
  const { env, calls, COLS } = mondayStub([{ id: 'M1', name: 'x', phone: '0507536247', notes: 'a\nטופס מטא: דיילות 1990' }]);
  await mondayUpsertLead(env, '972507536247', { types: ['lead'], notes: 'טופס מטא: דיילות 1990', seen: 1 });
  const mut = calls.find(c => c.query.includes('change_multiple_column_values'));
  const v = mut ? JSON.parse(mut.variables.v) : {};
  assert.ok(!(COLS['הערות'] in v));
});

test('a brand-new phone creates exactly one item with status חדש → שלו', async () => {
  const { env, calls, COLS } = mondayStub([{ id: 'M9', name: 'other', phone: '0521111111', notes: '' }]);
  const r = await mondayUpsertLead(env, '972507536247', { name: 'מאיה', types: ['lead'], at: '2026-11-02T10:24:07Z', seen: 1 });
  assert.equal(r.created, true);
  const v = JSON.parse(calls.find(c => c.query.includes('create_item')).variables.v);
  assert.deepEqual(v[COLS['סטטוס']], { label: 'חדש' });
  assert.deepEqual(v[COLS['טיפול']], { label: 'שלו' });
});

test('payment appends to הערות instead of replacing them', async () => {
  const { env, calls, COLS } = mondayStub([{ id: 'M1', name: 'x', phone: '0507536247', notes: 'ריצארד: הבטחתי הנחה של 100' }]);
  const r = await mondayMarkWon(env, '972507536247', 'שילם ₪990 · אסמכתא 123 · 2026-11-02');
  assert.equal(r.ok, true);
  const v = JSON.parse(calls.find(c => c.query.includes('change_multiple_column_values')).variables.v);
  assert.equal(v[COLS['הערות']].text, 'ריצארד: הבטחתי הנחה של 100\nשילם ₪990 · אסמכתא 123 · 2026-11-02');
  assert.deepEqual(v[COLS['סטטוס']], { label: 'סגר' });
});

test('findItemByPhone returns null (no throw) on an empty board', async () => {
  const { env, COLS } = mondayStub([]);
  assert.equal(await findItemByPhone(env, COLS, '972507536247'), null);
});

/* ── wiring in index.js (static checks; index.js is not importable in node) ── */
const SRC = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: the chase asks chaseStopReason, with the human marker', () => {
  const chase = SRC.slice(SRC.indexOf('async function chaseAbandonedLeads'), SRC.indexOf('/* Per-event levers'));
  assert.match(chase, /chaseStopReason\(\{ rec, conv, human \}\)/);
  assert.match(chase, /'human:' \+ phone/);
});
test('index.js: the Monday hook no longer reads .data off mondayGql (which returns data already)', () => {
  assert.ok(!SRC.includes("(((r || {}).data || {}).items || [])[0]"));
  assert.ok(!SRC.includes("(((r || {}).data || {}).users || [])[0]"));
});
test('index.js: an app away-message echo does not set human: and is not shown as Richard', () => {
  const echo = SRC.slice(SRC.indexOf('if (echo) {'), SRC.indexOf("if (msg.id && await seenOnce(env, 'wain:'"));
  assert.match(echo, /const appAuto = isAppAutoReply\(/);
  assert.match(echo, /if \(!appAuto && !await env\.RATE\.get\('human:'/);
});
test('index.js: lead-monday has a read-only find before any write path', () => {
  const h = SRC.slice(SRC.indexOf("url.pathname === '/api/lead-monday'"));
  assert.ok(h.indexOf("b.action === 'find'") > 0 && h.indexOf("b.action === 'find'") < h.indexOf('mondayUpsertLead'));
});
test('index.js: /api/stream reports truncation', () => {
  const h = SRC.slice(SRC.indexOf("url.pathname === '/api/stream'"), SRC.indexOf("url.pathname === '/api/delivery-report'"));
  assert.match(h, /audit\.queryEx\(/);
  assert.match(h, /truncated: qx\.truncated/);
});
