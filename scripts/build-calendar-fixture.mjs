/* fixtures/ops/calendar.json (+ `rolled` on fixtures/ops/capacity.json) for ops.html?mock=1.
   Run: OPS_ADMIN_KEY=… node scripts/build-calendar-fixture.mjs [--base https://go.ishur.io] [--month YYYY-MM]
   Read-only. Once /api/ops/calendar is deployed it is copied as-is (masked). Until then the month is
   composed LOCALLY with the real worker functions (planCapacity + calendarMonth from worker/ops.js) over
   the live /api/ops/capacity and /api/send-board responses — so it has no audit-only data
   (per-day audit counts, Shir's done rounds, closed purchases): those need the deployed endpoint.
   Masking = the same rules as build-ops-fixtures.mjs (event names → pseudonyms by tok8, phones, tokens). */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures/ops');
const KEY = process.env.OPS_ADMIN_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'https://go.ishur.io');
if (!KEY) { console.error('set OPS_ADMIN_KEY'); process.exit(2); }
const { planCapacity, calendarMonth } = await import(pathToFileURL(join(ROOT, 'worker/ops.js')));
const { isNoContactDay } = await import(pathToFileURL(join(ROOT, 'worker/shir.js')));

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OURS = /(6673|9799|4499)$/;
const maskStr = (s) => String(s).replace(UUID, '$1-0000-4000-8000-000000000000').replace(/(?<!\d)(972\d{8,9}|0\d{1,2}-?\d{3}-?\d{4})(?!\d)/g, (m) => (OURS.test(m.replace(/\D/g, '')) ? m : m.slice(0, 5) + '****' + m.slice(-3)));
/* the pseudonyms the other fixtures already use (capacity.json), so tok8 → name agrees across files */
const capFx = JSON.parse(readFileSync(join(OUT, 'capacity.json'), 'utf8'));
const names = new Map();
for (const d of capFx.days) for (const e of d.by_event) names.set(e.tok8, e.name);
for (const r of capFx.recommendations || []) names.set(r.tok8, r.name);
const pseudo = (tok8) => { if (!names.has(tok8)) names.set(tok8, 'אירוע ' + String.fromCharCode(0x5d0 + (names.size % 22)) + (names.size >= 22 ? names.size : '')); return names.get(tok8); };
const deep = (o, fn) => (Array.isArray(o) ? o.map((x) => deep(x, fn)) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(k, deep(v, fn), o)])) : o);
const scrub = (o) => deep(o, (k, v, p) => ((k === 'name' || k === 'event') && p && p.tok8 ? pseudo(p.tok8) : typeof v === 'string' ? maskStr(v) : v));

const get = async (p) => { const r = await fetch(BASE + '/api/ops/' + p, { headers: { 'X-Admin-Key': KEY } }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
/* 1 · capacity.json gets the rolled plan (re-planned on the masked fixture itself: same items, same model) */
const items = capFx.days.flatMap((d) => d.by_event.map((e) => ({ day: d.day, token: e.token || e.tok8, tok8: e.tok8, name: e.name, type: e.type, count: e.count, held: e.held, upper_bound: e.upper_bound })));
const model = { ...capFx.model, friday_capacity: capFx.model.friday_capacity ?? Math.min(capFx.model.capacity_per_day, 25 * 25) };
const plan = planCapacity({ today: capFx.today, days: capFx.days.length, items, model, isNoContactDay });
const capOut = { ...capFx, model, days: plan.days.map((r, i) => ({ ...capFx.days[i], rolled: r.rolled.map(({ token, ...x }) => x), out: r.out, rolled_in: r.rolled_in, carry: r.carry })), unplaced: plan.unplaced.map(({ token, ...x }) => x) };
writeFileSync(join(OUT, 'capacity.json'), JSON.stringify(capOut, null, 1) + '\n'); console.log('  capacity.json: rolled added');

/* 2 · calendar.json */
const month = arg('--month', capFx.today.slice(0, 7));
const live = await get('calendar?month=' + month);
let cal;
if (live.status === 200 && live.j.ok) { cal = { ...scrub(live.j), source: 'live /api/ops/calendar' }; }
else {
  const cap = (await get('capacity?days=28')).j;
  const sb = await (await fetch(BASE + '/api/send-board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: KEY, detail: false }) })).json();
  const capItems = cap.days.flatMap((d) => d.by_event.map((e) => ({ day: d.day, token: e.token, tok8: e.tok8, name: e.name, type: e.type, count: e.count, held: e.held })));
  const m2 = { ...cap.model, friday_capacity: Math.min(cap.model.capacity_per_day, 25 * 25) };
  const p2 = planCapacity({ today: cap.today, days: cap.days.length, items: capItems, model: m2, isNoContactDay });
  const events = sb.events.map((e) => ({ token: e.token, name: e.name, date: e.date, occasion: '', time: '' }));
  cal = { ok: true, at: new Date().toISOString(), source: 'composed locally from live capacity + send-board (calendar endpoint not deployed): no audit counts, no closed purchases, no Shir rounds',
    ...calendarMonth({ month, today: cap.today, events, board: sb, capDays: p2.days, isNoContactDay, perDay: m2.capacity_per_day, fridayCap: m2.friday_capacity, window: { weekday: '09:00–20:30', friday: '09:00–13:00', shabbat: null } }) };
  cal = scrub(cal);
  console.log('  calendar endpoint answered ' + live.status + ' → composed locally');
  console.log('  LIVE rolled plan (next 7 days):');
  for (const r of p2.days.slice(0, 7)) console.log('   ', r.day, 'cap', r.capacity, 'out', r.out, r.rolled.map((x) => `${x.event} ${x.n}${x.from_day !== r.day ? ' ↪' + x.from_day : ''}`).join(' + '));
}
writeFileSync(join(OUT, 'calendar.json'), JSON.stringify({ fixture: true, fixture_from: BASE, ...cal }, null, 1) + '\n'); console.log('  wrote calendar.json');
