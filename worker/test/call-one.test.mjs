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

test('25/11 a guest with a final answer is never dialled, unless the team asked for that call by name', () => {
  const at = src.indexOf("const finals = queue.filter(g => g.rsvp === 'מגיע' || g.rsvp === 'לא מגיע');"), b = src.slice(at, at + 1900);
  assert.ok(at > 0);
  assert.ok(src.indexOf('for (const g of queue) {\n    if (dialed.length >= cap) break;') > at, 'the filter runs before any dial');
  assert.ok(b.includes("env.RATE.get('callforce:' + g.guest_id)") && b.includes('queue = queue.filter(g => !gone.has(g.guest_id))'));
  assert.ok(b.includes("range: `אורחים!V${g.row}`, values: [['']]"));
  assert.ok(b.includes("String((gR[g.row - 2] || [])[2] || '').trim() === g.guest_id"), 'the row is checked against the guest id before it is written');
  assert.ok(src.includes("env.RATE.put('callforce:' + gid, today"), 'the by-name call sets the exception');
  const ev = Array(45).fill(''); ev[1] = 'TOK'; ev[31] = 'הכל כלול'; ev[6] = '2099-01-01';
  const mk = (id, rsvp) => { const g = Array(35).fill(''); g[2] = id; g[4] = '972501234567'; g[15] = rsvp; g[21] = 'נדרשת שיחה'; g[28] = 'TOK'; return g; };
  const q = buildCallQueue({ events: { values: [ev] }, guests: { values: [mk('G-1', ''), mk('G-2', 'לא מגיע')] } }, 3, null).queue;
  assert.deepEqual(q.map(g => [g.guest_id, g.row, g.rsvp]), [['G-1', 2, ''], ['G-2', 3, 'לא מגיע']]);
});
