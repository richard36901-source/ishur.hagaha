import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTESS_TERMS, hasHostess, invoiceTerms } from '../invoice.js';

test('hostess terms are attached only when the purchase includes hostesses', () => {
  assert.equal(hasHostess({ hostess: 2 }), true);
  assert.equal(hasHostess({ description: '200 רשומות פרמיום כולל דיילת' }), true);
  assert.equal(hasHostess({ plan: 'דיילת לאירוע' }), true);
  assert.equal(hasHostess({ plan: 'פרמיום', tier: 200 }), false);
});
test('the hostess terms say what Richard asked for: scope, no extras on the day, hours, travel, no named staff', () => {
  for (const w of ['קבלת פני האורחים', 'לא ניתן להוסיף', 'כשעה לפני', 'נסיעות', 'דיילת או דייל', 'ללא התחייבות']) assert.ok(HOSTESS_TERMS.includes(w), w);
  assert.ok(!invoiceTerms({ tier: 200, plan: 'פרמיום' }).includes('דיילות באירוע'));
});
