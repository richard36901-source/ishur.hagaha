/* Builds fixtures/ops/*.json for ops.html?mock=1.
   The registry part is REAL (automations.fixture.json = worker/automations-registry.js,
   plus code excerpts read from worker/ at each node's source line). Every number,
   event, phone and run below is invented with a seeded PRNG so output is stable.
   Run: node scripts/build-ops-fixtures.mjs  (re-run after registry changes) */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures/ops');
const reg = JSON.parse(readFileSync(join(ROOT, 'automations.fixture.json'), 'utf8')).registry;
const NOW = Date.parse('2026-11-03T11:40:00Z'); // 13:40 IL
let seed = 20261103;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const iso = (ms) => new Date(ms).toISOString();
const write = (name, obj) => writeFileSync(join(OUT, name + '.json'), JSON.stringify({ ok: true, fixture: true, as_of: iso(NOW), ...obj }, null, 1));

const EVENTS = [
  { token: 'e1a0c2f4-0000-4000-8000-000000000001', name: 'נועה ואיתי', date: '2026-11-05', guests: 420 },
  { token: 'e1a0c2f4-0000-4000-8000-000000000002', name: 'בר המצווה של יונתן', date: '2026-11-06', guests: 260 },
  { token: 'e1a0c2f4-0000-4000-8000-000000000003', name: 'שירה ודניאל', date: '2026-11-10', guests: 610 },
  { token: 'e1a0c2f4-0000-4000-8000-000000000004', name: 'מאיה ועומר', date: '2026-11-12', guests: 380 },
  { token: 'e1a0c2f4-0000-4000-8000-000000000005', name: 'בת המצווה של ליה', date: '2026-11-13', guests: 190 },
  { token: 'e1a0c2f4-0000-4000-8000-000000000006', name: 'טל ורוני', date: '2026-11-15', guests: 520 },
  { token: 'e1a0c2f4-0000-4000-8000-000000000007', name: 'אורי ונגה', date: '2026-11-17', guests: 700 },
];
const mask = () => '05' + ri(0, 8) + '-•••-' + String(ri(10, 99));

/* ── registry ── */
const SIDE = { send_guest: ['wa_guest'], send_client: ['wa_client'], call: ['call'], slack: ['slack'], internal: ['kv'], trigger: [] };
const SEV = { send_guest: 'P1', call: 'P1', send_client: 'P2', internal: 'P2', slack: 'P3', trigger: 'P2' };
const EXPLAIN = {
  d_pacer: 'כל 10 דקות הפייסר מחלק את השליחות והשיחות של היום לפרוסות קטנות, כדי שלא ייצא הכל בבת אחת. הוא מריץ את המנוע כשיש עבודה, מחייג, מנסה שוב מה שלא נמסר, ובסוף בודק שהכל תקין.',
  d_engine: 'המנוע היומי עובר על כל האירועים ומחליט מה צריך לצאת היום: גלי הזמנה, דוחות ללקוח, תזכורות, הושבה, יום לפני ואחרי.',
  wave1: 'גל ההזמנה הראשון לאורחים, בתאריך שנקבע לאירוע. יוצא רק בחלון השליחה ובתקציב היומי.',
  autoretry: 'פעם ביום מוחק סימוני כשל כדי שהודעות שלא נמסרו יישלחו שוב. זה יכול לגרום לשליחה חוזרת המונית, ולכן יש לו מתג משלו.',
  shir_dispatch: 'שיר מחייגת לאורחים שלא ענו בוואטסאפ, בחלון השיחות. כל שיחה עולה כסף.',
  event_day_blast: 'ביום האירוע, מ-09:00, שולח לאורחים את הודעת יום האירוע (ניווט, שעה).',
};
const DEPENDS = { wave1: ['template_check'], wave2: ['template_check'], shir_dispatch: ['reconcile_calls'], event_day_blast: ['template_check'] };
function excerpt(source) {
  if (!source || !source.file) return null;
  const p = join(ROOT, source.file);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split('\n');
  /* registry line numbers drift as index.js moves; anchor on the symbol, nearest to the recorded line */
  let line = source.line, best = Infinity;
  lines.forEach((l, i) => { if (source.symbol && l.includes(source.symbol) && Math.abs(i + 1 - source.line) < best) { best = Math.abs(i + 1 - source.line); line = i + 1; } });
  source = { ...source, line };
  const start = Math.max(1, source.line - 3), end = Math.min(lines.length, source.line + 18);
  return { file: source.file, start, line, drifted: best !== 0, lines: lines.slice(start - 1, end).map((l) => l.slice(0, 160)) };
}
const DAYMAP = { t_morning: [6, 35, 'morning'], d_engine: [6, 35, 'morning'], t_0400: [4, 0, 'night'], t_evening: [18, 0, 'evening'], t_tue: [9, 0, 'morning'] };
function nextFire(n) {
  const top = (n.from || [])[0] || '';
  if (n.layer === 3 || n.id === 't_wa_status') return { at: null, daypart: 'event', he: (n.trigger && n.trigger.il) || 'לפי אירוע' };
  if (n.id === 't_cron10' || n.id === 'd_pacer' || top === 't_cron10' || top === 'd_pacer') return { at: iso(Math.ceil(NOW / 600000) * 600000), daypart: 'continuous', he: 'כל 10 דקות' };
  const k = DAYMAP[n.id] || DAYMAP[top] || DAYMAP.t_morning;
  let d = new Date(NOW); d.setUTCHours(k[0], k[1], 0, 0); if (+d < NOW) d = new Date(+d + 864e5);
  return { at: iso(+d), daypart: k[2], he: (n.trigger && n.trigger.il) || '' };
}
const OFF = { noa_queue: 'מענה AI כבוי בהחלטה (כלל קבוע)', noa_lead_dial: 'NOA_LEADS=off' };
const KILL = ['d_pacer', 'wave1', 'wave2', 'wave3', 'event_day_blast', 'autoretry', 'shir_dispatch', 'shir_callbacks', 'wave_retry'];
const nodes = reg.nodes.map((n) => {
  const nf = nextFire(n);
  const busy = n.layer === 0 ? 0 : (nf.daypart === 'continuous' ? ri(60, 144) : ri(0, 3));
  const spark = Array.from({ length: 24 }, (_, h) => (busy > 20 ? ri(4, 6) : (h === 8 ? Math.min(1, busy) : 0)));
  const fails = spark.map((v) => (v && rnd() < 0.06 ? 1 : 0));
  if (n.id === 'party_nudges') fails[20] = 2;
  const lastAt = NOW - ri(1, 9) * 60000 - (busy < 20 ? ri(1, 20) * 3600000 : 0);
  return {
    ...n,
    side_effects: SIDE[n.kind] || [],
    severity: SEV[n.kind] || 'P3',
    kill: KILL.includes(n.id) ? { type: 'kv', key: 'off:' + n.id } : null,
    explain_he: EXPLAIN[n.id] || (n.conditions && n.conditions[0]) || '',
    depends_on: DEPENDS[n.id] || [],
    next_fire: nf.at, daypart: nf.daypart, schedule_he: nf.he,
    state: OFF[n.id] ? { enabled: false, disabled_by: 'richard', disabled_at: '2026-10-21T08:00:00Z', reason: OFF[n.id] } : { enabled: true },
    stats: {
      runs_24h: spark.reduce((a, b) => a + b, 0), fail_24h: fails.reduce((a, b) => a + b, 0), runs_7d: busy * 7 + ri(0, 9),
      last_run: n.layer === 0 ? null : { id: 'r_' + n.id + '_last', at: iso(lastAt), status: fails[23] ? 'failed' : (rnd() < 0.15 ? 'skipped' : 'ok') },
      spark_24h: spark, spark_fail_24h: fails, avg_ms: ri(120, 4200),
      handled: fails.some(Boolean) ? 'נוסה שוב אוטומטית בפעימה הבאה · התראה בסלאק' : null,
    },
    code: excerpt(n.source),
    editable: n.kind === 'send_guest' ? { il_time: '09:00', budget: 50 } : null,
  };
});
[...nodes].sort((a, b) => b.stats.runs_7d - a.stats.runs_7d).forEach((n, i) => { n.stats.most_run_rank = i + 1; });
write('registry', { windows: reg.windows, numbers: reg.numbers, nodes, global: { paused: false } });

/* ── runs ── */
const runnable = nodes.filter((n) => n.layer > 0);
const pacer = nodes.find((x) => x.id === 'd_pacer');
const runs = [];
for (let i = 0; i < 400; i++) {
  const n = i % 3 === 0 ? pacer : pick(runnable);
  const st = NOW - i * 4 * 60000 - ri(0, 90000);
  const r = rnd();
  const status = r < 0.05 ? 'failed' : r < 0.1 ? 'partial' : r < 0.28 ? 'skipped' : 'ok';
  const dur = ri(150, 9000);
  runs.push({
    id: 'r' + (100000 - i), automation_id: n.id, name: n.name_he, parent_id: null,
    triggered_by: i % 37 === 0 ? 'manual:richard' : i % 53 === 0 ? 'brain' : 'cron',
    started_at: iso(st), ended_at: iso(st + dur), duration_ms: dur, status,
    skip_reason: status === 'skipped' ? pick(['window', 'no-work', 'cap', 'paused']) : null,
    counts: n.kind === 'send_guest' || n.id === 'd_pacer' ? { sent: ri(0, 25), failed: status === 'ok' ? 0 : ri(1, 4), skipped: ri(0, 6) } : n.kind === 'call' ? { dialed: ri(0, 6), answered: ri(0, 3) } : {},
    cost_usd: n.kind === 'call' ? +(rnd() * 1.4).toFixed(2) : n.kind === 'send_guest' ? +(rnd() * 0.6).toFixed(2) : 0,
    error_class: status === 'failed' ? pick(['131048', '131026', 'snapshot_fetch', 'timeout']) : null,
    error: status === 'failed' ? pick(['Meta 131048: spam rate limit', 'Meta 131026: message undeliverable', 'snapshot fetch failed (sheet 503)', 'subrequest timeout']) : null,
    handled: status === 'failed' ? pick(['נוסה שוב בפעימה הבאה והצליח', 'המספר הוחלף ל-055-3089799', 'התראה P2 בסלאק', 'ממתין לאישור ריצארד']) : null,
  });
}
write('runs', { items: runs, next_cursor: null });

/* ── run detail (one rich example; the app synthesises the rest from runs) ── */
const head = runs[0];
const children = ['autoretry', 'lead_chase', 'shir_callbacks', 'shir_dispatch', 'reconcile_calls', 'template_check', 'doctor'].map((id, k) => ({
  id: head.id + '.' + (k + 1), automation_id: id, name: nodes.find((x) => x.id === id).name_he, parent_id: head.id,
  started_at: iso(Date.parse(head.started_at) + k * 400), status: k === 3 ? 'partial' : k === 0 ? 'skipped' : 'ok', skip_reason: k === 0 ? 'already-today' : null, counts: k === 3 ? { dialed: 6, answered: 2 } : {},
}));
write('run', {
  run: head, children,
  logs: [
    { ts: head.started_at, level: 'info', msg: 'פעימה התחילה · חלון שליחה פתוח · חלון שיחות פתוח' },
    { ts: head.started_at, level: 'info', msg: 'pacer:pending = היום → מריץ מנוע בתקציב 25' },
    { ts: head.started_at, level: 'info', msg: 'גל 1 · נועה ואיתי · 18 נשלחו מ-6673' },
    { ts: head.started_at, level: 'warn', msg: 'שיר: 2 מספרים לא זמינים, נדחו לסבב הבא' },
    { ts: head.ended_at, level: 'info', msg: 'doctor: הכל תקין' },
  ],
  audit: [
    { id: 'a9f31', at: head.started_at, kind: 'cron', summary: 'job runPacer ok' },
    { id: 'a9f32', at: head.started_at, kind: 'wa_out', summary: '18 הודעות wave1_f · נועה ואיתי' },
    { id: 'a9f33', at: head.ended_at, kind: 'call', summary: '6 חיוגים · 2 נענו' },
  ],
});

/* ── realtime ── */
const numbers = [
  { phone_id: '1409632775565600', label: 'שיר · אורחים', display: '055-308-6673', role: 'guests', cap: 1000, quality: 'GREEN' },
  { phone_id: '1409632775565601', label: 'שיר · אורחים 2', display: '055-308-9799', role: 'guests', cap: 250, quality: 'GREEN' },
  { phone_id: '1218978741299669', label: 'נועה · לקוחות', display: '4499', role: 'client', cap: 1000, quality: 'YELLOW' },
].map((x) => {
  const sched = x.role === 'guests' ? ri(120, 420) : ri(10, 40), exc = ri(2, 30), failed = ri(0, 12);
  return { ...x, sent_today: sched + exc, failed_today: failed, queued: x.role === 'guests' ? ri(40, 200) : ri(0, 8), reasons: { scheduled: sched, exception: exc, failed }, last_sent_at: iso(NOW - ri(1, 8) * 60000) };
});
const byEvent = EVENTS.slice(0, 5).map((e, k) => ({ token: e.token, name: e.name, date: e.date, number: k === 1 ? '9799' : '6673', sent: ri(20, 160), failed: ri(0, 6), queued: ri(0, 90), reason_top: pick(['גל 1', 'גל 2', 'תזכורת יום לפני', 'שליחה חוזרת']) }));
const recent = Array.from({ length: 30 }, (_, k) => {
  const e = pick(EVENTS); const reason = k % 9 === 0 ? 'failed' : k % 5 === 0 ? 'exception' : 'scheduled';
  return { at: iso(NOW - k * 97000), to: mask(), event: e.name, number: k % 4 ? '6673' : '9799', reason, status: reason === 'failed' ? 'failed' : pick(['sent', 'delivered', 'read']), template: pick(['wave1_f', 'wave2_n', 'day_before_f', 'resend_f']), why: reason === 'exception' ? pick(['אורח נוסף מאוחר', 'שליחה ידנית מהאדמין', 'בקשת לקוח']) : reason === 'failed' ? pick(['131026 לא ניתן למסירה', '131048 מגבלת ספאם']) : 'לפי לוח הזמנים' };
});
const timeline = Array.from({ length: 34 }, (_, k) => {
  const e = pick(EVENTS.slice(0, 4)); const st = pick(['answered', 'answered', 'no_answer', 'voicemail', 'busy', 'answered']);
  return { at: iso(NOW - k * 11 * 60000 - ri(0, 300000)), event: e.name, to: mask(), status: st, duration_s: st === 'answered' ? ri(25, 140) : 0, why: pick(['לא ענה לוואטסאפ 48 שעות', 'סבב שיחות שני', 'ביקש שיחה חוזרת', 'גל 3, אחרון']), outcome: st === 'answered' ? pick(['מגיע · 2', 'לא מגיע', 'אולי', 'מגיע · 4']) : null };
});
const callsOut = timeline.length, callsAns = timeline.filter((t) => t.status === 'answered').length;
const incidents = [
  { id: 'inc1', severity: 'P2', title: 'מספר נועה 4499 בדירוג צהוב', at: iso(NOW - 3 * 3600000), automation_id: 'lead_chase', status: 'open' },
  { id: 'inc2', severity: 'P3', title: 'party_nudges לא בודק עצירה גלובלית', at: iso(NOW - 26 * 3600000), automation_id: 'party_nudges', status: 'open' },
  { id: 'inc3', severity: 'P1', title: 'קובץ אורחים לא נטען (snapshot), טופל בניסיון חוזר', at: iso(NOW - 5 * 3600000), automation_id: 'd_pacer', status: 'resolved' },
];
const next = nodes.filter((n) => n.next_fire && n.layer > 0).sort((a, b) => a.next_fire.localeCompare(b.next_fire)).slice(0, 8).map((n) => ({ at: n.next_fire, automation_id: n.id, name: n.name_he, what: n.explain_he.slice(0, 90) }));
const guests = numbers.filter((n) => n.role === 'guests');
const waSent = guests.reduce((a, n) => a + n.sent_today, 0), waCap = guests.reduce((a, n) => a + n.cap, 0);
write('realtime', {
  summary: { wa_sent_today: waSent, wa_cap_total: waCap, wa_remaining: waCap - waSent, calls_today: callsOut, calls_answered: callsAns, failures_24h: runs.filter((r) => r.status === 'failed' && Date.parse(r.started_at) > NOW - 864e5).length, incidents_open: incidents.filter((i) => i.status === 'open').length, balances_low: 1, paused: false },
  wa: { numbers, by_event: byEvent, recent },
  calls: { out: callsOut, answered: callsAns, no_answer: callsOut - callsAns, queued: 41, remaining: 58, cap: 92, window: { open: true, from: '10:00', to: '20:30' },
    by_event: EVENTS.slice(0, 4).map((e) => ({ token: e.token, name: e.name, out: ri(4, 14), answered: ri(2, 8), remaining: ri(0, 30), why: pick(['לא ענו לוואטסאפ', 'סבב שני', 'יום לפני, אישור אחרון']) })), timeline },
  incidents, next,
});

/* ── capacity: next 14 days ── */
const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const days = Array.from({ length: 14 }, (_, k) => {
  const d = new Date(NOW + k * 864e5); const dow = d.getUTCDay(); const date = d.toISOString().slice(0, 10);
  const closed = dow === 6 || date === '2026-11-11';
  const cap = closed ? 0 : dow === 5 ? 500 : 1250;
  const evs = closed ? [] : EVENTS.filter(() => rnd() < 0.35).slice(0, 3).map((e) => ({ token: e.token, name: e.name, planned_wa: ri(60, 380), kind: pick(['גל 1', 'גל 2', 'גל 3', 'יום לפני']) }));
  if (k === 6 && !closed) evs.push({ token: EVENTS[6].token, name: EVENTS[6].name, planned_wa: 900, kind: 'גל 1' });
  const planned = evs.reduce((a, e) => a + e.planned_wa, 0);
  return { date, dow: DOW[dow], no_contact: closed, closed_reason: dow === 6 ? 'שבת' : closed ? 'ערב חג' : null, capacity_wa: cap, planned_wa: planned, capacity_calls: closed ? 0 : dow === 5 ? 30 : 92, planned_calls: closed ? 0 : ri(10, 110), events: evs };
});
const over = days.filter((d) => d.planned_wa > d.capacity_wa || d.planned_calls > d.capacity_calls);
write('capacity', {
  days,
  alerts: over.map((d) => {
    const wa = d.planned_wa > d.capacity_wa;
    return { date: d.date, kind: wa ? 'wa' : 'calls', over_by: wa ? d.planned_wa - d.capacity_wa : d.planned_calls - d.capacity_calls, msg: wa ? 'יותר הודעות מתוכננות מהתקרה ביום ' + d.dow : 'יותר שיחות מתוכננות ממה שאפשר לחייג ביום ' + d.dow };
  }),
  recommendations: EVENTS.slice(2).map((e, k) => ({ token: e.token, name: e.name, event_date: e.date, wave: 'גל 1', send_on: days[Math.min(13, 1 + k * 2)].date, planned: e.guests, reason: k === 2 ? 'להקדים ביום: היום המקורי מלא' : 'יש מקום ביום הזה בשני המספרים' })),
});

/* ── balances ── */
write('balances', { vendors: [
  { vendor: 'telnyx', label: 'Telnyx', amount: 23.4, currency: 'USD', low_threshold: 30, topup_url: 'https://portal.telnyx.com/#/app/billing', auto_topup: false, as_of: iso(NOW - 600000), source: 'api' },
  { vendor: 'retell', label: 'Retell · שיחות', amount: 61, currency: 'USD', low_threshold: 25, topup_url: 'https://dashboard.retellai.com/billing', auto_topup: true, as_of: '2026-11-02T07:00:00Z', source: 'manual', note: 'אין API ליתרה, מעודכן ידנית. השיחה האחרונה הצליחה לפני 4 דק׳' },
  { vendor: 'anthropic', label: 'Anthropic', amount: 142.8, currency: 'USD', low_threshold: 20, topup_url: 'https://console.anthropic.com/settings/billing', auto_topup: true, as_of: '2026-11-01T09:00:00Z', source: 'manual' },
  { vendor: 'meta_wa', label: 'Meta WhatsApp', amount: null, currency: 'USD', spent_month: 318.2, low_threshold: null, topup_url: 'https://business.facebook.com/billing_hub', auto_topup: 'unknown', as_of: iso(NOW - 1800000), source: 'api', note: 'משולם בכרטיס, אין יתרה. מוצג החיוב החודשי' },
  { vendor: 'meta_ads', label: 'Meta Ads', amount: 412, currency: 'ILS', spend_cap: 3000, spent_month: 2140, low_threshold: 200, topup_url: 'https://adsmanager.facebook.com/billing', auto_topup: true, as_of: iso(NOW - 1800000), source: 'api' },
  { vendor: 'cloudflare', label: 'Cloudflare', amount: null, currency: 'USD', plan: 'Workers Paid', usage_pct: 34, low_threshold: null, topup_url: 'https://dash.cloudflare.com/?to=/:account/billing', auto_topup: true, as_of: iso(NOW - 3600000), source: 'api' },
  { vendor: 'make', label: 'Make', amount: 6120, currency: 'ops', usage_pct: 61, low_threshold: 1000, topup_url: 'https://www.make.com/en/pricing', auto_topup: false, as_of: iso(NOW - 3600000), source: 'api' },
] });

/* ── live: seed rows; mock mode appends synthetic rows per poll ── */
const KINDS = ['wa_out', 'wa_status', 'wa_in', 'call', 'cron', 'admin', 'slack', 'pay', 'lead'];
const live = Array.from({ length: 80 }, (_, k) => {
  const kind = pick(KINDS); const e = pick(EVENTS);
  const msg = { wa_out: 'נשלחה הזמנה ל-' + mask(), wa_status: 'נמסר · ' + mask(), wa_in: 'תשובה: "מגיעים 2"', call: 'שיחה ' + pick(['נענתה', 'לא נענתה']) + ' · ' + mask(), cron: 'runPacer ok · 18 נשלחו', admin: 'ריצארד פתח את האירוע', slack: 'התראה נשלחה ל-#ops', pay: 'תשלום התקבל ₪' + ri(390, 1890), lead: 'ליד חדש מהאתר' }[kind];
  return { id: 50000 - k, at: iso(NOW - k * 41000), kind, level: rnd() < 0.08 ? 'error' : rnd() < 0.15 ? 'warn' : 'info', number: kind.startsWith('wa') ? pick(['6673', '9799', '4499']) : null, event: e.name, automation_id: pick(['d_pacer', 'wave1', 'shir_dispatch', 'lead_chase']), msg };
});
write('live', { items: live, cursor: 50000 });

/* ── brain ── */
write('brain', {
  findings: [
    { id: 'f1', at: iso(NOW - 900000), check_id: 'template_pending', severity: 'P2', status: 'handling', title: 'תבנית wave1_n ממתינה לאישור 26 שעות', playbook: 1, run_id: 'rb1' },
    { id: 'f2', at: iso(NOW - 5 * 3600000), check_id: 'snapshot_fail', severity: 'P1', status: 'resolved', title: 'קובץ האורחים של שירה ודניאל לא נטען', playbook: 3, run_id: 'rb2' },
    { id: 'f3', at: iso(NOW - 3 * 3600000), check_id: 'quality_drop', severity: 'P2', status: 'needs_approval', title: 'דירוג 4499 ירד לצהוב. להעביר תנועה?', playbook: 9, run_id: 'rb3' },
    { id: 'f4', at: iso(NOW - 864e5), check_id: 'wrong_number', severity: 'P3', status: 'resolved', title: 'אורח כתב ל-4499, נענה מ-6673', playbook: 7, run_id: 'rb4' },
  ],
  playbooks: [
    [1, 'תבנית ממתינה או נדחתה', 'active'], [2, 'עצירה ישנה', 'active'], [3, 'קובץ אורחים לא נטען', 'active'], [4, 'בעיית תשלום במספר (131042)', 'active'], [5, 'Telnyx: הזמנה או יתרה', 'active'],
    [6, 'ליד בלי פריט במאנדיי', 'active'], [7, 'הודעה למספר הלא נכון', 'active'], [8, 'גל לא יצא עד 12:00', 'active'], [9, 'שיעור ספאם עולה', 'approval'], [10, 'מנוע תקוע או חיוב Retell', 'active'],
  ].map(([id, name, status]) => ({ id, name, status, runs_7d: ri(0, 9), last_run: iso(NOW - ri(1, 72) * 3600000) })),
  stream: [
    'בדיקה: template_pending · wave1_n במצב PENDING מאתמול 11:20',
    'סוג ידוע, פלייבוק 1. לא צריך מודל שפה.',
    'בודק אם יש וריאנט קיים: wave1_n_v2 לא קיים',
    'מגיש וריאנט wave1_n_v2 עם אותו טקסט, קטגוריה UTILITY',
    'מטא החזיר מזהה חדש, סטטוס PENDING',
    'גל 1 של מאיה ועומר משתמש ב-wave1_f (מאושרת), אין השפעה על שליחה היום',
    'כתבתי התראה P2 לסלאק עם הסבר. אבדוק שוב בעוד שעה.',
  ].map((text, k) => ({ id: 900 + k, at: iso(NOW - (7 - k) * 20000), run_id: 'rb1', step: k + 1, text })),
  cursor: 906,
});

/* ── toggle: blast-radius live impact per switch (downstream is computed client-side in mock) ── */
write('toggle', { impact: {
  d_pacer: [['הזמנות בתור להיום', 212], ['אירועים מושפעים', 4], ['שיחות שנשארו היום', 58]],
  wave1: [['הזמנות גל 1 בתור', 164], ['אירועים', 3]],
  shir_dispatch: [['שיחות שנשארו היום', 58], ['אירועים', 4]],
  event_day_blast: [['אירועים היום', 0]],
  autoretry: [['הודעות שייחשבו מחדש', 37]],
} });
console.log('fixtures written: registry runs run realtime capacity balances live brain toggle');
