/* ishur ops · CRM mock (?mock=1 only; ../mock.js forwards every "crm/…" and "/pay-link" name here).
   fixtures/ops/crm/*.json → an in-memory store that behaves like the CRM endpoints, writes included.
   Fixture dates are anchored to their `as_of`; they are rebased to today so "היום" is never empty. */
const NAMES = ['leads', 'clients', 'hostesses', 'notes', 'activity', 'templates', 'stats', 'agenda'];
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
  S = { leads: out.leads.items, clients: out.clients.items, hostesses: out.hostesses.hostesses, assignments: out.hostesses.assignments, notes: out.notes.items, activity: out.activity.items, templates: out.templates.items, stats: out.stats, agenda: out.agenda, seq: 1 };
  return S;
}
const now = () => new Date().toISOString();
const ok = (o) => ({ ok: true, fixture: true, ...o });
const err = (e) => ({ ok: false, error: e });
const H24 = 864e5;
export async function crmMock(name, b = {}, ver = '1') {
  const s = await load(ver), path = name.replace(/^\//, '');
  const L = (id) => s.leads.find((l) => l.id === id), C = (t) => s.clients.find((c) => c.token === t);
  const send = /^crm\/leads\/([^/]+)\/send$/.exec(path);
  if (send) {
    const l = L(decodeURIComponent(send[1])); if (!l) return err('not-found');
    const open = l.last_inbound_at && Date.now() - Date.parse(l.last_inbound_at) < H24;
    if (!open && !b.template) return ok({ sent: false, needs_template: true, templates: s.templates });
    const text = b.template ? (s.templates.find((t) => t.name === b.template) || {}).preview || b.template : b.text;
    s.activity.push({ id: 'ac_m' + s.seq++, lead_id: l.id, at: now(), kind: 'wa', dir: 'out', by: 'noa', text: (b.template ? '[תבנית] ' : '') + text });
    if (['new', 'talking'].includes(l.status)) l.status = 'quoted';
    return ok({ sent: true, status: l.status });
  }
  switch (path) {
    case 'crm/leads': return ok({ items: s.leads });
    case 'crm/lead': { const l = L(b.id); return l ? ok({ lead: l, notes: s.notes.filter((n) => n.entity === 'lead' && n.entity_id === l.id), activity: s.activity.filter((a) => a.lead_id === l.id) }) : err('not-found'); }
    case 'crm/lead-update': { const l = L(b.id); if (!l) return err('not-found'); Object.entries(b.patch || {}).forEach(([k, v]) => { if (v !== undefined) l[k] = v; }); return ok({ lead: l }); }
    case 'crm/leads-bulk': { (b.ids || []).forEach((id) => { const l = L(id); if (!l) return; if (b.status) l.status = b.status; if (b.add_tag && !l.tags.includes(b.add_tag)) l.tags.push(b.add_tag); }); return ok({ updated: (b.ids || []).length }); }
    case 'crm/notes': return ok({ items: s.notes.filter((n) => n.entity === b.entity && n.entity_id === b.entity_id) });
    case 'crm/note-add': { const n = { id: 'nt_m' + s.seq++, entity: b.entity, entity_id: b.entity_id, at: now(), by: 'richard', text: b.text, pinned: !!b.pinned }; s.notes.push(n); return ok({ note: n }); }
    case 'crm/note-pin': { const n = s.notes.find((x) => x.id === b.id); if (n) n.pinned = !!b.pinned; return ok({ note: n }); }
    case 'crm/quote': {
      const l = L(b.lead_id); if (!l) return err('not-found');
      const G = globalThis.IshurPayLinkGen, cfg = globalThis.ISHUR_CONFIG, a = b.addons || {};
      const sum = G && cfg ? G.price({ plan: b.plan, records: b.records, hostesses: a.hostesses, design: a.design, calls: a.calls, extra_wave: a.extra_wave }, cfg).total : null;
      l.quote_id = 'q_m' + s.seq++;
      return ok({ quote_id: l.quote_id, url: 'https://pay.grow.link/DEMO-' + l.quote_id, sum, description: b.records + ' רשומות ' + b.plan });
    }
    case 'pay-link': return ok({ url: 'https://pay.grow.link/DEMO-paylink', sum: null, description: 'דמה' });
    case 'crm/templates': return ok({ items: s.templates });
    case 'crm/clients': return ok({ items: s.clients });
    case 'crm/client': { const c = C(b.token); return c ? ok({ client: c, notes: s.notes.filter((n) => n.entity === 'client' && n.entity_id === c.token), timeline: s.activity.filter((a) => a.client_token === c.token) }) : err('not-found'); }
    case 'crm/client-action': {
      const c = C(b.token); if (!c) return err('not-found');
      if (b.confirm == null) return ok({ applied: false, confirm_required: b.action });
      if (b.action === 'hold') c.status = c.status === 'hold' ? 'active' : 'hold';
      if (b.action === 'add_hostess') c.addons.hostesses = (c.addons.hostesses || 0) + 1;
      s.activity.push({ id: 'cac_m' + s.seq++, client_token: c.token, at: now(), kind: b.action === 'extra_send' ? 'send' : 'note', dir: 'out', text: { hold: c.status === 'hold' ? 'הוחזק (hold)' : 'שוחרר מ-hold', extra_send: 'שליחה נוספת תוזמנה', add_hostess: 'נוספה דיילת' }[b.action] || b.action });
      return ok({ applied: true, client: c });
    }
    case 'crm/hostesses': {
      const events = s.clients.filter((c) => c.addons.hostesses > 0 && c.status !== 'done').map((c) => ({ client_token: c.token, name: c.name, date: c.event_date, need: c.addons.hostesses, have: s.assignments.filter((a) => a.client_token === c.token && a.status !== 'declined').length }));
      return ok({ hostesses: s.hostesses, assignments: s.assignments, events });
    }
    case 'crm/assignment': {
      let a = s.assignments.find((x) => x.id === b.id);
      if (!a) { a = { id: 'as_m' + s.seq++, status: 'proposed', pay: 400, paid: false }; s.assignments.push(a); }
      Object.entries(b.patch || {}).forEach(([k, v]) => { if (v !== undefined) a[k] = v; });
      return ok({ assignment: a });
    }
    case 'crm/agenda': {
      const d = ilDay(Date.now());
      return ok({ reminders: s.leads.filter((l) => l.next_action_at && ilDay(l.next_action_at) === d), events: s.clients.filter((c) => c.event_date === d), sends_today: s.agenda.sends_today });
    }
    case 'crm/stats': return ok(s.stats);
    default: return { ok: false, error: 'unknown-crm-route' };
  }
}
