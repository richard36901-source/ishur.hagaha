/* Design-pass screenshots: every section + tab, light / dark / 375 px, into docs/ops-screens/design/.
   Also prints console errors and horizontal overflow per screen (exit 1 if any). Usage: node scripts/ops-design-shots.mjs */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), OUT = join(ROOT, 'docs/ops-screens/design');
mkdirSync(OUT, { recursive: true });
async function pwLoad() {
  try { return await import('playwright'); } catch (e) { /* npx cache */ }
  const base = join(homedir(), '.npm/_npx');
  for (const d of existsSync(base) ? readdirSync(base) : []) { const p = join(base, d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) return import(pathToFileURL(p)); }
  return null;
}
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const srv = createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = join(ROOT, u === '/' ? 'ops.html' : u); if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': T[extname(f)] || 'application/octet-stream' }); r.end(readFileSync(f)); });
await new Promise((ok) => srv.listen(0, ok));
const url = `http://127.0.0.1:${srv.address().port}/ops.html?mock=1`;
const SCREENS = [
  ['overview', '#/overview'], ['leads', '#/leads'], ['leads-modal', '#/leads/L972500009001'], ['clients', '#/clients'], ['client-card', '#/clients', 'card'], ['clients-hostesses', '#/clients?tab=hostesses'], ['clients-feedback', '#/clients?tab=feedback'],
  ['messages-inbox', '#/messages'], ['messages-sends', '#/messages?tab=sends'], ['messages-capacity', '#/messages?tab=capacity'], ['messages-templates', '#/messages?tab=templates'],
  ['calls', '#/calls'], ['calls-manual', '#/calls?tab=manual'], ['calls-shir', '#/calls?tab=shir'], ['calendar', '#/calendar'], ['calendar-capacity', '#/calendar?tab=capacity'],
  ['finance', '#/finance'], ['finance-ads', '#/finance?tab=ads'], ['finance-balances', '#/finance?tab=balances'],
  ['system-automations', '#/system'], ['system-runs', '#/system?tab=runs'], ['system-live', '#/system?tab=live'], ['system-brain', '#/system?tab=brain'], ['system-changes', '#/system?tab=changes'], ['system-control', '#/system?tab=control'], ['system-notify', '#/system?tab=notify'],
];
const pw = await pwLoad(); if (!pw) { console.log('Playwright not importable'); process.exit(2); }
const browser = await pw.chromium.launch().catch(() => pw.chromium.launch({ channel: 'chrome' }));
let bad = 0;
for (const [mode, vp] of [['light', { width: 1440, height: 900 }], ['dark', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 812 }]]) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: mode === 'dark' ? 'dark' : 'light', locale: 'he-IL', timezoneId: 'Asia/Jerusalem', isMobile: mode === 'mobile', hasTouch: mode === 'mobile' });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(url + '#/overview'); await page.waitForTimeout(1200);
  for (const [name, hash, extra] of SCREENS) {
    errs.length = 0;
    await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1500);
    if (extra === 'card') { await page.click('#main tr[data-row]').catch(() => {}); await page.waitForTimeout(900); }
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector('#main').scrollWidth > document.querySelector('#main').clientWidth + 1);
    await page.screenshot({ path: join(OUT, `${name}-${mode}.png`) });
    if (errs.length || over) { bad++; console.log(`✗ ${name} ${mode}${over ? ' · horizontal overflow' : ''}${errs.length ? ' · ' + errs.slice(0, 2).join(' | ') : ''}`); } else console.log(`✓ ${name} ${mode}`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  }
  await ctx.close();
}
await browser.close(); srv.close();
console.log(bad ? bad + ' screens with problems' : 'all screens clean'); process.exit(bad ? 1 : 0);
