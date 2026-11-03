/* site prefill link smoke test (03/11).
   Part A (plain node): node --check every inline <script> of index.html (the
   ops-ui-smoke way) + popup.js + config.js; config.js in a sandbox: hostess
   size rule, bundle scope, design price; every param paylink.siteLink writes
   is read by index.html.
   Part B (only if Playwright loads): serve the repo, open the prefill links,
   stub the Worker, check the popup is filled, editable, priced from the
   tables, and that a design order posts /api/quote-from-site and follows its url.
   Exit 0 = all run checks passed. Usage: node scripts/prefill-smoke.mjs [--no-browser] */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (c, name, extra = '') => { if (c) { passes++; console.log('  ✓ ' + name + (extra ? ' · ' + extra : '')); } else { fails++; console.log('  ✗ ' + name + (extra ? ' · ' + extra : '')); } };

console.log('A1 syntax');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const tmp = mkdtempSync(join(tmpdir(), 'prefill-'));
inline.forEach((code, i) => { const f = join(tmp, `inline-${i}.js`); writeFileSync(f, code); const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); ok(r.status === 0, `node --check index.html inline #${i} (${code.length} chars)`, r.stderr.split('\n').slice(0, 3).join(' ')); });
for (const f of ['assets/popup.js', 'config.js']) { const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' }); ok(r.status === 0, 'node --check ' + f, r.stderr); }

console.log('A2 config rules');
const sb = { window: {}, location: { hostname: 'ishur.io', search: '' }, console }; sb.window = sb;
vm.createContext(sb); vm.runInContext(readFileSync(join(ROOT, 'config.js'), 'utf8'), sb);
const CFG = sb.ISHUR_CONFIG;
ok(CFG.hostessTier(200).count === 1 && CFG.hostessTier(300).count === 2 && CFG.hostessTier(900).count === 2, 'hostesses: under 300 → 1, 300+ → 2');
ok(!CFG.bundleApplies(CFG.bundleFor('winter1790'), '300', 'premium', true), 'winter1790 (1 hostess) does not cover 300');
ok(CFG.bundleApplies(CFG.bundleFor('winter1990'), '700', 'basic', true) || !CFG.bundleLive(CFG.bundleFor('winter1990')), 'winter1990 covers 700 with any plan (while live)');
ok(CFG.DESIGN_PRICE === 79, 'design ₪79');
const { SITE_PARAMS, PKG_PRICES, BUNDLES } = await import(pathToFileURL(join(ROOT, 'worker/paylink.js')));
const read = new Set([...html.matchAll(/q\.get\('([a-z]+)'\)/g)].map(m => m[1]));
ok(SITE_PARAMS.every(p => read.has(p)), 'index.html reads every param siteLink writes', SITE_PARAMS.filter(p => !read.has(p)).join(',') || 'all');
ok(Object.keys(PKG_PRICES).every(t => ['basic', 'pro', 'premium'].every(p => CFG.priceFor(t, p) === PKG_PRICES[t][p])), 'paylink PKG_PRICES == config PRICE_TABLE');
ok(Object.entries(BUNDLES).every(([k, b]) => { const c = CFG.bundleFor(k); return c && c.total === b.total && c.hostesses === b.hostesses && JSON.stringify(c.guests) === JSON.stringify(b.guests) && (c.until || '') === (b.until || ''); }), 'paylink BUNDLES == config BUNDLES');

/* ── Part B ── */
async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { /* fall through */ }
  const base = join(homedir(), '.npm/_npx');
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) { const p = join(base, d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) { try { return await import(pathToFileURL(p)); } catch (e) { /* next */ } } }
  return null;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
if (!process.argv.includes('--no-browser')) {
  const pw = await loadPlaywright();
  if (!pw) console.log('B  skipped: Playwright not importable');
  else {
    const srv = createServer((req, res) => {
      const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
      if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
    }).listen(0);
    const port = srv.address().port;
    /* bundled chromium first, else the installed Google Chrome (headless) */
    const browser = await pw.chromium.launch().catch(() => pw.chromium.launch({ channel: 'chrome', headless: true }));
    const errors = [];
    const open = async (qs) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.on('pageerror', e => errors.push(String(e.message)));
      const posts = [];
      /* everything off-origin is stubbed: nothing real is called */
      await page.route(u => !String(u).startsWith(`http://localhost:${port}/`), async route => {
        const u = route.request().url();
        if (/quote-from-site/.test(u)) { posts.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: `http://localhost:${port}/thanks.html?stub=1`, sum: 458 }) }); }
        if (/hostess-check/.test(u)) { posts.push({ hostess: JSON.parse(route.request().postData() || '{}') }); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, travel: 0, total: 1990, url: '' }) }); }
        if (/\/api\/|\/promo/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return route.fulfill({ status: 204, body: '' });
      });
      await page.goto(`http://localhost:${port}/` + qs, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#order-modal.open', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      return { page, posts };
    };
    try {
      console.log('B1 ?plan= prefill (no hostesses, design)');
      const { page, posts } = await open('?plan=pro&guests=300&hostess=0&design=1&calls=1&occasion=wedding&date=2027-03-15&name=%D7%93%D7%A0%D7%94%20%D7%9B%D7%94%D7%9F&phone=0501234567&src=noa');
      ok(await page.$eval('#order-modal', el => el.classList.contains('open')), 'popup opens');
      ok(await page.$eval('#f-name', el => el.value) === 'דנה כהן' && await page.$eval('#f-phone', el => el.value) === '0501234567', 'name + phone filled');
      ok(await page.$eval('#f-name', el => !el.readOnly && !el.disabled), 'name editable');
      await page.$eval('#pop-next', el => el.click()); await page.waitForTimeout(500);
      ok(await page.$eval('#ws2', el => el.classList.contains('active')), 'step 2 reached');
      ok(await page.$eval('#f-occasion', el => el.value) === 'wedding', 'occasion filled');
      ok(await page.$eval('#f-guests', el => el.value) === '300', 'records 300 filled');
      ok(!(await page.$('#f-guests-fixed:not([hidden])')), 'records not locked');
      const tot = await page.$eval('#pop-total', el => el.textContent.replace(/\s+/g, ' '));
      ok(/₪458/.test(tot), 'total = פרמיום 300 (379) + design (79) from the tables', tot);
      await page.$eval('#f-plans .plan-opt[data-plan="basic"]', el => el.click()); await page.waitForTimeout(100);
      ok(/₪378/.test(await page.$eval('#pop-total', el => el.textContent)), 'plan changeable: בסיס 299 + 79 = ₪378');
      await page.$eval('#f-plans .plan-opt[data-plan="pro"]', el => el.click());
      await page.$eval('#pop-next2', el => el.click()).catch(() => {}); await page.waitForTimeout(300);
      ok(await page.$eval('#f-design-row', el => !el.hidden && el.offsetParent !== null), 'design row visible');
      await page.$eval('#f-design-no', el => el.click()); await page.waitForTimeout(100);
      ok(/₪379/.test(await page.$eval('#pop-total', el => el.textContent)), 'design off → ₪379');
      await page.$eval('#f-design-yes', el => el.click()); await page.waitForTimeout(100);
      ok(/₪458/.test(await page.$eval('#pop-total', el => el.textContent)), 'design back on → ₪458');
      await page.$eval('#f-terms', el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }).catch(() => {});
      await Promise.all([page.waitForURL(/thanks\.html\?stub=1/, { timeout: 5000 }).catch(() => {}), page.$eval('#pop-submit', el => el.click()).catch(() => {})]);
      const q = posts.find(p => p.plan);
      ok(!!q && q.plan === 'pro' && q.records === 300 && q.design === true && q.hostesses === 0 && q.src === 'noa' && q.event_date === '2027-03-15', 'design order posts /api/quote-from-site with the structured choice', JSON.stringify(q || {}).slice(0, 160));
      ok(/thanks\.html\?stub=1/.test(page.url()), 'follows the server url (Grow link)', page.url());
      await page.close();

      console.log('B2 ?offer=winter1990 with design (the sales-flow bundle link)');
      const b = await open('?offer=winter1990&guests=700&hostess=2&design=1&occasion=wedding&date=2027-03-15&city=%D7%97%D7%99%D7%A4%D7%94&name=%D7%93%D7%A0%D7%94&phone=0501234567&src=noa');
      ok(await b.page.$eval('#order-modal', el => el.classList.contains('open')), 'popup opens');
      await b.page.$eval('#pop-next', el => el.click()).catch(() => {}); await b.page.waitForTimeout(600);
      const t2 = await b.page.$eval('#pop-total', el => el.textContent.replace(/\s+/g, ' '));
      ok(/₪1,?990/.test(t2) && /עיצוב ההזמנה במתנה/.test(t2), 'bundle total ₪1,990, design free', t2.slice(0, 160));
      const hc = b.posts.find(p => p.hostess);
      ok(!!hc && hc.hostess.design === true && hc.hostess.offer === 'winter1990', 'hostess-check carries design + offer', JSON.stringify(hc || {}).slice(0, 160));
      await b.page.close();
      ok(!errors.length, 'no page errors', errors.slice(0, 3).join(' | '));
    } finally { await browser.close(); srv.close(); }
  }
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
