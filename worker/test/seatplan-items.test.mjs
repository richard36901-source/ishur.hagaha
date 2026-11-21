// 22/11/2026 · the hall's chuppah, bar, stage… kept with the table map (seatplan:<token>.items)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanItems, itemsToKeep, MAX_ITEMS } from '../seatplan-items.js';

test('hall items: what a client sends is cut to the fixed lists, a short name and a place inside the map', () => {
  const out = cleanItems([
    { kind: 'chuppah', label: '  החופה שלנו  ', shape: 'hex', color: 'gold', x: 100, y: 50, w: 120, h: 110 },
    { kind: '<script>', label: '<img src=x onerror=1>' + 'א'.repeat(80), shape: 'star', color: 'url(javascript:1)', x: -5, y: 99999, w: 1, h: 'abc', extra: 'dropped' },
    null, 'text', 7,
  ]);
  assert.deepEqual(out[0], { kind: 'chuppah', label: 'החופה שלנו', shape: 'hex', color: 'gold', x: 100, y: 50, w: 120, h: 110 });
  assert.equal(out.length, 2);
  assert.equal(out[1].kind, 'free'); assert.equal(out[1].shape, 'rect'); assert.equal(out[1].color, 'gold');
  assert.equal(out[1].label.length, 30); assert.deepEqual([out[1].x, out[1].y, out[1].w, out[1].h], [0, 4000, 30, 100]);
  assert.equal('extra' in out[1], false);
  assert.equal(cleanItems(Array.from({ length: 500 }, () => ({ kind: 'bar' }))).length, MAX_ITEMS);
  assert.deepEqual(cleanItems(undefined), []); assert.deepEqual(cleanItems('x'), []);
});

test('hall items: a save from an older copy of the page (no items at all) keeps what is there; an empty list removes them', () => {
  const kept = [{ kind: 'bar', label: 'בר', shape: 'rect', color: 'blue', x: 10, y: 10, w: 200, h: 60 }];
  assert.deepEqual(itemsToKeep(undefined, kept), kept);
  assert.deepEqual(itemsToKeep(null, kept), kept);
  assert.deepEqual(itemsToKeep([], kept), []);
  assert.deepEqual(itemsToKeep([{ kind: 'stage', label: 'במה', shape: 'arch', color: 'purple', x: 1, y: 2, w: 240, h: 90 }], kept), [{ kind: 'stage', label: 'במה', shape: 'arch', color: 'purple', x: 1, y: 2, w: 240, h: 90 }]);
  assert.deepEqual(itemsToKeep(undefined, undefined), []);
});

test('hall items: the client's own colour is kept only as #rrggbb; the added kinds and the octagon are kept', () => {
  const out = cleanItems([{ kind: 'buffet', shape: 'oct', color: '#FF8800' }, { kind: 'photo', color: '#ff88' }, { kind: 'gifts', color: '#ff8800;background:url(x)' }, { color: 'red' }]);
  assert.deepEqual(out.map(o => [o.kind, o.shape, o.color]), [['buffet', 'oct', '#ff8800'], ['photo', 'rect', 'gold'], ['gifts', 'rect', 'gold'], ['free', 'rect', 'red']]);
});
