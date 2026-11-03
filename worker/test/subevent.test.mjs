// node --test worker/test/subevent.test.mjs — 03/11 linked sub-events (שבת חתן)
// Pure parts + the real Worker fetch() with Meta and the sheet stubbed; nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statusFromButton, parseShabbatText, applyShabbatReply, summarizeShabbat, planShabbatSend, shabbatParams, renderBody, routeToSub, SHABBAT_BUTTONS } from '../subevent.js';
import { cleanParam } from '../whatsapp.js';
import worker from '../index.js';

/* ── pure ─────────────────────────────────────────────────────────────── */
test('buttons → status (all three), anything else → ""', () => {
  assert.equal(statusFromButton('מגיע/ה עם לינה'), 'with_stay');
  assert.equal(statusFromButton('מגיע/ה בלי לינה'), 'no_stay');
  assert.equal(statusFromButton('לא מגיע/ה'), 'no');
  assert.equal(statusFromButton('מגיע/ה'), '');
});

test('button → count follow-up: coming buttons ask "כמה תהיו", the number completes it; "לא" never asks', () => {
  for (const [btn, st] of [[SHABBAT_BUTTONS[0], 'with_stay'], [SHABBAT_BUTTONS[1], 'no_stay']]) {
    const a = applyShabbatReply(null, parseShabbatText(btn), btn);
    assert.equal(a.rec.status, st); assert.equal(a.rec.await, 'count'); assert.equal(a.reply, 'איזה כיף! כמה תהיו בסך הכל?');
    const b = applyShabbatReply(a.rec, parseShabbatText('4'), '4');
    assert.equal(b.rec.status, st); assert.equal(b.rec.n, 4); assert.equal(b.rec.await, ''); assert.equal(b.reply, 'מעולה, רשמנו 4 🙏');
  }
  const no = applyShabbatReply(null, parseShabbatText(SHABBAT_BUTTONS[2]), 'x');
  assert.equal(no.rec.status, 'no'); assert.equal(no.rec.await, ''); assert.equal(no.reply, 'תודה שעדכנתם 🙏');
});

test('replies never carry an event or client name (Richard 03/11)', () => {
  const replies = [];
  for (const t of [...SHABBAT_BUTTONS, '3', 'אולי', 'כן', 'בלי לינה, 2']) replies.push(applyShabbatReply(null, parseShabbatText(t) || { n: 3 }, t).reply);
  for (const r of replies) assert.ok(!/של |זגורי|בר מצווה|שבת חתן/.test(r), r);
});

test('free-text parser', () => {
  assert.deepEqual(parseShabbatText('עם לינה, נהיה 4'), { status: 'with_stay', n: 4 });
  assert.deepEqual(parseShabbatText('נגיע עם לינה'), { status: 'with_stay' });
  assert.deepEqual(parseShabbatText('בלי לינה'), { status: 'no_stay' });
  assert.deepEqual(parseShabbatText('ללא לינה 3'), { status: 'no_stay', n: 3 });
  assert.deepEqual(parseShabbatText('לא צריכים לינה'), { status: 'no_stay' });
  assert.deepEqual(parseShabbatText('לא מגיעים'), { status: 'no' });
  assert.deepEqual(parseShabbatText('לצערנו לא נוכל'), { status: 'no' });
  assert.deepEqual(parseShabbatText('אולי'), { status: 'undecided' });
  assert.deepEqual(parseShabbatText('אולי עם לינה'), { status: 'undecided' });
  assert.deepEqual(parseShabbatText('יש מקום ללינה?'), { status: 'undecided' });
  assert.deepEqual(parseShabbatText('3'), { n: 3 });
  assert.deepEqual(parseShabbatText('כן'), { status: 'yes' });
  assert.equal(parseShabbatText('🙂'), null);
  /* "כן" then "עם לינה" — the lodging answer completes, then asks the count */
  const a = applyShabbatReply(null, parseShabbatText('כן'), 'כן');
  assert.equal(a.rec.await, 'stay');
  const b = applyShabbatReply(a.rec, parseShabbatText('עם לינה'), 'עם לינה');
  assert.equal(b.rec.status, 'with_stay'); assert.equal(b.rec.await, 'count');
  /* "3" first, then "בלי לינה" keeps the 3 */
  const c = applyShabbatReply(null, { n: 3 }, '3');
  const d = applyShabbatReply(c.rec, parseShabbatText('בלי לינה'), 'בלי לינה');
  assert.equal(d.rec.status, 'no_stay'); assert.equal(d.rec.n, 3); assert.equal(d.rec.await, '');
});

test('summary math: people vs guests, undecided, no reply; dedup by phone', () => {
  const guests = [1, 2, 3, 4, 5, 6, 6].map(i => ({ phone: '97250000000' + i, name: 'G' + i }));
  const r = { '972500000001': { status: 'with_stay', n: 4 }, '972500000002': { status: 'with_stay', n: 0 }, '972500000003': { status: 'no_stay', n: 2 },
    '972500000004': { status: 'no' }, '972500000005': { status: 'yes' } };
  const { counts } = summarizeShabbat(guests, r);
  assert.deepEqual(counts.with_stay, { guests: 2, people: 5 });   /* n:0 counts as 1 person */
  assert.deepEqual(counts.no_stay, { guests: 1, people: 2 });
  assert.equal(counts.no.guests, 1);
  assert.equal(counts.undecided.guests, 1);   /* "כן" without lodging = undecided */
  assert.equal(counts.no_reply.guests, 1);
  assert.equal(counts.total, 6);
});

test('params: {{1}} = the guest name only; "דנה" → ["דנה"], empty → "אורחים יקרים"', () => {
  assert.deepEqual(shabbatParams({ name: 'דנה' }, cleanParam), ['דנה']);
  assert.deepEqual(shabbatParams({ name: '  דנה \n' }, cleanParam), ['דנה']);
  assert.deepEqual(shabbatParams({ name: '' }, cleanParam), ['אורחים יקרים']);
  assert.equal(renderBody('שלום {{1}}, מוזמנים', ['דנה']), 'שלום דנה, מוזמנים');
});

test('lint: the sub-event send path never reads ev[2] (client name) nor builds an event name', () => {
  const src = readFileSync(new URL('../subevent.js', import.meta.url), 'utf8');
  const send = src.slice(src.indexOf('export async function handleSubeventSend'), src.indexOf('export async function handleSubeventSummary'));
  assert.ok(send.length > 500);
  assert.ok(!/ev\[2\]/.test(send), 'no ev[2]');
  assert.ok(!/ev\[34\]|eventDisplayName|guestEventName|ev\[5\]/.test(send), 'no event name in the send path');
  assert.ok(!/ev\[2\]/.test(src), 'no ev[2] anywhere in subevent.js');
});

test('plan: refusals (hold, cancel, not approved, empty phone, window) and cap/max trimming', () => {
  const rows = [1, 2, 3, 4].map(i => ({ phone: '97250000000' + i, name: 'G' + i }));
  const base = { approved: true, windowOpen: true, held: false, cancelled: false, rows, room: 10, max: 10, dry: false };
  assert.equal(planShabbatSend({ ...base, held: true }).why, 'parent-on-hold');
  assert.equal(planShabbatSend({ ...base, cancelled: true }).why, 'parent-cancelled');
  assert.equal(planShabbatSend({ ...base, approved: false }).why, 'template-not-approved');
  assert.equal(planShabbatSend({ ...base, windowOpen: false }).why, 'send-window-closed');
  const e = planShabbatSend({ ...base, rows: rows.concat({ phone: '', name: 'בלי טלפון' }) });
  assert.equal(e.why, 'guest-rows-with-empty-phone'); assert.deepEqual(e.empty_phone, ['בלי טלפון']);
  /* dry never refuses on approval/phones/window — it shows the plan */
  assert.equal(planShabbatSend({ ...base, approved: false, dry: true }).refuse, false);
  const cap = planShabbatSend({ ...base, room: 2 });
  assert.deepEqual(cap.list.map(x => x.action), ['send', 'send', 'hold', 'hold']);
  assert.equal(cap.list[2].reason, 'held: cap');
  const mx = planShabbatSend({ ...base, max: 3 });
  assert.equal(mx.counts.send, 3); assert.equal(mx.list[3].reason, 'max-reached');
  const again = planShabbatSend({ ...base, sentMarks: new Set(rows.map(r => r.phone)) });
  assert.equal(again.counts.send, 0); assert.equal(again.counts.skip, 4);
});

test('routing: quoted sub message wins; quoted parent message → normal flow; open context → sub', () => {
  assert.equal(routeToSub({ ctxSub: 'S', ctxOther: false, openSub: '', type: 'button' }), 'S');
  assert.equal(routeToSub({ ctxSub: null, ctxOther: true, openSub: 'S', type: 'button' }), '');
  assert.equal(routeToSub({ ctxSub: null, ctxOther: false, openSub: 'S', type: 'text' }), 'S');
  assert.equal(routeToSub({ ctxSub: null, ctxOther: false, openSub: null, type: 'text' }), '');
});

/* ── through the Worker ───────────────────────────────────────────────── */
const PARENT = 'ffb78392-0000-4000-8000-0000000000aa';
const SUB = '5ab5ab5a-0000-4000-8000-0000000000bb';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
let realFetch, sent = [], sheetWrites = [], tplStatus = 'APPROVED', emptyRow = false;
function snapshot() {
  const ev = Array(50).fill(''); ev[1] = PARENT; ev[2] = 'Eleonora'; ev[5] = 'בר מצווה'; ev[6] = ilDay(new Date(Date.now() + 30 * 864e5)); ev[7] = 'כן'; ev[34] = 'יהונתן';
  const g = (n, name) => { const r = Array(31).fill(''); r[28] = PARENT; r[2] = 'G' + n; r[3] = name; r[4] = n ? '050000000' + n : ''; r[15] = ''; return r; };
  const rows = [g(1, 'דנה'), g(2, ''), g(3, 'משה')];
  if (emptyRow) rows.push(g(0, 'בלי טלפון'));
  return { events: { values: [ev] }, guests: { values: rows } };
}
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()), { status: 200 });
    if (u === 'https://hook.test/events') { sheetWrites.push(init.body); return new Response('{}', { status: 200 }); }
    if (/message_templates\?name=/.test(u)) { const name = decodeURIComponent(u.match(/name=([^&]+)/)[1]);
      return new Response(JSON.stringify({ data: [{ name, status: tplStatus, category: 'UTILITY', components: [{ type: 'BODY', text: 'שלום {{1}}, מוזמנים לשבת חתן' }, { type: 'FOOTER', text: 'ishur.io' }, { type: 'BUTTONS', buttons: SHABBAT_BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }] }] })); }
    if (/\/messages$/.test(u)) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: 'wamid.S' + sent.length }] })); }
    return new Response('{}', { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });
const env = () => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events', WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', WA_VERIFY_GUESTS: 'v', GUEST_DAILY_BUDGET: '100',
  RATE: kv({ ['subevent:' + SUB]: JSON.stringify({ parent: PARENT, kind: 'shabbat', template: 'ishur_shabat_hatan_zaguri', name: 'שבת חתן · זגורי', created: 'x' }), ['subevents:' + PARENT]: JSON.stringify([SUB]) }) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify({ admin_key: 'k', ...body }) }), e, ctx).then(r => r.json());
const CLOCK = ['send-window-closed'];

test('dry run: preview with the rendered body for each guest, buttons, nothing sent', async () => {
  sent = []; tplStatus = 'APPROVED'; emptyRow = false;
  const r = await post(env(), '/api/subevent-send', { token: SUB });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.dry, true);
  assert.deepEqual(r.preview.guests.map(g => g.body), ['שלום דנה, מוזמנים לשבת חתן', 'שלום אורחים יקרים, מוזמנים לשבת חתן', 'שלום משה, מוזמנים לשבת חתן']);
  assert.deepEqual(r.preview.buttons, SHABBAT_BUTTONS);
  assert.ok(!JSON.stringify(r).includes('Eleonora'), 'never the client name');
  assert.equal(sent.length, 0);
});

test('real send refuses when the template is not APPROVED', async () => {
  tplStatus = 'PENDING'; sent = [];
  const r = await post(env(), '/api/subevent-send', { token: SUB, dry: false });
  assert.equal(r.ok, false); assert.equal(r.refused, 'template-not-approved'); assert.equal(sent.length, 0);
  tplStatus = 'APPROVED';
});

test('real send refuses on an empty-phone guest row and on a held parent', async () => {
  emptyRow = true; sent = [];
  const r = await post(env(), '/api/subevent-send', { token: SUB, dry: false });
  assert.equal(r.refused, 'guest-rows-with-empty-phone'); assert.deepEqual(r.empty_phone_rows, ['בלי טלפון']);
  emptyRow = false;
  const e = env(); await e.RATE.put('hold:' + PARENT, 'x');
  const h = await post(e, '/api/subevent-send', { token: SUB, dry: false });
  assert.equal(h.refused, 'parent-on-hold'); assert.equal(sent.length, 0);
});

test('real send (stubbed Meta): params exactly [name], idempotent — second run sends 0; button reply → sub RSVP only', async () => {
  sent = []; sheetWrites = []; emptyRow = false;
  const e = env();
  const r = await post(e, '/api/subevent-send', { token: SUB, dry: false });
  if (r.refused) { assert.ok(CLOCK.includes(r.refused), r.refused); console.log('# SKIPPED-BY-CLOCK'); return; }
  assert.equal(r.counts.sent, 3);
  assert.deepEqual(sent.map(b => b.template.components.find(c => c.type === 'body').parameters.map(p => p.text)), [['דנה'], ['אורחים יקרים'], ['משה']]);
  assert.ok(sent.every(b => b.template.name === 'ishur_shabat_hatan_zaguri'));
  const again = await post(e, '/api/subevent-send', { token: SUB, dry: false });
  assert.equal(again.counts.sent, 0); assert.equal(again.counts.skip, 3); assert.equal(sent.length, 3);

  /* guest 1 taps "עם לינה" quoting our message, then writes "4" */
  const hook = (msg) => worker.fetch(new Request('https://go.ishur.io/api/wa-webhook?t=v', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'A' }, contacts: [], messages: [{ from: '972500000001', timestamp: '1', ...msg }] } }] }] }) }), e, ctx);
  const before = sent.length;
  await hook({ id: 'in1', type: 'button', button: { text: 'מגיע/ה עם לינה' }, context: { id: 'wamid.S1' } });
  assert.deepEqual(JSON.parse(e.RATE.m.get(`shrsvp:${SUB}:972500000001`)).status, 'with_stay');
  await hook({ id: 'in2', type: 'text', text: { body: '4' } });
  const rec = JSON.parse(e.RATE.m.get(`shrsvp:${SUB}:972500000001`));
  assert.equal(rec.n, 4); assert.equal(rec.await, '');
  const texts = sent.slice(before).map(b => (b.text && b.text.body) || '');
  assert.deepEqual(texts, ['איזה כיף! כמה תהיו בסך הכל?', 'מעולה, רשמנו 4 🙏']);
  assert.equal(sheetWrites.length, 0, 'the parent RSVP (sheet) is never written');
  assert.ok(!e.RATE.m.has('awaitparty:G1'), 'no parent count nudge armed');

  /* summary (client-safe) */
  const s = await worker.fetch(new Request('https://go.ishur.io/api/subevent-summary?token=' + SUB), e, ctx).then(x => x.json());
  assert.deepEqual(s.subevent.counts.with_stay, { guests: 1, people: 4 });
  assert.equal(s.subevent.counts.no_reply.guests, 2);
  assert.ok(!JSON.stringify(s).includes('97250'), 'no phones in the client summary');
});

test('admin clients view (status view:biz) lists the sub-event linked to its parent; clients.html renders its own row + dashboard link', async () => {
  const { createHash } = await import('node:crypto');
  const ts = String(Date.now()), nonce = 'n' + ts;
  const sig = createHash('sha256').update(`ak|${nonce}|${ts}`).digest('hex');
  const r = await post({ ...env(), APP_KEY: 'ak' }, '/api/status', { view: 'biz', app: 'dash', nonce, stamp_ts: ts, sig });
  assert.ok(Array.isArray(r.subevents), JSON.stringify(r).slice(0, 200));
  assert.deepEqual(r.subevents.map(x => [x.token, x.parent, x.kind_he]), [[SUB, PARENT, 'שבת חתן']]);
  const html = readFileSync(new URL('../../clients.html', import.meta.url), 'utf8');
  assert.ok(/function subRows/.test(html) && /dashboard\.html\?t=' \+ encodeURIComponent\(x\.token\)/.test(html));
});

/* ── 04/11 the pacer half: continueSubevents (no chat session needed) ── */
import { continueSubevents, SUB_SLICE } from '../subevent.js';
function contHarness({ guests = 108, presend = 0, started = true, room = 230, open = true, off = false } = {}) {
  const rows = Array.from({ length: guests }, (_, i) => ({ phone: '9725' + String(10000000 + i), name: 'G' + i }));
  const rec = { parent: PARENT, kind: 'shabbat', template: 'ishur_shabat_hatan_zaguri', name: 'שבת חתן · זגורי', created: 'x', ...(started ? { started_at: '2026-11-03T10:00:00Z' } : {}) };
  const init = { ['subevent:' + SUB]: JSON.stringify(rec) };
  for (let i = 0; i < presend; i++) init[`shsent:${SUB}:${rows[i].phone}`] = '{}';
  const e = { RATE: kv(init) };
  const out = { sends: [], slack: [], changes: [], used: 0 };
  const ev = Array(50).fill(''); ev[1] = PARENT; ev[6] = ilDay(new Date(Date.now() + 30 * 864e5)); ev[7] = 'כן';
  const raw = { events: { values: [ev] }, guests: { values: rows.map(r => { const g = Array(31).fill(''); g[28] = PARENT; g[3] = r.name; g[4] = r.phone; return g; }) } };
  const d = {
    isOff: async (env, id) => off && id === 'subevent_continue', sendWindowState: () => (open ? { open: true } : { open: false, why: 'evening' }), isNoContactDay: () => false, ilDate: () => ilDay(),
    kvPrefix: async (env, prefix) => Object.fromEntries([...env.RATE.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v])),
    guestCapacity: async () => ({ remaining: Math.max(0, room - out.used), limit: room, used: out.used, scope: 'guests' }),
    fetchSnapshot: async () => raw, eventRowOf: (r, t) => r.events.values.find(x => x[1] === t), normPhone: p => String(p), cleanParam: s => s,
    phoneBlocked: async () => false, wrongNum: async () => false, templateDetails: async () => ({ status: 'APPROVED', body: 'שלום {{1}}' }), sendingPaused: async () => false,
    sendTemplate: async (env, to, tpl, params) => { out.sends.push({ to, tpl, params }); out.used++; return { ok: true, id: 'wamid.C' + out.sends.length }; },
    noteGuestSend: async () => {}, logEvent: async () => {},
    recordChange: async (env, x) => { out.changes.push(x); return x; }, slackPost: async (env, t) => { out.slack.push(t); },
  };
  return { e, d, out, rec: () => JSON.parse(e.RATE.m.get('subevent:' + SUB)) };
}

test('pacer: started sub-event with 108 left, cap 230 → 25 per tick … → completes with change-log + Slack', async () => {
  const h = contHarness({ guests: 120, presend: 12 });   /* 12 already sent by hand, 108 left */
  const perTick = [];
  for (let i = 0; i < 8; i++) { const before = h.out.sends.length; await continueSubevents(h.e, h.d); perTick.push(h.out.sends.length - before); if (h.rec().completed_at) break; }
  assert.deepEqual(perTick, [25, 25, 25, 25, 8]);
  assert.equal(SUB_SLICE, 25);
  const r = h.rec();
  assert.ok(r.completed_at, 'completed_at set'); assert.equal(r.completed_sent, 120);
  assert.deepEqual(h.out.slack, ['שבת חתן · זגורי: הושלם, נשלחו 120']);
  assert.equal(h.out.changes.length, 1); assert.equal(h.out.changes[0].kind, 'subevent');
  /* after completion: nothing more, ever */
  const n = h.out.sends.length; await continueSubevents(h.e, h.d); assert.equal(h.out.sends.length, n); assert.equal(h.out.slack.length, 1);
  assert.ok(h.out.sends.every(s => s.tpl === 'ishur_shabat_hatan_zaguri' && s.params.length === 1));
});

test('pacer: cap room 0 → held, nothing sent, not completed', async () => {
  const h = contHarness({ room: 0 });
  const r = await continueSubevents(h.e, h.d);
  assert.equal(h.out.sends.length, 0); assert.equal(r.subs[0].held, 'cap'); assert.ok(!h.rec().completed_at);
  /* small room → slice = room */
  const s = contHarness({ room: 7 }); await continueSubevents(s.e, s.d); assert.equal(s.out.sends.length, 7); assert.ok(!s.rec().completed_at);
});

test('pacer: send window closed → nothing (no reads of guests, no sends)', async () => {
  const h = contHarness({ open: false });
  const r = await continueSubevents(h.e, h.d);
  assert.equal(r.skipped, 'window-closed'); assert.equal(h.out.sends.length, 0);
});

test('pacer: a sub-event never started by hand is never started; kill switch stops a started one', async () => {
  const h = contHarness({ started: false, presend: 0 });
  const r = await continueSubevents(h.e, h.d);
  assert.equal(r.subs[0].skipped, 'not-started'); assert.equal(h.out.sends.length, 0); assert.ok(!h.rec().started_at);
  /* legacy: no started_at but shsent marks exist → it was started → continues */
  const l = contHarness({ started: false, presend: 3, guests: 10 });
  await continueSubevents(l.e, l.d); assert.equal(l.out.sends.length, 7); assert.ok(l.rec().started_at && l.rec().completed_at);
  const k = contHarness({ off: true });
  assert.equal((await continueSubevents(k.e, k.d)).skipped, 'off:subevent_continue'); assert.equal(k.out.sends.length, 0);
});

test('route: the first real /api/subevent-send stamps started_at; a dry run does not', async () => {
  sent = []; emptyRow = false; tplStatus = 'APPROVED';
  const e = env();
  await post(e, '/api/subevent-send', { token: SUB });
  assert.ok(!JSON.parse(e.RATE.m.get('subevent:' + SUB)).started_at, 'dry never starts');
  const r = await post(e, '/api/subevent-send', { token: SUB, dry: false });
  if (r.refused) { assert.ok(CLOCK.includes(r.refused), r.refused); assert.ok(!JSON.parse(e.RATE.m.get('subevent:' + SUB)).started_at); console.log('# SKIPPED-BY-CLOCK'); return; }
  assert.ok(JSON.parse(e.RATE.m.get('subevent:' + SUB)).started_at);
});
