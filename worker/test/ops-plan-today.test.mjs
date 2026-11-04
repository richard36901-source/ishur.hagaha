// node --test worker/test/ops-plan-today.test.mjs — the סקירה "מתוכנן מול בוצע" defects seen live on 04/11/2026,
// reproduced from a fixture shaped like that day's real data:
//   1. /api/ops/plan?period=today took 49 s → precomputed into KV plan:<period>, the route serves KV, every source timed,
//      the per-guest send board reused from its cache, past days read once (plan:day:<day>).
//   2. only 5 rows: no sub-event "שבת חתן · זגורי" (176 guests, first send in progress, reminder 05/11 10:00), no replies,
//      lead sends 0/0 while realtime showed 14 sent / 13 failed 131042, crons with an empty title.
//   3. no answer to "did everything that should go out today go out?" → a top status line + one red line per real problem,
//      numbers taken verbatim from /api/ops/realtime (rt) and /api/ops/call-rounds.
// Plus the brain check planned_not_progressing and its Slack key stuck:<id>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composePlan, precomputePlans, servePlan, ilAt, PLAN_KEY, PLAN_DAY_KEY, CRON_HE, PLAN_CRONS, WORK_KINDS } from '../ops-plan.js';
import { sendsByDay, callsByDay } from '../ops.js';
import { CHECKS, stuckCandidates, progressStep } from '../brain.js';
import { slackImportant } from '../slack.js';

const TODAY = '2026-11-04', TOMORROW = '2026-11-05';                 /* Wednesday */
const NOW = Date.parse('2026-11-04T13:40:00Z');                       /* 15:40 Israel */
const SUB = 'ab699ac0-7a64-4a9a-abd3-0d541ad5041a', PARENT = '6a3155cc-0000-4000-8000-000000000001', ROUND = 'c2f63d20-0000-4000-8000-000000000002';
const flat = p => p.days.flatMap(d => d.items);
const find = (p, id) => flat(p).find(i => i.id === id);

/* today's realtime payload (worker/ops.js buildRealtime shape), as the screen showed it */
const RT = () => ({ ok: true, at: '2026-11-04T13:39:30.000Z', today: TODAY,
  wa: { numbers: [
    { phone_id: 'A', role: 'guests', label: 'שיר #1', sent_today: 52, rejected_today: 0, failed_async_today: 2, failed_by_code: { 131026: 2 }, by_reason: { subevent: 40, reply: 6, wave: 6 }, by_event: { ab699ac0: { total: 40, subevent: 40 }, c2f63d20: { total: 12, reply: 6, wave: 6 } }, frees_at: null },
    { phone_id: 'N', role: 'client', label: 'נועה · 4499', sent_today: 14, rejected_today: 0, failed_async_today: 13, failed_by_code: { 131042: 13 }, by_reason: { client: 14 }, by_event: { '—': { total: 14, client: 14 } } }],
  totals: { sent_today: 66, rejected_today: 0, failed_async_today: 15 } },
  cap: { scope: 'portfolio', limit: 250, used: 120, margin: 20, remaining: 110, all_held: false },
  queue: { sends: { why: 'will-send' }, calls: { why: 'will-dial' } },
  make: { reader: { ok: true, failing_since: null }, writer: { ok: true, failing_since: null }, outbox: { size: 0, pending: false } },
  noa: { phone_id: 'N', billing_131042: true } });
const ROUNDS = () => ({ ok: true, at: '2026-11-04T13:39:40.000Z', today: TODAY, totals: { queued: 34, remaining_today: 34, dialed_today: 50, lead_calls_today: 0 },
  events: [{ tok8: 'c2f63d20', token: ROUND, name: 'נועה ויונתן', date: '2026-11-07', queued: 34, remaining_today: 34, dialed_today: 50, answered_today: 31,
    outcomes_today: { coming: 12, not_coming: 5, maybe: 4, voicemail: 9, no_answer: 10 }, will_dial: true, why: [] }] });
const SUBS = () => [{ token: SUB, parent: PARENT, kind: 'shabbat', template: 'shabbat_chatan_v1', name: 'שבת חתן · זגורי', invited: 176, sent: 103, replied: 31, failed: 0, pending: 73,
  started_at: '2026-11-03T16:00:00.000Z', reminder_at: '2026-11-05T10:00' }];
const CRONS = () => PLAN_CRONS.map(c => ({ ...c, runs: c.id === 'journal_digest' ? [] : [{ started_at: '2026-11-04T06:35:10.000Z', status: 'ok' }] }));
const INPUT = (over = {}) => ({ period: 'today', today: TODAY, now: NOW, send_window: { open: true }, call_window: { open: true }, paused: false, sends_why: 'will-send', next_tick_at: '2026-11-04T13:50:00.000Z',
  events: [{ token: PARENT, name: 'זגורי', date: '2026-11-12', time: '19:30', occasion: 'חתונה' }, { token: ROUND, name: 'נועה ויונתן', date: '2026-11-07', time: '20:00', occasion: 'חתונה' }],
  sends: [{ day: TODAY, tok8: 'ab699ac0', type: 'subevent', sent: 40, failed: 0 }, { day: TODAY, tok8: 'c2f63d20', type: 'w2', sent: 6, failed: 0 }],
  capacity: { days: [{ day: TODAY, open: true, capacity: 230, planned: 73, overflow: 0, out: 73, rolled: [{ tok8: 'ab699ac0', event: 'שבת חתן · זגורי', type: 'subevent', n: 73, from_day: TODAY }], by_event: [] },
    { day: TOMORROW, open: true, capacity: 230, planned: 0, overflow: 0, out: 0, rolled: [], by_event: [] }] },
  board: { events: [{ short: 'c2f63d20', name: 'נועה ויונתן', types: [{ key: 'w2', due: TODAY, audience: 6, sent: 6, failed: 0, pending: { total: 0 } }] }] },
  subs: SUBS(), subrecs: { [SUB]: SUBS()[0] }, call_rounds: ROUNDS(), rt: RT(), lead_sends: { by_day: {}, billing_131042: true }, crons: CRONS(), assignments: [], ...over });

/* ── defect 2: every row that should be there is there, titled, grouped ───────────────────────────────── */
test('defect 2: the sub-event שבת חתן · זגורי shows today (113 planned, 40 done, in progress, replies + totals) and its reminder tomorrow 10:00', () => {
  const p = composePlan(INPUT());
  const s = find(p, `send:ab699ac0|subevent:${TODAY}`);
  assert.ok(s, 'the sub-event row exists');
  assert.equal(s.label_he, 'שבת חתן · זגורי'); assert.equal(s.event.name, 'שבת חתן · זגורי');
  assert.equal(s.planned_n, 113); assert.equal(s.done_n, 40); assert.equal(s.status, 'in_progress'); assert.equal(s.self_heals, true); assert.equal(s.needs_you, false);
  assert.match(s.reason_he, /נשלחו 40 מתוך 113 היום/); assert.match(s.reason_he, /31 ענו/); assert.match(s.reason_he, /סה״כ 103 מתוך 176/);
  assert.deepEqual([s.extra.invited, s.extra.sent_total, s.extra.pending, s.extra.replied], [176, 103, 73, 31]);
  assert.ok(p.tomorrow && p.tomorrow.day === TOMORROW, 'the today view carries tomorrow');
  const rem = p.tomorrow.items.find(i => i.id === 'subrem:ab699ac0');
  assert.ok(rem, 'the reminder is in tomorrow'); assert.equal(rem.planned_at, ilAt(TOMORROW, '10:00')); assert.equal(rem.status, 'waiting'); assert.equal(rem.planned_n, 103 - 31);
  assert.equal(p.days.length, 1); assert.ok(!flat(p).some(i => i.day === TOMORROW), 'tomorrow is not counted in today');
});

test('defect 2: the sub-event survives Make being down (no snapshot → no board, no capacity, no events) — it comes from its KV record', () => {
  const p = composePlan(INPUT({ board: null, capacity: null, events: [], snapshot_ok: false, rt: { ...RT(), make: { reader: { ok: false, failing_since: '2026-11-04T11:00:00.000Z' }, writer: { ok: false }, outbox: { size: 7 } } } }));
  const s = find(p, `send:ab699ac0|subevent:${TODAY}`);
  assert.ok(s); assert.equal(s.done_n, 40); assert.equal(s.planned_n, 113, 'without the planner the whole rest is today');
  assert.equal(p.status.problems[0].code, 'make'); assert.equal(p.status.problems[0].needs_you, true); assert.match(p.status.problems[0].cause_he, /7 כתיבות ממתינות/);
});

test('defect 2: Noa 4499 lead sends are realtime\'s numbers (14 sent, 13 failed 131042), not 0/0; Shir\'s round reads 50/84 with answered / coming / not coming / left', () => {
  const p = composePlan(INPUT());
  const l = find(p, `leads:${TODAY}`);
  assert.equal(l.sent_n, 14); assert.equal(l.failed_n, 13); assert.equal(l.done_n, 1); assert.equal(l.planned_n, 14);
  assert.equal(l.status, 'missed'); assert.equal(l.needs_you, true); assert.match(l.reason_he, /נשלחו 14 · נכשלו 13 \(131042 ×13\)/); assert.equal(l.event.name, 'לידים · נועה 4499');
  const c = find(p, `call:c2f63d20:${TODAY}`);
  assert.equal(c.planned_n, 84); assert.equal(c.done_n, 50); assert.equal(c.status, 'in_progress');
  assert.deepEqual([c.extra.dialed, c.extra.answered, c.extra.coming, c.extra.not_coming, c.extra.left], [50, 31, 12, 5, 34]);
  assert.match(c.reason_he, /50 חיוגים מתוך 84 · 31 נענו/); assert.match(c.reason_he, /נשארו 34/);
});

test('defect 2: every row has a Hebrew title and an event name (crons included), sends are one row per event + kind, replies are counted', () => {
  const p = composePlan(INPUT());
  const items = flat(p);
  for (const i of items) { assert.ok(String(i.label_he).trim(), 'title ' + i.id); assert.ok(String(i.event.name).trim(), 'event ' + i.id); assert.match(i.time_hm, /^\d\d:\d\d$/, 'time ' + i.id); }
  for (const c of PLAN_CRONS) { const r = find(p, `cron:${c.id}:${TODAY}`); assert.equal(r.label_he, CRON_HE[c.id]); assert.equal(r.event.name, 'מערכת'); }
  const keys = items.filter(i => i.kind === 'send').map(i => i.event.tok8 + '|' + i.type);
  assert.equal(new Set(keys).size, keys.length, 'one row per event + kind');
  const rep = find(p, `send:c2f63d20|reply:${TODAY}`); assert.equal(rep.done_n, 6); assert.equal(rep.status, 'done'); assert.match(rep.label_he, /תשובות לאורחים · נועה ויונתן/);
  assert.equal(find(p, `send:c2f63d20|w2:${TODAY}`).status, 'done');
});

/* ── defect 3: the top line + red lines, numbers equal realtime / call-rounds ─────────────────────────── */
test('defect 3: the top line answers "did it all go out" and its numbers are realtime\'s and call-rounds\' exactly', () => {
  const p = composePlan(INPUT()), st = p.status, rt = RT(), r = ROUNDS();
  assert.equal(st.line_he, 'היום: 4 מתוך 8 בוצעו · 3 ממתינים (יוצאים לבד עד 20:30) · 1 צריך אותך');
  assert.equal(st.all_ok, false);
  assert.equal(st.numbers.wa_sent, rt.wa.totals.sent_today); assert.equal(st.numbers.wa_failed, rt.wa.totals.rejected_today + rt.wa.totals.failed_async_today);
  assert.equal(st.numbers.noa_sent, 14); assert.equal(st.numbers.noa_failed, 13);
  assert.equal(st.numbers.calls_dialed, r.totals.dialed_today); assert.equal(st.numbers.calls_left, r.totals.remaining_today); assert.equal(st.numbers.calls_answered, 31);
  assert.equal(st.numbers_he, 'נשלחו היום 66 הודעות (אורחים 52 · נועה 14) · 15 נכשלו · 50 שיחות, 31 נענו');
  const b = st.problems.find(x => x.code === '131042');
  assert.ok(b && b.needs_you && !b.self_heals); assert.match(b.title_he, /13 הודעות ללידים נכשלו/); assert.match(b.fix_he, /WhatsApp Manager/);
  const g = st.problems.find(x => x.code === 'guest_failed'); assert.ok(g && g.self_heals && !g.needs_you); assert.match(g.title_he, /131026 ×2/);
  assert.ok(!st.problems.some(x => x.code === 'item:leads:' + TODAY), 'the lead row is explained by the 131042 line, not repeated');
  assert.equal(st.problems.filter(x => x.needs_you).length, 1);
});

test('defect 3: cap full → a self-healing red line with the HH:MM it frees at; call window closed → the guests left for the next call day; all done → ✓', () => {
  const capRt = { ...RT(), cap: { ...RT().cap, used: 250, remaining: 0 }, queue: { sends: { why: 'cap' } } };
  capRt.wa.numbers[0].frees_at = '2026-11-04T15:10:00.000Z';
  const c = composePlan(INPUT({ rt: capRt, sends_why: 'cap' }));
  const cap = c.status.problems.find(x => x.code === 'cap');
  assert.ok(cap && cap.self_heals && !cap.needs_you); assert.equal(cap.until_hm, '17:10'); assert.match(cap.title_he, /התקרה של מטא מלאה עד 17:10/);
  assert.equal(find(c, `send:ab699ac0|subevent:${TODAY}`).block, 'cap');

  const late = Date.parse('2026-11-04T19:00:00Z');                                       /* 21:00 Israel */
  const w = composePlan(INPUT({ now: late, send_window: { open: false, why: 'hours' }, call_window: { open: false, why: 'hours' } }));
  const cw = w.status.problems.find(x => x.code === 'call_window');
  assert.ok(cw && cw.self_heals); assert.match(cw.title_he, /34 אורחים נשארו ל-05\/11/);
  const sw = w.status.problems.find(x => x.code === 'send_window'); assert.ok(sw && sw.self_heals); assert.match(sw.title_he, /73 הודעות יוצאות לבד/);

  const allDone = composePlan(INPUT({ subs: [], subrecs: {}, capacity: null, call_rounds: { events: [] }, crons: CRONS().map(c => ({ ...c, runs: [{ started_at: c.id === 'journal_digest' ? '2026-11-04T19:00:05.000Z' : '2026-11-04T06:35:10.000Z', status: 'ok' }] })),
    now: Date.parse('2026-11-04T19:10:00Z'), rt: { ...RT(), noa: { billing_131042: false }, wa: { numbers: [{ ...RT().wa.numbers[0], failed_async_today: 0, failed_by_code: {} }], totals: { sent_today: 52, rejected_today: 0, failed_async_today: 0 } } }, lead_sends: { by_day: {}, billing_131042: false } }));
  assert.equal(allDone.status.line_he, 'היום: הכול יצא כמתוכנן ✓'); assert.equal(allDone.status.all_ok, true);
});

test('defect 3: a sub-event nobody started is a "needs you" row with its own red line', () => {
  const p = composePlan(INPUT({ subs: [{ ...SUBS()[0], started_at: '', sent: 0, replied: 0, pending: 176 }], sends: [] }));
  const s = find(p, `send:ab699ac0|subevent:${TODAY}`);
  assert.equal(s.needs_you, true); assert.match(s.reason_he, /מחכה ללחיצה שלך/);
  assert.ok(p.status.problems.some(x => x.code === 'item:' + s.id && x.needs_you));
  assert.match(p.status.line_he, /2 צריכים אותך/);
});

/* ── defect 1: precomputed into KV, served from KV, every source timed, nothing expensive twice ───────── */
function kv(init = {}) {
  const m = new Map(Object.entries(init)); let gets = 0;
  return { m, gets: () => gets, get: async k => { gets++; return m.has(k) ? m.get(k) : null; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }) };
}
function harness({ now = NOW, init = {} } = {}) {
  const env = { RATE: kv({ ['subevent:' + SUB]: JSON.stringify({ parent: PARENT, kind: 'shabbat', template: 'shabbat_chatan_v1', name: 'שבת חתן · זגורי', started_at: '2026-11-03T16:00:00.000Z', reminder_at: '2026-11-05T10:00' }), ...init }) };
  const calls = { audit: [], board: 0, capacity: 0, rounds: 0, realtime: [] };
  const d = { ilDate: (x = new Date(now)) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(x), snapshotCached: async () => null, clientPhoneId: () => 'N',
    kvPrefix: async (e, pre) => Object.fromEntries([...e.RATE.m.entries()].filter(([k]) => k.startsWith(pre))),
    auditQueryEx: async (e, q) => { calls.audit.push(q); return { items: [], truncated: false }; },
    sendBoardData: async () => { calls.board++; return { events: [] }; }, sendingPaused: async () => false,
    sendWindowState: () => ({ open: true }), callWindowState: () => ({ open: true }), isNoContactDay: () => false, isTestEventRow: () => false, planKeyOf: () => 'pro', normPhone: x => x };
  const fns = { sendsByDay, callsByDay, buildCapacity: async () => { calls.capacity++; return { ok: true, days: [] }; }, buildCallRounds: async () => { calls.rounds++; return ROUNDS(); },
    buildRealtime: async (e, dd, n, pre) => { calls.realtime.push(pre); return RT(); } };
  return { env, d, fns, calls };
}
const boom = () => { throw new Error('must not be called when KV is warm'); };

test('defect 1: the pacer precompute writes plan:today / plan:week / plan:month with per-source timings; the route then answers from KV without touching a single source', async () => {
  const h = harness();
  const r = await precomputePlans(h.env, h.d, h.fns, { now: NOW });
  assert.equal(r.ok, true); assert.deepEqual(r.periods, ['today', 'week', 'month']);
  for (const p of ['today', 'week', 'month']) { const hit = JSON.parse(h.env.RATE.m.get(PLAN_KEY(p))); assert.equal(hit.at, NOW); assert.equal(hit.data.period, p); }
  for (const k of ['snapshot', 'audit_today', 'capacity', 'send_board', 'subevents', 'call_rounds', 'realtime', 'audit_past']) assert.equal(typeof r.ms[k], 'number', 'timed: ' + k);
  assert.equal(h.calls.capacity, 1, 'ONE gather for the three periods'); assert.equal(h.calls.rounds, 1); assert.equal(h.calls.realtime.length, 1);
  assert.ok(h.calls.realtime[0].outQ && h.calls.realtime[0].stQ, 'realtime gets the plan\'s own today rows (same numbers)');
  const today = JSON.parse(h.env.RATE.m.get(PLAN_KEY('today'))).data;
  assert.ok(today.days[0].items.some(i => i.id === `send:ab699ac0|subevent:${TODAY}`), 'the sub-event reaches the stored plan from its KV record (no snapshot)');
  assert.ok(today.status && today.status.line_he.startsWith('היום:'));

  const cold = { ...h.d, snapshotCached: boom, auditQueryEx: boom, sendBoardData: boom, kvPrefix: boom };
  const t0 = Date.now();
  const served = await servePlan(h.env, cold, { buildCapacity: boom, buildCallRounds: boom, buildRealtime: boom, sendsByDay: boom, callsByDay: boom }, { period: 'today', now: NOW + 5 * 60e3 });
  const took = Date.now() - t0;
  assert.equal(served.served, 'kv'); assert.equal(served.cached, true); assert.equal(served.age_s, 300); assert.ok(took < 100, took + ' ms');
  assert.equal(served.status.line_he, today.status.line_he);
});

test('defect 1: KV older than 30 min or fresh=1 recomputes; the cold path never rebuilds the per-guest send board, a fresh board cache is reused', async () => {
  const h = harness();
  await precomputePlans(h.env, h.d, h.fns, { now: NOW });
  assert.equal(h.calls.board, 1, 'no board cache → the pacer builds it once');
  const stale = await servePlan(h.env, h.d, h.fns, { period: 'today', now: NOW + 31 * 60e3 });
  assert.equal(stale.served, 'cold'); assert.equal(h.calls.board, 1, 'cold path: no board rebuild');
  const fresh = await servePlan(h.env, h.d, h.fns, { period: 'week', now: NOW + 60e3, fresh: true });
  assert.equal(fresh.served, 'fresh'); assert.equal(h.calls.board, 2);
  const h2 = harness({ init: { 'sendboard:all:3:0': JSON.stringify({ at: NOW - 10 * 60e3, data: { events: [] } }) } });
  await precomputePlans(h2.env, h2.d, h2.fns, { now: NOW });
  assert.equal(h2.calls.board, 0, 'board cache 10 min old → reused, no per-guest marker reads');
});

test('defect 1: past days are read from the audit once (plan:day:<day>) — the next tick reads only today', async () => {
  const h = harness();
  await precomputePlans(h.env, h.d, h.fns, { now: NOW, periods: ['week'] });
  const pastQ = h.calls.audit.filter(q => q.from); assert.equal(pastQ.length, 3 * 3, 'Sun..Tue × (wa_out, wa_status, call)');
  for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) assert.equal(JSON.parse(h.env.RATE.m.get(PLAN_DAY_KEY(day))).final, true);
  h.calls.audit.length = 0;
  await precomputePlans(h.env, h.d, h.fns, { now: NOW + 10 * 60e3, periods: ['week'] });
  assert.equal(h.calls.audit.filter(q => q.from).length, 0, 'second tick: no past-day audit reads');
  assert.equal(h.calls.audit.filter(q => q.days === 1).length, 2, 'only today\'s wa_out + wa_status (realtime\'s query)');
});

/* ── brain: planned_not_progressing ───────────────────────────────────────────────────────────────── */
test('brain planned_not_progressing: a row inside its window whose done count did not move for 30 min → P1 with Slack key stuck:<id>; moving, capped, needing Richard or outside the window → nothing', async () => {
  const plan = composePlan(INPUT());
  const cand = stuckCandidates(plan, { sendOpen: true, callOpen: true, now: NOW });
  assert.deepEqual(cand.map(i => i.id).sort(), [`call:c2f63d20:${TODAY}`, `send:ab699ac0|subevent:${TODAY}`].sort());
  assert.equal(stuckCandidates(plan, { sendOpen: false, callOpen: false, now: NOW }).length, 0, 'outside the windows nothing is expected to move');
  assert.equal(stuckCandidates(plan, { sendOpen: true, callOpen: true, paused: true, now: NOW }).length, 0);
  const capped = composePlan(INPUT({ sends_why: 'cap' }));
  assert.ok(!stuckCandidates(capped, { sendOpen: true, callOpen: true, now: NOW }).some(i => i.kind === 'send'), 'waiting for the Meta cap is not stuck');

  const chk = CHECKS.find(c => c.id === 'planned_not_progressing'); assert.ok(chk);
  const env = { RATE: kv({ 'plan:today': JSON.stringify({ at: NOW, data: plan }) }) };
  const d = { sendWindowState: () => ({ open: true }), callWindowState: () => ({ open: true }), sendingPaused: async () => false };
  const ctx = (now) => ({ env, d, now, today: TODAY, log: () => {} });
  assert.deepEqual(await chk.run(ctx(NOW)), [], 'first look only records');
  env.RATE.m.set('plan:today', JSON.stringify({ at: NOW + 20 * 60e3, data: plan }));
  assert.deepEqual(await chk.run(ctx(NOW + 20 * 60e3)), [], '20 min: not yet');
  env.RATE.m.set('plan:today', JSON.stringify({ at: NOW + 31 * 60e3, data: plan }));
  const f = await chk.run(ctx(NOW + 31 * 60e3));
  assert.equal(f.length, 2); assert.ok(f.every(x => x.severity === 'P1' && x.status === 'fail' && x.slack_key === 'stuck:' + x.data.item_id && x.id === 'planned_not_progressing:' + x.data.item_id));
  assert.match(f.find(x => x.data.kind === 'send').title_he, /תקוע: שבת חתן · זגורי — 40 מתוך 113, לא זז 31 דקות/);
  /* the round moved → only the sub-event stays stuck */
  const moved = JSON.parse(JSON.stringify(plan)); moved.days[0].items.find(i => i.kind === 'call').done_n = 56;
  env.RATE.m.set('plan:today', JSON.stringify({ at: NOW + 41 * 60e3, data: moved }));
  const f2 = await chk.run(ctx(NOW + 41 * 60e3));
  assert.deepEqual(f2.map(x => x.data.kind), ['send']);
  /* a stale plan (pacer stopped) is not judged — pacer_tick owns that */
  env.RATE.m.set('plan:today', JSON.stringify({ at: NOW, data: plan }));
  assert.deepEqual(await chk.run(ctx(NOW + 60 * 60e3)), []);
  const s = progressStep({ day: '2026-11-03', items: { x: { done: 1, since: 0 } } }, [{ id: 'x', done_n: 1 }], { now: NOW, today: TODAY });
  assert.equal(s.state.items.x.since, NOW, 'a new day starts the clock again');
});

test('slack: the stuck:<id> key (and opts.important=true) passes the strict allowlist even when the title mentions the cap', () => {
  assert.equal(slackImportant('🚨 *מוח · תקוע: גל 1 · נועה ויונתן — 0 מתוך 80, לא זז 30 דקות*', { key: 'stuck:send:c2f63d20|w1:2026-11-04' }), true);
  assert.equal(slackImportant('תקוע: תקרה', { key: 'finding:stuck:x' }), true);
  assert.equal(slackImportant('anything', { important: true }), true);
  assert.equal(slackImportant('🚨 תקרה מלאה', { key: 'cap_high' }), false, 'other keys keep the old rules');
  assert.ok(WORK_KINDS.has('send') && !WORK_KINDS.has('event'));
});
