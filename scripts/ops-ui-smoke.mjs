/* ops.html smoke test.
   Part A (always, plain node): node --check every module, size budgets, every screen's
   view functions render the fixtures to non-empty HTML without throwing and without
   leaking "undefined"/"NaN"/"[object Object]".
   Part B (only if Playwright can be loaded): serve the repo, open ops.html?mock=1, assert
   skeleton-before-data, ≤3 data requests on load, every route renders without console
   errors, the typed-confirm toggle flow, no horizontal scroll at 375 px, and save
   screenshots to docs/ops-screens/.
   Exit 0 = all run checks passed. Usage: node scripts/ops-ui-smoke.mjs [--no-browser] */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPS = join(ROOT, 'assets/ops');
let fails = 0, passes = 0;
const ok = (cond, name, extra = '') => { if (cond) { passes++; console.log('  ✓ ' + name + (extra ? ' · ' + extra : '')); } else { fails++; console.log('  ✗ ' + name + (extra ? ' · ' + extra : '')); } };

console.log('A1 syntax');
const mods = ['app.js', 'ui.js', 'adapt.js', ...readdirSync(join(OPS, 'screens')).map((f) => 'screens/' + f)];
/* lazy modules (outside the counted budget, loaded only on their route): syntax-checked, not counted */
const lazy = ['mock.js', ...(existsSync(join(OPS, 'lazy')) ? readdirSync(join(OPS, 'lazy')).map((f) => 'lazy/' + f) : [])];
const crmMods = readdirSync(join(OPS, 'crm')).map((f) => 'crm/' + f);
for (const m of [...mods, ...crmMods, ...lazy.filter((m) => m !== 'mock.js')]) { const r = spawnSync(process.execPath, ['--check', join(OPS, m)], { encoding: 'utf8' }); ok(r.status === 0, 'node --check ' + m, r.stderr.trim().split('\n')[0]); }

console.log('A2 size budgets');
const js = mods.reduce((a, m) => a + statSync(join(OPS, m)).size, 0), css = statSync(join(OPS, 'ops.css')).size, html = statSync(join(ROOT, 'ops.html')).size;
/* 03/11 design pass: 120 → 130 KB (measured 128.9 KB): §11 section router + page tabs (app.js), sortable Table, Phone/EventLink/DatePicker renderers (ui.js), capacity meters, live insert-only feed. Behaviour that is not needed at first paint lives in lazy/kit2.js. */
ok(js < 130 * 1024, 'JS total < 130 KB', (js / 1024).toFixed(1) + ' KB');
ok(css < 40 * 1024, 'CSS < 40 KB', (css / 1024).toFixed(1) + ' KB');
console.log('    ops.html ' + (html / 1024).toFixed(1) + ' KB · lazy (not counted): ' + lazy.map((m) => m + ' ' + (statSync(join(OPS, m)).size / 1024).toFixed(1) + ' KB').join(', '));
const html0 = readFileSync(join(ROOT, 'ops.html'), 'utf8');
ok(!/<select|type="checkbox"|alert\(|confirm\(|prompt\(/.test(html0 + [...mods, ...lazy].map((m) => readFileSync(join(OPS, m), 'utf8')).join('')), 'no native select/checkbox/alert/confirm/prompt');
ok(/class="sk /.test(html0), 'ops.html ships skeleton markup for first paint');
const crmSizes = crmMods.map((m) => statSync(join(OPS, m)).size), crmJs = crmSizes.reduce((a, b) => a + b, 0);
/* 03/11 design pass: CRM total 100 → 110 KB (measured 108.1 KB): client card edit block + grouped actions, leads table columns */
ok(crmSizes.every((n) => n < 40 * 1024) && crmJs < 110 * 1024, 'CRM modules (lazy, not in the counted bundle) each < 40 KB, total < 110 KB', (crmJs / 1024).toFixed(1) + ' KB in ' + crmMods.length + ' files');
ok(!mods.some((m) => /^\s*import[^;(]*['"][./]*\/?crm\//m.test(readFileSync(join(OPS, m), 'utf8'))) && !/modulepreload[^>]*crm\//.test(html0), 'counted modules never import crm/* statically (only lazy import())');
ok(!/<select|type="checkbox"|alert\(|confirm\(|prompt\(/.test(crmMods.map((m) => readFileSync(join(OPS, m), 'utf8')).join('')), 'CRM modules: no native select/checkbox/alert/confirm/prompt');
ok(!/href="admin\.html"/.test(html0) && /data-r="leads"/.test(html0) && /data-r="clients"/.test(html0) && /data-r="hostesses"/.test(html0), 'nav: לידים / לקוחות / דיילות added, admin.html clients link removed');

console.log('A3 fixture rendering');
/* fixtures are masked copies of real API responses; screens render them only through adapt() */
const fx = (n) => JSON.parse(readFileSync(join(ROOT, 'fixtures/ops', n + '.json'), 'utf8'));
const { adapt } = await import(pathToFileURL(join(OPS, 'adapt.js')));
const RAW = Object.fromEntries(['registry', 'runs', 'run', 'realtime', 'capacity', 'balances', 'live', 'brain', 'toggle', 'code', 'calendar', 'changes'].map((n) => [n, fx(n)]));
const NAMES = Object.fromEntries(RAW.registry.nodes.map((n) => [n.id, n.name_he]));
const F = Object.fromEntries(Object.entries(RAW).map(([n, d]) => [n, ['toggle', 'code', 'calendar', 'changes'].includes(n) ? d : adapt(n, d, { names: NAMES })]));
console.log('A3a contract (fixture keys the adapter reads exist in the real-shaped fixtures)');
ok(RAW.realtime.wa && Array.isArray(RAW.realtime.wa.numbers) && RAW.realtime.cap && RAW.realtime.queue && 'calls' in RAW.realtime && RAW.realtime.pacer, 'realtime: wa.numbers, cap, queue, calls, pacer');
ok(RAW.realtime.wa.numbers.every((n) => 'sent_today' in n && 'by_reason' in n && 'by_event' in n && 'failed_by_code' in n), 'realtime.wa.numbers[] fields');
ok(RAW.capacity.days.every((d) => 'day' in d && 'planned' in d && 'capacity' in d && 'overflow' in d && Array.isArray(d.by_event)), 'capacity.days[] fields');
ok(RAW.capacity.days.every((d) => Array.isArray(d.rolled) && 'out' in d && d.out <= d.capacity && d.rolled.every((x) => 'event' in x && 'type' in x && 'n' in x && 'from_day' in x)), 'capacity.days[].rolled (planner output) fields, out ≤ capacity');
ok(RAW.calendar.days.every((d) => 'date' in d && 'dow' in d && 'open' in d && 'used' in d && 'capacity' in d && Array.isArray(d.events) && Array.isArray(d.items)) && Array.isArray(RAW.calendar.events), 'calendar.days[] fields');
ok(RAW.calendar.days.filter((d) => d.dow === 6).every((d) => !d.open && !d.items.some((i) => ['planned', 'rolled'].includes(i.state))), 'calendar: nothing planned or rolled onto Shabbat');
ok(RAW.balances.vendors.every((v) => 'vendor' in v && 'status' in v && 'source' in v && 'extra' in v), 'balances.vendors[] fields');
ok(RAW.registry.nodes.every((n) => 'state' in n && 'kill_switch' in n && 'risk' in n), 'registry.nodes[] fields');
ok(RAW.live.items.every((i) => 'ts' in i && 'type' in i), 'live.items[] have ts + type');
ok(Object.values(RAW.toggle.by_id).every((t) => t.applied === false && t.blast_radius), 'toggle fixtures are blast-radius-only (applied:false)');
ok(!(JSON.stringify(RAW).match(/(?<![\d*])972\d{8,9}(?!\d)/g) || []).some((m) => !/(6673|9799|4499)$/.test(m)), 'no unmasked guest/client 972… phones in fixtures (our 6673/9799/4499 allowed)');
ok(!/[0-9a-f]{8}-(?!0000-4000-8000-000000000000)[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify(RAW)), 'no unmasked event tokens (UUIDs) in fixtures');
ok(!/webhookKey"?\s*[:=]\s*"?[^"•\s]/.test(JSON.stringify(RAW).replace(/\\"/g, '"')), 'no webhookKey values in fixtures');
const S = {};
for (const n of ['overview', 'automations', 'runs', 'live', 'brain', 'calls', 'capacity', 'balances']) S[n] = await import(pathToFileURL(join(OPS, 'screens', n + '.js')));
const check = (name, fn) => {
  let out = '';
  try { out = fn(); } catch (e) { ok(false, name, e.message); return; }
  const bad = /undefined|NaN|\[object Object\]/.exec(out.replace(/<script[\s\S]*?<\/script>/g, ''));
  ok(typeof out === 'string' && out.length > 200 && !bad, name, out.length + ' chars' + (bad ? ' · leaked "' + bad[0] + '"' : ''));
};
const reg = F.registry;
check('overview.view', () => S.overview.view(F.realtime, F.capacity, F.balances));
check('overview.skeleton', () => S.overview.default.skeleton());
check('automations.listView', () => S.automations.listView(reg.nodes, {}));
/* live data may have no failing / switched-off node: derive one from a real node through adapt so the
   filter + off rendering are still exercised (same adapter path as a real failing/off node) */
const raw0 = RAW.registry.nodes.find((n) => n.id === 'wave1');
const regV = adapt('registry', { ...RAW.registry, nodes: RAW.registry.nodes.map((n) => (n.id === 'wave1' ? { ...raw0, state: { ...raw0.state, enabled: false, off: { at: '2026-11-03T10:00:00Z', by: 'richard', reason: 'בדיקה' }, last_run_at: '2026-11-03T10:00:00Z', by_status_24h: { failed: 2 } } } : n)) });
check('automations.listView filtered (failing)', () => S.automations.listView(regV.nodes, { state: 'failing' }));
for (const id of ['d_pacer', 'wave1', 'shir_dispatch', 'autoretry', 'noa_queue', 'wa_fail']) check('automations.detailView ' + id, () => S.automations.detailView(reg.nodes.find((n) => n.id === id), reg.nodes));
check('automations.depGraph d_pacer', () => S.automations.depGraph(reg.nodes.find((n) => n.id === 'd_pacer'), reg.nodes));
check('automations.blastBody', () => S.automations.blastBody(reg.nodes.find((n) => n.id === 'd_pacer'), adapt('toggle', RAW.toggle.by_id.d_pacer).blast));
const UI = await import(pathToFileURL(join(OPS, 'ui.js')));
check('automations Code from /code', () => UI.Code(adapt('code', RAW.code.by_id.d_pacer).code));
check('automations.runsTable', () => S.automations.runsTable(F.runs.items.slice(0, 30)));
const sorted = S.automations.sortNodes(reg.nodes);
ok(sorted.length === reg.nodes.filter((n) => n.layer > 0).length && sorted[0].daypart === 'continuous', 'automations sorted by day-part', sorted.length + ' rows');
ok(S.automations.listView(regV.nodes, { state: 'off' }).includes('aria-checked="false"'), 'disabled automations render as switched off');
check('runs.listView', () => S.runs.listView(F.runs.items.slice(0, 50)));
check('runs.runDetail', () => S.runs.runDetail(F.run));
check('live rows', () => F.live.items.map(S.live.row).join(''));
ok(F.live.items.filter((x) => S.live.match(x, { kind: 'call' })).every((x) => x.kind === 'call'), 'live filter by kind');
check('brain.findingsView', () => S.brain.findingsView(F.brain.findings));
check('brain.playbooksView', () => S.brain.playbooksView(F.brain.playbooks));
/* Phase 4a (lazy/messaging.js, lazy/inbox.js, lazy/control.js; fixtures from scripts/build-p4a-fixtures.mjs) */
const P4 = Object.fromEntries(['messages', 'inbox', 'thread', 'control'].map((n) => [n, fx(n)]));
const MSG = await import(pathToFileURL(join(OPS, 'lazy/messaging.js'))), INB = await import(pathToFileURL(join(OPS, 'lazy/inbox.js'))), CTL = await import(pathToFileURL(join(OPS, 'lazy/control.js')));
ok((JSON.stringify(P4).match(/972\d{9}/g) || []).every((m) => /^97250000\d{4}$/.test(m)) && !/[0-9a-f]{8}-(?!0000-0000-0000-000000000000)[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify(P4)), 'p4a fixtures: only fake 97250000xxxx phones, zeroed tokens');
ok(P4.messages.items.every((x) => ['id', 'ts', 'at', 'number', 'to', 'to_name', 'event', 'type', 'type_he', 'template', 'text', 'status', 'error_code', 'reply', 'reason', 'statuses'].every((k) => k in x)) && P4.messages.inbound.every((x) => ['id', 'from', 'text', 'in_reply_to'].every((k) => k in x)), 'messages contract: item + inbound fields (worker/ops-inbox.js groupMessages)');
ok(new Set(P4.messages.items.map((x) => x.id)).size === P4.messages.items.length && P4.messages.items.some((x) => x.statuses.length > 1), 'messages: one item per wamid even when it has several status rows');
const mAll = MSG.table(P4.messages.items, 'all');
ok((mAll.match(/class="msg-row"/g) || []).length === P4.messages.items.length, 'messaging table: one row per message', P4.messages.items.length + ' rows');
check('messaging.view all', () => MSG.view({ day: '2026-11-03', tab: 'all', data: P4.messages, open: new Set([P4.messages.items[0].id]) }));
check('messaging.view failed', () => MSG.view({ day: '2026-11-03', tab: 'failed', data: { ...P4.messages, items: P4.messages.items.filter((x) => x.status === 'failed') }, open: new Set() }));
check('messaging.view replies', () => MSG.view({ day: '2026-11-03', tab: 'replies', data: { ...P4.messages, items: P4.messages.inbound }, open: new Set([P4.messages.inbound[0].id]) }));
check('messaging.numberStrip', () => MSG.numberStrip(F.realtime) + '<x>'.repeat(20));
const rep = P4.messages.items.find((x) => x.reply), fl = P4.messages.items.find((x) => x.status === 'failed');
ok(MSG.detail(rep).includes(rep.reply.text) && MSG.detail(rep).includes(rep.text.slice(0, 20)) && MSG.detail(fl).includes(fl.error_code), 'message detail: full text, the guest reply, the failure code');
check('messaging empty', () => MSG.table([], 'all') + MSG.table([], 'replies') + '<x>'.repeat(40));
check('inbox.view', () => INB.view({ ch: '', q: '', list: P4.inbox, sel: '', thread: null }));
ok(INB.listView(P4.inbox.items).indexOf('conv unread') < INB.listView(P4.inbox.items).indexOf('class="conv"'), 'inbox: unread conversations come first');
for (const c of P4.inbox.items.slice(0, 6)) check('inbox.threadView ' + c.role, () => INB.threadView(P4.thread.by_phone[c.phone], { now: Date.parse('2026-11-03T10:00:00Z') }));
const thOpen = Object.values(P4.thread.by_phone).find((t) => t.window.open && t.channel === 'client'), thShut = Object.values(P4.thread.by_phone).find((t) => !t.window.open);
ok((INB.bubbles(thOpen.messages).match(/class="bub /g) || []).length === thOpen.messages.length, 'thread: one bubble per message');
ok(/id="ibx-txt"/.test(INB.composer(thOpen, { now: Date.parse('2026-11-03T10:00:00Z') })) && /data-act="ibx-send-tpl"/.test(INB.composer(thShut, { now: Date.parse('2026-11-03T10:00:00Z') })) && !/ibx-txt/.test(INB.composer(thShut, { now: Date.parse('2026-11-03T10:00:00Z') })), 'composer: free text inside the 24h window, template chooser outside');
ok(!/data-act="ibx-send/.test(INB.composer(thOpen, { now: Date.parse('2026-11-03T20:30:00Z') })), 'composer: no send to a client/lead in quiet hours (22:30 IL)');
ok(INB.SEND_WORD === 'שלח', 'inbox sends need the typed word שלח');
check('control.view', () => CTL.view(P4.control, {}));
check('control.view paused + loading', () => CTL.view({ ...P4.control, paused: true, brain_active: true }, {}) + CTL.view(null, {}));
ok(Object.keys(CTL.ACTIONS).filter((k) => k !== 'dry').every((k) => CTL.wordOf(k, k.includes('hold') || k.includes('cancel') ? P4.control.events[0] : k === 'ipn' ? 'ipnmiss:1' : '972500000101')) && CTL.wordOf('dry') === null, 'control: every action except the dry run needs a typed word');
ok(Object.keys(CTL.ACTIONS).every((k) => CTL.ACTIONS[k].blast(P4.control.events[0]).length > 20), 'control: every action has blast-radius text');
check('calls.view', () => S.calls.view(F.realtime));
check('capacity.view', () => S.capacity.view(F.capacity));
ok(S.capacity.view(F.capacity).includes('▲'), 'capacity shows over-capacity marker', F.capacity.alerts.length + ' alert days');
check('balances.view', () => S.balances.view(F.balances));
const capTip = S.capacity.outTip(F.capacity.days.find((d) => d.rolled_in > 0) || F.capacity.days[0]);
ok(/^ · יוצא: [\d,]+ \(.+ [\d,]+( \+ .+ [\d,]+)*\)( · נדחה מ-\d\d\/\d\d: [\d,]+)+$/.test(capTip), 'capacity tooltip: "יוצא: N (event n + …) · נדחה מ-dd/mm: n"', capTip);
ok(S.capacity.capBars(F.capacity.days).includes('stroke-dasharray'), 'capacity bars: rolled = primary, original due = outline');
const CAL = await import(pathToFileURL(join(OPS, 'lazy/calendar.js')));
const allF = { f: new Set(CAL.FILTERS.map((f) => f.id)), view: 'month', ev: '', q: '' };
check('calendar.view month', () => CAL.view(RAW.calendar, allF));
check('calendar.view week', () => CAL.view(RAW.calendar, { ...allF, view: 'week' }));
check('calendar.view empty month', () => CAL.view(CAL.emptyMonth('2026-12'), allF));
const calItems = RAW.calendar.days.flatMap((d) => d.items);
for (const s0 of ['planned', 'partial', 'held', 'rolled', 'ghost']) { const it = calItems.find((i) => i.state === s0); ok(!!it, 'calendar fixture has a ' + s0 + ' chip'); if (it) check('calendar.chipDetail ' + s0, () => CAL.chipDetail(it) + '<x>'.repeat(40)); }
const busy = RAW.calendar.days.reduce((a, d) => (d.items.length > a.items.length ? d : a));
check('calendar.dayDrawer', () => CAL.dayDrawer(busy, RAW.calendar, allF));
ok(CAL.cellHtml(RAW.calendar.days.find((d) => d.items.some((i) => i.state === 'rolled')), allF).includes('↪ מ-'), 'rolled chip shows "↪ מ-dd/mm" on the day it goes out');
const only = (f) => ({ ...allF, f: new Set(f) });
ok(RAW.calendar.days.every((d) => CAL.visible(d, only(['held'])).items.every((i) => i.state === 'held')) && RAW.calendar.days.every((d) => CAL.visible(d, only(['sends'])).events.length === 0), 'calendar filters: held only / sends hide event days');
const ev0 = RAW.calendar.events[0].tok8;
ok(RAW.calendar.days.every((d) => CAL.visible(d, { ...allF, ev: ev0 }).items.every((i) => i.tok8 === ev0)), 'calendar per-event filter');
ok(RAW.calendar.days.every((d) => CAL.visible(d, { ...allF, q: 'zzzz-no-match' }).items.length === 0), 'calendar text search');
const closedDay = { ...RAW.calendar.days[0], items: [{ id: 'closed:x', kind: 'closed', tok8: '', event: 'לקוח', type: 'closed', type_he: 'סגירה', state: 'done', at: '2026-11-02T09:00:00Z', package: 'פרמיום', records: 300, sum: 1490 }] };
ok(CAL.visible(closedDay, only(['closed'])).items.length === 1 && CAL.visible(closedDay, only(['sends'])).items.length === 0, 'calendar closed-purchase items follow the סגירות filter');
check('calendar.chipDetail closed', () => CAL.chipDetail(closedDay.items[0]) + '<x>'.repeat(40));
console.log('A3b change log (lazy/changes.js)');
const CH = await import(pathToFileURL(join(OPS, 'lazy/changes.js')));
ok(RAW.changes.items.every((x) => 'id' in x && 'at' in x && 'kind' in x && 'actor' in x && 'summary_he' in x && x.revert && 'possible' in x.revert && 'how' in x.revert), 'changes.items[] contract: id, at, kind, actor, summary_he, revert{possible, how}');
const chAll = { kinds: new Set(), actor: '', from: '', to: '', q: '' };
check('changes.toolbar', () => CH.toolbar(chAll));
check('changes.timeline', () => CH.timeline(RAW.changes.items, chAll));
check('changes.timeline empty', () => CH.timeline([], chAll) + '<x>'.repeat(60));
const days = CH.groupByDay(RAW.changes.items);
ok(days.length >= 3 && days.every((g, i) => i === 0 || g.day < days[i - 1].day), 'timeline grouped by Israel day, newest first', days.map((g) => g.day + ':' + g.items.length).join(' '));
for (const k of [...new Set(RAW.changes.items.map((x) => x.kind))]) check('changes.detail ' + k, () => CH.detail(RAW.changes.items.find((x) => x.kind === k)) + '<x>'.repeat(40));
const dep = RAW.changes.items.find((x) => x.kind === 'deploy');
ok(CH.row(dep).includes(dep.details.commits[0].subject) && CH.detail(dep).includes('wrangler rollback'), 'deploy entry lists its commit subjects + the rollback command');
ok(CH.detail(RAW.changes.items.find((x) => x.revert.possible && !x.reverted_at)).includes('data-act="chg-revert"') && !CH.detail(RAW.changes.items.find((x) => !x.revert.possible)).includes('chg-revert') && !CH.detail(RAW.changes.items.find((x) => x.reverted_at)).includes('chg-revert'), '"שחזר" only where revert.possible and not yet reverted');
ok(RAW.changes.items.filter((x) => CH.match(x, { ...chAll, kinds: new Set(['deploy', 'registry']) })).every((x) => ['deploy', 'registry'].includes(x.kind)) && RAW.changes.items.filter((x) => CH.match(x, { ...chAll, actor: 'Claude' })).every((x) => x.actor === 'Claude') && RAW.changes.items.filter((x) => CH.match(x, { ...chAll, from: '2026-11-03', to: '2026-11-03' })).every((x) => CH.ilDay(x.at) === '2026-11-03'), 'changes filters: kind / actor / date range');
const newNode = { ...reg.nodes.find((n) => n.id === 'wave1'), is_new: true };
ok(S.automations.listView([newNode], {}).includes('חדש') && !S.automations.listView([{ ...newNode, is_new: false }], {}).includes('>חדש<'), 'registry shows "חדש" for nodes added in the last 7 days');
ok(F.balances.vendors.filter(S.balances.isLow).map((v) => v.vendor).join() === 'telnyx', 'balances low detection = telnyx only');
check('empty states', () => S.runs.listView([]) + S.automations.listView([], {}) + S.brain.findingsView([]) + S.overview.incidents([]) + S.overview.nextUp([]) + '<x>'.repeat(60));
check('overview.view before balances lands', () => S.overview.view(F.realtime, F.capacity, null));
check('calls.view with calls:null (no RETELL_KEY)', () => S.calls.view(adapt('realtime', { ...RAW.realtime, calls: null })));
ok(S.overview.allIncidents(F.realtime, F.capacity, F.balances).length > 0, 'overview derives incidents from realtime + capacity + balances', S.overview.allIncidents(F.realtime, F.capacity, F.balances).length + ' incidents');

console.log('A3c money screens (lazy/finance, ads, templates, feedback)');
{
  const M = {}; for (const n of ['finance', 'ads', 'templates', 'feedback']) M[n] = await import(pathToFileURL(join(OPS, 'lazy/' + n + '.js')));
  const FX = Object.fromEntries(['finance', 'ads', 'templates', 'feedback'].map((n) => [n, fx(n)]));
  ok(FX.finance.pnl.every((p) => 'month' in p && 'revenue' in p && 'net' in p && 'margin_pct' in p && p.costs && 'total' in p.costs) && FX.finance.revenue.series.every((x) => 'bucket' in x && 'total' in x), 'finance contract: pnl[], revenue.series[]');
  ok(FX.finance.pnl.every((p) => Math.abs(p.revenue - p.costs.total - p.net) < 0.02), 'finance: net = revenue − costs in every month');
  ok(FX.ads.campaigns.some((c) => c.id === '120250670197650731' && c.read_only), 'ads: Shalev campaign present and read-only');
  check('finance.view', () => M.finance.view(FX.finance, { range: '90d', month: '', vendor: 'cloudflare' }));
  check('finance.view empty', () => M.finance.view({ ...FX.finance, events: [], invoices: [], revenue: { ...FX.finance.revenue, entries: [] } }, { range: '90d', vendor: 'monday' }));
  check('ads.view', () => M.ads.view(FX.ads, { range: '30d', open: new Set(FX.ads.campaigns.map((c) => c.id)) }));
  ok(!/data-act="(?!ads-open|mny-range|sort")[^"]+"/.test(M.ads.view(FX.ads, { range: '30d', open: new Set() })), 'ads screen has no write actions (Shalev read-only; header sort is view-only)');
  { const h = M.ads.view(FX.ads, { range: '30d', open: new Set(FX.ads.campaigns.map((c) => c.id)) }); ok(M.ads.COLS.length === 12 && (h.match(/class="srt/g) || []).length === 12 && /<tfoot><tr class="tot">/.test(h) && (h.match(/<tr data-row=/g) || []).length === FX.ads.campaigns.length, 'ads comparison: 12 sortable columns (spend → ROAS), one row per campaign, totals row'); }
  check('templates.view', () => M.templates.view(FX.templates, { waba: '', status: '', q: '' }));
  ok(M.templates.view(FX.templates, { waba: 'old', status: '', q: '' }).split('data-act="tp-variant"').length - 1 === FX.templates.templates.filter((t) => t.waba === 'old').length, 'templates WABA filter');
  check('feedback.view', () => M.feedback.view(FX.feedback));
  const svg = M.finance.view(FX.finance, { range: '90d', vendor: 'cloudflare' });
  ok((svg.match(/<svg class="vz"/g) || []).length >= 3 && (svg.match(/data-tip=/g) || []).length > 10 && /class="vz-tbl"/.test(svg), 'finance charts: ≥3 inline SVG charts with hover targets and table views');
}
console.log('A3d design pass (nav §11, sortable tables, DatePicker, capacity meters, live rows)');
{
  const navA = [...html0.slice(0, html0.indexOf('</nav>')).matchAll(/<a (class="sub" )?href="([^"]+)" data-r="([^"]+)"/g)];
  const prim = navA.filter((m) => !m[1]).map((m) => m[3]);
  ok(prim.join(',') === 'overview,leads,clients,messages,calls,calendar,finance,system', 'nav: exactly 7 sections + מערכת (§11)', prim.join(','));
  const subs = navA.filter((m) => m[1]).map((m) => m[3]);
  ok(['hostesses', 'feedback', 'inbox', 'messaging', 'capacity', 'templates', 'ads', 'balances', 'automations', 'runs', 'live', 'brain', 'changes', 'control', 'notify'].every((r) => subs.includes(r)), 'nav: every former screen is still a sub-link (the phone "עוד" sheet)', subs.length + ' sub-links');
  ok(/class="tabbar"[\s\S]*data-r="overview"[\s\S]*data-r="leads"[\s\S]*data-r="clients"[\s\S]*data-r="messages"[\s\S]*id="tb-more"/.test(html0), 'phone tab bar markup: סקירה / לידים / לקוחות / הודעות / עוד');
  ok(/Frank\+Ruhl\+Libre/.test(html0) && /family=Heebo/.test(html0) && /Rubik/.test(html0), 'brand fonts: Heebo + Rubik + Frank Ruhl Libre');
  const css = readFileSync(join(OPS, 'ops.css'), 'utf8');
  ok(/--green:#0F4C35/.test(css) && /--gold:#A8853C/.test(css) && /--control-h:44px/.test(css) && /--radius-md:10px/.test(css) && /--radius-lg:12px/.test(css) && /prefers-color-scheme:dark/.test(css) && /:root\[data-theme=dark\]/.test(css), 'ops.css carries the design-system tokens in both themes');
  const allSrc = [...mods, ...lazy, ...crmMods].map((m) => readFileSync(join(OPS, m), 'utf8')).join('');
  ok(!/type="date"|type="datetime-local"/.test(allSrc + html0), 'no native date inputs anywhere in ops (DatePicker only)');
  ok(!/border-radius:99px/.test(css + readFileSync(join(OPS, 'p4a.css'), 'utf8') + readFileSync(join(OPS, 'crm.css'), 'utf8')), 'no pill radii in the ops stylesheets');
  const tb = UI.Table({ id: 'smoke', columns: [{ label: 'שם', key: 'n' }, { label: 'סכום', num: true, sort: (r) => r.v, render: (r) => String(r.v) }], rows: [{ id: 1, n: 'ב', v: 10 }, { id: 2, n: 'א', v: 2 }] });
  ok((tb.match(/class="srt/g) || []).length === 2 && /data-sort-id="smoke"/.test(tb) && /data-sv="10"/.test(tb), 'Table: every labelled column gets a sort button + data-sv, table carries its sort id');
  ok(UI.sortVal('₪1,200') === 1200 && UI.sortVal('03/11') === '03/11' && UI.sortVal('2026-11-03') === '2026-11-03' && UI.sortVal('050-1234567') === '050-1234567' && UI.cmp(2, 10) < 0 && UI.cmp('א', 'ב') < 0, 'sort values: money/number parsed, dates and phones kept as text, Hebrew collation');
  const dp = UI.DatePicker({ value: '2026-11-03', attr: { 'data-q': 'event_date' } });
  ok(/<input type="hidden" data-q="event_date" value="2026-11-03">/.test(dp) && /03\/11\/2026/.test(dp) && /data-act="dp-open"/.test(dp), 'DatePicker: hidden ISO input + dd/mm/yyyy button');
  const K2 = await import(pathToFileURL(join(OPS, 'lazy/kit2.js')));
  const g = K2.monthGrid(2026, 10, '2026-11-03', '2026-11-03'), g2 = K2.monthGrid(2026, 11, '', '2026-12-01');
  ok(/נובמבר 2026/.test(g) && (g.match(/data-d=/g) || []).length === 30 && g.indexOf('<span></span>') === -1 && /data-d="2026-11-03" tabindex="0" aria-selected="true"/.test(g) && (g2.match(/<span><\/span>/g) || []).length === 2 && /היום/.test(g) && /ניקוי/.test(g), 'DatePicker grid: Hebrew month, week starts Sunday (Nov 2026 = no lead blanks, Dec 2026 = 2), selected day focusable, today/clear');
  const cm = S.capacity.capMeters(F.capacity.days);
  ok((cm.match(/<li/g) || []).length === F.capacity.days.length && /\+[\d,]+ נדחה/.test(cm) && /<b>68<\/b><small>\/68<\/small>/.test(cm) && /class="cm-over"/.test(cm), 'capacity meters: one row per day, X/cap label, red overflow segment with "+N נדחה"');
  ok(F.capacity.days.filter((d) => d.no_contact).length === (cm.match(/<li class="closed">/g) || []).length && (cm.match(/<details>/g) || []).length === F.capacity.days.length, 'capacity meters: closed days muted, every row expands to its events');
  ok(S.overview.view(F.realtime, F.capacity, F.balances).includes('class="cm"'), 'overview shows the same capacity meters');
  const adm = F.live.items.filter(S.live.isAdminView);
  ok(adm.length > 0 && F.live.items.filter((x) => S.live.match(x, {})).every((x) => !S.live.isAdminView(x)) && F.live.items.filter((x) => S.live.match(x, { admin: true })).length === F.live.items.length, 'live log: "דפדפן ·" admin rows hidden by default, shown with the toggle', adm.length + ' hidden');
  ok(S.live.row(F.live.items.find((x) => x.event), true).includes('feed-row') && S.live.row(F.live.items.find((x) => x.event), true).includes('href="#/clients/') && S.live.row(F.live.items[0], true).includes(' new"'), 'live rows: kind chip, event links to the client card, new rows carry the insert animation class');
  ok(UI.Phone('972501234567').includes('data-person="972501234567"') && UI.Phone('972501234567').includes('wa.me/972501234567') && UI.Phone('972501234567').includes('tel:+972501234567') && !UI.Phone('97250****567').includes('data-person="9'), 'Phone cell: opens the person drawer + WhatsApp + call; masked numbers stay inert');
  const CCs = await import(pathToFileURL(join(OPS, 'crm/clients.js')));
  ok(CCs.normPhone('050-123 4567') === '972501234567' && CCs.normPhone('12') === null && CCs.normPhone('+972 52-111-2222') === '972521112222', 'client card phone edit normalizes IL numbers');
}
console.log('A3c call center (lazy/calls.js, fixtures from the real ops-calls.js handlers)');
const CCX = await import(pathToFileURL(join(OPS, 'lazy/calls.js')));
const CF = Object.fromEntries(['calls', 'call', 'call-rounds', 'manual-calls', 'shir'].map((n) => [n, fx(n)]));
const ccSt = { tab: 'timeline', range: 'week', agent: '', number: '', event: '', outcomes: new Set(), mview: 'open', open: null };
ok(CF.calls.items.every((r) => ['id', 'at', 'day', 'agent', 'kind', 'outcome', 'outcome_he', 'duration_s', 'cost', 'attempt', 'has_recording', 'has_transcript'].every((k) => k in r) && 'retell' in r.cost && 'telnyx' in r.cost && 'total' in r.cost), 'calls.items[] contract: outcome, cost{retell,telnyx,total}, attempt, has_recording');
ok(CF.calls.costs && CF.calls.costs.by_day && CF.calls.costs.by_event && CF.calls.costs.total.calls === CF.calls.items.length, 'calls.costs rollup covers every call', CF.calls.costs.total.calls + ' calls');
check('calls.tabsBar', () => CCX.tabsBar('timeline', { manual: 3 }));
check('calls.filters', () => CCX.filters(ccSt, CF.calls));
check('calls.timeline', () => CCX.timeline(CF.calls, ccSt));
check('calls.timeline empty', () => CCX.timeline({ ...CF.calls, items: [] }, ccSt) + '<x>'.repeat(60));
const tlHtml = CCX.timeline(CF.calls, ccSt, CF.calls.items[0].id);
ok((tlHtml.match(/class="cc-row"/g) || []).length === CF.calls.items.length && tlHtml.includes('data-cc-x='), 'timeline: one row per call, the open row gets a detail slot');
const dHtml = CCX.callDetail(CF.call);
ok(/<audio controls preload="none" src="[^"]+"/.test(dHtml) && (dHtml.match(/<p class=/g) || []).length === CF.call.transcript.length && dHtml.includes(CF.call.summary.slice(0, 20)), 'call detail: player + every transcript turn + AI summary');
ok(!CCX.callDetail({ ...CF.call, recording: null, recording_missing: 'not-kept' }).includes('<audio') && CCX.callDetail({ ok: false, error: 'not-found' }).includes('errbox'), 'call detail: no player without a kept recording; error box on failure');
check('calls.rounds', () => CCX.rounds(CF['call-rounds']));
const rHtml = CCX.rounds(CF['call-rounds']);
const rStop = CF['call-rounds'].events.filter((e) => !e.stopped && !e.plan_no_calls).length, rStart = CF['call-rounds'].events.filter((e) => e.stopped && !e.plan_no_calls).length;
ok((rHtml.match(/data-a="stop"/g) || []).length === rStop && (rHtml.match(/data-a="start" data-extra/g) || []).length + (rHtml.match(/data-a="start"(?! data-extra)/g) || []).length >= rStart, 'rounds: stop button on running rounds, start on stopped ones, none on plan-without-calls', rStop + ' stop · ' + rStart + ' start');
ok(CF['call-rounds'].events.every((e) => e.will_dial === !e.why.length), 'rounds: will_dial ⇔ no why-not reasons');
check('calls.manual open', () => CCX.manual(CF['manual-calls'], 'open'));
check('calls.manual done', () => CCX.manual(CF['manual-calls'], 'done'));
ok((CCX.manual(CF['manual-calls'], 'open').match(/data-mc="/g) || []).length === CF['manual-calls'].open, 'manual queue: open view lists exactly the open guests', CF['manual-calls'].open + ' open');
check('calls.shir', () => CCX.shir(CF.shir));
ok(CCX.shir(CF.shir).includes('cc-shir-edit') && (CCX.shir(CF.shir).match(/cc-shir-rb/g) || []).length === CF.shir.history.length - 1, 'Shir: edit button + rollback on every version but the current');
check('calls.costs', () => CCX.costs(CF.calls.costs, 'week'));
check('calls.costs unknown telnyx', () => CCX.costs({ ...CF.calls.costs, telnyx_basis: 'unknown', telnyx_rate_per_min: null, total: { ...CF.calls.costs.total, telnyx: null } }, 'today'));
ok(!/import\s[^;(]*lazy\/calls/.test(readFileSync(join(OPS, 'screens/calls.js'), 'utf8')) && /import\('\.\.\/lazy\/calls\.js'\)/.test(readFileSync(join(OPS, 'screens/calls.js'), 'utf8')), 'screens/calls.js loads lazy/calls.js only through import()');

console.log('A4 CRM (fixtures/ops/crm through crm/adapt.js)');
const CA = await import(pathToFileURL(join(OPS, 'crm/adapt.js')));
const cfx = (n) => JSON.parse(readFileSync(join(ROOT, 'fixtures/ops/crm', n + '.json'), 'utf8'));
const CR = Object.fromEntries(['leads', 'clients', 'hostesses', 'assignments', 'reminders', 'notes', 'activity', 'templates', 'stats', 'agenda'].map((n) => [n, cfx(n)]));
/* fixtures = masked live GET responses (scripts/crm-fixtures-from-live.mjs): the server omits empty fields, so the fixture must carry the always-present ones and the adapter must fill every view field */
ok(CR.leads.items.every((l) => ['id', 'phone', 'status', 'tags', 'created_at', 'updated_at'].every((k) => k in l)) && ['statuses', 'by_status', 'sources', 'store'].every((k) => k in CR.leads), 'crm leads fixture has the GET /api/crm/leads shape (docs/CRM-API-2026-11-03.md)');
ok(CA.adaptCrm('leads', CR.leads).items.every((l) => ['id', 'phone', 'name', 'source', 'source_he', 'occasion_he', 'event_date', 'records', 'status', 'owner', 'owner_he', 'next_at', 'next_text', 'quote_id', 'client_token', 'tags', 'created_at', 'last_in', 'window_open'].every((k) => k in l)), 'crm leads adapter fills every view field from the real shape');
ok(Array.isArray(CR.clients.clients) && CR.clients.clients.every((c) => ['token', 'names', 'date', 'status', 'counts', 'addons', 'links'].every((k) => k in c)) && Array.isArray(CR.hostesses.items) && Array.isArray(CR.assignments.items) && Array.isArray(CR.agenda.items) && Array.isArray(CR.stats.revenue) && Array.isArray(CR.stats.volume), 'crm clients/hostesses/assignments/agenda/stats fixtures have the live response shapes');
ok(CA.PATH.lead('L1') === 'crm/leads/L1' && CA.PATH.quote('L1') === 'crm/leads/L1/quote' && CA.PATH.send('L1') === 'crm/leads/L1/send' && CA.PATH.leadsBulk === 'crm/leads/bulk' && CA.PATH.notePin === 'crm/notes/pin' && CA.PATH.assignment === 'crm/assignments', 'crm adapter paths match worker/crm.js routes');
ok(new Set(CR.leads.items.map((l) => l.status)).size === 6, 'crm leads cover all 6 statuses');
ok((JSON.stringify(CR).match(/972\d{9}/g) || []).every((m) => /^97250000\d{4}$/.test(m)), 'crm fixtures use only fake 97250000xxxx phones');
ok(!/[0-9a-f]{8}-(?!0000-4000-8000-000000000000)[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify(CR)), 'crm fixtures: tokens zeroed after the 8-char prefix');
const CL = await import(pathToFileURL(join(OPS, 'crm/leads.js'))), CC = await import(pathToFileURL(join(OPS, 'crm/clients.js'))), CHS = await import(pathToFileURL(join(OPS, 'crm/hostesses.js'))), CT = await import(pathToFileURL(join(OPS, 'crm/today.js'))), CQ = await import(pathToFileURL(join(OPS, 'crm/quick.js')));
const VL = CA.adaptCrm('leads', CR.leads).items, L0 = VL[0];
check('crm leads.board', () => CL.board(VL, {}));
ok((CL.board(VL, {}).match(/class="kb-col"/g) || []).length === 6, 'kanban has 6 status columns');
check('crm leads.table', () => CL.table(VL, new Set([L0.id])));
check('crm leads.bulkBar', () => CL.bulkBar(2, ['חם']));
ok(VL.filter((l) => CL.match(l, { status: 'quoted' })).every((l) => l.status === 'quoted') && VL.filter((l) => CL.match(l, { q: L0.name })).some((l) => l.id === L0.id), 'leads filter by status + search');
const LSRC = CR.leads.items.find((l) => CR.notes.notes.some((n) => n.entity_id === l.id)) || CR.leads.items[0];
const LD = CA.adaptCrm('lead', { ok: true, lead: LSRC, notes: CR.notes.notes.filter((n) => n.entity_id === LSRC.id), activities: CR.activity.activities.filter((a) => a.entity_id === LSRC.id), reminders: [] });
ok(LD.notes.length > 0 && LD.activity.length > 0 && LD.activity.some((a) => a.kind === 'wa' && a.dir === 'in'), 'lead detail: notes + activities (wa_in → wa/in) adapt', LD.notes.length + ' notes · ' + LD.activity.length + ' acts');
check('crm leads.drawerView', () => CL.drawerView(LD));
/* quick close total from the REAL config.js + paylink-gen.js (same tables as the admin generator) */
const vm = await import('node:vm'); const sb = { console }; sb.window = sb; sb.globalThis = sb; vm.createContext(sb);
vm.runInContext(readFileSync(join(ROOT, 'config.js'), 'utf8'), sb); vm.runInContext(readFileSync(join(ROOT, 'assets/paylink-gen.js'), 'utf8'), sb);
const q0 = { ...CQ.qcState(LD.lead, sb.ISHUR_CONFIG), plan: 'basic', records: 100, design: true, hostesses: 2 };
ok(CQ.qcTotal(q0, sb.ISHUR_CONFIG, sb.IshurPayLinkGen) === 99 + 79 + 1990, 'quick close: basic 100 + design + 2 hostesses = ₪2,168', String(CQ.qcTotal(q0, sb.ISHUR_CONFIG, sb.IshurPayLinkGen)));
check('crm quick.qcView', () => CQ.qcView(q0, LD.lead, sb.ISHUR_CONFIG, sb.IshurPayLinkGen, { now: Date.parse('2026-11-03T10:00:00Z') }));
const NT = CA.adaptCrm('send', CR.templates);
ok(NT.needs_template && NT.templates.length === 3 && NT.templates[0].label, 'send: needs_template answer adapts with its templates');
const qv = CQ.qcView({ ...q0, url: 'https://pay.grow.link/X', msg: 'x', needs_template: true, templates: NT.templates }, LD.lead, sb.ISHUR_CONFIG, sb.IshurPayLinkGen, { now: Date.parse('2026-11-03T10:00:00Z') });
ok(/data-act="qc-tpl"/.test(qv) && /שלח תבנית/.test(qv), 'quick close: template chooser when needs_template');
ok(/aria-disabled="true"[^>]*>שלח דרך נועה|data-act="qc-send"[^>]*aria-disabled="true"/.test(CQ.qcView({ ...q0, url: 'u', msg: 'x' }, LD.lead, sb.ISHUR_CONFIG, sb.IshurPayLinkGen, { now: Date.parse('2026-11-03T20:30:00Z') })), 'quick close: send disabled in quiet hours (22:30 IL)');
const order = ['שם הלקוח', 'טלפון', 'סוג אירוע', 'תאריך האירוע', 'חבילה', 'רשומות', 'תוספות', 'סה״כ', 'צור קישור'].map((t) => CQ.qcView(q0, LD.lead, sb.ISHUR_CONFIG, sb.IshurPayLinkGen).indexOf(t));
ok(order.every((x, i) => x > 0 && (!i || x > order[i - 1])), 'quick close field order: name → phone → occasion → date → package → records → add-ons → total → action');
const VC = CA.adaptCrm('clients', CR.clients).items;
ok(VC.length === CR.clients.clients.length && VC.every((c) => c.name && c.status_he && typeof c.guests === 'number'), 'clients adapt (names → name, counts.invited → guests, held → hold)');
check('crm clients.listView', () => CC.listView(CC.pick(VC, '', '')));
check('crm clients.drawerView', () => CC.drawerView(CA.adaptCrm('client', { ok: true, client: CR.clients.clients[0], timeline: [{ at: '2026-11-01T10:00:00Z', kind: 'send', text: 'גל 1', source: 'audit' }, { at: '2026-11-02T10:00:00Z', kind: 'note', text: 'הערה', author: 'שלו', pinned: false, source: 'notes', id: 'n1' }], assignments: [] })));
const VH = CA.adaptCrm('hostesses', { hostesses: CR.hostesses.items, assignments: CR.assignments.items, clients: CR.clients.clients });
ok(VH.events.some((e) => e.have < e.need), 'hostess needs derived from clients addons.hostesses.n vs assignments', JSON.stringify(VH.events.map((e) => e.have + '/' + e.need)));
ok(VH.conflicts.length >= 1, 'hostess conflicts detected (fixture has a double booking)', VH.conflicts.length + ' conflicts');
check('crm hostesses.view', () => CHS.view(VH, VH.hostesses, CHS.weekDays(0, Date.parse('2026-11-03T10:00:00Z')), 0));
ok(/משובצת פעמיים/.test(CHS.warnings(VH, VH.hostesses)) && /חסרה בהם דיילת/.test(CHS.warnings(VH, VH.hostesses)), 'hostess warnings: conflict + short-staffed');
const VS = CA.adaptCrm('stats', CR.stats);
check('crm today.charts', () => CT.charts(VS, 900));
check('crm today.charts at 343 px', () => CT.charts(VS, 343));
ok(!/width="-|NaN/.test(CT.charts(VS, 343)), 'charts at phone width have no negative/NaN geometry');
const AG = CA.adaptCrm('agenda', { ok: true, items: [{ kind: 'reminder', id: 'R1', at: CR.reminders.items[0].due_at, entity_type: 'lead', entity_id: CR.reminders.items[0].entity_id, text: CR.reminders.items[0].text }, { kind: 'event', id: CR.clients.clients[0].token, entity_type: 'client', entity_id: CR.clients.clients[0].token, text: 'x' }], clients: CR.clients.clients });
ok(AG.reminders.length === 1 && AG.reminders[0].id === CR.reminders.items[0].entity_id && AG.events[0].name === VC.find((c) => c.token === CR.clients.clients[0].token).name, 'agenda items adapt (reminder → lead link, event → client row)');
check('crm today.agenda', () => CT.agenda(AG));
check('crm empty states', () => CL.board([], {}) + CC.listView([]) + CT.agenda({ reminders: [], events: [], sends: [] }) + '<x>'.repeat(40));

/* ── Part B: browser ── */
async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* fall through */ }
  const base = join(homedir(), '.npm/_npx');
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) { const p = join(base, d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) { try { return await import(pathToFileURL(p)); } catch (e) { /* next */ } } }
  return null;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SHOTS = process.argv.includes('--shots');
if (!process.argv.includes('--no-browser')) {
  const pw = await loadPlaywright();
  if (!pw) console.log('B  skipped: Playwright not importable');
  else {
    console.log('B  browser');
    const srv = createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = join(ROOT, u === '/' ? 'ops.html' : u); if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' }); r.end(readFileSync(f)); }).listen(0);
    const port = srv.address().port, url = `http://127.0.0.1:${port}/ops.html?mock=1`;
    let browser;
    try { browser = await pw.chromium.launch(); } catch (e) { browser = await pw.chromium.launch({ channel: 'chrome' }); }
    const shotDir = join(ROOT, 'docs/ops-screens'); mkdirSync(shotDir, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const data = []; page.on('request', (rq) => { if (rq.url().includes('/fixtures/ops/') || rq.url().includes('/api/ops/')) data.push(rq.url()); });
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'commit' });
      await page.waitForSelector('.sk', { timeout: 3000 });
      const skMs = Date.now() - t0;
      await page.waitForSelector('.tile .v', { timeout: 5000 });
      await page.waitForTimeout(600);
      if (scheme === 'light') {
        ok(skMs < 1500, 'skeleton visible before data', skMs + ' ms from navigation (cold, includes server start)');
        const uniq = [...new Set(data.map((u) => u.split('?')[0]))];
        ok(uniq.length <= 3, '≤ 3 data requests on load', uniq.map((u) => u.split('/').pop()).join(', '));
      }
      for (const r of ['overview', 'automations', 'runs', 'live', 'brain', 'messaging', 'inbox', 'control', 'calls', 'capacity', 'calendar', 'balances', 'changes', 'finance', 'ads', 'templates', 'feedback']) {
        await page.evaluate((h) => { location.hash = h; }, '#/' + r);
        await page.waitForFunction(() => !document.querySelector('#main .sk') || document.querySelector('#main .feed-row,#main table,#main .tile .v,#main .cal-d'), null, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(r === 'brain' || r === 'live' ? 3600 : 500);
        const txt = await page.$eval('#main', (m) => m.innerText);
        if (scheme === 'light') ok(txt.length > 80 && !/undefined|NaN/.test(txt), 'route ' + r + ' renders', txt.length + ' chars');
        if (scheme === 'light' || ['overview', 'automations'].includes(r)) await page.screenshot({ path: join(shotDir, `${r}-${scheme}.png`) });
      }
      if (scheme === 'light') {
        const before = await page.$$eval('.feed-row', (x) => x.length);
        ok(before > 0, 'live feed has rows (and streams)', before + ' rows');
        await page.evaluate(() => { location.hash = '#/automations/d_pacer'; });
        await page.waitForSelector('.drawer .code', { timeout: 4000 });
        ok(true, 'automation drawer opens with code excerpt');
        await page.screenshot({ path: join(shotDir, 'automation-drawer-light.png') });
        await page.click('.drawer [data-act=toggle]');
        await page.waitForSelector('.dialog #dlg-in', { timeout: 4000 });
        await page.waitForTimeout(350); /* let the pop-in finish before reading / shooting */
        const disabled = await page.$eval('.dialog [data-act=dlg-yes]', (b) => b.getAttribute('aria-disabled'));
        ok(disabled === 'true', 'typed-confirm button disabled until the id is typed');
        const blast = await page.$eval('.dialog[role=alertdialog]', (d) => d.innerText);
        const expBlast = String(RAW.toggle.by_id.d_pacer.blast_radius.messages_next_days.total || RAW.toggle.by_id.d_pacer.blast_radius.downstream.length);
        ok(blast.includes(expBlast) && /אוטומציות שתלויות/.test(blast), 'blast radius lists server impact + downstream', 'expects ' + expBlast);
        await page.screenshot({ path: join(shotDir, 'toggle-confirm-light.png') });
        await page.fill('.dialog #dlg-in', 'd_pacer');
        await page.click('.dialog [data-act=dlg-yes]');
        await page.waitForTimeout(900);
        const sw = await page.$eval('.drawer [data-act=toggle]', (b) => b.getAttribute('aria-checked'));
        ok(sw === 'false', 'after typed confirm the switch shows off');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Meta+k');
        ok(!!(await page.$('.palette')), '⌘K opens the command palette');
        await page.keyboard.press('Escape');
        await page.keyboard.press('g'); await page.keyboard.press('r');
        await page.waitForTimeout(500);
        ok((await page.evaluate(() => location.hash)) === '#/system?tab=runs' && !!(await page.$('.ptabs a[data-v=runs][aria-selected=true]')), 'g r navigates to runs (מערכת › ריצות tab)');
        await page.keyboard.press('g'); await page.keyboard.press('d');
        await page.waitForSelector('#main .cal-d[data-day]', { timeout: 4000 });
        ok((await page.evaluate(() => location.hash)) === '#/calendar', 'g d navigates to the calendar');
        const nChips = await page.$$eval('#main .cc', (x) => x.length);
        await page.click('#main [data-act=cal-f][data-f=sends]');
        const nAfter = await page.$$eval('#main .cc', (x) => x.length);
        ok(nChips > 0 && nAfter < nChips, 'filter chip hides sends', nChips + ' → ' + nAfter);
        ok((await page.evaluate(() => localStorage.getItem('ops:cal'))).includes('"f"'), 'calendar filters persisted in localStorage');
        await page.click('#main [data-act=cal-f][data-f=sends]');
        await page.click('#main .cal-d[data-day] .cc.s-rolled');
        await page.waitForSelector('.drawer dl.kv', { timeout: 3000 });
        ok(/למה/.test(await page.$eval('.drawer', (d) => d.innerText)), 'rolled chip opens its detail (with the reason it moved)');
        await page.screenshot({ path: join(shotDir, 'calendar-chip-light.png') });
        await page.keyboard.press('Escape'); await page.waitForTimeout(250);
        await page.click('#main .cal-d.today .cal-h');
        await page.waitForSelector('.drawer .cal-g, .drawer .empty', { timeout: 3000 });
        ok(/לוח השליחות/.test(await page.$eval('.drawer', (d) => d.innerText)), 'day drawer lists the day + links to send-board');
        await page.screenshot({ path: join(shotDir, 'calendar-day-light.png') });
        await page.keyboard.press('Escape'); await page.waitForTimeout(250);
        await page.click('#main [data-act=cal-next]'); await page.waitForTimeout(500);
        const nextOk = await page.$$eval('#main .cal-d[data-day]', (x) => x.length > 27 && !x[0].dataset.day.startsWith('2026-11'));
        await page.click('#main [data-act=cal-today]'); await page.waitForTimeout(500);
        ok(nextOk && (await page.$('#main .cal-d.today')) !== null, 'month navigation + "היום" button');
        /* change log: g h, kind chip filter, deploy drawer with commits, typed-confirm revert */
        await page.keyboard.press('g'); await page.keyboard.press('h');
        await page.waitForSelector('#main .chg-row', { timeout: 4000 });
        ok((await page.evaluate(() => location.hash)) === '#/system?tab=changes', 'g h navigates to the change log (מערכת › שינויים)');
        const nRows = await page.$$eval('#main .chg-row', (x) => x.length);
        ok(nRows === RAW.changes.items.length && (await page.$$eval('#main .chg-day', (x) => x.length)) === days.length, 'change log renders every entry grouped by day', nRows + ' rows');
        await page.click('#main [data-act=chg-k][data-k=deploy]');
        const nDep = await page.$$eval('#main .chg-row', (x) => x.length);
        ok(nDep === RAW.changes.items.filter((x) => x.kind === 'deploy').length, 'kind chip filters the timeline', nRows + ' → ' + nDep);
        await page.click('#main .chg-row');
        await page.waitForSelector('.drawer .chg-commits', { timeout: 3000 });
        ok((await page.$eval('.drawer', (d) => d.innerText)).includes(dep.details.commits[1].subject), 'deploy drawer lists the commits since the previous deploy');
        await page.waitForTimeout(350); /* drawer slide-in */
        await page.screenshot({ path: join(shotDir, 'changes-deploy-light.png') });
        await page.keyboard.press('Escape'); await page.waitForTimeout(250);
        await page.click('#main [data-act=chg-k][data-k=deploy]');
        const ed = RAW.changes.items.find((x) => x.kind === 'edit' && x.revert.possible);
        await page.click(`#main .chg-row[data-chg="${ed.id}"]`);
        await page.waitForSelector('.drawer [data-act=chg-revert]', { timeout: 3000 });
        await page.click('.drawer [data-act=chg-revert]');
        await page.waitForSelector('.dialog #dlg-in', { timeout: 4000 }); await page.waitForTimeout(350);
        ok((await page.$eval('.dialog [data-act=dlg-yes]', (b) => b.getAttribute('aria-disabled'))) === 'true', 'revert button disabled until the confirm word is typed');
        await page.screenshot({ path: join(shotDir, 'changes-revert-confirm-light.png') });
        await page.fill('.dialog #dlg-in', ed.revert.confirm);
        await page.click('.dialog [data-act=dlg-yes]');
        await page.waitForSelector(`#main .chg-row.reverted[data-chg="${ed.id}"]`, { timeout: 4000 }).catch(() => {});
        ok(!!(await page.$(`#main .chg-row.reverted[data-chg="${ed.id}"]`)) && (await page.$$eval('#main .chg-row', (x) => x.length)) === nRows + 1, 'after typed confirm the entry shows reverted + a new revert entry appears');
        await page.screenshot({ path: join(shotDir, 'changes-light.png') });
        ok(errors.length === 0, 'no console errors after the change-log flow', errors.slice(0, 3).join(' | '));
        ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
      }
      await ctx.close();
    }
    const m = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const mp = await m.newPage();
    for (const r of ['overview', 'automations', 'runs', 'messaging', 'inbox', 'control', 'capacity', 'calendar', 'balances', 'changes', 'finance', 'ads', 'templates', 'feedback']) {
      await mp.goto(url + '#/' + r); await mp.waitForTimeout(900);
      const over = await mp.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('#main').scrollWidth, document.querySelector('#main').clientWidth]);
      ok(over[0] <= over[1] && over[2] <= over[3] + 1, '375 px no horizontal scroll · ' + r, over.join('/'));
      await mp.screenshot({ path: join(shotDir, `${r}-mobile.png`) });
    }
    await m.close();

    console.log('B3 Phase 4a (messaging, inbox, control)');
    {
      const px = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      const pp = await px.newPage(); const perr = []; pp.on('pageerror', (e) => perr.push(e.message)); pp.on('console', (m2) => { if (m2.type() === 'error') perr.push(m2.text()); });
      await pp.goto(url + '#/messaging'); await pp.waitForSelector('#main tr.msg-row', { timeout: 6000 });
      ok((await pp.$$eval('#main tr.msg-row', (x) => x.length)) === P4.messages.items.length, 'הודעות renders one row per message', String(P4.messages.items.length));
      const rp = P4.messages.items.find((x) => x.reply);
      await pp.click(`#main tr.msg-row[data-row="${rp.id}"]`);
      ok((await pp.$eval('#main tr.msg-det', (d) => d.innerText)).includes(rp.reply.text), 'expanding a row shows the full text and the guest reply');
      await pp.click('#main [data-tabs=msgtab] [data-v=failed]'); await pp.waitForTimeout(400);
      ok((await pp.$$eval('#main tr.msg-row', (x) => x.length)) === P4.messages.items.filter((x) => x.status === 'failed').length, 'נכשלו tab shows only failed messages');
      await pp.click('#main [data-tabs=msgtab] [data-v=replies]'); await pp.waitForTimeout(400);
      ok((await pp.$$eval('#main tr.msg-row', (x) => x.length)) === P4.messages.inbound.length, 'תשובות tab shows inbound messages');
      await pp.screenshot({ path: join(shotDir, 'messaging-replies-light.png') });
      await pp.keyboard.press('g'); await pp.keyboard.press('i');
      await pp.waitForSelector('#main .conv', { timeout: 6000 });
      ok((await pp.evaluate(() => location.hash)) === '#/messages' && (await pp.$$eval('#main .conv', (x) => x.length)) === P4.inbox.items.length, 'g i opens הודעות on the inbox (its first tab) with every conversation');
      const c0 = P4.inbox.items.find((c) => c.window_open && c.ch.includes('client'));
      await pp.click(`#main .conv[data-phone="${c0.phone}"]`);
      await pp.waitForSelector('#main .bub', { timeout: 4000 });
      ok((await pp.$$eval('#main .bub', (x) => x.length)) === P4.thread.by_phone[c0.phone].messages.length, 'thread renders one bubble per message');
      const quietNow = await pp.evaluate(() => { const h = +new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(new Date()); return h >= 21 || h < 9; });
      if (quietNow) ok(!(await pp.$('#main [data-act=ibx-send]')), 'quiet hours now: the send button is not offered (21:00–09:00 rule)');
      else {
        await pp.fill('#main #ibx-txt', 'בדיקה מהסמוק');
        const before = await pp.$$eval('#main .bub', (x) => x.length);
        await pp.click('#main [data-act=ibx-send]'); await pp.waitForSelector('.dialog #dlg-in', { timeout: 3000 });
        ok((await pp.$eval('.dialog [data-act=dlg-yes]', (b) => b.getAttribute('aria-disabled'))) === 'true', 'send: the button stays disabled until שלח is typed');
        await pp.fill('.dialog #dlg-in', 'שלחח'); ok((await pp.$eval('.dialog [data-act=dlg-yes]', (b) => b.getAttribute('aria-disabled'))) === 'true', 'send: a near-miss word does not enable it');
        await pp.click('.dialog [data-act=dlg-no]'); await pp.waitForTimeout(400);
        ok((await pp.$$eval('#main .bub', (x) => x.length)) === before, 'send: cancel → nothing sent');
        await pp.click('#main [data-act=ibx-send]'); await pp.waitForSelector('.dialog #dlg-in'); await pp.fill('.dialog #dlg-in', 'שלח'); await pp.click('.dialog [data-act=dlg-yes]');
        await pp.waitForFunction((n) => document.querySelectorAll('#main .bub').length > n, before, { timeout: 4000 }).catch(() => {});
        ok((await pp.$$eval('#main .bub', (x) => x.length)) === before + 1, 'send: after typing שלח the message goes out (mock) and shows in the thread');
      }
      const shut = P4.inbox.items.find((c) => !c.window_open);
      await pp.click(`#main .conv[data-phone="${shut.phone}"]`); await pp.waitForSelector('#main .bub', { timeout: 4000 });
      ok(quietNow && shut.ch.includes('client') ? true : !!(await pp.$('#main [data-act=ibx-send-tpl]')) && !(await pp.$('#main #ibx-txt')), 'closed 24h window: template chooser, no free text');
      await pp.screenshot({ path: join(shotDir, 'inbox-light.png') });
      await pp.keyboard.press('g'); await pp.keyboard.press('x');
      await pp.waitForSelector('#main .ctl-grid', { timeout: 6000 });
      ok((await pp.evaluate(() => location.hash)) === '#/system?tab=control', 'g x opens שליטה ידנית (מערכת tab)');
      await pp.click('#main [data-act=ctl][data-a=pause]'); await pp.waitForSelector('.dialog #dlg-in');
      ok((await pp.$eval('#layer .dialog', (d) => d.innerText)).includes('אף הודעה') && (await pp.$eval('.dialog [data-act=dlg-yes]', (b) => b.getAttribute('aria-disabled'))) === 'true', 'pause: blast radius shown, disabled until the word is typed');
      await pp.fill('.dialog #dlg-in', 'עצור'); await pp.click('.dialog [data-act=dlg-yes]');
      await pp.waitForSelector('#main [data-a=resume]', { timeout: 4000 }).catch(() => {});
      ok(!!(await pp.$('#main [data-a=resume]')), 'after the typed confirm the system shows paused (resume offered)');
      await pp.click('#main [data-act=ctl][data-a=hold]'); await pp.waitForSelector('.dialog #dlg-in');
      ok((await pp.$eval('#layer .dialog', (d) => d.innerText)).includes('hold:' + P4.control.events[0].tok8), 'event hold needs hold:<tok8>');
      await pp.click('.dialog [data-act=dlg-no]');
      await pp.screenshot({ path: join(shotDir, 'control-light.png') });
      ok(perr.length === 0, 'no console errors in the Phase 4a flows', perr.slice(0, 3).join(' | '));
      await px.close();
      const mx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      const mq = await mx.newPage(); await mq.goto(url + '#/inbox'); await mq.waitForSelector('#main .conv', { timeout: 6000 });
      await mq.click('#main .conv'); await mq.waitForSelector('#main .bub', { timeout: 4000 });
      const lay = await mq.evaluate(() => [document.querySelector('.ibx-list').offsetParent === null, !!document.querySelector('.ibx-back').offsetParent, document.documentElement.scrollWidth <= innerWidth]);
      ok(lay.every(Boolean), '375 px inbox: thread replaces the list, back button shown, no sideways scroll', lay.join('/'));
      await mq.screenshot({ path: join(shotDir, 'inbox-thread-mobile.png') });
      await mq.click('#tb-more'); ok(await mq.$eval('.nav a[data-r=inbox]', (a) => !!a.offsetParent) && await mq.$eval('.nav a[data-r=control]', (a) => !!a.offsetParent), '"עוד" sheet lists אינבוקס and שליטה');
      await mx.close();
    }
    console.log('B1c call center');
    {
      const cc = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      const pg = await cc.newPage();
      const cerr = []; pg.on('pageerror', (e) => cerr.push(e.message)); pg.on('console', (m2) => { if (m2.type() === 'error') cerr.push(m2.text()); });
      await pg.addInitScript(() => { try { localStorage.setItem('ops:calls', JSON.stringify({ tab: 'timeline', range: 'week' })); } catch (e) {} });
      await pg.goto(url + '#/calls/timeline');
      await pg.waitForSelector('#main .cc-row', { timeout: 5000 }).catch(() => {});
      const nRows = await pg.$$eval('#main .cc-row', (x) => x.length);
      ok(nRows === CF.calls.items.length, 'שיחות: timeline lists every call of the week', nRows + ' rows');
      await pg.click(`#main .cc-h[data-id="${CF.call.call.id}"]`);
      await pg.waitForSelector('#main .cc-x audio', { timeout: 4000 }).catch(() => {});
      ok(!!(await pg.$('#main .cc-x audio')) && (await pg.$$eval('#main .cc-x .cc-tr p', (x) => x.length)) === CF.call.transcript.length, 'opening a call shows the player and the transcript');
      await pg.screenshot({ path: join(shotDir, 'calls-timeline-light.png') });
      await pg.click('#main [data-act=cc-out][data-k=coming]'); await pg.waitForTimeout(500);
      ok((await pg.$$eval('#main .cc-row', (x) => x.length)) === CF.calls.items.filter((r) => r.outcome === 'coming').length, 'outcome chip filters the timeline');
      await pg.click('#main [data-act=cc-tab][data-v=rounds]'); await pg.waitForSelector('#main .cc-card', { timeout: 4000 }).catch(() => {});
      ok((await pg.$$eval('#main .cc-card', (x) => x.length)) === CF['call-rounds'].events.length, 'סבבים: one card per event');
      await pg.click('#main [data-act=cc-round][data-a=stop]');
      await pg.waitForSelector('.dialog #dlg-in', { timeout: 4000 }); await pg.waitForTimeout(350);
      ok((await pg.$eval('.dialog [data-act=dlg-yes]', (b) => b.getAttribute('aria-disabled'))) === 'true', 'round stop: confirm disabled until the event code is typed');
      const word = CF['call-rounds'].events.find((e) => !e.stopped && !e.plan_no_calls).tok8;
      await pg.screenshot({ path: join(shotDir, 'calls-round-confirm-light.png') });
      await pg.fill('.dialog #dlg-in', word); await pg.click('.dialog [data-act=dlg-yes]'); await pg.waitForTimeout(900);
      ok((await pg.$$eval('#main [data-act=cc-round][data-a=stop]', (x) => x.length)) === CF['call-rounds'].events.filter((e) => !e.stopped && !e.plan_no_calls).length - 1, 'after the typed confirm the round shows as stopped');
      await pg.click('#main [data-act=cc-tab][data-v=manual]'); await pg.waitForSelector('#main .cc-mc', { timeout: 4000 }).catch(() => {});
      const nMc = await pg.$$eval('#main .cc-mc', (x) => x.length);
      ok(nMc === CF['manual-calls'].open, 'שיחות ידניות: open queue rendered', nMc + ' guests');
      await pg.click('#main [data-act=cc-done][data-o="מגיע"]'); await pg.waitForTimeout(600);
      ok((await pg.$$eval('#main .cc-mc', (x) => x.length)) === nMc - 1, 'marking "מגיע" takes the guest off the open queue');
      await pg.click('#main [data-act=cc-tab][data-v=shir]'); await pg.waitForSelector('#main [data-act=cc-shir-edit]', { timeout: 4000 }).catch(() => {});
      await pg.click('#main [data-act=cc-shir-edit]'); await pg.waitForSelector('.drawer textarea', { timeout: 4000 }).catch(() => {});
      ok(!!(await pg.$('.drawer textarea')), 'Shir: edit opens the versioned prompt editor');
      await pg.screenshot({ path: join(shotDir, 'calls-shir-edit-light.png') });
      await pg.keyboard.press('Escape');
      await pg.click('#main [data-act=cc-tab][data-v=costs]'); await pg.waitForTimeout(500);
      ok((await pg.$$eval('#main .cc-tbl', (x) => x.length)) === 2, 'עלויות: per-day and per-event tables');
      await pg.screenshot({ path: join(shotDir, 'calls-costs-light.png') });
      ok(cerr.length === 0, 'no console errors in the call center', cerr.slice(0, 3).join(' | '));
      await cc.close();
      const mc = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      const mpg = await mc.newPage();
      await mpg.addInitScript(() => { try { localStorage.setItem('ops:calls', JSON.stringify({ tab: 'timeline', range: 'week' })); } catch (e) {} });
      for (const t of ['timeline', 'rounds', 'manual', 'shir', 'costs']) {
        await mpg.goto(url + '#/calls/' + t); await mpg.waitForTimeout(900);
        if (t === 'timeline') { await mpg.click(`#main .cc-h[data-id="${CF.call.call.id}"]`).catch(() => {}); await mpg.waitForTimeout(500); }
        const over = await mpg.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('#main').scrollWidth, document.querySelector('#main').clientWidth]);
        ok(over[0] <= over[1] && over[2] <= over[3] + 1, '375 px no horizontal scroll · calls/' + t, over.join('/'));
        await mpg.screenshot({ path: join(shotDir, `calls-${t}-mobile.png`) });
      }
      const tap = await mpg.$$eval('#main .cc-h', (x) => Math.min(...x.map((e) => e.getBoundingClientRect().height))).catch(() => 0);
      await mpg.goto(url + '#/calls/manual'); await mpg.waitForTimeout(800);
      const btnH = await mpg.$$eval('#main .cc-mc .btns .btn', (x) => Math.min(...x.map((e) => e.getBoundingClientRect().height))).catch(() => 0);
      ok(btnH >= 40, '375 px: manual-call outcome buttons ≥ 40 px', String(btnH));
      await mc.close();
      ok(tap === 0 || tap >= 44, '375 px: call rows ≥ 44 px tall', String(tap));
    }

    console.log('B2 CRM');
    const cx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const cp = await cx.newPage();
    const cerr = []; cp.on('pageerror', (e) => cerr.push(e.message)); cp.on('console', (m2) => { if (m2.type() === 'error') cerr.push(m2.text()); });
    await cp.goto(url + '#/overview');
    /* 03/11 Phase 5: Richard rejected the static CRM "היום" charts (crm/today.js) on the overview; the smart overview
       (lazy/overview2.js) replaces them with one interactive trend chart + ממתין לך (which carries overdue reminders)
       + a funnel tile. Deeper chart checks: scripts/ops-notify-smoke.mjs. */
    await cp.waitForSelector('.ov2 #ov-trend [data-chart] svg', { timeout: 8000 }).catch(() => {});
    ok(!!(await cp.$('.ov2 .wait li')) && !!(await cp.$('.ov2 #ov-trend [data-chart] svg rect.hit')) && /משפך/.test(await cp.$eval('#main', (m) => m.innerText)), 'overview: ממתין לך list + interactive trend chart + funnel tile');
    await cp.screenshot({ path: join(shotDir, 'overview-crm-light.png'), fullPage: false });
    await cp.evaluate(() => { location.hash = '#/leads'; });
    await cp.waitForSelector('.kb-card', { timeout: 6000 });
    ok((await cp.$$('.kb-col')).length === 6, 'leads board renders 6 columns', (await cp.$$('.kb-card')).length + ' cards');
    await cp.screenshot({ path: join(shotDir, 'leads-light.png') });
    /* drag the first "new" card into "talking" with a real pointer path */
    const src = await cp.$('.kb-col[data-status=new] .kb-card'), id = await src.getAttribute('data-id');
    const sb0 = await src.boundingBox(), tb = await (await cp.$('.kb-col[data-status=talking] .kb-list')).boundingBox();
    await cp.mouse.move(sb0.x + 20, sb0.y + 12); await cp.mouse.down();
    for (let i = 1; i <= 12; i++) await cp.mouse.move(sb0.x + 20 + ((tb.x + tb.width / 2) - (sb0.x + 20)) * i / 12, sb0.y + 12 + ((tb.y + 40) - (sb0.y + 12)) * i / 12);
    const ghost = !!(await cp.$('.kb-ghost')); await cp.mouse.up(); await cp.waitForTimeout(400);
    ok(ghost && !!(await cp.$(`.kb-col[data-status=talking] .kb-card[data-id="${id}"]`)), 'kanban: dragging a card moves it to the drop column', id + ' new → talking');
    ok((await cp.evaluate(() => location.hash)) === '#/leads', 'drag does not open the drawer');
    await cp.evaluate(() => { location.hash = '#/clients'; }); await cp.waitForSelector('#cl-list tr[data-row]', { timeout: 6000 });
    await cp.evaluate(() => { location.hash = '#/leads'; }); await cp.waitForSelector('.kb-card', { timeout: 6000 });
    ok(!!(await cp.$(`.kb-col[data-status=talking] .kb-card[data-id="${id}"]`)), 'kanban move persisted through the API (mock) after navigating away and back');
    await cp.focus(`.kb-card[data-id="${id}"]`); await cp.keyboard.press('ArrowLeft'); await cp.waitForTimeout(300);
    ok(!!(await cp.$(`.kb-col[data-status=quoted] .kb-card[data-id="${id}"]`)), 'kanban: ← on a focused card moves it one column (keyboard)');
    /* lead drawer + quick close on a lead inside the 24h window */
    const wl = await cp.evaluate(async () => { const r = await fetch('fixtures/ops/crm/leads.json'); const j = await r.json(); return j.items.find((l) => l.name && l.last_inbound_at && ['new', 'talking'].includes(l.status) && Date.parse(j.as_of) - Date.parse(l.last_inbound_at) < 12 * 36e5) || j.items[0]; });
    await cp.evaluate((i) => { location.hash = '#/leads/' + i; }, wl.id);
    await cp.waitForSelector('.drawer #qc .qc-total', { timeout: 8000 });
    const dtxt = await cp.$eval('.drawer', (d) => d.innerText);
    ok(dtxt.includes(wl.name) && /הערות/.test(dtxt) && /פעילות/.test(dtxt) && /פעולה הבאה/.test(dtxt) && !!(await cp.$('.drawer a[href^="https://wa.me/"]')) && !!(await cp.$('.drawer a[href^="tel:"]')), 'lead drawer renders: name, wa.me + call, next action, notes, activity');
    const pickSel = async (name, v) => { await cp.click(`.drawer .sel[data-sel=${name}] > button`); await cp.click(`.drawer .sel[data-sel=${name}] .pop [data-v="${v}"]`); };
    await pickSel('q_plan', 'basic'); await pickSel('q_records', '100');
    await cp.click('.drawer [data-act=qc-tg][data-k=design]'); await cp.click('.drawer [data-act=qc-host][data-n="2"]');
    const tot = await cp.$eval('.drawer [data-qc-total]', (b) => b.textContent);
    ok(tot.replace(/[^0-9]/g, '') === '2168', 'quick close computes the live total (basic 100 + design + 2 hostesses)', tot);
    await cp.screenshot({ path: join(shotDir, 'lead-drawer-light.png') });
    await cp.click('.drawer [data-act=qc-make]'); await cp.waitForSelector('.drawer #qc-msg', { timeout: 5000 });
    const msg = await cp.$eval('.drawer #qc-msg', (t) => t.value);
    ok(/pay\.grow\.link/.test(msg) && msg.includes(wl.name.split(' ')[0]), '"צור קישור" shows the link + an editable suggested message');
    const quiet = await cp.evaluate(() => { const h = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(new Date()); return h >= 21 || h < 9; });
    if (quiet) ok((await cp.$eval('.drawer [data-act=qc-send]', (b) => b.getAttribute('aria-disabled'))) === 'true', 'quiet hours now: "שלח דרך נועה" is disabled (send flow not exercised in this run)');
    else {
      /* server answers a preview first; nothing goes out until the typed "שלח" confirm (explicit-send rule) */
      await cp.click('.drawer [data-act=qc-send]'); await cp.waitForSelector('.dialog #dlg-in', { timeout: 5000 });
      const dlg = await cp.$eval('.dialog[role=alertdialog]', (d) => d.innerText);
      ok(dlg.includes(msg.split('\n')[0].trim()) && !(await cp.$('.drawer #qc .okbox')), 'send: preview dialog shows the exact text and nothing is sent before the typed confirm');
      await cp.fill('.dialog #dlg-in', 'שלח'); await cp.click('.dialog [data-act=dlg-yes]');
      await cp.waitForSelector('.drawer .okbox', { timeout: 5000 }).catch(() => {});
      ok(!!(await cp.$('.drawer #qc .okbox')) && /הצעה נשלחה/.test(await cp.$eval('.drawer .crm-head', (h) => h.innerText)), '"שלח דרך נועה" sends and flips the status to הצעה נשלחה');
    }
    await cp.screenshot({ path: join(shotDir, 'lead-quickclose-light.png') });
    await cp.keyboard.press('Escape'); await cp.waitForTimeout(300);
    await cp.evaluate(() => { location.hash = '#/clients'; }); await cp.waitForSelector('#cl-list tr[data-row]', { timeout: 6000 });
    await cp.screenshot({ path: join(shotDir, 'clients-light.png') });
    await cp.click('#cl-list tr[data-row]'); await cp.waitForSelector('.drawer .crm-counts', { timeout: 5000 });
    ok(/קישורים/.test(await cp.$eval('.drawer', (d) => d.innerText)) && /ציר זמן/.test(await cp.$eval('.drawer', (d) => d.innerText)), 'client drawer renders: counts, links, timeline');
    await cp.screenshot({ path: join(shotDir, 'client-drawer-light.png') });
    await cp.click('.drawer [data-act=cl-hold]'); await cp.waitForSelector('.dialog #dlg-in', { timeout: 3000 });
    ok((await cp.$eval('.dialog [data-act=dlg-yes]', (b) => b.getAttribute('aria-disabled'))) === 'true', 'client hold sits behind the typed confirm');
    await cp.keyboard.press('Escape'); await cp.keyboard.press('Escape'); await cp.waitForTimeout(300);
    await cp.evaluate(() => { location.hash = '#/hostesses'; }); await cp.waitForSelector('.wk .shift', { timeout: 6000 });
    ok(!!(await cp.$('.errbox')) && !!(await cp.$('.wk .shift.conflict')), 'hostesses: week grid + conflict warning');
    await cp.screenshot({ path: join(shotDir, 'hostesses-light.png') });
    /* design pass: aliases, persisted sort, centered modal, DatePicker keyboard, live admin toggle */
    await cp.evaluate(() => { location.hash = '#/messaging'; }); await cp.waitForSelector('#main tr.msg-row', { timeout: 6000 });
    ok(!!(await cp.$('.ptabs a[data-v=sends][aria-selected=true]')) && (await cp.$eval('.nav a[data-r=messages]', (a) => a.getAttribute('aria-current'))) === 'page', 'old #/messaging opens הודעות › שליחות אוטומטיות');
    await cp.evaluate(() => { location.hash = '#/messages?tab=capacity'; }); await cp.waitForSelector('#main .cm', { timeout: 6000 });
    ok(!!(await cp.$('.ptabs a[data-v=capacity][aria-selected=true]')), 'deep link #/messages?tab=capacity renders the capacity meters tab');
    await cp.evaluate(() => { location.hash = '#/hostesses'; }); await cp.waitForSelector('.ptabs a[data-v=hostesses][aria-selected=true]', { timeout: 6000 });
    ok(true, 'old #/hostesses opens לקוחות › דיילות');
    await cp.evaluate(() => { localStorage.removeItem('ops:sort:clients'); location.hash = '#/clients'; }); await cp.waitForSelector('#cl-list tr[data-row]', { timeout: 6000 });
    const hdr = '#cl-list th[data-col="3"] .th-s';
    await cp.click(hdr); await cp.waitForTimeout(300);
    const d1 = await cp.$$eval('#cl-list tbody tr[data-row] td:nth-child(4)', (x) => x.map((t) => t.dataset.sv));
    ok((await cp.$eval('#cl-list th[data-col="3"]', (t) => t.getAttribute('aria-sort'))) === 'ascending' && d1.every((v, i) => !i || d1[i - 1].localeCompare(v) <= 0), 'clients: header click sorts ascending with the arrow');
    await cp.click(hdr); await cp.waitForTimeout(300);
    ok((await cp.$eval('#cl-list th[data-col="3"]', (t) => t.getAttribute('aria-sort'))) === 'descending', 'second click sorts descending');
    await cp.reload(); await cp.waitForSelector('#cl-list tr[data-row]', { timeout: 8000 });
    const d2 = await cp.$$eval('#cl-list tbody tr[data-row] td:nth-child(4)', (x) => x.map((t) => t.dataset.sv));
    ok((await cp.$eval('#cl-list th[data-col="3"]', (t) => t.getAttribute('aria-sort'))) === 'descending' && d2.every((v, i) => !i || d2[i - 1].localeCompare(v) >= 0), 'sort (column + direction) restored from localStorage after reload');
    await cp.evaluate(() => { location.hash = '#/leads/L972500009001'; }); await cp.waitForSelector('.drawer.modal #qc-date', { state: 'attached', timeout: 8000 }); await cp.waitForTimeout(400);
    const mr = await cp.evaluate(() => { const r = document.querySelector('.drawer.modal').getBoundingClientRect(); return [Math.round(r.left), Math.round(innerWidth - r.right), Math.round(r.top), Math.round(innerHeight - r.bottom)]; });
    ok(Math.abs(mr[0] - mr[1]) <= 2 && Math.abs(mr[2] - mr[3]) <= 2 && mr[0] > 40, 'lead details open as a centered modal on desktop', mr.join('/'));
    const v0 = await cp.$eval('#qc-date', (i) => i.value);
    await cp.click('.drawer [data-dp]:has(#qc-date) .dp-btn'); await cp.waitForSelector('.dp-pop [data-d]', { timeout: 3000 });
    await cp.keyboard.press('ArrowLeft'); await cp.keyboard.press('Enter'); await cp.waitForTimeout(200);
    const v1 = await cp.$eval('#qc-date', (i) => i.value), base = v0 || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    ok(v1 === new Date(Date.parse(base + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10) && !(await cp.$('.dp-pop')), 'DatePicker: ← (next day in RTL) + Enter writes the ISO date to the hidden input and closes', v0 + ' → ' + v1);
    await cp.keyboard.press('Escape');
    await cp.evaluate(() => { localStorage.removeItem('ops:live:admin'); location.hash = '#/system?tab=live'; }); await cp.waitForSelector('#lv-feed .feed-row', { timeout: 8000 });
    const hasAdm = () => cp.$$eval('#lv-feed .feed-row .m', (x) => x.some((m) => /^דפדפן/.test(m.textContent)));
    const h0 = await hasAdm(); await cp.click('[data-act=lv-admin]'); await cp.waitForTimeout(300); const h1 = await hasAdm();
    ok(!h0 && h1, 'live log: admin page-view rows hidden until "הצג פעילות אדמין"');
    const firstEl = await cp.$('#lv-feed .feed-row'); await cp.waitForTimeout(3600);
    ok(await firstEl.evaluate((n) => n.isConnected), 'live log poll keeps existing rows in place (no full re-render)');
    ok(cerr.length === 0, 'CRM routes: no console errors', cerr.slice(0, 3).join(' | '));
    await cx.close();

    const mc = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const mp2 = await mc.newPage();
    for (const r of ['leads', 'clients', 'hostesses', 'overview']) {
      await mp2.goto(url + '#/' + r); await mp2.waitForTimeout(r === 'overview' ? 2600 : 1100);
      const over = await mp2.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('#main').scrollWidth, document.querySelector('#main').clientWidth]);
      ok(over[0] <= over[1] && over[2] <= over[3] + 1, '375 px no horizontal scroll · ' + r + (r === 'overview' ? ' (with CRM today + charts)' : ''), over.join('/'));
      await mp2.screenshot({ path: join(shotDir, `${r}-mobile.png`) });
    }
    const tabs = await mp2.$$eval('.tabbar a,.tabbar button', (xs) => xs.map((x) => [x.innerText.trim(), Math.round(x.getBoundingClientRect().height)]));
    ok(tabs.map((t) => t[0]).join('|') === 'סקירה|לידים|לקוחות|הודעות|עוד' && tabs.every((t) => t[1] >= 44), 'phone tab bar: סקירה/לידים/לקוחות/הודעות/עוד (§11), each ≥ 44 px', tabs.map((t) => t[1]).join(','));
    ok(await mp2.$$eval('.nav a', (xs) => xs.some((x) => x.getAttribute('href') === '#/calendar' && x.dataset.r === 'calendar') && !document.querySelector('a[href="calendar.html"]')), 'nav ("עוד" sheet on phones): לוח שנה routes to the in-app #/calendar (no calendar.html link)');
    await mp2.tap('#tb-more'); await mp2.waitForTimeout(300);
    ok(await mp2.$eval('.shell>.nav', (n) => getComputedStyle(n).display !== 'none' && n.querySelectorAll('a[data-r]').length >= 12), '"עוד" opens the full nav as a sheet');
    await mp2.screenshot({ path: join(shotDir, 'more-sheet-mobile.png') });
    await mp2.tap('.more-scrim').catch(() => {});
    await mp2.goto(url + '#/leads/L972500009001'); await mp2.waitForSelector('.drawer .drawer-acts', { timeout: 6000 }); await mp2.waitForTimeout(500);
    const dr = await mp2.evaluate(() => { const d = document.querySelector('.drawer').getBoundingClientRect(), a = document.querySelector('.drawer-acts').getBoundingClientRect(); return [Math.round(d.width), Math.round(d.height), Math.round(a.bottom), innerHeight, Math.min(...[...document.querySelectorAll('.drawer-acts .btn')].map((b) => b.getBoundingClientRect().height)), document.querySelector('.drawer-b').scrollWidth <= document.querySelector('.drawer-b').clientWidth + 1]; });
    ok(dr[0] === 375 && dr[1] === 812 && Math.abs(dr[2] - dr[3]) <= 1 && dr[4] >= 44 && dr[5], '375 px lead drawer: full screen, sticky action bar at the bottom, 44 px buttons, no sideways scroll', dr.join('/'));
    await mp2.screenshot({ path: join(shotDir, 'lead-drawer-mobile.png') });
    const small = await mp2.$$eval('.drawer button:not([tabindex="-1"]), .drawer a.btn', (xs) => xs.filter((x) => x.offsetParent && !x.closest('.chip') && !x.closest('.pop')).map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.height), (x.innerText || x.getAttribute('aria-label') || '').trim().slice(0, 14)]; }).filter((r) => r[0] < 44));
    ok(small.length === 0, '375 px lead drawer: every button ≥ 44 px tall', small.slice(0, 4).map((x) => x.join(':')).join(' · '));
    await mc.close(); await browser.close(); srv.close();
  }
}
{ const r = spawnSync(process.execPath, [join(ROOT, 'scripts/ops-notify-smoke.mjs'), ...process.argv.slice(2)], { encoding: 'utf8' }); process.stdout.write(r.stdout); ok(r.status === 0, 'Phase 5 notify smoke (scripts/ops-notify-smoke.mjs)'); }   /* bell + #/notify + overview v2 at 1440/375 */
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
