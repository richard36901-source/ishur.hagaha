/* ============================================================================
   ishur.io · back-office login, users, page permissions and the action log (16/11/2026)
   ----------------------------------------------------------------------------
   OFF BY DEFAULT. Nothing here is enforced until KV `cfg:auth_enforce` = 'on'.
   While it is off, a request that carries no user session passes through authGate()
   as the very same Request object, with no KV read and no KV write: the shared
   admin key works exactly as before.

   What exists:
     · Google sign-in: the browser gets an ID token from Google Identity Services and posts
       it here; the signature is checked against Google's public keys (no client secret).
     · Users in KV   user:<email>  = {email, name, role, pages, layers, active, created_at, last_login}
     · Sessions      usess:<hex>   = {email, at}   30 days. The browser holds `us.<64 hex>`.
     · Action log    act:<ILday>:<ts>:<rand>  metadata {u, a, p}   (180 days)
     · authGate()    the ONE enforcement point, called from the Worker's outer fetch().

   How a session reaches the 100+ existing admin checks without touching them: the same
   trick resolveAdminSession() in index.js uses for `sess.` tokens. A valid user session
   is swapped for the real admin key (header and JSON body) before any handler runs.
   isAdmin() itself is not changed.

   STILL OPEN (see authGate): page permissions are not enforced per API route; keys in a
   query string (?k= / ?key=) are not covered; "browser" is recognised by headers only.
   ========================================================================== */
import { okJson, deny, cors } from './lib.js';

export const PAGES = [
  { id: 'data', label: 'נתונים' },
  { id: 'money', label: 'כספים' },
  { id: 'sales', label: 'מכירות' },
  { id: 'clients', label: 'לקוחות' },
  { id: 'sends', label: 'שליחות ושיחות' },
  { id: 'journal', label: 'יומן' },
  { id: 'control', label: 'שליטה' },
  { id: 'system', label: 'מערכת' },
];
export const LAYERS = [
  { id: 'sends', label: 'שליחות' },
  { id: 'money', label: 'עלויות ורווח' },
  { id: 'hostesses', label: 'דיילות' },
];
const PAGE_IDS = PAGES.map(p => p.id);
const LAYER_IDS = LAYERS.map(l => l.id);
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86400 * 1000;
const ACTION_DAYS = 180;
const TOK_RE = /^us\.[0-9a-f]{64}$/;
const GOOGLE_ISS = ['accounts.google.com', 'https://accounts.google.com'];
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const SEED_USERS = [
  { email: 'richardtomskiy@gmail.com', name: 'Richard', role: 'owner', pages: 'all', layers: 'all' },
  { email: 'shalevdrix3@gmail.com', name: 'Shalev', role: 'staff', pages: 'all', layers: 'all' },
];

/* ── pure ─────────────────────────────────────────────────────────────────── */
export function normEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(e) && e.length <= 120 ? e : '';
}
export function isSessionToken(v) { return TOK_RE.test(String(v || '')); }

function b64urlBytes(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some(p => !p)) return null;
  try {
    const dec = new TextDecoder();
    return { header: JSON.parse(dec.decode(b64urlBytes(parts[0]))), payload: JSON.parse(dec.decode(b64urlBytes(parts[1]))),
      signed: new TextEncoder().encode(parts[0] + '.' + parts[1]), sig: b64urlBytes(parts[2]) };
  } catch { return null; }
}
/* '' when the claims are acceptable, otherwise the reason */
export function claimsError(p, { clientId, now = Date.now() } = {}) {
  if (!p || typeof p !== 'object') return 'bad-token';
  if (!GOOGLE_ISS.includes(p.iss)) return 'bad-issuer';
  if (!clientId || p.aud !== clientId) return 'bad-audience';
  if (!(Number(p.exp) * 1000 > now)) return 'expired';
  if (p.email_verified !== true && p.email_verified !== 'true') return 'email-not-verified';
  if (!normEmail(p.email)) return 'no-email';
  return '';
}
/* → {ok:true, email, name} or {ok:false, error}. `keys` = the JWKS key list. RS256 only. */
export async function verifyGoogleJwt(token, { clientId, keys, now = Date.now() } = {}) {
  const j = parseJwt(token);
  if (!j) return { ok: false, error: 'bad-token' };
  if (j.header.alg !== 'RS256') return { ok: false, error: 'bad-alg' };
  const jwk = (Array.isArray(keys) ? keys : []).find(k => k && k.kid === j.header.kid && k.kty === 'RSA');
  if (!jwk) return { ok: false, error: 'unknown-key' };
  let good = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, j.sig, j.signed);
  } catch { good = false; }
  if (!good) return { ok: false, error: 'bad-signature' };
  const err = claimsError(j.payload, { clientId, now });
  if (err) return { ok: false, error: err };
  return { ok: true, email: normEmail(j.payload.email), name: String(j.payload.name || '').slice(0, 80) };
}

const listOf = (v, ids) => (v === 'all' ? 'all' : [...new Set((Array.isArray(v) ? v : []).map(String).filter(x => ids.includes(x)))]);
export function canSee(user, pageId) {
  if (!user || user.active === false || !PAGE_IDS.includes(pageId)) return false;
  if (user.role === 'owner' || user.pages === 'all') return true;
  return Array.isArray(user.pages) && user.pages.includes(pageId);
}
export function canLayer(user, layerId) {
  if (!user || user.active === false || !LAYER_IDS.includes(layerId)) return false;
  if (user.role === 'owner' || user.layers === 'all') return true;
  return Array.isArray(user.layers) && user.layers.includes(layerId);
}
export const allowedPages = user => PAGE_IDS.filter(id => canSee(user, id));
export const allowedLayers = user => LAYER_IDS.filter(id => canLayer(user, id));

/* The rules of a user change. actor = who asks, patch = what they sent, existing = the stored
   record (or null), all = every stored user. → {ok:true, user} (the record to store) or {ok:false, error}. */
export function planUserChange(actor, patch, existing, all = [], now = Date.now()) {
  if (!actor || actor.active === false || actor.role !== 'owner') return { ok: false, error: 'owner-only' };
  const email = normEmail(patch && patch.email);
  if (!email) return { ok: false, error: 'bad-email' };
  const p = patch || {};
  const next = {
    email,
    name: String(p.name !== undefined ? p.name : (existing && existing.name) || '').replace(/[<>]/g, '').slice(0, 80),
    role: p.role !== undefined ? (p.role === 'owner' ? 'owner' : 'staff') : (existing && existing.role) || 'staff',
    pages: p.pages !== undefined ? listOf(p.pages, PAGE_IDS) : existing ? existing.pages : [],
    layers: p.layers !== undefined ? listOf(p.layers, LAYER_IDS) : existing ? existing.layers : [],
    active: p.active !== undefined ? p.active !== false : existing ? existing.active !== false : true,
    created_at: (existing && existing.created_at) || new Date(now).toISOString(),
    last_login: (existing && existing.last_login) || null,
  };
  const wasOwner = existing && existing.role === 'owner' && existing.active !== false;
  const staysOwner = next.role === 'owner' && next.active;
  if (wasOwner && !staysOwner && !all.some(u => u && u.email !== email && u.role === 'owner' && u.active !== false)) return { ok: false, error: 'last-owner' };
  return { ok: true, user: next };
}
export const publicUser = u => (u ? { email: u.email, name: u.name || '', role: u.role, pages: u.pages, layers: u.layers, active: u.active !== false, created_at: u.created_at || null, last_login: u.last_login || null } : null);

export function ilDay(ts = Date.now()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts)); }
const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export function looksLikeBrowser(request) {
  const h = request.headers;
  return !!(h.get('Origin') || h.get('Sec-Fetch-Site') || h.get('Sec-Fetch-Mode'));
}
export function actionName(pathname, body) {
  const a = body && typeof body === 'object' && (body.action || body.act);
  return (String(pathname || '').replace(/^\/api\//, '') + (a ? ' · ' + String(a) : '')).slice(0, 120);
}

/* ── KV ───────────────────────────────────────────────────────────────────── */
async function kvJson(env, k) { try { return JSON.parse(await env.RATE.get(k)) || null; } catch { return null; } }
export async function getUser(env, email) { const e = normEmail(email); return e && env.RATE ? kvJson(env, 'user:' + e) : null; }
async function putUser(env, u) { await env.RATE.put('user:' + u.email, JSON.stringify(u)); }
export async function listUsers(env) {
  const out = [];
  if (!env.RATE || !env.RATE.list) return out;
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page = await env.RATE.list({ prefix: 'user:', cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    for (const k of page.keys) { const u = await kvJson(env, k.name); if (u && u.email) out.push(u); }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}
/* The two first users, written once and only when the store holds no user at all. A marker key
   decides "already done" (a KV list lags its own writes); an existing record is never overwritten. */
export async function ensureSeed(env, now = Date.now()) {
  if (!env.RATE) return false;
  if (await env.RATE.get('auth:seeded').catch(() => '1')) return false;
  const page = env.RATE.list ? await env.RATE.list({ prefix: 'user:', limit: 1 }).catch(() => null) : null;
  let wrote = false;
  if (!page || !page.keys.length) {
    for (const s of SEED_USERS) {
      if (await env.RATE.get('user:' + s.email).catch(() => null)) continue;
      await putUser(env, { ...s, active: true, created_at: new Date(now).toISOString(), last_login: null });
      wrote = true;
    }
  }
  await env.RATE.put('auth:seeded', new Date(now).toISOString());
  return wrote;
}

export async function createSession(env, email, now = Date.now()) {
  const id = randHex(32);
  await env.RATE.put('usess:' + id, JSON.stringify({ email, at: new Date(now).toISOString() }), { expirationTtl: SESSION_DAYS * 86400 });
  return 'us.' + id;
}
/* → the user behind the token, or null. The user record is re-read every time, so
   switching a user off ends every session of theirs at once. */
export async function readSession(env, token, now = Date.now()) {
  const tok = String(token || '');
  if (!TOK_RE.test(tok) || !env.RATE) return null;
  const rec = await kvJson(env, 'usess:' + tok.slice(3));
  if (!rec || !rec.email) return null;
  const at = Date.parse(rec.at || '');
  if (!Number.isFinite(at) || now - at >= SESSION_MS) return null;
  const user = await getUser(env, rec.email);
  return user && user.active !== false ? user : null;
}
export async function destroySession(env, token) {
  const tok = String(token || '');
  if (TOK_RE.test(tok) && env.RATE) await env.RATE.delete('usess:' + tok.slice(3)).catch(() => {});
}

export async function logAction(env, { u, a, p }, now = Date.now()) {
  if (!env.RATE || !u) return '';
  const key = 'act:' + ilDay(now) + ':' + now + ':' + randHex(4);
  await env.RATE.put(key, '1', { expirationTtl: ACTION_DAYS * 86400, metadata: { u: String(u).slice(0, 120), a: String(a || '').slice(0, 120), p: String(p || '').slice(0, 120) } });
  return key;
}
/* the last `days` Israel days, newest first; `user` narrows it to one email */
export async function queryActions(env, { days = 7, user = '', limit = 500, now = Date.now() } = {}) {
  const out = [];
  if (!env.RATE || !env.RATE.list) return out;
  const n = Math.max(1, Math.min(90, Number(days) || 7)), who = normEmail(user), max = Math.max(1, Math.min(2000, Number(limit) || 500));
  for (let i = 0; i < n; i++) {
    const day = ilDay(now - i * 86400000);
    let cursor;
    for (let pg = 0; pg < 5; pg++) {
      const page = await env.RATE.list({ prefix: 'act:' + day + ':', cursor, limit: 1000 }).catch(() => null);
      if (!page) break;
      for (const k of page.keys) {
        const m = k.metadata || {};
        if (who && m.u !== who) continue;
        out.push({ ts: Number(k.name.split(':')[2]) || 0, day, u: m.u || '', a: m.a || '', p: m.p || '' });
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  }
  out.sort((x, y) => y.ts - x.ts);
  return out.slice(0, max);
}

export async function getJwks(env, { fetchFn = fetch, force = false, now = Date.now() } = {}) {
  /* force = a token named a key we do not hold. Google rotates keys, so look again, but not more
     than once a minute: a stranger posting junk tokens must not turn every call into a fetch. */
  if (env.RATE) {
    const hit = await kvJson(env, 'auth:jwks');
    if (hit && Array.isArray(hit.keys) && now - hit.at < (force ? 60 : 3600) * 1000) return hit.keys;
  }
  const r = await fetchFn(JWKS_URL);
  const j = await r.json();
  const keys = Array.isArray(j && j.keys) ? j.keys : [];
  if (keys.length && env.RATE) await env.RATE.put('auth:jwks', JSON.stringify({ at: now, keys }), { expirationTtl: 3600 }).catch(() => {});
  return keys;
}
export async function enforceOn(env) {
  if (!env.RATE) return false;
  /* 'on' = required now; an ISO time (2026-11-16T18:00:00Z) = required from that moment, so the switch does not wait for
     anybody to be awake to flip it; anything else = off */
  try { const v = String((await env.RATE.get('cfg:auth_enforce')) || '').trim(); if (v === 'on') return true; const t = /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN; return Number.isFinite(t) && Date.now() >= t; } catch { return false; }
}

/* ══ authGate — THE enforcement point ════════════════════════════════════════
   Called once, from the Worker's outer fetch(), before anything else. Cron jobs and the
   Worker's own internal calls enter through fetchMain and never pass here.
   → {request}  (possibly rewritten)  or  {response}  (a refusal).

     1. The request carries a user session (`x-ishur-session` header, body `session`, or a
        `us.…` token in the admin-key slot) and it is valid → the real admin key is put
        in its place, the session field is removed, and a state-changing POST is written
        to the action log under the user's email.
     2. No valid session, and the request presents no admin key at all → untouched.
     3. No valid session, an admin key is presented:
          switch off (default)            → untouched, as before
          switch on, not a browser        → untouched (automation, curl, Make keep working)
          switch on, a browser            → 401 login-required

   OPEN, to close before the switch is turned on:
     · the existing pages do not send the session yet (adminbar.js / the pages' own fetch)
     · page permissions are advisory: any valid session gets the whole admin API
     · a key in a query string (?k= / ?key=, the recording players) is not looked at
     · "browser" = an Origin or Sec-Fetch header. A person who knows the shared key can
       still use it from a script; the key has to be rotated to really retire it
     · the older phone-code sessions (`sess.…`) count as "a shared key" under the switch
     · any error inside the gate lets the request through unchanged (fail-open)          */
export async function authGate(request, env, ctx, d = {}) {
  try { return await gate(request, env, ctx, d); } catch { return { request }; }
}
async function gate(request, env, ctx, d) {
  if (request.method === 'OPTIONS') return { request };
  const url = new URL(request.url), path = url.pathname;
  if (path.startsWith('/api/auth/') || path.startsWith('/api/grow-ipn')) return { request };
  /* /api/ops/ and /api/crm/ also take the key as `Authorization: Bearer …` */
  const bearer = path.startsWith('/api/ops/') || path.startsWith('/api/crm/') ? String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') : '';
  const hdrSess = request.headers.get('x-ishur-session') || '', hdrKey = request.headers.get('x-admin-key') || bearer;
  let text = null, body = null;
  if (request.method === 'POST' && String(request.headers.get('Content-Type') || '').includes('application/json') &&
      Number(request.headers.get('Content-Length') || 0) <= 262144) {
    try { text = await request.clone().text(); } catch { text = null; }
    if (text && (hdrSess || isSessionToken(hdrKey) || text.includes('"admin_key"') || text.includes('"session"'))) {
      try { const j = JSON.parse(text); if (j && typeof j === 'object' && !Array.isArray(j)) body = j; } catch { body = null; }
    }
  }
  const token = [hdrSess, body && body.session, body && body.admin_key, hdrKey].map(v => (typeof v === 'string' ? v : '')).find(isSessionToken) || '';
  const user = token && env.ADMIN_KEY ? await readSession(env, token) : null;
  if (user) {
    const headers = new Headers(request.headers);
    headers.delete('x-ishur-session');
    if (bearer) headers.delete('Authorization');
    headers.set('x-admin-key', env.ADMIN_KEY);
    let init = { headers };
    if (body) {
      const nb = { ...body, admin_key: env.ADMIN_KEY };
      if (isSessionToken(nb.session)) delete nb.session;
      const s = JSON.stringify(nb);
      headers.delete('Content-Length');
      init = { headers, body: s };
    }
    const isRead = path === '/api/admin/home' || (typeof d.isRead === 'function' && d.isRead(path, 'POST', body || {}));
    if (request.method === 'POST' && !isRead) {
      const job = logAction(env, { u: user.email, a: actionName(path, body), p: path }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
    return { request: new Request(request, init), user };
  }
  const presented = hdrKey || (body && typeof body.admin_key === 'string' && body.admin_key) || '';
  if (!presented || !looksLikeBrowser(request)) return { request };
  if (!(await enforceOn(env))) return { request };
  const origin = request.headers.get('Origin') || '';
  return { response: new Response(JSON.stringify({ ok: false, error: 'login-required', login: '/next/login.html' }), { status: 401, headers: { 'Content-Type': 'application/json', ...cors(origin) } }) };
}

/* ══ /api/auth/* ═════════════════════════════════════════════════════════════ */
export async function handleAuth(request, env, origin, url, d = {}) {
  const path = url.pathname.slice('/api/auth/'.length);
  if (!env.RATE) return deny(503, 'no-store', origin);
  const clientId = String((await env.RATE.get('cfg:google_client_id').catch(() => '')) || '').trim();
  if (path === 'config') return okJson({ ok: true, configured: !!clientId, client_id: clientId, enforce: await enforceOn(env) }, origin);
  if (request.method !== 'POST') return deny(405, 'post-only', origin);
  let b = {}; try { b = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!b || typeof b !== 'object') return deny(400, 'bad-json', origin);

  if (path === 'google') {
    if (!clientId) return deny(503, 'not-configured', origin);
    const cred = String(b.credential || '');
    if (!cred || cred.length > 4096) return deny(400, 'bad-token', origin);
    const fetchFn = d.fetch || fetch;
    let v = await verifyGoogleJwt(cred, { clientId, keys: await getJwks(env, { fetchFn }).catch(() => []) });
    if (!v.ok && v.error === 'unknown-key') v = await verifyGoogleJwt(cred, { clientId, keys: await getJwks(env, { fetchFn, force: true }).catch(() => []) });
    if (!v.ok) return deny(401, v.error, origin);
    await ensureSeed(env);
    const user = await getUser(env, v.email);
    if (!user || user.active === false) return deny(403, 'not-allowed', origin);
    user.last_login = new Date().toISOString();
    if (!user.name && v.name) user.name = v.name.replace(/[<>]/g, '');
    await putUser(env, user);
    const session = await createSession(env, user.email);
    await logAction(env, { u: user.email, a: 'login', p: url.pathname }).catch(() => {});
    return okJson({ ok: true, session, user: publicUser(user), pages: allowedPages(user), layers: allowedLayers(user) }, origin);
  }

  const token = request.headers.get('x-ishur-session') || (typeof b.session === 'string' ? b.session : '');
  if (path === 'logout') { await destroySession(env, token); return okJson({ ok: true }, origin); }
  const me = await readSession(env, token);
  if (!me) return deny(401, 'no-session', origin);
  if (path === 'me') return okJson({ ok: true, user: publicUser(me), pages: allowedPages(me), layers: allowedLayers(me), all_pages: PAGES, all_layers: LAYERS, enforce: await enforceOn(env) }, origin);

  if (path === 'users') {
    if (me.role !== 'owner') return deny(403, 'owner-only', origin);
    const action = String(b.action || 'list');
    let all = await listUsers(env);
    if (action === 'upsert' || action === 'deactivate') {
      const patch = action === 'deactivate' ? { email: b.user && b.user.email || b.email, active: false } : (b.user || {});
      const email = normEmail(patch.email);
      const existing = email ? (all.find(u => u.email === email) || await getUser(env, email)) : null;
      if (action === 'deactivate' && !existing) return deny(404, 'no-user', origin);
      const plan = planUserChange(me, patch, existing, all);
      if (!plan.ok) return deny(plan.error === 'owner-only' ? 403 : 400, plan.error, origin);
      await putUser(env, plan.user);
      await logAction(env, { u: me.email, a: 'auth/users · ' + action + ' · ' + plan.user.email, p: url.pathname }).catch(() => {});
      all = [...all.filter(u => u.email !== plan.user.email), plan.user];
    } else if (action !== 'list') return deny(400, 'bad-action', origin);
    all.sort((x, y) => (x.role === y.role ? x.email.localeCompare(y.email) : x.role === 'owner' ? -1 : 1));
    return okJson({ ok: true, users: all.map(publicUser), all_pages: PAGES, all_layers: LAYERS }, origin);
  }
  if (path === 'actions') {
    if (me.role !== 'owner') return deny(403, 'owner-only', origin);
    return okJson({ ok: true, actions: await queryActions(env, { days: b.days, user: b.user, limit: b.limit }) }, origin);
  }
  return deny(404, 'no-route', origin);
}
