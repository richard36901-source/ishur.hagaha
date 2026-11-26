import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../dashboard.js';

test('26/11 a send round on a future day reads "scheduled" even when guests already carry a mark for it (Shoham)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-26T09:00:00Z') });
  const ev = Array(45).fill(''); ev[1] = 'TOKF'; ev[6] = '2026-12-02'; ev[7] = 'כן'; ev[39] = '2026-11-09'; ev[40] = '2026-11-22'; ev[41] = '2026-11-29';
  const g = Array(35).fill(''); g[2] = 'G1'; g[3] = 'a'; g[4] = '972501234561'; g[28] = 'TOKF'; g[15] = 'מגיע';
  const d = buildDashboard('TOKF', { events: { values: [Array(45).fill('h'), ev] }, guests: { values: [Array(35).fill('h'), g] } }, 0, { extraPaid: true, count: { 3: 139 } });
  const extra = d.sends.find(s => s.key === 'extra');
  assert.equal(extra.status, 'scheduled');
});
