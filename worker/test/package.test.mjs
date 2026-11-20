// node --test worker/test/package.test.mjs — "החבילה שלי" (package.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from '../package.js';

test('the feature lines are the same ones the site shows (config.js PLANS)', () => {
  const src = fs.readFileSync(new URL('../../config.js', import.meta.url), 'utf8');
  for (const key of ['basic', 'pro', 'premium']) {
    const block = src.slice(src.indexOf(`key: '${key}'`)); const feats = block.slice(block.indexOf('features: ['), block.indexOf(']', block.indexOf('features: [')));
    const lines = [...feats.matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(P.PLAN_FEATURES[key], lines, key);
    assert.match(block.slice(0, 120), new RegExp(`name: '${P.PLAN_NAMES[key]}'`), key + ' name');
  }
});
test('the plan is read from the sheet text the same way the board reads it', () => {
  assert.equal(P.planKeyFromText('הכל כלול'), 'premium'); assert.equal(P.planKeyFromText('בסיס'), 'basic');
  assert.equal(P.planKeyFromText('פרמיום'), 'pro'); assert.equal(P.planKeyFromText(''), 'pro');
});
test('included lines build up through the packages and carry no price', async () => {
  assert.equal(P.includedLines('basic').length, 6);
  assert.equal(P.includedLines('pro').length, 9);
  const all = P.includedLines('premium');
  assert.ok(all.includes('3 סבבי שיחות מסוכן AI')); assert.ok(!all.some(l => /^סבב שיחות מסוכן AI/.test(l))); assert.ok(!all.some(l => /^כל מה שב/.test(l)));
  const kv = { get: async k => (k === 'extrasend:T' || k === 'hostess:T' ? '1' : null) };
  const p = await P.packageFor({ RATE: kv }, 'T', { plan: 'הכל כלול', guests_tier: '200' });
  assert.deepEqual([p.plan, p.name, p.guests, p.addons], ['premium', 'הכל כלול', 200, ['שליחה נוספת למוזמנים', 'דיילות קבלת פנים']]);
  assert.doesNotMatch(JSON.stringify(p), /₪|מחיר|שדרג|לרכישה/);
});
