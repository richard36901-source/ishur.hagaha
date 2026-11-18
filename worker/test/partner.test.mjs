import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPartner, refsOf, setName, linkStats, hitAdd, PID_RE } from '../partner.js';
import { isCode } from '../referral.js';

test('a partner gets a private id and two different fixed-mode codes', () => {
  const p = newPartner({ label: 'שלו' });
  assert.ok(PID_RE.test(p.pid));
  assert.ok(isCode(p.codes.discount) && isCode(p.codes.commission));
  assert.notEqual(p.codes.discount, p.codes.commission);
  const [a, b] = refsOf(p);
  assert.deepEqual([a.mode, b.mode], ['discount', 'commission']);
  assert.ok(a.locked && b.locked);            // the mode can never be switched on a published link
  assert.equal(a.partner, p.pid);
  assert.equal(a.phone, '');                  // no event, no phone ledger
});
test('the name is typed once: first + last, then locked', () => {
  const p = newPartner({ label: 'x' });
  assert.equal(setName(p, 'א', 'כהן').error, 'bad-name');
  const r = setName(p, ' דנה ', 'לוי');
  assert.equal(r.partner.name, 'דנה לוי');
  assert.equal(setName(r.partner, 'מישהו', 'אחר').error, 'name-locked');
  assert.equal(refsOf(r.partner)[0].name, 'דנה לוי');
});
test('link numbers: visits, closed, saved for friends, earned only when verified', () => {
  const recs = [{ status: 'verified', credit: 30, discount_given: 0, sum_total: 149 }, { status: 'pending', credit: 20, discount_given: 0, sum_total: 99 }];
  const s = linkStats('commission', 'abcd1234', recs, { n: 7 });
  assert.equal(s.visits, 7); assert.equal(s.closed, 2); assert.equal(s.earned, 30); assert.equal(s.earned_pending, 20);
  assert.equal(s.link, 'https://ishur.io/?ref=abcd1234');
});
test('visit counter adds per day and keeps the total', () => {
  let h = hitAdd(null, '2026-11-12'); h = hitAdd(h, '2026-11-12'); h = hitAdd(h, '2026-11-13');
  assert.equal(h.n, 3); assert.equal(h.days['2026-11-12'], 2);
});
