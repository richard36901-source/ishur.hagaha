/* 08/11 (Richard): "nothing falls between the chairs" — the template guard */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBroken, isGood, reword, copyPayload, runGuard, placeholders, ALT_PREFIX } from '../templateguard.js';

const BODY = 'שלום {{1}}! מחכים לראותכם היום ב{{2}} 🎉\n⏰ שעה: {{3}}\n📍 הכתובת: {{4}}\n🧭 לניווט לחצו על הכפתור למטה.\n🎁 מי שירצה לתת מתנה לבעלי השמחה, אפשר בביט בכפתור למטה.\nמאחלים ערב מושלם, נתראה!';
const T = (o = {}) => ({ name: 'ishur_yom_combo_gb', status: 'APPROVED', category: 'UTILITY', language: 'he',
  components: [{ type: 'BODY', text: BODY, example: { body_text: [['a', 'b', 'c', 'd']] } }, { type: 'FOOTER', text: 'f' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'ניווט', url: 'https://go.ishur.io/nav/{{1}}' }, { type: 'URL', text: 'מתנה בביט', url: 'https://go.ishur.io/gift/{{1}}' }] }], ...o });
function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; }

test('broken = rejected / paused / disabled / approved-as-MARKETING / missing; good = APPROVED UTILITY', () => {
  assert.equal(isBroken(null), 'missing');
  assert.equal(isBroken(T({ status: 'REJECTED' })), 'rejected');
  assert.equal(isBroken(T({ category: 'MARKETING' })), 'marketing');
  assert.equal(isBroken(T({ status: 'PENDING' })), '');
  assert.equal(isBroken(T()), '');
  assert.ok(isGood(T())); assert.ok(!isGood(T({ category: 'MARKETING' })));
});
test('every reword level keeps the same variables in the same order, and changes the wording', () => {
  for (const lvl of [1, 2, 3]) {
    const r = reword(BODY, lvl, { hasButtons: true });
    assert.deepEqual(placeholders(r), placeholders(BODY), 'level ' + lvl);
    assert.notEqual(r, BODY);
    assert.ok(!/🎁|🎉/.test(r), 'no emojis at level ' + lvl);
  }
  assert.match(reword(BODY, 2), /בביט נמצא בכפתור/);
  assert.doesNotMatch(reword(BODY, 2), /פייבוקס/, 'Bit-only stays Bit-only');
});
test('the copy keeps buttons + footer, is UTILITY, named _r<n>; media headers are never rebuilt', () => {
  const p = copyPayload(T(), 1);
  assert.equal(p.name, 'ishur_yom_combo_gb_r1'); assert.equal(p.category, 'UTILITY');
  assert.equal(p.components.find(c => c.type === 'BUTTONS').buttons.length, 2);
  assert.ok(p.components.find(c => c.type === 'FOOTER'));
  assert.equal(copyPayload(T({ components: [{ type: 'HEADER', format: 'IMAGE' }, ...T().components] }), 1), null);
});
test('run: a reclassified template gets a copy submitted; approved copy → tmplalt; original healthy again → back', async () => {
  let metas = [T({ category: 'MARKETING' })]; const submitted = []; const notes = [];
  const store = kv();
  const deps = { list: async () => metas, submit: async p => { submitted.push(p); return { id: '1', status: 'PENDING' }; }, kv: store, notify: async t => notes.push(t), log: async () => {} };
  let r = await runGuard(['ishur_yom_combo_gb'], deps);
  assert.equal(r[0].action, 'submitted'); assert.equal(submitted[0].name, 'ishur_yom_combo_gb_r1');
  metas = [T({ category: 'MARKETING' }), { ...submitted[0], status: 'PENDING', category: 'UTILITY' }];
  r = await runGuard(['ishur_yom_combo_gb'], deps);
  assert.equal(r[0].action, 'waiting'); assert.equal(submitted.length, 1, 'never resubmits while pending');
  metas = [T({ category: 'MARKETING' }), { ...submitted[0], status: 'APPROVED', category: 'UTILITY' }];
  r = await runGuard(['ishur_yom_combo_gb'], deps);
  assert.equal(r[0].action, 'alt-approved'); assert.equal(await store.get(ALT_PREFIX + 'ishur_yom_combo_gb'), 'ishur_yom_combo_gb_r1');
  metas = [T(), { ...submitted[0], status: 'APPROVED', category: 'UTILITY' }];
  r = await runGuard(['ishur_yom_combo_gb'], deps);
  assert.equal(r[0].action, 'back-to-original'); assert.equal(await store.get(ALT_PREFIX + 'ishur_yom_combo_gb'), null);
});
test('run: copy also goes MARKETING → next level; all levels used → P1 to a human', async () => {
  const submitted = []; const notes = [];
  let metas = [T({ status: 'REJECTED' })];
  const deps = { list: async () => metas, submit: async p => { submitted.push(p); return { id: 'x', status: 'PENDING' }; }, kv: kv(), notify: async (t, o) => notes.push([t, o]), log: async () => {} };
  await runGuard(['ishur_yom_combo_gb'], deps);
  metas = [T({ status: 'REJECTED' }), { ...submitted[0], status: 'APPROVED', category: 'MARKETING' }];
  await runGuard(['ishur_yom_combo_gb'], deps);
  assert.equal(submitted[1].name, 'ishur_yom_combo_gb_r2');
  metas = [T({ status: 'REJECTED' }), { ...submitted[0], status: 'REJECTED' }, { ...submitted[1], status: 'REJECTED' }];
  await runGuard(['ishur_yom_combo_gb'], deps);
  assert.equal(submitted[2].name, 'ishur_yom_combo_gb_r3');
  metas.push({ ...submitted[2], status: 'REJECTED' });
  const r = await runGuard(['ishur_yom_combo_gb'], deps);
  assert.equal(r[0].action, 'stuck'); assert.equal(notes.at(-1)[1].sev, 'P1');
});
test('run: a missing template that was never created → P1 (nothing to rebuild from)', async () => {
  const notes = [];
  const r = await runGuard(['ishur_nope'], { list: async () => [], submit: async () => ({}), kv: kv(), notify: async (t, o) => notes.push(o), log: async () => {} });
  assert.equal(r[0].action, 'stuck'); assert.equal(notes[0].sev, 'P1');
});

import { nightMaxAge } from '../snapshot.js';
test('snapshot · screens keep an hour at night (Israel 21:00–08:00); senders never stretched', () => {
  const night = Date.parse('2026-11-08T21:30:00Z'), day = Date.parse('2026-11-08T10:00:00Z');   /* 23:30 / 12:00 IL */
  assert.equal(nightMaxAge('dashboard', 300, night), 3600);
  assert.equal(nightMaxAge('send', 300, night), 300);
  assert.equal(nightMaxAge('write', 0, night), 0);
  assert.equal(nightMaxAge('dashboard', 300, day), 300);
});
