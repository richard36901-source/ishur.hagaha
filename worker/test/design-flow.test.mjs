// node --test worker/test/design-flow.test.mjs — 03/11 dashboard design flow:
// brief save/validate, state machine, free round once, paid round via IPN, token scoping.
// Everything outbound is stubbed; nothing leaves the machine.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { validateClientBrief, newFlow, addVersion, approveDesign, requestChanges, buyRound, grantPaidRound, markDone, roundsTotal, designRoundRef, isDesignPayment } from '../design.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init)), meta = new Map();
  return { m, meta,
    get: async k => m.has(k) ? (typeof m.get(k) === 'string' ? m.get(k) : m.get(k)) : null,
    put: async (k, v, o = {}) => { m.set(k, typeof v === 'string' ? v : v); if (o.metadata) meta.set(k, o.metadata); },
    delete: async k => { m.delete(k); meta.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }),
    getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: meta.get(k) || null }) };
}
let realFetch, calls = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, body: init.body && typeof init.body === 'string' ? init.body : '' });
    if (u === 'https://hook.test/grow-link') return new Response(JSON.stringify({ url: 'https://pay.grow.link/ROUND-LINK' }));
    if (u === 'https://hook.test/grow') return new Response('ok', { status: 200 });
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });

const T1 = '11111111-2222-4333-8444-555555555555', T2 = '99999999-8888-4777-8666-555555555555';
const seed = (extra = {}) => ({
  ['token:' + T1]: JSON.stringify({ phone: '972501234567', name: 'דנה' }),
  ['token:' + T2]: JSON.stringify({ phone: '972521111111', name: 'אבי' }),
  ['design:' + T1]: JSON.stringify({ status: 'paid', ref: 'D1' }),
  ['design:' + T2]: JSON.stringify({ status: 'paid', ref: 'D2' }),
  ...extra,
});
const env = (init = seed()) => ({ ADMIN_KEY: 'k', GROW_KEY: 'gk', HOOK_GROW: 'https://hook.test/grow', GROW_LINK_HOOK: 'https://hook.test/grow-link',
  SLACK_ALERT_HOOK: 'https://hook.test/slack', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const req = (e, path, init) => worker.fetch(new Request('https://go.ishur.io' + path, init), e, ctx);
const post = (e, path, body) => req(e, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const flow = (e, body) => post(e, '/api/design-flow', body).then(r => r.json());
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
const PDF = new TextEncoder().encode('%PDF-1.4 fake design');
async function upload(e, token, purpose, bytes, extra = {}) {
  const fd = new FormData(); fd.append('token', token); fd.append('purpose', purpose);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([bytes]), 'f.bin');
  const r = await req(e, '/api/media', { method: 'POST', body: fd });
  return { status: r.status, j: await r.json() };
}
const slackTexts = () => calls.filter(c => c.u === 'https://hook.test/slack').map(c => JSON.parse(c.body).text);

/* ── pure: brief validation ── */
test('validateClientBrief: text required, ≤5 refs, ids shaped', () => {
  assert.equal(validateClientBrief({ text: 'דנה ואבי, זהב ושמנת, נוסח קלאסי' }).ok, true);
  assert.equal(validateClientBrief({ text: '  ' }).why, 'text');
  assert.equal(validateClientBrief({ text: 'שמות וצבעים', refs: Array(6).fill('0123456789abcdef') }).why, 'too-many-refs');
  assert.equal(validateClientBrief({ text: 'שמות וצבעים', refs: ['../etc'] }).why, 'bad-ref');
  assert.deepEqual(validateClientBrief({ text: 'שמות וצבעים', refs: ['0123456789abcdef', '0123456789abcdef'] }).brief.refs, ['0123456789abcdef']);
  assert.equal(validateClientBrief({ text: 'x'.repeat(5000) }).brief.text.length, 3000);
});

/* ── pure: state machine ── */
test('state machine: awaiting → changes → new version (rounds_used++) → approved → done', () => {
  let f = newFlow();
  assert.equal(approveDesign(f).ok, false, 'nothing to approve before a version');
  f = addVersion(f, { media: 'aaaaaaaaaaaaaaaa', note: 'גרסה ראשונה' }).flow;
  assert.equal(f.status, 'awaiting_client'); assert.equal(f.rounds_used, 0); assert.equal(roundsTotal(f), 1);
  f = requestChanges(f, 'להחליף את הצבע').flow;
  assert.equal(f.status, 'changes_requested'); assert.equal(f.rounds_used, 0, 'a request alone does not use the round');
  f = addVersion(f, { media: 'bbbbbbbbbbbbbbbb' }).flow;
  assert.equal(f.rounds_used, 1, 'the answering version uses it'); assert.equal(f.versions.length, 2); assert.equal(f.status, 'awaiting_client');
  assert.equal(requestChanges(f, 'עוד שינוי').why, 'no-rounds-left');
  assert.equal(markDone(f).ok, false, 'done only after approval');
  f = approveDesign(f).flow; assert.equal(f.status, 'approved'); assert.equal(f.approved_version, 2);
  assert.equal(addVersion(f, { media: 'cccccccccccccccc' }).why, 'already-approved');
  f = markDone(f).flow; assert.equal(f.status, 'done');
});
test('a second admin upload without a client request does not burn a round', () => {
  let f = addVersion(newFlow(), { media: 'aaaaaaaaaaaaaaaa' }).flow;
  f = addVersion(f, { media: 'bbbbbbbbbbbbbbbb' }).flow;
  assert.equal(f.rounds_used, 0);
});
test('buyRound: the free round is granted once, then every round is ₪49', () => {
  let f = addVersion(newFlow(), { media: 'aaaaaaaaaaaaaaaa' }).flow;
  const a = buyRound(f); assert.equal(a.free, true); f = a.flow;
  assert.equal(roundsTotal(f), 1, 'the free round is the included one, not an extra');
  const b = buyRound(f); assert.equal(b.free, false); assert.equal(b.pay, true); assert.equal(b.price, 49);
  f = grantPaidRound(f, 'R1').flow; assert.equal(roundsTotal(f), 2);
  assert.equal(buyRound(f).pay, true);
});
test('designRoundRef + isDesignPayment: a round is never read as the ₪79 design', () => {
  const flat = { paymentDesc: 'סבב תיקונים נוסף לעיצוב', cField1: `q:0123456789ab|design_round:1|t:${T1}` };
  assert.deepEqual(designRoundRef(flat), { id: '0123456789ab', token: T1 });
  assert.equal(isDesignPayment(flat), false);
  assert.equal(designRoundRef({ cField1: 'q:0123456789ab|pkg:basic:100;design:1' }), null);
});

/* ── routes ── */
test('route: unpaid design → state says paid:false and writes are refused', async () => {
  const e = env(seed({ ['design:' + T1]: undefined }));
  e.RATE.m.delete('design:' + T1);
  const s = await flow(e, { token: T1, action: 'state' });
  assert.equal(s.ok, true); assert.equal(s.paid, false); assert.equal(s.versions, undefined);
  const r = await post(e, '/api/design-flow', { token: T1, action: 'brief', text: 'שמות וצבעים' });
  assert.equal(r.status, 402);
});
test('route: brief save with inspiration images, editable until the first version, Slack line', async () => {
  const e = env();
  const up = await upload(e, T1, 'design_ref', PNG);
  assert.equal(up.status, 200); assert.match(up.j.media, /^[0-9a-f]{16}$/); assert.equal(up.j.mime, 'image/png');
  const pdfRef = await upload(e, T1, 'design_ref', PDF);
  assert.equal(pdfRef.status, 422, 'clients upload images only');
  let s = await flow(e, { token: T1, action: 'brief', text: 'דנה ואבי · זהב · נוסח קלאסי', refs: [up.j.media] });
  assert.equal(s.ok, true); assert.equal(s.brief.text, 'דנה ואבי · זהב · נוסח קלאסי'); assert.equal(s.brief.refs.length, 1); assert.equal(s.brief_editable, true);
  assert.equal(JSON.parse(e.RATE.m.get('designbrief:' + T1)).source, 'dashboard');
  assert.ok(slackTexts().some(t => t.includes('בריף עיצוב חדש')));
  s = await flow(e, { token: T1, action: 'brief', text: 'עדכון: כסף במקום זהב', refs: [] });
  assert.equal(s.ok, true); assert.equal(s.brief.text, 'עדכון: כסף במקום זהב');
  assert.equal((await flow(e, { token: T1, action: 'brief', text: 'x', refs: [] })).why, 'text');
  assert.equal((await flow(e, { token: T1, action: 'brief', text: 'שמות וצבעים', refs: ['abcdefabcdefabcd'] })).why, 'unknown-ref');
  /* admin uploads v1 → brief is locked */
  const v = await upload(e, T1, 'design_version', PDF, { admin_key: 'k' });
  assert.equal(v.status, 200); assert.equal(v.j.mime, 'application/pdf');
  const a = await (await post(e, '/api/design-version', { admin_key: 'k', token: T1, media: v.j.media, note: 'גרסה 1' })).json();
  assert.equal(a.ok, true); assert.equal(a.status, 'awaiting_client'); assert.equal(a.versions[0].mime, 'application/pdf');
  assert.equal((await flow(e, { token: T1, action: 'brief', text: 'שינוי מאוחר', refs: [] })).why, 'locked');
  assert.equal((await upload(e, T1, 'design_ref', PNG)).status, 409);
});
test('route: full loop — version → changes → version → approve (Slack "עיצוב אושר") → admin done', async () => {
  const e = env();
  const v1 = await upload(e, T1, 'design_version', PNG, { admin_key: 'k' });
  await post(e, '/api/design-version', { admin_key: 'k', token: T1, media: v1.j.media });
  let s = await flow(e, { token: T1, action: 'changes', comment: 'שם הכלה באות גדולה' });
  assert.equal(s.ok, true); assert.equal(s.status, 'changes_requested'); assert.equal(s.rounds_used, 0);
  assert.ok(slackTexts().some(t => t.includes('ביקש תיקונים')));
  const v2 = await upload(e, T1, 'design_version', PNG, { admin_key: 'k' });
  s = await (await post(e, '/api/design-version', { admin_key: 'k', token: T1, media: v2.j.media, note: 'תוקן' })).json();
  assert.equal(s.rounds_used, 1); assert.equal(s.versions.length, 2);
  assert.equal((await flow(e, { token: T1, action: 'changes', comment: 'עוד' })).why, 'no-rounds-left');
  calls = [];
  s = await flow(e, { token: T1, action: 'approve' });
  assert.equal(s.status, 'approved');
  assert.ok(slackTexts().some(t => t.includes('עיצוב אושר')));
  s = await (await post(e, '/api/design-version', { admin_key: 'k', token: T1, action: 'done' })).json();
  assert.equal(s.status, 'done');
  assert.equal((await post(e, '/api/design-version', { admin_key: 'nope', token: T1, action: 'done' })).status, 403);
  assert.equal((await upload(e, T1, 'design_version', PNG, { admin_key: 'nope' })).status, 403);
});
test('route: free round on first buy click, then a ₪49 server-priced link; IPN grants exactly one round', async () => {
  const e = env();
  const v1 = await upload(e, T1, 'design_version', PNG, { admin_key: 'k' });
  await post(e, '/api/design-version', { admin_key: 'k', token: T1, media: v1.j.media });
  let s = await flow(e, { token: T1, action: 'buy', sum: 1 });
  assert.equal(s.ok, true); assert.equal(s.free, true); assert.equal(s.free_claimed, true);
  assert.ok(!calls.some(c => c.u === 'https://hook.test/grow-link'), 'no payment for the free round');
  s = await flow(e, { token: T1, action: 'buy', sum: 1 });
  assert.equal(s.ok, true); assert.equal(s.pay, true); assert.equal(s.url, 'https://pay.grow.link/ROUND-LINK');
  const mk = JSON.parse(calls.find(c => c.u === 'https://hook.test/grow-link').body);
  assert.equal(mk.sum, 49, 'server price, the client sum is ignored');
  assert.match(mk.cField1, new RegExp(`^q:[0-9a-f]{12}\\|design_round:1\\|t:${T1}$`));
  assert.ok(!/עיצוב\s*הזמנה/.test(mk.description));
  calls = [];
  const flat = { paymentDesc: mk.description, paymentSum: '49', asmachta: 'R1', payerPhone: '0501234567', fullName: 'דנה', cField1: mk.cField1 };
  const r = await post(e, '/api/grow-ipn?k=gk', flat);
  assert.equal(await r.text(), 'design-round-granted');
  assert.equal(JSON.parse(e.RATE.m.get('designflow:' + T1)).rounds_paid, 1);
  assert.ok(!calls.some(c => c.u === 'https://hook.test/grow'), 'no new event minted');
  assert.equal((await post(e, '/api/grow-ipn?k=gk', flat).then(x => x.text())), 'duplicate');
  assert.equal(JSON.parse(e.RATE.m.get('designflow:' + T1)).rounds_paid, 1, 'a replayed IPN grants nothing more');
  s = await flow(e, { token: T1, action: 'state' });
  assert.equal(s.rounds_total, 2);
  /* a forged cField pointing the quote at another event is parked, not granted */
  const forged = { ...flat, asmachta: 'R2', cField1: mk.cField1.replace(T1, T2) };
  assert.equal(await (await post(e, '/api/grow-ipn?k=gk', forged)).text(), 'design-round-parked');
  assert.equal(e.RATE.m.get('designflow:' + T2), undefined);
});
test('token scoping: one event cannot read or write another event’s design', async () => {
  const e = env();
  const v = await upload(e, T1, 'design_version', PNG, { admin_key: 'k' });
  await post(e, '/api/design-version', { admin_key: 'k', token: T1, media: v.j.media });
  const own = await req(e, `/api/design-file?t=${T1}&id=${v.j.media}`, { method: 'GET' });
  assert.equal(own.status, 200); assert.equal(own.headers.get('Content-Type'), 'image/png');
  const cross = await req(e, `/api/design-file?t=${T2}&id=${v.j.media}`, { method: 'GET' });
  assert.equal(cross.status, 404, 'the T1 file id under T2 is not found');
  const s2 = await flow(e, { token: T2, action: 'state' });
  assert.equal(s2.versions.length, 0, 'T2 sees none of T1’s versions');
  assert.equal((await flow(e, { token: T2, action: 'approve' })).why, 'nothing-to-approve');
  assert.equal(JSON.parse(e.RATE.m.get('designflow:' + T1)).status, 'awaiting_client');
  /* T2 cannot attach T1's file to its brief */
  assert.equal((await flow(e, { token: T2, action: 'brief', text: 'שמות וצבעים', refs: [v.j.media] })).why, 'unknown-ref');
  /* unknown token */
  assert.equal((await post(e, '/api/design-flow', { token: '00000000-0000-4000-8000-000000000000', action: 'state' })).status, 404);
  assert.equal((await req(e, `/api/design-file?t=${T1}&id=../x`, { method: 'GET' })).status, 400);
});
