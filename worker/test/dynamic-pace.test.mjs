// 12/11 Richard: small days finish by noon, big days spread; base 50, max 100
import test from 'node:test';
import assert from 'node:assert/strict';
import { dynamicPace } from '../budget.js';
const at = (h, m = 0) => h * 60 + m;
const day = (remaining, nowH, nowM = 0) => dynamicPace({ remaining, minsLeft: at(20, 30) - at(nowH, nowM), minsToTarget: at(12) - at(nowH, nowM), base: 50, max: 100 });
test('300 at 09:00 → base 50 (done by 10:00)', () => { const r = day(300, 9); assert.equal(r.pace, 50); assert.equal(r.why, 'fits-by-target'); });
test('1,200 at 09:00 → 67/tick to finish by 12:00', () => { const r = day(1200, 9); assert.equal(r.pace, 67); assert.equal(r.why, 'finish-by-target'); });
test('3,000 at 09:00 → cannot make noon → runs at max 100 until done (~14:00)', () => { const r = day(3000, 9); assert.equal(r.pace, 100); assert.equal(r.why, 'max-until-done'); });
test('9,000 at 09:00 → spread needs 131/tick → capped at 100', () => { const r = day(9000, 9); assert.equal(r.pace, 100); assert.equal(r.why, 'spread-capped'); });
test('afternoon: 400 at 16:00 (target passed) → 400/27 ticks = 15 → base 50', () => { const r = day(400, 16); assert.equal(r.pace, 50); });
test('nothing left or window closed → base', () => {
  assert.equal(dynamicPace({ remaining: 0, minsLeft: 300 }).pace, 50);
  assert.equal(dynamicPace({ remaining: 500, minsLeft: 0 }).pace, 50);
});
test('admin settings: base 25 / max 60 are respected', () => {
  assert.equal(dynamicPace({ remaining: 1200, minsLeft: 690, minsToTarget: 180, base: 25, max: 60 }).pace, 60);
  assert.equal(dynamicPace({ remaining: 200, minsLeft: 690, minsToTarget: 180, base: 25, max: 60 }).pace, 25);
});
