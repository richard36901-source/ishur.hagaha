// node --test worker/test/crm-store.test.mjs — store.js: the SAME contract on both backends.
// D1 is a real SQLite (node:sqlite) running migrations/0003_crm.sql behind a D1-shaped adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { kvStore, d1Store, makeStore, applyQuery } from '../store.js';

export function memKv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }) };
}
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0003_crm.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { prepare: sql => stmt(sql), _db: db };
}
const backends = { kv: () => kvStore(memKv()), d1: () => d1Store(fakeD1()) };

for (const [name, mk] of Object.entries(backends)) {
  test(`[${name}] upsert merges, keeps created_at, unions tags, get/findBy/remove`, async () => {
    const s = mk();
    const a = await s.upsert('leads', { id: 'L972501111111', phone: '972501111111', name: 'דנה', status: 'new', tags: ['חם'] });
    assert.ok(a.created_at && a.updated_at);
    await new Promise(r => setTimeout(r, 5));
    const b = await s.upsert('leads', { id: 'L972501111111', status: 'talking', tags: ['חם', 'חתונה'], name: undefined });
    assert.equal(b.name, 'דנה', 'undefined never overwrites');
    assert.equal(b.status, 'talking'); assert.deepEqual(b.tags, ['חם', 'חתונה']);
    assert.equal(b.created_at, a.created_at); assert.ok(b.updated_at > a.updated_at);
    assert.deepEqual((await s.upsert('leads', { id: 'L972501111111', tags: ['x'], replace_tags: true })).tags, ['x']);
    assert.equal((await s.get('leads', 'L972501111111')).status, 'talking');
    assert.equal((await s.findBy('leads', 'phone', '972501111111')).id, 'L972501111111');
    assert.equal(await s.findBy('leads', 'phone', '972500000000'), null);
    await s.remove('leads', 'L972501111111');
    assert.equal(await s.get('leads', 'L972501111111'), null);
    await assert.rejects(() => s.upsert('nope', { id: 1 }));
  });

  test(`[${name}] list: filters (scalar, IN, range, boolean, tag), search, sort, pagination`, async () => {
    const s = mk();
    const rows = [
      { id: 'L1', phone: '972500000001', name: 'אבי', status: 'new', source: 'web', tags: ['חם'], next_action_at: '2026-11-01T10:00:00.000Z' },
      { id: 'L2', phone: '972500000002', name: 'בתיה', status: 'talking', source: 'whatsapp', tags: [], next_action_at: '2026-11-05T10:00:00.000Z' },
      { id: 'L3', phone: '972500000003', name: 'גיל', status: 'quoted', source: 'meta_form', tags: ['חם'] },
      { id: 'L4', phone: '972500000004', name: 'דנה', status: 'new', source: 'meta_form', tags: [] },
    ];
    for (const r of rows) await s.upsert('leads', r);
    const ids = r => r.items.map(x => x.id);
    assert.deepEqual(ids(await s.list('leads', { filter: { status: 'new' }, sort: 'id' })), ['L1', 'L4']);
    assert.deepEqual(ids(await s.list('leads', { filter: { status: ['new', 'quoted'] }, sort: 'id' })), ['L1', 'L3', 'L4']);
    assert.deepEqual(ids(await s.list('leads', { filter: { tags: 'חם' }, sort: 'id' })), ['L1', 'L3']);
    assert.deepEqual(ids(await s.list('leads', { filter: { next_action_at: { to: '2026-11-03T00:00:00Z' } } })), ['L1']);
    assert.deepEqual(ids(await s.list('leads', { q: 'בתי' })), ['L2']);
    assert.deepEqual(ids(await s.list('leads', { q: '050-000-0003' })), ['L3'], 'phone search by local digits');
    assert.deepEqual(ids(await s.list('leads', { sort: 'next_action_at' })).slice(0, 2), ['L1', 'L2'], 'empties last');
    const p1 = await s.list('leads', { sort: 'id', limit: 3 });
    assert.deepEqual(ids(p1), ['L1', 'L2', 'L3']); assert.equal(p1.total, 4); assert.equal(p1.next_cursor, '3');
    const p2 = await s.list('leads', { sort: 'id', limit: 3, cursor: p1.next_cursor });
    assert.deepEqual(ids(p2), ['L4']); assert.equal(p2.next_cursor, null);
    await s.upsert('hostesses', { id: 'H1', name: 'מיה', active: true }); await s.upsert('hostesses', { id: 'H2', name: 'נוי', active: false });
    assert.deepEqual(ids(await s.list('hostesses', { filter: { active: true } })), ['H1']);
  });

  test(`[${name}] notes: pinned first then oldest→newest, pin toggle; activities newest first, dedupe by id`, async () => {
    const s = mk();
    await s.appendNote({ entity_type: 'lead', entity_id: 'L1', text: 'שני', at: '2026-11-02T00:00:00.000Z' });
    await s.appendNote({ entity_type: 'lead', entity_id: 'L1', text: 'ראשון', at: '2026-11-01T00:00:00.000Z', origin: 'monday' });
    const n3 = await s.appendNote({ entity_type: 'lead', entity_id: 'L1', text: 'נעוץ', at: '2026-11-03T00:00:00.000Z' });
    await s.appendNote({ entity_type: 'client', entity_id: 'L1', text: 'other entity' });
    assert.deepEqual((await s.listNotes('lead', 'L1')).map(n => n.text), ['ראשון', 'שני', 'נעוץ']);
    await s.setNotePinned('lead', 'L1', n3.id, true);
    assert.deepEqual((await s.listNotes('lead', 'L1')).map(n => n.text), ['נעוץ', 'ראשון', 'שני']);
    assert.equal(await s.setNotePinned('lead', 'L1', 'nope', true), null);
    await s.appendActivity({ entity_type: 'lead', entity_id: 'L1', kind: 'wa_in', dir: 'in', text: 'a', at: '2026-11-01T00:00:00.000Z', id: 'wa:1' });
    await s.appendActivity({ entity_type: 'lead', entity_id: 'L1', kind: 'wa_out', dir: 'out', text: 'b', at: '2026-11-02T00:00:00.000Z' });
    await s.appendActivity({ entity_type: 'lead', entity_id: 'L1', kind: 'wa_in', dir: 'in', text: 'a again', at: '2026-11-03T00:00:00.000Z', id: 'wa:1' });
    const acts = await s.listActivities('lead', 'L1');
    assert.deepEqual(acts.map(a => a.text), ['b', 'a'], 'same id once, newest first');
    assert.equal((await s.listActivities('lead', 'L1', { limit: 1 })).length, 1);
  });
}

test('both backends return identical list results for the same writes', async () => {
  const a = kvStore(memKv()), b = d1Store(fakeD1());
  for (const s of [a, b]) for (let i = 0; i < 12; i++) await s.upsert('reminders', { id: 'R' + i, entity_type: 'lead', entity_id: 'L' + (i % 3), due_at: `2026-11-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`, done: i % 4 === 0, text: 't' + i });
  const q = { filter: { done: false, entity_id: ['L0', 'L1'] }, sort: '-due_at', limit: 4 };
  const strip = r => r.items.map(({ created_at, updated_at, ...x }) => x);
  assert.deepEqual(strip(await a.list('reminders', q)), strip(await b.list('reminders', q)));
  assert.equal((await a.list('reminders', q)).total, (await b.list('reminders', q)).total);
});

test('makeStore: D1 when OPS_DB is bound, KV otherwise, CRM_STORE=kv forces KV', () => {
  assert.equal(makeStore({ RATE: memKv() }).kind, 'kv');
  assert.equal(makeStore({ RATE: memKv(), OPS_DB: fakeD1() }).kind, 'd1');
  assert.equal(makeStore({ RATE: memKv(), OPS_DB: fakeD1(), CRM_STORE: 'kv' }).kind, 'kv');
  assert.throws(() => makeStore({}));
  assert.equal(applyQuery([{ id: 'a' }], { limit: 9999 }).items.length, 1);
});
