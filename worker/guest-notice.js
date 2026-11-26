/* ============================================================================
   ishur.io · guest-notice.js · the client's cancel / postpone notice to guests
   (26/11/2026, track-cancel — Richard loved the red stop button, extend it)
   ----------------------------------------------------------------------------
   After the client stops the event from the board (client-stop.js) with
   "האירוע בוטל" or "האירוע נדחה", the board may schedule ONE fixed-wording
   WhatsApp notice to every invited guest:

     preview → pick the day + hour → see the exact bubble → tick the terms →
     type "שלח" → scheduled.  Or: "לבטל בלי לשלוח לאורחים" (stop only).

   Where it lives: inside the clientstop:<token> record, field `notice` (one
   key per event, so the clients page reads no extra key per event), plus the
   index gnotice:index = [token…] so the pacer finds the due ones without a
   KV list (lists lag their own writes).

   Who may get one: the same gate as the engine's stage 5 — הכל כלול
   (planKeyOf → 'premium') or the paid add-on msgaddon:<token>:cancel|postpone.
   No new package flag. And only when somebody was invited at all.

   When: a future Israel-time slot, 09:00–18:30 Sun–Thu (the guests' window
   closes at 19:00), 09:00–12:30 on Friday (the window closes 13:00), never
   Saturday, never a no-contact day (חג), never after the original event day.

   Sending (runGuestNotices, from the pacer every 10 minutes): due + the
   window open + before 19:00 + both Meta templates APPROVED and their body
   equal to the wording the client saw → status 'sending' is written BEFORE
   the first message (from then on it is FINAL), then each invited guest
   once (marker gn:<token>:<kind>:<phone>) through sendTemplate on the guest
   numbers, inside the daily cap (guestCapacity) and the tick's pace. The rest
   goes on the next tick. Not approved yet → it waits ("ממתין לאישור הנוסח").
   The event day passed while waiting → 'expired', Slack, nothing late.

   FINAL: once the first guest got it (status sending / sent) nothing can be
   cancelled and the stop can not be lifted (sends never resume: the guests
   were told the event is off / moved). Before that the client or the team
   may cancel the scheduled notice; only the team lifts the stop (a lift
   with a scheduled notice must say cancel_notice:true).

   Routes (index.js hooks):
     POST /api/client-notice-preview {token, kind, new_date?}
     POST /api/client-notice         {token, kind, new_date?, day, hm, confirm:'שלח', terms:true}
     POST /api/client-notice-cancel  {token} (client) | {admin_key, token} (team)
   ========================================================================== */

/* ── the fixed wording (submitted to Meta by Richard from docs/NOTICE-TEMPLATES.md, never edited here alone:
      the sender compares Meta's approved body to these and waits on any difference) ── */
export const NOTICE_TEMPLATES = {
  cancel: {
    name: 'ishur_event_cancelled',
    nn: 'ishur_event_cancelled_nn',
    body: 'שלום {{1}},\nאנחנו מעדכנים בשם בעלי השמחה על ביטול האירוע.\nהאירוע: {{2}}\nהמועד שתוכנן: {{3}}\nאין צורך להגיע. תודה רבה על ההבנה.',
    body_nn: 'שלום,\nאנחנו מעדכנים בשם בעלי השמחה על ביטול האירוע.\nהאירוע: {{1}}\nהמועד שתוכנן: {{2}}\nאין צורך להגיע. תודה רבה על ההבנה.',
  },
  postpone: {
    name: 'ishur_event_postponed',
    nn: 'ishur_event_postponed_nn',
    body: 'שלום {{1}},\nאנחנו מעדכנים בשם בעלי השמחה על דחיית האירוע.\nהאירוע: {{2}}\nהמועד הקודם: {{3}}\nהמועד החדש: {{4}}\nנשמח לראותכם במועד החדש. תודה רבה על ההבנה.',
    body_nn: 'שלום,\nאנחנו מעדכנים בשם בעלי השמחה על דחיית האירוע.\nהאירוע: {{1}}\nהמועד הקודם: {{2}}\nהמועד החדש: {{3}}\nנשמח לראותכם במועד החדש. תודה רבה על ההבנה.',
  },
};
export const NOTICE_FOOTER = 'נשלח באמצעות ishur.io';
export const NOTICE_NAMES = Object.values(NOTICE_TEMPLATES).flatMap(t => [t.name, t.nn]);
export const KIND_HE = { cancel: 'ביטול', postpone: 'דחייה' };
export const CONFIRM_WORD = 'שלח';
export const INDEX_KEY = 'gnotice:index';
/* what the published terms (terms.html §2, §4) already say — shown before the client confirms; nothing new is promised here */
export const TERMS_URL = 'https://ishur.io/terms.html#payment';
export const TERMS_LINES = [
  'ביטול, דחייה או שינוי של האירוע אינם מזכים בהחזר (סעיף 2 בתקנון).',
  'אין החזר בגין הודעות שכבר יצאו או שיחות שבוצעו (סעיף 2).',
  'הודעה שכבר יצאה אינה ניתנת לביטול או לשינוי (סעיף 4).',
  'מועד השליחה הוא מועד מתוכנן; מגבלות וואטסאפ עשויות לפרוס את השליחה על פני זמן (סעיף 4).',
];
/* the guests' slot rules (the client picks inside them; the server checks them again) */
export const SLOT = { from: '09:00', last: '18:30', fri_last: '12:30', step: 30 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/* ── §1 pure ─────────────────────────────────────────────────────────────── */
export function heDay(iso) {
  const p = String(iso || '').slice(0, 10).split('-');
  return p.length === 3 && DAY_RE.test(String(iso).slice(0, 10)) ? `${p[2]}.${p[1]}.${p[0]}` : '';
}
const weekday = iso => new Date(String(iso) + 'T12:00:00Z').getUTCDay();   /* 0 Sun … 6 Sat */
export function addDays(iso, n) { const d = new Date(String(iso) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/* the package includes the notice: הכל כלול, or the paid add-on for exactly this kind */
export function noticeEligible({ plan, addonPaid } = {}) { return plan === 'premium' || !!addonPaid; }

/* kind for a client stop record: what the client told us */
export function kindsFor(stop) {
  if (!stop) return [];
  if (stop.mode === 'postpone' || stop.reason === 'postponed') return ['postpone'];
  if (stop.mode === 'cancel' || stop.reason === 'cancelled') return ['cancel'];
  return [];
}

/* the four variables, guest-facing: the event name only through guestEventName (no client name, ever) */
export function noticeVars({ kind, eventName, origDate, newDate }) {
  return { event: String(eventName || '').trim() || 'האירוע', orig: heDay(origDate), neu: kind === 'postpone' ? heDay(newDate) : '' };
}
export function noticeParams(kind, vars, guestName = '') {
  const name = String(guestName || '').replace(/\s+/g, ' ').trim();
  const base = kind === 'postpone' ? [vars.event, vars.orig, vars.neu] : [vars.event, vars.orig];
  const T = NOTICE_TEMPLATES[kind];
  return name ? { template: T.name, params: [name, ...base] } : { template: T.nn, params: base };
}
export function fillBody(body, params) { return String(body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => String(params[Number(n) - 1] ?? '')); }
/* the exact text a guest gets (guestName '' → the no-name twin) */
export function renderNotice(kind, vars, guestName = '') {
  const T = NOTICE_TEMPLATES[kind]; if (!T) return '';
  const p = noticeParams(kind, vars, guestName);
  return fillBody(p.template === T.name ? T.body : T.body_nn, p.params);
}
const norm = s => String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
export function bodyMatches(ours, meta) { return !!meta && norm(ours) === norm(meta); }

/* new event date for a postponement: a day after today, not Saturday */
export function newDateError(d, today) {
  if (!DAY_RE.test(String(d || ''))) return 'bad-new-date';
  if (d <= today) return 'new-date-not-future';
  if (weekday(d) === 6) return 'new-date-shabbat';
  return '';
}

/* the send slot. now = {day:'YYYY-MM-DD', hm:'HH:MM'} in Israel. → '' or the refusal code */
export function slotError(day, hm, { now, origDate = '', noContact = () => false } = {}) {
  if (!DAY_RE.test(String(day || ''))) return 'bad-day';
  const m = HM_RE.exec(String(hm || ''));
  if (!m) return 'bad-hour';
  if (Number(m[2]) % SLOT.step) return 'bad-hour';
  const wd = weekday(day);
  if (wd === 6) return 'shabbat';
  if (noContact(day)) return 'no-contact-day';
  if (hm < SLOT.from) return 'quiet-hours';
  if (hm > (wd === 5 ? SLOT.fri_last : SLOT.last)) return wd === 5 ? 'friday-hours' : 'quiet-hours';
  if (!now || `${day} ${hm}` <= `${now.day} ${now.hm}`) return 'not-future';
  if (DAY_RE.test(String(origDate || '')) && day > origDate) return 'after-event';
  return '';
}
/* the days the board offers (today … the event day, minus Saturdays and no-contact days), each with its hours */
export function slotOptions({ now, origDate = '', noContact = () => false, maxDays = 60 } = {}) {
  const out = [];
  const end = DAY_RE.test(String(origDate || '')) ? origDate : addDays(now.day, maxDays);
  for (let d = now.day, i = 0; d <= end && i < maxDays; d = addDays(d, 1), i++) {
    const hours = [];
    for (let t = 9 * 60; t <= 18 * 60 + 30; t += SLOT.step) {
      const hm = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      if (!slotError(d, hm, { now, origDate, noContact })) hours.push(hm);
    }
    if (hours.length) out.push({ day: d, day_he: heDay(d), hours });
  }
  return out;
}

/* 26/11: KV has no compare-and-swap and a read may be ~60 s stale, so a cancel / lift racing the sender's first
   message could overwrite 'sending'. Close both from LOCK_MIN minutes before the slot — unless the notice is
   held for Meta's approval / the wording, or Meta refused the first send (nothing can start before that clears;
   a residual race there is the accepted price of never locking a client out of cancelling). */
export const LOCK_MIN = 5;
export function ilNow(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
export function cancelLocked(n, now) {
  if (!n || n.status !== 'scheduled' || ['template', 'wording', 'refused'].includes(n.wait)) return false;
  const t = Date.parse(`${n.day}T${n.hm}:00Z`) - LOCK_MIN * 60000, c = Date.parse(`${now.day}T${now.hm}:00Z`);
  return !(c < t);
}

/* FINAL = at least one guest may have it: the record says sending/sent, or counted a send */
export function isFinal(n) { return !!n && (n.status === 'sending' || n.status === 'sent' || Number(n.sent_n) > 0); }
export function isPending(n) { return !!n && n.status === 'scheduled' && !isFinal(n); }

/* what the board and the clients page get (no internals) */
export function publicNotice(n, { approved } = {}) {
  if (!n) return null;
  const out = { kind: n.kind, kind_he: KIND_HE[n.kind] || '', status: n.status, day: n.day || '', hm: n.hm || '', day_he: heDay(n.day),
    orig_date: n.orig_date || '', new_date: n.new_date || '', sent_n: Number(n.sent_n) || 0, total: Number(n.total) || 0,
    started_at: n.started_at || '', sent_at: n.sent_at || '', final: isFinal(n), text: n.text || '', at: n.at || '' };
  const waitTemplate = approved === false || (approved == null && n.wait === 'template');
  out.waiting_template = isPending(n) && waitTemplate;
  out.label_he = noticeLabel(out);
  return out;
}
const stampHe = iso => { const t = Date.parse(String(iso || '')); if (!t) return ''; try { return new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t)); } catch { return ''; } };
export function noticeLabel(p) {
  const what = p.kind === 'postpone' ? 'הודעת הדחייה' : 'הודעת הביטול';
  if (p.status === 'sent') return `${what} נשלחה לאורחים ב-${stampHe(p.sent_at || p.started_at)} · לא ניתן לבטל`;
  if (p.final) return `${what} נשלחת לאורחים מ-${stampHe(p.started_at)} · לא ניתן לבטל`;
  if (p.status === 'scheduled') return `${what} לאורחים מתוזמנת ל-${p.day_he} בשעה ${p.hm}` + (p.waiting_template ? ' · ממתין לאישור הנוסח' : '');
  if (p.status === 'cancelled') return `${what} המתוזמנת בוטלה`;
  if (p.status === 'expired') return `${what} לא יצאה לפני מועד האירוע`;
  return '';
}

/* invited = got a wave (sheet stamp I/J/K, or a wsent: marker) or answered. Guest rows: [3]=name [4]=phone [15]=answer [28]=token */
export function invitedGuests(gRows, token, { normPhone = p => String(p || '').replace(/\D/g, ''), sentPhones = new Set() } = {}) {
  const out = []; const seen = new Set();
  for (const g of gRows || []) {
    if (!g || String(g[28] || '').trim() !== token) continue;
    const phone = normPhone(String(g[4] || '').trim());
    if (!phone || seen.has(phone)) continue;
    const stamped = [8, 9, 10].some(i => String(g[i] || '').trim());
    const answered = !!String(g[15] || '').trim();
    if (!stamped && !answered && !sentPhones.has(phone)) continue;
    seen.add(phone);
    out.push({ phone, name: String(g[3] || '').trim() });
  }
  return out;
}

/* ── §2 KV ───────────────────────────────────────────────────────────────── */
const TTL = 400 * 86400;
async function readStop(env, token) { try { return JSON.parse((await env.RATE.get('clientstop:' + token)) || 'null'); } catch { return null; } }
async function writeStop(env, token, rec) { await env.RATE.put('clientstop:' + token, JSON.stringify(rec), { expirationTtl: TTL }); }
export async function readIndex(env) { try { const a = JSON.parse((await env.RATE.get(INDEX_KEY)) || '[]'); return Array.isArray(a) ? a.filter(t => typeof t === 'string') : []; } catch { return []; } }
export async function indexAdd(env, token) { const a = await readIndex(env); if (!a.includes(token)) { a.push(token); await env.RATE.put(INDEX_KEY, JSON.stringify(a)); } }
export async function indexDrop(env, token) { const a = await readIndex(env); if (a.includes(token)) await env.RATE.put(INDEX_KEY, JSON.stringify(a.filter(t => t !== token))); }

/* the team's lift: refuse when final, refuse a pending notice unless the caller says to cancel it.
   → {ok:true, cancelled:bool} | {ok:false, error} */
export async function prepareLift(env, token, { cancelNotice = false, by = 'הצוות', now = ilNow() } = {}) {
  const rec = await readStop(env, token);
  const n = rec && rec.notice;
  if (!n) return { ok: true, cancelled: false };
  if (isFinal(n)) return { ok: false, error: 'notice-sent' };
  if (isPending(n)) {
    if (!cancelNotice) return { ok: false, error: 'notice-scheduled' };
    if (cancelLocked(n, now)) return { ok: false, error: 'notice-starting' };
    rec.notice = { ...n, status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: by };
    await writeStop(env, token, rec);
    await indexDrop(env, token).catch(() => {});
    return { ok: true, cancelled: true };
  }
  return { ok: true, cancelled: false };
}

/* ── §3 the event's facts, read once (deps.eventFacts) ─────────────────────
   eventFacts(env, token) → { ev, gRows, plan, addon:{cancel,postpone}, eventName, origDate, sentPhones:Set } | null */
async function offerFor(env, token, kind, d, newDate, stop) {
  const f = await d.eventFacts(env, token);
  if (!f) return { ok: false, error: 'event-not-found' };
  const today = d.now().day;
  if (!DAY_RE.test(String(f.origDate || ''))) return { ok: true, f, today, invited: [], eligible: false, noDate: true, nd: '', vars: noticeVars({ kind, eventName: f.eventName, origDate: '' }) };
  const invited = invitedGuests(f.gRows, token, { normPhone: d.normPhone, sentPhones: f.sentPhones });
  const eligible = noticeEligible({ plan: f.plan, addonPaid: !!(f.addon && f.addon[kind]) });
  const nd = kind === 'postpone' ? String(newDate || (stop && stop.new_date) || '').slice(0, 10) : '';
  const vars = noticeVars({ kind, eventName: f.eventName, origDate: f.origDate, newDate: nd });
  return { ok: true, f, today, invited, eligible, nd, vars };
}

/* ── §4 routes. d: { okJson, deny, tokenRecord, overBudget, isAdmin, logEvent, slackSend, eventFacts, now(), noContact,
                      normPhone, templateApproved? } ── */
async function body(request) { try { return await request.json(); } catch { return null; } }
const tokOk = t => /^[0-9a-f-]{36}$/.test(t);

export async function handleNoticePreview(request, env, origin, d) {
  const b = await body(request); if (!b) return d.deny(400, 'bad-json', origin);
  const token = String(b.token || '').trim();
  if (!tokOk(token) || !(await d.tokenRecord(env, token))) return d.deny(404, 'unknown-token', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  if (await d.overBudget(env, 'rl:gnprev:' + token, 60, 3600)) return d.deny(429, 'slow-down', origin);
  const kind = String(b.kind || '');
  if (!NOTICE_TEMPLATES[kind]) return d.deny(400, 'bad-kind', origin);
  const stop = await readStop(env, token);
  const o = await offerFor(env, token, kind, d, b.new_date, stop);
  if (!o.ok) return d.deny(404, o.error, origin);
  if (kind === 'postpone') { const e = newDateError(o.nd, o.today); if (e) return d.deny(422, e, origin); }
  const now = d.now();
  const approved = d.templateApproved ? (await Promise.all([NOTICE_TEMPLATES[kind].name, NOTICE_TEMPLATES[kind].nn].map(n => d.templateApproved(env, n).catch(() => false)))).every(Boolean) : null;
  const n = stop && stop.notice;
  if (o.noDate) return d.okJson({ ok: true, kind, eligible: false, why: 'no-event-date', invited_n: 0, slots: [], terms: { url: TERMS_URL, lines: TERMS_LINES }, confirm_word: CONFIRM_WORD, current: n ? publicNotice(n) : null }, origin);
  return d.okJson({ ok: true, kind, eligible: o.eligible, why: !o.eligible ? 'not-in-package' : !o.invited.length ? 'nobody-invited' : '',
    invited_n: o.invited.length, named_n: o.invited.filter(g => g.name).length,
    text: renderNotice(kind, o.vars, '‹שם האורח›'), text_nn: renderNotice(kind, o.vars, ''), footer: NOTICE_FOOTER,
    template: NOTICE_TEMPLATES[kind].name, approved,
    orig_date: o.f.origDate, new_date: o.nd, slots: slotOptions({ now, origDate: o.f.origDate >= now.day ? o.f.origDate : now.day, noContact: d.noContact }),
    terms: { url: TERMS_URL, lines: TERMS_LINES }, confirm_word: CONFIRM_WORD,
    current: n ? publicNotice(n) : null }, origin);
}

export async function handleNoticeSchedule(request, env, origin, d) {
  const b = await body(request); if (!b) return d.deny(400, 'bad-json', origin);
  const token = String(b.token || '').trim();
  if (!tokOk(token) || !(await d.tokenRecord(env, token))) return d.deny(404, 'unknown-token', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  if (await d.overBudget(env, 'rl:gnotice:' + token, 10, 3600)) return d.deny(429, 'slow-down', origin);
  const kind = String(b.kind || '');
  if (!NOTICE_TEMPLATES[kind]) return d.deny(400, 'bad-kind', origin);
  if (String(b.confirm || '').trim() !== CONFIRM_WORD) return d.deny(422, 'bad-confirm', origin);
  if (b.terms !== true) return d.deny(422, 'terms-not-accepted', origin);
  const stop = await readStop(env, token);
  if (!stop) return d.deny(409, 'not-stopped', origin);   /* the stop comes first (/api/client-stop) */
  if (!kindsFor(stop).includes(kind)) return d.deny(409, 'kind-mismatch', origin);
  if (stop.notice && isFinal(stop.notice)) return d.deny(409, 'notice-final', origin);
  if (stop.notice && isPending(stop.notice)) return d.deny(409, 'notice-scheduled', origin);
  const o = await offerFor(env, token, kind, d, b.new_date, stop);
  if (!o.ok) return d.deny(404, o.error, origin);
  if (o.noDate) return d.deny(409, 'no-event-date', origin);
  if (!o.eligible) return d.deny(409, 'not-in-package', origin);
  if (!o.invited.length) return d.deny(409, 'nobody-invited', origin);
  if (kind === 'postpone') { const e = newDateError(o.nd, o.today); if (e) return d.deny(422, e, origin); }
  const now = d.now();
  const day = String(b.day || '').slice(0, 10), hm = String(b.hm || '').slice(0, 5);
  const se = slotError(day, hm, { now, origDate: o.f.origDate, noContact: d.noContact });
  if (se) return d.deny(422, se, origin);
  const who = d.who ? await Promise.resolve(d.who(request, b)).catch(() => '') : '';
  const n = { kind, status: 'scheduled', day, hm, orig_date: o.f.origDate, new_date: o.nd, vars: o.vars,
    text: renderNotice(kind, o.vars, '‹שם האורח›'), total: o.invited.length, sent_n: 0, failed_n: 0,
    at: new Date().toISOString(), by: who || 'הלקוח', terms_at: new Date().toISOString(), confirm: CONFIRM_WORD };
  const rec = { ...stop, notice: n };
  if (kind === 'postpone' && o.nd) rec.new_date = o.nd;
  await writeStop(env, token, rec);
  await indexAdd(env, token);
  const name = String(o.vars.event || '').slice(0, 80);
  await d.logEvent(env, { area: 'אירוע', action: `הודעת ${KIND_HE[kind]} לאורחים תוזמנה מלוח הלקוח`, ok: true, review: true, token,
    detail: `${name} · ${heDay(day)} ${hm} · ${o.invited.length} מוזמנים · ע"י ${who || 'הלקוח'}` }).catch(() => {});
  await d.slackSend(env, `📣 *הודעת ${KIND_HE[kind]} לאורחים תוזמנה* · ${name} · ${token.slice(0, 8)}\n\n• מתי: ${heDay(day)} ${hm}\n• למי: ${o.invited.length} מוזמנים שקיבלו הזמנה\n• ע"י: ${who || 'הלקוח'}\n\nהנוסח קבוע (${NOTICE_TEMPLATES[kind].name}). עד שמטא מאשרת אותו ההודעה ממתינה.\n\n─── \n✅ *מה לעשות:* לבדוק שהתבניות אושרו. לביטול לפני היציאה: "ביטול ההודעה לאורחים" במסך הלקוחות.`, { urgent: true, oneoff: true }).catch(() => {});   /* oneoff: scheduled once */
  return d.okJson({ ok: true, notice: publicNotice(n) }, origin);
}

export async function handleNoticeCancel(request, env, origin, d) {
  const b = await body(request); if (!b) return d.deny(400, 'bad-json', origin);
  const token = String(b.token || '').trim();
  const team = typeof b.admin_key === 'string' && b.admin_key !== '';
  if (team) { if (!(await d.isAdmin(env, b.admin_key))) return d.deny(403, 'bad-admin-key', origin); if (!tokOk(token)) return d.deny(400, 'bad-token', origin); }
  else if (!tokOk(token) || !(await d.tokenRecord(env, token))) return d.deny(404, 'unknown-token', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  if (!team && await d.overBudget(env, 'rl:gncancel:' + token, 10, 3600)) return d.deny(429, 'slow-down', origin);
  const rec = await readStop(env, token);
  const n = rec && rec.notice;
  if (!n || !isPending(n)) {
    if (n && isFinal(n)) return d.deny(409, 'notice-final', origin);
    return d.okJson({ ok: true, already: true, notice: n ? publicNotice(n) : null }, origin);
  }
  if (cancelLocked(n, d.now())) return d.deny(409, 'notice-starting', origin);
  const who = team ? 'הצוות' : 'הלקוח';
  rec.notice = { ...n, status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: who };
  await writeStop(env, token, rec);
  await indexDrop(env, token).catch(() => {});
  await d.logEvent(env, { area: 'אירוע', action: `הודעת ${KIND_HE[n.kind]} המתוזמנת לאורחים בוטלה ע"י ${who}`, ok: true, token, detail: `${heDay(n.day)} ${n.hm}` }).catch(() => {});
  await d.slackSend(env, `↩️ *הודעת ${KIND_HE[n.kind]} לאורחים בוטלה לפני היציאה* · ${token.slice(0, 8)} · ע"י ${who}\n\nשום הודעה לא יצאה. השליחות עדיין עצורות.`, { oneoff: true }).catch(() => {});
  return d.okJson({ ok: true, notice: publicNotice(rec.notice) }, origin);
}

/* ── §5 the sender (pacer step) ─────────────────────────────────────────────
   d: { now(), sendWindowState(), noContact(day), templateApproved(env,name), templateBody?(env,name),
        guestCapacity(env), eventFacts(env,token), sendTemplate, noteGuestSend?, phoneBlocked, wrongNum, normPhone,
        addEvCost?, msgCost?, logEvent, slackSend, pace } */
export async function runGuestNotices(env, d) {
  if (!env.RATE) return { ok: false, why: 'no-kv' };
  const toks = await readIndex(env);
  if (!toks.length) return { ok: true, idle: true };
  const now = d.now(); const out = [];
  for (const token of toks) {
    const rec = await readStop(env, token);
    let n = rec && rec.notice;
    if (!n || !(n.status === 'scheduled' || n.status === 'sending')) { await indexDrop(env, token).catch(() => {}); continue; }
    if (n.status === 'scheduled' && `${n.day} ${n.hm}` > `${now.day} ${now.hm}`) { out.push({ token: token.slice(0, 8), waiting: 'time' }); continue; }
    /* the event day is over: never late */
    if (n.orig_date && now.day > n.orig_date) {
      rec.notice = { ...n, status: n.sent_n > 0 ? 'sent' : 'expired', ended_at: new Date().toISOString() };
      await writeStop(env, token, rec); await indexDrop(env, token).catch(() => {});
      await d.slackSend(env, `⚠️ *הודעת ${KIND_HE[n.kind]} לאורחים לא הושלמה לפני מועד האירוע* · ${token.slice(0, 8)}\n\nיצאו ${n.sent_n || 0} מתוך ${n.total || '?'}. שום דבר לא יישלח באיחור.\n\n─── \n✅ *מה לעשות:* לדבר עם הלקוח.`, { key: 'gnotice_exp:' + token.slice(0, 8), sev: 'P1' }).catch(() => {});
      out.push({ token: token.slice(0, 8), expired: true }); continue;
    }
    const win = d.sendWindowState();
    if (!win.open || now.hm >= '19:00' || d.noContact(now.day)) { out.push({ token: token.slice(0, 8), waiting: 'window' }); continue; }
    const T = NOTICE_TEMPLATES[n.kind];
    if (!T) continue;
    /* both twins approved, and the approved wording IS what the client saw */
    const ok = await Promise.all([T.name, T.nn].map(x => d.templateApproved(env, x).catch(() => false)));
    let mismatch = '';
    if (ok.every(Boolean) && d.templateBody) {
      const [b1, b2] = await Promise.all([T.name, T.nn].map(x => d.templateBody(env, x).catch(() => '')));
      if (!bodyMatches(T.body, b1)) mismatch = T.name; else if (!bodyMatches(T.body_nn, b2)) mismatch = T.nn;
    }
    if (!ok.every(Boolean) || mismatch) {
      if (n.wait !== (mismatch ? 'wording' : 'template')) {
        rec.notice = { ...n, wait: mismatch ? 'wording' : 'template' }; await writeStop(env, token, rec);
        await d.slackSend(env, mismatch
          ? `🛑 *הודעת ${KIND_HE[n.kind]} לאורחים ממתינה:* הנוסח המאושר במטא של ${mismatch} שונה ממה שהלקוח ראה ואישר. לא נשלח כלום. · ${token.slice(0, 8)}`
          : `⏳ *הודעת ${KIND_HE[n.kind]} לאורחים הגיע מועדה אבל התבניות עוד לא אושרו במטא* (${T.name} / ${T.nn}) · ${token.slice(0, 8)}\n\nהיא תצא מעצמה בפעימה הראשונה אחרי האישור, בחלון השליחה.`, { key: 'gnotice_wait:' + token.slice(0, 8), sev: 'P1' }).catch(() => {});
      }
      out.push({ token: token.slice(0, 8), waiting: mismatch ? 'wording' : 'template' }); continue;
    }
    const cap = await d.guestCapacity(env).catch(() => null);
    let left = Math.max(0, Math.min(Number(d.pace) || 30, cap && Number.isFinite(cap.remaining) ? cap.remaining : 0));
    if (!left) { out.push({ token: token.slice(0, 8), waiting: 'cap' }); continue; }
    const f = await d.eventFacts(env, token);
    if (!f) { out.push({ token: token.slice(0, 8), waiting: 'no-snapshot' }); continue; }
    const guests = invitedGuests(f.gRows, token, { normPhone: d.normPhone, sentPhones: f.sentPhones });
    /* FINAL from here: the record says 'sending' before the first message leaves */
    if (n.status === 'scheduled') {
      n = { ...n, status: 'sending', started_at: new Date().toISOString(), total: guests.length, wait: '' };
      rec.notice = n; await writeStop(env, token, rec);
      await d.logEvent(env, { area: 'שליחה', action: `הודעת ${KIND_HE[n.kind]} לאורחים התחילה לצאת`, ok: true, token, detail: `${guests.length} מוזמנים` }).catch(() => {});
    }
    let sent = 0, failed = 0, skipped = 0, cut = false, open = 0;
    for (const g of guests) {
      const mk = `gn:${token}:${n.kind}:${g.phone}`;
      if (await env.RATE.get(mk)) continue;
      if (left <= 0) { cut = true; break; }
      open++;   /* reached this guest: done below unless the send leaves no marker */
      if (await d.phoneBlocked(env, g.phone) || await d.wrongNum(env, token, g.phone)) { open--; skipped++; await env.RATE.put(mk, 'skip', { expirationTtl: 120 * 86400 }).catch(() => {}); continue; }
      const p = noticeParams(n.kind, n.vars, g.name);
      const wa = await d.sendTemplate(env, g.phone, p.template, p.params, '', 'he', 'guests', { token, wave: 'notice_' + n.kind });
      if (wa && wa.held) { cut = true; break; }
      left--;
      if (wa && wa.ok) {
        open--; sent++; await env.RATE.put(mk, '1', { expirationTtl: 120 * 86400 }).catch(() => {});
        /* no gk: an async delivery failure is logged by the status webhook, never reopened — the notice is one-shot */
        if (d.noteGuestSend) await d.noteGuestSend(env, wa, token, 'notice_' + n.kind, g.phone, '').catch(() => {});
        if (d.addEvCost && d.msgCost) await d.addEvCost(env, token, d.msgCost(p.template)).catch(() => {});
      } else {
        failed++;
        await d.logEvent(env, { area: 'שליחה', action: `הודעת ${KIND_HE[n.kind]} לאורח נכשלה`, ok: false, token, phone: g.phone, detail: String((wa && wa.error) || '') }).catch(() => {});
        /* a permanent refusal is about the template / the number, not this guest: stop the tick, a human looks (the waves do the same) */
        if (wa && wa.permanent) {
          cut = true;
          await d.slackSend(env, `🛑 *הודעת ${KIND_HE[n.kind]} לאורחים נעצרה:* מטא סירבה (${String((wa && wa.error) || '').slice(0, 80)}). ננסה שוב בפעימה הבאה · ${token.slice(0, 8)}`, { key: 'gnotice_perm:' + token.slice(0, 8), sev: 'P1' }).catch(() => {});
          break;
        }
        /* three failed tries for one guest → that guest is given up (counted as failed), the rest go on */
        const sk = `gnf:${token}:${n.kind}:${g.phone}`; const strikes = (Number(await env.RATE.get(sk).catch(() => 0)) || 0) + 1;
        await env.RATE.put(sk, String(strikes), { expirationTtl: 30 * 86400 }).catch(() => {});
        if (strikes >= 3) { open--; await env.RATE.put(mk, 'fail', { expirationTtl: 120 * 86400 }).catch(() => {}); }
      }
    }
    const read = await readStop(env, token);
    const fresh = read || rec;
    /* the record must never regress under a notice that reached guests: a cancel / lift that raced this tick is overruled */
    const raced = !read || !read.notice || read.notice.status === 'cancelled';
    const nn = { ...n, sent_n: (Number(n.sent_n) || 0) + sent, failed_n: (Number(n.failed_n) || 0) + failed, skipped_n: (Number(n.skipped_n) || 0) + skipped };
    const done = !cut && open <= 0;
    if (done) { nn.status = 'sent'; nn.sent_at = new Date().toISOString(); }
    /* FINAL means a guest really got it: a tick that reached nobody (held number, Meta refused the first one) goes back to waiting */
    if (!done && nn.sent_n === 0) { nn.status = 'scheduled'; nn.wait = 'refused'; delete nn.started_at; }
    fresh.notice = nn; await writeStop(env, token, fresh);
    if (raced && nn.sent_n > 0) {
      if (!done) await indexAdd(env, token).catch(() => {});
      /* the guests were told: the event stays stopped */
      for (const k of ['hold:', 'callstop:', 'sendsoff:']) if (!(await env.RATE.get(k + token).catch(() => null))) await env.RATE.put(k + token, new Date().toISOString(), { expirationTtl: TTL }).catch(() => {});
      await d.slackSend(env, `🚨 *הודעת ${KIND_HE[nn.kind]} לאורחים כבר התחילה לצאת כשמישהו ביטל אותה או שחרר את העצירה* · ${token.slice(0, 8)}\n\nיצאו ${nn.sent_n}. ההודעה ממשיכה לכולם והשליחות נשארות עצורות.\n\n─── \n✅ *מה לעשות:* לדבר עם הלקוח.`, { key: 'gnotice_race:' + token.slice(0, 8), sev: 'P1' }).catch(() => {});
    }
    if (done) {
      await indexDrop(env, token).catch(() => {});
      /* the engine's own stage 5 must never send its old ishur_bitul after this (it also skips under hold:, which the stop keeps) */
      if (nn.kind === 'cancel') await env.RATE.put('cancelmsg:' + token, now.day, { expirationTtl: 120 * 86400 }).catch(() => {});
      await d.logEvent(env, { area: 'שליחה', action: `הודעת ${KIND_HE[nn.kind]} נשלחה לכל המוזמנים`, ok: true, review: true, token, detail: `נשלחו ${nn.sent_n} · נכשלו ${nn.failed_n} · דולגו ${nn.skipped_n}` }).catch(() => {});
      await d.slackSend(env, `✅ *הודעת ${KIND_HE[nn.kind]} נשלחה לאורחים* · ${token.slice(0, 8)}\n\nנשלחו ${nn.sent_n} · נכשלו ${nn.failed_n} · דולגו (חסום / מספר שגוי) ${nn.skipped_n}. מעכשיו לא ניתן לחדש את השליחות לאירוע.`, { oneoff: true }).catch(() => {});
    }
    out.push({ token: token.slice(0, 8), kind: nn.kind, sent, failed, skipped, done, cut });
  }
  return { ok: true, events: out };
}
