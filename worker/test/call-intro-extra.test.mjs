/* 24/11/2026 (Richard): Aviv Pitusi's wedding names the parents right after the couple in Shir's first sentence.
   Only that sentence changes: every variable the script reads is the same with and without the addition. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCallPayload, guestOpening, hostExtra, introFor, safeGuestName } from '../shir.js';

const G = { kind: 'guest', phone: '972500000000', guest_id: 'G-f85d36d5-1', token: 'f85d36d5-x', name: 'דנה', event_name: 'תאיר ואביב', occasion: 'חתונה', event_date: '2026-12-03', party: '2' };
const EXTRA = 'והוריהם יעקב ומירי פיטוסי ושרון וכרמי מורי';

/* 25/11 Richard reversed the 24/11 request after the numbers: the parents are NOT said in the opening (it lost guests in
   the first seconds); Shir says them only when asked who it is. They ride in host_details. */
test('the parents are not in the opening; they are available to Shir for "מי זה?"', () => {
  const p = buildCallPayload({ ...G, host_extra: EXTRA }, '+97200', { legacy_opening: true });
  const v = p.retell_llm_dynamic_variables;
  assert.match(v.opening, /^היי, מדברת שיר מאישורי הגעה בשם תאיר ואביב — מגיעים לחתונה ב-/);
  assert.ok(!/והוריהם/.test(v.opening));
  assert.equal(v.host_details, EXTRA);
  assert.equal(buildCallPayload({ ...G }, '+97200').retell_llm_dynamic_variables.host_details, '', 'always sent, empty when there is none');
});

test('nothing else in the call changes', () => {
  const a = buildCallPayload({ ...G }, '+97200'), b = buildCallPayload({ ...G, host_extra: EXTRA }, '+97200');
  const va = { ...a.retell_llm_dynamic_variables }, vb = { ...b.retell_llm_dynamic_variables };
  assert.equal(va.opening, vb.opening, 'the opening is the same with and without the addition');
  delete va.host_details; delete vb.host_details;
  assert.deepEqual(vb, va);
  assert.ok(!('host_extra' in vb));
  assert.deepEqual(b.metadata, a.metadata);
  assert.equal(vb.host_name, 'תאיר ואביב');
});

test('an event without an addition opens exactly as before', () => {
  assert.equal(guestOpening({ host_name: 'נועה ויונתן', occasion: 'חתונה', event_date_spoken: '3 בדצמבר' }), 'היי, מדברת שיר, מאישורי הגעה בשם נועה ויונתן — מגיעים לחתונה ב-3 בדצמבר?');
  assert.equal(guestOpening({ host_name: 'נועה ויונתן', occasion: 'חתונה', host_extra: '   ' }), 'היי, מדברת שיר, מאישורי הגעה בשם נועה ויונתן — מגיעים לחתונה?');
});

test('the undecided opener carries it too, and braces never reach the voice', () => {
  assert.match(guestOpening({ host_name: 'א וב', occasion: 'חתונה', guest_state: 'מתלבט', host_extra: EXTRA }), /בשם א וב — ראינו שעוד לא סגרתם/);
  assert.equal(hostExtra('{{x}} שלום\n<b>'), 'x שלום b');
  assert.ok(hostExtra('א'.repeat(300)).length <= 140);
});

test('the dialer and the sample call both read the event addition', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal((src.match(/'callintro:' \+ /g) || []).length, 2);
  assert.match(src, /g\.host_extra = introCache\.get\(g\.token\)/);
});

test('an addition with a start day stays out of real calls until that day; a rehearsal always hears it', () => {
  const raw = JSON.stringify({ text: EXTRA, from: '2026-11-25' });
  assert.equal(introFor(raw, '2026-11-24'), '');
  assert.equal(introFor(raw, '2026-11-25'), EXTRA);
  assert.equal(introFor(raw, '2026-12-01'), EXTRA);
  assert.equal(introFor(raw), EXTRA);
  assert.equal(introFor(EXTRA, '2026-11-24'), EXTRA);
  assert.equal(introFor('', '2026-11-24'), '');
  assert.equal(introFor('{broken', '2026-11-24'), '');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("introFor(await env.RATE.get('callintro:' + g.token).catch(() => null), day)"));
});

test('25/11 an event can say how its hosts\' names are spoken; the written name stays', () => {
  const p = buildCallPayload({ ...G, event_name: 'שוהם ושי', host_spoken: 'שוהם ושַׁי' }, '+97200');
  const v = p.retell_llm_dynamic_variables;
  assert.equal(v.host_name, 'שוהם ושַׁי'); assert.equal(v.event_name, 'שוהם ושי');
  assert.match(v.opening, /בשם שוהם ושַׁי — מגיעים/);
  assert.equal(buildCallPayload({ ...G, event_name: 'שוהם ושי' }, '+97200').retell_llm_dynamic_variables.host_name, 'שוהם ושי');
});

test('25/11 the guest is greeted by name only when the name on the list is safe to say', () => {
  for (const [n, want] of [['דנה', 'דנה'], ['סייג בנימין', 'סייג בנימין'], ['נאוה בן ארצי', ''], ['קוממי שושי וקותי', ''], ['שושי וקותי', ''], ['אבא ותולי', ''], ['רחל אחות של עדן', ''], ['דודה רחל', ''],
    ['משפחת כהן', ''], ['הרב שרון', ''], ['Yarin ירין', ''], ['דורון אוזן (2)', ''], ['ז', ''], ['', ''], ['עו"ד עמית', ''], ['ורד כהן', 'ורד כהן'], ['בן דוד', '']])
    assert.equal(safeGuestName(n), want, n);
  assert.equal(guestOpening({ guest_name: 'דנה', host_name: 'שוהם ושי', occasion: 'חתונה' }), 'היי דנה, מדברת שיר, מאישורי הגעה בשם שוהם ושי — מגיעים לחתונה?');
  assert.equal(guestOpening({ guest_name: 'קוממי שושי וקותי', host_name: 'שוהם ושי', occasion: 'חתונה' }), 'היי, מדברת שיר, מאישורי הגעה בשם שוהם ושי — מגיעים לחתונה?');
  assert.match(guestOpening({ guest_name: 'דנה', host_name: 'א וב', occasion: 'חתונה', guest_state: 'מתלבט' }), /^היי דנה, מדברת שיר, מאישורי הגעה בשם א וב — ראינו שעוד לא סגרתם/);
});

test('25/11 real calls and rehearsals keep the old wording; the other opening stays behind its switch', () => {
  const g = { ...G, name: 'דנה', event_name: 'שוהם ושי' };
  assert.match(buildCallPayload(g, '+97200', { legacy_opening: true }).retell_llm_dynamic_variables.opening, /^היי, מדברת שיר מאישורי הגעה בשם שוהם ושי — /);
  assert.match(buildCallPayload(g, '+97200').retell_llm_dynamic_variables.opening, /^היי דנה, מדברת שיר, מאישורי הגעה בשם שוהם ושי — /);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("env.RATE.get('cfg:opening_v2')") && src.includes('legacy_opening: !('));
  const tc = src.slice(src.indexOf("body.action === 'testcall' && body.agent === 'shir_out'"), src.indexOf("body.action === 'testcall' && body.agent === 'shir_out'") + 12000);   /* the block's lines are long: 4,200 characters ended before the call */
  assert.ok(tc.includes('buildCallPayload(g, env.SHIR_FROM, { legacy_opening: body.opening_v2 !== true })'), 'a rehearsal hears what a guest hears unless it asks for the other opening');
});
