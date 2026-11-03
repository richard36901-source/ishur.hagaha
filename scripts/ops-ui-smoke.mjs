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
for (const m of [...mods, ...lazy.filter((m) => m !== 'mock.js')]) { const r = spawnSync(process.execPath, ['--check', join(OPS, m)], { encoding: 'utf8' }); ok(r.status === 0, 'node --check ' + m, r.stderr.trim().split('\n')[0]); }

console.log('A2 size budgets');
const js = mods.reduce((a, m) => a + statSync(join(OPS, m)).size, 0), css = statSync(join(OPS, 'ops.css')).size, html = statSync(join(ROOT, 'ops.html')).size;
ok(js < 120 * 1024, 'JS total < 120 KB', (js / 1024).toFixed(1) + ' KB');
ok(css < 40 * 1024, 'CSS < 40 KB', (css / 1024).toFixed(1) + ' KB');
console.log('    ops.html ' + (html / 1024).toFixed(1) + ' KB · lazy (not counted): ' + lazy.map((m) => m + ' ' + (statSync(join(OPS, m)).size / 1024).toFixed(1) + ' KB').join(', '));
const html0 = readFileSync(join(ROOT, 'ops.html'), 'utf8');
ok(!/<select|type="checkbox"|alert\(|confirm\(|prompt\(/.test(html0 + [...mods, ...lazy].map((m) => readFileSync(join(OPS, m), 'utf8')).join('')), 'no native select/checkbox/alert/confirm/prompt');
ok(/class="sk /.test(html0), 'ops.html ships skeleton markup for first paint');

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
for (const n of ['overview', 'automations', 'runs', 'live', 'brain', 'messaging', 'calls', 'capacity', 'balances']) S[n] = await import(pathToFileURL(join(OPS, 'screens', n + '.js')));
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
check('messaging.view', () => S.messaging.view(F.realtime));
check('messaging.view reason=failed', () => S.messaging.view(F.realtime, 'failed', {}, S.messaging.recentFromLive(F.live.items)));
check('messaging.view with live recent', () => S.messaging.view(F.realtime, '', {}, S.messaging.recentFromLive(F.live.items)));
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
      for (const r of ['overview', 'automations', 'runs', 'live', 'brain', 'messaging', 'calls', 'capacity', 'calendar', 'balances', 'changes']) {
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
        ok((await page.evaluate(() => location.hash)) === '#/runs', 'g r navigates to runs');
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
        ok((await page.evaluate(() => location.hash)) === '#/changes', 'g h navigates to the change log');
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
    for (const r of ['overview', 'automations', 'runs', 'messaging', 'capacity', 'calendar', 'balances', 'changes']) {
      await mp.goto(url + '#/' + r); await mp.waitForTimeout(900);
      const over = await mp.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('#main').scrollWidth, document.querySelector('#main').clientWidth]);
      ok(over[0] <= over[1] && over[2] <= over[3] + 1, '375 px no horizontal scroll · ' + r, over.join('/'));
      await mp.screenshot({ path: join(shotDir, `${r}-mobile.png`) });
    }
    await m.close(); await browser.close(); srv.close();
  }
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
