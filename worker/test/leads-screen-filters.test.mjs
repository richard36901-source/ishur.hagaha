// node --test worker/test/leads-screen-filters.test.mjs — 25/11 additions to next/assets/leads-crm.js: the source and
// date filters, the comment thread vs the history in the drawer, and what the "ניסינו להשיג" button says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../../next/assets/leads-crm.js');

const NOW = Date.parse('2026-11-25T12:00:00Z');
const rows = () => [
  { id: 'm1', name: 'דנה', source: 'fb / paid', status: 'חדש', created_at: '2026-11-25T07:00:00Z' },
  { id: 'm2', name: 'אבי', source: 'google / cpc', status: 'לא ענה', created_at: '2026-11-20T08:00:00Z' },
  { id: 'm3', name: 'רות', source: '', status: 'סגר', created_at: '2026-10-01T08:00:00Z' },
  { id: 'm4', name: 'גל', source: 'referral:a1b2c3d4', status: 'חדש', created_at: '' },
];
const ids = l => l.map(x => x.id);

test('source buckets match worker/leads.js; the source filter uses them', async () => {
  const { sourceKind } = await import('../leads.js');
  for (const s of ['fb / paid', 'google / cpc', '', 'ישיר', 'referral:a1b2c3d4', 'referral:leads_sep26', 'tiktok', 'משהו'])
    assert.equal(L.sourceKind(s), sourceKind(s), s);
  const f = o => ids(rows().filter(l => L.matchLead(l, o, NOW)));
  assert.deepEqual(f({ source: 'מטא' }), ['m1']);
  assert.deepEqual(f({ source: 'ישיר' }), ['m3']);
  assert.deepEqual(f({ source: 'הפניה', status: 'חדש' }), ['m4']);
  assert.deepEqual(L.sourceCounts(rows()), { 'מטא': 1, 'גוגל': 1, 'הפניה': 1, 'טיקטוק': 0, 'ישיר': 1, 'אחר': 0 });
});
test('date filter: today (Israel day) / 7 / 30 days; no date only under "כל הזמן"', () => {
  const f = since => ids(rows().filter(l => L.matchLead(l, { since }, NOW)));
  assert.deepEqual(f(''), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(f('today'), ['m1']);
  assert.deepEqual(f('7'), ['m1', 'm2']);
  assert.deepEqual(f('30'), ['m1', 'm2']);
  assert.equal(L.inSince({ created_at: '2026-11-24T22:30:00Z' }, 'today', NOW), true, '00:30 Israel on the 25th is today');
  assert.equal(L.inSince({ created_at: '2026-11-24T21:30:00Z' }, 'today', NOW), false);
});
test('the drawer: comments (author + time, oldest first) apart from the history (newest first, no note rows)', () => {
  const t = L.thread(
    [{ at: '2026-11-16T07:12:00Z', author: 'ריצארד', text: 'שני' }, { at: '2026-11-15T07:10:00Z', author: 'שלו', text: 'ראשון' }, { at: 'x', text: '' }],
    [{ at: '2026-11-15T07:10:00Z', kind: 'note', text: 'ראשון' }, { at: '2026-11-14T08:00:00Z', kind: 'created', text: 'נכנס' },
     { at: '2026-11-25T21:00:00Z', kind: 'reach', dir: 'out', text: 'מחוץ לשעות', meta: { who: 'שלו', state: 'queued' } }]);
  assert.deepEqual(t.comments.map(c => [c.who, c.text]), [['שלו', 'ראשון'], ['ריצארד', 'שני']]);
  assert.deepEqual(t.history.map(h => [h.kind, h.who, h.state]), [['reach', 'שלו', 'queued'], ['created', '', '']]);
  assert.match(t.history[0].text, /^ניסינו להשיג: /);
});
test('the button says: נשלח / יישלח ב-… / the calm failure line, never an error code', () => {
  assert.deepEqual(L.reachLabel({ ok: true, state: 'sent' }), { cls: 'saved', he: 'נשלח' });
  assert.deepEqual(L.reachLabel({ ok: true, state: 'queued', he: 'יישלח ב-יום ה׳ 10:00' }), { cls: 'saving', he: 'יישלח ב-יום ה׳ 10:00' });
  for (const j of [null, { ok: false, state: 'failed', error: 'send-failed', why: '131042: payment' }, { ok: false, error: 'paused' }])
    assert.deepEqual(L.reachLabel(j), { cls: 'failed', he: 'לא נשלח — נסו שוב מאוחר יותר' });
  assert.equal(L.reachLabel({ ok: false, error: 'no-phone' }).he, 'אין לליד מספר טלפון');
});
