/* ============================================================================
   ishur-agent · Cloudflare Worker entry
     POST /slack/events       Events API (url_verification, app_mention, thread replies)
     POST /slack/interactive  Block Kit button callback (the "אשר" approvals)
     GET  /health             liveness + whether writes are on
   Slack must get a 200 within 3 s, so every real piece of work runs in
   ctx.waitUntil after the ack.
   ========================================================================== */
import { verifySlackSignature, slackApi, threadHistory } from './slack.js';
import { runAgent, formatReply } from './claude.js';
import { handleApproval } from './gate.js';
import { TOOLS } from './tools.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const allowedChannel = (env, ch) => {
  const list = String(env.ALLOWED_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  return !list.length || list.includes(ch);
};

export async function handleEvents(request, env, ctx) {
  const raw = await request.text();
  const v = await verifySlackSignature(env.SLACK_SIGNING_SECRET, request.headers, raw);
  if (!v.ok) return json({ ok: false, why: v.why }, 401);
  let body; try { body = JSON.parse(raw); } catch { return json({ ok: false, why: 'bad-json' }, 400); }
  if (body.type === 'url_verification') return new Response(String(body.challenge || ''), { headers: { 'Content-Type': 'text/plain' } });
  if (body.type !== 'event_callback' || !body.event) return json({ ok: true, ignored: true });

  /* retries: Slack re-sends the same event_id (X-Slack-Retry-Num) when we were slow */
  const eid = String(body.event_id || '');
  if (eid) {
    if (await env.AGENT_KV.get('evt:' + eid)) return json({ ok: true, duplicate: true, retry: request.headers.get('x-slack-retry-num') || '0' });
    await env.AGENT_KV.put('evt:' + eid, '1', { expirationTtl: 3600 });
  }
  ctx.waitUntil(processEvent(env, body).catch(e => console.log('processEvent failed', e && e.message)));
  return json({ ok: true });
}

export function shouldHandle(env, body, threadKnown) {
  const ev = body.event || {};
  if (ev.bot_id || ev.subtype) return false;               // ignore bots (incl. ourselves) and edits/joins
  if (!allowedChannel(env, ev.channel)) return false;
  const botUser = (body.authorizations && body.authorizations[0] && body.authorizations[0].user_id) || env.SLACK_BOT_USER_ID || '';
  if (ev.type === 'app_mention') return true;
  if (ev.type === 'message' && ev.thread_ts && ev.thread_ts !== ev.ts) {
    if (botUser && String(ev.text || '').includes(`<@${botUser}>`)) return false; // the app_mention copy handles it
    return !!threadKnown;
  }
  return false;
}

/* Slack thread → Anthropic messages (alternating, starts and ends with user) */
export function toMessages(history, botUser) {
  const out = [];
  for (const m of history) {
    if (!m.text) continue;
    const mine = (botUser && m.user === botUser) || !!m.bot_id;
    const role = mine ? 'assistant' : 'user';
    const text = mine ? m.text : `<@${m.user}>: ${String(m.text).replace(new RegExp(`<@${botUser}>`, 'g'), '').trim()}`;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + text;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  return out.slice(-20).filter((m, i, a) => i > 0 || m.role === 'user');
}

export async function processEvent(env, body) {
  const ev = body.event;
  const tkey = `thread:${ev.channel}:${ev.thread_ts || ''}`;
  const known = ev.thread_ts ? !!(await env.AGENT_KV.get(tkey)) : false;
  if (!shouldHandle(env, body, known)) return { handled: false };
  const botUser = (body.authorizations && body.authorizations[0] && body.authorizations[0].user_id) || env.SLACK_BOT_USER_ID || '';
  const thread_ts = ev.thread_ts || ev.ts;
  let messages;
  if (ev.thread_ts) messages = toMessages(await threadHistory(env, ev.channel, ev.thread_ts), botUser);
  if (!messages || !messages.length) messages = toMessages([ev], botUser);
  await env.AGENT_KV.put(`thread:${ev.channel}:${thread_ts}`, '1', { expirationTtl: 7 * 86400 });

  const ctx = { requester: ev.user, channel: ev.channel, thread_ts, actions: [], approvals: [] };
  let text;
  try {
    const r = await runAgent(env, messages, ctx);
    text = formatReply(r.text, ctx.actions);
  } catch (e) {
    console.log('agent error', e && e.message);
    text = formatReply('לא הצלחתי להשלים את הבקשה (שגיאה פנימית בסוכן). הפרטים בלוג של ishur-agent.', ctx.actions);
  }
  await slackApi(env, 'chat.postMessage', { channel: ev.channel, thread_ts, text });
  return { handled: true, text, ctx };
}

export async function handleInteractive(request, env, ctx) {
  const raw = await request.text();
  const v = await verifySlackSignature(env.SLACK_SIGNING_SECRET, request.headers, raw);
  if (!v.ok) return json({ ok: false, why: v.why }, 401);
  let payload; try { payload = JSON.parse(new URLSearchParams(raw).get('payload') || ''); } catch { return json({ ok: false, why: 'bad-payload' }, 400); }
  ctx.waitUntil(processApproval(env, payload).catch(e => console.log('approval failed', e && e.message)));
  return new Response('', { status: 200 });
}

export async function processApproval(env, payload) {
  const out = await handleApproval(env, payload);
  const channel = (payload.container && payload.container.channel_id) || (payload.channel && payload.channel.id);
  const msgTs = (payload.container && payload.container.message_ts) || (payload.message && payload.message.ts);
  const thread_ts = (payload.message && payload.message.thread_ts) || msgTs;
  if (out.status === 'ignored' || out.status === 'bad-value') return out;
  if (out.status === 'not-richard') {
    await slackApi(env, 'chat.postEphemeral', { channel, user: payload.user.id, text: out.reply });
    return out;
  }
  if (out.status === 'executed' && channel && msgTs) {
    await slackApi(env, 'chat.update', { channel, ts: msgTs, text: out.reply,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${out.reply}\nאושר ע"י <@${payload.user.id}>` } }] });
  }
  if (channel && out.reply) await slackApi(env, 'chat.postMessage', { channel, thread_ts, text: out.reply });
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/slack/events') return handleEvents(request, env, ctx);
    if (request.method === 'POST' && url.pathname === '/slack/interactive') return handleInteractive(request, env, ctx);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, write: String(env.AGENT_WRITE || 'off'), tools: TOOLS.length,
        has: { slack_token: !!env.SLACK_BOT_TOKEN, signing: !!env.SLACK_SIGNING_SECRET, anthropic: !!env.ANTHROPIC_API_KEY, admin: !!env.AGENT_ADMIN_KEY, kv: !!env.AGENT_KV } });
    }
    return new Response('not found', { status: 404 });
  },
};
