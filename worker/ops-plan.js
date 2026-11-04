/* ============================================================================
   ishur.io · ops-plan.js · "מתוכנן מול בוצע" for the סקירה screen (04/11/2026)
   ----------------------------------------------------------------------------
   Richard 04/11: "I wanna see in the סקירה what's supposed to happen today and
   what already happened. Same for week and month."

   GET /api/ops/plan?period=today|week|month   (routed from ops.js handleOps)
     → { ok, period, from, to, today, at, totals:{planned, done, in_progress, waiting, missed},
         next:{label_he, at, day, deep_link}|null,
         days:[{ day, dow_he, past, today, future, open, capacity:{capacity, planned, overflow}|null,
                 totals:{…}, items:[ITEM…] }], sources:{…} }
     ITEM = { id, kind, event:{tok8,name}, label_he, planned_at (ISO, Z), day, planned_n, done_n, failed_n,
              status: done|in_progress|waiting|missed, status_he, reason_he, deep_link, type?, extra? }

   Kinds: send (guest waves / day-before / table / event-day / thanks / gift / sub-event),
          subevent_reminder, call (Shir's round per event), lead_sends (Noa 4499 per day),
          cron (the once-a-day jobs that matter), event (an event taking place), hostess (a shift).

   Sources (all already exist; this file only composes):
     capacity planner (ops.js buildCapacity → days[].rolled / by_event), the send board (send-board.js
     sendBoardData: per event per type due / audience / sent / pending reasons), sub-events (subevent.js
     subeventBoard + the subevent:<tok> KV record), call rounds (ops-calls.js buildCallRounds), the audit
     log (wa_out / wa_status / call rows → ops.js sendsByDay / callsByDay), the runs ledger (ops-run.js
     listRuns), hostess assignments (store.js), the sheet snapshot (send-board.js eventsFromRaw).

   §1 pure (unit-tested, no I/O: periodRange, cronFires, composePlan) · §2 buildPlan (I/O via env + deps + fns)
   fns = ops.js planFns(): buildCapacity, sendsByDay, callsByDay (kept out of this file to avoid an import cycle)
   ========================================================================== */
import { eventsFromRaw } from './send-board.js';
import { subeventBoard } from './subevent.js';
import { listRuns } from './ops-run.js';
import { cronNext } from './automations.js';
import { AUTOMATIONS } from './automations-registry.js';
import { OUTCOMES } from './ops-calls.js';

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */
export const PERIODS = ['today', 'week', 'month'];
export const STATUS_HE = { done: 'בוצע', in_progress: 'בתהליך', waiting: 'ממתין', missed: 'לא קרה' };
export const KIND_HE = { send: 'שליחה לאורחים', subevent_reminder: 'תזכורת אירוע-בן', call: 'סבב שיחות', lead_sends: 'הודעות ללידים', cron: 'משימה מתוזמנת', event: 'אירוע', hostess: 'משמרת דיילת' };
export const TYPE_HE = { w1: 'גל 1 · הזמנה', w2: 'גל 2 · תזכורת', w3: 'גל 3 · שליחה נוספת', daybefore: 'הודעת יום-לפני', table: 'הודעת השולחן (יום האירוע)', eventday: 'הודעת יום האירוע', thanks: 'הודעת תודה', gift: 'הודעת מתנה', subevent: 'אירוע-בן (שבת חתן)' };
const DOW_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
/* the once-a-day jobs Richard wants to see: the daily run, the backup, the 21:00 digest (10-minute jobs such as
   calendar_build stay in the runs ledger; `dow` limits a cron to weekdays, `il_hour` picks one fire of a multi-hour cron) */
export const PLAN_CRONS = [
  { id: 'd_engine', expr: '35 6 * * *' }, { id: 'backup', expr: '35 6 * * *' }, { id: 'journal_digest', expr: '0 17,18,19 * * *', il_hour: 21 },
];
const NAME_HE = Object.fromEntries(AUTOMATIONS.map(n => [n.id, n.name_he]));

export const ilDayOf = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dowOf = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
const isShabbat = iso => dowOf(iso) === 6;
const engineDay = (iso, isNoContactDay = () => false) => !isShabbat(iso) && !isNoContactDay(iso);
const firstEngineDay = (from, to, isNoContactDay) => { for (let d = from; d <= to; d = addDays(d, 1)) if (engineDay(d, isNoContactDay)) return d; return null; };
/* ms at 00:00 Israel time (DST-safe: probe both offsets) */
export function ilDayStartMs(iso) {
  for (const off of [2, 3]) { const t = Date.parse(`${iso}T00:00:00Z`) - off * 3600e3; if (ilDayOf(t) === iso && ilDayOf(t - 1) !== iso) return t; }
  return Date.parse(`${iso}T00:00:00Z`) - 2 * 3600e3;
}
/* ISO (Z) for HH:MM on an Israel day */
export const ilAt = (day, hm = '09:00') => { const [h, m] = String(hm).split(':').map(Number); return new Date(ilDayStartMs(day) + ((h || 0) * 60 + (m || 0)) * 60e3).toISOString(); };
const ilHM = ts => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
const ilHour = ts => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(ts)));
const ddmm = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';

/* today → one day; week → Sunday…Saturday around today (Israel week); month → the calendar month */
export function periodRange(period, today) {
  if (period === 'week') { const from = addDays(today, -dowOf(today)); return { from, to: addDays(from, 6) }; }
  if (period === 'month') { const [y, m] = today.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { from: today.slice(0, 7) + '-01', to: today.slice(0, 7) + '-' + String(n).padStart(2, '0') }; }
  return { from: today, to: today };
}
export const dayList = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 62; d = addDays(d, 1)) out.push(d); return out; };

/* when a once-a-day cron fires on each Israel day of `days` → { day: ISO } (none on days it skips) */
export function cronFires(c, days) {
  const out = {};
  for (const day of days) {
    if (c.dow && !c.dow.includes(dowOf(day))) continue;
    let t = ilDayStartMs(day) - 60e3;
    for (let i = 0; i < 40; i++) {
      const n = cronNext(c.expr, new Date(t)); if (!n) break;
      const ms = Date.parse(n); if (ilDayOf(ms) !== day) break;
      t = ms;
      if (c.il_hour != null && ilHour(ms) !== c.il_hour) continue;
      out[day] = n; break;
    }
  }
  return out;
}

const PEND_REASON = { hold: 'החזקה (hold)', cap: 'מכסה', window: 'חלון סגור', queue: 'בתור', reopened: 'נכשל ונפתח לשליחה חוזרת', scheduled: 'מתוכנן' };
const dominantPending = p => { const o = Object.entries(p || {}).filter(([k, v]) => k !== 'total' && v > 0).sort((a, b) => b[1] - a[1])[0]; return o ? PEND_REASON[o[0]] || o[0] : ''; };
const WHY_SEND = { paused: 'עצירה כללית', 'off:d_pacer': 'הפייסר כבוי', cap: 'מכסה', 'wacap:guests': 'כל המספרים בתקרה', shabbat: 'שבת', 'friday-window': 'חלון שישי נסגר (13:00)', hours: 'חלון סגור', 'window-closed': 'חלון סגור' };
const WHY_CALL = { paused: 'עצירה כללית', shabbat: 'שבת', 'friday-window': 'חלון שיחות שישי נסגר', hours: 'חלון השיחות סגור' };
const tot0 = () => ({ planned: 0, done: 0, in_progress: 0, waiting: 0, missed: 0 });
const bump = (t, st) => { t.planned++; t[st]++; };

/* THE composer. Pure: same input → same output. Every field documented in the header. */
export function composePlan(inp) {
  const { period = 'today', today, now = Date.now(), isNoContactDay = () => false } = inp;
  const { from, to } = inp.range || periodRange(period, today);
  const days = dayList(from, to);
  const nowHM = ilHM(now);
  const sendWin = inp.send_window || { open: true }, callWin = inp.call_window || { open: true };
  const sendsWhy = inp.sends_why || (inp.paused ? 'paused' : sendWin.open ? 'will-send' : (sendWin.why || 'window-closed'));
  const cellOf = {};
  const capBy = Object.fromEntries(((inp.capacity && inp.capacity.days) || []).map(r => [r.day, r]));
  for (const d of days) cellOf[d] = { day: d, dow_he: DOW_HE[dowOf(d)], past: d < today, today: d === today, future: d > today, open: engineDay(d, isNoContactDay), capacity: capBy[d] ? { capacity: capBy[d].capacity, planned: capBy[d].planned, overflow: capBy[d].overflow, out: capBy[d].out ?? null } : null, totals: tot0(), items: [] };
  const push = (day, it) => { const c = cellOf[day]; if (!c) return; it.day = day; it.status_he = STATUS_HE[it.status]; c.items.push(it); bump(c.totals, it.status); };
  const names = {};
  for (const e of inp.events || []) names[String(e.token || '').slice(0, 8)] = e.name || '';
  for (const e of (inp.board && inp.board.events) || []) if (e.name) names[e.short] = names[e.short] || e.name;
  const nameOf = (tok8, fb = '') => names[tok8] || fb || tok8;
  const sendLabel = (type, tok8, fb) => `${TYPE_HE[type] || type} · ${nameOf(tok8, fb)}`;
  const sendLink = tok8 => tok8 ? `#/clients/${tok8}` : '#/messages?tab=sends';
  /* what still goes out today: the send window must be open now or open later today */
  const sendLaterToday = !inp.paused && (sendWin.open || (sendWin.why === 'hours' && ilHour(now) < 9));
  const todayStart = () => (sendWin.open ? (inp.next_tick_at || ilAt(today, nowHM)) : ilAt(today, '09:00'));

  /* ── guest sends: one entry per (day, event, type), merged from the audit, the rolled plan and the board ── */
  const M = {};
  const slot = (day, tok8, type) => { const k = `${day}|${tok8}|${type}`; return M[k] = M[k] || { day, tok8, type, planned_n: 0, done_n: 0, failed_n: 0, of: null, held: false, dropped: false, from_day: '', pending: 0, reason_he: '', name: '' }; };
  for (const s of inp.sends || []) { if (!cellOf[s.day]) continue; const e = slot(s.day, s.tok8, s.type); e.done_n += s.sent || 0; e.failed_n += s.failed || 0; }
  for (const r of (inp.capacity && inp.capacity.days) || []) {
    if (!cellOf[r.day] || r.day < today) continue;
    for (const x of r.rolled || []) { const e = slot(r.day, x.tok8, x.type); e.planned_n += x.n || 0; e.name = e.name || x.event || ''; if (x.from_day && x.from_day < r.day) e.from_day = x.from_day; }
    for (const b of r.by_event || []) { if (b.dropped) { const e = slot(r.day, b.tok8, b.type); e.dropped = true; e.planned_n = Math.max(e.planned_n, b.count || 0); e.name = e.name || b.name; } else if (b.held) { const e = slot(r.day, b.tok8, b.type); e.held = true; e.planned_n = Math.max(e.planned_n, b.count || 0); e.name = e.name || b.name; } }
  }
  const lastCap = ((inp.capacity && inp.capacity.days) || []).map(r => r.day).sort().pop() || today;
  const boardTypes = [];
  for (const ev of (inp.board && inp.board.events) || []) for (const t of ev.types || []) boardTypes.push({ ev, t, tok8: ev.short, type: t.key });
  for (const sub of (inp.board && inp.board.subevents) || []) { const t = (sub.types || [])[0]; if (t) boardTypes.push({ ev: { short: String(sub.token).slice(0, 8), name: sub.name, held: false }, tok8: String(sub.token).slice(0, 8), type: 'subevent', t: { key: 'subevent', due: today, audience: t.invited, sent: t.sent, failed: t.failed, pending: { total: t.pending, queue: t.pending } } }); }
  for (const { ev, t, tok8, type } of boardTypes) {
    const p = t.pending || {}, pendLeft = Math.max(0, (p.total || 0) - (p.scheduled || 0));
    const failedN = typeof t.failed === 'object' ? (t.failed && t.failed.total) || 0 : t.failed || 0;
    const due = t.due || '';
    /* the audience is the "of" for every entry of this event+type; pending still open → the day entries are not finished */
    for (const k of Object.keys(M)) { const e = M[k]; if (e.tok8 !== tok8 || e.type !== type) continue; e.of = t.audience ?? e.of; e.name = e.name || ev.name; if (pendLeft > 0 && e.day <= today) { e.pending = pendLeft; e.reason_he = dominantPending(p); } if (e.day < today && e.failed_n === 0 && failedN && !e.done_n) e.failed_n = failedN; }
    const seenDays = Object.values(M).filter(e => e.tok8 === tok8 && e.type === type && e.done_n > 0);
    /* sent before the audit window (KV markers): one done entry on the last send day */
    if (!seenDays.length && t.sent > 0) { const day = t.last_at ? ilDayOf(Date.parse(t.last_at)) : due; if (cellOf[day]) { const e = slot(day, tok8, type); e.done_n = t.sent; e.of = t.audience ?? null; e.name = e.name || ev.name; e.failed_n = failedN; e.pending = pendLeft; e.reason_he = pendLeft ? dominantPending(p) : 'ספירה מסימוני השליחה (מחוץ לחלון הלוג)'; } }
    /* due and never sent → a missed entry on the due day (past), or waiting beyond the planner's horizon */
    if (due && cellOf[due] && !M[`${due}|${tok8}|${type}`]) {
      if (due < today && pendLeft > 0 && !t.sent) { const e = slot(due, tok8, type); e.planned_n = t.audience || pendLeft; e.of = t.audience ?? null; e.name = ev.name; e.pending = pendLeft; e.reason_he = dominantPending(p); e.held = !!(p.hold > 0 || ev.held); }
      else if (due > lastCap && (p.scheduled || 0) > 0) { const e = slot(due, tok8, type); e.planned_n = p.scheduled; e.of = t.audience ?? null; e.name = ev.name; e.reason_he = 'מתוכנן (מחוץ לאופק המתכנן)'; }
    }
  }
  for (const e of Object.values(M)) {
    const d = e.day, c = cellOf[d]; if (!c) continue;
    let status, reason = e.reason_he, at = ilAt(d, '09:00');
    /* today: the rolled n is what STILL goes out → the day's plan = sent so far + the rest */
    const remaining = c.today ? (e.planned_n || (e.pending && !e.dropped ? e.pending : 0)) : 0;
    const planned = c.today ? e.done_n + remaining : (e.planned_n || (e.done_n && e.of) || e.done_n);
    if (c.past) {
      if (e.done_n > 0) { status = e.pending > 0 && !e.dropped ? 'in_progress' : 'done'; if (status === 'in_progress') reason = `נשלחו ${e.done_n}${e.of ? ' מתוך ' + e.of : ''} · ממשיך${reason ? ' (' + reason + ')' : ''}`; else if (e.failed_n) reason = `${e.failed_n} נכשלו`; }
      else { status = 'missed'; reason = e.dropped ? 'יום-לפני לא יצא ב-D-1 — לא עובר ליום האירוע' : e.held ? PEND_REASON.hold : reason || 'לא יצא'; }
    } else if (c.today) {
      if (e.dropped) { status = 'missed'; reason = 'יום-לפני לא יצא ב-D-1 — לא עובר ליום האירוע'; }
      else if (e.done_n > 0 && remaining === 0) { status = 'done'; if (e.failed_n) reason = `${e.failed_n} נכשלו`; }
      else if (e.done_n > 0) { status = 'in_progress'; at = sendLaterToday ? todayStart() : at; reason = [e.from_day ? `נדחה מ-${ddmm(e.from_day)} (מכסה)` : '', e.failed_n ? `${e.failed_n} נכשלו` : '', !sendLaterToday ? WHY_SEND[sendsWhy] || '' : ''].filter(Boolean).join(' · '); }
      else if (e.held) { status = 'waiting'; reason = 'מוחזק (hold) — לא יוצא עד שמשחררים'; }
      else if (sendLaterToday) { status = 'waiting'; at = todayStart(); reason = [sendsWhy === 'cap' || sendsWhy === 'wacap:guests' ? 'מכסה — ימשיך כשיתפנה מקום' : '', e.from_day ? `נדחה מ-${ddmm(e.from_day)} (מכסה)` : '', reason].filter(Boolean).join(' · '); }
      else { status = 'missed'; reason = WHY_SEND[sendsWhy] || reason || 'לא יצא'; }
    } else {
      status = 'waiting';
      if (e.held) reason = 'מוחזק (hold)';
      else reason = [e.from_day ? `נדחה מ-${ddmm(e.from_day)} (מכסה)` : '', c.capacity && c.capacity.overflow > 0 ? `היום עמוס: ${c.capacity.planned} מתוכננות מול תקרה ${c.capacity.capacity}` : '', reason].filter(Boolean).join(' · ');
    }
    push(d, { id: `send:${e.tok8}|${e.type}:${d}`, kind: 'send', type: e.type, event: { tok8: e.tok8, name: nameOf(e.tok8, e.name) }, label_he: sendLabel(e.type, e.tok8, e.name), planned_at: at, planned_n: planned || 0, done_n: e.done_n, failed_n: e.failed_n, of: e.of, status, reason_he: reason, deep_link: sendLink(e.tok8) });
  }

  /* ── sub-event reminder (one scheduled wave to non-responders) ── */
  for (const [tok, r] of Object.entries(inp.subrecs || {})) {
    if (!r || !r.reminder_at) continue;
    const day = String(r.reminder_at).slice(0, 10), hm = String(r.reminder_at).slice(11, 16) || '10:00'; if (!cellOf[day]) continue;
    const tok8 = tok.slice(0, 8), at = ilAt(day, hm);
    let status, reason = '';
    if (r.reminder_cancelled_at) { status = 'missed'; reason = 'בוטל'; }
    else if (r.reminder_completed_at) status = 'done';
    else if (r.reminder_started_at) status = 'in_progress';
    else if (day < today || (day === today && Date.parse(at) < now && !sendLaterToday)) { status = 'missed'; reason = 'לא התחיל'; }
    else status = 'waiting';
    push(day, { id: `subrem:${tok8}`, kind: 'subevent_reminder', event: { tok8, name: nameOf(tok8, r.name) }, label_he: `תזכורת אירוע-בן · ${nameOf(tok8, r.name)}`, planned_at: at, planned_n: r.reminder_n || 0, done_n: r.reminder_sent || 0, failed_n: 0, status, reason_he: reason, deep_link: `#/clients/${tok8}` });
  }

  /* ── Shir's call rounds ── */
  for (const cd of inp.calls_done || []) { if (!cellOf[cd.day] || cd.day >= today) continue; push(cd.day, { id: `call:${cd.tok8}:${cd.day}`, kind: 'call', event: { tok8: cd.tok8, name: nameOf(cd.tok8, cd.name) }, label_he: `סבב שיחות של שיר · ${nameOf(cd.tok8, cd.name)}`, planned_at: ilAt(cd.day, '10:00'), planned_n: cd.n, done_n: cd.n, failed_n: 0, answered: cd.answered || 0, status: 'done', reason_he: `${cd.n} חיוגים · ${cd.answered || 0} נענו`, deep_link: '#/calls?tab=rounds' }); }
  const callStart = callWin.open ? (inp.next_tick_at || ilAt(today, nowHM)) : ilAt(today, '10:00');
  const callLaterToday = !inp.paused && (callWin.open || (callWin.why === 'hours' && ilHour(now) < 10));
  const nextCallDay = firstEngineDay(addDays(today, 1), addDays(today, 10), isNoContactDay);
  for (const ev of (inp.call_rounds && inp.call_rounds.events) || []) {
    const codes = new Set((ev.why || []).map(w => w.code));
    if (ev.plan_no_calls || codes.has('plan')) continue;
    const dialed = ev.dialed_today || 0, rem = ev.remaining_today || 0, queued = ev.queued || 0;
    const base = { kind: 'call', event: { tok8: ev.tok8, name: nameOf(ev.tok8, ev.name) }, label_he: `סבב שיחות של שיר · ${nameOf(ev.tok8, ev.name)}`, deep_link: '#/calls?tab=rounds', failed_n: 0 };
    const outs = Object.entries(ev.outcomes_today || {}).map(([k, v]) => `${OUTCOMES[k] || k} ${v}`).join(', ');
    if (cellOf[today] && (dialed > 0 || queued > 0)) {
      let status, reason = '';
      if (dialed > 0 && (rem === 0 || !callLaterToday)) { status = 'done'; reason = `${dialed} חיוגים · ${ev.answered_today || 0} נענו${outs ? ' · ' + outs : ''}${rem && !callLaterToday ? ' · ' + rem + ' נשארו ל' + (nextCallDay ? ddmm(nextCallDay) : 'מחר') : ''}`; }
      else if (dialed > 0) { status = 'in_progress'; reason = `${ev.answered_today || 0} נענו${outs ? ' · ' + outs : ''}`; }
      else if (codes.has('event-passed') || codes.has('all-capped') || (codes.has('empty') && !queued)) continue;
      else if (!callLaterToday) { status = 'missed'; reason = (ev.why || []).filter(w => w.code !== 'window').map(w => w.he).concat(WHY_CALL[callWin.why] || (inp.paused ? '' : 'חלון השיחות סגור')).filter(Boolean).join(' · '); }
      else if (ev.will_dial || codes.has('window')) { status = 'waiting'; reason = ev.stopped ? 'הסבב נעצר ידנית' : ''; }
      else { status = 'waiting'; reason = (ev.why || []).map(w => w.he).join(' · '); }
      push(today, { ...base, id: `call:${ev.tok8}:${today}`, planned_at: status === 'waiting' ? callStart : ilAt(today, '10:00'), planned_n: dialed + (status === 'done' && !callLaterToday ? 0 : rem), done_n: dialed, answered: ev.answered_today || 0, status, reason_he: reason });
    }
    /* what is still queued lands on the next open call day */
    const left = queued - (callLaterToday ? rem : 0);
    if (left > 0 && nextCallDay && cellOf[nextCallDay] && !ev.stopped && !codes.has('event-passed') && !(ev.date && ev.date < nextCallDay)) push(nextCallDay, { ...base, id: `call:${ev.tok8}:${nextCallDay}`, planned_at: ilAt(nextCallDay, '10:00'), planned_n: left, done_n: 0, answered: 0, status: 'waiting', reason_he: ev.hold ? 'האירוע מוחזק (hold)' : `${left} אורחים בתור לשיר` });
  }

  /* ── Noa 4499 → leads: per day ── */
  const ls = inp.lead_sends || null;
  for (const d of ls ? days : []) {
    if (d > today) continue;
    const r = (ls.by_day || {})[d] || { sent: 0, failed: 0 };
    if (!r.sent && !r.failed && d < today) continue;
    const bill = d === today && ls.billing_131042 ? 'חיוב מטא חסום (131042)' : '';
    const status = r.sent > 0 ? 'done' : d === today ? 'waiting' : 'missed';
    push(d, { id: `leads:${d}`, kind: 'lead_sends', event: { tok8: '', name: '' }, label_he: 'הודעות ללידים · נועה 4499', planned_at: ilAt(d, '10:00'), planned_n: r.sent + r.failed, done_n: r.sent, failed_n: r.failed, status, reason_he: [r.failed ? `${r.failed} נכשלו` : '', bill, status === 'waiting' ? 'עדיין לא יצאו היום' : ''].filter(Boolean).join(' · '), deep_link: '#/messages' });
  }

  /* ── the once-a-day crons ── */
  for (const c of inp.crons || []) {
    const fires = c.fires || cronFires(c, days);
    for (const d of days) {
      const at = fires[d]; if (!at) continue;
      const runs = (c.runs || []).filter(r => ilDayOf(Date.parse(r.started_at)) === d);
      const okRun = runs.find(r => r.status === 'ok' || r.status === 'partial'), bad = runs.find(r => r.status === 'failed');
      let status, reason = '', when = at;
      if (okRun) { status = 'done'; when = okRun.started_at; if (okRun.status === 'partial') reason = 'חלקי'; }
      else if (bad) { status = 'missed'; when = bad.started_at; reason = 'נכשל' + (bad.error ? ': ' + String(bad.error).slice(0, 80) : ''); }
      else if (runs.some(r => r.status === 'skipped')) { status = 'done'; reason = 'דולג (אין עבודה)'; }
      else if (d < today || (d === today && Date.parse(at) < now - 15 * 60e3)) { status = 'missed'; reason = `לא רץ (היה אמור ב-${ilHM(Date.parse(at))})`; }
      else status = 'waiting';
      push(d, { id: `cron:${c.id}:${d}`, kind: 'cron', event: { tok8: '', name: '' }, label_he: c.name_he || NAME_HE[c.id] || c.id, planned_at: when, planned_n: 0, done_n: 0, failed_n: bad ? 1 : 0, status, reason_he: reason, deep_link: `#/automations/${c.id}` });
    }
  }

  /* ── events taking place ── */
  for (const e of inp.events || []) {
    if (!e.date || !cellOf[e.date]) continue;
    const tok8 = String(e.token || '').slice(0, 8), hm = /^\d{1,2}:\d{2}/.test(e.time || '') ? e.time.slice(0, 5).padStart(5, '0') : '';
    const status = e.date < today ? 'done' : e.date === today ? 'in_progress' : 'waiting';
    push(e.date, { id: `event:${tok8}`, kind: 'event', event: { tok8, name: e.name || '' }, label_he: `${e.occasion ? e.occasion + ' · ' : 'אירוע · '}${e.name || tok8}`, planned_at: ilAt(e.date, hm || '00:00'), planned_n: 0, done_n: 0, failed_n: 0, status, reason_he: status === 'in_progress' ? 'מתקיים היום' + (hm ? ' · ' + hm : '') : hm ? 'קבלת פנים ' + hm : '', deep_link: `#/clients/${tok8}` });
  }

  /* ── hostess shifts ── */
  for (const a of inp.assignments || []) {
    if (!a.date || !cellOf[a.date]) continue;
    const tok8 = String(a.event_token || '').slice(0, 8), start = a.start || '00:00', end = a.end || '';
    let status, reason = '';
    if (a.status === 'cancelled') { status = 'missed'; reason = 'בוטל'; }
    else if (a.date < today) status = 'done';
    else if (a.date > today) status = 'waiting';
    else status = end && end <= nowHM ? 'done' : start <= nowHM ? 'in_progress' : 'waiting';
    push(a.date, { id: `hostess:${a.id}`, kind: 'hostess', event: { tok8, name: nameOf(tok8, a.event_name || '') }, label_he: `דיילת · ${a.hostess_name || a.hostess_id || ''}${tok8 ? ' · ' + nameOf(tok8, a.event_name || '') : ''}`, planned_at: ilAt(a.date, start), planned_n: 0, done_n: 0, failed_n: 0, status, reason_he: reason || `${start}${end ? '–' + end : ''}`, deep_link: '#/clients?tab=hostesses' });
  }

  /* order inside a day: the event + its shifts, then the work (sends, calls, leads) by time, the crons last; totals; the next thing that will happen */
  const KO = { event: 0, hostess: 0, send: 1, subevent_reminder: 1, call: 1, lead_sends: 1, cron: 2 };
  const totals = tot0();
  for (const c of Object.values(cellOf)) { c.items.sort((a, b) => (KO[a.kind] - KO[b.kind]) || (a.planned_at < b.planned_at ? -1 : a.planned_at > b.planned_at ? 1 : String(a.label_he).localeCompare(String(b.label_he), 'he'))); for (const k of Object.keys(totals)) totals[k] += c.totals[k]; }
  const upcoming = days.flatMap(d => cellOf[d].items).filter(i => i.status === 'waiting' && Date.parse(i.planned_at) >= now - 60e3).sort((a, b) => a.planned_at < b.planned_at ? -1 : 1)[0] || null;
  const nextIt = upcoming ? { label_he: upcoming.label_he, at: upcoming.planned_at, day: upcoming.day, deep_link: upcoming.deep_link, kind: upcoming.kind } : null;
  return { ok: true, period, from, to, today, at: new Date(now).toISOString(), tz: 'Asia/Jerusalem', totals, next: nextIt, days: days.map(d => cellOf[d]), status_he: STATUS_HE, kind_he: KIND_HE };
}

/* ══ §2 I/O ════════════════════════════════════════════════════════════════ */
async function kget(env, k) { try { return env.RATE ? await env.RATE.get(k) : null; } catch { return null; } }
/* fns = ops.js planFns() */
export async function buildPlan(env, d, fns, { period = 'today', now = Date.now(), fresh = false } = {}) {
  period = PERIODS.includes(period) ? period : 'today';
  const today = d.ilDate(new Date(now));
  const ck = 'opsplan:' + period;
  if (!fresh && env.RATE) { try { const hit = JSON.parse((await env.RATE.get(ck)) || 'null'); if (hit && now - hit.at < 90e3) return { ...hit.data, cached: true }; } catch {} }
  const range = periodRange(period, today), days = dayList(range.from, range.to);
  const horizon = Math.max(1, Math.min(28, Math.round((Date.parse(range.to) - Date.parse(today)) / 864e5) + 1));
  const raw = await d.snapshotCached(env).catch(() => null);
  const { events } = raw ? eventsFromRaw(raw, today, { isTestEventRow: d.isTestEventRow, planKeyOf: d.planKeyOf, from: addDays(range.from, -30) }) : { events: [] };
  const clientId = d.clientPhoneId(env) || '';
  const errors = [];
  const safe = (name, p) => p.catch(e => { errors.push(name + ': ' + String((e && e.message) || e).slice(0, 120)); return null; });
  const [cap, board, subAll, rounds, paused, bill, pacerPending, asgRes, ...runsRes] = await Promise.all([
    range.to >= today ? safe('capacity', fns.buildCapacity(env, d, now, horizon)) : null,
    d.sendBoardData ? safe('send_board', d.sendBoardData(env, { days: 3, detail: false })) : null,
    safe('subevents', d.kvPrefix(env, 'subevent:')),
    range.to >= today && fns.buildCallRounds ? safe('call_rounds', fns.buildCallRounds(env, d, now)) : null,
    d.sendingPaused(env).catch(() => false), kget(env, 'billingalert:client'), kget(env, 'pacer:pending'),
    safe('hostesses', (async () => { const { makeStore } = await import('./store.js'); const r = await makeStore(env).list('hostess_assignments', { limit: 500 }); return (r && r.items) || []; })()),
    ...PLAN_CRONS.map(c => safe('runs:' + c.id, listRuns(env, { automation_id: c.id, from: new Date(ilDayStartMs(range.from)).toISOString(), to: new Date(ilDayStartMs(range.to) + 864e5).toISOString(), limit: 200 }))),
  ]);
  /* audit: the range's days up to today (counts only), bounded like the calendar */
  let sends = [], callsDone = [], leadByDay = {}, truncated = false;
  if (range.from <= today) {
    const toD = (range.to < today ? range.to : today).replace(/-/g, ''), fromD = range.from.replace(/-/g, '');
    const q = kind => d.auditQueryEx(env, { from: fromD, to: toD, kind, limit: 20000, budget: 1500 }).catch(() => ({ items: [], truncated: true }));
    const subTpl = new Set(Object.values(subAll || {}).map(v => { try { return JSON.parse(v).template; } catch { return ''; } }).filter(Boolean));
    const [o, st, cl] = await Promise.all([q('wa_out'), q('wa_status'), q('call')]);
    truncated = !!(o.truncated || st.truncated || cl.truncated);
    sends = fns.sendsByDay(o.items, st.items, { events, subTemplates: subTpl });
    callsDone = fns.callsByDay(cl.items);
    const wm = {};
    for (const r of o.items || []) { const dd = r.data || {}; if (String(dd.phone_id || '') !== clientId || dd.channel === 'sms') continue; const day = ilDayOf(r.ts); const s = leadByDay[day] = leadByDay[day] || { sent: 0, failed: 0 }; if (r.ok) { s.sent++; if (dd.wamid) wm[dd.wamid] = s; } else s.failed++; }
    for (const r of st.items || []) { const dd = r.data || {}; if (dd.status === 'failed' && wm[dd.wamid]) wm[dd.wamid].failed++; }
  }
  const subrecs = {};
  for (const [k, v] of Object.entries(subAll || {})) { try { const r = JSON.parse(v); if (r && r.parent) subrecs[k.replace(/^subevent:/, '')] = r; } catch {} }
  const sendWin = d.sendWindowState(new Date(now)), callWin = d.callWindowState(new Date(now));
  const capInfo = await d.guestCapacity(env).catch(() => null);
  const room = capInfo ? capInfo.remaining : 1;
  const sendsWhy = paused ? 'paused' : !sendWin.open ? (sendWin.why || 'window-closed') : room <= 0 ? 'cap' : 'will-send';
  const crons = PLAN_CRONS.map((c, i) => ({ ...c, name_he: NAME_HE[c.id] || c.id, runs: (runsRes[i] && runsRes[i].items) || [] }));
  const out = composePlan({ period, today, now, range, isNoContactDay: d.isNoContactDay, send_window: sendWin, call_window: callWin, paused: !!paused, sends_why: sendsWhy, next_tick_at: cronNext('*/10 * * * *', new Date(now)),
    sends, capacity: cap && cap.ok ? cap : null, board, subrecs, call_rounds: rounds, calls_done: callsDone, lead_sends: { by_day: leadByDay, billing_131042: !!bill }, crons, events, assignments: asgRes || [] });
  out.audit_truncated = truncated; out.pacer_pending_today = pacerPending === today;
  out.sources = { snapshot: !!raw, capacity: !!(cap && cap.ok), send_board: !!board, call_rounds: !!rounds, hostesses: !!asgRes, errors };
  if (env.RATE) await env.RATE.put(ck, JSON.stringify({ at: now, data: out }), { expirationTtl: 300 }).catch(() => {});
  return out;
}
