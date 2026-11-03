// node --test worker/test/crm-clientcard.test.mjs — the ops client card LIVE (03/11):
// POST /api/crm/clients/:token partial edit (only changed cells, validation, change log + Slack),
// POST /api/crm/clients/:token/action → the existing admin routes, typed confirm, quiet hours, change log;
// lead template send. Sheets (BRAIN_HOOK), Graph and Slack are stubbed; nothing leaves the machine.
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { validClientEdit, clientCellDiff, CLIENT_ACTIONS } from '../crm.js';
import { listChanges } from '../changes.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, typeof v === 'string' ? v : v instanceof ArrayBuffer ? v : String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }),
    getWithMetadata: async k => (m.has(k) ? { value: m.get(k), metadata: { mime: 'image/png' } } : { value: null }) };
}
const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa', TOK2 = 'd2d6f6f6-0000-4000-8000-0000000000bb';
function snapshot() {
  const ev = (tok, name, date, extra = {}) => { const r = Array(50).fill(''); r[1] = tok; r[2] = 'אורי'; r[3] = '0501234567'; r[5] = 'חתונה'; r[6] = date; r[7] = 'כן'; r[8] = '379'; r[31] = 'pro'; r[32] = '300'; r[34] = name; for (const [i, v] of Object.entries(extra)) r[i] = v; return r; };
  const g = (n, rsvp, tok = TOK) => { const r = Array(31).fill(''); r[28] = tok; r[2] = 'G' + n; r[3] = 'אורח ' + n; r[4] = '05200000' + n + '1'; r[15] = rsvp; return r; };
  return { events: { values: [ev(TOK2, 'אחר', '2026-12-24'), ev(TOK, 'אורי ויצחק', '2026-11-20')] }, guests: { values: [g(1, 'מגיע'), g(2, ''), g(3, 'לא מגיע'), g(4, 'מתלבט')] }, leads: { values: [] } };
}
let realFetch, calls = [];
const sheetWrites = () => calls.filter(c => c.u === 'https://hook.test/brain' && /values:batchUpdate/.test(c.body)).map(c => JSON.parse(JSON.parse(c.body).payload).data);
const graph = () => calls.filter(c => /graph\.facebook\.com/.test(c.u) && c.body).map(c => JSON.parse(c.body));
const slack = () => calls.filter(c => c.u === 'https://hook.test/slack');
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, body: init.body ? String(init.body) : '' });
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()));
    if (u === 'https://hook.test/brain') {
      const b = JSON.parse(init.body || '{}');
      if (/values:batchUpdate/.test(b.url)) return new Response(JSON.stringify({ totalUpdatedCells: JSON.parse(b.payload).data.length }));
      if (/values\/אורחים!AC/.test(b.url)) return new Response(JSON.stringify({ values: [['x'], [TOK], [TOK], [TOK2]] }));
      if (/:batchUpdate$/.test(b.url)) return new Response(JSON.stringify({ replies: [{}, {}] }));
      return new Response('{}');
    }
    if (/graph\.facebook\.com\/v\d+\.\d+\/N\/messages/.test(u)) return new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }));
    return new Response('{}');
  };
  /* Wednesday 04/11/2026 10:00 Israel: inside client hours */
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:00+02:00') });
});
after(() => { globalThis.fetch = realFetch; mock.timers.reset(); });
beforeEach(() => { calls = []; });
const env = (init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', BRAIN_HOOK: 'https://hook.test/brain', SLACK_ALERT_HOOK: 'https://hook.test/slack', SLACK_HOOK: 'https://hook.test/slack',
  WA_PHONE_ID_CLIENT: 'N', WA_TOKEN: 'ct', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: key, ...body }) }), e, ctx);
const edit = (e, b, tok = TOK) => post(e, '/api/crm/clients/' + tok, { who: 'ops', ...b });
const act = (e, b, tok = TOK) => post(e, '/api/crm/clients/' + tok + '/action', { who: 'ops', ...b });
const clientChanges = async e => (await listChanges(e, { kind: 'client' })).items;

/* ── pure ── */
test('validClientEdit: IL phone, occasion from the list, date ≥ today unless override', () => {
  const T = '2026-11-04';
  assert.deepEqual(validClientEdit({ name1: 'דנה', name2: 'רון', phone: '052-111-2222', occasion: 'bar', event_date: '2026-12-01' }, T).fields, { names: 'דנה ורון', phone: '0521112222', occasion: 'בר מצווה', event_date: '2026-12-01' });
  assert.equal(validClientEdit({ occasion: 'חינה' }, T).fields.occasion, 'חינה', 'the Hebrew label is accepted too');
  assert.equal(validClientEdit({ phone: '12345' }, T).error, 'bad-phone');
  assert.equal(validClientEdit({ phone: '+1 212 555 0101' }, T).error, 'bad-phone');
  assert.equal(validClientEdit({ occasion: 'party' }, T).error, 'bad-occasion');
  assert.equal(validClientEdit({ event_date: '2026-11-03' }, T).error, 'date-in-past');
  assert.equal(validClientEdit({ event_date: '2026-11-03' }, T, { override: true }).fields.event_date, '2026-11-03');
  assert.equal(validClientEdit({ event_date: '04/12/2026' }, T).error, 'bad-date');
  assert.equal(validClientEdit({ name1: '', name2: 'x' }, T).error, 'bad-name');
});
test('clientCellDiff: only fields that differ from the row become cells (phone compared as digits)', () => {
  const row = Array(50).fill(''); row[3] = '0501234567'; row[5] = 'חתונה'; row[6] = '2026-11-20'; row[34] = 'אורי ויצחק';
  const d = clientCellDiff(row, { names: 'אורי ויצחק', phone: '0501234567', occasion: 'חתונה', event_date: '2026-12-01' }, 3);
  assert.deepEqual(d.data, [{ range: 'אירועים!G3', values: [['2026-12-01']] }]);
  assert.deepEqual(d.before, { event_date: '2026-11-20' }); assert.deepEqual(d.after, { event_date: '2026-12-01' });
});

/* ── edit route ── */
test('POST /api/crm/clients/:token writes ONLY the changed cells, updates client: KV + store, logs before/after + Slack', async () => {
  const e = env();
  const r = await edit(e, { name1: 'אורי', name2: 'יצחק', phone: '052-111-2222', occasion: 'wedding', event_date: '2026-12-01' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.ok, true);
  assert.deepEqual(j.changed.sort(), ['event_date', 'phone']);
  const w = sheetWrites(); assert.equal(w.length, 1, 'one batch write');
  assert.deepEqual(w[0], [{ range: 'אירועים!D3', values: [['0521112222']] }, { range: 'אירועים!G3', values: [['2026-12-01']] }], 'row 3 (2nd event), D + G only; C/F/AI untouched');
  assert.equal(e.RATE.m.get('client:972521112222'), '1');
  const ch = await clientChanges(e); assert.equal(ch.length, 1);
  assert.deepEqual(ch[0].details.before, { phone: '0501234567', event_date: '2026-11-20' });
  assert.deepEqual(ch[0].details.after, { phone: '0521112222', event_date: '2026-12-01' });
  assert.ok(slack().some(c => /פרטי לקוח עודכנו/.test(c.body)), 'Slack line');
  const t = await (await worker.fetch(new Request('https://go.ishur.io/api/crm/clients/' + TOK, { headers: { 'X-Admin-Key': 'k' } }), e, ctx)).json();
  assert.ok(t.timeline.some(x => /עריכת פרטים/.test(x.text)), 'timeline shows the edit');
});
test('edit: names change → AI only; nothing changed → no write, no log', async () => {
  const e = env();
  let j = await (await edit(e, { name1: 'אורי', name2: 'דן' })).json();
  assert.deepEqual(sheetWrites()[0], [{ range: 'אירועים!AI3', values: [['אורי ודן']] }]);
  calls = [];
  j = await (await edit(e, { name1: 'אורי', name2: 'יצחק', occasion: 'חתונה' })).json();
  assert.equal(j.unchanged, true); assert.equal(sheetWrites().length, 0);
  assert.equal((await clientChanges(e)).length, 1, 'only the first edit logged');
});
test('edit: validation errors are 400 and write nothing; past date only with override_past; unknown token 404', async () => {
  const e = env();
  for (const [b, err] of [[{ phone: '123' }, 'bad-phone'], [{ occasion: 'מסיבה' }, 'bad-occasion'], [{ event_date: '2026-10-01' }, 'date-in-past'], [{}, 'nothing-to-change']]) {
    const r = await edit(e, b); assert.equal(r.status, 400); assert.equal((await r.json()).error, err);
  }
  assert.equal(sheetWrites().length, 0);
  assert.equal((await (await edit(e, { event_date: '2026-10-01', override_past: true })).json()).ok, true);
  assert.equal((await edit(e, { phone: '0521112222' }, 'e0000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await post(e, '/api/crm/clients/' + TOK, { phone: '0521112222' }, 'bad')).status, 403);
});

/* ── actions ── */
test('actions: without the typed word nothing happens (applied:false + the word); reset asks for the guest count', async () => {
  const e = env();
  for (const a of Object.keys(CLIENT_ACTIONS)) {
    const j = await (await act(e, { action: a, kind: 'design', media: '0123456789abcdef' })).json();
    assert.equal(j.applied, false, a); assert.equal(j.confirm_required, a === 'reset_guests' ? '4' : CLIENT_ACTIONS[a].word, a);
  }
  assert.equal(graph().length + sheetWrites().length, 0); assert.equal((await clientChanges(e)).length, 0);
  assert.equal((await (await act(e, { action: 'nope', confirm: 'x' })).json()).error, 'bad-action');
});
const W = a => CLIENT_ACTIONS[a].word;
test('send_dashboard / send_upload → /api/client-link (Noa, button in window else template); quiet hours refuse', async () => {
  const e = env();
  let j = await (await act(e, { action: 'send_dashboard', confirm: 'שלח' })).json();
  assert.equal(j.ok, true, JSON.stringify(j));
  let g = graph(); assert.ok(g.length >= 1 && g.some(m => JSON.stringify(m).includes('dashboard.html?t=' + TOK)), 'dashboard link sent');
  calls = [];
  j = await (await act(e, { action: 'send_upload', confirm: 'שלח' })).json();
  assert.ok(graph().some(m => JSON.stringify(m).includes('upload.html?t=' + TOK)));
  assert.equal((await clientChanges(e)).length, 2);
  mock.timers.setTime(Date.parse('2026-11-04T22:00:00+02:00'));
  calls = [];
  j = await (await act(e, { action: 'send_dashboard', confirm: 'שלח' })).json();
  assert.equal(j.error, 'quiet-hours'); assert.equal(graph().length, 0);
  mock.timers.setTime(Date.parse('2026-11-04T10:00:00+02:00'));
});
test('hold / unhold → /api/event-flag hold + /api/client-active; cancel → event-flag cancel (AB cell); extra_send → extrasend flag', async () => {
  const e = env();
  assert.equal((await (await act(e, { action: 'hold', confirm: 'hold' })).json()).ok, true);
  assert.ok(e.RATE.m.has('hold:' + TOK)); assert.ok(e.RATE.m.has('inactive:' + TOK));
  assert.equal((await (await act(e, { action: 'hold', confirm: 'hold' })).json()).ok, true, 'second press releases (status is held now)');
  assert.ok(!e.RATE.m.has('hold:' + TOK)); assert.ok(!e.RATE.m.has('inactive:' + TOK));
  calls = [];
  assert.equal((await (await act(e, { action: 'cancel', confirm: 'ביטול' })).json()).ok, true);
  assert.deepEqual(sheetWrites()[0], [{ range: 'אירועים!AB3', values: [['כן']] }]);
  assert.equal((await (await act(e, { action: 'extra_send', confirm: 'שלח' })).json()).ok, true);
  assert.ok(e.RATE.m.has('extrasend:' + TOK));
  const ch = await clientChanges(e); assert.equal(ch.length, 4); assert.ok(ch.every(c => c.kind === 'client' && c.details.token === TOK.slice(0, 8)));
});
test('add_hostess / grant_addon (design, calls, extrasend, guests) → /api/grant-addon; toggle_active → /api/client-active', async () => {
  const e = env({ ['hostess:' + TOK]: JSON.stringify({ n: 1, city: 'חיפה', date: '2026-11-20' }) });
  assert.equal((await (await act(e, { action: 'add_hostess', confirm: 'דיילת' })).json()).ok, true);
  assert.equal(JSON.parse(e.RATE.m.get('hostess:' + TOK)).n, 2); assert.equal(JSON.parse(e.RATE.m.get('hostess:' + TOK)).city, 'חיפה', 'keeps city/date');
  assert.equal((await (await act(e, { action: 'grant_addon', kind: 'design', confirm: 'תוסף' })).json()).ok, true);
  assert.equal(JSON.parse(e.RATE.m.get('design:' + TOK)).status, 'paid');
  await act(e, { action: 'grant_addon', kind: 'calls', confirm: 'תוסף' }); assert.ok(e.RATE.m.has('callsaddon:' + TOK));
  await act(e, { action: 'grant_addon', kind: 'guests', n: 50, confirm: 'תוסף' }); assert.equal(JSON.parse(e.RATE.m.get('addon:' + TOK)).n, 50);
  assert.equal((await (await act(e, { action: 'grant_addon', kind: 'pony', confirm: 'תוסף' })).json()).error, 'bad-kind');
  assert.equal((await (await act(e, { action: 'toggle_active', confirm: 'פעיל' })).json()).ok, true); assert.ok(e.RATE.m.has('inactive:' + TOK));
  assert.equal((await clientChanges(e)).length, 5);
});
test('reset_guests → /api/guests-reset only with the typed count; refused after wave 1 (route rule kept)', async () => {
  const e = env({ 'sheetid:guests': '7' });
  assert.equal((await (await act(e, { action: 'reset_guests', confirm: 'איפוס' })).json()).applied, false);
  const j = await (await act(e, { action: 'reset_guests', confirm: '4' })).json();
  assert.equal(j.ok, true, JSON.stringify(j)); assert.equal(j.result.deleted, 2);
  const e2 = env({ 'sheetid:guests': '7', ['wave:' + TOK + ':1']: '1' });
  const j2 = await (await act(e2, { action: 'reset_guests', confirm: '4' })).json();
  assert.equal(j2.ok, false); assert.equal(j2.error, 'already-sent'); assert.equal((await clientChanges(e2)).length, 0, 'a refused action is not logged');
});
test('invoice_resend → /api/ops/invoice-resend; design_upload → /api/design-version; mark_paid → H cell', async () => {
  const e = env({ ['invoice:' + TOK]: JSON.stringify({ url: 'https://inv.test/1' }), invoicetmpl: 'ishur_heshbonit', ['design:' + TOK]: JSON.stringify({ status: 'paid' }), ['dfile:' + TOK + ':0123456789abcdef']: 'PNG' });
  let j = await (await act(e, { action: 'invoice_resend', confirm: 'חשבונית' })).json();
  assert.equal(j.ok, true, JSON.stringify(j)); assert.ok(graph().some(m => m.template && m.template.name === 'ishur_heshbonit'));
  j = await (await act(e, { action: 'design_upload', media: '0123456789abcdef', confirm: 'עיצוב' })).json();
  assert.equal(j.ok, true, JSON.stringify(j)); assert.equal(JSON.parse(e.RATE.m.get('designflow:' + TOK)).versions.length, 1);
  assert.equal((await (await act(e, { action: 'design_upload', media: 'zz', confirm: 'עיצוב' })).json()).error, 'bad-media');
  calls = [];
  j = await (await act(e, { action: 'mark_paid', on: false, confirm: 'שולם' })).json();
  assert.equal(j.ok, true); assert.deepEqual(sheetWrites()[0], [{ range: 'אירועים!H3', values: [['']] }]);
  assert.equal((await clientChanges(e)).length, 3);
});

/* ── lead drawer: template send outside the 24h window ── */
test('POST /api/crm/leads/:id/send {template} previews, then sends the approved template with [first, occasion]', async () => {
  const e = env();
  const L = await (await post(e, '/api/crm/leads', { phone: '0549998877', name: 'מיכל לוי', occasion: 'bat' })).json();
  let j = await (await post(e, '/api/crm/leads/' + L.lead.id + '/send', { template: 'ishur_lo_siyem' })).json();
  assert.equal(j.preview, true); assert.equal(graph().length, 0);
  j = await (await post(e, '/api/crm/leads/' + L.lead.id + '/send', { template: 'ishur_lo_siyem', confirm: true })).json();
  assert.equal(j.sent, true, JSON.stringify(j));
  const m = graph().find(x => x.template); assert.equal(m.to, '972549998877');
  assert.deepEqual(m.template.components[0].parameters.map(p => p.text), ['מיכל', 'בת מצווה']);
  assert.equal((await (await post(e, '/api/crm/leads/' + L.lead.id + '/send', { template: 'random', confirm: true })).json()).error, 'bad-template');
});
