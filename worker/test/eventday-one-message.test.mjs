/* 03/11 (Richard R1-R3): the day-before is never sent on the event day, and
   every guest gets exactly ONE event-day message. Offline: fake KV, fake sheet,
   fake Meta (per-template approval controlled per test). Clock pinned to
   Tuesday 03/11/2026 10:00 IL so the send window is open whatever time the
   suite runs. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { _runDailyEngine, _runEventDayBlasts } from '../index.js';
import { _resetBudgetMemory } from '../whatsapp.js';
import { dayBeforeAllowed, dayBeforeDropped, comboCandidates, comboParams, comboComponents, navTarget, eventDayMessageFor, COMBO } from '../eventday.js';
import { navLinkOk } from '../links.js';
import { projectItems, planCapacity } from '../ops.js';
import { aggregateSendBoard } from '../send-board.js';

const NOW = Date.parse('2026-11-03T08:00:00Z');   /* Tue 10:00 IL */
const TODAY = '2026-11-03', TOMORROW = '2026-11-04';
const OWNER = 'OWNER_SENTINEL_Eleonora';
const TOK = 'abcd1234-1111-4111-8111-111111111111';
const BIT = 'https://www.bitpay.co.il/app/me/ABC';
const NAV = 'https://waze.com/ul?q=Sky&navigate=yes';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m,
    get: async (k, type) => { if (!m.has(k)) return null; const v = m.get(k); return type === 'json' ? JSON.parse(v) : v; },
    put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true }),
    getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) };
}
function eventRow({ token = TOK, date = TODAY, hosts = 'הדר ויצחק' } = {}) {
  const ev = new Array(50).fill('');
  ev[1] = token; ev[2] = OWNER; ev[3] = '0509999999'; ev[5] = 'חתונה'; ev[6] = date; ev[7] = 'כן';
  ev[31] = 'הכל כלול'; ev[34] = hosts; ev[36] = '19:30'; ev[37] = 'יקנעם'; ev[38] = 'אולמי סקיי'; ev[43] = 'כן';
  return ev;
}
function guestRow({ token = TOK, id, name, phone, rsvp = 'מגיע', table = '' }) {
  const g = new Array(31).fill(''); g[2] = id; g[3] = name; g[4] = phone; g[15] = rsvp; g[28] = token; g[30] = table; return g;
}
const DANA = '972501111111', YOSI = '972502222222';
const GUESTS = [guestRow({ id: 'g1', name: 'דנה', phone: '0501111111', table: '7' }), guestRow({ id: 'g2', name: 'יוסי', phone: '0502222222' })];

let sent, snapshot, approved, realFetch;
function installFetch() {
  realFetch = globalThis.fetch; sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (u === 'https://hook.test/status') return json(snapshot);
    const m = u.match(/graph\.facebook\.com\/v\d+\.\d+\/([^/?]+)\/messages$/);
    if (m && init.method === 'POST') { sent.push({ pid: m[1], body: JSON.parse(init.body) }); return json({ messages: [{ id: 'wamid.E' + sent.length }] }); }
    if (/message_templates/.test(u)) {
      const name = decodeURIComponent((u.match(/name=([^&]+)/) || [])[1] || '');
      const ok = approved(name);
      return json({ data: [{ name, status: ok ? 'APPROVED' : 'PENDING', category: 'UTILITY', components: [] }] });
    }
    return json({});
  };
}
const env = (store = {}) => ({ RATE: kv(store), HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events',
  WA_PHONE_ID_GUESTS: 'A', WA_PHONE_IDS_GUESTS: 'B', WA_TOKEN_GUESTS: 't', WA_TOKEN: 'tc', WA_PHONE_ID: 'C', ADMIN_KEY: 'k' });
const guestSends = () => sent.filter(s => s.body.type === 'template' && s.pid !== 'C');
const to = (ph) => guestSends().filter(s => s.body.to === ph);
const paramsOf = (b) => ((((b.template || {}).components || []).find(c => c.type === 'body') || { parameters: [] }).parameters || []).map(p => p.text);
const buttonsOf = (b) => ((b.template || {}).components || []).filter(c => c.type === 'button');
const JOB = JSON.stringify({ at: TODAY, time: '19:30', what: 'החתונה של הדר ויצחק', address: 'אולמי סקיי, יקנעם', nav: NAV, template: 'ishur_yom_haerua' });
const GIFT = JSON.stringify({ on: true, bit: BIT });

beforeEach((t) => { t.mock.timers.enable({ apis: ['Date'], now: NOW }); _resetBudgetMemory(); installFetch(); approved = () => true; });
afterEach((t) => { globalThis.fetch = realFetch; t.mock.timers.reset(); });

/* both event-day paths, in either order, as the pacer runs them */
async function eventDay(e, order = 'engine-first') {
  if (order === 'engine-first') { await _runDailyEngine(e, false, null, { force: true }); await _runEventDayBlasts(e, {}); }
  else { await _runEventDayBlasts(e, {}); await _runDailyEngine(e, false, null, { force: true }); }
}

/* ── R1 ─────────────────────────────────────────────────────────────────── */
test('R1 pure: day-before allowed only at D-1; dropped on and after the event date', () => {
  assert.equal(dayBeforeAllowed(TODAY, TOMORROW), true);
  assert.equal(dayBeforeAllowed(TODAY, TODAY), false);
  assert.equal(dayBeforeAllowed(TODAY, '2026-11-05'), false);
  assert.equal(dayBeforeAllowed(TODAY, '02/11/2026'), false);
  assert.equal(dayBeforeDropped(TODAY, TODAY), true);
  assert.equal(dayBeforeDropped(TODAY, TOMORROW), false);
});

test('R1: day-before on the event day → 0 day-before sends, journal line "יום-לפני דולג — האירוע היום"', async () => {
  snapshot = { events: { values: [eventRow()] }, guests: { values: GUESTS } };
  const e = env();
  const res = await _runDailyEngine(e, false, null, { force: true });
  assert.equal(res.ok, true);
  assert.equal(guestSends().filter(s => /^ishur_yom_lifnei/.test(s.body.template.name)).length, 0);
  const logs = [...e.RATE.m.entries()].filter(([k]) => k.startsWith('evlog:')).map(([, v]) => JSON.parse(v));
  const line = logs.find(l => l.action === 'יום-לפני דולג — האירוע היום');
  assert.ok(line, 'journal line written: ' + logs.map(l => l.action).join(' | '));
  assert.match(line.detail, /2 אורחים/);
  /* written once per event per day */
  await _runDailyEngine(e, false, null, { force: true });
  assert.equal([...e.RATE.m.entries()].filter(([k, v]) => k.startsWith('evlog:') && JSON.parse(v).action === 'יום-לפני דולג — האירוע היום').length, 1);
});

test('R1 sanity: at D-1 the day-before still goes out', async () => {
  snapshot = { events: { values: [eventRow({ date: TOMORROW })] }, guests: { values: GUESTS } };
  await _runDailyEngine(env(), false, null, { force: true });
  assert.equal(guestSends().filter(s => /^ishur_yom_lifnei/.test(s.body.template.name)).length, 2);
});

/* ── R2 ─────────────────────────────────────────────────────────────────── */
test('R2: seating + gifts → each guest gets ONE message; table guest gets combo_tg with guest-safe params and both buttons', async () => {
  for (const order of ['engine-first', 'blast-first']) {
    sent = [];
    snapshot = { events: { values: [eventRow()] }, guests: { values: GUESTS } };
    const e = env({ [`edblast:${TOK}`]: JOB, [`giftlinks:${TOK}`]: GIFT });
    await eventDay(e, order);
    await eventDay(e, order);   /* a second tick sends nothing new */
    assert.equal(to(DANA).length, 1, order + ': Dana got ' + to(DANA).map(s => s.body.template.name));
    assert.equal(to(YOSI).length, 1, order + ': Yosi got ' + to(YOSI).map(s => s.body.template.name));
    const d = to(DANA)[0].body;
    assert.equal(d.template.name, 'ishur_yom_combo_tg');
    assert.deepEqual(paramsOf(d), ['דנה', 'חתונה של הדר ויצחק', '19:30', 'אולמי סקיי, יקנעם', '7']);
    for (const p of paramsOf(d)) assert.ok(!p.includes(OWNER));
    assert.deepEqual(buttonsOf(d).map(b => [b.index, b.parameters[0].text]), [['0', 'abcd1234'], ['1', 'abcd1234']]);
    const y = to(YOSI)[0].body;
    assert.equal(y.template.name, 'ishur_yom_combo_g');
    assert.deepEqual(paramsOf(y), ['יוסי', 'חתונה של הדר ויצחק', '19:30', 'אולמי סקיי, יקנעם']);
    assert.ok(await e.RATE.get(`ed:${TOK}:${DANA}`) && await e.RATE.get(`ed:${TOK}:${YOSI}`));
  }
});

test('R2: hosts cell empty → event name has no "של <client>"', async () => {
  snapshot = { events: { values: [eventRow({ hosts: '' })] }, guests: { values: GUESTS } };
  await eventDay(env({ [`edblast:${TOK}`]: JOB }));
  assert.equal(to(DANA)[0].body.template.name, 'ishur_yom_combo_t');
  assert.equal(paramsOf(to(DANA)[0].body)[1], 'חתונה');
  assert.equal(buttonsOf(to(DANA)[0].body).length, 1, 'combo_t has the nav button only');
});

test('R2 pure: richest variant first, a table guest never falls to combo_g', () => {
  assert.deepEqual(comboCandidates({ hasTable: true, giftOn: true }), [COMBO.tg, COMBO.t]);
  assert.deepEqual(comboCandidates({ hasTable: false, giftOn: true }), [COMBO.g]);
  assert.deepEqual(comboCandidates({ hasTable: true, giftOn: false }), [COMBO.t]);
  assert.deepEqual(comboCandidates({ hasTable: false, giftOn: false }), []);
  assert.equal(comboParams(COMBO.g, { guestName: 'a', eventName: 'b', time: 'c', address: 'd', table: '9' }).length, 4);
  assert.equal(comboComponents(COMBO.tg, TOK).length, 2);
});

test('R2: tg pending, t approved → table guest still gets ONE message (combo_t)', async () => {
  approved = (n) => n !== 'ishur_yom_combo_tg';
  snapshot = { events: { values: [eventRow()] }, guests: { values: GUESTS } };
  await eventDay(env({ [`edblast:${TOK}`]: JOB, [`giftlinks:${TOK}`]: GIFT }));
  assert.deepEqual(to(DANA).map(s => s.body.template.name), ['ishur_yom_combo_t']);
});

/* ── fallback ───────────────────────────────────────────────────────────── */
test('fallback: no combo approved → today\'s templates, still one per guest; combo approved mid-day sends nothing again', async () => {
  for (const order of ['engine-first', 'blast-first']) {
    sent = [];
    approved = (n) => !/^ishur_yom_combo/.test(n);
    snapshot = { events: { values: [eventRow()] }, guests: { values: GUESTS } };
    const e = env({ [`edblast:${TOK}`]: JOB });
    await eventDay(e, order);
    assert.deepEqual(to(DANA).map(s => s.body.template.name), ['ishur_shulchan'], order);
    assert.deepEqual(paramsOf(to(DANA)[0].body), ['דנה', 'חתונה של הדר ויצחק', '7']);
    assert.deepEqual(to(YOSI).map(s => s.body.template.name), ['ishur_yom_haerua'], order);
    /* Meta approves the combos at noon; the 10-min template cache expires */
    approved = () => true;
    for (const k of [...e.RATE.m.keys()]) if (k.startsWith('tmplinfo:') || k.startsWith('tmplok:')) e.RATE.m.delete(k);
    await e.RATE.put(`edblast:${TOK}`, JOB);   /* even if the job were set again */
    await e.RATE.delete('seat:' + TOK);         /* and the table stage reopened */
    await eventDay(e, order);
    assert.equal(to(DANA).length, 1, order + ': Dana got ' + to(DANA).map(s => s.body.template.name));
    assert.equal(to(YOSI).length, 1, order + ': Yosi got ' + to(YOSI).map(s => s.body.template.name));
  }
});

/* ── the mark ───────────────────────────────────────────────────────────── */
test('ed:<token>:<phone> blocks every other event-day path that day', async () => {
  snapshot = { events: { values: [eventRow()] }, guests: { values: GUESTS } };
  const e = env({ [`edblast:${TOK}`]: JOB, [`giftlinks:${TOK}`]: GIFT, [`ed:${TOK}:${DANA}`]: 'ishur_shulchan', [`ed:${TOK}:${YOSI}`]: 'eventday' });
  await eventDay(e);
  assert.equal(guestSends().length, 0, guestSends().map(s => s.body.template.name).join(','));
});

test('a failed send releases the claim (the guest is retried, not lost)', async () => {
  snapshot = { events: { values: [eventRow()] }, guests: { values: GUESTS } };
  const e = env({ [`edblast:${TOK}`]: JOB });
  const ok = globalThis.fetch;
  globalThis.fetch = async (url, init) => /\/messages$/.test(String(url)) && init.method === 'POST'
    ? new Response(JSON.stringify({ error: { code: 131000, message: 'boom' } }), { status: 400 }) : ok(url, init);
  await eventDay(e);
  assert.equal(await e.RATE.get(`ed:${TOK}:${DANA}`), null);
  assert.equal(await e.RATE.get(`ed:${TOK}:${YOSI}`), null);
});

test('resolver: no address → legacy (never an empty variable)', async () => {
  const ev = eventRow(); ev[37] = ''; ev[38] = '';
  const r = await eventDayMessageFor({}, ev, { phone: DANA, name: 'דנה', table: '7' }, { comboUsable: async () => true, giftOn: async () => true, guestEventName: () => 'x' });
  assert.equal(r.kind, 'legacy'); assert.equal(r.why, 'no-address');
});

/* ── planner / send-board ───────────────────────────────────────────────── */
test('planner: on the event day the day-before is "dropped", not planned; a Saturday D-1 is dropped too', () => {
  const g = (phone, rsvp, table = '') => ({ phone, rsvp, table, name: '', id: '' });
  const events = [{ token: TOK, name: 'A', date: TODAY, plan: 'pro', waves: {} }, { token: 'eeee5555-0', name: 'B', date: '2026-11-08', plan: 'pro', waves: {} }];
  const guests = { [TOK]: [g('1', 'מגיע', '7'), g('2', 'מגיע')], 'eeee5555-0': [g('3', 'מגיע')] };
  const items = projectItems({ events, guests, flags: { [TOK]: { eventday: { at: TODAY } } }, today: TODAY, days: 7 });
  const db = items.filter(i => i.type === 'daybefore');
  assert.deepEqual(db.map(i => [i.tok8, i.day, i.count, !!i.dropped]), [['abcd1234', TODAY, 2, true], ['eeee5555', '2026-11-08', 1, true]]);
  /* one event-day message per guest: table guest under table, the other under eventday */
  assert.equal(items.find(i => i.type === 'table').count, 1);
  assert.equal(items.find(i => i.type === 'eventday').count, 1);
  const p = planCapacity({ today: TODAY, days: 7, items, model: { capacity_per_day: 230, today_remaining: 230 } });
  const row = p.days.find(d => d.day === TODAY);
  assert.equal(row.planned, 2); assert.equal(row.dropped, 2);
  assert.ok(row.by_event.some(x => x.type === 'daybefore' && x.status === 'dropped'));
});

test('send-board: day-before not sent by the event day shows as dropped, not pending', () => {
  const ev = { token: TOK, name: 'א', date: TODAY, plan: 'premium', waves: { 1: '', 2: '', 3: '' }, held: false, eventday: null };
  const guests = { [TOK]: [{ name: 'דנה', phone: DANA, rsvp: 'מגיע', table: '7' }, { name: 'יוסי', phone: YOSI, rsvp: 'מגיע', table: '' }] };
  const markers = { [`${TOK}|daybefore|${DANA}`]: { m: '1', wst: 'delivered' }, [`${TOK}|daybefore|${YOSI}`]: { m: null } };
  const b = aggregateSendBoard({ today: TODAY, events: [ev], guests, markers, gates: { window: { open: true } } });
  const row = b.events[0].types.find(t => t.key === 'daybefore');
  assert.equal(row.dropped, 1); assert.equal(row.pending.total, 0); assert.equal(row.delivered, 1);
  assert.equal(row.people.dropped[0].phone, YOSI);
  /* the day before, the same guest is pending (queue) */
  const b2 = aggregateSendBoard({ today: '2026-11-02', events: [ev], guests, markers, gates: { window: { open: true } } });
  const r2 = b2.events[0].types.find(t => t.key === 'daybefore');
  assert.equal(r2.dropped, 0); assert.equal(r2.pending.queue, 1);
});

/* ── /nav/<slug> ────────────────────────────────────────────────────────── */
test('GET /nav/<slug> → 302 to the validated nav link, else a Waze search of the venue', async () => {
  snapshot = { events: { values: [eventRow()] }, guests: { values: [] } };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const r1 = await worker.fetch(new Request('https://go.ishur.io/nav/abcd1234'), env({ ['navlink:' + TOK]: NAV }), ctx);
  assert.equal(r1.status, 302); assert.equal(r1.headers.get('Location'), NAV);
  const r2 = await worker.fetch(new Request('https://go.ishur.io/nav/abcd1234'), env({ ['navlink:' + TOK]: 'https://waze.com.evil.example/x' }), ctx);
  assert.equal(r2.headers.get('Location'), 'https://waze.com/ul?q=' + encodeURIComponent('אולמי סקיי, יקנעם') + '&navigate=yes');
  const r3 = await worker.fetch(new Request('https://go.ishur.io/nav/zzzz'), env(), ctx);
  assert.equal(r3.headers.get('Location'), 'https://ishur.io/');
  assert.equal(navTarget({ navlink: '', jobNav: '', venue: '' }, navLinkOk), '');
});
