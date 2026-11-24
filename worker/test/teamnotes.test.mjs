// node --test worker/test/teamnotes.test.mjs — 24/11 the team's requests to Richard are kept and raised by the Worker itself
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTeamNote, noteKey, saveNote, listNotes, closeNote, overdueNotes, OPEN_ALERT_MS } from '../teamnotes.js';
import { CHECKS } from '../brain.js';

const kv = () => { const m = new Map(); return { get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), _m: m }; };
const OWNER = '972500000327';

test('what counts as a request: typed by a person on the client line, to the owner, with words', () => {
  const base = { peer: OWNER, owner: OWNER, ch: 'client', appAuto: false, text: 'להוריד את זיו מהרשימה' };
  assert.equal(isTeamNote(base), true);
  assert.equal(isTeamNote({ ...base, peer: '0500000327', owner: '972500000327' }), false, 'a different number is not the owner');
  assert.equal(isTeamNote({ ...base, peer: '972541112233' }), false, 'a message to a client is not a request');
  assert.equal(isTeamNote({ ...base, ch: 'guests' }), false);
  assert.equal(isTeamNote({ ...base, appAuto: true }), false, 'the app away message is not a request');
  assert.equal(isTeamNote({ ...base, text: '' }), false, 'a picture without words is not a request');
  assert.equal(isTeamNote({ ...base, owner: '' }), false);
});
test('a note is kept open, listed in order, and closed with what was done', async () => {
  const env = { RATE: kv() }; const now = Date.parse('2026-11-24T10:00:00Z');
  const k1 = await saveNote(env, { id: 'wamid.AAA==', ts: now - 8 * 3600e3, text: 'בקשה ראשונה', type: 'text' });
  const k2 = await saveNote(env, { id: 'wamid.BBB==', ts: now - 3600e3, text: 'בקשה שנייה', type: 'image' });
  assert.equal(k1, noteKey(now - 8 * 3600e3, 'wamid.AAA==')); assert.ok(/^teamnote:\d{13}:[A-Za-z0-9]+$/.test(k1));
  let notes = await listNotes(env, { days: 7, now });
  assert.deepEqual(notes.map(n => [n.text, n.status]), [['בקשה ראשונה', 'open'], ['בקשה שנייה', 'open']]);
  assert.deepEqual(overdueNotes(notes, now).map(n => n.key), [k1], 'only the one open for more than six hours');
  assert.equal(OPEN_ALERT_MS, 6 * 3600e3);
  assert.equal(await closeNote(env, k1, 'בוצע: הוסר'), true);
  notes = await listNotes(env, { days: 7, now });
  assert.equal(notes[0].status, 'done'); assert.equal(notes[0].result, 'בוצע: הוסר'); assert.equal(overdueNotes(notes, now).length, 0);
  assert.equal(await closeNote(env, 'teamnote:bad', 'x'), false); assert.equal(await closeNote(env, noteKey(1, 'none'), 'x'), false);
  assert.equal((await listNotes(env, { days: 7, now: now + 30 * 86400e3 })).length, 0, 'older than the window is not listed');
});
test('the ops brain raises an overdue request, and the Worker saves a note from the phone echo', async () => {
  const check = CHECKS.find(c => c.id === 'team_note_open'); assert.ok(check);
  const env = { RATE: kv() }; const now = Date.parse('2026-11-24T10:00:00Z');
  await saveNote(env, { id: 'A1', ts: now - 7 * 3600e3, text: 'בלוח של יעל כהן שיהיו שמות מלאים', type: 'text' });
  await saveNote(env, { id: 'A2', ts: now - 3600e3, text: 'טרייה', type: 'text' });
  const f = await check.run({ env, now });
  assert.equal(f.length, 1); assert.equal(f[0].severity, 'P2'); assert.ok(/פתוחה 7 שעות: בלוח של יעל כהן/.test(f[0].title_he), f[0].title_he);
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(/isTeamNote\(\{ peer, owner: env\.OWNER_PHONE \|\| OWNER_PHONE, ch: echoCh, appAuto, text: noteText \}\)/.test(src));
  const r = src.slice(src.indexOf("url.pathname === '/api/team-notes'"), src.indexOf("url.pathname === '/api/call-round'"));
  assert.ok(r.indexOf('isAdmin(env, b.admin_key)') > 0 && r.indexOf('isAdmin(env, b.admin_key)') < r.indexOf("b.action === 'done'"), 'admin only');
});
