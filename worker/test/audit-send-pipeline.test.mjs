/* 02/11/2026 send-pipeline audit — regression tests for every fix in
   docs/AUDIT-SEND-PIPELINE-2026-11-02.md. Offline: a fake KV, a fake sheet
   snapshot and a fake Meta Graph API stand in for the real ones. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanParam, sendTemplate, sendText, parseInboundReply, partyFromText, isQuestion, guestIntent,
  pickGuestPhone, guestBudgetLeft, noteGuestTemplate, guestPortfolioBudget, _resetBudgetMemory,
} from '../whatsapp.js';
import { navLinkOk, giftLinkOk } from '../links.js';
import worker, { guestEventName, eventDisplayName, _runDailyEngine, _lateInvite, _eventDayRecipients, _runEventDayBlasts } from '../index.js';

/* ── fakes ─────────────────────────────────────────────────────────────── */
function kv(init = {}, { failPutsOn = null } = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: async (k, type) => { if (!m.has(k)) return null; const v = m.get(k); return type === 'json' ? JSON.parse(v) : v; },
    put: async (k, v) => { if (failPutsOn && failPutsOn.test(k)) throw new Error('KV PUT failed: 429 Too Many Requests'); m.set(k, String(v)); },
    delete: async k => { m.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true }),
    getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }),
  };
}
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const plusDays = (n) => ilDay(new Date(Date.now() + n * 86400e3));
const OWNER = 'OWNER_SENTINEL_Eleonora';

let sent = [];          // every Graph /messages POST: { pid, body }
let realFetch;
let snapshot = null;
function installFetch() {
  realFetch = globalThis.fetch;
  sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (u === 'https://hook.test/status') return json(snapshot);
    const m = u.match(/graph\.facebook\.com\/v\d+\.\d+\/([^/?]+)\/messages$/);
    if (m && init.method === 'POST') { const body = JSON.parse(init.body); sent.push({ pid: m[1], body }); return json({ messages: [{ id: 'wamid.T' + sent.length }] }); }
    if (/message_templates/.test(u)) { const name = (u.match(/name=([^&]+)/) || [])[1] || ''; return json({ data: [{ name: decodeURIComponent(name), status: 'APPROVED', category: 'UTILITY', components: [] }] }); }
    return json({});
  };
}
function baseEnv(store = {}, opts) {
  return { RATE: kv(store, opts), HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events',
    WA_PHONE_ID_GUESTS: 'A', WA_PHONE_IDS_GUESTS: 'B', WA_TOKEN_GUESTS: 't', WA_TOKEN: 'tc', WA_PHONE_ID: 'C' };
}
const paramsOf = (b) => ((((b.template || {}).components || []).find(c => c.type === 'body') || { parameters: [] }).parameters || []).map(p => p.text);
beforeEach(() => { _resetBudgetMemory(); installFetch(); });
afterEach(() => { globalThis.fetch = realFetch; });

/* ── P0: template variables Meta would refuse ──────────────────────────── */
test('cleanParam: no newline/tab, no 5+ spaces, no stray edge quote, capped', () => {
  assert.equal(cleanParam('אולמי\nהגן\t הקסום'), 'אולמי הגן הקסום');
  assert.equal(cleanParam('a     b'), 'a b');
  assert.equal(cleanParam('"הבוטח'), 'הבוטח');
  assert.equal(cleanParam('מתחם ״סופיה״'), 'מתחם ״סופיה״');
  assert.equal(cleanParam('"גן" עדן'), '"גן" עדן');
  assert.equal(cleanParam('x'.repeat(500)).length, 300);
  assert.equal(cleanParam(null), '');
});

test('sendTemplate cleans every variable before Meta sees it', async () => {
  const env = baseEnv();
  const r = await sendTemplate(env, '0501234567', 'ishur_yom_lifnei', ['דנה\nכהן', 'החתונה', '02.11.2026', '19:30', 'אולם\r\nהגן'], '', 'he', 'guests');
  assert.equal(r.ok, true);
  assert.deepEqual(paramsOf(sent[0].body), ['דנה כהן', 'החתונה', '02.11.2026', '19:30', 'אולם הגן']);
});

test('sendTemplate refuses an empty variable without calling Meta (permanent, not a retry loop)', async () => {
  const env = baseEnv();
  const r = await sendTemplate(env, '0501234567', 'ishur_shulchan', ['דנה', '  ', '7'], '', 'he', 'guests');
  assert.equal(r.ok, false); assert.equal(r.permanent, true); assert.match(r.error, /empty-param:\{\{2\}\}/);
  assert.equal(sent.length, 0);
});

/* ── P0: names — no guest message may carry the paying client's name ───── */
test('guestEventName never falls back to the client (column C)', () => {
  const ev = []; ev[2] = OWNER; ev[5] = 'חתונה';
  assert.equal(guestEventName(ev), 'החתונה');
  assert.equal(guestEventName(ev, { article: false }), 'חתונה');
  ev[34] = 'הדר ויצחק';
  assert.equal(guestEventName(ev), 'החתונה של הדר ויצחק');
  assert.equal(guestEventName(ev, { article: false }), 'חתונה של הדר ויצחק');
  const bare = []; bare[2] = OWNER;
  assert.equal(guestEventName(bare), 'האירוע');
  /* the client-facing one keeps its contract (event-name.test.mjs) */
  assert.ok(eventDisplayName(bare).includes(OWNER));
});

test('lint: guest-facing builders never read the client name (ev[2] / c(2)) into a guest message', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const body = (name) => { const i = src.indexOf('async function ' + name + '('); assert.ok(i >= 0, name); const j = src.indexOf('\n}\n', i); return src.slice(i, j); };
  for (const fn of ['sendWave', 'resendInvitation', 'lateInvite', 'runEventDayBlasts']) {
    const b = body(fn);
    assert.ok(!/ev\[34\]\s*\|\|\s*ev\[2\]/.test(b), `${fn}: ev[34] || ev[2] reaches a guest`);
    assert.ok(!/eventDisplayName\(/.test(b), `${fn}: use guestEventName/eventHosts`);
  }
  const ft = body('guestFreeText');
  const sayLines = ft.split('\n').filter(l => /await say\(/.test(l));
  assert.ok(sayLines.length > 5);
  for (const l of sayLines) assert.ok(!/c\(2\)|ev\[2\]|eventDisplayName\(/.test(l), 'guest reply uses the client name: ' + l.trim().slice(0, 120));
  /* inside the engine, every guest-channel template takes a guest-safe name */
  const eng = body('runDailyEngine');
  for (const l of eng.split('\n').filter(x => /sendTemplate\(/.test(x) && /'guests'/.test(x))) {
    assert.ok(!/\bname\b\s*[,\]]/.test(l.replace(/name: gname/g, '')), 'engine guest send passes `name`: ' + l.trim().slice(0, 140));
  }
});

/* end to end: the whole daily engine against a fake sheet, every outgoing
   guest message inspected. Hosts cell empty on purpose for two events. */
function eventRow({ token, date, hosts = '', occasion = 'חתונה', plan = 'הכל כלול', cancelled = '', w1 = '' }) {
  const ev = new Array(50).fill('');
  ev[1] = token; ev[2] = OWNER; ev[3] = '0509999999'; ev[5] = occasion; ev[6] = date; ev[7] = 'כן';
  ev[27] = cancelled; ev[31] = plan; ev[34] = hosts; ev[36] = '19:30'; ev[37] = 'יקנעם'; ev[38] = 'אולמי סקיי'; ev[39] = w1; ev[43] = 'כן';
  return ev;
}
function guestRow({ token, id, name, phone, rsvp = '', table = '' }) {
  const g = new Array(31).fill(''); g[2] = id; g[3] = name; g[4] = phone; g[15] = rsvp; g[28] = token; g[30] = table; return g;
}
const T = { today: '11111111-1111-4111-8111-111111111111', yest: '22222222-2222-4222-8222-222222222222', canc: '33333333-3333-4333-8333-333333333333', wave: '44444444-4444-4444-8444-444444444444', moved: '55555555-5555-4555-8555-555555555555', tom: '66666666-6666-4666-8666-666666666666' };

async function runEngine(extraStore = {}, { tomorrow = false } = {}) {
  snapshot = {
    events: { values: [
      eventRow({ token: T.today, date: ilDay() }),
      eventRow({ token: T.yest, date: plusDays(-1), hosts: 'הדר ויצחק' }),
      eventRow({ token: T.canc, date: plusDays(10), hosts: 'רון ושיר', cancelled: 'כן' }),
      eventRow({ token: T.wave, date: plusDays(10), w1: ilDay() }),
      eventRow({ token: T.moved, date: plusDays(12), hosts: 'נועה ויונתן' }),
      ...(tomorrow ? [eventRow({ token: T.tom, date: plusDays(1), hosts: 'טל ועומר' })] : []),
    ] },
    guests: { values: [
      guestRow({ token: T.today, id: 'g1', name: 'דנה', phone: '0501111111', rsvp: 'מגיע', table: '7' }),
      guestRow({ token: T.today, id: 'g2', name: 'יוסי', phone: '0502222222', rsvp: 'מגיע' }),
      guestRow({ token: T.yest, id: 'g3', name: 'מיכל', phone: '0503333333', rsvp: 'מגיע' }),
      guestRow({ token: T.canc, id: 'g4', name: 'אבי', phone: '0504444444' }),
      guestRow({ token: T.wave, id: 'g5', name: 'רותי', phone: '0505555555' }),
      guestRow({ token: T.moved, id: 'g6', name: 'שגיא', phone: '0506666666' }),
      ...(tomorrow ? [guestRow({ token: T.tom, id: 'g7', name: 'ליאת', phone: '0507777777', rsvp: 'מגיע' })] : []),
    ] },
  };
  const env = baseEnv({
    [`wave:${T.canc}:1`]: ilDay(), [`wave:${T.today}:1`]: ilDay(), [`wave:${T.moved}:1`]: ilDay(),
    [`sentdate:${T.moved}`]: plusDays(5),          /* the sheet date moved 5 → 12 days out */
    ...extraStore,
  });
  const res = await _runDailyEngine(env, false, null, { force: true });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 300));
  return { env, res, out: sent.filter(s => s.body.type === 'template' && s.pid !== 'C') };
}

test('engine e2e: no guest template carries the client name; table has no double article', async () => {
  const { out } = await runEngine();
  if (process.env.AUDIT_PEEK) for (const s of out) console.log('SEND', s.pid, s.body.to, s.body.template.name, JSON.stringify(paramsOf(s.body)));
  /* 03/11 R1: was >= 5 — two of those were the day-before reminder sent ON the
     event day (T.today), which Richard's rule now forbids */
  assert.ok(out.length >= 4, 'expected several guest sends, got ' + out.length);
  for (const s of out) {
    for (const p of paramsOf(s.body)) {
      assert.ok(!p.includes(OWNER), `${s.body.template.name} → ${s.body.to}: "${p}"`);
      assert.ok(!/\n/.test(p));
    }
  }
  /* 03/11 R2: the fake Meta approves every name, so the table guest gets the combo (same ב{{2}} slot) */
  /* 08/11: no nav link in this fixture → the no-nav family (ishur_yom_plain_t) */
  const table = out.find(s => /^ishur_shulchan|^ishur_yom_(combo|plain)_t/.test(s.body.template.name));
  assert.ok(table, 'table message sent');
  assert.equal(paramsOf(table.body)[1], 'חתונה', 'ב{{2}} → "בחתונה", never "בהחתונה" or "של <client>"');
  const thanks = out.find(s => /^ishur_toda_orach/.test(s.body.template.name));
  assert.equal(paramsOf(thanks.body)[1], 'החתונה של הדר ויצחק');
  const inv = out.find(s => s.body.to === '972505555555');
  assert.ok(inv, 'wave 1 invitation sent');
  assert.equal(paramsOf(inv.body)[2], 'בעלי השמחה', 'empty hosts → generic, not the client');
});

test('engine e2e: a sheet date edit alone does NOT send "postponed" to guests', async () => {
  const { out } = await runEngine();
  assert.equal(out.filter(s => /^ishur_dchiya/.test(s.body.template.name)).length, 0);
});

test('engine e2e: an explicit postponeok for the new date does send it, once per guest', async () => {
  const { out } = await runEngine({ [`postponeok:${T.moved}`]: plusDays(12) });
  const d = out.filter(s => /^ishur_dchiya/.test(s.body.template.name));
  assert.equal(d.length, 1);
  assert.equal(d[0].body.to, '972506666666');
});

test('engine e2e: day-before closes its flag after a clean pass (the else-binding bug)', async () => {
  /* 03/11 R1: the day-before now runs only at D-1, so this uses an event dated
     tomorrow (it used T.today, i.e. a day-before sent on the event day) */
  const { env } = await runEngine({}, { tomorrow: true });
  assert.ok(await env.RATE.get('daybefore:' + T.tom), 'daybefore flag must close when every send succeeded');
});

test('engine e2e: window closed + no force → nothing goes to guests or clients', async () => {
  /* run the real gate: force off. If the test happens to run inside the
     window, the gate is open and this test only checks it does not throw. */
  snapshot = { events: { values: [eventRow({ token: T.today, date: ilDay() })] }, guests: { values: [guestRow({ token: T.today, id: 'g1', name: 'דנה', phone: '0501111111', rsvp: 'מגיע', table: '7' })] } };
  const { sendWindowState } = await import('../shir.js');
  const env = baseEnv();
  const res = await _runDailyEngine(env, false, null, {});
  if (!sendWindowState().open) assert.equal(sent.length, 0, 'sent outside the window');
  assert.ok(res.ok !== undefined);
});

/* ── P1: budget ────────────────────────────────────────────────────────── */
const day = ilDay();
/* integration 02/11: the rolling window lives in budget.js hourly buckets
   gsendh:<pid>:<epoch hour> (feat-gifts-sendboard), not gsend24:<pid> JSON */
const hourAgo = (h) => Math.floor((Date.now() - h * 3600e3) / 3600e3);
const bucket = (pid, h, n) => ({ [`gsendh:${pid}:${hourAgo(h)}`]: String(n) });

test('budget is rolling 24h: yesterday-evening sends still count after midnight', async () => {
  /* no gsend:<id>:<today> keys at all — the calendar-day counter says 0 */
  /* per-number model (GUEST_CAP_SCOPE=number, margin 0): the original assertions */
  const perNum = { ...baseEnv({ ...bucket('A', 10, 230), ...bucket('B', 2, 10) }), GUEST_CAP_SCOPE: 'number', GUEST_BUDGET_MARGIN: '0' };
  assert.equal(await pickGuestPhone(perNum), 'B');
  assert.equal(await guestBudgetLeft(perNum), 220);
  /* shared default (250 − margin 20 = 230 for both numbers together) */
  const shared = baseEnv({ ...bucket('A', 10, 200), ...bucket('B', 2, 10) });
  assert.equal(await pickGuestPhone(shared), 'B');
  assert.equal(await guestBudgetLeft(shared), 20, '230 − 210 still inside the rolling 24h');
});

test('buckets older than 24h no longer count', async () => {
  const env = baseEnv({ ...bucket('A', 30, 230) });
  assert.equal(await pickGuestPhone(env), 'A');
  assert.equal(await guestBudgetLeft(env), 230);
});

test('portfolio cap (GUEST_PORTFOLIO_BUDGET) holds across both numbers', async () => {
  const env = { ...baseEnv({ [`gsend:A:${day}`]: '120', [`gsend:B:${day}`]: '110' }), GUEST_PORTFOLIO_BUDGET: '230' };
  assert.equal(guestPortfolioBudget(env), 230);
  assert.equal(await pickGuestPhone(env), '');
  assert.equal(await guestBudgetLeft(env), 0);
});

/* integration 02/11: Richard decided (D1) — one shared portfolio limit, 250
   by default, minus the margin of 20 → 230 for all guest numbers together.
   The per-number sum (230 × numbers = 460) is still reachable explicitly. */
test('default portfolio cap = one shared 250, margin 20 → 230 combined; per-number sum only with GUEST_CAP_SCOPE=number', async () => {
  assert.equal(guestPortfolioBudget(baseEnv()), 250);
  assert.equal(await guestBudgetLeft(baseEnv()), 230);
  assert.equal(await guestBudgetLeft({ ...baseEnv(), GUEST_CAP_SCOPE: 'number', GUEST_BUDGET_MARGIN: '0' }), 460);
});

test('unique recipients: a second template to the same guest in 24h is not a second slot', async () => {
  const env = baseEnv();
  assert.equal(await noteGuestTemplate(env, 'A', '0501111111'), true);
  assert.equal(await noteGuestTemplate(env, 'A', '0501111111'), false);
  assert.equal(await env.RATE.get(`gsend:A:${day}`), '1');
});

test('KV write rejections (1 write/sec/key) do not make the counter forget sends in this isolate', async () => {
  const env = { ...baseEnv({}, { failPutsOn: /^gsend/ }), GUEST_DAILY_BUDGET: '3' };
  for (const p of ['0501', '0502', '0503']) await noteGuestTemplate(env, 'A', p);
  /* A spent its 3 even though no gsend write landed */
  assert.equal(await pickGuestPhone(env), 'B');
});

test('budget out → template held (no Meta call); a free-form reply still goes, from the number the guest wrote to', async () => {
  const env = { ...baseEnv({ [`gsend:A:${day}`]: '230', [`gsend:B:${day}`]: '230', 'gph:972501111111': 'B' }) };
  const t = await sendTemplate(env, '0501111111', 'ishur_yom_lifnei', ['a', 'b', 'c', 'd', 'e'], '', 'he', 'guests');
  assert.equal(t.ok, false); assert.equal(t.held, true);
  assert.equal(sent.length, 0);
  const r = await sendText(env, '0501111111', 'הכתובת: אולמי סקיי', 'guests');
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].pid, 'B');
});

test('a reply with no inbound pin falls back to the main number, never blocked by budget', async () => {
  const env = baseEnv({ [`gsend:A:${day}`]: '999', [`gsend:B:${day}`]: '999' });
  const r = await sendText(env, '0507777777', 'שלום', 'guests');
  assert.equal(r.ok, true); assert.equal(sent[0].pid, 'A');
});

/* ── P0: the inbound parser must not write a wrong status ──────────────── */
const P = (text) => parseInboundReply({ type: 'text', text: { body: text } });
test('parser: "בטח שלא" / "אשמח לדעת…" are not a yes', () => {
  assert.notEqual(P('בטח שלא').outcome, 'מגיע');
  assert.notEqual(P('אשמח לדעת מה הכתובת').outcome, 'מגיע');
  assert.notEqual(P('אשמח אבל לא נוכל').outcome, 'מגיע');
  assert.equal(P('אשמח להגיע').outcome, 'מגיע');
  assert.equal(P('בטח!').outcome, 'מגיע');
  /* a yes-word with a negation later goes to the free-text reader, which says no */
  assert.notEqual(P('כן, לא נוכל להגיע בסוף').outcome, 'מגיע');
  assert.equal(guestIntent('כן, לא נוכל להגיע בסוף'), 'no');
});
test('parser: a time or a date is not a head count', () => {
  assert.equal(P('מגיעים ב-19:30').party, undefined);
  assert.equal(P('מגיעים 2').party, 2);
  assert.equal(P('כן, נהיה 3').party, 3);
  assert.equal(P('מגיע/ה').outcome, 'מגיע');
  assert.equal(P('מגיעים 0').party, undefined);
});
test('partyFromText ignores times, dates, phones, "בשעה 8"', () => {
  assert.equal(partyFromText('נגיע בסביבות 20:00'), null);
  assert.equal(partyFromText('החתונה ב-5/11?'), null);
  assert.equal(partyFromText('בשעה 8 נגיע'), null);
  assert.equal(partyFromText('התקשרו ל-0501234567'), null);
  assert.equal(partyFromText('אנחנו 4'), 4);
  assert.equal(partyFromText('נהיה שלושה'), 3);
  assert.equal(partyFromText('שניים'), 2);
  assert.equal(partyFromText('5'), 5);
});
test('questions are recognised (never read as an RSVP count)', () => {
  assert.equal(isQuestion('באיזו שעה מתחיל? 19:30?'), true);
  assert.equal(isQuestion('מתי זה'), true);
  assert.equal(isQuestion('נגיע 3'), false);
  assert.equal(guestIntent('לא יודע, אולי 2'), 'unsure');
});

test('lint: guestFreeText has no free `ch` (it threw ReferenceError after writing מגיע)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function guestFreeText('); const j = src.indexOf('\n}\n', i);
  const b = src.slice(i, j).replace(/sendCh/g, '');
  assert.ok(!/[(,\s]ch[),\s]/.test(b), 'guestFreeText references `ch`');
});

/* ── P1: links that reach guests ───────────────────────────────────────── */
test('navigation links: exact hostnames, https, no user@host tricks', () => {
  for (const ok of ['https://waze.com/ul/hsv8xyz', 'https://ul.waze.com/ul?ll=32.1,34.8', 'https://www.waze.com/he/live-map', 'https://maps.app.goo.gl/AbC123', 'https://goo.gl/maps/xyz', 'https://www.google.com/maps/place/x', 'https://maps.google.com/?q=x', 'https://www.google.co.il/maps/@32,34'])
    assert.equal(navLinkOk(ok), true, ok);
  for (const bad of ['https://waze.com.evil.example/x', 'https://waze.com@evil.example/x', 'http://waze.com/ul/x', 'https://evil.example/waze.com', 'https://goo.gl/abc', 'https://www.google.com/search?q=x', 'https://waze.com/ul x', 'javascript:alert(1)', ''])
    assert.equal(navLinkOk(bad), false, bad);
});
test('gift links: Bit / PayBox hostnames only, https, no spaces', () => {
  assert.equal(giftLinkOk('https://www.bitpay.co.il/app/me/ABC'), true);
  assert.equal(giftLinkOk('https://links.payboxapp.com/xyz'), true);
  assert.equal(giftLinkOk('http://links.payboxapp.com/xyz'), false);
  assert.equal(giftLinkOk('https://payboxapp.com.evil.example/x'), false);
  assert.equal(giftLinkOk('https://bit.co.il@evil.example/'), false);
});

/* ── P1: late guest added from the dashboard ───────────────────────────── */
test('late invitation outside the window is queued, not sent at night', async () => {
  const { sendWindowState } = await import('../shir.js');
  const ev = eventRow({ token: T.wave, date: plusDays(10), hosts: 'רון ושיר' });
  const env = baseEnv({ [`wave:${T.wave}:1`]: ilDay() });
  const r = await _lateInvite(env, ev, T.wave, 'דני', '0508888888');
  if (sendWindowState().open) {
    assert.equal(r.sent, true); assert.equal(paramsOf(sent[0].body)[2], 'רון ושיר');
    assert.ok(await env.RATE.get(`wsent:${T.wave}:1:972508888888`));
  } else {
    assert.equal(r.sent, false); assert.match(r.why, /^queued:/);
    assert.equal(sent.length, 0);
    assert.ok(await env.RATE.get(`lateinv:${T.wave}:972508888888`));
  }
});
/* the same two gates with the clock pinned to Monday 02/11/2026 23:30 IL
   (21:30 UTC) — deterministic, whatever time the suite runs */
test('clock at 23:30 IL: engine sends nothing, a late invitation is queued', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T21:30:00Z') });
  try {
    const ev = eventRow({ token: T.wave, date: '2026-11-12', hosts: 'רון ושיר' });
    const env = baseEnv({ [`wave:${T.wave}:1`]: '2026-11-01' });
    const r = await _lateInvite(env, ev, T.wave, 'דני', '0508888888');
    assert.equal(r.sent, false); assert.equal(r.why, 'queued:outside-hours');
    assert.ok(await env.RATE.get(`lateinv:${T.wave}:972508888888`));
    snapshot = { events: { values: [eventRow({ token: T.today, date: '2026-11-02' }), eventRow({ token: T.wave, date: '2026-11-12', w1: '2026-11-02' })] },
      guests: { values: [guestRow({ token: T.today, id: 'g1', name: 'דנה', phone: '0501111111', rsvp: 'מגיע', table: '7' }), guestRow({ token: T.wave, id: 'g5', name: 'רותי', phone: '0505555555' })] } };
    const env2 = baseEnv();
    const res = await _runDailyEngine(env2, false, null, {});
    assert.equal(res.ok, true);
    assert.equal(sent.length, 0, 'nothing may leave at 23:30: ' + sent.map(s => s.body.template && s.body.template.name).join(','));
    assert.equal(res.truncated, true, 'the work stays pending for the pacer');
  } finally { t.mock.timers.reset(); }
});

/* ── P0: event-day blast ───────────────────────────────────────────────── */
test('event-day blast never goes to a guest who declined after the day-before reminder', async () => {
  const raw = { guests: { values: [
    guestRow({ token: T.today, id: 'g1', name: 'דנה', phone: '0501111111', rsvp: 'מגיע' }),
    guestRow({ token: T.today, id: 'g2', name: 'יוסי', phone: '0502222222', rsvp: 'לא מגיע' }),
  ] } };
  const env = baseEnv({ [`s5d:${T.today}:972502222222`]: '1', [`s5d:${T.today}:972501111111`]: '1' });
  const people = await _eventDayRecipients(env, T.today, raw, {});
  assert.deepEqual(people.map(p => p.phone), ['972501111111']);
});

test('event-day blast holds for a cancelled event', async () => {
  const { sendWindowState } = await import('../shir.js');
  snapshot = { events: { values: [eventRow({ token: T.today, date: ilDay(), cancelled: 'כן' })] },
    guests: { values: [guestRow({ token: T.today, id: 'g1', name: 'דנה', phone: '0501111111', rsvp: 'מגיע' })] } };
  const env = baseEnv({ [`edblast:${T.today}`]: JSON.stringify({ at: ilDay(), time: '19:30', what: 'החתונה', address: 'אולם', nav: 'https://waze.com/ul/x', template: 'ishur_yom_haerua' }) });
  const r = await _runEventDayBlasts(env, {});
  assert.equal(sent.length, 0);
  if (sendWindowState().open) assert.equal(r.jobs[0].skipped, 'cancelled-or-hold');
});

test('late invitation for an event that already happened is dropped', async () => {
  const ev = eventRow({ token: T.wave, date: plusDays(-2) });
  const env = baseEnv({ [`wave:${T.wave}:1`]: ilDay() });
  const r = await _lateInvite(env, ev, T.wave, 'דני', '0508888888');
  assert.equal(r.sent, false); assert.equal(r.why, 'event-passed'); assert.equal(sent.length, 0);
});

/* ── integration 02/11 (audit-send-pipeline onto feat-gifts-sendboard) ─── */
test('D5: the daily auto-retry reopens a failed guest but keeps the 3-strike count (3 per wave for life, not 3 a day)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const i = src.indexOf("env.RATE.get('autoretry:' + today)"); assert.ok(i >= 0, 'autoretry block');
  const b = src.slice(i, src.indexOf('out.autoretry = {', i));
  assert.ok(!/`wfail:/.test(b), 'autoretry deletes wfail:<token>:<wave>:<phone> — that resets the attempt count');
  assert.ok(/`gday:/.test(b), 'autoretry still clears the one-a-day guard');
});

test('/api/cap-status: the enforced shared budget + the audit fields (portfolio/per-number limit, left, late invites waiting)', async () => {
  const env = { ...baseEnv({ [`gsend:A:${day}`]: '100', [`gsend:B:${day}`]: '50', 'lateinv:tok1:972501111111': '{}', 'lateinv:tok1:972502222222': '{}' }), ADMIN_KEY: 'k' };
  const r = await worker.fetch(new Request('https://go.ishur.io/api/cap-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k' }) }), env, { waitUntil: () => {}, passThroughOnException: () => {} });
  assert.equal(r.status, 200);
  const j = await r.json();
  const b = j.budget;
  assert.equal(b.scope, 'portfolio');
  assert.equal(b.limit, 250); assert.equal(b.margin, 20); assert.equal(b.used, 150);
  assert.equal(b.remaining, 80); assert.equal(b.left, 80);
  assert.equal(b.portfolio_limit, 250); assert.equal(b.per_number_limit, 230);
  assert.equal(b.late_invites_waiting, 2);
  assert.deepEqual(b.numbers.map(n => [n.id, n.used]), [['A', 100], ['B', 50]]);
});

