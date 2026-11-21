#!/usr/bin/env node
/* 22/11 venue items on the seating plan (Richard: חופה בכל מיני צורות, בר, במה, מטבח; a shape, a name, a colour).
   Opens seating.html from this checkout with the server's answers stubbed in the browser (no real event is touched),
   then does what a client does. Exit 0 = every step passed. Saves screenshots to app/test/shots/seating-venue-*.png.
   PLAYWRIGHT_PATH=… node test/seating-venue-check.mjs */
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2' };
const server = http.createServer((q, r) => { const f = path.normalize(path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname))); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); });
await new Promise(r => server.listen(4190, '127.0.0.1', r));
const TOK = 'aaaaaaaa-0000-4000-8000-000000000001';
let stored = { tables: [{ name: '1', shape: 'round', x: 60, y: 300, w: 120, h: 120, cap: 10 }, { name: '2', shape: 'round', x: 220, y: 300, w: 120, h: 120, cap: 10 }], groups: {}, items: [] };
const saves = [];
const STATUS = { ok: true, event: { name1: 'דנה ויואב', occasion_label: 'חתונה' }, guests: [{ id: 'g1', name: 'משה כהן', seats: 2, status: 'confirmed', table: '' }, { id: 'g2', name: 'רות לוי', seats: 1, status: 'confirmed', table: '1' }] };

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const b = await chromium.launch({ channel: 'chrome' });
const results = []; const ok = (name, cond, info = '') => { results.push([!!cond, name, info]); console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info ? ' · ' + info : ''}`); };
const errors = [];
async function page(width) {
  const ctx = await b.newContext({ viewport: { width, height: width < 600 ? 860 : 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  await p.route(/\/api\/(status|seatplan|seating)(\?|$)/, async route => {
    const u = route.request().url(), body = JSON.parse(route.request().postData() || '{}');
    if (/seatplan/.test(u)) {
      if (Array.isArray(body.tables)) { saves.push(body); stored = { tables: body.tables, groups: body.groups || {}, items: body.items || stored.items }; }
      return route.fulfill({ json: { ok: true, ...stored } });
    }
    if (/seating/.test(u)) return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: STATUS });
  });
  await p.goto(`http://127.0.0.1:4190/seating.html?t=${TOK}`); await p.waitForSelector('.tbl');
  return { ctx, p };
}
const center = async (p, sel) => { const r = await p.locator(sel).first().boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, r }; };

try {
  /* desktop: add four items the way a client does */
  let { ctx, p } = await page(1280);
  const spots = [[900, 120], [1000, 520], [700, 640], [450, 560]];
  for (const [i, kind] of ['chuppah', 'bar', 'stage', 'kitchen'].entries()) {
    await p.click('#addItem'); await p.click(`.kinds [data-kind=${kind}]`);
    await p.mouse.click(1250, 880);               /* close the editor by tapping empty floor, as a person does */
    const c0 = await center(p, `.itm >> nth=${i}`);  /* the new item is on top: move it to its own place */
    await p.mouse.move(c0.x, c0.y); await p.mouse.down(); await p.mouse.move(spots[i][0], spots[i][1], { steps: 8 }); await p.mouse.up();
  }
  ok('four items on the floor', await p.locator('.itm').count() === 4, String(await p.locator('.itm').count()));
  ok('names shown', JSON.stringify(await p.locator('.itm .il').allTextContents()) === JSON.stringify(['חופה', 'בר', 'במה', 'מטבח']), JSON.stringify(await p.locator('.itm .il').allTextContents()));
  ok('the chuppah starts as a hexagon', await p.locator('.itm').first().evaluate(e => e.classList.contains('s-hex')));
  await p.mouse.click(1250, 880);
  let c = await center(p, '.itm >> nth=0');
  await p.mouse.click(c.x, c.y);
  ok('a click opens the editor', await p.locator('.pop #inm').count() === 1);
  await p.click('.pop [data-shape=oct]'); await p.click('.pop [data-color="#cfd8e8"]');
  await p.fill('.pop #inm', 'חופה בגן');
  const first = p.locator('.itm').first();
  ok('shape changed to octagon', await first.evaluate(e => e.classList.contains('s-oct')));
  ok('colour changed', (await first.locator('.shp').evaluate(e => getComputedStyle(e).backgroundColor)) === 'rgb(207, 216, 232)', await first.locator('.shp').evaluate(e => getComputedStyle(e).backgroundColor));
  ok('name changed on the floor', (await first.locator('.il').textContent()) === 'חופה בגן');
  /* a dark colour gets white text */
  await p.click('.pop [data-color="#374151"]');
  ok('dark colour, white text', (await p.locator('.itm').first().locator('.shp').evaluate(e => getComputedStyle(e).color)) === 'rgb(255, 255, 255)');

  /* move the bar */
  c = await center(p, '.itm >> nth=1'); const x0 = c.r.x;
  await p.mouse.move(c.x, c.y); await p.mouse.down(); await p.mouse.move(c.x - 150, c.y + 40, { steps: 8 }); await p.mouse.up();
  const x1 = (await p.locator('.itm').nth(1).boundingBox()).x;
  ok('the bar moved by dragging', Math.abs(x1 - x0 + 150) <= 2, `${x0} → ${x1}`);

  /* resize the stage with its gold handle */
  const st = p.locator('.itm').nth(2); const w0 = (await st.boundingBox()).width;
  await st.hover(); const h = await center(p, '.itm >> nth=2 >> .rz');
  await p.mouse.move(h.x, h.y); await p.mouse.down(); await p.mouse.move(h.x + 60, h.y + 20, { steps: 6 }); await p.mouse.up();
  ok('the stage grew by its handle', Math.abs((await st.boundingBox()).width - w0 - 60) <= 2);

  /* a guest dropped on the chuppah is not seated there */
  const g = await center(p, '.g[data-id=g1]'); c = await center(p, '.itm >> nth=0');
  await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(c.x, c.y, { steps: 10 }); await p.mouse.up();
  ok('a guest dropped on an item stays without a table', !(await p.locator('.g[data-id=g1] .at').count()));

  /* autosave */
  await p.waitForTimeout(2600);
  const last = saves[saves.length - 1] || {};
  ok('saved with the items', (last.items || []).length === 4, String((last.items || []).length));
  const ch = (last.items || [])[0] || {};
  ok('the save carries shape, colour and name', ch.kind === 'chuppah' && ch.shape === 'oct' && ch.color === '#374151' && ch.label === 'חופה בגן', JSON.stringify(ch));
  ok('tables saved unchanged in number', (last.tables || []).length === 2);
  await p.screenshot({ path: path.join(ROOT, 'app', 'test', 'shots', 'seating-venue-desktop.png') });

  /* come back later in a fresh window: everything comes back from the save */
  await ctx.close(); ({ ctx, p } = await page(1280)); await p.waitForSelector('.itm', { timeout: 10000 }).catch(() => {});
  ok('after reload: four items', await p.locator('.itm').count() === 4);
  ok('after reload: the chuppah kept name and shape', (await p.locator('.itm .il').first().textContent()) === 'חופה בגן' && await p.locator('.itm').first().evaluate(e => e.classList.contains('s-oct')));

  /* remove the kitchen with its × */
  await p.locator('.itm').nth(3).hover(); await p.locator('.itm').nth(3).locator('.x').click();
  ok('× removes an item', await p.locator('.itm').count() === 3);
  await ctx.close();

  /* phone width: the toolbar and the picker fit */
  ({ ctx, p } = await page(390));
  ok('phone: the add button is on screen', await p.locator('#addItem').isVisible());
  await p.click('#addItem');
  const box = await p.locator('.tpl').boundingBox();
  ok('phone: the picker fits the screen', box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  ok('phone: no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.screenshot({ path: path.join(ROOT, 'app', 'test', 'shots', 'seating-venue-phone.png') });
  await ctx.close();
  /* Richard 22/11: the language button is chosen in חשבון inside the app; the website keeps it */
  ({ ctx, p } = await page(390)); await p.waitForTimeout(1500);
  ok('website: the language button is shown', await p.locator('#langPick').isVisible().catch(() => false));
  await p.goto(`http://127.0.0.1:4190/seating.html?t=${TOK}&app=1`); await p.waitForSelector('.tbl'); await p.waitForTimeout(1500);
  ok('in the app: no language button on the page', (await p.locator('#langPick').count()) === 0 || !(await p.locator('#langPick').isVisible()));
  await ctx.close();
  ok('no script errors', !errors.length, errors.join(' | '));
} finally { await b.close(); server.close(); }
const fails = results.filter(r => !r[0]).length;
console.log(`${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
