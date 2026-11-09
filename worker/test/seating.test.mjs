import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTableQuestion, tableFor, tableReply } from '../seating.js';

const row = (id, name, phone, token, rsvp, table) => { const r = Array(31).fill(''); r[2] = id; r[3] = name; r[4] = phone; r[28] = token; r[15] = rsvp; r[30] = table; return r; };
const raw = { guests: { values: [
  row('g1', 'דנה כהן', '0501111111', 'T', 'מגיע', '12'),
  row('g2', 'אבי לוי', '0502222222', 'T', 'מגיע', 'שולחן 12'),
  row('g3', 'רון מזרחי', '0503333333', 'T', 'לא מגיע', '12'),
  row('g4', 'מיכל', '0504444444', 'T', 'מגיע', '7'),
  row('g5', 'יוסי', '0505555555', 'OTHER', 'מגיע', '12'),
  row('g6', 'שירה', '0506666666', 'T', 'מגיע', ''),
] } };

test('table questions are recognised, other questions are not', () => {
  for (const t of ['איזה שולחן אני', 'מה מספר השולחן שלנו?', 'באיזה שולחן אנחנו יושבים', 'שולחן?', 'איפה אני יושבת', 'סידור ישיבה?']) assert.equal(isTableQuestion(t), true, t);
  for (const t of ['איפה האולם', 'מתי האירוע', 'כמה אנשים', 'תודה']) assert.equal(isTableQuestion(t), false, t);
});

test('the guest gets their table and only same-event, attending mates, self first', () => {
  const info = tableFor(raw, { token: 'T', guest_id: 'g2', name: 'אבי לוי' });
  assert.equal(info.table, 'שולחן 12');
  assert.deepEqual(info.mates, ['אבי לוי', 'דנה כהן']);
  const txt = tableReply(info);
  assert.match(txt, /^🪑 שולחן 12/);
  assert.match(txt, /• דנה כהן/);
  assert.doesNotMatch(txt, /רון|יוסי|מיכל/);
});

test('no table on the sheet → null, nothing sent', () => {
  assert.equal(tableFor(raw, { token: 'T', guest_id: 'g6' }), null);
  assert.equal(tableReply(null), '');
});

test('a table of one has no mate list', () => {
  const txt = tableReply(tableFor(raw, { token: 'T', guest_id: 'g4' }));
  assert.equal(txt, '🪑 שולחן 7\n\nנתראה באירוע 🙂');
});
