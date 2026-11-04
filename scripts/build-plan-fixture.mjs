/* fixtures/ops/plan.json for ?mock=1 and the smoke: the REAL composer (worker/ops-plan.js composePlan) run over
   masked inputs — the capacity + call-rounds fixtures already in fixtures/ops (same "today" 2026-11-03) plus small
   synthetic audit / board / cron / hostess inputs, so every status (בוצע · בתהליך · ממתין · לא קרה) and all three
   periods appear. Usage: node scripts/build-plan-fixture.mjs */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { composePlan, PLAN_CRONS } = await import(pathToFileURL(join(ROOT, 'worker/ops-plan.js')));
const fx = n => JSON.parse(readFileSync(join(ROOT, 'fixtures/ops', n + '.json'), 'utf8'));
const TODAY = '2026-11-03', NOW = Date.parse('2026-11-03T10:00:00Z');   /* Tuesday, 12:00 Israel */
const cap = fx('capacity'), rounds = fx('call-rounds');
const tok = (p) => `${p}-0000-4000-8000-000000000000`;
const events = [
  { token: tok('c2f63d20'), name: 'נועה ויונתן', date: '2026-11-07', time: '19:30', occasion: 'חתונה' },
  { token: tok('c1c5fcf5'), name: 'אורי ויצחק', date: '2026-11-05', time: '20:00', occasion: 'חתונה' },
  { token: tok('f0a38bbd'), name: 'בר המצווה של איתי', date: '2026-11-12', time: '18:30', occasion: 'בר מצווה' },
  { token: tok('ab699ac0'), name: 'אירוע א', date: '2026-11-03', time: '19:00', occasion: 'חתונה' },
  { token: tok('395962fa'), name: 'אירוע ב', date: '2026-11-18', time: '20:00', occasion: 'חתונה' },
  { token: tok('e045522a'), name: 'אירוע ד', date: '2026-10-29', time: '19:00', occasion: 'ברית' },
];
const sends = [
  { day: '2026-11-01', tok8: '395962fa', type: 'w1', sent: 207, failed: 4 }, { day: '2026-11-02', tok8: 'c2f63d20', type: 'w2', sent: 88, failed: 1 },
  { day: '2026-11-02', tok8: 'e045522a', type: 'thanks', sent: 61, failed: 0 }, { day: '2026-11-03', tok8: 'ab699ac0', type: 'table', sent: 52, failed: 2 },
  { day: '2026-11-03', tok8: 'ab699ac0', type: 'subevent', sent: 40, failed: 0 }, { day: '2026-11-03', tok8: 'c1c5fcf5', type: 'gift', sent: 13, failed: 0 },
];
const board = { events: [
  { short: '395962fa', name: 'אירוע ב', types: [{ key: 'w1', due: '2026-11-01', audience: 211, sent: 207, failed: { total: 4 }, pending: { total: 0 } }] },
  { short: 'c2f63d20', name: 'נועה ויונתן', types: [{ key: 'w2', due: '2026-11-02', audience: 89, sent: 88, failed: 1, pending: { total: 0 } }, { key: 'daybefore', due: '2026-11-06', audience: 160, sent: 0, failed: 0, pending: { total: 160, scheduled: 160 } }] },
  { short: 'ab699ac0', name: 'אירוע א', types: [{ key: 'table', due: TODAY, audience: 52, sent: 52, failed: { total: 2 }, pending: { total: 0 } }] },
  { short: 'ffb78392', name: 'אירוע ו', held: true, types: [{ key: 'w1', due: '2026-11-02', audience: 140, sent: 0, failed: 0, pending: { total: 140, hold: 140 } }] },
  { short: '96b7dec2', name: 'אירוע ה', types: [{ key: 'w2', due: '2026-11-01', audience: 75, sent: 0, failed: 0, pending: { total: 75, cap: 75 } }, { key: 'w3', due: '2026-11-24', audience: 60, sent: 0, failed: 0, pending: { total: 60, scheduled: 60 } }] },
], subevents: [{ token: tok('ab699ac0'), name: 'שבת חתן · אירוע א', parent: tok('6a3155cc'), types: [{ invited: 216, sent: 40, pending: 176, failed: 0, replied: 9 }] }] };
const subrecs = { [tok('ab699ac0')]: { parent: tok('6a3155cc'), name: 'שבת חתן · אירוע א', reminder_at: '2026-11-06T10:00', reminder_n: 120 } };
const runs = (id, days, bad = []) => days.map(d => ({ started_at: `${d}T06:35:09.000Z`, status: bad.includes(d) ? 'failed' : 'ok', error: bad.includes(d) ? 'sheet 503' : '' }));
const crons = PLAN_CRONS.map(c => ({ ...c, runs: c.id === 'd_engine' ? runs(c.id, ['2026-11-01', '2026-11-02', TODAY], ['2026-11-02']) : c.id === 'backup' ? runs(c.id, ['2026-11-01', TODAY]) : c.il_hour ? [{ started_at: '2026-11-02T19:00:04.000Z', status: 'ok' }, { started_at: '2026-11-01T19:00:04.000Z', status: 'ok' }] : [] }));
const assignments = [
  { id: 'as1', date: '2026-11-03', start: '17:30', end: '23:00', hostess_name: 'מאיה', event_token: tok('ab699ac0'), status: 'confirmed' },
  { id: 'as2', date: '2026-11-05', start: '18:00', end: '23:30', hostess_name: 'רוני', event_token: tok('c1c5fcf5'), status: 'confirmed' },
  { id: 'as3', date: '2026-11-07', start: '18:00', end: '23:30', hostess_name: 'מאיה', event_token: tok('c2f63d20'), status: 'cancelled' },
  { id: 'as4', date: '2026-11-12', start: '17:00', end: '22:30', hostess_name: 'נועה ש׳', event_token: tok('f0a38bbd'), status: 'confirmed' },
];
/* 04/11 the realtime payload the status line reads (worker/ops.js buildRealtime shape): guests + Noa 4499 with 131042 */
const rt = { at: '2026-11-03T09:59:30.000Z', today: TODAY, wa: { numbers: [
  { phone_id: 'A', role: 'guests', label: 'שיר #1', sent_today: 105, rejected_today: 1, failed_async_today: 2, failed_by_code: { 131026: 3 }, by_reason: { table: 52, subevent: 40, gift: 13 }, by_event: { ab699ac0: { total: 92, table: 52, subevent: 40 }, c1c5fcf5: { total: 13, gift: 13 }, c2f63d20: { total: 4, reply: 4 } } },
  { phone_id: 'N', role: 'client', label: 'נועה · 4499', sent_today: 6, rejected_today: 0, failed_async_today: 1, failed_by_code: { 131042: 1 }, by_reason: { client: 6 }, by_event: {} }],
  totals: { sent_today: 111, rejected_today: 1, failed_async_today: 3 } },
  cap: { limit: 250, used: 120, remaining: 130 }, queue: { sends: { why: 'will-send' } }, make: { reader: { ok: true }, writer: { ok: true }, outbox: { size: 0 } }, noa: { billing_131042: true } };
const base = { today: TODAY, now: NOW, rt, send_window: { open: true }, call_window: { open: true }, paused: false, sends_why: 'will-send', next_tick_at: '2026-11-03T10:10:00.000Z',
  sends, capacity: cap, board, subrecs, call_rounds: rounds, calls_done: [{ day: '2026-11-02', tok8: 'c2f63d20', name: 'נועה ויונתן', n: 11, answered: 6 }, { day: '2026-11-01', tok8: '395962fa', name: 'אירוע ב', n: 7, answered: 2 }],
  lead_sends: { by_day: { '2026-11-01': { sent: 9, failed: 0 }, '2026-11-02': { sent: 14, failed: 2 }, [TODAY]: { sent: 6, failed: 1 } }, billing_131042: true }, crons, events, assignments };
const by_period = Object.fromEntries(['today', 'week', 'month'].map(p => [p, composePlan({ ...base, period: p })]));
writeFileSync(join(ROOT, 'fixtures/ops/plan.json'), JSON.stringify({ ok: true, fixture: true, by_period }, null, 1));
for (const p of Object.keys(by_period)) console.log(p, JSON.stringify(by_period[p].totals), 'next:', by_period[p].next && by_period[p].next.label_he);
