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
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
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

/* 12/11 security: an in-process attempt counter. The KV budget (overBudget) is read-then-write, so a
   burst of parallel requests all read the count from before any of them wrote. This map is
   incremented synchronously, so requests that share an isolate are counted exactly; the KV
   counter stays as the limit across isolates. → true once `limit` hits were already counted. */
const MEM_HITS = new Map();
export function memOver(key, limit, windowSec) {
  const now = Date.now();
  if (MEM_HITS.size > 5000) { for (const [k, v] of MEM_HITS) if (v.until <= now) MEM_HITS.delete(k); if (MEM_HITS.size > 20000) MEM_HITS.clear(); }
  let h = MEM_HITS.get(key);
  if (!h || h.until <= now) { h = { n: 0, until: now + windowSec * 1000 }; MEM_HITS.set(key, h); }
  h.n++;
  return h.n > limit;
}
/* how many hits memOver has counted for this key in its current window (does not count one) */
export function memCount(key) {
  const h = MEM_HITS.get(key);
  return h && h.until > Date.now() ? h.n : 0;
}

/* ══ 12/11 security: no formulas into the sheet ══════════════════════════════
   The Make writer scenarios (HOOK_EVENTS, HOOK_GROW, HOOK_LEADS) store cells as USER_ENTERED, the
   mode in which Google Sheets evaluates anything that starts with = + - or @. Text that a lead, a
   client, a guest or a payer typed is neutralised here, on its way out to those hooks:
     · sheetSafe  — free text (a guest's name or note, an RSVP answer, a description): a leading
                    apostrophe, which USER_ENTERED reads as "this is text" and does not store, so
                    "+1" stays "+1" in the cell;
     · sheetStrip — identity fields (names, venue, occasion, plan, utm…): the leading characters are
                    removed. These are also the fields a scenario copies from one tab to another or
                    joins into one cell, where an apostrophe would not protect.
   A phone written with its + (E.164) is left exactly as it is. The RAW writers (BRAIN_HOOK) are
   not touched: RAW never evaluates, and an apostrophe there would be stored literally. */
const FORMULA_LEAD = /^[\s‎‏‪-‮⁦-⁩]*[=+\-@\t\r]/;
const plusPhone = v => /^\+[\d\s\-().]{6,24}$/.test(v) && v.replace(/\D/g, '').length >= 7;
export function sheetSafe(v) {
  if (typeof v !== 'string' || !v || !FORMULA_LEAD.test(v) || plusPhone(v.trim())) return v;
  return "'" + v;
}
export function sheetStrip(v) {
  if (typeof v !== 'string' || !v || !FORMULA_LEAD.test(v) || plusPhone(v.trim())) return v;
  return v.replace(/^[\s‎‏‪-‮⁦-⁩=+\-@]+/, '');
}
const STRIP_KEYS = /^(name\d?|full_?name|fullName|client|event_title|event_name|venue_(name|addr|city)|occasion(_label)?|sug|plan(_name|Text)?|tier|email|guests|guest_range|guest_count|price|utm_\w+|source|first_source|referrer|page|session_id|notes?|ref|style|schedule_mode|host_roles|file_name|event_date|reception_time|send_date_\d|paidAt|clientId)$/;
const PHONE_KEYS = /^(phone|phone_alt|telefon|tel)$/;
function writerFields(obj, stripAll) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'append_body' && typeof v === 'string') {
      /* guest rows, pre-built for values:append — every cell is free text from the client's file */
      try {
        const ab = JSON.parse(v);
        if (ab && Array.isArray(ab.values)) { ab.values = ab.values.map(row => Array.isArray(row) ? row.map(sheetSafe) : row); out[k] = JSON.stringify(ab); continue; }
      } catch {}
      out[k] = v; continue;
    }
    if (typeof v !== 'string' || PHONE_KEYS.test(k)) { out[k] = v; continue; }
    out[k] = (stripAll || STRIP_KEYS.test(k)) ? sheetStrip(v) : sheetSafe(v);
  }
  return out;
}
/* the body of a POST to `url`, neutralised when `url` is one of the USER_ENTERED writers */
export function makeWriterBody(env, url, body) {
  if (!url || !env) return body;
  const stripAll = url === env.HOOK_LEADS || url === env.HOOK_GROW;
  if (!stripAll && url !== env.HOOK_EVENTS) return body;
  if (typeof body === 'string') {
    let obj; try { obj = JSON.parse(body); } catch { return body; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body;
    return JSON.stringify(writerFields(obj, stripAll));
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fd = new FormData();
    for (const [k, v] of body.entries()) fd.append(k, typeof v === 'string' ? writerFields({ [k]: v }, stripAll)[k] : v);
    return fd;
  }
  return body;
}
