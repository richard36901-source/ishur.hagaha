/* ============================================================================
   Serve-stale-then-refresh for the heavy admin reads (16/11/2026, Richard:
   "אינבוקס, שיחות ומוקד סופר איטי"). The inbox list, the live floor, the ops
   stats and the calls log each take 9–11 s to build. The last answer is kept
   (in this isolate and in KV); a request gets it at once, and when it is older
   than the route's soft age it is rebuilt behind the response, so the next
   request sees the new one. Only an authorised admin request is served from
   it, and only plain list reads: a single conversation is never cached.
   ============================================================================ */
export const SWR_ROUTES = { '/api/floor': 6, '/api/inbox': 10, '/api/ops-stats': 60, '/api/calls-log': 20 };
export const HARD_MAX_S = 900;
/* how old an answer may be and still be shown while a new one is built: the live floor stays tight, the lists may be from this morning */
export const HARD_BY_ROUTE = { '/api/floor': 900, '/api/inbox': 12 * 3600, '/api/ops-stats': 12 * 3600, '/api/calls-log': 3600 };
/* 26/11 track-speed (Richard: "our dashboards load a few seconds, sometimes a full minute"): the admin OVERVIEW reads
   that rebuilt from scratch on every open (the leads tab and the answers log read the Google sheet each time, the call
   board asks Retell, the money boards list every day ever) answer from the last copy too. Tighter than the list above:
   a copy is rebuilt behind the reply after `soft` seconds and is never shown older than `hard` (≤ 2 minutes), and any
   admin CHANGE (swrBust) drops every overview copy, so a board read right after an action is built fresh.
   Only the plain overview question is cached: `keys` are the only body fields it may carry (page stamp aside). */
export const OVERVIEW = {
  '/api/leads': { soft: 45, hard: 120, keys: [] },
  '/api/call-board': { soft: 30, hard: 120, keys: [] },
  '/api/cost-log': { soft: 60, hard: 120, keys: [] },
  '/api/feedback-list': { soft: 60, hard: 120, keys: [] },
  '/api/referrals': { soft: 60, hard: 120, keys: [] },
  '/api/partner/list': { soft: 60, hard: 120, keys: [] },
  '/api/design-list': { soft: 60, hard: 120, keys: [] },
  '/api/traffic': { soft: 60, hard: 120, keys: ['days'] },
  '/api/campaign-stats': { soft: 60, hard: 120, keys: ['days'] },
  '/api/answers-log': { soft: 45, hard: 120, keys: [] },
  '/api/future-log': { soft: 45, hard: 120, keys: ['days'] },
};
export const BUST_KEY = 'swr:bust';
/* the hook in index.js asks this: is the path served by swrServe at all */
export const swrRouted = p => Object.prototype.hasOwnProperty.call(SWR_ROUTES, p) || Object.prototype.hasOwnProperty.call(OVERVIEW, p);
const mem = new Map(), busy = new Set();
let bustAt = 0;
/* an admin change happened: every overview copy older than now is dropped (this isolate at once, the others through KV) */
export async function swrBust(env, now = Date.now()) {
  bustAt = Math.max(bustAt, now);
  if (env && env.RATE) await env.RATE.put(BUST_KEY, String(now), { expirationTtl: 600 }).catch(() => {});
}
async function bustedAt(env) {
  let t = bustAt;
  if (env && env.RATE) { try { const v = parseInt(await env.RATE.get(BUST_KEY), 10); if (v > t) t = v; } catch {} }
  return t;
}
const stable = v => (v && typeof v === 'object' && !Array.isArray(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v));
/* → the cache key, or '' when this request must not be cached */
export function swrKey(pathname, body) {
  if (!swrRouted(pathname) || !body || typeof body !== 'object' || Array.isArray(body)) return '';
  /* the page's request stamp (guard.js) changes on every load and is not part of the question */
  const { admin_key: _k, session: _s, app: _a, nonce: _n, stamp_ts: _t, sig: _g, ...rest } = body;
  if (pathname === '/api/inbox' && Object.keys(rest).some(k => k !== 'channel')) return '';   /* a conversation, a search, a page: always live */
  const ov = OVERVIEW[pathname];
  if (ov && Object.keys(rest).some(k => !ov.keys.includes(k) || (rest[k] !== null && typeof rest[k] === 'object'))) return '';   /* an event, an action, a search: always live */
  const q = stable(rest); if (q.length > 240) return '';
  return pathname.slice(5) + ':' + q;
}
export async function swrServe({ pathname, body, env, ctx, now = Date.now(), produce }) {
  const key = swrKey(pathname, body); if (!key) return null;
  const ov = OVERVIEW[pathname];
  const soft = (ov ? ov.soft : SWR_ROUTES[pathname]) * 1000, hard = (ov ? ov.hard : (HARD_BY_ROUTE[pathname] || HARD_MAX_S)) * 1000;
  let hit = mem.get(key);
  if (!hit && env.RATE) { try { const v = JSON.parse(await env.RATE.get('swr:' + key) || 'null'); if (v && v.at && typeof v.text === 'string') { hit = v; mem.set(key, v); } } catch {} }
  if (hit && ov && (hit.t0 || hit.at) <= await bustedAt(env)) hit = null;   /* built before the last admin change: build it again first */
  const build = async () => {
    const t0 = Date.now();   /* t0 = when the build STARTED: a change made while it ran makes the copy stale (bust check only) */
    const text = await produce(); if (typeof text !== 'string') return null;
    const v = { at: Date.now(), t0, text }; mem.set(key, v);
    if (env.RATE) await env.RATE.put('swr:' + key, JSON.stringify(v), { expirationTtl: Math.round(hard / 1000) }).catch(() => {});
    return v;
  };
  if (hit && now - hit.at < hard) {
    if (now - hit.at > soft && !busy.has(key)) {
      busy.add(key); const job = build().catch(() => null).then(() => { busy.delete(key); });
      if (ctx && ctx.waitUntil) ctx.waitUntil(job);
    }
    return { text: hit.text, age_ms: now - hit.at, cached: true };
  }
  const v = await build(); return v ? { text: v.text, age_ms: 0, cached: false } : null;
}
export function swrReset() { mem.clear(); busy.clear(); bustAt = 0; }

/* 26/11 the hook both index.js call sites use (the overview logs are routed early, the rest after the audit tap).
   Only a request with a valid admin key is ever served from a copy; a non-read on an overview route drops the copies.
   deps: { isAdmin(env, key), fetchMain(request, env, ctx), cors(origin) } → a Response, or null to fall through. */
export async function swrHook({ request, url, env, ctx, origin, deps }) {
  if (request.method !== 'POST' || !swrRouted(url.pathname) || request.headers.get('x-swr-inner') || String(env.SWR_OFF || '') === '1') return null;
  let sb = null, stext = '';
  try { stext = await request.clone().text(); sb = JSON.parse(stext); } catch { sb = null; }
  if (!sb || typeof sb !== 'object') return null;
  if (!deps.isAdmin(env, sb.admin_key)) return null;
  /* a change through an overview route itself (answers-log 'set', referrals/partner acts…) drops the copies; a read action
     ('live', 'proof', 'plan'…) is not a change — deps.isRead is team-log.js quietRead, the same list the action log uses */
  const act = String(sb.action || sb.act || '');
  if (OVERVIEW[url.pathname] && act && !(deps.isRead && deps.isRead(url.pathname, sb))) { await swrBust(env); return null; }
  const hit = await swrServe({ pathname: url.pathname, body: sb, env, ctx, produce: async () => {
    const r = await deps.fetchMain(new Request(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-swr-inner': '1', ...(origin ? { Origin: origin } : {}) }, body: stext }), env, ctx);
    if (r.status !== 200) return null; const t = await r.text(); return /^\s*\{[\s\S]*"ok"\s*:\s*true/.test(t.slice(0, 400)) ? t : null; } }).catch(() => null);
  if (!hit) return null;
  return new Response(hit.text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'x-ishur-age': String(Math.round(hit.age_ms / 1000)), ...deps.cors(origin) } });
}
