// node --test worker/test/leads-sync.test.mjs — the leads screen ⇄ the monday leads board (leads-sync.js):
// the field ↔ column mapping both ways, the webhook (challenge, column change, create, delete, unknown event),
// the conflict rule, the "changed since" read, the reconcile, and an edit that monday refuses.
// monday is a fake in this file; nothing leaves the machine and nothing here can message or call anyone.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { MCOL, WRITABLE, BOARD, HOLD_MS, itemToLead, validateEdit, fieldsToColumns, applyFields, editConflicts, mergeLead, sameLead, labelsFromColumns, reconcileLeads, jwtOk, leadId, itemIdOf } from '../leads-sync.js';
import { dialTicked, COL as NOA_COL, STATUS_INDEX } from '../noa.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init)), meta = new Map();
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v, o) => { m.set(k, String(v)); if (o && o.metadata) meta.set(k, o.metadata); }, delete: async k => { m.delete(k); meta.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: meta.get(name) })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}

/* ── a small monday: items with column values, the three reads and the one mutation the module uses ── */
const SETTINGS = { [MCOL.status]: { labels: { 0: 'חדש', 1: 'סגר', 2: 'לא ענה', 3: 'לא רלוונטי', 4: 'שיחה חוזרת', 5: 'נשלח פרטים', 6: 'סגר במקום אחר' } }, [MCOL.owner]: { labels: { 0: 'ריצארד', 1: 'נועה', 5: 'שלו' } }, [MCOL.ad]: { labels: [{ id: 1, name: 'AS04' }, { id: 2, name: 'AS05' }] } };
let M, calls, realFetch;
function item(id, name, o = {}) {
  return { id: String(id), name, state: 'active', created_at: '2026-11-10T08:00:00Z', updated_at: o.updated_at || '2026-11-16T08:00:00Z', group: { id: 'topics', title: o.group || 'פעילים' }, board: { id: o.board || BOARD },
    cols: { [MCOL.status]: o.status ?? 'חדש', [MCOL.owner]: o.owner ?? 'שלו', [MCOL.phone]: o.phone ?? '050-123-4567', [MCOL.guests]: o.guests ?? '200', [MCOL.event]: o.event ?? 'חתונה', [MCOL.package]: o.package ?? 'עד 300',
      [MCOL.source]: o.source ?? 'fb / paid', [MCOL.price]: o.price ?? '1790', [MCOL.dial]: o.dial ? 'v' : '', [MCOL.ad]: o.ad ?? 'AS04', [MCOL.notes]: o.notes ?? '', [MCOL.next]: o.next ?? '', [MCOL.updates]: o.updates ?? '' } };
}
const gqlItem = it => ({ id: it.id, name: it.name, state: it.state, created_at: it.created_at, updated_at: it.updated_at, group: it.group, board: it.board,
  column_values: Object.entries(it.cols).map(([id, text]) => ({ id, text, value: id === MCOL.dial ? JSON.stringify(text ? { checked: 'true' } : {}) : JSON.stringify(text), ...(id === MCOL.status || id === MCOL.owner ? { label: text, index: 0 } : {}) })) });
function mondayAnswer(q, v) {
  if (M.down) throw new Error('down');
  if (/create_webhook|create_item|create_column|delete_item|archive_item|create_update/.test(q)) throw new Error('the module must never call this: ' + q.slice(0, 60));
  if (/change_multiple_column_values/.test(q)) {
    if (M.rejectWrites) return { errors: [{ message: 'ColumnValueException: label not found' }] };
    const it = M.items.get(String(v.i)); const cv = JSON.parse(v.v);
    for (const [c, val] of Object.entries(cv)) it.cols[c] = val == null ? '' : typeof val === 'string' ? val : val.label ?? val.date ?? val.text ?? '';
    it.updated_at = new Date(Date.parse(it.updated_at) + 1000).toISOString().replace('.000Z', 'Z');
    return { data: { change_multiple_column_values: { id: it.id, updated_at: it.updated_at } } };
  }
  if (/settings_str/.test(q)) return { data: { boards: [{ columns: Object.entries(SETTINGS).map(([id, s]) => ({ id, settings_str: JSON.stringify(s) })) }] } };
  if (/items_page/.test(q)) return { data: { boards: [{ items_page: { cursor: null, items: [...M.items.values()].filter(i => i.state === 'active').map(gqlItem) } }] } };
  if (/items\(ids/.test(q)) return { data: { items: (v.i || []).map(i => M.items.get(String(i))).filter(Boolean).map(gqlItem) } };
  throw new Error('unexpected monday query: ' + q.slice(0, 80));
}
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), body = init.body ? String(init.body) : '';
    calls.push({ u, body });
    if (u === 'https://api.monday.com/v2') {
      const { query, variables } = JSON.parse(body);
      try { return new Response(JSON.stringify(mondayAnswer(query, variables || {}))); } catch (e) { if (e.message === 'down') return new Response('{}', { status: 502 }); throw e; }
    }
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  calls = [];
  M = { items: new Map([item(101, 'דנה לוי'), item(102, 'יוסי כהן', { phone: '0522222222', status: 'לא ענה', owner: 'שלו', dial: true, price: '' }), item(103, 'מיכל', { phone: '', status: 'שיחה חוזרת' })].map(i => [i.id, i])), down: false, rejectWrites: false };
});
const env = (init = {}, extra = {}) => ({ ADMIN_KEY: 'k', MONDAY_API_TOKEN: 'tok', MONDAY_WEBHOOK_SECRET: 'whsecret', RATE: kv(init), ...extra });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { headers: key ? { 'X-Admin-Key': key } : {} }), e, ctx);
const post = (e, path, body, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: key, ...body }) }), e, ctx);
const hook = (e, body, k = 'whsecret', headers = {}) => worker.fetch(new Request('https://go.ishur.io/webhooks/monday-leads' + (k ? '?k=' + k : ''), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), e, ctx);
const mutations = () => calls.filter(c => c.u === 'https://api.monday.com/v2' && /mutation/.test(JSON.parse(c.body).query)).map(c => JSON.parse(c.body));
const board = async e => (await (await get(e, '/api/crm/leads/board')).json());
const row = (b, id) => b.items.find(l => l.id === id);
const sleep = n => new Promise(r => setTimeout(r, n));

/* ── the mapping ────────────────────────────────────────────────────────── */
test('monday → fields: every column of the board lands on its field', () => {
  const l = itemToLead(gqlItem(item(101, 'דנה לוי', { dial: true, notes: 'דיברנו', next: '2026-11-20', updates: 'נועה · 15.11 · לא ענה', price: '1,790' })));
  assert.deepEqual({ id: l.id, item_id: l.item_id, name: l.name, phone: l.phone, event: l.event, guests: l.guests, package: l.package, price: l.price, source: l.source, ad: l.ad, status: l.status, owner: l.owner, dial: l.dial, notes: l.notes, next: l.next, touch_text: l.touch_text, group: l.group, m_at: l.m_at },
    { id: 'm101', item_id: '101', name: 'דנה לוי', phone: '972501234567', event: 'חתונה', guests: 200, package: 'עד 300', price: 1790, source: 'fb / paid', ad: 'AS04', status: 'חדש', owner: 'שלו', dial: true, notes: 'דיברנו', next: '2026-11-20', touch_text: 'נועה · 15.11 · לא ענה', group: 'פעילים', m_at: '2026-11-16T08:00:00Z' });
  const empty = itemToLead({ id: 7, name: 'x', column_values: [] });
  assert.deepEqual([empty.phone, empty.price, empty.guests, empty.status, empty.dial, empty.next], ['', null, null, '', false, '']);
  assert.equal(itemToLead(gqlItem(item(1, 'a', { phone: '+972-52-222-2222' }))).phone, '972522222222');
  assert.equal(itemToLead(gqlItem(item(1, 'a', { phone: '12345' }))).phone, '', 'not an Israeli number: kept as text only');
  assert.equal(leadId(101), 'm101'); assert.equal(itemIdOf('m101'), '101'); assert.equal(itemIdOf('L972501234567'), '');
  assert.equal(dialTicked(gqlItem(item(1, 'a', { dial: true }))), true, 'the same tick noa.js reads');
  assert.equal(MCOL.dial, NOA_COL.dial); assert.equal(MCOL.status, NOA_COL.status); assert.equal(MCOL.owner, NOA_COL.owner); assert.equal(MCOL.next, NOA_COL.callback);
  assert.deepEqual(labelsFromColumns(Object.entries(SETTINGS).map(([id, s]) => ({ id, settings_str: JSON.stringify(s) }))).owner, ['ריצארד', 'נועה', 'שלו']);
});

test('fields → monday: the column values of an edit, clearing included; only the writable columns', () => {
  assert.deepEqual(fieldsToColumns({ status: 'סגר', owner: 'נועה', price: 1790, next: '2026-11-20' }),
    { [MCOL.status]: { label: 'סגר' }, [MCOL.owner]: { label: 'נועה' }, [MCOL.price]: '1790', [MCOL.next]: { date: '2026-11-20' } });
  assert.deepEqual(fieldsToColumns({ owner: '', price: null, next: '' }), { [MCOL.owner]: null, [MCOL.price]: '', [MCOL.next]: null });
  assert.deepEqual(fieldsToColumns({ note: 'חוזרת מחר' }, { notes: 'ישן' }, { stamp: '16.11' }), { [MCOL.notes]: { text: 'ישן\n16.11 · חוזרת מחר' } });
  assert.deepEqual(fieldsToColumns({ note: 'ראשונה' }, { notes: '' }), { [MCOL.notes]: { text: 'ראשונה' } });
  assert.ok(!Object.values(WRITABLE).includes(MCOL.dial), '"נועה תחייג" is never writable from the screen');
  assert.deepEqual(Object.values(WRITABLE).sort(), [MCOL.status, MCOL.owner, MCOL.price, MCOL.next, MCOL.notes].sort());
  /* there and back: what was written reads as the same fields */
  const it = item(5, 'a'); const cv = fieldsToColumns({ status: 'סגר', owner: 'נועה', price: 950, next: '2026-12-01' });
  for (const [c, v] of Object.entries(cv)) it.cols[c] = typeof v === 'string' ? v : v.label ?? v.date;
  const back = itemToLead(gqlItem(it));
  assert.deepEqual([back.status, back.owner, back.price, back.next], ['סגר', 'נועה', 950, '2026-12-01']);
  assert.deepEqual(applyFields({ status: 'חדש', notes: 'א', price: 1 }, { status: 'סגר', note: 'ב' }, { stamp: '16.11' }), { status: 'סגר', notes: 'א\n16.11 · ב', price: 1 });
});

test('validateEdit: only status / owner / price / next / note, each checked', () => {
  assert.deepEqual(validateEdit({ status: 'סגר', owner: '', price: '1,200', next: '', note: '  היי   שם ' }).fields, { status: 'סגר', owner: '', price: 1200, next: '', note: 'היי שם' });
  assert.equal(validateEdit({ status: 'won' }).error, 'bad-status');
  assert.equal(validateEdit({ status: '' }).error, 'bad-status', 'a status is never cleared from the screen');
  assert.equal(validateEdit({ owner: 'מישהו' }).error, 'bad-owner');
  assert.equal(validateEdit({ price: 'abc' }).error, 'bad-price'); assert.equal(validateEdit({ price: -5 }).error, 'bad-price');
  assert.equal(validateEdit({ next: '20/11' }).error, 'bad-date'); assert.equal(validateEdit({ note: '  ' }).error, 'empty-note');
  assert.equal(validateEdit({}).error, 'nothing-to-update');
  assert.deepEqual(validateEdit({ dial: true }), { error: 'field-not-editable', field: 'dial' });
  assert.equal(validateEdit({ name: 'x' }).error, 'field-not-editable'); assert.equal(validateEdit({ phone: '050' }).error, 'field-not-editable');
  assert.equal(validateEdit({ status: 'חדש מאוד' }, { status: ['חדש מאוד'] }).fields.status, 'חדש מאוד', 'the labels the board has today win over the built-in list');
  assert.equal(validateEdit({ price: '' }).fields.price, null);
});

/* ── the conflict rule ──────────────────────────────────────────────────── */
test('conflict rule (pure): same field changed on both sides is refused; different fields and notes never conflict', () => {
  const cur = { status: 'לא ענה', owner: 'שלו', price: 1790, next: '' };
  assert.deepEqual(editConflicts(cur, { status: 'סגר' }, { status: 'חדש' }), ['status'], 'the screen saw חדש, monday says לא ענה, the edit wants סגר');
  assert.deepEqual(editConflicts(cur, { status: 'סגר' }, { status: 'לא ענה' }), [], 'monday still holds what the screen saw');
  assert.deepEqual(editConflicts(cur, { status: 'לא ענה' }, { status: 'חדש' }), [], 'both sides chose the same value');
  assert.deepEqual(editConflicts(cur, { price: 2000 }, { price: 1790, status: 'חדש' }), [], 'status moved in monday, the edit is about the price');
  assert.deepEqual(editConflicts(cur, { price: 2000, owner: 'נועה' }, { price: 990, owner: 'ריצארד' }), ['owner', 'price']);
  assert.deepEqual(editConflicts({ ...cur, price: null }, { price: 500 }, { price: '' }), []);
  assert.deepEqual(editConflicts(cur, { note: 'x' }, { note: 'y' }), []);
  assert.deepEqual(editConflicts(cur, { status: 'סגר' }, undefined), [], 'no base sent: nothing to compare, monday decides');
});

test('conflict rule (pure): of two reads the later monday updated_at wins; a field just written is held against a read from before the write', () => {
  const a = { id: 'm1', status: 'חדש', price: 1, m_at: '2026-11-16T08:00:00Z' }, b = { id: 'm1', status: 'סגר', price: 1, m_at: '2026-11-16T08:05:00Z' };
  assert.equal(mergeLead(a, b).status, 'סגר'); assert.equal(mergeLead(b, a).status, 'סגר', 'a stale read never overwrites a newer one');
  assert.equal(mergeLead(null, a), a); assert.equal(mergeLead(a, null), a);
  const now = Date.parse('2026-11-16T09:00:00Z');
  const floor = Date.parse(a.m_at), ours = { ...a, status: 'סגר', hold: { at: now, floor, f: { status: 'סגר' } } };
  const stale = { ...a, price: 5 };   /* read before our write landed: monday's updated_at has not moved */
  const m1 = mergeLead(ours, stale, now + 5000);
  assert.equal(m1.status, 'סגר', 'our accepted write does not go back'); assert.equal(m1.price, 5); assert.ok(m1.hold);
  const later = { ...a, status: 'לא רלוונטי', m_at: '2026-11-16T09:00:30Z' };   /* monday moved on after our write: it is the truth */
  const m2 = mergeLead(ours, later, now + 40000);
  assert.equal(m2.status, 'לא רלוונטי'); assert.equal(m2.hold, undefined);
  assert.equal(mergeLead(ours, stale, now + HOLD_MS + 1).status, 'חדש', 'the hold ends; the reconcile has the last word');
  assert.ok(sameLead({ ...a, hold: 1, rev: 5 }, { ...a, m_at: 'x' }), 'bookkeeping fields are not a change'); assert.ok(!sameLead(a, b));
  assert.ok(sameLead({ price: null, next: '' }, { price: '', next: null }));
});

/* ── the routes ─────────────────────────────────────────────────────────── */
test('GET /api/crm/leads/board: admin only; the first call reads the board and answers every item with labels and a cursor', async () => {
  const e = env();
  assert.equal((await get(e, '/api/crm/leads/board', '')).status, 403);
  assert.equal((await get(e, '/api/crm/leads/changes?since=1', 'bad')).status, 403);
  assert.equal((await post(e, '/api/crm/leads/m101', { fields: { status: 'סגר' } }, 'bad')).status, 403);
  const b = await board(e);
  assert.equal(b.ok, true); assert.equal(b.monday, 'ok'); assert.equal(b.items.length, 3);
  assert.ok(b.statuses.includes('סגר במקום אחר')); assert.deepEqual(b.owners, ['ריצארד', 'נועה', 'שלו']); assert.ok(b.cursor > 0 && b.synced_at);
  const l = row(b, 'm102');
  assert.deepEqual([l.name, l.phone, l.status, l.dial, l.price, l.touch_at], ['יוסי כהן', '972522222222', 'לא ענה', true, null, '2026-11-16T08:00:00Z']);
  assert.equal(row(b, 'm103').phone, '', 'an item without a phone is on the list too');
  assert.equal(mutations().length, 0, 'reading the board writes nothing to monday');
  /* the old list route and its shape are untouched */
  const old = await (await get(e, '/api/crm/leads')).json();
  assert.ok(old.ok && Array.isArray(old.items) && old.statuses.length === 6);
  /* no token: an honest empty answer, not an error page */
  const b2 = await board(env({}, { MONDAY_API_TOKEN: '' }));
  assert.deepEqual([b2.ok, b2.monday, b2.items.length], [true, 'no-token', 0]);
});

test('POST /api/crm/leads/m<id>: an inline edit goes to monday at once as change_multiple_column_values with only the changed columns', async () => {
  const e = env(); await board(e); calls = [];
  const r = await post(e, '/api/crm/leads/m101', { fields: { status: 'נשלח פרטים', price: 1990 }, base: { status: 'חדש', price: 1790 } });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true);
  assert.deepEqual([j.lead.status, j.lead.price, j.lead.owner], ['נשלח פרטים', 1990, 'שלו']); assert.equal(j.lead.hold, undefined); assert.ok(j.saved_at);
  const mu = mutations();
  assert.equal(mu.length, 1); assert.match(mu[0].query, /change_multiple_column_values/);
  assert.deepEqual([mu[0].variables.b, mu[0].variables.i], [BOARD, '101']);
  assert.deepEqual(JSON.parse(mu[0].variables.v), { [MCOL.status]: { label: 'נשלח פרטים' }, [MCOL.price]: '1990' });
  assert.equal(M.items.get('101').cols[MCOL.status], 'נשלח פרטים');
  /* the list and the changes read both show it without waiting for a webhook */
  assert.equal(row(await board(e), 'm101').status, 'נשלח פרטים');
  /* a note is appended to הערות, never replaces it, and lands on the local timeline */
  M.items.get('101').cols[MCOL.notes] = 'שלו: לחזור בערב';
  const n = await (await post(e, '/api/crm/leads/m101', { fields: { note: 'ביקשה הצעה' } })).json();
  assert.equal(n.ok, true); assert.match(n.lead.notes, /^שלו: לחזור בערב\n\d\d\.\d\d · ביקשה הצעה$/);
  assert.match(M.items.get('101').cols[MCOL.notes], /^שלו: לחזור בערב\n/);
  const det = await (await get(e, '/api/crm/leads/m101')).json();
  assert.equal(det.lead.id, 'm101'); assert.deepEqual(det.notes.map(x => x.text), ['ביקשה הצעה']); assert.match(det.activities[0].text, /סטטוס: חדש → נשלח פרטים/);
  /* clearing the owner sends null (monday's way to empty a status column) */
  await post(e, '/api/crm/leads/m101', { fields: { owner: '' } });
  assert.deepEqual(JSON.parse(mutations().pop().variables.v), { [MCOL.owner]: null });
  assert.equal((await get(e, '/api/crm/leads/m999')).status, 404);
});

test('an edit that monday refuses reports failure and nothing is marked saved', async () => {
  const e = env(); const b0 = await board(e);
  M.rejectWrites = true;
  let r = await post(e, '/api/crm/leads/m101', { fields: { status: 'סגר' }, base: { status: 'חדש' } }), j = await r.json();
  assert.equal(r.status, 502); assert.deepEqual([j.ok, j.error], [false, 'monday-failed']); assert.match(j.why, /label not found/); assert.equal(j.lead, undefined); assert.equal(j.saved_at, undefined);
  assert.equal(row(await board(e), 'm101').status, 'חדש', 'our copy did not move');
  assert.equal((await (await get(e, '/api/crm/leads/changes?since=' + b0.cursor)).json()).items.length, 0, 'and nobody is told it changed');
  M.rejectWrites = false; M.down = true;
  r = await post(e, '/api/crm/leads/m101', { fields: { price: 5 } }); j = await r.json();
  assert.equal(r.status, 502); assert.equal(j.ok, false);
  M.down = false;
  /* the other ways an edit cannot reach monday are failures too, never a quiet ok */
  r = await post(env({}, { MONDAY_API_TOKEN: '' }), '/api/crm/leads/m101', { fields: { status: 'סגר' } }); assert.equal(r.status, 503); assert.equal((await r.json()).error, 'no-token');
  r = await post(env({}, { CRM_MONDAY_SYNC: 'off' }), '/api/crm/leads/m101', { fields: { status: 'סגר' } }); assert.equal(r.status, 503); assert.equal((await r.json()).error, 'sync-off');
  r = await post(e, '/api/crm/leads/m101', { fields: { status: 'won' } }); assert.equal(r.status, 400);
  r = await post(e, '/api/crm/leads/m101', { fields: { dial: true } }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'field-not-editable');
  M.items.get('103').state = 'archived';
  r = await post(e, '/api/crm/leads/m103', { fields: { status: 'סגר' } }); assert.equal(r.status, 404); assert.equal((await r.json()).error, 'gone');
  assert.equal(mutations().length, 1, 'only the first, refused attempt ever reached a mutation');
  assert.equal(M.items.get('101').cols[MCOL.status], 'חדש');
});

test('both sides changed the same field: the edit is refused with 409, monday is not written, the screen gets monday\'s value', async () => {
  const e = env(); await board(e); calls = [];
  /* Shalev moves the lead in monday; the webhook has not arrived; the screen still shows חדש */
  M.items.get('101').cols[MCOL.status] = 'לא ענה'; M.items.get('101').updated_at = '2026-11-16T09:00:00Z';
  const r = await post(e, '/api/crm/leads/m101', { fields: { status: 'סגר' }, base: { status: 'חדש' } }), j = await r.json();
  assert.equal(r.status, 409); assert.deepEqual([j.ok, j.error, j.fields, j.lead.status], [false, 'conflict', ['status'], 'לא ענה']);
  assert.equal(mutations().length, 0); assert.equal(M.items.get('101').cols[MCOL.status], 'לא ענה');
  assert.equal(row(await board(e), 'm101').status, 'לא ענה', 'the mirror caught up from the same read');
  /* a different field on the same lead goes through, and monday's status stays */
  const ok = await (await post(e, '/api/crm/leads/m101', { fields: { price: 2100 }, base: { price: 1790 } })).json();
  assert.deepEqual([ok.ok, ok.lead.price, ok.lead.status], [true, 2100, 'לא ענה']);
  assert.deepEqual(JSON.parse(mutations()[0].variables.v), { [MCOL.price]: '2100' });
});

/* ── the webhook ────────────────────────────────────────────────────────── */
test('webhook: the challenge handshake is echoed; a wrong or missing secret is refused; no secret configured = closed', async () => {
  const e = env();
  const r = await hook(e, { challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
  assert.equal((await hook(e, { challenge: 'x' }, 'wrong')).status, 403);
  assert.equal((await hook(e, { challenge: 'x' }, '')).status, 403);
  assert.equal((await hook(env({}, { MONDAY_WEBHOOK_SECRET: '' }), { challenge: 'x' })).status, 503);
  assert.equal((await hook(e, 'not json')).status, 400);
  assert.equal((await worker.fetch(new Request('https://go.ishur.io/webhooks/monday-leads?k=whsecret'), e, ctx)).status, 405);
  /* a signed webhook (created with an app token): the JWT is checked when a signing secret is set */
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc({ dat: 1 });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('sign'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const jwt = head + '.' + Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head))).toString('base64url');
  assert.equal(await jwtOk(jwt, 'sign'), true); assert.equal(await jwtOk(jwt, 'other'), false); assert.equal(await jwtOk('junk', 'sign'), false);
  const es = env({}, { MONDAY_SIGNING_SECRET: 'sign' });
  assert.equal((await hook(es, { challenge: 'c' }, 'whsecret', { Authorization: jwt })).status, 200);
  assert.equal((await hook(es, { challenge: 'c' }, 'whsecret', { Authorization: jwt.slice(0, -3) + 'AAA' })).status, 403);
});

test('webhook: a column change in monday reaches the stored lead and the "changed since" read; the payload itself is not trusted', async () => {
  const e = env(); const b0 = await board(e);
  await sleep(5);
  M.items.get('102').cols[MCOL.status] = 'שיחה חוזרת'; M.items.get('102').cols[MCOL.price] = '2390'; M.items.get('102').updated_at = '2026-11-16T10:00:00Z';
  /* monday's documented shape, wrapped in `event`; the value in it says something else on purpose */
  const r = await hook(e, { event: { userId: 1, boardId: Number(BOARD), pulseId: 102, pulseName: 'יוסי כהן', columnId: 'status', columnType: 'color', value: { label: { index: 1, text: 'סגר' } }, previousValue: null, changedAt: 1731751200.5, type: 'update_column_value', triggerUuid: 'u1' } });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, id: 'm102', changed: true });
  const ch = await (await get(e, '/api/crm/leads/changes?since=' + b0.cursor)).json();
  assert.equal(ch.ok, true); assert.equal(ch.reload, undefined); assert.equal(ch.items.length, 1);
  assert.deepEqual([ch.items[0].id, ch.items[0].status, ch.items[0].price], ['m102', 'שיחה חוזרת', 2390], 'what monday answers for the item, not what the payload claimed');
  assert.ok(ch.cursor >= b0.cursor); assert.deepEqual(ch.deleted, []);
  assert.equal(row(await board(e), 'm102').status, 'שיחה חוזרת');
  /* the same event again (monday retries; our own write echoes back): nothing changes */
  assert.deepEqual(await (await hook(e, { event: { boardId: BOARD, pulseId: 102, type: 'update_column_value' } })).json(), { ok: true, id: 'm102', changed: false });
  await sleep(25);
  const quiet = await (await get(e, '/api/crm/leads/changes?since=' + (Date.now() + 30000))).json();
  assert.deepEqual([quiet.items.length, quiet.deleted.length], [0, 0], 'a cursor past the change gets nothing');
  /* the unwrapped shape works too */
  M.items.get('102').cols[MCOL.owner] = 'ריצארד'; M.items.get('102').updated_at = '2026-11-16T10:05:00Z';
  assert.equal((await (await hook(e, { boardId: BOARD, pulseId: '102', type: 'update_column_value' })).json()).changed, true);
  assert.equal(row(await board(e), 'm102').owner, 'ריצארד');
  assert.equal(mutations().length, 0, 'a webhook never writes to monday');
});

test('webhook: a created item appears (before it has a phone, too); an archived or deleted one disappears', async () => {
  const e = env(); const b0 = await board(e); await sleep(5);
  M.items.set('200', item(200, 'ליד חדש', { phone: '', status: 'חדש', price: '', guests: '' }));
  let j = await (await hook(e, { event: { boardId: BOARD, pulseId: 200, pulseName: 'ליד חדש', groupId: 'topics', columnValues: {}, type: 'create_pulse', triggerUuid: 'c1' } })).json();
  assert.deepEqual(j, { ok: true, id: 'm200', changed: true });
  let ch = await (await get(e, '/api/crm/leads/changes?since=' + b0.cursor)).json();
  assert.deepEqual(ch.items.map(l => [l.id, l.name, l.phone]), [['m200', 'ליד חדש', '']]);
  assert.equal((await board(e)).items.length, 4);
  /* the phone is typed a moment later: same item, found by its id */
  M.items.get('200').cols[MCOL.phone] = '054-000-1111'; M.items.get('200').updated_at = '2026-11-16T11:00:00Z';
  await hook(e, { event: { boardId: BOARD, pulseId: 200, columnId: MCOL.phone, type: 'update_column_value' } });
  const b1 = await board(e); assert.equal(row(b1, 'm200').phone, '972540001111'); assert.equal(b1.items.length, 4);
  /* archived (monday still answers the item, state archived) and deleted (monday answers nothing) */
  await sleep(5);
  M.items.get('200').state = 'archived';
  j = await (await hook(e, { event: { boardId: BOARD, pulseId: 200, type: 'archive_pulse' } })).json();
  assert.deepEqual(j, { ok: true, id: 'm200', deleted: true, changed: true });
  M.items.delete('103');
  j = await (await hook(e, { event: { boardId: BOARD, itemId: 103, type: 'delete_pulse' } })).json();
  assert.equal(j.deleted, true);
  ch = await (await get(e, '/api/crm/leads/changes?since=' + b1.cursor)).json();
  assert.deepEqual(ch.deleted.sort(), ['m103', 'm200']); assert.equal(ch.items.length, 0);
  assert.deepEqual((await board(e)).items.map(l => l.id).sort(), ['m101', 'm102']);
});

test('webhook: an unknown event, another board, sync off, monday down', async () => {
  const e = env(); await board(e); const before = e.RATE.m.size;
  assert.deepEqual(await (await hook(e, { event: { type: 'something_new', boardId: BOARD } })).json(), { ok: true, ignored: 'no-item' });
  assert.deepEqual(await (await hook(e, {})).json(), { ok: true, ignored: 'no-item' });
  assert.deepEqual(await (await hook(e, { event: { boardId: 999, pulseId: 101, type: 'update_column_value' } })).json(), { ok: true, ignored: 'board' });
  assert.deepEqual(await (await hook(env({}, { CRM_MONDAY_SYNC: 'off' }), { event: { boardId: BOARD, pulseId: 101 } })).json(), { ok: true, ignored: 'sync-off' });
  /* an event type nobody has seen, but it names an item of our board: the item is simply read again */
  M.items.get('101').cols[MCOL.event] = 'בר מצווה'; M.items.get('101').updated_at = '2026-11-16T12:00:00Z';
  assert.equal((await (await hook(e, { event: { boardId: BOARD, pulseId: 101, type: 'brand_new_event' } })).json()).changed, true);
  assert.equal(row(await board(e), 'm101').event, 'בר מצווה');
  M.down = true;
  const r = await hook(e, { event: { boardId: BOARD, pulseId: 101, type: 'update_column_value' } });
  assert.equal(r.status, 503, 'monday retries the delivery; nothing was stored from the payload');
  M.down = false;
  assert.ok(e.RATE.m.size >= before);
});

/* ── the healing read ───────────────────────────────────────────────────── */
test('reconcile: a change whose webhook never came is found; a deleted item is removed; a failed read changes nothing; no token = no-op', async () => {
  const e = env(); const b0 = await board(e);
  M.items.get('101').cols[MCOL.owner] = 'נועה'; M.items.get('101').updated_at = '2026-11-16T13:00:00Z';
  M.items.delete('103'); M.items.set('300', item(300, 'בלי וובהוק', { phone: '0533333333' }));
  const t = Date.now() + 10;
  const r = await reconcileLeads(e, { now: t });
  assert.deepEqual([r.ok, r.items, r.changed, r.bulk], [true, 3, 3, false]);
  const ch = await (await get(e, '/api/crm/leads/changes?since=' + b0.cursor)).json();
  assert.deepEqual(ch.items.map(l => l.id).sort(), ['m101', 'm300']); assert.deepEqual(ch.deleted, ['m103']);
  assert.equal(ch.items.find(l => l.id === 'm101').owner, 'נועה');
  assert.deepEqual((await reconcileLeads(e, { now: t + 10 })).changed, 0, 'a second run finds nothing');
  M.down = true;
  const bad = await reconcileLeads(e, { now: t + 20 }); assert.equal(bad.ok, false);
  M.down = false;
  assert.equal((await board(e)).items.length, 3, 'the mirror is as it was');
  assert.deepEqual(await reconcileLeads(env({}, { MONDAY_API_TOKEN: '' })), { ok: false, why: 'no-token' });
  assert.deepEqual(await reconcileLeads(env({}, { CRM_MONDAY_SYNC: 'off' })), { ok: false, why: 'sync-off' });
  assert.equal(mutations().length, 0, 'the reconcile only reads');
});

test('reconcile racing an edit: a board read taken before the edit does not undo the saved field', async () => {
  const e = env(); await board(e);
  const stale = gqlItem(M.items.get('101'));   /* the board as monday answered a moment before the edit */
  const j = await (await post(e, '/api/crm/leads/m101', { fields: { status: 'סגר' }, base: { status: 'חדש' } })).json();
  assert.equal(j.ok, true);
  const slowGql = async (_env, q) => (/settings_str/.test(q) ? { boards: [{ columns: [] }] } : { boards: [{ items_page: { cursor: null, items: [stale, gqlItem(M.items.get('102')), gqlItem(M.items.get('103'))] } }] });
  const r = await reconcileLeads(e, { gql: slowGql, now: Date.now() + 50, force: true });
  assert.equal(r.ok, true);
  assert.equal(row(await board(e), 'm101').status, 'סגר');
});

test('many changes at once (a bulk edit in monday): the page is told to reload instead of receiving hundreds of rows', async () => {
  const e = env(); const b0 = await board(e);
  for (let i = 0; i < 70; i++) M.items.set(String(1000 + i), item(1000 + i, 'ליד ' + i, { phone: '05400' + String(10000 + i) }));
  const r = await reconcileLeads(e, { now: Date.now() + 10 });
  assert.equal(r.bulk, true);
  const ch = await (await get(e, '/api/crm/leads/changes?since=' + b0.cursor)).json();
  assert.equal(ch.reload, true);
  assert.equal((await board(e)).items.length, 73);
  assert.equal((await (await get(e, '/api/crm/leads/changes')).json()).reload, true, 'no cursor = load the list');
});

/* ── what must never happen ─────────────────────────────────────────────── */
test('nothing here messages or calls anyone, and "נועה תחייג" is never written', async () => {
  const e = env({}, { WA_TOKEN: 'ct', WA_PHONE_ID_CLIENT: 'N', RETELL_API_KEY: 'rk', NOA_CHASE: 'on' });
  await board(e);
  await post(e, '/api/crm/leads/m102', { fields: { status: 'לא ענה', owner: 'נועה', price: 1790, next: '2026-11-20', note: 'לנסות שוב' }, base: { status: 'לא ענה' } });
  await post(e, '/api/crm/leads/m101', { fields: { status: 'לא ענה' }, base: { status: 'חדש' } });
  await hook(e, { event: { boardId: BOARD, pulseId: 102, type: 'update_column_value' } });
  await reconcileLeads(e, { now: Date.now() + 10, force: true });
  await get(e, '/api/crm/leads/changes?since=1');
  const hosts = [...new Set(calls.map(c => new URL(c.u).host))];
  assert.deepEqual(hosts, ['api.monday.com'], 'the only place this code talks to is monday');
  assert.ok(!calls.some(c => /graph\.facebook\.com|retellai|telnyx|twilio|slack/.test(c.u)));
  for (const m of mutations()) {
    assert.match(m.query, /^mutation\(\$b:ID!,\$i:ID!,\$v:JSON!\)\{ change_multiple_column_values\(/);
    assert.ok(!m.variables.v.includes(MCOL.dial), 'the dial tick is not in any write');
    for (const col of Object.keys(JSON.parse(m.variables.v))) assert.ok(Object.values(WRITABLE).includes(col), col);
  }
  assert.equal(mutations().length, 2);
  assert.equal(M.items.get('102').cols[MCOL.dial], 'v', 'the tick Shalev set is as she left it'); assert.equal(M.items.get('101').cols[MCOL.dial], '');
  assert.equal(STATUS_INDEX['לא ענה'], 2);
  assert.ok(![...e.RATE.m.keys()].some(k => /^(nq:|lq:|noaq:)/.test(k)), 'no call queue entry was created');
});
