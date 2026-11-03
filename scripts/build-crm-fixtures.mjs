/* Builds fixtures/ops/crm/*.json for the CRM screens until docs/CRM-API-2026-11-03.md lands
   (branch crm-backend). Shape = plan §7 + the CRM brief field lists. Deterministic (seeded),
   all phones are fake 97250000xxxx, all tokens are zeroed after an 8-char prefix.
   Dates are anchored to AS_OF; the mock (assets/ops/crm/mock.js) rebases them to today.
   Usage: node scripts/build-crm-fixtures.mjs */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/ops/crm');
mkdirSync(OUT, { recursive: true });
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const AS_OF = '2026-11-03T09:00:00+02:00', T0 = Date.parse(AS_OF);
const iso = (dayOff, h = 10, m = 0) => new Date(T0 + dayOff * 864e5 + (h - 9) * 36e5 + m * 6e4).toISOString();
const day = (dayOff) => iso(dayOff, 12).slice(0, 10);
const tok = (i) => 'a' + String(i).padStart(7, '0') + '-0000-4000-8000-000000000000';
const phone = (i) => '97250000' + String(1000 + i).slice(-4);

const FIRST = ['דנה', 'יוסי', 'מיכל', 'רות', 'אבי', 'נועם', 'שירה', 'תמר', 'עידו', 'הילה', 'אורי', 'ליאת', 'גיל', 'מאיה', 'רוני', 'יעל', 'עומר', 'נטע', 'איתי', 'קרן'];
const LAST = ['לוי', 'כהן', 'אברהם', 'מזרחי', 'פרץ', 'ביטון', 'דהן', 'אזולאי', 'פרידמן', 'שפירא', 'גבאי', 'אוחיון'];
const OCC = ['wedding', 'wedding', 'wedding', 'hina', 'bar', 'bat', 'brit', 'bday'];
const SRC = ['meta_form', 'meta_form', 'site', 'site', 'whatsapp', 'referral', 'google', 'instagram'];
const OWN = ['richard', 'richard', 'shalev'];
const TAGS = ['חם', 'מחיר', 'דיילות', 'עיצוב', 'VIP', 'חוזר', 'אולם'];
const STATUS = ['new', 'new', 'new', 'talking', 'talking', 'talking', 'quoted', 'quoted', 'closed', 'closed', 'not_relevant', 'lost'];
const NOTE_T = ['דיברנו, רוצה לראות דוגמה של ההזמנה', 'לא ענתה, לנסות שוב בערב', 'שאל על דיילות לחתונה', 'מתלבטים בין בסיס לפרמיום', 'ביקשה שנחזור אחרי שיסגרו אולם', 'שלחתי סיכום בוואטסאפ', 'רוצה הנחה, הצעתי שליחה נוספת חינם'];
const RECS = [100, 200, 300, 400, 500];

const leads = [], notes = [], activity = [];
for (let i = 1; i <= 42; i++) {
  const status = STATUS[(i * 7) % STATUS.length], created = -Math.floor(rnd() * 40) - (status === 'new' ? 0 : 3);
  const name = pick(FIRST) + ' ' + pick(LAST), inbound = status === 'new' && i % 2 ? created : Math.min(0, created + Math.floor(rnd() * 5));
  const na = ['talking', 'quoted', 'new'].includes(status) ? Math.floor(rnd() * 5) - 1 : null;
  const L = {
    id: 'ld_' + String(i).padStart(3, '0'), phone: phone(i), name, source: pick(SRC), occasion: pick(OCC),
    event_date: day(20 + Math.floor(rnd() * 200)), records_estimate: pick(RECS), status, owner: pick(OWN),
    next_action_at: na == null ? null : iso(na, 10 + (i % 8)), next_action_text: na == null ? '' : pick(['לחזור אחרי שיחה עם בן הזוג', 'לשלוח דוגמת הזמנה', 'לבדוק אם נכנס תשלום', 'שיחת היכרות', 'לשאול על תאריך']),
    quote_id: ['quoted', 'closed'].includes(status) ? 'q_' + i : null, client_token: status === 'closed' ? tok(i) : null,
    tags: TAGS.filter((_, k) => (i + k * 3) % 7 === 0).slice(0, 2), created_at: iso(created, 9 + (i % 10), i % 60),
    last_inbound_at: status === 'new' && i % 3 === 0 ? iso(0, 8, i) : iso(inbound, 12, i % 60),
  };
  leads.push(L);
  const nn = i % 4;
  for (let k = 0; k < nn; k++) notes.push({ id: 'nt_l' + i + '_' + k, entity: 'lead', entity_id: L.id, at: iso(created + k + 1, 11 + k), by: pick(OWN), text: pick(NOTE_T), pinned: k === 0 && i % 5 === 0 });
  activity.push({ id: 'ac_' + i + '_0', lead_id: L.id, at: L.created_at, kind: 'form', dir: 'in', text: 'השאיר פרטים · ' + L.source });
  activity.push({ id: 'ac_' + i + '_1', lead_id: L.id, at: iso(created, 9 + (i % 10), (i % 60) + 10 > 59 ? 59 : (i % 60) + 10), kind: 'wa', dir: 'out', by: 'noa', text: 'היי ' + name.split(' ')[0] + ', כאן נועה מ-ishur.io. ראיתי שהשארת פרטים לגבי אישורי הגעה. לאיזה אירוע?' });
  if (status !== 'new' || i % 2) activity.push({ id: 'ac_' + i + '_2', lead_id: L.id, at: L.last_inbound_at, kind: 'wa', dir: 'in', text: pick(['חתונה, בערך 300 מוזמנים', 'כמה זה עולה?', 'אפשר שתתקשרו?', 'מעולה, תשלחו פרטים']) });
  if (['talking', 'quoted', 'closed'].includes(status)) activity.push({ id: 'ac_' + i + '_3', lead_id: L.id, at: iso(created + 1, 17), kind: 'call', dir: 'out', by: L.owner, duration_s: 120 + Math.floor(rnd() * 400), outcome: pick(['answered', 'answered', 'no_answer']) });
}

const PLANS = ['basic', 'pro', 'premium'];
const clients = [];
leads.filter((l) => l.status === 'closed').concat(Array.from({ length: 12 }, (_, k) => ({ id: null, phone: phone(200 + k), name: pick(FIRST) + ' ' + pick(LAST), occasion: pick(OCC), records_estimate: pick(RECS), client_token: tok(100 + k) }))).forEach((l, k) => {
  const ev = k === 2 ? 0 : k === 5 ? 0 : -10 + Math.floor(rnd() * 70), records = l.records_estimate, guests = records * 2;
  const confirmed = ev < 0 ? Math.floor(guests * 0.8) : Math.floor(guests * rnd() * 0.7), declined = Math.floor((guests - confirmed) * 0.3);
  const plan = pick(PLANS), host = k % 3 === 0 ? (records > 300 ? 2 : 1) : 0;
  const C = {
    token: l.client_token, name: l.name, phone: l.phone, occasion: l.occasion, event_date: day(ev), event_time: '19:30', venue: pick(['אולם הגן', 'גני התערוכה', 'בית החווה', 'אחוזת השקמים']),
    plan, records, status: ev < 0 ? 'done' : k === 7 ? 'hold' : k % 6 === 4 ? 'setup' : 'active',
    counts: { guests, confirmed, declined, pending: guests - confirmed - declined }, paid: 0, paid_at: iso(-5 - k, 14), lead_id: l.id || null,
    addons: { design: k % 4 === 1 ? pick(['brief', 'draft', 'revision', 'approved']) : null, hostesses: host, calls: plan !== 'basic', extra_wave: k % 5 === 0 },
    links: { dashboard: 'https://ishur.io/dashboard.html?t=' + l.client_token, upload: 'https://ishur.io/upload.html?t=' + l.client_token, feedback: ev < 0 ? 'https://ishur.io/feedback.html?t=' + l.client_token : null },
  };
  C.paid = { basic: { 100: 99, 200: 199, 300: 299, 400: 399, 500: 499 }, pro: { 100: 149, 200: 279, 300: 379, 400: 489, 500: 589 }, premium: { 100: 199, 200: 339, 300: 449, 400: 559, 500: 669 } }[plan][records] + (host === 1 ? 1790 : host === 2 ? 1990 : 0) + (C.addons.design ? 79 : 0);
  clients.push(C);
  const t = C.token;
  activity.push({ id: 'cac_' + k + '_p', client_token: t, at: C.paid_at, kind: 'payment', dir: 'in', text: 'תשלום ₪' + C.paid + ' · ' + plan + ' ' + records + ' רשומות', amount: C.paid });
  activity.push({ id: 'cac_' + k + '_w1', client_token: t, at: iso(Math.min(ev - 14, -1), 11), kind: 'send', dir: 'out', text: 'גל הזמנה 1 · ' + guests + ' הודעות', count: guests });
  activity.push({ id: 'cac_' + k + '_r', client_token: t, at: iso(Math.min(ev - 13, -1), 9), kind: 'replies', dir: 'in', text: confirmed + ' אישרו · ' + declined + ' לא מגיעים', count: confirmed + declined });
  if (k % 3 === 0) notes.push({ id: 'nt_c' + k, entity: 'client', entity_id: t, at: iso(-2, 15), by: 'shalev', text: pick(['ביקשו להוסיף 20 רשומות', 'האולם רוצה דוח סועדים יומיים לפני', 'לבדוק שההזמנה המעוצבת עלתה']), pinned: k === 0 });
});

const hostesses = [
  { id: 'hs_1', name: 'שלו', phone: phone(501), city: 'תל אביב', status: 'active', rate: 450, notes_count: 1 },
  { id: 'hs_2', name: 'נועה ב.', phone: phone(502), city: 'רמת גן', status: 'active', rate: 400 },
  { id: 'hs_3', name: 'אור', phone: phone(503), city: 'ראשון לציון', status: 'active', rate: 400 },
  { id: 'hs_4', name: 'ליה', phone: phone(504), city: 'חיפה', status: 'active', rate: 420 },
  { id: 'hs_5', name: 'טל', phone: phone(505), city: 'ירושלים', status: 'inactive', rate: 400 },
  { id: 'hs_6', name: 'עדן', phone: phone(506), city: 'פתח תקווה', status: 'active', rate: 380 },
];
const assignments = [];
const needs = clients.filter((c) => c.addons.hostesses > 0);
needs.forEach((c, k) => {
  for (let n = 0; n < c.addons.hostesses; n++) {
    if (k === 1 && n === 1) continue; /* one event short-staffed */
    const h = hostesses[(k + n * 2) % 4];
    assignments.push({ id: 'as_' + k + '_' + n, hostess_id: h.id, client_token: c.token, event_name: c.name, date: c.event_date, start: '18:30', end: '23:30', status: c.status === 'done' ? 'done' : pick(['confirmed', 'confirmed', 'proposed']), pay: h.rate, paid: c.status === 'done' && k % 2 === 0 });
  }
});
/* a deliberate double-booking for the conflicts banner */
const c0 = clients.find((c) => c.event_date === day(0));
if (c0) {
  c0.addons.hostesses = Math.max(1, c0.addons.hostesses);
  assignments.push({ id: 'as_today_a', hostess_id: 'hs_1', client_token: c0.token, event_name: c0.name, date: c0.event_date, start: '19:00', end: '23:00', status: 'confirmed', pay: 450, paid: false });
  const c1 = clients.filter((c) => c.event_date === day(0))[1] || clients[3];
  assignments.push({ id: 'as_today_b', hostess_id: 'hs_1', client_token: c1.token, event_name: c1.name, date: day(0), start: '20:00', end: '23:30', status: 'proposed', pay: 450, paid: false });
}
notes.push({ id: 'nt_h1', entity: 'hostess', entity_id: 'hs_1', at: iso(-3, 12), by: 'richard', text: 'זמינה רק בערבים, לא בשישי', pinned: true });

const templates = [
  { name: 'paylink_followup', label: 'קישור תשלום (תבנית)', preview: 'היי {{1}}, בהמשך לשיחה שלנו, זה הקישור לתשלום: {{2}}', vars: ['first_name', 'url'] },
  { name: 'lead_reengage', label: 'חזרה לליד (תבנית)', preview: 'היי {{1}}, רצינו לבדוק אם עוד רלוונטי לך אישורי הגעה לאירוע 🙂', vars: ['first_name'] },
];

const revenue = Array.from({ length: 30 }, (_, k) => ({ day: day(k - 29), amount: Math.round((k % 7 === 5 ? 0 : 300 + rnd() * 2400) / 10) * 10 }));
const stats = {
  revenue_30d: revenue,
  funnel: { new: leads.length, talking: leads.filter((l) => l.status !== 'new').length, quoted: leads.filter((l) => ['quoted', 'closed'].includes(l.status)).length, closed: leads.filter((l) => l.status === 'closed').length, window_days: 30 },
  sends_14d: Array.from({ length: 14 }, (_, k) => ({ day: day(k - 13), wa: Math.round(200 + rnd() * 1400) })),
  calls_14d: Array.from({ length: 14 }, (_, k) => ({ day: day(k - 13), calls: k % 7 === 5 ? 0 : Math.round(10 + rnd() * 90) })),
};
const agenda = {
  sends_today: [{ client_token: clients[0].token, name: clients[0].name, kind: 'wave', label: 'גל תזכורת 2', at: iso(0, 11), count: 240 }, { client_token: clients[2].token, name: clients[2].name, kind: 'eventday', label: 'יום האירוע', at: iso(0, 12), count: 380 }, { client_token: clients[4].token, name: clients[4].name, kind: 'daybefore', label: 'יום לפני', at: iso(0, 17), count: 150 }],
};

const W = (n, d) => writeFileSync(join(OUT, n + '.json'), JSON.stringify({ ok: true, fixture: true, as_of: AS_OF, ...d }, null, 1) + '\n');
W('leads', { items: leads });
W('clients', { items: clients });
W('hostesses', { hostesses, assignments });
W('notes', { items: notes });
W('activity', { items: activity });
W('templates', { items: templates });
W('stats', stats);
W('agenda', agenda);
console.log('crm fixtures:', leads.length, 'leads,', clients.length, 'clients,', assignments.length, 'assignments,', notes.length, 'notes,', activity.length, 'activity');
