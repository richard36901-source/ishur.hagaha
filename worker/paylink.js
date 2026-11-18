/* ══ pay links v2 (03/11) ═════════════════════════════════════════════════
   Structured admin pay links: the server prices the quote from the tables
   below (never a client sum), writes a human description for the Grow page
   and a machine code that rides in cField1 next to the quote id, so the IPN
   knows exactly what was bought instead of guessing from words.
   Incident that started this: "100 רשומות בסיס + עיצוב הזמנה" went down the
   design-only path and no event was created.

   Prices mirror config.js (PRICE_TABLE, HOSTESS.tiers, HOSTESS.travelFor,
   DESIGN_PRICE) and the worker's ADDON_RATES. Keep them in sync. */

export const PKG_PRICES = { 50: { basic: 50, pro: 95, premium: 140 }, 100: { basic: 99, pro: 149, premium: 199 }, 200: { basic: 199, pro: 279, premium: 339 }, 300: { basic: 299, pro: 379, premium: 449 }, 400: { basic: 399, pro: 489, premium: 559 }, 500: { basic: 499, pro: 589, premium: 669 }, 600: { basic: 599, pro: 699, premium: 789 }, 700: { basic: 699, pro: 819, premium: 919 }, 800: { basic: 799, pro: 929, premium: 1049 }, 900: { basic: 899, pro: 1049, premium: 1179 } };
export const RECORD_TIERS = Object.keys(PKG_PRICES).map(Number);
export const PLAN_HE = { basic: 'בסיס', pro: 'פרמיום', premium: 'הכל כלול' };
/* config.js HOSTESS.tiers list prices, used only when no bundle is live (after
   the winter end date). A count with no price here is refused, never guessed. */
export const HOSTESS_PRICE = { 1: 1790, 2: 1990 };
/* config.js HOSTESS.travelFor: per booking, ₪250 for one hostess, ₪500 for two+ */
export const travelFor = n => (n >= 2 ? 500 : 250);
export const DESIGN_PRICE = 79;
/* worker ADDON_RATES (Shalev 10/09): 0.30/message + 20 per round; 2/AI call + 20 */
export const RATES = { msg: 0.30, call: 2, base: 20 };
/* plans that already include an AI call round (config.js ADDONS.calls.plans) */
const CALLS_INCLUDED = ['pro', 'premium'];
export const OCCASION_HE = { wedding: 'חתונה', hina: 'חינה', bar: 'בר מצווה', bat: 'בת מצווה', brit: 'ברית / בריתה', bday: 'יום הולדת', chalaka: 'חלאקה', chala: 'הפרשת חלה', biz: 'אירוע עסקי', other: 'אחר' };

/* config.js BUNDLES mirror (and the hostess-check route reads these). Keep in sync.
   Richard 03/11 20:20 (final): with hostesses the deal IS a bundle = הכל כלול
   (3 call rounds) + hostesses at one price, design free. Price by records:
   up to 700 → 1 hostess ₪1,790 / 2 hostesses ₪1,990; above 700 → 2 hostesses
   ₪2,390 / 3 hostesses ₪2,590 (3 exist only above 700). */
const UP_TO_700 = [50, 100, 200, 300, 400, 500, 600, 700], ABOVE_700 = [800, 900];
const WINTER_END = '2026-11-30T23:59:59+02:00';
export const BUNDLES = {
  vip1990: { plan: 'premium', hostesses: 2, guests: [300, 400, 500], total: 1990, name: 'מבצע 1990 · הכל כלול + 2 דיילות' },
  winter1990: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 2, guests: UP_TO_700, total: 1990, name: 'מבצע 1990 · הכל כלול + 2 דיילות', until: WINTER_END },
  winter1790: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 1, guests: UP_TO_700, total: 1790, name: 'מבצע 1790 · הכל כלול + דיילת אחת', until: WINTER_END },
  winter2390: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 2, guests: ABOVE_700, total: 2390, name: 'מבצע 2390 · הכל כלול + 2 דיילות', until: WINTER_END },
  winter2590: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 3, guests: ABOVE_700, total: 2590, name: 'מבצע 2590 · הכל כלול + 3 דיילות', until: WINTER_END },
};
export const BIG_FROM = 701;
/* the hostess counts a records tier can take, and their bundle price */
export function bundleTable(records) { return Number(records) >= BIG_FROM ? { 2: 2390, 3: 2590 } : { 1: 1790, 2: 1990 }; }
/* a requested count → one the tier allows, with a note when it had to move */
export function coerceHostesses(records, n) {
  n = Number(n) || 0;
  if (n <= 0) return { n: 0, note: '' };
  /* Richard 03/11 20:25: from 300 records two hostesses are mandatory (one is only for smaller events) */
  if (n === 1 && Number(records) >= HOSTESS_TWO_FROM && Number(records) < BIG_FROM) return { n: 2, note: 'מ-300 רשומות חובה 2 דיילות: עודכן ל-2' };
  if (bundleTable(records)[n]) return { n, note: '' };
  if (Number(records) >= BIG_FROM) return { n: 2, note: 'מעל 700 רשומות: מינימום 2 דיילות' };
  return { n: 2, note: '3 דיילות רק מעל 700 רשומות: עודכן ל-2' };
}
export const BUNDLE_CAP = 2590;
export const bundleLive = (b, now = Date.now()) => !!b && (!b.until || now <= Date.parse(b.until));
/* the live bundle for records + hostess count; the dated winter deals first */
export function pickBundle(records, hostesses, now = Date.now()) {
  const order = ['vip1990', 'winter1990', 'winter1790', 'winter2390', 'winter2590'];
  for (const k of order) { const b = BUNDLES[k]; if (bundleLive(b, now) && b.hostesses === hostesses && b.guests.includes(Number(records))) return k; }
  return '';
}
export const BUNDLE_NO_CALLS = 'חבילה + דיילות, בלי שיחות';
export const DESIGN_GIFT = 'עיצוב ההזמנה במתנה';

export function ilPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^05\d{8}$/.test(d)) return '972' + d.slice(1);
  if (/^9725\d{8}$/.test(d)) return d;
  return '';
}

/* body → { ok, quote } | { ok:false, why }. Pure; the route adds id + link. */
export function priceQuote(b) {
  b = b || {};
  /* no plan given: Richard's calls rule picks it (0 → basic, 1 → pro, 3 → premium) */
  const plan = !b.plan && b.calls_rounds != null ? recommendPlan({ calls_rounds: b.calls_rounds }) : String(b.plan || '');
  if (!PLAN_HE[plan]) return { ok: false, why: 'bad-plan' };
  const records = Number(b.records);
  if (!PKG_PRICES[records]) return { ok: false, why: 'bad-records' };
  const phone = ilPhone(b.phone);
  if (!phone) return { ok: false, why: 'bad-phone' };
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 2) return { ok: false, why: 'bad-name' };
  const occasion = String(b.occasion || '').trim().slice(0, 30);
  const event_date = String(b.event_date || '').trim();
  if (event_date && (!/^\d{4}-\d{2}-\d{2}$/.test(event_date) || isNaN(Date.parse(event_date + 'T00:00:00Z')))) return { ok: false, why: 'bad-date' };
  const a = b.addons || {};
  const h0 = a.hostesses == null ? 0 : Number(a.hostesses);
  if (!Number.isInteger(h0) || h0 < 0 || h0 > 3) return { ok: false, why: 'bad-hostesses' };
  const travel = !!a.travel;
  if (travel && !h0) return { ok: false, why: 'travel-without-hostesses' };
  const design = !!a.design, extra_wave = !!a.extra_wave;
  const now = b.now || Date.now();
  if (b.bundle && BUNDLES[String(b.bundle)] && !bundleLive(BUNDLES[String(b.bundle)], now)) return { ok: false, why: 'bundle-off' };

  /* Richard 03/11 20:20: hostesses → always the bundle. הכל כלול unless the lead
     explicitly wants no calls at all (same price, plan basic). Design free,
     calls never an add-on; a third wave and travel may ride on top. */
  const co = coerceHostesses(records, h0);
  const bk = h0 ? pickBundle(records, co.n, now) : '';
  if (bk) {
    const bd = BUNDLES[bk], hostesses = co.n, noCalls = !!(b.no_calls || a.no_calls);
    const bplan = noCalls ? 'basic' : bd.plan;
    const hl = hostesses === 1 ? 'דיילת' : hostesses + ' דיילות';
    const blines = [{ key: 'bundle', label: noCalls ? `${records} רשומות · ${BUNDLE_NO_CALLS} (${hl})` : `${records} רשומות ${PLAN_HE[bplan]} כולל ${hl} · ${bd.name}`, price: bd.total }];
    if (design) blines.push({ key: 'design', label: DESIGN_GIFT, price: 0 });
    if (travel) blines.push({ key: 'travel', label: 'נסיעות דיילות', price: bd.travel != null ? bd.travel : travelFor(hostesses) });
    if (extra_wave) blines.push({ key: 'wave', label: 'גל תזכורת שלישי', price: Math.ceil(RATES.msg * records + RATES.base) });
    const sum = blines.reduce((s2, l) => s2 + l.price, 0);
    const code = buildCode({ plan: bplan, records, design, hostesses, travel, extra_wave, calls: false });
    return { ok: true, quote: { plan: bplan, records, design, hostesses, travel, extra_wave, calls: false, no_calls: noCalls, bundle: bk, bundle_name: noCalls ? BUNDLE_NO_CALLS : bd.name, bundle_price: bd.total,
      ...(co.note ? { note: co.note, hostesses_asked: h0 } : {}), name, phone, occasion, event_date,
      lines: blines, sum, description: blines.map(l => l.label).join(' + '), code } };
  }
  /* no live bundle (after the winter end date): list prices, 1-2 hostesses only */
  const hostesses = h0;
  if (hostesses && !HOSTESS_PRICE[hostesses]) return { ok: false, why: 'hostesses-unpriced' };
  const calls = !!a.calls && !CALLS_INCLUDED.includes(plan);

  /* 12/11 הזמן חבר: discount_pct (20) takes the package line to 80%, whole shekels; add-ons stay at list */
  const dp = Math.max(0, Math.min(50, Number(b.discount_pct) || 0));
  const pkgPrice = dp ? Math.round(PKG_PRICES[records][plan] * (100 - dp) / 100) : PKG_PRICES[records][plan];
  const lines = [{ key: 'pkg', label: `${records} רשומות ${PLAN_HE[plan]}${dp ? ' · הנחת חבר' : ''}`, price: pkgPrice, ...(dp ? { list: PKG_PRICES[records][plan], discount_pct: dp } : {}) }];
  if (design) lines.push({ key: 'design', label: 'עיצוב הזמנה', price: DESIGN_PRICE });
  if (hostesses) lines.push({ key: 'host', label: hostesses === 1 ? 'דיילת אחת' : `${hostesses} דיילות`, price: HOSTESS_PRICE[hostesses] });
  if (travel) lines.push({ key: 'travel', label: 'נסיעות דיילות', price: travelFor(hostesses) });
  /* wording avoids "שליחה נוספת" / "סבב שיחות": parseAddonDesc would read
     those as an add-on to an existing event */
  if (extra_wave) lines.push({ key: 'wave', label: 'גל תזכורת שלישי', price: Math.ceil(RATES.msg * records + RATES.base) });
  if (calls) lines.push({ key: 'calls', label: 'שיחות AI למי שלא ענה', price: Math.ceil(RATES.call * records + RATES.base) });
  const sum = lines.reduce((s, l) => s + l.price, 0);
  const description = lines.map(l => l.label).join(' + ');
  const code = buildCode({ plan, records, design, hostesses, travel, extra_wave, calls });
  return { ok: true, quote: { plan, records, design, hostesses, travel, extra_wave, calls, name, phone, occasion, event_date, lines, sum, description, code } };
}

export function buildCode(q) {
  return `pkg:${q.plan}:${q.records};design:${q.design ? 1 : 0};host:${q.hostesses || 0};travel:${q.travel ? 1 : 0};wave:${q.extra_wave ? 1 : 0};calls:${q.calls ? 1 : 0}`;
}

/* "q:<id>|pkg:basic:100;design:1;..." anywhere in the custom fields →
   { id, code: {plan, records, design, hostesses, travel, extra_wave, calls} } */
export function readQuoteRef(flat) {
  flat = flat || {};
  const all = ['cField1', 'cfield1', 'customField1', 'cField2', 'cField3', 'note'].map(k => String(flat[k] || '')).join(' ');
  const idm = all.match(/\bq:([0-9a-f]{12})\b/);
  const pm = all.match(/pkg:(basic|pro|premium):(\d{2,4})((?:;[a-z_]+:\d+)*)/);
  let code = null;
  if (pm) {
    const kv = {}; for (const part of pm[3].split(';').filter(Boolean)) { const [k, v] = part.split(':'); kv[k] = Number(v) || 0; }
    code = { plan: pm[1], records: Number(pm[2]), design: !!kv.design, hostesses: Math.min(3, kv.host || 0), travel: !!kv.travel, extra_wave: !!kv.wave, calls: !!kv.calls };
  }
  if (!idm && !code) return null;
  return { id: idm ? idm[1] : '', code };
}

/* 12/11 security: cField1 travels through the payer's browser (a Grow link takes ?cField1=…), so a code or a
   quote id found in an IPN is a CLAIM, not a fact. It is honoured only when the money that actually arrived
   covers the cheapest legitimate price of what it claims: the stored quote's own sum, or — when the KV row is
   gone — the server price of the code with the friend discount, now and one quote-lifetime (30 d) ago.
   → { ok, expected, paid }. ok:false = treat the payment by its description and raise a hand. */
export function purchaseCovered(p, paidRaw, now = Date.now()) {
  const paid = Number(String(paidRaw == null ? '' : paidRaw).replace(/[^\d.]/g, ''));
  let expected = null;
  if (p && p.sum != null && Number.isFinite(Number(p.sum)) && Number(p.sum) > 0) expected = Number(p.sum);
  else if (p && p.plan && p.records) {
    const sums = [];
    for (const at of [now, now - 30 * 86400e3]) for (const no_calls of [false, true]) {
      const r = priceQuote({ plan: p.plan, records: p.records, phone: '0500000000', name: 'xx', discount_pct: 20, no_calls, now: at,
        addons: { hostesses: Number(p.hostesses) || 0, design: !!p.design, travel: !!p.travel, extra_wave: !!p.extra_wave, calls: !!p.calls } });
      if (r.ok) sums.push(r.quote.sum);
    }
    if (sums.length) expected = Math.min(...sums);
  }
  if (expected == null || !Number.isFinite(paid)) return { ok: false, expected, paid: Number.isFinite(paid) ? paid : null };
  return { ok: paid + 1 >= expected, expected, paid };
}

/* free-form description has a package in it ("100 רשומות בסיס …")? */
export function descHasPackage(d) { return /\d{2,4}\s*(?:מוזמנים|רשומות)/.test(String(d || '')); }

function fmtDate(d) { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }
export function addonList(q) {
  const out = [];
  if (q.design) out.push('עיצוב הזמנה');
  if (q.hostesses) out.push(q.hostesses === 1 ? 'דיילת אחת' : `${q.hostesses} דיילות`);
  if (q.travel) out.push('נסיעות');
  if (q.extra_wave) out.push('גל שלישי');
  if (q.calls) out.push('שיחות AI');
  return out;
}

/* the one Slack line a closed sale gets */
export function closeMessage({ name, phone, occasion, event_date, plan, records, addons, sum, token }) {
  const local = String(phone || '').replace(/^972/, '0');
  const occ = OCCASION_HE[occasion] || String(occasion || '').trim() || 'אירוע';
  const list = (addons || []).length ? addons.join(', ') : 'ללא';
  return `🎉 נסגר: ${name || 'ללא שם'} · ${local} · ${occ} ${fmtDate(event_date) || 'תאריך טרם'} · חבילה ${PLAN_HE[plan] || plan || '?'} · ${records || '?'} רשומות · תוספות: ${list} · ₪${sum || '?'} · https://ishur.io/dashboard.html?t=${token} · https://ishur.io/upload.html?t=${token}`;
}

/* ══ sales flow + site prefill (03/11) ══════════════════════════════════════
   Richard's plan rule: no call round → basic, one round → pro, three → premium.
   Hostesses and design never move the plan; they are add-ons on top. */
export function recommendPlan({ calls_rounds = 0 } = {}) {
  const c = Number(calls_rounds) || 0;
  return c >= 3 ? 'premium' : c >= 1 ? 'pro' : 'basic';
}
/* the no-reply fallback offer is never premium (Richard 03/11) */
export function fallbackPlan({ calls_rounds = 0 } = {}) {
  return (Number(calls_rounds) || 0) >= 1 ? 'pro' : 'basic';
}
/* Richard 03/11, global: hostesses wanted → under 300 records one, 300+ two */
export const HOSTESS_TWO_FROM = 300;
export function hostessesFor(records, wanted = true) {
  if (!wanted) return 0;
  const n = Number(records) || 0;
  return n >= HOSTESS_TWO_FROM ? 2 : 1;
}
/* a guest count → the next records tier up (650 → 700); null above the table */
export function tierFor(n) {
  const g = Math.ceil(Number(n) || 0);
  if (g <= 0) return null;
  return RECORD_TIERS.find(t => t >= g) || null;
}

/* the editable site prefill link (index.html reads exactly these params) */
export const SITE_PARAMS = ['offer', 'plan', 'guests', 'hostess', 'design', 'calls', 'occasion', 'date', 'city', 'name', 'phone', 'src'];
export function siteLink(p, base = 'https://ishur.io/') {
  const u = new URL(base);
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '' && v !== false) u.searchParams.set(k, String(v)); };
  set('offer', BUNDLES[p.bundle] ? p.bundle : '');
  set('plan', !p.bundle && PLAN_HE[p.plan] ? p.plan : '');
  set('guests', PKG_PRICES[p.records] ? p.records : '');
  set('hostess', p.hostesses ? Number(p.hostesses) : '');
  set('design', p.design ? 1 : '');
  set('calls', p.calls_rounds ? 1 : '');
  set('occasion', OCCASION_HE[p.occasion] ? p.occasion : '');
  set('date', /^\d{4}-\d{2}-\d{2}$/.test(String(p.event_date || '')) ? p.event_date : '');
  set('city', String(p.city || '').slice(0, 30));
  set('name', String(p.name || '').slice(0, 60));
  const local = String(p.phone || '').replace(/\D/g, '').replace(/^972/, '0');
  set('phone', /^05\d{8}$/.test(local) ? local : '');
  set('src', String(p.src || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 20));
  return u.toString();
}
