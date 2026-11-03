/* ============================================================================
   ishur.io · salesflow.js · lead qualification on Noa (4499) · 03/11/2026
   ----------------------------------------------------------------------------
   Deterministic, NOT free AI (Noa AI stays off). Three questions, one design
   question, then a server-priced offer with a prefilled site link.
   Behind cfg `sales_flow` (cfg.js, default off). State in KV sf:<phone>
   (7-day TTL). Docs: docs/SALES-FLOW-2026-11-03.md

   Rules baked in here:
     · leads only: never for client:, a phone with an event, or a guest (the
       caller passes isClient; the tick re-checks through deps.isClient)
     · free text only, inside the 24h window; window closed → nothing, Slack
     · 10:00–21:00 IL (no Shabbat; 18–21 a 3–8 min delay): outside, the reply waits in state.pending and
       the 10-minute pacer sends it at the next opening (same due/drain shape
       as noaq:)
     · one nudge per question, 60–150 min after it went out; after the
       design-question nudge, ~2h more → the fallback offer (never premium)
     · "ריצארד" / "נציג" / "תתקשרו אליי" / a question we cannot read → stop,
       Slack "ליד מבקש אדם", reply once
   ========================================================================== */
import { priceQuote, recommendPlan, fallbackPlan, hostessesFor, tierFor, siteLink, pickBundle, bundleLive, BUNDLES, BUNDLE_CAP, PLAN_HE, PKG_PRICES, HOSTESS_PRICE, DESIGN_PRICE } from './paylink.js';
import { clientHoursOpen } from './brain.js';

export const SF_PREFIX = 'sf:';
export const SF_SEEN = 'sfseen:';
export const SF_TTL = 7 * 86400;
export const WINDOW_MS = 24 * 3600e3;
export const NUDGE_MIN = 60, NUDGE_MAX = 150;          /* minutes, randomized */
export const FALLBACK_AFTER_NUDGE_MIN = 120;
export const FOLLOW1_MIN_H = 20, FOLLOW1_MAX_H = 26, FOLLOW2_AFTER_H = 48;
/* our own CRM note (markQuoted) is not a human one */
export const OWN_NOTE_RE = /^הצעה מזרימת המכירה/;
const DNC_RE = /לא\s*לפנות|לא\s*להתקשר|אל\s*תפנו|סגר(?:ה|ו)?(?!\s*במקום)(?![א-ת])|שילם|שילמה|לא\s*רלוונטי|הסר/;

/* Before every automated message (Richard 03/11): a human note on Monday/CRM
   newer than the lead's last inbound pauses the flow; "לא לפנות"/"סגר" ends it.
   h = { notes, updates:[{at,text}], crm:[{at,text}] } (deps.humanNotes, cached 10 min) */
export function humanGate(st, h) {
  if (!h) return { verdict: 'ok' };
  const since = Math.max(Number(st.lastInAt) || 0, Number(st.humanAck) || 0);
  const items = [...(h.updates || []), ...(h.crm || [])].filter(x => x && x.text && !OWN_NOTE_RE.test(x.text));
  const newer = items.filter(x => Number(x.at) > since).map(x => x.text);
  const notesChanged = st.notesSnap !== undefined && String(h.notes || '') !== String(st.notesSnap);
  const fresh = [...newer, ...(notesChanged ? [String(h.notes || '')] : [])];
  if (fresh.some(t => DNC_RE.test(t))) return { verdict: 'stop', text: fresh.join(' | ') };
  if (fresh.length) return { verdict: 'pause', text: fresh.join(' | ') };
  return { verdict: 'ok' };
}
/* simple facts a human wrote ("2 דיילות", a date) → prefill, never over an explicit answer */
export function notesFacts(h, now = Date.now()) {
  const txt = [String((h && h.notes) || ''), ...(((h && h.updates) || []).concat((h && h.crm) || [])).filter(x => !OWN_NOTE_RE.test(x.text || '')).map(x => x.text || '')].join('\n');
  const out = {};
  const m = txt.match(/(\d)\s*דיילות/); if (m) out.hostess = true; else if (/דיילת\s*אחת|רוצ\S*\s*דיילת/.test(txt)) out.hostess = true;
  const d = parseDate(txt, now); if (d.date) out.date = d.date;
  const c = parseCity(txt); if (c) out.city = c;
  return out;
}
function applyFacts(st, f) {
  if (!f) return;
  st.answers = st.answers || { calls_rounds: 0, hostess: false, date: '', month: 0, city: '' };
  const ex = st.explicit || {};
  if (f.hostess && !ex.hostess) st.answers.hostess = true;
  if (f.date && !st.answers.date) st.answers.date = f.date;
  if (f.city && !st.answers.city) st.answers.city = f.city;
}

export function sfEnabled(env) {
  const v = env && env.__cfg && env.__cfg.sales_flow;
  if (v !== undefined) return v === 'on';
  return String((env && env.SALES_FLOW) || '') === 'on';
}

/* Richard 03/11: no WhatsApp follow-ups for now. Nudges, the fallback offer
   and the post-offer follow-ups all sit behind cfg sales_followups (default
   off); with it off the flow only ever answers an inbound message. */
export function sfFollowupsEnabled(env) {
  const v = env && env.__cfg && env.__cfg.sales_followups;
  if (v !== undefined) return v === 'on';
  return String((env && env.SALES_FOLLOWUPS) || '') === 'on';
}

/* ── messages (Richard's wording, plural address) ─────────────────────────── */
const OCC_SAY = { wedding: 'חתונה', hina: 'חינה', bar: 'בר מצווה', bat: 'בת מצווה', brit: 'ברית', bday: 'יום הולדת', chalaka: 'חלאקה', chala: 'הפרשת חלה', biz: 'אירוע העסקי' };
export const MSG = {
  q1: (occ, askGuests) => `היי 🙂 נשמח לעזור עם ה${OCC_SAY[occ] || 'אירוע'}! כמה שאלות קצרות כדי להתאים לכם בדיוק:\n` +
    '1. חוץ מהזמנות ותזכורות בוואטסאפ, הייתם רוצים שנציגה שלנו גם תתקשר למי שלא ענה?\n' +
    '2. הייתם רוצים דיילת בקבלת פנים וסידורי הושבה ביום האירוע?\n' +
    '3. מתי האירוע ואיפה?' + (askGuests ? '\n4. כמה מוזמנים בערך?' : ''),
  q2: 'תודה! ודבר אחרון: יש לכם הזמנה מוכנה, או שתרצו שנעצב לכם אחת?',
  nudge: 'רק מזכירים 🙂 ברגע שתענו נשלח הצעה מדויקת',
  human: 'ריצארד יחזור אליכם בהקדם 🙂',
  /* after the offer: one check-in ~20–26h later, one call offer 2 days after that */
  follow1: 'היי 🙂 רק בודקים אם ההצעה ברורה, ואם יש שאלה אני כאן',
  follow2: 'אם נוח יותר בטלפון, תגידו מתי ונתקשר',
  /* "כמה עולה?" before we know anything: one friendly line, then the questions */
  priceFirst: 'המחיר תלוי בחבילה שמתאימה לכם, אז נתאים לכם הצעה אחת מדויקת 🙂',
  backToQ1: 'ונשמח לתשובות לשאלות למעלה, כדי לשלוח לכם הצעה אחת מדויקת 🙂',
  /* Richard 03/11: when they want calls, a warm word on one round vs three */
  advisory: 'טיפ קטן לפני ההצעה: חבילת פרמיום (סבב שיחות אחד) מתאימה בדרך כלל לקהל צעיר שעונה בעיקר בוואטסאפ. אם יש הרבה מוזמנים מבוגרים, אנחנו ממליצים על הכל כלול (3 סבבי שיחות), כדי לוודא שכולם יודעים על האירוע. אתם מכירים את האורחים הכי טוב, ואפשר לשנות בקישור 🙂',
};
/* what the offer includes, specific and complete (Richard 03/11), per the
   chosen plan/bundle — counts follow config.js PLANS */
export const INCLUDED = ['הזמנה בוואטסאפ עם תמונה/וידאו ואישור בלחיצה', 'תזכורת למי שלא ענה', 'תזכורת יום-לפני עם ניווט בוויז', 'הודעה ביום האירוע עם מספר השולחן',
  'קישורי מתנה בביט ופייבוקס לאורחים', 'סידורי הושבה וניהול תקציב', 'לוח בקרה למעקב 24/7 בזמן אמת'];
export function includesList(q) {
  const lines = [...INCLUDED];
  if (q.plan === 'premium') lines.push('3 סבבי שיחות למי שלא ענה', 'הודעת תודה לאורחים יום אחרי האירוע', 'הודעת דחייה או ביטול, אם צריך');
  else if (q.plan === 'pro') lines.push('סבב שיחות למי שלא ענה', 'הודעת תודה לאורחים יום אחרי האירוע');
  if (q.hostesses) lines.push(q.hostesses === 1 ? 'דיילת קבלת פנים ביום האירוע (מגיעה שעה לפני)' : `${q.hostesses} דיילות קבלת פנים ביום האירוע (מגיעות שעה לפני)`);
  if (q.design) lines.push(q.bundle ? 'עיצוב ההזמנה במתנה' : 'עיצוב הזמנה');
  lines.push(`עד ${q.records} רשומות (מספר טלפון = רשומה)`);
  return 'מה כלול:\n' + lines.map(l => '• ' + l).join('\n');
}
function addonWords(q) {
  const out = [];
  if (q.hostesses) out.push(q.hostesses === 1 ? 'דיילת אחת' : `${q.hostesses} דיילות`);
  if (q.design) out.push('עיצוב הזמנה');
  return out;
}
export function offerText(q, link, { calls_rounds = 0, fallback = false } = {}) {
  const calls = q.bundle ? 3 : (calls_rounds || (q.plan === 'premium' ? 3 : q.plan === 'pro' ? 1 : 0));
  /* the one-vs-three-rounds tip only when the plan follows their calls answer */
  const pre = calls && !q.bundle ? MSG.advisory + '\n\n' : '';
  const inc = '\n' + includesList(q) + '\n';
  /* Richard 03/11 closing: the link, or a phone call with a person */
  const tail = `כדי לבצע את ההזמנה תוכלו לעשות את זה כאן בקישור, או בשיחה טלפונית מול נציג:\n${link}\nהפרטים שלכם כבר מולאו חלקית, כך שהורדנו מכם עוד משהו 🙂 ותכף נוריד מכם גם את אישורי ההגעה, כדי שתוכלו להתעסק במה שבאמת חשוב באירוע.`;
  if (q.bundle) {
    /* Richard 03/11 copy: "לפי מה שבחרתם, הכי משתלם לכם מבצע החורף: הכל כלול + 2 דיילות ב-₪1,990." */
    const deal = /^winter/.test(q.bundle) ? 'מבצע החורף' : 'המבצע';
    const what = `${PLAN_HE[q.plan]} + ${q.hostesses === 1 ? 'דיילת אחת' : q.hostesses + ' דיילות'}`;
    const head = `${fallback ? 'הכנו לכם הצעה לפי מה שסיפרתם 🙂 ' : 'לפי מה שבחרתם, '}הכי משתלם לכם ${deal}: ${what} ב-${nis(q.sum)}.` +
      (q.design ? '\nועיצוב ההזמנה במתנה 🎁' : '');
    return head + '\n' + inc + tail;
  }
  const head = `חבילת ${PLAN_HE[q.plan]} ל-${q.records} רשומות${calls ? ' (כולל שיחות למי שלא ענה)' : ''}` +
    addonWords(q).map(x => ' + ' + x).join('') + ` = ${nis(q.sum)}.`;
  return pre + (fallback ? `הכנו לכם הצעה לפי מה שסיפרתם 🙂 ${head}\n` : `לפי מה שבחרתם: ${head}\n`) + inc + tail;
}

/* ── parsing ─────────────────────────────────────────────────────────────── */
const words = t => String(t || '').replace(/[‎‏]/g, '').split(/[^֐-׿a-zA-Z0-9]+/).filter(Boolean);
const unPrefix = w => (w.length > 2 && /^[וש]/.test(w) ? w.slice(1) : w);
const YES = new Set(['כן', 'בטח', 'ברור', 'נשמח', 'רוצים', 'רוצה', 'אשמח', 'מעוניינים', 'מעוניין', 'מעוניינת', 'יאללה', 'בהחלט', 'כמובן', 'סבבה', 'חייבים', 'אחלה', 'בשמחה', 'yes', 'ok']);
const NO = new Set(['לא', 'בלי', 'אין', 'no', 'מוותרים', 'מיותר']);
/* true | false | null (no polarity in this text) */
export function polarity(text) {
  let yes = false, no = false;
  for (const w0 of words(text)) { const w = w0.toLowerCase(); if (NO.has(w) || NO.has(unPrefix(w))) no = true; else if (YES.has(w) || YES.has(unPrefix(w))) yes = true; }
  if (/לא\s*צריך|אין\s*צורך|לא\s*רלוונטי/.test(text)) no = true;
  return no ? false : yes ? true : null;
}

const OCC_RE = [['wedding', /חתונ/], ['hina', /חינה/], ['bat', /בת[\s-]*מצו/], ['bar', /בר[\s-]*מצו/], ['brit', /ברית|בריתה/], ['bday', /יום\s*הולדת|יומולדת/], ['chalaka', /חלאקה/], ['chala', /הפרשת\s*חלה/], ['biz', /אירוע\s*עסקי|כנס|חברה/]];
export function parseOccasion(text) {
  const t = String(text || '');
  for (const [k, re] of OCC_RE) if (re.test(t)) return k;
  return '';
}

const DATE_RE = /(?<!\d)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?(?!\d)/;
const MONTHS = [['ינואר', 1], ['פברואר', 2], ['מרץ', 3], ['מרס', 3], ['אפריל', 4], ['מאי', 5], ['יוני', 6], ['יולי', 7], ['אוגוסט', 8], ['ספטמבר', 9], ['אוקטובר', 10], ['נובמבר', 11], ['דצמבר', 12]];
const pad = n => String(n).padStart(2, '0');
function realDate(y, m, d) { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; }
/* → { date:'YYYY-MM-DD'|'', month: 1..12|0, year } ; a date without a year is the next one to come */
export function parseDate(text, now = Date.now()) {
  const t = String(text || '');
  const today = new Date(now).toISOString().slice(0, 10);
  const y0 = new Date(now).getUTCFullYear();
  const pick = (y, m, d) => {
    if (!realDate(y, m, d)) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  let m = DATE_RE.exec(t);
  if (m) {
    const d = +m[1], mo = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let iso = null;
      if (m[3]) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; iso = pick(y, mo, d); }
      else { iso = pick(y0, mo, d); if (iso && iso < today) iso = pick(y0 + 1, mo, d); }
      if (iso && iso >= today) return { date: iso, month: mo, year: +iso.slice(0, 4) };
    }
  }
  for (const [name, mo] of MONTHS) {
    const re = new RegExp(`(?:(\\d{1,2})\\s*(?:ב|ל)?\\s*)?(?:ב|ל)?${name}(?:\\s*(\\d{4}))?`);
    const mm = re.exec(t);
    if (!mm) continue;
    let y = mm[2] ? +mm[2] : y0;
    if (!mm[2] && `${y0}-${pad(mo)}-31` < today) y = y0 + 1;
    if (mm[1]) { let iso = pick(y, mo, +mm[1]); if (iso && iso < today && !mm[2]) iso = pick(y + 1, mo, +mm[1]); if (iso) return { date: iso, month: mo, year: +iso.slice(0, 4) }; }
    return { date: '', month: mo, year: y };
  }
  return { date: '', month: 0, year: 0 };
}

export const CITIES = ['תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'אשדוד', 'נתניה', 'באר שבע', 'בני ברק', 'חולון', 'רמת גן', 'אשקלון', 'רחובות', 'בת ים', 'בית שמש', 'כפר סבא', 'הרצליה', 'חדרה', 'מודיעין', 'נצרת', 'לוד', 'רמלה', 'רעננה', 'ראש העין', 'הוד השרון', 'גבעתיים', 'קריית גת', 'נהריה', 'עפולה', 'כרמיאל', 'אילת', 'טבריה', 'צפת', 'עכו', 'קריית שמונה', 'דימונה', 'ערד', 'יבנה', 'גדרה', 'נס ציונה', 'קריית אונו', 'אור יהודה', 'יהוד', 'שוהם', 'זכרון יעקב', 'קיסריה', 'רמת השרון', 'קריית ביאליק', 'קריית מוצקין', 'קריית אתא', 'קריית ים', 'נשר', 'טירת כרמל', 'אור עקיבא', 'פרדס חנה', 'כפר יונה', 'אריאל', 'מעלה אדומים', 'שדרות', 'נתיבות', 'אופקים', 'קריית מלאכי', 'גן יבנה', 'באר יעקב', 'יפו', 'ת"א', 'פ"ת', 'ראשל"צ', 'ב"ש'];
const CITY_ALIAS = { 'ת"א': 'תל אביב', 'פ"ת': 'פתח תקווה', 'ראשל"צ': 'ראשון לציון', 'ב"ש': 'באר שבע', 'פתח תקוה': 'פתח תקווה' };
export function parseCity(text) {
  const t = String(text || '').replace(/[״]/g, '"').replace(/[‎‏]/g, '').replace(/פתח תקוה/g, 'פתח תקווה').replace(/-/g, ' ');
  const sorted = [...CITIES].sort((a, b) => b.length - a.length);
  for (const c of sorted) if (t.includes(c)) return CITY_ALIAS[c] || c;
  return '';
}

/* guests: a 2–4 digit number that is not part of a date or a phone */
export function parseGuests(text) {
  const t = String(text || '').replace(new RegExp(DATE_RE.source, 'g'), ' ').replace(/\d{4}(?=\s*$)/, m => (+m >= 2025 && +m <= 2035 ? ' ' : m));
  const all = [...t.matchAll(/(?<![\d./])(\d{2,4})(?![\d./])/g)].map(m => +m[1]).filter(n => n >= 20 && n <= 3000 && !(n >= 2025 && n <= 2035));
  return all.length ? Math.max(...all) : 0;
}

/* first message of a new lead: an occasion and/or a number */
export function triggerMatch(text) {
  const occasion = parseOccasion(text), guests = parseGuests(text);
  return occasion || guests ? { occasion, guests } : null;
}

export function wantsHuman(text) {
  const t = String(text || '');
  return /ריצארד|ריצ'רד|ריצרד|richard/i.test(t) || /נציג(?![הת])/.test(t) || /בן\s*אדם|מישהו\s*אמיתי/.test(t) ||
    /להתקשר\s*אלי|תתקשר[וי]?\s*אלי|תחזר[וי]\s*אלי|להתקשר\s*אלינו|תתקשרו\s*אלינו|אפשר\s*(?:לדבר|שיחה\s*טלפונית)|(?:^|\s)להתקשר\s*$|^\s*(?:תתקשרו|תתקשר)\s*$/.test(t);
}
export function optOut(text) {
  return /(?:^|\s)(?:הסר|הסירו|תסירו|הסרה|stop)(?:\s|$|[.!])|לא\s*רלוונטי|לא\s*מעוניינ|תפסיקו|סגרנו\s*עם/i.test(String(text || ''));
}

/* "כמה עולה…?" → { kind: 'calls'|'nocalls'|'hostess'|'design'|'general' } | null */
export function priceQuestion(text) {
  const t = String(text || '');
  if (!/כמה\s*(?:זה\s*)?(?:עולה|עולים|יעלה|תעלה|יוצא|זה)|מה\s*(?:ה)?מחיר|מחירים|כמה\s*כסף|מה\s*העלות/.test(t)) return null;
  if (/דייל/.test(t)) return { kind: 'hostess' };
  if (/עיצוב|לעצב/.test(t)) return { kind: 'design' };
  if (/בלי\s*(?:ה)?שיח|ללא\s*(?:ה)?שיח/.test(t)) return { kind: 'nocalls' };
  if (/3\s*(?:סבבי|שיחות|סבבים)|שלוש/.test(t)) return { kind: 'calls3' };
  if (/שיח|להתקשר/.test(t)) return { kind: 'calls' };
  return { kind: 'general' };
}
const nis = n => '₪' + Number(n).toLocaleString('en-US');
/* the one number a specific price question gets; null for a general "כמה עולה" */
export function priceAnswer(kind, guests) {
  const tier = tierFor(guests);
  const row = tier ? PKG_PRICES[tier] : null, rec = tier ? `ל-${tier} רשומות` : 'החל מ-50 רשומות';
  const base = row || PKG_PRICES[50];
  if (kind === 'nocalls') return `בלי שיחות (חבילת בסיס) ${rec}: ${nis(base.basic)}.`;
  if (kind === 'calls') return `עם סבב שיחות למי שלא ענה (חבילת פרמיום) ${rec}: ${nis(base.pro)}.`;
  if (kind === 'calls3') return `עם 3 סבבי שיחות (חבילת הכל כלול) ${rec}: ${nis(base.premium)}.`;
  if (kind === 'design') return `עיצוב הזמנה: ${nis(DESIGN_PRICE)}.`;
  if (kind === 'hostess') {
    if (!tier) return `דיילת אחת: ${nis(HOSTESS_PRICE[1])} (מ-300 רשומות ומעלה 2 דיילות: ${nis(HOSTESS_PRICE[2])}).`;
    const n = hostessesFor(tier, true);
    return `${n === 1 ? 'דיילת אחת' : n + ' דיילות'} ${rec}: ${nis(HOSTESS_PRICE[n])}.`;
  }
  return null;
}

/* split an answer into its parts: numbered ("1. כן 2. לא 3. ...") or lines/commas */
function segments(text) {
  const t = String(text || '').trim();
  if (/(?:^|\s)[1-3]\s*[.)\-:]/.test(t)) {
    const parts = {}; const re = /(?:^|\s)([1-3])\s*[.)\-:]\s*([\s\S]*?)(?=(?:\s[1-3]\s*[.)\-:])|$)/g; let m;
    while ((m = re.exec(t))) parts[+m[1] - 1] = m[2].trim();
    return { numbered: true, list: [0, 1, 2].map(i => parts[i] || '') };
  }
  let list = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (list.length < 2) list = t.split(/[,،]/).map(s => s.trim()).filter(Boolean);
  return { numbered: false, list };
}
const CALLS_KW = /שיח|להתקשר|תתקשר|נציגה|טלפונ|סבב/;
const HOST_KW = /דייל/;
function roundsIn(s) {
  if (/(?:^|\s)3(?:\s|$)|שלוש|3\s*(?:שיחות|סבבים)/.test(s)) return 3;
  if (/(?:^|\s)(?:1|2)\s*(?:שיח|סבב)|שיחה\s*אחת|סבב\s*אחד|פעם\s*אחת|אחת|אחד/.test(s)) return 1;
  return 0;
}
/* step-1 answer → { calls_rounds, hostess, date, month, city, guests, signals } — unanswered = no */
export function parseAnswers(text, now = Date.now()) {
  const t = String(text || '');
  const { numbered, list } = segments(t);
  let calls = null, host = null;
  const topical = list.filter(s => CALLS_KW.test(s) || HOST_KW.test(s)).length > 0;
  list.forEach((s, i) => {
    let topic = CALLS_KW.test(s) && !HOST_KW.test(s) ? 'calls' : HOST_KW.test(s) && !CALLS_KW.test(s) ? 'host' : null;
    if (!topic && (numbered || (!topical && list.length >= 2))) topic = i === 0 ? 'calls' : i === 1 ? 'host' : null;
    if (!topic && list.length === 1 && !topical) return;
    const p = polarity(s);
    if (topic === 'calls') { const r = roundsIn(s); if (p === false) calls = 0; else if (p === true) calls = r || 1; else if (r && CALLS_KW.test(s)) calls = r; }
    if (topic === 'host' && p !== null) host = p;
  });
  /* one line that covers both ("כן לשניהם" / "לא לשניהם") */
  if (calls === null && host === null && /שניהם|לשתיהן|לשתיהם|הכל|הכול/.test(t)) { const p = polarity(t); if (p !== null) { calls = p ? 1 : 0; host = p; } }
  const d = parseDate(t, now), city = parseCity(t);
  const guests = parseGuests(t.replace(/(?:^|\s)[1-3]\s*[.)\-:]/g, ' ').replace(/\d+\s*(?:שיחות|סבבים|דיילות)/g, ' '));
  const signals = (calls !== null) + (host !== null) + !!(d.date || d.month) + !!city;
  return { calls_rounds: calls || 0, hostess: !!host, explicitHostess: host !== null, explicitCalls: calls !== null, date: d.date, month: d.month, city, guests, signals };
}
/* step-2 answer → { design: bool, known: bool } — "we have one" = no design */
export function parseDesign(text) {
  const t = String(text || '');
  if (/יש\s*(?:לנו|כבר)|מוכנה|כבר\s*יש|לא\s*צריך|לא\s*צריכים|עיצבנו|יש\s*הזמנה/.test(t) && !/אין\s*(?:לנו)?\s*הזמנה|לא\s*מוכנה/.test(t)) return { design: false, known: true };
  if (/תעצבו|שתעצבו|נעצב|לעצב|עיצוב|אין\s*(?:לנו)?\s*(?:הזמנה)?|לא\s*מוכנה|עדיין\s*לא|אין\s*עדיין/.test(t)) return { design: true, known: true };
  const p = polarity(t);
  return { design: false, known: p !== null };
}

/* ── hours ───────────────────────────────────────────────────────────────── */
/* Richard 03/11 lead-hours rule: automated lead replies only 10:00–21:00 IL (inside the
   general client hours, so Shabbat stays closed); 18:00–21:00 each reply waits a random
   3–8 minutes; after 20:00 it is queued to the next day 10:00. */
export const LEAD_OPEN_H = 10, LEAD_CLOSE_H = 21, LEAD_SLOW_H = 18, LEAD_DELAY_MIN = 3, LEAD_DELAY_MAX = 8;
const ilHour = ts => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ts)));
export function leadHoursOpen(ts) { const h = ilHour(ts); return clientHoursOpen(ts) && h >= LEAD_OPEN_H && h < LEAD_CLOSE_H; }
export function leadSlowHours(ts) { const h = ilHour(ts); return h >= LEAD_SLOW_H && h < LEAD_CLOSE_H; }
export function leadDelayMs(rand = Math.random) { return Math.round((LEAD_DELAY_MIN + rand() * (LEAD_DELAY_MAX - LEAD_DELAY_MIN)) * 60e3); }
/* the next moment inside the lead hours, from ts; ts itself if open */
export function nextOpen(ts) {
  if (leadHoursOpen(ts)) return ts;
  let t = Math.ceil(ts / 900e3) * 900e3;
  for (let i = 0; i < 4 * 24 * 3; i++, t += 900e3) if (leadHoursOpen(t)) return t;
  return ts;
}
export function nudgeDelayMs(rand = Math.random) { return Math.round((NUDGE_MIN + rand() * (NUDGE_MAX - NUDGE_MIN)) * 60e3); }

/* ── offer ───────────────────────────────────────────────────────────────── */
export function buildOffer(st, { fallback = false, now = Date.now() } = {}) {
  const a = st.answers || {};
  const records = tierFor(st.guests);
  if (!records) return { ok: false, why: st.guests ? 'over-900' : 'no-guests' };
  const hostesses = hostessesFor(records, !!a.hostess);
  const design = !!st.design;
  /* hostesses wanted → the live bundle is the offer (top plan, design free) */
  const bundle = hostesses ? pickBundle(records, hostesses, now) : '';
  /* while the bundles run, an offer never goes above ₪1,990: hostesses with no
     bundle for that size (900 records) is a quote for a person */
  if (hostesses && !bundle && anyBundleLive(now)) return { ok: false, why: 'no-bundle' };
  const plan = bundle ? BUNDLES[bundle].plan : fallback ? fallbackPlan(a) : recommendPlan(a);
  const pq = priceQuote({ plan, records, bundle, now, phone: st.phone, name: (st.name && st.name.length >= 2) ? st.name : 'לקוח ishur', occasion: st.occasion || '', event_date: a.date || '', addons: { hostesses, design } });
  if (!pq.ok) return { ok: false, why: pq.why };
  const q = pq.quote;
  if (anyBundleLive(now) && q.sum > BUNDLE_CAP) return { ok: false, why: 'over-cap' };
  const link = siteLink({ bundle, plan, records, hostesses, design, calls_rounds: bundle ? 0 : a.calls_rounds, occasion: st.occasion, event_date: a.date, city: a.city, name: st.name, phone: st.phone, src: 'noa' });
  return { ok: true, quote: q, link, text: offerText(q, link, { calls_rounds: a.calls_rounds, fallback }) };
}
const anyBundleLive = now => Object.values(BUNDLES).some(b => b.until && bundleLive(b, now));

/* ── KV ──────────────────────────────────────────────────────────────────── */
export async function getState(env, phone) { try { return JSON.parse((await env.RATE.get(SF_PREFIX + phone)) || 'null'); } catch { return null; } }
async function putState(env, st) { await env.RATE.put(SF_PREFIX + st.phone, JSON.stringify(st), { expirationTtl: SF_TTL }); }

/* send now if the hours are open, else park it for the pacer; window checked here */
async function deliver(env, st, text, kind, deps, now, { delayed = false } = {}) {
  if (deps.humanNotes) {
    let h = null; try { h = await deps.humanNotes(st.phone); } catch {}
    const g = humanGate(st, h);
    if (g.verdict !== 'ok') {
      st.pausedFrom = st.step; st.step = g.verdict === 'stop' ? 'stopped' : 'paused'; st.why = 'human-note'; st.pending = null;
      await deps.slack(`✋ ליד ${st.name || ''} ${local(st.phone)}: יש עדכון ידני במונדי/CRM, הזרימה ${g.verdict === 'stop' ? 'הסתיימה' : 'נעצרה'} · ${String(g.text).slice(0, 200)}${g.verdict === 'pause' ? ' · להמשך: כפתור "המשך זרימה" בכרטיס הליד' : ''}`);
      await deps.log({ action: 'זרימת מכירה: עדכון ידני — לא נשלח', phone: st.phone, detail: kind + ' · ' + g.verdict });
      return { sent: false, why: 'human-note', verdict: g.verdict };
    }
    applyFacts(st, notesFacts(h, now));
  }
  if (!st.lastInAt || now - st.lastInAt > WINDOW_MS) {
    st.step = 'stopped'; st.why = 'window-closed';
    await deps.slack(`⌛ זרימת מכירה נעצרה: חלון 24 השעות נסגר · ${local(st.phone)} · ${kind} לא נשלח (אין תבניות בזרימה)`);
    await deps.log({ action: 'זרימת מכירה: חלון 24ש נסגר, לא נשלח', phone: st.phone, detail: kind });
    return { sent: false, why: 'window-closed' };
  }
  if (!leadHoursOpen(now)) { st.pending = { text, kind, due: nextOpen(now) }; return { sent: false, queued: true, due: st.pending.due }; }
  if (!delayed && leadSlowHours(now)) { st.pending = { text, kind, due: now + leadDelayMs(deps.rand), delayed: true }; return { sent: false, queued: true, delayed: true, due: st.pending.due }; }
  const r = await deps.send(st.phone, text);
  if (!r || !r.ok) { await deps.log({ action: 'זרימת מכירה: שליחה נכשלה', ok: false, phone: st.phone, detail: kind }); return { sent: false, why: 'send-failed' }; }
  st.lastOutAt = now; st.pending = null;
  afterSend(st, kind, deps, now);
  return { sent: true };
}
/* timers that start when a question actually went out */
function afterSend(st, kind, deps, now) {
  if (kind === 'q1' || kind === 'q2' || (String(kind).startsWith('price-') && !st.nudged[st.step])) st.nudgeAt = nextOpen(now + nudgeDelayMs(deps.rand));
  else if (String(kind).startsWith('price-') && st.step === 2 && st.nudged[2]) st.fallbackAt = nextOpen(now + FALLBACK_AFTER_NUDGE_MIN * 60e3);
  if (kind === 'offer' || kind === 'offer-fallback') { st.offerAt = now; st.follows = 0; st.followAt = nextOpen(now + Math.round((FOLLOW1_MIN_H + deps.rand() * (FOLLOW1_MAX_H - FOLLOW1_MIN_H)) * 3600e3)); }
  if (kind === 'nudge' && st.step === 2) st.fallbackAt = nextOpen(now + FALLBACK_AFTER_NUDGE_MIN * 60e3);
}
const local = p => String(p || '').replace(/^972/, '0');

async function handOff(env, st, why, text, deps, now) {
  st.step = 'human'; st.why = why;
  await deps.slack(`🙋 *ליד מבקש אדם* · ${st.name || ''} ${local(st.phone)} · ${why}${text ? ' · כתב/ה: ' + String(text).slice(0, 200) : ''} · https://ishur.io/inbox.html`);
  await deps.log({ action: 'זרימת מכירה: ליד מבקש אדם', phone: st.phone, detail: why });
  const r = await deliver(env, st, MSG.human, 'human', deps, now);
  await putState(env, st);
  return { handled: true, action: 'human', ...r };
}

async function sendOffer(env, st, deps, now, { fallback = false } = {}) {
  const o = buildOffer(st, { fallback, now });
  if (!o.ok) return handOff(env, st, o.why === 'over-900' ? 'מעל 900 מוזמנים — הצעה אישית' : o.why === 'no-guests' ? 'לא ידועה כמות מוזמנים' : o.why === 'no-bundle' || o.why === 'over-cap' ? 'דיילות בלי מבצע מתאים (מעל ₪1,990) — הצעה ידנית' : 'תמחור נכשל: ' + o.why, '', deps, now);
  const prevStep = st.step;
  st.step = 'done'; st.quote = { bundle: o.quote.bundle || '', plan: o.quote.plan, records: o.quote.records, hostesses: o.quote.hostesses, design: o.quote.design, sum: o.quote.sum, fallback };
  st.link = o.link;
  const r = await deliver(env, st, o.text, fallback ? 'offer-fallback' : 'offer', deps, now);
  if (r.why === 'human-note') { if (st.step === 'paused') st.pausedFrom = prevStep; await putState(env, st); return { handled: true, action: 'human-note', ...r }; }
  if (r.sent || r.queued) {
    await deps.markQuoted(st.phone, o.quote, o.link, { fallback });
    await deps.slack(`💬 *הצעה נשלחה בזרימה* · ${st.name || ''} ${local(st.phone)} · ${o.quote.description} · ₪${o.quote.sum}${fallback ? ' · ברירת מחדל (לא ענו)' : ''}${r.queued ? ' · תצא ב-10:00' : ''}`);
    await deps.log({ action: fallback ? 'זרימת מכירה: הצעת ברירת מחדל' : 'זרימת מכירה: הצעה נשלחה', phone: st.phone, detail: `${o.quote.description} · ₪${o.quote.sum}` });
  }
  await putState(env, st);
  return { handled: true, action: fallback ? 'offer-fallback' : 'offer', quote: o.quote, link: o.link, ...r };
}

/* deps: { send(phone,text)→{ok}, slack(text), log(obj), markQuoted(phone,quote,link,opts), rand(), now() } */
function fill(deps = {}) {
  return { send: deps.send || (async () => ({ ok: false })), slack: deps.slack || (async () => {}), log: deps.log || (async () => {}),
    markQuoted: deps.markQuoted || (async () => {}), rand: deps.rand || Math.random, now: deps.now || Date.now, isClient: deps.isClient || (async () => false), humanNotes: deps.humanNotes || null };
}

/* One inbound on 4499 from a phone the caller already ruled a lead (not a
   client, not a guest). ctx: { phone, text, name, isNewLead, isMetaLead, occasion, guests }
   → { handled } — handled:true means the normal path must not answer. */
export async function salesInbound(env, ctx, depsIn) {
  if (!sfEnabled(env) || !env.RATE) return { handled: false, why: 'off' };
  const deps = fill(depsIn), now = deps.now();
  const phone = String(ctx.phone || ''), text = String(ctx.text || '').trim();
  if (!phone || !text) return { handled: false, why: 'empty' };
  if (ctx.isClient) return { handled: false, why: 'client' };
  let st = await getState(env, phone);

  if (!st) {
    if (await env.RATE.get(SF_SEEN + phone)) return { handled: false, why: 'seen' };
    const trig = triggerMatch(text);
    if (!(ctx.isNewLead && trig) && !ctx.isMetaLead) return { handled: false, why: 'no-trigger' };
    if (optOut(text)) return { handled: false, why: 'optout' };
    await env.RATE.put(SF_SEEN + phone, new Date(now).toISOString(), { expirationTtl: 180 * 86400 });
    st = { phone, name: String(ctx.name || '').slice(0, 60), occasion: (trig && trig.occasion) || ctx.occasion || '', guests: (trig && trig.guests) || Number(ctx.guests) || 0,
      step: 1, answers: null, design: false, startedAt: now, lastInAt: now, lastOutAt: 0, nudged: {}, src: ctx.isMetaLead ? 'meta' : 'whatsapp' };
    if (deps.humanNotes) { try { const h0 = await deps.humanNotes(phone); st.notesSnap = String((h0 && h0.notes) || ''); st.humanAck = now; } catch {} }
    if (wantsHuman(text)) return handOff(env, st, 'ביקש אדם בהודעה הראשונה', text, deps, now);
    const pq0 = priceQuestion(text);
    const r = await deliver(env, st, (pq0 ? MSG.priceFirst + '\n' : '') + MSG.q1(st.occasion, !st.guests), 'q1', deps, now);
    await putState(env, st);
    await deps.log({ action: 'זרימת מכירה התחילה', phone, detail: `${st.occasion || '?'} · ${st.guests || '?'} · ${st.src}` });
    return { handled: true, action: 'q1', ...r };
  }

  /* after the offer: "בשיחה" / "נציג" / "תתקשרו" is the phone option of the closing → a person */
  if (st.step === 'done' && !st.followStop) { st.followStop = true; st.followAt = 0; st.lastInAt = now; await putState(env, st); }
  if (st.step === 'done' && (wantsHuman(text) || /שיחה|תתקשר|להתקשר|טלפונ/.test(text)) && !optOut(text)) { st.lastInAt = now; return handOff(env, st, 'ביקש להזמין בשיחה טלפונית אחרי ההצעה', text, deps, now); }
  if (st.step === 'done' || st.step === 'human' || st.step === 'stopped' || st.step === 'paused') return { handled: false, why: 'flow-' + st.step };
  st.lastInAt = now; st.nudgeAt = 0; st.fallbackAt = 0;
  if (optOut(text)) {
    st.step = 'stopped'; st.why = 'optout'; await putState(env, st);
    await deps.slack(`🛑 זרימת מכירה נעצרה (הסרה/לא רלוונטי) · ${local(phone)} · ${text.slice(0, 120)}`);
    return { handled: false, action: 'optout' };
  }
  if (wantsHuman(text)) return handOff(env, st, 'ביקש נציג / את ריצארד', text, deps, now);

  /* a price question mid-flow: that one number now, then the flow goes on */
  const pq = priceQuestion(text);
  if (pq) {
    const g = parseGuests(text); if (g && !st.guests) st.guests = g;
    const ans = priceAnswer(pq.kind, st.guests);
    const tail = st.step === 1 ? MSG.backToQ1 : MSG.q2;
    const msg = ans ? ans + '\n' + tail : MSG.priceFirst + '\n' + tail;
    const r = await deliver(env, st, msg, 'price-' + pq.kind, deps, now);
    await putState(env, st);
    return { handled: true, action: 'price-answer', kind: pq.kind, ...r };
  }

  if (st.step === 1) {
    const a = parseAnswers(text, now);
    if (!a.signals && !a.guests) return handOff(env, st, 'תשובה שהזרימה לא הבינה', text, deps, now);
    const prev = st.answers || {};
    st.answers = { calls_rounds: a.calls_rounds, hostess: a.hostess || (!a.explicitHostess && !!prev.hostess), date: a.date || prev.date || '', month: a.month, city: a.city || prev.city || '' };
    st.explicit = { hostess: a.explicitHostess, calls: a.explicitCalls };
    if (a.guests) st.guests = a.guests;
    if (!st.occasion) st.occasion = parseOccasion(text);
    st.step = 2;
    const r = await deliver(env, st, MSG.q2, 'q2', deps, now);
    await putState(env, st);
    return { handled: true, action: 'q2', answers: st.answers, ...r };
  }
  if (st.step === 2) {
    const d = parseDesign(text);
    if (!d.known && /\?/.test(text)) return handOff(env, st, 'שאלה שהזרימה לא הבינה', text, deps, now);
    st.design = d.design;
    const g = parseGuests(text); if (g && !st.guests) st.guests = g;
    return sendOffer(env, st, deps, now);
  }
  return { handled: false, why: 'bad-step' };
}

/* Every pacer tick: queued replies whose morning came, nudges, the fallback offer. */
export async function salesTick(env, depsIn) {
  const out = { sent: 0, nudged: 0, fallback: 0, skipped: 0 };
  if (!sfEnabled(env) || !env.RATE) return out;
  const deps = fill(depsIn), now = deps.now();
  const follow = sfFollowupsEnabled(env);
  const page = await env.RATE.list({ prefix: SF_PREFIX, limit: 500 }).catch(() => null);
  for (const k of (page && page.keys) || []) {
    let st = null; try { st = JSON.parse((await env.RATE.get(k.name)) || 'null'); } catch {}
    if (!st || st.step === 'stopped') continue;
    if (st.pending && now >= st.pending.due) {   /* a queued REPLY to an inbound — not a follow-up */
      if (await deps.isClient(st.phone)) { st.step = 'stopped'; st.why = 'became-client'; st.pending = null; await putState(env, st); out.skipped++; continue; }
      const p = st.pending; st.pending = null;
      const r = await deliver(env, st, p.text, p.kind, deps, now, { delayed: !!p.delayed });
      if (r.sent) out.sent++;
      await putState(env, st);
      continue;
    }
    if (!follow) continue;
    if (st.step === 'done' && !st.pending && !st.followStop && st.followAt && now >= st.followAt && (st.follows || 0) < 2) {
      const n = (st.follows || 0) + 1;
      st.follows = n; st.followAt = n === 1 ? nextOpen(now + FOLLOW2_AFTER_H * 3600e3) : 0;
      const r = await deliver(env, st, n === 1 ? MSG.follow1 : MSG.follow2, 'follow' + n, deps, now);
      /* status stays quoted whatever happens; a closed window just ends the follow-ups */
      if (st.step === 'stopped' && st.why === 'window-closed') { st.step = 'done'; st.followStop = true; st.followAt = 0; }
      if (r.sent) out.followed = (out.followed || 0) + 1;
      await putState(env, st);
      continue;
    }
    if (st.pending || (st.step !== 1 && st.step !== 2)) continue;
    if (await deps.isClient(st.phone)) { st.step = 'stopped'; st.why = 'became-client'; await putState(env, st); out.skipped++; continue; }
    if (st.nudgeAt && !st.nudged[st.step] && now >= st.nudgeAt && st.lastOutAt > st.lastInAt - 1) {
      st.nudged[st.step] = now; st.nudgeAt = 0;
      const r = await deliver(env, st, MSG.nudge, 'nudge', deps, now);
      if (r.sent) out.nudged++;
      await putState(env, st);
      continue;
    }
    if (st.step === 2 && st.fallbackAt && now >= st.fallbackAt) {
      st.fallbackAt = 0;
      const r = await sendOffer(env, st, deps, now, { fallback: true });
      if (r.sent) out.fallback++;
    }
  }
  return out;
}

/* Richard resumes a paused lead (lead drawer / POST /api/sales-flow-resume):
   back to the step it was on, human notes up to now acknowledged */
export async function salesResume(env, phone, depsIn) {
  const deps = fill(depsIn), now = deps.now();
  const st = await getState(env, phone);
  if (!st || st.step !== 'paused') return { ok: false, why: st ? 'not-paused' : 'no-flow' };
  st.step = st.pausedFrom || 1; st.humanAck = now; st.why = '';
  if (deps.humanNotes) { try { const h = await deps.humanNotes(phone); st.notesSnap = String((h && h.notes) || ''); applyFacts(st, notesFacts(h, now)); } catch {} }
  if (st.step === 1 || st.step === 2) st.nudgeAt = st.nudged[st.step] ? 0 : nextOpen(now + nudgeDelayMs(deps.rand));
  if (st.step === 2 && st.nudged[2]) st.fallbackAt = nextOpen(now + FALLBACK_AFTER_NUDGE_MIN * 60e3);
  await putState(env, st);
  return { ok: true, step: st.step };
}
