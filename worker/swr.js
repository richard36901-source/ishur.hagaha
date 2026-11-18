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
const mem = new Map(), busy = new Set();
const stable = v => (v && typeof v === 'object' && !Array.isArray(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v));
/* → the cache key, or '' when this request must not be cached */
export function swrKey(pathname, body) {
  if (!(pathname in SWR_ROUTES) || !body || typeof body !== 'object' || Array.isArray(body)) return '';
  /* the page's request stamp (guard.js) changes on every load and is not part of the question */
  const { admin_key: _k, session: _s, app: _a, nonce: _n, stamp_ts: _t, sig: _g, ...rest } = body;
  if (pathname === '/api/inbox' && Object.keys(rest).some(k => k !== 'channel')) return '';   /* a conversation, a search, a page: always live */
  const q = stable(rest); if (q.length > 240) return '';
  return pathname.slice(5) + ':' + q;
}
export async function swrServe({ pathname, body, env, ctx, now = Date.now(), produce }) {
  const key = swrKey(pathname, body); if (!key) return null;
  const soft = SWR_ROUTES[pathname] * 1000, hard = (HARD_BY_ROUTE[pathname] || HARD_MAX_S) * 1000;
  let hit = mem.get(key);
  if (!hit && env.RATE) { try { const v = JSON.parse(await env.RATE.get('swr:' + key) || 'null'); if (v && v.at && typeof v.text === 'string') { hit = v; mem.set(key, v); } } catch {} }
  const build = async () => {
    const text = await produce(); if (typeof text !== 'string') return null;
    const v = { at: Date.now(), text }; mem.set(key, v);
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
export function swrReset() { mem.clear(); busy.clear(); }
