#!/usr/bin/env node
/* 22/11 round 7 Part B: the board's guest-language card (dashboard.html #guestLangCard). Serves this checkout on localhost:4180,
   signs in the staging demo client, stubs /api/guest-lang in the browser. Run from the repo root:
   STAGING_SECRETS=… PLAYWRIGHT_PATH=… node test/guest-lang-card-check.mjs <screenshot.png> */
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const ROOT = process.cwd();
const T = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8' };
const server = http.createServer((q, r) => { let u = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (!path.extname(u)) u += '.html'; const f = path.join(ROOT, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); });
await new Promise(r => server.listen(4180, '127.0.0.1', r));
const key = fs.readFileSync(process.env.STAGING_SECRETS, 'utf8').match(/^ADMIN_KEY=(.+)$/m)[1].trim();
const api = async (p, b) => (await fetch('https://go-staging.ishur.io' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const TOK = 'bbbbbbbb-0000-4000-8000-000000000002';
await api('/api/staging-seed', { admin_key: key, del_prefixes: ['rl:acctpin', 'acctpinlock:'] });
const pin = (await api('/api/client-pin', { admin_key: key, token: TOK })).pin;
const sess = (await api('/api/account/pin-login', { phone: '0500000102', pin })).session;
const { chromium } = await import(process.env.PLAYWRIGHT_PATH);
const b = await chromium.launch({ channel: 'chrome' });
const res = []; const ok = (n, c, i = '') => { res.push(!!c); console.log((c ? 'ok   ' : 'FAIL ') + n + (i ? ' · ' + i : '')); };
async function open(state, view) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } }); const saves = []; const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route(/\/api\/guest-lang$/, async route => { const body = JSON.parse(route.request().postData() || '{}');
    if (body.mode) { saves.push(body); if (state.locked) return route.fulfill({ status: 409, json: { ok: false, error: 'already-sent' } }); state.choice = body.mode === 'he' ? { mode: 'he' } : { mode: body.mode, lang: body.lang }; }
    return route.fulfill({ json: { ok: true, enabled: state.enabled, locked: state.locked, choice: state.choice } }); });
  await p.goto(`http://localhost:4180/dashboard.html?t=${TOK}&app=1&view=${view}#s=${encodeURIComponent(sess)}`); await p.waitForTimeout(7000);
  await p.getByText('דלגו על הכל').click({ timeout: 2000 }).catch(() => {});
  return { p, saves, errs };
}
let o = await open({ enabled: false, locked: false, choice: { mode: 'he' } }, 'sends');
ok('feature off: no card', await o.p.locator('#guestLangCard').isHidden()); await o.p.close();
const st = { enabled: true, locked: false, choice: { mode: 'he' } };
o = await open(st, 'sends');
ok('feature on: the card shows on שליחות', await o.p.locator('#guestLangCard').isVisible());
ok('Hebrew only is chosen, no language list', await o.p.locator('input[name=glMode][value=he]').isChecked() && await o.p.locator('#glLang').isHidden());
await o.p.locator('input[name=glMode][value=pair]').check(); await o.p.selectOption('#glLang', 'ru'); await o.p.click('#glSave'); await o.p.waitForTimeout(800);
ok('saving sends Hebrew + Russian', JSON.stringify(o.saves[0]) === JSON.stringify({ token: TOK, mode: 'pair', lang: 'ru' }), JSON.stringify(o.saves[0]));
ok('"נשמר ✓" after saving', (await o.p.locator('#glNote').textContent()) === 'נשמר ✓');
await o.p.locator('#guestLangCard').scrollIntoViewIfNeeded(); await o.p.locator('#guestLangCard').screenshot({ path: process.argv[2] });
ok('no script errors', !o.errs.length, o.errs.join(' | ')); await o.p.close();
o = await open(st, 'home');
ok('not on ראשי', await o.p.locator('#guestLangCard').isHidden()); await o.p.close();
o = await open({ enabled: true, locked: true, choice: { mode: 'alone', lang: 'en' } }, 'sends');
ok('after the invitations went out: the choice shows, locked, with the reason', await o.p.locator('input[name=glMode][value=alone]').isChecked() && await o.p.locator('input[name=glMode][value=he]').isDisabled() && await o.p.locator('#glSave').isHidden() && /כבר יצאו/.test(await o.p.locator('#glNote').textContent()));
await o.p.close();
await b.close(); server.close();
console.log(res.filter(Boolean).length + '/' + res.length + ' passed');
