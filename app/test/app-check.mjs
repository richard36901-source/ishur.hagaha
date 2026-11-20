#!/usr/bin/env node
/* client-app · loop 1 check (spec P1, P2, P3, P7, P8).
   Serves app/www on http://localhost:4180 (an origin the staging Worker allows), signs in as the demo client on
   go-staging.ishur.io and compares what the screens show with what /api/status answers.

   Needs: worker/.staging.secrets (ADMIN_KEY, to read the demo client's code; STAGING_SECRETS=/path overrides),
          Chrome, playwright (PLAYWRIGHT_PATH=/path/to/playwright/index.mjs when not installed here).
   Exit 0 = every check passed. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(HERE, '..', 'www');
const SHOTS = path.join(HERE, 'shots');
const BASE = 'https://go-staging.ishur.io';
/* DEMO=2 runs the second demo client, whose guests have mixed answers */
const [PHONE, TOKEN] = process.env.DEMO === '2' ? ['0500000102', 'bbbbbbbb-0000-4000-8000-000000000002'] : ['0500000101', 'aaaaaaaa-0000-4000-8000-000000000001'];
const BAD_WORDS = /שגיאה|error|נכשל|failed|exception/i;

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright').catch(() => { console.error('playwright not found: set PLAYWRIGHT_PATH to its index.mjs'); process.exit(2); });
const secretsFile = process.env.STAGING_SECRETS || path.join(HERE, '..', '..', 'worker', '.staging.secrets');
const adminKey = () => { const m = fs.readFileSync(secretsFile, 'utf8').match(/^ADMIN_KEY=(.+)$/m); if (!m) throw new Error('no ADMIN_KEY in ' + secretsFile); return m[1].trim(); };

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? ' · ' + detail : '')); };
const api = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

/* static checks on the source (P7, P8) */
const files = fs.readdirSync(WWW, { recursive: true }).map(f => path.join(WWW, f)).filter(f => /\.(html|css|js)$/.test(f));
const src = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
check('P7 no prices or buy wording in the app', !/₪|מחיר|לרכישה|קנו|שדרג/.test(src));
check('P8 no radius above 8px, no font CDN', !/border-radius:\s*(9|[1-9][0-9])px|fonts\.googleapis/.test(src));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(WWW, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'))));
  if (!p.startsWith(WWW) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(p));
});
await new Promise(r => server.listen(4180, '127.0.0.1', r));

let code = 1;
try {
  const health = await fetch(BASE + '/api/health').then(r => r.json()).catch(() => ({}));
  check('this is the staging worker', health.staging === true, health.worker || '?');
  if (health.staging !== true) throw new Error('not staging: stopping');
  /* staging only: clear this machine's sign-in counters (6 tries an hour per phone), as scripts/staging-check.mjs does */
  const cleared = await api('/api/staging-seed', { admin_key: adminKey(), del_prefixes: ['rl:acctpin', 'acctpinlock:'] });
  check('staging sign-in counters cleared for the run', cleared.status === 200 && cleared.body.ok !== false, 'status ' + cleared.status);
  const PIN = (await api('/api/client-pin', { admin_key: adminKey(), token: TOKEN })).body.pin || '';
  check('the demo client has a sign-in code', /^\d{4}$/.test(PIN));
  const WRONG = PIN === '0001' ? '0002' : '0001';

  /* the truth to compare with: the same data the app reads */
  const sess = (await api('/api/account/pin-login', { phone: PHONE, pin: PIN })).body.session || '';
  const truth = (await api('/api/status', { token: TOKEN, board_session: sess })).body;
  const G = truth.guests || [];
  const afterInvite = (truth.sends || []).some(x => x.key === 'invite' && (x.status === 'sent' || x.status === 'passed'));
  const notReached = g => g.status === 'pending' && (g.sent === 'failed' || g.sent === 'retrying' || ((!g.sent || g.sent === 'none') && afterInvite && !g.self));
  const want = { all: G.length, confirmed: G.filter(g => g.status === 'confirmed').length, undecided: G.filter(g => g.status === 'undecided').length, pending: G.filter(g => g.status === 'pending' || g.status === 'awaiting_call').length, declined: G.filter(g => g.status === 'declined').length, failed: G.filter(notReached).length };
  check('status answered with guests', truth.ok === true && G.length > 5, G.length + ' guests');

  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, locale: 'he-IL' });
  const p = await ctx.newPage();
  const jsErrors = []; p.on('pageerror', e => jsErrors.push(String(e.message)));
  const trackers = []; p.on('request', r => { if (/facebook\.(net|com)|tiktok|googletagmanager|google-analytics|doubleclick|posthog|ishur\.io\/ph\//i.test(r.url())) trackers.push(new URL(r.url()).host); });
  await p.goto('http://localhost:4180/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#signin:not([hidden])', { timeout: 15000 });
  await p.screenshot({ path: path.join(SHOTS, '1-signin-light.png') });

  /* P1: a wrong code stays on the sign-in screen, quietly */
  await p.fill('#phone', PHONE); await p.fill('#code', WRONG); await p.click('#go');
  await p.waitForSelector('#signinNote:not(:empty)', { timeout: 30000 }).catch(() => {});
  const afterWrong = await p.evaluate(() => ({ signin: !document.getElementById('signin').hidden, text: document.body.innerText }));
  check('P1 wrong code stays on sign-in', afterWrong.signin);
  check('P1 no error wording after a wrong code', !BAD_WORDS.test(afterWrong.text), (afterWrong.text.match(BAD_WORDS) || [''])[0]);

  /* P1: the right code lands on the summary with the event's name */
  await p.fill('#code', PIN); await p.click('#go');
  const inOk = await p.waitForSelector('#tabs:not([hidden])', { timeout: 60000 }).then(() => true, () => false);
  await p.waitForFunction(() => /\d/.test((document.getElementById('kpiAll') || {}).textContent || ''), null, { timeout: 60000 }).catch(() => {});
  const evName = await p.textContent('#evName').catch(() => '');
  const wantName = [truth.event.name1, truth.event.name2].filter(Boolean)[0];
  check('P1 right code opens the summary with the event name', inOk && evName.includes(wantName), evName.trim() + (inOk ? '' : ' · sign-in note: ' + (await p.textContent('#signinNote').catch(() => '')) + ' · ' + jsErrors.join(' | ')));
  const head = await p.evaluate(() => { const b = document.querySelector('#app .brand'), r = b.getBoundingClientRect(); return { text: b.textContent.trim(), off: Math.abs((r.left + r.right) / 2 - innerWidth / 2) }; });
  check('header reads "אישורי הגעה לאירועים - ishur.io" and sits in the middle', head.text === 'אישורי הגעה לאירועים - ishur.io' && head.off <= 2, head.text + ' · ' + head.off.toFixed(1) + 'px off centre');
  /* home is the regular board itself */
  const homeIsBoard = await p.frameLocator('#boardFrame').locator('#rows .pill').nth(5).waitFor({ timeout: 60000 }).then(() => true, () => false);
  check('home after sign-in is the regular board, tab "ראשי" lit', homeIsBoard && await p.evaluate(() => !document.getElementById('v-board').hidden && document.querySelector('#tabs .on span').textContent === 'ראשי'));
  /* the board's first-visit tour is skipped for the screenshots, the way a client taps "דלגו על הכל" */
  await p.waitForTimeout(1500);
  await p.frameLocator('#boardFrame').getByText('דלגו על הכל').click({ timeout: 5000 }).catch(() => {});
  { const f0 = p.frames().find(f => /dashboard/.test(f.url())); if (f0) await f0.evaluate(() => window.scrollTo(0, 0)); }
  await p.waitForTimeout(600); await p.screenshot({ path: path.join(SHOTS, '2-home-light.png') });

  /* P2: the six guest tabs show the counts computed from the same JSON */
  await p.click('[data-tab=guests]');
  await p.waitForSelector('#guestRows .row', { timeout: 20000 }).catch(() => {});
  for (const k of Object.keys(want)) {
    await p.click(`#filters [data-f=${k}]`);
    const got = await p.evaluate(k2 => ({ badge: Number(document.querySelector(`#filters [data-f=${k2}] .n`).textContent), rows: document.querySelectorAll('#guestRows .row').length }), k);
    check(`P2 tab ${k}`, got.badge === want[k] && got.rows === want[k], `screen ${got.badge}/${got.rows} rows, data ${want[k]}`);
  }
  await p.click('#filters [data-f=all]');
  await p.screenshot({ path: path.join(SHOTS, '3-guests-light.png') });
  const needle = G[3].name, wantRows = G.filter(g => g.name.includes(needle)).length;
  await p.fill('#search', needle);
  const found = await p.evaluate(() => document.querySelectorAll('#guestRows .row').length);
  check('P2 search leaves only the matching rows', found === wantRows && found >= 1, `${found} rows, data ${wantRows}`);
  await p.fill('#search', '');

  await p.click('[data-tab=sends]');
  const sendRows = await p.evaluate(() => document.querySelectorAll('#sendRows .row').length);
  check('send schedule lists every send', sendRows === (truth.sends || []).length, `${sendRows} of ${(truth.sends || []).length}`);
  await p.screenshot({ path: path.join(SHOTS, '4-sends-light.png') });
  await p.click('[data-tab=account]');
  await p.screenshot({ path: path.join(SHOTS, '5-account-light.png') });

  /* P13: the regular board, in app mode, inside the app */
  await p.click('[data-tab=board]');
  const fr = p.frameLocator('#boardFrame');
  const boardUp = await fr.locator('#rows .pill').nth(5).waitFor({ timeout: 60000 }).then(() => true, () => false);
  check('P13 the board opens inside the app with its guest rows', boardUp);
  const frame = p.frames().find(f => /dashboard/.test(f.url()));
  const inBoard = frame ? await frame.evaluate(() => {
    const vis = sel => Array.from(document.querySelectorAll(sel)).filter(el => el.offsetParent !== null || el.getClientRects().length).length;
    return { mode: document.documentElement.classList.contains('in-app'), shown: ['.top .brand', '.theme-tog', '#pwaCard', '#addonsCard', '#refCard', '#invoiceCard', '.buy', '.toc'].filter(s => vis(s) > 0), shekel: /₪/.test(document.body.innerText), hash: location.hash };
  }) : { mode: false, shown: ['no frame'], shekel: true, hash: '' };
  check('P13 app mode is on and nothing that sells is visible', inBoard.mode && inBoard.shown.length === 0 && !inBoard.shekel, inBoard.shown.join(' ') + (inBoard.shekel ? ' ₪ on screen' : ''));
  const bar = frame ? await frame.evaluate(() => !!document.getElementById('ishur-consent')) : true;
  check('P13 no tracking requests and no cookie bar inside the app', trackers.length === 0 && !bar, [...new Set(trackers)].join(' ') + (bar ? ' cookie bar shown' : ''));
  check('P13 the session is not left in the address', !/acct\./.test(inBoard.hash));
  await p.waitForTimeout(600); await p.screenshot({ path: path.join(SHOTS, '8-board-light.png') });

  /* what is saved on the device: no phone numbers, no board link to a page that sells */
  const saved = await p.evaluate(() => Object.keys(localStorage).filter(k => /^ishurapp_data:/.test(k)).map(k => localStorage.getItem(k)).join(''));
  check('saved copy on the device holds no phone numbers', saved.length > 100 && !/\d{9,}/.test(saved) && !/phone|gift|invoice/.test(saved));
  check('no link from the app to the web board', !/dashboard\.html/.test(src));

  /* screenshots of the home board further down: the invitation, the guests, the send schedule */
  await p.click('[data-tab=board]');
  if (frame) {
    for (const [sel, name] of [['#mediaCard', '9-home-invitation'], ['#rows', '10-home-guests'], ['#sendsCard', '11-home-sends'], ['#shareCard', '12-home-share']]) {
      await frame.evaluate(s2 => { const el = document.querySelector(s2); if (el) el.scrollIntoView({ block: 'start' }); }, sel);
      await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, name + '.png') });
    }
  }

  /* P3: no network, reload: the last state is still there with "עודכן" */
  await ctx.route('https://go-staging.ishur.io/**', r => r.abort());
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#tabs:not([hidden])', { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(2500);
  const off = await p.evaluate(() => ({ all: (document.getElementById('kpiAll') || {}).textContent, stamp: (document.getElementById('stamp') || {}).textContent, text: document.body.innerText }));
  check('P3 offline: the app\'s own summary takes the place of the board', await p.evaluate(() => !document.getElementById('v-summary').hidden && document.getElementById('v-board').hidden));
  check('P3 offline: counts still on screen', Number(off.all) === want.all, `screen ${off.all}, data ${want.all}`);
  check('P3 offline: says when it was updated, no error wording', /עודכן/.test(off.stamp || '') && !BAD_WORDS.test(off.text), (off.stamp || '').trim());
  await ctx.unroute('https://go-staging.ishur.io/**');

  /* dark, by device setting (P8 screenshots) */
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, '6-summary-dark.png') });
  await p.click('[data-tab=guests]'); await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, '7-guests-dark.png') });
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('P8 dark follows the device setting', /rgb\((\d+), (\d+), (\d+)\)/.test(bg) && bg.match(/\d+/g).slice(0, 3).every(n => Number(n) < 60), bg);

  /* sign out returns to the sign-in screen and forgets the session */
  await p.click('[data-tab=account]'); await p.click('#signout');
  const out = await p.evaluate(() => ({ signin: !document.getElementById('signin').hidden, left: Object.keys(localStorage).filter(k => /^ishurapp_/.test(k)) }));
  check('sign out forgets the session and the cached guests', out.signin && out.left.length === 0, out.left.join(','));
  check('no script failures on the page', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
  await browser.close();
  code = results.every(Boolean) ? 0 : 1;
} catch (e) { console.error('stopped: ' + (e && e.message)); code = 1; }
server.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(code);
