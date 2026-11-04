/* ============================================================================
   ishur.io · crm.js · the ops center as THE workplace (03/11/2026)
   ----------------------------------------------------------------------------
   docs/OPS-CENTER-PLAN-2026-11-03.md §7; the contract the frontend builds from
   is docs/CRM-API-2026-11-03.md — keep field names stable.
   Storage: store.js (D1 OPS_DB when bound, KV otherwise, same interface).

   Routes (admin auth exactly like /api/ops/*):
     GET  /api/crm/leads                 list (status, source, owner, tag, q, sort, limit, cursor)
     POST /api/crm/leads                 create a manual lead {phone, name, …}
     POST /api/crm/leads/import          {dry?, sources?:['kv','leadx','meta','monday']}
     POST /api/crm/leads/bulk            {ids[], patch{status|owner|tags|next_action_*}}
     GET  /api/crm/leads/:id             lead + notes + activities + reminders
     POST /api/crm/leads/:id             patch
     POST /api/crm/leads/:id/quote       {plan, records, addons, occasion, event_date} → link + suggested text
     POST /api/crm/leads/:id/send        {text, confirm:true} → Noa free text inside 24h, else needs_template
     GET  /api/crm/clients               merged events list
     GET  /api/crm/clients/:token        one event + timeline
     POST /api/crm/clients/:token        partial edit {name1,name2,phone,occasion,event_date[,override_past]} → only changed sheet cells
     POST /api/crm/clients/:token/action {action, confirm, …} → the existing admin routes (client-link, event-flag,
                                         grant-addon, guests-reset, client-active, design-version, ops/invoice-resend)
     GET  /api/crm/hostesses             roster      POST /api/crm/hostesses  upsert
     POST /api/crm/hostesses/:id         patch       POST /api/crm/hostesses/:id/delete {confirm:id}
     POST /api/crm/hostesses/import      roster from Monday (HOSTESS_ROSTER_BOARD) + bookings from KV
     GET  /api/crm/assignments           filters      POST /api/crm/assignments  create/update (conflict-checked)
     GET  /api/crm/assignments/conflicts ?hostess_id=&date=&start=&end=&exclude=
     GET  /api/crm/notes                 ?entity_type=&entity_id=   POST /api/crm/notes  POST /api/crm/notes/pin
     GET  /api/crm/reminders             POST /api/crm/reminders   POST /api/crm/reminders/:id
     GET  /api/crm/agenda?day=           today list for the overview
     GET  /api/crm/stats?range=          charts data

   Hooks used by the rest of the Worker:
     crmTouch(env, phone, {dir, text, ch, at, template, ok, who})   every 4499 in/out
     crmOnPaid(env, {phone, token, quoteId, sum, ref, name, simulated})  Grow IPN

   §1 pure (unit-tested)  §2 I/O
   ========================================================================== */
import { makeStore, newId, nowIso, ENTITY_TYPES } from './store.js';
import { mondayGql, digitsIl } from './monday.js';
import { buildBizStats } from './dashboard.js';
import { PLAN_HE, OCCASION_HE } from './paylink.js';
import { ilDayOf, addDays, closedFromPay } from './ops.js';
import { recordChange } from './changes.js';

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */
export const LEAD_STATUSES = ['new', 'talking', 'quoted', 'closed', 'not_relevant', 'lost'];
export const STATUS_HE = { new: 'חדש', talking: 'בשיחה', quoted: 'הצעה נשלחה', closed: 'סגר', not_relevant: 'לא רלוונטי', lost: 'נדחה' };
export const SOURCES = ['meta_form', 'whatsapp', 'web', 'manual', 'referral'];
export const HOSTESS_STATUSES = ['proposed', 'confirmed', 'done', 'paid'];
/* the Monday board's own labels (leads.js LEAD_STATUSES, read 12/10) */
export const MONDAY_TO_STATUS = { 'חדש': 'new', 'נשלח פרטים': 'quoted', 'לא ענה': 'new', 'שיחה חוזרת': 'talking', 'בטיפול': 'talking', 'סגר': 'closed', 'סגר במקום אחר': 'lost', 'לא רלוונטי': 'not_relevant' };
export const STATUS_TO_MONDAY = { new: 'חדש', talking: 'שיחה חוזרת', quoted: 'נשלח פרטים', closed: 'סגר', not_relevant: 'לא רלוונטי', lost: 'סגר במקום אחר' };
const MONDAY_BOARD = '18432553641';
const MCOL = { phone: 'phone_mm7g3mjv', status: 'status', owner: 'color_mm7g6y7g', notes: 'long_text_mm7gh65j', guests: 'numeric_mm7g6kn3' };
/* lead-facing templates on 4499 (outside the 24h window only a template may open the chat).
   Approval state lives in Meta; /api/templates shows it. _n = the ishur.io-portfolio twins. */
export const LEAD_TEMPLATES = [
  { name: 'ishur_lo_siyem', he: 'לא סיימת להזמין (תזכורת ראשונה)', category: 'marketing' },
  { name: 'ishur_lo_siyem_2', he: 'לא סיימת להזמין (יום אחרי)', category: 'marketing' },
  { name: 'ishur_lo_siyem_3', he: 'טיפ + הזמנה לחזור', category: 'marketing' },
];
const DAY = 864e5, WINDOW_MS = 24 * 3600e3;
const STATUS_RANK = { new: 0, talking: 1, quoted: 2, lost: 3, not_relevant: 3, closed: 4 };

export function phoneOf(raw) { const p = digitsIl(raw); return /^972\d{8,9}$/.test(p) ? p : ''; }
export const leadIdOf = phone => 'L' + phone;
const clean = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isoOrEmpty = v => { const t = Date.parse(v || ''); return isNaN(t) ? '' : new Date(t).toISOString(); };
const dayOrEmpty = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const recordsOf = v => { const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10); return n > 0 && n < 5000 ? n : null; };
const occOf = v => { const s = clean(v, 30); const k = Object.entries(OCCASION_HE).find(([key, he]) => key === s || he === s); return k ? k[0] : s; };
export function ilClock(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { h: Number(p.hour) % 24, dow: p.weekday };
}
/* memory rule: no WhatsApp to clients/leads 21:00–09:00, and none on Shabbat */
export function clientHoursOpen(ts) { const c = ilClock(ts); return c.dow !== 'Sat' && c.h >= 9 && c.h < 21; }

/* lead:<phone> (noteLead) → lead patch */
export function sourceOfKv(rec) {
  rec = rec || {};
  if ((rec.types || []).includes('whatsapp_in') || rec.page === 'whatsapp') return 'whatsapp';
  if (/leadform|instant-form|meta_leadform/.test(`${rec.source} ${rec.page}`)) return 'meta_form';
  if (/referral|חבר|המלצ/.test(String(rec.source || ''))) return 'referral';
  return 'web';
}
export function patchFromKvLead(phone, rec) {
  rec = rec || {};
  return { phone, name: clean(rec.name, 60), source: sourceOfKv(rec), occasion: occOf(rec.occasion), records_estimate: recordsOf(rec.guests),
    created_at: isoOrEmpty(rec.at), origin: { kv: true, page: rec.page || '', utm: clean(rec.source, 120), plan: rec.plan || '', price: rec.price || '' } };
}
/* leadx:<phone> (leads.html state: Hebrew status, owner, notes[], followup) */
export function patchFromLeadx(phone, x) {
  x = x || {};
  const p = { phone, monday_item_id: x.mondayId ? String(x.mondayId) : undefined, owner: clean(x.owner, 30) || undefined };
  if (x.status && MONDAY_TO_STATUS[x.status]) p.status = MONDAY_TO_STATUS[x.status];
  if (x.status === 'לא ענה') p.tags = ['לא ענה'];
  if (x.followup) { const f = isoOrEmpty(String(x.followup).length === 10 ? x.followup + 'T09:00:00+03:00' : x.followup); if (f) p.next_action_at = f; }
  return p;
}
/* pullMetaFormLeads({dry:true}).leads[] → lead patch */
export function patchFromMeta(l) {
  const phone = phoneOf(l.phone); if (!phone) return null;
  return { phone, name: clean(l.name, 60), source: 'meta_form', occasion: occOf(l.occasion), created_at: isoOrEmpty(l.at),
    origin: { meta_lead_id: String(l.id || ''), ad: clean(l.ad, 80), campaign: clean(l.campaign, 80) }, _note: l.extra ? 'טופס מטא: ' + clean(l.extra, 300) : '' };
}
/* a Monday item (column_values with ids/texts) → lead patch + its notes text */
export function patchFromMonday(it) {
  const col = id => clean(((it.column_values || []).find(c => c.id === id) || {}).text, 4000);
  let phone = phoneOf(col(MCOL.phone));
  if (!phone) { const m = String(it.name || '').match(/(?:\+?972|0)[\d\s-]{8,13}/); if (m) phone = phoneOf(m[0]); }
  if (!phone) return null;
  const label = col(MCOL.status);
  const p = { phone, name: clean(String(it.name || '').replace(/(?:\+?972|0)[\d\s-]{8,13}/, ''), 60), monday_item_id: String(it.id),
    created_at: isoOrEmpty(it.created_at), records_estimate: recordsOf(col(MCOL.guests)) || undefined, owner: col(MCOL.owner) || undefined };
  if (MONDAY_TO_STATUS[label]) p.status = MONDAY_TO_STATUS[label];
  if (label === 'לא ענה') p.tags = ['לא ענה'];
  const notes = String(((it.column_values || []).find(c => c.id === MCOL.notes) || {}).text || '').trim();
  return { patch: p, notes };
}

/* how an import patch lands on an existing lead: blanks are filled, nothing
   typed in the ops center is overwritten, created_at only moves earlier,
   status only moves forward (closed is final), source keeps the first seen. */
export function importMerge(existing, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null || v === '' || k.startsWith('_')) continue;
    if (!existing) { out[k] = v; continue; }
    if (k === 'created_at') { if (!existing.created_at || v < existing.created_at) out.created_at = v; continue; }
    if (k === 'status') { if ((STATUS_RANK[v] ?? 0) > (STATUS_RANK[existing.status] ?? 0) && existing.status !== 'closed' && !existing.status_by_ops) out.status = v; continue; }
    if (k === 'tags') { out.tags = v; continue; }
    if (k === 'origin') { out.origin = { ...(existing.origin || {}), ...v }; continue; }
    if (existing[k] === undefined || existing[k] === null || existing[k] === '') out[k] = v;
  }
  return out;
}

export function lastInboundMs(lead, conv) {
  return Math.max(Date.parse((lead && lead.last_inbound_at) || '') || 0, Number(conv && conv.last_in_ts) || 0, conv && !conv.last_in_ts && conv.last_dir === 'in' ? Number(conv.last_ts) || 0 : 0);
}
export function windowOpen(lead, conv, now = Date.now()) { const t = lastInboundMs(lead, conv); return !!t && now - t < WINDOW_MS; }

export function suggestedMessage(lead, quote) {
  const first = clean((lead && lead.name) || '', 40).split(' ')[0] || '';
  const occ = OCCASION_HE[quote.occasion || lead.occasion] || '';
  return [`היי${first ? ' ' + first : ''} 🙂`, `מצרפת את הקישור לתשלום${occ ? ' ל' + occ : ''}: ${quote.description} · ₪${quote.sum}`, quote.url,
    'מיד אחרי התשלום מגיע קישור להעלאת רשימת המוזמנים, ומשם אנחנו דואגים להכל.'].filter(Boolean).join('\n');
}

/* ── clients ───────────────────────────────────────────────────────────── */
export function clientStatus(e, today, { held = false } = {}) {
  if (e.cancelled) return 'cancelled';
  if (held) return 'held';
  const d = dayOrEmpty(String(e.date || '').slice(0, 10));
  if (!d || d > today) return 'upcoming';
  if (d === today) return 'live';
  return 'done';
}
/* biz (buildBizStats) + per-token KV facts → client rows. kv[token] = { paid, hostess, hostessbook, design, designflow, extrasend, callsaddon, fb, invoice, hold, wave1 }
   crmClients: rows already in the store (notes / lead link / last activity). */
export function mergeClients({ biz, subevents = [], kv = {}, crmClients = {}, today, base = 'https://ishur.io' }) {
  const out = [];
  for (const e of (biz && biz.events) || []) {
    if (!e.token) continue;
    const k = kv[e.token] || {}, c = crmClients[e.token] || {};
    const paid = k.paid || {};
    const replied = (e.confirmed || 0) + (e.declined || 0) + (e.undecided || 0);
    const fb = k.fb || null, df = k.designflow || null;
    out.push({
      token: e.token, tok8: e.token.slice(0, 8), names: e.name || e.client || '', client: e.client || '', phone: phoneOf(e.phone) || String(e.phone || ''),
      occasion: e.occasion || '', date: String(e.date || '').slice(0, 10), plan: e.plan || paid.plan || '', plan_he: PLAN_HE[e.plan || paid.plan] || e.plan || '',
      records: Number(e.tier || paid.tier) || null, paid: !!e.paid, paid_sum: Number(e.sum) || Number(String(paid.sum || '').replace(/[^\d.]/g, '')) || 0, paid_at: e.paid_at || String(paid.at || '').slice(0, 10),
      status: clientStatus(e, today, { held: !!k.hold }),
      counts: { invited: e.guests || 0, sent: k.wave1 ? (e.guests || 0) : 0, delivered: null, replied, confirmed: e.confirmed || 0, seats: e.seats || 0, declined: e.declined || 0, undecided: e.undecided || 0, pending: e.pending || 0, need_call: e.need_call || 0 },
      addons: {
        design: k.design ? (k.design.status || 'paid') : (df && df.status ? df.status : null),
        hostesses: k.hostess ? { n: Number(k.hostess.n) || 0, city: k.hostess.city || '', booked: !!k.hostessbook } : null,
        calls: !!k.callsaddon || ['pro', 'premium'].includes(e.plan), extra_wave: !!k.extrasend,
      },
      feedback: fb ? { nps: fb.nps ?? null, exp: fb.exp || '', route: fb.route || '', note: fb.note || '' } : null,
      invoice: e.invoice || (k.invoice && k.invoice.url) || '', file_uploaded: !!e.file_uploaded,
      links: { dashboard: `${base}/dashboard.html?t=${e.token}`, upload: `${base}/upload.html?t=${e.token}`, feedback: `${base}/feedback.html?t=${e.token}` },
      flags: { active: !k.inactive, hold: !!k.hold, paid: !!e.paid },
      subevents: subevents.filter(s => s.parent === e.token).map(s => ({ token: s.token, name: s.name, kind: s.kind, kind_he: s.kind_he || '' })),
      lead_id: c.lead_id || '', last_activity_at: c.last_activity_at || '', notes_count: c.notes_count || 0,
    });
  }
  return out;
}

/* ── hostesses ─────────────────────────────────────────────────────────── */
const toMin = hm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/* same hostess, same day, overlapping hours (no hours = the whole day). Returns the clashing rows. */
export function hostessConflicts(assignments, cand) {
  const s1 = toMin(cand.start), e1 = toMin(cand.end);
  return (assignments || []).filter(a => a.id !== cand.id && a.id !== cand.exclude && a.hostess_id === cand.hostess_id && a.date === cand.date && a.status !== 'cancelled')
    .filter(a => { const s2 = toMin(a.start), e2 = toMin(a.end); if (s1 == null || e1 == null || s2 == null || e2 == null) return true; return s1 < e2 && s2 < e1; });
}

/* ── agenda ────────────────────────────────────────────────────────────── */
/* everything due ON day (Israel) + everything overdue and still open, oldest first */
export function agendaFor(day, { reminders = [], leads = [], assignments = [], events = [] }, today = day) {
  const dueDay = iso => (iso ? ilDayOf(Date.parse(iso)) : '');
  const items = [];
  for (const r of reminders) {
    if (r.done) continue; const d = dueDay(r.due_at); if (!d) continue;
    if (d === day || (day === today && d < day)) items.push({ kind: 'reminder', id: r.id, at: r.due_at, overdue: d < day, entity_type: r.entity_type, entity_id: r.entity_id, text: r.text || '', owner: r.owner || '' });
  }
  for (const l of leads) {
    if (!l.next_action_at || ['closed', 'lost', 'not_relevant'].includes(l.status)) continue;
    /* a next action that IS an open reminder is listed once, as the reminder */
    if (reminders.some(r => !r.done && r.entity_type === 'lead' && r.entity_id === l.id && r.due_at === l.next_action_at)) continue;
    const d = dueDay(l.next_action_at);
    if (d === day || (day === today && d < day)) items.push({ kind: 'lead_action', id: l.id, at: l.next_action_at, overdue: d < day, entity_type: 'lead', entity_id: l.id, text: l.next_action_text || 'פעולה הבאה', name: l.name || '', phone: l.phone, status: l.status, owner: l.owner || '' });
  }
  for (const a of assignments) if (a.date === day) items.push({ kind: 'hostess_shift', id: a.id, at: a.date + 'T' + (a.start || '00:00') + ':00', overdue: false, entity_type: 'event', entity_id: a.event_token, text: `${a.hostess_name || a.hostess_id} · ${a.start || ''}${a.end ? '–' + a.end : ''}`, status: a.status });
  for (const e of events) if (e.date === day) items.push({ kind: 'event', id: e.token, at: day + 'T12:00:00', overdue: false, entity_type: 'client', entity_id: e.token, text: e.names || e.name || '', status: e.status || '' });
  items.sort((a, b) => (b.overdue - a.overdue) || String(a.at).localeCompare(String(b.at)));
  return { day, items, counts: { total: items.length, overdue: items.filter(i => i.overdue).length } };
}

/* ── stats ─────────────────────────────────────────────────────────────── */
export function rangeOf(range, today) {
  const m = /^(\d{1,3})([dwm])$/.exec(String(range || '30d')) || [null, '30', 'd'];
  const n = Math.max(1, Math.min(366, Number(m[1]) * (m[2] === 'w' ? 7 : m[2] === 'm' ? 30 : 1)));
  return { from: addDays(today, -(n - 1)), to: today, days: n, group: n <= 31 ? 'day' : n <= 120 ? 'week' : 'month' };
}
export function bucketOf(day, group) {
  if (group === 'month') return day.slice(0, 7);
  if (group === 'week') { const t = Date.parse(day + 'T12:00:00Z'); const dow = new Date(t).getUTCDay(); return new Date(t - dow * DAY).toISOString().slice(0, 10); }  /* week starts Sunday */
  return day;
}
export function buildStats({ range, today, leads = [], pay = [], out = [], status = [], calls = [], parsePaidDesc = () => null, group: g }) {
  const r = rangeOf(range, today); const group = g || r.group;
  const inR = d => d >= r.from && d <= r.to;
  const series = () => ({});
  const bump = (m, k, f, n = 1) => { m[k] = m[k] || { bucket: k }; m[k][f] = (m[k][f] || 0) + n; };
  const rev = series(), vol = series();
  for (const c of closedFromPay(pay, { parsePaidDesc })) if (inR(c.day)) { bump(rev, bucketOf(c.day, group), 'revenue', c.sum); bump(rev, bucketOf(c.day, group), 'orders'); }
  let rejected = 0, failedAsync = 0; const failBy = {};
  for (const x of out) { const d = ilDayOf(x.ts); if (!inR(d)) continue; bump(vol, bucketOf(d, group), 'sends'); if (!x.ok) { rejected++; bump(vol, bucketOf(d, group), 'failed'); const code = String(((x.data || {}).error || '').split(':')[0] || 'x'); failBy[code] = (failBy[code] || 0) + 1; } }
  for (const x of status) { const d = ilDayOf(x.ts); if (!inR(d) || String((x.data || {}).status || x.action || '').indexOf('failed') < 0) continue; failedAsync++; bump(vol, bucketOf(d, group), 'failed'); const code = String((x.data || {}).code || 'async'); failBy[code] = (failBy[code] || 0) + 1; }
  for (const x of calls) { const d = ilDayOf(x.ts); if (inR(d)) bump(vol, bucketOf(d, group), 'calls'); }
  const fill = (m, fields) => { const ks = new Set(); for (let d = r.from; d <= r.to; d = addDays(d, 1)) ks.add(bucketOf(d, group)); return [...ks].sort().map(k => ({ bucket: k, ...Object.fromEntries(fields.map(f => [f, (m[k] && m[k][f]) || 0])) })); };
  const ls = leads.filter(l => inR(ilDayOf(Date.parse(l.created_at) || 0)));
  const byStatus = Object.fromEntries(LEAD_STATUSES.map(s => [s, ls.filter(l => l.status === s).length]));
  const bySource = {}; for (const l of ls) bySource[l.source || 'unknown'] = (bySource[l.source || 'unknown'] || 0) + 1;
  const closed = ls.filter(l => l.status === 'closed');
  const closeDays = closed.map(l => (Date.parse(l.closed_at || '') - Date.parse(l.created_at || '')) / DAY).filter(x => x >= 0 && isFinite(x));
  const revenue = fill(rev, ['revenue', 'orders']);
  return {
    range: { ...r, group }, revenue, revenue_total: revenue.reduce((s, x) => s + x.revenue, 0),
    funnel: { total: ls.length, by_status: byStatus, conversion_pct: ls.length ? Math.round(1000 * closed.length / ls.length) / 10 : 0,
      quoted_or_beyond: ls.filter(l => ['quoted', 'closed'].includes(l.status) || l.quote_id).length },
    sources: bySource, avg_close_days: closeDays.length ? Math.round(10 * closeDays.reduce((a, b) => a + b, 0) / closeDays.length) / 10 : null,
    volume: fill(vol, ['sends', 'calls', 'failed']), failures: { rejected, failed_async: failedAsync, by_code: failBy },
  };
}

/* ══ §2 I/O ════════════════════════════════════════════════════════════════ */
const syncOn = env => String((env && env.CRM_MONDAY_SYNC) || 'on') !== 'off';
const jparse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const kvJson = async (env, k) => (env.RATE ? jparse(await env.RATE.get(k).catch(() => null)) : null);

/* read-only Monday pull (board 18432553641): name, phone, status, owner, notes */
export async function fetchMondayLeads(env, gql = mondayGql) {
  if (!env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token', items: [] };
  const ids = `["${MCOL.phone}","${MCOL.status}","${MCOL.owner}","${MCOL.notes}","${MCOL.guests}"]`;
  const items = []; let cursor = null;
  for (let page = 0; page < 20; page++) {
    const q = cursor ? `query($c:String!){ next_items_page(limit:100,cursor:$c){ cursor items{ id name created_at column_values(ids:${ids}){ id text } } } }`
      : `query($b:[ID!]){ boards(ids:$b){ items_page(limit:100){ cursor items{ id name created_at column_values(ids:${ids}){ id text } } } } }`;
    const r = await gql(env, q, cursor ? { c: cursor } : { b: [MONDAY_BOARD] });
    const pg = r && (cursor ? r.next_items_page : r.boards && r.boards[0] && r.boards[0].items_page);
    if (!pg) break; items.push(...(pg.items || [])); cursor = pg.cursor; if (!cursor) break;
  }
  return { ok: true, items };
}

const NOTE_CHUNK = 20, NOTE_PAUSE_MS = 250;
export async function importLeads(env, d, { dry = false, sources = ['kv', 'leadx', 'meta', 'monday'], store = makeStore(env), cursor = '', limit = 250 } = {}) {
  const res = { ok: true, dry, store: store.kind, sources: {}, created: 0, updated: 0, notes_added: 0, skipped_clients: 0, errors: [] };
  const patches = [];   /* [patch, opts] in source order: kv → leadx → meta → monday */
  const isClient = async p => !!(env.RATE && await env.RATE.get('client:' + p).catch(() => null));
  if (sources.includes('kv')) {
    const all = await d.kvPrefix(env, 'lead:').catch(() => ({}));
    res.sources.kv = Object.keys(all).length;
    for (const [ph, v] of Object.entries(all)) { const p = phoneOf(ph); const rec = jparse(v); if (p && rec) patches.push([patchFromKvLead(p, rec), {}]); }
  }
  if (sources.includes('leadx')) {
    const all = await d.kvPrefix(env, 'leadx:').catch(() => ({}));
    res.sources.leadx = Object.keys(all).length;
    for (const [ph, v] of Object.entries(all)) {
      const p = phoneOf(ph); const x = jparse(v); if (!p || !x) continue;
      patches.push([patchFromLeadx(p, x), {}]);
      for (const n of Array.isArray(x.notes) ? x.notes : []) patches.push([{ phone: p }, { note: clean(n.text, 4000), noteAt: isoOrEmpty(n.at) || undefined, origin: /^מאנדיי:/.test(n.text || '') ? 'monday' : 'leadx' }]);
    }
  }
  if (sources.includes('meta')) {
    try {
      const r = d.pullMetaFormLeads ? await d.pullMetaFormLeads(env, { dry: true, since: new Date(Date.now() - 60 * DAY).toISOString() }) : { ok: false, why: 'no-dep' };
      res.sources.meta = r.ok ? (r.leads || []).length : 'error:' + (r.why || '');
      for (const l of (r.ok && r.leads) || []) { const p = patchFromMeta(l); if (p) patches.push([p, { note: p._note, origin: 'meta' }]); }
    } catch (e) { res.errors.push('meta: ' + String(e && e.message).slice(0, 160)); }
  }
  if (sources.includes('monday')) {
    try {
      const r = await fetchMondayLeads(env, d.mondayGql || mondayGql);
      res.sources.monday = r.ok ? r.items.length : 'error:' + r.why;
      for (const it of r.items) { const m = patchFromMonday(it); if (m) patches.push([m.patch, m.notes ? { note: 'מאנדיי: ' + m.notes, noteAt: m.patch.created_at || undefined, origin: 'monday' } : {}]); }
    } catch (e) { res.errors.push('monday: ' + String(e && e.message).slice(0, 160)); }
  }
  /* ── batched, resumable apply (03/11: the per-lead upsert re-wrote crm:t:leads once per patch → "KV PUT failed: 429").
     Phones are processed in a stable (sorted) order, `limit` (default 250, keeps KV ops under the per-invocation cap) per call; `next_cursor` resumes the next call.
     Leads: computed in memory against ONE read of the table, written with ONE upsertMany (only rows that changed).
     Notes: deduped by text, written per entity in chunks of NOTE_CHUNK with a short pause between chunks.
     Re-running the same import is a no-op (0 created / 0 updated / 0 notes, no lead write). */
  const byPhone = new Map();
  for (const [p, o] of patches) { if (!p.phone) continue; (byPhone.get(p.phone) || byPhone.set(p.phone, []).get(p.phone)).push([p, o]); }
  const phones = [...byPhone.keys()].sort();
  const from = Math.max(0, parseInt(cursor, 10) || 0);
  const lim = Math.max(1, Math.min(2000, Number(limit) || 250));
  const chunk = phones.slice(from, from + lim);
  res.phones = phones.length; res.processed = chunk.length; res.unchanged = 0;
  res.next_cursor = from + lim < phones.length ? String(from + lim) : null; res.done = !res.next_cursor;
  if (dry) { for (const ph of chunk) if (await isClient(ph)) res.skipped_clients++; return res; }
  const existing = new Map((await store.all('leads')).map(l => [l.id, l]));
  const strip = r => { const { updated_at, ...x } = r || {}; return JSON.stringify(x, Object.keys(x).sort()); };
  const writes = [], noteJobs = [];
  for (const ph of chunk) {
    const id = leadIdOf(ph), before = existing.get(id) || null;
    let row = before ? { ...before } : null;
    const notes = [];
    for (const [p, o] of byPhone.get(ph)) {
      const m = importMerge(row, p);
      row = row ? { ...row, ...m } : { id, status: 'new', tags: [], ...m, phone: ph };
      if (o && o.note) notes.push({ text: o.note, at: o.noteAt || row.created_at, origin: o.origin });   /* as of this patch, like the old per-patch write */
    }
    if (!row.created_at) row.created_at = nowIso();
    /* a lead who already paid is closed, not new */
    if (await isClient(ph)) { res.skipped_clients++; if (row.status !== 'closed') { row.status = 'closed'; row.closed_at = row.closed_at || nowIso(); } }
    if (!before) { res.created++; writes.push(row); } else if (strip(before) !== strip(row)) { res.updated++; writes.push(row); } else res.unchanged++;
    if (notes.length) noteJobs.push({ id, created_at: row.created_at, notes });
  }
  if (writes.length) await store.upsertMany('leads', writes);
  const pause = d.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  for (let i = 0; i < noteJobs.length; i += NOTE_CHUNK) {
    if (i) await pause(NOTE_PAUSE_MS);
    const batch = [];
    await Promise.all(noteJobs.slice(i, i + NOTE_CHUNK).map(async j => {
      const have = new Set((await store.listNotes('lead', j.id)).map(n => n.text));
      for (const n of j.notes) {
        if (!n.text || have.has(n.text)) continue; have.add(n.text);
        /* Monday notes are the FIRST note: stamped no later than the lead itself */
        batch.push({ entity_type: 'lead', entity_id: j.id, text: n.text, author: n.origin === 'monday' ? 'מאנדיי' : 'ייבוא', at: n.at || j.created_at || nowIso(), origin: n.origin || 'import' });
      }
    }));
    if (batch.length) { await store.appendNotes(batch); res.notes_added += batch.length; }
  }
  res.writes = { leads: writes.length ? 1 : 0, note_keys: new Set(noteJobs.map(j => j.id)).size };
  if (env.RATE && res.done) await env.RATE.put('crm:imported_at', nowIso()).catch(() => {});
  return res;
}

/* every message on 4499 (in, out, phone echo) → activity on the lead/client with that phone.
   A number we never saw that writes in becomes a whatsapp lead (4499 is clients + leads only). */
export async function crmTouch(env, rawPhone, { dir = 'in', text = '', ch = 'client', at, template = '', ok = true, who = '', id } = {}) {
  if (ch !== 'client' || !env || !(env.RATE || env.OPS_DB)) return null;
  const phone = phoneOf(rawPhone); if (!phone) return null;
  const store = makeStore(env); const when = at || nowIso();
  const client = await store.findBy('clients', 'phone', phone);
  let lead = await store.get('leads', leadIdOf(phone));
  const isClient = !!client || !!(env.RATE && await env.RATE.get('client:' + phone).catch(() => null));
  if (!lead && !isClient && dir === 'in') lead = await store.upsert('leads', { id: leadIdOf(phone), phone, status: 'new', source: 'whatsapp', tags: [], created_at: when });
  const act = { kind: dir === 'in' ? 'wa_in' : 'wa_out', dir, text: String(text || '').slice(0, 500), at: when, id, meta: { template: template || undefined, ok, who: who || undefined } };
  const done = [];
  if (lead) {
    await store.appendActivity({ entity_type: 'lead', entity_id: lead.id, ...act });
    await store.upsert('leads', { id: lead.id, [dir === 'in' ? 'last_inbound_at' : 'last_outbound_at']: when });
    done.push(lead.id);
  }
  if (client) { await store.appendActivity({ entity_type: 'client', entity_id: client.id, ...act }); await store.upsert('clients', { id: client.id, last_activity_at: when }); done.push(client.id); }
  return done;
}

/* Grow IPN (processGrowPayment): close the lead by quote id, else by phone; link the client */
export async function crmOnPaid(env, { phone: rawPhone, token, quoteId = '', sum = '', ref = '', name = '', simulated = false } = {}, d = {}) {
  const phone = phoneOf(rawPhone); if (!phone || !token) return { ok: false, why: 'no-phone-or-token' };
  const store = makeStore(env); const at = nowIso();
  let lead = quoteId ? (await store.findBy('leads', 'quote_id', quoteId)) : null;
  if (!lead) lead = await store.get('leads', leadIdOf(phone));
  if (!lead) lead = await store.upsert('leads', { id: leadIdOf(phone), phone, name: clean(name, 60), source: 'web', status: 'new', tags: [], created_at: at });
  const paid = Number(String(sum).replace(/[^\d.]/g, '')) || 0;
  const row = await store.upsert('leads', { id: lead.id, status: 'closed', client_token: token, closed_at: at, paid_sum: paid, tags: simulated ? ['בדיקה'] : undefined });
  await store.appendActivity({ entity_type: 'lead', entity_id: lead.id, kind: 'payment', dir: 'in', text: `שולם ₪${sum || '?'} · ${ref}`, at, id: ref ? 'pay:' + ref : undefined, meta: { token, quote_id: quoteId, simulated } });
  await store.upsert('clients', { id: token, phone, name: clean(name, 60) || lead.name || '', lead_id: lead.id, last_activity_at: at, paid_sum: paid });
  await store.appendActivity({ entity_type: 'client', entity_id: token, kind: 'payment', dir: 'in', text: `שולם ₪${sum || '?'} · ${ref}`, at, id: ref ? 'pay:' + ref : undefined, meta: { quote_id: quoteId, lead_id: lead.id } });
  return { ok: true, lead_id: lead.id, status: row.status, client_token: token };
}

/* ops → Monday, one way (status label + appended note). Never throws. */
export async function mondayPush(env, d, lead, { note = '' } = {}, gql = (d && d.mondayGql) || mondayGql) {
  if (!syncOn(env)) return { ok: false, why: 'sync-off' };
  if (!env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token' };
  if (!lead || !lead.monday_item_id) return { ok: false, why: 'no-monday-item' };
  try {
    const v = {};
    if (STATUS_TO_MONDAY[lead.status]) v[MCOL.status] = { label: STATUS_TO_MONDAY[lead.status] };
    if (note) {
      const r = await gql(env, `query($i:[ID!]){ items(ids:$i){ column_values(ids:["${MCOL.notes}"]){ id text } } }`, { i: [String(lead.monday_item_id)] });
      const cur = String((((r && r.items && r.items[0]) || {}).column_values || [{}])[0].text || '');
      if (!cur.includes(note)) v[MCOL.notes] = { text: (cur ? cur + '\n' : '') + note };
    }
    if (!Object.keys(v).length) return { ok: true, changed: false };
    await gql(env, `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`, { b: MONDAY_BOARD, i: String(lead.monday_item_id), v: JSON.stringify(v) });
    return { ok: true, changed: true };
  } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 200) }; }
}

const LEAD_PATCH = ['name', 'status', 'owner', 'occasion', 'event_date', 'records_estimate', 'next_action_at', 'next_action_text', 'tags', 'replace_tags', 'source'];
export function validLeadPatch(b) {
  const p = {};
  for (const k of LEAD_PATCH) if (b[k] !== undefined) p[k] = b[k];
  if (p.status !== undefined && !LEAD_STATUSES.includes(p.status)) return { error: 'bad-status' };
  if (p.source !== undefined && !SOURCES.includes(p.source)) return { error: 'bad-source' };
  if (p.event_date !== undefined && p.event_date !== '' && !dayOrEmpty(p.event_date)) return { error: 'bad-date' };
  if (p.next_action_at !== undefined && p.next_action_at !== '') { const t = isoOrEmpty(p.next_action_at); if (!t) return { error: 'bad-next-action-at' }; p.next_action_at = t; }
  if (p.tags !== undefined && !Array.isArray(p.tags)) return { error: 'bad-tags' };
  if (p.records_estimate !== undefined && p.records_estimate !== null) p.records_estimate = recordsOf(p.records_estimate);
  if (p.name !== undefined) p.name = clean(p.name, 60);
  if (p.occasion !== undefined) p.occasion = occOf(p.occasion);
  if (p.next_action_text !== undefined) p.next_action_text = clean(p.next_action_text, 200);
  if (p.owner !== undefined) p.owner = clean(p.owner, 30);
  return { patch: p };
}

async function patchLead(env, d, store, lead, b, who) {
  const v = validLeadPatch(b); if (v.error) return { status: 400, body: { ok: false, error: v.error } };
  const p = v.patch; if (p.status && p.status !== lead.status) p.status_by_ops = true;
  if (p.status === 'closed' && !lead.closed_at) p.closed_at = nowIso();
  const row = await store.upsert('leads', { id: lead.id, ...p });
  let monday = null;
  if (p.status && p.status !== lead.status) {
    await store.appendActivity({ entity_type: 'lead', entity_id: lead.id, kind: 'status', text: `${STATUS_HE[lead.status] || lead.status} → ${STATUS_HE[p.status]}`, meta: { from: lead.status, to: p.status, who } });
    monday = await mondayPush(env, d, row);
  }
  return { status: 200, body: { ok: true, lead: row, monday } };
}

async function leadDetail(store, id) {
  const lead = await store.get('leads', id); if (!lead) return null;
  const [notes, activities, reminders] = await Promise.all([store.listNotes('lead', id), store.listActivities('lead', id, { limit: 200 }),
    store.list('reminders', { filter: { entity_type: 'lead', entity_id: id }, sort: 'due_at', limit: 100 })]);
  return { lead, notes, activities, reminders: reminders.items };
}

async function quoteLead(env, d, store, lead, b) {
  if (!d.makePayLink) return { status: 500, body: { ok: false, error: 'no-paylink-dep' } };
  const body = { plan: b.plan, records: b.records, addons: b.addons || {}, occasion: b.occasion || lead.occasion || '', event_date: b.event_date || lead.event_date || '',
    name: b.name || lead.name || 'לקוח', phone: lead.phone.replace(/^972/, '0') };
  const r = await d.makePayLink(env, body);
  if (!r.ok && r.why && !r.id) return { status: 400, body: { ok: false, error: r.why } };
  const quote = { id: r.id, url: r.url || '', sum: r.sum, description: r.description, lines: r.lines || [], code: r.code || '', plan: b.plan, records: Number(b.records), addons: b.addons || {},
    occasion: body.occasion, event_date: body.event_date, at: nowIso() };
  if (!quote.url) return { status: 502, body: { ok: false, error: 'link-failed', why: r.why || r.make || '', quote } };
  const row = await store.upsert('leads', { id: lead.id, quote_id: quote.id, quote, occasion: lead.occasion || occOf(body.occasion), event_date: lead.event_date || dayOrEmpty(body.event_date), records_estimate: lead.records_estimate || quote.records });
  await store.appendActivity({ entity_type: 'lead', entity_id: lead.id, kind: 'quote', text: `הצעה: ${quote.description} · ₪${quote.sum}`, meta: { quote_id: quote.id, url: quote.url } });
  return { status: 200, body: { ok: true, lead: row, quote, link: quote.url, suggested_text: suggestedMessage(row, quote) } };
}

async function sendLead(env, d, store, lead, b, now = Date.now()) {
  if (b.template) return sendLeadTemplate(env, d, store, lead, b, now);
  const text = String(b.text || '').trim();
  if (text.length < 2) return { status: 400, body: { ok: false, error: 'empty-text' } };
  if (text.length > 4000) return { status: 400, body: { ok: false, error: 'text-too-long' } };
  const conv = await kvJson(env, 'conv:' + lead.phone);
  const lastIn = lastInboundMs(lead, conv);
  if (!windowOpen(lead, conv, now)) {
    return { status: 200, body: { ok: false, error: 'needs_template', last_inbound_at: lastIn ? new Date(lastIn).toISOString() : null,
      why: lastIn ? 'החלון של 24 שעות נסגר: מותר לשלוח רק תבנית מאושרת' : 'הליד לא כתב לנו אף פעם: מותר לשלוח רק תבנית מאושרת', templates: LEAD_TEMPLATES } };
  }
  if (!clientHoursOpen(now)) return { status: 200, body: { ok: false, error: 'quiet-hours', why: 'לא שולחים ללקוחות/לידים 21:00–09:00 ובשבת' } };
  const window_closes_at = new Date(lastIn + WINDOW_MS).toISOString();
  if (b.confirm !== true) return { status: 200, body: { ok: true, preview: true, confirm_required: true, to: lead.phone.replace(/^972(\d{2})\d+(\d{3})$/, '0$1*****$2'), text, window_closes_at } };
  if (!d.sendText) return { status: 500, body: { ok: false, error: 'no-send-dep' } };
  const r = await d.sendText(env, lead.phone, text, 'client', { who: 'ops · ' + clean(b.who || 'admin', 30), name: lead.name || '' });
  /* the outbound activity itself is written by the crmTouch hook inside whatsapp.js post() */
  if (!r || !r.ok) return { status: 200, body: { ok: false, error: 'send-failed', why: String((r && r.error) || 'unknown').slice(0, 200) } };
  const to = lead.quote_id && ['new', 'talking'].includes(lead.status) ? 'quoted' : lead.status === 'new' ? 'talking' : lead.status;
  const row = await store.upsert('leads', { id: lead.id, status: to, last_outbound_at: nowIso(), status_by_ops: to !== lead.status ? true : undefined });
  if (to !== lead.status) await store.appendActivity({ entity_type: 'lead', entity_id: lead.id, kind: 'status', text: `${STATUS_HE[lead.status]} → ${STATUS_HE[to]}`, meta: { from: lead.status, to, via: 'send' } });
  const monday = to !== lead.status ? await mondayPush(env, d, row, { note: lead.quote ? `הצעה נשלחה בוואטסאפ: ${lead.quote.description} · ₪${lead.quote.sum} · ${new Date(now).toISOString().slice(0, 10)}` : '' }) : null;
  return { status: 200, body: { ok: true, sent: true, wamid: r.id || '', lead: row, monday } };
}

/* outside the 24h window only an approved template may open the chat: one of LEAD_TEMPLATES, params [first name, occasion]
   (the same ones chaseAbandonedLeads sends). Preview first; {confirm:true} sends. */
async function sendLeadTemplate(env, d, store, lead, b, now = Date.now()) {
  const t = LEAD_TEMPLATES.find(x => x.name === String(b.template));
  if (!t) return { status: 400, body: { ok: false, error: 'bad-template', templates: LEAD_TEMPLATES } };
  if (!clientHoursOpen(now)) return { status: 200, body: { ok: false, error: 'quiet-hours', why: 'לא שולחים ללקוחות/לידים 21:00–09:00 ובשבת' } };
  const first = clean(lead.name, 40).split(' ')[0] || 'היי';
  const occ = OCCASION_HE[lead.occasion] || clean(lead.occasion, 30) || 'האירוע';
  const to = lead.phone.replace(/^972(\d{2})\d+(\d{3})$/, '0$1*****$2');
  if (b.confirm !== true) return { status: 200, body: { ok: true, preview: true, confirm_required: true, to, template: t.name, text: `תבנית ${t.he} · ${first} · ${occ}` } };
  if (!d.sendClient) return { status: 500, body: { ok: false, error: 'no-send-dep' } };
  const r = await d.sendClient(env, lead.phone, t.name, [first, occ], { who: 'ops · ' + clean(b.who || 'admin', 30) });
  if (!r || !r.ok) return { status: 200, body: { ok: false, error: 'send-failed', why: String((r && r.error) || 'unknown').slice(0, 200) } };
  const st = lead.status === 'new' ? 'talking' : lead.status;
  const row = await store.upsert('leads', { id: lead.id, status: st, last_outbound_at: nowIso() });
  await store.appendActivity({ entity_type: 'lead', entity_id: lead.id, kind: 'wa_out', dir: 'out', text: 'תבנית: ' + t.he, meta: { template: t.name } });
  return { status: 200, body: { ok: true, sent: true, template: t.name, wamid: r.id || '', lead: row } };
}

/* ── client card (03/11): partial edit + actions ───────────────────────────
   The sheet row ('אירועים') is written cell by cell (sheetBatchWrite, RAW) and only for fields that changed.
   C/AI/D/F/G: client name · event title (hosts) · phone · occasion · event date. Never the whole row. */
export const CLIENT_CELLS = { names: { col: 'AI', idx: 34 }, phone: { col: 'D', idx: 3 }, occasion: { col: 'F', idx: 5 }, event_date: { col: 'G', idx: 6 } };
const OCC_BY_HE = Object.fromEntries(Object.entries(OCCASION_HE).map(([k, v]) => [v, k]));
/* body → {fields} | {error}. fields carry the SHEET values (occasion in Hebrew, phone 0-prefixed like the sheet). */
export function validClientEdit(b, today, { override = false } = {}) {
  const f = {};
  if (b.name1 !== undefined || b.name2 !== undefined) {
    const n1 = clean(b.name1, 40), n2 = clean(b.name2, 40);
    if (!n1) return { error: 'bad-name' };
    f.names = n2 ? `${n1} ו${n2}` : n1;
  } else if (b.names !== undefined) { const n = clean(b.names, 80); if (!n) return { error: 'bad-name' }; f.names = n; }
  if (b.phone !== undefined && b.phone !== '') {
    const p = digitsIl(b.phone);
    if (!/^9725\d{8}$|^972[2-9]\d{7,8}$/.test(p)) return { error: 'bad-phone' };
    f.phone = '0' + p.slice(3);
  }
  if (b.occasion !== undefined && b.occasion !== '') {
    const o = String(b.occasion).trim();
    if (!OCCASION_HE[o] && !OCC_BY_HE[o]) return { error: 'bad-occasion', allowed: Object.keys(OCCASION_HE) };
    f.occasion = OCCASION_HE[o] || o;
  }
  const date = b.event_date ?? b.date;
  if (date !== undefined && date !== '') {
    const dd = String(date).slice(0, 10);
    if (!dayOrEmpty(dd) || Number.isNaN(Date.parse(dd + 'T12:00:00Z'))) return { error: 'bad-date' };
    if (dd < today && !override) return { error: 'date-in-past', today };
    f.event_date = dd;
  }
  return { fields: f };
}
/* fields vs the current row → the cells to write (pure) */
export function clientCellDiff(row, fields, rowNum) {
  const cur = k => String((row || [])[CLIENT_CELLS[k].idx] ?? '').trim();
  const same = (k, v) => (k === 'phone' ? digitsIl(cur(k)) === digitsIl(v) : k === 'event_date' ? cur(k).slice(0, 10) === v : cur(k) === v);
  const before = {}, after = {}, data = [];
  for (const [k, v] of Object.entries(fields)) {
    if (same(k, v)) continue;
    before[k] = cur(k); after[k] = v;
    data.push({ range: `אירועים!${CLIENT_CELLS[k].col}${rowNum}`, values: [[v]] });
  }
  return { before, after, data };
}
async function eventRow(env, d, token) {
  const raw = d.fetchSnapshot ? await d.fetchSnapshot(env).catch(() => null) : null;
  const rows = (raw && raw.events && raw.events.values) || [];
  const i = rows.findIndex(r => String((r || [])[1] || '').trim() === token);
  return i < 0 ? null : { row: rows[i], rowNum: i + 2 };
}
const tok8 = t => String(t || '').slice(0, 8);
async function logClientChange(env, d, token, who, summary_he, details) {
  await recordChange(env, { kind: 'client', who, summary_he, details: { token: tok8(token), ...details } });
  if (d.slackPost) await d.slackPost(env, `🗂 ${summary_he} · אירוע ${tok8(token)}`, { urgent: false, oneoff: true }).catch(() => {});   /* oneoff: one admin edit on a client card */
}
const EDIT_HE = { 'bad-phone': 'מספר טלפון לא תקין', 'bad-occasion': 'סוג אירוע לא מהרשימה', 'date-in-past': 'התאריך כבר עבר', 'bad-date': 'תאריך לא תקין', 'bad-name': 'חסר שם', 'nothing-to-change': 'אין מה לשמור', 'sheet-write-failed': 'הכתיבה לגיליון נכשלה', 'not-found': 'האירוע לא נמצא בגיליון' };
const FIELD_HE = { names: 'שמות', phone: 'טלפון', occasion: 'סוג אירוע', event_date: 'תאריך' };
async function editClient(env, d, store, token, b, who, now = Date.now()) {
  if (!/^[0-9a-f-]{36}$/.test(token)) return { status: 400, body: { ok: false, error: 'bad-token' } };
  const v = validClientEdit(b, d.ilDate(new Date(now)), { override: b.override_past === true });
  if (v.error) return { status: 400, body: { ok: false, ...v, he: EDIT_HE[v.error] } };
  if (!Object.keys(v.fields).length) return { status: 400, body: { ok: false, error: 'nothing-to-change', he: EDIT_HE['nothing-to-change'] } };
  const hit = await eventRow(env, d, token);
  if (!hit) return { status: 404, body: { ok: false, error: 'not-found', he: EDIT_HE['not-found'] } };
  const diff = clientCellDiff(hit.row, v.fields, hit.rowNum);
  if (!diff.data.length) return { status: 200, body: { ok: true, changed: [], unchanged: true } };
  if (!d.sheetBatchWrite || !(await d.sheetBatchWrite(env, diff.data))) return { status: 502, body: { ok: false, error: 'sheet-write-failed', he: EDIT_HE['sheet-write-failed'] } };
  if (env.RATE) await env.RATE.delete('snapcache').catch(() => {});
  const changed = Object.keys(diff.after);
  const patch = { id: token, last_activity_at: nowIso() };
  if (diff.after.phone) {
    patch.phone = digitsIl(diff.after.phone);
    if (env.RATE) await env.RATE.put('client:' + patch.phone, '1').catch(() => {});
  }
  if (diff.after.names) patch.name = diff.after.names;
  await store.upsert('clients', patch);
  await store.appendActivity({ entity_type: 'client', entity_id: token, kind: 'event', text: 'עריכת פרטים: ' + changed.map(k => `${FIELD_HE[k]} ${diff.before[k] || '—'} → ${diff.after[k]}`).join(' · '), meta: { who, before: diff.before, after: diff.after } });
  await logClientChange(env, d, token, who, 'פרטי לקוח עודכנו: ' + changed.map(k => FIELD_HE[k]).join(', '), { route: 'crm/clients', before: diff.before, after: diff.after, cells: diff.data.map(x => x.range) });
  return { status: 200, body: { ok: true, changed, before: diff.before, after: diff.after, cells: diff.data.map(x => x.range) } };
}

/* every card action = one existing route. word = what the UI makes Richard type (memory rule: "שלח" for sends). */
export const CLIENT_ACTIONS = {
  send_dashboard: { word: 'שלח', send: true, title: c => `לשלוח ל${c.names} את קישור לוח הלקוח?`, body: () => 'הודעת וואטסאפ אחת מנועה (4499): בתוך חלון 24 השעות עם כפתור, אחרת בתבנית המאושרת. לא בשעות השקטות.' },
  send_upload: { word: 'שלח', send: true, title: c => `לשלוח ל${c.names} את קישור העלאת הרשימה?`, body: () => 'הודעת וואטסאפ אחת מנועה (4499): בתוך 24 השעות עם כפתור, אחרת בתבנית. לא בשעות השקטות.' },
  hold: { word: 'hold', title: c => (c.flags.hold ? `לשחרר את ${c.names} מ-hold?` : `לעצור את כל השליחות של ${c.names}?`), body: c => (c.flags.hold ? 'השליחות המתוכננות יחזרו לצאת בפעימה הבאה.' : 'אף הודעה ושיחה לאירוע הזה לא ייצאו עד שתשחררו. הרשימה והתאריכים נשארים.') },
  cancel: { word: 'ביטול', title: c => `לסמן את האירוע של ${c.names} כמבוטל?`, body: () => 'הגלים נעצרים (בוטל? = כן בגיליון). אפשר להחזיר.' },
  extra_send: { word: 'שלח', title: c => `לפתוח שליחה נוספת לאורחים של ${c.names}?`, body: c => `${c.counts.pending} אורחים שעוד לא ענו יקבלו תזכורת בגל 3, בחלון השליחה הבא (לא בשעות השקטות).` },
  add_hostess: { word: 'דיילת', safe: true, title: c => `להוסיף דיילת לאירוע של ${c.names}?`, body: () => 'נוספת דרישה לדיילת אחת. השיבוץ בלוח הדיילות, החיוב בנפרד (קישור תשלום).' },
  grant_addon: { word: 'תוסף', safe: true, title: (c, b) => `להעניק ל${c.names} ${ADDON_KINDS[b.kind] || 'תוסף'} בלי חיוב?`, body: () => 'התוסף נפתח בלי חיוב ובלי חשבונית. נרשם ביומן השינויים.' },
  reset_guests: { word: null, title: c => `למחוק את רשימת האורחים של ${c.names}?`, body: c => `${c.counts.invited} שורות נמחקות והלקוח יכול להעלות קובץ חדש, כולל תשובות שכבר התקבלו. אחרי שגל 1 יצא השרת חוסם. להקליד את מספר האורחים.` },
  invoice_resend: { word: 'חשבונית', send: true, title: c => `לשלוח שוב את החשבונית ל${c.names}?`, body: () => 'הקישור לחשבונית הקיימת נשלח שוב בוואטסאפ בתבנית החשבונית. לא בשעות השקטות.' },
  design_upload: { word: 'עיצוב', safe: true, title: c => `להעלות גרסת עיצוב לאירוע של ${c.names}?`, body: () => 'הקובץ נוסף כגרסה חדשה בתהליך העיצוב והלקוח רואה אותה.' },
  toggle_active: { word: 'פעיל', title: c => (c.flags.active ? `לסמן את ${c.names} כלא פעיל?` : `לסמן את ${c.names} כפעיל?`), body: () => 'אירוע לא פעיל לא שולח הודעות ולא שיחות.' },
  mark_paid: { word: 'שולם', title: c => (c.flags.paid ? `להסיר את סימון התשלום של ${c.names}?` : `לסמן את ${c.names} כשולם?`), body: c => (c.flags.paid ? 'אירוע שלא מסומן כשולם לא שולח הודעות.' : 'משנה רק את הסימון בגיליון (H): השליחות של האירוע נפתחות. לא נוצר תשלום ולא נשלחת חשבונית.') },
};
export const ADDON_KINDS = { design: 'עיצוב הזמנה', calls: 'שיחות AI', extrasend: 'גל תזכורת נוסף', guests: 'תוספת מוזמנים', hostess: 'דיילת' };
async function clientAction(env, d, store, token, b, who, now = Date.now()) {
  if (!/^[0-9a-f-]{36}$/.test(token)) return { status: 400, body: { ok: false, error: 'bad-token' } };
  const action = String(b.action || ''), spec = CLIENT_ACTIONS[action];
  if (!spec) return { status: 400, body: { ok: false, error: 'bad-action', actions: Object.keys(CLIENT_ACTIONS) } };
  if (!d.route) return { status: 500, body: { ok: false, error: 'no-route-dep' } };
  const list = await listClients(env, d, store, now);
  const c = list.ok ? list.clients.find(x => x.token === token) : null;
  if (!c) return { status: 404, body: { ok: false, error: 'not-found' } };
  const word = action === 'reset_guests' ? String(c.counts.invited || 0) : spec.word;
  if (String(b.confirm ?? '') !== word) return { status: 200, body: { ok: true, applied: false, confirm_required: word, title: spec.title(c, b), body: spec.body(c, b), danger: !spec.safe } };
  if (spec.send && !clientHoursOpen(now)) return { status: 200, body: { ok: false, applied: false, error: 'quiet-hours', why: 'לא שולחים ללקוחות 21:00–09:00 ובשבת' } };
  const on = typeof b.on === 'boolean' ? b.on : null;
  let r, summary, details = { action };
  switch (action) {
    case 'send_dashboard': case 'send_upload': {
      const kind = action === 'send_upload' ? 'upload' : 'dashboard';
      r = await d.route(env, '/api/client-link', { token, kind });
      summary = `נשלח ללקוח קישור ${kind === 'upload' ? 'העלאת רשימה' : 'לוח הלקוח'} (${r.via === 'button' ? 'בתוך 24 שעות' : 'תבנית'})`; details.via = r.via || null; break;
    }
    case 'hold': {
      const to = on ?? !c.flags.hold;
      r = await d.route(env, '/api/event-flag', { token, flag: 'hold', on: to, reason: clean(b.reason, 120) });
      if (r.ok) await d.route(env, '/api/client-active', { token, active: !to });
      summary = to ? 'שליחות האירוע הושהו (hold)' : 'האירוע שוחרר מ-hold'; details.before = { hold: c.flags.hold }; details.after = { hold: to }; break;
    }
    case 'cancel': {
      const to = on ?? true;
      r = await d.route(env, '/api/event-flag', { token, flag: 'cancel', on: to, reason: clean(b.reason, 120) });
      summary = to ? 'האירוע סומן כמבוטל' : 'ביטול האירוע הוסר'; details.after = { cancel: to }; break;
    }
    case 'extra_send': {
      const to = on ?? true;
      r = await d.route(env, '/api/event-flag', { token, flag: 'extrasend', on: to });
      summary = to ? 'נפתחה שליחה נוספת (גל 3)' : 'השליחה הנוספת בוטלה'; details.before = { extrasend: c.addons.extra_wave }; details.after = { extrasend: to }; break;
    }
    case 'add_hostess': {
      const n = Math.min(Math.max(parseInt(b.n, 10) || 1, 1), 5);
      r = await d.route(env, '/api/grant-addon', { token, kind: 'hostess', n });
      summary = `נוספה דרישה ל-${n} דיילות`; details.before = { hostesses: (c.addons.hostesses && c.addons.hostesses.n) || 0 }; details.after = { hostesses: details.before.hostesses + n }; break;
    }
    case 'grant_addon': {
      const kind = String(b.kind || '');
      if (!ADDON_KINDS[kind] || kind === 'hostess') return { status: 400, body: { ok: false, error: 'bad-kind', kinds: ['design', 'calls', 'extrasend', 'guests'] } };
      r = await d.route(env, '/api/grant-addon', { token, kind, n: kind === 'guests' ? Math.min(Math.max(parseInt(b.n, 10) || 50, 1), 900) : undefined });
      summary = `הוענק תוסף בלי חיוב: ${ADDON_KINDS[kind]}`; details.kind = kind; break;
    }
    case 'reset_guests': {
      r = await d.route(env, '/api/guests-reset', { token });
      summary = `רשימת המוזמנים אופסה (${r.deleted ?? 0} שורות)`; details.before = { guests: c.counts.invited }; details.after = { guests: 0 }; details.error = r.ok ? null : r.error || r.why || null; break;
    }
    case 'invoice_resend': {
      r = await d.route(env, '/api/ops/invoice-resend', { token, confirm: tok8(token) });
      summary = 'החשבונית נשלחה שוב ללקוח'; break;
    }
    case 'design_upload': {
      if (!/^[0-9a-f]{16}$/.test(String(b.media || ''))) return { status: 400, body: { ok: false, error: 'bad-media' } };
      r = await d.route(env, '/api/design-version', { token, action: 'upload', media: String(b.media), note: clean(b.note, 200) });
      summary = 'הועלתה גרסת עיצוב' + (r.versions ? ' ' + r.versions.length : ''); details.media = String(b.media); break;
    }
    case 'toggle_active': {
      const to = on ?? !c.flags.active;
      r = await d.route(env, '/api/client-active', { token, active: to });
      summary = to ? 'הלקוח סומן פעיל' : 'הלקוח סומן לא פעיל'; details.before = { active: c.flags.active }; details.after = { active: to }; break;
    }
    case 'mark_paid': {
      /* the paid cell (H) gates every send for the event; no payment, no invoice is created */
      const to = on ?? !c.flags.paid;
      const hit = await eventRow(env, d, token);
      if (!hit) return { status: 404, body: { ok: false, error: 'not-found' } };
      const ok = !!(d.sheetBatchWrite && await d.sheetBatchWrite(env, [{ range: `אירועים!H${hit.rowNum}`, values: [[to ? 'כן' : '']] }]));
      if (ok && env.RATE) await env.RATE.delete('snapcache').catch(() => {});
      r = { ok, error: ok ? '' : 'sheet-write-failed' };
      summary = to ? 'הלקוח סומן כשולם' : 'סימון התשלום הוסר'; details.before = { paid: c.flags.paid }; details.after = { paid: to }; details.cell = `H${hit.rowNum}`; break;
    }
  }
  if (!r.ok) return { status: 200, body: { ok: false, applied: false, error: r.error || r.why || 'route-failed', route_status: r.status } };
  await store.appendActivity({ entity_type: 'client', entity_id: token, kind: 'event', text: summary, meta: { who, ...details } });
  await logClientChange(env, d, token, who, summary, details);
  return { status: 200, body: { ok: true, applied: true, action, summary, result: r } };
}

/* per-token KV facts for the clients merge (bounded: one prefix scan per kind) */
async function clientKv(env, d) {
  const kinds = ['paid', 'hostess', 'hostessbook', 'design', 'designflow', 'extrasend', 'callsaddon', 'invoice', 'hold', 'inactive'];
  const res = await Promise.all(kinds.map(k => d.kvPrefix(env, k + ':').catch(() => ({}))));
  const out = {};
  kinds.forEach((k, i) => { for (const [tok, v] of Object.entries(res[i])) { if (!/^[0-9a-f-]{36}$/.test(tok)) continue; (out[tok] = out[tok] || {})[k] = jparse(v) ?? (v || true); } });
  const fb = await d.kvPrefix(env, 'fb:').catch(() => ({}));
  for (const [k, v] of Object.entries(fb)) { const tok = k.split(':')[0]; if (/^[0-9a-f-]{36}$/.test(tok) && !k.includes(':2')) (out[tok] = out[tok] || {}).fb = jparse(v); }
  const w1 = await d.kvPrefix(env, 'wave:').catch(() => ({}));
  for (const k of Object.keys(w1)) { const m = /^([0-9a-f-]{36}):1$/.exec(k); if (m) (out[m[1]] = out[m[1]] || {}).wave1 = true; }
  return out;
}
async function subeventsOf(env, d) {
  const all = await d.kvPrefix(env, 'subevent:').catch(() => ({}));
  return Object.entries(all).map(([tok, v]) => { const r = jparse(v); return r && r.parent ? { token: tok, parent: r.parent, name: r.name || '', kind: r.kind || '', kind_he: (d.SUBEVENT_KINDS && d.SUBEVENT_KINDS[r.kind] || {}).he || '' } : null; }).filter(Boolean);
}
export async function listClients(env, d, store, now = Date.now()) {
  const raw = await d.snapshotCached(env).catch(() => null);
  if (!raw) return { ok: false, error: 'no-snapshot' };
  const biz = buildBizStats(raw);
  const [kv, subevents, crm] = await Promise.all([clientKv(env, d), subeventsOf(env, d), store.all('clients')]);
  const crmClients = {};
  for (const c of crm) crmClients[c.id] = c;
  const today = d.ilDate(new Date(now));
  const clients = mergeClients({ biz, subevents, kv, crmClients, today });
  return { ok: true, at: new Date(now).toISOString(), today, clients, counts: Object.fromEntries(['upcoming', 'live', 'done', 'cancelled', 'held'].map(s => [s, clients.filter(c => c.status === s).length])) };
}
async function clientTimeline(env, d, store, token, now = Date.now()) {
  const list = await listClients(env, d, store, now);
  if (!list.ok) return { status: 502, body: list };
  const client = list.clients.find(c => c.token === token);
  if (!client) return { status: 404, body: { ok: false, error: 'not-found' } };
  const t = [];
  /* audit rows for the token: sends, replies, statuses, payments, calls (last 60 days, bounded) */
  let truncated = false;
  try {
    const from = ilDayOf(now - 60 * DAY).replace(/-/g, ''), to = ilDayOf(now).replace(/-/g, '');
    const q = await d.auditQueryEx(env, { from, to, token, limit: 3000, budget: 1500 });
    truncated = !!q.truncated;
    let delivered = 0;
    for (const r of q.items || []) {
      if (r.kind === 'wa_status') { if (/delivered|read/.test(String((r.data || {}).status || r.action || ''))) delivered++; continue; }
      if (!['wa_out', 'wa_in', 'pay', 'call', 'event'].includes(r.kind)) continue;
      t.push({ at: r.at || new Date(r.ts).toISOString(), kind: r.kind === 'wa_out' ? 'send' : r.kind === 'wa_in' ? 'reply' : r.kind === 'pay' ? 'payment' : r.kind, ok: r.ok !== false, text: String(r.action || '').slice(0, 160), source: 'audit' });
    }
    client.counts.delivered = delivered;
  } catch { truncated = true; }
  for (const n of await store.listNotes('client', token)) t.push({ at: n.at, kind: 'note', text: n.text, pinned: n.pinned, author: n.author, id: n.id, source: 'notes' });
  for (const n of await store.listNotes('event', token)) t.push({ at: n.at, kind: 'note', text: n.text, pinned: n.pinned, author: n.author, id: n.id, source: 'notes' });
  for (const a of await store.listActivities('client', token, { limit: 300 })) t.push({ at: a.at, kind: a.kind, text: a.text, dir: a.dir, source: 'crm' });
  const df = await kvJson(env, 'designflow:' + token);
  if (df) for (const h of Array.isArray(df.history) ? df.history : []) t.push({ at: h.at, kind: 'design', text: String(h.what || h.status || h.text || '').slice(0, 160), source: 'designflow' });
  if (df && df.status && !(df.history || []).length) t.push({ at: df.at || df.updated_at || '', kind: 'design', text: 'עיצוב: ' + df.status, source: 'designflow' });
  const asg = await store.list('hostess_assignments', { filter: { event_token: token }, sort: 'date', limit: 50 });
  for (const a of asg.items) t.push({ at: a.date + 'T' + (a.start || '00:00') + ':00', kind: 'hostess', text: `${a.hostess_name || a.hostess_id} · ${a.status}`, id: a.id, source: 'crm' });
  t.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { status: 200, body: { ok: true, client, timeline: t, assignments: asg.items, audit_truncated: truncated } };
}

/* ── hostesses ─────────────────────────────────────────────────────────── */
export function validHostess(b, ex) {
  const name = b.name !== undefined ? clean(b.name, 60) : ex && ex.name;
  if (!name || name.length < 2) return { error: 'bad-name' };
  const phone = b.phone !== undefined ? phoneOf(b.phone) : (ex && ex.phone) || '';
  if (b.phone !== undefined && b.phone !== '' && !phone) return { error: 'bad-phone' };
  const rate = b.rate !== undefined ? Number(b.rate) : ex && ex.rate;
  if (rate !== undefined && rate !== null && !(rate >= 0 && rate < 100000)) return { error: 'bad-rate' };
  return { row: { name, phone, city: b.city !== undefined ? clean(b.city, 40) : (ex && ex.city) || '', rate: rate ?? null, active: b.active !== undefined ? !!b.active : ex ? ex.active !== false : true } };
}
export function validAssignment(b, ex) {
  const r = { ...(ex || {}) };
  for (const k of ['hostess_id', 'event_token', 'date', 'start', 'end', 'status', 'hours', 'pay', 'hostess_name', 'note']) if (b[k] !== undefined) r[k] = b[k];
  if (!r.hostess_id) return { error: 'bad-hostess' };
  if (!/^[0-9a-f-]{8,36}$/.test(String(r.event_token || ''))) return { error: 'bad-event-token' };
  if (!dayOrEmpty(r.date)) return { error: 'bad-date' };
  for (const k of ['start', 'end']) if (r[k] && toMin(r[k]) == null) return { error: 'bad-' + k };
  r.status = r.status || 'proposed'; if (!HOSTESS_STATUSES.includes(r.status)) return { error: 'bad-status' };
  if (r.hours != null && r.hours !== '') { r.hours = Number(r.hours); if (!(r.hours > 0 && r.hours <= 16)) return { error: 'bad-hours' }; }
  if (r.pay != null && r.pay !== '') { r.pay = Number(r.pay); if (!(r.pay >= 0 && r.pay < 100000)) return { error: 'bad-pay' }; }
  return { row: r };
}
/* roster: Monday board HOSTESS_ROSTER_BOARD (read-only, name + phone + city columns by title);
   bookings: hostessbook:<token> (writeHostessBooking) + hostess:<token> (bought, not yet booked) */
async function importHostesses(env, d, store, { dry = false } = {}) {
  const out = { ok: true, dry, roster: 0, roster_created: 0, bookings: 0, bought_unbooked: [], why: [] };
  const gql = d.mondayGql || mondayGql;
  if (env.HOSTESS_ROSTER_BOARD && env.MONDAY_API_TOKEN) {
    try {
      const r = await gql(env, `query($b:[ID!]){ boards(ids:$b){ columns{ id title } items_page(limit:200){ items{ id name column_values{ id text } } } } }`, { b: [String(env.HOSTESS_ROSTER_BOARD)] });
      const bd = r && r.boards && r.boards[0];
      const byTitle = Object.fromEntries(((bd && bd.columns) || []).map(c => [c.title, c.id]));
      const colId = re => Object.entries(byTitle).find(([t]) => re.test(t));
      const pc = colId(/טלפון|נייד|phone/i), cc = colId(/עיר|אזור|city/i), rc = colId(/תעריף|שכר|rate/i);
      for (const it of (bd && bd.items_page && bd.items_page.items) || []) {
        const txt = c => (c ? String(((it.column_values || []).find(x => x.id === c[1]) || {}).text || '') : '');
        const phone = phoneOf(txt(pc)); const id = phone ? 'H' + phone : 'Hm' + it.id;
        out.roster++;
        if (dry) continue;
        const ex = await store.get('hostesses', id);
        if (!ex) out.roster_created++;
        await store.upsert('hostesses', { id, name: ex ? ex.name : clean(it.name, 60), phone: (ex && ex.phone) || phone, city: (ex && ex.city) || clean(txt(cc), 40), rate: ex && ex.rate != null ? ex.rate : (Number(txt(rc).replace(/[^\d.]/g, '')) || null), active: ex ? ex.active : true, monday_item_id: String(it.id) });
      }
    } catch (e) { out.why.push('monday: ' + String(e && e.message).slice(0, 160)); }
  } else out.why.push(env.HOSTESS_ROSTER_BOARD ? 'no MONDAY_API_TOKEN' : 'HOSTESS_ROSTER_BOARD not set: roster stays manual');
  const books = await d.kvPrefix(env, 'hostessbook:').catch(() => ({}));
  const bought = await d.kvPrefix(env, 'hostess:').catch(() => ({}));
  for (const [tok, v] of Object.entries(books)) { const b = jparse(v); if (b) out.bookings++; }
  for (const [tok, v] of Object.entries(bought)) { const h = jparse(v); if (h && !books[tok]) out.bought_unbooked.push({ token: tok, n: h.n || 0, date: h.date || '', city: h.city || '' }); }
  /* bookings carry no hostess identity (the roster link lived on Monday), so
     they are surfaced as events needing assignment, never invented as assignments */
  out.events_needing_hostess = Object.entries(books).map(([tok, v]) => { const b = jparse(v) || {}; return { token: tok, date: b.date || '', city: b.city || '', n: b.n || 0, reception: b.reception || '', start: b.start || '', end: b.end || '' }; });
  return out;
}

/* ══ the router ════════════════════════════════════════════════════════════ */
export async function handleCrm(request, env, origin, url, d) {
  const parts = url.pathname.replace(/^\/api\/crm\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch { return d.deny(400, 'bad-json', origin); } }
  else if (request.method !== 'GET') return d.deny(405, 'method', origin);
  const hk = request.headers.get('X-Admin-Key') || String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await d.adminKeyOk(env, body.admin_key || hk))) return d.deny(403, 'bad-admin-key', origin);
  const q = k => body[k] ?? url.searchParams.get(k);
  const json = (o, status = 200) => status === 200 ? d.okJson(o, origin) : new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...d.cors(origin) } });
  const res = r => json(r.body, r.status);
  const isPost = request.method === 'POST';
  const who = clean(body.who || 'admin', 40);
  let store; try { store = makeStore(env); } catch (e) { return json({ ok: false, error: 'no-store' }, 503); }
  const listQ = (filterKeys) => {
    const filter = {};
    for (const k of filterKeys) { const v = q(k); if (v !== null && v !== undefined && v !== '') filter[k === 'tag' ? 'tags' : k] = Array.isArray(v) ? v : String(v).includes(',') ? String(v).split(',') : v; }
    return { filter, q: q('q') || '', sort: q('sort') || undefined, limit: q('limit') || 50, cursor: q('cursor') || '' };
  };
  try {
    const [a, b, c] = parts;
    switch (a) {
      case 'leads': {
        if (!b) {
          if (isPost) {
            const phone = phoneOf(body.phone); if (!phone) return json({ ok: false, error: 'bad-phone' }, 400);
            const v = validLeadPatch({ source: 'manual', ...body }); if (v.error) return json({ ok: false, error: v.error }, 400);
            const ex = await store.get('leads', leadIdOf(phone));
            if (ex) return json({ ok: true, existed: true, lead: ex });
            const row = await store.upsert('leads', { id: leadIdOf(phone), phone, status: 'new', tags: [], ...v.patch });
            await store.appendActivity({ entity_type: 'lead', entity_id: row.id, kind: 'created', text: 'נוצר ידנית', meta: { who } });
            return json({ ok: true, existed: false, lead: row });
          }
          /* lazy KV sync: a list call refreshes from lead:/leadx: at most every 10 minutes (no external calls) */
          const last = env.RATE ? await env.RATE.get('crm:kvsync_at').catch(() => null) : null;
          let synced = null;
          if (!last || Date.now() - Date.parse(last) > 10 * 60e3) {
            if (env.RATE) await env.RATE.put('crm:kvsync_at', nowIso()).catch(() => {});
            /* resumable: a big lead: set is synced 250 phones per list call, continuing from the saved cursor */
            const cur = env.RATE ? await env.RATE.get('crm:kvsync_cursor').catch(() => null) : null;
            synced = await importLeads(env, d, { sources: ['kv', 'leadx'], store, cursor: cur || '' }).catch(e => ({ ok: false, why: String(e && e.message) }));
            if (env.RATE && synced && synced.ok) await env.RATE.put('crm:kvsync_cursor', synced.next_cursor || '').catch(() => {});
            if (env.RATE && synced && synced.next_cursor) await env.RATE.delete('crm:kvsync_at').catch(() => {});   /* not done: next list call continues */
          }
          const lq = listQ(['status', 'source', 'owner', 'tag', 'occasion']);
          if (q('due') === 'overdue') lq.filter.next_action_at = { to: nowIso(), empty: false };
          const r = await store.list('leads', { ...lq, sort: lq.sort || '-updated_at' });
          const all = await store.all('leads');
          const by_status = Object.fromEntries(LEAD_STATUSES.map(s => [s, all.filter(l => l.status === s).length]));
          return json({ ok: true, store: store.kind, ...r, by_status, statuses: LEAD_STATUSES.map(s => ({ id: s, he: STATUS_HE[s] })), sources: SOURCES, synced: synced ? { created: synced.created, updated: synced.updated, next_cursor: synced.next_cursor ?? null } : null });
        }
        if (b === 'import') {
          if (!isPost) return json({ ok: false, error: 'POST-only' }, 405);
          const sources = Array.isArray(body.sources) && body.sources.length ? body.sources.filter(s => ['kv', 'leadx', 'meta', 'monday'].includes(s)) : undefined;
          return json(await importLeads(env, d, { dry: body.dry === true, sources, store, cursor: body.cursor || '', limit: body.limit }));
        }
        if (b === 'bulk') {
          if (!isPost) return json({ ok: false, error: 'POST-only' }, 405);
          const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : [];
          if (!ids.length) return json({ ok: false, error: 'no-ids' }, 400);
          const v = validLeadPatch(body.patch || {}); if (v.error) return json({ ok: false, error: v.error }, 400);
          const results = [];
          for (const id of ids) { const l = await store.get('leads', id); if (!l) { results.push({ id, ok: false, error: 'not-found' }); continue; } const r = await patchLead(env, d, store, l, body.patch, who); results.push({ id, ok: r.body.ok, error: r.body.error }); }
          return json({ ok: true, results, changed: results.filter(r => r.ok).length });
        }
        const lead = await store.get('leads', b);
        if (!lead) return json({ ok: false, error: 'not-found' }, 404);
        if (!c) {
          if (isPost) return res(await patchLead(env, d, store, lead, body, who));
          return json({ ok: true, ...(await leadDetail(store, b)) });
        }
        if (!isPost) return json({ ok: false, error: 'POST-only' }, 405);
        if (c === 'quote') return res(await quoteLead(env, d, store, lead, body));
        if (c === 'send') return res(await sendLead(env, d, store, lead, body));
        return json({ ok: false, error: 'unknown-crm-route' }, 404);
      }
      case 'clients': {
        if (!b) return json(await listClients(env, d, store));
        if (isPost && !c) return res(await editClient(env, d, store, b, body, who));
        if (isPost && c === 'action') return res(await clientAction(env, d, store, b, body, who));
        if (c) return json({ ok: false, error: 'unknown-crm-route' }, 404);
        return res(await clientTimeline(env, d, store, b));
      }
      case 'hostesses': {
        if (!b) {
          if (isPost) {
            const id = body.id ? String(body.id) : (phoneOf(body.phone) ? 'H' + phoneOf(body.phone) : newId('H'));
            const ex = await store.get('hostesses', id);
            const v = validHostess(body, ex); if (v.error) return json({ ok: false, error: v.error }, 400);
            return json({ ok: true, created: !ex, hostess: await store.upsert('hostesses', { id, ...v.row }) });
          }
          const r = await store.list('hostesses', { ...listQ(['city', 'active']), sort: q('sort') || 'name', limit: q('limit') || 200 });
          return json({ ok: true, store: store.kind, ...r });
        }
        if (b === 'import') { if (!isPost) return json({ ok: false, error: 'POST-only' }, 405); return json(await importHostesses(env, d, store, { dry: body.dry === true })); }
        const h = await store.get('hostesses', b); if (!h) return json({ ok: false, error: 'not-found' }, 404);
        if (!isPost) {
          const asg = await store.list('hostess_assignments', { filter: { hostess_id: b }, sort: '-date', limit: 200 });
          return json({ ok: true, hostess: h, assignments: asg.items, notes: await store.listNotes('hostess', b) });
        }
        if (c === 'delete') {
          if (body.confirm !== b) return json({ ok: true, applied: false, confirm_required: b, why: 'deactivate with {active:false}; delete removes the roster row for good' });
          await store.remove('hostesses', b); return json({ ok: true, applied: true, deleted: b });
        }
        const v = validHostess(body, h); if (v.error) return json({ ok: false, error: v.error }, 400);
        return json({ ok: true, hostess: await store.upsert('hostesses', { id: b, ...v.row }) });
      }
      case 'assignments': {
        if (b === 'conflicts') {
          const all = (await store.list('hostess_assignments', { filter: { hostess_id: String(q('hostess_id') || ''), date: String(q('date') || '') }, limit: 500 })).items;
          return json({ ok: true, conflicts: hostessConflicts(all, { hostess_id: String(q('hostess_id') || ''), date: String(q('date') || ''), start: q('start') || '', end: q('end') || '', exclude: q('exclude') || '' }) });
        }
        if (!isPost) {
          const lq = listQ(['hostess_id', 'event_token', 'status']);
          if (q('from') || q('to')) lq.filter.date = { from: q('from') || undefined, to: q('to') || undefined };
          return json({ ok: true, ...(await store.list('hostess_assignments', { ...lq, sort: lq.sort || 'date', limit: q('limit') || 200 })) });
        }
        const id = String(body.id || b || '') || newId('S');
        const ex = await store.get('hostess_assignments', id);
        const v = validAssignment(body, ex); if (v.error) return json({ ok: false, error: v.error }, 400);
        const h = await store.get('hostesses', v.row.hostess_id); if (!h) return json({ ok: false, error: 'unknown-hostess' }, 400);
        const same = (await store.list('hostess_assignments', { filter: { hostess_id: v.row.hostess_id, date: v.row.date }, limit: 500 })).items;
        const conflicts = hostessConflicts(same, { ...v.row, id });
        /* a status/pay edit on an existing row does not re-litigate a clash that was already forced */
        const moved = !ex || ['hostess_id', 'date', 'start', 'end'].some(k => String(ex[k] || '') !== String(v.row[k] || ''));
        if (conflicts.length && moved && body.force !== true) return json({ ok: false, error: 'conflict', conflicts }, 409);
        const row = await store.upsert('hostess_assignments', { id, ...v.row, hostess_name: h.name });
        if (!ex || ex.status !== row.status) await store.appendActivity({ entity_type: 'event', entity_id: row.event_token, kind: 'hostess', text: `${h.name} · ${row.date} · ${row.status}`, meta: { assignment: id, who } });
        return json({ ok: true, created: !ex, assignment: row, conflicts });
      }
      case 'notes': {
        if (b === 'pin') {
          if (!isPost) return json({ ok: false, error: 'POST-only' }, 405);
          const n = await store.setNotePinned(String(body.entity_type), String(body.entity_id), String(body.id), !!body.pinned);
          return n ? json({ ok: true, note: n }) : json({ ok: false, error: 'not-found' }, 404);
        }
        const et = String(q('entity_type') || ''), eid = String(q('entity_id') || '');
        if (!ENTITY_TYPES.includes(et) || !eid) return json({ ok: false, error: 'bad-entity', entity_types: ENTITY_TYPES }, 400);
        if (!isPost) return json({ ok: true, notes: await store.listNotes(et, eid) });
        const text = String(body.text || '').trim(); if (!text) return json({ ok: false, error: 'empty-text' }, 400);
        const note = await store.appendNote({ entity_type: et, entity_id: eid, text, author: body.author || who, pinned: !!body.pinned });
        await store.appendActivity({ entity_type: et, entity_id: eid, kind: 'note', text: text.slice(0, 200), meta: { note_id: note.id, who: note.author } });
        let monday = null;
        if (et === 'lead' && body.monday !== false) { const l = await store.get('leads', eid); if (l) { await store.upsert('leads', { id: eid }); monday = await mondayPush(env, d, l, { note: `${note.at.slice(0, 10)} · ${note.author}: ${text.slice(0, 500)}` }); } }
        return json({ ok: true, note, monday });
      }
      case 'reminders': {
        if (!isPost) {
          const lq = listQ(['entity_type', 'entity_id', 'owner']);
          lq.filter.done = q('done') === null || q('done') === undefined ? false : String(q('done')) === 'true' || String(q('done')) === '1';
          if (q('due_before')) lq.filter.due_at = { to: isoOrEmpty(q('due_before')) || q('due_before') };
          return json({ ok: true, ...(await store.list('reminders', { ...lq, sort: lq.sort || 'due_at', limit: q('limit') || 200 })) });
        }
        const id = b || newId('R'); const ex = b ? await store.get('reminders', b) : null;
        if (b && !ex) return json({ ok: false, error: 'not-found' }, 404);
        const r = { ...(ex || {}) };
        for (const k of ['entity_type', 'entity_id', 'due_at', 'text', 'owner', 'done']) if (body[k] !== undefined) r[k] = body[k];
        if (!ENTITY_TYPES.includes(r.entity_type) || !r.entity_id) return json({ ok: false, error: 'bad-entity' }, 400);
        r.due_at = isoOrEmpty(r.due_at); if (!r.due_at) return json({ ok: false, error: 'bad-due-at' }, 400);
        r.text = clean(r.text, 300); r.done = !!r.done; if (r.done && !(ex && ex.done)) r.done_at = nowIso();
        const row = await store.upsert('reminders', { id, ...r });
        /* a lead's earliest open reminder is its next action */
        if (row.entity_type === 'lead') {
          const open = (await store.list('reminders', { filter: { entity_type: 'lead', entity_id: row.entity_id, done: false }, sort: 'due_at', limit: 1 })).items[0];
          const l = await store.get('leads', row.entity_id);
          if (l) await store.upsert('leads', { id: l.id, next_action_at: open ? open.due_at : '', next_action_text: open ? open.text : '' });
        }
        return json({ ok: true, created: !ex, reminder: row });
      }
      case 'agenda': {
        const today = d.ilDate(new Date());
        const day = dayOrEmpty(q('day')) || today;
        const [reminders, leads, asg] = await Promise.all([store.all('reminders'), store.all('leads'), store.list('hostess_assignments', { filter: { date: day }, limit: 500 })]);
        let events = [];
        if (q('events') !== '0') { const cl = await listClients(env, d, store).catch(() => null); events = cl && cl.ok ? cl.clients.filter(x => x.date === day && x.status !== 'cancelled') : []; }
        return json({ ok: true, ...agendaFor(day, { reminders, leads, assignments: asg.items, events }, today) });
      }
      case 'stats': {
        const today = d.ilDate(new Date());
        const r = rangeOf(q('range') || '30d', today);
        const from = r.from.replace(/-/g, ''), to = r.to.replace(/-/g, '');
        const aq = kind => d.auditQueryEx(env, { from, to, kind, limit: 20000, budget: 1500 }).catch(() => ({ items: [], truncated: true }));
        const [pay, out, st, calls, leads] = await Promise.all([aq('pay'), aq('wa_out'), aq('wa_status'), aq('call'), store.all('leads')]);
        const g = ['day', 'week', 'month'].includes(q('group')) ? q('group') : undefined;
        return json({ ok: true, at: nowIso(), ...buildStats({ range: q('range') || '30d', today, leads, pay: pay.items, out: out.items, status: st.items, calls: calls.items, parsePaidDesc: d.parsePaidDesc || (() => null), group: g }),
          audit_truncated: !!(pay.truncated || out.truncated || st.truncated || calls.truncated) });
      }
      default: return json({ ok: false, error: 'unknown-crm-route', routes: ['leads', 'leads/import', 'leads/bulk', 'leads/:id', 'leads/:id/quote', 'leads/:id/send', 'clients', 'clients/:token', 'hostesses', 'hostesses/import', 'hostesses/:id', 'assignments', 'assignments/conflicts', 'notes', 'notes/pin', 'reminders', 'reminders/:id', 'agenda', 'stats'] }, 404);
    }
  } catch (e) {
    return json({ ok: false, error: 'crm-failed', why: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

/* brain check: overdue reminders + lead next actions (brain.js CHECKS) */
export async function overdueCount(env, now = Date.now()) {
  const store = makeStore(env); const iso = new Date(now).toISOString();
  const [rem, leads] = await Promise.all([store.all('reminders'), store.all('leads')]);
  const r = rem.filter(x => !x.done && x.due_at && x.due_at < iso);
  const l = leads.filter(x => x.next_action_at && x.next_action_at < iso && !['closed', 'lost', 'not_relevant'].includes(x.status) && !r.some(y => y.entity_type === 'lead' && y.entity_id === x.id));
  return { reminders: r, leads: l };
}
