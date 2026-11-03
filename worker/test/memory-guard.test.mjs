// node --test worker/test/memory-guard.test.mjs
// R8: the gate between "a model said so" and "Noa says so on every call".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryGuard, addMemory, getMemory, memoryBlock, renderMemory, memoryKey, MEMORY_MAX } from '../noa.js';

/* an in-memory KV with the three methods the module uses */
function fakeKv() {
  const m = new Map();
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
}

test('memoryGuard accepts a plain behavioural lesson', () => {
  assert.equal(memoryGuard('כשמבקשים לחזור אחר כך, לשאול מתי נוח ולא ללחוץ').ok, true);
  assert.equal(memoryGuard('לפתוח במשפט אחד ולחכות לתשובה לפני שממשיכים').ok, true);
});

test('memoryGuard rejects the iron-rule words', () => {
  assert.equal(memoryGuard('להציע הנחה כשמהססים').why, 'banned:הנחה');
  assert.equal(memoryGuard('להגיד שהדיילת חינם').why, 'banned:חינם');
  assert.equal(memoryGuard('להבטיח ללא הגבלה של אורחים').why.startsWith('banned:'), true);
  assert.equal(memoryGuard('להגיד שאני מבטיחה שהכל יסתדר').why, 'banned:מבטיח');
});

test('memoryGuard rejects prices that are not in the config, keeps the known ones', () => {
  assert.equal(memoryGuard('להגיד שהחבילה עולה 999 ₪').ok, false);
  assert.equal(memoryGuard('להגיד שהחבילה עולה 999 ₪').why, 'price:999');
  assert.equal(memoryGuard('מחיר 1200 שקל לדיילת').why, 'price:1200');
  assert.equal(memoryGuard('דיילת אחת עולה 1790 ₪ ושתיים 1990 ₪').ok, true, 'config prices pass');
  assert.equal(memoryGuard('להזכיר שהנסיעות מחוץ למרכז 250 ₪').ok, true);
  assert.equal(memoryGuard('בלי מחיר בכלל, רק להסביר מה כלול').ok, true, 'no number = nothing to compare');
});

test('memoryGuard rejects PII: phones, emails, the people on the call', () => {
  assert.equal(memoryGuard('לחזור ל-054-576-4327 מחר').why, 'pii:phone');
  assert.equal(memoryGuard('לחזור ל 0545764327 מחר').why, 'pii:phone');
  assert.equal(memoryGuard('לשלוח ל a@b.co את הקישור').why, 'pii:email');
  assert.equal(memoryGuard('דנה ביקשה שיחזרו אליה בערב', { names: ['דנה כהן'] }).why, 'pii:name');
  assert.equal(memoryGuard('הליד בשם משה לא רוצה שיחות').why, 'pii:name');
  assert.equal(memoryGuard('אנשים מבקשים שיחזרו אליהם בערב', { names: ['דנה כהן'] }).ok, true);
});

test('memoryGuard rejects empty, too long and non-Hebrew lines', () => {
  assert.equal(memoryGuard('').why, 'empty');
  assert.equal(memoryGuard('   ').why, 'empty');
  assert.equal(memoryGuard('א'.repeat(161)).why, 'too-long');
  assert.equal(memoryGuard('always say hello first').why, 'not-hebrew');
});

test('addMemory: guard applied, duplicates dropped, 40-line FIFO, per-agent keys', async () => {
  const env = { RATE: fakeKv() };
  const r = await addMemory(env, 'נועה', ['לשאול מתי נוח לחזור', 'להציע הנחה', 'לשאול מתי נוח לחזור'], { source: 'call:x', by: 'בקרה' });
  assert.deepEqual(r.added, ['לשאול מתי נוח לחזור']);
  assert.deepEqual(r.rejected.map(x => x.why), ['banned:הנחה', 'duplicate']);
  const mem = await getMemory(env, 'נועה');
  assert.equal(mem.length, 1);
  assert.equal(mem[0].source, 'call:x');
  assert.equal(mem[0].by, 'בקרה');
  assert.ok(mem[0].at);
  assert.equal(memoryKey('נועה'), 'noa-memory');
  assert.equal(memoryKey('שיר'), 'shir-memory');
  assert.equal((await getMemory(env, 'שיר')).length, 0, 'Shir has her own key');

  for (let i = 0; i < 45; i++) await addMemory(env, 'שיר', 'לקח מספר ' + 'א'.repeat(i + 1), 'test');
  const shir = await getMemory(env, 'שיר');
  assert.equal(shir.length, MEMORY_MAX);
  assert.equal(shir[0].text, 'לקח מספר ' + 'א'.repeat(6), 'the oldest five left (FIFO)');
  assert.equal(shir[MEMORY_MAX - 1].text, 'לקח מספר ' + 'א'.repeat(45));
});

test('memoryBlock renders a Hebrew bullet block, empty string when nothing is known', async () => {
  const env = { RATE: fakeKv() };
  assert.equal(await memoryBlock(env, 'נועה'), '');
  await addMemory(env, 'נועה', ['לשאול מתי נוח לחזור', 'לא לחזור על הפתיח'], 'test');
  const b = await memoryBlock(env, 'נועה');
  assert.ok(b.startsWith('דברים שלמדתי משיחות קודמות:'));
  assert.ok(b.includes('• לשאול מתי נוח לחזור'));
  assert.ok(b.includes('• לא לחזור על הפתיח'));
  assert.equal(renderMemory([]), '');
  assert.equal(await memoryBlock({}, 'נועה'), '', 'no KV = empty, never throws');
});
