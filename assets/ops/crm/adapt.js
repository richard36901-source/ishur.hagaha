/* ishur ops · CRM adapter: the ONLY place that knows the CRM paths and field names (docs/CRM-API-2026-11-03.md,
   worker/crm.js). Fixtures: masked live GETs (scripts/crm-fixtures-from-live.mjs). Screens render view-models only.
   Reads: GET via app.js raw opts.qs (query + X-Admin-Key header, never the key in the URL). Writes: POST bodies per
   the doc; opts.soft returns {ok:false} answers (send) instead of throwing. Lazy; pure + a thin caller. */
if (typeof document !== 'undefined' && !document.getElementById('crm-css')) document.head.insertAdjacentHTML('beforeend', '<link id="crm-css" rel="stylesheet" href="assets/ops/crm.css?v=2">');

const enc = encodeURIComponent;
/* logical op → server path (app.js raw() sends any name with "/" to /api/<name>) */
export const PATH = {
  leads: 'crm/leads', lead: (id) => 'crm/leads/' + enc(id), leadUpdate: (id) => 'crm/leads/' + enc(id), leadsBulk: 'crm/leads/bulk',
  quote: (id) => 'crm/leads/' + enc(id) + '/quote', send: (id) => 'crm/leads/' + enc(id) + '/send',
  notes: 'crm/notes', noteAdd: 'crm/notes', notePin: 'crm/notes/pin',
  clients: 'crm/clients', client: (t) => 'crm/clients/' + enc(t),
  hostesses: 'crm/hostesses', assignments: 'crm/assignments', assignment: 'crm/assignments',
  agenda: 'crm/agenda', stats: 'crm/stats',
};
export const LEADS_Q = { limit: 500 };
export const STATS_Q = { range: '30d' };

export const STATUSES = [
  { id: 'new', he: 'חדש' }, { id: 'talking', he: 'בשיחה' }, { id: 'quoted', he: 'הצעה נשלחה' },
  { id: 'closed', he: 'סגר' }, { id: 'not_relevant', he: 'לא רלוונטי' }, { id: 'lost', he: 'נדחה' },
];
export const STATUS_HE = Object.fromEntries(STATUSES.map((s) => [s.id, s.he]));
/* worker/crm.js SOURCES: meta_form · whatsapp · web · manual · referral */
export const SOURCE_HE = { meta_form: 'טופס מטא', web: 'אתר', whatsapp: 'וואטסאפ', referral: 'הפניה', manual: 'ידני' };
/* the server stores the owner as typed (Monday "אחראי": שלו / ריצארד); ids are mapped for older rows */
export const OWNER_HE = { richard: 'ריצארד', shalev: 'שלו', noa: 'נועה', shir: 'שיר', system: 'מערכת' };
/* owners offered in the lead drawer: whatever the server's leads carry (filled by the leads view-model) */
export const OWNERS = ['ריצארד', 'שלו'];
export const OCC_HE = { wedding: 'חתונה', hina: 'חינה', bar: 'בר מצווה', bat: 'בת מצווה', brit: 'ברית / בריתה', bday: 'יום הולדת', chalaka: 'חלאקה', chala: 'הפרשת חלה' };
export const PLAN_HE = { basic: 'בסיס', pro: 'פרמיום', premium: 'הכל כלול' };
/* server client status (clientStatus): upcoming · live · done · cancelled · held → view status (held → hold) */
export const CLIENT_ST = { upcoming: ['info', 'לפני האירוע'], live: ['good', 'היום'], hold: ['serious', 'מוחזק'], done: ['', 'הסתיים'], cancelled: ['crit', 'בוטל'] };
export const DESIGN_ST = { paid: 'נרכש', brief: 'מחכה לבריף', draft: 'טיוטה אצל הלקוח', revision: 'בתיקונים', approved: 'אושר' };
/* server HOSTESS_STATUSES: proposed · confirmed · done · paid. "paid" is shown as done + the paid toggle */
export const ASSIGN_ST = { proposed: ['warn', 'הוצע'], confirmed: ['good', 'אישרה'], done: ['', 'בוצע'] };
/* worker/crm.js LEAD_TEMPLATES (also returned inside every needs_template answer) */
export const TEMPLATES = [
  { name: 'ishur_lo_siyem', he: 'לא סיימת להזמין (תזכורת ראשונה)', category: 'marketing' },
  { name: 'ishur_lo_siyem_2', he: 'לא סיימת להזמין (יום אחרי)', category: 'marketing' },
  { name: 'ishur_lo_siyem_3', he: 'טיפ + הזמנה לחזור', category: 'marketing' },
];

const H24 = 864e5;
const ilDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(d));
export const today = (now = Date.now()) => ilDay(now);
export const isToday = (d, now = Date.now()) => !!d && ilDay(d) === ilDay(now);
const nz = (v) => (v === '' || v === undefined ? null : v);

/* ── view-models ── */
export function lead(l, now = Date.now()) {
  return {
    id: l.id, phone: l.phone || '', name: l.name || '', source: l.source || 'manual', source_he: SOURCE_HE[l.source] || l.source || 'ידני',
    occasion: l.occasion || '', occasion_he: OCC_HE[l.occasion] || l.occasion || '', event_date: nz(l.event_date),
    records: l.records_estimate || null, status: STATUS_HE[l.status] ? l.status : 'new', owner: l.owner || '', owner_he: OWNER_HE[l.owner] || l.owner || '—',
    next_at: nz(l.next_action_at), next_text: l.next_action_text || '', due_today: isToday(nz(l.next_action_at), now), overdue: !!nz(l.next_action_at) && Date.parse(l.next_action_at) < now && !isToday(l.next_action_at, now),
    quote_id: l.quote_id || null, client_token: l.client_token || null, tags: l.tags || [], created_at: l.created_at, last_in: nz(l.last_inbound_at),
    window_open: !!nz(l.last_inbound_at) && now - Date.parse(l.last_inbound_at) < H24,
    monday_item_id: l.monday_item_id || null,
  };
}
export const note = (n) => ({ id: n.id, at: n.at, by: OWNER_HE[n.author] || n.author || '', text: n.text || '', pinned: !!n.pinned, entity: n.entity_type, entity_id: n.entity_id, origin: n.origin || '' });
/* activity kinds: lead (wa_in · wa_out · quote · status · payment · note · created · hostess) and client timeline (send · reply · payment · call · event · note · design · hostess) */
const ACT_HE = { quote: 'הצעת מחיר', status: 'סטטוס', payment: 'תשלום', note: 'הערה', created: 'נוצר', hostess: 'דיילת', send: 'שליחה', reply: 'תשובה', call: 'שיחה', event: 'אירוע', design: 'עיצוב' };
export function act(a) {
  const k = a.kind || '', m = a.meta || {};
  const wa = k === 'wa_in' || k === 'wa_out', out = k === 'wa_out' || a.dir === 'out';
  const who = m.who || m.by || '';
  const label = wa ? (out ? 'וואטסאפ יוצא' + (who ? ' · ' + (who === 'phone' ? 'מהטלפון' : OWNER_HE[who] || who) : '') + (m.template ? ' · תבנית' : '') : 'וואטסאפ נכנס') : (ACT_HE[k] || k);
  const kind = wa ? 'wa' : k === 'reply' ? 'replies' : k;
  return { id: a.id, at: a.at, kind, dir: wa ? (out ? 'out' : 'in') : a.dir || (k === 'reply' ? 'in' : 'out'), label, text: a.text || '', amount: a.amount || m.sum || null };
}
export function client(c) {
  const n = c.counts || {}, status = c.status === 'held' ? 'hold' : c.status, st = CLIENT_ST[status] || ['', c.status || '—'], ad = c.addons || {};
  const host = ad.hostesses && typeof ad.hostesses === 'object' ? Number(ad.hostesses.n) || 0 : Number(ad.hostesses) || 0;
  return {
    token: c.token, tok8: c.tok8 || String(c.token || '').slice(0, 8), name: c.names || c.client || '', name1: c.name1 || '', name2: c.name2 || '', phone: c.phone || '', occasion: c.occasion || '', occasion_he: OCC_HE[c.occasion] || c.occasion || '',
    event_date: nz(c.date), event_time: '', venue: '', plan: c.plan, plan_he: c.plan_he || PLAN_HE[c.plan] || c.plan || '—', records: c.records || 0,
    status, status_tone: st[0], status_he: st[1], guests: n.invited || 0, confirmed: n.confirmed || 0, declined: n.declined || 0, pending: n.pending || 0,
    sent: n.sent || 0, delivered: n.delivered ?? null, need_call: n.need_call || 0,
    paid: Number(c.paid_sum) || 0, paid_at: nz(c.paid_at), lead_id: c.lead_id || null,
    addons: { design: ad.design || null, design_he: ad.design ? DESIGN_ST[ad.design] || ad.design : '', hostesses: host, hostess_city: (ad.hostesses && ad.hostesses.city) || '', hostess_booked: !!(ad.hostesses && ad.hostesses.booked), calls: !!ad.calls, extra_wave: !!ad.extra_wave },
    links: { dashboard: (c.links || {}).dashboard || null, upload: (c.links || {}).upload || null, feedback: (c.links || {}).feedback || null },
  };
}
export const hostess = (h) => ({ id: h.id, name: h.name, phone: h.phone || '', city: h.city || '', active: h.active !== false, rate: Number(h.rate) || 0 });
export const assignment = (a, names = {}) => ({ id: a.id, hostess_id: a.hostess_id, client_token: a.event_token, event_name: names[a.event_token] || a.event_name || String(a.event_token || '').slice(0, 8), date: a.date, start: a.start || '', end: a.end || '', status: a.status === 'paid' ? 'done' : a.status || 'proposed', pay: Number(a.pay) || 0, paid: a.status === 'paid' });

/* conflicts: the same hostess on overlapping shifts the same day (server rule: no hours = the whole day) */
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? +m[1] * 60 + +m[2] : null; };
export function conflicts(asg) {
  const out = [], live = asg.filter((a) => a.status !== 'declined' && a.status !== 'cancelled');
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    if (a.hostess_id !== b.hostess_id || a.date !== b.date) continue;
    const s1 = toMin(a.start), e1 = toMin(a.end), s2 = toMin(b.start), e2 = toMin(b.end);
    if (s1 == null || e1 == null || s2 == null || e2 == null || (s1 < e2 && s2 < e1)) out.push([a.id, b.id]);
  }
  return out;
}

/* events that bought hostesses (clients list addons.hostesses.n) vs the assignments they have */
export function hostessNeeds(clients, asg) {
  return clients.filter((c) => c.addons.hostesses > 0 && !['done', 'cancelled'].includes(c.status))
    .map((c) => ({ client_token: c.token, name: c.name, date: c.event_date, need: c.addons.hostesses, have: asg.filter((a) => a.client_token === c.token).length }));
}
const funnelOf = (by = {}, total = 0) => {
  /* a lead that reached a later stage passed the earlier ones: new = everyone, talking = talking + quoted + closed … */
  const reach = { new: total, talking: (by.talking || 0) + (by.quoted || 0) + (by.closed || 0), quoted: (by.quoted || 0) + (by.closed || 0), closed: by.closed || 0 };
  return STATUSES.slice(0, 4).map((s) => ({ id: s.id, he: s.he, v: reach[s.id] || 0 }));
};
const tpl = (t) => ({ name: t.name, label: t.he || t.label || t.name, preview: t.preview || '' });

const MAP = {
  leads: (d) => {
    const items = (d.items || []).map((l) => lead(l));
    for (const o of new Set((d.items || []).map((l) => l.owner).filter(Boolean))) if (!OWNERS.includes(o)) OWNERS.push(o);
    return { items, total: d.total ?? items.length, next_cursor: d.next_cursor || null, by_status: d.by_status || {}, owners: OWNERS.slice(), store: d.store || '', synced: d.synced || null, as_of: d.as_of || null };
  },
  lead: (d) => ({ lead: lead(d.lead), notes: (d.notes || []).map(note), activity: (d.activities || []).map(act).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), reminders: d.reminders || [] }),
  clients: (d) => ({ items: (d.clients || []).map(client), counts: d.counts || {}, today: d.today || null }),
  client: (d) => {
    const tl = d.timeline || [];
    return { client: client(d.client), notes: tl.filter((t) => t.kind === 'note' && t.source === 'notes').map((t) => note({ ...t, entity_type: 'client', entity_id: d.client.token })),
      timeline: tl.filter((t) => !(t.kind === 'note' && t.source === 'notes')).map(act).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), assignments: (d.assignments || []).map((a) => assignment(a)) };
  },
  /* composed from GET hostesses + assignments + clients (see crm().hostesses) */
  hostesses: (d) => {
    const cl = (d.clients || []).map((c) => (c.token && c.counts ? client(c) : c)), names = Object.fromEntries(cl.map((c) => [c.token, c.name]));
    const asg = (d.assignments || []).map((a) => assignment(a, names));
    return { hostesses: (d.hostesses || []).map(hostess), assignments: asg, conflicts: conflicts(asg), events: d.events || hostessNeeds(cl, asg) };
  },
  /* GET agenda items (reminder · lead_action · hostess_shift · event) + the clients list for event details */
  agenda: (d) => {
    const items = d.items || [], cl = Object.fromEntries((d.clients || []).map((c) => [c.token, client(c)]));
    return {
      reminders: items.filter((i) => i.kind === 'reminder' || i.kind === 'lead_action').map((i) => ({ id: i.entity_type === 'lead' ? i.entity_id : i.id, name: i.name || '', phone: i.phone || '', next_at: i.at, next_text: i.text || '', overdue: !!i.overdue, owner: i.owner || '' })),
      events: items.filter((i) => i.kind === 'event').map((i) => cl[i.entity_id] || client({ token: i.entity_id, names: i.text, status: i.status })),
      shifts: items.filter((i) => i.kind === 'hostess_shift').map((i) => ({ id: i.id, at: i.at, text: i.text, token: i.entity_id, status: i.status })),
      sends: [], counts: d.counts || {},
    };
  },
  stats: (d) => {
    const vol = d.volume || [];
    return {
      revenue: (d.revenue || []).map((r) => ({ day: r.bucket, v: r.revenue || 0 })), revenue_total: d.revenue_total || 0,
      funnel: funnelOf((d.funnel || {}).by_status, (d.funnel || {}).total || 0), funnel_days: (d.range || {}).days || 30, conversion_pct: (d.funnel || {}).conversion_pct || 0,
      sends: vol.slice(-14).map((r) => ({ day: r.bucket, v: r.sends || 0 })), calls: vol.slice(-14).map((r) => ({ day: r.bucket, v: r.calls || 0 })),
      avg_close_days: d.avg_close_days ?? null, sources: d.sources || {},
    };
  },
  notes: (d) => ({ items: (d.notes || []).map(note) }),
  templates: (d) => ({ items: (d.items || d.templates || TEMPLATES).map(tpl) }),
  /* send answers: {sent} · {preview, confirm_required} · {ok:false, error:'needs_template', templates} · {ok:false, error:'quiet-hours'} */
  send: (d) => ({
    sent: !!d.sent, preview: !!d.preview, to: d.to || '', text: d.text || '', window_closes_at: d.window_closes_at || null,
    status: (d.lead && d.lead.status) || null, needs_template: d.error === 'needs_template', why: d.why || '', error: d.ok === false ? d.error || 'send-failed' : null,
    templates: (d.templates || []).map(tpl), last_inbound_at: d.last_inbound_at || null,
  }),
  quote: (d) => {
    const q = d.quote || d;
    return { quote_id: q.id || d.quote_id || null, url: d.link || q.url || '', sum: q.sum != null ? q.sum : null, description: q.description || '', suggested_text: d.suggested_text || '' };
  },
};
export const adaptCrm = (op, d) => (!d || (d.ok === false && op !== 'send') || !MAP[op] ? d : MAP[op](d));

/* request bodies (view → server field names, docs/CRM-API-2026-11-03.md) */
export const body = {
  leadPatch: (p) => ({ status: p.status, owner: p.owner, next_action_at: p.next_at, next_action_text: p.next_text, tags: p.tags, replace_tags: p.tags ? true : undefined, event_date: p.event_date, name: p.name }),
  quote: (l, q) => ({ plan: q.plan, records: Number(q.records), occasion: l.occasion || undefined, event_date: q.event_date || undefined, addons: { design: !!q.design, hostesses: Number(q.hostesses) || 0, travel: false, extra_wave: !!q.extra_wave, calls: !!q.calls } }),
  assignment: (a) => ({ id: a.id || undefined, hostess_id: a.hostess_id, event_token: a.client_token, date: a.date, start: a.start, end: a.end, status: a.paid ? 'paid' : a.status === 'declined' ? 'proposed' : a.status, pay: a.pay, force: a.force || undefined }),
};
const strip = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).forEach((k) => (o[k] === undefined ? delete o[k] : strip(o[k]))); return o; };
const notYet = (what) => { const e = new Error(what + ': אין לזה עדיין נקודת קצה בשרת'); e.status = 501; return e; };

/* crm(ctx) → caller bound to the ops data layer (auth, mock, errors all come from app.js) */
export function crm(ctx) {
  const path = (op, arg) => (typeof PATH[op] === 'function' ? PATH[op](arg) : PATH[op]);
  const read = (p, q = {}, o = {}) => ctx.api.get(p, q, { ...o, qs: '?' + new URLSearchParams(strip({ ...q })) });
  const get = (op, q = {}, o, arg) => read(path(op, arg), q, o).then((d) => adaptCrm(op, d));
  const post = (op, b = {}, arg, o) => ctx.api.post(path(op, arg), strip(b), o).then((d) => adaptCrm(op, d));
  const cachedRaw = (p, q) => { const c = ctx.api.cached(p, q); return c ? c.data : null; };
  const self = {
    get, post,
    /* the last good view from the ops cache (instant first paint), or null */
    cachedView(op) {
      if (op === 'leads') { const d = cachedRaw(PATH.leads, LEADS_Q); return d ? adaptCrm('leads', d) : null; }
      if (op === 'clients') { const d = cachedRaw(PATH.clients); return d ? adaptCrm('clients', d) : null; }
      if (op === 'hostesses') { const h = cachedRaw(PATH.hostesses, { limit: 200 }), a = cachedRaw(PATH.assignments, { limit: 500 }), c = cachedRaw(PATH.clients); return h && a ? adaptCrm('hostesses', { hostesses: h.items, assignments: a.items, clients: (c && c.clients) || [] }) : null; }
      return null;
    },
    leads: () => get('leads', LEADS_Q),
    lead: (id) => get('lead', {}, { cache: false }, id),
    updateLead: (id, p) => post('leadUpdate', body.leadPatch(p), id),
    bulk: (ids, p) => post('leadsBulk', { ids, patch: strip({ status: p.status || undefined, tags: p.add_tag ? [p.add_tag] : undefined }) }),
    notes: (entity, entity_id) => get('notes', { entity_type: entity, entity_id }, { cache: false }),
    addNote: (entity, entity_id, text, pinned = false) => post('noteAdd', { entity_type: entity, entity_id, text, pinned }),
    pinNote: (id, pinned, entity, entity_id) => post('notePin', { entity_type: entity, entity_id, id, pinned }),
    /* priced on the server (paylink.js priceQuote) and minted by makePayLinkV2, same as /api/pay-link */
    quote: (l, q) => post('quote', body.quote(l, q), l.id),
    /* free text only, inside the 24h window. 1st call → preview (nothing sent); the UI confirms; 2nd call with confirm:true sends.
       Templates have no send route yet (doc: "Templates still go out through the existing tools"). */
    async send(id, b) {
      if (b.template) throw notYet('שליחת תבנית מהמסך');
      const r = await post('send', strip({ text: b.text, confirm: b.confirm === true ? true : undefined }), id, { soft: true });
      if (r.error && !r.needs_template) { const e = new Error(r.why || r.error); e.code = r.error; throw e; }
      return r;
    },
    templates: async () => adaptCrm('templates', { items: TEMPLATES }),
    clients: () => get('clients'),
    client: (token) => get('client', {}, { cache: false }, token),
    async clientAction() { throw notYet('הפעולה'); },
    /* in-place edit of the client card (names / phone / occasion / date). POST crm/clients/:token; the Worker
       route is not deployed yet (see docs/OPS-DESIGN-2026-11-03.md): a 404 surfaces as "not yet" in the toast. */
    clientUpdate: (token, p) => post('client', strip({ names: p.names, name1: p.name1, name2: p.name2, phone: p.phone, occasion: p.occasion, date: p.date, who: 'ops' }), token),
    async hostesses() {
      const [h, a, c] = await Promise.all([read(PATH.hostesses, { limit: 200 }), read(PATH.assignments, { limit: 500 }), read(PATH.clients).catch(() => ({ clients: [] }))]);
      return adaptCrm('hostesses', { hostesses: h.items || [], assignments: a.items || [], clients: c.clients || [] });
    },
    saveAssignment: (a) => post('assignment', body.assignment(a)),
    async agenda() {
      const [a, c] = await Promise.all([read(PATH.agenda, {}, { cache: true }), read(PATH.clients).catch(() => ({ clients: [] }))]);
      return adaptCrm('agenda', { ...a, clients: c.clients || [] });
    },
    stats: () => get('stats', STATS_Q),
  };
  return self;
}
