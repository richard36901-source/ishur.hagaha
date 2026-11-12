/* ============================================================================
   ishur.io · send-board.js · "נשלחו מתוך כמה" (Richard 01/11)
   ----------------------------------------------------------------------------
   Richard: "איפה אני רואה כמה נשלחו מתוך כמה?" — /api/wave-audit counts
   `sent` = Meta ACCEPTED the request. On 01/11 Meta accepted ~300 messages and
   then failed them asynchronously (131048), and the board said "sent".

   This file answers, per event AND per message type:
       נמסרו X / נשלחו Y / מתוך Z מוזמנים
   with buckets נמסר · נקרא · נכשל (by Meta code, plain Hebrew) · ממתין (why)
   · ענו, and the names behind every bucket (last status time + the number the
   message left from).

   Source of truth (in this order):
     1. wa_status audit rows joined to wa_out audit rows by wamid
        (whatsapp.js:305 writes wa_out {phone_id, wamid, template};
         index.js:2889 writes wa_status {wamid, status, wave}).
     2. For a (guest, type) the audit window does not cover, the per-guest KV
        markers the engine itself reads: wsent/wst/wferr/wdead (waves) and
        s5d/s5t/s5e/s3t (lifecycle). These decide "reopened" vs "final" too:
        a failed message whose marker is gone WILL be re-sent (ממתין), one whose
        marker is still there will not (נכשל).
   Never the `sent` counter.

   Layout:
     §1 pure helpers + aggregateSendBoard()   ← unit-tested, no I/O
     §2 handleSendBoard(request, env, origin, deps) ← the route; I/O via deps
   ========================================================================== */

import { planVsCapacity } from './budget.js';
import { giftActive } from './gifts.js';
import { subeventBoard } from './subevent.js';   /* 03/11 linked sub-events */

/* ── §1a message types, in board order ─────────────────────────────────── */
export const TYPES = [
  { key: 'w1', he: 'הזמנה · גל 1', marker: (t, p) => `wsent:${t}:1:${p}`, wave: '1' },
  { key: 'w2', he: 'הזמנה · גל 2 (תזכורת)', marker: (t, p) => `wsent:${t}:2:${p}`, wave: '2' },
  { key: 'w3', he: 'הזמנה · גל 3', marker: (t, p) => `wsent:${t}:3:${p}`, wave: '3' },
  { key: 'daybefore', he: 'יום-לפני', marker: (t, p) => `s5d:${t}:${p}`, wave: 'daybefore' },
  { key: 'table', he: 'שולחן', marker: (t, p) => `s5t:${t}:${p}`, wave: 'seating' },
  { key: 'eventday', he: 'יום-האירוע', marker: (t, p) => `s5e:${t}:${p}`, wave: 'eventday' },
  { key: 'thanks', he: 'תודה', marker: (t, p) => `s3t:${t}:${p}`, wave: '' },
  /* 02/11: the gift message to declined guests (decline reply or /api/gift-blast) */
  { key: 'gift', he: 'מתנה (לא מגיעים)', marker: (t, p) => `gift:${t}:${p}`, wave: 'gift' },
];
/* 02/11 (Richard): failures broken out by these codes on the board, always */
export const BOARD_CODES = ['131048', '131049', '131047', '131042', '130472'];
const TYPE_BY_KEY = Object.fromEntries(TYPES.map(t => [t.key, t]));
/* the sends whose failure the status webhook can reopen (index.js:2905-2960:
   it needs a wamid:<id> record with gk; waves write it at index.js:4495, the
   lifecycle sends through noteGuestSend since the 01/11 hotfix). The thank-you
   (index.js:5009) records no wamid, so its failures are final. */
const REOPENABLE = new Set(['w1', 'w2', 'w3', 'daybefore', 'table', 'eventday']);

/* ── §1b Meta error codes → plain Hebrew. Documented in the review doc. ──── */
export const FAIL_GROUPS = {
  cap: 'תקרה',
  notwa: 'לא בוואטסאפ',
  blocked: 'חסם',
  experiment: 'ניסוי מטא',
  other: 'אחר',
};
export const CODE_MAP = {
  131048: { g: 'cap', he: 'תקרת שליחה של מטא (Spam rate limit) — המספר שלנו, לא האורח' },
  130429: { g: 'cap', he: 'תקרת קצב של מטא (Rate limit)' },
  131056: { g: 'cap', he: 'יותר מדי הודעות לאותו אורח בזמן קצר' },
  131026: { g: 'notwa', he: 'לא ניתן למסור: אין וואטסאפ במספר, גרסה ישנה, או שחסם אותנו' },
  131050: { g: 'blocked', he: 'האורח ביקש לא לקבל הודעות שיווקיות' },
  130472: { g: 'experiment', he: 'המספר בניסוי של מטא — הודעות שיווק לא נמסרות לו' },
  131049: { g: 'other', he: 'מטא עצרה כדי לשמור על מעורבות (מגבלת שיווק לאורח)' },
  131047: { g: 'other', he: 'עברו 24 שעות מההודעה האחרונה של האורח — רק תבנית' },
  131042: { g: 'other', he: 'בעיית תשלום בחשבון מטא' },
  131053: { g: 'other', he: 'מטא לא הצליחה להעלות את התמונה/וידאו' },
  132000: { g: 'other', he: 'מספר הפרמטרים לא תואם לתבנית' },
  132001: { g: 'other', he: 'התבנית לא קיימת / לא אושרה בשפה הזו' },
  132015: { g: 'other', he: 'התבנית מושהית' },
  132016: { g: 'other', he: 'התבנית מושבתת' },
  133010: { g: 'other', he: 'המספר לא רשום ב-API' },
};
export function codeOf(text) {
  const m = /\b(1[0-9]{5})\b/.exec(String(text || ''));
  return m ? m[1] : '';
}
export function failGroup(code) { return (CODE_MAP[code] || {}).g || 'other'; }
export function failHe(code) { return (CODE_MAP[code] || {}).he || (code ? 'קוד ' + code : 'סיבה לא ידועה'); }
const CAP_CODES = new Set(['131048', '130429']);

/* ── §1c phone_id → the number people know. Ids from wrangler.toml:25-31 and
   the audit log (1107514695777584 is the only guests id seen before 01/11 and
   the sheet line names 0559726673 as Shir's sender, whatsapp.js:330). ──── */
export const PHONE_LABELS = {
  '1107514695777584': '055-972-6673',
  '1409632775565601': '055-308-9799',
  '1218978741299669': '055-950-4499',
  '1404834546041914': '055-950-4499',
};
export function phoneLabel(id, extra = {}) {
  const k = String(id || '');
  if (!k) return '';
  return extra[k] || PHONE_LABELS[k] || 'מזהה …' + k.slice(-4);
}

/* ── §1d which type is this outgoing message? ──────────────────────────── */
function ilDay(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts)); }
export function typeOf({ template, wave, at }, ev) {
  const w = String(wave == null ? '' : wave);
  if (w === '1' || w === '2' || w === '3') return 'w' + w;
  if (w === 'daybefore') return 'daybefore';
  if (w === 'seating') return 'table';
  const t = String(template || '');
  /* 09/11: the D-1 / event-day family — a _t* name carries the table, so it IS the table message */
  if (/^ishur_lifnei_/.test(t)) return 'daybefore';
  if (/^ishur_yom_(combo|plain)_t/.test(t)) return 'table';
  if (/^ishur_yom_(combo|plain)_/.test(t)) return 'eventday';
  if (w === 'eventday') return 'eventday';
  if (w === 'gift') return 'gift';
  if (!t) return null;
  if (/^ishur_yom_lifnei/.test(t)) return 'daybefore';
  /* _f (footer copy) and _matana (gift twin) are the same table message */
  if (/^ishur_shulchan/.test(t)) return 'table';
  if (/^ishur_matana/.test(t)) return 'gift';
  if (/^ishur_toda_matana/.test(t)) return 'thanks';
  if (/^ishur_toda_orach/.test(t)) return 'thanks';
  if (ev && ev.eventday_template && t === ev.eventday_template) return 'eventday';
  if (/^ishur_yom_haerua|^ishur_eventday/.test(t)) return 'eventday';
  /* 03/11 the one event-day message: with a table it IS the table message */
  if (/^ishur_yom_combo_tg?$/.test(t)) return 'table';
  if (t === 'ishur_yom_combo_g') return 'eventday';
  /* 12/11: a personal invitation template is always ishur_c_<tok8>_<n> (index.js customName) — the plan's events carry no custom_template, so the name decides */
  const isInvite = /hazmana|^ishur_c_[0-9a-f]{8}_\d+$/.test(t) || (ev && ev.custom_template && t === ev.custom_template);
  if (!isInvite) return null;
  /* the three waves share one template (index.js:4484), so the date decides */
  const d = at ? ilDay(at) : '';
  const wv = (ev && ev.waves) || {};
  if (wv[3] && d >= wv[3]) return 'w3';
  if (wv[2] && d >= wv[2]) return 'w2';
  return 'w1';
}

/* ── §1e audience: who SHOULD get this type (index.js:4440-4443, 5060-5100,
   5228-5240, 4020-4032, 4990-5002) ─────────────────────────────────────── */
function inAudience(type, g, ev) {
  const r = g.rsvp || '';
  switch (type) {
    case 'w1': case 'w3': return r !== 'לא מגיע';
    case 'w2': return !r || r === 'מתלבט';
    case 'daybefore': return r === 'מגיע';
    case 'table': return r === 'מגיע' && !!g.table;
    /* 03/11 R2: a guest with a table gets ONE event-day message — the table one */
    case 'eventday': return !!ev.eventday && r === 'מגיע' && !g.table;
    case 'thanks': return ev.plan !== 'basic' && r === 'מגיע';
    case 'gift': return !!ev.gift_on && r === 'לא מגיע';
    default: return false;
  }
}
/* the date a type becomes due; null when it never applies to this event */
function dueDate(type, ev) {
  const add = (d, n) => d ? new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10) : '';
  switch (type) {
    case 'w1': return ev.waves[1] || null;
    case 'w2': return ev.waves[2] || null;
    case 'w3': return ev.waves[3] || null;
    case 'daybefore': return add(ev.date, -1);
    case 'table': return ev.date || null;
    case 'eventday': return ev.eventday ? (ev.eventday.at || ev.date) : null;
    case 'thanks': return ev.plan === 'basic' ? null : add(ev.date, 1);
    case 'gift': return ev.gift_on ? add(ev.date, 1) : null;
    default: return null;
  }
}

const RANK = { sent: 1, delivered: 2, read: 3 };
function bumpCode(row, code) { const k = String(code || '?'); row.failed.codes[k] = (row.failed.codes[k] || 0) + 1; }

/* ── §1h what is planned to leave on each of the next days (02/11) ─────────
   due today or overdue: everything still waiting that the engine will try
   (queue, window, cap, reopened) — an event on hold is not counted, it will
   not leave until someone lifts the hold. due later: the scheduled ones. */
export function plannedByDay(events, today, days = 3) {
  const last = new Date(Date.parse(today + 'T12:00:00Z') + (days - 1) * 864e5).toISOString().slice(0, 10);
  const out = {};
  for (const ev of events || []) for (const t of ev.types || []) {
    const p = t.pending || {};
    if (t.due && t.due <= today) { const n = (p.queue || 0) + (p.window || 0) + (p.cap || 0) + (p.reopened || 0); if (n) out[today] = (out[today] || 0) + n; }
    else if (t.due && t.due <= last && p.scheduled) out[t.due] = (out[t.due] || 0) + p.scheduled;
  }
  return out;
}
/* per-number cap rows for the board (labels + reset times) */
export function capBoard(cap, plan, labels = {}) {
  if (!cap) return null;
  const numbers = (cap.numbers || []).map(n => ({ ...n, label: phoneLabel(n.id, labels) }));
  return { scope: cap.scope, limit: cap.limit, used: cap.used, remaining: cap.remaining, all_held: !!cap.all_held, numbers, plan, warning: (plan || []).some(d => d.over) };
}

/* ── §1f THE aggregation. Pure: same input → same output. ──────────────────
   input = {
     today: 'YYYY-MM-DD', now: ms,
     events: [{ token, name, date, plan, waves:{1,2,3}, held, eventday:{at,no_table}|null,
                eventday_template, custom_template }],
     guests: { <token>: [{ name, phone(972…), id, rsvp, table }] },
     waOut:   audit rows kind wa_out    (data.wamid, data.phone_id, data.template)
     waStatus:audit rows kind wa_status (data.wamid, data.status, data.wave, detail)
     waIn:    audit rows kind wa_in     (phone, ts)          — optional
     markers: { '<token>|<type>|<phone>': { m, wst, err, dead } } — optional;
              m = the per-guest marker value (null = absent = will be sent)
     gates:   { paused, cap_all, window:{open, why} }
     phoneLabels: { phone_id: '05x-…' }   — optional overrides
     detail:  true → include the name lists per bucket
   } */
export function aggregateSendBoard(input) {
  const { today, events = [], guests = {}, waOut = [], waStatus = [], waIn = [], gates = {}, detail = true } = input;
  const markers = input.markers || null;
  const coverageFrom = String(input.coverageFrom || '');
  const labels = input.phoneLabels || {};

  /* phone → events it belongs to (table messages carry no token, index.js:5090) */
  const evByTok = {}; const tokByPhone = {};
  for (const ev of events) {
    evByTok[ev.token] = ev;
    for (const g of guests[ev.token] || []) (tokByPhone[g.phone] = tokByPhone[g.phone] || []).push(ev.token);
  }
  const resolveTok = (tok, phone) => {
    const t = String(tok || '');
    if (t.length >= 8) { const hit = events.find(e => e.token === t || e.token.slice(0, 8) === t.slice(0, 8)); if (hit) return hit.token; }
    const cands = tokByPhone[phone] || [];
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {   /* nearest event on or after today */
      return cands.map(c => evByTok[c]).sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(today)) - Math.abs(Date.parse(b.date) - Date.parse(today)))[0].token;
    }
    return '';
  };

  /* statuses by wamid, time-ordered */
  const stBy = {};
  for (const s of waStatus) {
    const id = s && s.data && s.data.wamid; if (!id) continue;
    (stBy[id] = stBy[id] || []).push({ status: String(s.data.status || ''), ts: Number(s.ts) || Date.parse(s.at) || 0, code: s.data.status === 'failed' ? codeOf(s.detail) : '', detail: String(s.detail || ''), wave: s.data.wave, token: s.token });
  }
  for (const k in stBy) stBy[k].sort((a, b) => a.ts - b.ts);

  /* attempts per (token,type,phone) */
  const att = {};
  const seenOut = new Set();
  for (const o of waOut) {
    const d = o.data || {}; const phone = String(o.phone || ''); if (!phone) continue;
    const sts = d.wamid ? (stBy[d.wamid] || []) : [];
    const tok = resolveTok(o.token || (sts[0] && sts[0].token), phone);
    const ev = evByTok[tok]; if (!ev) continue;
    const ts = Number(o.ts) || Date.parse(o.at) || 0;
    const type = typeOf({ template: d.template, wave: sts.length ? sts[0].wave : '', at: ts }, ev);
    if (!type) continue;
    if (d.wamid) seenOut.add(d.wamid);
    const k = `${tok}|${type}|${phone}`;
    (att[k] = att[k] || []).push({ ts, accepted: !!o.ok && !!d.wamid, reject: o.ok ? '' : codeOf(d.error || o.detail), wamid: d.wamid || '', phone_id: String(d.phone_id || ''), statuses: sts, tmpl: String(d.template || '') });
  }
  /* statuses whose wa_out fell outside the window but that carry token+wave */
  for (const id in stBy) {
    if (seenOut.has(id)) continue;
    const s0 = stBy[id][0]; if (!s0.token || !s0.wave) continue;
    const ev = evByTok[resolveTok(s0.token, '')]; if (!ev) continue;
    const type = typeOf({ wave: s0.wave }, ev); if (!type) continue;
    const phone = (waStatus.find(s => s.data && s.data.wamid === id) || {}).phone || '';
    if (!phone) continue;
    const k = `${ev.token}|${type}|${phone}`;
    (att[k] = att[k] || []).push({ ts: s0.ts, accepted: true, reject: '', wamid: id, phone_id: '', statuses: stBy[id] });
  }
  for (const k in att) att[k].sort((a, b) => a.ts - b.ts);

  const inBy = {};
  for (const m of waIn) { const p = String(m.phone || ''); const ts = Number(m.ts) || Date.parse(m.at) || 0; if (p) (inBy[p] = inBy[p] || []).push(ts); }

  const out = [];
  for (const ev of events) {
    const gl = (guests[ev.token] || []).filter(g => g.phone);
    const seen = new Set(); const list = gl.filter(g => !seen.has(g.phone) && seen.add(g.phone));
    const evOut = { token: ev.token, short: ev.token.slice(0, 8), name: ev.name, date: ev.date, held: !!ev.held, invited: list.length, types: [] };
    for (const T of TYPES) {
      const due = dueDate(T.key, ev);
      const row = { key: T.key, he: T.he, due, audience: 0, sent: 0, delivered: 0, read: 0, no_status: 0, answered: 0,
        failed: { total: 0, cap: 0, notwa: 0, blocked: 0, experiment: 0, other: 0, codes: {} },
        pending: { total: 0, reopened: 0, hold: 0, cap: 0, window: 0, scheduled: 0, queue: 0 },
        dropped: 0,   /* 03/11 R1: day-before not sent by the event day — never sent late */
        skipped: 0, unknown: 0, last_at: 0, first_at: 0, inferred: 0, sources: { audit: 0, kv: 0 }, templates: {} };
      const people = detail ? { delivered: [], read: [], no_status: [], failed: [], pending: [], answered: [], skipped: [], unknown: [], dropped: [] } : null;
      const dropDay = T.key === 'daybefore' && !!ev.date && today >= ev.date;
      const DROP_HE = 'דולג — האירוע היום/עבר; יום-לפני לא נשלח באיחור';
      const push = (b, g, extra) => { if (people) people[b].push({ name: g.name || '', phone: g.phone, ...extra }); };

      for (const g of list) {
        const k = `${ev.token}|${T.key}|${g.phone}`;
        const a = att[k] || [];
        const mk = markers && markers[k] ? markers[k] : null;
        const aud = !!due && inAudience(T.key, g, ev);   /* a type with no date (e.g. no wave 3) has no audience */
        if (!a.length && !aud && !(mk && (mk.wst || mk.m))) continue;
        row.audience++;
        if (mk && mk.m === 'skip' && !a.length) { row.skipped++; push('skipped', g, { why: 'דילוג ידני' }); continue; }

        if (a.length) {
          row.sources.audit++;
          /* 09/11 control center: which wording went out, and when the type started */
          for (const x of a) { if (x.tmpl) row.templates[x.tmpl] = (row.templates[x.tmpl] || 0) + 1; if (x.ts && (!row.first_at || x.ts < row.first_at)) row.first_at = x.ts; }
          const acc = a.filter(x => x.accepted);
          const last = a[a.length - 1];
          const allSt = [].concat(...a.map(x => x.statuses.map(s => ({ ...s, phone_id: x.phone_id }))));
          const best = allSt.filter(s => RANK[s.status] >= 2).sort((x, y) => RANK[y.status] - RANK[x.status] || y.ts - x.ts)[0];
          const lastTs = Math.max(last.ts, ...allSt.map(s => s.ts));
          if (lastTs > row.last_at) row.last_at = lastTs;
          const num = phoneLabel((best && best.phone_id) || last.phone_id, labels);
          if (acc.length) row.sent++;
          if (best) {
            row.delivered++;
            if (best.status === 'read') { row.read++; push('read', g, { at: best.ts, number: num, status: 'read' }); }
            else push('delivered', g, { at: best.ts, number: num, status: 'delivered' });
          } else {
            /* the newest outcome of the newest attempt */
            const lst = last.statuses.filter(s => s.status === 'failed').pop();
            const code = lst ? lst.code : last.reject;
            if (!lst && last.accepted) { row.no_status++; push('no_status', g, { at: last.ts, number: num, status: 'sent' }); }
            else {
              const nonCap = a.filter(x => x.statuses.some(s => s.status === 'failed' && !CAP_CODES.has(s.code))).length;
              let reopened;
              if (mk) reopened = !mk.m && !mk.dead;                 /* the engine's own marker decides */
              else if (++row.inferred) reopened = REOPENABLE.has(T.key) && !!lst && (CAP_CODES.has(code) || (code !== '131026' && nonCap < 3));
              const info = { at: lst ? lst.ts : last.ts, number: num, status: 'failed', code, why: failHe(code), group: failGroup(code) };
              if (reopened && dropDay) { row.dropped++; push('dropped', g, { ...info, reason: 'dropped', reason_he: DROP_HE }); }
              else if (reopened) { row.pending.total++; row.pending.reopened++; push('pending', g, { ...info, reason: 'reopened', reason_he: 'נכשל (' + FAIL_GROUPS[failGroup(code)] + ') ונפתח לשליחה חוזרת' }); }
              else { row.failed.total++; row.failed[failGroup(code)]++; bumpCode(row, code); push('failed', g, info); }
            }
          }
          /* answered: an RSVP on the sheet (invites) or a WhatsApp reply after the first send */
          const first = (acc[0] || a[0]).ts;
          const replied = (inBy[g.phone] || []).some(t => t >= first);
          if ((T.key[0] === 'w' && g.rsvp) || replied) { row.answered++; push('answered', g, { at: (inBy[g.phone] || []).filter(t => t >= first)[0] || 0, rsvp: g.rsvp || '' }); }
          continue;
        }

        /* no attempt in the audit window: the KV marker, when we have it */
        if (mk && (mk.wst || mk.m)) {
          row.sources.kv++;
          if (mk.wst === 'read' || mk.wst === 'delivered') { row.sent++; row.delivered++; if (mk.wst === 'read') { row.read++; push('read', g, { status: 'read', src: 'kv' }); } else push('delivered', g, { status: 'delivered', src: 'kv' }); }
          else if (mk.wst === 'failed' || mk.err || mk.dead) {
            const code = String(mk.err || mk.dead || ''); row.sent++;
            if (!mk.m && !mk.dead && dropDay) { row.dropped++; push('dropped', g, { status: 'failed', code, why: failHe(code), reason: 'dropped', reason_he: DROP_HE, src: 'kv' }); }
            else if (!mk.m && !mk.dead) { row.pending.total++; row.pending.reopened++; push('pending', g, { status: 'failed', code, why: failHe(code), reason: 'reopened', reason_he: 'נכשל (' + FAIL_GROUPS[failGroup(code)] + ') ונפתח לשליחה חוזרת', src: 'kv' }); }
            else { row.failed.total++; row.failed[failGroup(code)]++; bumpCode(row, code); push('failed', g, { status: 'failed', code, why: failHe(code), group: failGroup(code), src: 'kv' }); }
          } else { row.sent++; row.no_status++; push('no_status', g, { status: 'sent', src: 'kv' }); }
          if (T.key[0] === 'w' && g.rsvp) { row.answered++; push('answered', g, { rsvp: g.rsvp }); }
          continue;
        }

        /* before the audit log existed (or outside the window asked for) and no
           marker to look at: say "unknown", never "not sent" */
        if (!mk && due && coverageFrom && due < coverageFrom) { row.unknown++; push('unknown', g, { reason_he: 'נשלח לפני תחילת היומן — אין נתון מסירה' }); continue; }
        if (!mk && !markers && due && due < today) { row.unknown++; push('unknown', g, { reason_he: 'לא נמצא ביומן; בלי סמני KV אי אפשר לדעת אם יצא' }); continue; }
        /* never sent: why not */
        if (dropDay) { row.dropped++; push('dropped', g, { reason: 'dropped', reason_he: DROP_HE }); continue; }
        let reason, reason_he;
        if (!due || due > today) { reason = 'scheduled'; reason_he = due ? 'מתוכנן ל-' + due.slice(8, 10) + '/' + due.slice(5, 7) : 'לא חל על האירוע'; }
        else if (ev.held || gates.paused) { reason = 'hold'; reason_he = ev.held ? 'האירוע בהשהיה' : 'כל השליחות מושהות'; }
        else if (gates.cap_all) { reason = 'cap'; reason_he = 'כל המספרים בתקרה — ימשיך כשמטא תשחרר'; }
        else if (gates.window && gates.window.open === false) { reason = 'window'; reason_he = 'מחוץ לחלון השליחה (' + ({ shabbat: 'שבת', 'friday-window': 'שישי אחרי 13:00', hours: '09:00-20:30' }[gates.window.why] || gates.window.why || '') + ')'; }
        else { reason = 'queue'; reason_he = 'בתור — יוצא בפעימה הבאה'; }
        row.pending.total++; row.pending[reason]++;
        push('pending', g, { reason, reason_he });
      }
      if (!row.audience && !row.sent) continue;
      if (people) row.people = people;
      evOut.types.push(row);
    }
    out.push(evOut);
  }
  out.sort((a, b) => (a.date || '9') < (b.date || '9') ? -1 : 1);
  return { ok: true, today, generated_at: new Date(input.now || Date.now()).toISOString(), coverage_from: coverageFrom || null, events: out };
}

/* ── §1g sheet snapshot → the event list (same filter as /api/wave-audit,
   index.js:9759-9764, widened to include events whose waves have not started
   so "מתוכנן" shows; the columns are the ones that route reads) ─────────── */
export function eventsFromRaw(raw, today, { token = '', isTestEventRow = () => false, planKeyOf = () => '', from = '' } = {}) {
  const evs = []; const guests = {};
  const gByTok = {};
  for (const g of (raw && raw.guests && raw.guests.values) || []) { const t = String(g[28] || '').trim(); if (t) (gByTok[t] = gByTok[t] || []).push(g); }
  const norm = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '972' + d.slice(1); return d; };
  for (const ev of (raw && raw.events && raw.events.values) || []) {
    const tok = String(ev[1] || '').trim(); if (!tok || isTestEventRow(ev)) continue;
    if (token && tok !== token && tok.slice(0, 8) !== String(token).slice(0, 8)) continue;
    const c = i => String(ev[i] ?? '').trim();
    if (c(7) !== 'כן' || c(27) === 'כן' || c(43) !== 'כן') continue;
    const date = c(6).slice(0, 10);
    if (!token && from && date < from) continue;
    evs.push({ token: tok, name: c(34) || c(2), date, plan: planKeyOf(ev), waves: { 1: c(39).slice(0, 10), 2: c(40).slice(0, 10), 3: c(41).slice(0, 10) }, held: false, eventday: null, occasion: c(5), time: c(36), client_id: c(0) });
    guests[tok] = (gByTok[tok] || []).map(g => ({ name: String(g[3] || '').trim(), phone: norm(g[4]), id: String(g[2] || '').trim(), rsvp: String(g[15] || '').trim(), table: String(g[30] || '').trim() }));
  }
  return { events: evs, guests };
}

/* ── §2 the route ──────────────────────────────────────────────────────────
   POST /api/send-board {admin_key, token?, days?, detail?}
   deps (index.js internals, passed in so this file never imports index.js):
     isAdmin, okJson, deny, snapshotCached(env), auditQuery(env, q),
     isTestEventRow, planKeyOf, ilDate(), sendWindowState(), sendingPaused(env),
     guestPhoneIds(env), kvPrefix(env, prefix)
   Read-only: KV get/list only. The one write is a 5-minute cache entry. */
export async function handleSendBoard(request, env, origin, deps) {
  let b = {}; try { b = await request.json(); } catch { return deps.deny(400, 'bad-json', origin); }
  if (!deps.isAdmin(env, b.admin_key)) return deps.deny(403, 'bad-admin-key', origin);
  const token = String(b.token || '').trim();
  if (token && !/^[0-9a-f-]{8,36}$/.test(token)) return deps.deny(400, 'bad-token', origin);
  const r = await sendBoardData(env, deps, b);
  if (!r) return deps.deny(502, 'reader-failed', origin);
  return deps.okJson(r, origin);
}
/* 03/11 ops calendar: the same board as data (no Response), so /api/ops/calendar reuses it + its cache */
export async function sendBoardData(env, deps, b = {}) {
  const token = String(b.token || '').trim();
  const days = Math.max(1, Math.min(10, Number(b.days) || 3));
  const detail = b.detail !== false;
  const ck = `sendboard:${token.slice(0, 8) || 'all'}:${days}:${detail ? 1 : 0}`;
  /* the cap is never served from the cache: it moves with every send */
  const withCap = async (data) => {
    if (!deps.guestCapacity) return data;
    const cap = await deps.guestCapacity(env).catch(() => null);
    if (!cap) return data;
    const plan = planVsCapacity(plannedByDay(data.events, data.today, 3), { today: data.today, remainingNow: cap.remaining, limit: cap.limit, days: 3 });
    return { ...data, cap: capBoard(cap, plan), cap_at: new Date().toISOString() };
  };
  if (env.RATE && !b.force) { try { const hit = JSON.parse((await env.RATE.get(ck)) || 'null'); if (hit && Date.now() - hit.at < 5 * 60e3) return { ...(await withCap(hit.data)), cached: true }; } catch {} }

  const today = deps.ilDate();
  const raw = await deps.snapshotCached(env);
  if (!raw) return null;
  const from = new Date(Date.parse(today + 'T12:00:00Z') - 2 * 864e5).toISOString().slice(0, 10);
  const { events, guests } = eventsFromRaw(raw, today, { token, isTestEventRow: deps.isTestEventRow, planKeyOf: deps.planKeyOf, from });

  /* holds, the event-day jobs, the custom invitation names */
  const edJobs = await deps.kvPrefix(env, 'edblast:').catch(() => ({}));
  await Promise.all(events.map(async ev => {
    ev.held = !!(await env.RATE.get('hold:' + ev.token).catch(() => null));
    try { const j = JSON.parse(edJobs[ev.token] || 'null'); if (j) { ev.eventday = { at: String(j.at || ''), no_table: !!j.no_table }; ev.eventday_template = String(j.template || ''); } } catch {}
    try { const ct = JSON.parse((await env.RATE.get('customtmpl:' + ev.token)) || 'null'); if (ct && ct.name) ev.custom_template = ct.name; } catch {}
    try { ev.gift_on = giftActive(JSON.parse((await env.RATE.get('giftlinks:' + ev.token)) || 'null')); } catch { ev.gift_on = false; }
  }));
  const ids = deps.guestPhoneIds(env);
  const capIds = await Promise.all(ids.map(id => env.RATE.get('wacap:' + id).catch(() => null)));
  const gates = {
    paused: await deps.sendingPaused(env).catch(() => false),
    cap_all: !!(await env.RATE.get('wacap:guests').catch(() => null)) || (ids.length > 0 && capIds.every(Boolean)),
    window: deps.sendWindowState(),
  };

  /* one pass over the audit log; every kind we need comes from it */
  const rows = await deps.auditQuery(env, { days, limit: 20000 });
  const waOut = [], waStatus = [], waIn = [];
  for (const r of rows) { if (r.kind === 'wa_out') waOut.push(r); else if (r.kind === 'wa_status') waStatus.push(r); else if (r.kind === 'wa_in') waIn.push(r); }

  /* the engine's own per-guest markers, for every (guest, due type) */
  const markers = {};
  const jobs = [];
  for (const ev of events) {
    const seen = new Set();
    for (const g of guests[ev.token] || []) {
      if (!g.phone || seen.has(g.phone)) continue; seen.add(g.phone);
      for (const T of TYPES) {
        const due = dueDate(T.key, ev);
        /* gift markers are written by the decline reply BEFORE the event — read them whenever links are on */
        if (!(T.key === 'gift' && ev.gift_on) && (!due || due > today)) continue;
        jobs.push(async () => {
          const isWave = T.key[0] === 'w';
          const [m, wst, err, dead] = await Promise.all([
            env.RATE.get(T.marker(ev.token, g.phone)).catch(() => null),
            T.wave ? env.RATE.get(`wst:${ev.token}:${T.wave}:${g.phone}`).catch(() => null) : null,
            T.wave ? env.RATE.get(`wferr:${ev.token}:${T.wave}:${g.phone}`).catch(() => null) : null,
            isWave ? env.RATE.get(`wdead:${ev.token}:${T.wave}:${g.phone}`).catch(() => null) : null,
          ]);
          markers[`${ev.token}|${T.key}|${g.phone}`] = { m, wst, err, dead };
        });
      }
    }
  }
  for (let i = 0; i < jobs.length; i += 50) await Promise.all(jobs.slice(i, i + 50).map(f => f()));

  const coverageFrom = rows.length ? deps.ilDate(new Date(rows[rows.length - 1].ts)) : today;
  const data = aggregateSendBoard({ today, now: Date.now(), events, guests, waOut, waStatus, waIn, markers, gates, detail, coverageFrom });
  data.window_days = days;
  data.oldest_row_at = rows.length ? rows[rows.length - 1].at : null;
  data.gates = gates;
  data.codes = BOARD_CODES.map(c => ({ code: c, he: failHe(c) }));
  /* 03/11: linked sub-events (שבת חתן) — their ONE message type, from their own markers */
  try { data.subevents = await subeventBoard(env, raw, { kvPrefix: deps.kvPrefix, normPhone: deps.normPhone || (x => String(x || '').replace(/\D/g, '').replace(/^0/, '972')), token }); } catch { data.subevents = []; }
  if (env.RATE) await env.RATE.put(ck, JSON.stringify({ at: Date.now(), data }), { expirationTtl: 600 }).catch(() => {});
  return withCap(data);
}
