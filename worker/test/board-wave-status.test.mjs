// 12/11 Richard: Mor's board said "עבר" after 524 invitations went out — the wave flag had been reopened for one retry
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../dashboard.js';
const row = Array(45).fill('');
row[1] = 'TOK'; row[6] = '2026-11-30'; row[31] = 'הכל כלול'; row[39] = '2026-11-09'; row[40] = '2026-11-19';
const g = i => { const r = Array(30).fill(''); r[2] = 'g' + i; r[3] = 'אורח ' + i; r[4] = '97250000' + String(i).padStart(4, '0'); r[28] = 'TOK'; return r; };
const raw = { events: { values: [Array(45).fill('h'), row] }, guests: { values: [Array(30).fill('h'), ...Array.from({ length: 100 }, (_, i) => g(i))] } };
const inv = d => d.sends.find(s => s.key === 'invite');
test('flag gone but 99/100 sent → בוצע ✓ (sent), with stats', () => {
  const d = buildDashboard('TOK', raw, 0, { 1: false, count: { 1: 99 } });
  assert.equal(inv(d).status, 'sent'); assert.ok(inv(d).stats);
});
test('flag gone, 40/100 sent → בתהליך (running), not עבר', () => {
  assert.equal(inv(buildDashboard('TOK', raw, 0, { 1: false, count: { 1: 40 } })).status, 'running');
});
test('nothing sent and the date passed → עבר; flag set → sent', () => {
  assert.equal(inv(buildDashboard('TOK', raw, 0, { count: { 1: 0 } })).status, 'passed');
  assert.equal(inv(buildDashboard('TOK', raw, 0, { 1: true })).status, 'sent');
});
