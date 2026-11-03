/* ============================================================================
   ishur.io · shared helpers (extracted from index.js, 20/10/2026)
   ----------------------------------------------------------------------------
   Phones, admin auth, JSON responses + CORS, KV conveniences, hashing.
   Pure utilities with no business logic; everything imports from here.
   ========================================================================== */
export function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}
/* Richard 21/10: guests abroad get WhatsApp (any E.164 number written with
   its country code), Shir dials Israeli mobiles only. */
export function isIlMobile(p) { return /^9725\d{8}$/.test(String(p || '')); }
export function isWaPhone(p) {
  const d = String(p || '');
  if (isIlMobile(d)) return true;
  if (d.startsWith('972')) return false;                 // IL landline / malformed
  return /^[1-9]\d{8,14}$/.test(d);                      // foreign number with country code
}

/* ══ The master switch ═══════════════════════════════════════════════════════
   One key, checked before anything leaves the system. Set it and the whole
   business goes quiet within seconds, without a deploy and without touching
   the sheet. Nothing else in the engine needs to know about it.
   ─────────────────────────────────────────────────────────────────────────── */
export async function sendingPaused(env) {
  if (!env.RATE) return false;
  return !!(await env.RATE.get('paused'));
}

export function okJson(payload, origin) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

/* Retell retries webhooks and fires several events per call — each (call, stage)
   is processed exactly once. */
export async function seenOnce(env, key) {
  if (!env.RATE) return false;
  if (await env.RATE.get(key)) return true;
  await env.RATE.put(key, '1', { expirationTtl: 3 * 86400 });
  return false;
}

/* constant time, so a wrong signature cannot be narrowed down by timing */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Two personal admin keys — Richard's and Shalev's — each revocable alone */
export function isAdmin(env, key) {
  const k = String(key || '');
  if (!k) return false;
  if (env.ADMIN_KEY && safeEqual(k, env.ADMIN_KEY)) return true;
  if (env.ADMIN_KEY2 && safeEqual(k, env.ADMIN_KEY2)) return true;
  return false;
}

/* 10.5: never ring a test number. Patterns: 9725000050xx (our fake range)
   and anything in TEST_PHONES (comma-separated, wrangler var). */
export function isTestPhone(env, phone) {
  const p = normPhone(phone || '');
  if (!p) return true;
  if (/^9725000050\d\d$/.test(p)) return true;
  if (['972500005201', '972500000000', '972578888888'].includes(p)) return true;
  const list = String(env.TEST_PHONES || '').split(',').map(x => normPhone(x.trim())).filter(Boolean);
  return list.includes(p);
}

/* ══ Money & sources board ═══════════════════════════════════════════════════
   Admin-gated: revenue per day (from the events sheet), messaging + call costs
   per day (from KV counters), and lead sources (utm) from the leads sheet.
   ─────────────────────────────────────────────────────────────────────────── */
export async function kvPrefix(env, prefix) {
  const out = {};
  if (!env.RATE || !env.RATE.list) return out;
  let cursor;
  for (let i = 0; i < 10; i++) {
    const page = await env.RATE.list({ prefix, cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    for (const k of page.keys) out[k.name.slice(prefix.length)] = await env.RATE.get(k.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

export const ALLOWED_ORIGINS = [
  'https://ishur.io',
  'https://www.ishur.io',
  /* the mirror. Serving the pages from go.ishur.io was only half the job: the
     browser still refused every API call from them, because this list did not
     know the host. The page loaded and nothing on it worked. */
  'https://go.ishur.io',
  'http://localhost:4180',
];

export function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function deny(status, reason, origin) {
  return new Response(JSON.stringify({ ok: false, error: reason }), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
