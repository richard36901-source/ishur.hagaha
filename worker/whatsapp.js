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

import { logRow } from './sheetlogs.js';
import { logEvent, stream } from './evlog.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}

/* Guests ride their own number the moment WA_PHONE_ID_GUESTS exists. That
   number lives in a SEPARATE Meta business portfolio on purpose: bulk sending
   is what gets flagged, and a ban there must not touch the client number.
   A separate portfolio means a separate system user, hence its own token
   (WA_TOKEN_GUESTS). Until both secrets exist, everything rides the client
   number and the client token — the system degrades, it never breaks. */
/* The pair moves together: a guests number in another portfolio is unusable
   without its own token, so half a configuration must never route traffic. */
export function guestsReady(env) {
  return !!(env.WA_PHONE_ID_GUESTS && env.WA_TOKEN_GUESTS);
}

/* 26/09: Noa's number (4499) moved into the ishur.io portfolio, next to
   Shir's. CLIENT_PORTFOLIO="on" (wrangler.toml) routes the client channel
   through the portfolio's phone id + token; off = the old business, so the
   flip is one var and the rollback is the same var. */
export function clientOnPortfolio(env) {
  return String(env.CLIENT_PORTFOLIO || '') === 'on' && !!env.WA_PHONE_ID_CLIENT_NEW && !!env.WA_TOKEN_GUESTS;
}
const PORTFOLIO_RENAMED = new Set(['ishur_lo_siyem', 'ishur_lo_siyem_2', 'ishur_lo_siyem_3', 'ishur_tashlum', 'ishur_heshbonit', 'ishur_tzikoret_kovetz', 'ishur_doch', 'ishur_shidrug', 'ishur_shidrug_sichot']);
export function clientWaba(env) { return clientOnPortfolio(env) ? '2815615772154486' : '1060242146337688'; }
export function clientToken(env) { return clientOnPortfolio(env) ? env.WA_TOKEN_GUESTS : env.WA_TOKEN; }
/* 25/10: 4499 re-registered via coexistence (QR) under WABA 1060242146337688 with a
   new phone id. WA_PHONE_ID_CLIENT (wrangler var) overrides the old WA_PHONE_ID secret. */
export function clientPhoneId(env) { return env.WA_PHONE_ID_CLIENT || env.WA_PHONE_ID; }

/* ── 22/10 Richard: more than one number for Shir ─────────────────────────
   WA_PHONE_IDS_GUESTS = "id1,id2,id3" (all on the same WABA, same token).
   Each number has its own 250/24h cap while the business is unverified, so
   three numbers = 750. The sender picks the number with the fewest sends
   today that is not cap-held (wacap:<phoneId>). Counters: gsend:<id>:<day>. */
export function guestPhoneIds(env) {
  const extra = String(env.WA_PHONE_IDS_GUESTS || '').split(',').map(x => x.trim()).filter(Boolean);
  const all = [env.WA_PHONE_ID_GUESTS, ...extra].filter(Boolean);
  return [...new Set(all)];
}
export function isGuestPhone(env, pid) { return !!pid && guestPhoneIds(env).includes(String(pid)); }
function ilDayKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); }

/* ── 02/11 audit: the guest budget ─────────────────────────────────────────
   Meta's messaging limit is "unique customers reached with a business-
   initiated (template) message in a ROLLING 24h", not "sends per Israeli
   calendar day". Three things the day counter alone got wrong:
     1. midnight reset: 230 at 20:00 + 230 at 09:00 = 460 inside Meta's 24h;
     2. KV allows one write per second per key, so a 25-send tick lost
        increments and the counter under-counted exactly when it mattered;
     3. service replies (free text inside a guest's 24h window) do not count
        toward the limit, but they were counted AND blocked once the budget
        ran out — Shir would go silent to a guest asking for the address.
   So: per-number usage = max(calendar-day counter, rolling-24h hourly
   buckets); an isolate-local tally that never goes below what this isolate
   itself sent; unique recipients only (gbic:<phone>, 24h); templates only.
   Portfolio cap: GUEST_PORTFOLIO_BUDGET (all numbers together). Unset, it is
   per-number budget × numbers — the pre-audit behaviour. See
   docs/AUDIT-SEND-PIPELINE-2026-11-02.md: on 02/11 the two numbers together
   delivered to ~250 unique people, which is what ONE shared TIER_250 looks
   like (Meta moved messaging limits to the business portfolio in Oct 2025). */
const MEM_DAY = new Map();   // `gsend:<pid>:<day>` → count this isolate knows
const MEM_24 = new Map();    // pid → { 'YYYY-MM-DDTHH': n } (UTC hours)
function hourKeyOf(ms) { return new Date(ms).toISOString().slice(0, 13); }
function prune24(obj, now = Date.now()) {
  const out = {}; const floor = hourKeyOf(now - 23 * 3600e3);
  for (const [h, n] of Object.entries(obj || {})) if (h >= floor && Number(n) > 0) out[h] = Number(n);
  return out;
}
function merge24(a, b) { const out = { ...(a || {}) }; for (const [h, n] of Object.entries(b || {})) out[h] = Math.max(Number(out[h]) || 0, Number(n) || 0); return out; }
function sum24(obj) { return Object.values(obj || {}).reduce((t, n) => t + (Number(n) || 0), 0); }
async function read24(env, pid) {
  let kv = {}; try { kv = JSON.parse(await env.RATE.get('gsend24:' + pid)) || {}; } catch {}
  const m = prune24(merge24(kv, MEM_24.get(pid)));
  MEM_24.set(pid, m);
  return m;
}
async function readDay(env, pid, day) {
  const k = `gsend:${pid}:${day}`;
  const kv = Number(await env.RATE.get(k).catch(() => 0)) || 0;
  return Math.max(kv, MEM_DAY.get(k) || 0);
}
export function guestDailyBudget(env) { const n = Number(env && env.GUEST_DAILY_BUDGET); return n > 0 ? n : 230; }
export function guestPortfolioBudget(env) {
  const n = Number(env && env.GUEST_PORTFOLIO_BUDGET);
  return n > 0 ? n : guestDailyBudget(env) * Math.max(1, guestPhoneIds(env || {}).length);
}
/* one row per guest number: used = max(day counter, rolling 24h), held */
export async function guestUsage(env) {
  const day = ilDayKey();
  return Promise.all(guestPhoneIds(env).map(async id => {
    const [d, r, held, until] = await Promise.all([readDay(env, id, day), read24(env, id),
      env.RATE.get('wacap:' + id).catch(() => null), env.RATE.get('wacapuntil:' + id).catch(() => null)]);
    return { id, day: d, rolling: sum24(r), n: Math.max(d, sum24(r)), held: !!held, held_until: Number(until) || 0 };
  }));
}
export async function pickGuestPhone(env) {
  const ids = guestPhoneIds(env);
  if (!guestsReady(env) || !ids.length) return '';
  if (!env.RATE) return ids[0];
  const rows = await guestUsage(env);
  /* 02/11 incident: retries burned 2,081 conversations against two 250 caps
     and Meta blocked both numbers for 24h. A number that already sent its
     budget is simply not offered — no Meta call, no 131048. Same for the
     portfolio as a whole. */
  const budget = guestDailyBudget(env);
  const used = rows.reduce((t, r) => t + r.n, 0);
  if (used >= guestPortfolioBudget(env)) return '';
  const open = rows.filter(r => !r.held && r.n < budget).sort((a, b) => a.n - b.n);
  return open.length ? open[0].id : '';
}
export async function guestBudgetLeft(env) {
  if (!env.RATE) return 0;
  const rows = await guestUsage(env); const b = guestDailyBudget(env);
  const perNumber = rows.reduce((t, r) => t + (r.held ? 0 : Math.max(0, b - r.n)), 0);
  const portfolio = Math.max(0, guestPortfolioBudget(env) - rows.reduce((t, r) => t + r.n, 0));
  return Math.min(perNumber, portfolio);
}
/* a business-initiated (template) message was accepted for `phone` on `pid`.
   Counted once per recipient per rolling 24h — that is Meta's unit. */
export async function noteGuestTemplate(env, pid, phone) {
  if (!env.RATE || !pid) return false;
  const p = normPhone(phone);
  if (p) {
    if (await env.RATE.get('gbic:' + p).catch(() => null)) return false;
    await env.RATE.put('gbic:' + p, String(pid), { expirationTtl: 86400 }).catch(() => {});
  }
  await bumpGuestSend(env, pid);
  return true;
}
export async function bumpGuestSend(env, pid) {
  if (!env.RATE || !pid) return;
  const day = ilDayKey();
  const k = `gsend:${pid}:${day}`;
  const n = (await readDay(env, pid, day)) + 1;
  MEM_DAY.set(k, n);
  await env.RATE.put(k, String(n), { expirationTtl: 2 * 86400 }).catch(() => {});
  const r = await read24(env, pid); const h = hourKeyOf(Date.now());
  r[h] = (Number(r[h]) || 0) + 1;
  MEM_24.set(pid, r);
  await env.RATE.put('gsend24:' + pid, JSON.stringify(r), { expirationTtl: 2 * 86400 }).catch(() => {});
}
/* a free-form (non-template) guest message must leave from the number the
   guest wrote to: the 24h customer-service window is per business number.
   gin:<phone> is written by the inbound webhook. 02/11: 28 replies died on
   131047 because they left from the "least used" number instead. Service
   messages do not count toward Meta's limit, so no budget gate here. */
export async function guestReplyPhone(env, to) {
  const ids = guestPhoneIds(env);
  if (!guestsReady(env) || !ids.length) return '';
  const pin = env.RATE ? await env.RATE.get('gin:' + normPhone(to)).catch(() => null) : null;
  if (pin && ids.includes(String(pin))) return String(pin);
  return ids[0];
}
export function _resetBudgetMemory() { MEM_DAY.clear(); MEM_24.clear(); }
function pickPhone(env, channel) {
  if (channel === 'guests') return guestsReady(env) ? env.WA_PHONE_ID_GUESTS : '';
  return clientOnPortfolio(env) ? env.WA_PHONE_ID_CLIENT_NEW : clientPhoneId(env);
}

function pickToken(env, channel) {
  if (channel === 'guests') return guestsReady(env) ? env.WA_TOKEN_GUESTS : '';
  return clientToken(env);
}

/* failures and cap warnings go where Richard looks: Slack first, Telegram
   only when the Slack webhook secret is missing. Quiet hours (Phase 6, rule
   9): duplicated from index.js's slackSend rather than imported — index.js
   imports THIS module, so the reverse import would be circular. `urgent`
   lets a caller (e.g. the 131042 billing ping) bypass the queue. */
async function opsPing(env, where, what, detail, urgent) {
  const text = `⚠️ *${where}*\n${what}${detail ? '\n' + detail : ''}`;
  if (env.SLACK_ALERT_HOOK) {
    if (!urgent && env.RATE) {
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date()));
      if (hour < 9 || hour >= 21) {
        let list = [];
        try { list = JSON.parse(await env.RATE.get('slackq:list')) || []; } catch {}
        if (!Array.isArray(list)) list = [];
        list.push(text.slice(0, 500));
        if (list.length > 200) list = list.slice(-200);
        await env.RATE.put('slackq:list', JSON.stringify(list), { expirationTtl: 3 * 86400 }).catch(() => {});
        return;
      }
    }
    await fetch(env.SLACK_ALERT_HOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    return;
  }
  if (!env.ALERT_HOOK) return;
  await fetch(env.ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ where, what, detail: detail || '', ts: new Date().toISOString() }),
  }).catch(() => {});
}

/* One key per conversation, not per message. The inbox list used to be built
   by listing every log: key ever written — two waves on one 300-guest event is
   600 keys, so the list hit its scan cap and older threads simply stopped
   appearing. This index is what the list reads now: it grows with people, not
   with messages. */
export async function touchConversation(env, phone, { ts, dir, text, ch }) {
  if (!env.RATE || !phone) return;
  const key = 'conv:' + phone;
  let c = null;
  try { c = JSON.parse(await env.RATE.get(key)); } catch {}
  if (!c || typeof c !== 'object') c = { phone, msgs: 0, first_ts: ts };
  c.phone = phone;
  c.msgs = (c.msgs || 0) + 1;
  if (!c.first_ts) c.first_ts = ts;
  if (!(ts < (c.last_ts || 0))) {
    c.last_ts = ts;
    c.last_dir = dir;
    c.last_text = String(text || '').slice(0, 80);
  }
  /* a number can be written to on one channel and reply on the other, so the
     filter needs the set, not the latest */
  const chans = new Set(c.ch || []);
  if (ch) chans.add(ch);
  c.ch = [...chans];
  await env.RATE.put(key, JSON.stringify(c)).catch(() => {});
}

/* Rule 6, enforced mechanically, not by habit: a guest-facing template can
   only leave on Shir's WABA, a client/lead-facing one only on Noa's. Checked
   by template NAME, not by the `channel` argument the caller happened to
   pass — a wrong argument at a call site is exactly the bug this exists to
   catch. Unrecognized/future template names (an admin ad-hoc send, "noop",
   anything not in either list) are NOT guarded — this blocks a known
   category sent through the wrong door, it does not gate everything.
   NOTE (verify before trusting the source doc): PLAN-NOA-HARDENING.md lists
   ishur_tzikoret_kovetz as guest-only; the actual code sends it with
   sendClient() to a CLIENT who paid but hasn't uploaded their guest list
   (index.js ~3069, ~3164) — categorized here by verified real usage. */
const GUEST_ONLY_TEMPLATE_RE = /^hazmana_|^ishur_hazmana|^ishur_yom_lifnei|^ishur_shulchan|^ishur_toda_orach|^ishur_bitul\b|^ishur_dchiya\b/i;
const CLIENT_ONLY_TEMPLATE_RE = /^ishur_lo_siyem|^ishur_kod\b|^ishur_heshbonit\b|^ishur_tashlum\b|^ishur_shidrug|^ishur_doch\b|^ishur_syum\b|^ishur_tzikoret_kovetz\b/i;

/* 27/09 (Richard: "show the actual message, not the template name"). The
   template body comes from Meta once per name per week and is cached in KV;
   the parameters are substituted in, so the inbox shows what the person
   actually read. Falls back to "תבנית <name>" when Meta does not answer. */
async function templateSpec(env, name, channel) {
  const guests = channel === 'guests' && guestsReady(env);
  const waba = guests ? '1378764257421712' : clientWaba(env);
  const token = guests ? env.WA_TOKEN_GUESTS : clientToken(env);
  const ck = 'tmplspec:' + waba + ':' + name;
  let spec = null;
  try { spec = env.RATE ? JSON.parse(await env.RATE.get(ck)) : null; } catch {}
  if (!spec && token) {
    const r = await fetch(`${GRAPH}/${waba}/message_templates?name=${encodeURIComponent(name)}&fields=name,components`, { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    const t = ((j && j.data) || []).find(x => x.name === name);
    if (t) {
      const comps = t.components || [];
      const bd = comps.find(c => c.type === 'BODY'); const ft = comps.find(c => c.type === 'FOOTER'); const hd = comps.find(c => c.type === 'HEADER'); const bt = comps.find(c => c.type === 'BUTTONS');
      spec = { body: (bd && bd.text) || '', footer: (ft && ft.text) || '', header: hd ? { format: hd.format || 'TEXT', text: hd.text || '' } : null,
        buttons: ((bt && bt.buttons) || []).map(x => ({ type: x.type, text: x.text || '', url: x.url || '' })) };
      if (env.RATE) await env.RATE.put(ck, JSON.stringify(spec), { expirationTtl: 7 * 86400 }).catch(() => {});
    }
  }
  return spec;
}

/* 27/09 (Richard: "show the actual message, the video, the buttons, like
   GHL / WhatsApp"). The template spec comes from Meta once per name per
   week and is cached; parameters are substituted in, the header media link
   and the buttons ride along so the inbox can draw the bubble as the person
   saw it. Falls back to "תבנית <name>" when Meta does not answer. */
async function renderTemplate(env, name, body, channel) {
  try {
    const spec = await templateSpec(env, name, channel);
    if (!spec) return null;
    const comps = (body.template || {}).components || [];
    const comp = comps.find(c => c.type === 'body');
    const params = ((comp && comp.parameters) || []).map(x => String(x.text ?? ''));
    const text = spec.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
    const hdr = comps.find(c => c.type === 'header');
    const hp = hdr && hdr.parameters && hdr.parameters[0];
    const media = hp ? { kind: hp.type, url: (hp[hp.type] || {}).link || '' } : (spec.header && spec.header.format === 'TEXT' && spec.header.text ? { kind: 'text', text: spec.header.text } : null);
    return { text, footer: spec.footer, media, buttons: spec.buttons };
  } catch { return null; }
}

async function post(env, body, channel, ctx) {
  /* Iron rule (Richard, 06/09): 4499 talks to clients and leads ONLY. Guest
     traffic leaves from Shir's WhatsApp number or it does not leave at all.
     The old "degrade to the client number" fallback sent a real wave from
     4499 on the first live run — never again. */
  if (body.type === 'template') {
    const tname = String((body.template || {}).name || '');
    const wantsGuestChannel = channel === 'guests';
    if (GUEST_ONLY_TEMPLATE_RE.test(tname) && !wantsGuestChannel) {
      await logEvent(env, { area: 'שליחה', action: 'תבנית אורחים נשלחה בטעות מערוץ לקוחות — נחסם', ok: false, review: true,
        phone: String(body.to || ''), detail: tname });
      return { ok: false, error: 'wrong-channel' };
    }
    if (CLIENT_ONLY_TEMPLATE_RE.test(tname) && wantsGuestChannel) {
      await logEvent(env, { area: 'שליחה', action: 'תבנית לקוחות נשלחה בטעות מערוץ אורחים — נחסם', ok: false, review: true,
        phone: String(body.to || ''), detail: tname });
      return { ok: false, error: 'wrong-channel' };
    }
  }
  if (channel === 'guests' && !guestsReady(env)) {
    try {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
      if (env.RATE && !(await env.RATE.get('noguestnum:' + day))) {
        await env.RATE.put('noguestnum:' + day, '1', { expirationTtl: 86400 });
        await logEvent(env, { area: 'שליחה', action: 'מספר האורחים (שיר) לא מחובר — שליחות לאורחים מוחזקות, לא יוצאות מ-4499', ok: false, review: true,
          detail: 'חסרים WA_PHONE_ID_GUESTS / WA_TOKEN_GUESTS · AUT-884 · הגלים נשארים פתוחים ויצאו ברגע שהמספר יחובר' });
        await opsPing(env, 'מספר האורחים לא מחובר', 'גלים לאורחים מוחזקים. כלום לא יוצא מ-4499.', 'AUT-884');
      }
    } catch {}
    return { ok: false, error: 'guests-number-not-connected', held: true };
  }
  /* 21/10: Noa's number is off Meta's API (133010) while it moves WABA.
     Every caller that retries each pacer tick (lead chase, client links)
     would alert Slack 6x an hour. One real attempt per hour, one alert per
     6h, everything else is held quietly. */
  const clientCh = !(channel === 'guests' && guestsReady(env));
  if (clientCh && env.RATE && await env.RATE.get('noa:unreg').catch(() => null)) {
    return { ok: false, error: '133010: account not registered (held)', held: true };
  }
  /* 02/11 audit: only business-initiated (template) messages spend Meta's
     limit and the budget; a free-form reply goes out on the number the guest
     wrote to, budget or not. */
  const isTmpl = body.type === 'template';
  const phoneId = channel === 'guests'
    ? (isTmpl ? await pickGuestPhone(env) : await guestReplyPhone(env, body.to))
    : pickPhone(env, channel);
  const token = pickToken(env, channel);
  if (channel === 'guests' && token && !phoneId) {
    /* one journal line a day, not one per guest: the batch stops, the rest waits */
    try {
      const dk = 'gbudgetnote:' + ilDayKey();
      if (env.RATE && !(await env.RATE.get(dk))) {
        await env.RATE.put(dk, '1', { expirationTtl: 86400 });
        await logEvent(env, { area: 'שליחה', action: 'תקציב השליחה היומי לאורחים נוצל — השליחות ממתינות', ok: false, review: true,
          detail: `תקרה ${guestPortfolioBudget(env)} ל-24 שעות (כל המספרים) · ${guestDailyBudget(env)} למספר · היתר נשלח כשהחלון מתגלגל` });
      }
    } catch {}
    return { ok: false, error: 'guests-daily-budget', held: true };
  }
  if (!token || !phoneId) return { ok: false, error: 'wa-not-configured' };
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
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
      const tr = body.type === 'template' ? await renderTemplate(env, String((body.template || {}).name || ''), body, channel) : null;
      const rendered = tr ? tr.text : '';
      const summary =
        body.type === 'text' ? String((body.text || {}).body || '') :
        body.type === 'image' ? '🖼 ' + String((body.image || {}).caption || 'תמונה') :
        body.type === 'template' ? (rendered || 'תבנית ' + String((body.template || {}).name || '')) :
        body.type === 'interactive' ? String(((body.interactive || {}).body || {}).text || '') : body.type;
      /* ctx (template/occasion/wave/token) makes per-message performance
         measurable later: which text, for which event type, got answered */
      const ch = (channel === 'guests' && guestsReady(env)) ? 'guests' : 'client';
      const ts = Date.now();
      /* no TTL: the inbox is the record of what we said to a customer, and a
         customer who comes back after a year should not meet a blank thread */
      const logKey = 'log:' + String(body.to || '') + ':' + ts;
      if (res.ok && res.id) await env.RATE.put('wamid2log:' + res.id, logKey, { expirationTtl: 14 * 86400 }).catch(() => {});
      if (res.ok && channel === 'guests') { if (isTmpl && !(ctx && ctx.probe)) await noteGuestTemplate(env, phoneId, body.to); if (res.id) await env.RATE.put('wamidpid:' + res.id, phoneId, { expirationTtl: 3 * 86400 }).catch(() => {}); }
      await env.RATE.put(logKey,
        JSON.stringify({
          dir: 'out', type: body.type, text: summary.slice(0, 1000),
          ok: res.ok, error: res.error || '', ch, id: res.id || '', status: res.ok ? 'sent' : 'failed',
          ...(tr ? { footer: tr.footer || '', media: tr.media || null, buttons: tr.buttons || [] } : {}),
          ...(body.type === 'template' ? { params: (((body.template || {}).components || []).find(c => c.type === 'body') || { parameters: [] }).parameters.map(x => String(x.text ?? '')), lang: ((body.template || {}).language || {}).code || 'he' } : {}),
          ...(body.type === 'image' ? { media: { kind: 'image', url: (body.image || {}).link || '' } } : {}),
          ...(body.type === 'interactive' && (body.interactive || {}).type === 'cta_url' ? { buttons: [{ type: 'URL', text: body.interactive.action.parameters.display_text, url: body.interactive.action.parameters.url }] } : {}),
          tmpl: body.type === 'template' ? String((body.template || {}).name || '') : '',
          ...(ctx && typeof ctx === 'object' ? {
            occ: String(ctx.occasion || '').slice(0, 40),
            wave: ctx.wave || '',
            tok: String(ctx.token || '').slice(0, 8),
          } : {}),
          at: new Date().toISOString(),
        }));
      stream(env, { kind: 'wa_out', area: ch === 'guests' ? 'שיר' : 'נועה', data: { phone_id: phoneId, wamid: res.id || '', template: body.type === 'template' ? String((body.template || {}).name || '') : '', error: res.error || '' }, action: (res.ok ? '📤 ' : '⛔ ') + (body.type === 'template' ? 'תבנית ' + String((body.template || {}).name || '') : body.type === 'text' ? 'הודעה' : body.type) + ' → ' + String(body.to || ''), ok: res.ok, phone: String(body.to || ''), token: ctx && ctx.token ? String(ctx.token) : '', detail: (res.ok ? '' : String(res.error || '') + ' · ') + summary.slice(0, 400) }).catch(() => {});
      await touchConversation(env, String(body.to || ''), {
        ts, dir: 'out', text: summary.slice(0, 80), ch,
      });
      /* the sheet line (Richard 06/09: every message, with its status). The
         delivered/read columns are filled by the status webhook via the id. */
      try {
        const c = ctx && typeof ctx === 'object' ? ctx : {};
        const name = c.name || (await env.RATE.get('waname:' + String(body.to || ''))) || '';
        await logRow(env, ch === 'guests' ? 'msg_guests' : 'msg_clients', {
          id: res.id || '', dir: 'יוצאת', who: c.who || (ch === 'guests' ? 'שיר (מערכת)' : 'נועה (מערכת)'),
          sent: res.ok ? 'כן ' + ilTimeLocal() : 'נכשל', error: res.ok ? '' : res.error,
          name, phone: String(body.to || ''), text: summary.slice(0, 500),
          sender: ch === 'guests' ? '0559726673' : '0559504499',
          type: body.type === 'template' ? 'תבנית' : body.type === 'image' ? 'תמונה' : body.type === 'text' ? 'טקסט' : body.type,
          tmpl: body.type === 'template' ? String((body.template || {}).name || '') : '',
          token: String(c.token || '').slice(0, 8), wave: c.wave || '',
        });
      } catch {}
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
      /* daily counters feed the money board: sends, template sends, failures.
         AUT-903: this and tstat: above are read-modify-write on ONE hot key
         per send. KV allows one write per second per key, so in a 25-message
         tick some increments are rejected and swallowed by the outer catch —
         the money board under-counts; sending itself is unaffected. The clean
         fix is an in-memory tally per tick flushed once at the end, which
         needs a context threaded through sendWave → sendTemplate → here and
         every other sendTemplate caller; not done in this pass. Sharding the
         key was rejected: three readers aggregate by the bare day key. */
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
            `נשלחו ${st.tmpl} תבניות היום, מעל 80% מתקרת מטא (${cap.limit})`, cap.tier || '', true);
        }
      }
    }
    if (!res.ok) {
      /* Meta billing/eligibility on the client WABA (131042) fails EVERY
         send while it's broken, and callers like chaseAbandonedLeads retry
         every ten minutes — without this, that's a fresh Slack ping every
         ten minutes for as long as the account stays restricted (08/09).
         One alert per 6h instead; guests (Shir) is a separate WABA and
         unaffected, so it keeps the normal per-failure alert. */
      const isClientChannel = !(channel === 'guests' && guestsReady(env));
      if (isClientChannel && /133010/.test(String(res.error || '')) && env.RATE) {
        await env.RATE.put('noa:unreg', '1', { expirationTtl: 3600 }).catch(() => {});
        const k = 'unregalert:client';
        if (!(await env.RATE.get(k))) {
          await env.RATE.put(k, '1', { expirationTtl: 6 * 3600 });
          await opsPing(env, 'המספר של נועה (4499) לא רשום ב-API',
            'מטא מחזירה 133010. שליחות ללקוחות ולידים מוחזקות ונבדקות שוב פעם בשעה; ההתראה הבאה בעוד עד 6 שעות. לתקן: לסרוק QR לחיבור המספר ל-WABA החדש.',
            `${body.type} → ${body.to}`, true);
        }
      } else if (isClientChannel && /131042/.test(String(res.error || '')) && env.RATE) {
        const k = 'billingalert:client';
        if (!(await env.RATE.get(k))) {
          await env.RATE.put(k, '1', { expirationTtl: 6 * 3600 });
          await opsPing(env, 'תשלום WhatsApp (4499)',
            'שליחות מהמספר של נועה נכשלות — בעיית חיוב מטא (131042). זה יחזור על עצמו עד שהחיוב יתוקן, ההתראה הבאה בעוד עד 6 שעות.',
            `${body.type} → ${body.to}`, true);
        }
      } else {
        await opsPing(env, 'שליחת וואטסאפ', res.error, `${body.type} → ${body.to}`);
      }
    }
  } catch {}
  return res;
}

/* A real WhatsApp button (interactive CTA URL) inside the 24h window — what a
   guest sees as a tappable "הוספה ליומן" row, not a pasted link. */
export function sendCtaUrl(env, to, text, label, url, channel, ctx) {
  return post(env, { to: normPhone(to), type: 'interactive',
    interactive: { type: 'cta_url', body: { text: String(text) }, action: { name: 'cta_url', parameters: { display_text: String(label).slice(0, 20), url: String(url) } } } }, channel, ctx);
}

export function sendText(env, to, text, channel, ctx) {
  return post(env, { to: normPhone(to), type: 'text', text: { body: String(text) } }, channel, ctx);
}

/* An image with a caption — what an invitation actually looks like when the
   client uploaded artwork and the guest already has an open window. */
export function sendImage(env, to, imageUrl, caption, channel, ctx) {
  return post(env, {
    to: normPhone(to), type: 'image',
    image: { link: imageUrl, caption: String(caption || '').slice(0, 1024) },
  }, channel, ctx);
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

/* One template body variable, the way Meta accepts it: no CR/LF/tab (132018),
   no run of more than 4 spaces, no control characters, no stray unbalanced
   quote at the edges (a lead named `"הבוטח` was greeted `היי "הבוטח`), at
   most 300 characters. Hebrew gershayim (״) and inner quotes are kept. */
export function cleanParam(v) {
  let s = String(v ?? '').replace(new RegExp('[\\r\\n\\t\\u2028\\u2029]+', 'g'), ' ').replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), '');
  s = s.replace(/ {2,}/g, ' ').trim();
  const q = /["“”]/g;
  if (((s.match(q) || []).length % 2) === 1) s = s.replace(/^["“”]+|["“”]+$/g, '').trim();
  if (s.length > 300) s = s.slice(0, 299).trim() + '…';
  return s;
}

/* The production path. `params` are the positional body variables; `imageUrl`
   fills a header of type IMAGE when the template has one. */
export async function sendTemplate(env, to, name, params = [], imageUrl = '', lang = 'he', channel, ctx) {
  /* Richard, 11/09: every template gets the ishur.io footer. The footer
     copies are submitted as <name>_f; the pacer writes tmplf:<name> once Meta
     approves one, and from then on the copy goes out instead. */
  /* 26/09: on the ishur.io portfolio the client templates live under new
     names (<name>_n, footer built in) because Meta locks a deleted name for
     30 days. Portfolio + client channel → _n, and the _f switch is skipped. */
  const isClient = !(channel === 'guests' && guestsReady(env));
  if (isClient && clientOnPortfolio(env) && PORTFOLIO_RENAMED.has(name)) name = name + '_n';
  else { try { const f = env.RATE ? await env.RATE.get('tmplf:' + name) : null; if (f) name = f; } catch {} }
  /* 02/11 audit: Meta refuses a body variable with a newline / tab / more
     than 4 spaces in a row (132018) and an empty one (131008) — and a refused
     send was retried every tick. Clean every variable here, once, for every
     caller; refuse an empty one before Meta sees it (permanent: retrying the
     same sheet data cannot help, a human has to fill the cell). */
  params = (params || []).map(cleanParam);
  const emptyAt = params.findIndex(p => !p);
  if (emptyAt >= 0) {
    try {
      const ek = `emptyparam:${name}:${String((ctx && ctx.token) || '').slice(0, 8)}:${ilDayKey()}`;
      if (!env.RATE || !(await env.RATE.get(ek))) {
        if (env.RATE) await env.RATE.put(ek, '1', { expirationTtl: 86400 });
        await logEvent(env, { area: 'שליחה', action: 'תבנית לא נשלחה — משתנה ריק', ok: false, review: true, phone: normPhone(to), token: ctx && ctx.token ? String(ctx.token) : '', detail: `${name} · משתנה {{${emptyAt + 1}}} ריק` });
      }
    } catch {}
    return { ok: false, error: `empty-param:{{${emptyAt + 1}}}`, permanent: true };
  }
  const components = [];
  if (imageUrl) {
    /* an .mp4 link fills a VIDEO header; anything else an IMAGE header. The
       file goes exactly as uploaded — WhatsApp does not crop or re-cut it. */
    const isVideo = /\/vid\/|\.mp4(\?|$)/i.test(String(imageUrl));
    components.push(isVideo
      ? { type: 'header', parameters: [{ type: 'video', video: { link: imageUrl } }] }
      : { type: 'header', parameters: [{ type: 'image', image: { link: imageUrl } }] });
  }
  if (params.length) {
    components.push({
      type: 'body',
      parameters: params.map(p => ({ type: 'text', text: String(p ?? '') })),
    });
  }
  const res = await post(env, {
    to: normPhone(to), type: 'template',
    template: { name, language: { code: lang }, ...(components.length ? { components } : {}) },
  }, channel, ctx);
  /* 20/10: the cap gauge. Meta allows TIER_250 business-initiated
     conversations per rolling 24h on the guests number; a template to a
     guest who had none in the last 24h opens one. bic:<ts>:<phone> lives
     exactly 24h, so a count of the prefix IS the number Meta is counting,
     and the oldest key says when the next slot frees. One key per phone per
     24h (the gday guard already keeps it to one send per guest per day). */
  if (res && res.ok && channel === 'guests' && env.RATE && !ctx?.probe) {
    try { await env.RATE.put('bic:' + Date.now() + ':' + normPhone(to), '1', { expirationTtl: 86400 }); } catch {}
  }
  return res;
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
  /* opt-out must be the whole intent, anchored: a bare "הסר" or an explicit
     phrase. Unanchored it also matched הסרטון, הסרנו, and removed a guest
     from the list forever over a word about a video. */
  /* two different requests, two different channels. "הסר" stops the WhatsApp
     messages; "לא להתקשר" stops the phone calls. Neither implies the other. */
  if (/(לא להתקשר|אל תתקשרו|אל תתקשר|תפסיקו להתקשר|לא לחייג)/.test(clean)) {
    return { kind: 'nocall' };
  }
  /* \b is defined on [A-Za-z0-9_], so it never matches after a Hebrew letter.
     The boundary has to be spelled out: end of string, space, or punctuation. */
  if (/^\s*(הסר|הסירו|תסירו|הפסיקו|תפסיקו|תורידו אותי)(\s|$|[.!,?׃־])/.test(clean) ||
      /(להסיר אותי|תסירו אותי|הסירו אותי)/.test(clean)) {
    return { kind: 'optout' };
  }

  /* "טעות" — the invitation reached the wrong number. Scoped to ONE event,
     unlike הסר: the same phone may be a real guest at somebody else's wedding
     next month. Anchored like the opt-out, or "בטעות" inside a sentence about
     something else would silence a legitimate guest. */
  if (/^\s*(טעות|זו טעות|זאת טעות|הגיע בטעות|הגיעה בטעות|קיבלתי בטעות|לא מכיר|לא מכירה|מספר שגוי|מספר לא נכון)(\s|$|[.!,?׃־])/.test(clean) &&
      /* 02/11: "טעות, 2 מגיעים" / "טעות - לא מגיעים" is a guest CORRECTING their
         answer, not a wrong number. A digit or an RSVP word after "טעות" means
         fall through to the normal parsing below. */
      !/^\s*(טעות|זו טעות|זאת טעות)[\s.!,?׃־-]+.*(\d|מגיע|נגיע|נהיה|כן\b|לא\b)/.test(clean)) {
    return { kind: 'mistake' };
  }

  /* a bare number = party size reply */
  const bare = clean.replace(/[^\d]/g, '');
  if (bare && bare === clean.replace(/\s/g, '') && Number(bare) >= 1 && Number(bare) <= 99) {
    return { kind: 'party', party: Number(bare) };
  }

  /* 02/11 audit: "בטח שלא" and "אשמח לדעת מה הכתובת" used to be written to the
     sheet as מגיע. בטח/אשמח/ברור count only when followed by an arrival word
     or nothing; any yes-prefix with a negation later in the text is left to
     the free-text path, which reads the whole sentence. */
  const yesStrong = /^(מגיע|מגיעה|מגיע\/ה|מגיעים|כן|נגיע|נהיה שם)/.test(clean);
  const yesSoft = /^(בטח|אשמח|ברור)(?!\s*ש?לא)(?=[\s,.!]*(נגיע|מגיע|מגיעה|מגיעים|נבוא|להגיע|לבוא|$|[^֐-׿\w]*$))/.test(clean);
  const negated = /(^|[\s,.\-])(ש?לא|אין)([\s,.!?]|$)/.test(clean.replace(/^(כן|מגיע\S*|נגיע|בטח|אשמח|ברור)/, ''));
  const yes = (yesStrong || yesSoft) && !negated;
  const no = /^(לא מגיע|לא מגיעה|לא מגיע\/ה|לא מגיעים|לא נגיע|לא נוכל|לצערנו|לא נספיק)|^לא\s*$|^לא[.!]/.test(clean);
  const maybe = /(עדיין לא|לא ידוע|מתלבט|נעדכן|לא בטוח|לא יודע|לא סגרנו|אולי)/.test(clean);

  /* order matters: "לא בטוח עדיין" is undecided, not a refusal. A bare "לא"
     still declines, but anything after it has to be checked first. */
  if (maybe) return { kind: 'rsvp', outcome: 'מתלבט' };
  if (no) return { kind: 'rsvp', outcome: 'לא מגיע' };
  if (yes) {
    /* a time ("מגיעים ב-19:30") or a date is not a head count */
    const n = partyDigits(clean);
    return { kind: 'rsvp', outcome: 'מגיע', party: n || undefined };
  }
  return { kind: 'text', body: text };
}

/* digits that can be a head count: times (19:30), dates (5/11, 05.11.2026),
   long numbers (phones, years, money) and "בשעה 8"-style hours are removed
   first; 1..30 only. 02/11 audit: "נגיע בסביבות 20:00" was written as 20
   guests, "באיזו שעה מתחיל? 19:30?" as 19. */
function stripNonCounts(s) {
  return String(s || '')
    .replace(/\d{1,2}[:.]\d{2}/g, ' ')
    .replace(/\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?/g, ' ')
    .replace(/\d{3,}/g, ' ')
    .replace(/(בשעה|שעה|בסביבות|סביבות|עד|אחרי|לפני|ב-)\s*-?\s*\d{1,2}/g, ' ')
    .replace(/\d+\s*(₪|ש"ח|שח|שקל|שקלים|%)/g, ' ');
}
function partyDigits(s) {
  const m = stripNonCounts(s).match(/(^|[^\d])(\d{1,2})(?!\d)/);
  if (!m) return null;
  const n = Number(m[2]);
  return n >= 1 && n <= 30 ? n : null;
}

/* Hebrew words people answer "how many of you?" with, plus a loose digit
   grab. Only consulted while a party-size question is actually open. */
const HE_COUNT = { 'לבד': 1, 'רק אני': 1, 'אחד': 1, 'אחת': 1, 'שניים': 2, 'שתיים': 2, 'זוג': 2,
  'שלושה': 3, 'שלוש': 3, 'ארבעה': 4, 'ארבע': 4, 'חמישה': 5, 'חמש': 5, 'שישה': 6, 'שש': 6,
  'שבעה': 7, 'שבע': 7, 'שמונה': 8, 'תשעה': 9, 'תשע': 9, 'עשרה': 10, 'עשר': 10 };
export function partyFromText(text) {
  const clean = String(text || '').replace(/[‎‏]/g, '').trim();
  if (!clean) return null;
  const n = partyDigits(clean);
  if (n) return n;
  /* a digit that was a time/date/phone is not a count — and then a stray
     "אחד"/"שתיים" in the same sentence is not one either */
  if (/\d/.test(clean)) return null;
  for (const w of Object.keys(HE_COUNT)) if (new RegExp('(^|[\\s,.])' + w + '($|[\\s,.!])').test(clean)) return HE_COUNT[w];
  return null;
}
/* free text that is a question ("באיזו שעה? 19:30?", "מתי זה, ב-5?") must not
   be read as an RSVP or a head count */
export function isQuestion(text) {
  const t = String(text || '').trim();
  return /\?|？/.test(t) || /^(מה|מתי|איפה|איך|למה|מי|האם|כמה|באיזו|באיזה|היכן|אפשר)(\s|$)/.test(t);
}

/* Free-text intent of a known guest (Richard 21/10): "בסוף לא מסתדר לי
   להגיע" is a no, "לא מודע כרגע" is unsure, not "forward to the hosts".
   Order matters: unsure before no, because "לא יודע" contains "לא". */
const UNSURE_RE = /(לא\s*(יודע|יודעת|יודעים|בטוח|בטוחה|בטוחים|מודע|מודעת|סגור|סגורה|סגורים|החלטנו|החלטתי)|עדיין לא|עוד לא|אעדכן|נעדכן|אבדוק|נבדוק|אולי|יכול להיות|נראה לי ש|לא ברור|תלוי|מתלבט|מתלבטת|מתלבטים|צריך לבדוק|צריכה לבדוק)/;
const NO_RE = /((^|\s)(לא|אין)\s*(נגיע|מגיע|מגיעה|מגיעים|נוכל|נבוא|נצליח|נהיה|אגיע|אבוא|אהיה|אוכל|יכול|יכולה|יכולים|אצליח|מסתדר|מסתדרת|יוצא|יוצאת|מתאפשר)|לא[^.!?]{0,25}(להגיע|לבוא|להיות שם|להשתתף)|אי אפשר|^(בסוף\s*)?לא\.?$|לצערנו|לצערי|לא נגיע|מוותרים|נוותר)/;
const YES_RE = /((בסוף|כן)\s*(כן|נגיע|מגיע|מגיעה|מגיעים|נבוא|אגיע|אבוא)|^(כן|מגיע|מגיעה|מגיעים|נגיע|אגיע|נהיה שם|אהיה שם|בטח|ברור)[\s.!]*$)/;
export function guestIntent(text) {
  const t = String(text || '').replace(/[‎‏]/g, '').trim();
  if (!t) return null;
  if (UNSURE_RE.test(t)) return 'unsure';
  if (NO_RE.test(t)) return 'no';
  if (YES_RE.test(t) && !/לא/.test(t)) return 'yes';
  return null;
}

/* Pull the reply messages out of Meta's webhook envelope */
export function extractInbound(payload) {
  const out = [];
  for (const entry of (payload && payload.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      /* Meta sends the sender's WhatsApp profile name alongside the message.
         It is the only name we get for a number that is in no sheet, so it is
         worth keeping: the inbox shows a person, not a phone number. */
      const names = {};
      for (const c of v.contacts || []) {
        const wa = String(c.wa_id || '');
        const nm = String((c.profile && c.profile.name) || '').trim();
        if (wa && nm) names[wa] = nm;
      }
      for (const m of v.messages || []) {
        const from = String(m.from || '');
        out.push({
          from, msg: m,
          phoneId: String((v.metadata && v.metadata.phone_number_id) || ''),
          profileName: names[from] || '',
        });
      }
      /* Coexistence: a message Richard types in the WhatsApp Business app on
         the same number comes back here as an echo (field smb_message_echoes).
         It is not inbound — it is a human taking the conversation. */
      if (ch.field === 'smb_message_echoes') {
        for (const m of v.message_echoes || []) {
          out.push({
            echo: true, from: String(m.from || ''), to: String(m.to || ''), msg: m,
            phoneId: String((v.metadata && v.metadata.phone_number_id) || ''),
            profileName: '',
          });
        }
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
      /* the resend path needs to know who this is and what they already
         answered: without these it greeted everyone "אורח יקר" and re-offered
         the RSVP buttons to people who had already replied */
      name: String(r[3] || '').trim(),
      rsvp: String(r[15] || '').trim(),
      party: Number(String(r[13] || '').trim()) || Number(String(r[5] || '').trim()) || 0,
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

function ilTimeLocal(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
