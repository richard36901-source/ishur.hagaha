// node --test worker/test/salesflow.test.mjs — 03/11 lead qualification flow on 4499
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendPlan, fallbackPlan, hostessesFor, tierFor, siteLink, priceQuote, SITE_PARAMS } from '../paylink.js';
import { parseAnswers, parseDesign, parseDate, parseCity, parseGuests, triggerMatch, wantsHuman, optOut, priceQuestion, priceAnswer,
  salesInbound, salesTick, buildOffer, nextOpen, nudgeDelayMs, MSG, sfEnabled, SF_PREFIX, NUDGE_MIN, NUDGE_MAX } from '../salesflow.js';
import { SETTINGS, validateEdit, editableFor, withCfg } from '../cfg.js';

const NOW = Date.parse('2026-11-03T08:00:00Z');            /* Tue 10:00 Israel */
const NIGHT = Date.parse('2026-11-03T20:30:00Z');          /* Tue 22:30 Israel */
const P = '972501234567';

function fakeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; } };
}
function harness({ on = true, rand = 0.5 } = {}) {
  const kv = fakeKv();
  const env = { RATE: kv, __cfg: { sales_flow: on ? 'on' : 'off' } };
  const sent = [], slack = [], quoted = [];
  let now = NOW;
  const deps = { send: async (p, t) => { sent.push({ p, t, at: now }); return { ok: true }; }, slack: async t => { slack.push(t); }, log: async () => {},
    markQuoted: async (p, q, l, o) => { quoted.push({ p, q, l, o }); }, rand: () => rand, now: () => now, isClient: async () => false };
  return { kv, env, sent, slack, quoted, deps, setNow: t => { now = t; }, get now() { return now; },
    st: async () => JSON.parse(await kv.get(SF_PREFIX + P)) };
}

/* ── plan rule, hostess rule, tiers, link ── */
test('recommendPlan: calls 0 → basic, 1 → pro, 3 → premium; hostess/design never move it', () => {
  assert.equal(recommendPlan({ calls_rounds: 0 }), 'basic');
  assert.equal(recommendPlan({ calls_rounds: 1 }), 'pro');
  assert.equal(recommendPlan({ calls_rounds: 3 }), 'premium');
  assert.equal(recommendPlan({ calls_rounds: 0, hostess: true, design: true }), 'basic');
  assert.equal(recommendPlan({}), 'basic');
});
test('fallbackPlan is never premium', () => {
  assert.equal(fallbackPlan({ calls_rounds: 0 }), 'basic');
  assert.equal(fallbackPlan({ calls_rounds: 1 }), 'pro');
  assert.equal(fallbackPlan({ calls_rounds: 3 }), 'pro');
});
test('hostess rule: under 300 records → 1, 300+ → 2, not wanted → 0', () => {
  assert.equal(hostessesFor(200, true), 1);
  assert.equal(hostessesFor(299, true), 1);
  assert.equal(hostessesFor(300, true), 2);
  assert.equal(hostessesFor(700, true), 2);
  assert.equal(hostessesFor(700, false), 0);
});
test('tierFor rounds up to the next records tier', () => {
  assert.equal(tierFor(650), 700); assert.equal(tierFor(100), 100); assert.equal(tierFor(101), 200); assert.equal(tierFor(30), 50);
  assert.equal(tierFor(901), null); assert.equal(tierFor(0), null);
});
test('siteLink: the documented params only, phone local, junk dropped', () => {
  const u = new URL(siteLink({ plan: 'pro', records: 300, hostesses: 2, design: true, calls_rounds: 1, occasion: 'wedding', event_date: '2027-03-15', city: 'חיפה', name: 'דנה כהן', phone: '972501234567', src: 'noa' }));
  assert.equal(u.origin + u.pathname, 'https://ishur.io/');
  assert.deepEqual(Object.fromEntries(u.searchParams), { plan: 'pro', guests: '300', hostess: '2', design: '1', calls: '1', occasion: 'wedding', date: '2027-03-15', city: 'חיפה', name: 'דנה כהן', phone: '0501234567', src: 'noa' });
  for (const k of u.searchParams.keys()) assert.ok(SITE_PARAMS.includes(k), k);
  const bad = new URL(siteLink({ plan: 'gold', records: 333, occasion: 'x', event_date: '15/3', phone: '123' }));
  assert.equal([...bad.searchParams.keys()].length, 0);
});

/* ── parser ── */
test('parseAnswers: numbered yes/no/ignored, one vs three call rounds', () => {
  let a = parseAnswers('1. כן 2. לא 3. 15.3.27 בתל אביב', NOW);
  assert.equal(a.calls_rounds, 1); assert.equal(a.hostess, false); assert.equal(a.date, '2027-03-15'); assert.equal(a.city, 'תל אביב');
  a = parseAnswers('1. כן, 3 שיחות\n2. כן\n3. מרץ, חיפה', NOW);
  assert.equal(a.calls_rounds, 3); assert.equal(a.hostess, true); assert.equal(a.date, ''); assert.equal(a.month, 3); assert.equal(a.city, 'חיפה');
  a = parseAnswers('שיחה אחת מספיקה, דיילת לא צריך', NOW);
  assert.equal(a.calls_rounds, 1); assert.equal(a.hostess, false);
  a = parseAnswers('רוצים דיילת. האירוע ב-15/03/2027 בירושלים', NOW);
  assert.equal(a.calls_rounds, 0, 'calls not answered = no'); assert.equal(a.hostess, true); assert.equal(a.date, '2027-03-15'); assert.equal(a.city, 'ירושלים');
  a = parseAnswers('לא, כן, 20.6 באשדוד', NOW);
  assert.equal(a.calls_rounds, 0); assert.equal(a.hostess, true); assert.equal(a.date, '2027-06-20'); assert.equal(a.city, 'אשדוד');
  a = parseAnswers('כן לשניהם', NOW);
  assert.equal(a.calls_rounds, 1); assert.equal(a.hostess, true);
  assert.equal(parseAnswers('אוקיי', NOW).signals, 0);
});
test('parseDate: 15.3.27, 15/03/2027, "15 במרץ", "מרץ", past dates roll forward', () => {
  assert.equal(parseDate('15.3.27', NOW).date, '2027-03-15');
  assert.equal(parseDate('15/03/2027', NOW).date, '2027-03-15');
  assert.equal(parseDate('ב-15 במרץ', NOW).date, '2027-03-15');
  assert.deepEqual(parseDate('במרץ', NOW), { date: '', month: 3, year: 2027 });
  assert.equal(parseDate('1.12', NOW).date, '2026-12-01');
  assert.equal(parseDate('1.10', NOW).date, '2027-10-01', 'October 1 already passed this year');
  assert.equal(parseDate('31.2.27', NOW).date, '');
});
test('parseCity: names, prefixes, abbreviations', () => {
  assert.equal(parseCity('בתל אביב'), 'תל אביב'); assert.equal(parseCity('בת"א'), 'תל אביב'); assert.equal(parseCity('בפתח תקוה'), 'פתח תקווה');
  assert.equal(parseCity('בראשון לציון'), 'ראשון לציון'); assert.equal(parseCity('באולם בקריית ביאליק'), 'קריית ביאליק'); assert.equal(parseCity('עוד לא יודעים'), '');
});
test('trigger + guests: "חתונה 650", dates and phones are not guest counts', () => {
  assert.deepEqual(triggerMatch('חתונה 650'), { occasion: 'wedding', guests: 650 });
  assert.deepEqual(triggerMatch('היי, בר מצווה'), { occasion: 'bar', guests: 0 });
  assert.deepEqual(triggerMatch('כ-300 איש'), { occasion: '', guests: 300 });
  assert.equal(triggerMatch('היי מה נשמע'), null);
  assert.equal(parseGuests('אירוע ב-15.3.27, 0501234567'), 0);
});
test('parseDesign', () => {
  assert.deepEqual(parseDesign('יש לנו הזמנה'), { design: false, known: true });
  assert.deepEqual(parseDesign('אין, נשמח שתעצבו'), { design: true, known: true });
  assert.deepEqual(parseDesign('תעצבו לנו'), { design: true, known: true });
  assert.equal(parseDesign('מה?').known, false);
});
test('human + opt-out words; the calls question itself is not a human request', () => {
  for (const t of ['אפשר לדבר עם ריצארד?', 'אפשר נציג', 'תתקשרו אליי', 'להתקשר']) assert.ok(wantsHuman(t), t);
  for (const t of ['כן שהנציגה תתקשר למי שלא ענה', 'כן, 3 שיחות', 'חתונה 650']) assert.ok(!wantsHuman(t), t);
  for (const t of ['הסר', 'לא רלוונטי', 'לא מעוניינים תודה', 'תפסיקו']) assert.ok(optOut(t), t);
  assert.ok(!optOut('לא צריך דיילת'));
});
test('price questions: the specific kind, one number', () => {
  assert.equal(priceQuestion('כמה עולה בלי שיחות?').kind, 'nocalls');
  assert.equal(priceQuestion('כמה עולה דיילת?').kind, 'hostess');
  assert.equal(priceQuestion('כמה עולה?').kind, 'general');
  assert.equal(priceQuestion('כן 3 שיחות'), null);
  assert.equal(priceAnswer('nocalls', 650), 'בלי שיחות (חבילת בסיס) ל-700 רשומות: ₪699.');
  assert.equal(priceAnswer('hostess', 650), '2 דיילות ל-700 רשומות: ₪1,990.');
  assert.equal(priceAnswer('hostess', 200), 'דיילת אחת ל-200 רשומות: ₪1,790.');
  assert.equal(priceAnswer('general', 650), null);
});

/* ── offer ── */
test('buildOffer: server-priced, one number, includes list, advisory only with calls', () => {
  const st = { phone: P, name: 'דנה', occasion: 'wedding', guests: 650, answers: { calls_rounds: 3, hostess: true, date: '2027-03-15', city: 'חיפה' }, design: true };
  const o = buildOffer(st);
  const pq = priceQuote({ plan: 'premium', records: 700, phone: P, name: 'דנה', addons: { hostesses: 2, design: true } }).quote;
  assert.equal(o.quote.plan, 'premium'); assert.equal(o.quote.hostesses, 2); assert.equal(o.quote.sum, pq.sum);
  assert.ok(o.text.startsWith(MSG.advisory), 'advisory line before the offer when they asked for calls');
  assert.ok(o.text.includes(`לפי מה שבחרתם: חבילת הכל כלול ל-700 רשומות (כולל שיחות למי שלא ענה) + 2 דיילות + עיצוב הזמנה = ₪${pq.sum}.`));
  assert.equal((o.text.match(/₪/g) || []).length, 1, 'exactly one price');
  for (const l of ['• הזמנות בוואטסאפ עם אישור הגעה בלחיצה', '• תזכורות', 'Waze', '• מספר שולחן', 'ביט / פייבוקס', '• סידורי הושבה', '• ניהול תקציב', '• 3 סבבי שיחות', '• 2 דיילות', '• עיצוב הזמנה']) assert.ok(o.text.includes(l), l);
  assert.ok(o.text.includes(o.link) && o.link.includes('src=noa'));
  const plain = buildOffer({ ...st, answers: { calls_rounds: 0, hostess: false }, design: false });
  assert.ok(!plain.text.includes(MSG.advisory)); assert.equal(plain.quote.plan, 'basic');
  assert.ok(plain.text.includes('לפי מה שבחרתם: חבילת בסיס ל-700 רשומות = ₪699.'));
  assert.equal(buildOffer({ ...st, guests: 1200 }).why, 'over-900');
});

/* ── state machine, end to end ── */
test('flag off = no-op', async () => {
  const h = harness({ on: false });
  const r = await salesInbound(h.env, { phone: P, text: 'חתונה 650', isNewLead: true }, h.deps);
  assert.equal(r.handled, false); assert.equal(h.sent.length, 0); assert.equal(h.kv.store.size, 0);
  assert.equal((await salesTick(h.env, h.deps)).sent, 0);
  assert.equal(sfEnabled({}), false, 'default off');
  assert.equal(SETTINGS.sales_flow.default, 'off');
});
test('happy path: trigger → questions → design → one offer, lead marked quoted', async () => {
  const h = harness();
  let r = await salesInbound(h.env, { phone: P, text: 'היי, חתונה 650', name: 'דנה', isNewLead: true }, h.deps);
  assert.equal(r.action, 'q1'); assert.equal(h.sent[0].t, MSG.q1('wedding', false));
  assert.ok(h.sent[0].t.startsWith('היי 🙂 נשמח לעזור עם החתונה!'));
  h.setNow(NOW + 5 * 60e3);
  r = await salesInbound(h.env, { phone: P, text: '1. כן 2. כן 3. 15.3.27 בחיפה' }, h.deps);
  assert.equal(r.action, 'q2'); assert.equal(h.sent[1].t, MSG.q2);
  h.setNow(NOW + 10 * 60e3);
  r = await salesInbound(h.env, { phone: P, text: 'אין לנו, תעצבו' }, h.deps);
  assert.equal(r.action, 'offer'); assert.equal(r.quote.plan, 'pro'); assert.equal(r.quote.records, 700); assert.equal(r.quote.hostesses, 2); assert.equal(r.quote.design, true);
  assert.ok(h.sent[2].t.includes('חבילת פרמיום ל-700 רשומות (כולל שיחות למי שלא ענה) + 2 דיילות + עיצוב הזמנה'));
  assert.ok(h.sent[2].t.includes('date=2027-03-15') && h.sent[2].t.includes('plan=pro'));
  assert.equal(h.quoted.length, 1); assert.ok(h.slack.some(s => s.includes('הצעה נשלחה')));
  assert.equal((await h.st()).step, 'done');
  /* after the offer the flow is out of the way */
  assert.equal((await salesInbound(h.env, { phone: P, text: 'תודה!' }, h.deps)).handled, false);
});
test('3 call rounds → premium (הכל כלול), with the advisory line', async () => {
  const h = harness();
  await salesInbound(h.env, { phone: P, text: 'בר מצווה 180', isNewLead: true }, h.deps);
  await salesInbound(h.env, { phone: P, text: '1. כן, 3 שיחות 2. לא 3. מאי' }, h.deps);
  const r = await salesInbound(h.env, { phone: P, text: 'יש לנו הזמנה' }, h.deps);
  assert.equal(r.quote.plan, 'premium'); assert.equal(r.quote.records, 200); assert.equal(r.quote.hostesses, 0);
  assert.ok(h.sent.at(-1).t.startsWith(MSG.advisory));
});
test('not a trigger / not a lead / already seen → untouched', async () => {
  const h = harness();
  assert.equal((await salesInbound(h.env, { phone: P, text: 'היי', isNewLead: true }, h.deps)).handled, false);
  assert.equal((await salesInbound(h.env, { phone: P, text: 'חתונה 300', isNewLead: true, isClient: true }, h.deps)).handled, false);
  assert.equal((await salesInbound(h.env, { phone: P, text: 'חתונה 300' }, h.deps)).handled, false, 'an existing lead writing an occasion is not a trigger');
  assert.equal(h.sent.length, 0);
  const meta = await salesInbound(h.env, { phone: P, text: 'היי', isMetaLead: true, occasion: 'bat' }, h.deps);
  assert.equal(meta.action, 'q1'); assert.ok(h.sent[0].t.includes('עם הבת מצווה!') && h.sent[0].t.includes('4. כמה מוזמנים'), 'meta lead without a number is asked for one');
});
test('price question mid-flow: one number now, flow continues; "כמה עולה?" first → questions with one line', async () => {
  const h = harness();
  let r = await salesInbound(h.env, { phone: P, text: 'חתונה 650, כמה עולה?', isNewLead: true }, h.deps);
  assert.equal(r.action, 'q1'); assert.ok(h.sent[0].t.startsWith(MSG.priceFirst + '\n'));
  assert.ok(!h.sent[0].t.includes('₪'), 'no price before the questions');
  r = await salesInbound(h.env, { phone: P, text: 'כמה עולה בלי שיחות?' }, h.deps);
  assert.equal(r.action, 'price-answer'); assert.equal(h.sent[1].t, 'בלי שיחות (חבילת בסיס) ל-700 רשומות: ₪699.\n' + MSG.backToQ1);
  assert.equal((await h.st()).step, 1);
  r = await salesInbound(h.env, { phone: P, text: 'לא, לא, דצמבר' }, h.deps);
  assert.equal(r.action, 'q2');
  r = await salesInbound(h.env, { phone: P, text: 'כמה עולה דיילת?' }, h.deps);
  assert.equal(h.sent.at(-1).t, '2 דיילות ל-700 רשומות: ₪1,990.\n' + MSG.q2);
  r = await salesInbound(h.env, { phone: P, text: 'יש לנו' }, h.deps);
  assert.equal(r.action, 'offer'); assert.equal(r.quote.plan, 'basic');
});
test('human request / unreadable answer → stop, Slack, one reply', async () => {
  const h = harness();
  await salesInbound(h.env, { phone: P, text: 'חתונה 400', isNewLead: true }, h.deps);
  const r = await salesInbound(h.env, { phone: P, text: 'אפשר לדבר עם ריצארד?' }, h.deps);
  assert.equal(r.action, 'human'); assert.equal(h.sent.at(-1).t, MSG.human); assert.ok(h.slack.some(s => s.includes('ליד מבקש אדם')));
  assert.equal((await salesInbound(h.env, { phone: P, text: 'הלו?' }, h.deps)).handled, false, 'replied once, then hands off');
  const h2 = harness();
  await salesInbound(h2.env, { phone: P, text: 'חתונה 400', isNewLead: true }, h2.deps);
  assert.equal((await salesInbound(h2.env, { phone: P, text: 'מה זה בדיוק?' }, h2.deps)).action, 'human');
});
test('opt-out stops the flow without a flow reply', async () => {
  const h = harness();
  await salesInbound(h.env, { phone: P, text: 'חתונה 400', isNewLead: true }, h.deps);
  const r = await salesInbound(h.env, { phone: P, text: 'לא רלוונטי' }, h.deps);
  assert.equal(r.handled, false); assert.equal(h.sent.length, 1); assert.equal((await h.st()).step, 'stopped');
});
test('hours gating: a night message is answered from the queue at 09:00', async () => {
  const h = harness(); h.setNow(NIGHT);
  const r = await salesInbound(h.env, { phone: P, text: 'חתונה 650', isNewLead: true }, h.deps);
  assert.equal(r.queued, true); assert.equal(h.sent.length, 0);
  const due = (await h.st()).pending.due;
  assert.equal(new Date(due).toISOString(), '2026-11-04T07:00:00.000Z', '09:00 Israel next morning');
  h.setNow(due - 60e3); await salesTick(h.env, h.deps); assert.equal(h.sent.length, 0);
  h.setNow(due); const t = await salesTick(h.env, h.deps); assert.equal(t.sent, 1); assert.equal(h.sent[0].t, MSG.q1('wedding', false));
  assert.ok(nextOpen(Date.parse('2026-11-06T19:30:00Z')) > Date.parse('2026-11-07T21:00:00Z'), 'Friday night waits past Shabbat');
});
test('nudges: once per question after 60–150 min; then the fallback offer ~2h after the second nudge', async () => {
  assert.equal(nudgeDelayMs(() => 0), NUDGE_MIN * 60e3); assert.equal(nudgeDelayMs(() => 1), NUDGE_MAX * 60e3);
  const h = harness({ rand: 0 });                                   /* 60 min */
  await salesInbound(h.env, { phone: P, text: 'חתונה 250', isNewLead: true }, h.deps);
  h.setNow(NOW + 59 * 60e3); await salesTick(h.env, h.deps); assert.equal(h.sent.length, 1, 'not before 60 min');
  h.setNow(NOW + 60 * 60e3); assert.equal((await salesTick(h.env, h.deps)).nudged, 1); assert.equal(h.sent.at(-1).t, MSG.nudge);
  h.setNow(NOW + 5 * 3600e3); await salesTick(h.env, h.deps); assert.equal(h.sent.length, 2, 'one nudge per question');
  /* they answer the questions; the design question goes unanswered */
  h.setNow(NOW + 6 * 3600e3); await salesInbound(h.env, { phone: P, text: '1. כן 2. כן 3. 1.12 ברמת גן' }, h.deps);
  const t2 = h.now;
  h.setNow(t2 + 60 * 60e3); assert.equal((await salesTick(h.env, h.deps)).nudged, 1);
  const nudge2 = h.now;
  h.setNow(nudge2 + 119 * 60e3); assert.equal((await salesTick(h.env, h.deps)).fallback, 0);
  h.setNow(nudge2 + 120 * 60e3);
  assert.equal(new Date(h.now).toISOString(), '2026-11-03T17:00:00.000Z', '19:00 Israel, inside hours');
  assert.equal((await salesTick(h.env, h.deps)).fallback, 1);
  const off = h.sent.at(-1).t;
  assert.ok(off.includes('הכנו לכם הצעה לפי מה שסיפרתם') && off.includes('הבחירות כבר ממולאות בקישור'));
  assert.ok(off.includes('חבילת פרמיום ל-300 רשומות (כולל שיחות למי שלא ענה) + 2 דיילות = ₪'), 'pro fallback, 300 records → 2 hostesses, no design');
  assert.equal(h.quoted[0].o.fallback, true);
  h.setNow(h.now + 10 * 3600e3); await salesTick(h.env, h.deps); assert.equal(h.sent.length, 5, 'q1, nudge, q2, nudge, offer — nothing after');
});
test('fallback offer is basic when they never asked for calls, 1 hostess under 300', async () => {
  const h = harness({ rand: 0 });
  await salesInbound(h.env, { phone: P, text: 'ברית 120', isNewLead: true }, h.deps);
  await salesInbound(h.env, { phone: P, text: 'לא, כן, 10.1.27 בחולון' }, h.deps);
  h.setNow(NOW + 60 * 60e3); await salesTick(h.env, h.deps);
  h.setNow(NOW + 180 * 60e3); await salesTick(h.env, h.deps);
  assert.ok(h.sent.at(-1).t.includes('חבילת בסיס ל-200 רשומות + דיילת אחת = ₪'));
});
test('a nudge that falls at night waits for the morning', async () => {
  const h = harness({ rand: 1 });                                   /* 150 min */
  h.setNow(Date.parse('2026-11-03T17:30:00Z'));                     /* 19:30 Israel */
  await salesInbound(h.env, { phone: P, text: 'חתונה 500', isNewLead: true }, h.deps);
  assert.equal(new Date((await h.st()).nudgeAt).toISOString(), '2026-11-04T07:00:00.000Z');
});
test('24h window closed → nothing sent, Slack', async () => {
  const h = harness({ rand: 0 }); h.setNow(NIGHT);
  await salesInbound(h.env, { phone: P, text: 'חתונה 650', isNewLead: true }, h.deps);
  h.setNow(NIGHT + 25 * 3600e3);
  await salesTick(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.ok(h.slack.some(s => s.includes('חלון 24 השעות נסגר'))); assert.equal((await h.st()).step, 'stopped');
});
test('became a client meanwhile → the tick stops the flow', async () => {
  const h = harness({ rand: 0 });
  await salesInbound(h.env, { phone: P, text: 'חתונה 650', isNewLead: true }, h.deps);
  h.deps.isClient = async () => true;
  h.setNow(NOW + 2 * 3600e3); const t = await salesTick(h.env, h.deps);
  assert.equal(t.skipped, 1); assert.equal(h.sent.length, 1);
});

/* ── the switch ── */
test('cfg sales_flow: on/off, default off, its own confirm word, applied by withCfg', async () => {
  assert.deepEqual(validateEdit('sales_flow', '', 'on'), { ok: true, value: 'on' });
  const row = editableFor('sales_flow', {})[0];
  assert.equal(row.value, 'off'); assert.equal(row.confirm, 'sales_flow');
  const kv = fakeKv(); await kv.put('cfg:sales_flow', JSON.stringify({ value: 'on' }));
  const e = await withCfg({ RATE: kv }, { fresh: true });
  assert.equal(sfEnabled(e), true);
});
