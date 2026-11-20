// node --test worker/test/app-events.test.mjs — the client app's usage events (app-events.js). Spec P17, P18.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../app-events.js';
import { handleApp } from '../app-push.js';

function kv() {
  const m = new Map();
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(); const from = Number(cursor) || 0, page = all.slice(from, from + limit); return { keys: page.map(name => ({ name })), list_complete: from + limit >= all.length, cursor: String(from + limit) }; } };
}
const A = '972521234567', B = '972529999999';
const at = (d, h = 12) => new Date(Date.UTC(2026, 10, d, h - 2));   // Israel is UTC+2 in late November
let env;
beforeEach(() => { env = { RATE: kv(), ADMIN_KEY: 'k' }; });
const stored = () => [...env.RATE.m.entries()].filter(([k]) => k.startsWith('appev:'));
const ev = (n, p, t) => ({ n, t, s: 'abcd12', p });

test('P17 unknown names, Hebrew values and phone-like values are not stored; no phone in the record', async () => {
  const now = at(20), t = now.getTime();
  const r = await E.ingest(env, A, { plat: 'ios', ver: '1.0.0', events: [
    ev('tab_view', { tab: 'guests' }, t), ev('made_up', { tab: 'x' }, t), ev('board_click', { page: 'dashboard', id: 'דנה כהן' }, t),
    ev('board_click', { page: 'dashboard', id: '0521234567' }, t), ev('guest_search', { q: 'דנה', secret: 'x' }, t),
    ev('js_error', { msg: 'TypeError: דנה 0521234567 is not a function' }, t), ev('tab_view', { tab: 972521234567 }, t),
  ] }, { now });
  assert.equal(r.ok, true); assert.equal(r.kept, 6); assert.equal(r.dropped, 1);
  const all = JSON.stringify(stored());
  assert.doesNotMatch(all, /made_up/); assert.doesNotMatch(all, /[֐-׿]/); assert.doesNotMatch(all, /521234567/);
  assert.doesNotMatch(all, /972521234567|0521234567/);
  const [key, val] = stored()[0], rec = JSON.parse(val);
  assert.match(key, /^appev:20261120:[0-9a-f]{16}:/);
  assert.deepEqual(rec.ev.map(e => [e.n, e.p]), [['tab_view', { tab: 'guests' }], ['board_click', { page: 'dashboard' }], ['board_click', { page: 'dashboard' }], ['guest_search', {}], ['js_error', { msg: 'TypeError:    is not a function' }], ['tab_view', {}]]);
  assert.equal(rec.plat, 'ios'); assert.equal(rec.ver, '1.0.0');
});
test('the same phone gets the same id, another phone another, and the id is not the phone', async () => {
  const a = await E.uidFor(env, A), a2 = await E.uidFor(env, '+972-52-1234567'), b = await E.uidFor(env, B);
  assert.equal(a, a2); assert.equal(a, await E.uidFor(env, '052-1234567')); assert.notEqual(a, b); assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(await E.uidFor({ ADMIN_KEY: 'other' }, A), a);
});
test('a batch is capped at 50 events and a client at 240 batches an hour', async () => {
  const now = at(20), t = now.getTime();
  const r = await E.ingest(env, A, { events: Array.from({ length: 80 }, () => ev('app_open', {}, t)) }, { now });
  assert.equal(r.kept, 50);
  env.RATE.m.set('rl:appev:' + await E.uidFor(env, A) + ':' + Math.floor(t / 3600e3), '240');
  assert.deepEqual(await E.ingest(env, A, { events: [ev('app_open', {}, t)] }, { now }), { ok: false, error: 'slow-down' });
  assert.equal((await E.ingest(env, B, { events: [ev('app_open', {}, t)] }, { now })).ok, true);
});
test('an event time far from now is replaced by the time of arrival', () => {
  const now = Date.UTC(2026, 10, 20);
  assert.equal(E.cleanEvent(ev('app_open', {}, now - 30 * 86400e3), now).t, now);
  assert.equal(E.cleanEvent(ev('app_open', {}, now - 3600e3), now).t, now - 3600e3);
  assert.equal(E.cleanEvent({ n: 'app_open', s: 'DROP TABLE' }, now).s, '');
});
test('report: clients per day, tabs, board controls, funnel and return on day 1', async () => {
  const d19 = at(19), d20 = at(20);
  await E.ingest(env, A, { plat: 'ios', ver: '1.0.0', events: [ev('signin_ok', {}, d19.getTime()), ev('tab_view', { tab: 'board' }, d19.getTime()), ev('board_view', { page: 'dashboard' }, d19.getTime()), ev('push_sheet_view', {}, d19.getTime()), ev('push_yes', {}, d19.getTime())] }, { now: d19 });
  await E.ingest(env, B, { plat: 'android', ver: '1.0.0', events: [ev('signin_ok', {}, d19.getTime()), ev('tab_view', { tab: 'guests' }, d19.getTime())] }, { now: d19 });
  await E.ingest(env, A, { plat: 'ios', ver: '1.0.0', events: [ev('app_open', {}, d20.getTime()), ev('tab_view', { tab: 'guests' }, d20.getTime()), ev('board_click', { page: 'dashboard', id: 'editInvite' }, d20.getTime()), ev('js_error', { msg: 'x is undefined' }, d20.getTime())] }, { now: d20 });
  const r = await E.report(env, { days: 3, now: d20, phone: A });
  assert.deepEqual(r.daily.map(x => [x.day, x.clients, x.events]), [['20261118', 0, 0], ['20261119', 2, 7], ['20261120', 1, 4]]);
  assert.equal(r.clients, 2); assert.deepEqual(r.tabs, { board: 1, guests: 2 });
  assert.deepEqual(r.board_controls, { 'dashboard#editInvite': 1 }); assert.deepEqual(r.board_pages, { dashboard: 1 });
  assert.deepEqual(r.errors, { 'x is undefined': 1 }); assert.deepEqual(r.platforms, { ios: 1, android: 1 });
  const f = Object.fromEntries(r.funnel.map(x => [x.step, x.clients]));
  assert.deepEqual([f.signed_in, f.saw_board, f.opened_guests, f.asked_about_notifications, f.said_yes_to_notifications], [2, 1, 2, 1, 1]);
  assert.deepEqual(r.return, { new_clients: 2, day1_eligible: 2, day1: 1, day7_eligible: 0, day7: 0 });
  assert.deepEqual(r.client.active_days, ['20261119', '20261120']); assert.equal(r.client.events.board_click, 1);
  assert.ok(env.RATE.m.has('appsum:20261119'), 'a finished day is kept'); assert.ok(!env.RATE.m.has('appsum:20261120'), 'today is not');
  assert.doesNotMatch(JSON.stringify(r), /97252/);
});
test('P18 purge removes one client and leaves the other; the kept day summary is rebuilt', async () => {
  const d19 = at(19), d20 = at(20);
  await E.ingest(env, A, { events: [ev('app_open', {}, d19.getTime())] }, { now: d19 });
  await E.ingest(env, B, { events: [ev('app_open', {}, d19.getTime())] }, { now: d19 });
  await E.report(env, { days: 2, now: d20 });
  const r = await E.purge(env, A), ua = await E.uidFor(env, A), ub = await E.uidFor(env, B);
  assert.equal(r.removed, 1);
  assert.ok(![...env.RATE.m.keys()].some(k => k.includes(ua) && !k.startsWith('rl:')), 'nothing of A is left');
  assert.ok([...env.RATE.m.keys()].some(k => k.startsWith('appev:') && k.includes(ub)));
  assert.equal((await E.report(env, { days: 2, now: d20 })).clients, 1);
});
test('routes: events need a session, the report and the purge need the admin key, a delete request purges', async () => {
  const d = { deny: (status, error) => ({ status, error }), okJson: x => ({ status: 200, body: x }), isAdmin: (e, k) => k === 'k', logEvent: async () => {}, verifySession: async (e, s) => (s === 'good' ? A : '') };
  const call = (path, body) => handleApp(new Request('https://x/api/app/' + path, { method: 'POST', body: JSON.stringify(body) }), env, '', new URL('https://x/api/app/' + path), d);
  assert.equal((await call('events', { session: 'bad', events: [ev('app_open', {}, Date.now())] })).status, 401);
  assert.equal((await call('events', { session: 'good', events: [ev('app_open', {}, Date.now())] })).body.kept, 1);
  assert.equal((await call('analytics', { admin_key: 'no' })).status, 403);
  assert.equal((await call('analytics', { admin_key: 'k', days: 1 })).body.clients, 1);
  assert.equal((await call('events-purge', { admin_key: 'no', phone: A })).status, 403);
  assert.equal((await call('delete-request', { session: 'good' })).body.ok, true);
  assert.equal(stored().length, 0);
});

/* ── the same behaviour with the D1 database bound (APP_DB). node:sqlite stands in for D1 and runs the real SQL. ── */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../migrations-app/0001_app_events.sql', import.meta.url), 'utf8'));
  const mk = (sql, args = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) ?? null, run: async () => { db.prepare(sql).run(...args); return { success: true }; }, _run: () => db.prepare(sql).run(...args) });
  return { db, prepare: sql => mk(sql), batch: async stmts => { for (const st of stmts) st._run(); return []; } };
}
const fill = async (e, d19, d20) => {
  await E.ingest(e, A, { plat: 'ios', ver: '1.0.0', events: [ev('signin_ok', {}, d19.getTime()), ev('tab_view', { tab: 'board' }, d19.getTime()), ev('board_view', { page: 'dashboard' }, d19.getTime()), ev('push_sheet_view', {}, d19.getTime()), ev('push_yes', {}, d19.getTime())] }, { now: d19 });
  await E.ingest(e, B, { plat: 'android', ver: '1.0.0', events: [ev('signin_ok', {}, d19.getTime()), ev('tab_view', { tab: 'guests' }, d19.getTime())] }, { now: d19 });
  await E.ingest(e, A, { plat: 'ios', ver: '1.0.0', events: [ev('app_open', {}, d20.getTime()), ev('tab_view', { tab: 'guests' }, d20.getTime()), ev('board_click', { page: 'dashboard', id: 'editInvite' }, d20.getTime()), ev('js_error', { msg: 'x is undefined' }, d20.getTime())] }, { now: d20 });
};
test('database: the report is identical to the one from KV', async () => {
  const d19 = at(19), d20 = at(20), kvEnv = { RATE: kv(), ADMIN_KEY: 'k' }, dbEnv = { RATE: kv(), ADMIN_KEY: 'k', APP_DB: d1() };
  await fill(kvEnv, d19, d20); await fill(dbEnv, d19, d20);
  const a = await E.report(kvEnv, { days: 3, now: d20, phone: A }), b = await E.report(dbEnv, { days: 3, now: d20, phone: A });
  assert.deepEqual(b, a);
  assert.equal(b.clients, 2); assert.deepEqual(b.return, { new_clients: 2, day1_eligible: 2, day1: 1, day7_eligible: 0, day7: 0 });
  assert.ok(![...dbEnv.RATE.m.keys()].some(k => k.startsWith('appev:')), 'with a database nothing is written to KV but the rate counter');
});
test('database: rows hold no phone, no Hebrew and no unknown event; purge removes one client only', async () => {
  const now = at(20), t = now.getTime(), e = { RATE: kv(), ADMIN_KEY: 'k', APP_DB: d1() };
  await E.ingest(e, A, { plat: 'ios', ver: '1.0.0', events: [ev('tab_view', { tab: 'guests' }, t), ev('made_up', {}, t), ev('board_click', { page: 'dashboard', id: 'דנה כהן' }, t), ev('board_click', { page: 'dashboard', id: '0521234567' }, t)] }, { now });
  await E.ingest(e, B, { events: [ev('app_open', {}, t)] }, { now });
  const rows = e.APP_DB.db.prepare('SELECT * FROM app_events').all(), dump = JSON.stringify(rows) + JSON.stringify(e.APP_DB.db.prepare('SELECT * FROM app_users').all());
  assert.equal(rows.length, 4); assert.doesNotMatch(dump, /made_up|[\u0590-\u05FF]|521234567/);
  assert.deepEqual(await E.purge(e, A), { ok: true, removed: 3 });
  assert.equal(e.APP_DB.db.prepare('SELECT COUNT(*) AS c FROM app_events').get().c, 1);
  assert.equal(e.APP_DB.db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c, 1);
});
