import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCallQueue } from '../dashboard.js';

function raw(plan) {
  const ev = new Array(50).fill(''); ev[1] = 'tok-basic'; ev[2] = 'אירוע'; ev[6] = '2026-11-09'; ev[31] = plan;
  const g = new Array(40).fill(''); g[2] = 'g1'; g[3] = 'אורח'; g[4] = '972501234567'; g[21] = 'נדרשת שיחה'; g[28] = 'tok-basic'; g[29] = '0';
  return { events: { values: [ev] }, guests: { values: [g] } };
}
test('בסיס without a calls add-on: no one is queued', () => {
  const { queue } = buildCallQueue(raw('בסיס'), 3);
  assert.equal(queue.length, 0);
});
test('בסיס with a paid calls add-on (callsaddon:<token>): one round is queued', () => {
  const { queue } = buildCallQueue(raw('בסיס'), 3, new Set(['tok-basic']));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].max_tries, 1);
});
/* Richard 12/11 (his words: "רק אם רכשו תוספת שיחה"): הכל כלול keeps its 3 rounds, and gets a 4th ONLY with a bought add-on.
   The old rule here was "add-on never raises a premium plan above its own cap" (3). */
test('הכל כלול without the add-on stays at its own 3 rounds', () => {
  const { queue } = buildCallQueue(raw('הכל כלול'), 3, new Set());
  assert.equal(queue.length, 1);
  assert.equal(queue[0].max_tries, 3);
});
test('הכל כלול with a bought add-on gets a 4th round', () => {
  const { queue } = buildCallQueue(raw('הכל כלול'), 3, new Set(['tok-basic']));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].max_tries, 4);
});
test('12/11: add-on gives פרמיום one more round on top of its own (1+1)', () => {
  const { queue } = buildCallQueue(raw('פרמיום'), 3, new Set(['tok-basic']));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].max_tries, 2);
});
