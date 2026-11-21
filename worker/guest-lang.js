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
