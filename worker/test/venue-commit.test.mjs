// node --test worker/test/venue-commit.test.mjs — the venue commitment tile (venue-commit.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../venue-commit.js';

function kv() { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; }
const TOK = '11111111-2222-3333-4444-555555555555';

test('recommendation: confirmed + half the undecided + 30% of the silent, in people', () => {
  assert.deepEqual(V.recommend({ confirmed_seats: 70, undecided_seats: 20, pending_seats: 30, declined_seats: 30 }), { ready: true, n: 89 });
  assert.deepEqual(V.recommend({ confirmed: 10, undecided: 0, pending: 0, declined: 0 }), { ready: true, n: 10 });
});
test('no recommendation before half of the invited people answered', () => {
  assert.deepEqual(V.recommend({ confirmed_seats: 10, undecided_seats: 0, pending_seats: 90, declined_seats: 0 }), { ready: false, n: null });
  assert.deepEqual(V.recommend({}), { ready: false, n: null });
  assert.equal(V.recommend({ confirmed_seats: 50, pending_seats: 50 }).ready, true);
});
test('agrees with the recommendation within 5 people or 5%', () => {
  assert.equal(V.fits(89, 89), true); assert.equal(V.fits(94, 89), true); assert.equal(V.fits(84, 89), true);
  assert.equal(V.fits(95, 89), false); assert.equal(V.fits(83, 89), false);
  assert.equal(V.fits(420, 400), true); assert.equal(V.fits(421, 400), false);
  assert.equal(V.fits(0, 89), false); assert.equal(V.fits(89, 0), false);
});
test('only a whole number from 0 to 5000 is accepted; empty clears', () => {
  assert.equal(V.parseCommit('120'), 120); assert.equal(V.parseCommit(120), 120); assert.equal(V.parseCommit(''), 0); assert.equal(V.parseCommit(null), 0);
  for (const bad of ['12.5', '-3', 'abc', '5001', '1e3x', {}]) assert.equal(V.parseCommit(bad), null, String(bad));
});
test('saved, read back with the status, cleared', async () => {
  const env = { RATE: kv() }, totals = { confirmed_seats: 70, undecided_seats: 20, pending_seats: 30, declined_seats: 30 };
  assert.deepEqual(await V.venueFor(env, TOK, totals), { commit: null, recommended: 89, ready: true, ok: null, diff: null });
  await V.writeCommit(env, TOK, 90);
  assert.deepEqual(await V.venueFor(env, TOK, totals), { commit: 90, recommended: 89, ready: true, ok: true, diff: 1 });
  await V.writeCommit(env, TOK, 120);
  assert.deepEqual(await V.venueFor(env, TOK, totals), { commit: 120, recommended: 89, ready: true, ok: false, diff: 31 });
  assert.deepEqual(await V.venueFor(env, TOK, { confirmed_seats: 5, pending_seats: 95 }), { commit: 120, recommended: null, ready: false, ok: null, diff: null });
  await V.writeCommit(env, TOK, 0);
  assert.equal(env.RATE.m.size, 0);
});

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
test('with the database: saved, changed and cleared, nothing in KV', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(new URL('../migrations-app/0003_venue_commits.sql', import.meta.url), 'utf8'));
  const mk = (sql, a = []) => ({ bind: (...x) => mk(sql, x), first: async () => db.prepare(sql).get(...a) ?? null, run: async () => db.prepare(sql).run(...a) });
  const env = { RATE: kv(), APP_DB: { prepare: sql => mk(sql) } }, totals = { confirmed_seats: 70, undecided_seats: 20, pending_seats: 30, declined_seats: 30 };
  await V.writeCommit(env, TOK, 90); assert.equal((await V.venueFor(env, TOK, totals)).commit, 90);
  await V.writeCommit(env, TOK, 120); assert.equal((await V.venueFor(env, TOK, totals)).commit, 120);
  await V.writeCommit(env, TOK, 0); assert.equal((await V.venueFor(env, TOK, totals)).commit, null);
  assert.equal(env.RATE.m.size, 0);
});
