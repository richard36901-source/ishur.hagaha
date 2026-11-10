import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, fillBody, buildNote, noteDailySend } from '../wavenote.js';

const mkEnv = () => {
  const kv = new Map();
  return { kv, env: { SLACK_ALERT_HOOK: 'https://hooks.slack.test/x', WA_TOKEN_GUESTS: 't', RATE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } } };
};
const metaFetch = async () => ({ json: async () => ({ data: [{ name: 'hazmana_ishur', status: 'APPROVED', components: [
  { type: 'BODY', text: 'היי {{1}}, מוזמנים ל{{2}} של {{3}} ב-{{4}} בשעה {{5}} ב{{6}}' },
  { type: 'BUTTONS', buttons: [{ text: 'מגיע/ה' }, { text: 'לא מגיע/ה' }] } ] }] }) });

test('kindOf: wave number first, then the template family', () => {
  assert.equal(kindOf({ wave: 1, template: 'hazmana_ishur' }).he, 'גל 1');
  assert.equal(kindOf({ wave: 2, template: 'hazmana_ishur' }).he, 'גל 2 · תזכורת');
  assert.equal(kindOf({ template: 'ishur_toda_orach_v2' }).key, 'thanks');
  assert.equal(kindOf({ wave: 'daybefore', template: 'ishur_lifnei_x' }).key, 'daybefore');
  assert.equal(kindOf({ template: 'ishur_otp' }), null);
});

test('fillBody puts the exact parameters into the slots', () => {
  assert.equal(fillBody('היי {{1}}, {{2}}', ['דנה', 'חתונה']), 'היי דנה, חתונה');
  assert.equal(fillBody('{{1}} {{3}}', ['א']), 'א {{3}}');
});

test('first guest send of the day posts ONE Slack note with title, exact wording, image and no buttons', async () => {
  const { env } = mkEnv(); const posts = [];
  const deps = { fetch: metaFetch, slackSend: async (e, text, o) => posts.push({ text, o }), eventName: async () => 'הדר ויצחק', now: Date.parse('2026-11-11T08:00:00Z') };
  const args = { token: 'tok-1', template: 'hazmana_ishur', params: ['דנה', 'חתונה', 'הדר ויצחק', 'יום רביעי 2 בדצמבר', '19:30', 'אודיסאה, באר שבע'], imageUrl: 'https://go.ishur.io/art/x.jpg', wave: 1 };
  const r1 = await noteDailySend(env, args, deps);
  assert.equal(r1.posted, true);
  assert.equal(r1.title, 'נשלח לאורחים · גל 1 · הדר ויצחק');
  assert.equal(posts.length, 1);
  const p = posts[0];
  assert.ok(p.text.includes('היי דנה, מוזמנים לחתונה של הדר ויצחק ב-יום רביעי 2 בדצמבר בשעה 19:30 באודיסאה, באר שבע'), p.text);
  assert.ok(!/מגיע\/ה/.test(p.text), 'buttons must not appear');
  assert.ok(!JSON.stringify(p.o.blocks).includes('מגיע/ה'), 'buttons must not appear in blocks');
  assert.equal(p.o.blocks[0].type, 'header');
  assert.ok(p.o.blocks.some(b => b.type === 'image' && b.image_url === args.imageUrl));
  assert.equal(p.o.important, true);
  /* the second guest of the same round, same day: silent */
  const r2 = await noteDailySend(env, { ...args, params: ['יוסי', ...args.params.slice(1)] }, deps);
  assert.equal(r2.skipped, 'already'); assert.equal(posts.length, 1);
  /* another round (wave 2) the same day: its own note */
  const r3 = await noteDailySend(env, { ...args, wave: 2 }, deps);
  assert.equal(r3.posted, true); assert.equal(posts.length, 2);
  assert.ok(posts[1].text.startsWith('*נשלח לאורחים · גל 2 · תזכורת · הדר ויצחק*'));
  /* the next day: again */
  const r4 = await noteDailySend(env, args, { ...deps, now: Date.parse('2026-11-12T08:00:00Z') });
  assert.equal(r4.posted, true); assert.equal(posts.length, 3);
});

test('video artwork becomes a link line, not an image block; missing template wording still posts', async () => {
  const { env } = mkEnv(); const posts = [];
  const deps = { fetch: async () => ({ json: async () => ({ data: [] }) }), slackSend: async (e, text, o) => posts.push({ text, o }), eventName: async () => 'מור ונועם' };
  const r = await noteDailySend(env, { token: 'tok-2', template: 'hazmana_vid', params: ['x'], imageUrl: 'https://go.ishur.io/vid/tok-2', wave: 1 }, deps);
  assert.equal(r.posted, true);
  assert.ok(!posts[0].o.blocks.some(b => b.type === 'image'));
  assert.ok(posts[0].text.includes('🎬'));
  assert.ok(posts[0].text.includes('לא נמצא במטא'));
});

test('buildNote quotes every line of the wording', () => {
  const n = buildNote({ kindHe: 'תודה', evName: 'א', tmpl: { body: 'שורה 1\nשורה 2', header: '', footer: 'ishur.io' }, params: [], imageUrl: '', template: 't' });
  assert.equal(n.blocks[1].text.text, '>שורה 1\n>שורה 2\n>\n>ishur.io');
});
