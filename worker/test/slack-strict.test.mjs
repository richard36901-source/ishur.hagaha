import test from 'node:test';
import assert from 'node:assert/strict';
import { slackSend, slackImportant, muteKey } from '../slack.js';

function env() {
  const kv = new Map();
  return { SLACK_ALERT_HOOK: 'https://hook', SLACK_STRICT: '1',
    RATE: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async k => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) } };
}
function capture() { const posts = []; globalThis.fetch = async (u, o) => { if (u === 'https://hook') posts.push(JSON.parse(o.body).text); return new Response('{}'); }; return posts; }
const noon = new Date('2026-11-04T10:00:00Z');

test('strict: noise (131042, pacer, hold, 131047) never reaches Slack', async () => {
  const e = env(), posts = capture();
  for (const t of ['🚨 *מוח · נועה 4499: מטא מחזירה 131042*', '🚨 *מוח · הפייסר לא רץ 300 דקות*', '🟡 *אירוע בהחזקה יותר מיומיים*', '⚠️ *מוח · 29 הודעות נכשלו היום ב-131047*'])
    await slackSend(e, t, { key: 'x', urgent: true, now: noon });
  assert.equal(posts.length, 0);
});
test('strict: a payment posts once; the same title again within 24h is silent', async () => {
  const e = env(), posts = capture();
  await slackSend(e, '💰 *תשלום התקבל* · שרון · ₪178', { oneoff: true, urgent: true, now: noon });
  await slackSend(e, '💰 *תשלום התקבל* · שרון · ₪178', { oneoff: true, urgent: true, now: noon });
  assert.equal(posts.length, 1);
});
test('strict: Make down is important, the digest always posts', async () => {
  assert.equal(slackImportant('🚨 *מוח · Make מושהה/לא עונה*', { key: 'finding:make_down' }), true);
  const e = env(), posts = capture();
  await slackSend(e, '☀️ *בוקר · סיכום*', { oneoff: true, urgent: true, digest: true, now: noon });
  await slackSend(e, '☀️ *בוקר · סיכום*', { oneoff: true, urgent: true, digest: true, now: noon });
  assert.equal(posts.length, 2);
});
test('mute key ignores changing numbers', () => {
  assert.equal(muteKey('⚠️ 27 הודעות נכשלו'), muteKey('⚠️ 29 הודעות נכשלו'));
});

/* 12/11 Richard: a purchase / an upgrade is a green 🎉 line that reaches Slack at once (it used to fall into the digest as "info") */
test('strict: 🎉 תשלום חדש / שדרוג נרכש are important and post immediately', async () => {
  assert.equal(slackImportant('🎉 *תשלום חדש* · ₪379 · 300 מוזמנים פרימיום · שירן 053-830-9006 · לקוח חדש'), true);
  assert.equal(slackImportant('🎉 *שדרוג נרכש* · ₪59 · שליחה נוספת · אלעד 050-000-0000'), true);
  assert.equal(slackImportant('💳 *תשלום חדש* · ₪379'), true);
  const e = env(), posts = capture();
  await slackSend(e, '🎉 *תשלום חדש* · ₪379 · 300 מוזמנים פרימיום · שירן', { oneoff: true, urgent: true, now: noon, important: true });
  assert.equal(posts.length, 1);
  assert.match(posts[0], /🎉/);
});
