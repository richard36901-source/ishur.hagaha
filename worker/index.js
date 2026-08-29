/* ============================================================================
   ishur.io · webhook proxy
   ----------------------------------------------------------------------------
   The three Make URLs stop being public. The browser talks to this Worker, the
   Worker holds the real URLs as secrets and forwards only what passes.

   What it enforces, in order, before a request costs a Make operation:
     1. origin must be one we published from
     2. the request must carry a valid stamp from assets/guard.js
     3. the stamp must be recent
     4. the IP must not have exceeded its budget for that route

   Deploy:
     cd worker
     npx wrangler secret put HOOK_LEADS
     npx wrangler secret put HOOK_EVENTS
     npx wrangler secret put HOOK_STATUS
     npx wrangler secret put APP_KEY
     npx wrangler deploy

   Then set USE_PROXY to true and PROXY_BASE to the deployed URL in config.js.
   ========================================================================== */

const ROUTES = {
  '/api/lead':   { secret: 'HOOK_LEADS',  limit: 12,  window: 3600 },
  '/api/event':  { secret: 'HOOK_EVENTS', limit: 20,  window: 3600 },
  '/api/status': { secret: 'HOOK_STATUS', limit: 120, window: 3600 },
};

/* ══ Grow payments ═══════════════════════════════════════════════════════════
   Grow's notify URL points here (with ?k=<GROW_KEY>), not at Make directly.
   This route does the fragile part in code: dedupe by receipt ref, mint the
   event token, remember ref→token so thanks.html can claim it, then forward a
   clean flat payload to the Make writer scenario.
   ─────────────────────────────────────────────────────────────────────────── */

function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}

async function handleGrowIpn(request, env, url) {
  if ((url.searchParams.get('k') || '') !== env.GROW_KEY) {
    return new Response('forbidden', { status: 403 });
  }

  /* Grow may send JSON or form-encoded; read both */
  let p = {};
  const type = request.headers.get('Content-Type') || '';
  try {
    if (type.includes('json')) p = await request.json();
    else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) p[k] = v;
      /* some gateways nest under data */
      if (p.data && typeof p.data === 'string') {
        try { Object.assign(p, JSON.parse(p.data)); } catch {}
      }
    }
  } catch { return new Response('bad-body', { status: 400 }); }

  const flat = { ...(typeof p.data === 'object' ? p.data : {}), ...p };
  const ref = String(
    flat.asmachta || flat.transactionId || flat.transactionToken ||
    flat.paymentId || flat.processToken || flat.processId || ''
  ).trim();
  const phone = normPhone(flat.payerPhone || flat.phone || flat.customerPhone || flat.cell);
  const sum = String(flat.sum || flat.amount || flat.paymentSum || flat.price || '').trim();
  const name = String(flat.fullName || flat.payerName ||
    [flat.firstName, flat.lastName].filter(Boolean).join(' ')).trim();
  const email = String(flat.payerEmail || flat.email || '').trim();

  if (!ref || !phone) {
    /* still forward so nothing is lost, marked for manual attention */
    if (env.HOOK_GROW) {
      await fetch(env.HOOK_GROW, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem: 'missing-ref-or-phone', raw: flat }),
      }).catch(() => {});
    }
    return new Response('accepted-incomplete', { status: 200 });
  }

  /* dedupe: one event per receipt, forever */
  const seen = env.RATE ? await env.RATE.get('grow:' + ref) : null;
  if (seen) return new Response('duplicate', { status: 200 });

  const token = crypto.randomUUID();
  const isNewClient = env.RATE ? !(await env.RATE.get('client:' + phone)) : true;

  if (env.RATE) {
    /* ref→token lives 30 days so the thank-you page can claim it */
    await env.RATE.put('grow:' + ref, token, { expirationTtl: 30 * 86400 });
    await env.RATE.put('client:' + phone, '1', { expirationTtl: 730 * 86400 });
  }

  const clean = {
    kind: 'payment', ref, token, phone, sum, name, email,
    clientId: 'C-' + phone.slice(-9),
    isNewClient: isNewClient ? 'yes' : 'no',
    paidAt: new Date().toISOString(),
  };

  let ok = false;
  if (env.HOOK_GROW) {
    const r = await fetch(env.HOOK_GROW, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean),
    }).catch(() => null);
    ok = !!r && r.status === 200;
  }
  /* if the writer failed, forget the dedupe key so Grow's retry works */
  if (!ok && env.RATE) await env.RATE.delete('grow:' + ref);
  return new Response(ok ? 'ok' : 'writer-failed', { status: ok ? 200 : 502 });
}

/* thanks.html asks: "payment ref X just paid — where do I go?" Only the payer
   holds the ref, so returning the tokenized link to it is safe. */
async function handleClaim(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  const stampError = await checkStamp(body, env.APP_KEY);
  if (stampError) return deny(403, stampError, origin);
  const ref = String(body.ref || '').trim();
  if (!ref || !env.RATE) return deny(404, 'not-found', origin);
  const token = await env.RATE.get('grow:' + ref);
  if (!token) {
    return new Response(JSON.stringify({ ok: false, pending: true }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) },
    });
  }
  return new Response(JSON.stringify({ ok: true, token }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

const ALLOWED_ORIGINS = [
  'https://ishur.io',
  'https://www.ishur.io',
  'http://localhost:4180',
];

const MAX_STAMP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;   // the upload cap plus headroom

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function deny(status, reason, origin) {
  return new Response(JSON.stringify({ ok: false, error: reason }), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* constant time, so a wrong signature cannot be narrowed down by timing */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function checkStamp(fields, appKey) {
  const { app, nonce, stamp_ts, sig } = fields;
  if (!app || !nonce || !stamp_ts || !sig) return 'missing-stamp';
  const age = Date.now() - Number(stamp_ts);
  if (!Number.isFinite(age) || age < -60000 || age > MAX_STAMP_AGE_MS) return 'stale-stamp';
  const expected = await sha256Hex(`${appKey}|${nonce}|${stamp_ts}`);
  return safeEqual(expected, String(sig)) ? null : 'bad-stamp';
}

/* Per IP, per route. KV when it is bound, otherwise an in-process map that
   still blunts a burst from one machine. */
async function overBudget(env, key, limit, windowSec) {
  if (!env.RATE) {
    globalThis.__mem = globalThis.__mem || new Map();
    const now = Date.now();
    const hits = (globalThis.__mem.get(key) || []).filter(t => now - t < windowSec * 1000);
    if (hits.length >= limit) return true;
    hits.push(now);
    globalThis.__mem.set(key, hits);
    return false;
  }
  const current = Number(await env.RATE.get(key)) || 0;
  if (current >= limit) return true;
  await env.RATE.put(key, String(current + 1), { expirationTtl: windowSec });
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const route = ROUTES[url.pathname];

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (url.pathname === '/api/grow-ipn' && request.method === 'POST') {
      return handleGrowIpn(request, env, url);
    }
    if (url.pathname === '/api/claim' && request.method === 'POST') {
      return handleClaim(request, env, origin);
    }
    if (!route) return deny(404, 'unknown-route', origin);
    if (request.method !== 'POST') return deny(405, 'method', origin);
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return deny(403, 'origin', origin);

    const target = env[route.secret];
    const appKey = env.APP_KEY;
    if (!target || !appKey) return deny(500, 'not-configured', origin);

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) return deny(413, 'too-large', origin);

    const type = request.headers.get('Content-Type') || '';
    let stampFields = {};
    let forwardBody;

    /* The body is read once and rebuilt, because a stream cannot be both
       inspected and forwarded. */
    if (type.includes('multipart/form-data')) {
      const form = await request.formData();
      ['app', 'nonce', 'stamp_ts', 'sig'].forEach(k => { stampFields[k] = form.get(k); });
      forwardBody = form;
    } else {
      const text = await request.text();
      try { stampFields = JSON.parse(text); } catch { return deny(400, 'bad-json', origin); }
      forwardBody = text;
    }

    const stampError = await checkStamp(stampFields, appKey);
    if (stampError) return deny(403, stampError, origin);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const bucket = `${url.pathname}:${ip}`;
    if (await overBudget(env, bucket, route.limit, route.window)) {
      return deny(429, 'rate-limited', origin);
    }

    const headers = new Headers();
    if (!type.includes('multipart/form-data')) headers.set('Content-Type', 'application/json');
    /* Make sees where the request really came from, not the Worker */
    headers.set('X-Forwarded-For', ip);
    headers.set('X-Ishur-Country', request.headers.get('CF-IPCountry') || '');

    let upstream;
    try {
      upstream = await fetch(target, { method: 'POST', headers, body: forwardBody });
    } catch (e) {
      return deny(502, 'upstream-unreachable', origin);
    }

    /* status has to answer, the other two only need their code passed back */
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'text/plain',
        ...cors(origin),
      },
    });
  },
};
