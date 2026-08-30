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
import { callWindowState, buildCallPayload, retellToCallResult, verifyRetellSignature, ilDate, shouldDial } from './shir.js';
import { sendText, sendImage, sendTemplate, sendOtpTemplate, inviteText, parseInboundReply, extractInbound, findGuestByPhone } from './whatsapp.js';

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
    /* every purchase lands in Slack — Richard doesn't always get Grow's email */
    await slackPost(env, `🎉 *רכישה חדשה ב-ishur*\n${name || 'ללא שם'} · ${phone}` +
      `\nסכום: ₪${sum || '?'}${payMethod ? ' · ' + payMethod : ''}` +
      `\n${isNewClient ? 'לקוח חדש' : 'לקוח חוזר'} · אסמכתא ${ref}`);
    if (env.RATE) await env.RATE.put('claimlink:' + phone, token, { expirationTtl: 180 * 86400 });
    /* the stuck-client stage nudges whoever still hasn't uploaded a day later */
    if (env.RATE) await env.RATE.put('pend:' + token,
      JSON.stringify({ phone, name, at: new Date().toISOString() }), { expirationTtl: 7 * 86400 });
    const first = (name.split(' ')[0] || '').trim() || 'לקוח יקר';
    const wa = await sendTemplate(env, phone, 'ishur_tashlum',
      [first, 'https://ishur.io/upload.html?t=' + token]);
    if (wa.ok) await addEvCost(env, token, 0.53);
    if (env.RATE) await env.RATE.put('paywa:' + ref,
      JSON.stringify({ ...wa, at: new Date().toISOString() }), { expirationTtl: 30 * 86400 });
  }
  return new Response(ok ? 'ok' : 'writer-failed', { status: ok ? 200 : 502 });
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
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
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
    const tierNum = tierOf(capRow);
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
  const tierNum = tierOf(evRow);
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
  if (action.cost_cents) {
    await trackCallCost(env, action.cost_cents);
    await addEvCost(env, action.guest_id, action.cost_cents);
  }

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
  if (!isAdmin(env, body.admin_key)) {
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
      /* the pro upsell fires the day after a call round actually happened */
      await env.RATE.put('calldate:' + g.token, day, { expirationTtl: 60 * 86400 });
      dialed.push(g.guest_id);
    }
  }
  return okJson({ ok: true, dialed: dialed.length, guests: dialed }, origin);
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

  for (const { from, msg } of extractInbound(payload)) {
    try {
    /* Meta retries a delivery until it gets a 200, and one slow reply is
       enough to earn a retry. Without this the guest is answered twice and
       the sheet is written twice. msg.id is Meta's stable per-message id. */
    if (msg.id && await seenOnce(env, 'wain:' + msg.id)) continue;
    const parsed = parseInboundReply(msg);
    /* full inbound log — every message from every number, always */
    if (env.RATE) {
      await env.RATE.put('log:' + from + ':' + Date.now(),
        JSON.stringify({
          dir: 'in', type: msg.type,
          text: (parsed ? textOf(parsed) : '').slice(0, 300),
          at: new Date().toISOString(),
        }), { expirationTtl: 90 * 86400 }).catch(() => {});
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

    if (parsed.kind === 'optout') {
      if (env.RATE) await env.RATE.put('optout:' + normPhone(from), new Date().toISOString());
      await sendText(env, from, 'הוסרת מרשימת התפוצה. לא נשלח לך עוד הודעות 🙏');
      continue;
    }

    const raw = await fetchSnapshot(env.HOOK_STATUS);
    const guest = raw ? findGuestByPhone(raw, from, ilDate()) : null;
    if (!guest) {
      /* not a guest of any event — client service: always answer something */
      await serviceReply(env, from, textOf(parsed));
      continue;
    }

    if (parsed.kind === 'party' && env.RATE) {
      const pending = await env.RATE.get('awaitparty:' + guest.guest_id);
      if (pending) {
        await env.RATE.delete('awaitparty:' + guest.guest_id);
        await writeGuestReply(env, guest, 'מגיע', parsed.party);
        await sendText(env, from, `מעולה, רשמנו ${parsed.party} 🎉 נתראה בשמחות!`);
      }
      continue;
    }

    if (parsed.kind === 'rsvp') {
      if (parsed.outcome === 'מגיע' && !parsed.party) {
        await writeGuestReply(env, guest, 'מגיע');
        if (env.RATE) await env.RATE.put('awaitparty:' + guest.guest_id, '1', { expirationTtl: 86400 });
        await sendText(env, from, 'איזה כיף! כמה תהיו בסך הכל? (אפשר לענות רק במספר)');
      } else if (parsed.outcome === 'מגיע') {
        await writeGuestReply(env, guest, 'מגיע', parsed.party);
        await sendText(env, from, `נרשם, ${parsed.party} מגיעים 🎉`);
      } else if (parsed.outcome === 'לא מגיע') {
        await writeGuestReply(env, guest, 'לא מגיע');
        await sendText(env, from, 'חבל שלא תהיו, תודה שעדכנתם 🙏');
      } else {
        await writeGuestReply(env, guest, 'מתלבט');
        await sendText(env, from, 'אין לחץ, אפשר לעדכן כאן בכל רגע 🙂');
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

async function serviceReply(env, from, text) {
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
  if (!reply) reply = (await aiReply(env, from, t)) || '';

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

async function aiReply(env, from, text) {
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

  const sys = (brain.persona || 'את נציגת שירות חמה של ishur.io — שירות אישורי הגעה לאירועים בוואטסאפ.') +
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
async function writeGuestReply(env, guest, outcome, party) {
  await fetch(env.HOOK_EVENTS, {
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
async function sendWave(env, ev, token, guests, wave, dry) {
  const occasion = String(ev[5] || '').trim() || 'אירוע';
  const hosts = String(ev[34] || ev[2] || '').trim() || 'בעלי השמחה';
  const date = heDate(String(ev[6] || '').trim());
  const time = String(ev[36] || '').trim() || 'בשעות הערב';
  const venue = [String(ev[38] || '').trim(), String(ev[37] || '').trim()].filter(Boolean).join(', ') || 'פרטים בהמשך';

  let sent = 0, skippedOptout = 0, skippedAnswered = 0, failed = 0;
  const seenPhones = new Set();
  for (const g of guests) {
    const phone = String(g[4] || '').trim();
    if (!phone || seenPhones.has(phone)) continue; // one message per phone per event, whatever file it came from
    seenPhones.add(phone);
    const answered = String(g[15] || '').trim() !== '';
    if (wave.onlyUnanswered && answered) { skippedAnswered++; continue; }
    if (env.RATE && await env.RATE.get('optout:' + normPhone(phone))) { skippedOptout++; continue; }
    if (dry) { sent++; continue; }
    const name = String(g[3] || '').trim() || 'אורח יקר';
    const res = await sendTemplate(env, phone, 'hazmana_ishur',
      [name, occasion, hosts, date, time, venue], '', 'he', 'guests',
      { occasion, wave: wave.key, token });
    if (res.ok) sent++; else failed++;
  }
  return { wave: wave.key, sent, skippedOptout, skippedAnswered, failed };
}

async function runDailyEngine(env, dry, todayOverride) {
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

  const evRows = (raw.events && raw.events.values) || [];
  const gRows = (raw.guests && raw.guests.values) || [];
  const out = [];

  /* keep Meta's cap cached so the 80% alert has a number during the waves */
  await waCapInfo(env).catch(() => null);

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
        const wa = await sendTemplate(env, v.phone, 'ishur_tzikoret_kovetz',
          [first, 'https://ishur.io/upload.html?t=' + token], '', 'he', undefined, { token });
        if (wa.ok) {
          await addEvCost(env, token, 0.53);
          await slackPost(env, `🟠 *לקוח תקוע* · ${v.name || ''} ${v.phone}\nשילם אתמול ולא העלה רשימת מוזמנים. נשלחה תזכורת עם הקישור האישי. אפשר לענות לו מהאינבוקס, והוא גם יכול פשוט לשלוח את האקסל בוואטסאפ.`);
          await env.RATE.delete('pend:' + token);
          await env.RATE.put('pend2:' + token, today, { expirationTtl: 30 * 86400 });
        }
        out.push({ token, type: 'stuck_client', sent: wa.ok });
      }
    } catch (e) { await alert(env, 'לקוח תקוע', 'שלב הבדיקה נפל', String(e && e.message)); }
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
      if (when !== today) continue;
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
      const res = await sendWave(env, ev, token, guests, wave, dry);
      if (!dry && res.sent) await addEvCost(env, token, res.sent * 0.53);
      /* only close the wave if something actually went out. A wave where every
         send failed (revoked token, number blocked) must stay open so a fixed
         re-run still reaches the guests instead of burning the list. */
      const waveDelivered = res.sent > 0 || res.failed === 0;
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
    const wa = await sendTemplate(env, phone, 'ishur_doch', [
      evName, String(confirmed), String(diners), String(declined), String(pending),
      'https://ishur.io/dashboard.html?t=' + token,
    ]);
    if (wa.ok && env.RATE) await env.RATE.put('report7:' + token, today, { expirationTtl: 60 * 86400 });
    if (wa.ok) await addEvCost(env, token, 0.53);
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
    const wa = await sendTemplate(env, phone, 'ishur_syum', [
      evName, String(confirmed), String(diners), String(declined), String(pending), review, clip,
    ]);
    if (wa.ok && env.RATE) await env.RATE.put('eoe:' + token, today, { expirationTtl: 120 * 86400 });
    if (wa.ok) await addEvCost(env, token, 0.53);
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
    const seenPhones = new Set();
    for (const g of gRows) {
      if (String(g[28] || '').trim() !== token) continue;
      const phone = String(g[4] || '').trim();
      const table = String(g[30] || '').trim();
      const rsvp = String(g[15] || '').trim();
      if (!phone || !table || rsvp !== 'מגיע' || seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      if (env.RATE && await env.RATE.get('optout:' + normPhone(phone))) continue;
      if (dry) { would++; continue; }
      const gname = String(g[3] || '').trim() || 'אורח יקר';
      const wa = await sendTemplate(env, phone, 'ishur_shulchan', [gname, evName, table], '', 'he', 'guests');
      if (wa.ok) sent++; else failed++;
    }
    if (dry) { if (would) out.push({ token, type: 'seating', would_send: would }); continue; }
    if (sent) await addEvCost(env, token, sent * 0.53);
    if (sent && env.RATE) await env.RATE.put('seat:' + token, today, { expirationTtl: 30 * 86400 });
    if (failed) await alert(env, 'הודעות שולחן', `${failed} שליחות נכשלו`, token.slice(0, 8));
    if (sent || failed) out.push({ token, type: 'seating', sent, failed });
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
      let sent = 0, failed = 0; const seen = new Set();
      for (const g of guests) {
        const phone = String(g[4] || '').trim();
        if (!phone || seen.has(phone)) continue; seen.add(phone);
        if (env.RATE && await env.RATE.get('optout:' + normPhone(phone))) continue;
        const gname = String(g[3] || '').trim() || 'אורח יקר';
        const wa = await sendTemplate(env, phone, 'ishur_bitul', [gname, evName], '', 'he', 'guests', { occasion, token });
        if (wa.ok) sent++; else failed++;
      }
      if (sent) { await addEvCost(env, token, sent * 0.53); if (env.RATE) await env.RATE.put('cancelmsg:' + token, today, { expirationTtl: 120 * 86400 }); }
      if (failed) await alert(env, 'הודעת ביטול', `${failed} שליחות נכשלו`, token.slice(0, 8));
      out.push({ token, type: 'cancel_notice', sent, failed });
      continue;
    }

    const sentDate = env.RATE ? await env.RATE.get('sentdate:' + token) : null;
    if (invited && sentDate && sentDate !== date && date >= today) {
      if (plan === 'premium') {
        if (dry) { out.push({ token, type: 'postpone_notice', would_send: guests.length, from: sentDate, to: date }); }
        else {
          let sent = 0, failed = 0; const seen = new Set();
          for (const g of guests) {
            const phone = String(g[4] || '').trim();
            if (!phone || seen.has(phone)) continue; seen.add(phone);
            if (env.RATE && await env.RATE.get('optout:' + normPhone(phone))) continue;
            const gname = String(g[3] || '').trim() || 'אורח יקר';
            const wa = await sendTemplate(env, phone, 'ishur_dchiya',
              [gname, evName, heDate(date), time, venue || 'פרטים אצל בעלי השמחה'], '', 'he', 'guests', { occasion, token });
            if (wa.ok) sent++; else failed++;
          }
          if (sent) {
            await addEvCost(env, token, sent * 0.53);
            if (env.RATE) {
              await env.RATE.put('sentdate:' + token, date, { expirationTtl: 200 * 86400 });
              /* one-shot flags realign to the new date */
              await env.RATE.delete('report7:' + token).catch(() => {});
              await env.RATE.delete('seat:' + token).catch(() => {});
              await env.RATE.delete('daybefore:' + token).catch(() => {});
            }
          }
          if (failed) await alert(env, 'הודעת דחייה', `${failed} שליחות נכשלו`, token.slice(0, 8));
          out.push({ token, type: 'postpone_notice', sent, failed });
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
      let sent = 0, failed = 0, would = 0; const seen = new Set();
      for (const g of guests) {
        const phone = String(g[4] || '').trim();
        const rsvp = String(g[15] || '').trim();
        if (!phone || rsvp !== 'מגיע' || seen.has(phone)) continue; seen.add(phone);
        if (env.RATE && await env.RATE.get('optout:' + normPhone(phone))) continue;
        if (dry) { would++; continue; }
        const gname = String(g[3] || '').trim() || 'אורח יקר';
        const wa = await sendTemplate(env, phone, 'ishur_yom_lifnei',
          [gname, evName, heDate(date), time, venue || 'פרטים אצל בעלי השמחה'], '', 'he', 'guests',
          { occasion, wave: 'daybefore', token });
        if (wa.ok) sent++; else failed++;
      }
      if (dry) { if (would) out.push({ token, type: 'day_before', would_send: would }); }
      else {
        if (sent) { await addEvCost(env, token, sent * 0.53); if (env.RATE) await env.RATE.put('daybefore:' + token, today, { expirationTtl: 30 * 86400 }); }
        if (failed) await alert(env, 'תזכורת יום-לפני', `${failed} שליחות נכשלו`, token.slice(0, 8));
        if (sent || failed) out.push({ token, type: 'day_before', sent, failed });
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
            const wa = await sendTemplate(env, phone, 'ishur_shidrug',
              [first, evName, `${silent} מתוך ${total}`], '', 'he', undefined, { occasion, token });
            if (wa.ok && env.RATE) await env.RATE.put('upsell:' + token, today, { expirationTtl: 120 * 86400 });
            if (wa.ok) {
              await addEvCost(env, token, 0.53);
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
            const wa = await sendTemplate(env, phone, 'ishur_shidrug_sichot',
              [first, evName, `${silent} מתוך ${tried.length}`], '', 'he', undefined, { occasion, token });
            if (wa.ok && env.RATE) await env.RATE.put('upsell2:' + token, today, { expirationTtl: 120 * 86400 });
            if (wa.ok) {
              await addEvCost(env, token, 0.53);
              await slackPost(env, `💡 *הצעת הכל כלול נשלחה* · ${name} (פרמיום): ${silent}/${tried.length} לא נענו לסבב השיחות`);
            }
            out.push({ token, type: 'upsell_pro', sent: wa.ok });
          }
        }
      }
    }
  }
  return { ok: true, date: today, events: out };
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
    /* one thread, oldest first */
    const names = (await kvKeys(env, 'log:' + phone + ':')).sort();
    const messages = [];
    for (const n of names.slice(-200)) {
      try {
        const v = JSON.parse(await env.RATE.get(n));
        if (v) messages.push({ ts: Number(n.split(':').pop()) || 0, ...v });
      } catch {}
    }
    return okJson({ ok: true, phone, messages }, origin);
  }

  /* conversation list: newest activity first, with a name when we know one */
  const names = await kvKeys(env, 'log:');
  const conv = {};
  for (const n of names) {
    const parts = n.split(':');           // log:<phone>:<ts>
    const p = parts[1], ts = Number(parts[2]) || 0;
    if (!p) continue;
    const c = (conv[p] = conv[p] || { phone: p, msgs: 0, last_ts: 0 });
    c.msgs++;
    if (ts > c.last_ts) { c.last_ts = ts; c.last_key = n; }
  }
  const list = Object.values(conv).sort((a, b) => b.last_ts - a.last_ts).slice(0, 200);
  for (const c of list) {
    try {
      const v = JSON.parse(await env.RATE.get(c.last_key));
      if (v) { c.last_dir = v.dir; c.last_text = String(v.text || v.type || '').slice(0, 80); }
    } catch {}
    delete c.last_key;
  }

  /* names from the sheet: event owners and guests */
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
    for (const c of list) {
      const hit = nameOf[c.phone];
      if (hit) { c.name = hit.name; c.kind = hit.kind; }
    }
  }
  return okJson({ ok: true, conversations: list }, origin);
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
  await addEvCost(env, (eventsForPhone(raw, phone)[0] || {}).token || '', 0.53);
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
    row.wa_cost_usd_cents += Math.round((Number(st.tmpl) || 0) * 0.53 * 100) / 100;
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
    row.wa_cost_usd_cents += Math.round((Number(st.tmpl) || 0) * 0.53 * 100) / 100;
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
  /* the morning run: reports (and, next stage, the guest sending waves) */
  async scheduled(event, env, ctx) {
    /* the Tuesday reminder crons carry their own schedule string */
    if (String(event.cron || '').startsWith('0 9,10,16')) {
      const hourUtc = new Date(event.scheduledTime || Date.now()).getUTCHours();
      ctx.waitUntil(runTeamReminders(env, hourUtc, false).catch(() => {}));
      return;
    }
    ctx.waitUntil(runDailyEngine(env, false).then(() => runBackup(env)).then(res => {
      if (res && !res.ok) return alert(env, 'גיבוי יומי', 'הגיבוי נכשל', res.error || '');
    }).then(() => {
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
    if (url.pathname.startsWith('/img/') && request.method === 'GET') {
      return serveImage(env, url.pathname);
    }
    if (url.pathname === '/api/shir-webhook' && request.method === 'POST') {
      return handleShirWebhook(request, env);
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
    if (url.pathname === '/api/brain-toggle' && request.method === 'POST') {
      return handleBrainToggle(request, env, origin);
    }
    if (url.pathname === '/api/shir-admin' && request.method === 'POST') {
      return handleShirAdmin(request, env, origin);
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
      const snapshot = buildDashboard(token, raw, refCount);
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
