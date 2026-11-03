/* shared test doubles: in-memory KV, a recording fetch, a Slack signer */
import { hmacHex } from '../src/slack.js';

export function memKV() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}

export function baseEnv(over = {}) {
  return {
    AGENT_WRITE: 'off',
    RICHARD_SLACK_ID: 'U_RICHARD',
    SHALEV_SLACK_ID: 'U_SHALEV',
    ALLOWED_CHANNELS: 'C_HAGAA',
    ISHUR_BASE: 'https://go.ishur.io',
    AGENT_ADMIN_KEY: 'test-admin-key',
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'sign-secret',
    ANTHROPIC_API_KEY: 'sk-test',
    AGENT_KV: memKV(),
    ...over,
  };
}

/* fetch double: records every call; responder(url, init) -> {status, body} */
export function recFetch(responder = () => ({ status: 200, body: { ok: true } })) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? safeJson(init.body) : undefined });
    const r = await responder(String(url), init);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  f.calls = calls;
  f.to = prefix => calls.filter(c => c.url.startsWith(prefix));
  return f;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

export async function signedRequest(path, rawBody, secret, { ts = Math.floor(Date.now() / 1000), headers = {}, sig } = {}) {
  const s = sig || 'v0=' + await hmacHex(secret, `v0:${ts}:${rawBody}`);
  return new Request('https://ishur-agent.test' + path, {
    method: 'POST', body: rawBody,
    headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': s, 'content-type': 'application/json', ...headers },
  });
}

export function fakeCtx() {
  const p = [];
  return { waitUntil: x => p.push(x), pending: p, done: () => Promise.all(p) };
}
