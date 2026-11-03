/* Generates fixtures/ops/{finance,ads,templates,feedback}.json for ops.html?mock=1 by running the REAL
   /api/ops/* handlers over synthetic (fake) data with every network call stubbed. Nothing leaves the
   machine. Usage: node worker/scripts/ops-money-fixtures.mjs */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ilDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(t));
const day = (n) => ilDay(Date.now() - n * 864e5);
const NAMES = ['דנה ואבי', 'משפחת לוי', 'בר מצווה לנועם', 'חינה של שירה', 'יום הולדת 40', 'ברית לאורי', 'חתונת רון ומאיה', 'אירוע חברה'];
const PRICES = [449, 279, 199, 669, 95, 140, 789, 339];
const toks = NAMES.map((_, i) => `${(0xa1b2c3d0 + i).toString(16)}-0000-4000-8000-00000000000${i}`);
function snapshot() {
  return { events: { values: NAMES.map((n, i) => { const ev = Array(50).fill(''); ev[1] = toks[i]; ev[2] = 'לקוח ' + (i + 1); ev[3] = '97250000000' + i; ev[5] = 'חתונה'; ev[6] = day(-10 - i * 4); ev[7] = 'כן'; ev[8] = String(PRICES[i]); ev[25] = day(5 + i * 9) + ' 10:00'; ev[34] = n; ev[31] = 'pro'; if (i % 3 === 0) ev[9] = '4000' + i; return ev; }) }, guests: { values: [] } };
}
const kvInit = {};
for (let i = 0; i < 95; i++) { kvInit['wacost:' + day(i)] = String(8 + (i % 7) * 3); if (i % 2) kvInit['shircost:' + day(i)] = String(150 + (i % 5) * 40); }
for (const [i, m] of [day(0), day(31), day(62), day(93)].map((d, i) => [i, d.slice(0, 7)])) { kvInit['adspend:' + m] = String(1800 - i * 300); kvInit['fixedcost:' + m] = JSON.stringify([{ name: 'Make', ils: 120 }, { name: 'מספרים', ils: 60 }]); kvInit['costman:' + m] = JSON.stringify({ cloudflare: 18, monday: 140, anthropic: 90 }); }
toks.forEach((t, i) => { kvInit['evcost:' + t.slice(0, 8)] = String(2000 + i * 900); if (i % 2 === 0) kvInit['invoice:' + t] = JSON.stringify({ url: 'https://example.invalid/inv/' + i, number: '100' + i, at: day(i) + 'T10:00:00Z' }); });
toks.slice(0, 6).forEach((t, i) => { kvInit['fb:' + t] = JSON.stringify({ nps: [10, 9, 7, 10, 6, 9][i], exp: [9, 10, 8, 9, 7, 10][i], at: day(3 + i * 6) + 'T18:00:00Z', route: i % 2 ? 'review' : 'clip', clicked_review: i % 2 ? '1' : '', note: i === 4 ? 'היה עיכוב בתשובות' : '' }); });
kvInit['fb:' + toks[6]] = JSON.stringify({ left: '1', at: day(2) + 'T18:00:00Z' });
const asg = { rows: Object.fromEntries(toks.slice(0, 4).map((t, i) => ['A' + i, { id: 'A' + i, hostess_id: 'H' + i, event_token: t, date: day(-10 - i * 4), status: i < 2 ? 'paid' : 'confirmed', pay: 600 + i * 150 }])) };
kvInit['crm:t:hostess_assignments'] = JSON.stringify(asg);
kvInit['crm:t:leads'] = JSON.stringify({ rows: Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => ['L' + i, { id: 'L' + i, phone: '97250000000' + i, source: 'meta_form', status: i < 3 ? 'closed' : 'new', created_at: day(4 + i * 3) + 'T09:00:00Z', origin: { campaign: i % 2 ? 'קמפיין שלו' : 'ishur · לידים' } }])) });
kvInit['tplseen'] = JSON.stringify({ 'guests:hazmana_ishur_v3': new Date(Date.now() - 3 * 864e5).toISOString() });
function kv(init) { const m = new Map(Object.entries(init)); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) }; }
const ins = [['120250009883070731', 'ishur · לידים', 'S1', 'רחב 25-45', [['A1', 'וידאו 15ש', 820, 9], ['A2', 'קרוסלה', 410, 3]]], ['120250009883070731', 'ishur · לידים', 'S2', 'ריטרגטינג', [['A3', 'סטטי', 260, 4]]], ['120250670197650731', 'קמפיין שלו', 'S3', 'שלו · רחב', [['A4', 'רילס', 640, 5]]]]
  .flatMap(([cid, cn, sid, sn, ads]) => ads.map(([aid, an, sp, l]) => ({ campaign_id: cid, campaign_name: cn, adset_id: sid, adset_name: sn, ad_id: aid, ad_name: an, spend: String(sp), impressions: String(sp * 40), clicks: String(Math.round(sp / 9)), actions: [{ action_type: 'lead', value: String(l) }] })));
const TPL = { '1378764257421712': [['hazmana_ishur_v2', 'APPROVED', 'UTILITY', 'GREEN'], ['hazmana_ishur_v3', 'PENDING', 'UTILITY', ''], ['ishur_yom_lifnei', 'APPROVED', 'UTILITY', 'GREEN'], ['ishur_toda_orach', 'APPROVED', 'MARKETING', 'YELLOW'], ['ishur_shulchan_f', 'REJECTED', 'UTILITY', '']], '2815615772154486': [['ishur_heshbonit_n', 'APPROVED', 'UTILITY', 'GREEN'], ['ishur_tashlum_n', 'PAUSED', 'UTILITY', 'RED']], '1060242146337688': [['ishur_kod', 'APPROVED', 'AUTHENTICATION', 'GREEN']] };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === 'https://hook.test/status') return new Response(JSON.stringify(snapshot()));
  if (/\/insights\?level=ad/.test(u)) return new Response(JSON.stringify({ data: ins }));
  const m = u.match(/v21\.0\/(\d+)\/message_templates\?fields=/); if (m) return new Response(JSON.stringify({ data: (TPL[m[1]] || []).map(([name, status, category, q], i) => ({ id: m[1] + i, name, status, category, language: 'he', quality_score: q ? { score: q } : undefined, rejected_reason: status === 'REJECTED' ? 'INVALID_FORMAT' : 'NONE' })) }));
  if (/pricing_analytics/.test(u)) return new Response(JSON.stringify({ pricing_analytics: { data: [{ data_points: [{ cost: 6.4, volume: 410 }] }] } }));
  if (u === 'https://api.telnyx.com/v2/balance') return new Response(JSON.stringify({ data: { balance: '9.29', available_credit: '9.29', currency: 'USD' } }));
  if (/\/act_1944903292858482\?/.test(u)) return new Response(JSON.stringify({ balance: '26936', amount_spent: '386617', spend_cap: '0', currency: 'ILS', account_status: 1, is_prepay_account: false }));
  return new Response('{}');
};
const env = { ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_TOKEN_GUESTS: 't', WA_TOKEN: 'ct', TELNYX_KEY: 'x', META_ADS_TOKEN: 'mt', RATE: kv(kvInit) };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = async (p) => (await worker.fetch(new Request('https://go.ishur.io/api/ops/' + p, { headers: { 'X-Admin-Key': 'k' } }), env, ctx)).json();
const out = { finance: await get('finance?range=90d'), ads: await get('ads?range=30d'), templates: await get('templates'), feedback: await get('feedback') };
for (const [n, d] of Object.entries(out)) { if (!d.ok) throw new Error(n + ': ' + JSON.stringify(d).slice(0, 300)); d.fixture = true; delete d.cached; writeFileSync(join(ROOT, 'fixtures/ops', n + '.json'), JSON.stringify(d, null, 1)); console.log(n, JSON.stringify(d).length, 'bytes'); }
