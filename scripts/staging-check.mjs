#!/usr/bin/env node
/* ============================================================================
   staging-check.mjs · "does client sign-in work, the way real clients arrive"
   (Richard 18/11/2026, after sign-in broke in production three times in a day)
   ----------------------------------------------------------------------------
   Runs against STAGING only (staging.ishur.io + go-staging.ishur.io), on the
   invented demo sheet. It signs in the ways clients really do — which a quick
   look in a fresh browser never covered:

     1. the personal link, first visit
     2. the personal link on a RETURNING device whose cache serves an old
        config.js (the failure of 18/11: "הקוד לא נכון" with a right code)
     3. the board opened with no link at all (the home-screen app)
     4. the personal area on the site: phone + code
     5. a wrong code is refused, and the board stays shut
     6. staging cannot send: a WhatsApp to a number off the allowlist is blocked
     7. production does not carry the staging routes

   Usage:   node scripts/staging-check.mjs            (exit 0 = all passed)
   Needs:   worker/.staging.secrets (ADMIN_KEY), Chrome, playwright
            (PLAYWRIGHT_PATH points at its index.mjs when it is not installed here)
   Run it before every promote of anything that touches sign-in, the board
   link, config.js, guard.js, sw.js or the status route.
   ========================================================================== */
import { seed, kv, adminKey, BASE, EVENTS } from '../worker/scripts/staging-seed.mjs';

const SITE = process.env.STAGING_SITE || 'https://staging.ishur.io';
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW).catch(() => { console.error('playwright not found: set PLAYWRIGHT_PATH to its index.mjs'); process.exit(2); });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? ' · ' + detail : '')); };
const api = async (path, body) => { const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const EV = EVENTS[0], PHONE = EV.phone;

/* ── 0. staging is what it says, seeded, and locked for the test ── */
const health = await fetch(BASE + '/api/health').then(r => r.json()).catch(() => ({}));
check('this is the staging worker, crons off', health.staging === true && health.crons === 'off', `${health.worker || '?'} ${health.commit || ''}`);
if (health.staging !== true) { console.error('not staging: stopping before touching anything'); process.exit(1); }
const sd = await seed({ 'cfg:board_pin': '1' });
check('demo sheet seeded, board lock on', sd.status === 200 && sd.body.events === EVENTS.length, `${sd.body.events} events, ${sd.body.guests} guests`);
const pinR = await api('/api/client-pin', { admin_key: adminKey(), token: EV.token });
const PIN = pinR.body.pin || '', WRONG = PIN === '0001' ? '0002' : '0001';
check('the demo client has a sign-in code', /^\d{4}$/.test(PIN));
const shut = await api('/api/status', { token: EV.token });
check('the link alone is refused while the lock is on', shut.status === 401 && shut.body.error === 'pin-required');

const browser = await chromium.launch({ channel: 'chrome' });
const boardOpen = p => p.evaluate(() => !document.getElementById('main').hidden && document.getElementById('pinGate').hidden && document.getElementById('gate').hidden);
const rows = p => p.evaluate(() => document.querySelectorAll('#rows .pill').length);
const waitBoard = p => p.waitForFunction(() => !document.getElementById('main').hidden && document.querySelectorAll('#rows .pill').length > 5, null, { timeout: 60000 }).then(() => true, () => false);

/* ── 1. personal link, first visit ── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage();
  await p.goto(`${SITE}/dashboard.html?t=${EV.token}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !document.getElementById('pinGate').hidden, null, { timeout: 30000 }).catch(() => {});
  /* 5. a wrong code first */
  await p.fill('#p-pin', WRONG); await p.waitForTimeout(6000);
  check('a wrong code is refused and the board stays shut', !(await boardOpen(p)) && /לא נכון/.test(await p.textContent('#p-err')));
  await p.fill('#p-pin', ''); await p.fill('#p-pin', PIN);
  const ok = await waitBoard(p);
  check('personal link, first visit: the right code opens the board (no button pressed)', ok && await boardOpen(p), `${await rows(p)} rows of ${EV.guests}`);
  await p.reload({ waitUntil: 'domcontentloaded' });
  check('…and a reload does not ask again', await waitBoard(p) && await boardOpen(p));
  await ctx.close();
}

/* ── 2. returning device: the cache worker is installed, and config.js is an OLD copy ── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage();
  const live = await fetch(`${SITE}/config.js`).then(r => r.text());
  const old = live.replace(/'account-board-pin': '[^']*',?/g, '').replace(/'account-board-pin-send': '[^']*',?/g, '').replace(/'preview-messages': '[^']*',?/g, '').replace(/'account-pin-login': '[^']*',?/g, '');
  await ctx.route('**/config.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: old }));
  const bad = []; p.on('response', r => { if (/\/api\/account-board-pin/.test(r.url())) bad.push(r.status()); });
  await p.goto(`${SITE}/dashboard.html?t=${EV.token}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.goto(`${SITE}/dashboard.html?t=${EV.token}`, { waitUntil: 'domcontentloaded' });   /* second visit: the cache worker is in control */
  await p.waitForFunction(() => !document.getElementById('pinGate').hidden, null, { timeout: 30000 }).catch(() => {});
  await p.fill('#p-pin', PIN);
  const ok = await waitBoard(p);
  check('returning device with an old config.js: the right code still opens the board', ok && await boardOpen(p) && !bad.length, bad.length ? 'the code was sent to a path that does not exist' : `${await rows(p)} rows`);
  await ctx.close();
}

/* ── 3. no personal link (home-screen app): phone + code on the gate ── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage();
  await p.goto(`${SITE}/dashboard.html?pwa=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !document.getElementById('gate').hidden, null, { timeout: 30000 }).catch(() => {});
  await p.fill('#g-phone', PHONE); await p.locator('#g-code').pressSequentially(PIN, { delay: 90 });
  const ok = await waitBoard(p);
  check('opened without a link (home-screen app): phone + code opens the board', ok && await boardOpen(p), `${await rows(p)} rows`);
  await ctx.close();
}

/* ── 4. the personal area on the site ── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage();
  await p.goto(`${SITE}/account.html`, { waitUntil: 'domcontentloaded' });
  await p.fill('#phone', PHONE); await p.locator('#pin').pressSequentially(PIN, { delay: 90 });
  const link = p.locator(`a[href*="dashboard.html?t=${EV.token}"]`).first();
  await link.waitFor({ state: 'visible', timeout: 40000 }).catch(() => {});
  const listed = await link.count() > 0;
  check('personal area: phone + code signs in and lists the event', listed);
  if (listed) {
    /* a first visit shows the guided-tour overlay over the page, so the link is followed by its address (same tab, same sign-in) rather than by a click */
    /* the worker writes event links with the production host (https://ishur.io/…). On staging that would leave the
       environment, so the same path is opened on the staging site, where this sign-in lives. */
    const target = new URL(await link.getAttribute('href'), p.url());
    await p.goto(SITE + target.pathname + target.search, { waitUntil: 'domcontentloaded' });
    check('…and the board opens from there without asking again', await waitBoard(p) && await boardOpen(p), `${await rows(p)} rows`);
  }
  await ctx.close();
}
await browser.close();

/* ── 6. staging cannot reach a real phone ── */
const probe = await api('/api/staging-probe', { admin_key: adminKey(), phone: '0501234567' });
check('a WhatsApp to a number off the allowlist is blocked', probe.body.staging === true && probe.body.allowlisted === false && probe.body.result && probe.body.result.error === 'staging-blocked');

/* ── 7. production does not carry the staging routes ── */
const prodSeed = await fetch('https://go.ishur.io/api/staging-seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status).catch(() => 0);
check('production refuses the staging seed route', prodSeed === 404 || prodSeed === 403, 'HTTP ' + prodSeed);

/* leave staging the way production runs today: lock off */
await kv({ 'cfg:board_pin': null });

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\nSTAGING CHECK FAILED · ${failed.length} of ${results.length}` : `\nSTAGING CHECK PASS · ${results.length} of ${results.length}`);
process.exit(failed.length ? 1 : 0);
