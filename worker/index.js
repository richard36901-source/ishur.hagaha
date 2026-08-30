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

import { parseGuestFile, guestsFromRows } from './parse.js';
import { buildDashboard, buildCallQueue, callOutcome, buildBizStats } from './dashboard.js';
import { callWindowState, buildCallPayload, retellToCallResult, verifyRetellSignature, ilDate, shouldDial } from './shir.js';

const ROUTES = {
  '/api/lead':   { secret: 'HOOK_LEADS',  limit: 12,  window: 3600 },
  '/api/event':  { secret: 'HOOK_EVENTS', limit: 20,  window: 3600 },
  '/api/status': { secret: 'HOOK_STATUS', limit: 120, window: 3600 },
};

const MAX_GUESTS      = 2000;
const MAX_FILE_BYTES  = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TOKEN_TTL       = 400 * 86400;   // covers events booked far ahead

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
    /* token→who: the upload page presents a token, this is how it is trusted */
    await env.RATE.put('token:' + token, JSON.stringify({
      phone, ref, name, clientId: 'C-' + phone.slice(-9),
    }), { expirationTtl: TOKEN_TTL });
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

/* ══ event uploads ═══════════════════════════════════════════════════════════
   /api/event does the heavy lifting in code instead of in Make:
     · guest file  → parsed + validated here, Make receives ready-made rows
     · invitation image → stored in KV, served back publicly at /img/<token>
   Make stays a plain writer with nothing fragile inside it.
   ─────────────────────────────────────────────────────────────────────────── */

async function tokenRecord(env, token) {
  if (!env.RATE || !token || !/^[0-9a-f-]{36}$/.test(token)) return null;
  const raw = await env.RATE.get('token:' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sniffImage(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function okJson(payload, origin) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

async function handleEventForm(form, rec, token, env, origin, target, url) {
  const file = form.get('file');
  if (file && typeof file === 'object' && file.arrayBuffer) {
    /* one guest list per event; replacements go through support on purpose */
    if (await env.RATE.get('uploaded:' + token)) return deny(409, 'already-uploaded', origin);
    if (file.size > MAX_FILE_BYTES) return deny(413, 'file-too-large', origin);
    if (!/\.(csv|xlsx|xls)$/i.test(file.name || '')) return deny(422, 'bad-file-type', origin);

    let rows;
    try { rows = parseGuestFile(file.name, await file.arrayBuffer()); }
    catch { return deny(422, 'unreadable-file', origin); }
    const { guests, skipped } = guestsFromRows(rows);
    if (!guests.length) return deny(422, 'no-valid-guests', origin);
    if (guests.length > MAX_GUESTS) return deny(422, 'too-many-guests', origin);

    /* rows in the exact shape of the אורחים sheet, A through AC */
    const now = new Date().toISOString();
    const values = guests.map((g, i) => {
      const row = new Array(29).fill('');
      row[0] = rec.clientId;                        // מזהה לקוח
      row[1] = rec.name || '';                      // שם לקוח
      row[2] = 'G-' + token.slice(0, 8) + '-' + (i + 1); // מזהה אורח
      row[3] = g.name;                              // שם אורח
      row[4] = g.phone;                             // טלפון אורח
      row[5] = g.party;                             // כמה הוזמנו
      row[24] = 'הועלה מקובץ: ' + file.name;        // הערות מערכת
      row[25] = now;                                // זמן שינוי אחרון
      row[28] = token;                              // מזהה אירוע
      return row;
    });

    const r = await fetch(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'guests_file', token,
        file_name: file.name,
        guest_count: guests.length,
        skipped_count: skipped.length,
        append_body: JSON.stringify({ values }),
      }),
    }).catch(() => null);
    if (!r || r.status !== 200) return deny(502, 'writer-failed', origin);

    await env.RATE.put('uploaded:' + token, now, { expirationTtl: TOKEN_TTL });
    return okJson({ ok: true, guests: guests.length, skipped: skipped.length }, origin);
  }

  /* setup step — text fields, plus the invitation image when one was chosen */
  const out = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;

  const image = form.get('image');
  if (image && typeof image === 'object' && image.arrayBuffer) {
    if (image.size > MAX_IMAGE_BYTES) return deny(413, 'image-too-large', origin);
    const buf = await image.arrayBuffer();
    const mime = sniffImage(new Uint8Array(buf.slice(0, 16)));
    if (!mime) return deny(422, 'bad-image', origin);
    await env.RATE.put('img:' + token, buf, { expirationTtl: TOKEN_TTL, metadata: { mime } });
    out.image_url = 'https://' + url.hostname + '/img/' + token;
  }

  const r = await fetch(target, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(out),
  }).catch(() => null);
  if (!r || r.status !== 200) return deny(502, 'writer-failed', origin);
  return okJson({ ok: true, image: !!out.image_url }, origin);
}

/* ══ שיר — the AI caller ═════════════════════════════════════════════════════
   Dormant until the secrets exist (RETELL_KEY, SHIR_FROM). The webhook feeds
   Retell's mid-call tool and end-of-call reports into the same call_result
   contract the calls page uses; dispatch places the day's calls.
   ─────────────────────────────────────────────────────────────────────────── */

async function writeCallResult(env, guestId, result, partySize) {
  const r = await fetch(env.HOOK_EVENTS, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'call_result', guest_id: guestId,
      rsvp: result.rsvp || '__keep__', call_status: result.call_status,
      answer: result.answer, tries: String(result.tries),
      party: partySize != null && partySize !== '' ? String(partySize) : '__keep__',
      ts: new Date().toISOString(),
    }),
  }).catch(() => null);
  return !!r && r.status === 200;
}

async function trackCallCost(env, cents) {
  if (!env.RATE || !cents) return;
  const key = 'shircost:' + ilDate();
  const cur = Number(await env.RATE.get(key)) || 0;
  await env.RATE.put(key, String(cur + cents), { expirationTtl: 400 * 86400 });
}

/* Retell retries webhooks and fires several events per call — each (call, stage)
   is processed exactly once. */
async function seenOnce(env, key) {
  if (!env.RATE) return false;
  if (await env.RATE.get(key)) return true;
  await env.RATE.put(key, '1', { expirationTtl: 3 * 86400 });
  return false;
}

const okJsonPlain = payload => new Response(JSON.stringify(payload), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

async function handleShirWebhook(request, env) {
  if (!env.RETELL_KEY) return new Response('not-configured', { status: 503 });
  if (Number(request.headers.get('Content-Length') || 0) > 262144) {
    return new Response('too-large', { status: 413 });
  }
  const rawBody = await request.text();
  const sig = request.headers.get('X-Retell-Signature') || '';
  if (!(await verifyRetellSignature(rawBody, sig, env.RETELL_KEY))) {
    return new Response('bad-signature', { status: 403 });
  }
  let body;
  try { body = JSON.parse(rawBody); } catch { return new Response('bad-json', { status: 400 }); }

  const action = retellToCallResult(body);
  if (!action) return okJsonPlain({ ok: true });

  if (action.kind === 'tool') {
    if (action.call_id && await seenOnce(env, 'shirdone:tool:' + action.call_id)) {
      return okJsonPlain({ response: action.reply });
    }
    /* remember the outcome was recorded, so the end-of-call report for this
       call does not overwrite it with "no clear outcome" */
    if (action.call_id && env.RATE) {
      await env.RATE.put('shirtool:' + action.call_id, '1', { expirationTtl: 3 * 86400 });
    }
    await writeCallResult(env, action.guest_id, action.result, action.party_size);
    return okJsonPlain({ response: action.reply });
  }

  /* end-of-call (call_analyzed only) */
  if (action.call_id && await seenOnce(env, 'shirdone:end:' + action.call_id)) {
    return okJsonPlain({ ok: true });
  }
  if (action.cost_cents) await trackCallCost(env, action.cost_cents);

  if (action.kind === 'end') {
    await writeCallResult(env, action.guest_id, action.result);
  } else if (action.kind === 'end-no-outcome') {
    const toolRan = action.call_id && env.RATE && await env.RATE.get('shirtool:' + action.call_id);
    if (!toolRan) await writeCallResult(env, action.guest_id, action.result);
  }
  return okJsonPlain({ ok: true });
}

async function handleShirDispatch(request, env, origin) {
  if (Number(request.headers.get('Content-Length') || 0) > 65536) {
    return deny(413, 'too-large', origin);
  }
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!env.ADMIN_KEY || !safeEqual(String(body.admin_key || ''), env.ADMIN_KEY)) {
    return deny(403, 'bad-admin-key', origin);
  }
  if (!env.RETELL_KEY || !env.SHIR_FROM) return deny(503, 'shir-not-configured', origin);

  const win = callWindowState();
  if (!win.open && !body.force) return okJson({ ok: true, dialed: 0, closed: win.why }, origin);

  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (!raw) return deny(502, 'reader-failed', origin);
  const { queue } = buildCallQueue(raw);

  const day = ilDate();
  const cap = Math.min(Number(body.max) || 5, 25);
  const dialed = [];
  for (const g of queue) {
    if (dialed.length >= cap) break;
    if (!shouldDial(g, day)) continue; // capped, or the event already happened
    /* one attempt per guest per day — the 3 tries live on separate days */
    const dayKey = `shirtry:${g.guest_id}:${day}`;
    if (await env.RATE.get(dayKey)) continue;
    const r = await fetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCallPayload(g, env.SHIR_FROM)),
    }).catch(() => null);
    if (r && (r.status === 200 || r.status === 201)) {
      await env.RATE.put(dayKey, '1', { expirationTtl: 2 * 86400 });
      dialed.push(g.guest_id);
    }
  }
  return okJson({ ok: true, dialed: dialed.length, guests: dialed }, origin);
}

async function fetchSnapshot(target) {
  const r = await fetch(target, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'snapshot' }),
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  try { return await r.json(); } catch { return null; }
}

async function serveImage(env, pathname) {
  const token = pathname.slice('/img/'.length);
  if (!env.RATE || !/^[0-9a-f-]{36}$/.test(token)) return new Response('not-found', { status: 404 });
  const { value, metadata } = await env.RATE.getWithMetadata('img:' + token, { type: 'arrayBuffer' });
  if (!value) return new Response('not-found', { status: 404 });
  return new Response(value, {
    headers: {
      'Content-Type': (metadata && metadata.mime) || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
    },
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
    if (url.pathname.startsWith('/img/') && request.method === 'GET') {
      return serveImage(env, url.pathname);
    }
    if (url.pathname === '/api/shir-webhook' && request.method === 'POST') {
      return handleShirWebhook(request, env);
    }
    if (url.pathname === '/api/shir-dispatch' && request.method === 'POST') {
      return handleShirDispatch(request, env, origin);
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
    let parsedForm = null;
    if (type.includes('multipart/form-data')) {
      const form = await request.formData();
      ['app', 'nonce', 'stamp_ts', 'sig'].forEach(k => { stampFields[k] = form.get(k); });
      forwardBody = form;
      parsedForm = form;
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

    /* the dashboard asks with a token; the numbers are computed here, not in
       Make — Make only hands the sheets over */
    if (url.pathname === '/api/status') {
      /* the calls page asks with the admin key and gets the whole queue */
      const admin = String(stampFields.admin_key || '');
      if (admin) {
        if (!env.ADMIN_KEY || !safeEqual(admin, env.ADMIN_KEY)) return deny(403, 'bad-admin-key', origin);
        const raw = await fetchSnapshot(target);
        if (!raw) return deny(502, 'reader-failed', origin);
        if (stampFields.view === 'biz') return okJson(buildBizStats(raw), origin);
        return okJson(buildCallQueue(raw), origin);
      }
      const token = String(stampFields.token || '').trim();
      if (!token) return deny(403, 'code-login-not-ready', origin); // phone+code waits for WhatsApp OTP
      if (!(await tokenRecord(env, token))) return deny(404, 'unknown-token', origin);
      const raw = await fetchSnapshot(target);
      if (!raw) return deny(502, 'reader-failed', origin);
      const snapshot = buildDashboard(token, raw);
      if (!snapshot) return deny(404, 'event-not-found', origin);
      return okJson(snapshot, origin);
    }

    /* a call outcome from the calls page: admin key instead of a token, and
       the button pressed becomes exact cell values here, not in Make */
    if (url.pathname === '/api/event' && stampFields.event_type === 'call_result') {
      if (!env.ADMIN_KEY || !safeEqual(String(stampFields.admin_key || ''), env.ADMIN_KEY)) {
        return deny(403, 'bad-admin-key', origin);
      }
      const result = callOutcome(String(stampFields.outcome || ''), stampFields.tries);
      if (!result || !stampFields.guest_id) return deny(400, 'bad-outcome', origin);
      const r = await fetch(target, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'call_result',
          guest_id: String(stampFields.guest_id),
          /* empty rsvp means "leave what is there" — Make swaps the sentinel
             for the cell's current value */
          rsvp: result.rsvp || '__keep__', call_status: result.call_status,
          answer: result.answer, tries: String(result.tries),
          party: '__keep__',
          ts: new Date().toISOString(),
        }),
      }).catch(() => null);
      if (!r || r.status !== 200) return deny(502, 'writer-failed', origin);
      return okJson({ ok: true, ...result }, origin);
    }

    /* everything aimed at an event must present a token minted by a payment */
    if (url.pathname === '/api/event') {
      const token = String((parsedForm ? parsedForm.get('token') : stampFields.token) || '').trim();
      const rec = await tokenRecord(env, token);
      if (!rec) return deny(403, 'unknown-token', origin);
      if (parsedForm) return handleEventForm(parsedForm, rec, token, env, origin, target, url);
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
