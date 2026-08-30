/* ============================================================================
   ishur.io · WhatsApp Cloud API sender
   ----------------------------------------------------------------------------
   Sends straight to Meta's Graph API with the system-user token, bypassing the
   Make WhatsApp module entirely. Make stays a Sheets writer; the Worker owns
   every message that leaves the system.

   Two shapes:
     sendText     — free-form. Only legal inside an open 24h window (a guest who
                    replied). Used for replies and for testing to our own phones.
     sendTemplate — the real invitation/reminder path. Needs an approved
                    template name; parameters are positional ({{1}}, {{2}}…).

   Every send returns {ok, id|error} and the caller logs the cost.
   ========================================================================== */

const GRAPH = 'https://graph.facebook.com/v21.0';

function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}

/* guests get their own number the moment WA_PHONE_ID_GUESTS exists;
   until then everything rides the client number. */
function pickPhone(env, channel) {
  if (channel === 'guests' && env.WA_PHONE_ID_GUESTS) return env.WA_PHONE_ID_GUESTS;
  return env.WA_PHONE_ID;
}

/* failures and cap warnings go where Richard looks: Slack first, Telegram
   only when the Slack webhook secret is missing */
async function opsPing(env, where, what, detail) {
  if (env.SLACK_ALERT_HOOK) {
    await fetch(env.SLACK_ALERT_HOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `⚠️ *${where}*\n${what}${detail ? '\n' + detail : ''}` }),
    }).catch(() => {});
    return;
  }
  if (!env.ALERT_HOOK) return;
  await fetch(env.ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ where, what, detail: detail || '', ts: new Date().toISOString() }),
  }).catch(() => {});
}

async function post(env, body, channel, ctx) {
  const phoneId = pickPhone(env, channel);
  if (!env.WA_TOKEN || !phoneId) return { ok: false, error: 'wa-not-configured' };
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  }).catch(() => null);
  let res;
  if (!r) res = { ok: false, error: 'unreachable' };
  else {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = j.error || {};
      res = { ok: false, error: `${e.code || r.status}: ${e.message || 'send-failed'}` };
    } else {
      res = { ok: true, id: (j.messages && j.messages[0] && j.messages[0].id) || '' };
    }
  }
  /* every outbound message is logged; every failure raises an alert */
  try {
    if (env.RATE) {
      const summary =
        body.type === 'text' ? String((body.text || {}).body || '') :
        body.type === 'image' ? '🖼 ' + String((body.image || {}).caption || 'תמונה') :
        body.type === 'template' ? 'תבנית ' + String((body.template || {}).name || '') : body.type;
      /* ctx (template/occasion/wave/token) makes per-message performance
         measurable later: which text, for which event type, got answered */
      await env.RATE.put('log:' + String(body.to || '') + ':' + Date.now(),
        JSON.stringify({
          dir: 'out', type: body.type, text: summary.slice(0, 300),
          ok: res.ok, error: res.error || '',
          tmpl: body.type === 'template' ? String((body.template || {}).name || '') : '',
          ...(ctx && typeof ctx === 'object' ? {
            occ: String(ctx.occasion || '').slice(0, 40),
            wave: ctx.wave || '',
            tok: String(ctx.token || '').slice(0, 8),
          } : {}),
          at: new Date().toISOString(),
        }),
        { expirationTtl: 90 * 86400 });
      /* per-template performance: sent/fail here, replied credited by the
         inbound webhook against lastout:<phone>. Occasion rides along so a
         weak wording for one event type stands out. */
      if (body.type === 'template') {
        const tmpl = String((body.template || {}).name || '');
        const occ = ctx && ctx.occasion ? String(ctx.occasion).slice(0, 40) : '-';
        const tk = `tstat:${tmpl}:${occ}`;
        let ts = { sent: 0, fail: 0, replied: 0 };
        try { ts = JSON.parse(await env.RATE.get(tk)) || ts; } catch {}
        if (res.ok) ts.sent += 1; else ts.fail += 1;
        await env.RATE.put(tk, JSON.stringify(ts), { expirationTtl: 400 * 86400 });
        if (res.ok) {
          await env.RATE.put('lastout:' + String(body.to || ''),
            JSON.stringify({ tmpl, occ, at: new Date().toISOString() }), { expirationTtl: 2 * 86400 });
        }
      }
      /* daily counters feed the money board: sends, template sends, failures */
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
      const key = 'wastat:' + day;
      let st = { out: 0, tmpl: 0, fail: 0 };
      try { st = JSON.parse(await env.RATE.get(key)) || st; } catch {}
      st.out += 1;
      if (body.type === 'template') st.tmpl += 1;
      if (!res.ok) st.fail += 1;
      await env.RATE.put(key, JSON.stringify(st), { expirationTtl: 400 * 86400 });
      /* crossing 80% of Meta's daily conversation cap → one alert per day.
         wa:cap is kept warm by the daily engine and the admin board. */
      if (body.type === 'template') {
        let cap = null;
        try { cap = JSON.parse(await env.RATE.get('wa:cap')); } catch {}
        if (cap && cap.limit && st.tmpl >= cap.limit * 0.8 && !(await env.RATE.get('capalert:' + day))) {
          await env.RATE.put('capalert:' + day, '1', { expirationTtl: 2 * 86400 });
          await opsPing(env, 'תקרת וואטסאפ',
            `נשלחו ${st.tmpl} תבניות היום, מעל 80% מתקרת מטא (${cap.limit})`, cap.tier || '');
        }
      }
    }
    if (!res.ok) {
      await opsPing(env, 'שליחת וואטסאפ', res.error, `${body.type} → ${body.to}`);
    }
  } catch {}
  return res;
}

export function sendText(env, to, text, channel) {
  return post(env, { to: normPhone(to), type: 'text', text: { body: String(text) } }, channel);
}

/* An image with a caption — what an invitation actually looks like when the
   client uploaded artwork and the guest already has an open window. */
export function sendImage(env, to, imageUrl, caption, channel) {
  return post(env, {
    to: normPhone(to), type: 'image',
    image: { link: imageUrl, caption: String(caption || '').slice(0, 1024) },
  }, channel);
}

/* AUTHENTICATION template (ishur_kod): the one-time code fills both the body
   and the copy-code button. */
export function sendOtpTemplate(env, to, code) {
  return post(env, {
    to: normPhone(to), type: 'template',
    template: {
      name: 'ishur_kod', language: { code: 'he' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: String(code) }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(code) }] },
      ],
    },
  });
}

/* The production path. `params` are the positional body variables; `imageUrl`
   fills a header of type IMAGE when the template has one. */
export function sendTemplate(env, to, name, params = [], imageUrl = '', lang = 'he', channel, ctx) {
  const components = [];
  if (imageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: imageUrl } }] });
  }
  if (params.length) {
    components.push({
      type: 'body',
      parameters: params.map(p => ({ type: 'text', text: String(p ?? '') })),
    });
  }
  return post(env, {
    to: normPhone(to), type: 'template',
    template: { name, language: { code: lang }, ...(components.length ? { components } : {}) },
  }, channel, ctx);
}

/* ── inbound ── a guest replied: a template button, or free text ──────────
   Returns null for noise, or:
     { kind:'rsvp',  outcome:'מגיע'|'לא מגיע'|'מתלבט', party?:number }
     { kind:'party', party:number }        — a bare number (answers "כמה תהיו?")
     { kind:'optout' }                     — הסר/הסירו אותי
     { kind:'text',  body }                — anything else, for the inbox later */
export function parseInboundReply(msg) {
  if (!msg || !msg.type) return null;
  let text = '';
  if (msg.type === 'button') text = String((msg.button && (msg.button.text || msg.button.payload)) || '');
  else if (msg.type === 'interactive') {
    const i = msg.interactive || {};
    text = String((i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '');
  } else if (msg.type === 'text') text = String((msg.text && msg.text.body) || '');
  else return null;
  text = text.trim();
  if (!text) return null;

  const clean = text.replace(/[‎‏]/g, '');
  if (/הסר|הסירו|תסירו|לא להתקשר|תפסיקו/.test(clean)) return { kind: 'optout' };

  /* a bare number = party size reply */
  const bare = clean.replace(/[^\d]/g, '');
  if (bare && bare === clean.replace(/\s/g, '') && Number(bare) >= 1 && Number(bare) <= 99) {
    return { kind: 'party', party: Number(bare) };
  }

  const yes = /^(מגיע|מגיעה|מגיע\/ה|מגיעים|כן|נגיע|בטח|אשמח|נהיה שם)/.test(clean);
  const no = /^(לא מגיע|לא מגיעה|לא מגיע\/ה|לא מגיעים|לא נגיע|לא נוכל|לצערנו|לא)/.test(clean);
  const maybe = /(עדיין לא|לא ידוע|מתלבט|נעדכן|לא בטוח|אולי)/.test(clean);

  if (no) return { kind: 'rsvp', outcome: 'לא מגיע' };
  if (yes) {
    const m = clean.match(/(\d{1,2})/);
    return { kind: 'rsvp', outcome: 'מגיע', party: m ? Number(m[1]) : undefined };
  }
  if (maybe) return { kind: 'rsvp', outcome: 'מתלבט' };
  return { kind: 'text', body: text };
}

/* Pull the reply messages out of Meta's webhook envelope */
export function extractInbound(payload) {
  const out = [];
  for (const entry of (payload && payload.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      for (const m of v.messages || []) {
        out.push({ from: String(m.from || ''), msg: m, phoneId: String((v.metadata && v.metadata.phone_number_id) || '') });
      }
    }
  }
  return out;
}

/* Which guest row does this phone belong to? Prefer the nearest upcoming
   event; fall back to the most recent row. */
export function findGuestByPhone(raw, phone, todayIso) {
  const gRows = (raw.guests && raw.guests.values) || [];
  const evRows = (raw.events && raw.events.values) || [];
  const dates = {};
  for (const r of evRows) {
    const t = String(r[1] || '').trim();
    if (t) dates[t] = String(r[6] || '').trim();
  }
  const p = normPhone(phone);
  let best = null;
  for (const r of gRows) {
    if (normPhone(r[4]) !== p) continue;
    const token = String(r[28] || '').trim();
    const date = dates[token] || '';
    const upcoming = date >= todayIso;
    const cand = {
      guest_id: String(r[2] || '').trim(),
      token, date, upcoming,
      tries: Number(String(r[29] || '').trim()) || 0,
    };
    if (!cand.guest_id) continue;
    if (!best) { best = cand; continue; }
    if (cand.upcoming && !best.upcoming) best = cand;
    else if (cand.upcoming === best.upcoming && cand.date > best.date === false && cand.upcoming) {
      /* both upcoming: keep the sooner one */
      if (cand.date < best.date) best = cand;
    }
  }
  return best;
}

/* What the guest sees when there is no approved template yet — used for our own
   test numbers, where a 24h window is opened by hand. */
export function inviteText(ev) {
  const lines = [
    `שלום! הוזמנתם ל${ev.occasion || 'אירוע'}${ev.event_name ? ' של ' + ev.event_name : ''} 🎉`,
    ev.event_date ? `📅 ${ev.event_date}` : '',
    ev.reception_time ? `🕐 קבלת פנים ${ev.reception_time}` : '',
    [ev.venue_name, ev.venue_city].filter(Boolean).join(', '),
    '',
    'נשמח לדעת אם תגיעו, פשוט השיבו להודעה הזו:',
    'כן / לא, ואם כן כמה תהיו.',
  ];
  return lines.filter(Boolean).join('\n');
}
