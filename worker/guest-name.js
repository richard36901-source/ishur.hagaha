/* ============================================================================
   ishur.io · guest-name.js · "לשלוח עם שם האורח" per event (Richard 26/11)
   ----------------------------------------------------------------------------
   A guest saved as "דודה של הכלה" or "חבר מהצבא 2" must not be greeted by it.
   The client turns the name off once (evsettings:<token>.guest_name = false,
   edited on the board's "הגדרות מתקדמות" and on the team's client card) and
   EVERY guest template follows: invitation, reminders, extra send, day-before,
   event-day, table, thank-you, gift, cancel / postpone, resend, sub-events and
   any notice added later, because the decision sits inside sendTemplate
   (whatsapp.js), the one door every guest template goes through.

   With the name off, for a template whose {{1}} is the guest's name:
     1. twin    — the no-name copy <name>_anon (the greeting line without the
                  name, variables renumbered from {{1}}) once Meta approved it
                  (KV tmplanon:<name> = '<name>_anon', set by the admin check
                  route below). The name parameter is dropped.
                  Skipped for an event whose messages go out in another
                  language: the copy has no translations, the neutral word has.
     2. neutral — no approved twin yet: the same template with {{1}} =
                  'אורח יקר' (every name-first template opens with "שלום
                  {{1}}" / "היי {{1}}", so the generic value reads naturally;
                  guest-lang.js already translates it).
     3. hold    — a template we do not know (a hand-picked sub-event or
                  event-day template, a new family nobody registered here):
                  nothing is sent, the caller sees a permanent failure (the
                  wave stops and stays open, like an empty variable), and the
                  journal + Slack get ONE line per event and template per day.
   A template with no variables, or one known to carry no name, goes as is.

   §1 pure (unit-tested in test/guest-name.test.mjs) · §2 KV · §3 routes
   ========================================================================== */

import { alert } from './slack.js';
import { readGuestLang, guestLangOn, TRANSLATED } from './guest-lang.js';

/* ── §1 pure ──────────────────────────────────────────────────────────────── */

export const NEUTRAL = 'אורח יקר';
export const ANON_SUFFIX = '_anon';
export const anonName = name => String(name || '') + ANON_SUFFIX;

/* {{1}} is the guest's name. Covers the caller-chosen names and their twins:
   _v2, _img/_vid(_u), the styled invitations, _yn, _ab<n>, _img (tmplimg), _f, _r<n>. */
const NAME_FIRST_RE = /^(hazmana_ishur|ishur_hazmana_shuv|ishur_yom_lifnei|ishur_lifnei_(combo|plain)_|ishur_yom_(combo|plain)_|ishur_shulchan|ishur_bitul|ishur_dchiya|ishur_matana|ishur_toda_|ishur_shabat_hatan)/;
/* known to carry no name: the old event-day message ({{1}} = the time), the client's own wording (no variables),
   the no-name copies themselves */
const NO_NAME_RE = /^(ishur_yom_haerua|ishur_c_[0-9a-f]{8}_\d+)|_anon$/;

export function nameFamily(name) {
  const n = String(name || '');
  if (NO_NAME_RE.test(n)) return 'none';
  if (NAME_FIRST_RE.test(n)) return 'first';
  return 'unknown';
}

/* The decision for one send. on = the event sends with names (the default).
   twin = the approved no-name copy of this template ('' = none). → { action, name, params }
   action: 'keep' (unchanged) | 'twin' | 'neutral' | 'hold' */
export function decideGuestName({ name, params = [], on = true, twin = '' }) {
  const p = Array.isArray(params) ? params : [];
  if (on || !p.length) return { action: 'keep', name, params: p };
  const fam = nameFamily(name);
  if (fam === 'none') return { action: 'keep', name, params: p };
  if (fam === 'first') {
    if (twin) return { action: 'twin', name: twin, params: p.slice(1) };
    return { action: 'neutral', name, params: [NEUTRAL, ...p.slice(1)] };
  }
  return { action: 'hold', name, params: p };
}

/* A body without the guest's name: the first {{1}} (and the space before it) goes, every {{n}} becomes {{n-1}}.
   "שלום {{1}}! הוזמנתם ל{{2}}" → "שלום! הוזמנתם ל{{1}}". null when the body has no {{1}}. */
export function anonBody(body) {
  const s = String(body || '');
  if (!/\{\{1\}\}/.test(s)) return null;
  return s.replace(/[ \t]*\{\{1\}\}/, '').replace(/\{\{(\d+)\}\}/g, (m, i) => `{{${Number(i) - 1}}}`);
}

/* the Meta payload of the no-name copy, from the record of the live template (templates/<name>.json payload).
   Same category, header, footer and buttons; the body example loses its first value. null when it has no name. */
export function anonPayload(payload) {
  if (!payload || !payload.name || !Array.isArray(payload.components)) return null;
  let changed = false;
  const components = payload.components.map(c => {
    if (!c || c.type !== 'BODY') return c;
    const text = anonBody(c.text); if (text == null) return c;
    changed = true;
    const out = { ...c, text };
    const ex = c.example && Array.isArray(c.example.body_text) && Array.isArray(c.example.body_text[0]) ? c.example.body_text[0] : null;
    if (ex) out.example = { ...c.example, body_text: [ex.slice(1)] };
    if (out.example && (!out.example.body_text || !out.example.body_text[0] || !out.example.body_text[0].length)) delete out.example;
    return out;
  });
  if (!changed) return null;
  return { ...payload, name: anonName(payload.name), allow_category_change: false, components };
}

/* the settings value: absent = on (every event before 26/11 keeps its names) */
export const guestNameFromSettings = s => !(s && s.guest_name === false);

/* What the board's preview shows for the invitation/reminder bubbles: 'name' | 'twin' | 'neutral'. */
export function previewMode(on, twinApproved) { return on ? 'name' : twinApproved ? 'twin' : 'neutral'; }

/* ── §2 KV ────────────────────────────────────────────────────────────────── */

const memo = new WeakMap();   /* per KV binding: a wave asks the same two questions for every guest, kept a minute */
const TTL = 60000;
function cache(env) { let m = memo.get(env.RATE); if (!m) { m = new Map(); memo.set(env.RATE, m); } if (m.size > 600) m.clear(); return m; }
export function forgetGuestName(env) { if (env && env.RATE) memo.delete(env.RATE); }

async function readSettings(env, token) {
  try { return JSON.parse((await env.RATE.get('evsettings:' + token)) || 'null'); } catch { return null; }
}
/* Does this event send with the guest's name? A sub-event (subevent:<token>) follows its parent's setting. */
export async function guestNameOn(env, token) {
  if (!env || !env.RATE || !token) return true;
  const m = cache(env), k = 'on|' + token, hit = m.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  let v = true;
  try {
    let s = await readSettings(env, token);
    if (!s) {
      let sub = null; try { sub = JSON.parse((await env.RATE.get('subevent:' + token)) || 'null'); } catch {}
      if (sub && sub.parent) s = await readSettings(env, String(sub.parent));
    }
    v = guestNameFromSettings(s);
  } catch { v = true; }
  m.set(k, { v, at: Date.now() });
  return v;
}
/* the approved no-name copy of this template, '' when there is none */
export async function anonTwin(env, name) {
  if (!env || !env.RATE || !name) return '';
  const m = cache(env), k = 'tw|' + name, hit = m.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  let v = '';
  try { v = String((await env.RATE.get('tmplanon:' + name)) || ''); } catch { v = ''; }
  m.set(k, { v, at: Date.now() });
  return v;
}

/* journal + Slack, once per event + template per day */
async function reportHold(env, token, name) {
  try {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    const k = `gnhold:${String(token).slice(0, 8)}:${name}:${day}`;
    if (env.RATE && await env.RATE.get(k)) return;
    if (env.RATE) await env.RATE.put(k, '1', { expirationTtl: 2 * 86400 });
    await alert(env, 'שליחה', 'הודעה למוזמנים לא נשלחה: הלקוח ביקש לשלוח בלי שם האורח',
      `אירוע ${String(token).slice(0, 8)} · תבנית ${name} לא מוכרת כתבנית שאפשר לשלוח בלי שם (guest-name.js). להוסיף אותה לרשימה או להגיש עותק ${anonName(name)}. ההודעה מחכה, שום דבר לא יצא עם השם.`,
      { key: 'gnhold:' + String(token).slice(0, 8) + ':' + name });
  } catch {}
}

/* The hook sendTemplate calls first. → { name, params, ctx } to go on with, or { hold: result } to return as is. */
export async function applyGuestName(env, { name, params, channel, ctx }) {
  const p = Array.isArray(params) ? params : [];
  /* ctx.noGuestName: the caller's params are the event's, never a guest's name (the hand-set event-day job) */
  if (channel !== 'guests' || !ctx || !ctx.token || ctx.gnDone || ctx.langTried || ctx.probe || ctx.noGuestName || !p.length) return { name, params: p, ctx };
  const token = String(ctx.token);
  const on = await guestNameOn(env, token);
  const next = { ...ctx, gnDone: 1 };
  if (on) return { name, params: p, ctx: next };
  let twin = nameFamily(name) === 'first' ? await anonTwin(env, name) : '';
  /* the copy has no translations: an event in another language gets the neutral word, which guest-lang translates */
  if (twin && guestLangOn(env) && TRANSLATED.has(name)) {
    const c = await readGuestLang(env, token).catch(() => ({ mode: 'he' }));
    if (c && c.mode && c.mode !== 'he') twin = '';
  }
  const d = decideGuestName({ name, params: p, on, twin });
  if (d.action === 'hold') {
    await reportHold(env, token, name);
    return { hold: { ok: false, error: 'guest-name-hold', permanent: true } };
  }
  return { name: d.name, params: d.params, ctx: next };
}

/* ── §3 routes ────────────────────────────────────────────────────────────
   POST /api/guest-name  (the team's client card)
     {admin_key, token}             → { ok, token, on }
     {admin_key, token, on:bool}    → saves into evsettings:<token> (other fields kept); same answer
   POST /api/guest-name-twins  (admin)
     {admin_key}                    → { ok, twins:[{ base, twin, on }] } from KV only
     {admin_key, action:'check'}    → reads Meta's status of every <base>_anon in ANON_BASES and sets / clears
                                      tmplanon:<base>; → { ok, twins:[{ base, twin, status, category, on }] }
   deps: { okJson, deny, isAdmin, tokenRecord, logEvent, saveSettings, fetchFn? } */

/* the names a sender passes today (caller-chosen, before the in-sendTemplate swaps), for the twin check */
export const ANON_BASES = [
  'hazmana_ishur', 'hazmana_ishur_v2', 'hazmana_ishur_v2_yn', 'hazmana_ishur_img', 'hazmana_ishur_vid', 'hazmana_ishur_img_u', 'hazmana_ishur_vid_u',
  'hazmana_ishur_serious', 'hazmana_ishur_serious_img', 'hazmana_ishur_serious_vid',
  'hazmana_ishur_respectful', 'hazmana_ishur_respectful_img', 'hazmana_ishur_respectful_vid',
  'hazmana_ishur_playful', 'hazmana_ishur_playful_img', 'hazmana_ishur_playful_vid',
  'ishur_hazmana_shuv', 'ishur_yom_lifnei', 'ishur_yom_lifnei_img',
  ...['n', 'g', 'gb', 'gp', 't', 'tg', 'tgb', 'tgp'].flatMap(k => ['ishur_lifnei_combo_' + k, 'ishur_lifnei_combo_' + k + '_img']),
  ...['g', 'gb', 'gp', 't', 'tg', 'tgb', 'tgp'].flatMap(k => ['ishur_lifnei_plain_' + k, 'ishur_lifnei_plain_' + k + '_img']),
  ...['n', 'g', 'gb', 'gp', 't', 'tg', 'tgb', 'tgp'].map(k => 'ishur_yom_combo_' + k),
  ...['s', 'g', 'gb', 'gp', 't', 'tg', 'tgb', 'tgp'].map(k => 'ishur_yom_plain_' + k),
  'ishur_shulchan', 'ishur_shulchan_matana', 'ishur_bitul', 'ishur_dchiya',
  'ishur_matana', 'ishur_matana2', 'ishur_toda_matana', 'ishur_toda_matana2', 'ishur_toda_orach', 'ishur_toda_orach_v2', 'ishur_toda_orach_u',
  'ishur_shabat_hatan_reminder',
];

const TOKEN_RE = /^[0-9a-f-]{36}$/;

export async function handleGuestName(request, env, origin, deps) {
  let b = {}; try { b = await request.json(); } catch { return deps.deny(400, 'bad-json', origin); }
  if (!deps.isAdmin(env, b.admin_key)) return deps.deny(403, 'bad-admin-key', origin);
  const tok = String(b.token || '').trim();
  if (!TOKEN_RE.test(tok) || !(await deps.tokenRecord(env, tok))) return deps.deny(404, 'unknown-token', origin);
  if (typeof b.on === 'boolean') {
    const r = await deps.saveSettings(env, tok, { guest_name: b.on });
    if (r && r.error) return deps.deny(422, r.error, origin);
    forgetGuestName(env);
    await deps.logEvent(env, { area: 'לוח', action: b.on ? 'שם האורח בהודעות: הופעל (צוות)' : 'שם האורח בהודעות: כובה (צוות)', ok: true, token: tok }).catch(() => {});
  }
  return deps.okJson({ ok: true, token: tok, on: await guestNameOn(env, tok) }, origin);
}

export async function handleGuestNameTwins(request, env, origin, deps) {
  let b = {}; try { b = await request.json(); } catch { return deps.deny(400, 'bad-json', origin); }
  if (!deps.isAdmin(env, b.admin_key)) return deps.deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deps.deny(503, 'not-configured', origin);
  if (b.action !== 'check') {
    const twins = await Promise.all(ANON_BASES.map(async base => ({ base, twin: anonName(base), on: (await env.RATE.get('tmplanon:' + base).catch(() => null)) === anonName(base) })));
    return deps.okJson({ ok: true, twins }, origin);
  }
  const tok = env.WA_TOKEN_GUESTS; if (!tok) return deps.deny(503, 'not-configured', origin);
  const fetchFn = deps.fetchFn || fetch;
  const r = await fetchFn(`https://graph.facebook.com/v21.0/1378764257421712/message_templates?fields=name,status,category&limit=500`, { headers: { Authorization: 'Bearer ' + tok } }).catch(() => null);
  const j = r ? await r.json().catch(() => null) : null;
  if (!j || !Array.isArray(j.data)) return deps.deny(502, 'meta-read-failed', origin);
  const by = {}; for (const t of j.data) by[t.name] = t;
  const twins = [];
  for (const base of ANON_BASES) {
    const twin = anonName(base), t = by[twin], status = t ? String(t.status || '').toUpperCase() : 'MISSING';
    const ok = status === 'APPROVED';
    if (ok) await env.RATE.put('tmplanon:' + base, twin); else await env.RATE.delete('tmplanon:' + base).catch(() => {});
    twins.push({ base, twin, status, category: t ? t.category || '' : '', on: ok });
  }
  forgetGuestName(env);
  await deps.logEvent(env, { area: 'תבניות', action: 'בדיקת עותקים בלי שם האורח', ok: true, detail: `${twins.filter(x => x.on).length} מאושרים מתוך ${twins.length}` }).catch(() => {});
  return deps.okJson({ ok: true, twins }, origin);
}
