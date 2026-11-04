// node --test worker/test/subevent-dashboard.test.mjs — 04/11 the sub-event board uses the normal board's markup
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
const block = html.slice(html.indexOf('SUBEV-HTML-START'), html.indexOf('/* SUBEV-HTML-END */')).replace(/^[^\n]*\n/, '');
const { subeventHtml, subevReminderLine } = new Function(block + '\nreturn { subeventHtml, subevReminderLine };')();
const sv = { name: 'שבת חתן · זגורי', parent: 'p-1', sent: 4, reminder: { at: '2026-11-05T10:00', started_at: '', completed_at: '', sent: 0 },
  counts: { with_stay: { guests: 1, people: 4 }, no_stay: { guests: 1, people: 2 }, no: { guests: 1 }, undecided: { guests: 0 }, no_reply: { guests: 1 }, total: 4 },
  guests: [
    { name: 'דנה', phone: '050-****-001', status: 'with_stay', status_he: 'מגיעים עם לינה', n: 4, at: '2026-11-04T11:00:00Z' },
    { name: 'אבי <b>', phone: '050-****-002', status: 'no', status_he: 'לא מגיעים', n: 0, at: '2026-11-04T12:00:00Z' },
    { name: 'משה', phone: '050-****-003', status: 'no_stay', status_he: 'מגיעים בלי לינה', n: 2, at: '' },
    { name: 'גיל', phone: '050-****-004', status: 'none', status_he: 'לא ענו', n: 0, at: '' }] };
const st = (o = {}) => ({ filter: 'all', sort: 'status', query: '', ...o });

test('same components as the normal board: kpis, filt chips, gsearch, rows-h, row + brand pills; no bare <table>', () => {
  const h = subeventHtml(sv, st());
  for (const cls of ['class="kpis"', 'class="kpi hi"', 'class="filters"', 'class="filt on"', 'class="gsearch"', 'class="rows-h"', 'class="row"', 'class="pill yes"', 'class="pill no"', 'class="pill wait"', 'class="row-p"', 'class="row-s"'])
    assert.ok(h.includes(cls), cls);
  assert.ok(!/<table/.test(h));
  for (const l of ['מגיעים עם לינה', 'מגיעים בלי לינה', 'לא מגיעים', 'מתלבטים', 'לא ענו']) assert.ok(h.includes('<div class="kpi-l">' + l + '</div>'), l);
  assert.ok(h.includes('<div class="kpi-v">4</div>'));   /* people with lodging */
  assert.ok(h.includes('050-****-001') && !/05\d{8}/.test(h), 'masked phones only');
  assert.ok(h.includes('אבי &lt;b&gt;'), 'escaped');
  assert.ok(h.includes('תזכורת: מתוכננת 05/11 מ-10:00'));
  assert.ok(/· ענו <bdi dir="ltr">04\/11 13:00<\/bdi>/.test(h), 'reply time shown (IL)');
});
test('filter, search, sort', () => {
  const only = subeventHtml(sv, st({ filter: 'no' })); assert.equal((only.match(/class="row"/g) || []).length, 1);
  const q = subeventHtml(sv, st({ query: 'משה' })); assert.equal((q.match(/class="row"/g) || []).length, 1);
  const qd = subeventHtml(sv, st({ query: '004' })); assert.ok(qd.includes('גיל') && (qd.match(/class="row"/g) || []).length === 1);
  const byN = subeventHtml(sv, st({ sort: 'n' })); assert.ok(byN.indexOf('דנה') < byN.indexOf('משה') && byN.indexOf('משה') < byN.indexOf('אבי'));
  const bySt = subeventHtml(sv, st()); assert.ok(bySt.indexOf('גיל') < bySt.indexOf('אבי'), 'no-reply before declined');
});
test('reminder line: planned / in progress / sent', () => {
  assert.equal(subevReminderLine({ at: '2026-11-05T10:00' }), 'תזכורת: מתוכננת 05/11 מ-10:00');
  assert.equal(subevReminderLine({ at: '2026-11-05T10:00', started_at: 'x', sent: 7 }), 'תזכורת: נשלחה 7 (בתהליך)');
  assert.equal(subevReminderLine({ at: '2026-11-05T10:00', started_at: 'x', completed_at: 'y', sent: 30 }), 'תזכורת: נשלחה 30');
  assert.equal(subevReminderLine({}), '');
});
