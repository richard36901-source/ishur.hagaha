// node scripts/leads-crm-smoke.mjs [shots-dir] — next/leads.html in a real browser with the API stubbed:
// the table renders, an inline edit calls POST /api/crm/leads/m<id>, a refused save rolls back and says so,
// a change made "in monday" appears on its own within one poll, the header stays pinned, the drawer, the phone cards.
// Nothing leaves the machine: every /api/ call is answered here and any other host is blocked.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root = new URL('..', import.meta.url).pathname;
const shots = process.argv[2] || '';
const { chromium } = await import(path.join(os.homedir(), '.ship-studio/playwright-env/node_modules/playwright/index.mjs'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); r.end(fs.readFileSync(p)); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const base = 'http://127.0.0.1:' + server.address().port;
let fail = 0, n = 0;
const ok = (c, name, extra = '') => { n++; if (!c) fail++; console.log((c ? '  ✓ ' : '  ✗ ') + name + (extra ? '  [' + extra + ']' : '')); };

const ST = ['חדש', 'נשלח פרטים', 'לא ענה', 'שיחה חוזרת', 'סגר', 'סגר במקום אחר', 'לא רלוונטי'];
const mk = i => ({ id: 'm' + (100 + i), item_id: String(100 + i), name: i === 0 ? 'אאא ראשון <b>x</b>' : 'ליד ' + String(i).padStart(2, '0'), phone: '97252' + String(1000000 + i), event: i % 2 ? 'חתונה' : 'בר מצווה', guests: 50 + i * 5, package: 'עד 300', price: i % 3 ? 1000 + i * 10 : null, source: i % 2 ? 'fb / paid' : 'google', ad: 'AS04',
  status: ST[i % 3], owner: ['שלו', 'נועה', ''][i % 3], dial: i === 2, notes: i === 1 ? 'שורה ראשונה\nלחזור בערב' : '', next: i === 1 ? '2026-11-20' : '', touch_text: '', group: 'פעילים', created_at: new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString(), m_at: '2026-11-16T08:00:00Z', touch_at: '2026-11-16T08:00:00Z' });
const db = new Map(Array.from({ length: 60 }, (_, i) => mk(i)).map(l => [l.id, l]));
const reqs = [], pending = { items: [], deleted: [] }; let failNext = false, conflictNext = false, polls = 0, blocked = [];

let browser; try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'chrome' }); }   /* like ops-ui-smoke: the bundled browser, else the installed Chrome */
async function open(viewport) {
  const cx = await browser.newContext({ viewport, locale: 'he-IL' });
  await cx.addInitScript(() => { try { localStorage.setItem('ishur_calls_key', 'test-key'); } catch (e) {} });
  const page = await cx.newPage();
  page.on('pageerror', e => { fail++; console.log('  ✗ page error: ' + e.message); });
  await cx.route('**/*', async route => {
    const rq = route.request(), u = new URL(rq.url());
    if (u.origin === base) return route.continue();
    if (!u.pathname.startsWith('/api/')) { if (!/fonts\.g/.test(u.host)) blocked.push(u.host + u.pathname); return route.abort(); }
    const body = rq.method() === 'POST' ? JSON.parse(rq.postData() || '{}') : null;
    reqs.push({ m: rq.method(), p: u.pathname + u.search, body, key: rq.headers()['x-admin-key'] || (body && body.admin_key) || '' });
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key' }, body: JSON.stringify(o) });
    if (rq.method() === 'OPTIONS') return json({});
    if (u.pathname === '/api/crm/leads/board') return json({ ok: true, monday: 'ok', items: [...db.values()], cursor: 1000, synced_at: new Date().toISOString(), statuses: ST, owners: ['ריצארד', 'נועה', 'שלו'] });
    if (u.pathname === '/api/crm/leads/changes') { polls++; const out = { ok: true, monday: 'ok', cursor: 1000 + polls, items: pending.items.splice(0), deleted: pending.deleted.splice(0) }; return json(out); }
    const m = u.pathname.match(/^\/api\/crm\/leads\/(m\d+)$/);
    if (m && rq.method() === 'POST') {
      const l = db.get(m[1]);
      if (failNext) { failNext = false; return json({ ok: false, error: 'monday-failed', why: 'monday 500' }, 502); }
      if (conflictNext) { conflictNext = false; return json({ ok: false, error: 'conflict', fields: ['owner'], lead: { ...l, owner: 'ריצארד' } }, 409); }
      const f = body.fields; const next = { ...l, ...Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'note')) };
      if (f.note) next.notes = (l.notes ? l.notes + '\n' : '') + '16.11 · ' + f.note;
      db.set(l.id, next); await new Promise(r => setTimeout(r, 150));
      return json({ ok: true, lead: next, rev: Date.now(), saved_at: new Date().toISOString() });
    }
    if (m) return json({ ok: true, lead: db.get(m[1]), notes: [{ at: '2026-11-15T10:00:00Z', text: 'הערה מהציר', author: 'שלו' }], activities: [{ at: '2026-11-15T11:00:00Z', kind: 'msg', dir: 'in', text: 'שלום, מה המחיר?' }] });
    return json({ ok: false, error: 'stub' });
  });
  await page.goto(base + '/next/leads.html');
  await page.waitForSelector('#rows tr[data-id]', { timeout: 8000 });
  return { cx, page };
}
const rowText = (page, id) => page.$eval('#rows tr[data-id="' + id + '"]', tr => tr.innerText);

try {
  const { cx, page } = await open({ width: 1440, height: 900 });
  ok((await page.$$('#rows tr[data-id]')).length === 60, 'the table renders every lead of the stubbed board', (await page.$$('#rows tr[data-id]')).length + ' rows');
  const heads = await page.$$eval('#hd th', a => a.map(x => x.innerText.trim()));
  ok(heads.join('|') === 'שם|טלפון|אירוע|כמות|חבילה|מחיר|מקור|מודעה|סטטוס|טיפול|נגיעה אחרונה|הצעד הבא|הערה', 'columns: name / phone / event / guests / package / price / source / ad / status / owner / last touch / next step (+ note)', heads.join('|'));
  ok(reqs[0] && reqs.find(r => r.p === '/api/crm/leads/board').key === 'test-key', 'the list is read with the admin key in a header');
  ok(await page.$eval('#rows', el => !el.querySelector('b') && /<b>x<\/b>/.test(el.innerText)), 'a name with markup in it is shown as text');
  ok(await page.$eval('#sales', el => !!el) && await page.$eval('#pbfold', el => !!el) && await page.$eval('.list', el => !!el.querySelector('#rows')), '#sales, #pbfold and .list are in the page');
  if (shots) await page.screenshot({ path: path.join(shots, 'leads-1440.png') });

  /* sticky header */
  await page.$eval('#list', el => { el.scrollTop = 600; });
  const pos = await page.evaluate(() => { const l = document.getElementById('list').getBoundingClientRect(), h = document.querySelector('#hd th').getBoundingClientRect(); return { d: Math.abs(h.top - l.top), sc: document.getElementById('list').scrollTop }; });
  ok(pos.sc > 300 && pos.d < 3, 'the header stays at the top of the list after scrolling', JSON.stringify(pos));
  await page.$eval('#list', el => { el.scrollTop = 0; });

  /* sort, filter, search */
  await page.click('#hd [data-sort="name"]');
  ok((await page.$eval('#rows tr[data-id]', tr => tr.dataset.id)) === 'm100' && (await page.$eval('#hd th[aria-sort]', th => th.getAttribute('aria-sort'))) === 'ascending', 'a click on a column sorts by it');
  await page.click('#hd [data-sort="name"]');
  ok((await page.$eval('#rows tr[data-id]', tr => tr.dataset.id)) !== 'm100', 'a second click reverses the order');
  await page.click('#hd [data-sort="guests"]');
  ok((await page.$eval('#rows tr[data-id]', tr => tr.dataset.id)) === 'm100', 'numbers sort as numbers (50 first)');
  await page.click('#stChips .chip[data-st="לא ענה"]');
  ok((await page.$$('#rows tr[data-id]')).length === 20, 'status chip filters', (await page.$$('#rows tr[data-id]')).length + '');
  await page.click('#owChips .chip[data-ow="-"]');
  ok((await page.$$('#rows tr[data-id]')).length === 20 && (await page.$eval('#shown', e => e.innerText)).includes('20'), 'owner chip filters (nobody)');
  await page.click('#stChips .chip[data-st=""]'); await page.click('#owChips .chip[data-ow=""]');
  await page.keyboard.press('/'); await page.keyboard.type('052-100-0007');
  ok((await page.$$('#rows tr[data-id]')).length === 1, '"/" focuses the search; a phone typed with dashes finds its lead');
  await page.fill('#q', '');

  /* an inline edit */
  const before = reqs.length;
  await page.selectOption('#rows tr[data-id="m101"] select[data-f="status"]', 'סגר');
  await page.waitForSelector('#rows tr[data-id="m101"] .ss.saved', { timeout: 4000 });
  const ed = reqs.slice(before).find(r => r.m === 'POST');
  ok(ed && ed.p === '/api/crm/leads/m101' && ed.body.fields.status === 'סגר' && Object.keys(ed.body.fields).length === 1 && ed.body.base.status === 'נשלח פרטים' && ed.body.admin_key === 'test-key', 'an inline status edit calls POST /api/crm/leads/m101 with the changed field and what the user saw', ed && JSON.stringify({ p: ed.p, fields: ed.body.fields, base: ed.body.base }));
  ok((await rowText(page, 'm101')).includes('נשמר'), 'the row says "נשמר" after monday accepted');
  ok(await page.$eval('#drawer', d => d.hidden), 'no modal opened for the edit');
  await page.fill('#rows tr[data-id="m101"] input[data-f="price"]', '2,450'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#rows tr[data-id="m101"] input[data-f="price"]').defaultValue === '2450' && !document.querySelector('#rows tr[data-id="m101"] .ss.saving'), null, { timeout: 4000 });
  const pe = reqs.filter(r => r.m === 'POST').pop();
  ok(pe.body.fields.price === 2450 && pe.body.base.price === 1010, 'price edit by keyboard (Enter) sends a number', JSON.stringify(pe.body.fields));
  await page.fill('#rows tr[data-id="m101"] input[data-f="note"]', 'ביקשה הצעה'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#rows tr[data-id="m101"] input[data-f="note"]').placeholder.includes('ביקשה הצעה'), null, { timeout: 4000 });
  ok(reqs.filter(r => r.m === 'POST').pop().body.fields.note === 'ביקשה הצעה', 'a note typed in the row is saved with Enter and becomes the row\'s last note');
  await page.selectOption('#rows tr[data-id="m101"] select[data-f="owner"]', 'ריצארד');
  await page.waitForTimeout(500);
  ok(reqs.filter(r => r.m === 'POST').pop().body.fields.owner === 'ריצארד' && reqs.filter(r => r.m === 'POST').pop().body.base.owner === 'נועה', 'owner edit');

  /* a save monday refuses */
  failNext = true;
  await page.selectOption('#rows tr[data-id="m102"] select[data-f="status"]', 'סגר');
  await page.waitForSelector('#rows tr[data-id="m102"] .ss.failed', { timeout: 4000 });
  ok((await page.$eval('#rows tr[data-id="m102"] select[data-f="status"]', s => s.value)) === 'לא ענה' && (await rowText(page, 'm102')).includes('לא נשמר') && !(await page.$('#rows tr[data-id="m102"] .ss.saved')), 'a refused save rolls the row back and says "לא נשמר"', await page.$eval('#rows tr[data-id="m102"] .ss', s => s.className + ':' + s.innerText));
  await page.waitForTimeout(3000);
  ok(await page.$('#rows tr[data-id="m102"] .ss.failed'), 'the failed mark stays (it does not fade like "נשמר")');
  conflictNext = true;
  await page.selectOption('#rows tr[data-id="m103"] select[data-f="owner"]', 'נועה');
  await page.waitForSelector('#rows tr[data-id="m103"] .ss.conflict', { timeout: 4000 });
  ok((await page.$eval('#rows tr[data-id="m103"] select[data-f="owner"]', s => s.value)) === 'ריצארד', 'a conflict shows the value monday holds');

  /* a change made in monday arrives on its own */
  const p0 = polls;
  pending.items.push({ ...db.get('m104'), status: 'לא רלוונטי', price: 7777, rev: 5 }); pending.items.push({ ...mk(900), id: 'm999', name: 'נוצר במאנדיי', rev: 6 }); pending.deleted.push('m105');
  await page.waitForFunction(() => { const s = document.querySelector('#rows tr[data-id="m104"] select[data-f="status"]'); return s && s.value === 'לא רלוונטי'; }, null, { timeout: 15000 });
  ok(polls > p0 && reqs.some(r => /^\/api\/crm\/leads\/changes\?since=\d+/.test(r.p)), 'the page polls "changed since" on its own', polls + ' polls');
  ok((await page.$eval('#rows tr[data-id="m104"] input[data-f="price"]', i => i.value)) === '7777' && !!(await page.$('#rows tr[data-id="m999"]')) && !(await page.$('#rows tr[data-id="m105"]')), 'a remote edit shows in its row, a new item appears, a removed one is gone, without a refresh');
  /* a row being typed in is left alone, then catches up */
  await page.fill('#rows tr[data-id="m106"] input[data-f="note"]', 'באמצע הקלדה');
  pending.items.push({ ...db.get('m106'), status: 'סגר במקום אחר', rev: 9 });
  const p1 = polls; while (polls === p1) await page.waitForTimeout(500);
  await page.waitForTimeout(300);
  ok((await page.$eval('#rows tr[data-id="m106"] input[data-f="note"]', i => i.value)) === 'באמצע הקלדה' && (await page.$eval('#rows tr[data-id="m106"] select[data-f="status"]', s => s.value)) !== 'סגר במקום אחר', 'a poll does not touch a row somebody is typing in');
  await page.fill('#rows tr[data-id="m106"] input[data-f="note"]', ''); await page.click('h1');
  await page.waitForFunction(() => document.querySelector('#rows tr[data-id="m106"] select[data-f="status"]').value === 'סגר במקום אחר', null, { timeout: 15000 });
  ok(true, 'and the held change lands once the row is free');

  /* the drawer */
  await page.focus('#rows tr[data-id="m101"]'); await page.keyboard.press('Enter');
  await page.waitForSelector('#drawer:not([hidden]) #dTl li time', { timeout: 4000 });
  const dt = await page.$eval('#drawer', d => d.innerText);
  ok(/ליד 01/.test(dt) && /הערה מהציר/.test(dt) && /נכנס: שלום, מה המחיר\?/.test(dt) && /קישור לתשלום/.test(dt) && /נועה תחייג/.test(dt) && /לחזור בערב/.test(dt), 'Enter on a row opens the drawer: the lead, monday notes, the timeline, the pay-link shortcut');
  ok(await page.$eval('#main', m => m.contains(document.getElementById('drawer'))), 'the drawer lives inside #main');
  if (shots) await page.screenshot({ path: path.join(shots, 'leads-drawer.png') });
  await page.fill('#dNx', '2026-12-01'); await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
  ok(reqs.filter(r => r.m === 'POST').pop().body.fields.next === '2026-12-01', 'the next-step date is edited in the drawer');
  await page.keyboard.press('Escape');
  ok(await page.$eval('#drawer', d => d.hidden) && (await page.evaluate(() => document.activeElement.dataset.id)) === 'm101', 'Escape closes it and focus returns to the row');
  await page.keyboard.press('ArrowDown');
  ok((await page.evaluate(() => document.activeElement.dataset.id)) !== 'm101' && (await page.evaluate(() => document.activeElement.tagName)) === 'TR', 'arrow keys move between rows');
  /* info button */
  await page.click('#infoBtn'); ok(!(await page.$eval('#info', e => e.hidden)), 'the "i" button opens the explanation'); await page.keyboard.press('Escape'); ok(await page.$eval('#info', e => e.hidden), 'Escape closes it');
  /* pay link shortcut: opens the pay-link part of this page, sends nothing */
  await page.focus('#rows tr[data-id="m101"]'); await page.keyboard.press('Enter'); await page.click('#dPay');
  await page.waitForFunction(() => document.body.dataset.sub === 'paylink', null, { timeout: 4000 });
  ok(await page.$eval('#list', l => getComputedStyle(l).display === 'none') && await page.$eval('#drawer', d => d.hidden), 'the pay-link shortcut switches to the קישורים view; the list and the drawer are out of the way');
  ok(!reqs.some(r => /\/send|pay-link|whatsapp|dial/.test(r.p)), 'no send, pay-link creation or call request was made by any of this', reqs.filter(r => r.m === 'POST').map(r => r.p).filter((v, i, a) => a.indexOf(v) === i).join(' '));
  await page.evaluate(() => { location.hash = ''; }); await page.waitForFunction(() => document.body.dataset.sub === 'main');
  ok(await page.$eval('#list', l => getComputedStyle(l).display !== 'none') && await page.$eval('#pbfold', l => getComputedStyle(l).display === 'none'), 'back on the list, the script fold is hidden by the top bar');
  ok(await page.$$eval('#main *', els => els.every(e => { const r = parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0; return r <= 8 || getComputedStyle(e).borderTopLeftRadius.includes('%'); })), 'no corner radius above 8px on the page');
  await cx.close();

  /* dark + phone */
  const d = await open({ width: 1440, height: 900 });
  await d.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  if (shots) await d.page.screenshot({ path: path.join(shots, 'leads-1440-dark.png') });
  await d.cx.close();
  const ph = await open({ width: 390, height: 844 });
  const card = await ph.page.$eval('#rows tr[data-id]', tr => ({ disp: getComputedStyle(tr).display, w: tr.getBoundingClientRect().width, head: getComputedStyle(document.querySelector('.crm thead')).display }));
  ok(card.disp === 'grid' && card.head === 'none' && card.w <= 390, 'at phone width each lead is a card', JSON.stringify(card));
  ok(await ph.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390px', String(await ph.page.evaluate(() => document.documentElement.scrollWidth)));
  await ph.page.selectOption('#rows tr[data-id] select[data-f="owner"]', 'ריצארד');
  await ph.page.waitForSelector('#rows .ss.saved', { timeout: 4000 }); ok(true, 'inline edit works on the card');
  if (shots) await ph.page.screenshot({ path: path.join(shots, 'leads-390.png') });
  await ph.cx.close();
  ok(blocked.length === 0, 'the page asked for nothing outside its own files and the API', blocked.slice(0, 3).join(' '));
} catch (e) { fail++; console.log('  ✗ crashed: ' + (e && e.stack || e)); }
await browser.close(); server.close();
console.log(`\n${n - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
