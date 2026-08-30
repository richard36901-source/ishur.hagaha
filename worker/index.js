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
import { sendText, sendImage, sendTemplate, inviteText, parseInboundReply, extractInbound, findGuestByPhone } from './whatsapp.js';

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

/* Any failure anywhere → immediate ping to Richard (Make hook → Telegram for
   now; swaps to the Slack channel the moment a Slack webhook exists). */
async function alert(env, where, what, detail) {
  if (!env.ALERT_HOOK) return;
  await fetch(env.ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      where, what: String(what || '').slice(0, 300),
      detail: String(detail || '').slice(0, 500), ts: new Date().toISOString(),
    }),
  }).catch(() => {});
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
  if (!ok) await alert(env, 'תשלום Grow', 'Make לא קלט את התשלום (writer-failed)', `ref=${ref} phone=${phone} sum=${sum}`);

  /* paid → the client gets their personal upload link on WhatsApp, right now.
     claimlink:<phone> lets the service bot re-send it on request later. */
  if (ok) {
    if (env.RATE) await env.RATE.put('claimlink:' + phone, token, { expirationTtl: 180 * 86400 });
    const first = (name.split(' ')[0] || '').trim() || 'לקוח יקר';
    const wa = await sendTemplate(env, phone, 'ishur_tashlum',
      [first, 'https://ishur.io/upload.html?t=' + token]);
    if (env.RATE) await env.RATE.put('paywa:' + ref,
      JSON.stringify({ ...wa, at: new Date().toISOString() }), { expirationTtl: 30 * 86400 });
  }
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
    const { guests, skipped, warnings } = guestsFromRows(rows);
    if (!guests.length) return deny(422, 'no-valid-guests', origin);
    if (guests.length > MAX_GUESTS) return deny(422, 'too-many-guests', origin);

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
    if (!parsed) continue;

    if (parsed.kind === 'optout') {
      if (env.RATE) await env.RATE.put('optout:' + from, new Date().toISOString());
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
        await sendText(env, from, `נרשם — ${parsed.party} מגיעים 🎉`);
      } else if (parsed.outcome === 'לא מגיע') {
        await writeGuestReply(env, guest, 'לא מגיע');
        await sendText(env, from, 'חבל שלא תהיו, תודה שעדכנתם 🙏');
      } else {
        await writeGuestReply(env, guest, 'מתלבט');
        await sendText(env, from, 'אין לחץ — אפשר לעדכן כאן בכל רגע 🙂');
      }
    }
    /* a guest wrote a free question — same service brain answers */
    if (parsed.kind === 'text') await serviceReply(env, from, parsed.body);
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
      reply = 'בדקתי — התשלום שלך אצלנו ✅\n' +
        'הנה הקישור האישי להעלאת רשימת המוזמנים והגדרת האירוע:\n' +
        'https://ishur.io/upload.html?t=' + token + '\n\n' +
        'זה לוקח 3 דקות, ואני כאן לכל שאלה 🙂';
    } else if (/שילמ|תשלום|רכשתי|קניתי|לא קיבלתי/.test(t)) {
      reply = 'רגע, בודקים 🙂 לא מצאתי תשלום שמשויך למספר הזה — ' +
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
    '\n- אל תמציאי מחירים, קישורים או הבטחות. הקישור היחיד שמותר להזכיר: ishur.io' +
    '\n- אם אין תשובה בטוחה בידע למטה — כתבי בקצרה שתבדקי ותחזרי.' +
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
    if (env.RATE && await env.RATE.get('optout:' + phone)) { skippedOptout++; continue; }
    if (dry) { sent++; continue; }
    const name = String(g[3] || '').trim() || 'אורח יקר';
    const res = await sendTemplate(env, phone, 'hazmana_ishur',
      [name, occasion, hosts, date, time, venue], '', 'he', 'guests');
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

    const guests = gRows.filter(g => String(g[28] || '').trim() === token);
    if (!guests.length) continue;

    for (const wave of WAVES) {
      const when = String(ev[wave.col] || '').trim().slice(0, 10);
      if (when !== today) continue;
      const flagKey = `wave:${token}:${wave.key}`;
      if (env.RATE && await env.RATE.get(flagKey)) continue;
      const res = await sendWave(env, ev, token, guests, wave, dry);
      if (!dry && env.RATE) await env.RATE.put(flagKey, today, { expirationTtl: 120 * 86400 });
      if (!dry && res.failed) {
        await alert(env, 'גל שליחה', `גל ${wave.key} לאירוע ${token.slice(0, 8)}: ${res.failed} שליחות נכשלו`, '');
      }
      out.push({ token, type: 'wave', ...res });
    }

    /* escalation: the morning after the LAST planned send, whoever still has
       no answer is queued for a call */
    const lastSend = WAVES.map(w => String(ev[w.col] || '').trim().slice(0, 10))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
    if (lastSend && lastSend < today) {
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
    if (!wa.ok) await alert(env, 'סוף-אירוע', 'שליחת הודעת הסיום נכשלה', token + ': ' + wa.error);
    out.push({ token, type: 'end_of_event', confirmed, diners, declined, pending, sent: wa.ok });
  }
  return { ok: true, date: today, events: out };
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
  if (!env.WA_TOKEN || !env.WA_PHONE_ID) return null;
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}?fields=messaging_limit_tier,quality_rating`, {
    headers: { Authorization: 'Bearer ' + env.WA_TOKEN },
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

  return okJson({
    ok: true,
    series: Object.values(days).sort((a, b) => a.date < b.date ? -1 : 1),
    utm: Object.entries(utm).sort((a, b) => b[1] - a[1]),
    leads_total: leadRows.filter(r => String((r || [])[2] || '').trim()).length,
    wa_cap: cap ? { ...cap, used_today: usedToday } : null,
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
    ctx.waitUntil(runDailyEngine(env, false).then(() => runBackup(env)).then(res => {
      if (res && !res.ok) return alert(env, 'גיבוי יומי', 'הגיבוי נכשל', res.error || '');
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
    if (url.pathname === '/api/backup' && request.method === 'POST') {
      return handleBackup(request, env, origin);
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
      if (!token) return deny(403, 'code-login-not-ready', origin); // phone+code waits for WhatsApp OTP
      if (!(await tokenRecord(env, token))) return deny(404, 'unknown-token', origin);
      const raw = await fetchSnapshot(target);
      if (!raw) return deny(502, 'reader-failed', origin);
      const snapshot = buildDashboard(token, raw);
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
