/* 24/11/2026 Shalev: one named guest gets one call on a set day, even though they answered "לא מגיע". */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCallQueue } from '../dashboard.js';
const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('the queue dials whoever is flagged, whatever their answer; one try short of the limit means exactly one call', () => {
  const ev = Array(45).fill(''); ev[1] = 'TOK'; ev[2] = 'c'; ev[31] = 'הכל כלול'; ev[6] = '2099-01-01';
  const g = Array(35).fill(''); g[2] = 'G-1'; g[3] = 'רותם'; g[4] = '972501234567'; g[15] = 'לא מגיע'; g[21] = 'נדרשת שיחה'; g[28] = 'TOK'; g[29] = '2';
  const q = buildCallQueue({ events: { values: [ev] }, guests: { values: [g] } }, 3, null).queue;
  assert.equal(q.length, 1); assert.equal(q[0].capped, false); assert.equal(q[0].max_tries, 3); assert.equal(q[0].tries, 2);
  g[29] = '3';
  assert.equal(buildCallQueue({ events: { values: [ev] }, guests: { values: [g] } }, 3, null).queue[0].capped, true, 'after that one call the guest is not dialled again');
});

test('the job opens on its day, from 09:00, writes the flag and the tries, and is removed', () => {
  const at = src.indexOf("await kvPrefix(env, 'callone:')"), b = src.slice(at, at + 2600);
  assert.ok(at > 0);
  assert.ok(b.includes("if (!dry && (!dueOne || ilHour < 9))"));
  assert.ok(b.includes("values: [['נדרשת שיחה']]") && b.includes('values: [[String(capO - 1)]]'));
  assert.ok(b.includes("env.RATE.delete('callone:' + gid)"));
  assert.ok(!/אורחים!P\$|rsvp/.test(b), 'the answer on the board is not touched');
});
