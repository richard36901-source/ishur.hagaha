/* ============================================================================
   ishur.io · calls-log.js · every call ever, one page (Richard 02/11, F.4+F.5)
   ----------------------------------------------------------------------------
   POST /api/calls-log — READ-ONLY. This module performs no KV put/delete and
   keeps no cache. Its reads:
     · audit.query, ONE IL day per read (a multi-day query silently drops days
       on a busy log, seen live 01/11), kind 'call' (written by the Retell
       webhook, index.js:2165)
     · the 'לוג שיחות' sheet tab (sheetlogs.js:67, CALL_COLS) through the Make
       proxy, read only, and only for days before the audit log began (22/10)
     · the guest call queue from the sheet snapshot (fetchSnapshot: an HTTP
       read of the Make hook, no KV) and Noa's lead queue (lq:, KV list/get)

   Body: { admin_key, from, to (YYYY-MM-DD, IL), cursor, limit (≤100; csv ≤2000),
           agent ('שיר'|'נועה'), kind ('guest'|'lead'|'inbound'), state
           ('done'|'noanswer'|'failed'|'review'), review (true), event, outcome,
           q (free text), format ('json'|'csv'), queue (true → people waiting),
           count_day ('YYYY-MM-DD' → {calls, review} for that one day only),
           sheet (true → include the sheet tab for days before 22/10) }
   Cursor: "<YYYY-MM-DD>|<ts>|<id>" — continue inside that day below (ts,id),
   then older days. Each request scans at most MAX_DAYS days, so one request
   never reads the whole log; a short page with a cursor means "more below".
   ========================================================================== */

export const AUDIT_START = '2026-10-22';
export const MAX_DAYS = 4;
const OUR_LINES = { '972555074446': 'שיר', '972555077733': 'נועה' };

function ilDay(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts)); }
export function dayList(from, to) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return out;
  for (let d = Date.parse(to + 'T12:00:00Z'); out.length < 400; d -= 864e5) {
    const s = new Date(d).toISOString().slice(0, 10);
    if (s < from) break;
    out.push(s);
  }
  return out;   /* newest first */
}

/* ── one audit 'call' record → one row ─────────────────────────────────── */
export function rowFromAudit(r) {
  const d = r.data || {};
  const ts = Number(r.ts) || Date.parse(r.at) || 0;
  const phone = String(r.phone || '');
  const agent = String(d.agent || r.area || '') || 'שיר';
  /* the webhook stores to_number as the phone (index.js:2165), so an inbound
     call records OUR line, not the caller's — mark it inbound, caller unknown */
  const inbound = !!OUR_LINES[phone];
  const kind = inbound ? 'inbound' : agent === 'נועה' ? 'lead' : 'guest';
  const outcome = d.outcome === '__keep__' ? '' : String(d.outcome || '');
  const dur = Number(d.duration_s) || 0;
  const disc = String(d.disconnection || '');
  return {
    id: String(d.call_id || r.id || ''), ts, day: ilDay(ts), src: 'audit',
    agent, kind, name: String(d.guest_name || ''), phone: inbound ? '' : phone,
    event: String(d.event_name || (r.event && r.event.event) || ''), event_date: String((r.event && r.event.date) || ''),
    token: String(r.token || ''), guest_id: String(d.guest_id || ''),
    outcome, answer: String(d.answer || ''), duration_s: dur, disconnection: disc,
    cost: Number(r.cost) || 0, recording: String(d.recording || ''), recording_name: String(d.recording_name || ''),
    summary: String(d.summary || ''), sentiment: String(d.sentiment || ''), transcript: String(r.detail || ''),
    ...classifyCall({ outcome, answer: String(d.answer || ''), dur, disc, sentiment: String(d.sentiment || '') }),
  };
}

/* the 'לוג שיחות' tab row (CALL_COLS: at agent dir phone name kind token status dur outcome summary sentiment cost reason id) */
export function rowFromSheet(cells) {
  const c = i => String((cells || [])[i] ?? '').trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})[ ,]+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(c(0));
  if (!m) return null;
  /* ilTime() writes Israel wall time; +02:00 is right until 2026-10-25 (DST end) and ±1h before it */
  const ts = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || '00'}+03:00`);
  const dir = c(2), dur = Number(c(8)) || 0, outcome = c(9);
  const inbound = /נכנסת/.test(dir);
  return {
    id: c(14) || 'sheet-' + ts + '-' + c(3), ts, day: `${m[3]}-${m[2]}-${m[1]}`, src: 'sheet',
    agent: c(1) || 'שיר', kind: inbound ? 'inbound' : /ליד|לקוח/.test(c(5)) ? 'lead' : 'guest',
    name: c(4), phone: c(3).replace(/\D/g, ''), event: '', event_date: '', token: c(6), guest_id: '',
    outcome: /^(מגיע|לא מגיע|מתלבט)$/.test(outcome) ? outcome : '', answer: outcome, duration_s: dur, disconnection: c(13),
    cost: Number(c(12)) || 0, recording: '', recording_name: '', summary: c(10), sentiment: c(11), transcript: '',
    ...classifyCall({ outcome, answer: outcome, dur, disc: c(13), sentiment: c(11) }),
  };
}

/* done / noanswer / failed, and whether a human should look.
   "לבדיקה" is derived: Retell's needs_review flag is not in the audit record.
   Rule: the call connected (dur > 0) but ended with no usable answer, or it
   failed on our/the carrier's side, or the caller sounded negative. */
export function classifyCall({ outcome, answer, dur, disc, sentiment }) {
  let state;
  if (/^(error|dial_failed|registered_call_timeout|concurrency_limit|scam_detected|invalid_destination)/.test(disc)) state = 'failed';
  else if (disc === 'voicemail_reached' || /^dial_(no_answer|busy)$/.test(disc) || (!dur && !outcome)) state = 'noanswer';
  else state = 'done';
  const definite = /^(מגיע|לא מגיע|מתלבט)$/.test(outcome) || /לחייג שוב|לא להתקשר|לא ענה/.test(answer);
  const review = state === 'failed' || (state === 'done' && !definite) || /negative/i.test(sentiment || '');
  return { state, review, voicemail: disc === 'voicemail_reached' };
}

export function matches(row, f = {}) {
  if (f.agent && row.agent !== f.agent) return false;
  if (f.kind && row.kind !== f.kind) return false;
  if (f.state === 'review' ? !row.review : (f.state && row.state !== f.state)) return false;
  if (f.review && !row.review) return false;
  if (f.event && row.event !== f.event && !String(row.token).startsWith(f.event)) return false;
  if (f.outcome && row.outcome !== f.outcome && row.answer !== f.outcome) return false;
  if (f.q) { const n = String(f.q).toLowerCase(); if ((row.name + ' ' + row.phone + ' ' + row.event + ' ' + row.answer).toLowerCase().indexOf(n) < 0) return false; }
  return true;
}

const cmpDesc = (a, b) => (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
export function encodeCursor(day, ts, id) { return `${day}|${ts}|${id}`; }
export function decodeCursor(c) {
  const m = /^(\d{4}-\d{2}-\d{2})\|(\d*)\|(.*)$/.exec(String(c || ''));
  return m ? { day: m[1], ts: m[2] === '' ? Infinity : Number(m[2]), id: m[3] } : null;
}

/* ── the paginator. Pure apart from readDay(day) → Promise<rows>. ─────────
   days: newest first. Returns { rows, cursor|null, scanned:[days], day_counts } */
export async function paginate({ days, readDay, cursor, limit = 100, filter = {}, maxDays = MAX_DAYS }) {
  const cur = decodeCursor(cursor);
  let i = cur ? days.indexOf(cur.day) : 0;
  if (cur && i < 0) i = days.findIndex(d => d < cur.day);   /* cursor day outside the range: resume below it */
  if (i < 0) return { rows: [], cursor: null, scanned: [], day_counts: {} };
  const rows = [], scanned = [], dayCounts = {};
  let read = 0;
  for (; i < days.length; i++) {
    if (read >= maxDays) return { rows, cursor: encodeCursor(days[i], '', ''), scanned, day_counts: dayCounts, partial: true };
    const day = days[i];
    const all = (await readDay(day)).filter(r => r && r.day === day).sort(cmpDesc);
    read++;
    const fresh = cur && day === cur.day && cur.ts !== Infinity;
    const list = fresh ? all.filter(r => r.ts < cur.ts || (r.ts === cur.ts && r.id < cur.id)) : all;
    const hit = list.filter(r => matches(r, filter));
    if (!fresh) dayCounts[day] = { calls: hit.length, review: hit.filter(r => r.review).length };
    for (let k = 0; k < hit.length; k++) {
      rows.push(hit[k]);
      if (rows.length >= limit) {
        const last = hit[k];
        const more = k < hit.length - 1 || i < days.length - 1;
        if (k === hit.length - 1) scanned.push(day);
        return { rows, cursor: more ? (k < hit.length - 1 ? encodeCursor(day, last.ts, last.id) : encodeCursor(days[i + 1], '', '')) : null, scanned, day_counts: dayCounts };
      }
    }
    scanned.push(day);
  }
  return { rows, cursor: null, scanned, day_counts: dayCounts };
}

/* ── CSV (Excel-safe: BOM, quoted, Hebrew headers) ─────────────────────── */
const CSV_COLS = [['day', 'תאריך'], ['ts', 'שעה'], ['agent', 'סוכנת'], ['kind', 'סוג'], ['name', 'שם'], ['phone', 'טלפון'], ['event', 'אירוע'],
  ['state', 'מצב'], ['review', 'לבדיקה'], ['outcome', 'תוצאה'], ['answer', 'תשובה'], ['duration_s', 'משך (שנ\')'], ['cost', 'עלות ₪'],
  ['disconnection', 'סיבת ניתוק'], ['summary', 'סיכום'], ['id', 'מזהה שיחה'], ['src', 'מקור']];
const KIND_HE = { guest: 'אורח', lead: 'ליד', inbound: 'נכנסת' }, STATE_HE = { done: 'בוצע', noanswer: 'לא ענה', failed: 'נכשל' };
export function toCsv(rows, header = true) {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"';
  const lines = header ? [CSV_COLS.map(c => esc(c[1])).join(',')] : [];
  for (const r of rows) lines.push(CSV_COLS.map(([k]) => {
    if (k === 'ts') return esc(new Date(r.ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }));
    if (k === 'kind') return esc(KIND_HE[r.kind] || r.kind);
    if (k === 'state') return esc(STATE_HE[r.state] || r.state);
    if (k === 'review') return esc(r.review ? 'כן' : '');
    if (k === 'phone') return esc(r.phone ? '0' + String(r.phone).replace(/^972/, '') : '');
    return esc(r[k]);
  }).join(','));
  return (header ? '﻿' : '') + lines.join('\r\n');
}

/* ── the next attempt for a waiting guest (dialer rules: index.js:2242-2283) ── */
export function nextAttempt(q, { now, today, callWindowState, lastCallDay }) {
  if (q.state === 'capped') return { at: null, he: 'מוצה' };
  if (q.event_date && String(q.event_date).slice(0, 10) < today) return { at: null, he: 'לא יחויג — האירוע עבר' };
  const triedToday = lastCallDay === today;               /* shirtry:<id>:<day> → one dial per guest per day */
  let t = now;
  if (triedToday) { const z = Date.parse(today + 'T22:30:00Z'); t = Math.max(t, z); }   /* after IL midnight */
  for (let k = 0; k < 7 * 24 * 6; k++, t += 10 * 60e3) {
    if (callWindowState(new Date(t)).open) return { at: t, he: t === now ? 'בפעימה הבאה (עד 10 דק׳)' : '' };
  }
  return { at: null, he: '—' };
}

/* ── the route ─────────────────────────────────────────────────────────────
   deps: { isAdmin, okJson, deny, cors, auditQuery(env,q), ilDate(), callWindowState(d),
           fetchSnapshot(env), buildCallQueue(raw), kvPrefix(env,p), readTabAll(env,tab) } */
export async function handleCallsLog(request, env, origin, deps) {
  let b = {}; try { b = await request.json(); } catch { return deps.deny(400, 'bad-json', origin); }
  if (!deps.isAdmin(env, b.admin_key)) return deps.deny(403, 'bad-admin-key', origin);
  const today = deps.ilDate();
  const isoOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const to = isoOk(b.to) && b.to <= today ? b.to : today;
  const from = isoOk(b.from) ? b.from : new Date(Date.parse(to + 'T12:00:00Z') - 6 * 864e5).toISOString().slice(0, 10);
  const filter = { agent: b.agent || '', kind: b.kind || '', state: b.state || '', review: b.review === true, event: String(b.event || ''), outcome: String(b.outcome || ''), q: String(b.q || '').slice(0, 60) };
  const csv = b.format === 'csv';
  const limit = Math.max(1, Math.min(csv ? 2000 : 100, Number(b.limit) || (csv ? 2000 : 100)));

  let sheetRows = null;
  const readDay = async day => {
    if (day >= AUDIT_START) {
      const k = day.replace(/-/g, '');
      const recs = await deps.auditQuery(env, { from: k, to: k, kind: 'call', limit: 20000 });
      return recs.map(rowFromAudit);
    }
    if (!b.sheet || !deps.readTabAll) return [];
    if (!sheetRows) { const t = await deps.readTabAll(env, 'calls').catch(() => null); sheetRows = ((t && t.rows) || []).map(rowFromSheet).filter(Boolean); }
    return sheetRows.filter(r => r.day === day);
  };

  /* header counts are fetched one day per request by the page, in parallel */
  if (isoOk(b.count_day)) {
    const rows = (await readDay(b.count_day)).filter(r => r.day === b.count_day && matches(r, filter));
    return deps.okJson({ ok: true, day: b.count_day, calls: rows.length, review: rows.filter(r => r.review).length, cost: Math.round(rows.reduce((n, r) => n + r.cost, 0) * 100) / 100 }, origin);
  }

  const days = dayList(from, to);
  const page = await paginate({ days, readDay, cursor: b.cursor, limit, filter, maxDays: csv ? 7 : MAX_DAYS });

  if (csv) {
    return new Response(toCsv(page.rows, !b.cursor), { headers: { ...(deps.cors ? deps.cors(origin) : {}), 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ishur-calls-${from}_${to}.csv"`, 'X-Next-Cursor': page.cursor || '', 'Access-Control-Expose-Headers': 'X-Next-Cursor' } });
  }

  let queue;
  if (b.queue) {
    queue = [];
    const now = Date.now();
    const lastDay = {}; for (const r of page.rows) if (r.guest_id && !lastDay[r.guest_id]) lastDay[r.guest_id] = r.day;
    try {
      const raw = await deps.fetchSnapshot(env);
      const q = raw ? (deps.buildCallQueue(raw).queue || []) : [];
      for (const g of q) {
        const st = g.capped ? 'capped' : (g.event_date && String(g.event_date).slice(0, 10) < today ? 'past' : 'waiting');
        const na = nextAttempt({ state: g.capped ? 'capped' : 'waiting', event_date: g.event_date }, { now, today, callWindowState: deps.callWindowState, lastCallDay: lastDay[g.guest_id] });
        queue.push({ kind: 'guest', agent: 'שיר', name: g.name, phone: String(g.phone || '').replace(/\D/g, ''), guest_id: g.guest_id, token: g.token, event: g.event_name || g.client_name, event_date: g.event_date,
          tries: g.tries, max_tries: g.max_tries, state: st, last_answer: g.last_answer || '', next_at: na.at, next_he: na.he });
      }
    } catch {}
    try {
      const lq = await deps.kvPrefix(env, 'lq:');
      for (const [phone, v] of Object.entries(lq)) { let o = {}; try { o = JSON.parse(v) || {}; } catch {} queue.push({ kind: 'lead', agent: 'נועה', name: o.name || '', phone, event: o.occ || '', state: 'waiting', tries: null, max_tries: null, next_at: null, next_he: 'לפי תור נועה' }); }
    } catch {}
  }
  return deps.okJson({ ok: true, from, to, filter, rows: page.rows, cursor: page.cursor, partial: !!page.partial, scanned: page.scanned, day_counts: page.day_counts, days,
    window: deps.callWindowState(), audit_start: AUDIT_START, queue, generated_at: new Date().toISOString() }, origin);
}
