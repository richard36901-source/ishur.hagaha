#!/usr/bin/env node
/* round 7 pass conditions A1–A3, A5 (.sdlc/client-app/round7-languages.md). For each language: sign in to the app on
   staging, walk the four tabs and the events page, then open each board page with ?lang=. The app's own screens use
   app/www/i18n.js; the board pages use the site's overlay (assets/i18n.js, another session). Report every visible text
   that is still a Hebrew UI text, the page direction, and pages wider than the screen.
   LANGS=en,ru node app/scripts/i18n-check.mjs   (default: every language file present)   exit 0 = all pass
   Needs STAGING_SECRETS and PLAYWRIGHT_PATH, like test/app-check.mjs. Serves app/www on localhost:4180. */
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/* the collector also picked up pieces of code that hold Hebrew; they never show on screen, so they are not required */
const CODE = /[$;{}=<>]|\+ ?'|' ?\+|\(|\)|\|\|/;
const KEYS = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'keys.json'), 'utf8')).filter(k => !CODE.test(k)));
const RTL = { he: 1, ar: 1, yi: 1 };
const DICT_DIR = path.join(ROOT, 'app', 'www', 'i18n');
const all = fs.readdirSync(DICT_DIR).filter(f => /^[a-z]{2}\.json$/.test(f)).map(f => f.slice(0, 2));
const LANGS = (process.env.LANGS || all.join(',')).split(',').filter(Boolean);
const dicts = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(DICT_DIR, l + '.json'), 'utf8'))]));
/* the two copies of the layer differ only in their header comment */
const body = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\/\*[\s\S]*?\*\/\n/, '');
if (body('app/www/i18n.js') !== body('assets/i18n-pages.js')) { console.log('FAIL app/www/i18n.js and assets/i18n-pages.js differ'); process.exit(1); }
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const key = fs.readFileSync(process.env.STAGING_SECRETS, 'utf8').match(/^ADMIN_KEY=(.+)$/m)[1].trim();
const BASE = 'https://go-staging.ishur.io', SITE = 'https://staging.ishur.io', PHONE = '0500000102', TOK = 'bbbbbbbb-0000-4000-8000-000000000002';
const api = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const WWW = path.join(ROOT, 'app', 'www');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.html': 'text/html; charset=utf-8' };
const server = http.createServer((q, r) => { const f = path.normalize(path.join(WWW, decodeURIComponent(new URL(q.url, 'http://x').pathname.replace(/\/$/, '/index.html')))); if (!f.startsWith(WWW) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(fs.readFileSync(f)); });
await new Promise(r => server.listen(4180, '127.0.0.1', r));

/* the visible texts that are still a Hebrew UI key (for yi: a key whose Yiddish differs) */
/* client data (names, venue, the invitation wording) stays in Hebrew on purpose: read it from the event and skip it */
let DATA = [];
const isData = t => DATA.some(d => d && t.includes(d));
const leftovers = async (frame, lang) => (await frame.evaluate(() => {
  const o = [], vis = el => !!(el && (el.offsetParent || el.getClientRects().length));
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const p = w.currentNode.parentElement; if (!p || /^(SCRIPT|STYLE)$/.test(p.tagName) || !vis(p) || p.closest('[data-noi18n]')) continue; o.push(w.currentNode.nodeValue); }
  document.querySelectorAll('[placeholder]').forEach(el => vis(el) && o.push(el.getAttribute('placeholder')));
  return o;
}).catch(() => [])).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => KEYS.has(s) && !isData(s) && !(lang === 'yi' && dicts.yi[s] === s));
const layout = frame => frame.evaluate(() => ({ dir: document.documentElement.getAttribute('dir'), wide: document.documentElement.scrollWidth > innerWidth + 1 })).catch(() => ({ dir: '?', wide: false }));

const report = {}; let fail = 0;
const b = await chromium.launch({ channel: 'chrome' });
try {
  await api('/api/staging-seed', { admin_key: key, del_prefixes: ['rl:acctpin', 'acctpinlock:'] });
  const pin = (await api('/api/client-pin', { admin_key: key, token: TOK })).pin;
  const sess = (await api('/api/account/pin-login', { phone: PHONE, pin })).session;
  const st = await api('/api/status', { token: TOK, board_session: sess, app: 1 });
  const ev = st.event || {};
  DATA = [ev.name1, ev.name2, ev.venue_name, ev.venue_city, ...(st.guests || []).map(g => g.name), ...(st.guests || []).map(g => g.table)].filter(x => x && String(x).length > 1).map(String);
  if (st.custom_template && st.custom_template.text) DATA.push(String(st.custom_template.text).slice(0, 30));
  DATA.push('שלום {שם האורח}');
  for (const lang of LANGS) {
    const r = report[lang] = { left: {}, dir: {}, wide: [], persisted: null };
    const note = (where, list, lay) => { if (list.length) r.left[where] = [...new Set(list)]; r.dir[where] = lay.dir; if (lay.wide) r.wide.push(where); };
    /* A5: the dictionary covers every key */
    const missing = [...KEYS].filter(k => !(k in dicts[lang]) || !String(dicts[lang][k]).trim());
    if (missing.length) r.missing = missing.length;
    /* the app: choose the language with the picker, as a client does */
    const ctx = await b.newContext({ viewport: { width: 400, height: 860 }, locale: 'he-IL' });
    const p = await ctx.newPage();
    await p.goto('http://localhost:4180/'); await p.waitForSelector('#signin:not([hidden])');
    await p.fill('#phone', PHONE); await p.fill('#code', pin); await p.click('#go');
    await p.waitForSelector('#tabs:not([hidden])', { timeout: 60000 });
    await p.click('[data-tab=account]'); await p.selectOption('#langPick', lang);
    await p.waitForTimeout(1500); await p.waitForSelector('#tabs:not([hidden])', { timeout: 60000 });
    r.persisted = await p.evaluate(() => window.IshurI18n && IshurI18n.lang);
    for (const t of ['board', 'guests', 'sends', 'account']) {
      await p.click(`[data-tab=${t}]`); await p.waitForTimeout(t === 'board' ? 9000 : 3500);
      note('app:' + t, await leftovers(p, lang), await layout(p));
      const f = p.frames().find(x => /dashboard/.test(x.url()));
      if (f && t !== 'account') { r.frameLang = /[?&]lang=([a-z]{2})/.exec(f.url())?.[1]; note('board:' + t, await leftovers(f, lang), await layout(f)); }
    }
    await p.click('#eventsOpen'); await p.waitForTimeout(800); note('app:events', await leftovers(p, lang), await layout(p)); await p.click('#eventsClose');
    await p.screenshot({ path: path.join(ROOT, 'app', 'test', 'shots', `lang-${lang}-account.png`) });
    await ctx.close();
    /* the board pages, opened the way the app opens them */
    for (const u of [`upload.html?t=${TOK}&step=2`, `schedule.html?t=${TOK}`, `budget.html?v=1&t=${TOK}`, `seating.html?v=5&t=${TOK}`, `checklist.html?t=${TOK}`]) {
      const c2 = await b.newContext({ viewport: { width: 400, height: 860 } }); const q = await c2.newPage();
      await q.addInitScript(s => { try { localStorage.setItem('ishur_acct_session', s); sessionStorage.setItem('ishur_in_app', '1'); } catch (e) {} }, sess);
      await q.goto(`${SITE}/${u}&app=1&lang=${lang}`, { waitUntil: 'load' }).catch(() => {}); await q.waitForTimeout(6000);
      note(u.split('?')[0], await leftovers(q, lang), await layout(q));
      await c2.close();
    }
    const want = RTL[lang] ? 'rtl' : 'ltr';
    const badDir = Object.entries(r.dir).filter(([w, d]) => d !== want).map(([w]) => w);
    const nLeft = Object.values(r.left).reduce((a, x) => a + x.length, 0);
    const ok = !r.missing && !nLeft && !badDir.length && !r.wide.length && r.persisted === lang && r.frameLang === lang;
    if (!ok) fail++;
    /* saved after each language, so a cut-off run still leaves what it found */
    const RP = path.join(ROOT, 'i18n', 'check-report.json'); let prev = {}; try { prev = JSON.parse(fs.readFileSync(RP, 'utf8')); } catch {}
    prev[lang] = { ...r, ok, at: new Date().toISOString() }; fs.writeFileSync(RP, JSON.stringify(prev, null, 1));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${lang}: untranslated ${nLeft}, wrong direction ${badDir.length ? badDir.join(' ') : 0}, too wide ${r.wide.length ? r.wide.join(' ') : 0}, kept ${r.persisted}, board ${r.frameLang}${r.missing ? ', dictionary missing ' + r.missing : ''}`);
  }
} finally { await b.close(); server.close(); }
console.log(`${LANGS.length - fail}/${LANGS.length} languages pass`);
process.exit(fail ? 1 : 0);
