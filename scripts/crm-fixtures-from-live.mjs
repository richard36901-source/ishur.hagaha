/* Regenerates fixtures/ops/crm/*.json from the LIVE CRM API (docs/CRM-API-2026-11-03.md). READ-ONLY: GETs only.
   Usage:  ISHUR_ADMIN_KEY=… node scripts/crm-fixtures-from-live.mjs            (fetches https://go.ishur.io)
           node scripts/crm-fixtures-from-live.mjs --from <dir>                 (re-masks saved GET responses)
   Masking (same rules as the other ops fixtures): every 9725…/05… phone → a fake 97250000xxxx (stable per phone),
   lead ids follow their phone, tokens are zeroed after the 8-char prefix, client/lead names are pseudonyms,
   invoice links are dropped. Staff names (owner: שלו / ריצארד) are kept: they are the screen's filter values.
   Live CRM tables that are still EMPTY on the server (hostesses, assignments, reminders, notes, activities on
   03/11/2026) get a small synthetic set in the SAME server schema so every screen state can be rendered.
   Synthetic rows carry `fixture: "synthetic"`; everything else is a masked live row. Dates stay as fetched;
   assets/ops/crm/mock.js rebases them to today from `as_of`. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), OUT = join(ROOT, 'fixtures/ops/crm');
const BASE = process.env.ISHUR_BASE || 'https://go.ishur.io';
const fromArg = process.argv.indexOf('--from'), FROM = fromArg > 0 ? process.argv[fromArg + 1] : '';
const KEY = process.env.ISHUR_ADMIN_KEY || '';
if (!FROM && !KEY) { console.error('set ISHUR_ADMIN_KEY (sent as X-Admin-Key, never in the URL) or pass --from <dir>'); process.exit(2); }

async function getLive(name, path) {
  if (FROM) { const f = join(FROM, name + '.json'); if (!existsSync(f)) throw new Error('missing ' + f); return JSON.parse(readFileSync(f, 'utf8')); }
  const r = await fetch(BASE + '/api/crm/' + path, { method: 'GET', headers: { 'X-Admin-Key': KEY } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(path + ' → ' + r.status + ' ' + (j.error || ''));
  return j;
}

/* ── masking ── */
const phones = new Map();
const fakePhone = (p) => { if (/^97250000\d{4}$/.test(p)) return p; if (!phones.has(p)) phones.set(p, '97250000' + String(1000 + phones.size).slice(-4)); return phones.get(p); };
const normIl = (s) => { const d = String(s).replace(/\D/g, ''); return d.startsWith('972') ? d : d.startsWith('0') ? '972' + d.slice(1) : d; };
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const maskStr = (s) => String(s).replace(UUID, '$1-0000-4000-8000-000000000000')
  .replace(/(?<!\d)(972\d{8,9}|0\d{1,2}-?\d{3}-?\d{4})(?!\d)/g, (m) => fakePhone(normIl(m)))
  .replace(/\bL972\d{8,9}\b/g, (m) => 'L' + fakePhone(m.slice(1)));
const FIRST = ['דנה', 'יוסי', 'מיכל', 'רות', 'אבי', 'נועם', 'שירה', 'תמר', 'עידו', 'הילה', 'אורי', 'ליאת', 'גיל', 'מאיה', 'רוני', 'יעל', 'עומר', 'נטע'];
const LAST = ['לוי', 'כהן', 'אברהם', 'מזרחי', 'פרץ', 'ביטון', 'דהן', 'אזולאי', 'פרידמן', 'שפירא', 'גבאי', 'אוחיון'];
const pseudo = (i, two = false) => FIRST[i % FIRST.length] + ' ' + LAST[(i * 7) % LAST.length] + (two ? ' ו' + FIRST[(i + 5) % FIRST.length] + ' ' + LAST[(i * 3 + 1) % LAST.length] : '');
const NAME_KEYS = new Set(['name', 'names', 'client', 'hostess_name']);
let nameSeq = 0; const names = new Map();
const fakeName = (v, two) => { const k = String(v); if (!names.has(k)) names.set(k, pseudo(nameSeq++, two)); return names.get(k); };
function scrub(o) {
  if (Array.isArray(o)) return o.map(scrub);
  if (!o || typeof o !== 'object') return typeof o === 'string' ? maskStr(o) : o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'invoice') { out[k] = v ? 'INV-masked' : ''; continue; }
    if (NAME_KEYS.has(k) && typeof v === 'string' && v) { out[k] = fakeName(v, k === 'names' && / ו/.test(v)); continue; }
    if (k === 'phone' && v) { out[k] = fakePhone(normIl(v)); continue; }
    out[k] = scrub(v);
  }
  return out;
}

/* ── live reads ── */
const live = {
  leads: await getLive('leads', 'leads?limit=500'),
  clients: await getLive('clients', 'clients'),
  hostesses: await getLive('hostesses', 'hostesses?limit=200'),
  assignments: await getLive('assignments', 'assignments?limit=500'),
  reminders: await getLive('reminders', 'reminders?limit=200'),
  agenda: await getLive('agenda', 'agenda'),
  stats: await getLive('stats', 'stats?range=30d'),
};
const AS_OF = live.stats.at || live.clients.at || new Date().toISOString();
const T0 = Date.parse(AS_OF), iso = (dd, h = 10) => new Date(T0 + dd * 864e5 + (h - 10) * 36e5).toISOString(), day = (dd) => iso(dd, 12).slice(0, 10);
const meta = (what, synthetic = 0) => ({ fixture: true, as_of: AS_OF, source: `live GET ${BASE}/api/crm/${what}, masked`, synthetic_rows: synthetic });

const M = scrub(live);
/* ── synthetic rows (server schema) for the tables that are empty live ── */
const SYN = 'synthetic';
const sp = (i) => '97250000' + String(9000 + i);
const synLeads = [
  { id: 'L' + sp(1), phone: sp(1), name: pseudo(20), status: 'talking', source: 'whatsapp', occasion: 'wedding', event_date: day(140), records_estimate: 300, owner: 'שלו', tags: ['חם'], next_action_at: iso(0, 11), next_action_text: 'לחזור אחרי שיחה עם בן הזוג', last_inbound_at: iso(0, 6), created_at: iso(-3), updated_at: iso(0, 6), fixture: SYN },
  { id: 'L' + sp(2), phone: sp(2), name: pseudo(21), status: 'quoted', source: 'meta_form', occasion: 'bar', event_date: day(60), records_estimate: 200, owner: 'ריצארד', tags: [], quote_id: 'fixq0002', next_action_at: iso(-1, 9), next_action_text: 'לבדוק אם שילם', last_inbound_at: iso(-2), created_at: iso(-6), updated_at: iso(-1), fixture: SYN },
  { id: 'L' + sp(3), phone: sp(3), name: pseudo(22), status: 'new', source: 'web', occasion: 'hina', tags: ['מחיר'], last_inbound_at: iso(0, 5), created_at: iso(0, 5), updated_at: iso(0, 5), fixture: SYN },
];
const synNotes = [
  { id: 'Nfix1', entity_type: 'lead', entity_id: synLeads[0].id, text: 'דיברנו, מחכה לאישור של בן הזוג', author: 'שלו', pinned: true, at: iso(-1), origin: '', fixture: SYN },
  { id: 'Nfix2', entity_type: 'lead', entity_id: synLeads[0].id, text: 'מאנדיי: הגיעה מהמלצה של חברה', author: 'מאנדיי', pinned: false, at: iso(-3), origin: 'monday', fixture: SYN },
  { id: 'Nfix3', entity_type: 'lead', entity_id: synLeads[1].id, text: 'שלחתי קישור, ביקש לחשוב', author: 'ריצארד', pinned: false, at: iso(-2), origin: '', fixture: SYN },
];
const synActs = [
  { id: 'Afix1', entity_type: 'lead', entity_id: synLeads[0].id, kind: 'created', dir: '', text: 'נוצר מוואטסאפ', at: iso(-3), meta: {}, fixture: SYN },
  { id: 'wa:fix2', entity_type: 'lead', entity_id: synLeads[0].id, kind: 'wa_in', dir: 'in', text: 'היי, אפשר פרטים על אישורי הגעה?', at: iso(0, 6), meta: { ok: true }, fixture: SYN },
  { id: 'Afix3', entity_type: 'lead', entity_id: synLeads[0].id, kind: 'wa_out', dir: 'out', text: 'בשמחה! כמה אורחים בערך?', at: iso(-1, 12), meta: { ok: true, who: 'phone' }, fixture: SYN },
  { id: 'Afix4', entity_type: 'lead', entity_id: synLeads[1].id, kind: 'quote', dir: 'out', text: '200 רשומות בסיס · ₪149', at: iso(-2), meta: { quote_id: 'fixq0002' }, fixture: SYN },
  { id: 'Afix5', entity_type: 'lead', entity_id: synLeads[1].id, kind: 'status', dir: '', text: 'talking → quoted', at: iso(-2), meta: { who: 'ריצארד' }, fixture: SYN },
];
const synReminders = [
  { id: 'Rfix1', entity_type: 'lead', entity_id: synLeads[0].id, due_at: synLeads[0].next_action_at, text: synLeads[0].next_action_text, owner: 'שלו', done: false, created_at: iso(-1), updated_at: iso(-1), fixture: SYN },
];
/* hostesses + a double booking on the first upcoming event, so the conflict + short-staffed warnings render */
const ev = (M.clients.clients || []).find((c) => c.status === 'upcoming') || (M.clients.clients || [])[0] || { token: 'fix00000-0000-4000-8000-000000000000', date: day(10) };
const evDate = day(0);   /* today (the mock rebases it), so the double booking is in the week grid the screen opens on */
const synHost = [
  { id: 'H' + sp(11), name: pseudo(30), phone: sp(11), city: 'תל אביב', rate: 450, active: true, created_at: iso(-20), updated_at: iso(-20), fixture: SYN },
  { id: 'H' + sp(12), name: pseudo(31), phone: sp(12), city: 'חיפה', rate: 400, active: true, created_at: iso(-20), updated_at: iso(-20), fixture: SYN },
  { id: 'H' + sp(13), name: pseudo(32), phone: sp(13), city: 'ירושלים', rate: 420, active: false, created_at: iso(-40), updated_at: iso(-5), fixture: SYN },
];
const synAsg = [
  { id: 'Sfix1', hostess_id: synHost[0].id, hostess_name: synHost[0].name, event_token: ev.token, date: evDate, start: '18:00', end: '23:00', hours: 5, pay: 450, status: 'confirmed', created_at: iso(-3), updated_at: iso(-3), fixture: SYN },
  { id: 'Sfix2', hostess_id: synHost[0].id, hostess_name: synHost[0].name, event_token: 'fixe0002-0000-4000-8000-000000000000', date: evDate, start: '20:00', end: '23:30', hours: 3.5, pay: 400, status: 'proposed', created_at: iso(-1), updated_at: iso(-1), fixture: SYN },
  { id: 'Sfix3', hostess_id: synHost[1].id, hostess_name: synHost[1].name, event_token: ev.token, date: day(-6), start: '19:00', end: '23:00', hours: 4, pay: 400, status: 'paid', created_at: iso(-12), updated_at: iso(-5), fixture: SYN },
];
/* the event the double booking sits on bought 3 hostesses → it is short-staffed */
for (const c of M.clients.clients || []) if (c.token === ev.token) c.addons = { ...c.addons, hostesses: { n: 3, city: 'תל אביב', booked: true } };

const withSyn = (arr, syn) => (arr && arr.length ? arr : syn);
const leadsItems = [...(M.leads.items || []), ...synLeads];
const by = Object.fromEntries(['new', 'talking', 'quoted', 'closed', 'not_relevant', 'lost'].map((s) => [s, leadsItems.filter((l) => l.status === s).length]));
const files = {
  leads: { ...meta('leads?limit=500', synLeads.length), ...M.leads, items: leadsItems, total: leadsItems.length, by_status: by },
  clients: { ...meta('clients'), ...M.clients },
  hostesses: { ...meta('hostesses?limit=200', (M.hostesses.items || []).length ? 0 : synHost.length), ...M.hostesses, items: withSyn(M.hostesses.items, synHost), total: withSyn(M.hostesses.items, synHost).length },
  assignments: { ...meta('assignments?limit=500', (M.assignments.items || []).length ? 0 : synAsg.length), ...M.assignments, items: withSyn(M.assignments.items, synAsg), total: withSyn(M.assignments.items, synAsg).length },
  reminders: { ...meta('reminders', (M.reminders.items || []).length ? 0 : synReminders.length), ...M.reminders, items: withSyn(M.reminders.items, synReminders), total: withSyn(M.reminders.items, synReminders).length },
  /* GET /leads/:id notes + activities for every fixture lead, one file each (the mock answers /leads/:id from them) */
  notes: { ...meta('notes?entity_type=…&entity_id=… (all entities)', synNotes.length), ok: true, notes: synNotes },
  activity: { ...meta('leads/:id activities (all leads)', synActs.length), ok: true, activities: synActs },
  agenda: { ...meta('agenda'), ...M.agenda },
  stats: { ...meta('stats?range=30d'), ...M.stats },
  /* the needs_template answer of POST /leads/:id/send (worker/crm.js LEAD_TEMPLATES); not fetched: send is a write */
  templates: { ...meta('(POST leads/:id/send needs_template answer, from worker/crm.js)'), ok: false, error: 'needs_template', last_inbound_at: null, why: 'הליד לא כתב לנו אף פעם: מותר לשלוח רק תבנית מאושרת',
    templates: [{ name: 'ishur_lo_siyem', he: 'לא סיימת להזמין (תזכורת ראשונה)', category: 'marketing' }, { name: 'ishur_lo_siyem_2', he: 'לא סיימת להזמין (יום אחרי)', category: 'marketing' }, { name: 'ishur_lo_siyem_3', he: 'טיפ + הזמנה לחזור', category: 'marketing' }] },
};
mkdirSync(OUT, { recursive: true });
const leak = (s) => (s.match(/(?<!\d)972\d{8,9}(?!\d)/g) || []).filter((m) => !/^97250000\d{4}$/.test(m));
for (const [n, d] of Object.entries(files)) {
  const txt = JSON.stringify(d, null, 1) + '\n';
  if (leak(txt).length) throw new Error(n + ': unmasked phone ' + leak(txt)[0]);
  writeFileSync(join(OUT, n + '.json'), txt);
  console.log(n.padEnd(12), String(txt.length).padStart(7) + ' B', d.items ? d.items.length + ' items' : d.clients ? d.clients.length + ' clients' : '');
}
