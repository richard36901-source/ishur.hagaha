/* 16/11: the pay-link form's dropdowns in a REAL browser (the node smoke renders strings only and missed that a
   dropdown closed the instant it opened). Opens each dropdown, checks the list stays open, picks an option and
   checks the value changed; then an outside click closes an open list.
   Usage: node scripts/paylink-dropdown-check.mjs [--ref <git ref>]   (--ref runs the same checks on an older file) */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : '';
const src = (f) => (ref ? execFileSync('git', ['show', ref + ':' + f], { cwd: ROOT, encoding: 'utf8' }) : readFileSync(join(ROOT, f), 'utf8'));
async function pw() {
  try { return await import('playwright'); } catch (e) { /* next */ }
  for (const p of [join(homedir(), '.ship-studio/playwright-env/node_modules/playwright/index.mjs')]) if (existsSync(p)) return import(pathToFileURL(p));
  const base = join(homedir(), '.npm/_npx');
  if (existsSync(base)) for (const d of readdirSync(base)) { const p = join(base, d, 'node_modules/playwright/index.mjs'); if (existsSync(p)) return import(pathToFileURL(p)); }
  throw new Error('playwright not found');
}
let fails = 0; const ok = (c, n) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) fails++; };
const { chromium } = await pw();
let browser; try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }
const page = await browser.newPage();
await page.setContent('<!doctype html><html lang="he" dir="rtl"><body><p id="out">outside</p><div id="h"></div></body></html>');
await page.addScriptTag({ content: src('config.js') });
await page.addScriptTag({ content: src('assets/paylink-gen.js') });
await page.evaluate(() => window.IshurPayLinkGen.mount('h', 'k'));
for (const id of ['occasion', 'plan', 'records', 'hostesses']) {
  const btn = page.locator(`[data-dd="${id}"]`);
  if (!(await btn.count())) { ok(false, id + ': dropdown exists'); continue; }
  const before = (await btn.innerText()).trim();
  await btn.click();
  await page.waitForTimeout(150);
  const n = await page.locator(`[data-set="${id}"]`).count();
  ok(n > 1, `${id}: the list stays open after the click (${n} options)`);
  if (n > 1) {
    const opt = page.locator(`[data-set="${id}"]:not([disabled]):not([aria-selected="true"])`).first();
    const want = (await opt.innerText()).trim();
    await opt.click(); await page.waitForTimeout(100);
    const after = (await page.locator(`[data-dd="${id}"]`).innerText()).trim();
    ok(after === want && after !== before, `${id}: picking "${want}" changes the value (was "${before}", now "${after}")`);
  }
}
await page.locator('[data-dd="records"]').click(); await page.waitForTimeout(100);
await page.locator('#out').click(); await page.waitForTimeout(100);
ok((await page.locator('[data-set="records"]').count()) === 0, 'a click outside the form closes an open list');
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
