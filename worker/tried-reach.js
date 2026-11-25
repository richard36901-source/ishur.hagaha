/* ============================================================================
   ishur.io · tried-reach.js · "ניסינו להשיג אותך" (25/11/2026)
   ----------------------------------------------------------------------------
   One button on a lead (the leads screen, the app, or a monday button) sends,
   from Noa's number (4499, the clients/leads channel, never a guests number):
     "היי {name}, ניסינו להשיג אותך בנוגע לאישורי הגעה — אל דאגה, ננסה שוב
      בהמשך, או כתבו לנו מתי הכי נוח שנחייג 🙂"

   · inside the lead's 24h window → the same words as free text;
   · outside it → the approved template noa_tried_reach ({{1}} = first name).
     The template is NOT at Meta yet (PROPOSED below is what to submit, as
     UTILITY). Until it is approved a template send fails at Meta, and the
     button shows the calm "לא נשלח" line, like any other failure.
   · lead hours 10:00–20:00 Israel (and never on Shabbat). Pressed outside
     them → queued (KV reachq:<phone>) and sent by the 10-minute cron at the
     next 10:00.
   · a press within COOLDOWN_MS of a sent/queued one for the same phone is the
     same press (page double-click, monday retries): nothing new goes out.
   · every press → the lead's history (store activity on L<phone>) + the journal
     (logEvent); a failure → one Slack alert per error code (keyed, deduped).
   · off switch: TRIED_REACH="off" (env or cfg) → nothing is sent or queued.

   Routes:
     POST /api/crm/leads/<m<itemId>|L<phone>>/tried-reach   {admin_key}  (handleCrm → crmDeps.triedReach)
     POST /webhooks/monday-tried-reach?k=<MONDAY_WEBHOOK_SECRET>   (a monday automation)
   ========================================================================== */
import { clientHoursOpen, windowOpen, phoneOf, leadIdOf } from './crm.js';
import { storedLead, readItem, itemIdOf, BOARD } from './leads-sync.js';
import { mondayGql } from './monday.js';
import { logEvent } from './evlog.js';
import { safeEqual } from './lib.js';

export const TEMPLATE = 'noa_tried_reach';
export const REACH_OPEN_H = 10, REACH_CLOSE_H = 20;
export const COOLDOWN_MS = 10 * 60e3;
export const QUEUE_TTL = 4 * 86400;
export const MONDAY_CAP = 6;                 /* monday-originated presses per 10 minutes (a button automation once fired for every item) */
export const FAIL_HE = 'לא נשלח — נסו שוב מאוחר יותר';
const K = { q: 'reachq:', last: 'reach:last:', cap: 'reach:mcap:' };
export const textFor = first => `היי ${first}, ניסינו להשיג אותך בנוגע לאישורי הגעה — אל דאגה, ננסה שוב בהמשך, או כתבו לנו מתי הכי נוח שנחייג 🙂`;
/* what Richard submits to Meta (on Noa's WABA). Not submitted from here. */
export const PROPOSED = {
  name: TEMPLATE, category: 'UTILITY', language: 'he',
  body: 'היי {{1}}, ניסינו להשיג אותך בנוגע לאישורי הגעה — אל דאגה, ננסה שוב בהמשך, או כתבו לנו מתי הכי נוח שנחייג 🙂',
  example: ['דנה'],
};

const jparse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const kvJson = async (env, k) => (env.RATE ? jparse(await env.RATE.get(k).catch(() => null)) : null);
const mask = p => String(p || '').replace(/^972(\d{2})\d+(\d{3})$/, '0$1*****$2');

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */
/* "דנה לוי - חתונה" → "דנה"; nothing usable → "שלום" (Meta refuses an empty variable) */
export function firstName(name) {
  const w = String(name || '').replace(/[-–—|,/()]+/g, ' ').trim().split(/\s+/)[0] || '';
  const t = w.replace(/[^\p{L}'׳]/gu, '').slice(0, 20);
  return t.length >= 2 ? t : 'שלום';
}
function ilHour(ts) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ts))); }
export function reachOpen(ts) { const h = ilHour(ts); return clientHoursOpen(ts) && h >= REACH_OPEN_H && h < REACH_CLOSE_H; }
/* the next moment inside 10:00–20:00 (quarter-hour steps, so it lands on 10:00 sharp); ts itself when open */
export function nextReachAt(ts) {
  if (reachOpen(ts)) return ts;
  let t = Math.ceil(ts / 900e3) * 900e3;
  for (let i = 0; i < 4 * 24 * 4; i++, t += 900e3) if (reachOpen(t)) return t;
  return ts;
}
/* what one press does → { action: 'send'|'queue'|'refuse', via, due, reason } */
export function decide({ now, inWindow = false, paused = false, optout = false, off = false }) {
  if (off) return { action: 'refuse', reason: 'off' };
  if (optout) return { action: 'refuse', reason: 'optout' };
  if (!reachOpen(now)) return { action: 'queue', due: nextReachAt(now) };
  if (paused) return { action: 'refuse', reason: 'paused' };
  return { action: 'send', via: inWindow ? 'text' : 'template' };
}
/* the press the cooldown swallows: a sent/queued one for the same phone a moment ago (a failed one may be retried at once) */
export function isRepeat(last, now) { return !!last && (last.state === 'sent' || last.state === 'queued') && now - Number(last.at || 0) < COOLDOWN_MS; }
const hhmm = ts => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));

/* ══ §2 I/O ════════════════════════════════════════════════════════════════ */
async function history(env, store, phone, { text, state, via = '', who = '', source = '', error = '' }, now) {
  if (store) {
    try { await store.appendActivity({ entity_type: 'lead', entity_id: leadIdOf(phone), kind: 'reach', dir: 'out', text, at: new Date(now).toISOString(), meta: { state, via: via || undefined, who: who || undefined, source: source || undefined, error: error || undefined } }); } catch { /* history only */ }
  }
  await logEvent(env, { area: 'לידים', action: 'ניסינו להשיג · ' + ({ sent: 'נשלח', queued: 'ממתין ל-10:00', failed: 'לא נשלח', repeat: 'לחיצה כפולה' }[state] || state), ok: state !== 'failed', review: state === 'failed', phone, detail: [text, who && 'מי: ' + who, source && 'מאיפה: ' + source, error].filter(Boolean).join(' · ') }).catch(() => {});
}

async function isOff(env) {
  if (String(env.TRIED_REACH || '') === 'off') return true;
  return env.RATE ? (await env.RATE.get('cfg:tried_reach').catch(() => null)) === 'off' : false;
}
async function optedOut(env, phone) {
  if (!env.RATE) return false;
  return !!(await env.RATE.get('optout:' + phone).catch(() => null)) || !!(await env.RATE.get('block:' + phone).catch(() => null));
}

/* one real send attempt (hours already checked) → { ok, via, error } */
async function deliver(env, d, store, { phone, name }, who, now) {
  if (d.sendingPaused && await d.sendingPaused(env).catch(() => false)) return { ok: false, error: 'paused' };
  let crmLead = null; try { crmLead = store ? await store.get('leads', leadIdOf(phone)) : null; } catch { crmLead = null; }
  const conv = await kvJson(env, 'conv:' + phone);
  const first = firstName(name), via = windowOpen(crmLead, conv, now) ? 'text' : 'template';
  const ctx = { who: 'ניסינו להשיג · ' + (who || 'admin'), name: name || '' };
  let r;
  try {
    r = via === 'text' ? await d.sendText(env, phone, textFor(first), 'client', ctx) : await d.sendClient(env, phone, TEMPLATE, [first], ctx);
  } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  return r && r.ok ? { ok: true, via, id: r.id || '' } : { ok: false, via, error: String((r && r.error) || 'unknown').slice(0, 160) };
}
async function alertFail(env, d, phone, error, source) {
  const code = (/\b(\d{6})\b/.exec(error) || [])[1] || String(error).split(/[\s:]/)[0] || 'unknown';
  const text = `ניסינו להשיג · ההודעה לליד לא נשלחה\n${mask(phone)} · ${error.slice(0, 120)}${source ? ' · ' + source : ''}`;
  try { if (d.slackSend) await d.slackSend(env, text, { key: 'tried_reach:' + code, sev: 'P2', action: code === '131042' ? 'החשבון של נועה ב-Meta חסום לתשלום (131042): לסדר אמצעי תשלום ב-Business Manager' : 'לבדוק את המספר של נועה ואת התבנית noa_tried_reach' }); } catch { /* alert only */ }
}

/* one press. lead = { phone, name }; who = the person (or 'מאנדיי'); source = 'screen' | 'monday' | 'app'.
   → { status, body: { ok, state:'sent'|'queued'|'repeat'|'failed', via?, due?, he } } */
export async function triedReach(env, d, { lead, who = 'admin', source = 'screen' }, { now = Date.now(), store = null } = {}) {
  const phone = phoneOf(lead && lead.phone);
  if (!phone) return { status: 400, body: { ok: false, error: 'no-phone', he: 'אין לליד מספר טלפון' } };
  if (!env.RATE) return { status: 503, body: { ok: false, error: 'no-store', he: FAIL_HE } };
  const name = String((lead && lead.name) || '').trim();
  const last = await kvJson(env, K.last + phone);
  if (isRepeat(last, now)) {
    await history(env, store, phone, { text: 'לחיצה חוזרת, לא נשלח שוב', state: 'repeat', who, source }, now);
    return { status: 200, body: { ok: true, state: 'repeat', prior: last.state, due: last.due ? new Date(last.due).toISOString() : undefined, he: last.state === 'queued' ? 'כבר ממתין לשליחה ב-' + hhmm(last.due) : 'כבר נשלח לפני כמה דקות' } };
  }
  const pending = await kvJson(env, K.q + phone);
  const dec = decide({ now, off: await isOff(env), optout: await optedOut(env, phone) });
  if (dec.action === 'refuse') {
    await history(env, store, phone, { text: dec.reason === 'optout' ? 'הליד ביקש לא לקבל הודעות' : 'הכפתור כבוי', state: 'failed', who, source, error: dec.reason }, now);
    return { status: 200, body: { ok: false, state: 'failed', error: dec.reason, he: dec.reason === 'optout' ? 'הליד ביקש לא לקבל הודעות' : FAIL_HE } };
  }
  if (dec.action === 'queue' || pending) {
    const due = pending ? Number(pending.due) : dec.due;
    if (!pending) await env.RATE.put(K.q + phone, JSON.stringify({ phone, name, who, source, at: now, due }), { expirationTtl: QUEUE_TTL });
    await env.RATE.put(K.last + phone, JSON.stringify({ state: 'queued', at: now, due }), { expirationTtl: 86400 });
    await history(env, store, phone, { text: 'מחוץ לשעות 10:00–20:00 · יישלח ב-' + hhmm(due), state: 'queued', who, source }, now);
    return { status: 200, body: { ok: true, state: 'queued', due: new Date(due).toISOString(), he: 'יישלח ב-' + hhmm(due) } };
  }
  return sendNow(env, d, store, { phone, name }, who, source, now);
}

async function sendNow(env, d, store, lead, who, source, now) {
  const r = await deliver(env, d, store, lead, who, now);
  if (r.ok) {
    await env.RATE.put(K.last + lead.phone, JSON.stringify({ state: 'sent', at: now, via: r.via }), { expirationTtl: 86400 });
    await history(env, store, lead.phone, { text: r.via === 'text' ? 'נשלח (טקסט, בתוך 24 שעות)' : 'נשלח (תבנית ' + TEMPLATE + ')', state: 'sent', via: r.via, who, source }, now);
    return { status: 200, body: { ok: true, state: 'sent', via: r.via, he: 'נשלח' } };
  }
  await env.RATE.put(K.last + lead.phone, JSON.stringify({ state: 'failed', at: now, error: r.error }), { expirationTtl: 86400 });
  await history(env, store, lead.phone, { text: 'לא נשלח', state: 'failed', via: r.via, who, source, error: r.error }, now);
  await alertFail(env, d, lead.phone, r.error, source);
  return { status: 200, body: { ok: false, state: 'failed', error: 'send-failed', why: r.error, he: FAIL_HE } };
}

/* the 10-minute cron: queued presses whose time came. Inside the hours only; a queued press gets one attempt. */
export async function drainTriedReach(env, d, { now = Date.now(), store = null, max = 20 } = {}) {
  if (!env.RATE || !env.RATE.list) return { ok: false, why: 'no-kv' };
  if (!reachOpen(now)) return { ok: true, skipped: 'hours', sent: 0 };
  const pg = await env.RATE.list({ prefix: K.q, limit: 200 }).catch(() => null);
  const out = { ok: true, sent: 0, failed: 0, waiting: 0 };
  for (const k of (pg && pg.keys) || []) {
    if (out.sent + out.failed >= max) break;
    const e = await kvJson(env, k.name);
    if (!e) continue;
    if (Number(e.due) > now) { out.waiting++; continue; }
    await env.RATE.delete(k.name);   /* before the attempt: a slow tick and the next one never both send it */
    if (await isOff(env) || await optedOut(env, e.phone)) { await history(env, store, e.phone, { text: 'בוטל לפני השליחה (כבוי / ביקש לא לקבל)', state: 'failed', who: e.who, source: 'queue' }, now); out.failed++; continue; }
    const r = await sendNow(env, d, store, { phone: e.phone, name: e.name }, e.who, 'queue', now);
    if (r.body.ok) out.sent++; else out.failed++;
  }
  return out;
}

/* the lead behind a screen id: m<itemId> → the monday mirror (live read when the mirror lacks it); L<phone> → our store */
export async function leadForId(env, id, { store = null, gql = mondayGql } = {}) {
  const itemId = itemIdOf(id);
  if (itemId) {
    let l = await storedLead(env, itemId).catch(() => null);
    if (!l && env.MONDAY_API_TOKEN) { const r = await readItem(env, gql, itemId).catch(() => null); l = r && r.lead; }
    return l ? { phone: l.phone, name: l.name } : null;
  }
  if (/^L972\d{8,9}$/.test(String(id)) && store) { const l = await store.get('leads', String(id)).catch(() => null); return { phone: String(id).slice(1), name: (l && l.name) || '' }; }
  return null;
}

/* ══ §2 monday → us: a button (or a status) on the leads board ══════════════
   Same door as /webhooks/monday-leads: closed without MONDAY_WEBHOOK_SECRET, the
   secret in ?k=, the challenge answered, only board 18432553641, and the item
   read back from monday (the payload is a signal, never the data). After the
   key check the answer is always 200: monday retries a non-200 for 30 minutes
   and the cooldown already makes a retry harmless.
   Optional narrowing: MONDAY_REACH_COLUMN (only that column id), MONDAY_REACH_LABEL
   (a status column fires only when it changes TO that label). */
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
export async function handleMondayReach(request, env, url, d, { gql = mondayGql, now = Date.now(), store = null } = {}) {
  if (request.method !== 'POST') return jres({ ok: false, error: 'method' }, 405);
  if (!env.MONDAY_WEBHOOK_SECRET) return jres({ ok: false, error: 'not-configured' }, 503);
  if (!safeEqual(String(url.searchParams.get('k') || ''), String(env.MONDAY_WEBHOOK_SECRET))) return jres({ ok: false, error: 'forbidden' }, 403);
  let body = null; try { body = await request.json(); } catch { return jres({ ok: false, error: 'bad-json' }, 400); }
  if (body && typeof body.challenge === 'string') return jres({ challenge: body.challenge });
  const ev = (body && body.event) || {};
  if (String(ev.boardId || '') !== BOARD) return jres({ ok: true, ignored: 'board' });
  if (env.MONDAY_REACH_COLUMN && String(ev.columnId || '') !== String(env.MONDAY_REACH_COLUMN)) return jres({ ok: true, ignored: 'column' });
  if (env.MONDAY_REACH_LABEL) { const lab = ev.value && ev.value.label; const txt = typeof lab === 'string' ? lab : lab && lab.text; if (String(txt || '') !== String(env.MONDAY_REACH_LABEL)) return jres({ ok: true, ignored: 'label' }); }
  const itemId = String(ev.pulseId || ev.itemId || '').replace(/\D/g, '');
  if (!itemId) return jres({ ok: true, ignored: 'no-item' });
  if (!env.MONDAY_API_TOKEN || !env.RATE) return jres({ ok: false, error: 'no-token' });
  /* a burst (an automation that fires for the whole board) stops after MONDAY_CAP in ten minutes */
  const bucket = K.cap + Math.floor(now / 600e3), n = Number(await env.RATE.get(bucket).catch(() => 0)) || 0;
  if (n >= MONDAY_CAP) {
    if (n === MONDAY_CAP) { await env.RATE.put(bucket, String(n + 1), { expirationTtl: 1200 }); await logEvent(env, { area: 'לידים', action: 'ניסינו להשיג · יותר מדי לחיצות ממאנדיי, נעצר', ok: false, review: true, detail: `יותר מ-${MONDAY_CAP} בעשר דקות` }).catch(() => {}); if (d.slackSend) await d.slackSend(env, `ניסינו להשיג · יותר מ-${MONDAY_CAP} לחיצות ממאנדיי בעשר דקות, השאר לא נשלחו`, { key: 'tried_reach:burst', sev: 'P2', action: 'לבדוק את האוטומציה של הכפתור במאנדיי' }).catch(() => {}); }
    return jres({ ok: false, error: 'burst-cap' });
  }
  await env.RATE.put(bucket, String(n + 1), { expirationTtl: 1200 });
  let read; try { read = await readItem(env, gql, itemId); } catch { return jres({ ok: false, error: 'monday-read-failed' }); }
  if (read.gone || !read.lead) return jres({ ok: true, ignored: 'gone' });
  const r = await triedReach(env, d, { lead: read.lead, who: 'מאנדיי', source: 'monday' }, { now, store });
  return jres({ ...r.body, id: 'm' + itemId });
}
