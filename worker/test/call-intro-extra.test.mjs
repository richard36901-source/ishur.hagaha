/* 24/11/2026 (Richard): Aviv Pitusi's wedding names the parents right after the couple in Shir's first sentence.
   Only that sentence changes: every variable the script reads is the same with and without the addition. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCallPayload, guestOpening, hostExtra } from '../shir.js';

const G = { kind: 'guest', phone: '972500000000', guest_id: 'G-f85d36d5-1', token: 'f85d36d5-x', name: 'דנה', event_name: 'תאיר ואביב', occasion: 'חתונה', event_date: '2026-12-03', party: '2' };
const EXTRA = 'והוריהם יעקב ומירי פיטוסי ושרון וכרמי מורי';

test('the parents come right after the couple, before the question', () => {
  const p = buildCallPayload({ ...G, host_extra: EXTRA }, '+97200');
  const o = p.retell_llm_dynamic_variables.opening;
  assert.match(o, /^היי, מדברת שיר מאישורי הגעה בשם תאיר ואביב, והוריהם יעקב ומירי פיטוסי ושרון וכרמי מורי — מגיעים לחתונה ב-/);
});

test('nothing else in the call changes', () => {
  const a = buildCallPayload({ ...G }, '+97200'), b = buildCallPayload({ ...G, host_extra: EXTRA }, '+97200');
  const va = { ...a.retell_llm_dynamic_variables }, vb = { ...b.retell_llm_dynamic_variables };
  assert.notEqual(va.opening, vb.opening);
  delete va.opening; delete vb.opening;
  assert.deepEqual(vb, va);
  assert.ok(!('host_extra' in vb));
  assert.deepEqual(b.metadata, a.metadata);
  assert.equal(vb.host_name, 'תאיר ואביב');
});

test('an event without an addition opens exactly as before', () => {
  assert.equal(guestOpening({ host_name: 'נועה ויונתן', occasion: 'חתונה', event_date_spoken: '3 בדצמבר' }), 'היי, מדברת שיר מאישורי הגעה בשם נועה ויונתן — מגיעים לחתונה ב-3 בדצמבר?');
  assert.equal(guestOpening({ host_name: 'נועה ויונתן', occasion: 'חתונה', host_extra: '   ' }), 'היי, מדברת שיר מאישורי הגעה בשם נועה ויונתן — מגיעים לחתונה?');
});

test('the undecided opener carries it too, and braces never reach the voice', () => {
  assert.match(guestOpening({ host_name: 'א וב', occasion: 'חתונה', guest_state: 'מתלבט', host_extra: EXTRA }), /בשם א וב, והוריהם יעקב ומירי פיטוסי ושרון וכרמי מורי — ראינו שעוד לא סגרתם/);
  assert.equal(hostExtra('{{x}} שלום\n<b>'), 'x שלום b');
  assert.ok(hostExtra('א'.repeat(300)).length <= 140);
});

test('the dialer and the sample call both read the event addition', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal((src.match(/'callintro:' \+ /g) || []).length, 2);
  assert.match(src, /g\.host_extra = introCache\.get\(g\.token\)/);
});
