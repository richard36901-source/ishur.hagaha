/* Richard's final pricing rules (03/11 20:20), the full matrix:
   records 100/300/650/700/800/1000 × hostesses 0/1/2/3 × calls 0/1/3 × design y/n.
   Expected sums are written out from the rules here, not from paylink.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceQuote, tierFor } from '../paylink.js';

const NOW = Date.parse('2026-11-03T18:00:00Z');
const base = { name: 'דנה כהן', phone: '0501234567', occasion: 'wedding', now: NOW };
const LIST = { 100: { basic: 99, pro: 149, premium: 199 }, 300: { basic: 299, pro: 379, premium: 449 }, 700: { basic: 699, pro: 819, premium: 919 }, 800: { basic: 799, pro: 929, premium: 1049 } };
const planFor = c => (c >= 3 ? 'premium' : c >= 1 ? 'pro' : 'basic');
function expected(records, h, calls, design) {
  const tier = tierFor(records);
  if (!tier) return { refused: true };
  if (h) {
    const tb = tier > 700 ? { 2: 2390, 3: 2590 } : { 1: 1790, 2: 1990 };
    /* Richard 03/11 20:25: from 300 records two hostesses are mandatory */
    const n = (h === 1 && tier >= 300) ? 2 : (tb[h] ? h : 2);
    return { sum: tb[n], plan: 'premium', hostesses: n, coerced: n !== h };
  }
  const plan = planFor(calls);
  return { sum: LIST[tier][plan] + (design ? 79 : 0), plan, hostesses: 0, coerced: false };
}

export const MATRIX = [];
for (const records of [100, 300, 650, 700, 800, 1000]) for (const h of [0, 1, 2, 3]) for (const calls of [0, 1, 3]) for (const design of [false, true]) {
  const exp = expected(records, h, calls, design);
  test(`matrix: ${records} records · ${h} hostesses · ${calls} call rounds · design ${design ? 'y' : 'n'} → ${exp.refused ? 'refused' : '₪' + exp.sum}`, () => {
    const tier = tierFor(records);
    const r = priceQuote({ ...base, calls_rounds: calls, records: tier || records, addons: { hostesses: h, design } });
    if (exp.refused) { assert.equal(r.ok, false); assert.equal(r.why, 'bad-records'); return; }
    assert.equal(r.ok, true, r.why);
    const q = r.quote;
    assert.equal(q.sum, exp.sum); assert.equal(q.plan, exp.plan); assert.equal(q.hostesses, exp.hostesses);
    assert.equal(!!q.note, exp.coerced, 'a note exactly when the hostess count had to move');
    if (h) {
      assert.ok(q.bundle, 'hostesses → a bundle');
      assert.equal(q.calls, false, 'calls never an add-on in a bundle');
      if (design) assert.deepEqual(q.lines.find(l => l.key === 'design'), { key: 'design', label: 'עיצוב ההזמנה במתנה', price: 0 });
      assert.ok(!q.lines.some(l => l.key === 'calls'));
    } else if (design) assert.equal(q.lines.find(l => l.key === 'design').price, 79);
    MATRIX.push({ records, h, calls, design, sum: q.sum, plan: q.plan, hostesses: q.hostesses, bundle: q.bundle || '' });
  });
}

test('screenshot case: בסיס 50 + 2 דיילות + design + calls + wave was ₪2,274 → ₪1,990 (+35 third wave)', () => {
  const a = { hostesses: 2, design: true, calls: true };
  assert.equal(priceQuote({ ...base, plan: 'basic', records: 50, addons: a }).quote.sum, 1990);
  const w = priceQuote({ ...base, plan: 'basic', records: 50, addons: { ...a, extra_wave: true } }).quote;
  assert.equal(w.sum, 1990 + 35);
  assert.equal(w.plan, 'premium'); assert.equal(w.calls, false);
  assert.deepEqual(w.lines.map(l => l.price), [1990, 0, 35]);
});
test('3 hostesses at 650 → coerced to 2 with a note; 1 hostess at 800 → 2 with a note', () => {
  const q = priceQuote({ ...base, plan: 'basic', records: tierFor(650), addons: { hostesses: 3 } }).quote;
  assert.equal(q.hostesses, 2); assert.equal(q.sum, 1990); assert.equal(q.hostesses_asked, 3); assert.match(q.note, /רק מעל 700/);
  const b = priceQuote({ ...base, plan: 'basic', records: 800, addons: { hostesses: 1 } }).quote;
  assert.equal(b.hostesses, 2); assert.equal(b.sum, 2390); assert.match(b.note, /מינימום 2/);
});
test('no calls at all: same bundle price, plan basic, label "חבילה + דיילות, בלי שיחות"', () => {
  const q = priceQuote({ ...base, plan: 'premium', records: 300, no_calls: true, addons: { hostesses: 2, design: true } }).quote;
  assert.equal(q.sum, 1990); assert.equal(q.plan, 'basic'); assert.equal(q.no_calls, true);
  assert.ok(q.lines[0].label.includes('חבילה + דיילות, בלי שיחות')); assert.ok(q.code.startsWith('pkg:basic:300;design:1;host:2;'));
  assert.equal(priceQuote({ ...base, plan: 'basic', records: 900, no_calls: true, addons: { hostesses: 3 } }).quote.sum, 2590);
});
test('no hostesses: calls add-on only on basic; never on a plan that already has calls', () => {
  assert.equal(priceQuote({ ...base, calls_rounds: 1, records: 300, addons: { calls: true } }).quote.sum, 379);
  assert.equal(priceQuote({ ...base, calls_rounds: 0, records: 300, addons: { calls: true, extra_wave: true } }).quote.sum, 299 + 620 + 110);
});
