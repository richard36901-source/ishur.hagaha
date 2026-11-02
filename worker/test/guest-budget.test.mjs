import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickGuestPhone, guestDailyBudget, guestBudgetLeft } from '../whatsapp.js';

function kv(init = {}) { const m = new Map(Object.entries(init)); return { get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; }
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
/* 02/11 (later): these hotfix tests were written for the per-number model (230 per
   number, summed, no margin). The default is now portfolio-shared with a margin of
   20 (Richard's decision; covered in budget.test.mjs), so they run that model
   explicitly. Every assertion below is unchanged. */
const env = (store) => ({ WA_PHONE_ID_GUESTS: 'A', WA_PHONE_IDS_GUESTS: 'B', WA_TOKEN_GUESTS: 't', GUEST_CAP_SCOPE: 'number', GUEST_BUDGET_MARGIN: '0', RATE: kv(store) });

test('default budget is 230 per number per day', () => { assert.equal(guestDailyBudget({}), 230); assert.equal(guestDailyBudget({ GUEST_DAILY_BUDGET: '100' }), 100); });

test('a number that spent its budget is not offered; the other one is', async () => {
  const e = env({ [`gsend:A:${day}`]: '230', [`gsend:B:${day}`]: '5' });
  assert.equal(await pickGuestPhone(e), 'B');
});

test('both over budget → no number at all (no Meta call, no 131048)', async () => {
  const e = env({ [`gsend:A:${day}`]: '231', [`gsend:B:${day}`]: '400' });
  assert.equal(await pickGuestPhone(e), '');
  assert.equal(await guestBudgetLeft(e), 0);
});

test('held number is skipped even with budget', async () => {
  const e = env({ [`gsend:A:${day}`]: '1', 'wacap:A': '1', [`gsend:B:${day}`]: '50' });
  assert.equal(await pickGuestPhone(e), 'B');
  assert.equal(await guestBudgetLeft(e), 180);
});
