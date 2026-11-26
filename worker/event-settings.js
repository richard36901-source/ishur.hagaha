/* ============================================================================
   ishur.io · event-settings.js · "הגדרות מתקדמות" on the client board (25/11)
   ----------------------------------------------------------------------------
   One KV record per event, evsettings:<token>, edited from dashboard.html
   through POST /api/event-settings (token-gated like /api/giftlinks):

     parents      { bride, groom, hosts }  → callintro:<token> (Shir's
                  {{host_details}}) + the WhatsApp "מי זה?" answer. Never said
                  or sent up front.
     names        { last1, last2 }         surnames from the setup step (the
                  event title itself is composed on the page, column 34).
     questions    { shuttle:{on,details}, food:{on}, custom:{on,q} } — asked
                  after a "מגיע" on WhatsApp (inside the 24h window, buttons /
                  list, no template) and by Shir after a phone "yes".
     call_window  { start, end, fri, fri_end } — narrows the legal calling
                  window for this event only; it can never widen it.
     gift_on_yes  default true — a guest who confirms gets the gift line
                  on the confirmation message (only when gift links are on).
     guest_name   default true — false = no guest template carries the guest's
                  name (26/11, guest-name.js decides inside sendTemplate).

   Answers per guest: fqa:<token>:<guest_id> = {shuttle, food, custom, via, at},
   the short form also in the key's metadata so the board reads them with one
   list call.

   §1 pure (unit-tested) · §2 KV helpers · §3 WhatsApp flow · §4 route
   ========================================================================== */

import { giftActive, giftKey, giftPageUrl } from './gifts.js';
import { introFor } from './shir.js';
import { guestIntent, isQuestion } from './whatsapp.js';
import { forgetGuestName } from './guest-name.js';

/* ── §1 pure ──────────────────────────────────────────────────────────────── */

export const FOOD_OPTIONS = ['רגיל', 'צמחוני', 'טבעוני', 'ללא גלוטן', 'אחר'];
export const Q_ORDER = ['shuttle', 'food', 'custom'];
export const Q_LABEL = { shuttle: 'הסעה', food: 'העדפת אוכל', custom: 'שאלה נוספת' };

/* the legal calling window, minutes since midnight Israel time — the same numbers as shir.js callWindowState */
export const LEGAL = { start: 10 * 60, end: 20 * 60 + 30, fri_start: 9 * 60 + 30, fri_end: 13 * 60 };

/* text a client typed that goes to guests and into Shir's prompt: no braces, no markup, no links, one line */
export function cleanText(s, max = 120) {
  return String(s == null ? '' : s)
    .replace(/https?:\/\/\S+|www\.\S+|\S+\.(com|co\.il|io|net|org|il)\b\S*/gi, ' ')
    .replace(/[{}<>\[\]\\`|*_~#]/g, ' ')
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); if (!m) return NaN; const h = Number(m[1]), mm = Number(m[2]); return h < 24 && mm < 60 ? h * 60 + mm : NaN; };
const toHm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

/* A client's call window, clamped into the legal one. null = no narrowing (the default).
   fri:false = no calls on Friday for this event. Needs at least an hour on weekdays. */
export function normCallWindow(cw) {
  if (!cw || typeof cw !== 'object') return null;
  let s = toMin(cw.start), e = toMin(cw.end);
  if (!Number.isFinite(s)) s = LEGAL.start;
  if (!Number.isFinite(e)) e = LEGAL.end;
  s = Math.max(LEGAL.start, Math.min(s, LEGAL.end));
  e = Math.min(LEGAL.end, Math.max(e, LEGAL.start));
  if (e - s < 60) return { error: 'window-too-short' };
  const fri = cw.fri !== false;
  let fe = toMin(cw.fri_end); if (!Number.isFinite(fe)) fe = LEGAL.fri_end;
  fe = Math.min(LEGAL.fri_end, Math.max(fe, LEGAL.fri_start + 30));
  const out = { start: toHm(s), end: toHm(e), fri, fri_end: toHm(fe) };
  if (s === LEGAL.start && e === LEGAL.end && fri && fe === LEGAL.fri_end) return null;   /* the same as the default */
  return out;
}

function ilClock(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return { day: get('weekday'), mins: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/* Is it OK to call a guest of THIS event now? Always inside the legal window (read again here, so a bad record can
   never widen it), and inside the client's window when one is set. */
export function eventCallWindowOpen(cw, now = new Date()) {
  const { day, mins } = ilClock(now);
  if (day === 'Sat') return false;
  const w = cw && !cw.error ? normCallWindow(cw) : null;
  if (day === 'Fri') {
    if (w && !w.fri) return false;
    const fe = w ? toMin(w.fri_end) : LEGAL.fri_end;
    return mins >= LEGAL.fri_start && mins <= Math.min(fe, LEGAL.fri_end);
  }
  const s = w ? toMin(w.start) : LEGAL.start, e = w ? toMin(w.end) : LEGAL.end;
  return mins >= Math.max(s, LEGAL.start) && mins <= Math.min(e, LEGAL.end);
}

/* The parents as one speakable sentence, ≤ 140 characters (hostExtra's cap), never cut in the middle of a name:
   each part is capped at 55 characters before it is joined. */
export const PARENT_MAX = 55;
export function parentsText(p) {
  const x = p || {};
  const bride = cleanText(x.bride, PARENT_MAX), groom = cleanText(x.groom, PARENT_MAX), hosts = cleanText(x.hosts, PARENT_MAX * 2);
  if (bride || groom) {
    const a = bride ? 'הורי הכלה ' + bride : '', b = groom ? 'הורי החתן ' + groom : '';
    return a && b ? `${a}, ו${b}` : a || b;
  }
  return hosts;
}

export function normQuestions(q) {
  const x = q || {};
  const sh = x.shuttle || {}, fo = x.food || {}, cu = x.custom || {};
  const customQ = cleanText(cu.q, 140);   /* ≤ hostExtra's cap: it reaches Shir whole */
  return {
    shuttle: { on: !!sh.on, details: cleanText(sh.details, 120) },
    food: { on: !!fo.on },
    custom: { on: !!cu.on && !!customQ, q: customQ },
  };
}

/* the whole record, validated. prev = the stored record (fields not sent are kept). */
export function normalizeSettings(input, prev) {
  const p = prev || {}, b = input || {};
  const out = {
    parents: b.parents !== undefined ? {
      bride: cleanText((b.parents || {}).bride, PARENT_MAX),
      groom: cleanText((b.parents || {}).groom, PARENT_MAX),
      hosts: cleanText((b.parents || {}).hosts, PARENT_MAX * 2),
    } : (p.parents || { bride: '', groom: '', hosts: '' }),
    names: b.names !== undefined ? { last1: cleanText((b.names || {}).last1, 40), last2: cleanText((b.names || {}).last2, 40) } : (p.names || { last1: '', last2: '' }),
    questions: b.questions !== undefined ? normQuestions(b.questions) : normQuestions(p.questions),
    call_window: b.call_window !== undefined ? normCallWindow(b.call_window) : (p.call_window || null),
    gift_on_yes: b.gift_on_yes !== undefined ? b.gift_on_yes !== false : p.gift_on_yes !== false,
    guest_name: b.guest_name !== undefined ? b.guest_name !== false : p.guest_name !== false,
  };
  if (out.call_window && out.call_window.error) return { error: out.call_window.error };
  return out;
}

/* the questions that are on, in the order they are asked */
export function enabledSteps(s) {
  const q = normQuestions(s && s.questions);
  return Q_ORDER.filter(k => q[k].on);
}

/* the WhatsApp message for one step: reply buttons (≤3, titles ≤20) or a list (≤10 rows, titles ≤24) */
export function questionMessage(step, s) {
  const q = normQuestions(s && s.questions);
  if (step === 'shuttle') {
    const d = q.shuttle.details;
    return { kind: 'buttons', text: d ? `🚌 יש הסעה לאירוע: ${d}\nתרצו להצטרף?` : '🚌 תהיה הסעה לאירוע. תרצו להצטרף?',
      buttons: [{ id: 'fq:shuttle:yes', title: 'כן, נצטרף' }, { id: 'fq:shuttle:no', title: 'לא צריך' }] };
  }
  if (step === 'food') {
    return { kind: 'list', text: '🍽 יש לכם העדפה באוכל?', button: 'בחירה',
      rows: FOOD_OPTIONS.map((t, i) => ({ id: 'fq:food:' + i, title: t })) };
  }
  if (step === 'custom') {
    return { kind: 'buttons', text: q.custom.q + '\n(אפשר לענות כאן בהודעה)', buttons: [{ id: 'fq:custom:skip', title: 'דילוג' }] };
  }
  return null;
}

/* Is this reply an answer to the open step? → { answer } (answer '' = skipped) or null (not an answer: let the normal
   flow handle it). rsvpish = the text reads as a change of RSVP or a question, so a free-text step must not swallow it. */
export function parseFollowupAnswer(step, text, interactiveId, opts = {}) {
  const id = String(interactiveId || '');
  const t = String(text || '').replace(/[‎‏]/g, '').trim();
  if (step === 'shuttle') {
    if (id === 'fq:shuttle:yes') return { answer: 'כן' };
    if (id === 'fq:shuttle:no') return { answer: 'לא' };
    const c = t.replace(/[!.,🚌🙏🙂]/gu, '').trim();
    if (/^(כן|כן כן|בטח|ברור|מעוניין|מעוניינת|מעוניינים|כן תודה|כן בבקשה|כן נצטרף|נצטרף|yes)$/i.test(c)) return { answer: 'כן' };
    if (/^(לא|לא תודה|לא צריך|לא צריכים|לא מעוניין|לא מעוניינת|לא מעוניינים|no)$/i.test(c)) return { answer: 'לא' };
    return null;
  }
  if (step === 'food') {
    const m = /^fq:food:(\d)$/.exec(id);
    if (m && FOOD_OPTIONS[Number(m[1])]) return { answer: FOOD_OPTIONS[Number(m[1])] };
    const c = t.replace(/[!.,🙏🙂]/gu, '').trim();
    if (/^(רגיל|רגילה|הכל|אין|אין העדפה|בלי העדפה|לא|לא תודה)$/.test(c)) return { answer: 'רגיל' };
    if (/^צמחוני(ת|ים|ות)?$/.test(c)) return { answer: 'צמחוני' };
    if (/^טבעוני(ת|ים|ות)?$/.test(c)) return { answer: 'טבעוני' };
    if (/^(ללא|בלי) ?גלוטן$/.test(c)) return { answer: 'ללא גלוטן' };
    if (/^אחר$/.test(c)) return { answer: 'אחר' };
    return null;
  }
  if (step === 'custom') {
    if (id === 'fq:custom:skip') return { answer: '' };
    if (!t || opts.rsvpish || id) return null;
    return { answer: cleanText(t, 300) };
  }
  return null;
}

/* Free text that must NOT be taken as the answer to the client's own (free-text) question: a template button, a
   question, words about arriving, or a cancellation ("לא נוכל", "לצערנו מוותרים", "אי אפשר"). A cancellation goes to
   the RSVP flow: a missed one costs the hosts a plate, a missed custom answer costs little. A bare "לא" / "לא תודה" is
   an answer ("תצטרכו חניה?" "לא"). Undecided words ("אולי") and numbers stay answers: they are normal answers to a
   question the hosts wrote ("כמה רכבים?" "2"), and "אולי" must not turn a confirmed guest into מתלבט. */
export function rsvpishText(text, isButton = false) {
  if (isButton) return true;
  const t = String(text || '').replace(/[\u200e\u200f]/g, '').trim();
  if (!t) return false;
  if (isQuestion(t)) return true;
  if (/(מגיע|נגיע|להגיע|לבוא|נבוא|אגיע|אבוא)/.test(t)) return true;
  if (guestIntent(t) === 'no' && !/^(לא|לא תודה|לא צריך|לא צריכים|אין)[.!]*$/.test(t)) return true;
  return false;
}

/* what Shir gets: always-present strings, empty when the question is off (braces must never be read out loud) */
export function shirFollowupVars(s) {
  const q = normQuestions(s && s.questions);
  const v = {
    ask_shuttle: q.shuttle.on ? 'כן' : '',
    shuttle_details: q.shuttle.on ? q.shuttle.details : '',
    ask_food: q.food.on ? 'כן' : '',
    food_options: q.food.on ? FOOD_OPTIONS.join(', ') : '',
    custom_question: q.custom.on ? q.custom.q : '',
  };
  const lines = [];
  if (v.ask_shuttle) lines.push('הסעה: ' + (v.shuttle_details ? `יש הסעה (${v.shuttle_details}). לשאול אם מצטרפים.` : 'לשאול אם מצטרפים להסעה.'));
  if (v.ask_food) lines.push('אוכל: לשאול אם יש העדפה (' + v.food_options + ').');
  if (v.custom_question) lines.push('שאלה של בעלי השמחה: ' + v.custom_question);
  v.followup_questions = lines.join(' | ');
  return v;
}

/* 26/11 Shalev (Shoham's event): an event with no new settings but the older shuttle question (extraq:<token>, a bus)
   gets the same question from Shir on the phone; WhatsApp keeps the exact wording the client approved. */
/* 26/11 (guest-name): a record that has no question on (e.g. saved only for the guest-name switch) does not hide the
   older question, the same as WhatsApp (startFollowups → false → the old extraq question is asked there too). */
export function legacyShuttleSettings(settings, extraq) {
  if (settings && enabledSteps(settings).length) return settings;
  const q = extraq && typeof extraq === 'object' ? extraq : null;
  if (!q || q.id !== 'bus') return settings;
  const details = String(q.label || '').replace(/^הסעה\s*/, '').trim().slice(0, 120);
  return { questions: { shuttle: { on: true, details } } };
}

/* Answers to the follow-up questions from a Retell webhook, read tolerantly: the mid-call tool's optional args
   (shuttle, food, custom_answer) or the post-call analysis fields (shuttle_answer, food_answer, custom_answer).
   null when the call carried none (which is every call until the Retell agent is updated). */
export function followupsFromRetell(body) {
  if (!body) return null;
  let src = null, meta = {};
  if (body.name === 'record_rsvp_outcome') { src = body.args || {}; meta = (body.call && body.call.metadata) || {}; }
  else if (body.event === 'call_analyzed' && body.call) { src = ((body.call.call_analysis || {}).custom_analysis_data) || {}; meta = body.call.metadata || {}; }
  if (!src || !meta.guest_id || !meta.token) return null;
  /* only a guest who said yes on this call was asked the questions */
  if (String(src.outcome || '').trim() !== 'מגיע') return null;
  /* unknown values are dropped, never guessed: an analysis field comes back as "לא צוין" more often than not */
  const yn = v => { const s = String(v == null ? '' : v).trim(); if (/^(כן|yes|true)$/i.test(s)) return 'כן'; if (/^(לא|no|false)$/i.test(s)) return 'לא'; return ''; };
  const food = v => { const s = String(v == null ? '' : v).trim(); return FOOD_OPTIONS.includes(s) ? s : ''; };
  const out = {};
  const sh = yn(src.shuttle != null ? src.shuttle : src.shuttle_answer); if (sh) out.shuttle = sh;
  const fo = food(src.food != null ? src.food : src.food_answer); if (fo) out.food = fo;
  const cu = cleanText(src.custom_answer, 300); if (cu && !/^(לא ברור|לא נשאל|לא נשאלה|לא צוין|לא צויין|לא ידוע|לא רלוונטי|אין|אין תשובה|ללא|none|null|n\/a|na|unknown|not specified|not asked|-)$/i.test(cu)) out.custom = cu;
  if (!Object.keys(out).length) return null;
  return { token: String(meta.token), guest_id: String(meta.guest_id), answers: out };
}

/* The webhook side: only answers to questions the event has ON are kept. → the stored record, or null. */
export async function saveRetellFollowups(env, body) {
  const fu = followupsFromRetell(body);
  if (!fu || !env || !env.RATE) return null;
  const on = new Set(enabledSteps(await getSettings(env, fu.token)));
  const a = {}; for (const k of Object.keys(fu.answers)) if (on.has(k)) a[k] = fu.answers[k];
  if (!Object.keys(a).length) return null;
  return putAnswer(env, fu.token, fu.guest_id, a, 'call');
}

/* the short form kept in the KV key's metadata (≤1024 bytes) */
export function answerMeta(a) {
  const x = a || {};
  return { s: String(x.shuttle || ''), f: String(x.food || ''), c: String(x.custom || '').slice(0, 150), v: String(x.via || '') };
}

export const GIFT_YES_LINE = 'לנוחיותכם אפשר להעניק מתנה ישירות כאן: ';
export function yesGiftLine(token) { return '\n\n' + GIFT_YES_LINE + giftPageUrl(token); }

/* the WhatsApp answer to "מי זה?", with the parents when the event set them */
export function whoIsText(eventName, intro) {
  const extra = String(intro || '').trim();
  return `זו הזמנה ל${eventName}${extra ? ` (${extra})` : ''}, נשלחה דרך אישורי הגעה (ishur.io). אפשר לענות כאן מגיע / לא מגיע 🙂`;
}

/* ── §2 KV ────────────────────────────────────────────────────────────────── */

export async function getSettings(env, token) {
  if (!env || !env.RATE || !token) return null;
  try { return JSON.parse((await env.RATE.get('evsettings:' + token)) || 'null'); } catch { return null; }
}

/* the parents go where Shir and the "מי זה?" reply already read them: callintro:<token>. A text the team wrote by hand
   is replaced only when the client actually fills the parents; clearing them removes only what this screen wrote. */
async function syncCallIntro(env, token, parents) {
  const text = parentsText(parents);
  const k = 'callintro:' + token;
  const curRaw = await env.RATE.get(k).catch(() => null);
  let cur = null; if (curRaw && String(curRaw).trim()[0] === '{') { try { cur = JSON.parse(curRaw); } catch {} }
  if (text) {
    const rec = { text, src: 'settings' };
    if (cur && /^\d{4}-\d{2}-\d{2}$/.test(String(cur.from || ''))) rec.from = cur.from;
    await env.RATE.put(k, JSON.stringify(rec));
    return text;
  }
  if (cur && cur.src === 'settings') await env.RATE.delete(k).catch(() => {});
  return '';
}

export async function saveSettings(env, token, input) {
  const prev = await getSettings(env, token);
  const s = normalizeSettings(input, prev);
  if (s.error) return s;
  s.at = new Date().toISOString();
  await env.RATE.put('evsettings:' + token, JSON.stringify(s));
  if (input && input.guest_name !== undefined) forgetGuestName(env);
  if (input && input.parents !== undefined) await syncCallIntro(env, token, s.parents);
  return s;
}

export async function putAnswer(env, token, guestId, patch, via, name = '') {
  if (!env.RATE || !token || !guestId) return null;
  const k = `fqa:${token}:${guestId}`;
  let cur = {}; try { cur = JSON.parse((await env.RATE.get(k)) || '{}') || {}; } catch {}
  const next = { ...cur, ...patch, via: via || cur.via || '', name: name || cur.name || '', at: new Date().toISOString() };
  await env.RATE.put(k, JSON.stringify(next), { metadata: answerMeta(next), expirationTtl: 400 * 86400 });
  return next;
}

/* every answer of the event: { guest_id: {shuttle, food, custom, via} }, one list call per 1000 (cursor followed) */
export async function listAnswers(env, token) {
  const out = {};
  if (!env.RATE || !token) return out;
  let cursor;
  for (let i = 0; i < 20; i++) {
    const l = await env.RATE.list({ prefix: `fqa:${token}:`, cursor });
    for (const k of l.keys || []) {
      const m = k.metadata || {};
      out[k.name.slice(`fqa:${token}:`.length)] = { shuttle: m.s || '', food: m.f || '', custom: m.c || '', via: m.v || '' };
    }
    if (l.list_complete || !l.cursor) break;
    cursor = l.cursor;
  }
  return out;
}

/* ── §3 WhatsApp flow ───────────────────────────────────────────────────────
   deps: { sendReplyButtons, sendList, sendText, logEvent, normPhone }. awaitfq:<guest_id> = {step, token, phone, ch, at}. */

async function askStep(env, guest, from, sendCh, step, s, deps) {
  const m = questionMessage(step, s);
  if (!m) return null;
  await env.RATE.put('awaitfq:' + guest.guest_id, JSON.stringify({ step, token: guest.token, phone: deps.normPhone(from), ch: sendCh, at: Date.now() }), { expirationTtl: 86400 });
  const ctx = { who: 'שיר (מענה אוטומטי)' };
  return m.kind === 'list'
    ? deps.sendList(env, from, m.text, m.button, m.rows, sendCh, ctx)
    : deps.sendReplyButtons(env, from, m.text, m.buttons, sendCh, ctx);
}

/* After a "מגיע" (count recorded): the event's questions, the first one now. true = this event uses the new
   questions (asked, or already answered); false = none set, the caller may run the old single question (extraq). */
export async function startFollowups(env, guest, from, sendCh, deps) {
  try {
    if (!env.RATE || !guest || !guest.guest_id) return false;
    const s = await getSettings(env, guest.token);
    const steps = enabledSteps(s);
    if (!steps.length) return false;
    if (await env.RATE.get('awaitfq:' + guest.guest_id)) return true;   /* a question is open: never ask twice */
    let done = {}; try { done = JSON.parse((await env.RATE.get(`fqa:${guest.token}:${guest.guest_id}`)) || '{}') || {}; } catch {}
    const next = steps.find(k => done[k] === undefined);
    if (!next) return true;
    await askStep(env, guest, from, sendCh, next, s, deps);
    return true;
  } catch { return false; }
}

/* An inbound message while a question is open. → true when it was the answer (nothing else should handle it). */
export async function handleFollowupReply(env, guest, from, msg, sendCh, deps, opts = {}) {
  if (!env.RATE || !guest || !guest.guest_id) return false;
  const i = (msg && msg.interactive) || {};
  const iid = String((i.button_reply && i.button_reply.id) || (i.list_reply && i.list_reply.id) || '');
  let wait = null; try { wait = JSON.parse((await env.RATE.get('awaitfq:' + guest.guest_id)) || 'null'); } catch {}
  let step = wait && wait.step;
  const fromId = /^fq:(shuttle|food|custom):/.exec(iid);
  if (fromId) step = fromId[1];   /* a tap on an older question's button still counts for that question */
  if (!step) return false;
  const rawText = String((msg && msg.text && msg.text.body) || (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || (msg && msg.button && (msg.button.text || msg.button.payload)) || '');
  const got = parseFollowupAnswer(step, rawText, iid, { rsvpish: !!opts.rsvpish });
  if (!got) return false;
  await putAnswer(env, guest.token, guest.guest_id, { [step]: got.answer }, 'whatsapp', guest.name || '');
  await env.RATE.delete('awaitfq:' + guest.guest_id).catch(() => {});
  if (deps.logEvent) await deps.logEvent(env, { area: 'ווצאפ', action: `שאלת המשך (${Q_LABEL[step]}): ${got.answer || 'דילוג'}`, ok: true, phone: from, token: guest.token }).catch(() => {});
  const s = await getSettings(env, guest.token);
  const steps = enabledSteps(s);
  let done = {}; try { done = JSON.parse((await env.RATE.get(`fqa:${guest.token}:${guest.guest_id}`)) || '{}') || {}; } catch {}
  const next = steps.find(k => done[k] === undefined);
  if (next) await askStep(env, guest, from, sendCh, next, s, deps);
  else await deps.sendText(env, from, 'תודה, רשמנו 🙏', sendCh, { who: 'שיר (מענה אוטומטי)' });
  return true;
}

/* The gift line for a guest who confirmed: '' when the event has no active links, turned it off, or the guest already
   got a gift message (the same once-per-guest mark as the decline reply). mark() after the message really left. */
export async function yesGift(env, token, phone, gl) {
  const none = { text: '', mark: async () => {} };
  try {
    if (!env.RATE || !token || !giftActive(gl)) return none;
    const s = await getSettings(env, token);
    if (s && s.gift_on_yes === false) return none;
    const k = giftKey(token, phone);
    if (await env.RATE.get(k)) return none;
    return { text: yesGiftLine(token), mark: async () => { await env.RATE.put(k, JSON.stringify({ at: new Date().toISOString(), via: 'yes' }), { expirationTtl: 120 * 86400 }).catch(() => {}); } };
  } catch { return none; }
}

/* the "מי זה?" extra: callintro (written by this screen or by the team), as the dialer reads it */
export async function introNow(env, token, day) {
  if (!env.RATE || !token) return '';
  return introFor(await env.RATE.get('callintro:' + token).catch(() => null), day);
}

/* Per-event call window for the dialer, cached per token for one dispatch tick. */
export function callWindowGate(env, now = new Date()) {
  const cache = new Map();
  return async token => {
    if (!cache.has(token)) {
      const s = await getSettings(env, token).catch(() => null);
      cache.set(token, eventCallWindowOpen(s && s.call_window, now));
    }
    return cache.get(token);
  };
}

/* ── §4 route ─────────────────────────────────────────────────────────────
   POST /api/event-settings
     {token}                  → { ok, settings, intro, legal, food_options }
     {token, settings:{…}}    → saves; same answer. 422 {error:'window-too-short'} on a bad window.
   deps: { okJson, deny, tokenRecord, overBudget, logEvent } */
export async function handleEventSettings(request, env, origin, deps) {
  let b = {};
  try { b = await request.json(); } catch { return deps.deny(400, 'bad-json', origin); }
  const tok = String(b.token || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(tok) || !(await deps.tokenRecord(env, tok))) return deps.deny(404, 'unknown-token', origin);
  if (await deps.overBudget(env, 'rl:evset:' + tok, 60, 3600)) return deps.deny(429, 'slow-down', origin);
  let s = await getSettings(env, tok);
  if (b.settings && typeof b.settings === 'object') {
    const r = await saveSettings(env, tok, b.settings);
    if (r.error) return deps.deny(422, r.error, origin);
    s = r;
    await deps.logEvent(env, { area: 'לוח', action: 'הגדרות מתקדמות עודכנו', ok: true, token: tok,
      detail: `הורים ${parentsText(s.parents) ? 'כן' : 'לא'} · שאלות ${enabledSteps(s).map(k => Q_LABEL[k]).join(', ') || 'אין'} · חלון שיחות ${s.call_window ? s.call_window.start + '–' + s.call_window.end : 'ברירת מחדל'} · שם האורח בהודעות ${s.guest_name === false ? 'לא' : 'כן'}` }).catch(() => {});
  }
  const settings = normalizeSettings({}, s || {});
  return deps.okJson({
    ok: true, settings,
    intro: await introNow(env, tok),
    legal: { start: toHm(LEGAL.start), end: toHm(LEGAL.end), fri_start: toHm(LEGAL.fri_start), fri_end: toHm(LEGAL.fri_end) },
    food_options: FOOD_OPTIONS,
  }, origin);
}
