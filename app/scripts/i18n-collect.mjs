#!/usr/bin/env node
/* Collects every Hebrew text the client sees: from the source (string literals and HTML text) and from the live
   staging pages (every text node and placeholder/title/aria-label, hidden ones too). Writes i18n/strings.json:
   { "<Hebrew text>": { n: <times seen>, where: [files/pages] } }. Run after changing screens, then fill the gaps:
   node app/scripts/i18n-collect.mjs  (needs PLAYWRIGHT_PATH and STAGING_SECRETS, like test/app-check.mjs) */
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HE = /[֐-׿]/;
const norm = s => String(s).replace(/\s+/g, ' ').trim();
const out = {};
const add = (s, where) => { s = norm(s); if (!HE.test(s) || s.length > 400) return; const e = out[s] || (out[s] = { n: 0, where: [] }); e.n++; if (!e.where.includes(where)) e.where.push(where); };
const FILES = ['app/www/index.html', 'app/www/app.js', 'app/www/help.js', 'app/www/push.js', 'dashboard.html', 'upload.html', 'schedule.html', 'budget.html', 'seating.html', 'checklist.html', 'table.html', 'feedback.html', 'assets/ux.js', 'assets/design-card.js', 'assets/pwa.js'];
for (const f of FILES) {
  const p = path.join(ROOT, f); if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) { const s = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1'); if (HE.test(s) && !/[<>{}]/.test(s)) add(s, f); }
  for (const m of src.matchAll(/>([^<>]*[֐-׿][^<>]*)</g)) add(m[1], f);
}
const { chromium } = await import(process.env.PLAYWRIGHT_PATH);
const key = fs.readFileSync(process.env.STAGING_SECRETS, 'utf8').match(/^ADMIN_KEY=(.+)$/m)[1].trim();
const BASE = 'https://go-staging.ishur.io', SITE = 'https://staging.ishur.io';
const api = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const WWW = path.join(ROOT, 'app', 'www');
const server = http.createServer((q, r) => { const f = path.normalize(path.join(WWW, decodeURIComponent(new URL(q.url, 'http://x').pathname.replace(/\/$/, '/index.html')))); if (!f.startsWith(WWW) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }); r.end(fs.readFileSync(f)); });
await new Promise(r => server.listen(4180, '127.0.0.1', r));
const grab = async (frame, where) => {
  const list = await frame.evaluate(() => {
    const o = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const p = w.currentNode.parentElement; if (p && /^(SCRIPT|STYLE)$/.test(p.tagName)) continue; o.push(w.currentNode.nodeValue); }
    document.querySelectorAll('[placeholder],[title],[aria-label],input[type=button],input[type=submit]').forEach(el => ['placeholder', 'title', 'aria-label', 'value'].forEach(a => el.getAttribute(a) && o.push(el.getAttribute(a))));
    o.push(document.title); return o;
  }).catch(() => []);
  list.forEach(s => add(s, where));
};
const b = await chromium.launch({ channel: 'chrome' });
try {
  await api('/api/staging-seed', { admin_key: key, del_prefixes: ['rl:acctpin', 'acctpinlock:'] });
  for (const [phone, tok] of [['0500000101', 'aaaaaaaa-0000-4000-8000-000000000001'], ['0500000102', 'bbbbbbbb-0000-4000-8000-000000000002']]) {
    const pin = (await api('/api/client-pin', { admin_key: key, token: tok })).pin;
    const p = await (await b.newContext({ viewport: { width: 400, height: 860 }, locale: 'he-IL' })).newPage();
    await p.goto('http://localhost:4180/'); await grab(p, 'app');
    await p.fill('#phone', phone); await p.fill('#code', pin); await p.click('#go');
    await p.waitForSelector('#tabs:not([hidden])', { timeout: 60000 });
    await p.frameLocator('#boardFrame').locator('#kpis .kpi').nth(5).waitFor({ timeout: 60000 }).catch(() => {});
    for (const t of ['board', 'guests', 'sends', 'account']) { await p.click(`[data-tab=${t}]`); await p.waitForTimeout(2500); await grab(p, 'app'); const f = p.frames().find(x => /dashboard/.test(x.url())); if (f) await grab(f, 'dashboard'); }
    const sess = (await api('/api/account/pin-login', { phone, pin })).session;
    for (const u of [`dashboard.html?t=${tok}`, `upload.html?t=${tok}&step=2`, `upload.html?t=${tok}`, `schedule.html?t=${tok}`, `budget.html?v=1&t=${tok}`, `seating.html?v=5&t=${tok}`, `checklist.html?t=${tok}`, `table.html?qr=1&t=${tok}`, `feedback.html?t=${tok}`]) {
      const q = await (await b.newContext({ viewport: { width: 400, height: 860 }, locale: 'he-IL' })).newPage();
      await q.addInitScript(s => { try { localStorage.setItem('ishur_acct_session', s); sessionStorage.setItem('ishur_in_app', '1'); } catch (e) {} }, sess);
      await q.goto(`${SITE}/${u}`, { waitUntil: 'load' }).catch(() => {}); await q.waitForTimeout(5000);
      await grab(q, u.split('?')[0]); await q.context().close();
    }
  }
} finally { await b.close(); server.close(); }
fs.mkdirSync(path.join(ROOT, 'i18n'), { recursive: true });
const sorted = Object.fromEntries(Object.entries(out).sort((a, b) => b[1].n - a[1].n));
fs.writeFileSync(path.join(ROOT, 'i18n', 'strings.json'), JSON.stringify(sorted, null, 1));
console.log(Object.keys(sorted).length, 'strings;', Object.values(sorted).filter(e => e.where.some(w => !/\.(html|js)$/.test(w) || w === 'app')).length, 'seen live');
