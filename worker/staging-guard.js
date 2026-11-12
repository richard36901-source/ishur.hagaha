/* ============================================================================
   ishur.io · staging-guard.js · the hard egress guard (dev-staging, 12/11/2026)
   ----------------------------------------------------------------------------
   Staging (`STAGING = "1"` in wrangler [env.staging]) runs the same code as
   production with production-shaped secrets. The only thing that must never
   happen there is a message or a call reaching a real guest, client or lead.

   So instead of trusting every one of the ~10 send sites, the guard wraps
   globalThis.fetch once per isolate and decides per request, deny by default:
     · graph.facebook.com …/messages POST  → body.to must be on STAGING_ALLOWLIST
     · api.retellai.com create-phone-call → body.to_number must be on it
     · Slack, Make hooks, Anthropic, PostHog → allowed (staging secrets decide
       where they land; the Sheet id comes from SHEET_ID)
     · Monday, Telnyx, Linear, Cloudflare, googleapis → reads only
     · Morning / GreenInvoice / Meshulam (money) and anything else → blocked
   A blocked request never touches the network: the caller gets a synthetic
   403 {ok:false, error:'staging-blocked'} so its normal error path runs, and
   one stagingblock:<ts> row lands in KV for the ops journal.

   Production: isStaging() is false → nothing is installed, fetch is untouched.
   whatsapp.js post() repeats the phone check itself (defense in depth).
   ========================================================================== */

export const BLOCKED = 'staging-blocked';
const KV_PREFIX = 'stagingblock:';
const KV_TTL = 7 * 86400;

export function isStaging(env) { return !!env && env.STAGING === '1'; }

function digits(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}
export function allowlist(env) {
  return String((env && env.STAGING_ALLOWLIST) || '').split(',').map(digits).filter(Boolean);
}
export function isAllowedPhone(env, phone) {
  const d = digits(phone);
  return !!d && allowlist(env).includes(d);
}

/* hosts and what they may do in staging */
const SEND_WA = /^graph\.facebook\.com$/;
const SEND_RETELL = /^api\.retellai\.com$/;
const OPEN = [/^hooks\.slack\.com$/, /^hook\.[a-z0-9-]+\.make\.com$/, /^api\.anthropic\.com$/, /^us\.i\.posthog\.com$/];
const READ_ONLY = [/^api\.monday\.com$/, /^api\.telnyx\.com$/, /^api\.linear\.app$/, /^api\.cloudflare\.com$/, /\.googleapis\.com$/, /^api\.github\.com$/];
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* pure: { ok:true } | { ok:false, why, to } — body is the raw string (or null) */
export function decide(env, url, method, body) {
  if (!isStaging(env)) return { ok: true };
  let host = '', path = '';
  try { const u = new URL(String(url)); host = u.hostname; path = u.pathname; } catch { return { ok: false, why: 'bad-url' }; }
  const m = String(method || 'GET').toUpperCase();
  const isWrite = WRITE.has(m);
  const recipient = key => {
    if (typeof body !== 'string') return null;
    try { const j = JSON.parse(body); return j && j[key] != null ? digits(j[key]) : ''; } catch { return null; }
  };
  if (SEND_WA.test(host)) {
    if (!(isWrite && /\/messages$/.test(path))) return { ok: true };
    const to = recipient('to');
    if (to == null) return { ok: false, why: 'unparseable-send', to: '' };
    return isAllowedPhone(env, to) ? { ok: true } : { ok: false, why: 'not-allowlisted', to };
  }
  if (SEND_RETELL.test(host)) {
    if (!(isWrite && /create-phone-call$/.test(path))) return isWrite ? { ok: false, why: 'retell-write' } : { ok: true };
    const to = recipient('to_number');
    if (to == null) return { ok: false, why: 'unparseable-call', to: '' };
    return isAllowedPhone(env, to) ? { ok: true } : { ok: false, why: 'not-allowlisted', to };
  }
  if (OPEN.some(re => re.test(host))) return { ok: true };
  if (READ_ONLY.some(re => re.test(host))) return isWrite ? { ok: false, why: 'read-only-host' } : { ok: true };
  return { ok: false, why: 'host-not-allowed' };
}

function blockedResponse(host, d) {
  return new Response(JSON.stringify({ ok: false, error: BLOCKED, why: d.why, host, to: d.to || '' }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'X-Staging-Blocked': d.why } });
}
function journal(env, host, method, d) {
  try {
    if (!env.RATE) return;
    const p = env.RATE.put(KV_PREFIX + Date.now() + ':' + Math.random().toString(36).slice(2, 6),
      JSON.stringify({ at: new Date().toISOString(), host, method, why: d.why, to: d.to || '' }), { expirationTtl: KV_TTL });
    if (p && p.catch) p.catch(() => {});
  } catch {}
}

const WRAPPED = Symbol.for('ishur.staging-guard');
let original = null;

/* idempotent; called at the top of fetch() and scheduled() */
export function installStagingGuard(env) {
  if (!isStaging(env)) return false;
  if (globalThis.fetch && globalThis.fetch[WRAPPED]) { globalThis.fetch[WRAPPED].env = env; return true; }
  original = globalThis.fetch;
  const state = { env };
  const guarded = async function (input, init) {
    const e = state.env;
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = (init && init.method) || (req && req.method) || 'GET';
    let body = null;
    if (WRITE.has(String(method).toUpperCase())) {
      if (init && init.body != null) body = typeof init.body === 'string' ? init.body : undefined;
      else if (req) { try { body = await req.clone().text(); } catch { body = undefined; } }
      if (body === undefined) body = null;   /* FormData / streams: not inspectable → send endpoints fail closed */
    }
    const d = decide(e, url, method, body);
    if (d.ok) return original(input, init);
    let host = ''; try { host = new URL(url).hostname; } catch {}
    journal(e, host, method, d);
    return blockedResponse(host, d);
  };
  guarded[WRAPPED] = state;
  globalThis.fetch = guarded;
  return true;
}
/* tests only */
export function uninstallStagingGuard() {
  if (globalThis.fetch && globalThis.fetch[WRAPPED] && original) { globalThis.fetch = original; original = null; }
}

/* env copy whose EMAIL binding refuses to send in staging */
export function wrapEmail(env) {
  if (!isStaging(env) || !env.EMAIL) return env;
  const e2 = Object.create(Object.getPrototypeOf(env) || null);
  Object.assign(e2, env);
  e2.EMAIL = { send: async () => { journal(env, 'email', 'SEND', { why: 'email' }); return { ok: false, error: BLOCKED }; } };
  return e2;
}
