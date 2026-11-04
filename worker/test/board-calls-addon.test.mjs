import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../dashboard.js';
const row = Array(45).fill('');
row[1]='TOK'; row[6]='2026-11-20'; row[31]='בסיס'; row[39]='2026-11-01';
const raw = { events: { values: [Array(45).fill('h'), row] }, guests: { values: [] } };
test('basic plan without add-on: no calls row', () => {
  const d = buildDashboard('TOK', raw, 0, {});
  assert.ok(!d.sends.some(s => s.key === 'calls'));
});
test('basic plan with paid calls add-on: calls row shows', () => {
  const d = buildDashboard('TOK', raw, 0, { callsAddon: true });
  const sends = d.sends;
  assert.ok(sends.some(s => s.key === 'calls'), JSON.stringify(sends));
});
test('manual extra call round shows on a basic plan with no add-on', () => {
  const d = buildDashboard('TOK', raw, 0, { callRound: { at: '2026-11-05', n: 4, done: false } });
  assert.ok(d.sends.some(s => s.key === 'calls2'));
});
test('granted extra send shows even with no date yet', () => {
  const d = buildDashboard('TOK', raw, 0, { extraPaid: true });
  const r = d.sends.find(s => s.key === 'extra');
  assert.ok(r && r.editable && r.date === '');
});
