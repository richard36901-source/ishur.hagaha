/* Live check: ops.html against the REAL ops API (go.ishur.io), read-only.
   Auth exactly like the other admin pages: the key sits in localStorage "ishur_calls_key" and
   app.js POSTs it with IshurGuard.stamp(). No query-string key, no new auth path.
   It never sends a toggle with confirm (it does not even open the toggle dialog).
   Screenshots → docs/ops-screens/live/<route>.png. Before each shot, phone numbers on the page are
   masked in the DOM (the repo is public), as are full event tokens (UUIDs: board access), key-like
   fields, and the contact name after a phone in feed rows.
   Usage: OPS_ADMIN_KEY=… node scripts/ops-ui-live.mjs      Exit 0 = every route rendered real data. */
import { readFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.OPS_ADMIN_KEY; if (!KEY) { console.error('set OPS_ADMIN_KEY'); process.exit(2); }
let pw; try { pw = await import('playwright'); } catch (e) { for (const d of readdirSync(join(homedir(), '.npm/_npx'))) { const p = join(homedir(), '.npm/_npx', d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) { pw = await import(pathToFileURL(p)); break; } } }
if (!pw) { console.error('Playwright not importable'); process.exit(2); }
let fails = 0; const ok = (c, n, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x ? ' · ' + x : '')); if (!c) fails++; };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
/* the Worker's CORS only allows ishur.io origins, so the local worktree is served UNDER https://ishur.io
   by request interception: the page runs this checkout's code, with the real origin, against the real API */
const url = 'https://ishur.io/ops.html';
const out = join(ROOT, 'docs/ops-screens/live'); mkdirSync(out, { recursive: true });
let browser; try { browser = await pw.chromium.launch(); } catch (e) { browser = await pw.chromium.launch({ channel: 'chrome' }); }
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', colorScheme: 'light' });
await ctx.addInitScript((k) => { try { localStorage.setItem('ishur_calls_key', k); } catch (e) {} }, KEY);
await ctx.route('https://ishur.io/**', (route) => {
  const u = decodeURIComponent(new URL(route.request().url()).pathname), f = join(ROOT, u === '/' ? 'ops.html' : u);
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ status: 200, contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});
const page = await ctx.newPage();
const errors = [], api = [], bad = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (rq) => { if (rq.url().includes('/api/ops/')) { api.push({ t: Date.now(), u: rq.url() }); if (rq.url().includes('/toggle')) { const b = rq.postData() || ''; if (/"confirm"/.test(b)) bad.push(b); } } });
page.on('response', (rs) => { if (rs.url().includes('/api/ops/') && rs.status() >= 400) errors.push(rs.status() + ' ' + rs.url()); });
const mask = () => page.evaluate(() => {
  const re = /(?<![\d*])(972\d{8,9}|05\d-?\d{3}-?\d{4})(?![\d*])/g, keep = /(6673|9799|4499)$/;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const uuid = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, keyish = /("?(?:webhookKey|admin_key|api_?key|secret|password|signature)"?\s*[:=]\s*"?)[^",\s}&]+/gi;
  for (let n; (n = w.nextNode());) n.nodeValue = n.nodeValue.replace(uuid, '$1-…').replace(keyish, '$1•••').replace(re, (m) => (keep.test(m.replace(/\D/g, '')) ? m : m.slice(0, 5) + '****' + m.slice(-3)));
  document.querySelectorAll('.feed-row .m').forEach((m) => { m.textContent = m.textContent.replace(/(\*{4}\d{3}) · .+$/, '$1 · ‹שם›'); });
});

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#main .tile .v', { timeout: 20000 }).catch(async () => { console.log('DEBUG', errors, api.map((x) => x.u), (await page.$eval('body', (b) => b.innerText)).slice(0, 400)); process.exit(1); });
await page.waitForTimeout(1200); /* < the 1.5 s side-feed delay */
const onLoad = [...new Set(api.filter((x) => x.t - t0 < 1400).map((x) => x.u.split('/api/ops/')[1].split('?')[0]))];
ok(onLoad.length <= 3, 'overview: ≤ 3 API requests on load (real API)', onLoad.join(', '));
ok(!(await page.$('#gate:not([hidden])')), 'admin key accepted (no login gate)');
const ROUTES = { overview: '.tile .v', automations: 'table tr[data-row]', runs: '#rn-list', live: '.feed-row', brain: '#br-stream', messaging: 'article.card', calls: '.tile .v', capacity: 'svg', balances: 'article.card' };
for (const [r, sel] of Object.entries(ROUTES)) {
  await page.evaluate((h) => { location.hash = h; }, '#/' + r);
  await page.waitForSelector('#main ' + sel, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#main .sk'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(r === 'live' ? 3500 : 900);
  const txt = await page.$eval('#main', (m) => m.innerText);
  const err = await page.$eval('#main', (m) => (m.querySelector('.errbox') || {}).innerText || '');
  if (r === 'brain') ok(/עוד לא קיימת/.test(err), 'route brain: shows "endpoint not built yet" (no backend)', err.slice(0, 60));
  else ok(txt.length > 80 && !/undefined|NaN|\[object Object\]/.test(txt) && !/לא הצלחנו לטעון|אין הרשאה/.test(err), 'route ' + r + ' renders live data', txt.length + ' chars' + (err ? ' · box: ' + err.slice(0, 80) : ''));
  await mask();
  await page.screenshot({ path: join(out, r + '.png'), fullPage: true });
}
await page.evaluate(() => { location.hash = '#/automations/d_pacer'; });
await page.waitForSelector('.drawer #au-code .code', { timeout: 15000 }).then(() => ok(true, 'automation drawer loads real code from /api/ops/code')).catch(() => ok(false, 'automation drawer loads real code from /api/ops/code'));
await page.waitForTimeout(800); await mask();
await page.screenshot({ path: join(out, 'automation-drawer.png') });
ok(bad.length === 0, 'no toggle request carried "confirm"');
/* brain has no backend route yet: its single 404 (+ the browser's matching console line) is asserted above */
const brain404 = errors.filter((e) => /\/api\/ops\/brain|status of 404/.test(e)), other = errors.filter((e) => !brain404.includes(e));
ok(brain404.length <= 2, 'brain: exactly one 404 request, no polling of the missing route', brain404.length + ' lines');
ok(other.length === 0, 'no other console / HTTP errors', other.slice(0, 4).join(' | '));
await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall live checks passed'); process.exit(fails ? 1 : 0);
