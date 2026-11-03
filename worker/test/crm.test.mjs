// node --test worker/test/crm.test.mjs — /api/crm/*: dedupe by phone across sources, quick close
// (quote → send gated by the 24h window → Grow IPN closes), clients merge, hostess conflicts, agenda, stats.
// Graph / Grow / Monday / Meta are stubbed; nothing leaves the machine.
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../index.js';
import { importLeads, mergeClients, hostessConflicts, agendaFor, buildStats, importMerge, windowOpen, crmTouch, crmOnPaid, clientHoursOpen, patchFromMonday, overdueCount } from '../crm.js';
import { makeStore } from '../store.js';
import { CHECKS } from '../brain.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0003_crm.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { db.prepare(sql).run(...args); return {}; } });
  return { prepare: sql => stmt(sql) };
}
const kvPrefix = async (env, prefix) => { const out = {}; for (const [k, v] of env.RATE.m) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v; return out; };

const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa', TOK2 = 'd2d6f6f6-0000-4000-8000-0000000000bb';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
function snapshot() {
  const ev = (tok, name, date, extra = {}) => { const r = Array(50).fill(''); r[1] = tok; r[2] = name; r[3] = '0501234567'; r[5] = 'חתונה'; r[6] = date; r[7] = 'כן'; r[8] = '379'; r[31] = 'pro'; r[32] = '300'; r[34] = name; for (const [i, v] of Object.entries(extra)) r[i] = v; return r; };
  const g = (n, rsvp, tok = TOK) => { const r = Array(31).fill(''); r[28] = tok; r[2] = 'G' + n; r[3] = 'אורח ' + n; r[4] = '05200000' + n + '1'; r[15] = rsvp; return r; };
  return { events: { values: [ev(TOK, 'אורי ויצחק', '2026-11-20'), ev(TOK2, 'בוטל', '2026-10-01', { 27: 'כן' })] }, guests: { values: [g(1, 'מגיע'), g(2, ''), g(3, 'לא מגיע'), g(4, 'מתלבט')] }, leads: { values: [] } };
}
let realFetch, calls = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, body: init.body ? String(init.body) : '' });
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()));
    if (u === 'https://hook.test/grow-link') return new Response(JSON.stringify({ url: 'https://pay.grow.link/TEST-LINK' }));
    if (/graph\.facebook\.com\/v\d+\.\d+\/N\/messages/.test(u)) return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST1' }] }));
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; mock.timers.reset(); });
beforeEach(() => { calls = []; });
const env = (init = {}, extra = {}) => ({ ADMIN_KEY: 'k', GROW_KEY: 'gk', HOOK_GROW: 'https://hook.test/grow', GROW_LINK_HOOK: 'https://hook.test/grow-link', HOOK_STATUS: 'https://hook.test/status',
  SLACK_ALERT_HOOK: 'https://hook.test/slack', WA_PHONE_ID_CLIENT: 'N', WA_TOKEN: 'ct', RATE: kv(init), ...extra });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { headers: key ? { 'X-Admin-Key': key } : {} }), e, ctx);
const post = (e, path, body, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: key, ...body }) }), e, ctx);

test('auth: /api/crm/* is admin-only like /api/ops/*', async () => {
  const e = env();
  assert.equal((await get(e, '/api/crm/leads', '')).status, 403);
  assert.equal((await get(e, '/api/crm/leads', 'bad')).status, 403);
  assert.equal((await get(e, '/api/crm/leads')).status, 200);
  assert.equal((await post(e, '/api/crm/agenda', {})).status, 200);
  assert.equal((await get(e, '/api/crm/nope')).status, 404);
});

/* ── 1. dedupe by phone across every source ── */
for (const backend of ['kv', 'd1']) test(`[${backend}] import: one lead per phone across lead: / leadx: / Meta / Monday; Monday notes are the first note; re-import adds nothing`, async () => {
  const e = env({
    'lead:972501234567': JSON.stringify({ name: 'דנה', occasion: 'חתונה', guests: '300', at: '2026-10-20T10:00:00.000Z', page: 'ishur.io/', source: 'google / cpc', types: ['lead'] }),
    'lead:972529999999': JSON.stringify({ name: 'יוסי', at: '2026-10-25T10:00:00.000Z', page: 'whatsapp', types: ['whatsapp_in'] }),
    'leadx:972501234567': JSON.stringify({ status: 'שיחה חוזרת', owner: 'שלו', mondayId: '777', notes: [{ at: '2026-10-21T08:00:00.000Z', text: 'ביקשה לחזור אחרי החגים' }] }),
    'client:972541111111': '1',
  }, backend === 'd1' ? { OPS_DB: fakeD1(), MONDAY_API_TOKEN: 'm' } : { MONDAY_API_TOKEN: 'm' });
  const d = {
    kvPrefix,
    pullMetaFormLeads: async (_e, o) => { assert.equal(o.dry, true, 'Meta is read dry: no mlead:/Slack/sheet side effects'); return { ok: true, leads: [
      { id: 'ml1', at: '2026-10-22T10:00:00+0000', phone: '+972-50-123-4567', name: 'דנה כהן', occasion: 'wedding', extra: 'guests: 300', ad: 'AS05', campaign: 'winter' },
      { id: 'ml2', at: '2026-10-23T10:00:00+0000', phone: '0541111111', name: 'לקוח קיים' },
    ] }; },
    mondayGql: async (_e, q) => { assert.ok(!/mutation/.test(q), 'import never writes Monday'); return { boards: [{ items_page: { cursor: null, items: [
      { id: '777', name: 'דנה כהן', created_at: '2026-10-19T09:00:00Z', column_values: [{ id: 'phone_mm7g3mjv', text: '050-123-4567' }, { id: 'status', text: 'שיחה חוזרת' }, { id: 'long_text_mm7gh65j', text: 'הגיעה מהמלצה של חברה' }] },
      { id: '778', name: 'בלי טלפון', column_values: [] },
    ] } }] }; },
  };
  const store = makeStore(e);
  assert.equal(store.kind, backend);
  const r = await importLeads(e, d, { store });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const all = await store.all('leads');
  assert.deepEqual(all.map(l => l.phone).sort(), ['972501234567', '972529999999', '972541111111']);
  const dana = await store.get('leads', 'L972501234567');
  assert.equal(dana.status, 'talking'); assert.equal(dana.owner, 'שלו'); assert.equal(dana.monday_item_id, '777');
  assert.equal(dana.source, 'web', 'source = the first seen (the website form)');
  assert.equal(dana.created_at, '2026-10-19T09:00:00.000Z', 'created_at moves to the earliest source (Monday)');
  assert.equal(dana.records_estimate, 300); assert.equal(dana.origin.meta_lead_id, 'ml1');
  const notes = await store.listNotes('lead', dana.id);
  assert.match(notes[0].text, /^מאנדיי: הגיעה מהמלצה/); assert.equal(notes[0].origin, 'monday');
  assert.equal(notes.length, 3, 'monday + leadx + meta notes, each once');
  assert.equal((await store.get('leads', 'L972529999999')).source, 'whatsapp');
  assert.equal((await store.get('leads', 'L972541111111')).status, 'closed', 'a phone that already paid is closed');
  const r2 = await importLeads(e, d, { store });
  assert.equal(r2.created, 0); assert.equal(r2.notes_added, 0);
  assert.equal((await store.all('leads')).length, 3);
  assert.equal((await store.listNotes('lead', dana.id)).length, 3);
});

test('importMerge: ops edits win over imports, status only moves forward, closed is final', () => {
  assert.deepEqual(importMerge({ name: 'דנה', status: 'quoted', status_by_ops: true }, { name: 'אחר', status: 'closed', owner: 'שלו' }), { owner: 'שלו' });
  assert.deepEqual(importMerge({ status: 'new' }, { status: 'talking' }), { status: 'talking' });
  assert.deepEqual(importMerge({ status: 'talking' }, { status: 'new' }), {});
  assert.deepEqual(importMerge({ status: 'closed' }, { status: 'lost' }), {});
  assert.equal(patchFromMonday({ id: '1', name: 'רון 0521234567', column_values: [] }).patch.phone, '972521234567', 'phone typed into the item name');
});

/* ── 2. quick close: quote → send (24h gate, quiet hours, confirm) → IPN closes ── */
test('quick close end to end through the Worker', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:00.000Z') });   /* Wed 12:00 Israel */
  try {
    const e = env();
    const c = await (await post(e, '/api/crm/leads', { phone: '050-123-4567', name: 'דנה כהן', occasion: 'wedding', event_date: '2026-12-20' })).json();
    assert.equal(c.ok, true); assert.equal(c.lead.id, 'L972501234567'); assert.equal(c.lead.source, 'manual');
    assert.equal((await (await post(e, '/api/crm/leads', { phone: '0501234567' })).json()).existed, true, 'same phone never duplicates');

    const q = await (await post(e, '/api/crm/leads/L972501234567/quote', { plan: 'basic', records: 100, addons: { design: true } })).json();
    assert.equal(q.ok, true); assert.equal(q.link, 'https://pay.grow.link/TEST-LINK'); assert.equal(q.quote.sum, 99 + 79);
    assert.match(q.suggested_text, /דנה/); assert.match(q.suggested_text, /pay\.grow\.link/); assert.match(q.suggested_text, /₪178/);
    const sentHook = JSON.parse(calls.find(x => x.u === 'https://hook.test/grow-link').body);
    assert.equal(sentHook.sum, 178, 'server-priced'); assert.ok(sentHook.cField1.startsWith('q:' + q.quote.id));
    assert.equal((await post(e, '/api/crm/leads/L972501234567/quote', { plan: 'gold', records: 100 })).status, 400);

    /* never wrote to us → template only */
    let s = await (await post(e, '/api/crm/leads/L972501234567/send', { text: q.suggested_text, confirm: true })).json();
    assert.equal(s.ok, false); assert.equal(s.error, 'needs_template'); assert.ok(s.templates.length >= 1);
    assert.ok(!calls.some(x => /\/messages$/.test(x.u)), 'nothing sent');
    /* an inbound 25h ago is outside the window */
    e.RATE.m.set('conv:972501234567', JSON.stringify({ last_in_ts: Date.now() - 25 * 3600e3, last_dir: 'in' }));
    assert.equal((await (await post(e, '/api/crm/leads/L972501234567/send', { text: 'x y', confirm: true })).json()).error, 'needs_template');
    /* an inbound 1h ago (through the real webhook hook) opens it */
    await crmTouch(e, '972501234567', { dir: 'in', text: 'אפשר קישור?', at: new Date(Date.now() - 3600e3).toISOString(), id: 'wa:in1' });
    s = await (await post(e, '/api/crm/leads/L972501234567/send', { text: q.suggested_text })).json();
    assert.equal(s.preview, true); assert.equal(s.confirm_required, true);
    assert.ok(!calls.some(x => /\/messages$/.test(x.u)), 'preview sends nothing');
    s = await (await post(e, '/api/crm/leads/L972501234567/send', { text: q.suggested_text, confirm: true })).json();
    assert.equal(s.ok, true, JSON.stringify(s)); assert.equal(s.wamid, 'wamid.TEST1'); assert.equal(s.lead.status, 'quoted');
    const wa = calls.filter(x => /\/N\/messages$/.test(x.u));
    assert.equal(wa.length, 1, 'one free text from Noa (client phone id)'); assert.equal(JSON.parse(wa[0].body).type, 'text');
    const det = await (await get(e, '/api/crm/leads/L972501234567')).json();
    const kinds = det.activities.map(a => a.kind);
    assert.ok(kinds.includes('wa_in') && kinds.includes('wa_out') && kinds.includes('quote') && kinds.includes('status'), kinds.join(','));

    /* Grow IPN with the quote id → closed + client token */
    const r = await post(e, '/api/grow-ipn?k=gk', { paymentDesc: q.quote.description, paymentSum: '178', asmachta: 'QC1', payerPhone: '0501234567', fullName: 'דנה כהן', cField1: `q:${q.quote.id}|${q.quote.code}`, cField2: 'wedding' }, undefined);
    assert.equal(await r.text(), 'ok');
    const token = e.RATE.m.get('grow:QC1');
    const after = (await (await get(e, '/api/crm/leads/L972501234567')).json()).lead;
    assert.equal(after.status, 'closed'); assert.equal(after.client_token, token); assert.ok(after.closed_at);
    const cl = await makeStore(e).get('clients', token);
    assert.equal(cl.lead_id, 'L972501234567'); assert.equal(cl.phone, '972501234567');
  } finally { mock.timers.reset(); }
});

test('send gating: quiet hours (21:00–09:00, Shabbat) refuse even inside the window', async () => {
  assert.equal(clientHoursOpen(Date.parse('2026-11-04T10:00:00Z')), true);
  assert.equal(clientHoursOpen(Date.parse('2026-11-04T20:00:00Z')), false, '22:00 IL');
  assert.equal(clientHoursOpen(Date.parse('2026-11-07T10:00:00Z')), false, 'Shabbat');
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T20:00:00.000Z') });
  try {
    const e = env({ 'conv:972501234567': JSON.stringify({ last_in_ts: Date.now() - 600e3 }) });
    await post(e, '/api/crm/leads', { phone: '0501234567', name: 'דנה' });
    const s = await (await post(e, '/api/crm/leads/L972501234567/send', { text: 'שלום', confirm: true })).json();
    assert.equal(s.error, 'quiet-hours');
    assert.ok(!calls.some(x => /\/messages$/.test(x.u)));
  } finally { mock.timers.reset(); }
  assert.equal(windowOpen({ last_inbound_at: new Date(Date.now() - 3600e3).toISOString() }, null), true);
  assert.equal(windowOpen({}, { last_dir: 'out', last_ts: Date.now() }), false);
});

test('crmTouch: 4499 inbound from a new number becomes a whatsapp lead; guests channel and outbound never create one', async () => {
  const e = env({ 'client:972541111111': '1' });
  await crmTouch(e, '0527777777', { dir: 'out', text: 'x' });
  await crmTouch(e, '0528888888', { dir: 'in', text: 'x', ch: 'guests' });
  await crmTouch(e, '0541111111', { dir: 'in', text: 'לקוח קיים' });
  const s = makeStore(e);
  assert.equal((await s.all('leads')).length, 0);
  await crmTouch(e, '0527777777', { dir: 'in', text: 'היי, כמה עולה?' });
  const l = await s.get('leads', 'L972527777777');
  assert.equal(l.source, 'whatsapp'); assert.ok(l.last_inbound_at);
});

test('crmOnPaid without a quote closes the lead by phone and is idempotent per receipt', async () => {
  const e = env();
  const s = makeStore(e);
  await s.upsert('leads', { id: 'L972501234567', phone: '972501234567', status: 'talking', tags: [] });
  const r = await crmOnPaid(e, { phone: '0501234567', token: TOK, sum: '379', ref: 'R1', name: 'דנה' });
  assert.equal(r.ok, true); assert.equal(r.status, 'closed');
  await crmOnPaid(e, { phone: '0501234567', token: TOK, sum: '379', ref: 'R1' });
  assert.equal((await s.listActivities('lead', 'L972501234567')).filter(a => a.kind === 'payment').length, 1);
});

/* ── 3. clients ── */
test('mergeClients: status, counts, add-ons, feedback, links', () => {
  const biz = { events: [
    { token: TOK, name: 'אורי ויצחק', client: 'אורי', phone: '0501234567', occasion: 'חתונה', date: '2026-11-20', paid: true, sum: 379, plan: 'pro', tier: '300', guests: 4, confirmed: 1, declined: 1, undecided: 1, pending: 1, seats: 2 },
    { token: TOK2, name: 'בוטל', date: '2026-10-01', cancelled: true, guests: 0 },
    { token: 'e3e3e3e3-0000-4000-8000-0000000000cc', name: 'היום', date: '2026-11-03' },
  ] };
  const rows = mergeClients({ biz, today: '2026-11-03', kv: { [TOK]: { wave1: true, hostess: { n: 2, city: 'חיפה' }, design: { status: 'paid' }, extrasend: true, fb: { nps: 9, route: 'לביקורת בגוגל' } } },
    subevents: [{ token: 'sub1', parent: TOK, name: 'שבת חתן', kind: 'shabbat_chatan' }], crmClients: { [TOK]: { lead_id: 'L972501234567' } } });
  const a = rows.find(r => r.token === TOK);
  assert.equal(a.status, 'upcoming'); assert.equal(a.phone, '972501234567'); assert.equal(a.records, 300); assert.equal(a.paid_sum, 379);
  assert.deepEqual(a.counts, { invited: 4, sent: 4, delivered: null, replied: 3, confirmed: 1, seats: 2, declined: 1, undecided: 1, pending: 1, need_call: 0 });
  assert.deepEqual(a.addons, { design: 'paid', hostesses: { n: 2, city: 'חיפה', booked: false }, calls: true, extra_wave: true });
  assert.equal(a.feedback.nps, 9); assert.equal(a.subevents.length, 1); assert.equal(a.lead_id, 'L972501234567');
  assert.match(a.links.upload, /upload\.html\?t=c1c5fcf5/);
  assert.equal(rows.find(r => r.token === TOK2).status, 'cancelled');
  assert.equal(rows.find(r => r.names === 'היום').status, 'live');
  assert.equal(mergeClients({ biz, today: '2026-11-03', kv: { [TOK]: { hold: '1' } } }).find(r => r.token === TOK).status, 'held');
});

test('GET /api/crm/clients merges the sheet snapshot with KV; /clients/:token has a timeline', async () => {
  const e = env({ ['paid:' + TOK]: JSON.stringify({ plan: 'pro', tier: 300, sum: '379', at: '2026-10-01T00:00:00Z' }), ['hostess:' + TOK]: JSON.stringify({ n: 1, city: 'תל אביב' }) });
  const s = makeStore(e);
  await s.appendNote({ entity_type: 'client', entity_id: TOK, text: 'רוצים שולחן VIP', pinned: true });
  await s.upsert('hostesses', { id: 'H1', name: 'מיה' });
  await s.upsert('hostess_assignments', { id: 'S1', hostess_id: 'H1', hostess_name: 'מיה', event_token: TOK, date: '2026-11-20', start: '18:00', end: '23:00', status: 'confirmed' });
  const j = await (await get(e, '/api/crm/clients')).json();
  assert.equal(j.ok, true); assert.equal(j.clients.length, 2);
  const c = j.clients.find(x => x.token === TOK);
  assert.equal(c.addons.hostesses.n, 1); assert.equal(c.counts.confirmed, 1); assert.equal(j.counts.cancelled, 1);
  const t = await (await get(e, '/api/crm/clients/' + TOK)).json();
  assert.equal(t.ok, true); assert.ok(t.timeline.some(x => x.kind === 'note' && x.pinned)); assert.ok(t.timeline.some(x => x.kind === 'hostess'));
  assert.equal(t.assignments.length, 1);
  assert.equal((await get(e, '/api/crm/clients/nope')).status, 404);
});

/* ── 4. hostesses ── */
test('hostessConflicts: same hostess + same day + overlapping hours; no hours = whole day', () => {
  const a = [{ id: 'S1', hostess_id: 'H1', date: '2026-11-20', start: '18:00', end: '23:00', status: 'confirmed' }, { id: 'S2', hostess_id: 'H1', date: '2026-11-21', status: 'proposed' }];
  assert.equal(hostessConflicts(a, { hostess_id: 'H1', date: '2026-11-20', start: '22:00', end: '23:30' }).length, 1);
  assert.equal(hostessConflicts(a, { hostess_id: 'H1', date: '2026-11-20', start: '12:00', end: '17:00' }).length, 0, 'back to back is fine');
  assert.equal(hostessConflicts(a, { hostess_id: 'H2', date: '2026-11-20', start: '18:00', end: '23:00' }).length, 0);
  assert.equal(hostessConflicts(a, { hostess_id: 'H1', date: '2026-11-21', start: '10:00', end: '11:00' }).length, 1, 'no hours on the existing one');
  assert.equal(hostessConflicts(a, { id: 'S1', hostess_id: 'H1', date: '2026-11-20', start: '18:00', end: '23:00' }).length, 0, 'itself');
});
test('hostess routes: roster CRUD, assignment 409 on conflict, force overrides, delete needs confirm', async () => {
  const e = env();
  const h = await (await post(e, '/api/crm/hostesses', { name: 'מיה לוי', phone: '0503333333', city: 'חיפה', rate: 450 })).json();
  assert.equal(h.ok, true); assert.equal(h.hostess.id, 'H972503333333'); assert.equal(h.hostess.active, true);
  assert.equal((await post(e, '/api/crm/hostesses', { name: 'x' })).status, 400);
  assert.equal((await (await post(e, '/api/crm/hostesses/H972503333333', { active: false })).json()).hostess.active, false);
  const a1 = await (await post(e, '/api/crm/assignments', { hostess_id: 'H972503333333', event_token: TOK, date: '2026-11-20', start: '18:00', end: '23:00', hours: 5, pay: 450 })).json();
  assert.equal(a1.ok, true); assert.equal(a1.assignment.status, 'proposed'); assert.equal(a1.assignment.hostess_name, 'מיה לוי');
  const clash = await post(e, '/api/crm/assignments', { hostess_id: 'H972503333333', event_token: TOK2, date: '2026-11-20', start: '20:00', end: '22:00' });
  assert.equal(clash.status, 409); assert.equal((await clash.json()).conflicts[0].id, a1.assignment.id);
  const cf = await (await get(e, `/api/crm/assignments/conflicts?hostess_id=H972503333333&date=2026-11-20&start=19:00&end=20:00`)).json();
  assert.equal(cf.conflicts.length, 1);
  assert.equal((await (await post(e, '/api/crm/assignments', { hostess_id: 'H972503333333', event_token: TOK2, date: '2026-11-20', start: '20:00', end: '22:00', force: true })).json()).ok, true);
  assert.equal((await (await post(e, '/api/crm/assignments', { id: a1.assignment.id, status: 'confirmed' })).json()).assignment.status, 'confirmed');
  assert.equal((await post(e, '/api/crm/assignments', { hostess_id: 'H972503333333', event_token: TOK, date: '2026-11-20', status: 'maybe' })).status, 400);
  const list = await (await get(e, '/api/crm/assignments?event_token=' + TOK)).json();
  assert.equal(list.items.length, 1);
  assert.equal((await (await post(e, '/api/crm/hostesses/H972503333333/delete', {})).json()).applied, false);
  assert.equal((await (await post(e, '/api/crm/hostesses/H972503333333/delete', { confirm: 'H972503333333' })).json()).applied, true);
});
test('hostess import: KV bookings surface as events needing a hostess; no roster board → said so, nothing invented', async () => {
  const e = env({ ['hostessbook:' + TOK]: JSON.stringify({ date: '2026-11-20', city: 'חיפה', n: 2, reception: '19:30', start: 'a', end: 'b' }), ['hostess:' + TOK2]: JSON.stringify({ n: 1, date: '2026-12-01' }) });
  const j = await (await post(e, '/api/crm/hostesses/import', {})).json();
  assert.equal(j.bookings, 1); assert.equal(j.events_needing_hostess[0].n, 2); assert.equal(j.bought_unbooked[0].token, TOK2);
  assert.match(j.why[0], /HOSTESS_ROSTER_BOARD/);
  assert.equal((await makeStore(e).all('hostess_assignments')).length, 0);
});

/* ── 5. notes, reminders, agenda, brain ── */
test('notes + reminders + agenda (overdue first) + brain crm_overdue', async () => {
  const e = env();
  await post(e, '/api/crm/leads', { phone: '0501234567', name: 'דנה' });
  assert.equal((await post(e, '/api/crm/notes', { entity_type: 'lead', entity_id: 'L972501234567', text: '' })).status, 400);
  assert.equal((await post(e, '/api/crm/notes', { entity_type: 'nope', entity_id: 'x', text: 'a' })).status, 400);
  const n = await (await post(e, '/api/crm/notes', { entity_type: 'lead', entity_id: 'L972501234567', text: 'דיברנו, שולחת הצעה', author: 'שלו' })).json();
  assert.equal(n.ok, true); assert.equal(n.monday.why, 'no-token');
  await post(e, '/api/crm/notes/pin', { entity_type: 'lead', entity_id: 'L972501234567', id: n.note.id, pinned: true });
  assert.equal((await (await get(e, '/api/crm/notes?entity_type=lead&entity_id=L972501234567')).json()).notes[0].pinned, true);
  const today = ilDay();
  const past = new Date(Date.now() - 2 * 864e5).toISOString(), later = new Date(Date.now() + 3 * 3600e3).toISOString(); /* always in the future, whatever the hour the suite runs */
  const r1 = await (await post(e, '/api/crm/reminders', { entity_type: 'lead', entity_id: 'L972501234567', due_at: past, text: 'לחזור לדנה' })).json();
  await post(e, '/api/crm/reminders', { entity_type: 'client', entity_id: TOK, due_at: later, text: 'לוודא העלאה' });
  assert.equal((await post(e, '/api/crm/reminders', { entity_type: 'lead', entity_id: 'x', due_at: 'never' })).status, 400);
  const lead = (await (await get(e, '/api/crm/leads/L972501234567')).json()).lead;
  assert.equal(lead.next_action_text, 'לחזור לדנה', 'the earliest open reminder is the next action');
  const ag = await (await get(e, '/api/crm/agenda?events=0')).json();
  assert.equal(ag.day, today); assert.equal(ag.items[0].overdue, true); assert.equal(ag.items[0].text, 'לחזור לדנה');
  assert.ok(ag.items.some(i => i.text === 'לוודא העלאה'));
  const chk = CHECKS.find(c => c.id === 'crm_overdue');
  const f = await chk.run({ env: e, now: Date.now() });
  assert.equal(f.length, 1); assert.match(f[0].title_he, /באיחור/); assert.equal(f[0].severity, 'P2', 'over a day late');
  await post(e, '/api/crm/reminders/' + r1.reminder.id, { done: true });
  assert.equal((await overdueCount(e)).reminders.length, 0);
  assert.equal((await (await get(e, '/api/crm/leads/L972501234567')).json()).lead.next_action_at, '');
  assert.deepEqual(await chk.run({ env: e, now: Date.now() }), []);
});
test('agendaFor (pure): day items, overdue only on today, closed leads skipped', () => {
  const a = agendaFor('2026-11-03', { reminders: [{ id: 'R1', due_at: '2026-11-01T08:00:00Z', text: 'old' }, { id: 'R2', due_at: '2026-11-03T08:00:00Z', text: 'today' }, { id: 'R3', due_at: '2026-11-03T08:00:00Z', done: true }],
    leads: [{ id: 'L1', status: 'closed', next_action_at: '2026-11-03T08:00:00Z' }, { id: 'L2', status: 'new', next_action_at: '2026-11-03T06:00:00Z', name: 'רון' }],
    assignments: [{ id: 'S1', date: '2026-11-03', hostess_id: 'H1', start: '18:00' }] }, '2026-11-03');
  assert.deepEqual(a.items.map(i => i.id), ['R1', 'L2', 'R2', 'S1']);
  assert.equal(agendaFor('2026-11-03', { reminders: [{ id: 'R1', entity_type: 'lead', entity_id: 'L2', due_at: '2026-11-03T06:00:00Z' }], leads: [{ id: 'L2', status: 'new', next_action_at: '2026-11-03T06:00:00Z' }] }).items.length, 1, 'reminder-backed next action listed once');
  assert.equal(agendaFor('2026-11-05', { reminders: [{ id: 'R1', due_at: '2026-11-01T08:00:00Z' }] }, '2026-11-03').items.length, 0);
});

/* ── 6. stats ── */
test('buildStats: revenue buckets from pay rows, funnel + conversion, sources, close time, volume + failures', () => {
  const ts = iso => Date.parse(iso);
  const pay = [{ kind: 'pay', ts: ts('2026-11-02T10:00:00Z'), data: { ipn: { paymentDesc: '100 רשומות בסיס', paymentSum: '99', asmachta: 'A' } } }, { kind: 'pay', ts: ts('2026-11-02T11:00:00Z'), data: { ipn: { paymentDesc: '100 רשומות בסיס', paymentSum: '99', asmachta: 'A' } } }];
  const leads = [{ status: 'closed', source: 'meta_form', created_at: '2026-11-01T10:00:00Z', closed_at: '2026-11-03T10:00:00Z' }, { status: 'new', source: 'whatsapp', created_at: '2026-11-02T10:00:00Z' }, { status: 'quoted', source: 'meta_form', created_at: '2026-11-02T10:00:00Z', quote_id: 'q' }];
  const out = [{ ts: ts('2026-11-02T10:00:00Z'), ok: true }, { ts: ts('2026-11-02T10:00:00Z'), ok: false, data: { error: '131049: x' } }];
  const st = [{ ts: ts('2026-11-03T10:00:00Z'), data: { status: 'failed', code: 131026 } }];
  const s = buildStats({ range: '7d', today: '2026-11-03', leads, pay, out, status: st, calls: [{ ts: ts('2026-11-03T10:00:00Z') }], parsePaidDesc: d => (/רשומות/.test(d) ? { tier: 100, planText: 'בסיס' } : null) });
  assert.equal(s.range.group, 'day'); assert.equal(s.revenue.length, 7);
  assert.equal(s.revenue_total, 99, 'same receipt counted once');
  assert.equal(s.funnel.total, 3); assert.equal(s.funnel.by_status.closed, 1); assert.equal(s.funnel.conversion_pct, 33.3);
  assert.deepEqual(s.sources, { meta_form: 2, whatsapp: 1 }); assert.equal(s.avg_close_days, 2);
  assert.deepEqual(s.volume.find(v => v.bucket === '2026-11-02'), { bucket: '2026-11-02', sends: 2, calls: 0, failed: 1 });
  assert.deepEqual(s.failures, { rejected: 1, failed_async: 1, by_code: { 131049: 1, 131026: 1 } });
  assert.equal(buildStats({ range: '90d', today: '2026-11-03' }).range.group, 'week');
  assert.equal(buildStats({ range: '12m', today: '2026-11-03' }).range.group, 'month');
});
test('GET /api/crm/stats and /api/crm/leads answer with the documented shape', async () => {
  const e = env({ 'lead:972501234567': JSON.stringify({ name: 'דנה', at: new Date().toISOString() }) });
  const l = await (await get(e, '/api/crm/leads')).json();
  assert.equal(l.ok, true); assert.equal(l.total, 1, 'lazy KV sync on the first list'); assert.equal(l.synced.created, 1);
  assert.equal(l.by_status.new, 1); assert.equal(l.statuses.length, 6);
  const s = await (await get(e, '/api/crm/stats?range=30d')).json();
  assert.equal(s.ok, true); assert.equal(s.funnel.total, 1); assert.ok(Array.isArray(s.revenue) && Array.isArray(s.volume));
  const b = await (await post(e, '/api/crm/leads/bulk', { ids: ['L972501234567', 'Lnope'], patch: { status: 'talking', owner: 'שלו' } })).json();
  assert.equal(b.changed, 1); assert.equal(b.results[1].error, 'not-found');
  assert.equal((await post(e, '/api/crm/leads/bulk', { ids: ['L972501234567'], patch: { status: 'won' } })).status, 400);
});

/* ── import at volume: KV rejects a 2nd PUT to the same key inside one import (Cloudflare: ~1 write/sec/key → 429) ── */
function strictKv(init = {}) {
  const base = kv(init), puts = new Map();
  const put = async (k, v) => { const n = (puts.get(k) || 0) + 1; puts.set(k, n); if (n > 1) throw new Error('KV PUT failed: 429 Too Many Requests'); return base.put(k, v); };
  return { ...base, put, puts, window: () => puts.clear() };
}
test('import: 120 leads + notes → one crm:t:leads PUT per call, resumable by cursor, idempotent re-run; HTTP route returns counts', async () => {
  const init = {};
  for (let i = 0; i < 120; i++) {
    const ph = '97250' + String(1000000 + i);
    init['lead:' + ph] = JSON.stringify({ name: 'ליד ' + i, at: '2026-10-20T10:00:00.000Z', page: 'ishur.io/', types: ['lead'] });
    if (i % 3 === 0) init['leadx:' + ph] = JSON.stringify({ status: 'שיחה חוזרת', notes: [{ at: '2026-10-21T08:00:00.000Z', text: 'הערה ' + i }] });
  }
  const RATE = strictKv(init);
  const e = env({}, { RATE });
  const d = { kvPrefix, sleep: async () => {} };
  const store = makeStore(e);
  let cursor = '', total = { created: 0, updated: 0, notes_added: 0 }, calls = 0;
  do {
    RATE.window();
    const r = await importLeads(e, d, { store, sources: ['kv', 'leadx'], cursor, limit: 50 });
    assert.equal(r.ok, true); assert.equal(r.errors.length, 0);
    assert.equal(RATE.puts.get('crm:t:leads'), 1, 'exactly one table PUT per call');
    for (const k of Object.keys(total)) total[k] += r[k];
    assert.equal(r.phones, 120); calls++;
    cursor = r.next_cursor;
    assert.equal(r.done, !cursor);
  } while (cursor && calls < 10);
  assert.equal(calls, 3, '120 phones / 50 per call');
  assert.deepEqual(total, { created: 120, updated: 0, notes_added: 40 });
  assert.equal((await store.all('leads')).length, 120);
  assert.equal((await store.get('leads', 'L972501000000')).status, 'talking');
  assert.equal((await store.listNotes('lead', 'L972501000003')).length, 1);
  /* re-run: nothing changes, nothing is written to the leads table */
  RATE.window();
  const again = await importLeads(e, d, { store, sources: ['kv', 'leadx'], limit: 500 });
  assert.deepEqual([again.created, again.updated, again.notes_added, again.unchanged, again.done], [0, 0, 0, 120, true]);
  assert.equal(RATE.puts.get('crm:t:leads') || 0, 0, 'idempotent: no table write when nothing changed');
  /* the route: cursor + limit pass through, counts come back */
  RATE.window();
  const res = await (await post(e, '/api/crm/leads/import', { sources: ['kv'], limit: 100 })).json();
  assert.equal(res.ok, true); assert.equal(res.processed, 100); assert.equal(res.next_cursor, '100'); assert.equal(res.unchanged, 100);
  const res2 = await (await post(e, '/api/crm/leads/import', { sources: ['kv'], limit: 100, cursor: res.next_cursor })).json();
  assert.equal(res2.processed, 20); assert.equal(res2.next_cursor, null); assert.equal(res2.done, true);
});
