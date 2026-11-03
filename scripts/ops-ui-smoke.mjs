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
const mods = ['app.js', 'ui.js', ...readdirSync(join(OPS, 'screens')).map((f) => 'screens/' + f)];
for (const m of mods) { const r = spawnSync(process.execPath, ['--check', join(OPS, m)], { encoding: 'utf8' }); ok(r.status === 0, 'node --check ' + m, r.stderr.trim().split('\n')[0]); }

console.log('A2 size budgets');
const js = mods.reduce((a, m) => a + statSync(join(OPS, m)).size, 0), css = statSync(join(OPS, 'ops.css')).size, html = statSync(join(ROOT, 'ops.html')).size;
ok(js < 120 * 1024, 'JS total < 120 KB', (js / 1024).toFixed(1) + ' KB');
ok(css < 40 * 1024, 'CSS < 40 KB', (css / 1024).toFixed(1) + ' KB');
console.log('    ops.html ' + (html / 1024).toFixed(1) + ' KB');
const html0 = readFileSync(join(ROOT, 'ops.html'), 'utf8');
ok(!/<select|type="checkbox"|alert\(|confirm\(|prompt\(/.test(html0 + mods.map((m) => readFileSync(join(OPS, m), 'utf8')).join('')), 'no native select/checkbox/alert/confirm/prompt');
ok(/class="sk /.test(html0), 'ops.html ships skeleton markup for first paint');

console.log('A3 fixture rendering');
const fx = (n) => JSON.parse(readFileSync(join(ROOT, 'fixtures/ops', n + '.json'), 'utf8'));
const F = Object.fromEntries(['registry', 'runs', 'run', 'realtime', 'capacity', 'balances', 'live', 'brain', 'toggle'].map((n) => [n, fx(n)]));
const S = {};
for (const n of ['overview', 'automations', 'runs', 'live', 'brain', 'messaging', 'calls', 'capacity', 'balances']) S[n] = await import(pathToFileURL(join(OPS, 'screens', n + '.js')));
const check = (name, fn) => {
  let out = '';
  try { out = fn(); } catch (e) { ok(false, name, e.message); return; }
  const bad = /undefined|NaN|\[object Object\]/.exec(out.replace(/<script[\s\S]*?<\/script>/g, ''));
  ok(typeof out === 'string' && out.length > 200 && !bad, name, out.length + ' chars' + (bad ? ' · leaked "' + bad[0] + '"' : ''));
};
const reg = F.registry;
check('overview.view', () => S.overview.view(F.realtime, F.capacity, reg));
check('overview.skeleton', () => S.overview.default.skeleton());
check('automations.listView', () => S.automations.listView(reg.nodes, {}));
check('automations.listView filtered (failing)', () => S.automations.listView(reg.nodes, { state: 'failing' }));
for (const id of ['d_pacer', 'wave1', 'shir_dispatch', 'autoretry', 'noa_queue', 'wa_fail']) check('automations.detailView ' + id, () => S.automations.detailView(reg.nodes.find((n) => n.id === id), reg.nodes));
check('automations.depGraph d_pacer', () => S.automations.depGraph(reg.nodes.find((n) => n.id === 'd_pacer'), reg.nodes));
check('automations.blastBody', () => S.automations.blastBody(reg.nodes.find((n) => n.id === 'd_pacer'), { downstream: [{ id: 'x', name: 'א' }], impact: [{ label: 'הזמנות', count: 212 }] }));
check('automations.runsTable', () => S.automations.runsTable(F.runs.items.slice(0, 30)));
const sorted = S.automations.sortNodes(reg.nodes);
ok(sorted.length === reg.nodes.filter((n) => n.layer > 0).length && sorted[0].daypart === 'continuous', 'automations sorted by day-part', sorted.length + ' rows');
ok(S.automations.listView(reg.nodes, { state: 'off' }).includes('aria-checked="false"'), 'disabled automations render as switched off');
check('runs.listView', () => S.runs.listView(F.runs.items.slice(0, 50)));
check('runs.runDetail', () => S.runs.runDetail(F.run));
check('live rows', () => F.live.items.map(S.live.row).join(''));
ok(F.live.items.filter((x) => S.live.match(x, { kind: 'call' })).every((x) => x.kind === 'call'), 'live filter by kind');
check('brain.findingsView', () => S.brain.findingsView(F.brain.findings));
check('brain.playbooksView', () => S.brain.playbooksView(F.brain.playbooks));
check('messaging.view', () => S.messaging.view(F.realtime));
check('messaging.view reason=failed', () => S.messaging.view(F.realtime, 'failed'));
check('calls.view', () => S.calls.view(F.realtime));
check('capacity.view', () => S.capacity.view(F.capacity));
ok(S.capacity.view(F.capacity).includes('▲'), 'capacity shows over-capacity marker', F.capacity.alerts.length + ' alert days');
check('balances.view', () => S.balances.view(F.balances));
ok(F.balances.vendors.filter(S.balances.isLow).map((v) => v.vendor).join() === 'telnyx', 'balances low detection = telnyx only');
check('empty states', () => S.runs.listView([]) + S.automations.listView([], {}) + S.brain.findingsView([]) + S.overview.incidents([]) + S.overview.nextUp([]) + '<x>'.repeat(60));

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
      for (const r of ['overview', 'automations', 'runs', 'live', 'brain', 'messaging', 'calls', 'capacity', 'balances']) {
        await page.evaluate((h) => { location.hash = h; }, '#/' + r);
        await page.waitForFunction(() => !document.querySelector('#main .sk') || document.querySelector('#main .feed-row,#main table,#main .tile .v'), null, { timeout: 5000 }).catch(() => {});
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
        ok(/212/.test(blast) && /אוטומציות שתלויות/.test(blast), 'blast radius lists live impact + downstream');
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
        ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
      }
      await ctx.close();
    }
    const m = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const mp = await m.newPage();
    for (const r of ['overview', 'automations', 'runs', 'messaging', 'capacity', 'balances']) {
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
