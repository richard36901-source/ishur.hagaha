// node --test worker/test/d1mirror.test.mjs — 26/11 phase 1 of the D1 move: the sheet mirrored into D1.
// The fake D1 runs the REAL d1/schema.sql and the module's real SQL on node:sqlite,
// with the D1 surface the Worker uses: prepare / bind / run / all / first / batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { mirrorSnapshot, mirrorAfterRefresh, reconcile, counts, keyedRows, normRow, columnsOf, TABLES, FLAG_KEY, _resetD1Memo, handleD1Mirror } from '../d1mirror.js';
import { readSnapshot, _resetSnapshotState } from '../snapshot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '..', 'd1', 'schema.sql'), 'utf8');

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const n = { reads: 0, writes: 0, statements: 0, batches: 0 };
  const isWrite = sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    run: async () => { n.statements++; const r = db.prepare(sql).run(...args); if (isWrite(sql)) n.writes += Number(r.changes); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => { n.statements++; const rows = db.prepare(sql).all(...args); n.reads += rows.length; return { success: true, results: rows }; },
    first: async col => { n.statements++; const r = db.prepare(sql).get(...args); n.reads++; return r ? (col ? r[col] : r) : null; },
  });
  return {
    db, n,
    prepare: sql => stmt(sql),
    batch: async list => {
      n.batches++;
      db.exec('BEGIN');
      try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
function kv(init = {}) {
  const m = new Map(Object.entries(init)); const n = { get: 0, put: 0, del: 0, list: 0 };
  return { m, n,
    get: async k => { n.get++; return m.has(k) ? m.get(k) : null; },
    put: async (k, v) => { n.put++; m.set(k, String(v)); },
    delete: async k => { n.del++; m.delete(k); },
    list: async ({ prefix = '' } = {}) => { n.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
const ON = { [FLAG_KEY]: JSON.stringify({ value: 'on' }) };

/* a small sheet in the real column layout */
function sheet({ guests = 40, drop = [], edit = {} } = {}) {
  const tok = 'aaaaaaaa-0000-4000-8000-000000000001';
  const ev = Array(45).fill(''); ev[1] = tok; ev[2] = 'לקוחה'; ev[3] = '0500000101'; ev[6] = '2026-12-24'; ev[31] = 'פרמיום'; ev[39] = '2026-12-01';
  const ev2 = Array(10).fill(''); ev2[1] = 'bbbbbbbb-0000-4000-8000-000000000002'; ev2[2] = 'לקוח';
  const g = [];
  for (let i = 1; i <= guests; i++) {
    if (drop.includes(i)) continue;
    const r = Array(31).fill('');   /* trailing empties: Google would drop them, Make may not */
    r[2] = `G-${i}`; r[3] = `אורח ${i}`; r[4] = '05500' + String(10000 + i); r[5] = String(1 + (i % 3)); r[15] = i % 2 ? 'מגיע' : ''; r[13] = i % 2 ? '2' : ''; r[28] = tok;
    if (edit[i]) Object.assign(r, edit[i]);
    g.push(r);
  }
  return { ok: true, events: { values: [ev, ev2] }, guests: { values: g }, leads: { values: [['', 'ליד', '050-0000102', 'a@b.c'], ['', 'ליד ב', '0500000103']] } };
}
const env = (flag = true) => ({ DB: fakeD1(), RATE: kv(flag ? ON : {}) });

test('schema.sql: every mirror column the module writes exists with the declared type (the real file, real SQLite)', () => {
  const d = fakeD1();
  for (const t of TABLES) {
    const info = d.db.prepare(`PRAGMA table_info(${t})`).all();
    const have = new Map(info.map(c => [c.name, c.type]));
    for (const c of columnsOf(t)) assert.equal(have.get(c.name), c.type, `${t}.${c.name}`);
    for (const extra of ['key', 'raw', 'hash', 'first_seen', 'updated_at', 'deleted_at', 'sheet_row']) assert.ok(have.has(extra), `${t}.${extra}`);
  }
  for (const t of ['sends', 'calls', 'messages', 'answers_history', 'team_items', 'mirror_runs']) assert.ok(d.db.prepare(`PRAGMA table_info(${t})`).all().length, t);
  const idx = d.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  for (const i of ['guests_token_rsvp', 'guests_phone', 'events_phone', 'sends_day', 'calls_day', 'messages_phone_at', 'messages_day']) assert.ok(idx.includes(i), i);
  /* the migrations, applied in order, build exactly what schema.sql builds */
  const mig = new DatabaseSync(':memory:');
  const dir = path.join(HERE, '..', 'd1', 'migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) mig.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  const shape = x => x.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(r => ({ ...r, sql: String(r.sql || '').replace(/\s+/g, ' ') }));
  assert.deepEqual(shape(mig), shape(d.db));
});

test('first pass writes every row with typed columns; a second identical pass is idempotent and writes NOTHING', async () => {
  const e = env();
  const r1 = await mirrorSnapshot(e, sheet());
  assert.equal(r1.ok, true);
  assert.deepEqual([r1.tabs.events.upserted, r1.tabs.guests.upserted, r1.tabs.leads.upserted], [2, 40, 2]);
  const g = e.DB.db.prepare("SELECT * FROM guests WHERE key='G-3'").get();
  assert.equal(g.name, 'אורח 3'); assert.equal(g.party, 2); assert.equal(g.invited, 1); assert.equal(g.rsvp, 'מגיע'); assert.equal(g.sheet_row, 4);
  assert.equal(JSON.parse(g.raw)[3], 'אורח 3'); assert.equal(JSON.parse(g.raw).length, 29, 'trailing empties dropped');
  assert.equal(e.DB.db.prepare("SELECT send_date_1 s, plan FROM events WHERE key='aaaaaaaa-0000-4000-8000-000000000001'").get().s, '2026-12-01');
  assert.equal(e.DB.db.prepare("SELECT key FROM leads WHERE email='a@b.c'").get().key, '0500000102', 'lead key = phone digits');

  const w = e.DB.n.writes;
  const r2 = await mirrorSnapshot(e, sheet());   /* same isolate: whole-tab hash → not even a D1 read */
  assert.equal(r2.changed, 0); assert.equal(e.DB.n.writes, w, 'zero writes on the second pass');
  assert.ok(r2.tabs.guests.skippedTab);

  _resetD1Memo(e);   /* a cold isolate: re-reads the hashes from D1, still writes nothing */
  const reads = e.DB.n.reads;
  const r3 = await mirrorSnapshot(e, sheet());
  assert.equal(r3.changed, 0); assert.equal(e.DB.n.writes, w);
  assert.equal(e.DB.n.reads - reads, 44, 'one hash read per stored row, nothing else');
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) n FROM guests').get().n, 40, 'no duplicate rows');
});

test('only changed rows are written: one edited cell = one upsert; trailing-empty differences and row moves are not changes', async () => {
  const e = env();
  await mirrorSnapshot(e, sheet());
  const w = e.DB.n.writes;
  const r = await mirrorSnapshot(e, sheet({ edit: { 7: { 15: 'לא מגיע', 22: 'שיחה' } } }));
  assert.equal(r.tabs.guests.upserted, 1); assert.equal(r.tabs.guests.unchanged, 39);
  assert.equal(e.DB.n.writes - w, 2, 'the one guest row + the one mirror_runs line');
  assert.equal(e.DB.db.prepare("SELECT rsvp, call_answer FROM guests WHERE key='G-7'").get().rsvp, 'לא מגיע');
  /* same values, shorter arrays (Google) and the rows in another order */
  const s = sheet({ edit: { 7: { 15: 'לא מגיע', 22: 'שיחה' } } });
  s.guests.values = s.guests.values.map(normRow).reverse();
  const w2 = e.DB.n.writes;
  const r2 = await mirrorSnapshot(e, s);
  assert.equal(r2.changed, 0); assert.equal(e.DB.n.writes, w2);
});

test('rows gone from the sheet are detected and soft-deleted; a row that comes back is revived', async () => {
  const e = env();
  await mirrorSnapshot(e, sheet());
  const r = await mirrorSnapshot(e, sheet({ drop: [5, 6] }));
  assert.equal(r.tabs.guests.deleted, 2);
  const gone = e.DB.db.prepare('SELECT key FROM guests WHERE deleted_at IS NOT NULL ORDER BY key').all().map(x => x.key);
  assert.deepEqual(gone, ['G-5', 'G-6']);
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) n FROM guests').get().n, 40, 'soft: the rows are kept');
  const again = await mirrorSnapshot(e, sheet({ drop: [5, 6] }));
  assert.equal(again.changed, 0, 'deleting twice costs nothing');
  const back = await mirrorSnapshot(e, sheet({ drop: [6] }));
  assert.equal(back.tabs.guests.upserted, 1);
  assert.equal(e.DB.db.prepare("SELECT deleted_at FROM guests WHERE key='G-5'").get().deleted_at, null);
});

test('delete guard: a missing, empty or collapsed tab deletes nothing', async () => {
  const e = env();
  await mirrorSnapshot(e, sheet());
  const s = sheet({ guests: 10 });   /* 40 → 10: under half */
  const r = await mirrorSnapshot(e, s);
  assert.equal(r.tabs.guests.guard, 'delete-guard'); assert.equal(r.tabs.guests.deleted, 0);
  const noTab = sheet(); delete noTab.guests;
  const r2 = await mirrorSnapshot(e, noTab);
  assert.equal(r2.tabs.guests.guard, 'tab-missing');
  const empty = sheet(); empty.guests.values = [];
  const r3 = await mirrorSnapshot(e, empty);
  assert.equal(r3.tabs.guests.deleted, 0); assert.equal(r3.tabs.guests.guard, 'delete-guard');
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) n FROM guests WHERE deleted_at IS NULL').get().n, 40);
});

test('keys: blank ids fall back to token+phone, duplicate ids are suffixed so counts still match', () => {
  const tok = 't1';
  const rows = [['', '', 'G-1', 'a', '0501'], ['', '', 'G-1', 'b', '0502'], ['', '', '', 'c', '050-3', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', tok], ['', '', '', 'd'], []];
  const { rows: k, dupes } = keyedRows('guests', rows);
  assert.deepEqual(k.map(r => r.key), ['G-1', 'G-1#2', 'np:t1:0503', 'row:3']);
  assert.equal(dupes, 1);
});

test('reconcile: counts sheet vs D1 match after the full pass and the Slack line says so; a gap is reported', async () => {
  const e = env();
  const posted = [];
  const slackPost = async (_env, text) => { posted.push(text); return true; };
  const rep = await reconcile(e, sheet(), { slackPost });
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.counts.guests, { sheet: 40, d1: 40, match: true });
  assert.deepEqual(rep.counts.events, { sheet: 2, d1: 2, match: true });
  assert.equal(posted.length, 1); assert.match(posted[0], /guests: גיליון 40 · D1 לפני 0 · אחרי 40/);
  assert.equal(rep.clean, false, 'the first pass had everything to write'); assert.equal(rep.drift, 44);
  const quiet = await reconcile(e, sheet(), { slackPost });
  assert.equal(quiet.clean, true); assert.equal(quiet.drift, 0, 'incremental path left nothing to heal');
  /* a row written behind the mirror's back (or a delete the guard refused) shows as a gap */
  e.DB.db.prepare("INSERT INTO guests (key, raw, hash, first_seen, updated_at) VALUES ('stray', '[]', 'x', 'now', 'now')").run();
  const c = await counts(e, sheet());
  assert.deepEqual(c.guests, { sheet: 40, d1: 41, match: false });
  /* …which the next full pass heals (stray is not in the sheet → soft-deleted) */
  const rep2 = await reconcile(e, sheet(), { slackPost });
  assert.deepEqual(rep2.before.guests, { sheet: 40, d1: 41, match: false }, 'the drift is measured BEFORE the full pass heals it');
  assert.equal(rep2.ok, true); assert.equal(rep2.clean, false); assert.equal(rep2.mirror.tabs.guests.deleted, 1);
  /* a stale row the incremental path missed (edited behind its back) is also drift */
  e.DB.db.prepare("UPDATE guests SET hash='stale' WHERE key='G-9'").run();
  const rep3 = await reconcile(e, sheet(), { slackPost, quiet: true });
  assert.equal(rep3.drift, 1); assert.equal(rep3.clean, false); assert.equal(rep3.before.guests.match, true, 'counts alone would have missed it');
});

test('flag off / no DB: nothing happens, and without DB not even a KV read', async () => {
  const off = env(false);
  assert.equal(await mirrorAfterRefresh(off, sheet()), null);
  assert.equal(off.DB.n.statements, 0);
  const rate = kv(ON);
  assert.equal(await mirrorAfterRefresh({ RATE: rate }, sheet()), null);
  assert.equal(rate.n.get, 0, 'production (no DB binding) pays zero KV reads');
  assert.deepEqual(await reconcile({ RATE: rate }, sheet(), {}), { ok: false, skipped: 'no-db' });
});

test('the write cap: a big first backfill finishes over several passes, then nothing', async () => {
  const e = env();
  const r1 = await mirrorSnapshot(e, sheet(), { maxWrites: 25 });
  assert.equal(r1.tabs.events.upserted + r1.tabs.guests.upserted, 25); assert.equal(r1.tabs.guests.capped, true);
  const r2 = await mirrorSnapshot(e, sheet(), { maxWrites: 25 });
  assert.equal(r2.tabs.guests.upserted, 17);
  const r3 = await mirrorSnapshot(e, sheet(), { maxWrites: 25 });
  assert.equal(r3.changed, 0);
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) n FROM guests').get().n, 40);
});

test('snapshot.js refresh mirrors the sheet AS READ (before the KV overlay patches) when DB + flag are on', async () => {
  const e = env();
  const s = sheet();
  /* an overlay patch newer than the fetch: the reader sees it, the mirror must not */
  const patch = [{ id: 'p1', at: Date.now() + 60e3, ops: [{ k: 'guests', row: 0, cells: { 15: 'PATCHED' } }] }];
  e.RATE.m.set('snappatch', JSON.stringify(patch));
  _resetSnapshotState(e);
  const raw = await readSnapshot(e, 'probe', { fetchRaw: async () => JSON.parse(JSON.stringify(s)) });
  assert.equal(raw.guests.values[0][15], 'PATCHED', 'the reader got the overlay');
  assert.equal(e.DB.db.prepare("SELECT rsvp FROM guests WHERE key='G-1'").get().rsvp, 'מגיע', 'D1 got the sheet');
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) n FROM guests').get().n, 40);
});

test('POST /api/d1-mirror: admin only; status / sync / reconcile shapes; 503 without DB', async () => {
  const e = env();
  const d = { isAdmin: (_e, k) => k === 'adm', deny: (s, why) => new Response(JSON.stringify({ ok: false, error: why }), { status: s }), okJson: p => new Response(JSON.stringify(p)),
    readSnapshot: async () => sheet(), slackPost: async () => true };
  const call = async (b, en = e) => { const r = await handleD1Mirror(new Request('https://x/api/d1-mirror', { method: 'POST', body: JSON.stringify(b) }), en, '', d); return { status: r.status, body: await r.json() }; };
  assert.equal((await call({ admin_key: 'no' })).status, 403);
  const s0 = await call({ admin_key: 'adm' });
  assert.equal(s0.body.bound, true); assert.equal(s0.body.flag, true); assert.deepEqual(s0.body.counts, { events: 0, guests: 0, leads: 0 });
  const sy = await call({ admin_key: 'adm', action: 'sync' });
  assert.equal(sy.body.ok, true); assert.equal(sy.body.tabs.guests.upserted, 40);
  const rc = await call({ admin_key: 'adm', action: 'reconcile', quiet: true });
  assert.equal(rc.body.ok, true); assert.equal(rc.body.counts.guests.match, true);
  const s1 = await call({ admin_key: 'adm', action: 'status' });
  assert.deepEqual(s1.body.counts, { events: 2, guests: 40, leads: 2 }); assert.ok(s1.body.runs.length >= 1);
  const nodb = await call({ admin_key: 'adm', action: 'sync' }, { RATE: kv() });
  assert.equal(nodb.status, 503);
  assert.deepEqual((await call({ admin_key: 'adm' }, { RATE: kv() })).body, { ok: true, bound: false });
});
