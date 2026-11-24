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
  /* 22/11/2026 (Richard's OK): the sample event was dated 20/11/2026 and this test began to fail the day after, because a
     passed event reads 'passed'. The dates are now relative to today, with the same gaps as before (event in 5 days, first wave 14 days ago). */
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const liveRow = raw.events.values[1].slice(); liveRow[6] = day(5); liveRow[39] = day(-14);
  const r2 = { events: { values: [Array(45).fill('h'), liveRow] }, guests: { values: [Array(35).fill('h'), g] } };
  const d = buildDashboard('TOK', r2, 0, { callsAddon: true });
  const row = d.sends.find(s => s.key === 'calls');
  assert.equal(row.status, 'sent', JSON.stringify(row));
  g[29] = '0';
  const d2 = buildDashboard('TOK', r2, 0, { callsAddon: true });
  assert.equal(d2.sends.find(s => s.key === 'calls').status, 'running');
});
test('23/11 הכל כלול: three call rows, a day apart, each with its own status; פרמיום keeps one row', () => {
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const next = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); if (x.getUTCDay() === 5) x.setUTCDate(x.getUTCDate() + 2); else if (x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  const evRow = Array(45).fill(''); evRow[1] = 'TOK3'; evRow[6] = day(20); evRow[31] = 'הכל כלול'; evRow[39] = day(-12); evRow[40] = day(-10);
  const G = (id, tries, status21, rsvp) => { const g = Array(35).fill(''); g[1] = 'c'; g[2] = id; g[3] = id; g[4] = '97250123456' + id.slice(-1); g[15] = rsvp || ''; g[21] = status21 || ''; g[28] = 'TOK3'; g[29] = String(tries); return g; };
  const guests = [G('G1', 1, 'נדרשת שיחה'), G('G2', 2, 'נדרשת שיחה'), G('G3', 3, ''), G('G4', 1, '', 'מגיע')];
  const d = buildDashboard('TOK3', { events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), ...guests] } }, 0, {});
  const rows = d.sends.filter(s => /^calls/.test(s.key));
  assert.deepEqual(rows.map(r => r.key), ['calls', 'calls_r2', 'calls_r3'], JSON.stringify(rows));
  assert.ok(/סבב 1$/.test(rows[0].label) && /סבב 2$/.test(rows[1].label) && /סבב 3$/.test(rows[2].label));
  assert.equal(rows[1].date, next(rows[0].date)); assert.equal(rows[2].date, next(rows[1].date));
  /* 24/11 Richard changed the rule of 23/11: a round whose day has passed and that dialled is done ("אם זה אתמול אז תסמן
     בוצע"); G1, whom it did not dial, is shown as moved on to the next round instead of "עוד לא חויגו". Was: running, queued 1. */
  assert.equal(rows[1].status, 'sent'); assert.equal(rows[1].dialed_n, 2); assert.equal(rows[1].queued, 0); assert.equal(rows[1].stats.moved, 1);
  assert.equal(rows[0].status, 'sent'); assert.equal(rows[0].stats.moved, 0);
  assert.equal(rows[2].status, 'running'); assert.equal(rows[2].dialed_n, 1); assert.equal(rows[2].queued, 2);
  /* 23/11 (later the same evening, Richard): every round carries its own result. tries = the round of the guest's last call. */
  const pick = t => ({ dialed: t.dialed, answered: t.answered, no_answer: t.no_answer, waiting: t.waiting, later: t.later });
  assert.deepEqual(pick(rows[0].stats), { dialed: 4, answered: 0, no_answer: 3, waiting: 0, later: 1 });   /* G4 answered later in WhatsApp */
  assert.deepEqual(pick(rows[1].stats), { dialed: 2, answered: 0, no_answer: 2, waiting: 0, later: 0 });   /* 24/11: was waiting 1, now moved 1 (above) */
  assert.deepEqual(pick(rows[2].stats), { dialed: 1, answered: 0, no_answer: 1, waiting: 2, later: 0 });
  /* a guest who picked up on the second call: silent in round 1, the answer belongs to round 2 */
  const g5 = G('G5', 2, '', 'לא מגיע'); g5[22] = 'ענה';
  const d5 = buildDashboard('TOK3', { events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), ...guests, g5] } }, 0, {});
  const r5 = d5.sends.filter(s => /^calls/.test(s.key));
  assert.equal(r5[0].stats.no_answer, 4); assert.equal(r5[0].stats.answered, 0);
  assert.equal(r5[1].stats.answered, 1); assert.equal(r5[1].stats.declined, 1); assert.equal(r5[1].stats.dialed, 3);
  assert.equal(r5[2].stats.answered, 0);
  const done = [G('G1', 3, ''), G('G4', 1, '', 'מגיע')];
  const d2 = buildDashboard('TOK3', { events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), ...done] } }, 0, {});
  assert.deepEqual(d2.sends.filter(s => /^calls/.test(s.key)).map(r => r.status), ['sent', 'sent', 'sent']);
  const prem = evRow.slice(); prem[31] = 'פרמיום';
  const d3 = buildDashboard('TOK3', { events: { values: [Array(45).fill('h'), prem] }, guests: { values: [Array(35).fill('h'), ...guests] } }, 0, {});
  const r3 = d3.sends.filter(s => /^calls/.test(s.key));
  assert.equal(r3.length, 1); assert.equal(r3[0].label, 'שיחה טלפונית למי שלא ענה');
});
test('23/11 a call round that already dialled never shows a day in the future', () => {
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const evRow = Array(45).fill(''); evRow[1] = 'TOK4'; evRow[6] = day(6); evRow[31] = 'הכל כלול'; evRow[39] = day(-12); evRow[40] = day(-10);
  const g = Array(35).fill(''); g[1] = 'c'; g[2] = 'G1'; g[3] = 'a'; g[4] = '972501234561'; g[28] = 'TOK4'; g[29] = '3';
  const d = buildDashboard('TOK4', { events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), g] } }, 0, { callDate: day(0) });
  const rows = d.sends.filter(s => /^calls/.test(s.key));
  assert.deepEqual(rows.map(r => r.status), ['sent', 'sent', 'sent']);
  for (const r of rows) assert.ok(r.date <= day(0), r.key + ' ' + r.date);
});
test('23/11 the rounds are dated from the day they really opened, not from a day set by hand later', () => {
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const evRow = Array(45).fill(''); evRow[1] = 'TOK5'; evRow[6] = day(6); evRow[31] = 'הכל כלול'; evRow[39] = day(-12); evRow[40] = day(-10);
  const g = Array(35).fill(''); g[1] = 'c'; g[2] = 'G1'; g[3] = 'a'; g[4] = '972501234561'; g[28] = 'TOK5'; g[29] = '3';
  const d = buildDashboard('TOK5', { events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), g] } }, 0, { callDate: day(0), escDate: day(-6) });
  const rows = d.sends.filter(s => /^calls/.test(s.key));
  assert.equal(rows[0].date, day(-6));
  assert.ok(rows[1].date > rows[0].date && rows[2].date > rows[1].date && rows[2].date <= day(0), rows.map(r => r.date).join(' '));
  const later = buildDashboard('TOK5', { events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), g] } }, 0, { callDate: day(-8), escDate: day(-6) });
  assert.equal(later.sends.find(s => s.key === 'calls').date, day(-8), 'an earlier hand-set day still wins');
});
test('24/11 an opened extra round does not rewrite the plan rounds; it has its own row and result', () => {
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const evRow = Array(45).fill(''); evRow[1] = 'TOK6'; evRow[6] = day(3); evRow[31] = 'הכל כלול'; evRow[39] = day(-12); evRow[40] = day(-10);
  const G = (id, tries, v21, rsvp, ans) => { const g = Array(35).fill(''); g[1] = 'c'; g[2] = id; g[3] = id; g[4] = '97250123456' + id.slice(-1); g[15] = rsvp || ''; g[21] = v21 || ''; g[22] = ans || ''; g[28] = 'TOK6'; g[29] = String(tries); return g; };
  /* before the extra round: A, B, C used all three tries; D answered on the second call */
  const before = [G('GA', 3, '', '', 'לא ענה - מוצו הנסיונות'), G('GB', 3, '', '', 'לא ענה - מוצו הנסיונות'), G('GC', 3, '', '', 'לא ענה - מוצו הנסיונות'), G('GD', 2, '', 'מגיע', 'ענה')];
  const raw = gs => ({ events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), ...gs] } });
  const pick = t => ({ dialed: t.dialed, answered: t.answered, no_answer: t.no_answer, waiting: t.waiting });
  const b = buildDashboard('TOK6', raw(before), 0, { escDate: day(-6) }).sends.filter(s => /^calls/.test(s.key));
  assert.deepEqual(b.map(r => r.status), ['sent', 'sent', 'sent']);
  /* the extra round opened this morning: tries back to 0, flagged again. A was already called and said no, B was called and did not answer, C still waits */
  const after = [G('GA', 1, '', 'לא מגיע', 'ענה'), G('GB', 1, 'נדרשת שיחה', '', 'לא ענה'), G('GC', 0, 'נדרשת שיחה', '', 'לא ענה - מוצו הנסיונות'), G('GD', 2, '', 'מגיע', 'ענה')];
  const job = { at: day(0), n: 3, done: true, flagged: 3, ids: ['GA', 'GB', 'GC'], prev: { GA: 3, GB: 3, GC: 3 } };
  const a = buildDashboard('TOK6', raw(after), 0, { escDate: day(-6), callRound: job }).sends.filter(s => /^calls/.test(s.key));
  assert.deepEqual(a.map(r => r.key), ['calls', 'calls_r2', 'calls_r3', 'calls2']);
  assert.deepEqual(a.slice(0, 3).map(r => r.status), ['sent', 'sent', 'sent'], 'the plan rounds stay done');
  for (let i = 0; i < 3; i++) assert.deepEqual(pick(a[i].stats), pick(b[i].stats), 'round ' + (i + 1) + ' is unchanged by the extra round');
  assert.deepEqual(pick(a[3].stats), { dialed: 2, answered: 1, no_answer: 1, waiting: 1 });
  assert.equal(a[3].stats.declined, 1); assert.equal(a[3].status, 'running');
  /* a job that recorded no earlier tries (שילת's, opened before this fix): its guests count as having used the plan's tries */
  const a2 = buildDashboard('TOK6', raw(after), 0, { escDate: day(-6), callRound: { ...job, prev: null } }).sends.filter(s => /^calls/.test(s.key));
  for (let i = 0; i < 3; i++) assert.deepEqual(pick(a2[i].stats), pick(b[i].stats));
});

test('24/11 a guest who pressed "טעות" (wrong number) does not wait for any call round', () => {
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const evRow = Array(45).fill(''); evRow[1] = 'TOKW'; evRow[6] = day(20); evRow[31] = 'הכל כלול'; evRow[39] = day(-12); evRow[40] = day(-10);
  const G = (id, phone, tries) => { const g = Array(35).fill(''); g[1] = 'c'; g[2] = id; g[3] = id; g[4] = phone; g[21] = 'נדרשת שיחה'; g[28] = 'TOKW'; g[29] = String(tries); return g; };
  const guests = [G('A', '972501111111', 0), G('B', '0502222222', 0), G('C', '972503333333', 1)];
  const raw = { events: { values: [Array(45).fill('h'), evRow] }, guests: { values: [Array(35).fill('h'), ...guests] } };
  const rowsOf = sent => buildDashboard('TOKW', raw, 0, sent).sends.filter(s => /^calls/.test(s.key));
  const plain = rowsOf({}), marked = rowsOf({ wrong: new Set(['972501111111', '972502222222']) });
  assert.equal(plain[0].stats.moved, 2);                       /* without the marks A and B look like guests round 1 skipped */
  assert.equal(marked[0].stats.moved, 0);
  assert.equal(marked[1].queued, 1); assert.equal(marked[1].stats.waiting, 1);   /* only C still waits for round 2 */
  assert.equal(marked[2].stats.waiting, 1);
});
