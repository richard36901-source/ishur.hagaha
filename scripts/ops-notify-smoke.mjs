/* Phase 5 smoke: notifications bell + "התראות" screen + the smart overview (lazy/notify.js, lazy/overview2.js).
   A (plain node): syntax, fixtures are fake (97250000xxxx / zeroed tokens), every view renders the fixtures without
   "undefined"/"NaN"/"[object Object]". B (Playwright, ?mock=1): bell count + dropdown + mark read, #/notify list +
   filters + settings toggle, overview order + interactive trend chart (range chips, arrows, tooltip, table) at 1440,
   and the phone version at 375 px (2-column tiles, ממתין לך + תקריות first, full-width chart, scrollable chips,
   44 px targets, no horizontal scroll). Exit 0 = all passed. Invoked from ops-ui-smoke.mjs; also runs alone.
   Usage: node scripts/ops-notify-smoke.mjs [--no-browser] */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPS = join(ROOT, 'assets/ops');
let fails = 0, passes = 0;
const ok = (c, name, extra = '') => { if (c) passes++; else fails++; console.log(`  ${c ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`); };
const fx = (n) => JSON.parse(readFileSync(join(ROOT, 'fixtures/ops', n + '.json'), 'utf8'));

console.log('N1 syntax + fixtures');
for (const m of ['lazy/notify.js', 'lazy/overview2.js', 'screens/overview.js']) { const r = spawnSync(process.execPath, ['--check', join(OPS, m)], { encoding: 'utf8' }); ok(r.status === 0, 'node --check ' + m, r.stderr.trim().split('\n')[0]); }
const FX = Object.fromEntries(['notifications', 'notify-settings', 'overview', 'overview-series'].map((n) => [n, fx(n)]));
const blob = JSON.stringify(FX);
ok((blob.match(/972\d{9}/g) || []).every((m) => /^97250000\d{4}$/.test(m) || m === '972545764327'), 'fixtures: only fake 97250000xxxx phones');
ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(blob), 'fixtures: no event tokens');
ok(!/<select|type="checkbox"|alert\(|confirm\(|prompt\(/.test(['lazy/notify.js', 'lazy/overview2.js'].map((m) => readFileSync(join(OPS, m), 'utf8')).join('')), 'no native select/checkbox/alert/confirm/prompt');

console.log('N2 views render');
const NT = await import(pathToFileURL(join(OPS, 'lazy/notify.js'))), OV = await import(pathToFileURL(join(OPS, 'lazy/overview2.js')));
const check = (name, fn) => { let out = ''; try { out = fn(); } catch (e) { ok(false, name, e.message); return ''; } const bad = /undefined|NaN|\[object Object\]/.exec(out); ok(typeof out === 'string' && out.length > 100 && !bad, name, out.length + ' chars' + (bad ? ' · leaked "' + bad[0] + '"' : '')); return out; };
check('notify.dropdown', () => NT.dropdown(FX.notifications));
check('notify.dropdown empty', () => NT.dropdown({ items: [], unread: 0 }) + '<x>'.repeat(20));
const lv = check('notify.listView', () => NT.listView(FX.notifications, { sev: new Set(), unread: false, rule: '' }));
ok((lv.match(/class="ntf-row/g) || []).length === FX.notifications.items.length, 'list: one row per notification');
ok((NT.listView(FX.notifications, { sev: new Set(['P0']), unread: false, rule: '' }).match(/class="ntf-row/g) || []).length === FX.notifications.items.filter((n) => n.severity === 'P0').length, 'list: severity filter');
check('notify.settingsView', () => NT.settingsView(FX['notify-settings']));
ok((NT.settingsView(FX['notify-settings']).match(/class="ntf-rule/g) || []).length === FX['notify-settings'].rules.length, 'settings: one row per rule', FX['notify-settings'].rules.length + ' rules');
const ov = check('overview2.view', () => OV.view(FX.overview));
const order = ['ממתין לך', 'תקריות', 'היום', 'מגמות', 'אירועים קרובים', 'מה השתנה מאז הביקור האחרון', 'יתרות'].map((t) => ov.indexOf('>' + t + '<'));
ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'overview order: ממתין לך · תקריות · היום · מגמות · אירועים · מה השתנה · יתרות', order.join(','));
check('overview2.view skeleton', () => OV.view(null));
check('overview2 empty world', () => OV.view({ ...FX.overview, waiting: [], incidents: [], events: [], changes: { count: 0, items: [] }, balances: { low: [] }, ads: { why: 'אין מפתח' }, traffic: { why: 'x' } }));
for (const m of OV.METRICS) check('trend ' + m.id, () => OV.trendView({ metric: m.id, range: 'month', offset: 0, table: false, data: FX['overview-series'], width: 600 }));
check('trend table', () => OV.trendView({ metric: 'revenue', range: 'month', offset: 0, table: true, data: FX['overview-series'] }));
ok(/אין נתונים עדיין: אין מפתח/.test(OV.trendView({ metric: 'ad_spend', range: 'month', offset: 0, data: { ...FX['overview-series'], series: { ...FX['overview-series'].series, ad_spend: null }, why: { ads: 'אין מפתח META_ADS_TOKEN בוורקר' } } })), 'trend: missing source shows "אין נתונים עדיין" + the reason');
ok(/אין נתונים עדיין/.test(OV.extrasTiles({ ads: { why: 'אין מפתח' }, traffic: { why: 'x' } })), 'ads/traffic tiles: honest empty state');

async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* fall through */ }
  const base = join(homedir(), '.npm/_npx'); if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) { const p = join(base, d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) { try { return await import(pathToFileURL(p)); } catch (e) { /* next */ } } }
  return null;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
if (!process.argv.includes('--no-browser')) {
  const pw = await loadPlaywright();
  if (!pw) console.log('N3 skipped: Playwright not importable');
  else {
    console.log('N3 browser');
    const srv = createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = join(ROOT, u === '/' ? 'ops.html' : u); if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' }); r.end(readFileSync(f)); }).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${srv.address().port}/ops.html?mock=1`;
    let browser; try { browser = await pw.chromium.launch(); } catch (e) { browser = await pw.chromium.launch({ channel: 'chrome' }); }
    const shots = join(ROOT, 'docs/ops-screens'); mkdirSync(shots, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      const cx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      const p = await cx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
      await p.goto(url + '#/overview'); await p.waitForSelector('.ov2 .tile .v', { timeout: 6000 }); await p.waitForSelector('[data-chart] svg rect.hit', { timeout: 6000, state: 'attached' }); await p.waitForTimeout(500);
      await p.screenshot({ path: join(shots, `overview2-${scheme}.png`), fullPage: true });
      if (scheme === 'dark') { ok(await p.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)'), 'dark mode: overview not white'); ok(errs.length === 0, 'dark: no console errors', errs.slice(0, 2).join(' | ')); await cx.close(); continue; }
      const cnt = await p.waitForFunction(() => { const c = document.querySelector('#ntf-bell .cnt'); return c && !c.hidden && c.textContent; }, null, { timeout: 4000 }).then((h) => h.jsonValue()).catch(() => '');
      ok(cnt === '5', 'bell shows the unread count', 'count ' + cnt);
      await p.click('#ntf-bell'); await p.waitForSelector('.ntf-pop .ntf-row', { timeout: 3000 });
      ok((await p.$$eval('.ntf-pop .ntf-row', (x) => x.length)) === 8, 'dropdown lists the latest notifications');
      await p.screenshot({ path: join(shots, 'notify-bell-light.png') });
      await p.click('.ntf-pop [data-act=ntf-read]'); await p.waitForTimeout(400);
      ok((await p.$eval('#ntf-bell .cnt', (c) => c.textContent)) === '4', 'mark read in the dropdown drops the count');
      await p.keyboard.press('Escape'); ok(!(await p.$('.ntf-pop')), 'Esc closes the dropdown');
      /* trend chart: range, arrows, tooltip, table */
      const bars0 = await p.$$eval('[data-chart] rect.hit', (x) => x.length);
      ok(bars0 === 30, 'trend: month = 30 day buckets', bars0);
      const svgW = await p.$eval('[data-chart] svg', (s) => [Math.round(s.getBoundingClientRect().width), Math.round(s.closest('.card').getBoundingClientRect().width)]);
      ok(svgW[0] > svgW[1] - 60, 'trend: chart is full card width', svgW.join('/'));
      await p.hover('[data-chart] rect.hit[data-i="20"]'); await p.waitForTimeout(150);
      ok(/₪/.test(await p.$eval('[data-chart] .tip', (t) => t.innerText).catch(() => '')), 'trend: hover tooltip shows the exact value');
      await p.click('[data-act=tr-r][data-v=week]'); await p.waitForTimeout(500);
      ok((await p.$eval('[data-act=tr-r][data-v=week]', (b) => b.getAttribute('aria-pressed'))) === 'true', 'trend: range switch (שבוע)');
      await p.click('[data-act=tr-prev]'); await p.waitForTimeout(400);
      ok((await p.$eval('[data-act=tr-next]', (b) => b.getAttribute('aria-disabled'))) !== 'true', 'trend: step back enables "next"');
      await p.click('[data-act=tr-m][data-v=calls]'); await p.click('[data-act=tr-table]'); await p.waitForTimeout(200);
      ok((await p.$$eval('.ov2 table.tt tbody tr', (x) => x.length)) > 5, 'trend: טבלה toggle shows rows');
      await p.screenshot({ path: join(shots, 'overview2-trend-table-light.png') });
      ok(/מודעות · 7 ימים/.test(await p.$eval('#main', (m) => m.innerText)) && /כניסות לאתר/.test(await p.$eval('#main', (m) => m.innerText)), 'overview shows ads + site traffic tiles');
      /* notifications screen */
      await p.goto(url + '#/notify'); await p.waitForSelector('#main .ntf-row', { timeout: 5000 });
      const rows = await p.$$eval('#main .ntf-row', (x) => x.length);
      await p.click('#main [data-act=ntf-f-sev][data-v=P1]'); await p.waitForTimeout(150);
      ok(rows === 8 && (await p.$$eval('#main .ntf-row', (x) => x.length)) === FX.notifications.items.filter((n) => n.severity === 'P1').length, 'screen: list + severity filter', rows + ' rows');
      await p.screenshot({ path: join(shots, 'notify-list-light.png') });
      await p.click('#main [role=tab][data-v=settings]'); await p.waitForSelector('#main .ntf-rule', { timeout: 4000 });
      const sw = '#main .ntf-rule[data-rule=new_lead] [role=switch]';
      await p.click(sw); await p.waitForTimeout(300);
      ok((await p.$eval(sw, (b) => b.getAttribute('aria-checked'))) === 'false' && /נרשם ביומן/.test(await p.$eval('body', (b) => b.innerText)), 'settings: toggle a rule off, toast says it was logged');
      await p.screenshot({ path: join(shots, 'notify-settings-light.png') });
      ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | '));
      await cx.close();
    }
    /* phone */
    const mc = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const mp = await mc.newPage(); const merr = []; mp.on('pageerror', (e) => merr.push(e.message));
    await mp.goto(url + '#/overview'); await mp.waitForSelector('[data-chart] svg rect.hit', { timeout: 6000, state: 'attached' }); await mp.waitForTimeout(500);
    const lay = await mp.evaluate(() => {
      const over = document.documentElement.scrollWidth <= innerWidth && document.querySelector('#main').scrollWidth <= document.querySelector('#main').clientWidth + 1;
      const tiles = [...document.querySelectorAll('.ov2 .g-tiles')][0].querySelectorAll('.tile');
      const cols = new Set([...tiles].map((t) => Math.round(t.getBoundingClientRect().left))).size;
      const h2 = [...document.querySelectorAll('.ov2 h2')].map((h) => h.textContent);
      const chart = document.querySelector('[data-chart] svg').getBoundingClientRect().width, card = document.querySelector('#ov-trend').getBoundingClientRect().width;
      const scr = document.querySelector('.ov2 .scr'); const scrollable = getComputedStyle(scr).overflowX === 'auto';
      const small = [...document.querySelectorAll('.ov2 button, .ov2 a.btn, .ov2 .chipb')].filter((x) => x.offsetParent && x.getBoundingClientRect().height < 44).map((x) => x.textContent.trim().slice(0, 12));
      return { over, cols, first: h2.slice(0, 2).join('|'), chartFull: chart >= card - 48, scrollable, small };
    });
    ok(lay.over, '375 px overview: no horizontal scroll');
    ok(lay.cols === 2, '375 px: tiles stack in 2 columns', lay.cols + ' cols');
    ok(lay.first === 'ממתין לך|תקריות', '375 px: ממתין לך + תקריות come first', lay.first);
    ok(lay.chartFull && lay.scrollable, '375 px: full-width chart, range/metric chips scroll sideways inside their row');
    ok(lay.small.length === 0, '375 px: every tap target ≥ 44 px', lay.small.slice(0, 5).join(', '));
    await mp.screenshot({ path: join(shots, 'overview2-mobile.png'), fullPage: true });
    await mp.tap('#ntf-bell'); await mp.waitForSelector('.ntf-pop .ntf-row', { timeout: 3000 });
    const pop = await mp.$eval('.ntf-pop', (x) => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
    ok(pop, '375 px: bell dropdown fits the screen'); await mp.screenshot({ path: join(shots, 'notify-bell-mobile.png') });
    await mp.goto(url + '#/notify'); await mp.waitForSelector('#main .ntf-row', { timeout: 5000 });
    ok(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '375 px notify screen: no horizontal scroll');
    await mp.screenshot({ path: join(shots, 'notify-list-mobile.png') });
    ok(merr.length === 0, '375 px: no page errors', merr.slice(0, 2).join(' | '));
    await mc.close(); await browser.close(); srv.close();
  }
}
console.log(`\nnotify smoke: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
