/* Phase 5 fixtures (?mock=1): fixtures/ops/{notifications,notify-settings,overview,overview-series}.json.
   Hand-made, fake people (97250000xxxx), zeroed tokens; shapes come from worker/notify.js itself
   (RULES, mergeCfg, windowOf/bucketsOf) so a backend rename shows up here. Usage: node scripts/build-notify-fixtures.mjs */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as N from '../worker/notify.js';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures/ops');
const now = Date.parse('2026-11-03T12:00:00+02:00'), iso = (m) => new Date(now - m * 60e3).toISOString(), today = '2026-11-03';
const n = (min, rule, severity, title_he, deep_link, extra = {}) => ({ id: 'nfx' + min, at: iso(min), severity, rule, title_he, body_he: '', deep_link, entity: rule + ':' + min, read: false, snoozed_until: null, channels: ['app', 'slack'], data: null, ...extra });
const items = [
  n(4, 'incident', 'P0', 'הפייסר לא רץ 40 דקות. יש תיקון שמחכה לאישור שלך.', '#/brain', { channels: ['app', 'slack', 'push', 'whatsapp'] }),
  n(12, 'new_lead', 'P2', 'ליד חדש: דנה מטופס פייסבוק. לענות תוך שעה.', '#/leads/L972500009001', { body_he: 'כתבה: "חתונה במרץ, 250 אורחים"\nהצעד הבא: לפתוח את הליד ולשלוח הצעה (יש נוסח מוכן).' }),
  n(35, 'payment', 'P1', 'שולם ₪790: אירוע ב · פרימיום 300. לוודא שהרשימה הועלתה.', '#/clients?focus=e5f6a7b8', { channels: ['app', 'slack', 'push'] }),
  n(70, 'unanswered', 'P1', 'ליד 0500-***-0301 מחכה לתשובה מ-09:50. לענות עכשיו.', '#/inbox?focus=972500000301'),
  n(130, 'event_readiness', 'P1', 'אירוע ג ב-06/11: חסר דיילות, הזמנה. לטפל היום.', '#/clients?focus=c9d0e1f2'),
  n(200, 'cap_high', 'P2', 'התקרה היומית ב-88% (220/250). מה שלא ייצא היום יידחה למחר.', '#/capacity', { read: true }),
  n(400, 'brain_autofix', 'P3', 'המוח תיקן לבד: שוחררה החזקה שנשכחה. אין צורך לעשות כלום.', '#/brain', { read: true }),
  n(900, 'deploy', 'P3', 'גרסה חדשה עלתה: notify.js', '#/changes', { read: true, channels: ['app'] }),
];
writeFileSync(join(OUT, 'notifications.json'), JSON.stringify({ ok: true, fixture: true, rules: Object.fromEntries(N.RULES.map((r) => [r.id, r.he])), items, unread: items.filter((x) => !x.read).length, next_cursor: null, source: 'fixture' }, null, 1));
writeFileSync(join(OUT, 'notify-settings.json'), JSON.stringify({ ok: true, fixture: true, severities: N.SEVERITIES, channels: N.CHANNELS, quiet_hours: { from: '21:00', to: '09:00' }, rules: N.RULES.map((r) => ({ id: r.id, he: r.he, default_severity: r.sev, dedupe_min: Math.round(r.window / 60e3), defaults: N.defaultCfg(r.id), ...N.mergeCfg(r.id, null) })) }, null, 1));
const w = N.windowOf('month', 0, today), b = N.bucketsOf(w), wave = (i, base, amp) => Math.max(0, Math.round(base + amp * Math.sin(i / 2.3) + ((i * 37) % 11) - 5));
const series = { revenue: b.map((_, i) => (i % 3 === 0 ? 0 : wave(i, 900, 600))), orders: b.map((_, i) => (i % 3 === 0 ? 0 : 1 + (i % 2))), leads: b.map((_, i) => wave(i, 6, 4)), closed: b.map((_, i) => i % 4 === 0 ? 1 : 0), sends: b.map((_, i) => wave(i, 180, 90)), fails: b.map((_, i) => i % 5), calls: b.map((_, i) => wave(i, 30, 20)), visits: b.map((_, i) => wave(i, 140, 60)), ad_spend: b.map((_, i) => wave(i, 120, 40)), ad_leads: b.map((_, i) => wave(i, 4, 3)) };
const sum = (a) => a.reduce((x, y) => x + y, 0);
writeFileSync(join(OUT, 'overview-series.json'), JSON.stringify({ ok: true, fixture: true, at: new Date(now).toISOString(), window: w, buckets: b, series, why: { revenue: '', sends: '', calls: '', visits: '', ads: '' }, totals: { revenue: sum(series.revenue), orders: sum(series.orders), leads: sum(series.leads) }, prev_totals: { revenue: Math.round(sum(series.revenue) * 0.8), orders: 14, leads: Math.round(sum(series.leads) * 1.1) }, undated_sales: 2 }, null, 1));
const last7 = (k) => series[k].slice(-7);
const ov = {
  ok: true, fixture: true, at: new Date(now).toISOString(), today, last_seen: iso(600),
  waiting: N.waitingFor({ pending: [{ id: 'pfx1', name_he: 'הפעלת הפייסר מחדש', title_he: 'הפייסר לא רץ 40 דקות', finding_id: 'pacer_stale' }],
    convs: [{ role: 'lead', phone: '972500000301', last_dir: 'in', last_in_ts: now - 130 * 60e3 }, { role: 'client', phone: '972500000302', name: 'לקוח 2', last_dir: 'in', last_in_ts: now - 75 * 60e3 }],
    reminders: [{ text: 'להתקשר לדנה לגבי ההצעה', due_at: iso(90), entity_type: 'lead', entity_id: 'L972500009001' }],
    events: [{ tok8: 'c9d0e1f2', names: 'אירוע ג', date: '2026-11-06', readiness: [{ id: 'list', he: 'רשימת מוזמנים', state: 'ok' }, { id: 'invite', he: 'הזמנה', state: 'missing' }, { id: 'hostess', he: 'דיילות', state: 'missing' }] }] }, now),
  incidents: [{ severity: 'P0', rule: 'incident', title_he: 'הפייסר לא רץ 40 דקות. יש תיקון שמחכה לאישור שלך.', href: '#/brain', action: { type: 'brain-decision', id: 'pfx1', confirm: 'pfx1', label_he: 'לאשר תיקון' } },
    { severity: 'P2', rule: 'cap_high', title_he: 'התקרה היומית ב-88% (220/250). מה שלא ייצא היום יידחה למחר.', href: '#/capacity', action: { type: 'nav', href: '#/capacity', label_he: 'לפתוח' } }],
  money: { today: 790, today_orders: 1, month: 2370, last_month_to_date: 1980, open_quotes: 4, open_quotes_sum: 3160, spark: last7('revenue'), recent: [] },
  leads: { new_today: 3, waiting_1h: 1, quoted: 4, closed_today: 1, spark: last7('leads') },
  sends: { sent: 220, failed: 3, cap_used: 220, cap_limit: 250, cap_pct: 88, queue_why: 'will-send', next_tick_at: iso(-6), paused: false, spark: last7('sends') },
  calls: { dialed: 42, answered: 27, remaining: 18, shir: 'dialing', why: 'will-dial', spark: last7('calls') },
  spark_days: b.slice(-7),
  events: [
    { token: '', tok8: 'a1b2c3d4', names: 'אירוע א', date: '2026-11-03', plan_he: 'פרימיום', status: 'live', invited: 280, confirmed: 190, readiness: [{ id: 'list', he: 'רשימת מוזמנים', state: 'ok' }, { id: 'invite', he: 'הזמנה', state: 'ok' }] },
    { token: '', tok8: 'c9d0e1f2', names: 'אירוע ג', date: '2026-11-06', plan_he: 'פרו', status: 'upcoming', invited: 150, confirmed: 40, readiness: [{ id: 'list', he: 'רשימת מוזמנים', state: 'ok' }, { id: 'invite', he: 'הזמנה', state: 'missing' }, { id: 'hostess', he: 'דיילות', state: 'missing' }] },
    { token: '', tok8: 'e5f6a7b8', names: 'אירוע ב', date: '2026-11-09', plan_he: 'בסיס', status: 'upcoming', invited: 0, confirmed: 0, readiness: [{ id: 'list', he: 'רשימת מוזמנים', state: 'missing' }, { id: 'invite', he: 'הזמנה', state: 'unknown' }, { id: 'gifts', he: 'קישורי מתנה', state: 'ok' }] }],
  changes: { since: iso(600), count: 3, items: [{ id: 'cfx1', at: iso(30), kind: 'edit', actor: 'Richard', summary_he: 'גודל פעימה: 25 → 20' }, { id: 'cfx2', at: iso(200), kind: 'brain', actor: 'brain', summary_he: 'שוחררה החזקה שנשכחה' }, { id: 'cfx3', at: iso(500), kind: 'deploy', actor: 'system', summary_he: 'גרסה 8f4aa331 עלתה' }] },
  balances: { low: [{ vendor: 'retell', amount: 12.4, currency: 'USD', status: 'low' }], checked_at: iso(8) },
  notifications: { unread: items.filter((x) => !x.read).length, latest: items.slice(0, 5) },
  ads: { today: { spend: 118, leads: 4, cpl: 29.5, roas: 6.7 }, d7: { spend: 842, leads: 31, cpl: 27.2, roas: 4.1 }, d30: { spend: 3410, leads: 118, cpl: 28.9, roas: 3.6 }, spark: last7('ad_spend') },
  traffic: { visitors_7d: 1012, live_now: 3, spark: last7('visits'), top_sources: [{ src: 'facebook', n: 610 }, { src: 'google', n: 220 }, { src: 'direct', n: 140 }], lead_pct: 3.1, purchase_pct: 0.7 },
  funnel: { visitors_7d: 1012, leads: 118, quoted: 46, closed: 19 },
  growth: { month: 2370, last_month: 1980, mom_pct: 20 },
  totals: { revenue: 48210, sales: 61, undated: 2, events: 64, guests: 15890 },
  errors: [],
};
writeFileSync(join(OUT, 'overview.json'), JSON.stringify(ov, null, 1));
console.log('wrote 4 fixtures');
