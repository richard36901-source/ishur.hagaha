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
/* config.js HOSTESS.tiers: 1 hostess ₪1,790, 2 hostesses ₪1,990 (Richard 20/10:
   "no third tier"). A count with no price here is refused, never guessed. */
export const HOSTESS_PRICE = { 1: 1790, 2: 1990 };
/* config.js HOSTESS.travelFor: per booking, ₪250 for one hostess, ₪500 for two+ */
export const travelFor = n => (n >= 2 ? 500 : 250);
export const DESIGN_PRICE = 79;
/* worker ADDON_RATES (Shalev 10/09): 0.30/message + 20 per round; 2/AI call + 20 */
export const RATES = { msg: 0.30, call: 2, base: 20 };
/* plans that already include an AI call round (config.js ADDONS.calls.plans) */
const CALLS_INCLUDED = ['pro', 'premium'];
export const OCCASION_HE = { wedding: 'חתונה', hina: 'חינה', bar: 'בר מצווה', bat: 'בת מצווה', brit: 'ברית / בריתה', bday: 'יום הולדת', chalaka: 'חלאקה', chala: 'הפרשת חלה', biz: 'אירוע עסקי', other: 'אחר' };

export function ilPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^05\d{8}$/.test(d)) return '972' + d.slice(1);
  if (/^9725\d{8}$/.test(d)) return d;
  return '';
}

/* body → { ok, quote } | { ok:false, why }. Pure; the route adds id + link. */
export function priceQuote(b) {
  b = b || {};
  const plan = String(b.plan || '');
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
  const hostesses = a.hostesses == null ? 0 : Number(a.hostesses);
  if (!Number.isInteger(hostesses) || hostesses < 0 || hostesses > 3) return { ok: false, why: 'bad-hostesses' };
  if (hostesses && !HOSTESS_PRICE[hostesses]) return { ok: false, why: 'hostesses-unpriced' };
  const travel = !!a.travel;
  if (travel && !hostesses) return { ok: false, why: 'travel-without-hostesses' };
  const design = !!a.design, extra_wave = !!a.extra_wave;
  const calls = !!a.calls && !CALLS_INCLUDED.includes(plan);

  const lines = [{ key: 'pkg', label: `${records} רשומות ${PLAN_HE[plan]}`, price: PKG_PRICES[records][plan] }];
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
export const SITE_PARAMS = ['plan', 'guests', 'hostess', 'design', 'calls', 'occasion', 'date', 'city', 'name', 'phone', 'src'];
export function siteLink(p, base = 'https://ishur.io/') {
  const u = new URL(base);
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '' && v !== false) u.searchParams.set(k, String(v)); };
  set('plan', PLAN_HE[p.plan] ? p.plan : '');
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
