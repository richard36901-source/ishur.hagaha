/* ishur ops · CRM mock (?mock=1 only; ../mock.js forwards every "crm/…" and "/pay-link" name here).
   fixtures/ops/crm/*.json (masked live GET responses, scripts/crm-fixtures-from-live.mjs) → an in-memory store
   that answers the SAME paths, methods and shapes as worker/crm.js handleCrm, writes included.
   Fixture dates are anchored to their `as_of`; they are rebased to today so "היום" is never empty. */
const NAMES = ['leads', 'clients', 'hostesses', 'assignments', 'reminders', 'notes', 'activity', 'templates', 'stats'];
const STATUSES = ['new', 'talking', 'quoted', 'closed', 'not_relevant', 'lost'];
const STATUS_HE = { new: 'חדש', talking: 'בשיחה', quoted: 'הצעה נשלחה', closed: 'סגר', not_relevant: 'לא רלוונטי', lost: 'נדחה' };
let S = null;
const ilDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(d));
function rebase(txt, asOf) {
  const shift = Math.round((Date.parse(ilDay(Date.now()) + 'T12:00:00Z') - Date.parse(ilDay(asOf) + 'T12:00:00Z')) / 864e5);
  if (!shift) return txt;
  return txt.replace(/"(\d{4}-\d{2}-\d{2})(T[\d:.]+(?:Z|[+-]\d\d:\d\d))?"/g, (m, d, t) => (t ? '"' + new Date(Date.parse(d + t) + shift * 864e5).toISOString() + '"' : '"' + new Date(Date.parse(d + 'T12:00:00Z') + shift * 864e5).toISOString().slice(0, 10) + '"'));
}
async function load(ver) {
  if (S) return S;
  const out = {};
  await Promise.all(NAMES.map(async (n) => { const r = await fetch(`fixtures/ops/crm/${n}.json?v=${ver}`); const t = await r.text(); out[n] = JSON.parse(rebase(t, JSON.parse(t).as_of)); }));
  S = { leads: out.leads.items, clients: out.clients.clients, hostesses: out.hostesses.items, assignments: out.assignments.items, reminders: out.reminders.items,
    notes: out.notes.notes, activities: out.activity.activities, templates: out.templates.templates, stats: out.stats, seq: 1 };
  return S;
}
const now = () => new Date().toISOString();
const ok = (o) => ({ ok: true, fixture: true, ...o });
const err = (e, extra) => ({ ok: false, error: e, ...extra });
const H24 = 864e5;
const byUpd = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
const quiet = (t = Date.now()) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return p.weekday === 'Sat' || +p.hour < 9 || +p.hour >= 21; };
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? +m[1] * 60 + +m[2] : null; };
const clash = (all, c) => all.filter((a) => a.id !== c.id && a.hostess_id === c.hostess_id && a.date === c.date).filter((a) => { const s1 = toMin(c.start), e1 = toMin(c.end), s2 = toMin(a.start), e2 = toMin(a.end); return s1 == null || e1 == null || s2 == null || e2 == null || (s1 < e2 && s2 < e1); });

export async function crmMock(name, b = {}, ver = '1', method = 'POST') {
  const s = await load(ver), path = name.replace(/^\//, ''), isPost = method !== 'GET';
  const [, a, x, y] = path.split('/').map(decodeURIComponent); /* crm / a / x / y */
  const L = (id) => s.leads.find((l) => l.id === id), C = (t) => s.clients.find((c) => c.token === t || c.tok8 === t || String(c.token).startsWith(t));
  const act = (o) => { const r = { id: 'Am' + s.seq++, dir: '', meta: {}, at: now(), ...o }; s.activities.push(r); return r; };
  if (path === 'pay-link') return ok({ url: 'https://pay.grow.link/DEMO-paylink', sum: null, description: 'דמה' });
  switch (a) {
    case 'leads': {
      if (!x) return ok({ store: 'kv', items: [...s.leads].sort(byUpd), total: s.leads.length, next_cursor: null, by_status: Object.fromEntries(STATUSES.map((k) => [k, s.leads.filter((l) => l.status === k).length])), statuses: STATUSES.map((id) => ({ id, he: STATUS_HE[id] })), sources: ['meta_form', 'whatsapp', 'web', 'manual', 'referral'], synced: null });
      if (x === 'bulk') {
        const results = (b.ids || []).map((id) => { const l = L(id); if (!l) return { id, ok: false, error: 'not-found' }; const p = b.patch || {}; if (p.status) l.status = p.status; if (p.tags) l.tags = [...new Set([...(l.tags || []), ...p.tags])]; l.updated_at = now(); return { id, ok: true }; });
        return ok({ results, changed: results.filter((r) => r.ok).length });
      }
      const l = L(x); if (!l) return err('not-found');
      if (!y && !isPost) return ok({ lead: l, notes: s.notes.filter((n) => n.entity_type === 'lead' && n.entity_id === l.id).sort((p, q) => (q.pinned - p.pinned) || String(p.at).localeCompare(String(q.at))), activities: s.activities.filter((v) => v.entity_type === 'lead' && v.entity_id === l.id).sort((p, q) => String(q.at).localeCompare(String(p.at))), reminders: s.reminders.filter((r) => r.entity_type === 'lead' && r.entity_id === l.id) });
      if (!y) {
        const prev = l.status;
        for (const k of ['name', 'status', 'owner', 'occasion', 'event_date', 'records_estimate', 'next_action_at', 'next_action_text', 'source']) if (b[k] !== undefined) l[k] = b[k];
        if (b.tags) l.tags = b.replace_tags ? [...b.tags] : [...new Set([...(l.tags || []), ...b.tags])];
        if (b.status && b.status !== prev) { l.status_by_ops = true; act({ entity_type: 'lead', entity_id: l.id, kind: 'status', text: prev + ' → ' + b.status }); }
        l.updated_at = now();
        return ok({ lead: l, monday: { ok: false, why: 'sync-off' } });
      }
      if (y === 'quote') {
        const G = globalThis.IshurPayLinkGen, cfg = globalThis.ISHUR_CONFIG, ad = b.addons || {};
        const sum = G && cfg ? G.price({ plan: b.plan, records: b.records, hostesses: ad.hostesses, design: ad.design, calls: ad.calls, extra_wave: ad.extra_wave }, cfg).total : null;
        const q = { id: 'qm' + s.seq++, url: '', sum, description: b.records + ' רשומות ' + b.plan, plan: b.plan, records: b.records, addons: ad, at: now() };
        q.url = 'https://pay.grow.link/DEMO-' + q.id; l.quote_id = q.id; l.quote = q;
        act({ entity_type: 'lead', entity_id: l.id, kind: 'quote', dir: 'out', text: q.description + (sum != null ? ' · ₪' + sum : '') });
        return ok({ lead: l, quote: q, link: q.url, suggested_text: `היי ${(l.name || '').split(' ')[0]} 🙂\nמצרפת את הקישור לתשלום: ${q.description}${sum != null ? ' · ₪' + sum : ''}\n${q.url}` });
      }
      if (y === 'send') {
        const last = l.last_inbound_at && Date.parse(l.last_inbound_at);
        if (b.template) { if (b.confirm !== true) return ok({ preview: true, to: l.phone, text: b.template }); act({ entity_type: 'lead', entity_id: l.id, kind: 'wa_out', dir: 'out', text: b.template }); return ok({ sent: true, lead: l }); }
        if (!last || Date.now() - last >= H24) return err('needs_template', { last_inbound_at: l.last_inbound_at || null, why: last ? 'החלון של 24 שעות נסגר: מותר לשלוח רק תבנית מאושרת' : 'הליד לא כתב לנו אף פעם: מותר לשלוח רק תבנית מאושרת', templates: s.templates });
        if (quiet()) return err('quiet-hours', { why: 'לא שולחים ללקוחות/לידים 21:00–09:00 ובשבת' });
        if (b.confirm !== true) return ok({ preview: true, confirm_required: true, to: String(l.phone).replace(/^972(\d{2})\d+(\d{3})$/, '0$1*****$2'), text: b.text, window_closes_at: new Date(last + H24).toISOString() });
        act({ entity_type: 'lead', entity_id: l.id, kind: 'wa_out', dir: 'out', text: b.text, meta: { ok: true, who: 'admin' } });
        if (['new', 'talking'].includes(l.status)) l.status = l.quote_id ? 'quoted' : 'talking';
        l.last_outbound_at = now();
        return ok({ sent: true, wamid: 'wamid.DEMO', lead: l, monday: { ok: false, why: 'sync-off' } });
      }
      return err('unknown-crm-route');
    }
    case 'notes': {
      if (x === 'pin') { const n = s.notes.find((v) => v.id === b.id && v.entity_type === b.entity_type && v.entity_id === b.entity_id); if (!n) return err('not-found'); n.pinned = !!b.pinned; return ok({ note: n }); }
      if (!isPost) return ok({ notes: s.notes.filter((n) => n.entity_type === b.entity_type && n.entity_id === b.entity_id) });
      const n = { id: 'Nm' + s.seq++, entity_type: b.entity_type, entity_id: b.entity_id, text: b.text, author: 'admin', pinned: !!b.pinned, at: now(), origin: '' };
      s.notes.push(n); act({ entity_type: b.entity_type, entity_id: b.entity_id, kind: 'note', text: b.text, meta: { note_id: n.id } });
      return ok({ note: n, monday: null });
    }
    case 'clients': {
      if (!x) return ok({ at: now(), today: ilDay(Date.now()), clients: s.clients, counts: Object.fromEntries(['upcoming', 'live', 'done', 'cancelled', 'held'].map((k) => [k, s.clients.filter((c) => c.status === k).length])) });
      const c = C(x); if (!c) return err('not-found');
      if (isPost && !y) {
        if (b.event_date < ilDay(Date.now()) && !b.override_past) return err('date-in-past');
        const nm = b.name2 ? b.name1 + ' ו' + b.name2 : b.name1, changed = [];
        for (const [k, to, v] of [['names', 'names', nm], ['phone', 'phone', b.phone], ['occasion', 'occasion', b.occasion], ['event_date', 'date', b.event_date]]) if (v && v !== c[to]) { c[to] = v; changed.push(k); }
        return ok({ changed, unchanged: !changed.length });
      }
      if (isPost && y === 'action') {
        const w = { send_dashboard: 'שלח', send_upload: 'שלח', extra_send: 'שלח', reset_guests: String((c.counts || {}).invited || 0) }[b.action] || 'אישור';
        if (b.confirm !== w) return ok({ applied: false, confirm_required: w, title: b.action + '?', body: 'הדגמה' });
        if (b.action === 'hold') c.status = b.on ? 'held' : 'upcoming';
        act({ entity_type: 'client', entity_id: c.token, kind: 'event', text: b.action });
        return ok({ applied: true, summary: 'הדגמה: ' + b.action });
      }
      const tl = [...s.activities.filter((v) => ['client', 'event'].includes(v.entity_type) && v.entity_id === c.token).map((v) => ({ ...v, source: 'crm' })),
        ...s.notes.filter((n) => ['client', 'event'].includes(n.entity_type) && n.entity_id === c.token).map((n) => ({ ...n, kind: 'note', source: 'notes' }))].sort((p, q) => String(q.at).localeCompare(String(p.at)));
      return ok({ client: c, timeline: tl, assignments: s.assignments.filter((v) => v.event_token === c.token), audit_truncated: false });
    }
    case 'hostesses': return ok({ store: 'kv', items: [...s.hostesses].sort((p, q) => String(p.name).localeCompare(String(q.name))), total: s.hostesses.length, next_cursor: null });
    case 'assignments': {
      if (!isPost) return ok({ items: [...s.assignments].sort((p, q) => String(p.date).localeCompare(String(q.date))), total: s.assignments.length, next_cursor: null });
      let r = s.assignments.find((v) => v.id === b.id);
      const cand = { ...(r || { status: 'proposed' }), ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k !== 'force')) };
      cand.id = cand.id || 'Sm' + s.seq++;
      const moved = !r || ['hostess_id', 'date', 'start', 'end'].some((k) => String(r[k] || '') !== String(cand[k] || ''));
      const cf = clash(s.assignments, cand);
      if (cf.length && moved && b.force !== true) return err('conflict', { conflicts: cf });
      const h = s.hostesses.find((v) => v.id === cand.hostess_id); if (!h) return err('unknown-hostess');
      cand.hostess_name = h.name;
      if (r) Object.assign(r, cand); else s.assignments.push((r = cand));
      return ok({ created: !b.id, assignment: r, conflicts: cf });
    }
    case 'reminders': return ok({ items: s.reminders.filter((r) => (!b.entity_type || r.entity_type === b.entity_type) && (!b.entity_id || r.entity_id === b.entity_id) && !r.done), total: s.reminders.length, next_cursor: null });
    case 'agenda': {
      /* same rules as worker/crm.js agendaFor */
      const day = ilDay(Date.now()), due = (t) => (t ? ilDay(t) : ''), items = [];
      for (const r of s.reminders) { if (r.done) continue; const d = due(r.due_at); if (d && d <= day) items.push({ kind: 'reminder', id: r.id, at: r.due_at, overdue: d < day, entity_type: r.entity_type, entity_id: r.entity_id, text: r.text, owner: r.owner }); }
      for (const l of s.leads) {
        if (!l.next_action_at || ['closed', 'lost', 'not_relevant'].includes(l.status) || s.reminders.some((r) => !r.done && r.entity_id === l.id && r.due_at === l.next_action_at)) continue;
        const d = due(l.next_action_at); if (d && d <= day) items.push({ kind: 'lead_action', id: l.id, at: l.next_action_at, overdue: d < day, entity_type: 'lead', entity_id: l.id, text: l.next_action_text || 'פעולה הבאה', name: l.name || '', phone: l.phone, status: l.status, owner: l.owner || '' });
      }
      for (const v of s.assignments) if (v.date === day) items.push({ kind: 'hostess_shift', id: v.id, at: day + 'T' + (v.start || '00:00') + ':00', overdue: false, entity_type: 'event', entity_id: v.event_token, text: `${v.hostess_name} · ${v.start}–${v.end}`, status: v.status });
      for (const c of s.clients) if (c.date === day && c.status !== 'cancelled') items.push({ kind: 'event', id: c.token, at: day + 'T12:00:00', overdue: false, entity_type: 'client', entity_id: c.token, text: c.names, status: c.status });
      items.sort((p, q) => (q.overdue - p.overdue) || String(p.at).localeCompare(String(q.at)));
      return ok({ day, items, counts: { total: items.length, overdue: items.filter((i) => i.overdue).length } });
    }
    case 'stats': return ok(s.stats);
    default: return err('unknown-crm-route');
  }
}
