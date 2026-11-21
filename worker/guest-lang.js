/* Guest buttons in the language the client chose (round 7 Part B, .sdlc/client-app/round7-partB-spec.md).
   Richard 22/11: "we just prep the buttons so they be in the same language as requested, but same text we got now
   for the buttons just translated". The message body is the client's own wording (written by the client in that
   language); only the three answer buttons and the footer line come from here.
   Per event: { mode: 'he' } (today) · { mode: 'alone', lang } (that language instead of Hebrew) ·
   { mode: 'pair', lang } (Hebrew + that language in the same message, Hebrew first).
   Meta limits: a quick-reply button is at most 25 characters, a footer at most 60.
   Guests' taps are read back to today's Hebrew words (toHebrewReply), so the rest of the engine is unchanged.
   Translations: Claude's, not yet read by native speakers. Yiddish and Amharic are not Meta template languages and
   were dropped for guest messages (Richard, 21/11). */

export const GUEST_LANGS = ['en', 'ru', 'ar', 'fr', 'es', 'pt'];
const META_CODE = { en: 'en', ru: 'ru', ar: 'ar', fr: 'fr', es: 'es', pt: 'pt_BR' };

const HE_BUTTONS = ['מגיע/ה', 'לא מגיע/ה', 'עדיין לא ידוע'];
const HE_FOOTER = 'נשלח ע"י ishur.io · הגיע בטעות? השיבו "טעות"';

/* alone: the full translation of today's buttons */
const ALONE = {
  en: ['Coming', 'Not coming', 'Not sure yet'],
  ru: ['Приду', 'Не приду', 'Пока не знаю'],
  ar: ['سأحضر', 'لن أحضر', 'لا أعرف بعد'],
  fr: ['Je viens', 'Je ne viens pas', 'Je ne sais pas encore'],
  es: ['Voy', 'No voy', 'Todavía no sé'],
  pt: ['Vou', 'Não vou', 'Ainda não sei']
};
/* pair: "Hebrew · translation" must fit 25 characters, so a few use a shorter wording */
const PAIR = {
  en: ['Coming', 'Not coming', 'Not sure'],
  ru: ['Приду', 'Не приду', 'Не знаю'],
  ar: ['سأحضر', 'لن أحضر', 'لا أعرف'],
  fr: ['Je viens', 'Absent(e)', 'Peut-être'],
  es: ['Voy', 'No voy', 'No sé'],
  pt: ['Vou', 'Não vou', 'Não sei']
};
/* the word a guest sends when the invitation reached the wrong number, as the footer tells them */
const MISTAKE = { en: 'mistake', ru: 'ошибка', ar: 'خطأ', fr: 'erreur', es: 'error', pt: 'erro' };
const FOOTER = {
  en: 'Sent by ishur.io · Wrong number? Reply "mistake"',
  ru: 'Отправлено ishur.io · Не тот номер? Ответьте "ошибка"',
  ar: 'أُرسلت عبر ishur.io · رقم خاطئ؟ أرسلوا "خطأ"',
  fr: 'Envoyé par ishur.io · Mauvais numéro ? Répondez "erreur"',
  es: 'Enviado por ishur.io · ¿Número equivocado? Respondan "error"',
  pt: 'Enviado por ishur.io · Número errado? Respondam "erro"'
};

const norm = c => {
  const ok = c && GUEST_LANGS.includes(c.lang) && (c.mode === 'alone' || c.mode === 'pair');
  return ok ? { mode: c.mode, lang: c.lang } : { mode: 'he' };
};

export function guestButtons(choice) {
  const c = norm(choice);
  if (c.mode === 'alone') return ALONE[c.lang].slice();
  if (c.mode === 'pair') return HE_BUTTONS.map((h, i) => h + ' · ' + PAIR[c.lang][i]);
  return HE_BUTTONS.slice();
}

export function guestFooter(choice) {
  const c = norm(choice);
  if (c.mode === 'alone') return FOOTER[c.lang];
  if (c.mode === 'pair') return 'ishur.io · בטעות? "טעות" · ' + ({ en: 'Wrong number?', ru: 'Не тот номер?', ar: 'رقم خاطئ؟', fr: 'Mauvais numéro ?', es: '¿Número equivocado?', pt: 'Número errado?' })[c.lang] + ' "' + MISTAKE[c.lang] + '"';
  return HE_FOOTER;
}

/* the language label the template is submitted with: alone = that language; Hebrew and pairs = he */
export function templateLang(choice) {
  const c = norm(choice);
  return c.mode === 'alone' ? META_CODE[c.lang] : 'he';
}

/* a whole reply that is one of our translated buttons (or a wrong-number word) becomes today's Hebrew word.
   Whole replies only: "Coming with 2 kids" stays as it is and goes to the free-text path. */
const BACK = new Map();
for (const lang of GUEST_LANGS) {
  HE_BUTTONS.forEach((h, i) => {
    BACK.set(ALONE[lang][i].toLowerCase(), h);
    BACK.set(PAIR[lang][i].toLowerCase(), h);
    BACK.set((h + ' · ' + PAIR[lang][i]).toLowerCase(), h);
  });
  BACK.set(MISTAKE[lang].toLowerCase(), 'טעות');
}
BACK.set('wrong number', 'טעות');

export function toHebrewReply(text) {
  const s = String(text == null ? '' : text);
  const k = s.replace(/[‎‏]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  return BACK.get(k) || s;
}

/* ══ 22/11 night · sending in the event's language (Richard: "Yes, all messages") ══════════════════════════════
   OFF unless the Worker variable GUEST_LANG is "on" (staging first; production only on Richard's "promote").
   The event's choice lives in KV guestlang:<token> = {mode, lang}; with no key the event is Hebrew only, as today.
   sendTemplate asks variantFor() before a guest send: a translated copy exists for the templates in TRANSLATED
   (built by scripts/translate-templates.mjs). If Meta does not know or has not approved that copy (MISSING), the
   Hebrew one goes out instead and the copy is not tried again for 6 hours, so no guest misses a message. */
export const TRANSLATED = new Set(["ishur_lifnei_combo_g","ishur_lifnei_combo_gb","ishur_lifnei_combo_gp","ishur_lifnei_combo_n","ishur_lifnei_combo_t","ishur_lifnei_combo_tg","ishur_lifnei_combo_tgb","ishur_lifnei_combo_tgp","ishur_lifnei_plain_g","ishur_lifnei_plain_gb","ishur_lifnei_plain_gp","ishur_lifnei_plain_t","ishur_lifnei_plain_tg","ishur_lifnei_plain_tgb","ishur_lifnei_plain_tgp","ishur_matana","ishur_shulchan_matana","ishur_toda_matana","ishur_toda_orach_u","ishur_yom_combo_g","ishur_yom_combo_gb","ishur_yom_combo_gp","ishur_yom_combo_n","ishur_yom_combo_t","ishur_yom_combo_tg","ishur_yom_combo_tgb","ishur_yom_combo_tgp","ishur_yom_haerua_matana","ishur_yom_plain_g","ishur_yom_plain_gb","ishur_yom_plain_gp","ishur_yom_plain_s","ishur_yom_plain_t","ishur_yom_plain_tg","ishur_yom_plain_tgb","ishur_yom_plain_tgp"]);
export const guestLangOn = env => String((env && env.GUEST_LANG) || '').toLowerCase() === 'on';
/* Meta: 132000 wrong number of variables, 132001 no such template in that language, 132012 variable format,
   132015 paused, 132016 disabled — all mean "this copy cannot be used", not "this guest cannot be reached" */
export const isMissingTemplate = err => /^(132000|132001|132012|132015|132016)\b/.test(String(err || ''));

export async function readGuestLang(env, token) {
  if (!env || !env.RATE || !token) return { mode: 'he' };
  try { return norm(JSON.parse((await env.RATE.get('guestlang:' + token)) || 'null')); } catch { return { mode: 'he' }; }
}

/* the copy to send instead of <name>, or null when Hebrew goes out as today */
export function variantFor(name, choice, params) {
  const c = norm(choice);
  if (c.mode === 'he' || !TRANSLATED.has(name)) return null;
  const pair = c.mode === 'pair';
  return { name: name + '_' + (pair ? 'he' : '') + c.lang, lang: templateLang(c), params: pair ? [...params, ...params] : params.slice() };
}

/* the hook sendTemplate calls; returns the send's result, or null to go on with the Hebrew template */
export async function trySendInGuestLang(env, { name, params, channel, ctx }, send) {
  if (channel !== 'guests' || !ctx || !ctx.token || ctx.langTried || !guestLangOn(env) || !TRANSLATED.has(name)) return null;
  const v = variantFor(name, await readGuestLang(env, ctx.token), params || []);
  if (!v) return null;
  try { if (env.RATE && await env.RATE.get('tmplmiss:' + v.name)) return null; } catch {}
  const r = await send(v);
  if (r && !r.ok && isMissingTemplate(r.error)) {
    try { if (env.RATE) await env.RATE.put('tmplmiss:' + v.name, String(r.error).slice(0, 120), { expirationTtl: 6 * 3600 }); } catch {}
    return null;
  }
  return r;
}

/* the board's choice: read it, and save it while the invitations have not gone out (KV wave:<token>:1) */
export async function guestLangApi(env, token, body) {
  const locked = !!(env.RATE && await env.RATE.get('wave:' + token + ':1'));
  const cur = await readGuestLang(env, token);
  if (body && body.mode) {
    if (locked) return { ok: false, status: 409, error: 'already-sent', choice: cur, locked };
    const c = norm(body);
    if (body.mode !== 'he' && c.mode === 'he') return { ok: false, status: 400, error: 'bad-choice', choice: cur, locked };
    if (c.mode === 'he') await env.RATE.delete('guestlang:' + token); else await env.RATE.put('guestlang:' + token, JSON.stringify(c));
    return { ok: true, choice: c, locked, langs: GUEST_LANGS };
  }
  return { ok: true, choice: cur, locked, langs: GUEST_LANGS };
}
