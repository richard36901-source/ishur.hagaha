/* ============================================================================
   ishur.io · נועה רודפת (noa-chase) — 02/11/2026
   ----------------------------------------------------------------------------
   Leads that Shalev marked "לא ענה" on the monday board die there. This module
   gives them to Noa (the outbound voice agent on 055-507-7733):

     scanMondayNotAnswered  board 18432553641, status "לא ענה" (index 2) and
                            טיפול != נועה → KV nq:<phone972>; marks טיפול=נועה
                            and עדכונים="נועה לקחה · DD/MM".
     cadenceNextAt          pure: day 0 / +1 / +3 / +7 / +14 from first_at,
                            hour bands rotate 10–12 / 13–16 / 17–20 (Fri
                            09:30–13:00), never Saturday or a no-contact day,
                            max 5 attempts.
     drainNoaChase          like runShirLeadDial but from nq: entries whose
                            next_at <= now; why:'chase' + {{memory}}.
     noaChaseCallEnded      the call_analyzed hook: records the attempt,
                            schedules the next one, writes the result back.
     writeBackMonday        status / עדכונים / an item update with the
                            transcript summary and the /rec/<call_id> link.
     memory                 noa-memory / shir-memory in KV (40 lines, FIFO),
                            memoryGuard (iron rules + PII), memoryBlock for
                            the {{memory}} dynamic variable.

   Everything that writes (KV queue, monday, Retell) is behind
   env.NOA_CHASE === 'on'. `dry` previews without touching anything.
   Pure functions take `now` so node can test them offline.
   ========================================================================== */

import { callWindowState, isNoContactDay, ilDate, buildCallPayload, normIl, leadFromRow } from './shir.js';
import { mondayGql } from './monday.js';
import { stream, logEvent } from './evlog.js';
import { isTestPhone, kvPrefix, normPhone, sendingPaused } from './lib.js';
import { slackPost } from './slack.js';

export const BOARD = '18432553641';
/* column ids, verified against the live board 02/11 (read-only GraphQL) */
export const COL = {
  status: 'status',               // 1 סגר · 2 לא ענה · 3 לא רלוונטי · 4 שיחה חוזרת
  owner: 'color_mm7g6y7g',        // טיפול: 0 ריצארד · 1 נועה · 5 שלו
  phone: 'phone_mm7g3mjv',
  occasion: 'text_mm7g5b2h',      // אירוע
  source: 'text_mm7gk14c',        // מקור
  updates: 'text_mm8a3mbn',       // עדכונים
  callback: 'date_mm8970h',       // מתי לחייג
};
export const STATUS_INDEX = { 'סגר': 1, 'לא ענה': 2, 'לא רלוונטי': 3, 'שיחה חוזרת': 4 };
export const NQ = 'nq:';
export const MAX_ATTEMPTS = 5;
export const DAY_OFFSETS = [0, 1, 3, 7, 14];
/* hour bands in Israel minutes-of-day; rotate by attempt index */
export const BANDS = [[10 * 60, 12 * 60], [13 * 60, 16 * 60], [17 * 60, 20 * 60]];
export const FRIDAY_BAND = [9 * 60 + 30, 13 * 60];

const on = env => String((env && env.NOA_CHASE) || '') === 'on';

/* ── Israel-time helpers (pure) ───────────────────────────────────────────── */
function ilParts(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  return { weekday: g('weekday'), y: Number(g('year')), m: Number(g('month')), d: Number(g('day')), h: Number(g('hour')) % 24, min: Number(g('minute')) };
}
/* Israel minus UTC, in minutes, at instant d */
function ilOffsetMin(d) {
  const p = ilParts(d);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  const trunc = Math.floor(d.getTime() / 60000) * 60000;
  return Math.round((asUtc - trunc) / 60000);
}
/* the instant that is `mins` minutes into Israel day `dayIso` */
export function ilDateAt(dayIso, mins) {
  const base = new Date(`${dayIso}T00:00:00Z`).getTime() + mins * 60000;
  let d = new Date(base - ilOffsetMin(new Date(base)) * 60000);
  const off2 = ilOffsetMin(d);
  d = new Date(base - off2 * 60000);
  return d;
}
function addDays(dayIso, n) {
  const d = new Date(`${dayIso}T12:00:00Z`);
  return new Date(d.getTime() + n * 86400e3).toISOString().slice(0, 10);
}
export function ilWeekday(dayIso) {
  return ilParts(ilDateAt(dayIso, 12 * 60)).weekday;
}
export function ddmm(d = new Date()) {
  const p = ilParts(d);
  return `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}`;
}

/* ── cadence ──────────────────────────────────────────────────────────────── */
/* When is the next attempt? ISO string, or null when the 5 are spent.
   attempts: [{at, ...}] already made (voicemail / no answer included — they
   count toward the cadence, just not as "reached"). The day offsets are
   measured from opts.first_at, else from the first attempt, else from now. */
export function cadenceNextAt(attempts, now = new Date(), windowFn = callWindowState, opts = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const n = list.length;
  if (n >= MAX_ATTEMPTS) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const firstIso = opts.first_at || (list[0] && list[0].at) || new Date(nowMs).toISOString();
  const firstDay = ilDate(new Date(Date.parse(firstIso) || nowMs));
  let day = addDays(firstDay, DAY_OFFSETS[n]);
  /* a later attempt can never land before the previous one */
  const lastMs = list.reduce((m, a) => Math.max(m, Date.parse(a && a.at) || 0), 0);
  const floor = Math.max(nowMs, lastMs + 60000);
  const rot = n % BANDS.length;
  for (let i = 0; i < 40; i++, day = addDays(day, 1)) {
    const wd = ilWeekday(day);
    if (wd === 'Sat' || isNoContactDay(day)) continue;
    const bands = wd === 'Fri' ? [FRIDAY_BAND] : [...BANDS.slice(rot), ...BANDS.slice(0, rot)];
    for (const [start, end] of bands) {
      let t = Math.max(floor, ilDateAt(day, start).getTime());
      const endMs = ilDateAt(day, end).getTime();
      if (t > endMs) continue;             // this band is already behind us today
      /* step inside the band until the real window says open (it always
         should — the bands sit inside Sun–Thu 10:00–20:30 / Fri 09:30–13:00) */
      for (let k = 0; k < 24 && t <= endMs; k++, t += 10 * 60000) {
        if (windowFn(new Date(t)).open) return new Date(t).toISOString();
      }
    }
  }
  return null;
}

/* ── monday helpers ───────────────────────────────────────────────────────── */
function phone972(text) {
  let d = String(text || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  if (/^5\d{8}$/.test(d)) return '972' + d;   // monday phone column drops the leading 0
  return d;
}
const colText = (it, id) => String(((it.column_values || []).find(c => c.id === id) || {}).text || '').trim();
const colLabel = (it, id) => { const c = (it.column_values || []).find(c => c.id === id) || {}; return String(c.label || c.text || '').trim(); };

async function mondayNotAnswered(env) {
  const items = [];
  let cursor = null;
  const fields = `id name column_values(ids:["${COL.status}","${COL.owner}","${COL.phone}","${COL.occasion}","${COL.source}","${COL.updates}","${COL.callback}"]){ id text ... on StatusValue{ index label } }`;
  for (let page = 0; page < 20; page++) {
    const q = cursor
      ? `query($c:String!){ next_items_page(limit:100,cursor:$c){ cursor items{ ${fields} } } }`
      : `query($b:[ID!]){ boards(ids:$b){ items_page(limit:100, query_params:{rules:[{column_id:"${COL.status}", compare_value:[${STATUS_INDEX['לא ענה']}]}]}){ cursor items{ ${fields} } } } }`;
    const r = await mondayGql(env, q, cursor ? { c: cursor } : { b: [BOARD] });
    const pg = r && (cursor ? r.next_items_page : r.boards && r.boards[0] && r.boards[0].items_page);
    if (!pg) break;
    items.push(...(pg.items || []));
    cursor = pg.cursor;
    if (!cursor) break;
  }
  return items;
}

async function mondaySet(env, itemId, values) {
  return mondayGql(env, 'mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }',
    { b: BOARD, i: String(itemId), v: JSON.stringify(values) });
}

async function mondayFindByPhone(env, phone) {
  const local = String(phone || '').replace(/^972/, '0');
  const r = await mondayGql(env, `query($b:ID!,$c:String!,$v:[String]!){ items_page_by_column_values(board_id:$b,limit:1,columns:[{column_id:$c,column_values:$v}]){ items{ id name } } }`,
    { b: BOARD, c: COL.phone, v: [local] }).catch(() => null);
  const hit = r && r.items_page_by_column_values && r.items_page_by_column_values.items[0];
  return hit ? String(hit.id) : '';
}

/* ── R1 · the scan ────────────────────────────────────────────────────────── */
/* deps (all optional, index.js passes the real ones):
     leadRows()        → לידים sheet rows, for the "already paid" check
     callBlocked(p)    → nocall:/block: (defaults to a KV check here)
     now               → Date, for tests */
export async function scanMondayNotAnswered(env, { dry = false, deps = {} } = {}) {
  if (!env || !env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token' };
  if (!env.RATE) return { ok: false, why: 'no-kv' };
  const now = deps.now || new Date();
  const live = on(env) && !dry;
  let items;
  try { items = await mondayNotAnswered(env); } catch (e) { return { ok: false, why: 'monday: ' + String(e && e.message).slice(0, 160) }; }
  const rows = deps.leadRows ? (await deps.leadRows().catch(() => [])) || [] : [];
  const blocked = deps.callBlocked || (async p => !!(await env.RATE.get('nocall:' + p)) || !!(await env.RATE.get('block:' + p)));
  const queued = [], skipped = [];
  for (const it of items) {
    const name = String(it.name || '').trim();
    const phone = phone972(colText(it, COL.phone));
    const skip = why => skipped.push({ item_id: String(it.id), name, why });
    if (!phone || phone.length < 11) { skip('no-phone'); continue; }
    if (colLabel(it, COL.owner) === 'נועה') { skip('already-noa'); continue; }
    if (isTestPhone(env, phone)) { skip('test-phone'); continue; }
    if (await blocked(phone)) { skip('blocked'); continue; }
    const row = rows.find(r => normPhone(r && r[2]) === phone);
    if (row && leadFromRow(row).paid) { skip('paid'); continue; }
    if (await env.RATE.get(NQ + phone)) { skip('queued'); continue; }
    const entry = {
      item_id: String(it.id), name, phone,
      occasion: colText(it, COL.occasion), source: colText(it, COL.source),
      first_at: now.toISOString(), attempts: [],
      next_at: cadenceNextAt([], now, callWindowState, { first_at: now.toISOString() }),
    };
    queued.push(entry);
    if (!live) continue;
    await env.RATE.put(NQ + phone, JSON.stringify(entry), { expirationTtl: 45 * 86400 });
    const v = {}; v[COL.owner] = { label: 'נועה' }; v[COL.updates] = `נועה לקחה · ${ddmm(now)}`;
    try { await mondaySet(env, it.id, v); } catch (e) {
      await logEvent(env, { area: 'נועה', action: 'מאנדיי: סימון טיפול=נועה נכשל', ok: false, review: true, phone, detail: String(e && e.message).slice(0, 160) }).catch(() => {});
    }
    await logEvent(env, { area: 'נועה', action: 'ליד "לא ענה" נכנס לתור של נועה', ok: true, phone, detail: `${name} · הבא: ${entry.next_at || '—'}` }).catch(() => {});
  }
  return { ok: true, dry: !live, scanned: items.length, queued, skipped };
}

/* ── R2 · the drain ───────────────────────────────────────────────────────── */
/* deps: leadReplied(phone, sinceIso), callBlocked(phone), retellBillingGuard(res),
         logRow(tab, rec), memory (string, the rendered {{memory}} block), now, fetch */
export async function drainNoaChase(env, { max = 2, dry = false, deps = {} } = {}) {
  const now = deps.now || new Date();
  const out = { dialed: 0, waiting: 0, skipped: 0, phones: [], dry };
  if (!dry && !on(env)) return { ...out, why: 'noa-chase-off' };
  if (!env.RATE) return { ...out, why: 'no-kv' };
  if (!dry && (!env.RETELL_KEY || !env.NOA_AGENT || !env.NOA_FROM)) return { ...out, why: 'not-configured' };
  if (await sendingPaused(env)) return { ...out, why: 'paused' };
  const today = ilDate(now);
  if (isNoContactDay(today)) return { ...out, why: 'no-contact-day' };
  const win = callWindowState(now);
  if (!win.open) return { ...out, why: win.why };

  const entries = await kvPrefix(env, NQ);
  const blocked = deps.callBlocked || (async p => !!(await env.RATE.get('nocall:' + p)) || !!(await env.RATE.get('block:' + p)));
  const doFetch = deps.fetch || fetch;
  for (const phone of Object.keys(entries)) {
    if (out.dialed >= max) break;
    let q = null; try { q = JSON.parse(entries[phone]); } catch {}
    if (!q || q.done) { out.skipped++; continue; }
    if (isTestPhone(env, phone) || await blocked(phone)) { out.skipped++; if (!dry) await env.RATE.delete(NQ + phone).catch(() => {}); continue; }
    /* answered on WhatsApp since we took the lead → out of the queue */
    if (deps.leadReplied && await deps.leadReplied(phone, q.first_at)) {
      out.skipped++;
      if (!dry) {
        await env.RATE.delete(NQ + phone).catch(() => {});
        await logEvent(env, { area: 'נועה', action: 'ליד ענה בוואטסאפ — יצא מתור הרדיפה', ok: true, phone }).catch(() => {});
      }
      continue;
    }
    const attempts = Array.isArray(q.attempts) ? q.attempts : [];
    if (attempts.length >= MAX_ATTEMPTS) { out.skipped++; if (!dry) await finishChase(env, phone, q); continue; }
    if (q.next_at && Date.parse(q.next_at) > now.getTime()) { out.waiting++; continue; }
    /* one attempt per Israeli day, whatever the clock says */
    if (attempts.some(a => ilDate(new Date(Date.parse(a.at) || 0)) === today)) { out.waiting++; continue; }

    const lead = { kind: 'lead', phone, name: q.name || '', occasion: q.occasion || 'אירוע', source: q.source || '', requested: false };
    const payload = buildCallPayload(lead, env.NOA_FROM || '', { override_agent_id: env.NOA_AGENT || '', memory: deps.memory || '' });
    payload.metadata.why = 'chase';
    payload.metadata.item_id = String(q.item_id || '');
    payload.metadata.attempt = String(attempts.length + 1);
    payload.retell_llm_dynamic_variables.why = 'chase';
    payload.retell_llm_dynamic_variables.attempt = String(attempts.length + 1);
    if (dry) { out.dialed++; out.phones.push(phone); out.payload = out.payload || payload; continue; }

    const res = await doFetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (deps.retellBillingGuard) await deps.retellBillingGuard(res).catch(() => {});
    if (res && (res.status === 200 || res.status === 201)) {
      let cid = ''; try { cid = String(((await res.clone().json()) || {}).call_id || ''); } catch {}
      attempts.push({ at: now.toISOString(), call_id: cid, reached: false, outcome: '' });
      q.attempts = attempts;
      q.next_at = cadenceNextAt(attempts, now, callWindowState, { first_at: q.first_at });
      q.last_call_id = cid;
      await env.RATE.put(NQ + phone, JSON.stringify(q), { expirationTtl: 45 * 86400 });
      if (deps.logRow) await deps.logRow('calls', { agent: 'נועה', dir: 'יוצאת', phone, name: q.name || '', kind: `ליד (רדיפה ${attempts.length}/${MAX_ATTEMPTS})`, status: 'חויג', id: cid }).catch(() => {});
      out.dialed++; out.phones.push(phone);
    } else {
      out.skipped++;
      await logEvent(env, { area: 'נועה', action: 'חיוג רדיפה נכשל', ok: false, review: true, phone, detail: res ? 'status ' + res.status : 'no response' }).catch(() => {});
    }
  }
  return out;
}

/* 5 attempts, nobody picked up: status stays "לא ענה", עדכונים says so, and
   the entry is kept as done so the scan does not re-queue it. The last
   WhatsApp template (R2) is a separate, explicitly approved send — not here. */
async function finishChase(env, phone, q) {
  if (q.done) return;
  q.done = true; q.done_at = new Date().toISOString();
  await env.RATE.put(NQ + phone, JSON.stringify(q), { expirationTtl: 45 * 86400 }).catch(() => {});
  if (on(env) && env.MONDAY_API_TOKEN && q.item_id) {
    const v = {}; v[COL.updates] = `נועה: ${MAX_ATTEMPTS} ניסיונות, לא נענה · ${ddmm()}`;
    await mondaySet(env, q.item_id, v).catch(() => {});
  }
  await logEvent(env, { area: 'נועה', action: 'רדיפה הסתיימה — 5 ניסיונות ללא מענה', ok: true, review: true, phone, detail: q.name || '' }).catch(() => {});
}

/* ── R3 · the result back to monday ───────────────────────────────────────── */
/* result: { outcome: 'סגר'|'שיחה חוזרת'|'לא רלוונטי'|'לא ענה', callback_date?: 'YYYY-MM-DD',
             line: one-line summary, summary, transcript, call_id, item_id?, attempt? } */
export async function writeBackMonday(env, phone, result, opts = {}) {
  if (!env || !env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token' };
  if (!on(env) && !opts.force) return { ok: false, why: 'noa-chase-off' };
  const r = result || {};
  const now = opts.now || new Date();
  let itemId = String(r.item_id || '');
  if (!itemId && env.RATE) { try { itemId = String((JSON.parse(await env.RATE.get(NQ + normIl(phone))) || {}).item_id || ''); } catch {} }
  if (!itemId) itemId = await mondayFindByPhone(env, normIl(phone));
  if (!itemId) return { ok: false, why: 'not-found' };

  const v = {};
  const idx = STATUS_INDEX[r.outcome];
  if (idx) v[COL.status] = { index: idx };
  if (r.outcome === 'שיחה חוזרת' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.callback_date || ''))) v[COL.callback] = { date: r.callback_date };
  const line = String(r.line || r.summary || r.outcome || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  v[COL.updates] = `נועה · ${ddmm(now)} · ${r.outcome || 'שיחה'}${line && line !== r.outcome ? ' · ' + line : ''}`;
  try { await mondaySet(env, itemId, v); } catch (e) { return { ok: false, why: 'set: ' + String(e && e.message).slice(0, 160) }; }

  const rec = r.call_id ? `https://go.ishur.io/rec/${r.call_id}` : '';
  const body = [
    `נועה · ${r.outcome || 'שיחה'}${r.attempt ? ` · ניסיון ${r.attempt}/${MAX_ATTEMPTS}` : ''}`,
    r.summary ? String(r.summary).slice(0, 600) : '',
    rec ? `הקלטה: ${rec}` : '',
    r.transcript ? '---\n' + String(r.transcript).slice(0, 2500) : '',
  ].filter(Boolean).join('\n');
  let updateId = '';
  try {
    const u = await mondayGql(env, 'mutation($i:ID!,$b:String!){ create_update(item_id:$i, body:$b){ id } }', { i: itemId, b: body });
    updateId = String((u && u.create_update && u.create_update.id) || '');
  } catch (e) {
    await logEvent(env, { area: 'נועה', action: 'מאנדיי: פוסט בפריט נכשל', ok: false, phone, detail: String(e && e.message).slice(0, 160) }).catch(() => {});
  }
  return { ok: true, item_id: itemId, update_id: updateId, values: v };
}

/* What a chase call amounts to, from Retell's end-of-call report. Pure. */
export function chaseOutcome(call) {
  const c = call || {};
  const reason = String(c.disconnection_reason || '');
  const cad = (c.call_analysis && c.call_analysis.custom_analysis_data) || {};
  const t = String(c.transcript || '');
  const users = (t.match(/^\s*User:\s*(.*)$/gm) || []).map(l => l.replace(/^\s*User:\s*/, '').trim()).filter(Boolean);
  const said = users.join(' ');
  if (/voicemail|dial_no_answer|dial_busy|dial_failed/.test(reason) || !users.length) return { outcome: 'לא ענה', reached: false };
  const ao = String(cad.outcome || '').trim();
  if (STATUS_INDEX[ao]) return { outcome: ao, reached: true, callback_date: String(cad.callback_date || '') };
  if (/לא\s+מעוניי|לא\s+רלוונט|כבר\s+סגר|סגרנו\s+עם|תמחק|תסיר|לא\s+להתקשר/.test(said)) return { outcome: 'לא רלוונטי', reached: true };
  if (/שלמ|שילמ|סגרנו|נסגר|שולם|קנינו|הזמנו/.test(said) && /כן|סגור|מעולה/.test(said)) return { outcome: 'סגר', reached: true };
  if (/תחזר|תתקשר|מחר|אחר\s*כך|בערב|בבוקר|שבוע הבא|לא\s+נוח/.test(said)) return { outcome: 'שיחה חוזרת', reached: true };
  if (/transfer/.test(reason)) return { outcome: 'שיחה חוזרת', reached: true, transferred: true };
  return { outcome: '', reached: true };
}

/* The call_analyzed hook for a chase call (metadata.why === 'chase').
   Records the attempt on the nq: entry, schedules the next one (or closes
   the chase when somebody was reached), and writes the result to monday. */
export async function noaChaseCallEnded(env, call, opts = {}) {
  const c = call || {};
  const meta = c.metadata || {};
  if (String(meta.why || '') !== 'chase') return { ok: false, why: 'not-chase' };
  if (!env || !env.RATE) return { ok: false, why: 'no-kv' };
  const phone = normIl(c.to_number || '');
  const now = opts.now || new Date();
  let q = null; try { q = JSON.parse(await env.RATE.get(NQ + phone)); } catch {}
  const verdict = chaseOutcome(c);
  const callId = String(c.call_id || '');
  if (q) {
    const attempts = Array.isArray(q.attempts) ? q.attempts : [];
    const mine = attempts.find(a => a.call_id === callId);
    if (mine) { mine.reached = verdict.reached; mine.outcome = verdict.outcome; }
    else attempts.push({ at: now.toISOString(), call_id: callId, reached: verdict.reached, outcome: verdict.outcome });
    q.attempts = attempts;
    if (verdict.reached) { q.done = true; q.done_at = now.toISOString(); q.next_at = null; }
    else q.next_at = cadenceNextAt(attempts, now, callWindowState, { first_at: q.first_at });
    if (on(env)) await env.RATE.put(NQ + phone, JSON.stringify(q), { expirationTtl: 45 * 86400 }).catch(() => {});
  }
  const dur = c.start_timestamp && c.end_timestamp ? Math.round((c.end_timestamp - c.start_timestamp) / 1000) : null;
  const ca = c.call_analysis || {};
  const result = {
    outcome: verdict.outcome || (verdict.reached ? '' : 'לא ענה'),
    callback_date: verdict.callback_date || '',
    line: verdict.reached ? String(ca.call_summary || '').slice(0, 160) : `לא ענה${dur != null ? ` (${dur} שנ׳)` : ''}`,
    summary: String(ca.call_summary || ''), transcript: String(c.transcript || ''),
    call_id: callId, item_id: (q && q.item_id) || String(meta.item_id || ''), attempt: (q && q.attempts.length) || Number(meta.attempt) || undefined,
  };
  /* a reached call with no clear status leaves the status alone */
  if (!result.outcome) result.line = String(ca.call_summary || 'שיחה ללא סטטוס ברור').slice(0, 160);
  let monday = { ok: false, why: 'skipped' };
  if (on(env)) monday = await writeBackMonday(env, phone, result, { now }).catch(e => ({ ok: false, why: String(e && e.message) }));
  if (verdict.reached && !q) {
    /* a chase call we cannot match to a queue entry still gets reported */
    await logEvent(env, { area: 'נועה', action: 'שיחת רדיפה ללא רשומת תור', ok: false, review: true, phone, ref: callId.slice(-12) }).catch(() => {});
  }
  return { ok: true, phone, verdict, next_at: q ? q.next_at : null, done: !!(q && q.done), monday };
}

/* ── R8 · memory ──────────────────────────────────────────────────────────── */
export const MEMORY_MAX = 40;
export function memoryKey(agent) {
  const a = String(agent || '').trim();
  if (a === 'שיר' || /^shir/i.test(a)) return 'shir-memory';
  return 'noa-memory';
}
export async function getMemory(env, agent) {
  if (!env || !env.RATE) return [];
  try { const v = JSON.parse(await env.RATE.get(memoryKey(agent))); return Array.isArray(v) ? v : []; } catch { return []; }
}

/* Prices the agents are allowed to say. Any other ₪ figure in a lesson is a
   hallucination or a one-off that must not become policy. */
export const KNOWN_PRICES = new Set([49, 149, 250, 500, 1790, 1990, 2390, 3090]);
const BANNED = ['הנחה', 'חינם', 'ללא הגבלה', 'מבטיח', 'מבטיחה', 'בחינם', 'הנחות', 'מתנה'];

/* The gate between "a model said so" and "Noa says so on every call". */
export function memoryGuard(text, opts = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, why: 'empty' };
  if (t.length > 160) return { ok: false, why: 'too-long' };
  if (!/[א-ת]/.test(t)) return { ok: false, why: 'not-hebrew' };
  for (const w of BANNED) if (t.includes(w)) return { ok: false, why: 'banned:' + w };
  /* a phone number, in any of the shapes people write them */
  if (/(?:\+?972|0)[\s-]?5\d(?:[\s-]?\d){7}/.test(t) || /\d{7,}/.test(t.replace(/[\s-]/g, ''))) return { ok: false, why: 'pii:phone' };
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return { ok: false, why: 'pii:email' };
  /* prices: any number next to ₪/שקל/מחיר that is not in the price list */
  const nums = [...t.matchAll(/(\d[\d,]*)\s*(?:₪|ש"ח|שקל|שח)|(?:₪|מחיר|עולה|עלות)\s*(?:של\s*)?(\d[\d,]*)/g)]
    .map(m => Number(String(m[1] || m[2]).replace(/,/g, ''))).filter(n => Number.isFinite(n));
  const allowed = opts.prices instanceof Set ? opts.prices : KNOWN_PRICES;
  for (const n of nums) if (!allowed.has(n)) return { ok: false, why: 'price:' + n };
  /* names: the people on this call (passed in), plus the obvious patterns */
  for (const nm of (opts.names || [])) {
    const first = String(nm || '').trim().split(/\s+/)[0];
    if (first && first.length >= 2 && new RegExp('(^|[\\s,.;:()"׳״-])' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s,.;:()"׳״-])').test(t)) return { ok: false, why: 'pii:name' };
  }
  if (/(?:^|\s)(?:בשם|מר|גברת|גב׳|הלקוח בשם|הליד בשם)\s+[א-ת]{2,}/.test(t)) return { ok: false, why: 'pii:name' };
  return { ok: true, text: t };
}

/* lines: string | string[]; source: string | {source, by}. Returns {added, rejected}. */
export async function addMemory(env, agent, lines, source) {
  const list = (Array.isArray(lines) ? lines : [lines]).map(l => typeof l === 'string' ? l : (l && l.text) || '');
  const src = typeof source === 'object' && source ? source : { source: String(source || ''), by: '' };
  const added = [], rejected = [];
  if (!env || !env.RATE) return { added, rejected: list.map(text => ({ text, why: 'no-kv' })) };
  const key = memoryKey(agent);
  let mem = await getMemory(env, agent);
  const have = new Set(mem.map(m => m.text));
  for (const l of list) {
    const g = src.trusted ? { ok: !!String(l || '').trim(), text: String(l || '').trim(), why: 'empty' } : memoryGuard(l, src);
    if (!g.ok) { rejected.push({ text: l, why: g.why }); continue; }
    if (have.has(g.text)) { rejected.push({ text: l, why: 'duplicate' }); continue; }
    mem.push({ text: g.text, at: new Date().toISOString(), source: String(src.source || ''), by: String(src.by || '') });
    have.add(g.text); added.push(g.text);
  }
  if (mem.length > MEMORY_MAX) mem = mem.slice(-MEMORY_MAX);   // FIFO: the oldest leave
  if (added.length) await env.RATE.put(key, JSON.stringify(mem));
  if (rejected.some(r => r.why !== 'duplicate')) {
    await logEvent(env, { area: 'זיכרון', action: `לקח נדחה (${memoryKey(agent)})`, ok: false, review: true,
      detail: rejected.filter(r => r.why !== 'duplicate').map(r => r.why + ': ' + String(r.text).slice(0, 80)).join(' | ').slice(0, 400) }).catch(() => {});
  }
  return { added, rejected };
}

export async function removeMemory(env, agent, text) {
  const mem = await getMemory(env, agent);
  const next = mem.filter(m => m.text !== text);
  if (env && env.RATE && next.length !== mem.length) await env.RATE.put(memoryKey(agent), JSON.stringify(next));
  return { removed: mem.length - next.length };
}

/* the {{memory}} block: a Hebrew bullet list, newest last; '' when empty */
export function renderMemory(lines) {
  const list = (Array.isArray(lines) ? lines : []).map(m => (typeof m === 'string' ? m : m && m.text) || '').filter(Boolean);
  if (!list.length) return '';
  return 'דברים שלמדתי משיחות קודמות:\n' + list.map(t => '• ' + t).join('\n');
}
export async function memoryBlock(env, agent) {
  return renderMemory(await getMemory(env, agent));
}

/* one pacer tick, both halves; never throws into the pacer */
export async function noaChaseTick(env, deps = {}) {
  if (!on(env)) return { ok: true, why: 'noa-chase-off' };
  const out = {};
  try { out.scan = await scanMondayNotAnswered(env, { deps }); } catch (e) { out.scan = { ok: false, why: String(e && e.message) }; }
  try { out.drain = await drainNoaChase(env, { max: 2, deps: { ...deps, memory: await memoryBlock(env, 'נועה') } }); } catch (e) { out.drain = { ok: false, why: String(e && e.message) }; }
  if (out.drain && out.drain.dialed) {
    await slackPost(env, `📞 *נועה יצאה ל-${out.drain.dialed} שיחות רדיפה* ללידים מהלוח שלא ענו.`, { quiet: true, oneoff: true }).catch(() => {});   /* oneoff: one dial batch (quiet) */
  }
  stream(env, { kind: 'event', area: 'נועה', action: 'סבב רדיפה', ok: true, detail: JSON.stringify({ scan: out.scan && { queued: (out.scan.queued || []).length, skipped: (out.scan.skipped || []).length, why: out.scan.why }, drain: out.drain }).slice(0, 600) }).catch(() => {});
  return out;
}
