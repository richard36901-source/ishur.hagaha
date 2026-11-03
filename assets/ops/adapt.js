/* ishur ops · adapt: the ONLY place that knows the backend's field names.
   Real responses (contract: worker docs/OPS-API-2026-11-03.md) → the view-models the screens render.
   Live and mock both pass through here, and fixtures/ops/*.json are masked copies of real responses,
   so a contract change breaks the smoke test instead of silently breaking a screen.
   Pure functions, no DOM: the smoke test imports this in plain node. */

const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const ilHour = (iso) => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const dowOf = (day) => DOW[new Date(day + 'T12:00:00Z').getUTCDay()];
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

export const SCHEDULED = ['wave', 'daybefore', 'eventday', 'table', 'thanks', 'gift', 'subevent', 'client'];
export const REASON_HE = { wave: 'גל הזמנה', daybefore: 'יום לפני', eventday: 'יום האירוע', table: 'הושבה', thanks: 'תודה', gift: 'מתנה', subevent: 'אירוע-בן', client: 'ללקוח', reply: 'מענה', manual: 'ידני' };
export const WHY_HE = {
  'will-send': 'ישלח', paused: 'עצירה כללית (paused)', 'off:d_pacer': 'הפייסר כבוי', 'nothing-pending': 'אין מה לשלוח', cap: 'התקרה נגמרה', 'wacap:guests': 'עצירת תקרה גלובלית',
  'will-dial': 'יחייג', window: 'מחוץ לחלון', 'no-contact-day': 'יום בלי פניות',
};
const why = (w) => WHY_HE[w] || w || '—';
const RISK_SEV = { high: 'P1', medium: 'P2', low: 'P3' };
export const VENDOR_HE = { telnyx: 'Telnyx · שיחות', cloudflare: 'Cloudflare', meta_ads: 'Meta · מודעות', meta_wa: 'Meta · וואטסאפ', retell: 'Retell · שיר', anthropic: 'Anthropic' };

/* ── registry ── */
function daypart(n) {
  const cron = (n.trigger && n.trigger.cron) || '';
  if (n.layer === 3 || !(n.state && n.state.next_fire)) return 'event';
  if (/\*\/10/.test(cron) || (n.from || []).some((f) => f === 't_cron10' || f === 'd_pacer')) return 'continuous';
  const h = ilHour(n.state.next_fire);
  return h < 8 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'noon' : 'evening';
}
export function node(n) {
  const s = n.state || {}, b = s.by_status_24h || {}, fails = (b.failed || 0) + (b.partial || 0);
  const lastStatus = !s.last_run_at ? null : b.failed && !b.ok ? 'failed' : b.partial && !b.ok ? 'partial' : b.ok ? 'ok' : Object.keys(b)[0] || 'ok';
  return {
    ...n,
    daypart: daypart(n),
    next_fire: s.next_fire || null,
    kill: n.kill_switch || null,
    severity: RISK_SEV[n.risk] || 'P3',
    explain_he: n.desc_he || '',
    code: null, /* loaded on demand from /api/ops/code */
    state: { enabled: s.enabled !== false, switch_id: s.switch_id || null, disabled_by: s.off ? s.off.by : null, disabled_at: s.off ? s.off.at : null, reason: s.off ? s.off.reason : '' },
    stats: { runs_24h: s.runs_24h || 0, fail_24h: fails, by_status_24h: b, last_run: lastStatus ? { at: s.last_run_at, status: lastStatus } : null, spark_24h: [], spark_fail_24h: null },
  };
}
const registry = (r) => ({ ...r, nodes: (r.nodes || []).map(node) });

/* ── realtime ── */
const PACER_STALE_MS = 25 * 60000;
export function realtimeIncidents(rt, now = Date.now()) {
  const out = [], at = rt.at;
  const add = (severity, title, automation_id = 'd_pacer') => out.push({ at, severity, status: 'open', title, automation_id });
  const p = rt.pacer || {}, cap = rt.cap || {}, wa = rt.wa || { numbers: [] };
  if (p.off) add('P1', 'הפייסר כבוי (מתג d_pacer)');
  if (p.paused) add('P1', 'עצירה כללית פעילה (paused): לא יוצאות הודעות ושיחות');
  if (p.last_tick_at && now - Date.parse(p.last_tick_at) > PACER_STALE_MS && !p.off && !p.paused) add('P1', 'הפייסר לא רץ מעל 25 דקות');
  if (cap.wacap_guests) add('P1', 'עצירת תקרה גלובלית לאורחים פעילה', 'wa_fail');
  if (cap.all_held) add('P1', 'כל מספרי האורחים מוחזקים (held)', 'wa_fail');
  if (rt.noa && rt.noa.billing_131042) add('P1', 'נועה 4499: שגיאת חיוב 131042 של Meta (6 שעות אחרונות)', 'noa_queue');
  for (const n of wa.numbers) {
    const f = (n.rejected_today || 0) + (n.failed_async_today || 0);
    if (n.held) add('P1', n.label + ': מוחזק עד ' + (n.held_until || '—'), 'wa_fail');
    if (n.quality && n.quality !== 'GREEN') add('P2', n.label + ': דירוג ' + n.quality, 'wa_fail');
    if (f) add('P2', n.label + ': ' + f + ' כשלים היום (' + Object.entries(n.failed_by_code || {}).map(([c, k]) => c + '×' + k).join(', ') + ')', 'wa_fail');
  }
  if ((wa.unknown_numbers || []).length) add('P3', wa.unknown_numbers.length + ' מספרים לא מוכרים ביומן', 'wa_fail');
  if (rt.calls === null) add('P2', 'אין RETELL_KEY: נתוני שיחות לא זמינים', 'shir_dispatch');
  else if (rt.calls && rt.calls.source === 'retell-unreadable') add('P2', 'רשימת השיחות של Retell לא נקראה (המספרים עשויים להיות חלקיים)', 'shir_dispatch');
  return out;
}
export const capacityIncidents = (cap) => (cap ? (cap.days || []).filter((d) => d.overflow > 0).map((d) => ({ at: cap.at, severity: 'P2', status: 'open', automation_id: 'd_engine', title: 'קיבולת ' + d.day + ': מתוכנן ' + d.planned + ' מול תקרה ' + d.capacity + ' (חריגה ' + d.overflow + ')' })) : []);
export const balanceIncidents = (bal) => (bal ? (bal.vendors || []).filter((v) => v.low).map((v) => ({ at: v.as_of || bal.at, severity: 'P2', status: 'open', automation_id: 'd_pacer', title: 'יתרה נמוכה: ' + v.label })) : []);

function realtime(rt) {
  const nums = (rt.wa && rt.wa.numbers) || [], guests = nums.filter((n) => n.role === 'guests');
  const cap = rt.cap || {}, q = rt.queue || {}, c = rt.calls;
  const capTotal = cap.limit != null ? cap.limit - (cap.margin || 0) : sum(guests, (n) => n.limit);
  const numbers = nums.map((n) => {
    const r = n.by_reason || {}, failed = (n.rejected_today || 0) + (n.failed_async_today || 0);
    const reasons = { scheduled: sum(SCHEDULED, (k) => r[k]), exception: (r.reply || 0) + (r.manual || 0), failed };
    /* the client number has no tier limit: scale its bar to what happened today so it never overflows */
    return { ...n, cap: n.limit != null ? Math.max(n.limit, reasons.scheduled + reasons.exception + failed) : Math.max(1, reasons.scheduled + reasons.exception + failed), reasons };
  });
  /* per event across numbers */
  const ev = {};
  for (const n of nums) for (const [tok8, x] of Object.entries(n.by_event || {})) {
    const e = (ev[tok8] = ev[tok8] || { token: tok8, sent: 0, numbers: [], reasons: {} });
    e.sent += x.total || 0; e.numbers.push(n.label.split(' · ')[0]);
    for (const [k, v] of Object.entries(x)) if (k !== 'total') e.reasons[k] = (e.reasons[k] || 0) + v;
  }
  const by_event = Object.values(ev).sort((a, b) => b.sent - a.sent).map((e) => {
    const top = Object.entries(e.reasons).sort((a, b) => b[1] - a[1])[0];
    return { token: e.token, sent: e.sent, number: e.numbers.join(', '), reason_top: top ? (REASON_HE[top[0]] || top[0]) + ' ' + top[1] : '—' };
  });
  const calls = c ? {
    ...c, out: c.dialed || 0, cap: (c.dialed || 0) + (c.capacity_left_today || 0), remaining: c.remaining_today || 0,
    window: { open: !!(q.calls && q.calls.call_window && q.calls.call_window.open) }, why: q.calls ? why(q.calls.why) : '',
    by_event: Object.entries(c.by_event || {}).map(([tok8, x]) => ({ token: tok8, ...x, out: x.dialed || 0, remaining: x.queued || 0, why: [x.in_progress ? x.in_progress + ' בשיחה' : '', x.voicemail ? x.voicemail + ' תא קולי' : '', x.no_answer ? x.no_answer + ' לא ענו' : ''].filter(Boolean).join(' · ') || (x.queued ? 'בתור לחיוג' : '—') })),
  } : null;
  const next = [];
  if (q.next_tick_at) {
    next.push({ at: q.next_tick_at, automation_id: 'd_pacer', name: 'הפייסר · שליחות', what: q.sends ? (q.sends.will_run ? 'עד ' + q.sends.max + ' הודעות' : why(q.sends.why)) : '—' });
    if (q.calls) next.push({ at: q.next_tick_at, automation_id: 'shir_dispatch', name: 'שיר · חיוגים', what: q.calls.will_run ? 'עד ' + q.calls.dials_max + ' חיוגים' + (q.calls.callbacks ? ' (' + q.calls.callbacks + ' חזרות)' : '') : why(q.calls.why) });
    if (q.autoretry) next.push({ at: q.next_tick_at, automation_id: 'autoretry', name: 'ניסיון חוזר יומי', what: q.autoretry.off ? 'כבוי' : q.autoretry.done_today ? 'כבר רץ היום' : q.autoretry.will_run ? 'ירוץ בפעימה הזו' : 'לא בפעימה הזו' });
    if ((q.event_day_due || []).length) next.push({ at: q.next_tick_at, automation_id: 'event_day_blast', name: 'הודעת יום האירוע', what: q.event_day_due.length + ' אירועים' });
    if (q.late_invites_waiting) next.push({ at: q.next_tick_at, automation_id: 'late_invites', name: 'הזמנות מאוחרות', what: q.late_invites_waiting + ' ממתינות' });
  }
  const incidents = realtimeIncidents(rt);
  return {
    ...rt,
    wa: { ...(rt.wa || {}), numbers, by_event, recent: [] },
    calls, next, incidents,
    summary: {
      wa_sent_today: sum(guests, (n) => n.sent_today), wa_cap_total: capTotal, wa_remaining: cap.remaining,
      calls_today: c ? c.dialed : null, calls_answered: c ? c.answered : null,
      failures_today: rt.wa && rt.wa.totals ? (rt.wa.totals.rejected_today || 0) + (rt.wa.totals.failed_async_today || 0) : 0,
      incidents_open: incidents.length, balances_low: null, paused: !!(rt.pacer && (rt.pacer.paused || rt.pacer.off)),
      holds: q.holds || 0,
    },
  };
}

/* ── capacity ── */
const TYPE_HE = { fits: 'נכנס', move: 'להזיז', no_window: 'אין חלון', split: 'לפצל' };
function capacity(c) {
  const days = (c.days || []).map((d) => ({
    ...d, date: d.day, dow: dowOf(d.day), planned_wa: d.planned || 0, capacity_wa: d.capacity || 0, no_contact: !d.open, closed_reason: d.open ? '' : 'סגור',
    events: (d.by_event || []).map((e) => ({ ...e, kind: (e.type_he || e.type) + (e.held ? ' · מוחזק' : '') + (e.upper_bound ? ' · עד' : '') + (e.manual ? ' · ידני' : ''), planned_wa: e.count })),
  }));
  return {
    ...c, days,
    alerts: days.filter((d) => d.overflow > 0).map((d) => ({ date: d.day, kind: 'wa', over_by: d.overflow, msg: 'מתוכנן ' + d.planned + ' מול תקרה ' + d.capacity })),
    recommendations: (c.recommendations || []).map((r) => ({ ...r, event_date: r.due, wave: TYPE_HE[r.kind] || r.kind, send_on: r.day || r.needs_capacity_by || (r.split && r.split[0] && r.split[0].day) || r.due, planned: r.count, reason: r.he })),
  };
}

/* ── balances ── */
function vendor(v) {
  const x = v.extra || {}, manual = v.source === 'manual';
  const out = { ...v, label: VENDOR_HE[v.vendor] || v.vendor, as_of: manual ? x.manual_set_at || null : v.checked_at, auto_topup: v.auto_topup === 'on' ? true : v.auto_topup === 'off' ? false : 'unknown', low: v.status === 'low', stale_days: x.stale_days };
  let note = v.error || x.why || x.note || '';
  if (v.vendor === 'meta_wa') { out.spent_month = v.amount; out.amount = null; note = 'הוצאה החודש, לא יתרה' + (x.wabas ? ' · ' + x.wabas.map((w) => w.name + ' ' + w.spend_mtd + '$').join(' · ') : ''); }
  if (v.vendor === 'meta_ads') note = (x.amount_meaning === 'spend_cap − amount_spent' ? 'יתרה עד תקרת ההוצאה' : 'אין תקרת הוצאה') + (x.balance_owed != null ? ' · חוב שלא חויב ' + x.balance_owed + ' ' + v.currency : '');
  if (v.vendor === 'cloudflare' && v.currency === 'requests_mtd') { out.usage_requests = v.amount; out.amount = null; note = v.amount + ' בקשות החודש'; }
  if (v.vendor === 'retell' && x.concurrency) note = (x.billing_guard_tripped ? 'שומר החיוב הופעל · ' : '') + 'מקביליות ' + x.concurrency.current_concurrency + '/' + x.concurrency.concurrency_limit + (manual && v.amount == null ? ' · יתרה: להזין ידנית' : '');
  if (manual && v.amount == null && !note) note = 'אין API ליתרה: להזין ידנית';
  out.note = note;
  return out;
}
const balances = (b) => ({ ...b, vendors: (b.vendors || []).map(vendor) });

/* ── runs / run / live / code / toggle ── */
export function run(r, names = {}) {
  const c = r.counts || {};
  return { ...r, name: names[r.automation_id] || r.automation_id, skip_reason: c.skip_reason || '', duration_ms: r.ended_at && r.started_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null, handled: '', error_class: '' };
}
const runs = (d, aux) => ({ ...d, items: (d.items || []).map((r) => run(r, aux.names)) });
function runOne(d, aux) {
  const audit = (d.audit || []).map((a) => ({ ...a, summary: a.action + (a.run_match ? ' ✓' : '') }));
  const logs = [{ ts: d.run.started_at, level: 'info', msg: 'התחיל · ' + d.run.automation_id + ' · ' + d.run.triggered_by }, ...(d.run.summary ? [{ ts: d.run.ended_at, level: 'info', msg: String(d.run.summary).slice(0, 600) }] : []), ...(d.run.error ? [{ ts: d.run.ended_at, level: 'error', msg: d.run.error }] : []), { ts: d.run.ended_at, level: 'info', msg: 'הסתיים · ' + d.run.status }];
  return { ...d, run: run(d.run, aux.names), children: (d.children || []).map((c) => run(c, aux.names)), audit, logs };
}
const PRIVATE = new Set(['wa_in', 'wa_out', 'wa_status']);
const KEYISH = /("?(?:webhookKey|admin_key|api_?key|secret|password|signature)"?\s*[:=]\s*"?)[^",\s}&]+/gi;
export function liveItem(it, names = {}) {
  if (it.type === 'run') return { ...it, kind: 'cron', level: it.status === 'failed' ? 'error' : it.status === 'partial' ? 'warn' : '', number: '', event: '', msg: (names[it.automation_id] || it.automation_id) + ' · ' + it.status + (it.triggered_by ? ' · ' + it.triggered_by : '') };
  const detail = typeof it.detail === 'string' && it.detail && !it.detail.startsWith('{') && !PRIVATE.has(it.kind) ? ' · ' + it.detail.slice(0, 140) : '';
  return { ...it, level: it.ok === false ? 'error' : '', number: it.area || '', event: it.token ? it.token.slice(0, 8) : '', msg: ((it.action || '') + detail).replace(KEYISH, '$1•••') };
}
const live = (d, aux) => ({ ...d, items: (d.items || []).map((x) => liveItem(x, aux.names)) });
const code = (d) => ({ ...d, code: { file: d.file, start: d.line_start, line: d.line_start, lines: String(d.source || '').split('\n'), truncated: d.truncated } });
function toggle(t) {
  const br = t.blast_radius || {}, m = br.messages_next_days || {}, cs = br.calls_stopped || {};
  const impact = [];
  if (m.total) impact.push({ label: 'הודעות ב-' + (br.horizon_days || 7) + ' הימים הקרובים' + (m.by_type ? ' (' + Object.entries(m.by_type).map(([k, v]) => k + ' ' + v).join(', ') + ')' : ''), count: m.total });
  if (m.partial_total) impact.push({ label: 'הודעות שנעצרות חלקית (יש עוד מפעיל)', count: m.partial_total });
  if (cs.queued) impact.push({ label: 'חיוגים בתור', count: cs.queued });
  if (cs.callbacks) impact.push({ label: 'חזרות טלפוניות בתור', count: cs.callbacks });
  for (const e of br.events_affected || []) impact.push({ label: 'הודעות · ' + e.name + ' (' + (e.days || []).join(', ') + ')', count: e.messages });
  return { ...t, needs_confirm: !t.applied && !!t.confirm_required, blast: { downstream: (br.downstream || []).map((d) => ({ id: d.id, name: d.name_he + (d.fully_stopped === false ? ' · חלקית' : '') })), impact } };
}

const MAP = { registry, realtime, capacity, balances, runs, run: runOne, live, code, toggle };
/* adapt(name, data, aux) · aux.names = {automation_id: name_he} from the cached registry */
export function adapt(name, data, aux = {}) {
  const f = MAP[name];
  if (!f || !data || data.ok === false) return data;
  return f(data, { names: aux.names || {} });
}
