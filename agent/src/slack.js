/* ishur-agent · Slack plumbing: signature check, posting, thread history */

const enc = new TextEncoder();

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }

export async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* Slack v0 signature: HMAC-SHA256(secret, "v0:<ts>:<raw body>"), 5-minute window.
   Returns { ok, why }. nowSec is injectable for tests. */
export async function verifySlackSignature(secret, headers, rawBody, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, why: 'no-secret' };
  const ts = headers.get('x-slack-request-timestamp');
  const sig = headers.get('x-slack-signature');
  if (!ts || !sig) return { ok: false, why: 'missing-headers' };
  if (!/^\d+$/.test(ts)) return { ok: false, why: 'bad-timestamp' };
  if (Math.abs(nowSec - Number(ts)) > 300) return { ok: false, why: 'stale' };
  const want = 'v0=' + await hmacHex(secret, `v0:${ts}:${rawBody}`);
  return timingSafeEqual(want, sig) ? { ok: true } : { ok: false, why: 'bad-signature' };
}

export async function slackApi(env, method, payload, fetchImpl = fetch) {
  const r = await fetchImpl('https://slack.com/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({ ok: false, error: 'bad-json' }));
}

export async function threadHistory(env, channel, ts, fetchImpl = fetch) {
  const r = await fetchImpl(`https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(ts)}&limit=30`, {
    headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN },
  });
  const j = await r.json().catch(() => ({}));
  return (j && j.messages) || [];
}

/* Block Kit approval message with one "אשר" button */
export function approvalBlocks({ id, hash, tool, args, requester }) {
  const shown = JSON.stringify(args, null, 1);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `🔴 *דרוש אישור של ריצארד*\n*פעולה:* \`${tool}\`\n*ביקש/ה:* <@${requester}>` } },
    { type: 'section', text: { type: 'mrkdwn', text: '```' + shown.slice(0, 2500) + '```' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `hash \`${hash.slice(0, 16)}\` · תוקף 24 שעות · רק ריצארד יכול לאשר` }] },
    { type: 'actions', elements: [{ type: 'button', style: 'danger', action_id: 'approve', text: { type: 'plain_text', text: 'אשר' }, value: JSON.stringify({ id, hash }) }] },
  ];
}
