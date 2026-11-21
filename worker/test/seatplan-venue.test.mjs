// node --test worker/test/seatplan-venue.test.mjs — venue items on the seating plan (Richard 22/11: חופה בכל מיני
// צורות, בר, במה, מטבח, a shape with a name and a colour). Stored with the tables in seatplan:<token>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { cleanVenueItems } from '../seating.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init)); let reads = 0;
  return { m, reads: () => reads, get: async k => { reads++; return m.has(k) ? m.get(k) : null; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
const TOK = 'aaaaaaaa-0000-4000-8000-000000000001';
const env = () => ({ ADMIN_KEY: 'k', RATE: kv({ ['token:' + TOK]: JSON.stringify({ token: TOK }) }) });
const post = (e, body) => worker.fetch(new Request('https://go.ishur.io/api/seatplan', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify({ token: TOK, ...body }) }), e, { waitUntil: () => {}, passThroughOnException: () => {} }).then(r => r.json());
const T1 = [{ name: '1', shape: 'round', x: 10, y: 10, w: 120, h: 120, cap: 10 }];
const CHUPPAH = { kind: 'chuppah', shape: 'hex', label: 'חופה', color: '#F2C6D0', x: 300, y: 40, w: 160, h: 160 };

test('items are cleaned: known kind and shape, #rrggbb colour, short plain name, numbers in range', () => {
  const [a, b] = cleanVenueItems([
    CHUPPAH,
    { kind: 'spaceship', shape: 'star', label: '<b>במה</b>   ראשית ומאוד מאוד ארוכה מדי לגמרי', color: 'red', x: -5, y: 'x', w: 9999, h: 1 }
  ]);
  assert.deepEqual(a, { kind: 'chuppah', shape: 'hex', label: 'חופה', color: '#f2c6d0', x: 300, y: 40, w: 160, h: 160 });
  assert.equal(b.kind, 'other'); assert.equal(b.shape, 'rect'); assert.equal(b.color, '#e8dcc0');
  assert.ok(!/[<>]/.test(b.label) && b.label.length <= 24, b.label);
  assert.deepEqual([b.x, b.y, b.w, b.h], [0, 0, 800, 30]);
  assert.deepEqual(cleanVenueItems('nope'), []);
  assert.equal(cleanVenueItems(Array(100).fill(CHUPPAH)).length, 60);
});

test('a save with items keeps them, and loading returns them', async () => {
  const e = env();
  const s = await post(e, { tables: T1, groups: {}, items: [CHUPPAH, { kind: 'bar', shape: 'rect', label: 'בר', color: '#334455', x: 600, y: 300, w: 200, h: 70 }] });
  assert.equal(s.ok, true); assert.equal(s.items.length, 2);
  const g = await post(e, {});
  assert.deepEqual(g.items.map(i => i.kind), ['chuppah', 'bar']);
  assert.equal(g.tables.length, 1);
});

test('a save that sends only tables (an older page) keeps the items already there, with one stored read', async () => {
  const e = env();
  await post(e, { tables: T1, groups: { g1: 'משפחה' }, items: [CHUPPAH] });
  let before = e.RATE.reads();
  await post(e, { tables: T1, groups: { g1: 'משפחה' }, items: [CHUPPAH] });
  const full = e.RATE.reads() - before;            /* everything sent: no read of the stored plan */
  before = e.RATE.reads();
  const s = await post(e, { tables: T1 });
  assert.deepEqual(s.items.map(i => i.kind), ['chuppah']);
  assert.deepEqual(s.groups, { g1: 'משפחה' });
  assert.equal(e.RATE.reads() - before, full + 1, 'groups and items missing: the stored plan is read once, not twice');
});

test('an empty list removes all items; a plan saved before this change loads with none', async () => {
  const e = env();
  await post(e, { tables: T1, items: [CHUPPAH] });
  assert.deepEqual((await post(e, { tables: T1, items: [] })).items, []);
  const old = env(); old.RATE.m.set('seatplan:' + TOK, JSON.stringify({ tables: T1, groups: {} }));
  const g = await post(old, {});
  assert.deepEqual(g.items, []); assert.equal(g.tables.length, 1);
});

test('items never become tables: the table list is exactly what was sent', async () => {
  const e = env();
  const s = await post(e, { tables: T1, items: [CHUPPAH, CHUPPAH] });
  assert.equal(s.tables.length, 1);
  assert.deepEqual(JSON.parse(e.RATE.m.get('seatplan:' + TOK)).tables, s.tables);
});
