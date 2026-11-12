/* Design flow card + dashboard PWA smoke test (03/11).
   Part A (plain node): node --check, manifest + icons, shell files exist, only
   dashboard.html registers the PWA, design-card render() over every state, sw.js
   fetch routing in a fake worker scope.
   Part B (only if Playwright loads): dashboard.html?demo=1&preview=1&designmock=<state> renders
   the card with no console errors, no horizontal scroll at 375px, screenshots to
   docs/design-screens/ (demo data only, nothing real).
   Exit 0 = every run check passed. Usage: node scripts/design-pwa-smoke.mjs [--no-browser] */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (c, n, x = '') => { if (c) { passes++; console.log('  ✓ ' + n + (x ? ' · ' + x : '')); } else { fails++; console.log('  ✗ ' + n + (x ? ' · ' + x : '')); } };

console.log('A1 syntax');
for (const f of ['assets/design-card.js', 'assets/pwa.js', 'sw.js', 'scripts/pwa-icons.mjs', 'worker/design.js']) {
  const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' }); ok(r.status === 0, 'node --check ' + f, r.stderr.trim().split('\n')[0]);
}

console.log('A2 manifest + icons');
const man = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
const dash = readFileSync(join(ROOT, 'dashboard.html'), 'utf8');
const green = (dash.match(/--green:(#[0-9A-Fa-f]{6})/) || [])[1];
ok(man.name === 'ishur · אישורי הגעה' && man.lang === 'he' && man.dir === 'rtl' && man.display === 'standalone', 'name / he / rtl / standalone');
ok(man.theme_color === green, 'theme_color = dashboard --green', man.theme_color + ' vs ' + green);
for (const ic of man.icons) {
  const p = join(ROOT, ic.src), b = existsSync(p) ? readFileSync(p) : null;
  const w = b ? b.readUInt32BE(16) : 0, h = b ? b.readUInt32BE(20) : 0;
  ok(b && b.slice(1, 4).toString() === 'PNG' && ic.sizes === `${w}x${h}`, 'icon ' + ic.src, `${w}x${h}`);
}
ok(man.start_url.startsWith('dashboard.html') && man.scope === 'dashboard.html', 'start_url/scope stay on dashboard.html');

console.log('A3 wiring');
ok(/<link rel="manifest" href="manifest.webmanifest">/.test(dash) && /assets\/pwa\.js/.test(dash) && /id="pwaCard"/.test(dash), 'dashboard.html links manifest + pwa.js + card');
ok(/id="designCard" hidden/.test(dash) && /assets\/design-card\.js/.test(dash), 'dashboard.html has the hidden design card + script');
/* 12/11: account.html is its own installable app (manifest-account.webmanifest, scope account.html) — Richard approved; it must never touch the board's SW scope */
const others = readdirSync(ROOT).filter((f) => f.endsWith('.html') && f !== 'dashboard.html' && f !== 'account.html').filter((f) => /sw\.js|pwa\.js|manifest\.webmanifest/.test(readFileSync(join(ROOT, f), 'utf8')));
ok(others.length === 0, 'no other page registers the SW / manifest', others.join(', '));
ok(/register\('sw\.js', \{ scope: 'dashboard\.html' \}\)/.test(readFileSync(join(ROOT, 'assets/pwa.js'), 'utf8')), 'SW scope is dashboard.html only');
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const shell = JSON.parse('[' + sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
const missing = shell.filter((f) => !existsSync(join(ROOT, f)));
ok(missing.length === 0, 'every precached shell file exists', shell.length + ' files' + (missing.length ? ' · missing ' + missing.join(',') : ''));
const used = [...dash.matchAll(/(?:src|href)="((?:assets\/|config)[^"?]+)/g)].map((m) => m[1]).filter((u) => !/\.webmanifest$/.test(u));
const notCached = [...new Set(used)].filter((u) => !shell.includes(u));
ok(notCached.length === 0, 'shell covers every local asset dashboard.html loads', notCached.join(', '));

console.log('A4 design card render()');
const require = createRequire(import.meta.url);
const DC = require(join(ROOT, 'assets/design-card.js'));
const clean = (h) => !/undefined|NaN|\[object Object\]/.test(h);
ok(DC.render({ ok: true, paid: false }) === '', 'unpaid → nothing');
const st = (k, patch = {}) => Object.assign(DC.mockState(k), patch);
const cases = [
  ['brief form', st('brief'), ['מה תרצו בהזמנה', 'שליחה', '0/5']],
  ['brief sent', st('sent'), ['נשלח, נחזור עם עיצוב ראשון', 'עריכת הבקשה']],
  ['v1 awaiting', st('v1'), ['מאשר/ת ✅', 'יש לי הערות ✍️', 'סבבי תיקונים: 0 מתוך 2']   /* 12/11 Richard: two included rounds, no purchase button while one is left */],
  ['rounds used up', st('limit'), ['מאשר/ת ✅', 'סבבי תיקונים: 2 מתוך 2', 'רכישת סבב נוסף · ₪49', 'היסטוריה (2 גרסאות)', 'ירוק כהה יותר']],
  ['changes requested', st('v1', { status: 'changes_requested' }), ['קיבלנו את ההערות']],
  ['approved', st('approved'), ['אישרתם ✅']],
  ['done', st('approved', { status: 'done' }), ['העיצוב מוכן']],
  ['pdf version', st('v1', { versions: [{ n: 1, url: 'https://x/y', mime: 'application/pdf', at: '' }] }), ['PDF']],
];
for (const [n, s, must] of cases) {
  let h = ''; try { h = DC.render(s, {}); } catch (e) { ok(false, n, e.message); continue; }
  const miss = must.filter((m) => !h.includes(m));
  ok(h.length > 100 && clean(h) && !miss.length, n, miss.length ? 'missing ' + miss.join(' | ') : h.length + ' chars');
}
ok(!DC.render(st('v1'), { changing: true }).includes('data-act="approve"') && DC.render(st('v1'), { changing: true }).includes('שליחת ההערות'), 'changes textarea replaces the buttons');
ok(DC.render(st('brief', { brief: { text: '<img src=x onerror=alert(1)>', refs: [] } }), { editing: true }).includes('&lt;img'), 'brief text is escaped');

console.log('A5 sw.js routing in a fake worker scope');
const handlers = {}, handled = [];
const fakeSelf = { location: { origin: 'https://ishur.io' }, addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: () => {}, clients: { claim: () => {} } };
vm.runInNewContext(sw, { self: fakeSelf, caches: { open: async () => ({ match: async () => null, put: async () => {} }), keys: async () => [] }, fetch: async () => new Response(''), URL, Response, Promise });
const fire = (url, method = 'GET', mode = 'cors') => { let r = false; handlers.fetch({ request: { url, method, mode }, respondWith: () => { r = true; } }); return r; };
ok(fire('https://go.ishur.io/api/design-file?t=a&id=b') === true, 'GET /api/* → network-first');
ok(fire('https://go.ishur.io/api/design-flow', 'POST') === false, 'POST never intercepted');
ok(fire('https://ishur.io/dashboard.html?t=x', 'GET', 'navigate') === true, 'navigation → network-first');
ok(fire('https://ishur.io/assets/lead.js?v=24') === true, 'same-origin static → cache-first');
ok(fire('https://fonts.googleapis.com/css2?family=Heebo') === false, 'cross-origin non-API untouched');

/* ── Part B ── */
async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* next */ }
  for (const p of [join(homedir(), '.ship-studio/playwright-env/node_modules/playwright/index.mjs')]) if (existsSync(p)) { try { return await import(pathToFileURL(p)); } catch (e) { /* next */ } }
  const base = join(homedir(), '.npm/_npx');
  if (existsSync(base)) for (const d of readdirSync(base)) { const p = join(base, d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) { try { return await import(pathToFileURL(p)); } catch (e) { /* next */ } } }
  return null;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
if (!process.argv.includes('--no-browser')) {
  const pw = await loadPlaywright();
  if (!pw) console.log('B  skipped: Playwright not importable');
  else {
    const srv = createServer((q, s) => { const p = join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (!p.startsWith(ROOT) || !existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); }).listen(0);
    const port = srv.address().port;
    let browser = null;
    try { browser = await pw.chromium.launch(); } catch (e) { try { browser = await pw.chromium.launch({ channel: 'chrome' }); } catch (e2) { console.log('B  skipped: no Chromium (' + e2.message.split('\n')[0] + ')'); } }
    if (browser) {
      const shots = join(ROOT, 'docs/design-screens'); mkdirSync(shots, { recursive: true });
      for (const k of ['brief', 'sent', 'v1', 'limit', 'approved']) {
        const page = await browser.newPage({ viewport: { width: 375, height: 1500 }, deviceScaleFactor: 2 });
        const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|posthog|fonts/i.test(m.text())) errs.push(m.text()); });
        await page.route(/^(?!http:\/\/localhost)/, (r) => r.abort());
        await page.addInitScript(() => { try { localStorage.setItem('ishur_consent_v1', JSON.stringify({ choice: 'essential', until: Date.now() + 864e5 })); } catch (e) {} });   /* keep the cookie bar out of the screenshots */
        await page.goto(`http://localhost:${port}/dashboard.html?demo=1&preview=1&designmock=${k}`, { waitUntil: 'load' });
        await page.waitForSelector('#designCard:not([hidden]) [data-dz-body] *', { timeout: 5000 }).catch(() => {});
        const vis = await page.$eval('#designCard', (e) => !e.hidden).catch(() => false);
        const sw = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        ok(vis && !errs.length, `browser designmock=${k}: card visible, no page errors`, errs.slice(0, 2).join(' | '));
        ok(sw, `browser designmock=${k}: no horizontal scroll at 375px`);
        const el = vis ? await page.$('#designCard') : null; if (el) await el.screenshot({ path: join(shots, `design-${k}.png`) });
        if (k === 'v1') {
          await page.click('[data-act="changes"]'); await page.fill('#dzComment', 'שם הכלה באות גדולה יותר');
          await page.click('[data-act="changes-send"]');
          ok(await page.locator('text=קיבלנו את ההערות').count() > 0, 'browser: changes flow reaches "קיבלנו את ההערות"');
          if (el) await el.screenshot({ path: join(shots, 'design-changes.png') });
        }
        if (k === 'brief') {
          await page.fill('#dzText', 'דנה ואבי · ירוק זית'); await page.click('[data-act="send"]');
          ok(await page.locator('text=נשלח, נחזור עם עיצוב ראשון').count() > 0, 'browser: brief submit shows the sent state');
        }
        await page.close();
      }
      /* PWA card: iOS UA shows the share instructions; standalone hides it */
      const ios = await browser.newContext({ viewport: { width: 375, height: 812 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
      const ip = await ios.newPage(); await ip.route(/^(?!http:\/\/localhost)/, (r) => r.abort());
      await ip.goto(`http://localhost:${port}/dashboard.html?demo=1&preview=1`, { waitUntil: 'load' });
      ok(await ip.$eval('#pwaCard', (e) => !e.hidden && /הוספה למסך הבית/.test(e.textContent)).catch(() => false), 'browser iOS: "הוסיפו למסך הבית" card with share steps');
      const pc = await ip.$('#pwaCard'); if (pc) await pc.screenshot({ path: join(shots, 'pwa-ios-card.png') });
      await ip.emulateMedia({ media: 'screen' });
      await ios.close();
      const st2 = await browser.newPage(); await st2.route(/^(?!http:\/\/localhost)/, (r) => r.abort());
      await st2.addInitScript(() => { const mm = window.matchMedia; window.matchMedia = (q) => /display-mode: standalone/.test(q) ? { matches: true, addEventListener() {}, removeListener() {} } : mm.call(window, q); });
      await st2.goto(`http://localhost:${port}/dashboard.html?demo=1&preview=1`, { waitUntil: 'load' });
      ok(await st2.$eval('#pwaCard', (e) => e.hidden).catch(() => false), 'browser standalone: card hidden');
      const swc = await st2.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('dashboard.html'); return r ? r.scope : ''; }).catch(() => '');
      ok(/\/dashboard\.html$/.test(swc), 'browser: SW registered with scope …/dashboard.html', swc);
      /* same context as the registration above, so the SW is live: the dashboard is controlled, index.html is not */
      await st2.evaluate(() => navigator.serviceWorker.ready);
      await st2.reload({ waitUntil: 'load' });
      ok(await st2.evaluate(() => !!navigator.serviceWorker.controller), 'browser: dashboard.html is controlled after reload');
      await st2.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' }).catch(() => {});
      ok(!(await st2.evaluate(() => !!navigator.serviceWorker.controller).catch(() => true)), 'browser: index.html in the same browser is NOT controlled');
      await browser.close();
    }
    srv.close();
  }
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
