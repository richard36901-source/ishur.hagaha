/* ============================================================================
   ishur-agent · the permission gate (the ONLY path from the model to a tool)
   ----------------------------------------------------------------------------
   green  → execute.
   yellow → AGENT_WRITE must be 'on' and the requester must be staff
            (Richard or Shalev); execute and record in ctx.actions so the
            reply says what was done.
   red    → never executed here. AGENT_WRITE must be 'on' and the requester
            must be staff; the exact {tool,args} is canonicalised, hashed
            (sha256) and stored in the agent's own KV, and an approval message
            with an "אשר" button is posted. handleApproval() executes it once,
            only for RICHARD_SLACK_ID, only if the hash still matches.
   ========================================================================== */
import { TOOL_BY_NAME, callTool, buildRequest, ToolInputError } from './tools.js';
import { slackApi, approvalBlocks } from './slack.js';

const APPROVAL_TTL_S = 24 * 3600;

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const payloadHash = payload => sha256Hex(canonical(payload));

const writeOn = env => String(env.AGENT_WRITE || 'off') === 'on';
const isStaff = (env, uid) => !!uid && (uid === env.RICHARD_SLACK_ID || uid === env.SHALEV_SLACK_ID);

function ilHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(now));
}
/* house rule: nothing reaches guests/clients 21:00–09:00 */
export const inSendWindow = (now = new Date()) => { const h = ilHour(now); return h >= 9 && h < 21; };

/* ctx: { requester, channel, thread_ts, actions: [], approvals: [], fetch, now } */
export async function gateTool(env, ctx, name, args) {
  const t = TOOL_BY_NAME[name];
  if (!t) return { error: 'unknown-tool', tool: name };
  const f = ctx.fetch || fetch;
  try { buildRequest(env, name, args); } catch (e) {
    if (e instanceof ToolInputError) return { error: 'bad-input', why: e.message };
    throw e;
  }
  if (t.tier === 'green') return callTool(env, name, args, f);

  if (!writeOn(env)) return { blocked: true, tier: t.tier, why: 'AGENT_WRITE=off — פעולות כתיבה כבויות. רק קריאה.' };
  if (!isStaff(env, ctx.requester)) return { blocked: true, tier: t.tier, why: 'only Richard or Shalev may request write actions' };

  if (t.tier === 'yellow') {
    const res = await callTool(env, name, args, f);
    ctx.actions.push({ tool: name, args, ok: !!res.ok, http_status: res.http_status });
    return res;
  }

  if (t.tier === 'red') {
    const payload = { tool: name, args: args || {} };
    const hash = await payloadHash(payload);
    const id = crypto.randomUUID();
    const rec = { id, payload, hash, requester: ctx.requester, ts: Date.now(), channel: ctx.channel, thread_ts: ctx.thread_ts, status: 'pending' };
    await env.AGENT_KV.put('appr:' + id, JSON.stringify(rec), { expirationTtl: APPROVAL_TTL_S });
    const posted = await slackApi(env, 'chat.postMessage', {
      channel: ctx.channel, thread_ts: ctx.thread_ts, text: `🔴 דרוש אישור של ריצארד: ${name}`,
      blocks: approvalBlocks({ id, hash, tool: name, args: payload.args, requester: ctx.requester }),
    }, f);
    ctx.approvals.push({ id, tool: name });
    return { pending_approval: true, approval_id: id, posted: !!(posted && posted.ok), note: 'NOT executed. Waiting for Richard to press אשר.' };
  }
  return { error: 'bad-tier' };
}

/* Interactivity callback. payload = Slack block_actions JSON.
   Returns { status, reply } and never throws on bad input. */
export async function handleApproval(env, payload, { fetch: f = fetch, now = new Date() } = {}) {
  const user = payload && payload.user && payload.user.id;
  const action = ((payload && payload.actions) || [])[0];
  if (!action || action.action_id !== 'approve') return { status: 'ignored' };
  let v; try { v = JSON.parse(action.value); } catch { return { status: 'bad-value' }; }
  if (!v || typeof v.id !== 'string' || typeof v.hash !== 'string') return { status: 'bad-value' };

  if (!env.RICHARD_SLACK_ID || user !== env.RICHARD_SLACK_ID) return { status: 'not-richard', reply: 'רק ריצארד יכול לאשר פעולה אדומה. הבקשה נשארת ממתינה.' };
  if (!writeOn(env)) return { status: 'write-off', reply: 'AGENT_WRITE כבוי. לא בוצע.' };

  const key = 'appr:' + v.id;
  let rec = null; try { rec = JSON.parse(await env.AGENT_KV.get(key)); } catch {}
  if (!rec) return { status: 'not-found', reply: 'הבקשה לא נמצאה או שפג תוקפה.' };
  if (rec.status !== 'pending') return { status: 'already-' + rec.status, reply: 'הבקשה כבר טופלה. לא בוצע שוב.' };
  if (Date.now() - Number(rec.ts) > APPROVAL_TTL_S * 1000) return { status: 'expired', reply: 'פג תוקף הבקשה (24 שעות).' };

  const recomputed = await payloadHash(rec.payload);
  if (recomputed !== rec.hash || recomputed !== v.hash) {
    rec.status = 'hash-mismatch'; await env.AGENT_KV.put(key, JSON.stringify(rec), { expirationTtl: APPROVAL_TTL_S });
    return { status: 'hash-mismatch', reply: 'התוכן השתנה מאז הבקשה. לא בוצע.' };
  }
  const t = TOOL_BY_NAME[rec.payload.tool];
  if (!t || t.tier !== 'red') return { status: 'bad-tool' };
  if (t.sends && !inSendWindow(now)) return { status: 'outside-window', reply: 'מחוץ לחלון 09:00–21:00. לא בוצע; צריך לבקש מחדש בחלון.' };

  /* claim before executing so a double click cannot run it twice (KV is not
     transactional: two clicks inside the same ~second can still race — see SETUP.md) */
  rec.status = 'executing'; rec.approved_by = user; rec.approved_at = Date.now();
  await env.AGENT_KV.put(key, JSON.stringify(rec), { expirationTtl: APPROVAL_TTL_S });
  let res;
  try { res = await callTool(env, rec.payload.tool, rec.payload.args, f); }
  catch (e) { res = { ok: false, error: String(e && e.message) }; }
  rec.status = 'done'; rec.result = { ok: !!res.ok, http_status: res.http_status };
  await env.AGENT_KV.put(key, JSON.stringify(rec), { expirationTtl: APPROVAL_TTL_S });
  return { status: 'executed', rec, result: res, reply: `${res.ok ? '✅' : '❌'} בוצע: ${rec.payload.tool} · HTTP ${res.http_status ?? '?'}` };
}
