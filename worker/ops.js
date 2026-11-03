/* ============================================================================
   ishur.io · ops.js · the operations control center API (03/11/2026)
   ----------------------------------------------------------------------------
   docs/OPS-CENTER-PLAN-2026-11-03.md Phase 0 + 1; the contract the frontend
   builds from is docs/OPS-API-2026-11-03.md — keep field names stable.

   Routes (all admin: X-Admin-Key header / Authorization: Bearer <key> on GET,
   or {admin_key} in a POST body; admin session stamps `sess.…` work in both):
     GET  /api/ops/realtime        WhatsApp per number, cap, queue, calls today, Noa, pacer
     GET  /api/ops/capacity        14-day planner: planned vs capacity, overflow, recommendations, rolled plan
   GET  /api/ops/calendar?month= month grid: events, send chips (done/partial/planned/held/rolled), calls, closed
     GET  /api/ops/balances        vendor balances (10 min KV cache bal:cache)
     POST /api/ops/balances        {set:{vendor, amount, currency, auto_topup}} → bal:manual:<vendor>
     GET  /api/ops/registry        registry nodes + ops metadata + runtime state
     GET  /api/ops/code?id=        the function source behind a node (registry-code.json)
     POST /api/ops/toggle          {id, enabled, confirm} — blast radius; writes auto:off:<id> only when confirm === id
     GET  /api/ops/live?since=     newest audit + ledger rows (≤200, cursor = ts)
     GET  /api/ops/runs            ledger (filters automation_id, status, from, to, cursor, limit)
     GET  /api/ops/run?id=         one run + children + linked audit rows
     GET  /api/ops/brain?since=    findings, pending actions, playbooks, brain runs, live log lines (brain.js)
     POST /api/ops/brain-run       run every check now (withRun brain_health, triggered_by manual)
     POST /api/ops/brain-decision  {id, approve, confirm} — approve/reject a pending playbook action
     POST /api/ops/run-log         {run_id, line|lines[], automation_id?} — an external agent streams its reasoning
     POST /api/ops/edit            {id, field, value, confirm} — whitelisted settings (cfg.js); blast radius first
     GET  /api/ops/changes         change log (changes.js): from, to, kind (comma list), actor, cursor, limit
     GET  /api/ops/messages?day=&cursor=&tab=all|failed|replies   one row per message (ops-inbox.js)
     GET  /api/ops/inbox?channel=  conversations · GET /api/ops/thread?phone= one thread · GET /api/ops/control manual-control state
     POST /api/ops/revert          {id, confirm} — undo one change: edit → previous value, toggle/pause → flip back,
                                   deploy → Cloudflare rollback (CF_API_TOKEN) or the exact wrangler command

   Read-only except: toggle (with confirm), POST balances (manual value), and
   the caches bal:cache (10 min) and biz:verif (6 h).

   §1 pure functions (unit-tested, no I/O) · §2 handlers (I/O via env + deps)
   deps = index.js opsDeps(): isAdmin, adminKeyOk, okJson, deny, cors, ilDate,
     sendWindowState, callWindowState, isNoContactDay, sendingPaused, snapshotCached,
     fetchSnapshot, waCapInfo, guestCapacity, guestPhoneIds, clientPhoneId,
     clientWaba, clientToken, kvPrefix, normPhone, isTestEventRow, planKeyOf,
     buildCallQueue, retellListCalls, metaAds, auditQuery, auditQueryEx,
     auditRecord, slackPost, PACE_SENDS, PACE_CALLS, PACE_CALLBACKS
   ========================================================================== */
import { AUTOMATIONS, KILL_SWITCH_IDS, opsMeta, BALANCE_LOW } from './automations-registry.js';
import { cronNext } from './automations.js';
import { typeOf, codeOf, phoneLabel, eventsFromRaw } from './send-board.js';
import { subeventBoard } from './subevent.js';
import { tierLimit } from './budget.js';
import { isOff, offState, OFF_PREFIX, listRuns, getRun, runStats } from './ops-run.js';
import CODE from './registry-code.json' with { type: 'json' };
import { runBrain, buildBrain, decide, runLogAppend } from './brain.js';
import { SETTINGS, validateEdit, confirmWord, writeSetting, loadCfg, effective, editableFor, NOA_CHASE_ON_CONFIRM } from './cfg.js';
import { buildMessages, buildInbox, buildThread, buildControl } from './ops-inbox.js';
import { recordChange, listChanges, getChange, markReverted, revertWord, registryFirstSeen, isNew, cfRollback, actorOf, KINDS, ACTORS } from './changes.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
export const GUEST_WABA = '1378764257421712';
export const META_AD_ACCOUNT = 'act_1944903292858482';   /* ads.js:26, used by /api/ads */
const BY_ID = Object.fromEntries(AUTOMATIONS.map(n => [n.id, n]));

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */
export const ilDayOf = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isShabbat = iso => new Date(iso + 'T12:00:00Z').getUTCDay() === 6;
/* ms at 00:00 Israel time of an IL day (DST-safe: probe both offsets) */
export function ilDayStartMs(iso) {
  for (const off of [2, 3]) { const t = Date.parse(`${iso}T00:00:00Z`) - off * 3600e3; if (ilDayOf(t) === iso && ilDayOf(t - 1) !== iso) return t; }
  return Date.parse(`${iso}T00:00:00Z`) - 2 * 3600e3;
}

/* send-reason vocabulary (frontend legend) */
export const REASONS = ['wave', 'daybefore', 'eventday', 'table', 'thanks', 'gift', 'subevent', 'client', 'reply', 'manual'];
const TYPE_TO_REASON = { w1: 'wave', w2: 'wave', w3: 'wave', daybefore: 'daybefore', table: 'table', eventday: 'eventday', thanks: 'thanks', gift: 'gift' };
export function reasonOf(row, { clientIds = [], subTemplates = new Set() } = {}) {
  const d = row.data || {};
  if (d.channel === 'sms') return 'manual';
  const t = String(d.template || '');
  if (!t) return 'reply';
  if (subTemplates.has(t)) return 'subevent';
  const ty = typeOf({ template: t, wave: d.wave, at: row.at }, null);
  if (ty && TYPE_TO_REASON[ty]) return TYPE_TO_REASON[ty];
  if (clientIds.includes(String(d.phone_id || ''))) return 'client';
  return 'manual';
}

/* THE WhatsApp aggregate. /api/ops/realtime and scripts/ops-check-realtime.mjs
   both run this over the same audit rows (kind wa_out + wa_status), so
   "realtime equals /api/stream" is a property of one function, not two. */
export function aggregateWa(outRows, statusRows, { today, numbers = [], clientIds = [], subTemplates = new Set(), untilTs = Infinity } = {}) {
  const per = {};
  const slot = pid => per[pid] = per[pid] || { phone_id: pid, sent_today: 0, rejected_today: 0, failed_async_today: 0, failed_by_code: {}, by_event: {}, by_reason: {} };
  for (const n of numbers) slot(String(n));
  const wamidPid = {};
  for (const r of outRows || []) {
    if (r.kind !== 'wa_out' || !(r.ts <= untilTs) || ilDayOf(r.ts) !== today) continue;
    const d = r.data || {};
    if (d.channel === 'sms') continue;           /* SMS rides wa_out but is not a WhatsApp number */
    const pid = String(d.phone_id || '?');
    const s = slot(pid);
    if (d.wamid) wamidPid[d.wamid] = pid;
    if (r.ok) {
      s.sent_today++;
      const reason = reasonOf(r, { clientIds, subTemplates });
      s.by_reason[reason] = (s.by_reason[reason] || 0) + 1;
      const tok = String(r.token || '').slice(0, 8) || '—';
      const e = s.by_event[tok] = s.by_event[tok] || { total: 0 };
      e.total++; e[reason] = (e[reason] || 0) + 1;
    } else {
      s.rejected_today++;
      const c = codeOf(d.error || r.detail) || '?';
      s.failed_by_code[c] = (s.failed_by_code[c] || 0) + 1;
    }
  }
  for (const r of statusRows || []) {
    if (r.kind !== 'wa_status' || !(r.ts <= untilTs) || ilDayOf(r.ts) !== today) continue;
    const d = r.data || {};
    if (d.status !== 'failed') continue;
    const pid = wamidPid[d.wamid]; if (!pid) continue;
    const s = slot(pid); s.failed_async_today++;
    const c = codeOf(r.detail) || '?';
    s.failed_by_code[c] = (s.failed_by_code[c] || 0) + 1;
  }
  return per;
}

/* realtime vs /api/stream (+ /api/shir-calls): the check behind
   scripts/ops-check-realtime.mjs. Pure. Returns { ok, checks[] }. */
export function compareRealtime(rt, streamItems, { shirCalls = null, today } = {}) {
  const checks = [];
  const day = today || rt.today;
  const until = rt.audit_until_ts || Infinity;
  const outRows = (streamItems || []).filter(r => r.kind === 'wa_out');
  const ref = aggregateWa(outRows, [], { today: day, untilTs: until });
  const rtPer = Object.fromEntries([...(rt.wa.numbers || []), ...(rt.wa.unknown_numbers || [])].map(n => [n.phone_id, n]));
  const ids = new Set([...Object.keys(ref).filter(k => ref[k].sent_today || ref[k].rejected_today), ...Object.keys(rtPer).filter(k => rtPer[k].sent_today || rtPer[k].rejected_today)]);
  for (const id of [...ids].sort()) {
    const a = rtPer[id] || { sent_today: 0, rejected_today: 0 }, b = ref[id] || { sent_today: 0, rejected_today: 0 };
    checks.push({ check: `wa.${id}.sent_today`, realtime: a.sent_today, stream: b.sent_today, ok: a.sent_today === b.sent_today });
    checks.push({ check: `wa.${id}.rejected_today`, realtime: a.rejected_today, stream: b.rejected_today, ok: a.rejected_today === b.rejected_today });
  }
  const tot = Object.values(ref).reduce((n, x) => n + x.sent_today, 0);
  checks.push({ check: 'wa.totals.sent_today', realtime: rt.wa.totals.sent_today, stream: tot, ok: rt.wa.totals.sent_today === tot });
  if (shirCalls && rt.calls) {
    const start = ilDayStartMs(day);
    const out = (shirCalls.calls || []).filter(c => Number(c.started_at) >= start && c.direction !== 'inbound');
    const capped = (shirCalls.calls || []).length >= 100 && out.length === (shirCalls.calls || []).length;
    checks.push({ check: 'calls.dialed', realtime: rt.calls.dialed, stream: out.length, ok: capped ? rt.calls.dialed >= out.length : rt.calls.dialed === out.length, note: capped ? '/api/shir-calls returns at most 100 — only a lower bound' : '' });
  }
  return { ok: checks.every(c => c.ok), checks };
}

/* call outcome buckets (Retell disconnection_reason) */
const NO_ANSWER = new Set(['dial_no_answer', 'dial_busy', 'dial_failed', 'invalid_destination', 'no_valid_payment', 'telephony_provider_permission_denied', 'telephony_provider_unavailable', 'sip_routing_error', 'marked_as_spam', 'user_declined', 'concurrency_limit_reached', 'credit_exhausted']);
export function callBucket(c) {
  const st = String(c.call_status || '');
  if (st === 'ongoing' || st === 'registered') return 'in_progress';
  const reason = String(c.disconnection_reason || '');
  if (reason === 'voicemail_reached' || (c.call_analysis && c.call_analysis.in_voicemail)) return 'voicemail';
  if (NO_ANSWER.has(reason) || st === 'not_connected' || st === 'error') return 'no_answer';
  const dur = c.end_timestamp && c.start_timestamp ? c.end_timestamp - c.start_timestamp : (c.duration_ms || 0);
  return dur >= 1000 ? 'answered' : 'no_answer';
}
export function aggregateCalls(calls, { dayStartMs, queue = [], ticksLeft = 0, paceCalls = 6 } = {}) {
  const out = { dialed: 0, answered: 0, voicemail: 0, no_answer: 0, in_progress: 0, inbound: 0, cost_usd: 0, by_event: {}, queued: 0, remaining_today: 0, capacity_left_today: ticksLeft * paceCalls };
  for (const c of calls || []) {
    if (!(Number(c.start_timestamp) >= dayStartMs)) continue;
    const inbound = String(c.direction || c.call_type || '').includes('inbound');
    if (inbound) { out.inbound++; continue; }
    out.dialed++;
    const b = callBucket(c); out[b]++;
    out.cost_usd += ((c.call_cost && c.call_cost.combined_cost) || 0) / 100;
    const tok = String(((c.metadata || {}).token) || '').slice(0, 8) || '—';
    const e = out.by_event[tok] = out.by_event[tok] || { dialed: 0, answered: 0, voicemail: 0, no_answer: 0, in_progress: 0, queued: 0 };
    e.dialed++; e[b]++;
  }
  const open = (queue || []).filter(g => !g.capped);
  out.queued = open.length;
  for (const g of open) { const tok = String(g.token || '').slice(0, 8) || '—'; const e = out.by_event[tok] = out.by_event[tok] || { dialed: 0, answered: 0, voicemail: 0, no_answer: 0, in_progress: 0, queued: 0 }; e.queued++; }
  out.remaining_today = Math.min(out.queued, out.capacity_left_today);
  out.cost_usd = Math.round(out.cost_usd * 100) / 100;
  return out;
}
/* how many 10-minute ticks are left today with the window open */
export function ticksLeftToday(windowFn, nowMs) {
  const today = ilDayOf(nowMs); let n = 0;
  const first = Math.ceil(nowMs / 600e3) * 600e3;
  for (let t = first; ilDayOf(t) === today; t += 600e3) if (windowFn(new Date(t)).open) n++;
  return n;
}

/* ── capacity planner ─────────────────────────────────────────────────────
   items: [{ day, token, name, type, count, held, upper_bound }]
   model: { verified, capacity_per_day, today_remaining, numbers, scope }
   Deterministic: events in (first due day, token) order claim free room greedily. */
export const PLAN_TYPES = { w1: 'גל 1', w2: 'גל 2', w3: 'גל 3', daybefore: 'יום-לפני', table: 'שולחן', eventday: 'יום-האירוע', thanks: 'תודה', subevent: 'אירוע-בן' };
export function engineDay(iso, isNoContactDay = () => false) { return !isShabbat(iso) && !isNoContactDay(iso); }
export function firstEngineDay(from, to, isNoContactDay) { for (let d = from; d <= to; d = addDays(d, 1)) if (engineDay(d, isNoContactDay)) return d; return null; }

/* events (eventsFromRaw shape) + flags → projected items for the horizon */
export function projectItems({ events, guests, flags = {}, today, days = 14, isNoContactDay = () => false }) {
  const last = addDays(today, days - 1);
  const items = [];
  const uniq = (list, pred) => { const s = new Set(); for (const g of list || []) if (g.phone && pred(g)) s.add(g.phone); return s.size; };
  for (const ev of events || []) {
    const f = flags[ev.token] || {};
    const gl = guests[ev.token] || [];
    const push = (day, type, count) => { if (day && day >= today && day <= last && count > 0) items.push({ day, token: ev.token, tok8: ev.token.slice(0, 8), name: ev.name || '', type, count, held: !!f.hold, upper_bound: true }); };
    for (const k of [1, 2, 3]) {
      const when = (ev.waves || {})[k]; if (!when) continue;
      if (f['wave' + k]) continue;
      if (k === 3 && !f.extrasend) continue;
      if (ev.date && ev.date < today) continue;
      const d = firstEngineDay(when > today ? when : today, addDays(when, 3), isNoContactDay);
      if (!d || (ev.date && ev.date < d)) continue;
      push(d, 'w' + k, uniq(gl, g => k === 2 ? (!g.rsvp || g.rsvp === 'מתלבט') : g.rsvp !== 'לא מגיע'));
    }
    if (!ev.date) continue;
    /* 03/11 R1: the day-before goes out on D-1 only. Not sent by then (cap,
       hold, window, a Saturday D-1) → dropped, never moved onto the event day */
    if (!f.daybefore) {
      const db = addDays(ev.date, -1);
      if (db >= today && engineDay(db, isNoContactDay)) push(db, 'daybefore', uniq(gl, g => g.rsvp === 'מגיע'));
      else if (ev.date >= today && ev.date <= last) { const n = uniq(gl, g => g.rsvp === 'מגיע'); if (n > 0) items.push({ day: ev.date, token: ev.token, tok8: ev.token.slice(0, 8), name: ev.name || '', type: 'daybefore', count: n, held: !!f.hold, upper_bound: true, dropped: true }); }
    }
    if (!f.seat && engineDay(ev.date, isNoContactDay)) push(ev.date, 'table', uniq(gl, g => g.rsvp === 'מגיע' && g.table));
    if (f.eventday) { const at = f.eventday.at && f.eventday.at > today ? f.eventday.at : today; if (at >= ev.date || !ev.date || at >= today) push(at, 'eventday', uniq(gl, g => g.rsvp === 'מגיע' && !g.table)); }   /* 03/11 R2: table guests' one message is counted under 'table' */
    if (!f.toda && ev.plan !== 'basic') { const d = firstEngineDay(addDays(ev.date, 1) > today ? addDays(ev.date, 1) : today, addDays(ev.date, 14), isNoContactDay); push(d, 'thanks', uniq(gl, g => g.rsvp === 'מגיע')); }
  }
  return items;
}

export function planCapacity({ today, days = 14, items = [], model = {}, isNoContactDay = () => false }) {
  const dayList = Array.from({ length: days }, (_, i) => addDays(today, i));
  const per = Math.max(0, Number(model.capacity_per_day) || 0);
  /* Friday: the send window closes at 13:00, so the day holds at most friday_capacity (pacer ticks × batch) */
  const isFri = d => new Date(d + 'T12:00:00Z').getUTCDay() === 5;
  const dayCap = d => isFri(d) && Number.isFinite(Number(model.friday_capacity)) ? Math.min(per, Math.max(0, Number(model.friday_capacity))) : per;
  const capOf = d => !engineDay(d, isNoContactDay) ? 0 : d === today ? Math.max(0, Math.min(dayCap(d), Number(model.today_remaining ?? per))) : dayCap(d);
  const rows = dayList.map(d => ({ day: d, open: engineDay(d, isNoContactDay), planned: 0, held_planned: 0, dropped: 0, capacity: capOf(d), overflow: 0, by_event: [] }));
  const byDay = Object.fromEntries(rows.map(r => [r.day, r]));
  const sorted = items.slice().sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : a.token < b.token ? -1 : a.token > b.token ? 1 : a.type < b.type ? -1 : 1);
  for (const it of sorted) {
    const r = byDay[it.day]; if (!r) continue;
    if (it.dropped) { r.dropped += it.count; r.by_event.push({ token: it.token, tok8: it.tok8, name: it.name, type: it.type, type_he: (PLAN_TYPES[it.type] || it.type) + ' · דולג', count: it.count, held: !!it.held, dropped: true, status: 'dropped' }); continue; }
    r.by_event.push({ token: it.token, tok8: it.tok8, name: it.name, type: it.type, type_he: PLAN_TYPES[it.type] || it.type, count: it.count, held: !!it.held, upper_bound: !!it.upper_bound });
    if (it.held) r.held_planned += it.count; else r.planned += it.count;
  }
  for (const r of rows) r.overflow = Math.max(0, r.planned - r.capacity);
  /* 03/11 rolled plan: what will ACTUALLY go out each day. The engine never drops a due message —
     what does not fit waits for the next open day, oldest first (FIFO by due day, then token/type).
     Closed days (Shabbat / no-contact) have capacity 0, so nothing ever lands on them. */
  const queue = [];
  for (const r of rows) {
    for (const it of sorted) if (it.day === r.day && !it.held) queue.push({ token: it.token, tok8: it.tok8, event: it.name, type: it.type, type_he: PLAN_TYPES[it.type] || it.type, n: it.count, from_day: it.day });
    let room = r.capacity; r.rolled = [];
    while (room > 0 && queue.length) { const q = queue[0], take = Math.min(room, q.n); r.rolled.push({ ...q, n: take }); q.n -= take; room -= take; if (!q.n) queue.shift(); }
    r.out = r.rolled.reduce((n, x) => n + x.n, 0);
    r.rolled_in = r.rolled.filter(x => x.from_day < r.day).reduce((n, x) => n + x.n, 0);
    r.carry = queue.reduce((n, q) => n + q.n, 0);
  }
  const unplaced = queue.map(q => ({ token: q.token, tok8: q.tok8, event: q.event, type: q.type, n: q.n, from_day: q.from_day }));
  /* recommendations: each event's per-day batch, earliest day it fits whole */
  const free = Object.fromEntries(rows.map(r => [r.day, r.capacity]));
  const events = {};
  for (const it of sorted) { if (it.held || it.dropped) continue; const e = events[it.token] = events[it.token] || { token: it.token, tok8: it.tok8, name: it.name, first: it.day, batches: {} }; e.batches[it.day] = (e.batches[it.day] || 0) + it.count; }
  const recs = [];
  const evList = Object.values(events).sort((a, b) => a.first < b.first ? -1 : a.first > b.first ? 1 : a.token < b.token ? -1 : 1);
  for (const e of evList) {
    for (const [due, count] of Object.entries(e.batches).sort()) {
      const fit = dayList.find(d => d >= due && free[d] >= count);
      if (fit) {
        free[fit] -= count;
        recs.push({ token: e.token, tok8: e.tok8, name: e.name, due, count, kind: fit === due ? 'fits' : 'move', day: fit, he: fit === due ? `נכנס כולו ב-${fit}` : `לא נכנס ב-${due}; החלון המוקדם ביותר שמכיל את כל ${count} ההודעות ביום אחד: ${fit}` });
        continue;
      }
      if (count <= per) {
        recs.push({ token: e.token, tok8: e.tok8, name: e.name, due, count, kind: 'no_window', day: null, he: `אין יום ב-${days} הימים הקרובים עם מקום ל-${count} הודעות — לפצל או להקדים` });
        continue;
      }
      const n = per > 0 ? Math.ceil(count / per) : null;
      const split = []; let left = count;
      for (const d of dayList) { if (left <= 0) break; if (d < due || free[d] <= 0) continue; const take = Math.min(left, free[d]); free[d] -= take; left -= take; split.push({ day: d, count: take }); }
      const needs = model.verified
        ? `צריך עוד מקום עד ${due}: להוסיף מספר שולח (אחרי אימות כל מספר מקבל תקרה משלו)`
        : `צריך מקום עד ${due}: אימות העסק ממתין — אחרי האימות כל מספר מקבל 1000; הוספת מספר עוזרת רק אחרי האימות (כרגע התקרה משותפת)`;
      recs.push({ token: e.token, tok8: e.tok8, name: e.name, due, count, kind: 'split', days_needed: n, split, unplaced: left, needs_capacity_by: due, he: `${count} הודעות לא נכנסות ביום אחד (תקרה ${per}) — לפצל על ${n} ימים. ${needs}` });
    }
  }
  return { days: rows, recommendations: recs, unplaced, totals: { out: rows.reduce((n, r) => n + r.out, 0), unplaced: unplaced.reduce((n, q) => n + q.n, 0), planned: rows.reduce((n, r) => n + r.planned, 0), held_planned: rows.reduce((n, r) => n + r.held_planned, 0), overflow_days: rows.filter(r => r.overflow > 0).map(r => r.day) } };
}
/* the capacity model: shared 250 − margin until verified, per-number tier (≥1000) after */
export function capacityModel({ verified = false, numbers = [], portfolioLimit = 250, margin = 20, todayRemaining = null }) {
  if (verified) {
    const per = numbers.map(n => ({ id: n.id, tier: n.tier || '', limit: Math.max(1000, tierLimit(n.tier, 0) || 0) }));
    const sum = per.reduce((s, n) => s + (Number.isFinite(n.limit) ? n.limit : 100000), 0);
    return { model: 'per_number', verified: true, capacity_per_day: sum, numbers: per, today_remaining: todayRemaining ?? sum, he: 'העסק מאומת: לכל מספר תקרה משלו (1000+), מצטבר' };
  }
  const cap = Math.max(0, portfolioLimit - margin);
  return { model: 'shared', verified: false, capacity_per_day: cap, numbers: numbers.map(n => ({ id: n.id, tier: n.tier || '', limit: portfolioLimit })), today_remaining: todayRemaining ?? cap, he: `העסק לא מאומת: תקרה משותפת ${portfolioLimit} פחות מרווח ${margin} = ${cap} ליום לכל המספרים יחד` };
}

/* ── blast radius ────────────────────────────────────────────────────────── */
/* edges = opsMeta(n).depends_on: what RUNS a node (from[] also draws feeds,
   e.g. escalation → shir_dispatch fills the queue but never dials) */
export function downstream(id, nodes = AUTOMATIONS) {
  const kids = {}; const par = {};
  for (const n of nodes) { par[n.id] = opsMeta(n).depends_on; for (const f of par[n.id]) (kids[f] = kids[f] || []).push(n.id); }
  const by = Object.fromEntries(nodes.map(n => [n.id, n]));
  const stopped = new Set([id]); const seen = new Set([id]); const order = [];
  const q = [id];
  while (q.length) { const x = q.shift(); for (const k of kids[x] || []) if (!seen.has(k)) { seen.add(k); q.push(k); order.push(k); } }
  /* fully stopped = every parent is stopped (fixpoint, in BFS order) */
  let changed = true;
  while (changed) { changed = false; for (const k of order) if (!stopped.has(k) && par[k].every(p => stopped.has(p))) { stopped.add(k); changed = true; } }
  return order.map(k => ({ id: k, name_he: by[k].name_he, kind: by[k].kind, fully_stopped: stopped.has(k), other_parents: par[k].filter(p => !stopped.has(p)) }));
}
/* which projected message types an automation id carries */
export const NODE_TYPES = { wave1: ['w1'], wave2: ['w2'], wave3: ['w3'], day_before: ['daybefore'], seating: ['table'], event_day_blast: ['eventday'], toda: ['thanks'], manual_blasts: ['subevent'] };
export function blastRadius(id, { items = [], today, days = 7, calls = {} } = {}) {
  const down = downstream(id);
  const stopped = new Set([id, ...down.filter(x => x.fully_stopped).map(x => x.id)]);
  const partial = new Set(down.filter(x => !x.fully_stopped).map(x => x.id));
  const last = addDays(today, days - 1);
  const types = new Set(), partialTypes = new Set();
  for (const n of stopped) for (const t of NODE_TYPES[n] || []) types.add(t);
  for (const n of partial) for (const t of NODE_TYPES[n] || []) if (!types.has(t)) partialTypes.add(t);
  const msgs = { total: 0, by_type: {}, partial_total: 0 }; const evs = {};
  for (const it of items) {
    if (it.day < today || it.day > last || it.held) continue;
    const full = types.has(it.type), part = partialTypes.has(it.type);
    if (!full && !part) continue;
    if (full) { msgs.total += it.count; msgs.by_type[it.type] = (msgs.by_type[it.type] || 0) + it.count; } else msgs.partial_total += it.count;
    const e = evs[it.token] = evs[it.token] || { token: it.token, tok8: it.tok8, name: it.name, messages: 0, days: [] };
    e.messages += it.count; if (!e.days.includes(it.day)) e.days.push(it.day);
  }
  const callStop = { queued: 0, callbacks: 0 };
  if (stopped.has('shir_dispatch')) callStop.queued = calls.queued || 0;
  if (stopped.has('shir_callbacks')) callStop.callbacks = calls.callbacks || 0;
  return { id, downstream: down, messages_next_days: msgs, calls_stopped: callStop, events_affected: Object.values(evs).sort((a, b) => b.messages - a.messages), horizon_days: days };
}
/* the switch a toggle id resolves to (wave_retry → manual_blasts) */
export function switchFor(id) {
  const n = BY_ID[id]; if (!n) return null;
  const ks = opsMeta(n).kill_switch;
  if (!ks || !ks.wired) return null;
  const sid = ks.via || id;
  return KILL_SWITCH_IDS.includes(sid) ? sid : null;
}

/* ══ §2 I/O ════════════════════════════════════════════════════════════════ */
async function kget(env, k) { try { return env.RATE ? await env.RATE.get(k) : null; } catch { return null; } }
async function kjson(env, k) { try { return JSON.parse((await kget(env, k)) || 'null'); } catch { return null; } }
async function kcount(env, prefix, max = 5000) {
  if (!env.RATE) return 0; let n = 0, cursor;
  for (let i = 0; i < 5; i++) { const p = await env.RATE.list({ prefix, cursor, limit: 1000 }).catch(() => null); if (!p) break; n += (p.keys || []).length; if (p.list_complete || n >= max) break; cursor = p.cursor; }
  return n;
}

async function bizVerification(env) {
  const c = await kjson(env, 'biz:verif');
  if (c && c.status) return c;
  let status = 'unknown', source = 'none';
  if (env.WA_TOKEN_GUESTS) {
    const r = await fetch(`${GRAPH}/${GUEST_WABA}?fields=business_verification_status`, { headers: { Authorization: 'Bearer ' + env.WA_TOKEN_GUESTS } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j && j.business_verification_status) { status = String(j.business_verification_status); source = 'meta'; }
  }
  const v = { status, verified: status === 'verified', source, at: new Date().toISOString() };
  if (env.RATE && source === 'meta') await env.RATE.put('biz:verif', JSON.stringify(v), { expirationTtl: 6 * 3600 }).catch(() => {});
  return v;
}

/* ── realtime ────────────────────────────────────────────────────────────── */
export async function buildRealtime(env, d, now = Date.now()) {
  const today = d.ilDate(new Date(now));
  await d.waCapInfo(env).catch(() => null);
  const guestIds = d.guestPhoneIds(env), clientId = d.clientPhoneId(env) || '';
  const [cap, waCap, pacerLast, pacerPending, paused, capAll, billFlag, edJobs, lateN, cbqN, holdsN, autoretryDone, offPacer, offRetry, outQ, stQ] = await Promise.all([
    d.guestCapacity(env).catch(() => null), kjson(env, 'wa:cap'), kjson(env, 'pacer:last'), kget(env, 'pacer:pending'), d.sendingPaused(env).catch(() => false),
    kget(env, 'wacap:guests'), kget(env, 'billingalert:client'), d.kvPrefix(env, 'edblast:').catch(() => ({})), kcount(env, 'lateinv:'), kcount(env, 'cbq:'), kcount(env, 'hold:'),
    kget(env, 'autoretry:' + today), isOff(env, 'd_pacer'), isOff(env, 'autoretry'),
    d.auditQueryEx(env, { days: 1, kind: 'wa_out', limit: 20000 }), d.auditQueryEx(env, { days: 1, kind: 'wa_status', limit: 20000 })]);
  const outRows = outQ.items || [], stRows = stQ.items || [];
  const untilTs = Math.max(0, ...outRows.map(r => r.ts || 0));
  const subTemplates = new Set(Object.values(await d.kvPrefix(env, 'subevent:').catch(() => ({}))).map(v => { try { return JSON.parse(v).template; } catch { return ''; } }).filter(Boolean));
  const agg = aggregateWa(outRows, stRows, { today, numbers: [...guestIds, clientId].filter(Boolean), clientIds: [clientId], subTemplates });
  const tiers = Object.fromEntries(((waCap && waCap.numbers) || []).map(n => [String(n.id), n]));
  const capRows = Object.fromEntries(((cap && cap.numbers) || []).map(n => [String(n.id), n]));
  const numbers = [...guestIds.map((id, i) => ({ id, role: 'guests', label: `שיר #${i + 1} · ${phoneLabel(id)}` })), ...(clientId ? [{ id: clientId, role: 'client', label: `נועה · ${phoneLabel(clientId)}` }] : [])].map(n => {
    const c = capRows[n.id] || {}; const t = tiers[n.id] || {}; const a = agg[n.id] || {};
    return { phone_id: n.id, role: n.role, label: n.label, tier: c.tier || t.tier || null, quality: t.quality || null, limit: c.limit ?? null, used_24h: c.used ?? null,
      remaining: c.remaining ?? null, held: !!c.held, held_until: c.held_until ? new Date(c.held_until).toISOString() : null, frees_at: c.frees_at ? new Date(c.frees_at).toISOString() : null,
      sent_today: a.sent_today || 0, rejected_today: a.rejected_today || 0, failed_async_today: a.failed_async_today || 0, failed_by_code: a.failed_by_code || {}, by_reason: a.by_reason || {}, by_event: a.by_event || {} };
  });
  const unknown = Object.values(agg).filter(a => !numbers.some(n => n.phone_id === a.phone_id) && (a.sent_today || a.rejected_today)).map(a => ({ phone_id: a.phone_id, role: 'unknown', label: phoneLabel(a.phone_id), sent_today: a.sent_today, rejected_today: a.rejected_today, failed_async_today: a.failed_async_today, failed_by_code: a.failed_by_code, by_reason: a.by_reason, by_event: a.by_event }));

  const sendWin = d.sendWindowState(new Date(now)), callWin = d.callWindowState(new Date(now));
  /* calls today */
  let calls = null;
  if (env.RETELL_KEY) {
    const dayStart = ilDayStartMs(today);
    const list = await d.retellListCalls(env, { sort_order: 'descending', limit: 1000, filter_criteria: { start_timestamp: { lower_threshold: dayStart } } }).catch(() => null);
    const raw = await d.snapshotCached(env).catch(() => null);
    const queue = raw ? (d.buildCallQueue(raw).queue || []) : [];
    calls = aggregateCalls(list || [], { dayStartMs: dayStart, queue, ticksLeft: ticksLeftToday(d.callWindowState, now), paceCalls: d.PACE_CALLS || 6 });
    calls.source = list ? 'retell' : 'retell-unreadable'; calls.callbacks_queued = cbqN;
  }
  const noaLast = outRows.filter(r => String((r.data || {}).phone_id || '') === clientId).sort((a, b) => b.ts - a.ts)[0] || null;
  const dueEd = Object.entries(edJobs).filter(([, v]) => { try { return String(JSON.parse(v).at || '') <= today; } catch { return false; } }).map(([t]) => t.slice(0, 8));
  const room = cap ? cap.remaining : 0;
  const pending = pacerPending === today;
  const nextTick = cronNext('*/10 * * * *', new Date(now));
  const sendsWhy = paused ? 'paused' : offPacer ? 'off:d_pacer' : !sendWin.open ? (sendWin.why || 'window-closed') : !pending ? 'nothing-pending' : room <= 0 ? 'cap' : capAll ? 'wacap:guests' : 'will-send';
  const callsWhy = paused ? 'paused' : offPacer ? 'off:d_pacer' : !callWin.open ? (callWin.why || 'window-closed') : 'will-dial';
  const cbTake = callsWhy === 'will-dial' ? Math.min(d.PACE_CALLBACKS || 3, cbqN) : 0;
  return {
    ok: true, at: new Date(now).toISOString(), today, audit_until_ts: untilTs || now, audit_truncated: !!(outQ.truncated || stQ.truncated),
    wa: { numbers, unknown_numbers: unknown, totals: { sent_today: Object.values(agg).reduce((n, a) => n + a.sent_today, 0), rejected_today: Object.values(agg).reduce((n, a) => n + a.rejected_today, 0), failed_async_today: Object.values(agg).reduce((n, a) => n + a.failed_async_today, 0) }, reasons: REASONS },
    cap: cap ? { scope: cap.scope, limit: cap.limit, used: cap.used, margin: cap.margin, remaining: cap.remaining, all_held: !!cap.all_held, wacap_guests: capAll || null } : null,
    queue: {
      next_tick_at: nextTick, pacer_pending_today: pending,
      sends: { will_run: sendsWhy === 'will-send', max: sendsWhy === 'will-send' ? Math.min(d.PACE_SENDS || 25, room) : 0, why: sendsWhy, send_window: sendWin },
      calls: { will_run: callsWhy === 'will-dial', callbacks: cbTake, dials_max: callsWhy === 'will-dial' ? Math.max(0, (d.PACE_CALLS || 6) - cbTake) : 0, why: callsWhy, call_window: callWin },
      autoretry: { will_run: !paused && !offPacer && !offRetry && sendWin.open && !autoretryDone, done_today: !!autoretryDone, off: offRetry },
      event_day_due: dueEd, late_invites_waiting: lateN, holds: holdsN,
    },
    calls,
    noa: { phone_id: clientId, billing_131042: !!billFlag, last_send: noaLast ? { at: noaLast.at, ok: noaLast.ok, template: (noaLast.data || {}).template || '', error: (noaLast.data || {}).error || '', to: String(noaLast.phone || '').replace(/(\d{3})\d{4}(\d{3})$/, '$1****$2') } : null },
    pacer: { last_tick_at: pacerLast ? pacerLast.at : null, last: pacerLast ? { sends: pacerLast.sends || null, calls: pacerLast.calls || null, callbacks: pacerLast.callbacks || null, autoretry: pacerLast.autoretry || null, leads: pacerLast.leads ?? null, doctor: pacerLast.doctor ? { fixed: pacerLast.doctor.fixed, alerted: pacerLast.doctor.alerted } : null } : null, off: offPacer, paused: !!paused },
  };
}

/* ── capacity ────────────────────────────────────────────────────────────── */
async function projectionInputs(env, d, today, days) {
  const raw = await d.snapshotCached(env).catch(() => null);
  if (!raw) return null;
  const { events, guests } = eventsFromRaw(raw, today, { isTestEventRow: d.isTestEventRow, planKeyOf: d.planKeyOf, from: addDays(today, -14) });
  const last = addDays(today, days + 1);
  const rel = events.filter(ev => (ev.date && ev.date >= today && ev.date <= last) || [1, 2, 3].some(k => ev.waves[k] && ev.waves[k] <= last && addDays(ev.waves[k], 3) >= today));
  const edJobs = await d.kvPrefix(env, 'edblast:').catch(() => ({}));
  const flags = {};
  await Promise.all(rel.map(async ev => {
    const t = ev.token;
    const [hold, w1, w2, w3, xs, db, seat, toda] = await Promise.all(['hold:', `wave:${t}:1`, `wave:${t}:2`, `wave:${t}:3`, 'extrasend:', 'daybefore:', 'seat:', 'toda:']
      .map(k => kget(env, k.endsWith(':') ? k + t : k)));
    let ed = null; try { const j = JSON.parse(edJobs[t] || 'null'); if (j) ed = { at: String(j.at || ''), no_table: !!j.no_table }; } catch {}
    flags[t] = { hold: !!hold, wave1: !!w1, wave2: !!w2, wave3: !!w3, extrasend: !!xs, daybefore: !!db, seat: !!seat, toda: !!toda, eventday: ed };
  }));
  return { raw, events: rel, guests, flags };
}
export async function buildCapacity(env, d, now = Date.now(), days = 14) {
  const today = d.ilDate(new Date(now));
  await d.waCapInfo(env).catch(() => null);
  const [cap, waCap, verif, inp] = await Promise.all([d.guestCapacity(env).catch(() => null), kjson(env, 'wa:cap'), bizVerification(env), projectionInputs(env, d, today, days)]);
  const numbers = ((waCap && waCap.numbers) || []).map(n => ({ id: String(n.id), tier: n.tier }));
  const model = capacityModel({ verified: verif.verified, numbers: numbers.length ? numbers : d.guestPhoneIds(env).map(id => ({ id, tier: '' })), portfolioLimit: (cap && cap.limit) || 250, margin: cap ? cap.margin : 20, todayRemaining: cap ? cap.remaining : null });
  /* Friday window 09:00–13:00 = 25 pacer ticks (:00…:00) × PACE_SENDS */
  model.friday_capacity = Math.min(model.capacity_per_day, 25 * (Number(d.PACE_SENDS) || 25));
  if (!inp) return { ok: false, error: 'snapshot-unreadable', model, verification: verif };
  const items = projectItems({ events: inp.events, guests: inp.guests, flags: inp.flags, today, days, isNoContactDay: d.isNoContactDay });
  /* sub-events: manual sends, no date — their unsent rest is planned for today, flagged manual */
  let subs = [];
  try { subs = await subeventBoard(env, inp.raw, { kvPrefix: d.kvPrefix, normPhone: d.normPhone }); } catch {}
  for (const s of subs) { const p = ((s.types || [])[0] || {}).pending || 0; if (p > 0) items.push({ day: today, token: s.token, tok8: s.token.slice(0, 8), name: s.name || '', type: 'subevent', count: p, held: !!(inp.flags[s.parent] || {}).hold, upper_bound: false, manual: true }); }
  const plan = planCapacity({ today, days, items, model, isNoContactDay: d.isNoContactDay });
  return { ok: true, at: new Date(now).toISOString(), today, horizon_days: days, model, verification: verif, ...plan,
    notes: ['מספרי הגלים הם גבול עליון: לא נבדקים סימוני נשלח לכל אורח, הסרות וטעות-במספר', 'אירועים מוחזקים (hold) מסומנים held ולא נספרים ב-planned', 'אירוע-בן (שבת חתן) נשלח ידנית — מה שלא נשלח מתוכנן להיום'] };
}

/* ── calendar (03/11) ─────────────────────────────────────────────────────
   GET /api/ops/calendar?month=YYYY-MM → one row per Israel-time day of the month:
   events, every send chip (done / partial / planned / held / rolled + ghost), call rounds,
   closed purchases, used vs capacity. calendarMonth() is pure; buildCalendar() gathers. */
export const CAL_TYPES = { ...PLAN_TYPES, gift: 'מתנה', call: 'סבב שיחות' };
const DOW_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dowOf = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
export function monthDays(month) {
  const [y, m] = month.split('-').map(Number), n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
/* audit rows → per (day, tok8, type): sent / failed / delivered (+ the template seen) */
export function sendsByDay(outRows, statusRows, { events = [], subTemplates = new Map() } = {}) {
  const evBy = Object.fromEntries(events.map(e => [e.token.slice(0, 8), e]));
  const out = {}, wm = {};
  const slot = (day, tok8, type) => { const k = `${day}|${tok8}|${type}`; return out[k] = out[k] || { day, tok8, type, sent: 0, failed: 0, delivered: 0, template: '' }; };
  for (const r of outRows || []) {
    if (r.kind !== 'wa_out') continue;
    const d = r.data || {}; if (d.channel === 'sms') continue;
    const tok8 = String(r.token || '').slice(0, 8); if (!tok8) continue;
    const t = String(d.template || '');
    const type = subTemplates.has(t) ? 'subevent' : typeOf({ template: t, wave: d.wave, at: r.at || r.ts }, evBy[tok8]);
    if (!type) continue;
    const s = slot(ilDayOf(r.ts), tok8, type); if (t) s.template = t;
    if (r.ok) { s.sent++; if (d.wamid) wm[d.wamid] = { s, rank: 0 }; } else s.failed++;
  }
  const RK = { sent: 0, delivered: 1, read: 2, failed: 3 };
  for (const r of statusRows || []) {
    if (r.kind !== 'wa_status') continue;
    const d = r.data || {}, w = wm[d.wamid]; if (!w) continue;
    const rk = RK[d.status] ?? 0; if (rk <= w.rank) continue;
    if (rk === 3) { if (w.rank >= 1) w.s.delivered--; w.s.failed++; }
    else if (w.rank < 1) w.s.delivered++;
    w.rank = rk;
  }
  return Object.values(out);
}
export function calendarMonth({ month, today, events = [], board = null, capDays = [], sends = [], calls = { done: [], planned: [] }, closed = [], isNoContactDay = () => false, perDay = 230, fridayCap = null, window = null }) {
  const days = monthDays(month), inMonth = new Set(days);
  const cell = Object.fromEntries(days.map(d => {
    const dw = dowOf(d), open = engineDay(d, isNoContactDay);
    return [d, { date: d, dow: dw, dow_he: DOW_HE[dw], past: d < today, today: d === today, open, closed_reason: dw === 6 ? 'shabbat' : !open ? 'no_contact' : null, limited: open && dw === 5 ? 'friday' : null,
      used: 0, capacity: open ? (dw === 5 && fridayCap != null ? Math.min(perDay, fridayCap) : perDay) : 0, events: [], items: [] }];
  }));
  const add = (day, it) => { if (inMonth.has(day)) cell[day].items.push(it); };
  for (const e of events) if (e.date && inMonth.has(e.date)) cell[e.date].events.push({ tok8: e.token.slice(0, 8), name: e.name, type: e.occasion || '', time: e.time || '' });
  const names = Object.fromEntries(events.map(e => [e.token.slice(0, 8), e.name]));
  /* the rolled plan: every future piece lands on the day it will actually go out */
  const lastRoll = {}, capBy = Object.fromEntries(capDays.map(r => [r.day, r]));
  for (const r of capDays) for (const x of r.rolled || []) { const k = x.tok8 + '|' + x.type; if (!lastRoll[k] || r.day > lastRoll[k]) lastRoll[k] = r.day; }
  const boardTypes = {};
  for (const ev of (board && board.events) || []) for (const t of ev.types || []) boardTypes[ev.short + '|' + t.key] = { ev, t };
  for (const sub of (board && board.subevents) || []) { const t = (sub.types || [])[0]; if (t) boardTypes[sub.token.slice(0, 8) + '|subevent'] = { ev: { short: sub.token.slice(0, 8), name: sub.name, held: false }, t: { ...t, key: 'subevent', due: today, audience: t.invited, pending: { total: t.pending, hold: 0 } }, template: sub.template }; }
  const nameOf = (tok8, fb = '') => names[tok8] || fb || tok8;
  /* done / partial: one chip per day the audit saw sends */
  const sawDone = new Set();
  for (const s of sends) {
    const k = s.tok8 + '|' + s.type, bt = boardTypes[k];
    const pend = bt ? Math.max(0, ((bt.t.pending || {}).total || 0) - ((bt.t.pending || {}).hold || 0)) : 0;
    const partial = !!bt && pend > 0;
    sawDone.add(k);
    add(s.day, { id: `send:${k}:${s.day}`, kind: 'send', tok8: s.tok8, event: nameOf(s.tok8, bt && bt.ev.name), type: s.type, type_he: CAL_TYPES[s.type] || s.type, state: partial ? 'partial' : 'done',
      n: s.sent, sent: s.sent, delivered: s.delivered, failed: s.failed, of: bt ? bt.t.audience : null, total_sent: bt ? bt.t.sent : s.sent, due: bt ? bt.t.due || null : null,
      completion_day: partial ? lastRoll[k] || null : null, template: s.template || (bt && bt.template) || '', reason: partial ? `נשלחו ${bt.t.sent} מתוך ${bt.t.audience}` : '' });
    if (cell[s.day]) cell[s.day].used += s.sent;
  }
  for (const [k, { ev, t, template }] of Object.entries(boardTypes)) {
    const p = t.pending || {};
    /* sends the audit window does not reach (board counts from KV markers) */
    if (!sawDone.has(k) && t.sent > 0) {
      const day = t.last_at ? ilDayOf(t.last_at) : t.due;
      const pend = Math.max(0, (p.total || 0) - (p.hold || 0));
      add(day, { id: `send:${k}:${day}:b`, kind: 'send', tok8: ev.short, event: ev.name, type: t.key, type_he: CAL_TYPES[t.key] || t.key, state: pend ? 'partial' : 'done', n: t.sent, sent: t.sent, delivered: t.delivered || 0,
        failed: (t.failed && t.failed.total) ?? (t.failed || 0), of: t.audience, total_sent: t.sent, due: t.due || null, completion_day: pend ? lastRoll[k] || null : null, template: template || '', reason: 'ספירה מסימוני השליחה (מחוץ לחלון הלוג)' });
    }
    if (p.hold > 0) add(t.due && t.due >= today ? t.due : today, { id: `send:${k}:held`, kind: 'send', tok8: ev.short, event: ev.name, type: t.key, type_he: CAL_TYPES[t.key] || t.key, state: 'held', n: p.hold, of: t.audience, due: t.due || null, template: template || '', reason: 'האירוע בהחזקה (hold) — לא יוצא עד שמשחררים' });
    /* scheduled beyond the planner's horizon: plain planned on the due day */
    const lastCap = capDays.length ? capDays[capDays.length - 1].day : today;
    if (p.scheduled > 0 && t.due > lastCap) add(t.due, { id: `send:${k}:${t.due}:p`, kind: 'send', tok8: ev.short, event: ev.name, type: t.key, type_he: CAL_TYPES[t.key] || t.key, state: 'planned', n: p.scheduled, of: t.audience, due: t.due, template: template || '', reason: 'מתוכנן (מחוץ לאופק המתכנן)' });
  }
  const ghosts = {};
  for (const r of capDays) {
    for (const x of r.rolled || []) {
      const k = x.tok8 + '|' + x.type, base = { kind: 'send', tok8: x.tok8, event: x.event || nameOf(x.tok8), type: x.type, type_he: CAL_TYPES[x.type] || x.type, n: x.n, due: x.from_day, of: boardTypes[k] ? boardTypes[k].t.audience : null, template: (boardTypes[k] && boardTypes[k].template) || '' };
      if (x.from_day === r.day) add(r.day, { ...base, id: `send:${k}:${r.day}:plan`, state: 'planned', reason: '' });
      else {
        add(r.day, { ...base, id: `send:${k}:${r.day}:from:${x.from_day}`, state: 'rolled', from_day: x.from_day, reason: `לא נכנס בתקרה של ${x.from_day} — המתכנן דחה ליום הפנוי הבא` });
        const gk = k + '|' + x.from_day, g = ghosts[gk] = ghosts[gk] || { ...base, id: `send:${k}:${x.from_day}:ghost`, state: 'ghost', n: 0, to_days: [], day: x.from_day };
        g.n += x.n; g.to_days.push(r.day);
      }
    }
    for (const e of r.by_event || []) if (e.held && !boardTypes[e.tok8 + '|' + e.type]) add(r.day, { id: `send:${e.tok8}|${e.type}:${r.day}:held`, kind: 'send', tok8: e.tok8, event: e.name, type: e.type, type_he: CAL_TYPES[e.type] || e.type, state: 'held', n: e.count, due: r.day, template: '', reason: 'האירוע בהחזקה (hold)' });
    if (cell[r.day]) { const c = cell[r.day]; c.capacity = r.day === today ? Math.max(c.used + r.capacity, 0) : r.capacity; c.used += r.out || 0; }
  }
  for (const { day, ...g } of Object.values(ghosts)) add(day, { ...g, to_day: g.to_days[g.to_days.length - 1], reason: `${g.n} עברו ל-${g.to_days.join(', ')} (תקרה)` });
  for (const c of calls.done || []) add(c.day, { id: `call:${c.tok8}:${c.day}`, kind: 'call', tok8: c.tok8, event: nameOf(c.tok8, c.name), type: 'call', type_he: CAL_TYPES.call, state: 'done', n: c.n, answered: c.answered || 0, reason: '' });
  for (const c of calls.planned || []) add(c.day, { id: `call:${c.tok8}:${c.day}:plan`, kind: 'call', tok8: c.tok8, event: nameOf(c.tok8, c.name), type: 'call', type_he: CAL_TYPES.call, state: 'planned', n: c.n, reason: 'אורחים בתור לשיר (לא ענו להודעות)' });
  for (const c of closed) add(c.day, { id: `closed:${c.ref || c.at}`, kind: 'closed', tok8: c.tok8 || '', event: c.event, type: 'closed', type_he: 'סגירה', state: 'done', at: c.at, package: c.package, records: c.records, sum: c.sum, reason: '' });
  const ST = { done: 0, partial: 1, rolled: 2, planned: 3, held: 4, ghost: 5 };
  for (const c of Object.values(cell)) c.items.sort((a, b) => (a.kind === 'closed') - (b.kind === 'closed') || (ST[a.state] - ST[b.state]) || String(a.event).localeCompare(String(b.event)));
  const tokOf = {}; for (const e of events) tokOf[e.token.slice(0, 8)] = e.token;
  for (const ev of (board && board.events) || []) if (ev.token) tokOf[ev.short] = ev.token;
  for (const sub of (board && board.subevents) || []) tokOf[sub.token.slice(0, 8)] = sub.token;
  const evList = {}; for (const c of Object.values(cell)) for (const it of c.items.concat(c.events)) if (it.tok8) evList[it.tok8] = evList[it.tok8] || it.event || it.name;
  return { month, today, tz: 'Asia/Jerusalem', per_day: perDay, friday_capacity: fridayCap, window, days: days.map(d => cell[d]), events: Object.entries(evList).map(([tok8, name]) => ({ tok8, name, token: tokOf[tok8] || '' })).sort((a, b) => a.name.localeCompare(b.name)) };
}
/* pay audit rows (Grow IPN) → closed purchases; only ishur packages (parsePaidDesc ≠ null) */
export function closedFromPay(rows, { parsePaidDesc = () => null, events = [] } = {}) {
  const byClient = Object.fromEntries(events.filter(e => e.client_id).map(e => [e.client_id, e]));
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    if (r.kind !== 'pay') continue;
    const f = (r.data && r.data.ipn) || {};
    const desc = String(f.paymentDesc || f.description || f.productName || ''), b = parsePaidDesc(desc); if (!b) continue;
    const ref = String(f.asmachta || f.transactionId || f.transactionCode || r.id || ''); if (seen.has(ref)) continue; seen.add(ref);
    const phone = String(f.payerPhone || f.phone || r.phone || '').replace(/\D/g, '').replace(/^0/, '972');
    const ev = phone ? byClient['C-' + phone.slice(-9)] : null;
    out.push({ day: ilDayOf(r.ts), at: r.at || new Date(r.ts).toISOString(), ref, tok8: ev ? ev.token.slice(0, 8) : '', event: ev ? ev.name : String(f.fullName || f.payerName || f.name || 'לקוח'), package: [b.planText, b.hostess ? b.hostess + ' דיילות' : ''].filter(Boolean).join(' + ') || desc.slice(0, 40), records: b.tier || null, sum: Number(f.paymentSum || f.sum || f.amount || f.transactionSum) || 0 });
  }
  return out;
}
export function callsByDay(rows) {
  const m = {};
  for (const r of rows || []) {
    if (r.kind !== 'call') continue;
    const d = r.data || {}; if (d.agent && d.agent !== 'שיר') continue;
    const tok8 = String(r.token || '').slice(0, 8); if (!tok8) continue;
    const k = ilDayOf(r.ts) + '|' + tok8, c = m[k] = m[k] || { day: ilDayOf(r.ts), tok8, name: d.event_name || '', n: 0, answered: 0 };
    c.n++; if (d.outcome || d.answer) c.answered++;
  }
  return Object.values(m);
}
export async function buildCalendar(env, d, month, now = Date.now(), { fresh = false } = {}) {
  const today = d.ilDate(new Date(now));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) month = today.slice(0, 7);
  const ck = 'opscal:' + month;
  if (!fresh && env.RATE) { try { const hit = JSON.parse((await env.RATE.get(ck)) || 'null'); if (hit && now - hit.at < 5 * 60e3) return { ...hit.data, cached: true }; } catch {} }
  const days = monthDays(month), first = days[0], last = days[days.length - 1];
  const raw = await d.snapshotCached(env).catch(() => null);
  const { events } = raw ? eventsFromRaw(raw, today, { isTestEventRow: d.isTestEventRow, planKeyOf: d.planKeyOf, from: addDays(first, -30) }) : { events: [] };
  const horizon = Math.max(0, Math.min(28, Math.round((Date.parse(last) - Date.parse(today)) / 864e5) + 1));
  const [cap, board, subTpl] = await Promise.all([
    horizon > 0 && last >= today ? buildCapacity(env, d, now, horizon).catch(() => null) : null,
    d.sendBoardData ? d.sendBoardData(env, { days: 3, detail: false }).catch(() => null) : null,
    d.kvPrefix(env, 'subevent:').then(all => new Set(Object.values(all).map(v => { try { return JSON.parse(v).template; } catch { return ''; } }).filter(Boolean))).catch(() => new Set()),
  ]);
  /* audit: the month's days up to today (counts only), one query per kind, bounded */
  let sends = [], callsDone = [], closed = [], truncated = false;
  if (first <= today) {
    const to = (last < today ? last : today).replace(/-/g, ''), from = first.replace(/-/g, '');
    const q = kind => d.auditQueryEx(env, { from, to, kind, limit: 20000, budget: 1500 }).catch(() => ({ items: [], truncated: true }));
    const [o, st, cl, pay] = await Promise.all([q('wa_out'), q('wa_status'), q('call'), q('pay')]);
    truncated = !!(o.truncated || st.truncated || cl.truncated || pay.truncated);
    sends = sendsByDay(o.items, st.items, { events, subTemplates: subTpl });
    callsDone = callsByDay(cl.items);
    closed = closedFromPay(pay.items, { parsePaidDesc: d.parsePaidDesc || (() => null), events });
  }
  /* Shir's queue: the guests who still get a call round, on the next open call day */
  let callsPlanned = [];
  try {
    if (raw && d.buildCallQueue && last >= today) {
      const { queue } = d.buildCallQueue(raw); const by = {};
      for (const g of queue || []) if (!g.capped && g.token) { const t = String(g.token).slice(0, 8); by[t] = by[t] || { tok8: t, name: g.event_name || '', n: 0 }; by[t].n++; }
      const cw = d.callWindowState ? d.callWindowState(new Date(now)) : { open: true };
      const ilH = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(now)));
      const day = firstEngineDay(cw.open || (cw.why === 'hours' && ilH < 12) ? today : addDays(today, 1), addDays(today, 10), d.isNoContactDay) || today;
      callsPlanned = Object.values(by).map(c => ({ ...c, day }));
    }
  } catch {}
  const model = cap && cap.model ? cap.model : { capacity_per_day: 230 };
  const out = { ok: true, at: new Date(now).toISOString(), ...calendarMonth({ month, today, events, board, capDays: (cap && cap.days) || [], sends, calls: { done: callsDone, planned: callsPlanned }, closed, isNoContactDay: d.isNoContactDay, perDay: model.capacity_per_day, fridayCap: model.friday_capacity ?? null,
    window: { weekday: '09:00–20:30', friday: '09:00–13:00', shabbat: null } }), audit_truncated: truncated, sources: { capacity: !!cap, send_board: !!board, snapshot: !!raw } };
  if (env.RATE) await env.RATE.put(ck, JSON.stringify({ at: now, data: out }), { expirationTtl: 600 }).catch(() => {});
  return out;
}

/* ── balances ────────────────────────────────────────────────────────────── */
export const VENDORS = {
  telnyx:     { dashboard_url: 'https://portal.telnyx.com/#/app/account/billing', topup_url: 'https://portal.telnyx.com/#/app/account/billing' },
  cloudflare: { dashboard_url: 'https://dash.cloudflare.com/?to=/:account/workers/plans', topup_url: 'https://dash.cloudflare.com/?to=/:account/billing' },
  meta_ads:   { dashboard_url: 'https://adsmanager.facebook.com/adsmanager/manage/accounts?act=1944903292858482', topup_url: 'https://business.facebook.com/billing_hub/accounts/details?asset_id=1944903292858482' },
  meta_wa:    { dashboard_url: 'https://business.facebook.com/wa/manage/insights/', topup_url: 'https://business.facebook.com/billing_hub/' },
  retell:     { dashboard_url: 'https://dashboard.retellai.com/billing', topup_url: 'https://dashboard.retellai.com/billing' },
  anthropic:  { dashboard_url: 'https://console.anthropic.com/settings/billing', topup_url: 'https://console.anthropic.com/settings/billing' },
};
export function balanceStatus(amount, low, err) {
  if (err) return 'error';
  if (amount == null || low == null) return 'ok';
  return Number(amount) < Number(low) ? 'low' : 'ok';
}
function vendorRow(vendor, o) {
  const low = BALANCE_LOW[vendor] ?? null;
  return { vendor, amount: o.amount ?? null, currency: o.currency || '', source: o.source || 'manual', checked_at: o.checked_at || new Date().toISOString(),
    dashboard_url: VENDORS[vendor].dashboard_url, topup_url: VENDORS[vendor].topup_url, auto_topup: o.auto_topup || 'unknown',
    status: o.status || balanceStatus(o.amount, low, o.error), low_threshold: low, error: o.error || '', extra: o.extra || {} };
}
async function manualRow(env, vendor, extra = {}) {
  const m = await kjson(env, 'bal:manual:' + vendor);
  return vendorRow(vendor, { amount: m ? m.amount : null, currency: (m && m.currency) || 'USD', source: 'manual', checked_at: m ? m.at : null, auto_topup: (m && m.auto_topup) || 'unknown', extra: { ...extra, manual_set_at: m ? m.at : null, stale_days: m && m.at ? Math.floor((Date.now() - Date.parse(m.at)) / 864e5) : null } });
}
export const ADAPTERS = {
  async telnyx(env) {
    if (!env.TELNYX_KEY) return manualRow(env, 'telnyx', { why: 'no TELNYX_KEY' });
    const r = await fetch('https://api.telnyx.com/v2/balance', { headers: { Authorization: 'Bearer ' + env.TELNYX_KEY } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (!j || !j.data) return vendorRow('telnyx', { source: 'api', error: 'http ' + (r ? r.status : 'unreachable') });
    const d = j.data; const num = v => v == null || v === '' ? null : Number(v);
    const avail = num(d.available_credit) ?? num(d.balance);
    return vendorRow('telnyx', { amount: avail, currency: d.currency || 'USD', source: 'api', extra: { balance: num(d.balance), available_credit: num(d.available_credit), credit_limit: num(d.credit_limit), pending: num(d.pending) } });
  },
  async cloudflare(env) {
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return manualRow(env, 'cloudflare', { why: 'no CF_API_TOKEN/CF_ACCOUNT_ID — set both for Workers usage' });
    const now = new Date(); const from = now.toISOString().slice(0, 8) + '01'; const to = now.toISOString().slice(0, 10);
    const query = `query($a:String!,$f:Date!,$t:Date!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:10000,filter:{date_geq:$f,date_leq:$t}){sum{requests subrequests errors}}}}}`;
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, f: from, t: to } }) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    const rows = j && j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0] ? j.data.viewer.accounts[0].workersInvocationsAdaptive : null;
    if (!rows) return vendorRow('cloudflare', { source: 'api', error: (j && j.errors && j.errors[0] && j.errors[0].message) || 'http ' + (r ? r.status : 'unreachable') });
    const sum = rows.reduce((a, x) => ({ requests: a.requests + (x.sum.requests || 0), subrequests: a.subrequests + (x.sum.subrequests || 0), errors: a.errors + (x.sum.errors || 0) }), { requests: 0, subrequests: 0, errors: 0 });
    return vendorRow('cloudflare', { amount: sum.requests, currency: 'requests_mtd', source: 'api', auto_topup: 'off', extra: { ...sum, from, to, plan_included_requests: 10000000 } });
  },
  async meta_ads(env, d) {
    if (!env.META_ADS_TOKEN) return manualRow(env, 'meta_ads', { why: 'no META_ADS_TOKEN' });
    const r = await d.metaAds(env, `/${META_AD_ACCOUNT}?fields=balance,amount_spent,spend_cap,currency,account_status,is_prepay_account`, 'GET').catch(() => null);
    const a = r && r.ok && r.data ? r.data : null;
    if (!a) return vendorRow('meta_ads', { source: 'api', error: 'graph ' + ((r && r.status) || 'unreachable') });
    const minor = v => v == null || v === '' ? null : Number(v) / 100;   /* Graph money fields are in minor units */
    const cap = minor(a.spend_cap), spent = minor(a.amount_spent), owed = minor(a.balance);
    const left = cap ? Math.max(0, Math.round((cap - spent) * 100) / 100) : null;
    return vendorRow('meta_ads', { amount: left, currency: a.currency || 'ILS', source: 'api', auto_topup: a.is_prepay_account === false ? 'on' : 'unknown',
      extra: { balance_owed: owed, amount_spent: spent, spend_cap: cap, account_status: a.account_status, is_prepay_account: a.is_prepay_account ?? null, amount_meaning: cap ? 'spend_cap − amount_spent' : 'no spend cap set (amount null)' } });
  },
  async meta_wa(env, d) {
    const now = new Date(); const start = Math.floor(Date.parse(now.toISOString().slice(0, 8) + '01T00:00:00Z') / 1000); const end = Math.floor(now.getTime() / 1000);
    const wabas = [{ name: 'guests', waba: GUEST_WABA, tok: env.WA_TOKEN_GUESTS }, { name: 'client', waba: d.clientWaba(env), tok: d.clientToken(env) }].filter(w => w.tok);
    if (!wabas.length) return manualRow(env, 'meta_wa', { why: 'no WhatsApp tokens' });
    const per = []; let total = 0, err = '';
    for (const w of wabas) {
      const f = `pricing_analytics.start(${start}).end(${end}).granularity(DAILY)`;
      const r = await fetch(`${GRAPH}/${w.waba}?fields=${encodeURIComponent(f)}`, { headers: { Authorization: 'Bearer ' + w.tok } }).catch(() => null);
      const j = r ? await r.json().catch(() => null) : null;
      const pts = (j && j.pricing_analytics && j.pricing_analytics.data && j.pricing_analytics.data[0] && j.pricing_analytics.data[0].data_points) || null;
      if (!pts) { err = err || ((j && j.error && j.error.message) || 'http ' + (r ? r.status : 'unreachable')); per.push({ name: w.name, waba: w.waba, error: (j && j.error && j.error.message) || 'no data' }); continue; }
      const cost = pts.reduce((n, p) => n + (Number(p.cost) || 0), 0), volume = pts.reduce((n, p) => n + (Number(p.volume) || 0), 0);
      total += cost; per.push({ name: w.name, waba: w.waba, spend_mtd: Math.round(cost * 100) / 100, volume });
    }
    const allErr = per.every(p => p.error);
    return vendorRow('meta_wa', { amount: allErr ? null : Math.round(total * 100) / 100, currency: 'USD', source: 'api', auto_topup: 'unknown', error: allErr ? err : '', extra: { meaning: 'spend this month (pricing_analytics), not a balance — the payment method is not readable', wabas: per } });
  },
  async retell(env) {
    /* no balance endpoint in Retell's API (docs.retellai.com, checked 03/11): manual + the concurrency read + the billing-guard flag */
    let conc = null;
    if (env.RETELL_KEY) { const r = await fetch('https://api.retellai.com/get-concurrency', { headers: { Authorization: 'Bearer ' + env.RETELL_KEY } }).catch(() => null); conc = r && r.ok ? await r.json().catch(() => null) : null; }
    const row = await manualRow(env, 'retell', { concurrency: conc, billing_guard_tripped: !!(await kget(env, 'billretell')), note: 'credits hit 0 → calls end with credit_exhausted' });
    if (row.extra.billing_guard_tripped) row.status = 'low';
    return row;
  },
  async anthropic(env) { return manualRow(env, 'anthropic', { note: 'credit balance is not in the API; Admin usage/cost API needs an sk-ant-admin key' }); },
};
export async function buildBalances(env, d, { fresh = false } = {}) {
  if (!fresh) { const c = await kjson(env, 'bal:cache'); if (c && Date.now() - Date.parse(c.at) < 10 * 60e3) return { ...c, cached: true }; }
  const vendors = await Promise.all(Object.keys(ADAPTERS).map(v => ADAPTERS[v](env, d).catch(e => vendorRow(v, { source: 'api', error: String(e && e.message || e) }))));
  const out = { ok: true, at: new Date().toISOString(), vendors };
  if (env.RATE) await env.RATE.put('bal:cache', JSON.stringify(out), { expirationTtl: 3600 }).catch(() => {});
  return { ...out, cached: false };
}

/* ── registry ────────────────────────────────────────────────────────────── */
function triggerExpr(n, depth = 0) {
  if (n.trigger && n.trigger.cron) return n.trigger.cron;
  const p = BY_ID[(n.from || [])[0]]; return p && depth < 5 ? triggerExpr(p, depth + 1) : '';
}
export function nextFire(n, now = new Date()) {
  const ex = String(triggerExpr(n)).split('+').map(x => x.trim()).filter(Boolean).map(e => e === '*/10' ? '*/10 * * * *' : e);
  return ex.flatMap(e => e === '0 17,18,19 * * *' ? [cronNext(e, now)] : [cronNext(e, now)]).filter(Boolean).sort()[0] || null;
}
export function codeRef(id) {
  const c = CODE.nodes && CODE.nodes[id];
  return c ? { file: c.file, line: c.line_start, line_end: c.line_end, ref: `${c.file}:${c.line_start}`, symbol: c.symbol } : null;
}
export async function buildRegistry(env, now = Date.now()) {
  const since = new Date(now - 864e5).toISOString();
  const [stats, offs, cfgVals, firstSeen] = await Promise.all([runStats(env, since), Promise.all(KILL_SWITCH_IDS.map(async id => [id, await offState(env, id)])), loadCfg(env, { fresh: true }).catch(() => ({})), registryFirstSeen(env).catch(() => ({}))]);
  const off = Object.fromEntries(offs);
  const nodes = AUTOMATIONS.map(n => {
    const m = opsMeta(n);
    const sid = switchFor(n.id);
    const st = stats.stats[n.id] || null;
    return { id: n.id, name_he: n.name_he, layer: n.layer, kind: n.kind, from: n.from || [], trigger: n.trigger || null, conditions: n.conditions || [], templates: n.templates || [],
      audience: n.audience || '', warnings: n.warnings || [], ...m, code_ref: codeRef(n.id), editable: editableFor(n.id, cfgVals),
      added_at: n.added || firstSeen[n.id] || null, is_new: isNew(n.added || firstSeen[n.id], now),
      state: { enabled: sid ? !off[sid] : true, switch_id: sid, off: sid ? off[sid] : null, last_run_at: st ? st.last_started_at : null, runs_24h: st ? st.runs_24h : 0, by_status_24h: st ? st.by_status : {}, next_fire: nextFire(n, new Date(now)) } };
  });
  return { ok: true, at: new Date(now).toISOString(), ledger_source: stats.source, kill_switches: KILL_SWITCH_IDS, code_snapshot: { at: CODE.generated_at, git: CODE.git }, nodes };
}

/* ── toggle ──────────────────────────────────────────────────────────────── */
export async function toggle(env, d, b, now = Date.now()) {
  const id = String(b.id || '');
  if (!BY_ID[id]) return { status: 404, body: { ok: false, error: 'unknown-id' } };
  const sid = switchFor(id);
  if (!sid) return { status: 409, body: { ok: false, error: 'no-kill-switch', he: 'לאוטומציה הזו אין מתג שהקוד בודק — רק "paused" הכללי עוצר אותה', kill_switches: KILL_SWITCH_IDS } };
  if (typeof b.enabled !== 'boolean') return { status: 400, body: { ok: false, error: 'enabled-must-be-boolean' } };
  const today = d.ilDate(new Date(now));
  const before = await offState(env, sid);
  /* blast radius: computed on every call; shown before the confirm */
  let items = [], callQ = 0;
  try {
    const inp = await projectionInputs(env, d, today, 7);
    if (inp) { items = projectItems({ events: inp.events, guests: inp.guests, flags: inp.flags, today, days: 7, isNoContactDay: d.isNoContactDay }); callQ = (d.buildCallQueue(inp.raw).queue || []).filter(g => !g.capped).length; }
  } catch {}
  const radius = blastRadius(sid, { items, today, days: 7, calls: { queued: callQ, callbacks: await kcount(env, 'cbq:') } });
  const base = { ok: true, id, switch_id: sid, key: OFF_PREFIX + sid, enabled_now: !before, requested_enabled: b.enabled, off_since: before, blast_radius: b.enabled ? null : radius, confirm_required: sid };
  if (b.confirm !== sid && b.confirm !== id) return { status: 200, body: { ...base, applied: false, he: `כדי לבצע, לשלוח שוב עם confirm: "${sid}"` } };
  const who = String(b.who || 'admin').slice(0, 40); const reason = String(b.reason || '').slice(0, 300);
  if (b.enabled) await env.RATE.delete(OFF_PREFIX + sid);
  else await env.RATE.put(OFF_PREFIX + sid, JSON.stringify({ at: new Date(now).toISOString(), by: who, reason }));
  const msg = `${b.enabled ? '🟢 הופעל' : '🔴 כובה'} · ${BY_ID[sid].name_he} (${sid})${reason ? ' · ' + reason : ''}${!b.enabled ? ` · נעצרות ${radius.messages_next_days.total} הודעות ב-7 ימים, ${radius.events_affected.length} אירועים` : ''}`;
  await d.auditRecord(env, { kind: 'admin', area: 'מרכז בקרה', action: msg, ok: true, review: !b.enabled, data: { switch: sid, enabled: b.enabled, before, who, reason, blast: b.enabled ? null : { messages: radius.messages_next_days.total, events: radius.events_affected.length } } }).catch(() => {});
  await d.slackPost(env, `🎛️ *מרכז בקרה* · ${msg}`).catch(() => {});
  const chg = await recordChange(env, { kind: 'toggle', who, summary_he: `${b.enabled ? 'הופעל' : 'כובה'}: ${BY_ID[sid].name_he} (${sid})${reason ? ' · ' + reason : ''}`,
    details: { switch: sid, id, enabled: b.enabled, before_off: before, who, reason, reverts: b.reverts || null, blast: b.enabled ? null : { messages: radius.messages_next_days.total, events: radius.events_affected.length } },
    revert: { possible: true, how: 'toggle', payload: { id: sid, enabled: !b.enabled } } }, now);
  return { status: 200, body: { ...base, applied: true, enabled_now: b.enabled, change_id: chg ? chg.id : null } };
}

/* ── edit-in-place (cfg.js) ──────────────────────────────────────────────── */
/* what an edit changes, computed before the confirm (like toggle's blast radius) */
async function editRadius(env, d, id, field, before, after, now) {
  const today = d.ilDate(new Date(now)); const effects = [];
  let inp = null; try { inp = await projectionInputs(env, d, today, 7); } catch {}
  const items = inp ? projectItems({ events: inp.events, guests: inp.guests, flags: inp.flags, today, days: 7, isNoContactDay: d.isNoContactDay }) : [];
  const todayPlanned = items.filter(x => x.day === today && !x.held).reduce((n, x) => n + x.count, 0);
  const winMin = w => { const t = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; }; return { wk: t(w.end) - t(w.start), fri: t(w.fri_end) - t(w.start) }; };
  if (id === 'pacer_batch_size') { effects.push({ label: 'הודעות לפעימה', before, after }); effects.push({ label: 'מקסימום ליום (≈69 פעימות בחלון)', before: before * 69, after: after * 69 }); effects.push({ label: 'מתוכנן להיום', count: todayPlanned }); }
  if (id === 'send_window') { const a = winMin(before), b = winMin(after); effects.push({ label: 'דקות שליחה ביום חול', before: a.wk, after: b.wk }); effects.push({ label: 'דקות שליחה בשישי', before: a.fri, after: b.fri }); effects.push({ label: 'פעימות שנעלמות ביום חול', count: Math.max(0, Math.round((a.wk - b.wk) / 10)) }); effects.push({ label: 'מתוכנן להיום', count: todayPlanned }); }
  if (id === 'guest_budget_margin') { const cap = await d.guestCapacity(env).catch(() => null); if (cap) { effects.push({ label: 'נשאר היום בתקרה', before: Math.max(0, cap.limit - cap.used - before), after: Math.max(0, cap.limit - cap.used - after) }); } effects.push({ label: 'מתוכנן להיום', count: todayPlanned }); }
  if (id === 'daily_call_cap') { const q = inp ? (d.buildCallQueue(inp.raw).queue || []).filter(g => !g.capped).length : 0; effects.push({ label: 'חיוגים בתור', count: q }); effects.push({ label: 'תקרה ליום', before: before || 'בלי', after: after || 'בלי' }); }
  if (id === 'noa_chase') effects.push({ label: after === 'on' ? 'נועה מתחילה לחייג ללידים "לא ענה" (2 לפעימה, בחלון שיחות) וכותבת למאנדיי' : 'נועה מפסיקה לחייג ללידים', count: after === 'on' ? 2 : 0 });
  if (id === 'event_hold') { const mine = items.filter(x => x.token === field); effects.push({ label: after ? 'הודעות שנעצרות ב-7 ימים לאירוע' : 'הודעות שחוזרות ב-7 ימים לאירוע', count: mine.reduce((n, x) => n + x.count, 0) }); }
  return { setting: id, field: field || '', horizon_days: 7, effects };
}
export async function editSetting(env, d, b, now = Date.now()) {
  const id = String(b.id || ''); const field = String(b.field || '');
  const s = SETTINGS[id];
  if (!s) return { status: 404, body: { ok: false, error: 'unknown-setting', settings: Object.keys(SETTINGS) } };
  const vals = await loadCfg(env, { fresh: true }); const eff = effective(vals);
  const cur = s.per ? !!(await kget(env, 'hold:' + field)) : eff[id];
  const v = validateEdit(id, field, b.value, cur);
  if (!v.ok) return { status: 400, body: { ok: false, error: 'invalid', why: v.why } };
  const word = confirmWord(id, v.value);
  const radius = await editRadius(env, d, id, field, cur, v.value, now).catch(() => ({ setting: id, effects: [] }));
  const base = { ok: true, id, field, before: cur, after: v.value, blast_radius: radius, confirm_required: word };
  if (b.confirm !== word) return { status: 200, body: { ...base, applied: false, he: id === 'noa_chase' && v.value === 'on' ? `נועה רודפת נשארת כבויה עד שריצ'ארד מקליד "${NOA_CHASE_ON_CONFIRM}"` : `כדי לשמור, לשלוח שוב עם confirm: "${word}"` } };
  const who = String(b.who || 'admin').slice(0, 40), reason = String(b.reason || '').slice(0, 300);
  const w = await writeSetting(env, id, field, v.value, { who, reason, now });
  const show = x => (x && typeof x === 'object' ? Object.values(x).join('–') : String(x));
  const msg = `✏️ ${s.he}${field && s.per ? ' · ' + field.slice(0, 8) : ''}: ${show(w.before)} → ${show(w.after)}${reason ? ' · ' + reason : ''}`;
  await d.auditRecord(env, { kind: 'admin', area: 'מרכז בקרה', action: msg, ok: true, review: true, data: { setting: id, field, before: w.before, after: w.after, who, reason, blast: radius.effects } }).catch(() => {});
  await d.slackPost(env, `🎛️ *מרכז בקרה* · ${msg} · ${who}`).catch(() => {});
  const chg = await recordChange(env, { kind: s.per ? 'hold' : 'edit', who, summary_he: msg.replace(/^✏️ /, ''),
    details: { setting: id, field, from: w.before, to: w.after, who, reason, reverts: b.reverts || null, blast: radius.effects },
    revert: { possible: true, how: 'edit', payload: { id, field, value: w.before } } }, now);
  return { status: 200, body: { ...base, applied: true, change_id: chg ? chg.id : null } };
}

/* ── change log revert ───────────────────────────────────────────────────── */
/* POST /api/ops/revert {id, confirm, who}. Without the typed confirm: a preview (what would happen).
   The confirm is `revert:<id>`, or `rollback:<previous version id>` for a deploy. Reverting an edit
   back to noa_chase "on" still needs Richard's own word (cfg.js rule), never the generic one. */
export async function revertChange(env, d, b, now = Date.now(), { fetchFn = fetch } = {}) {
  const id = String(b.id || '');
  const e = await getChange(env, id);
  if (!e) return { status: 404, body: { ok: false, error: 'unknown-change' } };
  if (!e.revert || !e.revert.possible) return { status: 409, body: { ok: false, error: 'not-revertible', change: e } };
  if (e.reverted_at) return { status: 409, body: { ok: false, error: 'already-reverted', reverted_at: e.reverted_at, reverted_by: e.reverted_by } };
  const p = e.revert.payload || {};
  const who = String(b.who || 'admin').slice(0, 40);
  let word = revertWord(e);
  if (e.revert.how === 'edit' && p.id === 'noa_chase' && p.value === 'on') word = NOA_CHASE_ON_CONFIRM;
  const preview = e.revert.how === 'edit' ? { setting: p.id, field: p.field || '', back_to: p.value, now: (e.details || {}).to }
    : e.revert.how === 'toggle' ? (p.pause !== undefined ? { pause: p.pause } : { switch: p.id, enabled: p.enabled })
    : { version_id: p.version_id, from_version: p.from_version || null, command: `cd worker && npx wrangler rollback ${p.version_id} --name ${p.script || 'ishur-webhooks'}`, api: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID) };
  const base = { ok: true, id, how: e.revert.how, preview, confirm_required: word };
  if (b.confirm !== word) return { status: 200, body: { ...base, applied: false, he: `כדי לשחזר, לשלוח שוב עם confirm: "${word}"` } };
  const reason = `שחזור ${id}`;
  let r = null, newId = null;
  if (e.revert.how === 'edit') {
    const v = validateEdit(p.id, p.field || '', p.value, null);
    if (!v.ok) return { status: 409, body: { ok: false, error: 'previous-value-invalid-now', why: v.why } };
    r = await editSetting(env, d, { id: p.id, field: p.field || '', value: p.value, confirm: confirmWord(p.id, v.value), who, reason, reverts: id }, now);
    if (r.body && r.body.applied) newId = r.body.change_id;
    else return { status: r.status || 409, body: { ok: false, error: 'edit-not-applied', result: r.body } };
  } else if (e.revert.how === 'toggle' && p.pause !== undefined) {
    if (p.pause) await env.RATE.put('paused', new Date(now).toISOString());
    else { await env.RATE.delete('paused'); await env.RATE.put('pacer:pending', d.ilDate(new Date(now)), { expirationTtl: 2 * 86400 }).catch(() => {}); }
    await d.slackPost(env, `🎛️ *מרכז בקרה* · שחזור: ${p.pause ? '⏸️ כל השליחות הושהו' : '▶️ השליחות חזרו לפעול'} · ${who}`).catch(() => {});
    const c = await recordChange(env, { kind: 'pause', who, summary_he: `${p.pause ? 'עצירה כללית הופעלה' : 'עצירה כללית בוטלה'} (שחזור)`, details: { paused: p.pause, reverts: id, who }, revert: { possible: true, how: 'toggle', payload: { pause: !p.pause } } }, now);
    newId = c ? c.id : null; r = { body: { paused: p.pause } };
  } else if (e.revert.how === 'toggle') {
    r = await toggle(env, d, { id: p.id, enabled: !!p.enabled, confirm: p.id, who, reason, reverts: id }, now);
    if (r.body && r.body.applied) newId = r.body.change_id;
    else return { status: r.status || 409, body: { ok: false, error: 'toggle-not-applied', result: r.body } };
  } else if (e.revert.how === 'rollback') {
    const api = await cfRollback(env, p.version_id, { message: `ops center rollback ${id} by ${who}`, fetchFn });
    if (!api.ok) return { status: 200, body: { ...base, applied: false, manual: true, api, he: api.manual ? 'אין CF_API_TOKEN בוורקר: להריץ את הפקודה במחשב' : 'Cloudflare סירב: להריץ את הפקודה במחשב', command: preview.command } };
    await d.auditRecord(env, { kind: 'admin', area: 'בנייה', action: `↩️ שחזור גרסה ל-${String(p.version_id).slice(0, 8)} (מרכז בקרה)`, ok: true, review: true, data: { change: id, version_id: p.version_id, who } }).catch(() => {});
    await d.slackPost(env, `🎛️ *מרכז בקרה* · ↩️ הוורקר הוחזר לגרסה ${String(p.version_id).slice(0, 8)} · ${who}`).catch(() => {});
    const c = await recordChange(env, { kind: 'revert', who, summary_he: `הוורקר הוחזר לגרסה ${String(p.version_id).slice(0, 8)}`, details: { reverts: id, version_id: p.version_id, from_version: p.from_version || null, deployment_id: api.deployment_id },
      revert: p.from_version ? { possible: true, how: 'rollback', payload: { version_id: p.from_version, script: p.script, from_version: p.version_id } } : null }, now);
    newId = c ? c.id : null; r = { body: api };
  }
  await markReverted(env, e, newId, now);
  return { status: 200, body: { ...base, applied: true, revert_change_id: newId, result: r && r.body } };
}

/* ── live / runs ─────────────────────────────────────────────────────────── */
export function mergeLive(auditRows, runRows, limit = 200) {
  const a = (auditRows || []).map(r => ({ type: 'audit', ts: r.ts, at: r.at, id: r.id, kind: r.kind, area: r.area, action: r.action, ok: r.ok, token: r.token ? String(r.token).slice(0, 8) : '', detail: String(r.detail || '').slice(0, 300), data: r.data && r.data.job ? { job: r.data.job, ms: r.data.ms, run_id: r.data.run_id || null } : null }));
  const b = (runRows || []).map(r => ({ type: 'run', ts: Date.parse(r.ended_at || r.started_at) || 0, at: r.ended_at || r.started_at, id: r.id, automation_id: r.automation_id, parent_id: r.parent_id, status: r.status, triggered_by: r.triggered_by, counts: r.counts, summary: String(r.summary || '').slice(0, 300) }));
  const all = [...a, ...b].sort((x, y) => y.ts - x.ts).slice(0, limit);
  return { items: all, cursor: all.length ? Math.max(...all.map(x => x.ts)) : null };
}

/* what the brain's capacity/balances checks call (ops.js owns them) */
export const brainFns = () => ({ buildCapacity: (env, d, now, days) => buildCapacity(env, d, now, days), buildBalances: (env, d, o) => buildBalances(env, d, o) });

/* ══ the router ════════════════════════════════════════════════════════════ */
export async function handleOps(request, env, origin, url, d) {
  const path = url.pathname.replace(/^\/api\/ops\//, '');
  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch { return d.deny(400, 'bad-json', origin); } }
  else if (request.method !== 'GET') return d.deny(405, 'method', origin);
  const hk = request.headers.get('X-Admin-Key') || String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const key = body.admin_key || hk;
  if (!(await d.adminKeyOk(env, key))) return d.deny(403, 'bad-admin-key', origin);
  const q = k => body[k] ?? url.searchParams.get(k);
  const json = (o, status = 200) => status === 200 ? d.okJson(o, origin) : new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...d.cors(origin) } });
  try {
    if (/^(notifications(\/mark|\/push-pull)?|notify-settings|overview|overview-series)$/.test(path) || (path === 'edit' && String(body.id || '').startsWith('notify:'))) return (await import('./notify.js')).handleNotify(request, env, url, d, body, json, path);   /* 03/11 Phase 5 notifications + overview */
    switch (path) {
      case 'realtime': return json(await buildRealtime(env, d));
      case 'capacity': return json(await buildCapacity(env, d, Date.now(), Math.max(1, Math.min(28, Number(q('days')) || 14))));
      case 'calendar': return json(await buildCalendar(env, d, String(q('month') || ''), Date.now(), { fresh: String(q('fresh') || '') === '1' }));
      case 'balances': {
        if (request.method === 'POST' && body.set) {
          const v = String(body.set.vendor || ''); if (!VENDORS[v]) return json({ ok: false, error: 'unknown-vendor', vendors: Object.keys(VENDORS) }, 400);
          const amt = Number(body.set.amount); if (!Number.isFinite(amt)) return json({ ok: false, error: 'amount-not-a-number' }, 400);
          const rec = { amount: amt, currency: String(body.set.currency || 'USD').slice(0, 8), auto_topup: ['on', 'off', 'unknown'].includes(body.set.auto_topup) ? body.set.auto_topup : 'unknown', at: new Date().toISOString() };
          await env.RATE.put('bal:manual:' + v, JSON.stringify(rec)); await env.RATE.delete('bal:cache').catch(() => {});
          return json({ ok: true, vendor: v, manual: rec });
        }
        return json(await buildBalances(env, d, { fresh: String(q('fresh') || '') === '1' || q('fresh') === true }));
      }
      case 'registry': return json(await buildRegistry(env));
      case 'code': {
        const id = String(q('id') || ''); const c = CODE.nodes && CODE.nodes[id];
        if (!c) return json({ ok: false, error: BY_ID[id] ? 'no-code-snapshot' : 'unknown-id' }, 404);
        return json({ ok: true, id, ...c, snapshot_at: CODE.generated_at, git: CODE.git });
      }
      case 'toggle': {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST-only' }, 405);
        const r = await toggle(env, d, body); return json(r.body, r.status);
      }
      case 'live': {
        const since = Number(q('since')) || 0;
        const limit = Math.max(1, Math.min(200, Number(q('limit')) || 200));
        const aq = await d.auditQueryEx(env, { days: 1, limit, since, budget: 3000 });
        const runs = await listRuns(env, { from: since ? new Date(since).toISOString() : new Date(Date.now() - 3600e3).toISOString(), limit });
        return json({ ok: true, ...mergeLive(aq.items, runs.items.filter(r => !since || (Date.parse(r.ended_at || r.started_at) || 0) > since), limit), audit_truncated: !!aq.truncated, ledger_source: runs.source, now: Date.now() });
      }
      case 'runs': {
        const r = await listRuns(env, { automation_id: q('automation_id') || '', status: q('status') || '', from: q('from') || '', to: q('to') || '', cursor: q('cursor') || '', limit: Number(q('limit')) || 50 });
        return json({ ok: true, ...r });
      }
      case 'run': {
        const id = String(q('id') || ''); const r = await getRun(env, id);
        if (!r) return json({ ok: false, error: 'not-found' }, 404);
        const t0 = Date.parse(r.run.started_at) - 1000, t1 = (Date.parse(r.run.ended_at || r.run.started_at) || Date.now()) + 5000;
        const tok = String(q('token') || '');
        const day = ilDayOf(t0).replace(/-/g, '');
        const rows = await d.auditQuery(env, { from: day, to: ilDayOf(t1).replace(/-/g, ''), since: t0, limit: 2000, token: tok || undefined });
        const linked = rows.filter(x => x.ts >= t0 && x.ts <= t1 && (!tok || String(x.token || '').startsWith(tok.slice(0, 8))))
          .map(x => ({ id: x.id, ts: x.ts, at: x.at, kind: x.kind, action: x.action, ok: x.ok, token: x.token ? String(x.token).slice(0, 8) : '', detail: String(x.detail || '').slice(0, 300), run_match: !!(x.data && x.data.run_id === id) }))
          .sort((a, b) => a.ts - b.ts).slice(0, 500);
        return json({ ok: true, source: r.source, run: r.run, children: r.children, audit: linked, audit_window: { from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), token: tok || null } });
      }
      case 'brain': return json(await buildBrain(env, { since: Number(q('since')) || 0 }));
      case 'brain-run': {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST-only' }, 405);
        const r = await runBrain(env, d, { force: true, only: body.only || null, triggered_by: 'manual:' + String(body.who || 'admin').slice(0, 40), fns: brainFns() });
        return json({ ok: true, ...r });
      }
      case 'brain-decision': {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST-only' }, 405);
        const r = await decide(env, d, body); return json(r.body, r.status);
      }
      case 'run-log': {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST-only' }, 405);
        const r = await runLogAppend(env, body); return json(r.body, r.status);
      }
      case 'edit': {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST-only' }, 405);
        const r = await editSetting(env, d, body); return json(r.body, r.status);
      }
      case 'changes': {
        const actor = String(q('actor') || '');
        if (actor && !ACTORS.includes(actor)) return json({ ok: false, error: 'bad-actor', actors: ACTORS }, 400);
        const r = await listChanges(env, { from: q('from') || '', to: q('to') || '', kind: q('kind') || '', actor, cursor: q('cursor') || '', limit: Number(q('limit')) || 100 });
        return json({ ok: true, kinds: KINDS, actors: ACTORS, ...r });
      }
      /* 03/11 Phase 4a (ops-inbox.js): read-only */
      case 'messages': return json(await buildMessages(env, d, { day: q('day'), cursor: q('cursor'), tab: q('tab'), limit: q('limit') }));
      case 'inbox': return json(await buildInbox(env, d, { channel: q('channel'), limit: q('limit') }));
      case 'thread': { const r = await buildThread(env, d, { phone: q('phone') }); return json(r.body, r.status); }
      case 'control': return json(await buildControl(env, d));
      case 'revert': {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST-only' }, 405);
        const r = await revertChange(env, d, body); return json(r.body, r.status);
      }
      default: return json({ ok: false, error: 'unknown-ops-route', routes: ['realtime', 'capacity', 'calendar', 'balances', 'registry', 'code', 'toggle', 'live', 'runs', 'run', 'brain', 'brain-run', 'brain-decision', 'run-log', 'edit', 'changes', 'revert', 'messages', 'inbox', 'thread', 'control'] }, 404);
    }
  } catch (e) {
    return json({ ok: false, error: 'ops-failed', why: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}
