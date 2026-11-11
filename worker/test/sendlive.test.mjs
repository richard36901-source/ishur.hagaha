// node --test worker/test/sendlive.test.mjs — the live send picture (Richard 11/11: "המונה לייב ומתי משתחרר")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseTimeline, dayCounts, etaFinish, eventRows, windowCloseMs } from '../sendlive.js';

/* the real buckets of 10–11/11/26 (two guest numbers), read from KV at 11:52 IL */
const A = { 498417: 66, 498422: 25, 498423: 22, 498440: 2 }, B = { 498417: 62, 498422: 27, 498423: 25, 498440: 1 };
const NOW = Date.parse('2026-11-11T09:52:00Z');   /* 11:52 IL, epoch hour 498441 */

test('releaseTimeline: 230 used of 250−10, 10 free, and the real release hours 12:00 +128 / 17:00 +52 / 18:00 +47', () => {
  const t = releaseTimeline({ bucketsByPid: { a: A, b: B }, limit: 250, margin: 10, now: NOW });
  assert.equal(t.used, 230); assert.equal(t.cap, 240); assert.equal(t.free, 10);
  assert.deepEqual(t.releases.map(r => [r.at, r.n]), [
    ['2026-11-11T10:00:00.000Z', 128], ['2026-11-11T15:00:00.000Z', 52], ['2026-11-11T16:00:00.000Z', 47], ['2026-11-12T09:00:00.000Z', 3]]);
  assert.equal(t.releases[0].free_after, 138);
  /* with the old margin of 20 the morning had 0 free — exactly why Mor waited until 12:00 */
  assert.equal(releaseTimeline({ bucketsByPid: { a: A, b: B }, limit: 250, margin: 20, now: NOW }).free, 0);
});

test('dayCounts: wsent keys → per event / wave / IL day from expiration − TTL', () => {
  const ttl = 120 * 86400, exp = iso => Math.floor(Date.parse(iso) / 1000) + ttl;
  const keys = [
    { name: 'wsent:tok-m:1:972500000001', expiration: exp('2026-11-10T09:30:00Z') },
    { name: 'wsent:tok-m:1:972500000002', expiration: exp('2026-11-11T10:01:00Z') },
    { name: 'wsent:tok-m:1:972500000003', expiration: exp('2026-11-11T10:02:00Z') },
    { name: 'wsent:tok-s:1:972500000004', expiration: exp('2026-11-10T07:10:00Z') },
    { name: 'other:x', expiration: 1 }];
  const c = dayCounts(keys);
  assert.equal(c['tok-m']['1'].total, 3);
  assert.deepEqual(c['tok-m']['1'].by_day, { '2026-11-10': 1, '2026-11-11': 2 });
  assert.equal(c['tok-s']['1'].by_day['2026-11-10'], 1);
});

test('windowCloseMs: Wed 11:52 → 20:30 IL; Fri → 13:00; Shabbat/after hours → null', () => {
  assert.equal(new Date(windowCloseMs(NOW)).toISOString(), '2026-11-11T18:30:00.000Z');
  assert.equal(new Date(windowCloseMs(Date.parse('2026-11-13T08:00:00Z'))).toISOString(), '2026-11-13T11:00:00.000Z');
  assert.equal(windowCloseMs(Date.parse('2026-11-14T08:00:00Z')), null);
  assert.equal(windowCloseMs(Date.parse('2026-11-11T19:00:00Z')), null);
});

test('etaFinish: 89 left, 10 free now, 128 at 12:00, 25 per 10-min tick → done 12:30 IL', () => {
  const t = releaseTimeline({ bucketsByPid: { a: A, b: B }, limit: 250, margin: 10, now: NOW });
  const e = etaFinish({ remaining: 89, free: t.free, releases: t.releases, now: NOW, closeAt: windowCloseMs(NOW), pace: 25 });
  assert.equal(e.done, true); assert.equal(e.at, '2026-11-11T10:32:00.000Z'); assert.equal(e.today, 89);
  /* nothing fits before the window closes → carried */
  const late = etaFinish({ remaining: 50, free: 0, releases: [{ at_ms: Date.parse('2026-11-12T09:00:00Z'), n: 50 }], now: NOW, closeAt: windowCloseMs(NOW) });
  assert.equal(late.done, false); assert.equal(late.carried, 50); assert.equal(late.why, 'no-room-today');
});

test('eventRows: Mor first by waveorder, Shoham next on the room Mor leaves; sent/left/ETA per wave', () => {
  const today = '2026-11-11';
  const mk = (n, tok) => Array.from({ length: n }, (_, i) => ({ phone: '9725' + tok + String(i).padStart(5, '0'), rsvp: '' }));
  const events = [
    { token: 'shoham-0000', name: 'שוהם ושי', date: '2026-12-01', waves: { 1: '2026-11-10', 2: '', 3: '' } },
    { token: 'mor-0000000', name: 'מור ונועם', date: '2026-12-05', waves: { 1: '2026-11-09', 2: '2026-11-20', 3: '' } }];
  const guests = { 'shoham-0000': mk(400, '1'), 'mor-0000000': mk(510, '2') };
  const flags = { 'shoham-0000': { order: 1, prio: 115 }, 'mor-0000000': { order: 0, prio: 0 } };
  const counts = { 'shoham-0000': { 1: { total: 118, by_day: { '2026-11-10': 115, [today]: 3 } } }, 'mor-0000000': { 1: { total: 421, by_day: { '2026-11-10': 112, [today]: 0 } } } };
  const t = releaseTimeline({ bucketsByPid: { a: A, b: B }, limit: 250, margin: 10, now: NOW });
  const rows = eventRows({ events, guests, flags, counts, shares: { 'shoham-0000': 3 }, today, now: NOW, free: t.free, releases: t.releases, closeAt: windowCloseMs(NOW) });
  assert.deepEqual(rows.map(r => r.name + ' w' + r.wave), ['מור ונועם w1', 'מור ונועם w2', 'שוהם ושי w1']);
  const mor = rows[0]; assert.equal(mor.sent, 421); assert.equal(mor.left, 89); assert.equal(mor.gate, 'queue'); assert.equal(mor.eta.done, true); assert.equal(mor.eta.at, '2026-11-11T10:32:00.000Z');
  assert.equal(rows[1].gate, 'not-yet'); assert.equal(rows[1].eta, null);
  const sh = rows[2]; assert.equal(sh.left, 282); assert.equal(sh.eta.position, 2); assert.equal(sh.eta.daily_share, 112);
  /* Shoham's 112 for today start after Mor's 89 and fit before 20:30 */
  assert.equal(sh.eta.done, true); assert.ok(sh.eta.at > mor.eta.at, sh.eta.at);
  assert.equal(sh.eta.carried, 282 - 112);
});
