/* 20/11 Richard: records granted from the clients screen raise the client's add-a-guest allowance (10/10 → 10/20). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const s = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('the allowance is the free ten plus what the admin granted', () => {
  assert.match(s, /return ADDON_RATES\.freeGuests \+ Math\.max\(0, bonus\);/);
  assert.match(s, /const LIMIT = await freeGuestLimit\(env, tok\);/);
});
test('a grant adds to the bonus, and the upload ceiling follows it', () => {
  assert.match(s, /await env\.RATE\.put\('gaddbonus:' \+ tok, String\(bonus0 \+ n\)/);
  assert.match(s, /billable > tierNum \+ await freeGuestLimit\(env,/);
});
