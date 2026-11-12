import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectItems } from '../ops.js';

/* 12/11 Richard: "למה מציג לי את מור ונועם שלא הסתיים?" — a past wave with no wave: marker must only plan the guests it has not reached */
const ev = { token: 'tok-aaaaaaaa', name: 'מור ונועם', date: '2026-11-30', plan: 'premium', waves: { 1: '2026-11-08' } };
const guests = { 'tok-aaaaaaaa': [{ phone: '972500000001', rsvp: '' }, { phone: '972500000002', rsvp: '' }, { phone: '972500000003', rsvp: '' }] };
const run = flags => projectItems({ events: [ev], guests, flags: { 'tok-aaaaaaaa': flags }, today: '2026-11-09', days: 14 }).filter(i => i.type === 'w1');
test('everyone already reached → nothing is planned for the wave', () => {
  assert.equal(run({ reached: { 1: new Set(['972500000001', '972500000002', '972500000003']) } }).length, 0);
});
test('one guest not reached yet → the plan is that one, not the whole list', () => {
  const it = run({ reached: { 1: new Set(['972500000001', '972500000002']) } });
  assert.equal(it.length, 1); assert.equal(it[0].count, 1);
});
test('no markers at all → the whole list, as before', () => {
  assert.equal(run({})[0].count, 3);
});
