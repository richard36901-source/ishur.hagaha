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
import { buildDashboard, buildCallQueue, callOutcome, buildBizStats, planKeyOf } from './dashboard.js';
import { callWindowState, msUntilCallWindow, sendWindowState, isNoContactDay, buildCallPayload, retellToCallResult, verifyRetellSignature, ilDate, shouldDial, inboundLookup, inboundVariables, inboundMetadata, inboundCallVerdict, leadFromRow } from './shir.js';
import { sendText, sendImage, sendTemplate, sendOtpTemplate, inviteText, parseInboundReply, extractInbound, findGuestByPhone, partyFromText, touchConversation } from './whatsapp.js';
import { promoCheck, promoGo, promoBurn, promoAdmin, normCode } from './promo.js';

const ROUTES = {
  '/api/lead':   { secret: 'HOOK_LEADS',  limit: 12,  window: 3600 },
  '/api/event':  { secret: 'HOOK_EVENTS', limit: 20,  window: 3600 },
  '/api/status': { secret: 'HOOK_STATUS', limit: 120, window: 3600 },
};

const MAX_GUESTS      = 2000;
const MAX_FILE_BYTES  = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TOKEN_TTL       = 400 * 86400;   // covers events booked far ahead

/* ══ what a message really costs ═════════════════════════════════════════════
   Meta bills per delivered template since 07/2025, by the CATEGORY the template
   was APPROVED under — not by what we meant. Israel: utility $0.0053 (~0.02 ₪),
   marketing $0.0353 (~0.12 ₪), authentication ~0.05 ₪. Free-form text inside an
   open 24h service window costs nothing at all.
   The categories below were read from Meta on 01.09.26 via /api/meta-admin.
   The previous flat 0.53 ₪ overstated utility sends ~25x and drove the P&L
   board into fiction. Still to do: reconcile against the first real invoice. */
const TMPL_CATEGORY = {
  hazmana_ishur: 'utility', hazmana_ishur_v2: 'utility', ishur_hazmana_shuv: 'utility',
  ishur_dchiya: 'utility', ishur_bitul: 'utility', ishur_yom_lifnei: 'utility',
  ishur_shulchan: 'utility', ishur_doch: 'utility', ishur_tzikoret_kovetz: 'utility',
  ishur_tashlum: 'utility',
  ishur_lo_siyem: 'marketing', ishur_lo_siyem_2: 'marketing', ishur_lo_siyem_3: 'marketing',
  ishur_toda_orach: 'marketing', ishur_syum: 'marketing',
  ishur_shidrug: 'marketing', ishur_shidrug_sichot: 'marketing',
  ishur_kod: 'auth',
};
const CAT_COST = { utility: 0.02, marketing: 0.12, auth: 0.05 };
function msgCost(tmpl) { return CAT_COST[TMPL_CATEGORY[tmpl] || 'utility'] || 0.02; }

/* One batched write to the sheet — many cells, one Make operation. Every range
   must name its tab explicitly. Returns true only when Sheets confirmed cells. */
async function sheetBatchWrite(env, data) {
  if (!env.BRAIN_HOOK || !data || !data.length) return false;
  const r = await fetch(env.BRAIN_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchUpdate',
      method: 'POST',
      payload: JSON.stringify({ valueInputOption: 'RAW', data }),
    }),
  }).catch(() => null);
  if (!r || !r.ok) return false;
  let out = null;
  try { out = await r.json(); } catch {}
  return !!(out && out.totalUpdatedCells);
}

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

/* Any failure anywhere → immediate ping to Richard in Slack (#ishur-hagaa via
   incoming webhook). Telegram (ALERT_HOOK → Make) is only the fallback when
   the Slack secret is missing — Richard asked for Slack-only, 30.8. */
async function alert(env, where, what, detail) {
  const what300 = String(what || '').slice(0, 300);
  const detail500 = String(detail || '').slice(0, 500);
  if (env.SLACK_ALERT_HOOK) {
    await slackPost(env, `⚠️ *${where}*\n${what300}${detail500 ? '\n' + detail500 : ''}`);
    return;
  }
  if (!env.ALERT_HOOK) return;
  await fetch(env.ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      where, what: what300,
      detail: detail500, ts: new Date().toISOString(),
    }),
  }).catch(() => {});
}

/* ══ The master switch ═══════════════════════════════════════════════════════
   One key, checked before anything leaves the system. Set it and the whole
   business goes quiet within seconds, without a deploy and without touching
   the sheet. Nothing else in the engine needs to know about it.
   ─────────────────────────────────────────────────────────────────────────── */
async function sendingPaused(env) {
  if (!env.RATE) return false;
  return !!(await env.RATE.get('paused'));
}

/* A phone Richard pulled out of sending by hand, for any reason: a wrong
   number, a family that asked him directly, a guest in mourning. Same effect
   as the guest texting הסר, but it is his action and it is reversible. */
/* Opting out of WhatsApp is NOT opting out of calls. A guest who writes "הסר"
   is telling us to stop messaging them; the host still needs to know whether
   they are coming, and Shir still calls. Only `nocall:` (the guest asked not
   to be phoned) and `block:` (Richard pulled the number by hand) stop a dial.
   Two predicates, because one was silently doing both jobs. */
async function phoneBlocked(env, phone) {
  if (!env.RATE) return false;
  const p = normPhone(phone);
  if (!p) return false;
  return !!(await env.RATE.get('optout:' + p)) || !!(await env.RATE.get('block:' + p));
}

/* A client who asked to be removed must stop hearing from us too, not just
   the guests. Every client-facing template goes through here. */
async function sendClient(env, phone, template, params, ctx) {
  const p = normPhone(phone);
  if (!p) return { ok: false, error: 'no-phone' };
  if (await sendingPaused(env)) return { ok: false, error: 'paused' };
  if (await phoneBlocked(env, p)) return { ok: false, error: 'optout' };
  return sendTemplate(env, p, template, params, '', 'he', undefined, ctx);
}

/* Anything the team should just SEE (purchases, milestones) — not failures. */
async function slackPost(env, text) {
  if (!env.SLACK_ALERT_HOOK) return;
  await fetch(env.SLACK_ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

/* One tier credit per new paying customer whose first touch was a referral
   link. The code sits in the lead row (column L, "referral:<tok8>"). */
async function creditReferral(env, payerPhone, newToken) {
  if (!env.RATE || !env.BRAIN_HOOK) return;
  const last9 = String(payerPhone).slice(-9);
  if (!last9) return;
  if (await env.RATE.get('refdone:' + last9)) return; // one credit per payer, ever
  const r = await fetch(env.BRAIN_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchGet',
      qk1: 'ranges', qv1: 'לידים - לא סגרו!A2:P1000',
    }),
  }).catch(() => null);
  if (!r || !r.ok) return;
  let rows = [];
  try { rows = (await r.json()).valueRanges[0].values || []; } catch { return; }
  for (const row of rows) {
    if (!String(row[2] || '').includes(last9)) continue;
    const m = String(row[11] || '').match(/^referral:([0-9a-f]{8})/);
    if (!m || m[1] === String(newToken).slice(0, 8)) return;
    await env.RATE.put('refdone:' + last9, m[1], { expirationTtl: 730 * 86400 });
    const key = 'refcred:' + m[1];
    const cur = Number(await env.RATE.get(key)) || 0;
    await env.RATE.put(key, String(cur + 1), { expirationTtl: 730 * 86400 });
    await alert(env, 'הפניה מאומתת 🎉',
      `לקוח חדש שילם דרך קישור ההפניה של ${m[1]} — נזקף זיכוי דרגה`, '');
    return;
  }
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

  /* Richard clears OTHER businesses through the same Grow account, and the
     Grow webhook fires on every transaction. Only payments made on one of
     ishur's own payment pages may enter this pipeline. The page ids are the
     decoded tails of the pay.grow.link URLs in config.js. Raw payloads are
     kept 14 days so the matcher can be tightened against real traffic. */
  const ISHUR_GROW_PAGES = [
    '3300348', '3300353', '3300355', '3300359', '3300361', '3300362',
    '3300365', '3300367', '3300369', '3300370', '3300372', '3300373',
    '3300375', '3300376', '3300379', '3300381', '3300383', '3300385',
    '3300386', '3300389', '3300390', '3874155', '3874157', '3874158',
    '3874160', '3874161', '3874166', '3874176', '3874178', '3874181',
  ];
  const flatDump = JSON.stringify(flat);
  if (env.RATE) {
    await env.RATE.put('ipnraw:' + Date.now(), flatDump.slice(0, 8000),
      { expirationTtl: 14 * 86400 }).catch(() => {});
  }
  const isIshur = ISHUR_GROW_PAGES.some((id) => flatDump.includes(id)) ||
    flatDump.toLowerCase().includes('ishur') || flatDump.includes('אישורי הגעה');
  if (!isIshur) {
    /* The matcher has never seen a real Grow payload, so a miss here could be
       a genuine customer who paid and would get nothing. Never silently drop:
       park the whole payload under ipnmiss:<id> (30d) and shout in Slack with
       the id, so /api/ipn-replay can push it through the normal pipeline. */
    const missId = 'ipnmiss:' + Date.now();
    if (env.RATE) {
      await env.RATE.put(missId, flatDump.slice(0, 12000), { expirationTtl: 30 * 86400 }).catch(() => {});
    }
    await alert(env, 'תשלום Grow לא זוהה',
      `תשלום שלא זוהה כ-ishur לא הופעל (כנראה עסק אחר באותו חשבון). אם זה כן לקוח שלנו — שלח לי את המזהה ${missId} ואני מריץ אותו מיד`,
      flatDump.slice(0, 600));
    return new Response('ignored-non-ishur', { status: 200 });
  }

  return processGrowPayment(env, flat);
}

/* Everything after the ishur gate. Split out so a payment the gate wrongly
   rejected can be replayed from KV through the identical path. */
async function processGrowPayment(env, flat) {
  const ref = String(
    flat.asmachta || flat.transactionId || flat.transactionToken ||
    flat.paymentId || flat.processToken || flat.processId || ''
  ).trim();
  /* אשראי / ביט / העברה — Grow names this differently per gateway; grab what exists */
  const payMethod = String(flat.paymentType || flat.paymentMethod || flat.payment_type ||
    flat.transactionType || flat.typeName || '').trim();
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
    await alert(env, 'תשלום Grow', 'הגיע תשלום בלי אסמכתא או טלפון — טיפול ידני', JSON.stringify(flat).slice(0, 400));
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
    /* they paid — they are not an abandoned lead any more, in either
       direction: no chase message, and no lead call queued behind it */
    await env.RATE.delete('lead:' + phone).catch(() => {});
    await env.RATE.delete('lq:' + phone).catch(() => {});
    /* token→who: the upload page presents a token, this is how it is trusted */
    await env.RATE.put('token:' + token, JSON.stringify({
      phone, ref, name, clientId: 'C-' + phone.slice(-9),
    }), { expirationTtl: TOKEN_TTL });
  }

  const clean = {
    kind: 'payment', ref, token, phone, sum, name, email, payMethod,
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
  if (!ok) await alert(env, 'תשלום Grow', 'Make לא קלט את התשלום (writer-failed)', `ref=${ref} phone=${phone} sum=${sum}`);

  /* paid → the client gets their personal upload link on WhatsApp, right now.
     claimlink:<phone> lets the service bot re-send it on request later. */
  if (ok) {
    /* verified referral: when this payer's lead carries referral:<code>, the
       referrer earns a tier credit. Never blocks the payment path. */
    try { await creditReferral(env, phone, token); } catch {}
    /* a promo seat is only really taken once the money lands. Until here the
       code was on hold and would have expired back into the pool. */
    let promo = null;
    try {
      promo = await promoBurn(env, phone,
        flat.cField1 || flat.cField2 || flat.customField1 || flat.promo || '');
    } catch {}
    if (promo && env.RATE) {
      await env.RATE.put('promoof:' + token, JSON.stringify(promo), { expirationTtl: 400 * 86400 });
    }
    /* every purchase lands in Slack — Richard doesn't always get Grow's email */
    await slackPost(env, `🎉 *רכישה חדשה ב-ishur*\n${name || 'ללא שם'} · ${phone}` +
      `\nסכום: ₪${sum || '?'}${payMethod ? ' · ' + payMethod : ''}` +
      (promo ? `\n🎫 ${promo.label} · קוד ${promo.code || ''}` +
        (promo.left != null ? ` · נשארו ${promo.left} מקומות` : '') : '') +
      `\n${isNewClient ? 'לקוח חדש' : 'לקוח חוזר'} · אסמכתא ${ref}`);
    if (env.RATE) await env.RATE.put('claimlink:' + phone, token, { expirationTtl: 180 * 86400 });
    /* the stuck-client stage nudges whoever still hasn't uploaded a day later */
    if (env.RATE) await env.RATE.put('pend:' + token,
      JSON.stringify({ phone, name, at: new Date().toISOString() }), { expirationTtl: 7 * 86400 });
    const first = (name.split(' ')[0] || '').trim() || 'לקוח יקר';
    const wa = await sendClient(env, phone, 'ishur_tashlum',
      [first, 'https://ishur.io/upload.html?t=' + token], { token });
    if (wa.ok) await addEvCost(env, token, msgCost('ishur_tashlum'));
    if (env.RATE) await env.RATE.put('paywa:' + ref,
      JSON.stringify({ ...wa, at: new Date().toISOString() }), { expirationTtl: 30 * 86400 });
  }
  return new Response(ok ? 'ok' : 'writer-failed', { status: ok ? 200 : 502 });
}

/* ── promo vouchers ───────────────────────────────────────────────────────
   /promo/check is what the site asks before it dares show 49 instead of 299.
   /promo/go is the buy button: it holds a seat and sends the visitor to the
   real Grow link, which never appears anywhere a scraper can read it.
   Both are unauthenticated by design (a code IS the credential), so both are
   rate limited — 8.5e11 codes make guessing hopeless, but not free. */
async function handlePromoCheck(env, request, url, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  /* A whole household, office or wedding venue shares one IP, and this fires
     on every page load. 40 was low enough that an afternoon of testing locked
     out the tester's own home. Brute force is not what this defends against
     anyway — 31^8 codes make guessing hopeless — it only stops a flood. */
  if (await overBudget(env, 'promo-check:' + ip, 300, 600)) {
    return deny(429, 'rate-limited', origin);
  }
  const res = await promoCheck(env, url.searchParams.get('code'));
  return new Response(JSON.stringify(res), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });
}

async function handlePromoGo(env, request, url, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overBudget(env, 'promo-go:' + ip, 60, 600)) {
    return deny(429, 'rate-limited', origin);
  }
  /* the phone is not optional: without it the one-holder lock has nothing to
     lock onto, and the review proved a stripped ?phone= handed the same code
     to unlimited callers (finding #6). The site always sends it; a request
     without one is not the site. */
  const goPhone = String(url.searchParams.get('phone') || '').replace(/\D/g, '');
  if (goPhone.length < 9) {
    return Response.redirect('https://ishur.io/index.html?promo_error=phone-required', 302);
  }
  const res = await promoGo(env, url.searchParams.get('code'), goPhone);
  if (!res.ok) {
    /* a dead code lands on the normal pricing page rather than an error blob —
       whoever forwarded it out of the group just pays full price */
    /* back to whichever host they were on — bouncing a go.ishur.io visitor
       onto the blocked name is how a bad code becomes a dead end */
    const back = url.hostname === MIRROR_HOST ? LINK_BASE : 'https://ishur.io';
    const to = back + '/index.html?promo_error=' + encodeURIComponent(res.reason || 'invalid');
    return Response.redirect(to, 302);
  }
  /* if Grow echoes custom fields back on the IPN this closes the loop without
     needing the phone; if it does not, the phone claim already covers it */
  let link = res.link;
  try {
    const u = new URL(link);
    if (!u.searchParams.has('cField1')) u.searchParams.set('cField1', normCode(url.searchParams.get('code')));
    link = u.toString();
  } catch {}
  return new Response(null, {
    status: 302,
    headers: { Location: link, 'Cache-Control': 'no-store' },
  });
}

async function handlePromoAdmin(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  const res = await promoAdmin(env, body);
  return okJson(res, origin);
}

/* ══ abandoned leads ═════════════════════════════════════════════════════════
   lead:<phone> is written the moment somebody submits the form, and deleted
   the moment they pay. Whatever is still sitting there some hours later is a
   person who asked us a question and got silence.
   ────────────────────────────────────────────────────────────────────────── */
const LEAD_TTL = 45 * 86400;

async function noteLead(env, f) {
  const phone = normPhone(f.phone || f.telefon || f.tel || '');
  if (!phone || phone.length < 11) return;
  /* somebody who already bought is not a lead, and must never be chased */
  if (await env.RATE.get('client:' + phone)) return;
  const key = 'lead:' + phone;
  const consent = f.marketing_consent === true || f.marketing_consent === 'true' || f.consent === true;
  /* the first submission sets the clock; later ones only fill blanks. The
     updates checkbox is the exception: a yes that arrives on submission two
     still counts, because the person did tick it. */
  let rec = null;
  try { rec = JSON.parse(await env.RATE.get(key)); } catch {}
  if (rec) {
    let dirty = false;
    if (consent && !rec.consent) { rec.consent = true; dirty = true; }
    if (!rec.name && f.name) { rec.name = String(f.name).trim().slice(0, 60); dirty = true; }
    if (!rec.occasion && (f.occasion || f.event_type)) {
      rec.occasion = String(f.occasion || f.event_type).trim().slice(0, 40); dirty = true;
    }
    if (dirty) await env.RATE.put(key, JSON.stringify(rec), { expirationTtl: LEAD_TTL });
    return;
  }
  /* someone who already went through the whole sequence starts nothing new */
  if (await env.RATE.get('leadchase:' + phone)) return;
  await env.RATE.put(key, JSON.stringify({
    name: String(f.name || f.fullName || f.full_name || '').trim().slice(0, 60),
    occasion: String(f.occasion || f.event_type || f.sug || '').trim().slice(0, 40),
    at: new Date().toISOString(),
    consent,
  }), { expirationTtl: LEAD_TTL });
}

/* The abandoned-lead sequence, exactly as Richard specced it (01.09):
     t1  half an hour after the form died          → ishur_lo_siyem
     t2  the next calendar day                     → ishur_lo_siyem_2
     then, for someone who did NOT tick updates:
     q   two silent hours after t2                 → lq: (the sales-call queue;
                                                     dialling it stays off until
                                                     a sales agent exists, AUT-896)
     and for someone who DID tick updates:
     t3  three days after t2                       → ishur_lo_siyem_3 (a tip, not a nag)
   A reply at any point ends the sequence on the spot — from that moment the
   conversation belongs to נועה and her 24h window, not to templates.
   Templates are required for the outbound touches because these people never
   wrote to us first. All of this only runs inside the send window, from the
   pacer, so "half an hour" after a 23:00 abandon really means 09:00. */
const LEAD_T1_MS = 30 * 60 * 1000;
const LEAD_T2_MIN_MS = 16 * 3600 * 1000;   // plus a calendar-day change, checked below
const LEAD_Q_MS = 2 * 3600 * 1000;
const LEAD_T3_MS = 3 * 86400 * 1000;

async function leadReplied(env, phone, sinceIso) {
  let c = null;
  try { c = JSON.parse(await env.RATE.get('conv:' + normPhone(phone))); } catch {}
  return !!(c && c.last_dir === 'in' && c.last_ts && c.last_ts > Date.parse(sinceIso || '1970-01-01'));
}

async function chaseAbandonedLeads(env, dry, budget) {
  if (!env.RATE) return [];
  const out = [];
  const now = Date.now();
  const today = ilDate();
  /* Two hard rules from the review (finding #1), learned the expensive way:
     1. A settled lead's lead: key DIES immediately — finished, bought, blocked,
        whatever. Skipping a dead lead still costs KV reads, and a fortnight of
        paid traffic builds enough of them that the scan alone blows the
        subrequest ceiling BEFORE the wave loop runs.
     2. The scan itself is bounded: one page, and skips also spend budget.
        Whatever does not fit this tick is ten minutes away from the next. */
  const page = await env.RATE.list({ prefix: 'lead:', limit: 1000 }).catch(() => null);
  if (!page) return out;

  const settle = async (phone, why) => {
    await env.RATE.put('leadchase:' + phone, why + ':' + new Date().toISOString(), { expirationTtl: LEAD_TTL });
    await env.RATE.delete('lead:' + phone);
  };
  const save = (phone, rec) =>
    env.RATE.put('lead:' + phone, JSON.stringify(rec), { expirationTtl: LEAD_TTL });

  /* a touch that Meta will refuse tomorrow too advances the sequence anyway:
     losing one text must not strand the person outside the call queue */
  const PERMANENT = /132000|132001|132005|131009|131026/;

  for (const k of page.keys) {
    if (budget && budget.left <= 0) break;
    const phone = k.name.slice('lead:'.length);
    let rec = null;
    try { rec = JSON.parse(await env.RATE.get(k.name)); } catch {}
    if (!rec) { await env.RATE.delete(k.name); continue; }
    if (await env.RATE.get('client:' + phone)) { await env.RATE.delete(k.name); continue; }
    if (await phoneBlocked(env, phone)) { if (!dry) await settle(phone, 'blocked'); continue; }
    /* answered = theirs now. Any inbound message after the form died means a
       human (or נועה) is already talking to them; more templates would nag. */
    if (await leadReplied(env, phone, rec.at)) { if (!dry) await settle(phone, 'answered'); continue; }

    const first = (String(rec.name || '').split(' ')[0] || '').trim() || 'היי';
    const occ = rec.occasion || 'האירוע שלכם';
    const sendTouch = async (tmpl, stampField) => {
      if (budget) budget.left--;
      const wa = await sendClient(env, phone, tmpl, [first, occ]);
      if (wa.ok || PERMANENT.test(String(wa.error || ''))) {
        rec[stampField] = new Date().toISOString();
        rec[stampField + 'd'] = today;
        await save(phone, rec);
      }
      out.push({ type: 'lead_' + stampField, phone, sent: !!wa.ok, error: wa.error || '' });
      return wa;
    };

    if (!rec.t1) {
      if (now - Date.parse(rec.at || 0) < LEAD_T1_MS) continue;
      if (dry) { out.push({ type: 'lead_t1', phone, name: rec.name }); continue; }
      await sendTouch('ishur_lo_siyem', 't1');
      continue;
    }
    if (!rec.t2) {
      if (today === rec.t1d || now - Date.parse(rec.t1) < LEAD_T2_MIN_MS) continue;
      if (dry) { out.push({ type: 'lead_t2', phone }); continue; }
      await sendTouch('ishur_lo_siyem_2', 't2');
      continue;
    }
    if (!rec.consent) {
      if (now - Date.parse(rec.t2) < LEAD_Q_MS) continue;
      if (dry) { out.push({ type: 'lead_queue', phone }); continue; }
      await env.RATE.put('lq:' + phone, JSON.stringify({ name: rec.name, occ, at: new Date().toISOString() }),
        { expirationTtl: 14 * 86400 });
      await settle(phone, 'queued');
      out.push({ type: 'lead_queue', phone, queued: true });
      continue;
    }
    if (!rec.t3) {
      if (now - Date.parse(rec.t2) < LEAD_T3_MS) continue;
      if (dry) { out.push({ type: 'lead_t3', phone }); continue; }
      await sendTouch('ishur_lo_siyem_3', 't3');
      await settle(phone, 'done');
    }
  }
  const sentNow = out.filter(o => o.sent).length;
  const queuedNow = out.filter(o => o.queued).length;
  if (!dry && (sentNow || queuedNow)) {
    const bits = [];
    if (sentNow) bits.push(`${sentNow} הודעות המשך ללידים שנטשו`);
    if (queuedNow) bits.push(`${queuedNow} נכנסו לתור שיחות המכירה`);
    await slackPost(env, `📨 *${bits.join(' · ')}.*`);
  }
  return out;
}

/* Per-event levers that live in KV rather than the sheet, so they can be
   flipped without a deploy: extrasend (unlocks wave 3, the paid add-on) and
   hold (freezes every guest send for one event).
   POST {admin_key, token, flag:'extrasend'|'hold', on:bool}; omit `on` to read. */
const EVENT_FLAGS = ['extrasend', 'hold'];
async function handleEventFlag(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  const token = String(body.token || '').trim();
  const flag = String(body.flag || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(token) || !EVENT_FLAGS.includes(flag) || !env.RATE) {
    return deny(400, 'bad-request', origin);
  }
  const key = flag + ':' + token;
  if (typeof body.on !== 'boolean') {
    return okJson({ ok: true, flag, on: !!(await env.RATE.get(key)) }, origin);
  }
  if (body.on) await env.RATE.put(key, new Date().toISOString(), { expirationTtl: 200 * 86400 });
  else await env.RATE.delete(key);
  await slackPost(env, `⚙️ ${flag === 'hold' ? 'השהיית שירות' : 'תוסף שליחה נוספת'} ${body.on ? 'הופעל' : 'בוטל'} לאירוע ${token.slice(0, 8)}`);
  return okJson({ ok: true, flag, on: body.on }, origin);
}

/* A payment the ishur gate wrongly rejected: POST {admin_key, id:"ipnmiss:…"}
   pushes the stored payload through the normal pipeline, once. */
async function handleIpnReplay(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  const id = String(body.id || '').trim();
  if (!/^ipnmiss:\d+$/.test(id) || !env.RATE) return deny(400, 'bad-id', origin);
  const raw = await env.RATE.get(id);
  if (!raw) return deny(404, 'not-found', origin);
  let flat = null;
  try { flat = JSON.parse(raw); } catch { return deny(422, 'bad-payload', origin); }
  const res = await processGrowPayment(env, flat);
  const text = await res.text().catch(() => '');
  if (res.status === 200) await env.RATE.delete(id).catch(() => {});
  return okJson({ ok: res.status === 200, status: res.status, result: text }, origin);
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
  /* WhatsApp renders JPEG and PNG. WebP was harmless while the artwork was
     never sent; now that it goes out as an image message it would fail, so
     the client is told at upload time instead of finding out on event day. */
  return null;
}

function okJson(payload, origin) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

/* The purchased tier, from the event row (col 32, e.g. "עד 300"). 0 = unknown,
   which lets the upload through and leaves the sheet as the source of truth. */
function tierOf(evRow) {
  if (!evRow) return 0;
  return parseInt(String(evRow[32] || '').replace(/\D/g, ''), 10) || 0;
}

/* A promo seat carries its own entitlement. The pilot pays 50, which is also
   the price of the 50-guest package, so the sheet can end up saying 50 while
   the customer was sold 300. The voucher is the stronger claim — it is what we
   actually promised — so it raises the cap, never lowers it. */
async function tierWithPromo(env, token, sheetTier) {
  if (!env.RATE || !token) return sheetTier;
  try {
    const raw = await env.RATE.get('promoof:' + token);
    if (!raw) return sheetTier;
    const p = JSON.parse(raw);
    const t = parseInt(p.maxTier, 10) || 0;
    return t > sheetTier ? t : sheetTier;
  } catch { return sheetTier; }
}

/* Invitations, not people: one phone number is one invitation. */
function countBillable(guests) {
  const seen = new Set();
  for (const g of guests) { const p = normPhone(g.phone); if (p) seen.add(p); }
  return seen.size;
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
    const { guests, skipped, warnings } = guestsFromRows(rows);
    if (!guests.length) return deny(422, 'no-valid-guests', origin);
    if (guests.length > MAX_GUESTS) return deny(422, 'too-many-guests', origin);

    /* the purchased tier caps the list: a 50-guest package cannot swallow a
       100-row file. The tier sits in the event row (col 32) written at setup;
       when the row isn't there yet we let it pass and the sheet stays the
       source of truth for a later manual check. */
    const capSnap = await fetchSnapshot(env.HOOK_STATUS).catch(() => null);
    const capRow = capSnap ? ((capSnap.events && capSnap.events.values) || [])
      .find(r => String(r[1] || '').trim() === token) : null;
    const tierNum = await tierWithPromo(env, token, tierOf(capRow));
    /* the tier counts invitations, i.e. distinct phone numbers — a family on
       one number is one invitation, exactly as the waves dedupe them */
    const billable = countBillable(guests);
    if (tierNum && billable > tierNum) {
      await slackPost(env, `📈 *חריגת מכסה בהעלאה* · ${rec.name || ''}: ${billable} הזמנות מול חבילת ${tierNum} — ההעלאה נחסמה והוצעה הגדלה`);
      return new Response(JSON.stringify({
        ok: false, error: 'over-tier', allowed: tierNum, got: billable,
      }), { status: 422, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
    }

    /* a partly-bad file stops for a human decision: the client sees exactly
       which rows have problems and chooses — upload anyway, or fix and retry.
       confirm=1 on the second send means "upload anyway". Only pages that
       declare supports_preview get this — an older cached page would mistake
       the preview for success and never confirm. */
    if ((skipped.length || warnings.length) &&
        String(form.get('supports_preview') || '') === '1' &&
        String(form.get('confirm') || '') !== '1') {
      return okJson({
        ok: true, preview: true,
        guests: guests.length,
        skipped: skipped.slice(0, 60),
        warnings: warnings.slice(0, 60),
      }, origin);
    }

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
    await env.RATE.delete('pend:' + token).catch(() => {});
    return okJson({ ok: true, guests: guests.length, skipped: skipped.length }, origin);
  }

  /* setup step — text fields, plus the invitation image when one was chosen.
     Only the settings fields are forwarded, by name. Copying the whole form
     let a caller smuggle event_type/guest_id/append_body through to the Make
     writer and touch rows belonging to somebody else's event. */
  /* exactly the fields Make scenario 6959458 reads for event_setup, checked
     against the blueprint. event_type/token are set below, never taken from
     the caller; guest_id, append_body, rsvp and friends belong to other
     routes and must not be reachable from here. */
  const SETUP_FIELDS = [
    'occasion', 'occasion_label', 'event_title', 'name1', 'name2',
    'event_date', 'reception_time', 'venue_name', 'venue_addr', 'venue_city',
    'style', 'event_description', 'schedule_mode',
    'send_date_1', 'send_date_2', 'send_date_3',
  ];
  const out = { event_type: 'event_setup', token };
  for (const k of SETUP_FIELDS) {
    const v = form.get(k);
    if (typeof v === 'string' && v !== '') out[k] = v;
  }

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

/* ══ guest list over WhatsApp ════════════════════════════════════════════════
   A paying client can just send the Excel/CSV to the business number instead
   of the upload page — same parser, same validations, same Make writer. */
async function waGuestFile(env, from, doc) {
  const phone = normPhone(from);
  /* anyone can send documents to a business number: cap the work and the
     replies per sender so this path cannot be used to burn our send quota */
  if (await overBudget(env, 'rl:wadoc:' + phone, 5, 3600)) return;
  const token = env.RATE ? await env.RATE.get('claimlink:' + phone) : null;
  if (!token) {
    /* one explanation per sender per day, then silence */
    if (!(await seenOnce(env, 'wadocnag:' + phone + ':' + ilDate()))) {
      await sendText(env, from, 'קיבלנו את הקובץ 🙂 העלאת רשימת מוזמנים זמינה למי שרכש חבילה, ולא מצאתי תשלום מהמספר הזה. אם שילמתם ממספר אחר, כתבו לנו כאן ונעזור.');
    }
    return;
  }
  const rec = await tokenRecord(env, token);
  if (!rec) {
    await sendText(env, from, 'הקישור האישי כבר לא בתוקף. כתבו לנו כאן ונשלח קישור חדש 🙂');
    return;
  }
  if (await env.RATE.get('uploaded:' + token)) {
    await sendText(env, from, 'כבר קיימת רשימת מוזמנים לאירוע הזה. להחלפת הרשימה כתבו לנו כאן ונטפל בזה יחד.');
    return;
  }
  const fname = String(doc.filename || 'guests.xlsx');
  if (!/\.(csv|xlsx|xls)$/i.test(fname)) {
    await sendText(env, from, 'הקובץ צריך להיות אקסל (xlsx) או CSV. אפשר גם דרך הקישור האישי: https://ishur.io/upload.html?t=' + token);
    return;
  }
  const meta = await fetch('https://graph.facebook.com/v21.0/' + doc.id, {
    headers: { Authorization: 'Bearer ' + env.WA_TOKEN },
  }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!meta || !meta.url) {
    await sendText(env, from, 'לא הצלחנו למשוך את הקובץ מוואטסאפ. נסו לשלוח שוב 🙂');
    return;
  }
  /* trust the declared size first so a huge file is never pulled into the
     isolate, then re-check the bytes we actually got */
  if (Number(meta.file_size) > MAX_FILE_BYTES) {
    await sendText(env, from, 'הקובץ גדול מדי לשליחה בוואטסאפ. אפשר להעלות דרך הקישור האישי: https://ishur.io/upload.html?t=' + token);
    return;
  }
  const buf = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + env.WA_TOKEN } })
    .then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
  if (!buf || buf.byteLength > MAX_FILE_BYTES) {
    await sendText(env, from, 'הקובץ גדול מדי או לא נקרא. אפשר להעלות דרך הקישור האישי: https://ishur.io/upload.html?t=' + token);
    return;
  }
  let rows;
  try { rows = parseGuestFile(fname, buf); }
  catch {
    await sendText(env, from, 'לא הצלחנו לקרוא את הקובץ. ודאו שיש בו עמודת שם ועמודת טלפון ונסו שוב 🙂');
    return;
  }
  const { guests, skipped } = guestsFromRows(rows);
  if (!guests.length) {
    await sendText(env, from, 'לא מצאנו ברשימה אף שורה תקינה (שם + טלפון). בדקו את הקובץ ונסו שוב 🙂');
    return;
  }
  if (guests.length > MAX_GUESTS) {
    await sendText(env, from, 'הרשימה גדולה מהמותר במערכת. כתבו לנו כאן ונסדר את זה.');
    return;
  }
  /* The website shows problem rows and asks before writing. WhatsApp has no
     room for that, and one guest list per event is final — so a file with a
     material number of unusable rows goes to the page instead of being
     silently accepted minus the people it dropped. */
  if (skipped.length > Math.max(3, Math.round(guests.length * 0.1))) {
    await sendText(env, from,
      `בקובץ יש ${skipped.length} שורות שלא הצלחנו לקרוא (חסר שם או טלפון תקין), ורשימה נשמרת פעם אחת.\n` +
      `כדי לראות בדיוק אילו שורות ולהחליט, פתחו את הקישור האישי: https://ishur.io/upload.html?t=${token}`);
    return;
  }
  const snap = await fetchSnapshot(env.HOOK_STATUS).catch(() => null);
  const evRow = snap ? ((snap.events && snap.events.values) || [])
    .find(r => String(r[1] || '').trim() === token) : null;
  const tierNum = await tierWithPromo(env, token, tierOf(evRow));
  const billable = countBillable(guests);
  if (tierNum && billable > tierNum) {
    await sendText(env, from, `הרשימה כוללת ${billable} הזמנות, והחבילה שנרכשה מכסה עד ${tierNum}. אפשר להגדיל את החבילה בקלות, פשוט כתבו לנו כאן ונשלח קישור.`);
    await slackPost(env, `📈 *הזדמנות הגדלה* · ${rec.name || ''} ${phone}: שלח ${billable} הזמנות מול חבילת ${tierNum}`);
    return;
  }
  const now = new Date().toISOString();
  const values = guests.map((g, i) => {
    const row = new Array(29).fill('');
    row[0] = rec.clientId;
    row[1] = rec.name || '';
    row[2] = 'G-' + token.slice(0, 8) + '-' + (i + 1);
    row[3] = g.name;
    row[4] = g.phone;
    row[5] = g.party;
    row[24] = 'הועלה בוואטסאפ: ' + fname;
    row[25] = now;
    row[28] = token;
    return row;
  });
  const r = await fetch(env.HOOK_EVENTS, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'guests_file', token,
      file_name: fname,
      guest_count: guests.length,
      skipped_count: skipped.length,
      append_body: JSON.stringify({ values }),
    }),
  }).catch(() => null);
  if (!r || r.status !== 200) {
    await sendText(env, from, 'קרתה תקלה זמנית בשמירה. נסו שוב בעוד כמה דקות 🙂');
    return;
  }
  await env.RATE.put('uploaded:' + token, now, { expirationTtl: TOKEN_TTL });
  await env.RATE.delete('pend:' + token).catch(() => {});
  await sendText(env, from, `הרשימה נקלטה! ${guests.length} מוזמנים נשמרו לאירוע 🎉${skipped.length ? ` (${skipped.length} שורות דולגו בגלל פרטים חסרים)` : ''}\nעוקבים אחרי הכל בלוח הבקרה: https://ishur.io/dashboard.html?t=${token}`);
  await slackPost(env, `📎 רשימת מוזמנים נקלטה בוואטסאפ · ${rec.name || ''} ${phone} · ${guests.length} מוזמנים`);
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

/* Per-event running cost, USD cents, keyed by the token's first 8 characters —
   guest ids carry the same prefix (G-<tok8>-N), so Shir's call costs join the
   same bucket as the WhatsApp sends. Feeds the per-event profit column. */
async function addEvCost(env, tokenOrGuestId, cents) {
  if (!env.RATE || !cents) return;
  let t8 = String(tokenOrGuestId || '');
  t8 = t8.startsWith('G-') ? (t8.split('-')[1] || '') : t8.slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(t8)) return;
  const key = 'evcost:' + t8;
  const cur = Number(await env.RATE.get(key)) || 0;
  await env.RATE.put(key, String(Math.round((cur + cents) * 100) / 100), { expirationTtl: 400 * 86400 });
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

/* Two personal admin keys — Richard's and Shalev's — each revocable alone */
function isAdmin(env, key) {
  const k = String(key || '');
  if (!k) return false;
  if (env.ADMIN_KEY && safeEqual(k, env.ADMIN_KEY)) return true;
  if (env.ADMIN_KEY2 && safeEqual(k, env.ADMIN_KEY2)) return true;
  return false;
}

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

  /* who rang whom, for the callback queue. Reaching the mid-call tool at all
     means a real conversation happened, so the provisional entry the inbound
     endpoint wrote when the phone rang is no longer owed. */
  const meta0 = (body.call && body.call.metadata) || {};
  const isInb = meta0.kind === 'inbound' || meta0.kind === 'callback';
  const inbPhone = normPhone(meta0.from || (body.call && body.call.from_number) || '');

  if (action.kind === 'tool-noop') {
    if (isInb && inbPhone) await cbqClear(env, inbPhone);
    return okJsonPlain({ response: action.reply });
  }

  if (action.kind === 'tool') {
    if (action.call_id && await seenOnce(env, 'shirdone:tool:' + action.call_id)) {
      return okJsonPlain({ response: action.reply });
    }
    if (isInb && inbPhone) await cbqClear(env, inbPhone);
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
  if (action.cost_cents) {
    await trackCallCost(env, action.cost_cents);
    await addEvCost(env, action.guest_id, action.cost_cents);
  }

  /* Did we actually talk to whoever rang us? A call that reached the tool
     recorded an answer and owes nothing; anything shorter than a greeting,
     or a Retell-side failure, goes back in the queue for a quick ring back. */
  const toolRanHere = !!(action.call_id && env.RATE && await env.RATE.get('shirtool:' + action.call_id));
  const verdict = inboundCallVerdict(body, { outcomeRecorded: toolRanHere });
  if (verdict) {
    if (verdict.missed) await cbqEnqueue(env, verdict.phone, verdict.why).catch(() => {});
    else await cbqClear(env, verdict.phone).catch(() => {});
  }
  /* an inbound call from a number no sheet knows: costed and queued above,
     but there is no row to write */
  if (action.kind === 'end-untracked') return okJsonPlain({ ok: true });

  if (action.kind === 'end') {
    await writeCallResult(env, action.guest_id, action.result);
  } else if (action.kind === 'end-no-outcome') {
    if (!toolRanHere) await writeCallResult(env, action.guest_id, action.result);
  }
  return okJsonPlain({ ok: true });
}

/* The dialling itself, with no HTTP around it, so the morning cron can run it.
   Until this existed, every guest queued for a call sat there forever: the
   only caller was an admin POST that nobody was making. */
async function runShirDispatch(env, { max = 25, force = false, quiet = false } = {}) {
  if (!env.RETELL_KEY || !env.SHIR_FROM) return { ok: false, why: 'not-configured' };
  if (await sendingPaused(env)) return { ok: true, dialed: 0, paused: true };
  /* a holiday is not a closed window, it is a closed day */
  if (isNoContactDay(ilDate()) && !force) return { ok: true, dialed: 0, closed: 'no-contact-day' };
  const win = callWindowState();
  /* the pacer calls this 63 times a day — the 60s cache exists exactly so
     those ticks do not each cost a Make operation (review finding #10) */
  const raw = await snapshotCached(env).catch(() => null);
  if (!raw) return { ok: false, why: 'reader-failed' };
  const { queue } = buildCallQueue(raw);
  /* a closed window with people waiting is worth saying out loud: silence here
     is exactly how the queue grew unnoticed */
  if (!win.open && !force) {
    if (queue.length && !quiet) {
      await slackPost(env, `🕐 ${queue.length} אורחים ממתינים לשיחה, אבל חלון החיוג סגור (${win.why}). ננסה בהזדמנות הבאה.`);
    }
    return { ok: true, dialed: 0, closed: win.why, queued: queue.length };
  }
  const day = ilDate();
  const cap = Math.min(Number(max) || 25, 25);
  const dialed = [];
  let blocked = 0;
  for (const g of queue) {
    if (dialed.length >= cap) break;
    if (!shouldDial(g, day)) continue;
    if (env.RATE && await env.RATE.get('hold:' + g.token)) { blocked++; continue; }
    /* was phoneBlocked() — which counts an opt-out. An opt-out is about
       messages, never about calls. See the note on callBlocked. */
    if (await callBlocked(env, g.phone)) { blocked++; continue; }
    if (await wrongNum(env, g.token, g.phone)) { blocked++; continue; }
    const dayKey = `shirtry:${g.guest_id}:${day}`;
    if (await env.RATE.get(dayKey)) continue;
    const r = await fetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCallPayload(g, env.SHIR_FROM)),
    }).catch(() => null);
    if (r && (r.status === 200 || r.status === 201)) {
      await env.RATE.put(dayKey, '1', { expirationTtl: 2 * 86400 });
      await env.RATE.put('calldate:' + g.token, day, { expirationTtl: 60 * 86400 });
      dialed.push(g.guest_id);
    }
  }
  /* a queue that never empties is a silent failure: say so */
  if (queue.length && !dialed.length && !blocked && !quiet) {
    await slackPost(env, `📞 *${queue.length} אורחים ממתינים לשיחה ואף אחד לא חויג.* שווה בדיקה.`);
  } else if (dialed.length && !quiet) {
    await slackPost(env, `📞 שיר חייגה ל-${dialed.length} אורחים${blocked ? ` (${blocked} דולגו: מוקפא או חסום)` : ''}. בתור: ${queue.length}`);
  } else if (dialed.length && quiet && env.RATE) {
    /* one running total a day instead of a line every ten minutes */
    const dk = 'dialday:' + day;
    const n = (parseInt(await env.RATE.get(dk) || '0', 10) || 0) + dialed.length;
    await env.RATE.put(dk, String(n), { expirationTtl: 3 * 86400 });
  }
  return { ok: true, dialed: dialed.length, guests: dialed, queued: queue.length, blocked };
}

async function handleShirDispatch(request, env, origin) {
  if (Number(request.headers.get('Content-Length') || 0) > 65536) {
    return deny(413, 'too-large', origin);
  }
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  /* the ring-back queue, on demand — same route, so there is one admin door
     into Shir's dialling rather than two */
  if (body.callbacks) {
    return okJson(await runShirCallbacks(env, { max: Math.min(Number(body.max) || 3, 10), force: !!body.force }), origin);
  }
  /* the sales pipe. Reachable on purpose so its inertness is provable rather
     than asserted: with SHIR_LEADS unset it answers skipped and dials nobody. */
  if (body.leads) {
    return okJson(await runShirLeadDial(env, { max: Math.min(Number(body.max) || 3, 10) }), origin);
  }
  const res = await runShirDispatch(env, { max: body.max, force: !!body.force });
  if (res.why === 'not-configured') return deny(503, 'shir-not-configured', origin);
  if (res.why === 'reader-failed') return deny(502, 'reader-failed', origin);
  return okJson(res, origin);
}

/* ══ שיר · הצד הנכנס ════════════════════════════════════════════════════════
   Somebody rings +972555074446 back. Retell asks THIS endpoint who they are
   before the agent opens its mouth, and answers with dynamic variables and
   metadata; the agent then greets them by name with a script written for a
   call they placed, not one we placed.

   Until this existed the number pointed the same agent at both directions:
   an inbound caller heard the outbound chase script with every variable
   empty, and the call was never written anywhere because the end-of-call
   handler dropped anything without a guest_id.
   ─────────────────────────────────────────────────────────────────────────── */

/* Why a 60-second cache of the whole snapshot, and not a phoneidx:<phone> map
   rebuilt once a day:

   An inbound caller is almost always somebody who got our WhatsApp minutes
   ago. A list uploaded at 10:00 must be recognised at 10:05, and a daily
   index would greet that guest as a stranger for the rest of the day — the
   single worst failure this endpoint has. Sixty seconds is fresh enough for
   that and still caps the cost at one Make operation per minute no matter how
   many calls arrive, which is far below what an inbound line can generate.

   The whole snapshot is cached rather than a phone→name map because the
   script also needs the event facts (host, date, venue, time), and those come
   from the same read — building a slimmer index would cost a second one.

   Shared deliberately: the callback drain reads it too, so a tick that rings
   three people back pays for one snapshot, not three. */
async function snapshotCached(env, maxAgeSec = 60) {
  if (!env.RATE) return fetchSnapshot(env.HOOK_STATUS);
  let hit = null;
  try { hit = JSON.parse(await env.RATE.get('snapcache')); } catch {}
  if (hit && hit.raw && Number.isFinite(hit.at) && Date.now() - hit.at < maxAgeSec * 1000) {
    return hit.raw;
  }
  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (raw) {
    await env.RATE.put('snapcache', JSON.stringify({ at: Date.now(), raw }),
      { expirationTtl: 900 }).catch(() => {});
    return raw;
  }
  /* Make is down. A stale snapshot beats greeting a known guest as a stranger,
     so the last good one is served rather than nothing. */
  return (hit && hit.raw) || null;
}

/* The inbound webhook is unauthenticated by nature — Retell POSTs it from
   their infrastructure — and it turns a phone number into a person's name.
   So the URL carries a secret derived from RETELL_KEY: nothing new to store,
   nothing to leak into a config file, and it rotates when the key does.
   A valid Retell signature is accepted as well, in case they start signing
   this event; an admin key is accepted for testing. */
async function inboundSecret(env) {
  return (await sha256Hex('shir-inbound|v1|' + String(env.RETELL_KEY || ''))).slice(0, 32);
}

/* ── the fast callback queue ──
   cbq:<phone> — somebody rang us and we did not get to talk to them. This is
   the hottest lead the system has: they dialled US. The pacer empties this
   before it touches the guest queue.

   The entry is written the moment the call ARRIVES, not when it fails, and a
   call that gets properly answered deletes its own entry at the end. That way
   a call which never reached Shir at all — concurrency limit, a Retell error,
   a caller who hung up mid-ring, anything that produces no end-of-call event
   — still gets a ring back, with no sweeper needed to notice the silence.
   The grace period below is what makes that safe: a normal thirty-second call
   clears itself minutes before the drain would look at it. */
const CBQ_GRACE_MS = 5 * 60 * 1000;
const CBQ_MAX_TRIES = 3;
const CBQ_TTL_S = 3 * 86400;
const CBQ_RETRY_MS = 45 * 60 * 1000;

/* Only two things stop a callback: Richard pulled the number out of calling
   by hand (nocall:), or the number is blocked outright (block:).
   optout: is NOT checked here, and that is on purpose — it means "stop
   WhatsApping me", it has never meant "stop calling me", and conflating the
   two is a standing rule in this project. */
async function callBlocked(env, phone) {
  if (!env.RATE) return false;
  const p = normPhone(phone);
  if (!p) return true;
  return !!(await env.RATE.get('nocall:' + p)) || !!(await env.RATE.get('block:' + p));
}

/* "טעות" — this phone was marked wrong-number for ONE event. Both messages
   and calls stop for that event: a wrong number is a wrong person, so ringing
   them about it is as bad as texting them. Everything else about the number
   stays untouched. */
async function wrongNum(env, token, phone) {
  if (!env.RATE || !token) return false;
  const p = normPhone(phone);
  if (!p) return false;
  return !!(await env.RATE.get('wrong:' + token + ':' + p));
}

async function cbqEnqueue(env, phone, why) {
  if (!env.RATE) return false;
  const p = normPhone(phone);
  if (!p || await callBlocked(env, p)) return false;
  /* never queue our own line: a ring-back that reported the wrong side of the
     call would otherwise have Shir dialling herself, forever */
  if (env.SHIR_FROM && normPhone(env.SHIR_FROM) === p) return false;
  let cur = null;
  try { cur = JSON.parse(await env.RATE.get('cbq:' + p)); } catch {}
  const rec = {
    at: (cur && cur.at) || Date.now(),
    tries: (cur && Number(cur.tries)) || 0,
    last: (cur && Number(cur.last)) || 0,
    why: String(why || 'inbound'),
  };
  await env.RATE.put('cbq:' + p, JSON.stringify(rec), { expirationTtl: CBQ_TTL_S });
  return true;
}

async function cbqClear(env, phone) {
  if (!env.RATE) return;
  const p = normPhone(phone);
  if (p) await env.RATE.delete('cbq:' + p).catch(() => {});
}

/* Ring back everyone in the queue, oldest first. Same window, same holiday
   rule and same pause switch the guest dialler obeys — a hot lead is not a
   licence to call somebody on Yom Kippur.

   The callback speaks the INBOUND script, not the chase script: they rang us,
   so "we sent you an invitation and saw no reply" is the wrong sentence.
   That is what override_agent_id is for. */
async function runShirCallbacks(env, { max = 3, force = false } = {}) {
  if (!env.RETELL_KEY || !env.SHIR_FROM || !env.RATE) return { dialed: 0, why: 'not-configured' };
  if (await sendingPaused(env)) return { dialed: 0, why: 'paused' };
  const today = ilDate();
  if (isNoContactDay(today) && !force) return { dialed: 0, why: 'no-contact-day' };
  const win = callWindowState();
  if (!win.open && !force) return { dialed: 0, why: win.why };

  const raw0 = await kvPrefix(env, 'cbq:');
  const rows = [];
  for (const [phone, v] of Object.entries(raw0)) {
    let rec = null;
    try { rec = JSON.parse(v); } catch {}
    if (!rec) { await env.RATE.delete('cbq:' + phone).catch(() => {}); continue; }
    rows.push({ phone, ...rec });
  }
  rows.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));

  const now = Date.now();
  const dialed = [];
  let waiting = 0, skipped = 0, snap;
  for (const r of rows) {
    if (dialed.length >= max) break;
    if (Number(r.tries) >= CBQ_MAX_TRIES) { await cbqClear(env, r.phone); skipped++; continue; }
    /* a call still in progress, or one that just ended and will clear itself */
    if (now - (Number(r.at) || 0) < CBQ_GRACE_MS && !force) { waiting++; continue; }
    if (Number(r.last) && now - Number(r.last) < CBQ_RETRY_MS && !force) { waiting++; continue; }
    if (await callBlocked(env, r.phone)) { await cbqClear(env, r.phone); skipped++; continue; }

    if (snap === undefined) snap = await snapshotCached(env).catch(() => null);
    /* looked up fresh rather than replayed from the queue entry: between the
       missed call and the ring back, the guest may have answered on WhatsApp */
    const hit = snap ? inboundLookup(snap, r.phone, today) : { caller_kind: 'unknown', phone: r.phone, name: '' };
    const meta = inboundMetadata(hit, { callback: true });
    const target = {
      kind: 'callback', phone: r.phone, hit,
      guest_id: meta.guest_id || '', token: meta.token || '',
      tries: meta.tries || '0', max_tries: meta.max_tries || '3',
    };
    const res = await fetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCallPayload(target, env.SHIR_FROM,
        { override_agent_id: env.SHIR_INBOUND_AGENT || '' })),
    }).catch(() => null);
    if (res && (res.status === 200 || res.status === 201)) {
      dialed.push(r.phone);
      await env.RATE.put('cbq:' + r.phone,
        JSON.stringify({ ...r, phone: undefined, tries: (Number(r.tries) || 0) + 1, last: now }),
        { expirationTtl: CBQ_TTL_S });
    }
  }
  if (dialed.length) {
    await slackPost(env, `📲 שיר חזרה ל-${dialed.length} מי שהתקשרו אלינו ולא ענינו.`);
  }
  return { dialed: dialed.length, phones: dialed, queued: rows.length, waiting, skipped };
}

/* ══ שיר · שיחת מכירה — the pipe, deliberately not connected ═════════════════
   Richard wants Shir to ring leads who walked away before paying. Everything
   structural for that exists now and nothing dials:

     · metadata.kind = 'lead', so the calls feed separates a sales call from
       an RSVP call the moment the first one happens
     · leadVariables / leadFromRow in shir.js — a lead has no host, no venue
       and no seat count, so it must never be fed the guest variable set
     · lq:<phone> as its own queue, drained here, never mixed with the guest
       queue or the callback queue

   THREE things are missing before this may ring one human being:
     1. a sales agent + LLM in Retell, and its id in SHIR_LEAD_AGENT
        (wrangler.toml [vars]). The RSVP script would be nonsense on a lead.
     2. env.SHIR_LEADS = 'on'. The master switch. Deliberately absent.
     3. Richard's call on consent: a lead who filled in a form is not the same
        as a guest whose own host handed us their number. Until that is
        decided, this function returns without touching Retell.
   All three are required; any one missing and the drain is a no-op. */
async function runShirLeadDial(env, { max = 3 } = {}) {
  const ready = String(env.SHIR_LEADS || '') === 'on' && !!env.SHIR_LEAD_AGENT;
  if (!ready) return { dialed: 0, skipped: 'lead-calling-disabled' };
  /* Every guard the guest dialler obeys applies here too, and one more:
     a lead who already paid is a client, not a prospect. */
  if (!env.RETELL_KEY || !env.SHIR_FROM || !env.RATE) return { dialed: 0, skipped: 'not-configured' };
  if (await sendingPaused(env)) return { dialed: 0, skipped: 'paused' };
  const today = ilDate();
  if (isNoContactDay(today)) return { dialed: 0, skipped: 'no-contact-day' };
  if (!callWindowState().open) return { dialed: 0, skipped: 'window' };

  const snap = await snapshotCached(env).catch(() => null);
  const rows = (snap && snap.leads && snap.leads.values) || [];
  const queued = await kvPrefix(env, 'lq:');
  const dialed = [];
  for (const phone of Object.keys(queued)) {
    if (dialed.length >= max) break;
    if (await callBlocked(env, phone)) { await env.RATE.delete('lq:' + phone).catch(() => {}); continue; }
    const row = rows.find(r => normPhone(r && r[2]) === phone);
    if (!row) { await env.RATE.delete('lq:' + phone).catch(() => {}); continue; }
    const lead = leadFromRow(row);
    if (lead.paid) { await env.RATE.delete('lq:' + phone).catch(() => {}); continue; }
    const res = await fetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCallPayload(lead, env.SHIR_FROM,
        { override_agent_id: env.SHIR_LEAD_AGENT })),
    }).catch(() => null);
    if (res && (res.status === 200 || res.status === 201)) {
      dialed.push(phone);
      await env.RATE.delete('lq:' + phone).catch(() => {});
    }
  }
  return { dialed: dialed.length, phones: dialed };
}

/* POST /api/shir-inbound?k=<secret>
   Retell's call_inbound event. Answers within one snapshot read, always 200:
   a non-2xx here would make Retell drop or mishandle a live call, so every
   internal failure degrades to "we do not know this number" instead.

   Also accepts {admin_key, from_number} for testing, and {admin_key} alone,
   which hands back the URL to register on the phone number. */
async function handleShirInbound(request, env, url, origin) {
  if (Number(request.headers.get('Content-Length') || 0) > 65536) {
    return deny(413, 'too-large', origin);
  }
  const rawBody = await request.text();
  let body = {};
  try { body = JSON.parse(rawBody || '{}'); } catch { return deny(400, 'bad-json', origin); }

  const admin = isAdmin(env, body.admin_key);
  if (!admin) {
    if (!env.RETELL_KEY) return deny(503, 'shir-not-configured', origin);
    const k = String(url.searchParams.get('k') || '');
    const want = await inboundSecret(env);
    const sig = request.headers.get('X-Retell-Signature') || '';
    const signed = !!sig && await verifyRetellSignature(rawBody, sig, env.RETELL_KEY);
    if (!safeEqual(k, want) && !signed) return deny(403, 'bad-inbound-key', origin);
  }

  const ci = body.call_inbound || {};
  const from = String(body.from_number || ci.from_number || '').trim();

  /* admin, no number: the install URL, so the secret never has to be printed
     anywhere it could be pasted by accident */
  if (admin && !from) {
    return okJson({
      ok: true,
      webhook_url: `https://${url.host}/api/shir-inbound?k=${await inboundSecret(env)}`,
      inbound_agent: String(env.SHIR_INBOUND_AGENT || ''),
    }, origin);
  }

  const phone = normPhone(from);
  const today = ilDate();
  /* Never hold a ringing phone hostage to Make. Four seconds and the call
     goes ahead as an unknown caller, which the script handles by asking. */
  const raw = await Promise.race([
    snapshotCached(env).catch(() => null),
    new Promise(r => setTimeout(() => r(null), 4000)),
  ]);
  const hit = raw ? inboundLookup(raw, phone, today) : { caller_kind: 'unknown', phone, name: '', event: null };

  const answer = {
    call_inbound: {
      dynamic_variables: inboundVariables(hit),
      metadata: inboundMetadata(hit),
    },
  };
  /* Belt and braces: even if the number's inbound_agents binding is ever
     reverted to the outbound agent, an inbound call still lands on the
     inbound script. This is the bug that started all of this. */
  if (env.SHIR_INBOUND_AGENT) answer.call_inbound.override_agent_id = String(env.SHIR_INBOUND_AGENT);

  if (!admin) {
    /* provisional callback entry — see CBQ_GRACE_MS above for why it goes in
       now and not on failure */
    await cbqEnqueue(env, phone, 'inbound-ring').catch(() => {});
    if (env.RATE) {
      const day = 'inbday:' + today;
      const n = (parseInt(await env.RATE.get(day) || '0', 10) || 0) + 1;
      await env.RATE.put(day, String(n), { expirationTtl: 40 * 86400 }).catch(() => {});
    }
  }

  if (admin) {
    return okJson({
      ok: true, snapshot: !!raw, phone,
      lookup: {
        caller_kind: hit.caller_kind, name: hit.name || '',
        guest_id: hit.guest_id || '', token: hit.token || '',
        rsvp: hit.rsvp || '', tries: hit.tries || 0, max_tries: hit.max_tries || 0,
      },
      ...answer,
    }, origin);
  }
  return okJsonPlain(answer);
}

/* ══ WhatsApp inbound — the RSVP buttons land here ═══════════════════════════
   Meta calls this URL for every reply to our numbers. A button tap or a
   text answer becomes the same call_result write the calls page uses; a bare
   "מגיע" gets a follow-up question about party size, whose numeric answer is
   matched back through a short-lived KV marker. הסר is honored immediately.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleWaWebhook(request, env, url) {
  /* Meta's one-time verification handshake */
  if (request.method === 'GET') {
    const p = url.searchParams;
    if (p.get('hub.mode') === 'subscribe' && env.WA_VERIFY && p.get('hub.verify_token') === env.WA_VERIFY) {
      return new Response(p.get('hub.challenge') || '', { status: 200 });
    }
    return new Response('forbidden', { status: 403 });
  }
  /* No app secret for HMAC — the shared token rides the callback URL instead */
  if (!env.WA_VERIFY || url.searchParams.get('t') !== env.WA_VERIFY) {
    return new Response('forbidden', { status: 403 });
  }

  let payload;
  try { payload = await request.json(); } catch { return new Response('ok', { status: 200 }); }

  for (const { from, msg, phoneId, profileName } of extractInbound(payload)) {
    try {
    /* Meta retries a delivery until it gets a 200, and one slow reply is
       enough to earn a retry. Without this the guest is answered twice and
       the sheet is written twice. msg.id is Meta's stable per-message id. */
    if (msg.id && await seenOnce(env, 'wain:' + msg.id)) continue;
    const parsed = parseInboundReply(msg);
    /* full inbound log — every message from every number, always */
    if (env.RATE) {
      /* which of our two numbers received this — the inbox filters on it */
      const ch = (env.WA_PHONE_ID_GUESTS && phoneId === env.WA_PHONE_ID_GUESTS) ? 'guests' : 'client';
      const ts = Date.now();
      const body = (parsed ? textOf(parsed) : '').slice(0, 300);
      /* kept forever, on purpose: this is the record of the conversation */
      await env.RATE.put('log:' + from + ':' + ts,
        JSON.stringify({
          dir: 'in', type: msg.type, ch,
          text: body,
          at: new Date().toISOString(),
        })).catch(() => {});
      await touchConversation(env, from, { ts, dir: 'in', text: body, ch }).catch(() => {});
      /* the WhatsApp profile name, refreshed on every inbound */
      if (profileName) {
        await env.RATE.put('waname:' + from, profileName.slice(0, 60)).catch(() => {});
      }
    }
    /* an Excel/CSV on WhatsApp = the guest list, same pipeline as the site */
    if (msg.type === 'document' && msg.document) {
      await waGuestFile(env, from, msg.document).catch(async (e) => {
        await alert(env, 'קובץ בוואטסאפ', 'קליטת קובץ נכשלה', `${from}: ${e && e.message}`);
        await sendText(env, from, 'משהו השתבש בקליטת הקובץ. אפשר לנסות שוב, או להעלות דרך הקישור האישי 🙂');
      });
      continue;
    }
    if (!parsed) continue;

    /* reply-rate attribution: one inbound credits the last template sent */
    if (env.RATE) {
      try {
        const lo = await env.RATE.get('lastout:' + from);
        if (lo) {
          const { tmpl, occ } = JSON.parse(lo);
          const tk = `tstat:${tmpl}:${occ || '-'}`;
          let st = { sent: 0, fail: 0, replied: 0 };
          try { st = JSON.parse(await env.RATE.get(tk)) || st; } catch {}
          st.replied += 1;
          await env.RATE.put(tk, JSON.stringify(st), { expirationTtl: 400 * 86400 });
          await env.RATE.delete('lastout:' + from);
        }
      } catch {}
    }

    /* stop the calls, keep the messages */
    if (parsed.kind === 'nocall') {
      if (env.RATE) await env.RATE.put('nocall:' + normPhone(from), new Date().toISOString());
      await sendText(env, from, 'סגור, לא נתקשר יותר 🙏 אפשר לעדכן הגעה כאן בהודעה בכל רגע.');
      continue;
    }
    if (parsed.kind === 'optout') {
      if (env.RATE) await env.RATE.put('optout:' + normPhone(from), new Date().toISOString());
      await sendText(env, from, 'הוסרת מרשימת התפוצה. לא נשלח לך עוד הודעות 🙏');
      continue;
    }

    const raw = await fetchSnapshot(env.HOOK_STATUS);
    /* WHO is this, in Richard's order of precedence. An event OWNER is a
       client even when their own number also sits in a guest row (his test
       wedding did exactly that, and Noa answered the boss with "כמה תהיו?").
       On the client number there are only two kinds of people: clients and
       leads. Guest logic runs for a matched guest who is NOT an owner — those
       are invitation replies riding the client number until the guests
       number is connected (AUT-884). */
    const ownEvents = raw ? eventsForPhone(raw, normPhone(from)) : [];
    const isClient = ownEvents.length > 0 ||
      !!(env.RATE && await env.RATE.get('client:' + normPhone(from)));
    const guest = (!isClient && raw) ? findGuestByPhone(raw, from, ilDate()) : null;

    /* wrong number: silence this event for this phone, nothing else */
    if (parsed.kind === 'mistake') {
      if (guest && guest.token && env.RATE) {
        await env.RATE.put('wrong:' + guest.token + ':' + normPhone(from),
          new Date().toISOString(), { expirationTtl: 400 * 86400 });
        await slackPost(env, `↩️ מספר סומן "טעות" · ${from} · אירוע ${guest.token.slice(0, 8)} — הושתק לאירוע הזה בלבד (הודעות ושיחות)`);
      }
      await sendText(env, from, 'תודה על העדכון, וסליחה על ההפרעה 🙏 לא תגיע אליכם עוד הודעה על האירוע הזה.');
      continue;
    }

    if (!guest) {
      /* a client or a lead — never guest language (Richard's rule: Noa does
         not speak to guests; she checks the sheet and picks one of two
         voices) */
      await serviceReply(env, from, textOf(parsed), {
        kind: isClient ? 'client' : 'lead',
        events: ownEvents.map(e => e.event_name || e.occasion || '').filter(Boolean).slice(0, 3),
      });
      continue;
    }

    /* answering "how many of you?" — a bare number, but also "אנחנו 4",
       "נהיה שלושה" or "לבד", which people write far more often */
    if (env.RATE) {
      const pending = await env.RATE.get('awaitparty:' + guest.guest_id);
      if (pending) {
        const n = parsed.kind === 'party' ? parsed.party : partyFromText(textOf(parsed));
        if (n) {
          await env.RATE.delete('awaitparty:' + guest.guest_id);
          const saved = await writeGuestReply(env, guest, 'מגיע', n);
          await sendText(env, from, saved
            ? `מעולה, רשמנו ${n} 🎉 נתראה בשמחות!`
            : 'קיבלנו, רגע רושמים ונחזור אליכם 🙂');
          continue;
        }
      }
    }
    if (parsed.kind === 'party') continue; // a number with no open question

    if (parsed.kind === 'rsvp') {
      /* never confirm what the sheet did not take */
      const HOLD = 'קיבלנו את התשובה, רגע רושמים ונחזור אליכם 🙂';
      if (parsed.outcome === 'מגיע' && !parsed.party) {
        const saved = await writeGuestReply(env, guest, 'מגיע');
        if (saved && env.RATE) await env.RATE.put('awaitparty:' + guest.guest_id, '1', { expirationTtl: 86400 });
        await sendText(env, from, saved
          ? 'איזה כיף! כמה תהיו בסך הכל?'
          : HOLD);
      } else if (parsed.outcome === 'מגיע') {
        const saved = await writeGuestReply(env, guest, 'מגיע', parsed.party);
        await sendText(env, from, saved ? `נרשם, ${parsed.party} מגיעים 🎉` : HOLD);
      } else if (parsed.outcome === 'לא מגיע') {
        const saved = await writeGuestReply(env, guest, 'לא מגיע');
        await sendText(env, from, saved ? 'חבל שלא תהיו, תודה שעדכנתם 🙏' : HOLD);
      } else {
        const saved = await writeGuestReply(env, guest, 'מתלבט');
        await sendText(env, from, saved ? 'אין לחץ, אפשר לעדכן כאן בכל רגע 🙂' : HOLD);
      }
    }
    /* "בוצע AUT-123" closes a team reminder before the service brain answers */
    if (parsed.kind === 'text') {
      const done = await markTaskDone(env, parsed.body).catch(() => null);
      if (done) {
        await sendText(env, from, 'סומן ✓ ' + done + ' ירד מהתזכורות. כל הכבוד!');
        continue;
      }
      await serviceReply(env, from, parsed.body);
    }
    } catch (e) {
      await alert(env, 'וובהוק וואטסאפ', 'שגיאה בטיפול בהודעה נכנסת', `${from}: ${e && e.message}`);
    }
  }
  return new Response('ok', { status: 200 });
}

/* ══ customer service — every message gets an answer ═════════════════════════
   Order of play:
     1. "didn't get my link / I paid" → verify against claimlink:<phone>,
        re-send the personal upload link.
     2. Anything else → the AI answers from the editable sheet brain
        (tab "מוח שירות": B1 kill-switch, B2 persona, rows 5+ are Q→A pairs).
     3. AI off/down → warm human fallback. Silence is never an option.
   Every exchange is logged to KV (inbox:<phone>:<ts>) for the inbox phase.
   ─────────────────────────────────────────────────────────────────────────── */

function textOf(parsed) {
  if (parsed.kind === 'text') return parsed.body;
  if (parsed.kind === 'party') return String(parsed.party);
  if (parsed.kind === 'rsvp') return parsed.outcome;
  return '';
}

const FALLBACK_REPLY = 'היי! כאן הצוות של ishur.io 🙂 קיבלנו את ההודעה ונחזור אליכם ממש בקרוב.';

async function serviceReply(env, from, text, who) {
  const t = String(text || '').trim();
  if (!t) return;

  let reply = '';

  /* 1 · paid client asking for their link */
  if (/קישור|לינק|לא קיבלתי|שילמ|תשלום|רכשתי|קניתי|העלא|איפה ממשיכ/.test(t)) {
    const token = env.RATE ? await env.RATE.get('claimlink:' + normPhone(from)) : null;
    if (token) {
      reply = 'בדקתי, התשלום שלך אצלנו ✅\n' +
        'הנה הקישור האישי להעלאת רשימת המוזמנים והגדרת האירוע:\n' +
        'https://ishur.io/upload.html?t=' + token + '\n\n' +
        'זה לוקח 3 דקות, ואני כאן לכל שאלה 🙂';
    } else if (/שילמ|תשלום|רכשתי|קניתי|לא קיבלתי/.test(t)) {
      reply = 'רגע, בודקים 🙂 לא מצאתי תשלום שמשויך למספר הזה. ' +
        'יכול להיות שהתשלום בוצע עם מספר טלפון אחר. ' +
        'נציג עובר על זה עכשיו ויחזור אליכם ממש בקרוב.';
    }
  }

  /* 2 · the sheet-brain AI */
  if (!reply) reply = (await aiReply(env, from, t, who)) || '';

  /* 3 · never silent */
  if (!reply) reply = FALLBACK_REPLY;

  await sendText(env, from, reply);
  if (env.RATE) {
    await env.RATE.put('inbox:' + normPhone(from) + ':' + Date.now(),
      JSON.stringify({ in: t.slice(0, 500), out: reply.slice(0, 500), at: new Date().toISOString() }),
      { expirationTtl: 90 * 86400 }).catch(() => {});
  }
}

/* The brain lives in the sheet so Richard edits it like text, no deploys.
   Cached in KV for 3 minutes — the kill-switch bites within that window. */
async function getBrain(env) {
  const fallback = { active: false, persona: '', faq: [] };
  if (!env.BRAIN_HOOK) return fallback;
  if (env.RATE) {
    const hit = await env.RATE.get('brain:cache');
    if (hit) { try { return JSON.parse(hit); } catch {} }
  }
  const r = await fetch(env.BRAIN_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchGet',
      qk1: 'ranges', qv1: 'מוח שירות!A1:D80',
    }),
  }).catch(() => null);
  if (!r || !r.ok) return fallback;
  let rows = [];
  try { rows = (await r.json()).valueRanges[0].values || []; } catch { return fallback; }
  const cell = (i, j) => String((rows[i] || [])[j] || '').trim();
  const brain = {
    active: !/כבוי/.test(cell(0, 1)),
    persona: cell(1, 1),
    reviewLink: cell(0, 3),      // D1 — Google review link for the end-of-event message
    testimonialLink: cell(1, 3), // D2 — video-testimonial tool link
    faq: rows.slice(4).map(x => [String(x[0] || '').trim(), String(x[1] || '').trim()])
      .filter(x => x[0] && x[1]).slice(0, 60),
  };
  if (env.RATE) await env.RATE.put('brain:cache', JSON.stringify(brain), { expirationTtl: 180 }).catch(() => {});
  return brain;
}

/* the last few exchanges with this phone, oldest first — real chat memory */
async function chatHistory(env, from, limit = 6) {
  if (!env.RATE || !env.RATE.list) return [];
  const prefix = 'inbox:' + normPhone(from) + ':';
  const page = await env.RATE.list({ prefix, limit: 1000 }).catch(() => null);
  if (!page) return [];
  const names = page.keys.map(k => k.name).sort().slice(-limit);
  const out = [];
  for (const n of names) {
    try {
      const e = JSON.parse(await env.RATE.get(n));
      if (e && e.in) out.push({ role: 'user', content: e.in });
      if (e && e.out) out.push({ role: 'assistant', content: e.out });
    } catch {}
  }
  return out;
}

async function aiReply(env, from, text, who) {
  if (!env.AI) return null;
  const brain = await getBrain(env);
  if (!brain.active) return null;

  /* per-phone daily cap so a prankster can't burn the budget */
  if (env.RATE) {
    const key = 'aicount:' + normPhone(from) + ':' + ilDate();
    const n = Number(await env.RATE.get(key)) || 0;
    if (n >= 20) return null;
    await env.RATE.put(key, String(n + 1), { expirationTtl: 86400 }).catch(() => {});
  }

  const history = await chatHistory(env, from);

  /* who is on the line, stated as fact so the model cannot guess wrong.
     There is deliberately no "guest" identity here at all. */
  const callerLine = who && who.kind === 'client'
    ? '\n\nמי מולך: לקוח/ה קיים/ת של ishur' +
      (who.events && who.events.length ? ' (אירועים: ' + who.events.join(', ') + ')' : '') +
      '. דברי כמו נציגת שירות ללקוח משלם: קצר, מקצועי, פותרת. אל תשאלי שאלות של אורח (כמה תהיו, מגיעים?) לעולם.'
    : '\n\nמי מולך: ליד — מתעניין/ת שעוד לא רכש/ה. המטרה: לעזור, לענות קצר, ולהוביל בעדינות לרכישה באתר ishur.io. אל תדברי אליו/ה כאילו הוזמנו לאירוע ואל תשאלי שאלות של אורח לעולם.';

  const sys = callerLine.slice(2) + '\n\n' + (brain.persona || 'את נציגת שירות חמה של ishur.io — שירות אישורי הגעה לאירועים בוואטסאפ.') +
    '\n\nכללים קשיחים:' +
    '\n- זו שיחת וואטסאפ מתמשכת. קראי את ההיסטוריה ועני בהמשך טבעי לה.' +
    '\n- אסור להציג את עצמך ("אני נועה") אם כבר הצגת את עצמך קודם בשיחה, או אם לא שאלו מי את. פעם אחת לכל היותר.' +
    '\n- אסור לחזור על משפטים או ניסוחים שכבר כתבת בשיחה.' +
    '\n- עני כמו בן אדם בצ׳אט: משפט אחד עד שלושה, ישיר, בלי פתיחים מנופחים. אימוג׳י לפעמים, לא בכל הודעה.' +
    '\n- כתיבה אנושית: בלי קו מפריד ארוך (—) בכלל, פסיק או נקודה במקום. בלי "חשוב לציין", "לסיכום", "יתרה מזאת". בלי לחזור על השאלה לפני שעונים. בלי סיכומים ריקים בסוף. משפטים באורכים משתנים.' +
    '\n- אל תמציאי מחירים, קישורים או הבטחות. הקישור היחיד שמותר להזכיר: ishur.io' +
    '\n- אם אין תשובה בטוחה בידע למטה, כתבי בקצרה שתבדקי ותחזרי.' +
    '\n- לעולם אל תגידי שאת בוט או AI.' +
    '\n\nידע (שאלה → תשובה):\n' +
    brain.faq.map(x => '• ' + x[0] + ' → ' + x[1]).join('\n');

  try {
    const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: sys },
        ...history,
        { role: 'user', content: String(text).slice(0, 800) },
      ],
      max_tokens: 300, temperature: 0.6,
    });
    const out = String((r && r.response) || '').trim();
    return out || null;
  } catch { return null; }
}

/* An RSVP from WhatsApp resolves the guest without touching the call fields */
/* Returns whether the sheet actually took the answer. The guest is only told
   "נרשם" when it did — otherwise we keep the reply and say we are on it. */
async function writeGuestReply(env, guest, outcome, party) {
  const r = await fetch(env.HOOK_EVENTS, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'call_result', guest_id: guest.guest_id,
      rsvp: outcome,
      call_status: outcome === 'מתלבט' ? '__keep__' : '',
      answer: 'ענה בוואטסאפ',
      tries: '__keep__',
      party: party != null ? String(party) : '__keep__',
      ts: new Date().toISOString(),
    }),
  }).catch(() => null);
  const ok = !!r && r.status === 200;
  if (!ok && env.RATE) {
    await env.RATE.put('rsvpfail:' + guest.guest_id + ':' + Date.now(),
      JSON.stringify({ guest_id: guest.guest_id, outcome, party: party ?? null, at: new Date().toISOString() }),
      { expirationTtl: 30 * 86400 }).catch(() => {});
    await alert(env, 'תשובת אורח לא נשמרה',
      `RSVP של ${guest.guest_id} (${outcome}) לא נכתב לגיליון — נשמר לשחזור`, '');
  }
  return ok;
}

/* ══ daily engine · stage 1: the week-before report ══════════════════════════
   Runs every morning (cron) and on demand via /api/daily-run.
   One report per event, the first non-Shabbat day within 7 days of the event:
   ishur_doch to the client with confirmed / diners / declined / pending and
   their personal dashboard link. KV flag report7:<token> makes it fire once.
   ─────────────────────────────────────────────────────────────────────────── */
function heDate(iso) {
  const p = String(iso || '').slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
}

/* one sending wave to the guests of one event. Guests are skipped when they
   opted out, and (for reminders) when they already answered. */
async function sendWave(env, ev, token, guests, wave, dry, budget) {
  const occasion = String(ev[5] || '').trim() || 'אירוע';
  const hosts = String(ev[34] || ev[2] || '').trim() || 'בעלי השמחה';
  const date = heDate(String(ev[6] || '').trim());
  const time = String(ev[36] || '').trim() || 'בשעות הערב';
  const venue = [String(ev[38] || '').trim(), String(ev[37] || '').trim()].filter(Boolean).join(', ') || 'פרטים בהמשך';
  /* the artwork the client uploaded (column AS). The template has an image
     header, and leaving this empty meant every invitation went out as plain
     text while their design sat unused in the sheet. */
  const invite = String(ev[44] || '').trim();

  /* which invitation template. v2 adds the small-print footer ("נשלח ע\"י
     ishur.io · הגיע בטעות? השיבו טעות") but starts life PENDING at Meta, and a
     pending template fails every send — so the name lives in KV and flips only
     after approval: wrangler kv key put invitetmpl hazmana_ishur_v2 --remote.
     Editing the live template instead would have parked it in review and
     silenced every wave meanwhile. */
  const inviteTmpl = (env.RATE && await env.RATE.get('invitetmpl')) || 'hazmana_ishur';
  let sent = 0, skippedOptout = 0, skippedAnswered = 0, failed = 0, skippedDone = 0;
  let truncated = false;
  /* the sheet is the source of truth, so every delivered invitation is written
     back to the guest's own row — תאריך שליחה 1/2/3 (columns I/J/K) — in one
     batched call after the loop. __row was stamped when the snapshot loaded. */
  const okRows = [];
  /* Where the previous tick stopped. Without this, tick 14 of a 400-guest
     wedding re-walked 325 already-handled guests at 2-3 KV reads each — a
     thousand subrequests before the first new invitation, which is the
     ceiling, which killed the tick, every tick (review finding #2). Guests
     before the cursor were all settled: sent (wsent:), declined, answered, or
     suppressed — all states that do not come back. A failure does NOT advance
     the cursor, so failed guests are retried from exactly where they stand. */
  const posKey = `wpos:${token}:${wave.key}`;
  let start = 0;
  if (!dry && env.RATE) start = parseInt(await env.RATE.get(posKey), 10) || 0;
  if (start > guests.length) start = 0;   // the list shrank; walk it again, wsent: dedupes
  let cursor = start;
  const seenPhones = new Set();
  for (let gi = start; gi < guests.length; gi++) {
    const g = guests[gi];
    /* A wave of 300 does not fit in one Worker invocation — Cloudflare caps
       subrequests, and a 300-guest blast at 09:35 is a spam signature besides.
       The budget stops the loop early; wsent: makes the next tick resume from
       exactly here rather than starting over. */
    if (budget && budget.left <= 0) { truncated = true; break; }
    const phone = String(g[4] || '').trim();
    if (!phone || seenPhones.has(phone)) { cursor = gi + 1; continue; }
    seenPhones.add(phone);
    const rsvp = String(g[15] || '').trim();
    const answered = rsvp !== '';
    /* a declined guest is out of the funnel for good: no reminder, no extra
       send, nothing. Only מגיע, מתלבט and people who never answered continue. */
    if (rsvp === 'לא מגיע') { skippedAnswered++; cursor = gi + 1; continue; }
    if (wave.onlyUnanswered && answered) { skippedAnswered++; cursor = gi + 1; continue; }
    /* dry runs never touch KV state */
    if (dry) { sent++; if (budget) budget.left--; continue; }
    /* wsent: FIRST — it is one read and it is true for every guest a previous
       tick handled, where phoneBlocked+wrongNum are three (finding #2) */
    const gkEarly = `wsent:${token}:${wave.key}:${normPhone(phone)}`;
    if (env.RATE && await env.RATE.get(gkEarly)) { skippedDone++; cursor = gi + 1; continue; }
    if (await phoneBlocked(env, phone)) { skippedOptout++; cursor = gi + 1; continue; }
    if (await wrongNum(env, token, phone)) { skippedOptout++; cursor = gi + 1; continue; }
    /* per-guest marker: the wave flag is only written after the whole loop, so
       a run cut short (subrequest ceiling, an exception) would otherwise start
       from the top tomorrow and message everyone a second time */
    const gk = gkEarly;
    const name = String(g[3] || '').trim() || 'אורח יקר';
    /* hazmana_ishur was approved with a BODY and buttons and NO image header,
       verified against Meta. Passing an image adds a header component the
       approved template does not have, and Meta rejects the whole send
       (132000) — so every client who uploaded artwork would have had their
       entire wave fail. The artwork goes as its own message right after. */
    const res = await sendTemplate(env, phone, inviteTmpl,
      [name, occasion, hosts, date, time, venue], '', 'he', 'guests',
      { occasion, wave: wave.key, token });
    if (budget) budget.left--;
    if (res.ok) {
      sent++;
      cursor = gi + 1;
      if (g.__row) okRows.push(g.__row);
      if (env.RATE) await env.RATE.put(gk, '1', { expirationTtl: 120 * 86400 }).catch(() => {});
      /* the artwork the client uploaded, as its own message. A failure here
         must never cost the invitation, which already landed. */
      if (invite && wave.key === 1) {
        await sendImage(env, phone, invite, '', 'guests').catch(() => null);
      }
    } else failed++;
  }
  if (!dry && env.RATE) {
    if (truncated || failed > 0) {
      await env.RATE.put(posKey, String(cursor), { expirationTtl: 7 * 86400 }).catch(() => {});
    } else {
      await env.RATE.delete(posKey).catch(() => {});
    }
  }
  /* one Make operation for the whole pulse. A failure here never costs the
     wave — the messages already went; the sheet catches up on a later pass. */
  if (!dry && okRows.length) {
    const col = { 1: 'I', 2: 'J', 3: 'K' }[wave.key] || 'I';
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16);
    await sheetBatchWrite(env, okRows.map(row => ({
      range: `אורחים!${col}${row}`, values: [[stamp]],
    }))).catch(() => {});
  }
  return { wave: wave.key, tmpl: inviteTmpl, sent, skippedOptout, skippedAnswered, skippedDone, failed, truncated };
}

async function runDailyEngine(env, dry, todayOverride, opts = {}) {
  /* how many guest messages this invocation may send before it stops and
     leaves the rest for the next tick. null = no ceiling (the nightly run). */
  const budget = opts.budget != null ? { left: Number(opts.budget) } : null;
  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (!raw) {
    await alert(env, 'מנוע יומי', 'אין גישה לנתוני הגיליון — הדוחות לא נשלחו', '');
    return { ok: false, error: 'no-snapshot' };
  }
  /* date override is allowed in dry runs only — for testing tomorrow safely */
  const today = (dry && /^\d{4}-\d{2}-\d{2}$/.test(String(todayOverride || '')))
    ? String(todayOverride) : ilDate();
  const isShabbat = new Date(today + 'T12:00:00Z').getUTCDay() === 6;
  if (isShabbat && !dry) return { ok: true, skipped: 'shabbat' };
  /* חג: no messages, no calls, no "friendly nudge". A holiday that nobody
     configured is the one day a wedding RSVP text is genuinely offensive. */
  if (isNoContactDay(today) && !dry) {
    if (env.RATE && !(await env.RATE.get('holnote:' + today))) {
      await env.RATE.put('holnote:' + today, '1', { expirationTtl: 3 * 86400 });
      await slackPost(env, `🕯️ *${today} מסומן כיום ללא יצירת קשר.* לא נשלחו הודעות ולא בוצעו שיחות. הכל ימשיך מחר.`);
    }
    return { ok: true, date: today, skipped: 'no-contact-day' };
  }

  const evRows = (raw.events && raw.events.values) || [];
  const gRows = (raw.guests && raw.guests.values) || [];
  /* remember where each guest lives in the sheet (values start at A2), so a
     filtered subset can still write its send-stamp back to the right row */
  gRows.forEach((g, i) => { if (g && typeof g === 'object') g.__row = i + 2; });
  const out = [];

  /* the master switch: stop before a single message is composed */
  if (await sendingPaused(env)) {
    if (!dry) await slackPost(env, '⏸️ *המנוע היומי לא רץ* — השליחה מושהית ידנית. להפעלה מחדש: המתג במרכז הבקרה.');
    return { ok: true, date: today, paused: true, events: [] };
  }

  /* keep Meta's cap cached so the 80% alert has a number during the waves */
  await waCapInfo(env).catch(() => null);

  /* ── stage 0.4: left a phone, never paid ────────────────────────────────
     Preview only. The live chase runs from the pacer every ten minutes; doing
     it here too meant the same scan ran twice per tick (review finding #1). */
  if (dry) for (const r of await chaseAbandonedLeads(env, true, budget)) out.push(r);

  /* ── stage 0.5: paid but never uploaded a guest list ──────────────────────
     handleGrowIpn drops pend:<token> at payment; a successful upload deletes
     it. Whatever is still pending a day later gets one friendly nudge with
     the personal link (ishur_tzikoret_kovetz) + a tagged Slack heads-up.   */
  if (env.RATE) {
    try {
      const pend = await kvPrefix(env, 'pend:');
      for (const [token, vRaw] of Object.entries(pend)) {
        let v = null; try { v = JSON.parse(vRaw); } catch {}
        if (!v || !v.phone) { if (!dry) await env.RATE.delete('pend:' + token); continue; }
        if (await env.RATE.get('uploaded:' + token)) { if (!dry) await env.RATE.delete('pend:' + token); continue; }
        const ageDays = Math.round((Date.parse(today) - Date.parse(String(v.at || today).slice(0, 10))) / 864e5);
        if (ageDays < 1) continue;
        if (dry) { out.push({ token, type: 'stuck_client', would_send_to: v.phone }); continue; }
        const first = (String(v.name || '').split(' ')[0] || '').trim() || 'לקוח יקר';
        const wa = await sendClient(env, v.phone, 'ishur_tzikoret_kovetz',
          [first, 'https://ishur.io/upload.html?t=' + token], { token });
        if (wa.ok) {
          await addEvCost(env, token, msgCost('ishur_tzikoret_kovetz'));
          await slackPost(env, `🟠 *לקוח תקוע* · ${v.name || ''} ${v.phone}\nשילם אתמול ולא העלה רשימת מוזמנים. נשלחה תזכורת עם הקישור האישי. אפשר לענות לו מהאינבוקס, והוא גם יכול פשוט לשלוח את האקסל בוואטסאפ.`);
          await env.RATE.delete('pend:' + token);
          await env.RATE.put('pend2:' + token, today, { expirationTtl: 30 * 86400 });
        }
        out.push({ token, type: 'stuck_client', sent: wa.ok });
      }
    } catch (e) { await alert(env, 'לקוח תקוע', 'שלב הבדיקה נפל', String(e && e.message)); }
  }

  /* ── stage 0.55: paid, uploaded, but the settings step was never finished ──
     No event date or no send dates means the engine has nothing to fire on,
     so the event would sit paid and silent forever. Nudge the client back to
     the page (it resumes at the settings step) and say so in Slack.        */
  for (const ev of evRows) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    const fileUp = String(ev[43] || '').trim() === 'כן';
    const phone = String(ev[3] || '').trim();
    if (!token || !paid || cancelled || !fileUp || !phone) continue;
    const evDate = String(ev[6] || '').trim().slice(0, 10);
    const anySend = [39, 40, 41].some(c => /^\d{4}-\d{2}-\d{2}/.test(String(ev[c] || '').trim()));
    if (/^\d{4}-\d{2}-\d{2}$/.test(evDate) && anySend) continue; // properly set up
    if (env.RATE && await env.RATE.get('nosetup:' + token)) continue;
    if (dry) { out.push({ token, type: 'no_setup', would_send_to: phone }); continue; }
    const first = (String(ev[2] || '').split(' ')[0] || '').trim() || 'לקוח יקר';
    const wa = await sendClient(env, phone, 'ishur_tzikoret_kovetz',
      [first, 'https://ishur.io/upload.html?t=' + token], { token });
    if (wa.ok) {
      await addEvCost(env, token, msgCost('ishur_tzikoret_kovetz'));
      if (env.RATE) await env.RATE.put('nosetup:' + token, today, { expirationTtl: 14 * 86400 });
      await slackPost(env, `🟠 *אירוע משולם בלי הגדרות* · ${ev[2] || ''} ${phone}\nהרשימה הועלתה אבל לא נבחרו תאריך אירוע או מועדי שליחה, ולכן שום הודעה לא תצא. נשלחה תזכורת חזרה לעמוד.`);
    }
    out.push({ token, type: 'no_setup', sent: wa.ok });
  }

  /* ── stage 0.6: channel health — yesterday's send-failure rate ──────────── */
  if (env.RATE && !dry) {
    try {
      const yd = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
      let st = null; try { st = JSON.parse(await env.RATE.get('wastat:' + yd)); } catch {}
      if (st && st.out >= 10 && st.fail / st.out >= 0.3 && !(await env.RATE.get('healthalert:' + yd))) {
        await alert(env, 'בריאות ערוץ',
          `אתמול נכשלו ${st.fail} מתוך ${st.out} שליחות (${Math.round(st.fail / st.out * 100)}%) — לבדוק את איכות המספר במטא`, yd);
        await env.RATE.put('healthalert:' + yd, '1', { expirationTtl: 3 * 86400 });
      }
    } catch {}
  }

  /* ── guest waves: invitation (AN), reminder (AO), extra (AP) ──────────── */
  const WAVES = [
    { key: 1, col: 39, onlyUnanswered: false },  // ההזמנה — לכל הרשימה
    { key: 2, col: 40, onlyUnanswered: true },   // תזכורת — למי שלא ענה
    { key: 3, col: 41, onlyUnanswered: false },  // שליחה נוספת — לכל הרשימה
  ];
  for (const ev of evRows) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    const fileUp = String(ev[43] || '').trim() === 'כן';
    if (!token || !paid || cancelled || !fileUp) continue;
    /* service-suspension lever: hold:<token> in KV freezes all guest sending
       for one event (unpaid balance, dispute) without touching the sheet */
    if (env.RATE && await env.RATE.get('hold:' + token)) continue;

    const guests = gRows.filter(g => String(g[28] || '').trim() === token);
    if (!guests.length) continue;

    for (const wave of WAVES) {
      const when = String(ev[wave.col] || '').trim().slice(0, 10);
      /* the engine never runs on Shabbat, and a date can be missed for other
         reasons too, so a wave stays claimable for three days. The KV flag
         below is what keeps it to a single send. */
      if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) continue;
      const lateBy = Math.round((Date.parse(today) - Date.parse(when)) / 864e5);
      if (lateBy < 0 || lateBy > 3) continue;
      /* never chase after the event itself has passed */
      const evDay = String(ev[6] || '').trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(evDay) && evDay < today) continue;
      const flagKey = `wave:${token}:${wave.key}`;
      if (env.RATE && await env.RATE.get(flagKey)) continue;
      /* wave 3 is the paid extra_send add-on — no plan includes it. The add-on
         purchase drops extrasend:<token> into KV; without it the wave holds. */
      if (wave.key === 3 && env.RATE && !(await env.RATE.get('extrasend:' + token))) {
        if (dry) { out.push({ token, type: 'wave3_held' }); continue; }
        if (!(await env.RATE.get('wave3note:' + token))) {
          await alert(env, 'גל 3', 'מתוכנן גל שלישי אך תוסף "שליחה נוספת" לא נרכש — הגל מוחזק', token.slice(0, 8));
          await env.RATE.put('wave3note:' + token, today, { expirationTtl: 120 * 86400 });
        }
        continue;
      }
      const res = await sendWave(env, ev, token, guests, wave, dry, budget);
      if (res.truncated) out.push({ token, type: 'wave_truncated', wave: wave.key, truncated: true });
      if (!dry && res.sent) await addEvCost(env, token, res.sent * msgCost(res.tmpl || 'hazmana_ishur'));
      /* only close the wave if something actually went out. A wave where every
         send failed (revoked token, number blocked) must stay open so a fixed
         re-run still reaches the guests instead of burning the list. */
      /* a wave the budget cut short is NOT finished: closing its flag here
         would strand every guest past the cut-off with no second chance */
      /* delivered means DELIVERED: zero failures and no truncation. The old
         `sent > 0 ||` closed a wave where 12 went out and 188 failed on a
         revoked token — wsent: already stops the 12 from repeating, so leaving
         the flag open costs nothing and the 188 get their invitation on the
         next tick. (Review finding #4.) */
      const waveDelivered = !res.truncated && res.failed === 0;
      if (!dry && res.failed > 0) {
        await slackPost(env, `⚠️ גל ${wave.key} · ${token.slice(0, 8)}: ${res.failed} שליחות נכשלו, ${res.sent} יצאו. הגל נשאר פתוח וינסה שוב בפעימה הבאה.`);
      }
      if (!dry && env.RATE && waveDelivered) {
        await env.RATE.put(flagKey, today, { expirationTtl: 120 * 86400 });
      }
      /* remember which event date the invitations announced — the postpone
         stage compares against it when the sheet's date later moves */
      if (!dry && wave.key === 1 && res.sent && env.RATE) {
        await env.RATE.put('sentdate:' + token, String(ev[6] || '').trim().slice(0, 10),
          { expirationTtl: 200 * 86400 });
      }
      if (!dry && res.failed) {
        await alert(env, 'גל שליחה', `גל ${wave.key} לאירוע ${token.slice(0, 8)}: ${res.failed} שליחות נכשלו`, '');
      }
      out.push({ token, type: 'wave', ...res });
    }

    /* escalation: the morning after the LAST planned send, whoever still has
       no answer is queued for a call */
    const lastSend = WAVES.map(w => String(ev[w.col] || '').trim().slice(0, 10))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
    /* calls are a plan feature: בסיס never enters the call queue — the basic
       upsell stage offers the upgrade instead of silently marking calls */
    if (lastSend && lastSend < today && planKeyOf(ev) !== 'basic') {
      const escKey = `esc:${token}`;
      if (!(env.RATE && await env.RATE.get(escKey))) {
        let queued = 0;
        for (const g of guests) {
          const answered = String(g[15] || '').trim() !== '';
          const gid = String(g[2] || '').trim();
          const callStatus = String(g[21] || '').trim();
          if (answered || !gid || callStatus) continue;
          if (dry) { queued++; continue; }
          await fetch(env.HOOK_EVENTS, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event_type: 'call_result', guest_id: gid,
              rsvp: '__keep__', call_status: 'נדרשת שיחה',
              answer: 'לא ענה להודעות', tries: '__keep__', party: '__keep__',
              ts: new Date().toISOString(),
            }),
          }).catch(() => null);
          queued++;
        }
        if (!dry && env.RATE) await env.RATE.put(escKey, today, { expirationTtl: 120 * 86400 });
        if (queued) out.push({ token, type: 'escalation', queued });
      }
    }
  }

  for (const ev of evRows) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    const date = String(ev[6] || '').trim();
    const phone = String(ev[3] || '').trim();
    if (!token || !paid || cancelled || !phone || !/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
    if (env.RATE && await env.RATE.get('hold:' + token)) continue;

    const daysLeft = Math.round((Date.parse(date.slice(0, 10)) - Date.parse(today)) / 864e5);
    if (daysLeft < 0 || daysLeft > 7) continue;
    if (env.RATE && await env.RATE.get('report7:' + token)) continue;

    let confirmed = 0, declined = 0, pending = 0, diners = 0;
    for (const g of gRows) {
      if (String(g[28] || '').trim() !== token) continue;
      const st = String(g[15] || '').trim();
      if (st === 'מגיע') {
        confirmed += 1;
        diners += Number(String(g[13] || '').trim()) || Number(String(g[5] || '').trim()) || 1;
      } else if (st === 'לא מגיע') declined += 1;
      else pending += 1;
    }

    const name = String(ev[2] || '').trim();
    const occasion = String(ev[5] || '').trim();
    const evName = occasion ? 'ה' + occasion + (name ? ' של ' + name : '') : (name || 'האירוע שלכם');

    if (dry) {
      out.push({ token, daysLeft, confirmed, diners, declined, pending, would_send_to: phone });
      continue;
    }
    const wa = await sendClient(env, phone, 'ishur_doch', [
      evName, String(confirmed), String(diners), String(declined), String(pending),
      'https://ishur.io/dashboard.html?t=' + token,
    ]);
    if (wa.ok && env.RATE) await env.RATE.put('report7:' + token, today, { expirationTtl: 60 * 86400 });
    if (wa.ok) await addEvCost(env, token, msgCost('ishur_doch'));
    if (!wa.ok) await alert(env, 'דוח שבוע-לפני', 'שליחת הדוח נכשלה', token + ': ' + wa.error);
    out.push({ token, daysLeft, confirmed, diners, declined, pending, sent: wa.ok });
  }

  /* ── stage 3: the day-after wrap-up — thanks + final report + review links ──
     Fires once per event, the first non-Shabbat morning after the event date.
     The Google-review and video-testimonial links live in the brain sheet
     (מוח שירות D1/D2) so Richard drops them in without a deploy; until both
     exist the message waits and he gets a single reminder alert per event.  */
  for (const ev of evRows) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    const date = String(ev[6] || '').trim().slice(0, 10);
    const phone = String(ev[3] || '').trim();
    if (!token || !paid || cancelled || !phone || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    if (env.RATE && await env.RATE.get('hold:' + token)) continue;
    const daysAfter = Math.round((Date.parse(today) - Date.parse(date)) / 864e5);
    if (daysAfter < 1 || daysAfter > 14) continue; // day-after and up to two weeks late, then let it go
    if (env.RATE && await env.RATE.get('eoe:' + token)) continue;

    let confirmed = 0, declined = 0, pending = 0, diners = 0;
    for (const g of gRows) {
      if (String(g[28] || '').trim() !== token) continue;
      const st = String(g[15] || '').trim();
      if (st === 'מגיע') {
        confirmed += 1;
        diners += Number(String(g[13] || '').trim()) || Number(String(g[5] || '').trim()) || 1;
      } else if (st === 'לא מגיע') declined += 1;
      else pending += 1;
    }

    const name = String(ev[2] || '').trim();
    const occasion = String(ev[5] || '').trim();
    const evName = occasion ? 'ה' + occasion + (name ? ' של ' + name : '') : (name || 'האירוע שלכם');
    const brain = await getBrain(env);
    const review = String(brain.reviewLink || '').trim();
    const clip = String(brain.testimonialLink || '').trim();

    if (dry) {
      out.push({ token, type: 'end_of_event', daysAfter, confirmed, diners, declined, pending,
        links_missing: !(review && clip), would_send_to: phone });
      continue;
    }
    if (!review || !clip) {
      if (!(env.RATE && await env.RATE.get('eoelink:' + token))) {
        await alert(env, 'סוף-אירוע',
          'חסרים קישורי ביקורת/המלצה (מוח שירות D1/D2) — הודעת הסיום ממתינה', token.slice(0, 8));
        if (env.RATE) await env.RATE.put('eoelink:' + token, today, { expirationTtl: 14 * 86400 });
      }
      continue;
    }
    const wa = await sendClient(env, phone, 'ishur_syum', [
      evName, String(confirmed), String(diners), String(declined), String(pending), review, clip,
    ]);
    if (wa.ok && env.RATE) await env.RATE.put('eoe:' + token, today, { expirationTtl: 120 * 86400 });
    if (wa.ok) await addEvCost(env, token, msgCost('ishur_syum'));
    if (!wa.ok) await alert(env, 'סוף-אירוע', 'שליחת הודעת הסיום נכשלה', token + ': ' + wa.error);
    out.push({ token, type: 'end_of_event', confirmed, diners, declined, pending, sent: wa.ok });
  }

  /* ── stage 4: event-day "your table" messages ─────────────────────────────
     On the morning of the event, every confirmed guest with an assigned table
     (column AE, set from the client's dashboard) gets ishur_shulchan. One run
     per event (KV seat:<token>) — but only once something was actually sent,
     so tables assigned later that morning still go out on a manual run.     */
  for (const ev of evRows) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    const date = String(ev[6] || '').trim().slice(0, 10);
    if (!token || !paid || cancelled || date !== today) continue;
    if (env.RATE && await env.RATE.get('seat:' + token)) continue;
    if (env.RATE && await env.RATE.get('hold:' + token)) continue;

    const name = String(ev[2] || '').trim();
    const occasion = String(ev[5] || '').trim();
    const evName = occasion ? 'ה' + occasion + (name ? ' של ' + name : '') : (name || 'האירוע');

    let sent = 0, failed = 0, would = 0;
    /* same discipline as the waves (review finding #5): per-guest marker,
       budget, and the event flag only when the whole list is done */
    let cut = false;
    const seenPhones = new Set();
    for (const g of gRows) {
      if (String(g[28] || '').trim() !== token) continue;
      if (budget && budget.left <= 0) { cut = true; break; }
      const phone = String(g[4] || '').trim();
      const table = String(g[30] || '').trim();
      const rsvp = String(g[15] || '').trim();
      if (!phone || !table || rsvp !== 'מגיע' || seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      if (dry) { would++; continue; }
      const mk = `s5t:${token}:${normPhone(phone)}`;
      if (env.RATE && await env.RATE.get(mk)) continue;
      if (await phoneBlocked(env, phone)) continue;
      if (await wrongNum(env, token, phone)) continue;
      const gname = String(g[3] || '').trim() || 'אורח יקר';
      const wa = await sendTemplate(env, phone, 'ishur_shulchan', [gname, evName, table], '', 'he', 'guests');
      if (budget) budget.left--;
      if (wa.ok) { sent++; if (env.RATE) await env.RATE.put(mk, '1', { expirationTtl: 14 * 86400 }).catch(() => {}); }
      else failed++;
    }
    if (dry) { if (would) out.push({ token, type: 'seating', would_send: would }); continue; }
    if (sent) await addEvCost(env, token, sent * msgCost('ishur_shulchan'));
    /* only close once something actually went out AND nothing failed — an
       empty pass keeps the flag open so tables assigned later still send */
    if (sent && !cut && !failed && env.RATE) await env.RATE.put('seat:' + token, today, { expirationTtl: 30 * 86400 });
    if (failed) await alert(env, 'הודעות שולחן', `${failed} שליחות נכשלו — ננסה שוב בפעימה הבאה`, token.slice(0, 8));
    if (sent || failed) out.push({ token, type: 'seating', sent, failed, truncated: cut });
    if (cut) out.push({ token, type: 'wave_truncated', truncated: true });
  }

  /* ── stage 5: lifecycle extras — day-before, cancel, postpone, upsell ─────
     · יום-לפני: promised in every plan — confirmed guests get the venue.
     · ביטול/דחייה to guests: a הכל-כלול feature; other plans raise an alert
       so Richard can offer it manually.
     · upsell: בסיס whose waves left ≥40% silent → offer calls; פרמיום whose
       single call round left ≥60% unreachable → offer הכל כלול.            */
  for (const ev of evRows) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    const date = String(ev[6] || '').trim().slice(0, 10);
    if (!token || !paid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (env.RATE && await env.RATE.get('hold:' + token)) continue;
    const plan = planKeyOf(ev);
    /* an unreadable plan cell silently downgrades a הכל כלול customer to one
       call round — never let that pass quietly */
    if (!String(ev[31] || '').trim() && !dry && env.RATE &&
        !(await env.RATE.get('plannote:' + token))) {
      await alert(env, 'חבילה חסרה',
        `לאירוע ${token.slice(0, 8)} אין חבילה בעמודה AF — המערכת מתייחסת אליו כפרמיום. למלא בגיליון`, '');
      await env.RATE.put('plannote:' + token, today, { expirationTtl: 60 * 86400 });
    }
    const guests = gRows.filter(g => String(g[28] || '').trim() === token);
    const name = String(ev[2] || '').trim();
    const occasion = String(ev[5] || '').trim();
    const evName = occasion ? 'ה' + occasion + (name ? ' של ' + name : '') : (name || 'האירוע');
    const invited = env.RATE ? await env.RATE.get(`wave:${token}:1`) : null;
    const time = String(ev[36] || '').trim() || 'בשעות הערב';
    const venue = [String(ev[38] || '').trim(), String(ev[37] || '').trim()].filter(Boolean).join(', ');

    if (cancelled) {
      if (!invited || date < today) continue;
      if (env.RATE && await env.RATE.get('cancelmsg:' + token)) continue;
      if (plan !== 'premium') {
        if (dry) { out.push({ token, type: 'cancel_note_would_alert' }); continue; }
        if (env.RATE && !(await env.RATE.get('cancelnote:' + token))) {
          await alert(env, 'אירוע בוטל',
            `האורחים של ${evName} כבר הוזמנו, אך הודעת ביטול לאורחים כלולה רק בהכל כלול (כאן: ${plan}). לשליחה חד-פעמית דברו איתי`,
            token.slice(0, 8));
          if (!dry) await env.RATE.put('cancelnote:' + token, today, { expirationTtl: 60 * 86400 });
        }
        continue;
      }
      if (dry) { out.push({ token, type: 'cancel_notice', would_send: guests.length }); continue; }
      /* Same shape as the waves, for the same reason (review finding #5): a
         180-of-300 partial run used to write cancelmsg: anyway, and 120 people
         showed up to a cancelled hall. Per-guest markers make re-entry free,
         the budget stops before the ceiling, and the event flag is only
         written when nobody is left behind. */
      let sent = 0, failed = 0, cut = false; const seen = new Set();
      for (const g of guests) {
        if (budget && budget.left <= 0) { cut = true; break; }
        const phone = String(g[4] || '').trim();
        if (!phone || seen.has(phone)) continue; seen.add(phone);
        const mk = `s5c:${token}:${normPhone(phone)}`;
        if (env.RATE && await env.RATE.get(mk)) continue;
        if (await phoneBlocked(env, phone)) continue;
        if (await wrongNum(env, token, phone)) continue;
        const gname = String(g[3] || '').trim() || 'אורח יקר';
        const wa = await sendTemplate(env, phone, 'ishur_bitul', [gname, evName], '', 'he', 'guests', { occasion, token });
        if (budget) budget.left--;
        if (wa.ok) { sent++; if (env.RATE) await env.RATE.put(mk, '1', { expirationTtl: 30 * 86400 }).catch(() => {}); }
        else failed++;
      }
      if (sent) await addEvCost(env, token, sent * msgCost('ishur_bitul'));
      if (!cut && !failed && env.RATE) await env.RATE.put('cancelmsg:' + token, today, { expirationTtl: 120 * 86400 });
      if (failed) await alert(env, 'הודעת ביטול', `${failed} שליחות נכשלו — ננסה שוב בפעימה הבאה`, token.slice(0, 8));
      out.push({ token, type: 'cancel_notice', sent, failed, truncated: cut });
      if (cut) out.push({ token, type: 'wave_truncated', truncated: true });
      continue;
    }

    const sentDate = env.RATE ? await env.RATE.get('sentdate:' + token) : null;
    if (invited && sentDate && sentDate !== date && date >= today) {
      if (plan === 'premium') {
        if (dry) { out.push({ token, type: 'postpone_notice', would_send: guests.length, from: sentDate, to: date }); }
        else {
          /* Per-guest markers keyed to the NEW date, so a second postponement
             re-notifies everyone. sentdate: only moves when every guest heard
             about the move — advancing it on a partial run made the condition
             above false forever and stranded the rest on the old date, and it
             also wiped the one-shot flags off that partial success (review
             finding #5). */
          let sent = 0, failed = 0, cut = false; const seen = new Set();
          for (const g of guests) {
            if (budget && budget.left <= 0) { cut = true; break; }
            const phone = String(g[4] || '').trim();
            if (!phone || seen.has(phone)) continue; seen.add(phone);
            const mk = `s5p:${token}:${date}:${normPhone(phone)}`;
            if (env.RATE && await env.RATE.get(mk)) continue;
            if (await phoneBlocked(env, phone)) continue;
            if (await wrongNum(env, token, phone)) continue;
            const gname = String(g[3] || '').trim() || 'אורח יקר';
            const wa = await sendTemplate(env, phone, 'ishur_dchiya',
              [gname, evName, heDate(date), time, venue || 'פרטים אצל בעלי השמחה'], '', 'he', 'guests', { occasion, token });
            if (budget) budget.left--;
            if (wa.ok) { sent++; if (env.RATE) await env.RATE.put(mk, '1', { expirationTtl: 60 * 86400 }).catch(() => {}); }
            else failed++;
          }
          if (sent) await addEvCost(env, token, sent * msgCost('ishur_dchiya'));
          if (!cut && !failed && env.RATE) {
            await env.RATE.put('sentdate:' + token, date, { expirationTtl: 200 * 86400 });
            /* one-shot flags realign to the new date — only now, when the
               whole list has actually heard about it */
            await env.RATE.delete('report7:' + token).catch(() => {});
            await env.RATE.delete('seat:' + token).catch(() => {});
            await env.RATE.delete('daybefore:' + token).catch(() => {});
          }
          if (failed) await alert(env, 'הודעת דחייה', `${failed} שליחות נכשלו — ננסה שוב בפעימה הבאה`, token.slice(0, 8));
          out.push({ token, type: 'postpone_notice', sent, failed, truncated: cut });
          if (cut) out.push({ token, type: 'wave_truncated', truncated: true });
        }
      } else if (dry) {
        out.push({ token, type: 'postpone_note_would_alert', from: sentDate, to: date });
      } else if (env.RATE && !(await env.RATE.get(`postponenote:${token}:${date}`))) {
        await alert(env, 'אירוע נדחה',
          `${evName} עבר מ-${sentDate} ל-${date}, אך עדכון אורחים כלול רק בהכל כלול (כאן: ${plan})`, token.slice(0, 8));
        if (!dry) await env.RATE.put(`postponenote:${token}:${date}`, today, { expirationTtl: 60 * 86400 });
      }
    }

    const fileUp = String(ev[43] || '').trim() === 'כן';
    const daysLeft = Math.round((Date.parse(date) - Date.parse(today)) / 864e5);
    /* D-1 normally, but the engine never runs on Shabbat, so a Sunday event
       would lose its reminder entirely. The window covers the event morning
       too and the KV flag keeps it to one send either way. */
    if (fileUp && daysLeft >= 0 && daysLeft <= 1 &&
        !(env.RATE && await env.RATE.get('daybefore:' + token))) {
      let sent = 0, failed = 0, would = 0, cut = false; const seen = new Set();
      for (const g of guests) {
        if (budget && budget.left <= 0) { cut = true; break; }
        const phone = String(g[4] || '').trim();
        const rsvp = String(g[15] || '').trim();
        if (!phone || rsvp !== 'מגיע' || seen.has(phone)) continue; seen.add(phone);
        if (dry) { would++; continue; }
        const mk = `s5d:${token}:${normPhone(phone)}`;
        if (env.RATE && await env.RATE.get(mk)) continue;
        if (await phoneBlocked(env, phone)) continue;
        if (await wrongNum(env, token, phone)) continue;
        const gname = String(g[3] || '').trim() || 'אורח יקר';
        const wa = await sendTemplate(env, phone, 'ishur_yom_lifnei',
          [gname, evName, heDate(date), time, venue || 'פרטים אצל בעלי השמחה'], '', 'he', 'guests',
          { occasion, wave: 'daybefore', token });
        if (budget) budget.left--;
        if (wa.ok) { sent++; if (env.RATE) await env.RATE.put(mk, '1', { expirationTtl: 7 * 86400 }).catch(() => {}); }
        else failed++;
      }
      if (dry) { if (would) out.push({ token, type: 'day_before', would_send: would }); }
      else {
        if (sent) await addEvCost(env, token, sent * msgCost('ishur_yom_lifnei'));
        /* the day-before flag closes only on a clean, complete pass (finding #5) */
        if (!cut && !failed && env.RATE) await env.RATE.put('daybefore:' + token, today, { expirationTtl: 30 * 86400 });
        if (failed) await alert(env, 'תזכורת יום-לפני', `${failed} שליחות נכשלו — ננסה שוב בפעימה הבאה`, token.slice(0, 8));
        if (sent || failed) out.push({ token, type: 'day_before', sent, failed, truncated: cut });
        if (cut) out.push({ token, type: 'wave_truncated', truncated: true });
      }
    }

    /* rulebook: a call round takes time — no calls offer under 7 days out */
    if (plan === 'basic' && fileUp && guests.length && daysLeft >= 7) {
      /* measure from the FIRST wave that already went out: by the time the
         last one lands there is no room left before the 7-day calls cutoff */
      const firstSend = [39, 40, 41].map(c => String(ev[c] || '').trim().slice(0, 10))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today).sort().shift();
      if (firstSend && Math.round((Date.parse(today) - Date.parse(firstSend)) / 864e5) >= 2 &&
          !(env.RATE && await env.RATE.get('upsell:' + token))) {
        const total = guests.length;
        const silent = guests.filter(g => !String(g[15] || '').trim()).length;
        if (total >= 10 && silent / total >= 0.4) {
          const phone = String(ev[3] || '').trim();
          const first = (name.split(' ')[0] || '').trim() || 'שלום';
          if (dry) out.push({ token, type: 'upsell_basic', silent, total });
          else if (phone) {
            const wa = await sendClient(env, phone, 'ishur_shidrug',
              [first, evName, `${silent} מתוך ${total}`], { occasion, token });
            if (wa.ok && env.RATE) await env.RATE.put('upsell:' + token, today, { expirationTtl: 120 * 86400 });
            if (wa.ok) {
              await addEvCost(env, token, msgCost('ishur_shidrug'));
              await slackPost(env, `💡 *הצעת שדרוג נשלחה* · ${name} (בסיס): ${silent}/${total} לא ענו להודעות — הוצעו שיחות של שיר`);
            }
            out.push({ token, type: 'upsell_basic', sent: wa.ok });
          }
        }
      }
    }

    if (plan === 'pro' && guests.length && daysLeft >= 7) {
      const callDay = env.RATE
        ? (await env.RATE.get('calldate:' + token)) ||
          (await env.RATE.get('calldate8:' + token.slice(0, 8)))
        : null;
      if (callDay && callDay < today && !(env.RATE && await env.RATE.get('upsell2:' + token))) {
        const tried = guests.filter(g => (Number(String(g[29] || '').trim()) || 0) >= 1);
        const silent = tried.filter(g => !String(g[15] || '').trim()).length;
        if (tried.length >= 5 && silent / tried.length >= 0.6) {
          const phone = String(ev[3] || '').trim();
          const first = (name.split(' ')[0] || '').trim() || 'שלום';
          if (dry) out.push({ token, type: 'upsell_pro', silent, tried: tried.length });
          else if (phone) {
            const wa = await sendClient(env, phone, 'ishur_shidrug_sichot',
              [first, evName, `${silent} מתוך ${tried.length}`], { occasion, token });
            if (wa.ok && env.RATE) await env.RATE.put('upsell2:' + token, today, { expirationTtl: 120 * 86400 });
            if (wa.ok) {
              await addEvCost(env, token, msgCost('ishur_shidrug_sichot'));
              await slackPost(env, `💡 *הצעת הכל כלול נשלחה* · ${name} (פרמיום): ${silent}/${tried.length} לא נענו לסבב השיחות`);
            }
            out.push({ token, type: 'upsell_pro', sent: wa.ok });
          }
        }
      }
    }
  }
  if (!dry && env.RATE) {
    await env.RATE.put('engine:lastrun',
      JSON.stringify({ at: new Date().toISOString(), date: today, items: out.length }),
      { expirationTtl: 30 * 86400 }).catch(() => {});
    /* did the budget cut this run short? The pacer reads this to decide
       whether the next tick has anything to do at all, which is what keeps
       144 daily ticks from costing 144 Make operations. */
    const cut = out.some(o => o && o.truncated);
    if (cut) await env.RATE.put('pacer:pending', today, { expirationTtl: 2 * 86400 });
    else if (budget) await env.RATE.delete('pacer:pending');
  }
  return { ok: true, date: today, events: out, truncated: out.some(o => o && o.truncated) };
}

/* ══ the pacer ═══════════════════════════════════════════════════════════════
   Everything used to happen in one burst at 09:35: every wave for every event,
   then Shir's whole dial round. Two problems with that. A 300-guest wave does
   not survive one invocation's subrequest ceiling, and 300 identical messages
   in ninety seconds is what a spam filter is built to catch. At the volume
   Richard is aiming for — a couple of thousand contacts a day — it does not
   work at all.

   So the burst becomes a trickle: a tick every ten minutes through the contact
   window, each one draining a slice. The dedupe keys that already existed
   (wsent: per guest per wave, shirtry: per guest per day) are what make this
   safe to re-enter; nothing here needed a new lock.

   The tick is cheap when there is nothing to do: one KV read and out. It only
   reaches for the sheet when the last run left work behind, or when the call
   queue is warm.
   ────────────────────────────────────────────────────────────────────────── */
const PACE_SENDS = 25;    // guest messages per tick — 63 ticks ≈ 1,500/day
const PACE_CALLS = 6;     // dials per tick — 63 ticks ≈ 375/day
const PACE_CALLBACKS = 3; // ring-backs per tick, taken OUT of PACE_CALLS

async function runPacer(env) {
  if (!env.RATE) return { ok: false, why: 'no-kv' };
  const today = ilDate();
  if (isNoContactDay(today)) return { ok: true, skipped: 'no-contact-day' };
  if (await sendingPaused(env)) return { ok: true, paused: true };

  const out = { date: today };

  /* messages first: they are cheaper and they warm the 24h window a call
     lands in more gracefully than a cold ring does */
  const sendWin = sendWindowState();
  if (sendWin.open && await env.RATE.get('pacer:pending') === today) {
    const r = await runDailyEngine(env, false, null, { budget: PACE_SENDS }).catch(e => {
      return { ok: false, error: String((e && e.message) || e) };
    });
    out.sends = r && r.ok ? { ran: true, truncated: !!r.truncated } : { ran: false, error: r && r.error };
    /* a tick that failed while work is pending used to vanish into the
       heartbeat; one alert a day is the difference between "Richard knows in
       20 minutes" and "somebody finds out at the hall" */
    if ((!r || !r.ok) && !(await env.RATE.get('paceralert:' + today))) {
      await env.RATE.put('paceralert:' + today, '1', { expirationTtl: 86400 });
      await slackPost(env, `🚨 *פעימת שליחה נכשלה* (${(r && r.error) || 'שגיאה'}) בזמן שיש עבודה ממתינה. הפעימה הבאה תנסה שוב בעוד 10 דקות; אם ההתראה הזאת חוזרת מחר — משהו תקוע באמת.`);
    }
  } else {
    out.sends = { ran: false, why: sendWin.open ? 'nothing-pending' : sendWin.why };
  }

  /* Chasing an abandoned lead does not need the sheet, only KV, so it runs on
     every tick rather than waiting for the nightly engine. Without this the
     "five hours later" promise was really "tomorrow morning", which for
     somebody who asked about their wedding this afternoon is a different
     product. Cheap: one KV list, no Make operation. */
  if (sendWin.open) {
    const chased = await chaseAbandonedLeads(env, false, { left: 10 }).catch(() => []);
    out.leads = chased.filter(c => c.sent).length;
  }

  /* then the dial slice */
  const callWin = callWindowState();
  if (callWin.open) {
    /* Whoever just rang US is the hottest lead in the system: somebody who
       wanted to talk to us badly enough to dial. The callback queue therefore
       empties BEFORE the guest queue — and out of the same per-tick budget,
       so a busy inbound hour cannot quietly blow the concurrency limit. */
    const cb = await runShirCallbacks(env, { max: Math.min(PACE_CALLBACKS, PACE_CALLS) }).catch(e => {
      return { dialed: 0, why: String((e && e.message) || e) };
    });
    out.callbacks = cb;
    const left = Math.max(0, PACE_CALLS - ((cb && cb.dialed) || 0));
    const r = left
      ? await runShirDispatch(env, { max: left, quiet: true }).catch(e => {
        return { ok: false, why: String((e && e.message) || e) };
      })
      : { dialed: 0, why: 'callbacks-took-the-slice' };
    out.calls = { dialed: (r && r.dialed) || 0, queued: (r && r.queued) || 0, why: r && r.why };
  } else {
    out.calls = { dialed: 0, why: callWin.why };
    out.callbacks = { dialed: 0, why: callWin.why };
  }
  /* a heartbeat worth having: "the pacer is alive" is otherwise invisible
     until the day somebody notices nothing went out */
  await env.RATE.put('pacer:last', JSON.stringify({ at: new Date().toISOString(), ...out }),
    { expirationTtl: 3 * 86400 }).catch(() => {});
  return { ok: true, ...out };
}

/* ══ Team reminders ══════════════════════════════════════════════════════════
   KV key `reminders` holds a JSON list: [{date:"YYYY-MM-DD", to:["9725..."],
   who:"שלו", tasks:[{id:"AUT-891", title:"...", done:false}]}].
   A Tuesday cron fires at 12:00/13:00/19:00 IL: the first slot always sends,
   the later slots nag only while something is still open. Anyone on the list
   closes a task by WhatsApping "בוצע AUT-891" to the business number.
   ─────────────────────────────────────────────────────────────────────────── */
async function loadReminders(env) {
  if (!env.RATE) return [];
  try { return JSON.parse(await env.RATE.get('reminders')) || []; } catch { return []; }
}

async function runTeamReminders(env, hourUtc, dry) {
  const today = ilDate();
  const list = await loadReminders(env);
  const out = [];
  for (const r of list) {
    if (r.date !== today) continue;
    const open = (r.tasks || []).filter(t => !t.done);
    const firstSlot = hourUtc === 9;
    if (!open.length && !firstSlot) continue;
    const lines = open.length
      ? open.map(t => '· ' + t.id + ' — ' + t.title)
      : ['הכל סגור 🎉'];
    const nag = hourUtc === 16 ? 'תזכורת אחרונה להיום — ' : hourUtc === 10 ? 'תזכורת — ' : '';
    const msg = 'היי ' + (r.who || '') + ' 🌟 ' + nag + 'המשימות הפתוחות להיום:\n' +
      lines.join('\n') +
      (open.length ? '\n\nסגרתם משהו? השיבו כאן "בוצע ' + open[0].id + '" ואפסיק להזכיר אותו.' : '');
    for (const to of r.to || []) {
      if (dry) { out.push({ to, would_send: msg.slice(0, 80) }); continue; }
      const res = await sendText(env, to, msg);
      out.push({ to, sent: res.ok });
    }
  }
  return { ok: true, date: today, hour: hourUtc, results: out };
}

async function handleRemindRun(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (Array.isArray(body.set)) {
    /* replace the whole reminders list — the admin seeds or edits it */
    await env.RATE.put('reminders', JSON.stringify(body.set.slice(0, 50)));
  }
  if (body.run != null) {
    return okJson(await runTeamReminders(env, Number(body.run) || 9, !!body.dry), origin);
  }
  return okJson({ ok: true, reminders: await loadReminders(env) }, origin);
}

/* WhatsApp "בוצע AUT-123" marks the task done and stops the nagging */
async function markTaskDone(env, text) {
  const m = String(text || '').match(/בוצע\s+((?:AUT|aut)-\d+)/);
  if (!m || !env.RATE) return null;
  const id = m[1].toUpperCase();
  const list = await loadReminders(env);
  let hit = false;
  for (const r of list) {
    for (const t of r.tasks || []) {
      if (String(t.id).toUpperCase() === id) { t.done = true; hit = true; }
    }
  }
  if (!hit) return null;
  await env.RATE.put('reminders', JSON.stringify(list));
  return id;
}

/* ══ Daily sheet backup ══════════════════════════════════════════════════════
   Every tab that holds state is snapshotted into KV once a day (35-day
   retention) right after the morning engine. Restore = read the JSON and
   paste back; the admin route serves list / fetch / run-now.
   ─────────────────────────────────────────────────────────────────────────── */
const BACKUP_TABS = ['לקוחות', 'אירועים', 'אורחים', 'לידים - לא סגרו', 'הסרות', 'מוח שירות'];

async function runBackup(env) {
  if (!env.BRAIN_HOOK || !env.RATE) return { ok: false, error: 'not-configured' };
  const tabs = {};
  for (const tab of BACKUP_TABS) {
    /* the proxy takes a single query pair, so one call per tab */
    const r = await fetch(env.BRAIN_HOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchGet',
        qk1: 'ranges', qv1: `${tab}!A1:AZ3000`,
      }),
    }).catch(() => null);
    if (!r || !r.ok) return { ok: false, error: 'read-failed: ' + tab };
    try { tabs[tab] = (await r.json()).valueRanges[0].values || []; }
    catch { return { ok: false, error: 'parse-failed: ' + tab }; }
  }
  const date = ilDate();
  const body = JSON.stringify({ at: new Date().toISOString(), date, tabs });
  await env.RATE.put('backup:' + date, body, { expirationTtl: 35 * 86400 });
  return { ok: true, date, bytes: body.length, rows: Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, v.length])) };
}

async function handleBackup(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (body.run) {
    const res = await runBackup(env);
    if (!res.ok) { await alert(env, 'גיבוי', 'גיבוי ידני נכשל', res.error || ''); return deny(502, res.error || 'backup-failed', origin); }
    return okJson(res, origin);
  }
  if (body.date) {
    const raw = env.RATE ? await env.RATE.get('backup:' + String(body.date).slice(0, 10)) : null;
    if (!raw) return deny(404, 'no-backup-for-date', origin);
    return new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
  }
  const dates = [];
  if (env.RATE && env.RATE.list) {
    let cursor;
    for (let i = 0; i < 5; i++) {
      const page = await env.RATE.list({ prefix: 'backup:', cursor, limit: 1000 }).catch(() => null);
      if (!page) break;
      for (const k of page.keys) dates.push(k.name.slice('backup:'.length));
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  }
  return okJson({ ok: true, dates: dates.sort().reverse() }, origin);
}

/* ══ The inbox — every WhatsApp conversation, Wati style ═════════════════════
   Built straight from the KV message log (log:<phone>:<ts>, 90 days).
   POST {admin_key} → conversation list; {admin_key, phone} → the thread.
   Replies go out through /api/wa-send, which logs itself into the same keys.
   ─────────────────────────────────────────────────────────────────────────── */
async function kvKeys(env, prefix, cap = 6000) {
  const names = [];
  if (!env.RATE || !env.RATE.list) return names;
  let cursor;
  while (names.length < cap) {
    const page = await env.RATE.list({ prefix, cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    for (const k of page.keys) names.push(k.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return names;
}

async function handleInbox(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);

  const phone = normPhone(body.phone || '');
  if (phone) {
    /* one thread, oldest first. Nothing expires any more, so an old customer
       coming back still finds everything that was ever said to them. */
    const names = (await kvKeys(env, 'log:' + phone + ':')).sort();
    const messages = [];
    for (const n of names.slice(-400)) {
      try {
        const v = JSON.parse(await env.RATE.get(n));
        if (v) messages.push({ ts: Number(n.split(':').pop()) || 0, ...v });
      } catch {}
    }
    const waName = env.RATE ? await env.RATE.get('waname:' + phone) : '';
    return okJson({ ok: true, phone, wa_name: waName || '', messages }, origin);
  }

  /* One key per conversation instead of one per message. The old list walked
     every log: key ever written and stopped at its scan cap, which is why
     older threads vanished as volume grew. */
  const channel = String(body.channel || '').trim();   // '' | 'client' | 'guests'
  const list = [];
  for (const k of await kvKeys(env, 'conv:')) {
    try {
      const c = JSON.parse(await env.RATE.get(k));
      if (!c || !c.phone) continue;
      if (channel && !(c.ch || []).includes(channel)) continue;
      list.push({
        phone: c.phone,
        msgs: c.msgs || 0,
        last_ts: c.last_ts || 0,
        last_dir: c.last_dir || '',
        last_text: c.last_text || '',
        first_ts: c.first_ts || 0,
        ch: c.ch || [],
      });
    } catch {}
  }
  list.sort((a, b) => b.last_ts - a.last_ts);
  const page = list.slice(0, 400);

  /* the name, best source first: what they call themselves on WhatsApp, then
     the sheet. A number in no sheet at all still shows a person. */
  for (const c of page) {
    try { c.wa_name = (await env.RATE.get('waname:' + c.phone)) || ''; } catch {}
  }
  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (raw) {
    const nameOf = {};
    for (const ev of (raw.events && raw.events.values) || []) {
      const p = normPhone(ev[3] || '');
      if (p && !nameOf[p]) nameOf[p] = { name: String(ev[2] || '').trim(), kind: 'לקוח' };
    }
    for (const g of (raw.guests && raw.guests.values) || []) {
      const p = normPhone(g[4] || '');
      if (p && !nameOf[p]) nameOf[p] = { name: String(g[3] || '').trim(), kind: 'אורח' };
    }
    for (const c of page) {
      const hit = nameOf[c.phone];
      if (hit) { c.name = hit.name; c.kind = hit.kind; }
      if (!c.name) c.name = c.wa_name || '';
    }
  } else {
    for (const c of page) if (!c.name) c.name = c.wa_name || '';
  }
  return okJson({
    ok: true, conversations: page, total: list.length,
    counts: {
      all: list.length,
      client: list.filter(c => (c.ch || []).includes('client')).length,
      guests: list.filter(c => (c.ch || []).includes('guests')).length,
    },
  }, origin);
}

/* Everything written before the conversation index existed only lives as
   log: keys. This walks them once and builds the index, so the inbox opens on
   the full history rather than on whatever arrived after the deploy.
   POST /api/inbox-reindex {admin_key}. Safe to run twice: it rebuilds from
   scratch rather than adding to what is there. */
async function handleInboxReindex(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return okJson({ ok: false, error: 'no-kv' }, origin);

  const names = await kvKeys(env, 'log:', 60000);
  const conv = {};
  for (const n of names) {
    const parts = n.split(':');                 // log:<phone>:<ts>
    const p = parts[1], ts = Number(parts[2]) || 0;
    if (!p) continue;
    const c = (conv[p] = conv[p] || { phone: p, msgs: 0, last_ts: 0, first_ts: ts, ch: [] });
    c.msgs++;
    if (ts && (!c.first_ts || ts < c.first_ts)) c.first_ts = ts;
    if (ts > c.last_ts) { c.last_ts = ts; c.last_key = n; }
  }
  let written = 0;
  for (const c of Object.values(conv)) {
    try {
      const v = JSON.parse(await env.RATE.get(c.last_key));
      if (v) {
        c.last_dir = v.dir || '';
        c.last_text = String(v.text || v.type || '').slice(0, 80);
        /* entries written before channels were tagged are client-number
           traffic — the guests number was not sending yet */
        if (v.ch) c.ch = [v.ch];
      }
    } catch {}
    if (!c.ch.length) c.ch = ['client'];
    delete c.last_key;
    await env.RATE.put('conv:' + c.phone, JSON.stringify(c));
    written++;
  }
  return okJson({ ok: true, scanned: names.length, conversations: written }, origin);
}

/* ══ Phone + code login for the dashboard ════════════════════════════════════
   The client types their phone, gets a one-time code on WhatsApp (ishur_kod),
   and signs in. A code that logged in once keeps working on that phone for a
   month, so the saved login survives reloads. The events column AU can hold a
   second allowed phone per event — that's the "two people, one dashboard".
   ─────────────────────────────────────────────────────────────────────────── */
function eventsForPhone(raw, phone) {
  const out = [];
  for (const ev of (raw && raw.events && raw.events.values) || []) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    if (!token || !paid || cancelled) continue;
    const owner = normPhone(ev[3] || '');
    const extra = normPhone(ev[46] || '');
    if (owner !== phone && (!extra || extra !== phone)) continue;
    out.push({
      token,
      event_name: String(ev[34] || ev[2] || '').trim(),
      occasion: String(ev[5] || '').trim(),
      event_date: String(ev[6] || '').trim(),
      venue_name: String(ev[4] || '').trim(),
      venue_city: String(ev[37] || '').trim(),
    });
  }
  return out;
}

async function handleOtpSend(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  const stampError = await checkStamp(body, env.APP_KEY);
  if (stampError) return deny(403, stampError, origin);
  const phone = normPhone(body.phone || '');
  if (!/^972\d{8,9}$/.test(phone)) return deny(400, 'bad-phone', origin);
  if (!env.RATE) return deny(503, 'kv-not-bound', origin);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overBudget(env, 'rl:otps:' + phone, 3, 3600)) return deny(429, 'rate-limited', origin);
  if (await overBudget(env, 'rl:otpi:' + ip, 10, 3600)) return deny(429, 'rate-limited', origin);
  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (!raw) return deny(502, 'reader-failed', origin);
  if (!eventsForPhone(raw, phone).length) return deny(404, 'no-events', origin);
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.RATE.put('otp:' + phone,
    JSON.stringify({ code, tries: 0, exp: Math.floor(Date.now() / 1000) + 600 }),
    { expirationTtl: 600 });
  const wa = await sendOtpTemplate(env, phone, code);
  if (!wa.ok) {
    await alert(env, 'קוד כניסה', 'שליחת קוד הכניסה נכשלה', phone + ': ' + wa.error);
    return deny(502, 'send-failed', origin);
  }
  await addEvCost(env, (eventsForPhone(raw, phone)[0] || {}).token || '', msgCost('ishur_kod'));
  return okJson({ ok: true }, origin);
}

/* ══ Seating: the client assigns tables from their dashboard ═════════════════
   POST {token, assignments:[{id, table}]} — token is the same personal token
   the dashboard already uses; writes go straight to column AE of אורחים via
   the sheet proxy, only into rows that belong to this event. On event day the
   engine sends each confirmed guest their table number (stage 4).
   ─────────────────────────────────────────────────────────────────────────── */
async function handleSeating(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  const token = String(body.token || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(token)) return deny(403, 'bad-token', origin);
  if (!(await tokenRecord(env, token))) return deny(404, 'unknown-token', origin);
  if (await overBudget(env, 'rl:seating:' + token, 30, 3600)) return deny(429, 'slow-down', origin);

  const list = Array.isArray(body.assignments) ? body.assignments.slice(0, 400) : [];
  if (!list.length) return deny(400, 'no-assignments', origin);

  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (!raw) return deny(502, 'reader-failed', origin);
  const gRows = (raw.guests && raw.guests.values) || [];

  /* guest_id → sheet row (values start at A2, so row = index + 2) */
  const rowOf = {};
  gRows.forEach((g, i) => {
    if (String((g || [])[28] || '').trim() === token) {
      rowOf[String(g[2] || '').trim()] = i + 2;
    }
  });

  const data = [];
  for (const a of list) {
    const row = rowOf[String((a || {}).id || '').trim()];
    if (!row) continue; // not this event's guest — silently skipped
    const table = String((a || {}).table ?? '').trim().slice(0, 12);
    data.push({ range: `אורחים!AE${row}`, values: [[table]] });
  }
  if (!data.length) return deny(400, 'no-matching-guests', origin);

  const r = await fetch(env.BRAIN_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchUpdate',
      method: 'POST',
      payload: JSON.stringify({ valueInputOption: 'RAW', data }),
    }),
  }).catch(() => null);
  if (!r || !r.ok) return deny(502, 'sheet-write-failed', origin);
  let out = null;
  try { out = await r.json(); } catch {}
  if (!out || !out.totalUpdatedCells) return deny(502, 'sheet-write-failed', origin);
  return okJson({ ok: true, updated: data.length }, origin);
}

/* ══ Manual ad-spend per month ═══════════════════════════════════════════════
   Richard types what he actually paid Meta/Google each month; the P&L board
   subtracts it. Stored as adspend:<YYYY-MM> in KV, no expiry.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleAdspend(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deny(503, 'kv-not-bound', origin);
  const m = String(body.month || '').slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(m) && body.ils != null) {
    await env.RATE.put('adspend:' + m, String(Math.max(0, Number(body.ils) || 0)));
  }
  const map = {};
  for (const [k, v] of Object.entries(await kvPrefix(env, 'adspend:'))) map[k] = Number(v) || 0;
  return okJson({ ok: true, adspend: map }, origin);
}

/* ══ Fixed monthly overheads ═════════════════════════════════════════════════
   Named line items per month (numbers rent, Make, whatever) — the P&L board
   always subtracts them. fixedcost:<YYYY-MM> holds a JSON array of
   {name, ils}; sending items replaces that month's list.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleFixedCost(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deny(503, 'kv-not-bound', origin);
  const m = String(body.month || '').slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(m) && Array.isArray(body.items)) {
    const items = body.items.slice(0, 30)
      .map(x => ({ name: String((x || {}).name || '').slice(0, 40), ils: Math.max(0, Number((x || {}).ils) || 0) }))
      .filter(x => x.name);
    await env.RATE.put('fixedcost:' + m, JSON.stringify(items));
  }
  const map = {};
  for (const [k, v] of Object.entries(await kvPrefix(env, 'fixedcost:'))) {
    try { map[k] = JSON.parse(v) || []; } catch { map[k] = []; }
  }
  return okJson({ ok: true, fixedcost: map }, origin);
}

/* ══ Cost log — the "what exactly did we spend" report ═══════════════════════
   Day by day (messages, calls) plus per-event totals, straight from the KV
   counters. The admin board renders it and exports CSV from it.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleCostLog(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);

  const [raw, waDays, shirDays, evCosts] = await Promise.all([
    fetchSnapshot(env.HOOK_STATUS),
    kvPrefix(env, 'wastat:'),
    kvPrefix(env, 'shircost:'),
    kvPrefix(env, 'evcost:'),
  ]);

  const days = {};
  const day = d => (days[d] = days[d] ||
    { date: d, wa_out: 0, wa_tmpl: 0, wa_fail: 0, wa_cost_usd_cents: 0, shir_cost_usd_cents: 0 });
  for (const [d, v] of Object.entries(waDays)) {
    let st = {}; try { st = JSON.parse(v) || {}; } catch {}
    const row = day(d);
    row.wa_out += Number(st.out) || 0;
    row.wa_tmpl += Number(st.tmpl) || 0;
    row.wa_fail += Number(st.fail) || 0;
    row.wa_cost_usd_cents += Math.round((Number(st.tmpl) || 0) * 0.02 * 100) / 100;
  }
  for (const [d, v] of Object.entries(shirDays)) day(d).shir_cost_usd_cents += Number(v) || 0;

  const events = [];
  for (const ev of (raw && raw.events && raw.events.values) || []) {
    const token = String(ev[1] || '').trim();
    const paid = String(ev[7] || '').trim() === 'כן';
    if (!token || !paid) continue;
    const t8 = token.slice(0, 8);
    events.push({
      token8: t8,
      client: String(ev[2] || '').trim(),
      name: String(ev[34] || ev[2] || '').trim(),
      occasion: String(ev[5] || '').trim(),
      date: String(ev[6] || '').trim(),
      plan: String(ev[31] || '').trim(),
      sum_ils: Number(String(ev[8] || '').replace(/[^\d.]/g, '')) || 0,
      cost_usd_cents: Number(evCosts[t8]) || 0,
      invoice: String(ev[9] || '').trim(),
      cancelled: String(ev[27] || '').trim() === 'כן',
    });
  }

  return okJson({
    ok: true,
    days: Object.values(days).sort((a, b) => a.date < b.date ? -1 : 1),
    events,
    generated_at: new Date().toISOString(),
  }, origin);
}

/* ══ AI kill-switch from the admin board ═════════════════════════════════════
   Writes פעיל/כבוי into מוח שירות!B1 (the same cell Richard edits by hand)
   and busts the 3-minute brain cache so the change bites immediately.
   POST {admin_key} reads the state; POST {admin_key, active:bool} sets it.
   ─────────────────────────────────────────────────────────────────────────── */
async function setBrainActive(env, active) {
  if (!env.BRAIN_HOOK) return false;
  const r = await fetch(env.BRAIN_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchUpdate',
      method: 'POST',
      /* the Make proxy maps `payload` verbatim into the request body only when
         it is a pre-serialized JSON string — an object arrives empty */
      payload: JSON.stringify({
        valueInputOption: 'RAW',
        data: [{ range: 'מוח שירות!B1', values: [[active ? 'פעיל' : 'כבוי']] }],
      }),
    }),
  }).catch(() => null);
  if (!(r && r.ok)) return false;
  let out = null;
  try { out = await r.json(); } catch { return false; }
  if (!out || !out.totalUpdatedCells) return false;
  if (env.RATE) await env.RATE.delete('brain:cache').catch(() => {});
  return true;
}

async function handleBrainToggle(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (typeof body.active === 'boolean') {
    const ok = await setBrainActive(env, body.active);
    if (!ok) return deny(502, 'sheet-write-failed', origin);
    /* KV delete is eventually consistent — answer from what we just wrote */
    return okJson({ ok: true, active: body.active }, origin);
  }
  const brain = await getBrain(env);
  return okJson({ ok: true, active: brain.active }, origin);
}

/* ══ the brain board ═════════════════════════════════════════════════════════
   Read and edit נועה's whole brain (the "מוח שירות" tab) from brain.html,
   without opening the spreadsheet: persona (B2), the on/off switch (B1), the
   two end-of-event links (D1/D2) and the Q&A rows (A5:B80).
   POST {admin_key, action:'get'} → the brain as JSON.
   POST {admin_key, action:'set', persona?, active?, reviewLink?,
         testimonialLink?, faq?:[[q,a],…]} → writes only what was passed.
   faq replaces the whole block: sent rows first, blanks through row 80 behind
   them, so a deleted question actually disappears (no batchClear needed).
   ─────────────────────────────────────────────────────────────────────────── */
async function handleBrainAdmin(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  const action = String(body.action || 'get');

  if (action === 'get') {
    if (env.RATE) await env.RATE.delete('brain:cache').catch(() => {});   // the editor wants the sheet, not a 3-minute-old copy
    const brain = await getBrain(env);
    return okJson({ ok: true, ...brain }, origin);
  }

  if (action !== 'set') return deny(400, 'unknown-action', origin);
  const data = [];
  if (typeof body.active === 'boolean') {
    data.push({ range: 'מוח שירות!B1', values: [[body.active ? 'פעיל' : 'כבוי']] });
  }
  if (typeof body.persona === 'string') {
    data.push({ range: 'מוח שירות!B2', values: [[body.persona.trim().slice(0, 4000)]] });
  }
  if (typeof body.reviewLink === 'string') {
    data.push({ range: 'מוח שירות!D1', values: [[body.reviewLink.trim().slice(0, 500)]] });
  }
  if (typeof body.testimonialLink === 'string') {
    data.push({ range: 'מוח שירות!D2', values: [[body.testimonialLink.trim().slice(0, 500)]] });
  }
  if (Array.isArray(body.faq)) {
    const rows = body.faq
      .map(p => [String((p && p[0]) || '').trim().slice(0, 300), String((p && p[1]) || '').trim().slice(0, 1500)])
      .filter(p => p[0] && p[1])
      .slice(0, 60);
    while (rows.length < 76) rows.push(['', '']);   // rows 5..80: blanks erase what was removed
    data.push({ range: 'מוח שירות!A5:B80', values: rows });
  }
  if (!data.length) return deny(400, 'nothing-to-write', origin);
  const ok = await sheetBatchWrite(env, data);
  if (!ok) return deny(502, 'sheet-write-failed', origin);
  if (env.RATE) await env.RATE.delete('brain:cache').catch(() => {});
  return okJson({ ok: true, wrote: data.map(d => d.range) }, origin);
}

async function handleDailyRun(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  return okJson(await runDailyEngine(env, !!body.dry, body.today), origin);
}

/* ══ Retell admin proxy ══════════════════════════════════════════════════════
   RETELL_KEY exists only in this Worker's secrets, so Retell account plumbing
   (importing the Telnyx number, binding agents) is driven through here rather
   than a key on any laptop. POST {admin_key, path, method?, payload?} — path
   must start with '/' and is hit verbatim on api.retellai.com.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleShirAdmin(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RETELL_KEY) return deny(503, 'shir-not-configured', origin);
  const path = String(body.path || '');
  if (!path.startsWith('/')) return deny(400, 'bad-path', origin);
  const method = String(body.method || 'GET').toUpperCase();
  const init = { method, headers: { Authorization: `Bearer ${env.RETELL_KEY}` } };
  if (body.payload !== undefined && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body.payload);
  }
  const r = await fetch(`https://api.retellai.com${path}`, init).catch(() => null);
  if (!r) return deny(502, 'retell-unreachable', origin);
  let out = null;
  try { out = await r.json(); } catch { out = null; }
  return okJson({ ok: r.ok, status: r.status, data: out }, origin);
}

/* ══ message performance ═════════════════════════════════════════════════════
   tstat:<template>:<occasion> counts sent/fail/replied (reply credited by the
   inbound webhook against lastout:<phone>). This is the raw feed for "which
   wording works for which event type" — the digest ranks it weekly in Slack,
   and improvement stays a human decision until Richard automates it.
   ─────────────────────────────────────────────────────────────────────────── */
async function msgStats(env) {
  const raw = await kvPrefix(env, 'tstat:');
  const rows = [];
  for (const [k, v] of Object.entries(raw)) {
    /* kvPrefix already strips "tstat:", so k is "<template>:<occasion>".
       Split on the first colon only — an occasion may contain one. */
    const i = k.indexOf(':');
    const tmpl = i < 0 ? k : k.slice(0, i);
    const occ = i < 0 ? '-' : k.slice(i + 1);
    let st = null; try { st = JSON.parse(v); } catch {}
    if (!st) continue;
    const sent = Number(st.sent) || 0;
    rows.push({
      template: tmpl, occasion: occ === '-' ? '' : occ,
      sent, fail: Number(st.fail) || 0, replied: Number(st.replied) || 0,
      reply_rate: sent ? Math.round((Number(st.replied) || 0) / sent * 100) : 0,
    });
  }
  rows.sort((a, b) => b.sent - a.sent);
  return rows;
}

async function handleMsgStats(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  return okJson({ ok: true, stats: await msgStats(env) }, origin);
}

async function msgPerformanceDigest(env) {
  const rows = (await msgStats(env)).filter(r => r.sent >= 20);
  if (!rows.length) return;
  const byRate = [...rows].sort((a, b) => b.reply_rate - a.reply_rate);
  const best = byRate[0], worst = byRate[byRate.length - 1];
  const lines = rows.slice(0, 8).map(r =>
    `· ${r.template}${r.occasion ? ' (' + r.occasion + ')' : ''}: ${r.sent} נשלחו, ${r.reply_rate}% ענו${r.fail ? ', ' + r.fail + ' נכשלו' : ''}`);
  await slackPost(env,
    `📊 *ביצועי הודעות — סיכום שבועי*\n${lines.join('\n')}\n\n` +
    `🏆 הכי טובה: ${best.template}${best.occasion ? ' (' + best.occasion + ')' : ''} — ${best.reply_rate}% מענה\n` +
    (worst !== best ? `🔻 הכי חלשה: ${worst.template}${worst.occasion ? ' (' + worst.occasion + ')' : ''} — ${worst.reply_rate}% מענה. רוצים נוסח משופר? תבקשו מקלוד והוא יגיש גרסה לאישור.` : ''));
}

/* ══ Re-sending the invitation ═══════════════════════════════════════════════
   A guest asks Shir (or writes in) to send the invitation again. If they have
   already answered, the re-send must NOT carry the RSVP buttons: pressing one
   a second time would overwrite what they already told us. So the reply states
   what we have on record and asks for nothing.
   ─────────────────────────────────────────────────────────────────────────── */
async function resendInvitation(env, guestPhone) {
  const phone = normPhone(guestPhone);
  if (!phone) return { ok: false, why: 'no-phone' };
  if (await sendingPaused(env)) return { ok: false, why: 'paused' };
  if (await phoneBlocked(env, phone)) return { ok: false, why: 'opted-out' };
  if (await overBudget(env, 'rl:resend:' + phone, 3, 3600)) return { ok: false, why: 'too-many' };

  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (!raw) return { ok: false, why: 'reader-failed' };
  const guest = findGuestByPhone(raw, phone, ilDate());
  if (!guest) return { ok: false, why: 'not-a-guest' };

  const evRows = (raw.events && raw.events.values) || [];
  const ev = evRows.find(r => String((r || [])[1] || '').trim() === String(guest.token || '').trim());
  if (!ev) return { ok: false, why: 'event-not-found' };
  if (String(ev[27] || '').trim() === 'כן') return { ok: false, why: 'cancelled' };

  const gname = String(guest.name || '').trim() || 'אורח יקר';
  const occasion = String(ev[5] || '').trim() || 'אירוע';
  const hosts = String(ev[34] || ev[2] || '').trim() || 'בעלי השמחה';
  const date = heDate(String(ev[6] || '').trim());
  const time = String(ev[36] || '').trim() || 'בשעות הערב';
  const venue = [String(ev[38] || '').trim(), String(ev[37] || '').trim()].filter(Boolean).join(', ') || 'פרטים בהמשך';
  const invite = String(ev[44] || '').trim();
  const rsvp = String(guest.rsvp || '').trim();

  /* already answered → no buttons, and say what we have so they do not
     re-answer and overwrite themselves */
  if (rsvp === 'מגיע' || rsvp === 'לא מגיע') {
    const party = Number(guest.party) || 0;
    const said = rsvp === 'מגיע'
      ? (party > 1 ? `מגיעים, ${party} אורחים` : 'מגיעים')
      : 'לא מגיעים';
    const wa = await sendTemplate(env, phone, 'ishur_hazmana_shuv',
      [gname, occasion, hosts, date, time, venue, said], '', 'he', 'guests',
      { occasion, wave: 'resend', token: guest.token });
    if (wa.ok) await addEvCost(env, guest.token, msgCost('ishur_hazmana_shuv'));
    return { ok: wa.ok, mode: 'no-buttons', rsvp, why: wa.error };
  }

  /* never answered, or still undecided → the normal invitation, buttons and all */
  const wa = await sendTemplate(env, phone, 'hazmana_ishur',
    [gname, occasion, hosts, date, time, venue], '', 'he', 'guests',
    { occasion, wave: 'resend', token: guest.token });
  if (wa.ok) await addEvCost(env, guest.token, msgCost('hazmana_ishur'));
  return { ok: wa.ok, mode: 'with-buttons', rsvp: rsvp || 'לא ענה', why: wa.error };
}

/* Shir calls this mid-conversation; the inbox and the service bot use it too. */
async function handleResend(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  const viaAdmin = isAdmin(env, body.admin_key);
  const viaShir = env.RETELL_KEY && String(body.shir_key || '') === env.RETELL_KEY;
  if (!viaAdmin && !viaShir) return deny(403, 'bad-key', origin);
  const res = await resendInvitation(env, body.phone);
  return okJson(res, origin);
}

/* ══ Call cost sync ══════════════════════════════════════════════════════════
   Retell's webhook is best-effort: a missed delivery means a call whose cost
   we never learn, and the money board quietly under-reports. So we pull
   instead of waiting to be pushed. Idempotent per call id, so running it
   twice costs nothing and fixes gaps.
   ─────────────────────────────────────────────────────────────────────────── */
const USD_ILS = 3.7;

async function syncCallCosts(env, limit = 100) {
  if (!env.RETELL_KEY || !env.RATE) return { ok: false, why: 'not-configured' };
  const r = await fetch('https://api.retellai.com/v2/list-calls', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit, sort_order: 'descending' }),
  }).catch(() => null);
  if (!r || !r.ok) return { ok: false, why: 'retell-unreachable' };
  let calls = null;
  try { calls = await r.json(); } catch {}
  if (!Array.isArray(calls)) return { ok: false, why: 'bad-response' };

  let added = 0, skipped = 0, cents = 0;
  for (const c of calls) {
    const id = String(c.call_id || '');
    if (!id) continue;
    /* one call is counted once, ever */
    if (await env.RATE.get('costdone:' + id)) { skipped++; continue; }
    const cc = c.call_cost || {};
    const amount = typeof cc.combined_cost === 'number' ? cc.combined_cost : 0;
    if (!amount || !c.end_timestamp) continue; // still running, or free
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' })
      .format(new Date(c.end_timestamp));
    const key = 'shircost:' + day;
    const cur = Number(await env.RATE.get(key)) || 0;
    await env.RATE.put(key, String(cur + amount), { expirationTtl: 400 * 86400 });
    /* and onto the event, so per-event profit includes the calls */
    const gid = String((c.metadata || {}).guest_id || '');
    if (gid) await addEvCost(env, gid, amount);
    await env.RATE.put('costdone:' + id, '1', { expirationTtl: 400 * 86400 });
    added++; cents += amount;
  }
  return { ok: true, added, skipped, cents: Math.round(cents * 100) / 100,
           ils: Math.round(cents / 100 * USD_ILS * 100) / 100 };
}

async function handleCostSync(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  return okJson(await syncCallCosts(env, Math.min(Number(body.limit) || 100, 500)), origin);
}

/* ══ The controls Richard reaches for ════════════════════════════════════════
   Everything here is reversible on purpose. The destructive-feeling actions
   are the ones that STOP things, and stopping is always undoable, so the
   confirmation lives in the interface rather than in a second API call.
   ─────────────────────────────────────────────────────────────────────────── */

/* POST {admin_key} reads · POST {admin_key, paused:bool} sets */
async function handlePause(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deny(503, 'no-kv', origin);
  if (typeof body.paused !== 'boolean') {
    return okJson({ ok: true, paused: await sendingPaused(env) }, origin);
  }
  if (body.paused) {
    await env.RATE.put('paused', new Date().toISOString());
    await slackPost(env, '⏸️ *כל השליחות הושהו* — אף הודעה לא תצא, כולל המנוע היומי ושיחות של שיר, עד להפעלה מחדש.');
  } else {
    await env.RATE.delete('paused');
    /* re-arm today: pausing over the 06:35 run used to mean the pacer said
       "nothing-pending" until tomorrow, so unpausing at 08:00 still lost the
       whole day (review finding #3) */
    await env.RATE.put('pacer:pending', ilDate(), { expirationTtl: 2 * 86400 }).catch(() => {});
    await slackPost(env, '▶️ *השליחות חזרו לפעול* — הפעימה הקרובה (עד 10 דקות) ממשיכה מאיפה שעצרנו.');
  }
  return okJson({ ok: true, paused: body.paused }, origin);
}

/* POST {admin_key, phone} reads · {admin_key, phone, blocked:bool} sets.
   Blocking one number by hand, and unblocking it, including numbers that
   opted themselves out — Richard asked to be able to undo that too. */
async function handleBlockPhone(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deny(503, 'no-kv', origin);
  const p = normPhone(body.phone);
  if (!p || p.length < 9) return deny(400, 'bad-phone', origin);
  if (typeof body.blocked !== 'boolean') {
    return okJson({
      ok: true, phone: p,
      blocked: !!(await env.RATE.get('block:' + p)),
      opted_out: !!(await env.RATE.get('optout:' + p)),
    }, origin);
  }
  if (body.blocked) {
    await env.RATE.put('block:' + p, new Date().toISOString());
  } else {
    /* releasing clears both, so a number can be restored whichever way it
       stopped receiving messages */
    await env.RATE.delete('block:' + p);
    await env.RATE.delete('optout:' + p);
  }
  await slackPost(env, `${body.blocked ? '🚫' : '✅'} *${p}* ${body.blocked ? 'הוצא משליחה ידנית' : 'הוחזר לשליחה'}`);
  return okJson({ ok: true, phone: p, blocked: body.blocked }, origin);
}

/* ══ Telnyx watch ════════════════════════════════════════════════════════════
   Shir's Israeli number sat in Telnyx regulatory review. This runs on its own
   morning cron and does the whole thing: the moment the number goes active it
   attaches it to the SIP connection Retell dials through, then says so in
   Slack. While it is still pending it says that too, once a day, so the wait
   is visible without anyone opening a portal. Goes quiet once wired.
   ─────────────────────────────────────────────────────────────────────────── */
const TELNYX_CONNECTION_ID = '3038128441548342863'; // FQDN connection "retell-shir"

async function checkTelnyx(env) {
  if (!env.TELNYX_KEY) return { ok: false, why: 'no-key' };
  if (env.RATE && await env.RATE.get('telnyxdone')) return { ok: true, why: 'already-wired' };

  const h = { Authorization: 'Bearer ' + env.TELNYX_KEY };
  const r = await fetch('https://api.telnyx.com/v2/phone_numbers', { headers: h }).catch(() => null);
  if (!r || !r.ok) {
    await alert(env, 'טלניקס', 'לא הצלחתי לקרוא את סטטוס המספר', r ? String(r.status) : 'unreachable');
    return { ok: false, why: 'unreachable' };
  }
  let j = null;
  try { j = await r.json(); } catch {}
  const num = ((j && j.data) || [])[0];
  if (!num) {
    await alert(env, 'טלניקס', 'אין מספרים בחשבון — משהו לא צפוי', '');
    return { ok: false, why: 'no-numbers' };
  }

  const status = String(num.status || '');
  const phone = String(num.phone_number || '');
  if (status !== 'active') {
    await slackPost(env, `⏳ *המספר של שיר עדיין לא פעיל*\n${phone} · סטטוס: ${status}\nאם זה נמשך, שווה לדחוף בצ'אט התמיכה (טיקט 620361).`);
    return { ok: true, why: status };
  }

  /* active: attach it to the SIP connection so Retell can dial through it */
  let wired = String(num.connection_id || '') === TELNYX_CONNECTION_ID;
  if (!wired) {
    const p = await fetch('https://api.telnyx.com/v2/phone_numbers/' + num.id, {
      method: 'PATCH',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: TELNYX_CONNECTION_ID }),
    }).catch(() => null);
    wired = !!p && p.ok;
  }
  if (wired && env.RATE) await env.RATE.put('telnyxdone', new Date().toISOString());
  await slackPost(env, wired
    ? `🎉 *המספר של שיר פעיל וחובר*\n${phone} משויך לחיבור ה-SIP, ורטל יכולה לחייג דרכו.\nנשאר רק להריץ שיחת בדיקה.`
    : `✅ *המספר של שיר אושר* (${phone}) אבל השיוך לחיבור ה-SIP נכשל. צריך לשייך ידנית בפורטל.`);
  return { ok: true, why: wired ? 'wired' : 'active-not-wired' };
}

/* Admin can ask at any time instead of waiting for the morning run. */
async function handleTelnyxCheck(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  return okJson(await checkTelnyx(env), origin);
}

/* ══ Client changes a send date ══════════════════════════════════════════════
   Everything the client does happens in their dashboard, never by asking us on
   WhatsApp. Token-authed, and every rule the upload page enforces is enforced
   again here: a wave that already went out is frozen, dates must be ahead of
   today and before the event, Shabbat is refused, and the invitation always
   stays before the chase.
   POST {token, send:'invite'|'reminder'|'extra', date:'YYYY-MM-DD'}
   ─────────────────────────────────────────────────────────────────────────── */
const SEND_COL = { invite: { n: 1, idx: 39, col: 'AN' }, reminder: { n: 2, idx: 40, col: 'AO' }, extra: { n: 3, idx: 41, col: 'AP' } };

async function handleSendDate(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  const token = String(body.token || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(token)) return deny(403, 'bad-token', origin);
  if (!(await tokenRecord(env, token))) return deny(404, 'unknown-token', origin);
  if (await overBudget(env, 'rl:senddate:' + token, 20, 3600)) return deny(429, 'slow-down', origin);

  const spec = SEND_COL[String(body.send || '').trim()];
  if (!spec) return deny(400, 'bad-send', origin);
  const date = String(body.date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return deny(400, 'bad-date', origin);

  /* a wave that already went out cannot be moved */
  if (env.RATE && await env.RATE.get(`wave:${token}:${spec.n}`)) {
    return deny(409, 'already-sent', origin);
  }

  const raw = await fetchSnapshot(env.HOOK_STATUS);
  if (!raw) return deny(502, 'reader-failed', origin);
  const evRows = (raw.events && raw.events.values) || [];
  const idx = evRows.findIndex(r => String((r || [])[1] || '').trim() === token);
  if (idx < 0) return deny(404, 'event-not-found', origin);
  const ev = evRows[idx];
  if (String(ev[27] || '').trim() === 'כן') return deny(409, 'event-cancelled', origin);

  const today = ilDate();
  const evDate = String(ev[6] || '').trim().slice(0, 10);
  if (date < today) return deny(422, 'date-in-past', origin);
  if (/^\d{4}-\d{2}-\d{2}$/.test(evDate) && date >= evDate) return deny(422, 'after-event', origin);
  if (new Date(date + 'T12:00:00Z').getUTCDay() === 6) return deny(422, 'shabbat', origin);

  /* keep the order sane: invitation, then chase, then extra */
  const others = {
    1: String(ev[39] || '').trim().slice(0, 10),
    2: String(ev[40] || '').trim().slice(0, 10),
    3: String(ev[41] || '').trim().slice(0, 10),
  };
  others[spec.n] = date;
  const seq = [others[1], others[2], others[3]].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  for (let i = 1; i < seq.length; i++) if (seq[i] <= seq[i - 1]) return deny(422, 'out-of-order', origin);

  const row = idx + 2; // values start at A2
  const r = await fetch(env.BRAIN_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchUpdate',
      method: 'POST',
      payload: JSON.stringify({
        valueInputOption: 'RAW',
        data: [{ range: `אירועים!${spec.col}${row}`, values: [[date]] }],
      }),
    }),
  }).catch(() => null);
  if (!r || !r.ok) return deny(502, 'sheet-write-failed', origin);
  let out = null;
  try { out = await r.json(); } catch {}
  if (!out || !out.totalUpdatedCells) return deny(502, 'sheet-write-failed', origin);
  return okJson({ ok: true, send: body.send, date }, origin);
}

/* ══ Meta admin proxy ════════════════════════════════════════════════════════
   WA_TOKEN lives only in this Worker's secrets. Template management and Graph
   lookups go through here so the token never sits on a laptop or in /tmp.
   POST {admin_key, path, method?, payload?} — path is hit on graph.facebook.com.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleMetaAdmin(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.WA_TOKEN) return deny(503, 'wa-not-configured', origin);
  const path = String(body.path || '');
  if (!path.startsWith('/')) return deny(400, 'bad-path', origin);
  const method = String(body.method || 'GET').toUpperCase();
  const init = { method, headers: { Authorization: 'Bearer ' + env.WA_TOKEN } };
  if (body.payload !== undefined && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body.payload);
  }
  const r = await fetch('https://graph.facebook.com/v21.0' + path, init).catch(() => null);
  if (!r) return deny(502, 'meta-unreachable', origin);
  let out = null;
  try { out = await r.json(); } catch { out = null; }
  return okJson({ ok: r.ok, status: r.status, data: out }, origin);
}

/* ══ Money & sources board ═══════════════════════════════════════════════════
   Admin-gated: revenue per day (from the events sheet), messaging + call costs
   per day (from KV counters), and lead sources (utm) from the leads sheet.
   ─────────────────────────────────────────────────────────────────────────── */
async function kvPrefix(env, prefix) {
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

/* Meta's daily business-initiated-conversation ceiling for the sending number.
   Cached 6 hours — the tier only moves when Meta bumps it. The whatsapp.js
   sender reads the same KV entry to fire the 80% alert mid-wave. */
async function waCapInfo(env) {
  const TIERS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: 0 };
  let cached = null;
  if (env.RATE) { try { cached = JSON.parse(await env.RATE.get('wa:cap')); } catch {} }
  if (cached) return cached;
  /* the cap that matters is the SENDING number's — guests once fully wired */
  const guestsReady = !!(env.WA_PHONE_ID_GUESTS && env.WA_TOKEN_GUESTS);
  const capPhone = guestsReady ? env.WA_PHONE_ID_GUESTS : env.WA_PHONE_ID;
  const capToken = guestsReady ? env.WA_TOKEN_GUESTS : env.WA_TOKEN;
  if (!capToken || !capPhone) return null;
  const r = await fetch(`https://graph.facebook.com/v21.0/${capPhone}?fields=messaging_limit_tier,quality_rating`, {
    headers: { Authorization: 'Bearer ' + capToken },
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || !j.messaging_limit_tier) return null;
  cached = {
    tier: j.messaging_limit_tier,
    limit: TIERS[j.messaging_limit_tier] ?? 250,
    quality: j.quality_rating || '',
  };
  if (env.RATE) await env.RATE.put('wa:cap', JSON.stringify(cached), { expirationTtl: 6 * 3600 }).catch(() => {});
  return cached;
}

async function handleOpsStats(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);

  const [raw, waDays, shirDays, leadsRes] = await Promise.all([
    fetchSnapshot(env.HOOK_STATUS),
    kvPrefix(env, 'wastat:'),
    kvPrefix(env, 'shircost:'),
    env.BRAIN_HOOK ? fetch(env.BRAIN_HOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'spreadsheets/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/values:batchGet',
        qk1: 'ranges', qv1: 'לידים - לא סגרו!A2:P500',
      }),
    }).catch(() => null) : null,
  ]);

  /* revenue per day: paid, not cancelled, dated by the Grow-payment stamp */
  const days = {};
  const day = d => (days[d] = days[d] ||
    { date: d, revenue_ils: 0, payments: 0, wa_msgs: 0, wa_cost_usd_cents: 0, shir_cost_usd_cents: 0 });
  for (const ev of (raw && raw.events && raw.events.values) || []) {
    const paid = String(ev[7] || '').trim() === 'כן';
    const cancelled = String(ev[27] || '').trim() === 'כן';
    const m = String(ev[25] || '').match(/\d{4}-\d{2}-\d{2}/);
    if (!paid || cancelled || !m) continue;
    const d = day(m[0]);
    d.revenue_ils += Number(String(ev[8] || '').replace(/[^\d.]/g, '')) || 0;
    d.payments += 1;
  }
  for (const [d, v] of Object.entries(waDays)) {
    let st = {}; try { st = JSON.parse(v) || {}; } catch {}
    const row = day(d);
    row.wa_msgs += Number(st.out) || 0;
    /* utility template ≈ $0.0053; free-form service messages cost nothing */
    row.wa_cost_usd_cents += Math.round((Number(st.tmpl) || 0) * 0.02 * 100) / 100;
  }
  for (const [d, v] of Object.entries(shirDays)) {
    day(d).shir_cost_usd_cents += Number(v) || 0;
  }

  /* lead sources */
  const utm = {};
  let leadRows = [];
  if (leadsRes && leadsRes.ok) {
    try { leadRows = (await leadsRes.json()).valueRanges[0].values || []; } catch {}
  }
  for (const r of leadRows) {
    if (!String((r || [])[2] || '').trim()) continue;
    const src = String(r[11] || '').trim() || 'ישיר / לא ידוע';
    utm[src] = (utm[src] || 0) + 1;
  }

  /* today's business-initiated sends against Meta's ceiling */
  const cap = await waCapInfo(env);
  let usedToday = 0;
  try { usedToday = Number((JSON.parse(waDays[ilDate()] || '{}') || {}).tmpl) || 0; } catch {}

  const adspend = {};
  for (const [k, v] of Object.entries(await kvPrefix(env, 'adspend:'))) adspend[k] = Number(v) || 0;
  const fixedcost = {};
  for (const [k, v] of Object.entries(await kvPrefix(env, 'fixedcost:'))) {
    try { fixedcost[k] = JSON.parse(v) || []; } catch { fixedcost[k] = []; }
  }

  return okJson({
    ok: true,
    series: Object.values(days).sort((a, b) => a.date < b.date ? -1 : 1),
    utm: Object.entries(utm).sort((a, b) => b[1] - a[1]),
    leads_total: leadRows.filter(r => String((r || [])[2] || '').trim()).length,
    wa_cap: cap ? { ...cap, used_today: usedToday } : null,
    adspend,
    fixedcost,
    generated_at: new Date().toISOString(),
  }, origin);
}

/* ══ Shir call monitoring ════════════════════════════════════════════════════
   Admin-gated proxy to Retell: live concurrency, today's cost, recent calls
   with duration / cost / recording / transcript. Feeds the admin board.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleShirCalls(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RETELL_KEY) return deny(503, 'shir-not-configured', origin);

  const auth = { Authorization: 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' };
  const [callsRes, concRes] = await Promise.all([
    fetch('https://api.retellai.com/v2/list-calls', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ sort_order: 'descending', limit: Math.min(Number(body.limit) || 30, 100) }),
    }).catch(() => null),
    fetch('https://api.retellai.com/get-concurrency', { headers: auth }).catch(() => null),
  ]);

  let calls = [];
  if (callsRes && callsRes.ok) { try { calls = await callsRes.json(); } catch {} }
  if (!Array.isArray(calls)) calls = [];
  let conc = {};
  if (concRes && concRes.ok) { try { conc = await concRes.json(); } catch {} }

  const slim = calls.map(c => ({
    id: c.call_id || '',
    status: c.call_status || '',
    type: c.call_type || '',
    from: c.from_number || '',
    to: c.to_number || '',
    started_at: c.start_timestamp || null,
    duration_s: c.start_timestamp && c.end_timestamp
      ? Math.round((c.end_timestamp - c.start_timestamp) / 1000) : null,
    cost_usd_cents: (c.call_cost && c.call_cost.combined_cost) || 0,
    reason: c.disconnection_reason || '',
    sentiment: (c.call_analysis && c.call_analysis.user_sentiment) || '',
    /* what the guest actually answered, and whether the call did its job.
       The outcome comes from the tool Shir calls mid-conversation; the
       custom analysis fields are filled by Retell after the call. */
    guest_id: String((c.metadata || {}).guest_id || ''),
    /* What kind of call this WAS. A number can be a guest at one event and a
       lead of ours at the same time, so the type belongs to the call. Calls
       placed before this field existed are guest RSVP calls; an inbound call
       carries no metadata of ours at all, so direction decides. */
    call_kind: String((c.metadata || {}).kind ||
      (String(c.direction || c.call_type || '').includes('inbound') ? 'inbound' : 'guest')),
    direction: String(c.direction || '').includes('inbound') ? 'inbound' : 'outbound',
    outcome: String(((c.call_analysis || {}).custom_analysis_data || {}).outcome || ''),
    party_size: ((c.call_analysis || {}).custom_analysis_data || {}).party_size ?? null,
    productive: !!((c.call_analysis || {}).custom_analysis_data || {}).got_answer,
    needs_review: !!((c.call_analysis || {}).custom_analysis_data || {}).needs_review,
    agent_quality: ((c.call_analysis || {}).custom_analysis_data || {}).agent_quality ?? null,
    quality_note: String(((c.call_analysis || {}).custom_analysis_data || {}).quality_note || ''),
    summary: String((c.call_analysis || {}).call_summary || '').slice(0, 400),
    recording_url: c.recording_url || '',
    transcript: String(c.transcript || '').slice(0, 8000),
  }));

  const costToday = env.RATE ? Number(await env.RATE.get('shircost:' + ilDate())) || 0 : 0;
  return okJson({
    ok: true,
    live: {
      now: Number(conc.current_concurrency) || 0,
      limit: Number(conc.concurrency_limit) || 0,
    },
    cost_today_usd_cents: costToday,
    calls: slim,
    generated_at: new Date().toISOString(),
  }, origin);
}

/* ══ WhatsApp sending ════════════════════════════════════════════════════════
   Admin-gated. Make's daily engine calls this instead of the WhatsApp module,
   so every message goes out through code we control and can log.
   modes: text | image | template | invite (build the invitation body for us)
   ─────────────────────────────────────────────────────────────────────────── */
async function handleWaSend(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, body.admin_key)) {
    return deny(403, 'bad-admin-key', origin);
  }
  const to = String(body.to || '').trim();
  if (!to) return deny(400, 'no-recipient', origin);

  let res;
  switch (String(body.mode || 'text')) {
    case 'template':
      res = await sendTemplate(env, to, body.template, body.params || [], body.image_url || '', body.lang || 'he', body.channel);
      break;
    case 'image':
      res = await sendImage(env, to, body.image_url, body.caption || '', body.channel);
      break;
    case 'invite': {
      const text = inviteText(body.event || {});
      res = body.image_url
        ? await sendImage(env, to, body.image_url, text)
        : await sendText(env, to, text);
      break;
    }
    default:
      res = await sendText(env, to, body.text || '');
  }
  return okJson(res, origin);
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
  /* the mirror. Serving the pages from go.ishur.io was only half the job: the
     browser still refused every API call from them, because this list did not
     know the host. The page loaded and nothing on it worked. */
  'https://go.ishur.io',
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

/* ══ go.ishur.io ═════════════════════════════════════════════════════════════
   Bezeq's SecuringSam blocklisted this site by exact hostname. Measured, not
   guessed: the same TLS handshake to the same GitHub Pages IP is killed for
   `ishur.io` and `www.ishur.io`, and passes for every other subdomain. So a
   customer on a filtered line gets a block page instead of the upload link
   they paid for — while Chrome works, because it hides the hostname.

   This serves the identical site from a name the filter does not know. The
   Worker fetches ishur.io from Cloudflare's network, which is nowhere near
   Bezeq's middlebox, so the origin is unchanged and there is one site to
   maintain, not two.

   It is a bypass, not a fix. The fix is getting the domain delisted; this
   exists so nobody who paid is stuck while that happens.
   ────────────────────────────────────────────────────────────────────────── */
const MIRROR_HOST = 'go.ishur.io';

/* Kept for the promo bounce below. Sent links deliberately still point at
   ishur.io: moving them all was a decision to make, not one to assume. */
const LINK_BASE = 'https://' + MIRROR_HOST;

async function serveMirror(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method-not-allowed', { status: 405 });
  }
  const target = 'https://ishur.io' + url.pathname + url.search;
  let up;
  try {
    up = await fetch(target, {
      method: request.method,
      headers: { 'Accept': request.headers.get('Accept') || '*/*',
                 'Accept-Language': request.headers.get('Accept-Language') || 'he' },
      redirect: 'follow',
    });
  } catch {
    return new Response('origin-unreachable', { status: 502 });
  }

  const type = up.headers.get('Content-Type') || '';
  const headers = new Headers();
  headers.set('Content-Type', type || 'text/html; charset=utf-8');
  const cc = up.headers.get('Cache-Control');
  if (cc) headers.set('Cache-Control', cc);
  /* the mirror must never compete with the real domain in search results */
  headers.set('X-Robots-Tag', 'noindex, nofollow');

  if (!type.includes('text/html')) {
    return new Response(up.body, { status: up.status, headers });
  }

  /* Absolute links back to ishur.io would drop the visitor straight back onto
     the blocked name mid-journey — the upload link, the terms page, the logo.
     Rewrite them to stay on this host. */
  let html = await up.text();
  html = html
    .replace(/https:\/\/www\.ishur\.io/g, 'https://' + MIRROR_HOST)
    .replace(/https:\/\/ishur\.io/g, 'https://' + MIRROR_HOST);
  /* except the canonical, which must keep pointing at the real site */
  html = html.replace(
    /<link([^>]*\brel=["']canonical["'][^>]*)href=["']https:\/\/go\.ishur\.io([^"']*)["']/gi,
    '<link$1href="https://ishur.io$2"');
  return new Response(html, { status: up.status, headers });
}

export default {
  /* the morning run: reports (and, next stage, the guest sending waves) */
  async scheduled(event, env, ctx) {
    /* the Tuesday reminder crons carry their own schedule string */
    /* 04:00 UTC = 07:00 in Israel through the summer. Telnyx is done, so this
       slot now carries the heartbeat: if the engine has not run in 30 hours,
       say so, because a silent engine is the failure nobody notices. */
    if (String(event.cron || '').startsWith('0 4 ')) {
      ctx.waitUntil((async () => {
        await checkTelnyx(env).catch(() => {});
        if (!env.RATE) return;
        const last = await env.RATE.get('engine:lastrun').catch(() => null);
        const age = last ? (Date.now() - Date.parse(JSON.parse(last).at || 0)) / 36e5 : 999;
        if (age > 30) {
          await alert(env, 'המנוע היומי',
            last ? `לא רץ כבר ${Math.round(age)} שעות` : 'אין תיעוד שרץ אי פעם', '');
        }
      })().catch(() => {}));
      return;
    }

    if (String(event.cron || '').startsWith('0 9,10,16')) {
      const hourUtc = new Date(event.scheduledTime || Date.now()).getUTCHours();
      ctx.waitUntil(runTeamReminders(env, hourUtc, false).catch(() => {}));
      return;
    }
    /* the ten-minute pacer: a slice of the sends and a slice of the dials,
       spread across the contact window instead of one burst at 09:35 */
    if (String(event.cron || '').startsWith('*/10')) {
      ctx.waitUntil(runPacer(env).catch(e =>
        alert(env, 'פייסר', 'סבב פריסה נפל', String((e && e.message) || e))));
      return;
    }
    ctx.waitUntil(syncCallCosts(env).catch(() => {}));
    /* Dialling belongs to the pacer now — it runs every ten minutes through
       the whole window instead of emptying 25 calls into the first minute of
       it. This cron keeps only the planning half of the morning. */
    /* Arm the day BEFORE the engine runs, not in its tail. When the morning
       snapshot failed, the tail never ran, pacer:pending kept yesterday's
       date, and all 143 remaining ticks answered "nothing-pending" — a whole
       day of invitations lost to one bad fetch (review finding #3). */
    ctx.waitUntil((async () => {
      if (env.RATE) await env.RATE.put('pacer:pending', ilDate(), { expirationTtl: 2 * 86400 }).catch(() => {});
    })());
    ctx.waitUntil(runDailyEngine(env, false, null, { budget: PACE_SENDS * 2 }).then(() => runBackup(env)).then(res => {
      if (res && !res.ok) return alert(env, 'גיבוי יומי', 'הגיבוי נכשל', res.error || '');
    }).catch(e => alert(env, 'מנוע יומי', 'הריצה נפלה באמצע',
      String((e && e.stack) || e).slice(0, 500))).then(() => {
      /* Monday morning: the weekly message-performance digest into Slack */
      const dow = new Date(ilDate() + 'T12:00:00Z').getUTCDay();
      if (dow === 1) return msgPerformanceDigest(env).catch(() => {});
    }).catch(() => {}));
  },

  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const route = ROUTES[url.pathname];

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    /* on the mirror host, anything that is not an API call is the website */
    if (url.hostname === MIRROR_HOST &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/promo/') &&
        !url.pathname.startsWith('/img/')) {
      return serveMirror(request, url);
    }
    if (url.pathname === '/api/grow-ipn' && request.method === 'POST') {
      return handleGrowIpn(request, env, url);
    }
    /* the same IPN with the key as a path segment — Grow's webhook form
       chokes on query strings, so it gets a URL with no ? at all */
    if (url.pathname.startsWith('/api/grow-ipn/k/') && request.method === 'POST') {
      url.searchParams.set('k', url.pathname.slice('/api/grow-ipn/k/'.length));
      return handleGrowIpn(request, env, url);
    }
    if (url.pathname === '/api/claim' && request.method === 'POST') {
      return handleClaim(request, env, origin);
    }
    if (url.pathname === '/promo/check' && request.method === 'GET') {
      return handlePromoCheck(env, request, url, origin);
    }
    if (url.pathname === '/promo/go' && request.method === 'GET') {
      return handlePromoGo(env, request, url, origin);
    }
    if (url.pathname === '/api/inbox-reindex' && request.method === 'POST') {
      return handleInboxReindex(request, env, origin);
    }
    if (url.pathname === '/api/pacer' && request.method === 'POST') {
      return (async () => {
        let b = {};
        try { b = await request.json(); } catch { return deny(400, 'bad-json', origin); }
        if (!isAdmin(env, b.admin_key)) return deny(403, 'bad-admin-key', origin);
        return okJson(await runPacer(env), origin);
      })();
    }
    if (url.pathname === '/api/promo' && request.method === 'POST') {
      return handlePromoAdmin(request, env, origin);
    }
    if (url.pathname.startsWith('/img/') && request.method === 'GET') {
      return serveImage(env, url.pathname);
    }
    if (url.pathname === '/api/shir-webhook' && request.method === 'POST') {
      return handleShirWebhook(request, env);
    }
    /* Retell asks who is calling, before the agent speaks */
    if (url.pathname === '/api/shir-inbound' && request.method === 'POST') {
      return handleShirInbound(request, env, url, origin);
    }
    if (url.pathname === '/api/shir-dispatch' && request.method === 'POST') {
      return handleShirDispatch(request, env, origin);
    }
    if (url.pathname === '/api/shir-calls' && request.method === 'POST') {
      return handleShirCalls(request, env, origin);
    }
    if (url.pathname === '/api/ops-stats' && request.method === 'POST') {
      return handleOpsStats(request, env, origin);
    }
    if (url.pathname === '/api/daily-run' && request.method === 'POST') {
      return handleDailyRun(request, env, origin);
    }
    if (url.pathname === '/api/brain-admin' && request.method === 'POST') {
      return handleBrainAdmin(request, env, origin);
    }
    if (url.pathname === '/api/brain-toggle' && request.method === 'POST') {
      return handleBrainToggle(request, env, origin);
    }
    if (url.pathname === '/api/shir-admin' && request.method === 'POST') {
      return handleShirAdmin(request, env, origin);
    }
    if (url.pathname === '/api/resend' && request.method === 'POST') {
      return handleResend(request, env, origin);
    }
    if (url.pathname === '/api/cost-sync' && request.method === 'POST') {
      return handleCostSync(request, env, origin);
    }
    if (url.pathname === '/api/pause' && request.method === 'POST') {
      return handlePause(request, env, origin);
    }
    if (url.pathname === '/api/block-phone' && request.method === 'POST') {
      return handleBlockPhone(request, env, origin);
    }
    if (url.pathname === '/api/telnyx-check' && request.method === 'POST') {
      return handleTelnyxCheck(request, env, origin);
    }
    if (url.pathname === '/api/send-date' && request.method === 'POST') {
      return handleSendDate(request, env, origin);
    }
    if (url.pathname === '/api/meta-admin' && request.method === 'POST') {
      return handleMetaAdmin(request, env, origin);
    }
    if (url.pathname === '/api/msg-stats' && request.method === 'POST') {
      return handleMsgStats(request, env, origin);
    }
    if (url.pathname === '/api/event-flag' && request.method === 'POST') {
      return handleEventFlag(request, env, origin);
    }
    if (url.pathname === '/api/ipn-replay' && request.method === 'POST') {
      return handleIpnReplay(request, env, origin);
    }
    if (url.pathname === '/api/backup' && request.method === 'POST') {
      return handleBackup(request, env, origin);
    }
    if (url.pathname === '/api/adspend' && request.method === 'POST') {
      return handleAdspend(request, env, origin);
    }
    if (url.pathname === '/api/seating' && request.method === 'POST') {
      return handleSeating(request, env, origin);
    }
    if (url.pathname === '/api/fixedcost' && request.method === 'POST') {
      return handleFixedCost(request, env, origin);
    }
    if (url.pathname === '/api/cost-log' && request.method === 'POST') {
      return handleCostLog(request, env, origin);
    }
    if (url.pathname === '/api/otp-send' && request.method === 'POST') {
      return handleOtpSend(request, env, origin);
    }
    if (url.pathname === '/api/inbox' && request.method === 'POST') {
      return handleInbox(request, env, origin);
    }
    if (url.pathname === '/api/remind-run' && request.method === 'POST') {
      return handleRemindRun(request, env, origin);
    }
    if (url.pathname === '/api/wa-send' && request.method === 'POST') {
      return handleWaSend(request, env, origin);
    }
    if (url.pathname === '/api/wa-webhook') {
      return handleWaWebhook(request, env, url);
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
      /* the routing fields have to be lifted too: the admin gate and the
         raw-append guard below both read stampFields, and a multipart body
         that carried only the four stamp keys sailed past both of them */
      ['app', 'nonce', 'stamp_ts', 'sig', 'event_type', 'append_body', 'guest_id', 'admin_key']
        .forEach(k => { stampFields[k] = form.get(k); });
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
        if (!isAdmin(env, admin)) return deny(403, 'bad-admin-key', origin);
        const raw = await fetchSnapshot(target);
        if (!raw) return deny(502, 'reader-failed', origin);
        if (stampFields.view === 'biz') return okJson(buildBizStats(raw), origin);
        return okJson(buildCallQueue(raw), origin);
      }
      const token = String(stampFields.token || '').trim();
      if (!token) {
        /* phone + code login (the gate). The code arrived via ishur_kod. */
        const phone = normPhone(stampFields.phone || '');
        const code = String(stampFields.code || '').replace(/\D/g, '');
        if (!phone || code.length < 4) return deny(403, 'bad-login', origin);
        if (!env.RATE) return deny(503, 'kv-not-bound', origin);
        if (await overBudget(env, 'rl:login:' + phone, 12, 3600)) return deny(429, 'rate-limited', origin);
        let rec = null;
        try { rec = JSON.parse(await env.RATE.get('otp:' + phone)); } catch {}
        const good = rec && (rec.tries || 0) < 6 && safeEqual(String(rec.code), code);
        if (!good) {
          if (rec) {
            /* keep the record's own remaining lifetime — a stranger guessing
               wrong must not shorten a legitimate month-long session */
            const left = Math.max(60, (Number(rec.exp) || Math.floor(Date.now() / 1000) + 600) - Math.floor(Date.now() / 1000));
            await env.RATE.put('otp:' + phone,
              JSON.stringify({ ...rec, tries: (rec.tries || 0) + 1 }), { expirationTtl: left });
          }
          return deny(403, 'bad-login', origin);
        }
        /* a code that logged in once keeps working on this phone for a month */
        await env.RATE.put('otp:' + phone,
          JSON.stringify({ code, tries: 0, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }),
          { expirationTtl: 30 * 86400 });
        const raw = await fetchSnapshot(target);
        if (!raw) return deny(502, 'reader-failed', origin);
        const evs = eventsForPhone(raw, phone);
        if (!evs.length) return deny(404, 'no-events', origin);
        return okJson({ ok: true, events: evs }, origin);
      }
      if (!(await tokenRecord(env, token))) return deny(404, 'unknown-token', origin);
      const raw = await fetchSnapshot(target);
      if (!raw) return deny(502, 'reader-failed', origin);
      const refCount = env.RATE ? Number(await env.RATE.get('refcred:' + token.slice(0, 8))) || 0 : 0;
      /* which waves already fired, so the page can lock those rows */
      const sentWaves = {};
      if (env.RATE) {
        for (const n of [1, 2, 3]) {
          sentWaves[n] = !!(await env.RATE.get(`wave:${token}:${n}`));
        }
      }
      const snapshot = buildDashboard(token, raw, refCount, sentWaves);
      if (!snapshot) return deny(404, 'event-not-found', origin);
      /* after the event: surface the review + testimonial links permanently */
      const evDate = String(snapshot.event.event_date || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(evDate) && evDate < ilDate()) {
        const brain = await getBrain(env);
        snapshot.after_party = {
          review: String(brain.reviewLink || '').trim(),
          clip: String(brain.testimonialLink || '').trim(),
        };
      }
      return okJson(snapshot, origin);
    }

    /* a call outcome from the calls page: admin key instead of a token, and
       the button pressed becomes exact cell values here, not in Make */
    if (url.pathname === '/api/event' && stampFields.event_type === 'call_result') {
      if (!isAdmin(env, stampFields.admin_key)) {
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
      /* a human round counts as a round: the guest id carries the event's
         first 8 token chars, which is all the upsell stage needs */
      const gid = String(stampFields.guest_id || '');
      const m8 = /^G-([0-9a-f]{8})-/i.exec(gid);
      if (m8 && env.RATE) {
        await env.RATE.put('calldate8:' + m8[1], ilDate(), { expirationTtl: 60 * 86400 }).catch(() => {});
      }
      return okJson({ ok: true, ...result }, origin);
    }

    /* everything aimed at an event must present a token minted by a payment */
    if (url.pathname === '/api/event') {
      const token = String((parsedForm ? parsedForm.get('token') : stampFields.token) || '').trim();
      const rec = await tokenRecord(env, token);
      if (!rec) return deny(403, 'unknown-token', origin);
      if (parsedForm) return handleEventForm(parsedForm, rec, token, env, origin, target, url);
      /* JSON on this route is the settings step only. Guest rows must go
         through handleEventForm, which owns parsing, the tier cap and the
         one-upload lock — a raw append_body here would skip all three. */
      if (stampFields.append_body || stampFields.event_type === 'guests_file') {
        return deny(400, 'guests-need-upload', origin);
      }
    }

    /* Somebody who typed their phone into the form and then walked away is the
       most expensive person we lose: they asked, and nobody ever answered.
       Until now the lead reached the sheet and stopped there. Recording it here
       — at the one point every lead passes through — is what lets the engine
       come back to them tomorrow. Never blocks the forward. */
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

    /* the lead is only worth chasing if it actually reached the sheet — and a
       forged POST that Make rejected must never earn a WhatsApp template from
       the business number (review finding #12) */
    if (url.pathname === '/api/lead' && env.RATE && upstream.ok) {
      try { await noteLead(env, stampFields); } catch {}
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
