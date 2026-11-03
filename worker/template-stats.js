/* ============================================================================
   ishur.io · template-stats.js · which wording works ("ביצועי תבניות")
   ----------------------------------------------------------------------------
   POST /api/template-stats {admin_key, days} → one row per template (and per
   message type when the same template serves two, e.g. hazmana_ishur_v2 as
   the invitation AND as the reminder): sends, delivered, read, replies within
   24h/72h, button-equivalent RSVP replies, opt-outs ("הסר"/"טעות"), cost,
   reply rate with a 95% Wilson interval, and a plain-Hebrew recommendation:
   "החלף" / "שמור" / "מעט נתונים". The rule is RULE below; the spec is
   docs/SPEC-ab-testing.md §2-§3.

   Data: the audit log only (audit.js) — no new sends, no new tracking.
     wa_out    data.template, data.wamid, data.phone_id, ok, phone, token, area
     wa_status data.wamid, data.status, data.wave, cost, detail ("<code> ...")
     wa_in     phone, area, detail (parsed reply text; the raw words for
               הסר/טעות — index.js wa_in writer, `body = textOf(parsed) || rawIn`)

   Structure, so the maths is testable without a Worker:
     compactRecord()        audit record → small row (or null)
     computeTemplateStats() rows → stats            (pure)
     wilson()/recommend()   (pure)
     loadRows()             the I/O: per-day audit reads, closed days cached
     handleTemplateStats()  the route; every dependency injectable
   ========================================================================== */

import { parseInboundReply } from './whatsapp.js';

/* ── the rule, in one place (docs/SPEC-ab-testing.md §3) ──────────────────── */
export const RULE = {
  MIN_N: 100,              // fewer mature delivered sends than this → "מעט נתונים"
  OPTOUT_MAX: 0.02,        // (הסר + טעות) / delivered above this → "החלף"
  DELIVERY_MIN: 0.85,      // delivered / (accepted − cap failures) below this → "החלף"
  REPLY_WINDOW_H: 72,      // a reply counts if it comes ≤72h after the send…
  SHORT_WINDOW_H: 24,      // …and is reported separately at ≤24h
  Z: 1.96,                 // 95% Wilson interval
  /* "significantly worse than the best template of the same message type":
     this template's upper bound is below the best one's lower bound. */
  CAP_CODES: ['131048', '130429'],   // the NUMBER's cap, not the copy's fault
};

/* message types and what "success" means for each */
export const MSG_TYPES = {
  invite:    { he: 'הזמנה',          goal: 'reply' },
  reminder:  { he: 'תזכורת',         goal: 'reply' },
  extra:     { he: 'שליחה נוספת',    goal: 'reply' },
  resend:    { he: 'שליחה חוזרת',    goal: 'reply' },
  daybefore: { he: 'יום לפני',       goal: 'info' },
  eventday:  { he: 'יום האירוע',     goal: 'info' },
  table:     { he: 'שולחן',          goal: 'info' },
  thanks:    { he: 'תודה',           goal: 'info' },
  cancel:    { he: 'ביטול',          goal: 'info' },
  postpone:  { he: 'דחייה',          goal: 'info' },
  client:    { he: 'ללקוח / ליד',    goal: 'reply' },
  other:     { he: 'אחר',            goal: 'reply' },
};

/* the template family, without the _f / _n / _u / _ab<n> suffixes */
export function baseName(t) {
  return String(t || '').replace(/_ab\d+$/, '').replace(/_(f|n)$/, '');
}

/* template + wave → message type. The wave comes from the wa_status rows
   (wamid: mapping, index.js sendWave / noteGuestSend); a send whose status
   never carried a wave is treated as wave 1 for the hazmana family. */
export function msgTypeOf(template, wave) {
  const b = baseName(template);
  const w = String(wave == null ? '' : wave);
  if (/^hazmana_ishur/.test(b) || /^ishur_c_[0-9a-f]{8}_\d+$/.test(b)) {
    if (w === '2') return 'reminder';
    if (w === '3') return 'extra';
    if (w === 'resend') return 'resend';
    return 'invite';
  }
  if (/^ishur_hazmana_shuv/.test(b)) return 'resend';
  if (/^ishur_yom_lifnei/.test(b)) return 'daybefore';
  if (/^ishur_yom_haerua/.test(b) || w === 'eventday') return 'eventday';
  if (/^ishur_shulchan/.test(b)) return 'table';
  if (/^ishur_toda_orach/.test(b)) return 'thanks';
  if (/^ishur_bitul/.test(b)) return 'cancel';
  if (/^ishur_dchiya/.test(b)) return 'postpone';
  if (/^ishur_(lo_siyem|tzikoret|doch|syum|tashlum|heshbonit|shidrug|kod)/.test(b)) return 'client';
  return 'other';
}

/* ── Wilson score interval ─────────────────────────────────────────────────── */
export function wilson(k, n, z = RULE.Z) {
  if (!n) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
  return { p, lo: Math.max(0, mid - half), hi: Math.min(1, mid + half) };
}

/* ── one inbound text → what it means (same parser the webhook uses) ───────── */
export function classifyReply(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty' };
  /* the audit row holds textOf(parsed): "מגיע" / "לא מגיע" / "מתלבט" / a number
     for button presses, the raw words otherwise — parse it again the same way */
  const p = parseInboundReply({ type: 'text', text: { body: t } });
  if (!p) return { kind: 'empty' };
  return p;
}

const normPh = p => { const d = String(p || '').replace(/\D/g, ''); return d.startsWith('0') ? '972' + d.slice(1) : d; };

/* ── audit record → compact row ────────────────────────────────────────────
   o = out (template only), s = status, i = in. Everything else → null.      */
export function compactRecord(r) {
  if (!r || !r.kind) return null;
  const d = r.data || {};
  const ch = r.area === 'נועה' ? 'c' : 'g';
  if (r.kind === 'wa_out') {
    if (!d.template) return null;               // free text / interactive: not a template
    return { k: 'o', ts: r.ts, p: normPh(r.phone), ch, t: d.template, w: d.wamid || '', ok: !!r.ok, pid: d.phone_id || '', tok: String(r.token || '').slice(0, 8), e: r.ok ? '' : String(d.error || '').split(':')[0] };
  }
  if (r.kind === 'wa_status') {
    if (!d.wamid) return null;
    const code = d.status === 'failed' ? String(r.detail || '').split(/\s/)[0] : '';
    return { k: 's', ts: r.ts, w: d.wamid, st: d.status || '', c: code, cost: Number(r.cost) || 0, wv: d.wave == null ? '' : String(d.wave), cat: (d.pricing && d.pricing.category) || '' };
  }
  if (r.kind === 'wa_in') {
    return { k: 'i', ts: r.ts, p: normPh(r.phone), ch, x: String(r.detail || '').slice(0, 120) };
  }
  return null;
}

/* ── per-send attribution (pure) ─────────────────────────────────────────────
   rows: compact rows (any order) → one object per template send:
   { o, wave, type, delivered, read, failed, code, cost, mature24, mature72,
     replied24, replied72, rsvp ('מגיע'|'לא מגיע'|'מתלבט'|''), optout, mistake, nocall }
   An inbound belongs to the LATEST template sent to that phone on that channel
   before it (last touch), if it came within RULE.REPLY_WINDOW_H. ab.js uses the
   same function, so the dashboard and the A/B engine can never disagree. */
export function attributeSends(rows, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const H = 3600e3;
  const outs = [], byWamid = new Map(), ins = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    if (r.k === 'o') outs.push(r);
    else if (r.k === 's') { const a = byWamid.get(r.w) || []; a.push(r); byWamid.set(r.w, a); }
    else if (r.k === 'i') { const key = r.ch + r.p; const a = ins.get(key) || []; a.push(r); ins.set(key, a); }
  }
  outs.sort((a, b) => a.ts - b.ts);
  for (const a of ins.values()) a.sort((x, y) => x.ts - y.ts);
  const sendsByPhone = new Map();
  for (const o of outs) if (o.ok) { const key = o.ch + o.p; const a = sendsByPhone.get(key) || []; a.push(o); sendsByPhone.set(key, a); }
  const repliesOf = new Map();
  for (const [key, list] of ins) {
    const sends = sendsByPhone.get(key);
    if (!sends) continue;
    let j = -1;
    for (const m of list) {
      while (j + 1 < sends.length && sends[j + 1].ts <= m.ts) j++;
      if (j < 0) continue;
      const s = sends[j];
      if (m.ts - s.ts > RULE.REPLY_WINDOW_H * H) continue;
      const a = repliesOf.get(s) || []; a.push(m); repliesOf.set(s, a);
    }
  }
  const res = [];
  for (const o of outs) {
    const sts = (o.w && byWamid.get(o.w)) || [];
    const wave = (sts.find(s => s.wv) || {}).wv || '';
    const x = { o, wave, type: msgTypeOf(o.t, wave), delivered: false, read: false, failed: false, code: '', cost: 0,
      mature24: false, mature72: false, replied24: false, replied72: false, rsvp: '', optout: false, mistake: false, nocall: false };
    res.push(x);
    if (!o.ok) continue;
    const got = new Set(sts.map(s => s.st));
    x.delivered = got.has('delivered') || got.has('read');
    x.read = got.has('read');
    if (got.has('failed') && !x.delivered) { x.failed = true; x.code = (sts.find(s => s.st === 'failed') || {}).c || '?'; }
    for (const s of sts) x.cost += s.cost || 0;
    const age = now - o.ts;
    const rep = repliesOf.get(o) || [];
    const first = rep[0];
    x.mature24 = age >= RULE.SHORT_WINDOW_H * H;
    x.mature72 = age >= RULE.REPLY_WINDOW_H * H;
    x.replied24 = !!(first && first.ts - o.ts <= RULE.SHORT_WINDOW_H * H);
    x.replied72 = !!first;
    for (const m of rep) {
      const c = classifyReply(m.x);
      if (!x.rsvp && c.kind === 'rsvp') x.rsvp = c.outcome;
      else if (!x.rsvp && c.kind === 'party') x.rsvp = 'מגיע';
      else if (c.kind === 'optout') x.optout = true;
      else if (c.kind === 'mistake') x.mistake = true;
      else if (c.kind === 'nocall') x.nocall = true;
    }
  }
  return res;
}

/* ── the aggregation (pure) ─────────────────────────────────────────────────
   rows: compact rows. opts.now: ms. Returns { rows, types, totals, rule }. */
export function computeTemplateStats(rows, opts = {}) {
  const sends = attributeSends(rows, opts);
  const agg = new Map();
  const blank = (template, type) => ({
    template, base: baseName(template), type, type_he: (MSG_TYPES[type] || MSG_TYPES.other).he, goal: (MSG_TYPES[type] || MSG_TYPES.other).goal,
    sends: 0, accepted: 0, rejected: 0, delivered: 0, read: 0, failed: 0, failed_cap: 0, failed_codes: {},
    replies24: 0, replies72: 0, mature24: 0, mature72: 0, mature72_delivered: 0, replies72_delivered: 0,
    clicks: 0, rsvp: { 'מגיע': 0, 'לא מגיע': 0, 'מתלבט': 0 }, optout: 0, mistake: 0, nocall: 0,
    cost: 0, first_ts: 0, last_ts: 0, events: new Set(),
  });
  for (const x of sends) {
    const o = x.o;
    const key = o.t + '|' + x.type;
    const a = agg.get(key) || blank(o.t, x.type); agg.set(key, a);
    a.sends++;
    if (!a.first_ts || o.ts < a.first_ts) a.first_ts = o.ts;
    if (o.ts > a.last_ts) a.last_ts = o.ts;
    if (o.tok) a.events.add(o.tok);
    if (!o.ok) { a.rejected++; continue; }
    a.accepted++;
    if (x.delivered) a.delivered++;
    if (x.read) a.read++;
    if (x.failed) { a.failed++; a.failed_codes[x.code] = (a.failed_codes[x.code] || 0) + 1; if (RULE.CAP_CODES.includes(x.code)) a.failed_cap++; }
    a.cost += x.cost;
    if (x.mature24) { a.mature24++; if (x.replied24) a.replies24++; }
    if (x.mature72) { a.mature72++; if (x.replied72) a.replies72++; if (x.delivered) { a.mature72_delivered++; if (x.replied72) a.replies72_delivered++; } }
    if (x.rsvp) { a.clicks++; a.rsvp[x.rsvp] = (a.rsvp[x.rsvp] || 0) + 1; }
    if (x.optout) a.optout++;
    if (x.mistake) a.mistake++;
    if (x.nocall) a.nocall++;
  }

  const out = [];
  for (const a of agg.values()) {
    a.events = a.events.size;
    a.cost = Math.round(a.cost * 100) / 100;
    /* the reply rate is measured on DELIVERED sends old enough to have had the
       full 72h window */
    const n = a.mature72_delivered || 0;
    const k = a.replies72_delivered || 0;
    a.reply_n = n; a.reply_k = k;
    const w = wilson(k, n);
    a.reply_rate = round4(w.p); a.reply_lo = round4(w.lo); a.reply_hi = round4(w.hi);
    a.reply24_rate = a.mature24 ? round4(a.replies24 / a.mature24) : 0;
    const delivBase = a.accepted - a.failed_cap;
    a.delivery_rate = delivBase > 0 ? round4(a.delivered / delivBase) : 0;
    a.read_rate = a.delivered ? round4(a.read / a.delivered) : 0;
    a.optout_rate = a.delivered ? round4((a.optout + a.mistake) / a.delivered) : 0;
    a.click_rate = a.delivered ? round4(a.clicks / a.delivered) : 0;
    a.cost_per_reply = a.replies72 ? Math.round(a.cost / a.replies72 * 100) / 100 : null;
    out.push(a);
  }
  /* recommendations need the peers of the same message type */
  const byType = {};
  for (const a of out) (byType[a.type] = byType[a.type] || []).push(a);
  for (const a of out) Object.assign(a, recommend(a, byType[a.type]));
  out.sort((x, y) => rankKey(y) - rankKey(x));

  const totals = out.reduce((t, a) => { for (const f of ['sends', 'accepted', 'delivered', 'read', 'failed', 'replies72', 'clicks', 'optout', 'mistake']) t[f] += a[f]; t.cost += a.cost; return t; },
    { sends: 0, accepted: 0, delivered: 0, read: 0, failed: 0, replies72: 0, clicks: 0, optout: 0, mistake: 0, cost: 0 });
  totals.cost = Math.round(totals.cost * 100) / 100;
  const types = Object.entries(byType).map(([type, list]) => ({ type, he: (MSG_TYPES[type] || MSG_TYPES.other).he, templates: list.map(x => x.template) }));
  return { rows: out, types, totals, rule: RULE };
}

function round4(x) { return Math.round(x * 10000) / 10000; }
function rankKey(a) { return (a.rec === 'מעט נתונים' ? 0 : 1) * 1e6 + a.reply_rate * 1e5 + Math.min(a.delivered, 99999) / 1e5; }

/* ── the recommendation (pure, documented in RULE and the spec §3) ─────────
   1. n < MIN_N mature delivered sends                → "מעט נתונים"
   2. opt-out (הסר+טעות) rate > OPTOUT_MAX            → "החלף"
   3. delivery rate (cap failures excluded) < MIN     → "החלף"
   4. goal=reply and a peer of the same type with n ≥ MIN_N has a 95% lower
      bound above this template's 95% upper bound    → "החלף"
   5. otherwise                                       → "שמור"           */
export function recommend(a, peers = []) {
  const n = a.goal === 'reply' ? a.reply_n : a.delivered;
  if (n < RULE.MIN_N) return { rec: 'מעט נתונים', why: `רק ${n} הודעות שנמסרו ועברו 72 שעות (צריך ${RULE.MIN_N})` };
  if (a.optout_rate > RULE.OPTOUT_MAX) return { rec: 'החלף', why: `${pct(a.optout_rate)} ביקשו הסרה או כתבו "טעות" (מעל ${pct(RULE.OPTOUT_MAX)})` };
  if (a.delivery_rate < RULE.DELIVERY_MIN) return { rec: 'החלף', why: `רק ${pct(a.delivery_rate)} נמסרו (בלי חסימות תקרה)` };
  if (a.goal === 'reply') {
    const better = (peers || []).filter(b => b !== a && b.reply_n >= RULE.MIN_N && b.reply_lo > a.reply_hi);
    if (better.length) {
      const best = better.sort((x, y) => y.reply_rate - x.reply_rate)[0];
      return { rec: 'החלף', why: `${best.template} עונים לה יותר (${pct(best.reply_rate)} מול ${pct(a.reply_rate)}, מובהק 95%)` };
    }
    return { rec: 'שמור', why: `${pct(a.reply_rate)} ענו תוך 72 שעות (טווח ${pct(a.reply_lo)}–${pct(a.reply_hi)})` };
  }
  return { rec: 'שמור', why: `הודעת מידע: ${pct(a.delivery_rate)} נמסרו, ${pct(a.optout_rate)} הסרות` };
}
function pct(x) { return (Math.round(x * 1000) / 10) + '%'; }

/* ── I/O: audit rows for N days ────────────────────────────────────────────
   One audit.query() for 60 days does NOT work: measured 01/11, a 7-day
   /api/stream returned 3 days and silently dropped the rest (each day is
   2k–7k records, the KV reads give out). So: one day per query, closed days
   compacted and cached under tstats:rows:<YYYYMMDD> (immutable once the day
   is over), at most `budget` uncached days read per request; the answer says
   which days are still missing and the page simply asks again. */
export async function loadRows(env, days, deps) {
  const q = deps.queryDay;               // async (env, 'YYYYMMDD') → audit records
  const kvGet = deps.kvGet || ((k) => env.RATE.get(k));
  const kvPut = deps.kvPut || ((k, v, o) => env.RATE.put(k, v, o));
  const now = deps.now ? deps.now() : Date.now();
  const budget = Math.max(1, Number(deps.budget) || 3);
  const today = ilDay(new Date(now));
  const rows = [], missing = [];
  let read = 0;
  for (let i = 0; i < days; i++) {
    const day = ilDay(new Date(now - i * 86400e3));
    let cached = null;
    if (day !== today) { try { cached = JSON.parse((await kvGet('tstats:rows:' + day)) || 'null'); } catch { cached = null; } }
    if (cached) { for (const r of cached) rows.push(r); continue; }
    if (read >= budget) { missing.push(day); continue; }
    read++;
    const recs = await q(env, day);
    const compact = (recs || []).map(compactRecord).filter(Boolean);
    for (const r of compact) rows.push(r);
    if (day !== today) await kvPut('tstats:rows:' + day, JSON.stringify(compact), { expirationTtl: 120 * 86400 });
  }
  return { rows, missing };
}
function ilDay(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d).replace(/-/g, ''); }

/* ── the route ───────────────────────────────────────────────────────────────
   deps (all injectable; index.js passes the real ones):
     isAdmin(env, key), okJson(obj, origin), deny(status, reason, origin),
     queryDay(env, day), kvGet, kvPut, now(), budget                          */
export async function handleTemplateStats(request, env, origin, deps = {}) {
  let b = {};
  try { b = await request.json(); } catch { return deps.deny(400, 'bad-json', origin); }
  if (!deps.isAdmin(env, b.admin_key)) return deps.deny(403, 'bad-admin-key', origin);
  const days = Math.max(1, Math.min(60, Number(b.days) || 30));
  const { rows, missing } = await loadRows(env, days, deps);
  const now = deps.now ? deps.now() : Date.now();
  const stats = computeTemplateStats(rows, { now });
  return deps.okJson({ ok: true, days, partial: missing.length > 0, missing_days: missing, generated_at: new Date(now).toISOString(), ...stats }, origin);
}
