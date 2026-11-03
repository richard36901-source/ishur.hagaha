/* ishur ops · CRM adapter: the ONLY place that knows the CRM backend's paths and field names
   (contract: docs/CRM-API-2026-11-03.md from branch crm-backend; until it lands the shape is the
   one in fixtures/ops/crm/*.json, built by scripts/build-crm-fixtures.mjs from plan §7).
   Same rule as ../adapt.js for the ops endpoints: screens call crm.* and render view-models only,
   so a field or path rename is a change here and nowhere else. Lazy-loaded with the CRM screens,
   so it costs nothing on the ops screens. Pure functions + a thin caller; no DOM. */

/* logical op → server path (POST /api/<path>, body {admin_key, ...}); app.js raw() routes any name with "/" to /api/<name> */
export const PATH = {
  leads: 'crm/leads', lead: 'crm/lead', leadUpdate: 'crm/lead-update', leadsBulk: 'crm/leads-bulk',
  notes: 'crm/notes', noteAdd: 'crm/note-add', notePin: 'crm/note-pin',
  quote: 'crm/quote', send: (id) => 'crm/leads/' + encodeURIComponent(id) + '/send', templates: 'crm/templates',
  clients: 'crm/clients', client: 'crm/client', clientAction: 'crm/client-action',
  hostesses: 'crm/hostesses', assignment: 'crm/assignment',
  agenda: 'crm/agenda', stats: 'crm/stats',
  /* fallback while crm/quote is not deployed: the existing structured pay-link endpoint (paylink-gen.js uses it) */
  payLink: '/pay-link',
};

export const STATUSES = [
  { id: 'new', he: 'חדש' }, { id: 'talking', he: 'בשיחה' }, { id: 'quoted', he: 'הצעה נשלחה' },
  { id: 'closed', he: 'סגר' }, { id: 'not_relevant', he: 'לא רלוונטי' }, { id: 'lost', he: 'נדחה' },
];
export const STATUS_HE = Object.fromEntries(STATUSES.map((s) => [s.id, s.he]));
export const SOURCE_HE = { meta_form: 'טופס מטא', site: 'אתר', whatsapp: 'וואטסאפ', referral: 'הפניה', google: 'גוגל', instagram: 'אינסטגרם', manual: 'ידני' };
export const OWNER_HE = { richard: 'ריצארד', shalev: 'שלו', noa: 'נועה', shir: 'שיר', system: 'מערכת' };
export const OCC_HE = { wedding: 'חתונה', hina: 'חינה', bar: 'בר מצווה', bat: 'בת מצווה', brit: 'ברית / בריתה', bday: 'יום הולדת', chalaka: 'חלאקה', chala: 'הפרשת חלה' };
export const PLAN_HE = { basic: 'בסיס', pro: 'פרמיום', premium: 'הכל כלול' };
export const CLIENT_ST = { setup: ['warn', 'בהקמה'], active: ['good', 'פעיל'], hold: ['serious', 'מוחזק'], done: ['', 'הסתיים'], cancelled: ['crit', 'בוטל'] };
export const DESIGN_ST = { brief: 'מחכה לבריף', draft: 'טיוטה אצל הלקוח', revision: 'בתיקונים', approved: 'אושר' };
export const ASSIGN_ST = { proposed: ['warn', 'הוצע'], confirmed: ['good', 'אישרה'], declined: ['crit', 'סירבה'], done: ['', 'בוצע'] };

const H24 = 864e5;
const ilDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(d));
export const today = (now = Date.now()) => ilDay(now);
export const isToday = (d, now = Date.now()) => !!d && ilDay(d) === ilDay(now);

/* ── view-models ── */
export function lead(l, now = Date.now()) {
  return {
    id: l.id, phone: l.phone || '', name: l.name || '', source: l.source || 'manual', source_he: SOURCE_HE[l.source] || l.source || 'ידני',
    occasion: l.occasion || '', occasion_he: OCC_HE[l.occasion] || l.occasion || '', event_date: l.event_date || null,
    records: l.records_estimate || null, status: STATUS_HE[l.status] ? l.status : 'new', owner: l.owner || '', owner_he: OWNER_HE[l.owner] || l.owner || '—',
    next_at: l.next_action_at || null, next_text: l.next_action_text || '', due_today: isToday(l.next_action_at, now), overdue: !!l.next_action_at && Date.parse(l.next_action_at) < now && !isToday(l.next_action_at, now),
    quote_id: l.quote_id || null, client_token: l.client_token || null, tags: l.tags || [], created_at: l.created_at, last_in: l.last_inbound_at || null,
    window_open: !!l.last_inbound_at && now - Date.parse(l.last_inbound_at) < H24,
  };
}
export const note = (n) => ({ id: n.id, at: n.at, by: OWNER_HE[n.by] || n.by || '', text: n.text || '', pinned: !!n.pinned, entity: n.entity, entity_id: n.entity_id });
export function act(a) {
  const k = a.kind, out = a.dir === 'out';
  const label = k === 'wa' ? (out ? 'וואטסאפ יוצא' + (a.by ? ' · ' + (OWNER_HE[a.by] || a.by) : '') : 'וואטסאפ נכנס') : k === 'call' ? 'שיחה' + (a.outcome === 'no_answer' ? ' · לא ענה' : a.duration_s ? ' · ' + Math.round(a.duration_s / 60) + ' דק׳' : '') : k === 'form' ? 'טופס' : k === 'payment' ? 'תשלום' : k === 'send' ? 'שליחה' : k === 'replies' ? 'תשובות' : k === 'note' ? 'הערה' : k;
  return { id: a.id, at: a.at, kind: k, dir: a.dir || '', label, text: a.text || '', amount: a.amount || null };
}
export function client(c) {
  const n = c.counts || {}, st = CLIENT_ST[c.status] || ['', c.status || '—'], ad = c.addons || {};
  return {
    token: c.token, tok8: String(c.token || '').slice(0, 8), name: c.name || '', phone: c.phone || '', occasion_he: OCC_HE[c.occasion] || c.occasion || '',
    event_date: c.event_date || null, event_time: c.event_time || '', venue: c.venue || '', plan: c.plan, plan_he: PLAN_HE[c.plan] || c.plan || '—', records: c.records || 0,
    status: c.status, status_tone: st[0], status_he: st[1], guests: n.guests || 0, confirmed: n.confirmed || 0, declined: n.declined || 0, pending: n.pending || 0,
    paid: c.paid || 0, paid_at: c.paid_at || null, lead_id: c.lead_id || null,
    addons: { design: ad.design || null, design_he: ad.design ? DESIGN_ST[ad.design] || ad.design : '', hostesses: ad.hostesses || 0, calls: !!ad.calls, extra_wave: !!ad.extra_wave },
    links: { dashboard: (c.links || {}).dashboard || null, upload: (c.links || {}).upload || null, feedback: (c.links || {}).feedback || null },
  };
}
export const hostess = (h) => ({ id: h.id, name: h.name, phone: h.phone || '', city: h.city || '', active: h.status !== 'inactive', rate: h.rate || 0 });
export const assignment = (a) => ({ id: a.id, hostess_id: a.hostess_id, client_token: a.client_token, event_name: a.event_name || '', date: a.date, start: a.start || '', end: a.end || '', status: a.status || 'proposed', pay: a.pay || 0, paid: !!a.paid });

/* conflicts: the same hostess on overlapping shifts the same day (declined ones don't count) */
export function conflicts(asg) {
  const out = [], live = asg.filter((a) => a.status !== 'declined');
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    if (a.hostess_id === b.hostess_id && a.date === b.date && a.start < b.end && b.start < a.end) out.push([a.id, b.id]);
  }
  return out;
}

const MAP = {
  leads: (d) => ({ items: (d.items || []).map((l) => lead(l)), as_of: d.as_of || null }),
  lead: (d) => ({ lead: lead(d.lead), notes: (d.notes || []).map(note), activity: (d.activity || []).map(act).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) }),
  clients: (d) => ({ items: (d.items || []).map(client) }),
  client: (d) => ({ client: client(d.client), notes: (d.notes || []).map(note), timeline: (d.timeline || []).map(act).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) }),
  hostesses: (d) => { const asg = (d.assignments || []).map(assignment); return { hostesses: (d.hostesses || []).map(hostess), assignments: asg, conflicts: conflicts(asg), events: d.events || [] }; },
  agenda: (d) => ({ reminders: (d.reminders || []).map((l) => lead(l)), events: (d.events || []).map(client), sends: (d.sends_today || []).map((s) => ({ token: s.client_token, name: s.name, label: s.label, at: s.at, count: s.count || 0 })) }),
  stats: (d) => ({ revenue: (d.revenue_30d || []).map((r) => ({ day: r.day, v: r.amount || 0 })), funnel: STATUSES.slice(0, 4).map((s) => ({ id: s.id, he: s.he, v: (d.funnel || {})[s.id] || 0 })), funnel_days: (d.funnel || {}).window_days || 30, sends: (d.sends_14d || []).map((r) => ({ day: r.day, v: r.wa || 0 })), calls: (d.calls_14d || []).map((r) => ({ day: r.day, v: r.calls || 0 })) }),
  notes: (d) => ({ items: (d.items || []).map(note) }),
  templates: (d) => ({ items: (d.items || []).map((t) => ({ name: t.name, label: t.label || t.name, preview: t.preview || '' })) }),
  /* send: {sent} | {needs_template, templates[]} — free text only inside the 24h window */
  send: (d) => ({ sent: !!d.sent, status: d.status || null, needs_template: !!d.needs_template, templates: (d.templates || []).map((t) => ({ name: t.name, label: t.label || t.name, preview: t.preview || '' })), queued_until: d.queued_until || null }),
  quote: (d) => ({ quote_id: d.quote_id || null, url: d.url || '', sum: d.sum != null ? d.sum : null, description: d.description || '' }),
};
export const adaptCrm = (op, d) => (!d || d.ok === false || !MAP[op] ? d : MAP[op](d));

/* request bodies (client → server field names) */
export const body = {
  leadPatch: (id, p) => ({ id, patch: { status: p.status, next_action_at: p.next_at, next_action_text: p.next_text, tags: p.tags, owner: p.owner } }),
  quote: (leadId, q) => ({ lead_id: leadId, plan: q.plan, records: Number(q.records), event_date: q.event_date || '', addons: { hostesses: Number(q.hostesses) || 0, design: !!q.design, calls: !!q.calls, extra_wave: !!q.extra_wave } }),
  /* the existing /api/pay-link takes the same structured payload plus name/phone/occasion (paylink-gen.js payload()) */
  payLink: (l, q) => ({ plan: q.plan, records: Number(q.records), name: l.name, phone: l.phone, occasion: l.occasion, event_date: q.event_date || '', addons: { design: !!q.design, hostesses: Number(q.hostesses) || 0, travel: false, extra_wave: !!q.extra_wave, calls: !!q.calls }, note: 'crm:' + l.id }),
};
const strip = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).forEach((k) => (o[k] === undefined ? delete o[k] : strip(o[k]))); return o; };

/* crm(ctx) → caller bound to the ops data layer (auth, stamp, mock, errors all come from app.js) */
export function crm(ctx) {
  const path = (op, arg) => (typeof PATH[op] === 'function' ? PATH[op](arg) : PATH[op]);
  const get = (op, b = {}, o) => ctx.api.get(path(op), b, o).then((d) => adaptCrm(op, d));
  const post = (op, b = {}, arg) => ctx.api.post(path(op, arg), strip(b)).then((d) => adaptCrm(op, d));
  return {
    get, post,
    leads: (f) => get('leads', f || {}),
    lead: (id) => get('lead', { id }, { cache: false }),
    updateLead: (id, p) => post('leadUpdate', body.leadPatch(id, p)),
    bulk: (ids, p) => post('leadsBulk', { ids, status: p.status, add_tag: p.add_tag }),
    notes: (entity, entity_id) => get('notes', { entity, entity_id }, { cache: false }),
    addNote: (entity, entity_id, text, pinned = false) => post('noteAdd', { entity, entity_id, text, pinned }),
    pinNote: (id, pinned) => post('notePin', { id, pinned }),
    async quote(l, q) {
      try { return await post('quote', body.quote(l.id, q)); }
      catch (e) { if (e && e.status === 404) return adaptCrm('quote', await ctx.api.post(PATH.payLink, body.payLink(l, q))); throw e; }
    },
    send: (id, b) => post('send', { text: b.text, quote_id: b.quote_id, template: b.template, url: b.url }, id),
    clients: () => get('clients'),
    client: (token) => get('client', { token }, { cache: false }),
    clientAction: (token, action, extra = {}) => post('clientAction', { token, action, ...extra }),
    hostesses: () => get('hostesses'),
    saveAssignment: (a) => post('assignment', { id: a.id, patch: { hostess_id: a.hostess_id, client_token: a.client_token, date: a.date, start: a.start, end: a.end, status: a.status, paid: a.paid } }),
    agenda: () => get('agenda', {}, { cache: true }),
    stats: () => get('stats'),
  };
}
