// node --test worker/test/budget.test.mjs — 02/11 budget math (Richard: "never send a batch that will be refused")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierLimit, epochHour, windowHours, rollingUsed, nextFreeAt, numberState, capacity, fitBatch, planVsCapacity } from '../budget.js';
import { pickGuestPhone, guestCapacity, guestBudgetLeft, bumpGuestSend } from '../whatsapp.js';

function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; }
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const env = (store, extra = {}) => ({ WA_PHONE_ID_GUESTS: 'A', WA_PHONE_IDS_GUESTS: 'B', WA_TOKEN_GUESTS: 't', RATE: kv(store), ...extra });
const H = epochHour(Date.now());
const tiers = (a = 'TIER_250', b = 'TIER_250') => JSON.stringify({ tier: a, numbers: [{ id: 'A', tier: a }, { id: 'B', tier: b }] });

test('tier names map to limits', () => {
  assert.equal(tierLimit('TIER_250'), 250); assert.equal(tierLimit('TIER_1K'), 1000);
  assert.equal(tierLimit('nope', 7), 7); assert.equal(tierLimit('TIER_UNLIMITED'), Infinity);
});

test('rolling 24h: 25 buckets, a send 24h+ ago no longer counts', () => {
  const now = Date.now();
  assert.equal(windowHours(now).length, 25);
  const b = { [H]: 3, [H - 10]: 4, [H - 24]: 2, [H - 25]: 100 };
  assert.equal(rollingUsed(b, now), 9);
  assert.equal(nextFreeAt(b, now), (H - 24 + 25) * 3600e3);
  assert.equal(nextFreeAt({}, now), null);
});

test('yesterday-evening burst still counts this morning (the day counter forgets it)', () => {
  const s = numberState({ limit: 250, dayUsed: 0, rolling: 240 });
  assert.equal(s.used, 240); assert.equal(s.remaining, 10);
});

test('portfolio scope: two numbers share ONE limit (Meta docs, 02/11)', () => {
  const a = numberState({ id: 'A', limit: 250, dayUsed: 200 });
  const b = numberState({ id: 'B', limit: 250, dayUsed: 30 });
  const c = capacity([a, b], { scope: 'portfolio', portfolioLimit: 250 });
  assert.equal(c.limit, 250); assert.equal(c.used, 230); assert.equal(c.remaining, 20);
});

test('number scope: limits add up to 500 (Richard\'s model, GUEST_CAP_SCOPE=number)', () => {
  const a = numberState({ id: 'A', limit: 250, dayUsed: 200 });
  const b = numberState({ id: 'B', limit: 250, dayUsed: 30 });
  const c = capacity([a, b], { scope: 'number' });
  assert.equal(c.limit, 500); assert.equal(c.remaining, 50 + 220);
});

test('a held number contributes nothing; until-time in the future = held', () => {
  const now = Date.now();
  const a = numberState({ id: 'A', limit: 250, dayUsed: 0, heldUntil: now + 60e3, now });
  const b = numberState({ id: 'B', limit: 250, dayUsed: 240, now });
  assert.equal(a.held, true); assert.equal(a.remaining, 0);
  assert.equal(capacity([a, b], { scope: 'portfolio', portfolioLimit: 250 }).remaining, 10, 'shared room 10, B can carry 10');
  assert.equal(capacity([a, b], { scope: 'number' }).remaining, 10);
});

test('margin is subtracted from the shared room', () => {
  const a = numberState({ id: 'A', limit: 250, dayUsed: 100, margin: 20 });
  assert.equal(capacity([a], { scope: 'portfolio', portfolioLimit: 250, margin: 20 }).remaining, 130);
});

test('fitBatch: send only what fits, hold the rest with reason cap', () => {
  assert.deepEqual(fitBatch(10, 25), { send: 10, held: 15, reason: 'cap' });
  assert.deepEqual(fitBatch(100, 25), { send: 25, held: 0, reason: '' });
  assert.deepEqual(fitBatch(0, 25), { send: 0, held: 25, reason: 'cap' });
  assert.deepEqual(fitBatch(-3, 5), { send: 0, held: 5, reason: 'cap' });
});

test('plan vs capacity: today uses the room left, later days the full limit; over → flagged', () => {
  const r = planVsCapacity({ '2026-11-03': 300, '2026-11-04': 120, '2026-11-05': 260 }, { today: '2026-11-03', remainingNow: 40, limit: 250 });
  assert.deepEqual(r.map(x => [x.day, x.planned, x.capacity, x.over, x.short_by]), [
    ['2026-11-03', 300, 40, true, 260], ['2026-11-04', 120, 250, false, 0], ['2026-11-05', 260, 250, true, 10]]);
});

test('whatsapp: real tiers from wa:cap, portfolio default → 250 shared, minus the default margin of 20', async () => {
  const e = env({ 'wa:cap': tiers(), [`gsend:A:${day}`]: '180', [`gsend:B:${day}`]: '40' });
  const c = await guestCapacity(e);
  assert.equal(c.scope, 'portfolio'); assert.equal(c.limit, 250); assert.equal(c.margin, 20);
  assert.equal(c.remaining, 250 - 20 - 220);
  assert.equal(await pickGuestPhone(e), 'B');
  const full = env({ 'wa:cap': tiers(), [`gsend:A:${day}`]: '200', [`gsend:B:${day}`]: '30' });
  assert.equal((await guestCapacity(full)).remaining, 0, '230 used = the margin line');
  assert.equal(await pickGuestPhone(full), '');
  assert.equal((await guestCapacity(env({ 'wa:cap': tiers(), [`gsend:A:${day}`]: '200', [`gsend:B:${day}`]: '30' }, { GUEST_BUDGET_MARGIN: '0' }))).remaining, 20);
});

test('whatsapp: a portfolio number that spent its share is skipped, the other still offered', async () => {
  const e = env({ 'wa:cap': tiers(), [`gsend:A:${day}`]: '200', [`gsend:B:${day}`]: '5' });
  assert.equal(await pickGuestPhone(e), 'B');
});

test('whatsapp: GUEST_CAP_SCOPE=number → 500 total from two TIER_250 numbers (margin 20 off the total)', async () => {
  const e = env({ 'wa:cap': tiers(), [`gsend:A:${day}`]: '200', [`gsend:B:${day}`]: '40' }, { GUEST_CAP_SCOPE: 'number' });
  const c = await guestCapacity(e);
  assert.equal(c.limit, 500); assert.equal(c.remaining, 500 - 20 - 240);
});

test('whatsapp: no room → no number for a template, but a reply still gets one', async () => {
  const e = env({ 'wa:cap': tiers(), [`gsend:A:${day}`]: '250', [`gsend:B:${day}`]: '10' });
  assert.equal(await guestBudgetLeft(e), 0);
  assert.equal(await pickGuestPhone(e), '');
  assert.equal(await pickGuestPhone(e, { template: false }), 'B');
});

test('whatsapp: the hourly buckets (rolling 24h) count even when the day counter is 0', async () => {
  const e = env({ 'wa:cap': tiers(), [`gsendh:A:${H - 12}`]: '150', [`gsendh:B:${H - 3}`]: '100' });
  assert.equal((await guestCapacity(e)).remaining, 0);
  assert.equal(await pickGuestPhone(e), '');
});

test('whatsapp: bumpGuestSend writes the day counter AND the hour bucket', async () => {
  const e = env({});
  await bumpGuestSend(e, 'A');
  assert.equal(e.RATE.m.get(`gsend:A:${day}`), '1');
  assert.equal(e.RATE.m.get(`gsendh:A:${H}`), '1');
});
