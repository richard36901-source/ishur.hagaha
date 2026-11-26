/* "החבילה שלי" (Richard 20/11/2026): what the client's package includes, for the app's account tab.
   No prices here, on purpose: the app sells nothing (spec, Policy flags). The feature lines mirror PLANS in
   config.js; worker/test/package.test.mjs fails when the two drift apart. */
export const PLAN_NAMES = { basic: 'בסיס', pro: 'פרמיום', premium: 'הכל כלול' };
export const PLAN_FEATURES = {
  basic: [
    'הזמנה דיגיטלית לאורחים בוואטסאפ',
    '2 הודעות אישורי הגעה (הזמנה + תזכורת למתלבטים)',
    'דף מעקב 24/7 מי אישר',
    'תזכורת יום לפני עם כתובת האולם וניווט',
    'סידורי הושבה, ניהול תקציב, קישור מתנות ביט/פייבוקס',
    'עד 10 מוזמנים נוספים חינם',
  ],
  pro: [
    'כל מה שבחבילת בסיס',
    'סבב שיחות מסוכן AI למתלבטים ולמי שענה אולי',
    'הודעת תודה לאורחים יום אחרי האירוע',
    'דוח מסודר ביום האירוע',
  ],
  premium: [
    'כל מה שבחבילת פרמיום',
    '3 סבבי שיחות מסוכן AI',
    'טיפול ידני במוזמנים שלא עונים',
    'הודעת דחייה או עדכון מועד',
    'הודעת ביטול אירוע',
    'עדיפות בתמיכה',
  ],
};
const ORDER = ['basic', 'pro', 'premium'];
export function planKeyFromText(s) {
  const t = String(s || '').trim().toLowerCase();
  if (/הכל|premium|all/.test(t)) return 'premium';
  if (/בסיס|basic|base/.test(t)) return 'basic';
  return 'pro';
}
/* every line the client has, lowest package first, without the "כל מה שב…" pointer lines */
export function includedLines(key) {
  const out = [];
  for (const k of ORDER.slice(0, ORDER.indexOf(key) + 1)) for (const f of PLAN_FEATURES[k]) if (!/^כל מה שבחבילת/.test(f)) out.push(f);
  /* a higher package replaces "one round of calls" with its own count */
  return key === 'premium' ? out.filter(f => !/^סבב שיחות מסוכן AI/.test(f)) : out;
}
/* add-ons bought for this event, read from the same KV rows the board uses */
const ADDONS = [['extrasend', 'שליחה נוספת למוזמנים'], ['callsaddon', 'סבב שיחות נוסף'], ['hostess', 'דיילות קבלת פנים'], ['msgaddon', 'הודעה נוספת'], ['designbrief', 'עיצוב הזמנה']];
export async function packageFor(env, token, event = {}) {
  const key = planKeyFromText(event.plan);
  const bought = [];
  if (env && env.RATE) {
    const vals = await Promise.all(ADDONS.map(([k]) => env.RATE.get(k + ':' + token).catch(() => null)));
    ADDONS.forEach(([, label], i) => { if (vals[i]) bought.push(label); });
  }
  const tier = String(event.guests_tier || '').replace(/[^\d]/g, '');
  return { plan: key, name: PLAN_NAMES[key], guests: tier ? Number(tier) : null, included: includedLines(key), addons: bought, terms_url: 'https://ishur.io/terms.html' };
}
