/* admin pay-link generator smoke test (03/11). Plain node, no browser:
   node --check the page modules, load the real config.js + assets/paylink-gen.js
   in a sandbox, render the generator to an HTML string across states and check
   prices, required fields, the WhatsApp text, and that nothing leaks
   undefined/NaN or a native select/checkbox. Exit 0 = all checks passed.
   Usage: node scripts/paylink-ui-smoke.mjs */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (c, name, extra = '') => { if (c) { passes++; console.log('  ✓ ' + name); } else { fails++; console.log('  ✗ ' + name + (extra ? ' · ' + extra : '')); } };

console.log('syntax');
for (const f of ['assets/paylink-gen.js', 'assets/playbook.js', 'config.js']) {
  const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' });
  ok(r.status === 0, 'node --check ' + f, r.stderr);
}

const sb = { window: {}, document: undefined, location: { hostname: 'ishur.io', search: '' }, console };
sb.window = sb; sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(readFileSync(join(ROOT, 'config.js'), 'utf8'), sb);
vm.runInContext(readFileSync(join(ROOT, 'assets/paylink-gen.js'), 'utf8'), sb);
const G = sb.IshurPayLinkGen, CFG = sb.ISHUR_CONFIG;
ok(!!G && !!CFG, 'config + generator load');

console.log('render');
const clean = (h) => !/undefined|NaN|\[object Object\]/.test(h);
const s0 = G.fresh();
const h0 = G.render(s0, CFG);
ok(clean(h0), 'empty state renders clean');
ok(!/<select|type="checkbox"/.test(h0 + readFileSync(join(ROOT, 'assets/paylink-gen.js'), 'utf8')), 'no native select / checkbox');
ok(/data-plg="make"[^>]*disabled/.test(h0), '"צור קישור" disabled until name/phone/occasion');
ok(/שם לקוח/.test(h0) && /טלפון נייד ישראלי/.test(h0) && /סוג אירוע/.test(h0), 'missing fields listed');
for (const k of ['plan', 'records', 'hostesses', 'occasion']) {
  const h = G.render({ ...s0, open: k }, CFG);
  ok(clean(h) && /role="listbox"/.test(h), 'dropdown ' + k + ' opens');
}
const recOpen = G.render({ ...s0, open: 'records' }, CFG);
ok(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'].every((n) => recOpen.includes('data-v="' + n + '"')), 'records = config tiers 50..900');
const hostOpen = G.render({ ...s0, open: 'hostesses' }, CFG);
ok(/data-v="3" disabled/.test(hostOpen), '3 hostesses shown but disabled (no price in config)');

console.log('pricing');
const s1 = { ...s0, plan: 'basic', records: 100, design: true, hostesses: 2, name: 'דנה כהן', phone: '050-1234567', occasion: 'wedding' };
const p1 = G.price(s1, CFG);
ok(p1.total === 99 + 79 + 1990, 'basic 100 + design + 2 hostesses = 2168', String(p1.total));
const h1 = G.render(s1, CFG);
ok(clean(h1) && !/data-plg="make"[^>]*disabled/.test(h1), 'filled form enables "צור קישור"');
ok(h1.includes('₪2,168') || h1.includes('₪2168'), 'total shown', h1.match(/סה"כ<\/span><span>[^<]*/)?.[0]);
const s2 = { ...s1, plan: 'premium', records: 300, design: false, hostesses: 1, travel: true, extra_wave: true, calls: true };
ok(G.price(s2, CFG).total === 449 + 1790 + 250 + 110, 'premium 300 + 1 hostess + travel + wave, calls included = 2599', String(G.price(s2, CFG).total));
ok(/כלול בחבילה/.test(G.render(s2, CFG)), 'calls toggle says included for premium');
const pl = G.payload(s2);
ok(pl.addons.calls === false && pl.addons.travel === true && pl.records === 300 && pl.phone === '050-1234567', 'payload: no calls on premium, travel kept, records numeric');
ok(G.payload({ ...s1, travel: true, hostesses: 0 }).addons.travel === false, 'payload: travel dropped without hostesses');
ok(G.problems({ ...s1, phone: '03-1234567' }).length === 1, 'landline rejected');

console.log('result + whatsapp');
const s3 = { ...s1, url: 'https://pay.grow.link/X', desc: '100 רשומות בסיס + עיצוב הזמנה + 2 דיילות', serverSum: 2168 };
const h3 = G.render(s3, CFG);
ok(clean(h3) && /data-plg="copy"/.test(h3) && /data-plg="wa"/.test(h3), 'link shown with copy + WhatsApp buttons');
const wa = G.waHref('050-1234567', 'https://pay.grow.link/X');
ok(wa.startsWith('https://wa.me/972501234567?text='), 'wa.me with the client number in 972 form', wa);
ok(decodeURIComponent(wa.split('text=')[1]) === 'היי, בהמשך לשיחה שלנו, זה הקישור לתשלום: https://pay.grow.link/X', 'exact WhatsApp text');
ok(!/fetch\([^)]*wa\.me/.test(readFileSync(join(ROOT, 'assets/paylink-gen.js'), 'utf8')), 'WhatsApp is a link only, nothing auto-sent');

console.log('mounted');
ok(/IshurPayLinkGen\.mount\('pl-gen'/.test(readFileSync(join(ROOT, 'assets/playbook.js'), 'utf8')), 'playbook mounts the generator');
for (const f of ['admin.html', 'leads.html']) ok(readFileSync(join(ROOT, f), 'utf8').includes('assets/paylink-gen.js'), f + ' loads paylink-gen.js');

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
