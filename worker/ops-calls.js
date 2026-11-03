/* ============================================================================
   ishur.io · ops-calls.js · the call center behind the ops "שיחות" screen (03/11, Phase 4b)
   ----------------------------------------------------------------------------
   Routed from ops.js handleOps (same admin auth, same deps object):
     GET  /api/ops/calls?day=|from=&to=|week=1&event=&outcome=&number=&agent=&cursor=&limit=
            timeline of Shir (guests) + Noa (leads) calls from the audit log (kind 'call',
            written by the Retell call_analyzed webhook), outcome mapped to one vocabulary,
            attempt # per guest inside the range, ₪ cost split Retell / Telnyx, and a costs rollup.
     GET  /api/ops/call?id=call_…&day=     one call: transcript (turns), AI summary, analysis,
            recording as a short-lived SIGNED link served by the Worker (/rec/<id>?e=&s=).
     GET  /api/ops/call-rounds             per-event round cards: queued / remaining / capacity today,
            "why not dialing" reasons, stop flag, extra-round job.
     POST /api/ops/call-round {token, action:'start'|'stop', confirm, extra?, reason?}
            typed confirm = first 8 chars of the token. stop → callstop:<token> (runShirDispatch
            skips that event); start → removes it (+ extra:true writes callround:<token> for today).
            Never dials anything itself.
     GET  /api/ops/manual-calls            the "נדרשת שיחה" queue + notes
     POST /api/ops/manual-calls {action:'note', guest_id, note} | {action:'done', guest_id, outcome, tries}
            'done' writes the outcome to the guest row through the same writer /api/event call_result uses.
     GET  /api/ops/shir                    Shir admin (read-only): prompt version + history, begin_message,
            model, voice settings. Edits stay on POST /api/voice-prompt (versioned, rollback).

   Money: audit `cost` is ₪ (Retell combined_cost USD cents × 3.7, index.js call_analyzed).
   Retell does not bill the Telnyx leg of an imported number, and nothing records it per call,
   so the Telnyx column is an ESTIMATE from billed minutes × env.TELNYX_ILS_PER_MIN (or
   TELNYX_USD_PER_MIN × 3.7) and null when neither is set.
   ========================================================================== */
import { rowFromAudit, dayList, paginate } from './calls-log.js';
import { recordingLink } from './audit.js';
import { planKeyOf, planMaxCallTries } from './dashboard.js';
import { isOff } from './ops-run.js';
import { dailyCallCap } from './cfg.js';
import { recordChange } from './changes.js';

export const USD_ILS = 3.7;
export const OUTCOMES = { coming: 'מגיע', not_coming: 'לא מגיע', maybe: 'מתלבט', callback: 'לחזור אליו', voicemail: 'תא קולי', no_answer: 'לא ענה', answered: 'נענתה בלי תשובה', failed: 'נכשלה', do_not_call: 'ביקש לא להתקשר' };
export const MANUAL_OUTCOMES = ['מגיע', 'לא מגיע', 'מתלבט', 'לא ענה', 'לחייג שוב', 'לא להתקשר'];
const ilDayOf = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isoOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */

/* one outcome key per call, from what the webhook stored (rsvp, answer text, disconnection, duration) */
export function mapOutcome({ outcome = '', answer = '', disconnection = '', duration_s = 0, state = '' } = {}) {
  const o = String(outcome || ''), a = String(answer || ''), disc = String(disconnection || ''), dur = Number(duration_s) || 0;
  if (o === 'מגיע') return 'coming';
  if (o === 'לא מגיע') return 'not_coming';
  if (o === 'מתלבט' || /מתלבט/.test(a)) return 'maybe';
  if (/לא להתקשר/.test(a)) return 'do_not_call';
  if (/לחייג שוב|לחזור|תחזרי|callback/i.test(a)) return 'callback';
  if (disc === 'voicemail_reached' || /תא קולי/.test(a)) return 'voicemail';
  if (state === 'failed' || /^(error|dial_failed|invalid_destination|registered_call_timeout|concurrency_limit|scam_detected)/.test(disc)) return 'failed';
  if (/^dial_(no_answer|busy)$/.test(disc) || /לא ענה/.test(a) || !dur) return 'no_answer';
  return 'answered';
}

/* Telnyx ₪ per billed minute (null = unknown) */
export function telnyxRate(env = {}) {
  const ils = Number(env.TELNYX_ILS_PER_MIN); if (Number.isFinite(ils) && ils > 0) return ils;
  const usd = Number(env.TELNYX_USD_PER_MIN); if (Number.isFinite(usd) && usd > 0) return usd * USD_ILS;
  return null;
}
/* ₪ split for one call; Telnyx bills per started minute, nothing for a call that never connected */
export function costSplit(row, rate = null) {
  const retell = r2(row.cost);
  const minutes = row.duration_s > 0 ? Math.ceil(row.duration_s / 60) : 0;
  const telnyx = rate == null ? null : r2(minutes * rate);
  return { retell, telnyx, total: r2(retell + (telnyx || 0)), minutes };
}

/* audit record → timeline row (list view: transcript stays on the detail endpoint) */
export function timelineRow(rec, rate = null) {
  const r = rowFromAudit(rec);
  const key = mapOutcome(r);
  const c = costSplit(r, rate);
  return { id: r.id, ts: r.ts, at: new Date(r.ts).toISOString(), day: r.day, agent: r.agent, kind: r.kind, name: r.name, phone: r.phone,
    event: r.event, token: r.token, tok8: String(r.token || '').slice(0, 8), guest_id: r.guest_id,
    outcome: key, outcome_he: OUTCOMES[key], rsvp: r.outcome, answer: r.answer, duration_s: r.duration_s, disconnection: r.disconnection,
    cost: c, has_recording: !!r.recording, has_transcript: !!r.transcript, summary: r.summary, sentiment: r.sentiment, review: r.review, attempt: null };
}

/* attempt # = this guest's (or phone's) nth call inside the rows given (chronological) */
export function assignAttempts(rows) {
  const seen = {};
  for (const r of [...rows].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))) {
    const k = r.guest_id || (r.phone ? 'p:' + r.phone : 'id:' + r.id);
    r.attempt = seen[k] = (seen[k] || 0) + 1;
  }
  return rows;
}

export function callMatches(r, f = {}) {
  if (f.event && r.tok8 !== String(f.event).slice(0, 8) && r.event !== f.event) return false;
  if (f.outcome) { const want = String(f.outcome).split(','); if (!want.includes(r.outcome)) return false; }
  if (f.number) { const n = String(f.number).replace(/\D/g, '').replace(/^0/, ''); if (n && !String(r.phone || '').includes(n)) return false; }
  if (f.agent && r.agent !== f.agent && r.kind !== f.agent) return false;
  return true;
}

/* per day and per event, ₪. Feeds the finance screen (ops.js re-exports it). */
export function callCostRollup(rows, { rate = null } = {}) {
  const blank = () => ({ calls: 0, connected: 0, minutes: 0, retell: 0, telnyx: rate == null ? null : 0, total: 0 });
  const add = (b, r) => { const c = r.cost || costSplit(r, rate); b.calls++; if (r.duration_s > 0) b.connected++; b.minutes += c.minutes; b.retell = r2(b.retell + c.retell); if (b.telnyx != null) b.telnyx = r2(b.telnyx + (c.telnyx || 0)); b.total = r2(b.total + c.total); };
  const days = {}, events = {}, total = blank();
  for (const r of rows || []) {
    add(days[r.day] = days[r.day] || { day: r.day, ...blank() }, r);
    const k = r.kind === 'guest' ? (r.tok8 || '—') : r.kind;
    add(events[k] = events[k] || { key: k, event: r.kind === 'guest' ? r.event : r.kind === 'lead' ? 'נועה · לידים' : 'נכנסות', ...blank() }, r);
    add(total, r);
  }
  return { currency: 'ILS', telnyx_rate_per_min: rate, telnyx_basis: rate == null ? 'unknown' : 'estimate', by_day: Object.values(days).sort((a, b) => a.day < b.day ? 1 : -1), by_event: Object.values(events).sort((a, b) => b.total - a.total), total };
}

/* why an event's round is not dialing right now (empty list = it will dial on the next tick) */
export const WHY_HE = { 'not-configured': 'שיר לא מוגדרת (RETELL_KEY / SHIR_FROM)', paused: 'עצירה כללית פעילה', 'off:shir_dispatch': 'מתג החיוג של שיר כבוי', 'off:d_pacer': 'הפייסר כבוי',
  'no-contact-day': 'יום ללא פניות (חג)', window: 'מחוץ לחלון השיחות', hold: 'האירוע מוחזק (hold)', stopped: 'הסבב נעצר ידנית', plan: 'החבילה לא כוללת שיחות',
  'daily-cap': 'תקרת החיוגים היומית מוצתה', 'event-passed': 'האירוע עבר', 'all-capped': 'כל הממתינים מיצו את הנסיונות', 'done-today': 'כל הממתינים כבר חויגו היום', empty: 'אין ממתינים לשיחה', 'no-capacity': 'לא נשארו פעימות היום' };
export function whyNotDialing(g = {}) {
  const out = [];
  const push = (code, extra) => out.push({ code, he: WHY_HE[code] + (extra ? ' · ' + extra : '') });
  if (g.notConfigured) push('not-configured');
  if (g.paused) push('paused');
  if (g.offDispatch) push('off:shir_dispatch');
  if (g.offPacer) push('off:d_pacer');
  if (g.noContactDay) push('no-contact-day');
  if (g.window && !g.window.open) push('window', g.window.why || '');
  if (g.hold) push('hold');
  if (g.stopped) push('stopped', g.stopped.by ? 'ע״י ' + g.stopped.by : '');
  if (g.planNoCalls) push('plan');
  if (g.capReached) push('daily-cap');
  if (g.eventPassed) push('event-passed');
  if (!g.planNoCalls && !g.eventPassed) {
    if (!g.queued) push(g.capped ? 'all-capped' : 'empty');
    else if (!g.remaining) push('done-today');
    else if (g.capacityLeft === 0 && g.window && g.window.open) push('no-capacity');
  }
  return out;
}

export const roundConfirmWord = token => String(token || '').slice(0, 8);

/* guests of one event a new round may re-queue: no definite RSVP, Israeli mobile */
export function eligibleRoundIds(raw, token) {
  return (((raw && raw.guests && raw.guests.values) || [])).filter(g => String((g || [])[28] || '').trim() === token && String(g[2] || '').trim())
    .filter(g => !['מגיע', 'לא מגיע'].includes(String(g[15] || '').trim()))
    .filter(g => /^9725\d{8}$/.test(String(g[4] || '').replace(/\D/g, '').replace(/^0(?=5)/, '972')))
    .map(g => String(g[2]).trim());
}

/* the round cards (pure: everything already read) */
export function roundCards({ queue = [], raw = null, today, todayRows = [], triedToday = new Set(), gates = {}, perEvent = {}, capacityLeft = 0 }) {
  const by = {};
  const card = (tok, ev = {}) => by[tok] = by[tok] || { token: tok, tok8: tok.slice(0, 8), name: ev.name || '', date: ev.date || '', plan: ev.plan || '', max_tries: ev.max_tries ?? null,
    queued: 0, capped: 0, remaining_today: 0, dialed_today: 0, answered_today: 0, cost_today: 0, outcomes_today: {}, plan_no_calls: false };
  for (const g of queue) {
    const c = card(g.token, { name: g.event_name || g.client_name, date: g.event_date, plan: g.plan, max_tries: g.max_tries });
    if (g.capped) { c.capped++; continue; }
    c.queued++;
    if (!triedToday.has(g.guest_id) && !(g.event_date && g.event_date < today)) c.remaining_today++;
  }
  /* "נדרשת שיחה" rows on an event whose plan has no calls never reach the queue — show them, they are the "plan" reason */
  const evs = {}; for (const e of ((raw && raw.events && raw.events.values) || [])) { const t = String(e[1] || '').trim(); if (t) evs[t] = e; }
  for (const g of ((raw && raw.guests && raw.guests.values) || [])) {
    if (String((g || [])[21] || '').trim() !== 'נדרשת שיחה') continue;
    const t = String(g[28] || '').trim(), e = evs[t]; if (!e || String(e[27] || '').trim() === 'כן') continue;
    const plan = planKeyOf(e); if (planMaxCallTries(plan) > 0) continue;
    const c = card(t, { name: String(e[34] || e[2] || '').trim(), date: String(e[6] || '').trim(), plan, max_tries: 0 }); c.plan_no_calls = true; c.queued++;
  }
  for (const r of todayRows) {
    if (r.kind !== 'guest' || !r.token) continue;
    const c = by[r.token] || card(r.token, { name: r.event });
    c.dialed_today++; if (r.duration_s > 0 && !['voicemail', 'no_answer', 'failed'].includes(r.outcome)) c.answered_today++;
    c.cost_today = r2(c.cost_today + r.cost.total); c.outcomes_today[r.outcome] = (c.outcomes_today[r.outcome] || 0) + 1;
  }
  return Object.values(by).map(c => {
    const pe = perEvent[c.token] || {};
    const why = whyNotDialing({ ...gates, hold: !!pe.hold, stopped: pe.stopped || null, planNoCalls: c.plan_no_calls, eventPassed: !!(c.date && c.date < today),
      queued: c.queued, capped: c.capped, remaining: c.remaining_today, capacityLeft });
    return { ...c, stopped: pe.stopped || null, hold: !!pe.hold, extra_round: pe.round || null, will_dial: !why.length, why, confirm_word: roundConfirmWord(c.token) };
  }).sort((a, b) => (b.will_dial - a.will_dial) || (a.date || '9') .localeCompare(b.date || '9') || a.tok8.localeCompare(b.tok8));
}

/* Retell transcript_object → [{role:'agent'|'user', text}] */
export function turns(c) {
  const t = (c && c.transcript_object) || [];
  if (Array.isArray(t) && t.length) return t.map(x => ({ role: x.role === 'agent' ? 'agent' : 'user', text: String(x.content || '') })).filter(x => x.text);
  return String((c && c.transcript) || '').split('\n').map(l => { const m = /^(Agent|User|agent|user)\s*:\s*(.*)$/.exec(l.trim()); return m ? { role: /agent/i.test(m[1]) ? 'agent' : 'user', text: m[2] } : (l.trim() ? { role: 'user', text: l.trim() } : null); }).filter(Boolean);
}

/* ══ §2 handlers ═══════════════════════════════════════════════════════════ */
async function kget(env, k) { try { return env.RATE ? await env.RATE.get(k) : null; } catch { return null; } }
async function kjson(env, k) { try { return JSON.parse((await kget(env, k)) || 'null'); } catch { return null; } }
async function readCallDay(env, d, day, rate) {
  const k = day.replace(/-/g, '');
  const recs = await d.auditQuery(env, { from: k, to: k, kind: 'call', limit: 20000 }).catch(() => []);
  return (recs || []).map(x => timelineRow(x, rate)).filter(r => r.day === day);
}

export async function listCalls(env, d, q = {}, now = Date.now()) {
  const today = d.ilDate(new Date(now));
  const rate = telnyxRate(env);
  let to = isoOk(q.day) ? q.day : isoOk(q.to) ? q.to : today, from = isoOk(q.day) ? q.day : isoOk(q.from) ? q.from : (q.week ? addDays(to, -6) : to);
  if (to > today) to = today;
  if (from > to) from = to;
  if (addDays(from, 30) < to) from = addDays(to, -30);
  const days = dayList(from, to);
  const filter = { event: String(q.event || ''), outcome: String(q.outcome || ''), number: String(q.number || ''), agent: String(q.agent || '') };
  const cache = {};
  const all = async day => (cache[day] = cache[day] || readCallDay(env, d, day, rate));
  /* attempts are counted over the whole range, so read it once (≤ 31 audit-day reads, kind-filtered) */
  const ranged = days.length <= 7 ? (await Promise.all(days.map(all))).flat() : null;
  if (ranged) assignAttempts(ranged);
  const page = await paginate({ days, readDay: async day => (await all(day)).filter(r => callMatches(r, filter)), cursor: q.cursor, limit: Math.max(1, Math.min(200, Number(q.limit) || 100)), filter: {}, maxDays: days.length <= 7 ? 7 : 4 });
  const pool = ranged ? ranged.filter(r => callMatches(r, filter)) : page.rows;
  const counts = {}; for (const r of pool) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const events = {}; for (const r of (ranged || page.rows)) if (r.tok8) events[r.tok8] = r.event || events[r.tok8] || '';
  return { ok: true, from, to, today, filter, items: page.rows, cursor: page.cursor, partial: !!page.partial, outcomes: OUTCOMES, counts,
    events: Object.entries(events).map(([tok8, name]) => ({ tok8, name })), costs: callCostRollup(pool, { rate }), attempt_basis: ranged ? 'range' : 'none', window: d.callWindowState(new Date(now)) };
}

export async function getCallDetail(env, d, { id, day } = {}) {
  id = String(id || '');
  if (!/^call_[A-Za-z0-9]{6,}$/.test(id)) return { status: 400, body: { ok: false, error: 'bad-id' } };
  const [c, meta] = await Promise.all([env.RETELL_KEY && d.retellApi ? d.retellApi(env, '/v2/get-call/' + id).catch(() => null) : null, kjson(env, 'recmeta:' + id)]);
  let row = null;
  const days = isoOk(day) ? [day] : meta && meta.at ? [ilDayOf(Date.parse(meta.at))] : c && c.start_timestamp ? [ilDayOf(c.start_timestamp)] : [];
  for (const dd of days) {
    const k = dd.replace(/-/g, '');
    const recs = await d.auditQuery(env, { from: k, to: k, kind: 'call', limit: 20000 }).catch(() => []);
    const hit = (recs || []).find(x => String((x.data || {}).call_id || '') === id);
    if (hit) { row = { rec: hit, row: timelineRow(hit, telnyxRate(env)) }; break; }
  }
  if (!c && !row && !meta) return { status: 404, body: { ok: false, error: 'not-found' } };
  const ca = (c && c.call_analysis) || {}, cad = ca.custom_analysis_data || {};
  const kept = !!(meta && meta.bytes > 0);
  const expires = Date.now() + 86400e3;
  const rec = kept ? { url: await recordingLink(env, id, 1), expires_at: new Date(expires).toISOString(), name: meta.name, mime: meta.mime, bytes: meta.bytes, source: 'kept' } : null;
  const transcript = c ? turns(c) : row ? turns({ transcript: row.rec.detail }) : [];
  const base = row ? row.row : { id, ts: c && c.start_timestamp, at: c && c.start_timestamp ? new Date(c.start_timestamp).toISOString() : (meta && meta.at) || null, agent: (meta && meta.agent) || '', phone: String((c && c.to_number) || (meta && meta.phone) || '').replace('+', ''),
    token: String(((c && c.metadata) || {}).token || (meta && meta.token) || ''), duration_s: c && c.end_timestamp ? Math.round((c.end_timestamp - c.start_timestamp) / 1000) : Math.round(((meta && meta.duration_ms) || 0) / 1000), disconnection: (c && c.disconnection_reason) || '' };
  if (!row) { base.outcome = mapOutcome({ outcome: cad.outcome || (meta && meta.outcome) || '', disconnection: base.disconnection, duration_s: base.duration_s }); base.outcome_he = OUTCOMES[base.outcome]; }
  return { status: 200, body: { ok: true, call: base, transcript, transcript_source: c ? 'retell' : row ? 'audit' : 'none',
    summary: String(ca.call_summary || (row && row.row.summary) || ''), sentiment: String(ca.user_sentiment || (row && row.row.sentiment) || ''),
    analysis: { outcome: cad.outcome ?? null, party_size: cad.party_size ?? null, got_answer: cad.got_answer ?? null, needs_review: cad.needs_review ?? null, agent_quality: cad.agent_quality ?? null, quality_note: cad.quality_note || '' },
    recording: rec, recording_missing: kept ? null : (meta ? 'not-kept' : 'no-metadata'), sources: { retell: !!c, audit: !!row, recmeta: !!meta } } };
}

async function gatesNow(env, d, now) {
  const today = d.ilDate(new Date(now));
  const [paused, offDispatch, offPacer, dialsDay] = await Promise.all([d.sendingPaused(env).catch(() => false), isOff(env, 'shir_dispatch'), isOff(env, 'd_pacer'), kget(env, 'dials:day:' + today)]);
  const win = d.callWindowState(new Date(now));
  const cap = dailyCallCap(env), dialed = Number(dialsDay) || 0;
  return { today, gates: { notConfigured: !env.RETELL_KEY || !env.SHIR_FROM, paused: !!paused, offDispatch: !!offDispatch, offPacer: !!offPacer, noContactDay: !!(d.isNoContactDay && d.isNoContactDay(today)), window: win, capReached: !!(cap && dialed >= cap) },
    cap: { daily: cap || null, dialed_counted: cap ? dialed : null } };
}

export async function buildCallRounds(env, d, now = Date.now(), { ticksLeft = 0 } = {}) {
  const { today, gates, cap } = await gatesNow(env, d, now);
  const raw = await d.snapshotCached(env).catch(() => null);
  const queue = raw ? (d.buildCallQueue(raw).queue || []) : [];
  const todayRows = await readCallDay(env, d, today, telnyxRate(env));
  const triedToday = new Set();
  try { const l = await env.RATE.list({ prefix: 'shirtry:', limit: 1000 }); for (const k of (l && l.keys) || []) { const m = /^shirtry:(.+):(\d{4}-\d{2}-\d{2})$/.exec(k.name); if (m && m[2] === today) triedToday.add(m[1]); } } catch {}
  const toks = [...new Set(queue.map(g => g.token))];
  const perEvent = {};
  await Promise.all(toks.map(async t => { const [hold, stop, round] = await Promise.all([kget(env, 'hold:' + t), kjson(env, 'callstop:' + t), kjson(env, 'callround:' + t)]); perEvent[t] = { hold: !!hold, stopped: stop, round }; }));
  const paceTotal = ticksLeft * (d.PACE_CALLS || 6);
  const capacityLeft = cap.daily ? Math.max(0, Math.min(paceTotal, cap.daily - (cap.dialed_counted || 0))) : paceTotal;
  const events = roundCards({ queue, raw, today, todayRows, triedToday, gates, perEvent, capacityLeft });
  const global = whyNotDialing({ ...gates, queued: 1, remaining: 1, capacityLeft }).filter(w => !['empty', 'done-today', 'all-capped'].includes(w.code));
  return { ok: true, today, at: new Date(now).toISOString(), source: raw ? 'snapshot' : 'snapshot-unreadable', window: gates.window, capacity_left_today: capacityLeft, ticks_left: ticksLeft, pace_per_tick: d.PACE_CALLS || 6, daily_cap: cap,
    global_why: global, totals: { queued: events.reduce((n, e) => n + e.queued, 0), remaining_today: events.reduce((n, e) => n + e.remaining_today, 0), dialed_today: todayRows.filter(r => r.kind === 'guest').length, lead_calls_today: todayRows.filter(r => r.kind === 'lead').length },
    events };
}

export async function callRound(env, d, b = {}, now = Date.now()) {
  const tok = String(b.token || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(tok)) return { status: 400, body: { ok: false, error: 'bad-token' } };
  const action = String(b.action || '');
  if (!['start', 'stop'].includes(action)) return { status: 400, body: { ok: false, error: 'bad-action', actions: ['start', 'stop'] } };
  const word = roundConfirmWord(tok);
  const before = await kjson(env, 'callstop:' + tok);
  const raw = action === 'start' && b.extra ? await d.snapshotCached(env).catch(() => null) : null;
  const ids = raw ? eligibleRoundIds(raw, tok) : [];
  const preview = { ok: true, applied: false, token: tok, action, stopped_now: !!before, confirm_required: word, extra_round_guests: b.extra ? ids.length : null,
    he: action === 'stop' ? 'שיר תפסיק לחייג לאורחי האירוע הזה עד שיופעל שוב. שיחות שכבר רצות לא נקטעות.' : 'שיר תחזור לחייג לאורחי האירוע בחלון השיחות' + (b.extra ? ` · סבב נוסף: ${ids.length} אורחים יחזרו לתור היום מ-09:00` : '') };
  if (String(b.confirm || '') !== word) return { status: 200, body: preview };
  const who = String(b.who || 'admin').slice(0, 40), reason = String(b.reason || '').slice(0, 200);
  if (action === 'stop') await env.RATE.put('callstop:' + tok, JSON.stringify({ at: new Date(now).toISOString(), by: who, reason }), { expirationTtl: 60 * 86400 });
  else {
    await env.RATE.delete('callstop:' + tok);
    if (b.extra && ids.length) await env.RATE.put('callround:' + tok, JSON.stringify({ at: d.ilDate(new Date(now)), guest_ids: ids.slice(0, 900), note: reason || 'סבב מהמרכז', set_at: new Date(now).toISOString() }), { expirationTtl: 60 * 86400 });
  }
  const msg = `${action === 'stop' ? '⏹️ סבב שיחות נעצר' : '▶️ סבב שיחות הופעל'} · אירוע ${word}${b.extra && action === 'start' ? ` · סבב נוסף ${ids.length}` : ''}${reason ? ' · ' + reason : ''}`;
  await d.auditRecord(env, { kind: 'admin', area: 'מרכז בקרה', action: msg, ok: true, review: action === 'stop', token: tok, data: { action, before, who, reason, extra: b.extra ? ids.length : null } }).catch(() => {});
  const chg = await recordChange(env, { kind: 'hold', who, summary_he: msg.replace(/^\S+\s/, ''), details: { token: word, action, before_stopped: !!before, who, reason, extra: b.extra ? ids.length : null }, revert: { possible: false, how: 'none' } }, now);
  return { status: 200, body: { ...preview, applied: true, stopped_now: action === 'stop', change_id: chg ? chg.id : null } };
}

export async function manualCalls(env, d, now = Date.now()) {
  const today = d.ilDate(new Date(now));
  const raw = await d.snapshotCached(env).catch(() => null);
  const queue = raw ? (d.buildCallQueue(raw).queue || []) : [];
  const notes = await d.kvPrefix(env, 'mcnote:').catch(() => ({}));
  const items = queue.map(g => { let n = null; try { n = JSON.parse(notes[g.guest_id] || 'null'); } catch {}
    return { guest_id: g.guest_id, name: g.name, phone: String(g.phone || '').replace(/\D/g, ''), party: g.party, rsvp: g.rsvp, last_answer: g.last_answer, tries: g.tries, max_tries: g.max_tries, capped: !!g.capped,
      token: g.token, tok8: String(g.token || '').slice(0, 8), event: g.event_name || g.client_name, occasion: g.occasion, event_date: g.event_date, venue: [g.venue_name, g.venue_city].filter(Boolean).join(', '), reception_time: g.reception_time,
      past: !!(g.event_date && g.event_date < today), note: n }; });
  return { ok: true, today, source: raw ? 'snapshot' : 'snapshot-unreadable', outcomes: MANUAL_OUTCOMES, open: items.filter(x => !x.capped && !x.past).length, items };
}

export async function manualCallsPost(env, d, b = {}, now = Date.now()) {
  const gid = String(b.guest_id || '').trim();
  if (!/^G-[\w-]{2,60}$/.test(gid)) return { status: 400, body: { ok: false, error: 'bad-guest-id' } };
  if (b.action === 'note') {
    const note = String(b.note || '').trim().slice(0, 500);
    if (!note) { await env.RATE.delete('mcnote:' + gid); return { status: 200, body: { ok: true, guest_id: gid, note: null } }; }
    const rec = { text: note, at: new Date(now).toISOString(), by: String(b.who || 'admin').slice(0, 40) };
    await env.RATE.put('mcnote:' + gid, JSON.stringify(rec), { expirationTtl: 120 * 86400 });
    return { status: 200, body: { ok: true, guest_id: gid, note: rec } };
  }
  if (b.action === 'done') {
    const outcome = String(b.outcome || '');
    if (!MANUAL_OUTCOMES.includes(outcome)) return { status: 400, body: { ok: false, error: 'bad-outcome', outcomes: MANUAL_OUTCOMES } };
    if (!d.markCallResult) return { status: 503, body: { ok: false, error: 'writer-unavailable' } };
    const r = await d.markCallResult(env, gid, outcome, b.tries).catch(() => null);
    if (!r || !r.ok) return { status: 502, body: { ok: false, error: 'writer-failed' } };
    await d.auditRecord(env, { kind: 'admin', area: 'שיחות', action: `שיחה ידנית סומנה: ${outcome}`, ok: true, data: { guest_id: gid, outcome, tries: r.tries, who: String(b.who || 'admin').slice(0, 40) } }).catch(() => {});
    return { status: 200, body: { ok: true, guest_id: gid, ...r } };
  }
  return { status: 400, body: { ok: false, error: 'bad-action', actions: ['note', 'done'] } };
}

const VOICE_KEYS = ['voice_id', 'voice_model', 'voice_temperature', 'voice_speed', 'volume', 'language', 'responsiveness', 'interruption_sensitivity', 'enable_backchannel', 'backchannel_frequency', 'ambient_sound', 'ambient_sound_volume', 'max_call_duration_ms', 'end_call_after_silence_ms', 'begin_message_delay_ms', 'voicemail_option', 'webhook_url'];
export async function shirAdmin(env, d, agentKey = 'shir_out') {
  const spec = (d.voiceAgents || {})[agentKey];
  if (!spec) return { status: 400, body: { ok: false, error: 'unknown-agent', agents: Object.keys(d.voiceAgents || {}) } };
  const meta = (await kjson(env, 'vpmeta:' + agentKey)) || { head: 0, list: [] };
  const base = { ok: true, agent: agentKey, name: spec.name, agent_id: spec.agent, head: meta.head || 0, history: (meta.list || []).slice(-20).reverse(), edit_via: '/api/voice-prompt' };
  if (!env.RETELL_KEY || !d.retellApi) return { status: 200, body: { ...base, retell: false } };
  const agent = await d.retellApi(env, '/get-agent/' + spec.agent).catch(() => null);
  const llmId = agent && agent.response_engine && agent.response_engine.llm_id;
  const llm = llmId ? await d.retellApi(env, '/get-retell-llm/' + llmId).catch(() => null) : null;
  const prompt = String((llm && llm.general_prompt) || '');
  const headRec = meta.head ? await kjson(env, `vp:${agentKey}:${meta.head}`) : null;
  return { status: 200, body: { ...base, retell: !!agent, llm_id: llmId || null, model: (llm && llm.model) || null, begin_message: llm ? (llm.begin_message ?? null) : null,
    prompt, prompt_chars: prompt.length, live_matches_head: headRec ? headRec.prompt === prompt : null,
    voice: agent ? Object.fromEntries(VOICE_KEYS.filter(k => agent[k] !== undefined).map(k => [k, agent[k]])) : null,
    analysis_fields: agent && Array.isArray(agent.post_call_analysis_data) ? agent.post_call_analysis_data.map(x => x.name) : [] } };
}

/* finance screen hook: ₪ call costs for a date range (ops.js re-exports) */
export async function buildCallCosts(env, d, { from, to } = {}, now = Date.now()) {
  const today = d.ilDate(new Date(now));
  let t = isoOk(to) && to <= today ? to : today, f = isoOk(from) ? from : addDays(t, -6);
  if (f > t) f = t;
  if (addDays(f, 62) < t) f = addDays(t, -62);
  const rate = telnyxRate(env);
  const rows = (await Promise.all(dayList(f, t).map(day => readCallDay(env, d, day, rate)))).flat();
  return { ok: true, from: f, to: t, ...callCostRollup(rows, { rate }) };
}
