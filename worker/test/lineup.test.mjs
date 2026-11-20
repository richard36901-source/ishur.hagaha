// node --test worker/test/lineup.test.mjs — the event schedule (lineup.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../lineup.js';

test('a wedding is worked back from the reception, with the drive time and 15 minutes of margin', () => {
  const s = L.suggest({ occasion: 'חתונה', reception: '19:00', ceremony: '20:15', drive: 40, from: 'רמת גן' });
  const at = t => s.find(x => x.text.startsWith(t));
  assert.equal(L.toHM(at('יציאה לאולם').m), '17:05');   /* 19:00 − 60 at the venue − 40 drive − 15 margin */ assert.match(at('יציאה לאולם').text, /מרמת גן.*40 דקות/);
  assert.equal(L.toHM(at('קבלת פנים').m), '19:00'); assert.equal(L.toHM(at('חופה').m), '20:15'); assert.equal(L.toHM(at('חתימה').m), '19:55');
  assert.equal(L.toHM(at('סיום').m), '01:15'); assert.ok(at('סיום').m >= 1440, 'after midnight counts as the next day');
  assert.deepEqual(s.map(x => x.m), [...s.map(x => x.m)].sort((a, b) => a - b));
});
test('other occasions get a shorter day; no ceremony time means 45 minutes after the reception', () => {
  const s = L.suggest({ occasion: 'בר מצווה', reception: '18:00' });
  assert.equal(L.toHM(s.find(x => x.text.startsWith('טקס')).m), '18:45');
  assert.ok(!s.some(x => /חופה|כתובה/.test(x.text)));
});
test('clean keeps only sane lines, sorted, capped', () => {
  const c = L.clean({ date: '2026-12-02', title: 'איתי', items: [{ m: 1200, text: 'ב' }, { m: 600, text: 'א\nשורה' }, { m: -5, text: 'x' }, { m: 3000, text: 'y' }, { m: 700, text: '' }], drive: 999, ceremony: '25:00' });
  assert.deepEqual(c.items, [{ m: 600, text: 'א שורה' }, { m: 1200, text: 'ב' }]);
  assert.equal(c.drive, 300); assert.equal(c.ceremony, '');
  assert.equal(L.clean({ date: '2/12/2026' }).date, '');
  assert.equal(L.clean({ items: Array.from({ length: 90 }, (_, i) => ({ m: i, text: 'x' })) }).items.length, 40);
});
test('Israel time is converted to UTC with the right offset for the day (winter +2, summer +3)', () => {
  assert.equal(L.ilUtc('2026-12-02', 19 * 60), '20261202T170000Z');
  assert.equal(L.ilUtc('2026-07-01', 19 * 60), '20260701T160000Z');
  assert.equal(L.ilUtc('2026-12-02', 1440 + 75), '20261202T231500Z', 'after midnight is the next day');
});
test('the calendar file: one entry per line, fixed ids, venue, escaped text, CRLF', () => {
  const rec = L.clean({ date: '2026-12-02', title: 'איתי', venue: 'אולמי הדקל, חיפה', items: [{ m: 1080, text: 'קבלת פנים' }, { m: 1125, text: 'טקס; פתיחה' }] });
  const f = L.ics(rec, 'aaaaaaaa-0000-4000-8000-000000000001', new Date(Date.UTC(2026, 10, 20)));
  assert.match(f, /^BEGIN:VCALENDAR\r\n/); assert.match(f, /END:VCALENDAR\r\n$/);
  assert.equal((f.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(f, /UID:lineup-aaaaaaaa-0@ishur\.io/); assert.match(f, /DTSTART:20261202T160000Z\r\nDTEND:20261202T164500Z/);
  assert.match(f, /SUMMARY:טקס\; פתיחה/); assert.match(f, /LOCATION:אולמי הדקל\\, חיפה/);
  assert.ok(f.split('\r\n').every(l => Buffer.byteLength(l, 'utf8') <= 75), 'lines folded');
  assert.equal((L.ics(L.clean({ items: rec.items }), 'x'.repeat(36)).match(/BEGIN:VEVENT/g) || []).length, 0, 'no date, no entries');
});
test('the feed key is fixed per token and differs between tokens', async () => {
  const env = { ADMIN_KEY: 'k' };
  const a = await L.feedKey(env, 'aaaa'), b = await L.feedKey(env, 'bbbb');
  assert.match(a, /^[0-9a-f]{16}$/); assert.equal(a, await L.feedKey(env, 'aaaa')); assert.notEqual(a, b);
});

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
test('storage: with the database a save reads back at once; without it, KV', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(new URL('../migrations-app/0002_lineups.sql', import.meta.url), 'utf8'));
  const mk = (sql, a = []) => ({ bind: (...x) => mk(sql, x), first: async () => db.prepare(sql).get(...a) ?? null, run: async () => db.prepare(sql).run(...a) });
  const m = new Map(), kv = { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
  const withDb = { RATE: kv, APP_DB: { prepare: sql => mk(sql) } }, T = 'aaaaaaaa-0000-4000-8000-000000000001';
  assert.equal(await L.readRec(withDb, T), null);
  await L.writeRec(withDb, T, { items: [{ m: 600, text: 'א' }], at: 'x' });
  await L.writeRec(withDb, T, { items: [{ m: 700, text: 'ב' }], at: 'y' });
  assert.deepEqual((await L.readRec(withDb, T)).items, [{ m: 700, text: 'ב' }]);
  assert.equal(m.size, 0, 'nothing in KV when the database is there');
  const noDb = { RATE: kv };
  await L.writeRec(noDb, T, { items: [{ m: 800, text: 'ג' }] });
  assert.deepEqual((await L.readRec(noDb, T)).items, [{ m: 800, text: 'ג' }]);
});
