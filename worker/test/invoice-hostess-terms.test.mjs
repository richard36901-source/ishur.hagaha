import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTESS_TERMS, hasHostess, invoiceTerms, DESIGN_TERMS, hasDesign } from '../invoice.js';

test('hostess terms are attached only when the purchase includes hostesses', () => {
  assert.equal(hasHostess({ hostess: 2 }), true);
  assert.equal(hasHostess({ description: '200 רשומות פרמיום כולל דיילת' }), true);
  assert.equal(hasHostess({ plan: 'דיילת לאירוע' }), true);
  assert.equal(hasHostess({ plan: 'פרמיום', tier: 200 }), false);
});
test('the hostess terms say what Richard asked for: scope, no extras on the day, hours, travel, no named staff', () => {
  for (const w of ['קבלת פני האורחים', 'לא ניתן להוסיף', '40 דקות לפני', 'נסיעות', 'דיילת או דייל', 'ללא התחייבות']) assert.ok(HOSTESS_TERMS.includes(w), w);
  assert.ok(!invoiceTerms({ tier: 200, plan: 'פרמיום' }).includes('דיילות באירוע'));
});
test('design terms go on an invoice that includes the invitation design, and only there', () => {
  assert.equal(hasDesign({ design: true }), true);
  assert.equal(hasDesign({ description: 'עיצוב הזמנה' }), true);
  assert.equal(hasDesign({ plan: 'פרמיום', tier: 200 }), false);
  for (const w of ['סבב תיקונים אחד', '₪49', 'אישור הלקוח', 'ללא הדפסה']) assert.ok(DESIGN_TERMS.includes(w), w);
});
