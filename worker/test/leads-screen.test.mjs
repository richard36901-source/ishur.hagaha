// node --test worker/test/leads-screen.test.mjs — the logic of the leads list (next/assets/leads-crm.js): sort by any
// column, the filters and their counts, the optimistic edit and its rollback, what counts as "saved", and how a change
// that arrives from monday lands on a list somebody is working in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../../next/assets/leads-crm.js');

const rows = () => [
  { id: 'm1', name: 'דנה', phone: '972521111111', event: 'חתונה', guests: 200, price: 1790, status: 'חדש', owner: 'שלו', source: 'fb', ad: 'AS04', created_at: '2026-11-14T08:00:00Z', touch_at: '2026-11-16T07:00:00Z', next: '2026-11-20' },
  { id: 'm2', name: 'אבי', phone: '972522222222', event: 'ברית', guests: 60, price: null, status: 'לא ענה', owner: '', source: 'google', ad: '', created_at: '2026-11-16T08:00:00Z', touch_at: '', next: '' },
  { id: 'm3', name: 'רות', phone: '', phone_text: '12345', event: '', guests: null, price: 990, status: 'סגר', owner: 'נועה', source: '', ad: '', created_at: '2026-11-10T08:00:00Z', touch_at: '2026-11-12T07:00:00Z', next: '2026-11-18' },
];
const ids = l => l.map(x => x.id);

test('sort: any column, both directions, numbers as numbers, empties always last', () => {
  assert.deepEqual(ids(L.sortLeads(rows(), 'name', 'asc')), ['m2', 'm1', 'm3']);
  assert.deepEqual(ids(L.sortLeads(rows(), 'name', 'desc')), ['m3', 'm1', 'm2']);
  assert.deepEqual(ids(L.sortLeads(rows(), 'price', 'asc')), ['m3', 'm1', 'm2'], '990 before 1790, the empty price last');
  assert.deepEqual(ids(L.sortLeads(rows(), 'price', 'desc')), ['m1', 'm3', 'm2'], 'and still last the other way');
  assert.deepEqual(ids(L.sortLeads(rows(), 'guests', 'desc')), ['m1', 'm2', 'm3']);
  assert.deepEqual(ids(L.sortLeads(rows(), 'next', 'asc')), ['m3', 'm1', 'm2']);
  assert.deepEqual(ids(L.sortLeads(rows(), 'touch_at', 'desc')), ['m1', 'm3', 'm2']);
  assert.deepEqual(ids(L.sortLeads(rows(), 'created_at', 'desc')), ['m2', 'm1', 'm3'], 'the default: newest first');
  for (const c of L.COLS) assert.equal(L.sortLeads(rows(), c.k, 'asc').length, 3, c.k);
  assert.deepEqual(L.COLS.map(c => c.k), ['name', 'phone', 'event', 'guests', 'package', 'price', 'source', 'ad', 'status', 'owner', 'touch_at', 'next']);
  const src = rows(); L.sortLeads(src, 'name', 'asc'); assert.deepEqual(ids(src), ['m1', 'm2', 'm3'], 'the list itself is not reordered');
});

test('filter: status, owner (also "nobody"), search by name, phone in any spelling, event, source', () => {
  const f = o => ids(rows().filter(l => L.matchLead(l, o)));
  assert.deepEqual(f({}), ['m1', 'm2', 'm3']);
  assert.deepEqual(f({ status: 'לא ענה' }), ['m2']);
  assert.deepEqual(f({ owner: 'נועה' }), ['m3']); assert.deepEqual(f({ owner: '-' }), ['m2']);
  assert.deepEqual(f({ status: 'חדש', owner: 'נועה' }), []);
  assert.deepEqual(f({ q: 'דנ' }), ['m1']); assert.deepEqual(f({ q: '052-222' }), ['m2']); assert.deepEqual(f({ q: '0521111111' }), ['m1']);
  assert.deepEqual(f({ q: 'ברית' }), ['m2']); assert.deepEqual(f({ q: 'GOOGLE' }), ['m2']); assert.deepEqual(f({ q: '12345' }), ['m3']);
  const c = L.counts(rows(), ['חדש', 'לא ענה', 'סגר', 'לא רלוונטי'], ['שלו', 'נועה', 'ריצארד']);
  assert.deepEqual(c, { all: 3, status: { 'חדש': 1, 'לא ענה': 1, 'סגר': 1, 'לא רלוונטי': 0 }, owner: { '-': 1, 'שלו': 1, 'נועה': 1, 'ריצארד': 0 } });
});

test('optimistic edit: the row changes at once, the base is what the user saw, rollback puts it back', () => {
  const l = rows()[1];
  const op = L.optimistic(l, { status: 'סגר', price: 500 });
  assert.deepEqual([op.lead.status, op.lead.price], ['סגר', 500]); assert.equal(l.status, 'לא ענה', 'the original is untouched');
  assert.deepEqual(op.base, { status: 'לא ענה', price: '' }); assert.deepEqual(op.undo, { status: 'לא ענה', price: null });
  const back = L.rollback(op.lead, op.undo); assert.deepEqual([back.status, back.price, back.name], ['לא ענה', null, 'אבי']);
  assert.deepEqual(L.optimistic(l, { note: 'x' }).base, {}, 'a note has nothing to compare against');
  /* a change that arrived on another field while the save was out survives the rollback */
  assert.equal(L.rollback({ ...op.lead, owner: 'שלו' }, op.undo).owner, 'שלו');
});

test('a row is "saved" only on an explicit ok with the lead; everything else is a failure or a conflict', () => {
  assert.equal(L.saveState(200, { ok: true, lead: { id: 'm1' } }), 'saved');
  assert.equal(L.saveState(200, { ok: true }), 'failed', 'ok without the stored lead is not proof');
  assert.equal(L.saveState(502, { ok: false, error: 'monday-failed' }), 'failed');
  assert.equal(L.saveState(200, { ok: false, error: 'no-token' }), 'failed');
  assert.equal(L.saveState(0, { ok: false, error: 'offline' }), 'failed'); assert.equal(L.saveState(500, null), 'failed'); assert.equal(L.saveState(403, null), 'failed');
  assert.equal(L.saveState(409, { ok: false, error: 'conflict', lead: {} }), 'conflict');
  assert.deepEqual(Object.keys(L.STATE_HE).sort(), ['conflict', 'failed', 'saved', 'saving']);
});

test('a remote change lands on the list: updated, added on top, removed; a busy row waits; an older answer is dropped', () => {
  let r = L.applyRemote(rows(), { items: [{ ...rows()[0], status: 'סגר', rev: 10 }, { id: 'm9', name: 'חדש מהלוח', status: 'חדש', rev: 11 }], deleted: ['m3'] }, {}, {});
  assert.deepEqual(ids(r.list), ['m9', 'm1', 'm2']); assert.equal(r.list[1].status, 'סגר');
  assert.deepEqual(r.changed.sort(), ['m1', 'm9']); assert.deepEqual(r.removed, ['m3']); assert.deepEqual(r.held, {});
  /* the user is typing in m1: its change is kept aside and applied on the next pass */
  r = L.applyRemote(rows(), { items: [{ ...rows()[0], status: 'סגר', rev: 10 }], deleted: ['m2'] }, { m1: true }, {});
  assert.equal(r.list[0].status, 'חדש'); assert.deepEqual(r.changed, []); assert.deepEqual(r.removed, ['m2']); assert.equal(r.held.m1.status, 'סגר');
  const r2 = L.applyRemote(r.list, { items: [], deleted: [] }, {}, r.held);
  assert.equal(r2.list[0].status, 'סגר'); assert.deepEqual(r2.changed, ['m1']); assert.deepEqual(r2.held, {});
  /* our own save (rev 20) is on screen; the overlap of the poll serves the older rev 10 again */
  const mine = rows().map(l => (l.id === 'm1' ? { ...l, price: 2000, rev: 20 } : l));
  assert.equal(L.applyRemote(mine, { items: [{ ...rows()[0], rev: 10 }] }, {}, {}).list[0].price, 2000);
  /* the same values again are not a change (nothing flashes) */
  assert.deepEqual(L.applyRemote(rows(), { items: [{ ...rows()[0], rev: 5 }] }, {}, {}).changed, []);
  assert.deepEqual(L.applyRemote(rows(), { deleted: ['m404'] }, {}, {}).removed, []);
});

test('display helpers: phone, relative time, last note line, money, escaping', () => {
  assert.equal(L.fmtPhone('972521111111'), '052-111-1111'); assert.equal(L.fmtPhone(''), '');
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(L.relTime('2026-11-16T11:59:50Z', now), 'עכשיו'); assert.equal(L.relTime('2026-11-16T11:30:00Z', now), 'לפני 30 דק׳');
  assert.equal(L.relTime('2026-11-16T07:00:00Z', now), 'לפני 5 שע׳'); assert.equal(L.relTime('2026-11-13T12:00:00Z', now), 'לפני 3 ימים'); assert.equal(L.relTime('', now), '');
  assert.equal(L.heDate('2026-11-20'), '20.11.26'); assert.equal(L.heDate(''), '');
  assert.equal(L.lastNoteLine('א\nב\n\n'), 'ב'); assert.equal(L.lastNoteLine(''), '');
  assert.equal(L.money(1790), '₪1,790'); assert.equal(L.money(null), '');
  assert.equal(L.esc('<img src=x onerror="a">\'&'), '&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;');
});
