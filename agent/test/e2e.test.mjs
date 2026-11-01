import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processEvent, processApproval } from '../src/index.js';
import { baseEnv, recFetch } from './helpers.mjs';

/* a mention in #ishur-hagaa → Claude calls the green automations tool → reply in the same thread */
test('mention → green tool → Hebrew reply posted in the same thread', async () => {
  let n = 0;
  const f = recFetch(url => {
    if (url.startsWith('https://api.anthropic.com')) {
      n++;
      return { status: 200, body: n === 1
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'automations', input: {} }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'מחר יוצאות 14 תזכורות יום-האירוע להדר ויצחק.\nמקור: /api/automations.' }] } };
    }
    if (url === 'https://go.ishur.io/api/automations') return { status: 200, body: { ok: true, nodes: [] } };
    return { status: 200, body: { ok: true } };
  });
  const orig = globalThis.fetch; globalThis.fetch = f;
  try {
    const env = baseEnv();
    const out = await processEvent(env, { authorizations: [{ user_id: 'UBOT' }], event: { type: 'app_mention', channel: 'C_HAGAA', user: 'U_SHALEV', text: '<@UBOT> מה יוצא מחר?', ts: '1700.1' } });
    assert.equal(out.handled, true);
    const post = f.to('https://slack.com/api/chat.postMessage').at(-1).body;
    assert.equal(post.channel, 'C_HAGAA');
    assert.equal(post.thread_ts, '1700.1');
    assert.match(post.text, /^מחר יוצאות 14/);
    assert.equal(f.to('https://go.ishur.io/api/automations').length, 1);
    const firstUser = f.to('https://api.anthropic.com')[0].body.messages[0];
    assert.equal(firstUser.content, '<@U_SHALEV>: מה יוצא מחר?');
    assert.ok(env.AGENT_KV.m.has('thread:C_HAGAA:1700.1'), 'thread remembered for follow-up replies');
  } finally { globalThis.fetch = orig; }
});

test('approval click by Shalev → ephemeral refusal only', async () => {
  const f = recFetch();
  const orig = globalThis.fetch; globalThis.fetch = f;
  try {
    const out = await processApproval(baseEnv({ AGENT_WRITE: 'on' }), { type: 'block_actions', user: { id: 'U_SHALEV' }, container: { channel_id: 'C_HAGAA', message_ts: '2.2' },
      actions: [{ action_id: 'approve', value: JSON.stringify({ id: 'x', hash: 'y' }) }] });
    assert.equal(out.status, 'not-richard');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://slack.com/api/chat.postEphemeral');
  } finally { globalThis.fetch = orig; }
});
