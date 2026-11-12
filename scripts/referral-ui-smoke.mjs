/* הזמן חבר UI smoke (12/11, spec P4). Plain node, no browser:
   1. config.js helpers: 30 prices at 80%, the 30-key GROW_LINKS_REF map, refCode from ?ref= and from the old utm link.
   2. index.html's IshurRef module, extracted and run in a sandbox with a stubbed Worker:
      discount → renderPlans is repainted with the struck price and the "הנחת חבר של <name>" tag;
      commission → the plain render is byte-identical to a visitor with no code; unknown code → store forgotten.
   3. popup.js checkout wiring (static): refGrowLink + cField3 + ref-touch + payViaQuote(ref).
   4. dashboard.html + share.html (static + sandbox): default copies, למימוש hidden at 0, six render specs with a QR.
   Exit 0 = every check passed. Usage: node scripts/referral-ui-smoke.mjs */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (c, name, extra = '') => { if (c) { passes++; console.log('  ✓ ' + name); } else { fails++; console.log('  ✗ ' + name + (extra ? ' · ' + extra : '')); } };
const read = f => readFileSync(join(ROOT, f), 'utf8');

console.log('syntax');
for (const f of ['config.js', 'assets/popup.js']) { const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' }); ok(r.status === 0, 'node --check ' + f, r.stderr); }

function cfgWith(search) {
  const sb = { window: {}, location: { hostname: 'ishur.io', search }, console };
  sb.window = sb; sb.globalThis = sb; vm.createContext(sb);
  vm.runInContext(read('config.js'), sb);
  return sb.ISHUR_CONFIG;
}
console.log('config.js');
const CFG = cfgWith('');
ok(Object.keys(CFG.GROW_LINKS_REF).length === 30 && Object.values(CFG.GROW_LINKS_REF).every(v => v === ''), 'GROW_LINKS_REF: 30 keys, all empty until Richard pastes the pages');
let n = 0, bad = [];
for (const t of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) for (const p of ['basic', 'pro', 'premium']) {
  const full = CFG.priceFor(t, p), r = CFG.refPrice(t, p); n++;
  if (!(r.applies && r.final === Math.round(full * 0.8) && r.saved === full - r.final)) bad.push(`${t}_${p}`);
}
ok(n === 30 && !bad.length, '30 package prices at 80%, whole shekels', bad.join(','));
ok(CFG.refPrice(300, 'pro').final === 303 && CFG.refPrice(50, 'basic').final === 40, '₪379 → ₪303, ₪50 → ₪40');
ok(CFG.refGrowLink(300, 'pro', 'abcd1234') === null, 'no page yet → null (popup mints a link)');
ok(cfgWith('?ref=ABCD1234').refCode() === 'abcd1234', '?ref= read and lowercased');
ok(cfgWith('?utm_source=referral&utm_medium=friend&utm_campaign=0123abcd').refCode() === '0123abcd', 'old share link still counts');
ok(cfgWith('?ref=nope').refCode() === '', 'a malformed code is ignored');
ok(CFG.refLink('abcd1234') === 'https://ishur.io/?ref=abcd1234', 'refLink');

console.log('index.html · IshurRef');
const html = read('index.html');
const m = html.match(/const IshurRef=\(\(\)=>\{[\s\S]*?\}\)\(\);\nwindow\.IshurRef=IshurRef;/);
ok(!!m, 'IshurRef module present');
ok(/const friend=!\(pr&&pr\.applies\)&&price!=null&&window\.IshurRef&&IshurRef\.discount\(\)/.test(html), 'renderPlans asks IshurRef when no campaign offer applies');
ok(/IshurRef\.tag\(\)\+' · '/.test(html), 'card shows the הנחת חבר tag');
ok(/config\.js\?v=83/.test(html) && /popup\.js\?v=43/.test(html), 'cache-bust bumped (config v83, popup v43)');

async function runRef({ search, answer }) {
  const calls = [];
  const sb = { window: {}, location: { hostname: 'ishur.io', search }, console, painted: [], store: {} };
  sb.window = sb; sb.globalThis = sb;
  sb.sessionStorage = { getItem: k => sb.store[k] ?? null, setItem: (k, v) => { sb.store[k] = String(v); }, removeItem: k => { delete sb.store[k]; } };
  sb.localStorage = sb.sessionStorage;
  sb.document = { getElementById: () => ({ value: '300' }), readyState: 'complete', addEventListener() {} };
  sb.fetch = async (u) => { calls.push(String(u)); return { json: async () => answer }; };
  sb.push = () => {};
  vm.createContext(sb);
  vm.runInContext(read('config.js'), sb);
  sb.CFG = sb.ISHUR_CONFIG;
  /* a renderPlans stand-in that renders exactly the price span index.html renders */
  vm.runInContext(`
    function renderPlans(guests){
      const offer=null; const out=[];
      for(const k of CFG.PLAN_ORDER){
        const price=CFG.priceFor(guests,k);
        let pr=(offer&&price!=null)?CFG.offerPrice(offer,guests,k):null;
        const friend=!(pr&&pr.applies)&&price!=null&&window.IshurRef&&IshurRef.discount();
        if(friend) pr=IshurRef.price(guests,k);
        const cut=!!(pr&&pr.applies);
        out.push(cut?'<span class="was">₪'+pr.original+'</span><span class="now">₪'+pr.final+'</span><span class="promo-save">'+(friend?IshurRef.tag()+' · ':'')+'חסכתם '+pr.saved+' ש״ח</span>':'₪'+price);
      }
      painted.push(out.join('|'));
    }`, sb);
  vm.runInContext(m[0], sb);
  await new Promise(r => setTimeout(r, 20));
  sb.renderPlansNow = () => vm.runInContext("renderPlans('300')", sb);
  sb.renderPlansNow();
  return { sb, calls, last: sb.painted[sb.painted.length - 1], painted: sb.painted };
}
const plain = await runRef({ search: '', answer: { ok: false } });
ok(plain.calls.length === 0 && plain.last === '₪299|₪379|₪449', 'no code: no Worker call, list prices', plain.last);
const disc = await runRef({ search: '?ref=abcd1234', answer: { ok: true, mode: 'discount', name_first: 'דנה' } });
ok(disc.calls.length === 1 && /\/referral\?code=abcd1234$/.test(disc.calls[0]), 'discount code: one GET /api/referral?code=', disc.calls.join());
ok(disc.painted.length >= 2, 'the page is repainted once the Worker answers');
ok(disc.last === '<span class="was">₪299</span><span class="now">₪239</span><span class="promo-save">הנחת חבר של דנה · חסכתם 60 ש״ח</span>|<span class="was">₪379</span><span class="now">₪303</span><span class="promo-save">הנחת חבר של דנה · חסכתם 76 ש״ח</span>|<span class="was">₪449</span><span class="now">₪359</span><span class="promo-save">הנחת חבר של דנה · חסכתם 90 ש״ח</span>', 'struck price + 80% + "הנחת חבר של דנה" on all three cards', disc.last);
const com = await runRef({ search: '?ref=abcd1234', answer: { ok: true, mode: 'commission', name_first: 'דנה' } });
ok(com.last === plain.last, 'commission mode: render identical to a plain visitor');
ok(vm.runInContext('IshurRef.active() && IshurRef.mode()==="commission" && IshurRef.code()==="abcd1234"', com.sb), 'commission: still active for checkout attribution');
const unk = await runRef({ search: '?ref=ffffffff', answer: { ok: false } });
ok(unk.last === plain.last && unk.sb.store.ishur_ref === undefined, 'unknown code: plain prices, store forgotten');

console.log('popup.js · checkout');
const pop = read('assets/popup.js');
ok(/CFG\.refGrowLink\(S\.guests, S\.plan, rc\)/.test(pop), 'discount → the 80% Grow page');
ok(/payViaQuote\(fields, \{ ref: rc, design: !!S\.design \}\)/.test(pop), 'no page yet → minted 80% link with ref');
ok(/'cField3=' \+ encodeURIComponent\('ref:' \+ rc\)/.test(pop), 'commission → normal page + cField3');
ok(/function refTouch\(fields, next\)/.test(pop) && /endpoint\('ref-touch'\)/.test(pop) && /setTimeout\(go, 1500\)/.test(pop), 'ref-touch before redirect, 1.5s cap');
ok(/if \(!pr\.applies && window\.IshurRef && IshurRef\.discount\(\) && CFG\.refPrice\) pr = CFG\.refPrice\(guests, plan\)/.test(pop), 'popup total uses the friend price');
ok(/IshurGuard\.stamp\(body\)/.test(pop.slice(pop.indexOf('function refTouch'), pop.indexOf('function refTouch') + 600)), 'ref-touch is stamped');

if (existsSync(join(ROOT, 'share.html'))) {
  console.log('dashboard.html + share.html');
  const dash = read('dashboard.html'), share = read('share.html');
  ok(/חברים חסכו ₪0/.test(dash) && /הרווחתם ₪0/.test(dash), 'dashboard default copies present');
  ok(/id="refRedeem"[^>]*hidden/.test(dash), 'למימוש hidden by default (shown when balance > 0)');
  ok(/20% הנחה לחברים/.test(dash) && /20% עמלה לי/.test(dash), 'the two choices');
  ok(/לא במזומן/.test(dash), 'small print: credit, not cash');
  ok(/qrcode(js)?[^"']*\.min\.js/.test(share) || /QRCode/.test(share), 'share.html loads a QR library');
  const specs = share.match(/\{\s*key:\s*'(story|square|wa)'/g) || [];
  ok(specs.length === 3 && /1080,\s*h:\s*1920/.test(share) && /1080,\s*h:\s*1080/.test(share) && /1200,\s*h:\s*630/.test(share), 'three sizes: 1080×1920, 1080×1080, 1200×630', specs.join());
  ok(/20% הנחה על כל החבילות/.test(share), 'discount variant copy');
  ok(/state\.v === 'discount' \? /.test(share) && /ההמלצה של/.test(share), 'commission variant branch (no discount wording)');
  ok(/ishur\.io\/\?ref=/.test(share), 'the link text on the image');
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
