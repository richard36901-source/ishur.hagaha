#!/usr/bin/env node
/* Store screenshots at the 6.9" iPhone size (1320x2868), taken from the same screens the app shows, signed in as the
   second staging demo client. Needs the same STAGING_SECRETS and PLAYWRIGHT_PATH as test/app-check.mjs.
   Output: store/screenshots/ios-6.9/*.png */
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), WWW = path.join(HERE, '..', 'www'), OUT = path.join(HERE, '..', 'store', 'screenshots', 'ios-6.9');
const BASE = 'https://go-staging.ishur.io', PHONE = '0500000102', TOKEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const key = fs.readFileSync(process.env.STAGING_SECRETS || path.join(HERE, '..', '..', 'worker', '.staging.secrets'), 'utf8').match(/^ADMIN_KEY=(.+)$/m)[1].trim();
const api = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json().catch(() => ({}));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => { const f = path.normalize(path.join(WWW, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')))); if (!f.startsWith(WWW) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
await new Promise(r => server.listen(4180, '127.0.0.1', r));
let code = 1;
try {
  if ((await fetch(BASE + '/api/health').then(r => r.json())).staging !== true) throw new Error('not staging');
  await api('/api/staging-seed', { admin_key: key, del_prefixes: ['rl:acctpin', 'acctpinlock:'] });
  const PIN = (await api('/api/client-pin', { admin_key: key, token: TOKEN })).pin;
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, locale: 'he-IL' })).newPage();
  const shot = n => p.screenshot({ path: path.join(OUT, n + '.png') });
  await p.goto('http://localhost:4180/'); await p.waitForSelector('#signin:not([hidden])');
  await p.fill('#phone', PHONE); await p.fill('#code', PIN); await p.click('#go');
  await p.waitForSelector('#tabs:not([hidden])', { timeout: 60000 });
  await p.frameLocator('#boardFrame').locator('#rows .pill').nth(5).waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.frameLocator('#boardFrame').getByText('דלגו על הכל').click({ timeout: 5000 }).catch(() => {});
  /* the notification sheet, if the page shows it in a browser */
  await p.getByText('לא עכשיו').click({ timeout: 1500 }).catch(() => {});
  const f = p.frames().find(x => /dashboard/.test(x.url())); if (f) await f.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(800); await shot('1-home');
  for (const [i, t] of [[2, 'guests'], [3, 'sends']]) { await p.click(`[data-tab=${t}]`); await p.waitForTimeout(1200); await shot(`${i}-${t}`); }
  await b.close(); code = 0;
} catch (e) { console.error(String(e)); } finally { server.close(); }
process.exit(code);
