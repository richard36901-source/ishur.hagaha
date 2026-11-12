// node --test worker/test/referral.test.mjs — הזמן חבר rules (spec P1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../referral.js';
import { PKG_PRICES } from '../paylink.js';

const TOK = '0123abcd-1111-2222-3333-444444444444';
const mk = (mode = 'commission') => R.newRef({ token: TOK, phone: '972501111111', name: 'דנה כהן', mode, at: '2026-11-12T10:00:00Z' }).ref;

test('R1 choice: code = tok8, mode locks after the first referral', () => {
  const bad = R.newRef({ token: TOK, phone: 'x', mode: 'cash' }); assert.equal(bad.ok, false); assert.equal(bad.error, 'bad-mode');
  const ref = mk('discount');
  assert.equal(ref.code, '0123abcd'); assert.equal(ref.locked, false);
  assert.equal(R.setMode(ref, 'commission').ref.mode, 'commission');
  assert.equal(R.setMode(ref, 'discount').changed, false);
  const locked = { ...ref, locked: true };
  assert.deepEqual(R.setMode(locked, 'commission'), { ok: false, error: 'locked' });
  assert.deepEqual(R.publicRef(ref), { ok: true, mode: 'discount', name_first: 'דנה' });
  assert.ok(!JSON.stringify(R.publicRef(ref)).includes('9725'), 'no phone in the public view');
  assert.equal(R.refLink('0123ABCD'), 'https://ishur.io/?ref=0123abcd');
});

test('R4 80% on every package price, whole shekels', () => {
  let n = 0;
  for (const t of Object.keys(PKG_PRICES)) for (const p of Object.keys(PKG_PRICES[t])) {
    const full = PKG_PRICES[t][p], d = R.discountPrice(full);
    assert.ok(Number.isInteger(d) && d === Math.round(full * 0.8), `${t}/${p}: ${full} → ${d}`); n++;
  }
  assert.equal(n, 30);
  assert.equal(R.discountPrice(95), 76); assert.equal(R.discountPrice(449), 359); assert.equal(R.discountPrice(50), 40);
});

test('R6 attribution order cField3 → refpend → lead row; self and own-event ignored', () => {
  const ref = mk(); const lookup = c => (c === ref.code ? ref : c === 'aaaaaaaa' ? { ...ref, code: 'aaaaaaaa' } : null);
  assert.equal(R.codeFromFields({ cField3: 'ref:0123ABCD' }), '0123abcd');
  assert.equal(R.codeFromFields({ cField1: 'q:abc|pkg:pro:300' }), '');
  let a = R.attribute({ flat: { cField3: 'ref:0123abcd' }, pendCode: 'aaaaaaaa', leadCode: 'bbbbbbbb', payerPhone: '972502222222', lookup });
  assert.equal(a.via, 'cField3'); assert.equal(a.code, '0123abcd'); assert.equal(a.ignored, undefined);
  a = R.attribute({ flat: {}, pendCode: 'aaaaaaaa', leadCode: '0123abcd', payerPhone: '972502222222', lookup });
  assert.equal(a.via, 'pending'); assert.equal(a.code, 'aaaaaaaa');
  a = R.attribute({ flat: {}, pendCode: 'zzzzzzzz', leadCode: '0123abcd', payerPhone: '972502222222', lookup });
  assert.equal(a.via, 'lead', 'an unknown pending code falls through to the lead row');
  assert.equal(R.attribute({ flat: {}, payerPhone: '972502222222', lookup }), null);
  a = R.attribute({ flat: { cField3: 'ref:0123abcd' }, payerPhone: '972501111111', lookup });
  assert.equal(a.ignored, 'self');
  a = R.attribute({ flat: { cField3: 'ref:0123abcd' }, payerPhone: '972509999999', friendToken: TOK, lookup });
  assert.equal(a.ignored, 'own-event');
});

test('R6 package sum = the package line only', () => {
  const pq = { plan: 'pro', records: 300, lines: [{ key: 'pkg', price: 379 }, { key: 'design', price: 79 }] };
  assert.deepEqual(R.packageSum({ purchase: pq, sum: 458, pkgPrices: PKG_PRICES }), { sum_package: 379, note: 'quote' });
  const bundle = { plan: 'premium', records: 300, lines: [{ key: 'bundle', price: 1990 }] };
  assert.deepEqual(R.packageSum({ purchase: bundle, sum: 1990, pkgPrices: PKG_PRICES }), { sum_package: 449, note: 'bundle' });
  assert.deepEqual(R.packageSum({ parsed: { tier: 300, plan: 'pro', hostess: 0 }, sum: '303', pkgPrices: PKG_PRICES }), { sum_package: 303, note: 'desc' }, 'an 80% page: what was paid');
  assert.deepEqual(R.packageSum({ parsed: { tier: 300, plan: 'pro', hostess: 0 }, sum: '379', pkgPrices: PKG_PRICES }), { sum_package: 379, note: 'desc' });
  assert.deepEqual(R.packageSum({ sum: '₪120' }), { sum_package: 120, note: 'unstructured' });
});

test('R6/R6b record: pending at payment, credit only on verify, once', () => {
  const ref = mk('commission');
  const rec = R.newRecord({ code: ref.code, ref, friend: { phone: '972502222222', name: 'רון לוי', token: 'ffff0000-1111-2222-3333-444444444444' }, sum_total: '458', sum_package: 379, ipnRef: 'TX1', via: 'cField3', at: '2026-11-12T11:00:00Z' });
  assert.equal(rec.status, 'pending'); assert.equal(rec.credit, 76); assert.equal(rec.discount_given, 0); assert.equal(rec.id, '0123abcd:TX1');
  let L = R.emptyLedger();
  /* pending never touches the ledger */
  assert.equal(R.refSummary(ref, [rec], L).earned, 0); assert.equal(R.refSummary(ref, [rec], L).pending, 1); assert.equal(R.refSummary(ref, [rec], L).locked, true);
  const v1 = R.verifyRecord(rec, { by: 'invoice', at: '2026-11-12T11:05:00Z' });
  assert.equal(v1.changed, true); assert.equal(v1.credit, 76); assert.equal(v1.rec.verified_by, 'invoice');
  L = R.ledgerAdd(L, { kind: 'referral', amount: v1.credit, ref: 'TX1', token: rec.friend_token }).ledger;
  assert.equal(R.ledgerBalance(L), 76); assert.equal(L.entries[0].ils, 76, 'account.js shape: ils, not amount');
  const v2 = R.verifyRecord(v1.rec, { by: 'manual' });
  assert.equal(v2.changed, false); assert.equal(v2.credit, 0, 'second verify credits nothing');
  assert.equal(R.ledgerAdd(L, { kind: 'referral', amount: 76, ref: 'TX1', token: rec.friend_token }).added, false, 'ledger dedupes the same ref');
  const s = R.refSummary(ref, [v1.rec], L);
  assert.deepEqual([s.friends, s.pending, s.earned, s.balance], [1, 0, 76, 76]);
  assert.equal(R.cardCopy(s), 'הרווחתם ₪76');
  assert.equal(R.cardCopy(R.refSummary(ref, [], null)), 'הרווחתם ₪0');
  /* discount path */
  const d = mk('discount');
  const rd = R.newRecord({ code: d.code, ref: d, friend: { phone: '972503333333' }, sum_total: 303, sum_package: 303, ipnRef: 'TX2' });
  assert.equal(rd.credit, 0); assert.equal(rd.discount_given, 76);
  const sd = R.refSummary(d, [R.verifyRecord(rd).rec], null);
  assert.equal(R.cardCopy(sd), 'חברים חסכו ₪76');
  assert.equal(R.cardCopy(R.refSummary(d, [], null)), 'חברים חסכו ₪0');
  /* redeem */
  assert.equal(R.redeemRecord(rec).changed, false, 'a pending record cannot be redeemed');
  assert.equal(R.redeemRecord(v1.rec).rec.redeemed, true);
  const rr = R.ledgerRedeem(L, { note: 'package' }); assert.equal(rr.redeemed, 76); assert.equal(R.ledgerBalance(rr.ledger), 0); assert.equal(rr.ledger.redeemed[0].ils, 76);
  /* a ledger the personal area wrote (review credits) is read as-is and summed together */
  const pa = { entries: [{ kind: 'review_video', ils: 30, at: 'x', token: 't1' }], redeemed: [] };
  assert.equal(R.ledgerBalance(R.ledgerAdd(pa, { kind: 'referral', amount: 76, ref: 'TX9' }).ledger), 106);
});

test('R7 review credits live in account.js (₪20 Google, ₪30 video); the referral ledger math matches it', () => {
  assert.deepEqual(R.REVIEW_CREDIT, { review_google: 20, review_video: 30 });
  const L = { entries: [{ kind: 'review_video', ils: 30, token: 't1' }, { kind: 'review_google', ils: 20, token: 't1' }], redeemed: [] };
  assert.equal(R.ledgerBalance(L), 50);
  assert.equal(R.pendingLine([L, R.emptyLedger(), { entries: [{ kind: 'referral', ils: 76 }], redeemed: [] }]), 'זיכויים ממתינים: ₪126 ל-2 לקוחות');
  assert.equal(R.pendingLine([R.emptyLedger(), { entries: [{ ils: 30 }], redeemed: [{ ils: 30 }] }]), '', 'a redeemed ledger is not waiting');
});

test('R13 Slack line', () => {
  const ref = mk('commission');
  const rec = R.newRecord({ code: ref.code, ref, friend: { phone: '972502222222', name: 'רון לוי' }, sum_total: 458, sum_package: 379, ipnRef: 'TX1' });
  const line = R.slackLine(rec);
  assert.match(line, /^🎉 \*הפניה שילמה\* · רון לוי 050-222-2222 · ₪458 · דרך דנה · זיכוי ₪76/);
  const d = mk('discount');
  assert.match(R.slackLine(R.newRecord({ code: d.code, ref: d, friend: { phone: '972502222222' }, sum_total: 303, sum_package: 303, ipnRef: 'TX2' })), /הנחה ₪76$/);
});
