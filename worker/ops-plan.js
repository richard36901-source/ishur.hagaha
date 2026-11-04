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
export const TYPE_HE = { w1: 'גל 1 · הזמנה', w2: 'גל 2 · תזכורת', w3: 'גל 3 · שליחה נוספת', daybefore: 'הודעת יום-לפני', table: 'הודעת השולחן (יום האירוע)', eventday: 'הודעת יום האירוע', thanks: 'הודעת תודה', gift: 'הודעת מתנה', subevent: 'אירוע-בן (שבת חתן)', reply: 'תשובות לאורחים' };
const DOW_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
/* the once-a-day jobs Richard wants to see: the daily run, the backup, the 21:00 digest (10-minute jobs such as
   calendar_build stay in the runs ledger; `dow` limits a cron to weekdays, `il_hour` picks one fire of a multi-hour cron) */
export const PLAN_CRONS = [
  { id: 'd_engine', expr: '35 6 * * *' }, { id: 'backup', expr: '35 6 * * *' }, { id: 'journal_digest', expr: '0 17,18,19 * * *', il_hour: 21 },
];
const NAME_HE = Object.fromEntries(AUTOMATIONS.map(n => [n.id, n.name_he]));
/* 04/11 "תמונה מלאה": plain-Hebrew titles for the crons (the registry names carry function names) and the event column of system rows */
export const CRON_HE = { d_engine: 'המנוע היומי של הבוקר (גלים, יום-לפני, תודה)', backup: 'גיבוי יומי של הגיליון', journal_digest: 'דוח יומי לסלאק (21:00)' };
export const SYSTEM_EVENT = 'מערכת';
export const LEADS_EVENT = 'לידים · נועה 4499';
/* the kinds that "go out" — what the top status line counts (events and hostess shifts are context, not work) */
export const WORK_KINDS = new Set(['send', 'subevent_reminder', 'call', 'lead_sends', 'cron']);
const SUB_KIND_HE = 'שבת חתן';
const subLabel = (name) => { const n = String(name || '').trim(); return n.includes(SUB_KIND_HE) ? n : `${SUB_KIND_HE} · ${n || 'אירוע-בן'}`; };

/* 04/11: every helper tolerates a bad timestamp (one odd audit row crashed the whole block with "Invalid time value") */
const okD = ts => { const d = new Date(ts); return Number.isFinite(d.getTime()) ? d : null; };
export const ilDayOf = ts => { const d = okD(ts); return d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d) : ''; };
export const addDays = (iso, n) => { const d = okD(Date.parse(String(iso).slice(0, 10) + 'T12:00:00Z') + n * 864e5); return d ? d.toISOString().slice(0, 10) : ''; };
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
export const ilAt = (day, hm = '09:00') => { const [h, m] = String(hm).split(':').map(Number); const d = okD(ilDayStartMs(day) + ((h || 0) * 60 + (m || 0)) * 60e3); return d ? d.toISOString() : ''; };
const ilHM = ts => { const d = okD(ts); return d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) : ''; };
const ilHour = ts => { const d = okD(ts); return d ? Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(d)) : 0; };
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
  const outDays = dayList(from, to);
  /* 04/11: the today view also carries tomorrow (the sub-event reminder at 10:00, the first waves) as a lookahead */
  const look = period === 'today' && outDays.length === 1 ? addDays(to, 1) : '';
  const days = look ? [...outDays, look] : outDays;
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
  /* sub-events (שבת חתן): own block below — they have no due date, they run from the KV record (started_at / completed_at) */
  const subs = subList(inp);
  const subToday = {};
  for (const sb of subs) { const t8 = String(sb.token).slice(0, 8), k = `${today}|${t8}|subevent`; if (M[k]) { subToday[t8] = M[k]; delete M[k]; } names[t8] = names[t8] || sb.name || ''; }
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

  /* ── sub-events (שבת חתן): one row today per started / scheduled sub-event, from its KV record + today's audit ── */
  const subBy = {};
  for (const sb of subs) {
    const t8 = String(sb.token).slice(0, 8); subBy[sb.token] = sb;
    if (!cellOf[today]) continue;
    const sl = subToday[t8] || null;
    const doneT = sl ? sl.done_n : 0, failT = sl ? sl.failed_n : 0;
    const completedToday = !!sb.completed_at && ilDayOf(Date.parse(sb.completed_at)) === today;
    if (sb.completed_at && !completedToday && !doneT) continue;            /* finished on an earlier day */
    const sentAll = Number(sb.sent) || 0, invited = Number(sb.invited) || 0;
    const started = !!sb.started_at || sentAll > 0;
    const pending = sb.completed_at ? 0 : Math.max(0, sb.pending != null ? Number(sb.pending) || 0 : invited - sentAll);
    const rolled = sl && sl.planned_n ? sl.planned_n : null;                  /* the planner's share of today (capacity) */
    const goes = rolled != null ? Math.min(pending, rolled) : pending;
    const planned = doneT + goes;
    const tail = [sb.replied ? `${sb.replied} ענו` : '', `סה״כ ${sentAll}${invited ? ' מתוך ' + invited : ''}`, failT ? `${failT} נכשלו היום` : ''].filter(Boolean);
    let status, reason, at = ilAt(today, '09:00'), needs = false, self = false, block = '';
    if (!started) { needs = true; status = sendLaterToday ? 'waiting' : 'missed'; reason = 'לא התחיל — שליחה ידנית: מחכה ללחיצה שלך על "שלח"'; }
    else if (pending === 0) { status = 'done'; reason = [`נשלחו ${doneT} היום`, ...tail].join(' · '); }
    else if (!sendLaterToday) { self = !inp.paused; needs = !!inp.paused; status = doneT > 0 ? 'in_progress' : 'missed'; reason = [`נשלחו ${doneT} מתוך ${planned} היום`, inp.paused ? 'עצירה כללית' : `${WHY_SEND[sendsWhy] || 'החלון נסגר'} — ממשיך לבד ביום השליחה הבא מ-09:00`, ...tail].join(' · '); }
    else {
      self = true; status = doneT > 0 ? 'in_progress' : 'waiting'; at = todayStart();
      const capNote = sendsWhy === 'cap' || sendsWhy === 'wacap:guests' ? 'מכסה מלאה — ממשיך כשמתפנה מקום' : 'ממשיך לבד כל 10 דקות';
      if (sendsWhy === 'cap' || sendsWhy === 'wacap:guests') block = 'cap';
      reason = [`נשלחו ${doneT} מתוך ${planned} היום`, capNote, ...tail].join(' · ');
    }
    push(today, { id: `send:${t8}|subevent:${today}`, kind: 'send', type: 'subevent', event: { tok8: t8, name: sb.name || nameOf(t8) }, label_he: subLabel(sb.name), planned_at: at, planned_n: planned, done_n: doneT, failed_n: failT, of: invited || null,
      status, reason_he: reason, needs_you: needs, self_heals: self, block, deep_link: sb.parent ? `#/clients/${String(sb.parent).slice(0, 8)}` : '#/messages?tab=sends', extra: { invited, sent_total: sentAll, pending, replied: Number(sb.replied) || 0, started_at: sb.started_at || '', completed_at: sb.completed_at || '' } });
  }

  /* ── replies to guests today (free-text answers inside the 24h window), per event — straight from realtime's by_event ── */
  const rtNums = (inp.rt && inp.rt.wa && inp.rt.wa.numbers) || [];
  if (cellOf[today]) {
    const rep = {};
    for (const n of rtNums) if (n.role === 'guests') for (const [t8, e] of Object.entries(n.by_event || {})) if (t8 !== '—' && e && e.reply) rep[t8] = (rep[t8] || 0) + e.reply;
    for (const [t8, n] of Object.entries(rep)) push(today, { id: `send:${t8}|reply:${today}`, kind: 'send', type: 'reply', event: { tok8: t8, name: nameOf(t8) }, label_he: `${TYPE_HE.reply} · ${nameOf(t8)}`, planned_at: ilAt(today, '09:00'), planned_n: n, done_n: n, failed_n: 0, status: 'done', reason_he: 'תשובות שנשלחו לאורחים בתוך חלון 24 השעות', deep_link: `#/clients/${t8}` });
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
    push(day, { id: `subrem:${tok8}`, kind: 'subevent_reminder', event: { tok8, name: nameOf(tok8, r.name) }, label_he: `תזכורת · ${subLabel(r.name || nameOf(tok8))}`, planned_at: at, planned_n: r.reminder_n || (subBy[tok] ? Math.max(0, (Number(subBy[tok].sent) || 0) - (Number(subBy[tok].replied) || 0)) : 0), done_n: r.reminder_sent || 0, failed_n: 0, status, reason_he: reason || (status === 'waiting' ? `לא ענו — יוצאת לבד ב-${hm}` : ''), self_heals: status === 'waiting', deep_link: `#/clients/${tok8}` });
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
      else if (dialed > 0) { status = 'in_progress'; reason = `${dialed} חיוגים מתוך ${dialed + rem} · ${ev.answered_today || 0} נענו${outs ? ' · ' + outs : ''} · נשארו ${rem} — ממשיכה לבד`; }
      else if (codes.has('event-passed') || codes.has('all-capped') || (codes.has('empty') && !queued)) continue;
      else if (!callLaterToday) { status = 'missed'; reason = (ev.why || []).filter(w => w.code !== 'window').map(w => w.he).concat(WHY_CALL[callWin.why] || (inp.paused ? '' : 'חלון השיחות סגור')).filter(Boolean).join(' · '); }
      else if (ev.will_dial || codes.has('window')) { status = 'waiting'; reason = ev.stopped ? 'הסבב נעצר ידנית' : ''; }
      else { status = 'waiting'; reason = (ev.why || []).map(w => w.he).join(' · '); }
      const oc = ev.outcomes_today || {};
      push(today, { ...base, id: `call:${ev.tok8}:${today}`, planned_at: status === 'waiting' ? callStart : ilAt(today, '10:00'), planned_n: dialed + (status === 'done' && !callLaterToday ? 0 : rem), done_n: dialed, answered: ev.answered_today || 0, status, reason_he: reason,
        self_heals: status !== 'done' && status !== 'missed' ? !ev.stopped && !ev.hold : status === 'done' && rem > 0, needs_you: !!(ev.stopped || ev.hold) && status !== 'done',
        extra: { dialed, answered: ev.answered_today || 0, coming: oc.coming || 0, not_coming: oc.not_coming || 0, maybe: oc.maybe || 0, left: rem, queued } });
    }
    /* what is still queued lands on the next open call day */
    const left = queued - (callLaterToday ? rem : 0);
    if (left > 0 && nextCallDay && cellOf[nextCallDay] && !ev.stopped && !codes.has('event-passed') && !(ev.date && ev.date < nextCallDay)) push(nextCallDay, { ...base, id: `call:${ev.tok8}:${nextCallDay}`, planned_at: ilAt(nextCallDay, '10:00'), planned_n: left, done_n: 0, answered: 0, status: 'waiting', reason_he: ev.hold ? 'האירוע מוחזק (hold)' : `${left} אורחים בתור לשיר` });
  }

  /* ── Noa 4499 → leads: per day ── */
  const cn = rtNums.find(n => n.role === 'client') || null;
  const ls = inp.lead_sends || (cn ? { by_day: {} } : null);
  for (const d of ls ? days : []) {
    if (d > today) continue;
    if (d === today && cn) {
      const sent = cn.sent_today || 0, rej = cn.rejected_today || 0, fa = cn.failed_async_today || 0, failed = rej + fa, delivered = Math.max(0, sent - fa), codes = cn.failed_by_code || {};
      const b131 = (codes['131042'] || 0) > 0 || !!ls.billing_131042;
      const status = sent + rej === 0 ? 'waiting' : failed > 0 && failed >= delivered ? 'missed' : 'done';
      const codeTxt = Object.entries(codes).filter(([, v]) => v > 0).map(([k, v]) => `${k} ×${v}`).join(', ');
      push(d, { id: `leads:${d}`, kind: 'lead_sends', event: { tok8: '', name: LEADS_EVENT }, label_he: 'הודעות ללידים · נועה 4499', planned_at: ilAt(d, '10:00'), planned_n: sent + rej, done_n: delivered, failed_n: failed, sent_n: sent,
        status, reason_he: [`נשלחו ${sent}`, rej ? `נדחו ${rej}` : '', failed ? `נכשלו ${failed}${codeTxt ? ' (' + codeTxt + ')' : ''}` : '', b131 && failed ? 'חיוב מטא חסום (131042) — צריך אותך' : '', status === 'waiting' ? 'עדיין לא יצאו היום' : ''].filter(Boolean).join(' · '),
        needs_you: b131 && failed > 0, self_heals: status === 'waiting', deep_link: '#/messages' });
      continue;
    }
    const r = (ls.by_day || {})[d] || { sent: 0, failed: 0 };
    if (!r.sent && !r.failed && d < today) continue;
    const bill = d === today && ls.billing_131042 ? 'חיוב מטא חסום (131042)' : '';
    const status = r.sent > 0 ? 'done' : d === today ? 'waiting' : 'missed';
    push(d, { id: `leads:${d}`, kind: 'lead_sends', event: { tok8: '', name: LEADS_EVENT }, label_he: 'הודעות ללידים · נועה 4499', planned_at: ilAt(d, '10:00'), planned_n: r.sent + r.failed, done_n: r.sent, failed_n: r.failed, status, reason_he: [r.failed ? `${r.failed} נכשלו` : '', bill, status === 'waiting' ? 'עדיין לא יצאו היום' : ''].filter(Boolean).join(' · '), deep_link: '#/messages' });
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
      push(d, { id: `cron:${c.id}:${d}`, kind: 'cron', event: { tok8: '', name: SYSTEM_EVENT }, label_he: CRON_HE[c.id] || c.name_he || NAME_HE[c.id] || `משימה מתוזמנת · ${c.id}`, planned_at: when, planned_n: 0, done_n: 0, failed_n: bad ? 1 : 0, status, reason_he: reason, deep_link: `#/automations/${c.id}` });
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

  /* every row says whether it heals by itself or needs Richard (explicit flags win; the rest by status + its fixed-vocabulary reason) */
  for (const c of Object.values(cellOf)) for (const it of c.items) {
    it.time_hm = ilHM(Date.parse(it.planned_at));
    if (!it.event || !it.event.name) it.event = { tok8: (it.event && it.event.tok8) || '', name: (it.event && it.event.tok8) ? nameOf(it.event.tok8) || it.event.tok8 : SYSTEM_EVENT };
    if (!WORK_KINDS.has(it.kind)) { it.needs_you = false; it.self_heals = false; continue; }
    const r = String(it.reason_he || '');
    if (it.needs_you == null && it.self_heals == null) {
      if (it.status === 'done') { it.needs_you = false; it.self_heals = false; }
      else if (it.status === 'missed') { it.self_heals = /מכסה|חלון|שבת|שישי/.test(r) && !/עצירה|הפייסר כבוי|hold|מוחזק|יום-לפני לא יצא/.test(r); it.needs_you = !it.self_heals; }
      else { it.needs_you = /hold|מוחזק|עצירה|הפייסר כבוי/.test(r); it.self_heals = !it.needs_you; }
    }
    it.needs_you = !!it.needs_you; it.self_heals = !!it.self_heals;
    if (!it.block && it.status !== 'done' && /מכסה/.test(r)) it.block = 'cap';
  }

  /* order inside a day: the event + its shifts, then the work (sends, calls, leads) by time, the crons last; totals; the next thing that will happen */
  const KO = { event: 0, hostess: 0, send: 1, subevent_reminder: 1, call: 1, lead_sends: 1, cron: 2 };
  const totals = tot0();
  for (const c of Object.values(cellOf)) c.items.sort((a, b) => (KO[a.kind] - KO[b.kind]) || (a.planned_at < b.planned_at ? -1 : a.planned_at > b.planned_at ? 1 : String(a.label_he).localeCompare(String(b.label_he), 'he')));
  for (const d of outDays) for (const k of Object.keys(totals)) totals[k] += cellOf[d].totals[k];
  const upcoming = days.flatMap(d => cellOf[d].items).filter(i => i.status === 'waiting' && Date.parse(i.planned_at) >= now - 60e3).sort((a, b) => a.planned_at < b.planned_at ? -1 : 1)[0] || null;
  const nextIt = upcoming ? { label_he: upcoming.label_he, at: upcoming.planned_at, day: upcoming.day, deep_link: upcoming.deep_link, kind: upcoming.kind } : null;
  const out = { ok: true, period, from, to, today, at: new Date(now).toISOString(), tz: 'Asia/Jerusalem', totals, next: nextIt, days: outDays.map(d => cellOf[d]), status_he: STATUS_HE, kind_he: KIND_HE };
  if (look) { const c = cellOf[look]; out.tomorrow = { ...c, items: c.items.filter(i => i.kind !== 'cron') }; }
  if (cellOf[today]) out.status = todayStatus(cellOf[today].items, { ...inp, now, today, sendLaterToday, callLaterToday, sendsWhy, nextCallDay });
  return out;
}

/* ── the top line of the סקירה: "did everything that should go out today go out?" + one red line per real problem.
   Numbers (sent / failed / per number) are realtime's own (inp.rt = buildRealtime over the same audit rows);
   calls are /api/ops/call-rounds' own (inp.call_rounds). Pure. ── */
const closeHM = (today, kind) => (dowOf(today) === 5 ? '13:00' : '20:30');
export function todayStatus(items, ctx) {
  const { rt = null, call_rounds: rounds = null, now = Date.now(), today, paused = false, sendLaterToday = true, callLaterToday = true, nextCallDay = null, snapshot_ok = true } = ctx;
  /* a lead-sends row with nothing sent is not a plan (leads are answered when they write) — it is not counted */
  const work = items.filter(i => WORK_KINDS.has(i.kind) && !(i.kind === 'lead_sends' && !i.planned_n && !i.done_n && !i.needs_you));
  const n = { total: work.length, done: 0, in_progress: 0, waiting: 0, missed: 0, needs_you: 0, self: 0, rolls: 0 };
  for (const i of work) { n[i.status]++; if (i.needs_you) n.needs_you++; else if (i.status === 'waiting' || i.status === 'in_progress') n.self++; else if (i.status === 'missed' && i.self_heals) n.rolls++; }
  /* realtime's numbers, verbatim */
  const nums = (rt && rt.wa && rt.wa.numbers) || [], T = (rt && rt.wa && rt.wa.totals) || {};
  const sum = (role, f) => nums.filter(x => !role || x.role === role).reduce((a, x) => a + (x[f] || 0), 0);
  const codesOf = role => { const o = {}; for (const x of nums.filter(y => y.role === role)) for (const [k, v] of Object.entries(x.failed_by_code || {})) o[k] = (o[k] || 0) + v; return o; };
  const rEv = (rounds && rounds.events) || [];
  const numbers = {
    wa_sent: T.sent_today || 0, wa_rejected: T.rejected_today || 0, wa_failed_async: T.failed_async_today || 0, wa_failed: (T.rejected_today || 0) + (T.failed_async_today || 0),
    guests_sent: sum('guests', 'sent_today'), guests_failed: sum('guests', 'rejected_today') + sum('guests', 'failed_async_today'),
    noa_sent: sum('client', 'sent_today'), noa_failed: sum('client', 'rejected_today') + sum('client', 'failed_async_today'),
    calls_dialed: rounds && rounds.totals ? rounds.totals.dialed_today || 0 : rEv.reduce((a, e) => a + (e.dialed_today || 0), 0),
    calls_answered: rEv.reduce((a, e) => a + (e.answered_today || 0), 0), calls_left: rounds && rounds.totals ? rounds.totals.remaining_today || 0 : rEv.reduce((a, e) => a + (e.remaining_today || 0), 0),
    calls_coming: rEv.reduce((a, e) => a + ((e.outcomes_today || {}).coming || 0), 0), calls_not_coming: rEv.reduce((a, e) => a + ((e.outcomes_today || {}).not_coming || 0), 0),
  };
  const P = [];
  const add = (p) => { if (!P.some(x => x.code === p.code)) P.push(p); };
  const mk = rt && rt.make;
  if ((mk && ((mk.reader && !mk.reader.ok) || (mk.writer && !mk.writer.ok))) || !snapshot_ok) {
    const since = mk && ((mk.reader && mk.reader.failing_since) || (mk.writer && mk.writer.failing_since));
    add({ code: 'make', needs_you: true, self_heals: false, title_he: 'Make לא עונה — הגיליון לא נקרא ולא נכתב',
      cause_he: `Make מושהה או שנגמרו לו הקרדיטים${since ? ' (מאז ' + ilHM(Date.parse(since)) + ')' : ''}${mk && mk.outbox && mk.outbox.size ? ` · ${mk.outbox.size} כתיבות ממתינות בתור` : ''}`,
      fix_he: 'להיכנס ל-Make, לבדוק קרדיטים ולהפעיל את התרחיש. הכתיבות שבתור ייכתבו לבד כש-Make יחזור.' });
  }
  const cc = codesOf('client');
  if ((cc['131042'] || 0) > 0 || (rt && rt.noa && rt.noa.billing_131042) || (ctx.lead_sends && ctx.lead_sends.billing_131042)) {
    add({ code: '131042', needs_you: true, self_heals: false, title_he: `נועה 4499: ${cc['131042'] || 0} הודעות ללידים נכשלו היום (131042)`, cause_he: 'מטא חוסמת שליחה מ-4499 בגלל בעיית תשלום בחשבון ה-WhatsApp', fix_he: 'לעדכן אמצעי תשלום ב-WhatsApp Manager של 4499. לא מתקן את עצמו.' });
  }
  if (paused) add({ code: 'paused', needs_you: true, self_heals: false, title_he: 'השליחה עצורה (עצירה כללית)', cause_he: 'מישהו לחץ על "עצור הכל"', fix_he: 'לשחרר במסך השליטה כשמוכנים.' });
  const why = rt && rt.queue && rt.queue.sends && rt.queue.sends.why;
  if (why === 'off:d_pacer') add({ code: 'pacer_off', needs_you: true, self_heals: false, title_he: 'הפייסר כבוי — שום דבר לא יוצא לבד', cause_he: 'auto:off:d_pacer', fix_he: 'להדליק במסך האוטומציות.' });
  const sendPending = work.filter(i => (i.kind === 'send' || i.kind === 'subevent_reminder') && i.status !== 'done' && !i.needs_you);
  const capFull = (rt && rt.cap && (rt.cap.remaining <= 0 || rt.cap.all_held)) || why === 'cap' || why === 'wacap:guests' || ctx.sends_why === 'cap' || ctx.sends_why === 'wacap:guests';
  if (capFull && sendPending.length) {
    const frees = nums.filter(x => x.role === 'guests').map(x => Date.parse(x.frees_at || x.held_until || '')).filter(t => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0];
    const until = frees ? ilHM(frees) : '';
    add({ code: 'cap', needs_you: false, self_heals: true, until_hm: until, title_he: `התקרה של מטא מלאה${until ? ' עד ' + until : ''}`,
      cause_he: rt && rt.cap ? `${rt.cap.used ?? '?'} מתוך ${rt.cap.limit ?? '?'} הודעות ב-24 השעות האחרונות` : 'כל מספרי האורחים בתקרה', fix_he: `לא צריך לעשות כלום — השליחה ממשיכה לבד${until ? ' ב-' + until : ' כשמתפנה מקום'}.` });
  }
  if (!sendLaterToday && !paused && sendPending.length) add({ code: 'send_window', needs_you: false, self_heals: true, title_he: `חלון השליחה נסגר — ${sendPending.reduce((a, i) => a + Math.max(0, (i.planned_n || 0) - (i.done_n || 0)), 0)} הודעות יוצאות לבד ביום השליחה הבא`, cause_he: `שולחים א׳–ה׳ 09:00–20:30, ו׳ עד 13:00`, fix_he: 'לא צריך לעשות כלום.' });
  const callsLeft = work.filter(i => i.kind === 'call' && i.extra && i.extra.left > 0);
  if (!callLaterToday && !paused && callsLeft.length) add({ code: 'call_window', needs_you: false, self_heals: true, title_he: `חלון השיחות נסגר — ${callsLeft.reduce((a, i) => a + i.extra.left, 0)} אורחים נשארו ל${nextCallDay ? '-' + ddmm(nextCallDay) : 'מחר'}`, cause_he: 'שיר מחייגת א׳–ה׳ 10:00–20:30, ו׳ 09:30–13:00', fix_he: 'לא צריך לעשות כלום — ממשיכה לבד ביום השיחות הבא.' });
  const gc = codesOf('guests'), gTxt = Object.entries(gc).filter(([k, v]) => v > 0 && k !== '131042').map(([k, v]) => `${k} ×${v}`).join(', ');
  if (numbers.guests_failed > 0) add({ code: 'guest_failed', needs_you: false, self_heals: true, title_he: `${numbers.guests_failed} הודעות לאורחים נכשלו היום${gTxt ? ' (' + gTxt + ')' : ''}`, cause_he: 'מספר שגוי / חסום / לא בוואטסאפ, או דחייה זמנית של מטא', fix_he: 'הניסיון החוזר האוטומטי מטפל בזה (עד 3 ניסיונות לאורח).' });
  /* every row that needs Richard and is not explained by a problem above gets its own red line */
  const covered = new Set(P.filter(p => p.needs_you).map(p => p.code));
  for (const i of work.filter(x => x.needs_you)) {
    if (i.kind === 'lead_sends' && covered.has('131042')) continue;
    if (covered.has('paused') || covered.has('pacer_off')) continue;
    add({ code: 'item:' + i.id, item_id: i.id, needs_you: true, self_heals: false, title_he: i.label_he, cause_he: i.reason_he || STATUS_HE[i.status], fix_he: i.deep_link ? 'לפתוח את השורה ולטפל' : '', deep_link: i.deep_link });
  }
  const anyClose = work.some(i => i.kind === 'call' && !i.needs_you && i.status !== 'done' && i.status !== 'missed') ? closeHM(today, 'call') : closeHM(today, 'send');
  const later = n.self ? (sendLaterToday || callLaterToday ? `עד ${anyClose}` : 'ביום השליחה הבא') : '';
  const needN = P.filter(p => p.needs_you).length;          /* one per red line: a row that needs Richard, or a cause (Make, 131042, pause) that blocks rows */
  let line;
  if (!n.total) line = 'היום: אין שום דבר מתוכנן';
  else if (n.done === n.total && !P.some(p => p.needs_you)) line = 'היום: הכול יצא כמתוכנן ✓';
  else line = [`היום: ${n.done} מתוך ${n.total} בוצעו`, n.self ? `${n.self} ממתינים (יוצאים לבד ${later})` : '', n.rolls ? `${n.rolls} עוברים לבד ליום הבא` : '', needN ? `${needN} ${needN === 1 ? 'צריך' : 'צריכים'} אותך` : ''].filter(Boolean).join(' · ');
  const numbers_he = rt ? `נשלחו היום ${numbers.wa_sent} הודעות (אורחים ${numbers.guests_sent} · נועה ${numbers.noa_sent}) · ${numbers.wa_failed} נכשלו · ${numbers.calls_dialed} שיחות, ${numbers.calls_answered} נענו` : '';
  return { line_he: line, all_ok: line.endsWith('✓'), counts: n, numbers, numbers_he, problems: P, rt_at: rt ? rt.at || null : null, rounds_at: rounds ? rounds.at || null : null };
}

/* the sub-event list the composer works from: inp.subs (buildPlan: KV records + live counts) or, for older callers / fixtures,
   board.subevents merged with the subevent:<tok> records */
export function subList(inp) {
  if (Array.isArray(inp.subs)) return inp.subs;
  return ((inp.board && inp.board.subevents) || []).map(sb => { const t = (sb.types || [])[0] || {}; const r = (inp.subrecs || {})[sb.token] || {};
    return { ...r, token: sb.token, name: sb.name || r.name || '', parent: sb.parent || r.parent || '', invited: t.invited || 0, sent: t.sent || 0, pending: t.pending ?? null, failed: t.failed || 0, replied: t.replied || 0, started_at: r.started_at || (t.sent ? 'legacy' : '') }; });
}

/* ══ §2 I/O ════════════════════════════════════════════════════════════════
   04/11 speed: /api/ops/plan took 49 s live. Every source is now timed (out.sources.ms), and the whole thing is
   computed ONCE per pacer tick for all three periods (precomputePlans → KV plan:today / plan:week / plan:month);
   the route serves KV and recomputes only with fresh=1 (or when KV is missing / older than 30 min).
   Cheapest-first rules inside one gather:
     · the send board (per-guest KV markers — the expensive part) is reused from its own cache when < 30 min old;
       the cold route path never rebuilds it.
     · past days are immutable: their audit counts live in plan:day:<day> (written once the day is over),
       so a tick reads only TODAY's audit rows — the very rows /api/ops/realtime reads (buildRealtime gets them
       handed in, so the plan's sent / failed numbers ARE realtime's).
     · call rounds come from the same buildCallRounds as /api/ops/call-rounds. */
async function kget(env, k) { try { return env.RATE ? await env.RATE.get(k) : null; } catch { return null; } }
async function kjson(env, k) { try { return JSON.parse((await kget(env, k)) || 'null'); } catch { return null; } }
async function kput(env, k, v, ttl) { try { if (env.RATE) await env.RATE.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined); } catch {} }
export const PLAN_KEY = p => 'plan:' + p;
export const PLAN_DAY_KEY = day => 'plan:day:' + day;
export const PLAN_FRESH_MS = 30 * 60e3;
const BOARD_MAX_MS = 30 * 60e3, BOARD_KEY = 'sendboard:all:3:0', SUBS_KEY = 'plan:subs';

/* sub-events from KV (no sheet needed for sent / replied; invited comes from the sheet, else the last known count) */
async function subsNow(env, d, raw) {
  const all = await d.kvPrefix(env, 'subevent:').catch(() => ({}));
  const recs = {};
  for (const [k, v] of Object.entries(all || {})) { try { const r = JSON.parse(v); if (r && r.parent) recs[k.replace(/^subevent:/, '')] = r; } catch {} }
  const known = (await kjson(env, SUBS_KEY)) || {};
  let board = [];
  if (raw && Object.keys(recs).length) { try { board = await subeventBoard(env, raw, { kvPrefix: d.kvPrefix, normPhone: d.normPhone || (x => String(x || '').replace(/\D/g, '').replace(/^0/, '972')) }); } catch {} }
  const byTok = Object.fromEntries(board.map(b => [b.token, (b.types || [])[0] || {}]));
  const out = [];
  for (const [tok, r] of Object.entries(recs)) {
    const t = byTok[tok];
    let sent, replied, invited;
    if (t) { sent = t.sent; replied = t.replied; invited = t.invited; }
    else { const [sm, rp] = await Promise.all([d.kvPrefix(env, `shsent:${tok}:`).catch(() => ({})), d.kvPrefix(env, `shrsvp:${tok}:`).catch(() => ({}))]); sent = Object.keys(sm || {}).length; replied = Object.keys(rp || {}).length; invited = (known[tok] && known[tok].invited) || 0; }
    out.push({ ...r, token: tok, name: r.name || '', parent: r.parent, invited, sent, replied, failed: t ? t.failed || 0 : 0, pending: invited ? Math.max(0, invited - sent) : null, counts_from: t ? 'sheet' : 'kv' });
  }
  if (board.length) await kput(env, SUBS_KEY, Object.fromEntries(out.filter(x => x.counts_from === 'sheet').map(x => [x.token, { invited: x.invited, at: Date.now() }])), 30 * 86400);
  return out;
}

/* one past day's audit counts (sends per event+type, Shir's calls, Noa's lead sends) — cached once the day is over */
async function pastDay(env, d, fns, day, { today, events, subTpl, clientId, budgetLeft }) {
  const hit = await kjson(env, PLAN_DAY_KEY(day));
  if (hit && hit.final) return { ...hit, from_cache: true };
  if (budgetLeft() <= 0) return null;
  const dd = day.replace(/-/g, '');
  const q = kind => d.auditQueryEx(env, { from: dd, to: dd, kind, limit: 20000, budget: 1500 }).catch(() => ({ items: [], truncated: true }));
  const [o, st, cl] = await Promise.all([q('wa_out'), q('wa_status'), q('call')]);
  const lead = { sent: 0, failed: 0 }, wm = {};
  for (const r of o.items || []) { const x = r.data || {}; if (String(x.phone_id || '') !== clientId || x.channel === 'sms') continue; if (r.ok) { lead.sent++; if (x.wamid) wm[x.wamid] = 1; } else lead.failed++; }
  for (const r of st.items || []) { const x = r.data || {}; if (x.status === 'failed' && wm[x.wamid]) lead.failed++; }
  const truncated = !!(o.truncated || st.truncated || cl.truncated);
  const rec = { day, sends: fns.sendsByDay(o.items, st.items, { events, subTemplates: subTpl }).filter(s => s.day === day), calls: fns.callsByDay(cl.items).filter(c => c.day === day), lead, truncated, final: day < today && !truncated, at: new Date().toISOString() };
  if (rec.final) await kput(env, PLAN_DAY_KEY(day), rec, 40 * 86400);
  return rec;
}

/* gather every input once, for the union of the requested periods */
export async function gatherPlan(env, d, fns, { now = Date.now(), from, to, buildBoard = true, pastDayBudget = 31 } = {}) {
  const today = d.ilDate(new Date(now));
  const ms = {}, errors = [];
  const timed = (name, f) => { const t0 = Date.now(); return Promise.resolve().then(f).then(v => { ms[name] = Date.now() - t0; return v; }, e => { ms[name] = Date.now() - t0; errors.push(name + ': ' + String((e && e.message) || e).slice(0, 120)); return null; }); };
  const raw = await timed('snapshot', () => d.snapshotCached(env));
  const { events } = raw ? eventsFromRaw(raw, today, { isTestEventRow: d.isTestEventRow, planKeyOf: d.planKeyOf, from: addDays(from, -30) }) : { events: [] };
  const clientId = d.clientPhoneId(env) || '';
  const horizon = Math.max(1, Math.min(28, Math.round((Date.parse(to) - Date.parse(today)) / 864e5) + 2));
  /* today's audit rows: exactly realtime's query */
  const todayQ = await timed('audit_today', () => Promise.all([d.auditQueryEx(env, { days: 1, kind: 'wa_out', limit: 20000 }), d.auditQueryEx(env, { days: 1, kind: 'wa_status', limit: 20000 })]));
  const [outQ, stQ] = todayQ || [{ items: [], truncated: true }, { items: [], truncated: true }];
  const boardHit = await kjson(env, BOARD_KEY);
  const boardFresh = boardHit && boardHit.data && now - boardHit.at < BOARD_MAX_MS;
  const [cap, board, subs, rounds, rt, paused, bill, asg, ...runsRes] = await Promise.all([
    to >= today ? timed('capacity', () => fns.buildCapacity(env, d, now, horizon)) : null,
    boardFresh ? boardHit.data : buildBoard && d.sendBoardData ? timed('send_board', () => d.sendBoardData(env, { days: 3, detail: false })) : (boardHit && boardHit.data) || null,
    timed('subevents', () => subsNow(env, d, raw)),
    to >= today && fns.buildCallRounds ? timed('call_rounds', () => fns.buildCallRounds(env, d, now)) : null,
    fns.buildRealtime ? timed('realtime', () => fns.buildRealtime(env, d, now, { outQ, stQ })) : null,
    d.sendingPaused(env).catch(() => false), kget(env, 'billingalert:client'),
    timed('hostesses', async () => { const { makeStore } = await import('./store.js'); const r = await makeStore(env).list('hostess_assignments', { limit: 500 }); return (r && r.items) || []; }),
    ...PLAN_CRONS.map(c => timed('runs:' + c.id, () => listRuns(env, { automation_id: c.id, from: new Date(ilDayStartMs(from)).toISOString(), to: new Date(ilDayStartMs(to) + 864e5).toISOString(), limit: 200 }))),
  ]);
  if (boardFresh) ms.send_board = 0;
  const subTpl = new Set((subs || []).map(x => x.template).filter(Boolean));
  /* today from the realtime rows; past days from the day cache (bounded misses per call) */
  const sends = [], callsDone = [], leadByDay = {};
  let truncated = !!(outQ.truncated || stQ.truncated), budget = pastDayBudget, pastMiss = 0;
  sends.push(...fns.sendsByDay(outQ.items, stQ.items, { events, subTemplates: subTpl }).filter(x => x.day === today));
  const t0 = Date.now();
  for (let day = from; day < today && day <= to; day = addDays(day, 1)) {
    const r = await pastDay(env, d, fns, day, { today, events, subTpl, clientId, budgetLeft: () => budget });
    if (!r) { truncated = true; pastMiss++; continue; }
    if (!r.from_cache) budget--;
    sends.push(...r.sends); callsDone.push(...r.calls); if (r.lead.sent || r.lead.failed) leadByDay[day] = r.lead; if (r.truncated) truncated = true;
  }
  ms.audit_past = Date.now() - t0;
  const sendWin = d.sendWindowState(new Date(now)), callWin = d.callWindowState(new Date(now));
  const room = rt && rt.cap ? rt.cap.remaining : 1;
  const sendsWhy = paused ? 'paused' : !sendWin.open ? (sendWin.why || 'window-closed') : room <= 0 ? 'cap' : 'will-send';
  const subrecs = Object.fromEntries((subs || []).map(x => [x.token, x]));
  const crons = PLAN_CRONS.map((c, i) => ({ ...c, name_he: CRON_HE[c.id] || NAME_HE[c.id] || c.id, runs: (runsRes[i] && runsRes[i].items) || [] }));
  return { today, now, events, sends, calls_done: callsDone, lead_sends: { by_day: leadByDay, billing_131042: !!bill }, capacity: cap && cap.ok ? cap : null, board, subs: subs || [], subrecs, call_rounds: rounds, rt,
    paused: !!paused, send_window: sendWin, call_window: callWin, sends_why: sendsWhy, next_tick_at: cronNext('*/10 * * * *', new Date(now)), crons, assignments: asg || [], isNoContactDay: d.isNoContactDay,
    snapshot_ok: !!raw, audit_truncated: truncated, past_days_missing: pastMiss,
    sources: { snapshot: !!raw, capacity: !!(cap && cap.ok), send_board: !!board, send_board_age_s: boardHit ? Math.round((now - boardHit.at) / 1000) : null, call_rounds: !!rounds, realtime: !!rt, hostesses: !!asg, errors, ms } };
}

export function composeFrom(g, period) {
  const range = periodRange(period, g.today);
  const out = composePlan({ ...g, period, range, sends: g.sends.filter(s => s.day >= range.from && s.day <= addDays(range.to, 1)) });
  out.audit_truncated = g.audit_truncated; out.sources = g.sources;
  out.realtime = g.rt ? { at: g.rt.at, totals: g.rt.wa && g.rt.wa.totals, make: g.rt.make || null, cap: g.rt.cap || null } : null;
  return out;
}

/* the pacer's step (every 10 min) and the route's cold / fresh path */
export async function precomputePlans(env, d, fns, { now = Date.now(), periods = PERIODS, buildBoard = true, pastDayBudget = 31 } = {}) {
  const t0 = Date.now();
  const today = d.ilDate(new Date(now));
  const rs = periods.map(p => periodRange(p, today));
  const from = rs.map(r => r.from).sort()[0], to = rs.map(r => r.to).sort().pop();
  const g = await gatherPlan(env, d, fns, { now, from, to: to < addDays(today, 1) ? addDays(today, 1) : to, buildBoard, pastDayBudget });
  const plans = {};
  for (const p of periods) { plans[p] = composeFrom(g, p); plans[p].sources = { ...g.sources, total_ms: Date.now() - t0 }; await kput(env, PLAN_KEY(p), { at: now, data: plans[p] }, 86400); }
  return { ok: true, at: new Date(now).toISOString(), periods, ms: { ...g.sources.ms, total: Date.now() - t0 }, errors: g.sources.errors, plans };
}

export async function servePlan(env, d, fns, { period = 'today', now = Date.now(), fresh = false, staleOk = false } = {}) {
  period = PERIODS.includes(period) ? period : 'today';
  if (!fresh) {
    const hit = await kjson(env, PLAN_KEY(period));
    /* 04/11: crons that run more often than hourly get 30 s wall time, so the precompute can be cut off.
       Serve the last saved copy of today at any age (instant), flagged stale; the screen then asks fresh=1 in the background. */
    if (hit && hit.data && hit.data.today === d.ilDate(new Date(now)) && (staleOk || now - hit.at < PLAN_FRESH_MS)) return { ...hit.data, served: 'kv', cached: true, age_s: Math.round((now - hit.at) / 1000), stale: now - hit.at >= PLAN_FRESH_MS };
  }
  /* cold (KV empty / stale) never rebuilds the per-guest send board and reads at most 3 uncached past days */
  /* 04/11: one gather serves all three periods; a fresh refresh saves today/week/month together */
  const r = await precomputePlans(env, d, fns, { now, periods: fresh ? PERIODS : [period], buildBoard: !!fresh, pastDayBudget: fresh ? 31 : 3 });
  return { ...r.plans[period], served: fresh ? 'fresh' : 'cold', age_s: 0 };
}
/* kept for callers of the first version */
export const buildPlan = servePlan;
