// node --test worker/test/inbox-search.test.mjs — 23/11 the inbox search box and the call-centre search
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxSearch, textHit, phoneHit, phoneNeedle } from '../inbox-search.js';
import { matches } from '../calls-log.js';

const list = [{ phone: '972521110001', wa_name: 'Dr Nadlan' }, { phone: '972541110002' }, { phone: '972501110003', wa_name: 'רון' }];
const names = { '972521110001': { name: 'נתני חגי', kind: 'אורח', event: 'תאיר ואביב' }, '972541110002': { name: 'שמרית כחלון', kind: 'לקוח', event: 'בר מצווה של איתן' } };
const found = q => inboxSearch(list, names, q).map(c => c.phone.slice(-1)).join('');

test('by phone, typed any way', () => {
  assert.equal(found('052-111-0001'), '1'); assert.equal(found('0521110001'), '1'); assert.equal(found('+972 52 111 0001'), '1'); assert.equal(found('0002'), '2');
  assert.equal(phoneNeedle('05'), '');
});
test('by name: any word order, and the other Hebrew spelling', () => {
  assert.equal(found('נתני חגי'), '1'); assert.equal(found('חגי נתני'), '1'); assert.equal(found('נתני חגאי'), '1'); assert.equal(found('כחלון'), '2');
});
test('by event name, by the WhatsApp name, nothing typed = everything, no match = nothing', () => {
  assert.equal(found('תאיר'), '1'); assert.equal(found('בר מצווה'), '2'); assert.equal(found('nadlan'), '1'); assert.equal(found('רון'), '3');
  assert.equal(found(''), '123'); assert.equal(found('זזזזז'), '');
});
test('a word that is not there fails the whole query', () => { assert.equal(textHit('נתני חגי תאיר ואביב', 'נתני כהן'), false); assert.equal(phoneHit('972521110001', 'נתני 052'), false); });
test('call centre: the same search on a call row', () => {
  const row = { agent: 'שיר', kind: 'guest', state: 'done', name: 'נתני חגי', phone: '972521110001', event: 'תאיר ואביב', answer: 'ענה', token: 'f85d36d5' };
  for (const q of ['נתני חגאי', 'חגי נתני', '052-111-0001', 'תאיר', 'נתני']) assert.equal(matches(row, { q }), true, q);
  assert.equal(matches(row, { q: 'כהן' }), false); assert.equal(matches(row, { q: '0549999999' }), false);
});

test('25/11 both inbox screens carry the search box and send the query to the server', async () => {
  const fs = await import('node:fs');
  for (const f of ['../../inbox.html', '../../next/inbox.html']) {
    const h = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(h.includes('id="convQ"'), f);
    assert.ok(h.includes("pl = { q: wq }"), f);
    assert.ok(h.includes("'לא נמצאה שיחה שמתאימה לחיפוש.'"), f);
    assert.ok(h.indexOf('id="convQ"') < h.indexOf("$('convQ').addEventListener"), f);
  }
});
