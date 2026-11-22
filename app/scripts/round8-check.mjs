#!/usr/bin/env node
/* round 8 (22/11, Richard: "like Apple, WhatsApp, Instagram"): the app's own frame. Signs in to staging with the demo
   client, then checks each piece. Exit 0 = all pass. Pictures in app/test/shots/r8-*.png.
   STAGING_SECRETS=… PLAYWRIGHT_PATH=… node app/scripts/round8-check.mjs */
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), WWW = path.join(ROOT, 'app', 'www'), SHOTS = path.join(ROOT, 'app', 'test', 'shots');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.html': 'text/html; charset=utf-8' };
const server = http.createServer((q, r) => { const f = path.normalize(path.join(WWW, decodeURIComponent(new URL(q.url, 'http://x').pathname.replace(/\/$/, '/index.html')))); if (!f.startsWith(WWW) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(fs.readFileSync(f)); });
await new Promise(r => server.listen(4180, '127.0.0.1', r));
const key = fs.readFileSync(process.env.STAGING_SECRETS, 'utf8').match(/^ADMIN_KEY=(.+)$/m)[1].trim();
const BASE = 'https://go-staging.ishur.io', PHONE = '0500000102', TOK = 'bbbbbbbb-0000-4000-8000-000000000002';
const api = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const res = []; const ok = (n, c, i = '') => { res.push(!!c); console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${i !== '' ? ' · ' + i : ''}`); };
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const b = await chromium.launch({ channel: 'chrome' });
const errors = [];
/* one finger drag through Chrome's touch input (the way a phone sends it) */
async function drag(p, x0, y0, x1, y1) {
  const cdp = await p.context().newCDPSession(p);
  const pt = (x, y) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
try {
  await api('/api/staging-seed', { admin_key: key, del_prefixes: ['rl:acctpin', 'acctpinlock:'] });
  const pin = (await api('/api/client-pin', { admin_key: key, token: TOK })).pin;
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'he-IL', colorScheme: 'light' });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(String(e)));
  await p.goto('http://localhost:4180/');
  /* R1 opening screen */
  ok('opening screen: logo and "אישורי הגעה לאירועים"', await p.locator('#splash img').isVisible() && (await p.locator('#splash .sp-t').textContent()) === 'אישורי הגעה לאירועים');
  ok('opening screen: WhatsApp 055-9504499 and info@ishur.io', /055-9504499/.test(await p.locator('#splash .sp-c').textContent()) && /info@ishur\.io/.test(await p.locator('#splash .sp-c').textContent()));
  await p.screenshot({ path: path.join(SHOTS, 'r8-splash.png') });
  await p.waitForSelector('#signin:not([hidden])'); await p.waitForTimeout(1200);
  ok('opening screen goes away', await p.locator('#splash').evaluate(e => e.hidden || getComputedStyle(e).opacity === '0'));
  /* R8 keyboard: typing in the phone field, a drag down hides the keyboard */
  await p.locator('#phone').focus(); const box = await p.locator('#signinForm h1').boundingBox();
  await drag(p, box.x + 40, box.y + 5, box.x + 40, box.y + 120);
  ok('drag down while typing hides the keyboard', await p.evaluate(() => document.activeElement.id !== 'phone'), await p.evaluate(() => document.activeElement.id || document.activeElement.tagName));
  /* code as four boxes (Richard 22/11) */
  ok('code: four boxes', (await p.locator('#otp .otp-box').count()) === 4);
  await p.locator('#code').focus(); await p.keyboard.type('12');
  ok('code: two digits typed show in the first two boxes, the third is next', JSON.stringify(await p.locator('#otp .otp-box').allTextContents()) === '["1","2","",""]' && await p.locator('#otp .otp-box').nth(2).evaluate(e => e.classList.contains('on')));
  await p.locator('#code').fill(''); await p.evaluate(() => { const f = document.getElementById('code'); f.value = 'a9-8 7 6'; f.dispatchEvent(new Event('input')); });
  ok('code: a pasted code fills all four, letters and spaces dropped', JSON.stringify(await p.locator('#otp .otp-box').allTextContents()) === '["9","8","7","6"]');
  await p.screenshot({ path: path.join(SHOTS, 'r8-code-boxes.png') });
  await p.locator('#code').fill('');
  /* sign in */
  await p.fill('#phone', PHONE); await p.fill('#code', pin); await p.click('#go');
  await p.waitForSelector('#tabs:not([hidden])', { timeout: 30000 }).catch(async () => { console.log('     sign-in note: ' + await p.locator('#signinNote').textContent() + ' · pin ' + (pin ? 'ok' : 'missing')); throw new Error('sign-in failed'); });
  /* R6 skeleton while the board loads */
  ok('loading shows the board\'s shape, not a line of text', (await p.locator('#boardWait .sk').count()) >= 10);
  /* R2 top bar */
  ok('top bar: the logo is there', await p.locator('#nav .navlogo').isVisible());
  await p.waitForTimeout(800);
  const evName = await p.locator('#navTitle').textContent();
  ok('top bar on ראשי: the brand, so a screenshot carries it (or the event switcher)', evName.trim() === 'אישורי הגעה לאירועים - ishur.io' || await p.locator('#evSwitch').isVisible(), evName);
  await p.click('[data-tab=guests]'); await p.waitForTimeout(500);
  ok('top bar on מוזמנים: "מוזמנים"', (await p.locator('#navTitle').textContent()) === 'מוזמנים' && !(await p.locator('#navTitle').evaluate(e => e.classList.contains('hide'))));
  /* R5 tab bar: the selected icon is filled, the others are not */
  const fills = await p.evaluate(() => [...document.querySelectorAll('#tabs button')].map(b => [b.getAttribute('data-tab'), getComputedStyle(b.querySelector('svg')).fill]));
  const on = fills.find(f => f[0] === 'guests')[1], off = fills.find(f => f[0] === 'account')[1];
  ok('tab bar: the selected icon is filled, the others outlined', on !== 'none' && off === 'none', JSON.stringify(fills));
  /* account: big title, then the small one after scrolling */
  await p.click('[data-tab=account]'); await p.waitForTimeout(500);
  ok('חשבון: the big title shows, the small one is hidden', await p.locator('#v-account h1.large').isVisible() && await p.locator('#navTitle').evaluate(e => e.classList.contains('hide')));
  await p.screenshot({ path: path.join(SHOTS, 'r8-account-top.png') });
  await p.evaluate(() => window.scrollTo(0, 400)); await p.waitForTimeout(500);
  ok('חשבון: after scrolling, "חשבון" sits in the bar', !(await p.locator('#navTitle').evaluate(e => e.classList.contains('hide'))) && (await p.locator('#navTitle').textContent()) === 'חשבון');
  /* R4 contact us */
  ok('צרו קשר: WhatsApp 055-9504499', await p.locator('#contactWa').isVisible() && /055-9504499/.test(await p.locator('#contactWa').textContent()));
  ok('צרו קשר: email opens mail to info@ishur.io', (await p.locator('#contactMail').getAttribute('href')) === 'mailto:info@ishur.io');
  await p.locator('#contactCard').scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(SHOTS, 'r8-account-contact.png') });
  /* R3 appearance */
  ok('appearance: "כמו בטלפון" chosen at first', (await p.locator('#appearance [data-a=auto]').getAttribute('aria-checked')) === 'true');
  await p.click('#appearance [data-a=dark]'); await p.waitForTimeout(300);
  ok('appearance: "כהה" turns the app dark', (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark' && (await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== 'rgb(250, 248, 241)');
  await p.screenshot({ path: path.join(SHOTS, 'r8-account-dark.png') });
  await p.reload(); await p.waitForSelector('#tabs:not([hidden])', { timeout: 60000 });
  ok('appearance: kept after the app is opened again (before any paint)', (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');
  await p.click('[data-tab=board]'); await p.waitForTimeout(1500);
  ok('appearance: the board inside the app gets it', /[?&]theme=dark/.test(await p.locator('#boardFrame').getAttribute('src')));
  await p.click('[data-tab=account]'); await p.click('#appearance [data-a=light]'); await p.waitForTimeout(300);
  ok('appearance: "בהיר" back to light', (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light');
  /* R7 swipe back on help: from the right edge (Hebrew) to the left */
  await p.click('#helpOpen'); await p.waitForSelector('#help:not([hidden])');
  await drag(p, 386, 400, 90, 410); await p.waitForTimeout(500);
  ok('swipe from the edge closes help', await p.locator('#help').isHidden());
  await p.click('#helpOpen'); await drag(p, 200, 400, 360, 410); await p.waitForTimeout(500);
  ok('a swipe that does not start at the edge does nothing', await p.locator('#help').isVisible());
  await p.click('#helpClose');
  ok('no script errors', !errors.length, errors.join(' | '));
  await ctx.close();
} finally { await b.close(); server.close(); }
const f = res.filter(x => !x).length; console.log(`${res.length - f}/${res.length} passed`); process.exit(f ? 1 : 0);
