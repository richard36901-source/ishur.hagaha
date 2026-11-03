// node --test worker/test/raffle.test.mjs — review raffle (raffle.js) through the real Worker fetch().
// Snapshot hook stubbed; WhatsApp/Slack never leave the machine (fetch stub records and answers {}).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../index.js';
import * as R from '../raffle.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, typeof v === 'string' ? v : String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
const TOK = '11111111-2222-3333-4444-555555555555', TOK2 = 'aaaaaaaa-2222-3333-4444-555555555555';
let realFetch; const out = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify({ events: { values: [['', TOK, 'דנה כהן', '0521234567'], ['', TOK2, 'יוסי', '0529999999']] }, guests: { values: [] } }));
    out.push(u); return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
const ON = { on: true, prize_he: 'פרס', draw_at: '2099-01-01T00:00:00Z', google_review_url: 'https://g.page/r/x/review', video_url: 'https://www.videoask.com/x', video_max_sec: 60 };
const env = (raffle = ON, init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', RAFFLE: JSON.stringify(raffle), RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const pub = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, ctx).then(r => r.json().then(j => ({ status: r.status, ...j })));
const adm = (e, path, body) => worker.fetch(new Request('https://go.ishur.io/api/ops/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...body }) } : { headers: { 'X-Admin-Key': 'k' } }), e, ctx).then(r => r.json().then(j => ({ status: r.status, ...j })));

test('count rules: video 2, google 1, both 3; google needs a configured URL', () => {
  assert.equal(R.ticketCount({ video_claimed_at: 'x' }), 2);
  assert.equal(R.ticketCount({ google_claimed_at: 'x' }), 1);
  assert.equal(R.ticketCount({ video_claimed_at: 'x', google_claimed_at: 'x' }), 3);
  assert.equal(R.ticketCount({}), 0);
  assert.equal(R.ticketCount({ google_claimed_at: 'x' }, { google_review_url: '' }), 0);
});

test('ticket numbers: 4 digits, unique even when the RNG keeps colliding', async () => {
  const e = env(); const seen = new Set();
  for (let i = 0; i < 300; i++) { const n = R.newTicketNumber(); assert.match(n, /^[1-9]\d{3}$/); }
  /* rigged RNG: same value 3 times, then new → top-up must skip the taken number */
  let calls = 0; const rng = { getRandomValues: a => { const c = calls++; a[0] = c < 4 ? 7 : c; return a; } };
  const a = { id: 'a', video_claimed_at: 'x', tickets: [] }; await R.topUpTickets(e, a, ON, rng);
  const b = { id: 'b', google_claimed_at: 'x', tickets: [] }; await R.topUpTickets(e, b, ON, rng);
  for (const t of [...a.tickets, ...b.tickets]) { assert.ok(!seen.has(t), 'dup ' + t); seen.add(t); }
  assert.equal(seen.size, 3);
});

test('flow: video claim = 2, then google = +1 (3 total, first two unchanged); one entry per phone per event', async () => {
  const e = env();
  const v = await pub(e, '/api/raffle/enter', { token: TOK, done: true });
  assert.equal(v.ok, true); assert.equal(v.tickets.length, 2); assert.equal(v.whatsapp, false, 'no open conversation → shown only');
  const again = await pub(e, '/api/raffle/enter', { token: TOK, done: true });
  assert.deepEqual(again.tickets, v.tickets, 'repeat claim adds nothing');
  const g = await pub(e, '/api/raffle/claim-google', { token: TOK, done: true });
  assert.equal(g.tickets.length, 3); assert.deepEqual(g.tickets.slice(0, 2), v.tickets);
  const list = await adm(e, 'raffle');
  assert.equal(list.counts.entries, 1); assert.equal(list.counts.tickets, 3);
  assert.equal(list.entries[0].phone, '972521234567'); assert.equal(list.entries[0].name, 'דנה כהן');
  /* partner (p=2) with another phone = a second entry on the same event; same phone as host = same entry */
  const p2 = await pub(e, '/api/raffle/claim-google', { token: TOK, who: '2', name: 'אבי', phone: '0541112222', done: true });
  assert.equal(p2.tickets.length, 1);
  const p2same = await pub(e, '/api/raffle/claim-google', { token: TOK, who: '2', name: 'x', phone: '052-123-4567', done: true });
  assert.deepEqual(p2same.tickets, g.tickets);
  assert.equal((await adm(e, 'raffle')).counts.entries, 2);
  assert.equal((await pub(e, '/api/raffle/claim-google', { token: TOK, who: '2', phone: '12', done: true })).error, 'bad-phone');
  assert.equal((await pub(e, '/api/raffle/enter', { token: TOK })).error, 'confirm-done');
  assert.equal((await pub(e, '/api/raffle/enter', { token: 'bbbbbbbb-2222-3333-4444-555555555555', done: true })).error, 'bad-token');
});

test('WhatsApp only inside an open conversation (inbound < 24h) and 09–21 IL', async () => {
  const now = Date.parse('2026-11-03T10:00:00Z'); // 12:00 IL
  const e = env(ON, { 'conv:972521234567': JSON.stringify({ last_in_ts: now - 3600e3 }) });
  assert.equal(await R.canWhatsApp(e, '972521234567', now), '');
  assert.equal(await R.canWhatsApp(e, '972521234567', now + 24 * 3600e3), 'no-open-conversation');
  assert.equal(await R.canWhatsApp(e, '972521234567', Date.parse('2026-11-03T20:00:00Z') - 0), 'quiet-hours');
  assert.equal(await R.canWhatsApp(env(), '972521234567', now), 'no-open-conversation');
  e.RATE.m.set('optout:972521234567', '1'); assert.equal(await R.canWhatsApp(e, '972521234567', now), 'optout');
});

test('draw: confirm required, only verified tickets, cryptographic pick of a valid ticket, once, change-log entry', async () => {
  const e = env();
  await pub(e, '/api/raffle/enter', { token: TOK, done: true });
  await pub(e, '/api/raffle/claim-google', { token: TOK2, done: true });
  assert.equal((await adm(e, 'raffle/draw', {})).error, 'confirm-required');
  assert.equal((await adm(e, 'raffle/draw', { confirm: 'yes' })).error, 'confirm-required');
  assert.equal((await adm(e, 'raffle/draw', { confirm: 'draw' })).error, 'no-verified-tickets');
  const l = await adm(e, 'raffle');
  const host = l.entries.find(x => x.token === TOK);
  assert.equal((await adm(e, 'raffle/verify', { id: host.id, field: 'google' })).error, 'not-claimed');
  assert.equal((await adm(e, 'raffle/verify', { id: host.id, field: 'video' })).ok, true);
  const d = await adm(e, 'raffle/draw', { confirm: 'draw' });
  assert.equal(d.ok, true); assert.ok(host.tickets.includes(d.winner.ticket), 'winner is a verified ticket'); assert.equal(d.winner.pool, 2);
  assert.equal((await adm(e, 'raffle/draw', { confirm: 'draw' })).error, 'already-drawn');
  assert.ok([...e.RATE.m.keys()].some(k => k.startsWith('chg:')), 'change log written');
  assert.equal((await pub(e, '/api/raffle/enter', { token: TOK2, done: true })).error, 'raffle-closed');
  /* the pick itself: uniform index from the rng */
  assert.equal(R.randInt(5, { getRandomValues: a => { a[0] = 12; return a; } }), 2);
});

test('config off hides everything; no Google URL hides the Google step', async () => {
  const off = env({ ...ON, on: false });
  const c = await (await worker.fetch(new Request('https://go.ishur.io/api/raffle/config'), off, ctx)).json();
  assert.deepEqual(c, { ok: true, on: false });
  assert.equal((await pub(off, '/api/raffle/enter', { token: TOK, done: true })).error, 'raffle-off');
  assert.equal((await pub(off, '/api/raffle/claim-google', { token: TOK, done: true })).error, 'raffle-off');
  const noG = env({ ...ON, google_review_url: '' });
  noG.BRAIN_HOOK = ''; // brain fallback has nothing either
  const c2 = await (await worker.fetch(new Request('https://go.ishur.io/api/raffle/config'), noG, ctx)).json();
  assert.equal(c2.on, true);
  assert.equal(c2.google, false);
  assert.equal((await pub(noG, '/api/raffle/claim-google', { token: TOK, done: true })).error, 'google-off');
  /* empty links fall back to the brain sheet at runtime */
  const live = await R.raffleCfgLive({ RAFFLE: JSON.stringify({ ...ON, google_review_url: '', video_url: '' }) }, { getBrain: async () => ({ reviewLink: 'https://g.page/r/CTGM0phWkiVyEBM/review', testimonialLink: 'https://www.videoask.com/f4mg4ukix' }) });
  assert.equal(live.google_review_url, 'https://g.page/r/CTGM0phWkiVyEBM/review'); assert.equal(live.video_url, 'https://www.videoask.com/f4mg4ukix');
});

test('config.js RAFFLE equals worker RAFFLE', () => {
  const src = fs.readFileSync(new URL('../../config.js', import.meta.url), 'utf8');
  const sb = { window: {}, document: { currentScript: null, querySelector: () => null }, location: { hostname: 'ishur.io', search: '' }, navigator: {}, console };
  vm.runInNewContext(src, sb);
  const C = sb.window.ISHUR_CONFIG.RAFFLE;
  assert.deepEqual(JSON.parse(JSON.stringify(C)), R.RAFFLE);
});
