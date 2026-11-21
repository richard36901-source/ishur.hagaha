#!/usr/bin/env node
/* round 7 follow-up: the help centre (app/www/help.js) in every language. For each language: open the app with
   ?lang=, open the help, then every topic and every step. Fails on:
   H1 Hebrew left on a help screen (any Hebrew letter; for Yiddish, a known Hebrew UI text the dictionary changes),
   H2 a piece of the moving picture that sticks out of its box or cuts its own text,
   H3 the wrong page direction.
   Also saves one picture per language (app/test/shots/help-<lang>.png) for a look by eye.
   LANGS=en,ru node app/scripts/help-check.mjs   exit 0 = all pass.  Needs PLAYWRIGHT_PATH. No staging, no sign-in. */
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WWW = path.join(ROOT, 'app', 'www'), DICT_DIR = path.join(WWW, 'i18n');
const all = fs.readdirSync(DICT_DIR).filter(f => /^[a-z]{2}\.json$/.test(f)).map(f => f.slice(0, 2));
const LANGS = (process.env.LANGS || ['he', ...all].join(',')).split(',').filter(Boolean);
const RTL = { he: 1, ar: 1, yi: 1 };
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8' };
const server = http.createServer((q, r) => { const f = path.normalize(path.join(WWW, decodeURIComponent(new URL(q.url, 'http://x').pathname.replace(/\/$/, '/index.html')))); if (!f.startsWith(WWW) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(fs.readFileSync(f)); });
await new Promise(r => server.listen(4181, '127.0.0.1', r));

/* everything visible inside the help dialog, and every scene piece that does not fit */
const probe = () => {
  const help = document.getElementById('help'), vis = el => !!(el && (el.offsetParent || el.getClientRects().length));
  const texts = [], w = document.createTreeWalker(help, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const p = w.currentNode.parentElement; if (p && vis(p) && w.currentNode.nodeValue.trim()) texts.push(w.currentNode.nodeValue.replace(/\s+/g, ' ').trim()); }
  const sc = document.getElementById('helpScene'), box = sc.getBoundingClientRect(), bad = [];
  if (vis(sc)) sc.querySelectorAll('*').forEach(el => {
    if (/sc-finger/.test(el.className)) return;                       /* the finger moves on purpose */
    const r = el.getBoundingClientRect(), t = (el.textContent || '').trim();
    if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) bad.push('outside: ' + el.className + ' "' + t + '"');
    /* the text itself (not its line box): inside the picture, and inside its own piece when that piece clips */
    if (t && el.children.length === 0) {
      const rg = document.createRange(); rg.selectNodeContents(el); const tr = rg.getBoundingClientRect(), cs = getComputedStyle(el);
      if (tr.left < box.left - 1 || tr.right > box.right + 1 || tr.top < box.top - 1 || tr.bottom > box.bottom + 1) bad.push('text outside: ' + el.className + ' "' + t + '"');
      if (cs.overflow !== 'visible' && (tr.left < r.left - 1 || tr.right > r.right + 1)) bad.push('cut: ' + el.className + ' "' + t + '"');
      /* mixed-direction text gives one box per run on the same line, so count lines, not boxes */
      const lines = new Set([...rg.getClientRects()].map(x => Math.round(x.top / 4)));
      if (lines.size > 1 && /sc-(n|pill|app|day)/.test(el.className)) bad.push('wraps: ' + el.className + ' "' + t + '"');
    }
  });
  /* the "typing" line must not cover the field's label */
  sc.querySelectorAll('.sc-field').forEach(f => {
    const ph = f.querySelector('.sc-ph'), ink = f.querySelector('.sc-ink'); if (!ph || !ink) return;
    const rg = document.createRange(); rg.selectNodeContents(ph); const a = rg.getBoundingClientRect(), c = ink.getBoundingClientRect();
    if (a.left < c.right - 1 && c.left < a.right - 1) bad.push('covers the label: sc-ink over "' + ph.textContent + '"');
  });
  const pg = document.getElementById('helpPlayer');
  if (vis(pg) && document.documentElement.scrollWidth > innerWidth + 1) bad.push('page wider than the phone');
  return { texts, bad, dir: document.documentElement.getAttribute('dir') || 'rtl' };
};

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const b = await chromium.launch({ channel: 'chrome' });
let fail = 0;
try {
  for (const lang of LANGS) {
    const dict = lang === 'he' ? {} : JSON.parse(fs.readFileSync(path.join(DICT_DIR, lang + '.json'), 'utf8'));
    const ctx = await b.newContext({ viewport: { width: 375, height: 760 }, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.goto(`http://localhost:4181/?lang=${lang}`); await p.waitForFunction(() => window.IshurHelp);
    await p.waitForTimeout(600);
    const topics = await p.evaluate(() => IshurHelp.topics.map(t => t.steps.length));
    const left = new Set(), bad = new Set(), dirs = new Set();
    const look = async where => {
      await p.waitForTimeout(150);
      const r = await p.evaluate(probe); dirs.add(r.dir);
      for (const t of r.texts) {
        const heb = /[֐-׿]/.test(t);
        if (lang === 'he') continue;
        if (lang === 'yi' ? (dict[t] && dict[t] !== t) : heb) left.add(t);
      }
      r.bad.forEach(x => bad.add(where + ' ' + x));
    };
    await p.evaluate(() => IshurHelp.open()); await look('list');
    for (let i = 0; i < topics.length; i++) {
      await p.evaluate(n => IshurHelp.open(n), i);
      for (let s = 0; s < topics[i]; s++) {
        await look(`topic ${i + 1} step ${s + 1}`);
        if (i === 0 && s === 1) await p.screenshot({ path: path.join(ROOT, 'app', 'test', 'shots', `help-${lang}.png`) });
        if (s < topics[i] - 1) await p.click('#helpNext');
      }
    }
    /* H4: every name a step quotes ("tap X", "in the Y tab") is a real label: in Hebrew it is on a screen of the app
       or the board; in another language it is the dictionary's word for that label, so the step and the button match */
    const shown = await p.evaluate(() => [...document.querySelectorAll('#helpText')].map(e => e.textContent));
    const steps = await p.evaluate(() => IshurHelp.topics.flatMap(t => t.steps.map(s => s.text)));
    const quoted = s => [...s.matchAll(/"([^"]+)"|«\s?([^»]+?)\s?»|„([^“”]+)[“”]|“([^”]+)”/g)].map(m => (m[1] || m[2] || m[3] || m[4]).trim());
    if (lang === 'he') {
      const src = ['app/www/index.html', 'app/www/app.js', 'dashboard.html'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
      for (const s of steps) for (const q of quoted(s)) if (!new RegExp('>' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ <]').test(src)) bad.add('quotes a label that is on no screen: "' + q + '"');
    } else {
      const words = new Set(Object.values(dict).map(v => String(v).trim()));
      for (const s of steps) { const t = dict[s]; if (!t) continue; for (const q of quoted(t)) if (!words.has(q)) bad.add('quotes "' + q + '", which no button or screen is called'); }
    }
    void shown;
    /* H5 (Hebrew pass, needs STAGING_SECRETS): a step that says 'in the "X" tab ... "Y"' is true on the real board:
       the board opened as the app opens tab X shows Y */
    if (lang === 'he' && process.env.STAGING_SECRETS) {
      const VIEW = { 'ראשי': 'home', 'מוזמנים': 'guests', 'שליחות': 'sends' };
      const key = fs.readFileSync(process.env.STAGING_SECRETS, 'utf8').match(/^ADMIN_KEY=(.+)$/m)[1].trim();
      const BASE = 'https://go-staging.ishur.io', SITE = 'https://staging.ishur.io', PHONE = '0500000102', TOK = 'bbbbbbbb-0000-4000-8000-000000000002';
      const api = async (u, body) => (await fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      await api('/api/staging-seed', { admin_key: key, del_prefixes: ['rl:acctpin', 'acctpinlock:'] });
      const pin = (await api('/api/client-pin', { admin_key: key, token: TOK })).pin;
      const sess = (await api('/api/account/pin-login', { phone: PHONE, pin })).session;
      for (const s of steps) {
        const m = /בלשונית "([^"]+)"/.exec(s); if (!m) continue;
        const view = VIEW[m[1]]; if (!view) { bad.add('names a tab the app does not have: "' + m[1] + '"'); continue; }
        const rest = quoted(s.slice(m.index + m[0].length)); if (!rest.length) continue;
        const c2 = await b.newContext({ viewport: { width: 400, height: 860 } }); const q = await c2.newPage();
        await q.goto(`${SITE}/dashboard.html?t=${TOK}&app=1&view=${view}#s=${encodeURIComponent(sess)}`, { waitUntil: 'load' }).catch(() => {});
        await q.waitForTimeout(6000);
        const seen = await q.evaluate(labels => labels.map(l => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const e = w.currentNode.parentElement; if (e && (e.offsetParent || e.getClientRects().length) && w.currentNode.nodeValue.replace(/\s+/g, ' ').trim() === l) return true; } return false; }), rest);
        rest.forEach((l, i) => { if (!seen[i]) bad.add(`board tab "${m[1]}" does not show "${l}"`); });
        await c2.close();
      }
    }
    await ctx.close();
    const wantDir = RTL[lang] ? 'rtl' : 'ltr', badDir = [...dirs].filter(d => d !== wantDir);
    const ok = !left.size && !bad.size && !badDir.length;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${lang}: Hebrew left ${left.size}, does not fit ${bad.size}, direction ${badDir.length ? badDir.join(' ') : 'ok'}`);
    for (const t of left) console.log('     left: ' + t);
    for (const t of bad) console.log('     ' + t);
  }
} finally { await b.close(); server.close(); }
console.log(`${LANGS.length - fail}/${LANGS.length} languages pass`);
process.exit(fail ? 1 : 0);
