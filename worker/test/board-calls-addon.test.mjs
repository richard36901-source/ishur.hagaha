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
test('round armed by hand on the regular round day shows once', () => {
  const d = buildDashboard('TOK', raw, 0, { callsAddon: true, callRound: { at: '2026-11-02', n: 84, done: false } });
  const calls = d.sends.filter(s => s.key === 'calls' || s.key === 'calls2');
  assert.equal(calls.length, 1, JSON.stringify(calls));
});
test('calls row is done once every waiting guest used all tries', () => {
  const g = Array(35).fill(''); g[1]='g'; g[2]='G1'; g[4]='972501234567'; g[21]='נדרשת שיחה'; g[28]='TOK'; g[29]='1';
  const r2 = { events: raw.events, guests: { values: [Array(35).fill('h'), g] } };
  const d = buildDashboard('TOK', r2, 0, { callsAddon: true });
  const row = d.sends.find(s => s.key === 'calls');
  assert.equal(row.status, 'sent', JSON.stringify(row));
  g[29] = '0';
  const d2 = buildDashboard('TOK', r2, 0, { callsAddon: true });
  assert.equal(d2.sends.find(s => s.key === 'calls').status, 'running');
});
