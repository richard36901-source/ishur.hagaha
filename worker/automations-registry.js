/* ============================================================================
   ishur.io · automations-registry.js — every sending automation, as data
   ----------------------------------------------------------------------------
   Built 01/11/2026 by reading worker/index.js, whatsapp.js, shir.js, slack.js,
   ads.js, audit.js at commit b480ed7 (index.js unchanged since a1c3d8a, the
   deployed 1461afe4 hotfix). NOTHING here is executed by the engine; it is a
   description of the engine for automations.html and /api/automations.

   Rule: every claim points at a line. `source` is the node's anchor and
   `evidence[]` backs specific claims (a template name, a KV marker, a guard).
   worker/scripts/check-registry.mjs opens each file and asserts that the
   anchored line (±3, see WINDOW there) contains `symbol` — when index.js moves,
   that script fails and prints where the symbol went.

   Field guide (per node):
     id, name_he, layer (0 trigger · 1 dispatcher · 2 automation · 3 reaction)
     from[]        upstream node ids (graph edges)
     kind          send_guest | send_client | call | slack | internal | trigger
     trigger       { cron (UTC, wrangler.toml), il, via }
     conditions[]  plain Hebrew
     templates[]   Meta template names (live counts strip _f/_n suffixes)
     audience      who receives it
     kv_markers    { per_guest[], per_event[], global[] }
     on_failure    { '131048': …, other: … }
     budget        cap / pace rule
     warnings[]    gaps found while reading the code (each one has evidence)
     live          { jobs[] audit.job names · kv key holding a last-run JSON ·
                     pacer: the key inside pacer:last this node reports into }
     source        { file, line, symbol }
     evidence[]    { file, line, symbol, claim }
   ========================================================================== */

const IX = 'worker/index.js';
const S = (line, symbol, file = IX) => ({ file, line, symbol });
const E = (line, symbol, claim, file = IX) => ({ file, line, symbol, claim });

/* Israel windows, from shir.js — quoted, not recomputed */
export const WINDOWS = {
  send: { he: 'א׳–ה׳ 09:00–20:30 · ו׳ 09:00–13:00 · שבת: אין', source: S(58, 'export function sendWindowState', 'worker/shir.js') },
  call: { he: 'א׳–ה׳ 10:00–20:30 · ו׳ 09:30–13:00 · שבת: אין', source: S(32, 'export function callWindowState', 'worker/shir.js') },
  no_contact_days: { he: 'חגים וערבי חג מרשימה קשיחה — אין הודעות ואין שיחות', source: S(94, 'export function isNoContactDay', 'worker/shir.js') },
  slack_quiet: { he: 'התראות סלאק לא דחופות נאספות 21:00–09:00 ויוצאות ב-09:00', source: S(17, 'export function slackQuietHours', 'worker/slack.js') },
};

/* the numbers a message can leave from — resolved at runtime, defined here */
export const NUMBERS = {
  guests: { he: 'שיר (אורחים) — כל המספרים ב-guestPhoneIds; נבחר המספר עם הכי מעט שליחות היום שלא בתקרה', source: S(67, 'export async function pickGuestPhone', 'worker/whatsapp.js'),
    evidence: [E(60, 'export function guestPhoneIds', 'הרשימה = WA_PHONE_ID_GUESTS + WA_PHONE_IDS_GUESTS', 'worker/whatsapp.js'), E(31, 'WA_PHONE_IDS_GUESTS = "1409632775565601"', 'מספר שני 055-3089799 נוסף 01/11', 'worker/wrangler.toml')] },
  client: { he: 'נועה 4499 (לקוחות ולידים) — sendClient, עוצר על paused/הסרה', source: S(127, 'async function sendClient'),
    evidence: [E(29, 'WA_PHONE_ID_CLIENT = "1218978741299669"', 'phone id של 4499 מאז 25/10', 'worker/wrangler.toml')] },
};

export const CRONS = [
  { expr: '*/10 * * * *', he: 'כל 10 דקות', node: 't_cron10' },
  { expr: '35 6 * * *', he: '08:35 חורף · 09:35 קיץ', node: 't_morning' },
  { expr: '0 4 * * *', he: '06:00 חורף · 07:00 קיץ', node: 't_0400' },
  { expr: '0 9,10,16 * * 2', he: 'שלישי 11:00/12:00/18:00 חורף', node: 't_tue' },
  { expr: '0 17 * * *', he: 'ערב (בודק שעה בישראל)', node: 't_evening' },
  { expr: '0 18 * * *', he: 'ערב (בודק שעה בישראל)', node: 't_evening' },
  { expr: '0 19 * * *', he: 'ערב (בודק שעה בישראל)', node: 't_evening' },
];
export const CRONS_SOURCE = S(48, 'crons = ["*/10 * * * *", "35 6 * * *"', 'worker/wrangler.toml');

/* guest-send failure semantics, shared text */
const CAP_REOPEN = 'תקרת מטא למספר: הסימון לאורח נמחק בלי לספור ניסיון, המספר מסומן wacap:<id>; כשכל המספרים בתקרה — wacap:guests עוצר את כל הגלים עד שמטא משחררת';
const NO_WAMID = 'לא נרשם wamid לשליחה הזו, ולכן כשל אסינכרוני (גם 131048) לא פותח את האורח מחדש — הוא נשאר מסומן כ"נשלח"';

export const AUTOMATIONS = [
  /* ═════════════ layer 0 · triggers ═════════════ */
  { id: 't_cron10', name_he: 'קרון כל 10 דקות', layer: 0, from: [], kind: 'trigger',
    trigger: { cron: '*/10 * * * *', il: 'כל 10 דקות, 24/7 (כל משימה בודקת חלון לבד)', via: 'scheduled()' },
    conditions: ['מריץ 12 משימות במקביל דרך audit.job, ואחריהן את הפייסר'],
    source: S(8811, "startsWith('*/10')"),
    evidence: [E(8825, "audit.job(env, 'runPacer'", 'הפייסר רץ בסוף כל פעימה')] },
  { id: 't_morning', name_he: 'קרון בוקר 06:35 UTC', layer: 0, from: [], kind: 'trigger',
    trigger: { cron: '35 6 * * *', il: '08:35 בחורף · 09:35 בקיץ', via: 'scheduled() — ענף ברירת המחדל' },
    conditions: ['מחמש pacer:pending להיום לפני המנוע', 'תקציב שליחה לאורחים: 50 אם חלון השליחה פתוח, אחרת 0 (בחורף 08:35 = 0, הפייסר ממשיך ב-09:00)'],
    kv_markers: { global: ['pacer:pending'] },
    source: S(8864, 'const morningBudget'),
    evidence: [E(8842, "pacer:pending', ilDate()", 'חימוש היום לפני ריצת המנוע')] },
  { id: 't_0400', name_he: 'קרון 04:00 UTC · דופק', layer: 0, from: [], kind: 'trigger',
    trigger: { cron: '0 4 * * *', il: '06:00 בחורף · 07:00 בקיץ', via: 'scheduled()' },
    source: S(8760, "startsWith('0 4 ')") },
  { id: 't_evening', name_he: 'קרונות ערב 17/18/19 UTC', layer: 0, from: [], kind: 'trigger',
    trigger: { cron: '0 17,18,19 * * *', il: 'הקוד בודק את השעה בישראל: 20:00 → לולאת שיפור · 21:00 → דוח יומי', via: 'scheduled()' },
    source: S(8794, "startsWith('0 17 ')"),
    evidence: [E(8795, "timeZone: 'Asia/Jerusalem', hour: '2-digit'", 'השעה בישראל נקבעת מ-scheduledTime')] },
  { id: 't_tue', name_he: 'קרון שלישי · תזכורות צוות', layer: 0, from: [], kind: 'trigger',
    trigger: { cron: '0 9,10,16 * * 2', il: 'שלישי 11:00/12:00/18:00 בחורף', via: 'scheduled()' },
    source: S(8804, "startsWith('0 9,10,16')") },
  { id: 't_wa_status', name_he: 'וובהוק סטטוס ממטא', layer: 0, from: [], kind: 'trigger',
    trigger: { cron: '', il: 'בכל דיווח מסירה/כשל ממטא', via: 'POST /webhook (handleWaWebhook)' },
    source: S(2829, 'async function handleWaWebhook') },

  /* ═════════════ layer 1 · dispatchers ═════════════ */
  { id: 'd_pacer', name_he: 'הפייסר (runPacer)', layer: 1, from: ['t_cron10'], kind: 'internal', routes: ['/api/pacer'],
    trigger: { cron: '*/10 * * * *', il: 'כל 10 דקות; שליחות רק בחלון השליחה, חיוג רק בחלון השיחות', via: 'audit.job runPacer' },
    conditions: ['חג (isNoContactDay) → רק בדיקת תבניות', 'paused → יוצא אחרי ריקון תור הסלאק ובדיקת פרסום', 'מריץ את המנוע עם תקציב 25 רק אם pacer:pending = היום'],
    kv_markers: { global: ['pacer:pending', 'pacer:last', 'paused', 'slackqflush:<יום>', 'autoretry:<יום>'] },
    budget: '25 הודעות לאורחים לפעימה (PACE_SENDS) · 6 חיוגים לפעימה (PACE_CALLS) · 3 חזרות שיחה מתוכם',
    live: { jobs: ['runPacer'], kv: 'pacer:last' },
    source: S(5491, 'async function runPacer'),
    evidence: [E(5392, 'const PACE_SENDS = 25', '25 לפעימה'), E(5393, 'const PACE_CALLS = 6', '6 חיוגים לפעימה'), E(5516, 'if (await sendingPaused(env)) return { ok: true, paused: true };', 'עצירה ידנית'), E(5544, "await env.RATE.get('pacer:pending') === today", 'המנוע רץ רק כשיש עבודה ממתינה'), E(5613, "await env.RATE.put('pacer:last'", 'דופק הפייסר')] },
  { id: 'd_engine', name_he: 'המנוע היומי (runDailyEngine)', layer: 1, from: ['t_morning', 'd_pacer'], kind: 'internal', routes: ['/api/daily-run'],
    trigger: { cron: '35 6 * * * + */10', il: 'בוקר + כל פעימת פייסר כשיש עבודה', via: 'runDailyEngine(env, dry, date, {budget})' },
    conditions: ['שבת → לא רץ (חוץ מהרצה יבשה)', 'יום ללא יצירת קשר → לא רץ', 'paused → לא רץ', 'אין בדיקת חלון שליחה בתוך המנוע עצמו — החלון נאכף רק דרך התקציב (0 בבוקר חורף)'],
    kv_markers: { global: ['engine:lastrun', 'pacer:pending', 'paused'] },
    budget: 'אובייקט budget אחד משותף לכל השלבים בריצה — שלבים מוקדמים בסדר הקוד אוכלים ראשונים',
    live: { kv: 'engine:lastrun' },
    mutates_on_dry: true,
    dry_writes: ['wa:cap (waCapInfo, כשאין מטמון)', 'מחיקת lead:<phone> ריק או של לקוח (chaseAbandonedLeads בהרצה יבשה)', 'brain:cache (getBrain בשלב סוף-אירוע)'],
    warnings: ['אין sendWindowState בתוך runDailyEngine: שלבים ללקוחות שלא סופרים תקציב (דוח שבוע-לפני, הודעת סיום, תזכורת קובץ, שדרוג) יכולים לצאת בריצת 08:35 בחורף, לפני 09:00',
      'גם הרצה יבשה (dry:true) כותבת ל-KV: wa:cap, brain:cache, ומוחקת מפתחות lead: — לכן /api/automations לא מריץ אותה'],
    source: S(4568, 'async function runDailyEngine'),
    evidence: [E(4608, 'await waCapInfo(env).catch(() => null);', 'נקרא גם ביבש'), E(8190, "await env.RATE.put('wa:cap'", 'כתיבת מטמון'), E(4613, 'if (dry) for (const r of await chaseAbandonedLeads', 'רצף לידים ביבש'), E(896, 'if (!rec) { await env.RATE.delete(k.name); continue; }', 'מחיקה בלי בדיקת dry'), E(897, "if (await env.RATE.get('client:' + phone)) { await env.RATE.delete(k.name); continue; }", 'מחיקה בלי בדיקת dry'), E(5056, 'const brain = await getBrain(env);', 'לפני בדיקת dry'), E(3853, "await env.RATE.put('brain:cache'", 'כתיבת מטמון'),
      E(4583, 'if (isShabbat && !dry', 'שבת'), E(4586, 'isNoContactDay(today) && !dry', 'חג'), E(4602, 'if (await sendingPaused(env)) {', 'paused'), E(5362, "engine:lastrun',", 'נרשם בסוף ריצה אמיתית')] },

  /* ═════════════ layer 2 · engine stages (runDailyEngine order) ═════════════ */
  { id: 'stuck_client', name_he: 'שלב 0.5 · שילם ולא העלה רשימה', layer: 2, from: ['d_engine'], kind: 'send_client',
    trigger: { cron: '35 6 * * * + */10', il: 'בכל ריצת מנוע, אין בדיקת חלון', via: 'runDailyEngine' },
    conditions: ['pend:<token> קיים (נכתב בתשלום) ואין uploaded:<token>', 'עבר לפחות יום מהתשלום'],
    templates: ['ishur_tzikoret_kovetz'], audience: 'הלקוח המשלם (הטלפון מהתשלום)',
    kv_markers: { per_event: ['pend:<token>', 'pend2:<token>', 'uploaded:<token>'] },
    on_failure: { other: 'לא נמחק pend: — ינסה שוב בריצה הבאה' },
    budget: 'לא סופר תקציב', source: S(4615, 'stage 0.5: paid but never'),
    evidence: [E(4630, "'ishur_tzikoret_kovetz',", 'התבנית'), E(4636, 'pend2:', 'סימון שנשלח')] },
  { id: 'no_setup', name_he: 'שלב 0.55 · שילם, העלה, לא הגדיר תאריכים', layer: 2, from: ['d_engine'], kind: 'send_client',
    trigger: { cron: '35 6 * * * + */10', il: 'בכל ריצת מנוע, אין בדיקת חלון', via: 'runDailyEngine' },
    conditions: ['משולם, לא בוטל, קובץ הועלה', 'חסר תאריך אירוע או אין אף תאריך שליחה (AN/AO/AP)'],
    templates: ['ishur_tzikoret_kovetz'], audience: 'הלקוח (עמודה D)', kv_markers: { per_event: ['nosetup:<token>'] },
    on_failure: { other: 'nosetup: לא נכתב — ינסה שוב' }, budget: 'לא סופר תקציב · פעם ב-14 יום',
    source: S(4713, 'stage 0.55'), evidence: [E(4725, 'const anySend = [39, 40, 41]', 'בודק AN/AO/AP'), E(4727, 'nosetup:', 'סימון')] },
  { id: 'health_alert', name_he: 'שלב 0.6 · בריאות ערוץ (כשלים אתמול)', layer: 2, from: ['d_engine'], kind: 'slack',
    conditions: ['אתמול ≥10 שליחות ו-≥30% נכשלו (wastat:<יום>)'], audience: 'סלאק', kv_markers: { global: ['wastat:<יום>', 'healthalert:<יום>'] },
    source: S(4740, 'stage 0.6: channel health'), evidence: [E(4746, "await alert(env, 'בריאות ערוץ',", 'התראה')] },
  { id: 'watchdog', name_he: 'שלב 0.7 · שומר: גל 1 לא יצא', layer: 2, from: ['d_engine'], kind: 'slack',
    conditions: ['משולם + קובץ + לא מוחזק', 'תאריך גל 1 עבר לפני יום או יותר ואין wave:<token>:1', 'האירוע עוד לא היה'],
    audience: 'סלאק (התראה אחת לאירוע)', kv_markers: { per_event: ['watchdog:<token>', 'wave:<token>:1', 'hold:<token>'] },
    source: S(4753, 'stage 0.7: the wedding'), evidence: [E(4778, "await env.RATE.put('watchdog:' + token", 'פעם אחת לאירוע')] },
  { id: 'ad_review', name_he: 'שלב 0.8 · סקירת קמפיין כל 4 ימים', layer: 2, from: ['d_engine'], kind: 'slack',
    conditions: ['adrev:last ישן מ-4 ימים פחות 6 שעות'], audience: 'ריצארד (וואטסאפ + סלאק)', kv_markers: { global: ['adrev:last'] },
    source: S(4795, 'stage 0.8'), evidence: [E(8013, 'if (!opts.force && last && now - Date.parse(last) < FOUR_D', 'שער 4 ימים')] },

  { id: 'wave1', name_he: 'גל 1 · הזמנה', layer: 2, from: ['d_engine'], kind: 'send_guest',
    trigger: { cron: '35 6 * * * + */10', il: 'תאריך AN, עד 3 ימים באיחור; בפועל בחלון השליחה (התקציב)', via: 'runDailyEngine → sendWave' },
    conditions: ['משולם, לא בוטל, קובץ הועלה, אין hold:<token>', 'היום בין AN ל-AN+3 והאירוע עוד לא היה', 'אין wave:<token>:1', 'לכל הרשימה חוץ מ"לא מגיע"', 'הזמנה אחת לאדם ביום בין אירועים (gday:)'],
    templates: ['hazmana_ishur', 'hazmana_ishur_v2', 'hazmana_ishur_img_u', 'hazmana_ishur_vid_u', 'hazmana_ishur_img', 'hazmana_ishur_vid'],
    audience: 'כל האורחים של האירוע (עמודה AC = token)',
    kv_markers: { per_guest: ['wsent:<token>:1:<phone>', 'gday:<phone>:<יום>', 'wferr:<token>:1:<phone>', 'wfail:<token>:1:<phone>', 'wdead:<token>:1:<phone>', 'wamid:<id>'], per_event: ['wave:<token>:1', 'wpos:<token>:1', 'wlate:<token>:1', 'sentdate:<token>', 'customtmpl:<token>', 'vidok:<token>'], global: ['invitetmpl', 'invitetmpl_img', 'invitetmpl_vid', 'wacap:guests', 'wacap:<phoneId>'] },
    on_failure: { '131048': CAP_REOPEN, '130429': CAP_REOPEN, '131026': 'לא בוואטסאפ/חסם: wdead מיד (3 מתוך 3), השיחה של שיר היא הדרך', '131049': 'גל 1: נדחה עד שתבנית ה-UTILITY (_u) פעילה', '130472': 'גל 1: נדחה כמו 131049', other: 'ניסיון 1–2: הסימון נמחק ונשלח שוב בפעימה הבאה; ניסיון 3: wdead ודורש טיפול ידני' },
    budget: 'סופר מהתקציב המשותף (25 לפעימה) · תקרת מטא 250 שיחות/24ש לכל מספר',
    live: { pacer: 'sends' },
    source: S(4807, '{ key: 1, col: 39'),
    evidence: [E(4841, 'const flagKey = `wave:', 'דגל גל'), E(4398, 'const inviteTmpl = ', 'שם התבנית מ-KV invitetmpl, ברירת מחדל hazmana_ishur'), E(4509, 'const custom = wave.key === 1 ? await customTemplateFor', 'נוסח אישי של הלקוח בגל 1'), E(4482, 'const gd = await env.RATE.get(`gday:', 'אחת ליום לאדם'), E(4492, "if ((lastErr === '131049'", 'דחיית 131049/130472'), E(4447, 'const posKey = `wpos:', 'סמן התקדמות'), E(4428, "if (!dry && env.RATE && await env.RATE.get('wacap:guests'))", 'עצירה בתקרה'), E(4870, 'const waveDelivered', 'הגל נסגר רק בלי כשלים ובלי קיטוע'), E(4472, 'if (dry) { sent++; if (budget) budget.left--; continue; }', 'בהרצה יבשה סופרים לפני בדיקת wsent — המספר הוא גבול עליון')] },
  { id: 'wave2', name_he: 'גל 2 · תזכורת', layer: 2, from: ['d_engine'], kind: 'send_guest',
    trigger: { cron: '35 6 * * * + */10', il: 'תאריך AO, עד 3 ימים באיחור', via: 'runDailyEngine → sendWave' },
    conditions: ['כמו גל 1', 'רק למי שלא ענה או ענה "מתלבט"'],
    templates: ['hazmana_ishur', 'hazmana_ishur_v2'], audience: 'אורחים שלא ענו / מתלבטים',
    kv_markers: { per_guest: ['wsent:<token>:2:<phone>', 'gday:<phone>:<יום>', 'wfail/wferr/wdead:<token>:2:<phone>'], per_event: ['wave:<token>:2', 'wpos:<token>:2'] },
    on_failure: { '131048': CAP_REOPEN, other: 'כמו גל 1' }, budget: 'תקציב משותף 25 לפעימה',
    live: { pacer: 'sends' },
    source: S(4808, '{ key: 2, col: 40, onlyUnanswered: true }'),
    evidence: [E(4398, 'const inviteTmpl = ', 'אותה תבנית הזמנה (תמונה/וידאו רק בגל 1)')] },
  { id: 'wave3', name_he: 'גל 3 · שליחה נוספת (תוסף)', layer: 2, from: ['d_engine'], kind: 'send_guest',
    trigger: { cron: '35 6 * * * + */10', il: 'תאריך AP', via: 'runDailyEngine → sendWave' },
    conditions: ['רק אם נרכש התוסף: extrasend:<token>', 'אחרת: התראה אחת ו-wave3note:'],
    templates: ['hazmana_ishur', 'hazmana_ishur_v2'], audience: 'כל הרשימה חוץ מ"לא מגיע"',
    kv_markers: { per_event: ['extrasend:<token>', 'wave3note:<token>', 'wave:<token>:3'] },
    on_failure: { '131048': CAP_REOPEN, other: 'כמו גל 1' }, budget: 'תקציב משותף 25 לפעימה',
    source: S(4809, '{ key: 3, col: 41'), evidence: [E(4845, "extrasend:' + token", 'שער התוסף')] },
  { id: 'escalation', name_he: 'הסלמה לשיחות אחרי הגל האחרון', layer: 2, from: ['d_engine'], kind: 'internal',
    conditions: ['יום אחרי תאריך השליחה האחרון', 'חבילה לא "בסיס"', 'מי שלא ענה או "מתלבט", נייד ישראלי, בלי סטטוס שיחה'],
    audience: 'כותב "נדרשת שיחה" בגיליון (HOOK_EVENTS) — התור של שיר', kv_markers: { per_guest: ['escg:<guest_id>'], per_event: ['esc:<token>'] },
    on_failure: { other: 'esc: לא נסגר כשמישהו נכשל — מחר נשלחים רק הנכשלים' },
    source: S(4898, 'const escKey = `esc:'), evidence: [E(4897, "planKeyOf(ev) !== 'basic') {", 'בסיס לא נכנס לתור'), E(4914, 'const gKey = `escg:', 'סימון לאורח')] },
  { id: 'report7', name_he: 'דוח שבוע-לפני ללקוח', layer: 2, from: ['d_engine'], kind: 'send_client',
    conditions: ['0–7 ימים לאירוע', 'אין report7:<token>', 'אין hold'], templates: ['ishur_doch'], audience: 'הלקוח',
    kv_markers: { per_event: ['report7:<token>', 'alertonce:doch:<token>:<יום>'] },
    on_failure: { other: 'report7: לא נכתב, התראה פעם ביום, ינסה בריצה הבאה' }, budget: 'לא סופר תקציב, אין בדיקת חלון',
    warnings: ['אין בדיקת חלון שליחה — בריצת 08:35 בחורף יכול לצאת לפני 09:00'],
    source: S(4977, "'ishur_doch', ["), evidence: [E(4955, 'if (daysLeft < 0 || daysLeft > 7) continue;', 'חלון 7 ימים'), E(4981, "report7:' + token", 'סימון')] },
  { id: 'toda', name_he: 'תודה לאורחים (יום אחרי)', layer: 2, from: ['d_engine'], kind: 'send_guest',
    conditions: ['1–14 ימים אחרי האירוע', 'חבילה לא "בסיס"', 'רק מי שאישר "מגיע"', 'אין toda:<token>'],
    templates: ['ishur_toda_orach_v2', 'ishur_toda_orach'], audience: 'אורחים שאישרו הגעה',
    kv_markers: { per_guest: ['s3t:<token>:<phone>'], per_event: ['toda:<token>'], global: ['tmplok:ishur_toda_orach_v2'] },
    on_failure: { '131048': NO_WAMID, other: 'כשל סינכרוני: toda: לא נסגר, ינסה בפעימה הבאה' }, budget: 'תקציב משותף 25 לפעימה',
    warnings: [NO_WAMID],
    source: S(5032, "ishur_toda_orach_v2') ? "), evidence: [E(5026, "planKeyOf(ev) !== 'basic' && !(env.RATE && await env.RATE.get('toda:'", 'בסיס לא מקבל'), E(5038, 'const mk = `s3t:', 'סימון לאורח'), E(4064, 'async function templateApproved', 'v2 רק כשמאושרת')] },
  { id: 'syum', name_he: 'סיכום סוף-אירוע ללקוח', layer: 2, from: ['d_engine'], kind: 'send_client',
    conditions: ['1–14 ימים אחרי האירוע', 'אין eoe:<token>', 'קישורי המלצה במוח השירות קיימים, אחרת התראה אחת'],
    templates: ['ishur_syum_v3', 'ishur_syum'], audience: 'הלקוח', kv_markers: { per_event: ['eoe:<token>', 'eoelink:<token>'], global: ['eoe:tmpl'] },
    on_failure: { other: 'eoe: לא נכתב, התראה פעם ביום' }, budget: 'לא סופר תקציב, אין בדיקת חלון',
    source: S(5079, "'ishur_syum_v3'"), evidence: [E(5062, 'const useV3 = ', 'v3 לפי eoe:tmpl'), E(5002, 'if (daysAfter < 1 || daysAfter > 14) continue;', 'חלון 14 יום')] },
  { id: 'seating', name_he: 'שלב 4 · "השולחן שלך" ביום האירוע', layer: 2, from: ['d_engine'], kind: 'send_guest',
    conditions: ['תאריך האירוע = היום', 'אורח "מגיע" עם שולחן בעמודה AE', 'אין seat:<token>, אין hold'],
    templates: ['ishur_shulchan'], audience: 'מגיעים עם שולחן',
    kv_markers: { per_guest: ['s5t:<token>:<phone>', 'wamid:<id>'], per_event: ['seat:<token>'] },
    on_failure: { '131048': 'נפתח מחדש: s5t: ו-seat:<token> נמחקים, pacer:pending חומש', other: 'הסימון לאורח נמחק אבל seat:<token> נשאר — בפועל לא יישלח שוב' },
    budget: 'תקציב משותף 25 לפעימה',
    warnings: ['כשל אסינכרוני שאינו תקרה: seat:<token> לא נמחק, לכן השלב לא חוזר לאורח הזה'],
    live: { pacer: 'sends' },
    source: S(5126, "'ishur_shulchan', [gname"), evidence: [E(5099, 'if (!token || !paid || cancelled || date !== today) continue;', 'רק ביום האירוע'), E(5121, 'const mk = `s5t:', 'סימון'), E(5135, "'seat:' + token, today", 'נסגר רק בלי כשלים'), E(2928, 'const lifeFlag = {', 'פתיחה מחדש בתקרה'), E(5120, 'if (dry) { would++; continue; }', 'הרצה יבשה סופרת לפני בדיקת s5t — גבול עליון')] },
  { id: 'cancel', name_he: 'שלב 5 · הודעת ביטול לאורחים', layer: 2, from: ['d_engine'], kind: 'send_guest',
    conditions: ['בוטל? = כן, וגל 1 כבר יצא, והאירוע עוד לא עבר', 'הכל כלול או תוסף msgaddon:<token>:cancel — אחרת התראה לריצארד'],
    templates: ['ishur_bitul'], audience: 'כל המוזמנים',
    kv_markers: { per_guest: ['s5c:<token>:<phone>'], per_event: ['cancelmsg:<token>', 'cancelnote:<token>', 'msgaddon:<token>:cancel'] },
    on_failure: { '131048': NO_WAMID, other: 'cancelmsg: לא נסגר, התראה, ינסה שוב' }, budget: 'תקציב משותף 25 לפעימה', warnings: [NO_WAMID],
    source: S(5201, "'ishur_bitul', [gname"), evidence: [E(5175, "if (plan !== 'premium' && !cancelPaid)", 'שער חבילה'), E(5196, 'const mk = `s5c:', 'סימון'), E(5207, "cancelmsg:' + token, today", 'נסגר בסוף')] },
  { id: 'postpone', name_he: 'שלב 5 · הודעת דחייה לאורחים', layer: 2, from: ['d_engine'], kind: 'send_guest',
    conditions: ['תאריך האירוע בגיליון שונה מ-sentdate:<token>', 'הכל כלול או msgaddon:<token>:postpone'],
    templates: ['ishur_dchiya'], audience: 'כל המוזמנים',
    kv_markers: { per_guest: ['s5p:<token>:<date>:<phone>'], per_event: ['sentdate:<token>', 'postponenote:<token>:<date>'] },
    on_failure: { '131048': 'הסימון לאורח נמחק (wamid נרשם)', other: 'ניסיון נוסף בפעימה הבאה עד 3' }, budget: 'תקציב משותף 25 לפעימה',
    source: S(5236, "'ishur_dchiya',"), evidence: [E(5217, "if (plan === 'premium' || postponePaid)", 'שער חבילה'), E(5231, 'const mk = `s5p:', 'סימון לפי התאריך החדש')] },
  { id: 'day_before', name_he: 'שלב 5 · תזכורת יום-לפני', layer: 2, from: ['d_engine'], kind: 'send_guest',
    conditions: ['0–1 ימים לאירוע, קובץ הועלה', 'רק "מגיע"', 'אין daybefore:<token>'],
    templates: ['ishur_yom_lifnei'], audience: 'מי שאישר הגעה',
    kv_markers: { per_guest: ['s5d:<token>:<phone>', 'wamid:<id>'], per_event: ['daybefore:<token>', 'navlink:<token>'], global: ['navtmpl'] },
    on_failure: { '131048': 'נפתח מחדש: s5d: ו-daybefore:<token> נמחקים', other: 'הסימון לאורח נמחק אבל daybefore:<token> נשאר — בפועל לא יישלח שוב' },
    budget: 'תקציב משותף 25 לפעימה', warnings: ['כשל אסינכרוני שאינו תקרה: daybefore:<token> לא נמחק'],
    live: { pacer: 'sends' },
    source: S(5285, "current: navU ? navT : 'ishur_yom_lifnei'"), evidence: [E(5269, 'if (fileUp && daysLeft >= 0 && daysLeft <= 1', 'D-1 או D-0'), E(5278, 'const mk = `s5d:', 'סימון'), E(5283, 'const navT = ', 'navtmpl כש-navlink קיים'), E(5300, "'daybefore:' + token, today", 'נסגר בלי כשלים'), E(5277, 'if (dry) { would++; continue; }', 'יבש = גבול עליון')] },
  { id: 'upsell_basic', name_he: 'שלב 5 · הצעת שדרוג לבסיס', layer: 2, from: ['d_engine'], kind: 'send_client',
    conditions: ['חבילת בסיס, ≥7 ימים לאירוע', '≥2 ימים מהגל הראשון שיצא', '≥10 מוזמנים ו-≥40% לא ענו'],
    templates: ['ishur_shidrug'], audience: 'הלקוח', kv_markers: { per_event: ['upsell:<token>'] }, budget: 'פעם אחת לאירוע, לא סופר תקציב',
    source: S(5322, "'ishur_shidrug',"), evidence: [E(5317, 'if (total >= 10 && silent / total >= 0.4)', 'סף 40%'), E(5324, "upsell:' + token, today", 'סימון')] },
  { id: 'upsell_pro', name_he: 'שלב 5 · הצעת הכל כלול לפרמיום', layer: 2, from: ['d_engine'], kind: 'send_client',
    conditions: ['פרמיום, ≥7 ימים לאירוע', 'סבב שיחות היה (calldate:)', '≥5 חויגו ו-≥60% לא נענו'],
    templates: ['ishur_shidrug_sichot'], audience: 'הלקוח', kv_markers: { per_event: ['upsell2:<token>', 'calldate:<token>'] }, budget: 'פעם אחת לאירוע',
    source: S(5348, "'ishur_shidrug_sichot',"), evidence: [E(5343, 'if (tried.length >= 5 && silent / tried.length >= 0.6)', 'סף 60%'), E(5350, "upsell2:' + token, today", 'סימון')] },

  /* ═════════════ layer 2 · pacer slices ═════════════ */
  { id: 'autoretry', name_he: 'ניסיון חוזר אוטומטי (פעם ביום)', layer: 2, from: ['d_pacer'], kind: 'internal',
    trigger: { cron: '*/10 * * * *', il: 'הפעימה הראשונה בחלון השליחה בכל יום', via: 'runPacer' },
    conditions: ['אורחים עם wfail/wferr בלי wsent ולא wdead'], kv_markers: { per_guest: ['wfail:', 'wferr:', 'gday:'], per_event: ['wave:<token>:<k>'], global: ['autoretry:<יום>'] },
    audience: 'פותח מחדש גלים — השליחה עצמה בגלים', live: { pacer: 'autoretry' },
    source: S(5526, "if (sendWin.open && !(await env.RATE.get('autoretry:'"), evidence: [E(5538, 'for (const w of waves) await env.RATE.delete(`wave:${token}:${w}`)', 'פתיחת דגל הגל')] },
  { id: 'lead_chase', name_he: 'רצף לידים שנטשו (נועה)', layer: 2, from: ['d_pacer'], kind: 'send_client',
    trigger: { cron: '*/10 * * * *', il: 'בחלון השליחה', via: 'runPacer → chaseAbandonedLeads' },
    conditions: ['t1: 30 דקות אחרי הטופס', 't2: ביום אחר ו-16 שעות אחרי t1', 'שעתיים אחרי t2 → תור שיחות lq: (אם אין הסכמה)', 't3: 3 ימים אחרי t2', 'יוצא מהרצף: שילם, ענה, חסום'],
    templates: ['ishur_lo_siyem', 'ishur_lo_siyem_2', 'ishur_lo_siyem_3'], audience: 'לידים שהשאירו טלפון ולא שילמו',
    kv_markers: { per_guest: ['lead:<phone>', 'leadchase:<phone>', 'lq:<phone>', 'wamid:<id>'] },
    on_failure: { '131042': 'סינכרוני: ניסיון אחד בעוד 30 דקות ואז דחייה ליום; אסינכרוני: הוובהוק מחזיר את החותמת', other: 'קודים קבועים (132000/132001/132005/131009/131026) מקדמים את הרצף בכל זאת' },
    budget: '10 לפעימה', live: { pacer: 'leads' },
    source: S(5566, 'const chased = await chaseAbandonedLeads(env, false, { left: 10 })'),
    evidence: [E(855, 'async function chaseAbandonedLeads', 'הפונקציה'), E(818, 'const LEAD_T1_MS', '30 דקות'), E(879, 'const PERMANENT = /132000', 'קודים קבועים'), E(889, 'const TEMPORARY = /131042/', 'קוד זמני'), E(936, "await sendTouch('ishur_lo_siyem', 't1')", 't1'), E(944, "await sendTouch('ishur_lo_siyem_2', 't2')", 't2'), E(961, "const wa3 = await sendTouch('ishur_lo_siyem_3', 't3')", 't3'), E(2972, 'if (m && m.leadPhone && m.stampField)', 'החזרת חותמת בכשל אסינכרוני')] },
  { id: 'shir_callbacks', name_he: 'שיר · חזרה למי שהתקשר', layer: 2, from: ['d_pacer'], kind: 'call',
    trigger: { cron: '*/10 * * * *', il: 'חלון השיחות', via: 'runPacer → runShirCallbacks' },
    conditions: ['תור cbq:<phone>', 'paused/חג/חלון סגור → לא מחייג'], audience: 'מי שהתקשר אלינו', kv_markers: { per_guest: ['cbq:<phone>'] },
    budget: 'עד 3 לפעימה, מתוך 6', live: { pacer: 'callbacks' },
    source: S(5579, 'const cb = await runShirCallbacks'), evidence: [E(2497, 'async function runShirCallbacks', 'הפונקציה'), E(2503, 'if (!win.open && !force) return { dialed: 0, why: win.why };', 'חלון')] },
  { id: 'shir_dispatch', name_he: 'שיר · חיוג תור האורחים', layer: 2, from: ['d_pacer', 'escalation', 'call_rounds'], kind: 'call', routes: ['/api/shir-dispatch'],
    trigger: { cron: '*/10 * * * *', il: 'חלון השיחות', via: 'runPacer → runShirDispatch' },
    conditions: ['שורה עם "נדרשת שיחה" (buildCallQueue)', 'אין hold, לא חסום לשיחות, לא "טעות במספר"', 'שיחה אחת ביום לאורח (shirtry:)', 'מקסימום ניסיונות לפי חבילה: הכל כלול 3 · פרמיום 1 · בסיס 0'],
    audience: 'אורחים בתור השיחות', kv_markers: { per_guest: ['shirtry:<guest_id>:<יום>', 'dialed:<guest_id>'], per_event: ['calldate:<token>', 'hold:<token>'], global: ['dialday:<יום>'] },
    budget: '6 לפעימה פחות חזרות שיחה · תקרה 25 לקריאה', live: { pacer: 'calls' },
    source: S(5585, 'await runShirDispatch(env, { max: left, quiet: true })'),
    evidence: [E(2249, 'async function runShirDispatch', 'הפונקציה'), E(2275, "if (env.RATE && await env.RATE.get('hold:' + g.token))", 'hold עוצר'), E(2280, 'const dayKey = `shirtry:', 'פעם ביום'), E(26, 'export function planMaxCallTries', 'ניסיונות לפי חבילה', 'worker/dashboard.js')] },
  { id: 'noa_lead_dial', name_he: 'נועה · חיוג לידים (כבוי)', layer: 2, from: ['d_pacer', 'lead_chase'], kind: 'call',
    conditions: ['NOA_LEADS="on" — כרגע "off"', 'תור lq:'], audience: 'לידים בתור', kv_markers: { per_guest: ['lq:<phone>'] }, budget: '2 לפעימה',
    live: { pacer: 'leadCalls' },
    source: S(5593, 'const lead = await runShirLeadDial(env, { max: 2 })'), evidence: [E(2596, 'const ready = String(env.NOA_LEADS', 'מתג'), E(20, 'NOA_LEADS = "off"', 'כבוי היום', 'worker/wrangler.toml')] },
  { id: 'reconcile_calls', name_he: 'קליטת תוצאות שיחה מרטל', layer: 2, from: ['d_pacer'], kind: 'internal',
    conditions: ['כל פעימה, בכל שעה', 'שיחות אורח שהסתיימו, עד 3 ימים, שעוד לא עובדו'], kv_markers: { global: ['shirdone:end:<call_id>'] },
    source: S(5573, 'await reconcileShirCalls(env).catch'), evidence: [E(2220, 'async function reconcileShirCalls', 'הפונקציה')] },
  { id: 'template_check', name_he: 'בדיקת תבניות מטא (שעתית)', layer: 2, from: ['d_pacer'], kind: 'internal',
    conditions: ['פעם בשעה (tmplcheck:<שעה>)', 'תבנית _u/_f שאושרה → מחליפה אוטומטית', 'תבנית חיה שנפסלה/הושהתה → חוזרים לקודמת + סלאק דחוף'],
    kv_markers: { global: ['tmplcheck:<שעה>', 'invitetmpl_img', 'invitetmpl_vid', 'tmplf:<name>', 'tmpllive:<name>', 'tmplbad:<name>:<status>'] },
    source: S(5599, 'await templateCheck(env, out);'), evidence: [E(5399, 'async function templateCheck', 'הפונקציה'), E(5403, "const hourKey = 'tmplcheck:'", 'פעם בשעה')] },
  { id: 'doctor', name_he: 'הרופא (סוף כל פעימה)', layer: 2, from: ['d_pacer'], kind: 'slack',
    conditions: ['גרסה חדשה ליומן', 'תשלומי Grow שחנו', 'pacer:pending ישן → חימוש מחדש', 'כשלי יומן/קורא/תבניות → התראה פעם ביום'],
    kv_markers: { global: ['build:current', 'doctor:<what>:<יום>'] }, live: { pacer: 'doctor' },
    source: S(5609, 'out.doctor = await runDoctor'), evidence: [E(5646, 'async function runDoctor', 'הפונקציה')] },
  { id: 'slack_flush', name_he: 'ריקון תור הסלאק של הלילה', layer: 2, from: ['d_pacer'], kind: 'slack',
    conditions: ['הפעימה הראשונה אחרי 09:00 בישראל, גם כשמושהה'], kv_markers: { global: ['slackqflush:<יום>', 'slackq:list'] },
    source: S(5504, 'await flushSlackQueue(env).catch'), evidence: [E(76, 'export async function flushSlackQueue', 'הפונקציה', 'worker/slack.js')] },

  /* ═════════════ layer 2 · direct every-10-minutes jobs ═════════════ */
  { id: 'event_day_blast', name_he: 'הודעת יום האירוע (edblast)', layer: 2, from: ['t_cron10'], kind: 'send_guest', routes: ['/api/event-day'],
    trigger: { cron: '*/10 * * * *', il: 'מ-09:00 בישראל ובחלון השליחה, מהתאריך job.at', via: 'audit.job runEventDayBlasts' },
    conditions: ['משימה edblast:<token> (נוצרת ב-/api/event-day action:set)', 'התבנית job.template מאושרת במטא', 'נמענים: "מגיע" או מי שקיבל יום-לפני (s5d:)', 'no_table: מדלג על מי שיש לו שולחן', 'לא חסום, לא טעות במספר, paused עוצר'],
    templates: ['ishur_yom_haerua'], audience: 'מגיעים (ומי שקיבל יום-לפני)',
    kv_markers: { per_guest: ['s5e:<token>:<phone>', 'wamid:<id>'], per_event: ['edblast:<token>', 'edblastwarn:<token>:<יום>'] },
    on_failure: { '131048': 'הוובהוק מוחק את s5e: — אבל המשימה edblast: כבר נמחקה אחרי פעימה בלי כשלים סינכרוניים, ולכן אין שליחה חוזרת', other: 'כשל סינכרוני: המשימה נשארת, ינסה בפעימה הבאה' },
    budget: 'אין תקציב לפעימה — כל הנמענים בפעימה אחת',
    warnings: ['hold:<token> לא נבדק בפונקציה הזו — "החזק" לא עוצר את הודעת יום האירוע; לעצור: /api/event-day action:clear', 'כשל תקרה אסינכרוני אחרי שהמשימה נמחקה לא נשלח שוב', 'אין תקציב לפעימה'],
    live: { jobs: ['runEventDayBlasts'] },
    source: S(4080, 'async function runEventDayBlasts'),
    evidence: [E(4091, 'if (!dry && (!due || ilHour < 9 || !sendWindowState().open', 'שער שעה/חלון/paused — בלי hold'), E(4034, 'if (job.no_table && String(g[30]', 'no_table'), E(4107, 'const mk = `s5e:', 'סימון לאורח'), E(9774, "template: String(b.template || 'ishur_yom_haerua')", 'תבנית ברירת המחדל של המשימה'), E(4117, "if (!failed) await env.RATE.delete('edblast:'", 'המשימה נמחקת אחרי פעימה נקייה'), E(9778, "if (b.action === 'clear') { await env.RATE.delete('edblast:'", 'הדרך לעצור'), E(2378, "await env.RATE.put('snapcache'", 'snapshotCached כותב מטמון — גם ב-dry')], mutates_on_dry: true },
  { id: 'call_rounds', name_he: 'סבב שיחות נוסף ביום שנבחר', layer: 2, from: ['t_cron10'], kind: 'internal', routes: ['/api/call-round'],
    trigger: { cron: '*/10 * * * *', il: 'מ-09:00 ביום job.at', via: 'audit.job drainCallRounds' },
    conditions: ['callround:<token> לא done', 'אורחים מהרשימה שעוד לא ענו, נייד ישראלי'], audience: 'כותב V="נדרשת שיחה", AD=0 → התור של שיר',
    kv_markers: { per_event: ['callround:<token>'] }, live: { jobs: ['drainCallRounds'] },
    warnings: ['אין בדיקת paused/hold כאן — אבל החיוג עצמו (shir_dispatch) בודק את שניהם'],
    source: S(4253, 'async function drainCallRounds'), evidence: [E(4265, 'if (!dry && (!due || ilHour < 9)) {', 'שער שעה'), E(4276, 'data.push({ range: `אורחים!V${row}`', 'כתיבה לגיליון')] },
  { id: 'party_nudges', name_he: '"כמה תהיו?" תזכורות כמות', layer: 2, from: ['t_cron10'], kind: 'send_guest',
    trigger: { cron: '*/10 * * * *', il: 'חלון השליחה', via: 'audit.job drainPartyNudges' },
    conditions: ['awaitparty:<guest_id> קיים', 'אחרי שעתיים ואחרי 6 שעות (מקסימום 2)', 'רק אם בגיליון עדיין "מגיע" בלי כמות'],
    templates: [], audience: 'אורח שענה מגיע בלי מספר (טקסט חופשי בתוך חלון 24ש)', kv_markers: { per_guest: ['awaitparty:<guest_id>'] },
    budget: 'אין תקציב · עד 500 מפתחות', warnings: ['לא בודק paused ולא hold — רק חלון שליחה'],
    live: { jobs: ['drainPartyNudges'] },
    source: S(4302, 'async function drainPartyNudges'), evidence: [E(4295, 'const PARTY_NUDGES = [', 'שני השלבים'), E(4304, 'if (!sendWindowState().open) return { sent: 0, closed: true };', 'השער היחיד')] },
  { id: 'lead_pings', name_he: 'ליד חדש לסלאק (אחרי 10 דקות שקט)', layer: 2, from: ['t_cron10'], kind: 'slack',
    conditions: ['leadping:<phone> שהגיע זמנו', 'לא שילם בינתיים'], audience: 'סלאק', kv_markers: { per_guest: ['leadping:<phone>', 'leadslack:<phone>'] },
    live: { jobs: ['drainLeadPings'] },
    source: S(683, 'async function drainLeadPings'), evidence: [E(679, 'const LEAD_PING_QUIET_MS', '10 דקות'), E(691, 'if (Date.now() < Number(t.due || 0)) continue;', 'המתנה')] },
  { id: 'meta_form_leads', name_he: 'לידים מטפסי מטא', layer: 2, from: ['t_cron10'], kind: 'slack',
    conditions: ['כל פעימה: לידים חדשים מטפסים מיידיים'], audience: 'גיליון לידים + מאנדיי + סלאק', kv_markers: { per_guest: ['mlead:<leadgen_id>'] },
    live: { jobs: ['pullMetaFormLeads'] }, source: S(712, 'async function pullMetaFormLeads'), evidence: [E(711, 'mlead:', 'דדופ')] },
  { id: 'custom_tmpl', name_he: 'מעקב נוסח הזמנה אישי במטא', layer: 2, from: ['t_cron10'], kind: 'slack',
    conditions: ['customtmpl:<token> במצב PENDING'], audience: 'סלאק + לוח הלקוח', kv_markers: { per_event: ['customtmpl:<token>'] },
    live: { jobs: ['checkCustomTemplates'] }, source: S(4222, 'async function checkCustomTemplates'), evidence: [E(4229, "if (!rec || rec.status !== 'PENDING' || !rec.name) continue;", 'רק ממתינים')] },
  { id: 'noa_queue', name_he: 'נועה · מענה AI מושהה', layer: 2, from: ['t_cron10'], kind: 'send_client',
    conditions: ['noaq:<phone> שהגיע זמנו (השהיה 1.5–5 דקות, בלילה עד 07:00)'], audience: 'מי שכתב לנועה', kv_markers: { per_guest: ['noaq:<phone>'] },
    live: { jobs: ['drainNoaQueue'] }, source: S(3786, 'async function drainNoaQueue'), evidence: [E(3793, 'if (!force && Date.now() < Number(q.due || 0)) continue;', 'זמן מענה')] },
  { id: 'sales_flow', name_he: 'נועה · זרימת מכירה ללידים (כפתורים, לא AI)', layer: 2, from: ['t_cron10'], kind: 'send_client',
    conditions: ['cfg sales_flow="on" בלבד (ברירת מחדל off) — עונה רק להודעה נכנסת', 'ליד בלבד, 09:00–21:00, בתוך חלון 24ש, עוצר על הערה ידנית במונדי/CRM', 'cfg sales_followups="on" (ברירת מחדל off): תזכורת לשאלה אחרי 60–150 דק׳, הצעת ברירת מחדל ~2ש אחרי, 2 מעקבים אחרי ההצעה'], audience: 'לידים ב-4499', kv_markers: { per_guest: ['sf:<phone>', 'sfseen:<phone>'] },
    live: { jobs: ['salesTick'] }, source: S(1, 'export async function salesTick', 'worker/salesflow.js') },
  { id: 'admin_calls', name_he: 'נועה · שיחה מתוזמנת לאדמין', layer: 2, from: ['t_cron10'], kind: 'call',
    conditions: ['noacall:<phone> שהגיע זמנו', 'רק למספרים ב-ADMIN_PHONES'], audience: 'ריצארד/שלו', kv_markers: { per_guest: ['noacall:<phone>'] },
    live: { jobs: ['drainAdminCalls'] }, source: S(7720, 'async function drainAdminCalls'), evidence: [E(7728, 'const admins = String(env.ADMIN_PHONES', 'רק אדמינים')] },
  { id: 'ads_watch', name_he: 'שומר חשבון המודעות', layer: 2, from: ['t_cron10'], kind: 'slack',
    conditions: ['פעם בשעה', 'מודיע רק כשהמצב השתנה'], audience: 'סלאק', kv_markers: { global: ['adswatch:<שעה>', 'adswatch:last'] },
    live: { jobs: ['adsHealthWatch'] }, source: S(105, 'export async function adsHealthWatch', 'worker/ads.js') },

  /* ═════════════ layer 2 · morning / 04:00 / evening / Tuesday ═════════════ */
  { id: 'morning_undelivered', name_he: 'בוקר · הזמנות שלא נמסרו (סלאק)', layer: 2, from: ['t_morning'], kind: 'slack',
    conditions: ['wfail/wdead/wferr בלי wsent'], audience: 'סלאק', source: S(8863, 'undeliveredLines(await undeliveredByEvent(env, raw)); if (l.length)'),
    evidence: [E(7167, 'async function undeliveredByEvent', 'החישוב')] },
  { id: 'backup', name_he: 'גיבוי יומי של הגיליון ל-KV', layer: 2, from: ['t_morning'], kind: 'internal',
    conditions: ['אחרי המנוע של הבוקר'], kv_markers: { global: ['backup:<יום>'] }, source: S(8865, 'runBackup(env)).then'),
    evidence: [E(5822, 'async function runBackup', 'הפונקציה')] },
  { id: 'perf_digest', name_he: 'שני · ביצועי הודעות (סלאק)', layer: 2, from: ['t_morning'], kind: 'slack',
    conditions: ['רק ביום שני', 'תבניות עם ≥20 שליחות'], audience: 'סלאק', source: S(8871, 'if (dow === 1) return msgPerformanceDigest'),
    evidence: [E(7245, 'async function msgPerformanceDigest', 'הפונקציה')] },
  { id: 'heartbeat', name_he: 'דופק: המנוע לא רץ', layer: 2, from: ['t_0400'], kind: 'slack',
    conditions: ['engine:lastrun ישן מ-30 שעות (ראשון 72, שבת 48)', 'גם בדיקת טלניקס ובדיקת חיוב פעם ביום'], audience: 'סלאק',
    kv_markers: { global: ['engine:lastrun', 'billcheck:<יום>'] }, source: S(8774, 'if (age > limit)'),
    evidence: [E(8773, "const limit = dow === 'Sun' ? 72", 'ספי שעות'), E(7443, 'async function checkBilling', 'בדיקת חיוב'), E(7546, 'async function checkTelnyx', 'טלניקס')] },
  { id: 'daily_improve', name_he: '20:00 · לולאת שיפור יומית', layer: 2, from: ['t_evening'], kind: 'slack',
    conditions: ['השעה בישראל = 20', 'פעם ביום (improve:<יום>)'], audience: 'סלאק', kv_markers: { global: ['improve:<יום>'] },
    live: { jobs: ['runDailyImprove'] }, source: S(8796, 'if (ilHour === 20)'),
    evidence: [E(6907, 'async function runDailyImprove', 'הפונקציה'), E(6910, "if (!opts.analyzeOnly && await env.RATE.get('improve:'", 'פעם ביום')] },
  { id: 'journal_digest', name_he: '21:00 · דוח יומי לסלאק', layer: 2, from: ['t_evening'], kind: 'slack',
    conditions: ['השעה בישראל = 21'], audience: 'סלאק', live: { jobs: ['dailyJournalDigest', 'snapshotTraffic'] }, source: S(8798, '} else if (ilHour === 21)'),
    evidence: [E(7199, 'async function dailyJournalDigest', 'הפונקציה')] },
  { id: 'audit_root', name_he: 'עוגן יומן ביקורת (19 UTC)', layer: 2, from: ['t_evening'], kind: 'slack',
    conditions: ['כל יום בקרון 0 19'], audience: 'סלאק', kv_markers: { global: ['auditroot:<YYYYMMDD>'] }, live: { jobs: ['auditDailyRoot'] },
    source: S(8792, "audit.job(env, 'auditDailyRoot'"), evidence: [E(292, 'export async function dailyRoot', 'החישוב', 'worker/audit.js')] },
  { id: 'team_reminders', name_he: 'תזכורות צוות (שלישי)', layer: 2, from: ['t_tue'], kind: 'send_client',
    conditions: ['רשימה ב-KV reminders לתאריך של היום', 'משבצת ראשונה תמיד; אחר כך רק אם נשאר פתוח', 'נכשל בוואטסאפ (24ש) → לסלאק'],
    templates: [], audience: 'ריצארד / שלו (טקסט חופשי)', kv_markers: { global: ['reminders'] }, live: { jobs: ['runTeamReminders'] },
    source: S(8806, "audit.job(env, 'runTeamReminders'"), evidence: [E(5756, 'async function runTeamReminders', 'הפונקציה'), E(5763, 'const firstSlot = hourUtc === 9;', 'משבצת ראשונה')] },

  /* ═════════════ admin endpoints that MUTATE even when dry ═════════════ */
  { id: 'wave_retry', name_he: '/api/wave-retry · ניסיון חוזר ידני (משנה מצב גם ב-dry!)', layer: 3, from: [], kind: 'internal', routes: ['/api/wave-retry'], mutating: true, mutates_on_dry: true,
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/wave-retry {token, wave, dry}' },
    conditions: ['dry:true מדלג רק על הרצת המנוע — המחיקות והחימוש קורים לפני הבדיקה'],
    kv_markers: { per_guest: ['wfail:', 'wdead:', 'wferr:', 'gday:'], per_event: ['wave:<token>:<k>'], global: ['pacer:pending'] },
    warnings: ['לעולם לא לקרוא מכלי קריאה בלבד: גם dry:true מוחק wfail/wdead/wferr/gday/wave וכותב pacer:pending'],
    source: S(9616, "url.pathname === '/api/wave-retry'"),
    evidence: [E(9623, 'for (const g of list) for (const k of [`wfail:${token}:${w}:${g.phone}`', 'מחיקות לפני בדיקת dry'), E(9624, 'await env.RATE.delete(`wave:${token}:${w}`)', 'פתיחת הגל'), E(9625, "await env.RATE.put('pacer:pending'", 'חימוש'), E(9626, 'const r = b.dry ? { dry: true }', 'dry נבדק רק כאן')] },

  /* ═════════════ 03/11 ops center: jobs the 10-minute tick runs that had no node ═════════════ */
  { id: 'late_invites', name_he: 'הזמנות מאוחרות (אורחים שנוספו אחרי הגל)', layer: 2, from: ['t_cron10'], kind: 'send_guest',
    conditions: ['תור lateinv:<token>:<phone>', 'paused / hold עוצרים'], audience: 'אורחים שנוספו לרשימה אחרי שגל 1 יצא',
    kv_markers: { per_guest: ['lateinv:<token>:<phone>'] }, live: { jobs: ['drainLateInvites'] }, source: S(4390, 'async function drainLateInvites') },
  { id: 'calendar_build', name_he: 'בניית מטמון לוח שנה', layer: 2, from: ['t_cron10'], kind: 'internal',
    conditions: ['כל פעימה, החודש הנוכחי'], audience: '—', live: { jobs: ['buildCalendarMonth'] }, source: S(9223, 'async function buildCalendarMonth') },
  { id: 'noa_chase', name_he: 'נועה רודפת (לידים "לא ענה" במאנדיי)', layer: 2, from: ['t_cron10'], kind: 'call',
    conditions: ['NOA_CHASE="on" בלבד (כרגע off)', 'חלון שיחות'], audience: 'לידים', live: { jobs: ['noaChaseTick'] }, source: S(481, 'export async function noaChaseTick', 'worker/noa.js') },
  { id: 'audit_meta', name_he: 'יומן ביקורת · רענון מטא-דאטה + מראה לגיליון', layer: 2, from: ['t_cron10'], kind: 'internal',
    conditions: ['כל פעימה: evmeta/gmap', 'פעם בשעה: מראה לטאב "ביקורת"'], audience: '—', live: { jobs: ['auditMeta', 'auditMirror'] }, source: S(89, 'export async function refreshMeta', 'worker/audit.js') },
  { id: 'ab_evaluate', name_he: 'A/B · בחירת תבנית מנצחת', layer: 2, from: ['t_cron10'], kind: 'internal',
    conditions: ['AB_ENABLED="on"', '06:00 בישראל'], audience: '—', live: { jobs: ['abEvaluate'] }, source: S(241, 'export async function evaluate', 'worker/ab.js') },
  { id: 'call_cost_sync', name_he: 'סנכרון עלויות שיחה מ-Retell', layer: 2, from: ['t_morning'], kind: 'internal',
    conditions: ['קרון בוקר'], audience: '—', live: { jobs: ['syncCallCosts'] }, source: S(7904, 'async function syncCallCosts') },
  { id: 'manual_blasts', name_he: 'שליחות ידניות (מתנה · אירוע-בן · SMS · ניסיון חוזר · שליחה חוזרת)', layer: 3, from: [], kind: 'send_guest', routes: ['/api/gift-blast', '/api/subevent-send', '/api/sms-blast', '/api/resend'], mutating: true,
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/gift-blast · /api/subevent-send · /api/sms-blast · /api/wave-retry · /api/resend' },
    conditions: ['אדמין בלבד', 'כבוי (auto:off:manual_blasts) → כל המסלולים מחזירים 423 לפני כל קריאה החוצה; /api/wave-retry חסום גם ב-dry כי הוא משנה מצב'],
    audience: 'אורחים של אירוע אחד', source: S(4491, 'async function handleGiftBlast') },

  /* ═════════════ 03/11 change log: nodes found by scripts/registry-sync.mjs (test/registry-sync.test.mjs) ═════════════
     `added` = the day the node entered the registry (the ops center shows "חדש" for 7 days).
     `routes[]` = the admin POST routes that start this automation by hand. */
  { id: 'brain_health', name_he: 'המוח · בדיקות בריאות (כל 10 דקות)', layer: 2, from: ['t_cron10'], kind: 'slack', added: '2026-11-03',
    trigger: { cron: '*/10 * * * *', il: 'כל 10 דקות (כל בדיקה לפי every_min שלה)', via: 'scheduled → runBrain · POST /api/ops/brain-run' }, routes: ['/api/ops/brain-run'],
    conditions: ['BRAIN_ENABLED != "off"', 'כל בדיקה רצה רק כשעבר every_min מהריצה הקודמת שלה'], audience: 'ריצ׳רד (סלאק + מסך המוח)',
    checks: ['template_watch', 'cap_hold_stale', 'pacer_tick', 'snapshot_fail', 'noa_billing', 'telnyx_order', 'lead_monday', 'reply_wrong_number', 'capacity_overflow', 'noa_unanswered', 'balances_low', 'crm_overdue', 'd1_ledger', 'failed_runs', 'biz_verification', 'gift_blast', 'wedding_day', 'call_round_not_dialing'],
    source: S(504, 'export async function runBrain', 'worker/brain.js'), evidence: [E(9787, 'ctx.waitUntil(runBrain(env', 'הקרון של 10 הדקות מריץ את המוח')] },
  { id: 'brain_fix', name_he: 'המוח · פלייבוקים (תיקון אוטומטי או באישור)', layer: 3, from: ['brain_health'], kind: 'internal', added: '2026-11-03',
    trigger: { cron: '', il: 'כשבדיקה מוצאת ממצא עם פלייבוק', via: 'execPlaybook · POST /api/ops/brain-decision' }, routes: ['/api/ops/brain-decision'],
    conditions: ['auto:true → רץ מיד (cooldown לכל ממצא)', 'auto:false → פעולה ממתינה לאישור עם מילת אישור', 'כל ביצוע נרשם ביומן השינויים (kind brain)'], audience: 'לפי הפלייבוק',
    playbooks: ['cap_probe_release', 'snapshot_retry', 'lead_monday_create', 'capacity_warning', 'template_variant', 'event_hold', 'eventday_retry', 'gift_blast_resume', 'requeue_reply', 'telnyx_nudge', 'call_round_kick'],
    source: S(567, 'export async function execPlaybook', 'worker/brain.js') },
  { id: 'brain_agent', name_he: 'המוח · הסלמה לסוכן חיצוני', layer: 3, from: ['brain_health'], kind: 'slack', added: '2026-11-03',
    trigger: { cron: '', il: 'ממצא בלי פלייבוק', via: 'escalate → claude.ai routine trigger' },
    conditions: ['רק ממצאים שאף פלייבוק לא מטפל בהם', 'הסוכן כותב את ההיגיון שלו ל-/api/ops/run-log'], audience: 'סוכן חיצוני + סלאק',
    source: S(606, 'async function escalate(env, d, c, f, parentRun)', 'worker/brain.js') },
  { id: 'subevent_continue', name_he: 'אירוע-בן · המשך שליחה אוטומטי עד הסוף', layer: 2, from: ['d_pacer', 'manual_blasts'], kind: 'send_guest', added: '2026-11-04',
    trigger: { cron: '*/10 * * * *', il: 'כל פעימת פייסר בתוך חלון השליחה', via: "runPacer step('subevent_continue') → continueSubevents" },
    conditions: ['רק תת-אירוע שהתחיל ידנית ("שלח" של ריצ׳רד = started_at, או סימון shsent קיים) — אף פעם לא מתחיל לבד', 'בלי completed_at', 'חלון שליחה פתוח, לא paused, לא חג, יש מקום בתקרה',
      'פרוסה = min(25, מקום בתקרה); תקרה 0 → מוחזק', 'פרוסה שלא השאירה ממתינים/כשלים → completed_at + יומן שינויים + סלאק "<שם>: הושלם, נשלחו X"', 'אורח שנכשל 3 פעמים (shfail) מדולג', 'מתג כיבוי auto:off:subevent_continue'],
    templates: ['ishur_shabat_hatan_zaguri'], audience: 'אורחי אירוע-האב (שורות חיות, בלי העתקה)',
    kv_markers: { per_guest: ['shsent:<sub>:<phone>', 'shfail:<sub>:<phone>'], per_event: ['subevent:<sub>.started_at', 'subevent:<sub>.completed_at'] },
    budget: 'min(25, guestCapacity.remaining) לכל פעימה', live: { pacer: 'subevents' },
    source: S(290, 'export async function continueSubevents', 'worker/subevent.js'),
    evidence: [E(291, "isOff(env, 'subevent_continue')", 'מתג הכיבוי נבדק ראשון', 'worker/subevent.js'), E(313, 'completed_at: new Date', 'סימון הושלם', 'worker/subevent.js'), E(6500, "step('subevent_continue'", 'הפייסר מריץ אותו בחלון השליחה')] },
  { id: 'call_round_watch', name_he: 'המוח · סבב שיחות לא מחייג (+ הפעלה מחדש באישור)', layer: 3, from: ['brain_health', 'call_rounds', 'shir_dispatch'], kind: 'slack', added: '2026-11-04',
    trigger: { cron: '*/10 * * * *', il: '10:00–19:00 (מ-10:20), כל 10 דקות', via: 'brain check call_round_not_dialing → playbook call_round_kick (auto:false)' },
    conditions: ['אירוע עם סבב שיחות פעיל: callround:<token> / callsaddon:<token> / מסלול שכולל שיחות (לא בסיס)', 'יש בתור אורחים שאפשר לחייג היום (לא shirtry היום)', '0 חיוגים לאירוע ב-60 הדקות האחרונות (calllast:<token>)',
      'ממצא P1 עם הסיבה: שעות / חג / paused / מתג כיבוי / hold / callstop / תקרה יומית / Retell', 'ההתראה לסלאק יוצאת מהמוח; הפלייבוק call_round_kick מריץ runShirDispatch רק אחרי אישור'],
    audience: 'ריצ׳רד (סלאק + מסך המוח)', kv_markers: { per_event: ['calllast:<token>', 'callround:<token>', 'callsaddon:<token>'] },
    source: S(285, "{ id: 'call_round_not_dialing'", 'worker/brain.js'),
    evidence: [E(471, "{ id: 'call_round_kick'", 'auto:false — מחייג רק באישור', 'worker/brain.js')] },
  { id: 'crm_lead_send', name_he: 'CRM · הודעה מהירה לליד מנועה 4499', layer: 3, from: [], kind: 'send_client', mutating: true, added: '2026-11-03',
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/crm/leads {id, action:"send", text, confirm:true}' }, routes: ['/api/crm/leads'],
    conditions: ['רק בתוך חלון 24 השעות של הליד (אחרת needs_template)', 'לא 21:00–09:00 ולא בשבת', 'בלי confirm:true → תצוגה מקדימה בלבד'], audience: 'ליד אחד',
    source: S(455, 'async function sendLead(env, d, store, lead, b', 'worker/crm.js') },
  { id: 'outreach', name_he: 'פנייה יזומה (אולמות/מפיקים)', layer: 3, from: [], kind: 'send_client', mutating: true, added: '2026-11-03',
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/outreach' }, routes: ['/api/outreach'],
    conditions: ['OUTREACH_ENABLED="on"', 'אדמין בלבד'], audience: 'רשימת פנייה (אימייל / וואטסאפ 4499)',
    source: S(391, 'export async function handleOutreach(request', 'worker/outreach.js') },
  { id: 'guest_text', name_he: 'טקסט חופשי לאורח (מהאדמין)', layer: 3, from: [], kind: 'send_guest', mutating: true, added: '2026-11-03',
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/guest-text' }, routes: ['/api/guest-text'],
    conditions: ['אדמין בלבד', 'רק בתוך חלון 24 השעות של האורח'], audience: 'אורח אחד',
    source: S(10590, "url.pathname === '/api/guest-text'") },
  { id: 'client_link', name_he: 'קישור ללוח/העלאה ללקוח (כפתור או תבנית)', layer: 3, from: [], kind: 'send_client', mutating: true, added: '2026-11-03',
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/client-link' }, routes: ['/api/client-link'],
    conditions: ['אדמין בלבד', 'בתוך 24 שעות: כפתור; אחרת התבנית ishur_tzikoret_kovetz / ishur_doch'], audience: 'לקוח אחד',
    templates: ['ishur_tzikoret_kovetz', 'ishur_doch'], source: S(10681, "url.pathname === '/api/client-link'") },
  { id: 'invoice_manual', name_he: 'חשבונית ידנית + שליחה ללקוח (שחזור)', layer: 3, from: [], kind: 'send_client', mutating: true, added: '2026-11-03',
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/evlog {action:"invoice-make"}' }, routes: ['/api/evlog'],
    conditions: ['אדמין בלבד', 'שולח רק כשיש תבנית ב-invoicetmpl ו-send != false'], audience: 'לקוח אחד',
    source: S(10090, "if (b.action === 'invoice-make')") },
  { id: 'voice_test_call', name_he: 'שיחת בדיקה מסוכן קולי', layer: 3, from: [], kind: 'call', mutating: true, added: '2026-11-03',
    trigger: { cron: '', il: 'ידני בלבד', via: 'POST /api/voice-tools' }, routes: ['/api/voice-tools'],
    conditions: ['אדמין בלבד', 'סוכן מתוך VOICE_AGENTS'], audience: 'המספר שהאדמין נתן',
    source: S(7457, 'async function handleVoiceTools(request') },
  { id: 'wa_send', name_he: 'גשר שליחה (/api/wa-send) למייק ולכלים', layer: 3, from: [], kind: 'send_guest', mutating: true, added: '2026-11-03',
    trigger: { cron: '', il: 'ידני / Make', via: 'POST /api/wa-send' }, routes: ['/api/wa-send'],
    conditions: ['אדמין בלבד', 'modes: text | image | template | invite'], audience: 'נמען אחד',
    source: S(9267, 'async function handleWaSend(request') },

  /* ═════════════ layer 3 · reactions ═════════════ */
  { id: 'wa_fail', name_he: 'כשל מסירה ממטא → פתיחה מחדש', layer: 3, from: ['t_wa_status'], kind: 'internal',
    trigger: { cron: '', il: 'מיידי', via: 'handleWaWebhook — status failed' },
    conditions: ['רק הודעות עם wamid:<id> רשום (גלים, שולחן, יום-לפני, יום האירוע, דחייה, לידים)', 'פעם אחת לכל wamid (wafail:)'],
    kv_markers: { per_guest: ['wamid:<id>', 'wamidpid:<id>', 'wferr:', 'wfail:', 'wdead:', 'gday:'], per_event: ['wave:<token>:<k>', 'daybefore:<token>', 'seat:<token>'], global: ['wacap:<phoneId>', 'wacap:guests', 'pacer:pending'] },
    on_failure: { '131048': CAP_REOPEN + '; לשלבי שולחן/יום-לפני גם דגל האירוע נמחק', '130429': 'כמו 131048', '131026': 'wdead מיד', other: 'עד 3 ניסיונות: מחיקת הסימון + pacer:pending; בשלישי wdead + שורת הסרות' },
    source: S(2922, "const capHit = code === '131048'"),
    evidence: [E(2907, "if (st.id && await seenOnce(env, 'wafail:' + st.id)) continue;", 'פעם אחת'), E(2928, 'const lifeFlag = {', 'דגלי שולחן/יום-לפני'), E(2937, "await env.RATE.put('wacap:guests'", 'עצירה גלובלית'), E(2947, "const n = code === '131026' ? 3", 'ספירת ניסיונות'), E(2950, 'wdead:${m.token}', 'מת אחרי 3')] },
];

/* edges for the map: from → id, plus the reopen edges the webhook draws */
export function edges() {
  const out = [];
  for (const n of AUTOMATIONS) for (const f of n.from || []) out.push({ from: f, to: n.id });
  for (const to of ['wave1', 'wave2', 'seating', 'day_before']) out.push({ from: 'wa_fail', to, kind: 'reopen' });
  return out;
}

/* template name as sent → registry name (footer _f and portfolio _n copies) */
export function baseTemplate(name) { return String(name || '').replace(/_(f|n)$/, ''); }

/* ═════════════ 03/11 · ops center metadata (docs/OPS-CENTER-PLAN-2026-11-03.md §3a) ═════════════
   Per node, on top of the description above:
     owner         who answers for it
     side_effects  wa_guest | wa_client | call | sms | email | sheet | kv | monday | slack | money | meta
     kill_switch   { key: 'auto:off:<id>', wired: true } — wired = the code checks the key before acting
                   (index.js, look for isOff(env, '<id>')); null = no per-automation switch (only `paused`)
     depends_on    upstream ids (defaults to from[])
     risk          high | medium | low
     desc_he       plain Hebrew, one sentence
     code          { file, symbol } — the function shown by /api/ops/code (defaults to source);
                   worker/registry-code.json holds the resolved lines (scripts/ops-snapshot-code.mjs) */
export const KILL_SWITCH_IDS = ['d_pacer', 'wave1', 'wave2', 'wave3', 'event_day_blast', 'autoretry', 'shir_dispatch', 'shir_callbacks', 'manual_blasts', 'party_nudges', 'subevent_continue'];
const KS = id => ({ key: 'auto:off:' + id, wired: true });
const C = (symbol, file = IX) => ({ file, symbol });
const OPS_OVERRIDES = {
  t_cron10:   { code: C('async scheduled(event, env, ctx)'), desc_he: 'השעון של הכל: כל 10 דקות מריץ את המשימות ואת הפייסר.' },
  t_morning:  { code: C('async scheduled(event, env, ctx)'), desc_he: 'קרון הבוקר: מחמש את היום ומריץ את המנוע היומי.' },
  t_0400:     { code: C('async scheduled(event, env, ctx)'), desc_he: 'בדיקת דופק בוקר: המנוע רץ? יתרות טלניקס וחיוב.' },
  t_evening:  { code: C('async scheduled(event, env, ctx)'), desc_he: 'קרונות ערב: לולאת שיפור ב-20:00 ודוח יומי ב-21:00.' },
  t_tue:      { code: C('async scheduled(event, env, ctx)'), desc_he: 'שלישי: תזכורות לצוות הדיילות.' },
  t_wa_status:{ side_effects: ['kv', 'wa_guest', 'slack'], risk: 'high', desc_he: 'כל דיווח של מטא על הודעה (נמסרה/נכשלה) ותשובה נכנסת עובר כאן.' },
  d_pacer:    { kill_switch: KS('d_pacer'), side_effects: ['wa_guest', 'wa_client', 'call', 'kv', 'slack', 'sheet'], risk: 'high',
                desc_he: 'הפייסר: כל 10 דקות שולח פרוסה של הודעות (25) וחיוגים (6), מריץ ניסיון חוזר, רדיפת לידים ובדיקות.' },
  d_engine:   { side_effects: ['wa_guest', 'wa_client', 'kv', 'sheet', 'slack'], risk: 'high', desc_he: 'המנוע היומי: מחליט לכל אירוע מה יוצא היום (גלים, יום-לפני, שולחן, תודה, דוחות ללקוח).' },
  wave1:      { kill_switch: KS('wave1'), code: C('async function sendWave'), risk: 'high', desc_he: 'גל 1: ההזמנה הראשונה לכל האורחים של האירוע.' },
  wave2:      { kill_switch: KS('wave2'), code: C('async function sendWave'), risk: 'high', desc_he: 'גל 2: תזכורת למי שלא ענה או מתלבט.' },
  wave3:      { kill_switch: KS('wave3'), code: C('async function sendWave'), risk: 'high', desc_he: 'גל 3: שליחה נוספת (תוסף בתשלום).' },
  autoretry:  { kill_switch: KS('autoretry'), side_effects: ['kv', 'wa_guest'], risk: 'high', code: C('async function runPacer'),
                desc_he: 'פעם ביום בחלון השליחה: פותח מחדש אורחים שההזמנה שלהם לא נמסרה, כדי שהגל ישלח להם שוב.' },
  lead_chase: { side_effects: ['wa_client', 'kv'], risk: 'medium', code: C('async function chaseAbandonedLeads') },
  shir_callbacks: { kill_switch: KS('shir_callbacks'), side_effects: ['call', 'kv', 'money'], risk: 'high', code: C('async function runShirCallbacks'),
                desc_he: 'שיר מחזירה שיחה למי שהתקשר אלינו ולא נענה.' },
  shir_dispatch:  { depends_on: ['d_pacer'], kill_switch: KS('shir_dispatch'), side_effects: ['call', 'kv', 'sheet', 'money'], risk: 'high', code: C('async function runShirDispatch'),
                desc_he: 'שיר מחייגת לאורחים שלא ענו בוואטסאפ (תור "נדרשת שיחה").' },
  noa_lead_dial:  { side_effects: ['call', 'money'], code: C('async function runShirLeadDial') },
  reconcile_calls:{ side_effects: ['sheet', 'kv'], code: C('async function reconcileShirCalls') },
  template_check: { side_effects: ['meta', 'kv', 'slack'], code: C('async function templateCheck') },
  doctor:     { side_effects: ['kv', 'slack'], code: C('async function runDoctor') },
  event_day_blast: { kill_switch: KS('event_day_blast'), risk: 'high', code: C('async function runEventDayBlasts'),
                desc_he: 'ביום האירוע מ-09:00: ההודעה שהלקוח קבע לאורחים שמגיעים.' },
  call_rounds:{ code: C('async function drainCallRounds') },
  subevent_continue: { kill_switch: KS('subevent_continue'), side_effects: ['wa_guest', 'kv', 'slack'], risk: 'high', code: C('export async function continueSubevents', 'worker/subevent.js'),
                desc_he: 'ממשיך תת-אירוע (שבת חתן) שריצ׳רד התחיל: 25 בכל פעימה בתוך התקרה עד שכולם קיבלו, ואז "הושלם" לסלאק.' },
  party_nudges: { kill_switch: KS('party_nudges'), risk: 'medium', code: C('async function drainPartyNudges'),
                desc_he: 'שואל אורח שענה "מגיע" כמה יגיעו, כשלא כתב מספר.' },
  lead_pings: { code: C('async function drainLeadPings') },
  meta_form_leads: { side_effects: ['sheet', 'monday', 'slack'], code: C('async function pullMetaFormLeads') },
  custom_tmpl:{ code: C('async function checkCustomTemplates') },
  noa_queue:  { side_effects: ['wa_client'], code: C('async function drainNoaQueue'), desc_he: 'תשובות מושהות של נועה ה-AI. כבוי בהחלטה — לא להדליק.' },
  sales_flow: { side_effects: ['wa_client', 'slack', 'kv'], code: C('export async function salesTick', 'worker/salesflow.js'), desc_he: 'זרימת מכירה דטרמיניסטית ללידים ב-4499: 3 שאלות, שאלת עיצוב, הצעה אחת עם קישור ממולא. כבוי עד שריצארד מדליק (cfg sales_flow).' },
  admin_calls:{ code: C('async function drainAdminCalls') },
  ads_watch:  { code: C('export async function adsHealthWatch', 'worker/ads.js') },
  backup:     { side_effects: ['kv'], code: C('async function runBackup') },
  perf_digest:{ code: C('async function msgPerformanceDigest') },
  heartbeat:  { side_effects: ['slack', 'meta'], code: C('async function checkBilling') },
  daily_improve: { code: C('async function runDailyImprove') },
  journal_digest:{ code: C('async function dailyJournalDigest') },
  audit_root: { code: C('export async function dailyRoot', 'worker/audit.js') },
  team_reminders:{ side_effects: ['wa_client'], code: C('async function runTeamReminders') },
  wave_retry: { side_effects: ['kv', 'wa_guest'], risk: 'high', kill_switch: { key: 'auto:off:manual_blasts', wired: true, via: 'manual_blasts' } },
  wa_fail:    { side_effects: ['kv'], risk: 'high', code: C('async function handleWaWebhook') },
  late_invites: { risk: 'medium' },
  manual_blasts:{ kill_switch: KS('manual_blasts'), side_effects: ['wa_guest', 'sms', 'kv'], risk: 'high',
                desc_he: 'כל השליחות הידניות לאורחים: קישורי מתנה, אירוע-בן (שבת חתן), SMS חירום, ניסיון חוזר לגל, שליחה חוזרת.' },
};
const SIDE_BY_KIND = { send_guest: ['wa_guest', 'kv'], send_client: ['wa_client', 'kv'], call: ['call', 'kv'], slack: ['slack'], internal: ['kv'], trigger: [] };
const RISK_BY_KIND = { send_guest: 'medium', send_client: 'medium', call: 'medium', slack: 'low', internal: 'low', trigger: 'low' };
export function opsMeta(n) {
  const o = OPS_OVERRIDES[n.id] || {};
  return {
    owner: o.owner || 'richard',
    side_effects: o.side_effects || SIDE_BY_KIND[n.kind] || [],
    kill_switch: o.kill_switch || null,
    depends_on: o.depends_on || (n.from || []).slice(),
    risk: o.risk || RISK_BY_KIND[n.kind] || 'low',
    desc_he: o.desc_he || [n.name_he, (n.conditions || [])[0]].filter(Boolean).join(' — '),
    code: o.code || (n.source ? { file: n.source.file, symbol: n.source.symbol } : null),
  };
}
/* audit.job name → registry id (the ledger's automation_id) */
export const JOB_TO_ID = {
  runPacer: 'd_pacer', adsHealthWatch: 'ads_watch', drainLeadPings: 'lead_pings', pullMetaFormLeads: 'meta_form_leads',
  drainPartyNudges: 'party_nudges', runEventDayBlasts: 'event_day_blast', drainLateInvites: 'late_invites', drainCallRounds: 'call_rounds',
  checkCustomTemplates: 'custom_tmpl', buildCalendarMonth: 'calendar_build', drainNoaQueue: 'noa_queue', drainAdminCalls: 'admin_calls', salesTick: 'sales_flow',
  noaChaseTick: 'noa_chase', auditMeta: 'audit_meta', auditMirror: 'audit_meta', abEvaluate: 'ab_evaluate', syncCallCosts: 'call_cost_sync',
  auditDailyRoot: 'audit_root', runDailyImprove: 'daily_improve', snapshotTraffic: 'journal_digest', dailyJournalDigest: 'journal_digest',
  runTeamReminders: 'team_reminders',
};
/* balance thresholds (/api/ops/balances): status 'low' when amount < low (null = no threshold) */
export const BALANCE_LOW = { telnyx: 10, meta_ads: 50, cloudflare: null, meta_wa: null, retell: 20, anthropic: 10 };
