/* ── leads.html: the board that replaces monday ──────────────────────────────
   Pure logic only (no fetch, no KV): the sheet rows of "לידים - לא סגרו",
   the per-lead KV state (leadx:<phone>) and the events snapshot go in, the
   merged, sorted list comes out. index.js owns the I/O. Tested from node.

   Sheet columns (A2:P, as the retro importer and shir.js document them):
     0 timestamp · 1 שם · 2 טלפון · 3 מייל · 4 סוג (occasion) · 5 כמות ·
     6 שלב נטישה · 7 שולם? · 8 כניסות · 9 לקוח קיים · 10 (spare) · 11 מקור ·
     12 וואטסאפ נשלח · 13 חבילה · 14 תאריך (ISO) · 15 "dd.mm hh:mm" first seen

   monday.js mirrors the same rows: סטטוס starts as חדש, or סגר on purchase
   (the humans own it after that), שלב is the funnel stage text. The status
   options here are those two plus the two every human board grows anyway. */

export const LEAD_STATUSES = ['חדש', 'בטיפול', 'סגר', 'לא רלוונטי'];
export const STAGES = { lead_partial: 'התחיל טופס', lead: 'שלח טופס', checkout: 'הגיע לתשלום', initiate_checkout: 'הגיע לתשלום', purchase: 'שילם' };

/* same rule as index.js normPhone, plus the bare "5XXXXXXXX" the sheet holds
   when the leading zero was eaten by a number cell */
export function normIl(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (/^5\d{8}$/.test(d)) d = '0' + d;
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}

const col = (row, i) => String((row && row[i]) || '').trim();

function isoDay(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (t && !isNaN(Date.parse(t))) return new Date(t).toISOString().slice(0, 10);
  return '';
}

/* the coarse bucket the filter chips use; the raw string stays on the lead */
export function sourceKind(src) {
  const s = String(src || '').trim();
  if (!s || /^ישיר/.test(s)) return 'ישיר';
  if (/^referral:/.test(s) || /הפניה/.test(s)) return 'הפניה';
  if (/\b(fb|facebook|ig|instagram|meta)\b|פייסבוק|אינסטגרם/i.test(s)) return 'מטא';
  if (/google|gclid|גוגל/i.test(s)) return 'גוגל';
  if (/tiktok|טיקטוק/i.test(s)) return 'טיקטוק';
  return 'אחר';
}

/* one sheet row → one lead record (sheet facts only) */
export function parseLeadRow(row, index) {
  const phone = normIl(col(row, 2));
  if (!phone || phone.length < 11) return null;
  const stageText = col(row, 6);
  const paid = col(row, 7) === 'כן';
  const stage = paid ? STAGES.purchase : (/תשלום/.test(stageText) ? STAGES.checkout : stageText ? stageText : STAGES.lead_partial);
  const dateIso = isoDay(col(row, 14)) || isoDay(col(row, 0));
  let firstAt = dateIso;
  const h = /(\d{2})\.(\d{2}) \d{2}:\d{2}/.exec(col(row, 15));
  if (h && dateIso) firstAt = `${dateIso.slice(0, 4)}-${h[2]}-${h[1]}`;
  const source = col(row, 11);
  return {
    phone,
    name: col(row, 1),
    email: col(row, 3),
    occasion: col(row, 4),
    guests: col(row, 5),
    stage,
    paidSheet: paid,
    seen: Number(col(row, 8)) || 1,
    existingClient: col(row, 9),
    eventDate: isoDay(col(row, 10)),
    source: source || 'ישיר',
    sourceKind: sourceKind(source),
    waSent: col(row, 12),
    plan: col(row, 13),
    date: dateIso,
    firstAt: firstAt || dateIso,
    row: Number.isFinite(index) ? index + 2 : 0,
  };
}

/* the events snapshot (HOOK_STATUS) → the few facts the won-match needs */
export function eventsFromSnapshot(rows) {
  const out = [];
  for (const ev of rows || []) {
    const token = col(ev, 1); if (!token) continue;
    const phone = normIl(col(ev, 3)); if (!phone) continue;
    out.push({ token, client: col(ev, 2), phone, occasion: col(ev, 5), date: col(ev, 6).slice(0, 10), paid: col(ev, 7) === 'כן', cancelled: col(ev, 27) === 'כן' });
  }
  return out;
}

/* KV leadx:<phone> → a clean state object, whatever was stored */
export function parseLeadState(raw) {
  let s = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch { s = null; } }
  if (!s || typeof s !== 'object') s = {};
  const notes = Array.isArray(s.notes) ? s.notes.filter(n => n && n.text).map(n => ({ at: String(n.at || ''), text: String(n.text).slice(0, 600) })) : [];
  return {
    status: LEAD_STATUSES.includes(s.status) ? s.status : '',
    notes,
    followup: /^\d{4}-\d{2}-\d{2}$/.test(String(s.followup || '')) ? String(s.followup) : '',
    token: String(s.token || ''),
    updatedAt: String(s.updatedAt || ''),
  };
}

/* sheet rows + KV states + events → one lead per phone.
   A phone with several rows keeps the newest row's facts, the earliest first
   seen, and the sum of visits. A paid, uncancelled event on the phone wins the
   lead automatically: status סגר and the event token, whatever KV says. */
export function mergeLeads(rows, states, events) {
  const byPhone = new Map();
  (rows || []).forEach((row, i) => {
    const l = parseLeadRow(row, i); if (!l) return;
    const prev = byPhone.get(l.phone);
    if (!prev) { byPhone.set(l.phone, l); return; }
    const newer = (l.date || '') >= (prev.date || '') ? l : prev, older = newer === l ? prev : l;
    for (const k of ['name', 'email', 'occasion', 'guests', 'plan', 'existingClient', 'waSent', 'eventDate']) if (!newer[k] && older[k]) newer[k] = older[k];
    newer.seen = (l.seen || 1) + (prev.seen || 1);
    newer.paidSheet = l.paidSheet || prev.paidSheet;
    if (newer.paidSheet) newer.stage = STAGES.purchase;
    newer.firstAt = [l.firstAt, prev.firstAt].filter(Boolean).sort()[0] || newer.firstAt;
    if (older.source && older.source !== 'ישיר' && (!newer.source || newer.source === 'ישיר')) { newer.source = older.source; newer.sourceKind = older.sourceKind; }
    byPhone.set(l.phone, newer);
  });
  const won = new Map();
  for (const ev of events || []) {
    if (!ev.paid || ev.cancelled) continue;
    const cur = won.get(ev.phone);
    if (!cur || (ev.date || '') > (cur.date || '')) won.set(ev.phone, ev);
  }
  const out = [];
  for (const l of byPhone.values()) {
    const st = parseLeadState((states || {})[l.phone]);
    const ev = won.get(l.phone);
    l.status = st.status || (l.paidSheet ? 'סגר' : 'חדש');
    l.notes = st.notes;
    l.followup = st.followup;
    l.updatedAt = st.updatedAt;
    l.token = st.token;
    l.won = false;
    if (ev) {
      l.won = true; l.status = 'סגר'; l.token = ev.token; l.stage = STAGES.purchase;
      if (!l.eventDate) l.eventDate = ev.date;
      if (!l.occasion) l.occasion = ev.occasion;
      if (!l.name) l.name = ev.client;
    }
    l.lastNote = l.notes.length ? l.notes[l.notes.length - 1] : null;
    out.push(l);
  }
  return out;
}

/* follow-up date first (soonest on top), the rest newest first */
export function sortLeads(list) {
  return (list || []).slice().sort((a, b) => {
    if (a.followup && b.followup && a.followup !== b.followup) return a.followup < b.followup ? -1 : 1;
    if (!!a.followup !== !!b.followup) return a.followup ? -1 : 1;
    const ad = a.date || '', bd = b.date || '';
    if (ad !== bd) return ad > bd ? -1 : 1;
    return (b.row || 0) - (a.row || 0);
  });
}

export function countByStatus(list) {
  const c = {}; for (const s of LEAD_STATUSES) c[s] = 0;
  c.followupDue = 0;
  for (const l of list || []) { if (c[l.status] != null) c[l.status]++; }
  return c;
}

/* /api/lead-update: previous state + the request → the next state.
   Returns { state } or { error }. followup '' clears the date; a note is
   appended with its timestamp; status must be one of the options. */
export function applyLeadUpdate(prev, body, nowIso) {
  const state = parseLeadState(prev);
  const b = body || {};
  let changed = false;
  if (b.status !== undefined) {
    const s = String(b.status || '').trim();
    if (!LEAD_STATUSES.includes(s)) return { error: 'bad-status' };
    state.status = s; changed = true;
  }
  if (b.followup !== undefined) {
    const f = String(b.followup || '').trim();
    if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) return { error: 'bad-followup' };
    state.followup = f; changed = true;
  }
  if (b.note !== undefined) {
    const t = String(b.note || '').trim().slice(0, 600);
    if (!t) return { error: 'empty-note' };
    state.notes.push({ at: nowIso, text: t }); changed = true;
    if (state.notes.length > 100) state.notes = state.notes.slice(-100);
  }
  if (b.token !== undefined) { state.token = String(b.token || '').trim(); changed = true; }
  if (!changed) return { error: 'nothing-to-update' };
  state.updatedAt = nowIso;
  return { state };
}
