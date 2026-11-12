// node --test worker/test/referral-routes.test.mjs — הזמן חבר through the real Worker fetch() (spec P2)
// Grow/Make, Slack and the writer are stubbed (globalThis.fetch); nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker, { _parsePaidDesc as parsePaidDesc } from '../index.js';
import { sha256Hex } from '../lib.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
let realFetch, hook = [], slack = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/grow-link') { hook.push(JSON.parse(init.body)); return new Response(JSON.stringify({ url: 'https://pay.grow.test/abc' })); }
    if (u === 'https://hook.test/grow-writer') return new Response('ok', { status: 200 });
    if (u === 'https://hook.test/slack') { slack.push(JSON.parse(init.body)); return new Response('ok'); }
    return new Response('{}', { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const APP_KEY = 'appk';
const TOK = 'aaaa1111-2222-3333-4444-555555555555', CODE = 'aaaa1111', REFERRER = '972501111111';
const env = (extra = {}) => ({ ADMIN_KEY: 'k', APP_KEY, GROW_LINK_HOOK: 'https://hook.test/grow-link', GROW_KEY: 'gk', HOOK_GROW: 'https://hook.test/grow-writer', SLACK_ALERT_HOOK: 'https://hook.test/slack',
  RATE: kv({ ['token:' + TOK]: JSON.stringify({ phone: REFERRER, name: 'דנה כהן', clientId: 'C-501111111' }) }), ...extra });
async function stamp(b) { const nonce = 'n' + Math.random().toString(36).slice(2), ts = Date.now(); return { ...b, app: 'ishur', nonce, stamp_ts: ts, sig: await sha256Hex(`${APP_KEY}|${nonce}|${ts}`) }; }
const hdr = () => ({ 'Content-Type': 'application/json', Origin: 'https://ishur.io', 'CF-Connecting-IP': '1.2.3.' + Math.floor(Math.random() * 200) });
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: hdr(), body: JSON.stringify(body) }), e, ctx);
const get = (e, path) => worker.fetch(new Request('https://go.ishur.io' + path, { headers: hdr() }), e, ctx);
const ipn = (e, body) => worker.fetch(new Request('https://go.ishur.io/api/grow-ipn?k=gk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, ctx);

test('R11 parsePaidDesc reads the 80% page names', () => {
  const p = parsePaidDesc('300 מוזמנים פרמיום · הנחת חבר');
  assert.equal(p.tier, 300); assert.equal(p.plan, 'pro'); assert.equal(p.hostess, 0);
  assert.equal(parsePaidDesc('50 מוזמנים בסיס · הנחת חבר').plan, 'basic');
  assert.equal(parsePaidDesc('900 מוזמנים הכל כלול · הנחת חבר').plan, 'premium');
});

test('R1/R2 choice + public lookup (no PII), lock after a referral', async () => {
  const e = env();
  let j = await (await get(e, '/api/referral?code=zzzzzzzz')).json();
  assert.deepEqual(j, { ok: false });
  j = await (await post(e, '/api/referral', { token: TOK, mode: 'cash' })).json(); assert.equal(j.error, 'bad-mode');
  assert.equal((await post(e, '/api/referral', { token: 'bbbb1111-2222-3333-4444-555555555555', mode: 'discount' })).status, 404, 'unknown token');
  j = await (await post(e, '/api/referral', { token: TOK, mode: 'discount' })).json();
  assert.equal(j.ok, true); assert.equal(j.mode, 'discount'); assert.equal(j.link, 'https://ishur.io/?ref=' + CODE); assert.equal(j.copy, 'חברים חסכו ₪0'); assert.equal(j.balance, 0);
  j = await (await get(e, '/api/referral?code=' + CODE.toUpperCase())).json();
  assert.deepEqual(j, { ok: true, mode: 'discount', name_first: 'דנה' });
  j = await (await post(e, '/api/referral', { token: TOK, mode: 'commission' })).json();
  assert.equal(j.mode, 'commission'); assert.equal(j.copy, 'הרווחתם ₪0');
  e.RATE.m.set('ref:' + CODE, JSON.stringify({ ...JSON.parse(e.RATE.m.get('ref:' + CODE)), locked: true }));
  j = await (await post(e, '/api/referral', { token: TOK, mode: 'discount' })).json();
  assert.equal(j.error, 'locked');
});

test('R5 ref-touch: stamped, remembers code↔phone 30d, unknown code → ok:false', async () => {
  const e = env();
  await post(e, '/api/referral', { token: TOK, mode: 'discount' });
  assert.equal((await post(e, '/api/ref-touch', { code: CODE, phone: '0502222222' })).status, 403, 'unstamped');
  let j = await (await post(e, '/api/ref-touch', await stamp({ code: 'ffffffff', phone: '0502222222' }))).json(); assert.equal(j.ok, false);
  j = await (await post(e, '/api/ref-touch', await stamp({ code: CODE, phone: '0502222222' }))).json(); assert.equal(j.ok, true);
  assert.equal(e.RATE.m.get('refpend:972502222222'), CODE);
});

test('R10 quote-from-site with a discount code: package line at 80%, add-on at list, cField3 carries the code', async () => {
  hook = []; const e = env();
  await post(e, '/api/referral', { token: TOK, mode: 'discount' });
  const j = await (await post(e, '/api/quote-from-site', await stamp({ plan: 'pro', records: 300, design: true, name: 'רון לוי', phone: '0502222222', occasion: 'wedding', ref: CODE }))).json();
  assert.equal(j.ok, true); assert.equal(j.sum, 303 + 79, '379*0.8=303 + design 79');
  assert.equal(hook[0].cField3, 'ref:' + CODE); assert.match(hook[0].description, /הנחת חבר/);
  /* commission mode: full price, still attributed */
  hook = []; const e2 = env();
  await post(e2, '/api/referral', { token: TOK, mode: 'commission' });
  const j2 = await (await post(e2, '/api/quote-from-site', await stamp({ plan: 'pro', records: 300, design: true, name: 'רון לוי', phone: '0502222222', occasion: 'wedding', ref: CODE }))).json();
  assert.equal(j2.sum, 458); assert.equal(hook[0].cField3, 'ref:' + CODE);
  /* unknown code: ignored */
  hook = [];
  const j3 = await (await post(e2, '/api/quote-from-site', await stamp({ plan: 'pro', records: 300, name: 'רון לוי', phone: '0502222222', occasion: 'wedding', ref: 'ffffffff' }))).json();
  assert.equal(j3.sum, 379); assert.equal(hook[0].cField3, '');
});

test('R6/R6b/R13 IPN: pending record, Slack 🎉, no credit; verify (manual) posts once; duplicate IPN does nothing', async () => {
  hook = []; slack = []; const e = env();
  await post(e, '/api/referral', { token: TOK, mode: 'commission' });
  const q = await (await post(e, '/api/quote-from-site', await stamp({ plan: 'pro', records: 300, design: true, name: 'רון לוי', phone: '0502222222', occasion: 'wedding', ref: CODE }))).json();
  const body = { asmachta: 'TX' + Date.now(), payerPhone: '0502222222', paymentSum: '458', paymentDesc: hook[0].description, fullName: 'רון לוי', cField1: hook[0].cField1, cField3: hook[0].cField3, _simulated: true };
  assert.equal((await ipn(e, body)).status, 200);
  const friendTok = e.RATE.m.get('grow:' + body.asmachta);
  const recId = CODE + ':' + body.asmachta;
  const rec = JSON.parse(e.RATE.m.get('refrec:' + recId));
  assert.equal(rec.status, 'pending'); assert.equal(rec.via, 'cField3'); assert.equal(rec.sum_package, 379); assert.equal(rec.credit, 76); assert.equal(rec.friend_token, friendTok);
  assert.equal(e.RATE.m.get('refcred:' + CODE), '1', 'tier counter');
  assert.equal(e.RATE.m.get('refdone:502222222'), CODE);
  assert.equal(JSON.parse(e.RATE.m.get('ref:' + CODE)).locked, true);
  assert.equal(e.RATE.m.get('credit:' + REFERRER), undefined, 'no credit before the invoice');
  assert.ok(slack.some(s => /הפניה שילמה/.test(JSON.stringify(s)) && /זיכוי ₪76/.test(JSON.stringify(s))), 'Slack 🎉 line');
  /* the referrer's board: pending, ₪0 */
  const d = await (await post(e, '/api/referral', { token: TOK, mode: 'commission' })).json();
  assert.equal(d.pending, 1); assert.equal(d.friends, 0); assert.equal(d.earned, 0); assert.equal(d.copy, 'הרווחתם ₪0'); assert.equal(d.locked, true);
  /* duplicate IPN: nothing new */
  const before = [...e.RATE.m.keys()].filter(k => k.startsWith('refrec:')).length;
  await ipn(e, body); await ipn(e, { ...body, asmachta: 'TX-second' });
  assert.equal([...e.RATE.m.keys()].filter(k => k.startsWith('refrec:')).length, before, 'one record per payer, ever');
  /* manual verify (Richard) */
  assert.equal((await post(e, '/api/referrals/act', { admin_key: 'bad', act: 'verify', id: recId })).status, 403);
  let v = await (await post(e, '/api/referrals/act', { admin_key: 'k', act: 'verify', id: recId, who: 'ריצארד' })).json();
  assert.equal(v.changed, true); assert.equal(v.credited, 76);
  const bal = l => (l.entries || []).reduce((n, x) => n + x.ils, 0) - (l.redeemed || []).reduce((n, x) => n + x.ils, 0);
  assert.equal(bal(JSON.parse(e.RATE.m.get('credit:' + REFERRER))), 76);
  assert.deepEqual(Object.keys(JSON.parse(e.RATE.m.get('credit:' + REFERRER)).entries[0]).sort(), ['at', 'ils', 'kind', 'note', 'ref', 'token'], 'account.js ledger shape');
  v = await (await post(e, '/api/referrals/act', { admin_key: 'k', act: 'verify', id: recId })).json();
  assert.equal(v.changed, false, 'second verify is a no-op');
  assert.equal(bal(JSON.parse(e.RATE.m.get('credit:' + REFERRER))), 76);
  const d2 = await (await post(e, '/api/referral', { token: TOK, mode: 'commission' })).json();
  assert.equal(d2.friends, 1); assert.equal(d2.earned, 76); assert.equal(d2.balance, 76); assert.equal(d2.copy, 'הרווחתם ₪76');
  /* admin list + redeem */
  const all = await (await post(e, '/api/referrals', { admin_key: 'k' })).json();
  assert.equal(all.records.length, 1); assert.equal(all.records[0].status, 'verified'); assert.equal(all.pending_line, 'זיכויים ממתינים: ₪76 ל-1 לקוחות');
  const rd = await (await post(e, '/api/referrals/act', { admin_key: 'k', act: 'redeem', phone: '0501111111', note: 'חבילה חדשה' })).json();
  assert.equal(rd.redeemed, 76);
  assert.equal(JSON.parse(e.RATE.m.get('refrec:' + recId)).redeemed, true);
  assert.equal(bal(JSON.parse(e.RATE.m.get('credit:' + REFERRER))), 0);
  /* the personal area reads the same row: entries + redeemed, balance 0 */
  const { readLedger, ledgerBalance } = await import('../account.js');
  assert.equal(ledgerBalance(await readLedger(e, REFERRER)), 0);
});

test('R6b invoice hook: a Morning invoice on the friend\'s payment verifies the record and credits', async () => {
  hook = []; const e = env({ MORNING_ID: 'x', MORNING_SECRET: 'y' });
  await post(e, '/api/referral', { token: TOK, mode: 'commission' });
  /* refpend path (no cField3 echo), a plain 80%-page description */
  await post(e, '/api/ref-touch', await stamp({ code: CODE, phone: '0503333333' }));
  const body = { asmachta: 'TY' + Date.now(), payerPhone: '0503333333', paymentSum: '303', paymentDesc: '300 מוזמנים פרמיום · הנחת חבר', fullName: 'גל שמש', invoiceURL: 'https://grow.test/inv/1', _simulated: true };
  assert.equal((await ipn(e, body)).status, 200);
  const rec = JSON.parse(e.RATE.m.get('refrec:' + CODE + ':' + body.asmachta));
  assert.equal(rec.via, 'pending'); assert.equal(rec.sum_package, 303);
  assert.equal(rec.status, 'verified', 'Grow sent an invoice URL → verified at once'); assert.equal(rec.verified_by, 'invoice');
  const { readLedger: rl, ledgerBalance: lb } = await import('../account.js');
  assert.equal(lb(await rl(e, REFERRER)), 61, '20% of 303, readable by the personal area');
  assert.equal(e.RATE.m.get('refpend:972503333333'), undefined, 'claim consumed');
});

test('R6 self-referral is ignored; discount path records the saving, no credit', async () => {
  hook = []; const e = env();
  await post(e, '/api/referral', { token: TOK, mode: 'discount' });
  await ipn(e, { asmachta: 'TS1', payerPhone: '0501111111', paymentSum: '303', paymentDesc: '300 מוזמנים פרמיום · הנחת חבר', fullName: 'דנה כהן', cField3: 'ref:' + CODE, _simulated: true });
  assert.equal([...e.RATE.m.keys()].filter(k => k.startsWith('refrec:')).length, 0, 'self');
  await ipn(e, { asmachta: 'TS2', payerPhone: '0504444444', paymentSum: '303', paymentDesc: '300 מוזמנים פרמיום · הנחת חבר', fullName: 'נוי', cField3: 'ref:' + CODE, _simulated: true });
  const rec = JSON.parse(e.RATE.m.get('refrec:' + CODE + ':TS2'));
  assert.equal(rec.path, 'discount'); assert.equal(rec.discount_given, 76); assert.equal(rec.credit, 0);
  await post(e, '/api/referrals/act', { admin_key: 'k', act: 'verify', id: CODE + ':TS2' });
  assert.equal(e.RATE.m.get('credit:' + REFERRER), undefined, 'discount path never credits');
  const d = await (await post(e, '/api/referral', { token: TOK, mode: 'discount' })).json();
  assert.equal(d.copy, 'חברים חסכו ₪76');
});

test('R14 the personal area already holds a review credit → a referral credit adds to the same ledger', async () => {
  const e = env();
  e.RATE.m.set('credit:' + REFERRER, JSON.stringify({ entries: [{ kind: 'review_video', ils: 30, at: '2026-11-12T00:00:00Z', token: TOK }], redeemed: [] }));
  await post(e, '/api/referral', { token: TOK, mode: 'commission' });
  await ipn(e, { asmachta: 'TR1', payerPhone: '0505555555', paymentSum: '379', paymentDesc: '300 מוזמנים פרמיום', fullName: 'עדי', cField3: 'ref:' + CODE, _simulated: true });
  await post(e, '/api/referrals/act', { admin_key: 'k', act: 'verify', id: CODE + ':TR1' });
  const { readLedger, ledgerBalance } = await import('../account.js');
  const L = await readLedger(e, REFERRER);
  assert.equal(ledgerBalance(L), 106); assert.equal(L.entries.length, 2);
  const d = await (await post(e, '/api/referral', { token: TOK, mode: 'commission' })).json();
  assert.equal(d.earned, 76, 'the card counts referral credit only'); assert.equal(d.balance, 106, 'the balance is the whole ledger');
  assert.equal((await post(e, '/api/referrals/act', { admin_key: 'k', act: 'review_verify', token: TOK, kind: 'review_video' })).status, 400, 'no admin review verification any more (account.js credits on claim)');
});

test('R14 raffle off: /api/raffle/links still hands out the review links + credit amounts', async () => {
  const e = env({ RAFFLE: JSON.stringify({ on: false, video_url: 'https://v.test/x', google_review_url: 'https://g.test/y' }) });
  const j = await (await get(e, '/api/raffle/links')).json();
  assert.deepEqual(j, { ok: true, video_url: 'https://v.test/x', google_review_url: 'https://g.test/y', credit: { video: 30, text: 20 } });
  assert.deepEqual(await (await get(e, '/api/raffle/config')).json(), { ok: true, on: false }, 'the raffle itself stays off');
});

test('R12 ops overview "waiting" line: credit balances + pending referrals', async () => {
  const { referralWaiting } = await import('../notify.js');
  const e = env();
  assert.deepEqual(await referralWaiting(e), []);
  e.RATE.m.set('credit:972501111111', JSON.stringify({ entries: [{ kind: 'referral', ils: 76 }], redeemed: [] }));
  e.RATE.m.set('refrec:aaaa1111:T1', JSON.stringify({ status: 'pending' }));
  const w = await referralWaiting(e);
  assert.equal(w[0].title_he, 'זיכויים ממתינים: ₪76 ל-1 לקוחות'); assert.equal(w[1].title_he, 'הפניה אחת ממתינה לאישור (לקוחות › הפניות)');
});
