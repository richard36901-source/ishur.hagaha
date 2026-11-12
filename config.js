/* ============================================================================
   ishur.io · config
   ----------------------------------------------------------------------------
   One file. Both site versions and both upload forms read from it.
   Nothing below should ever be duplicated inside a page.

   Fill the FILL ME block, everything else already works.
   ========================================================================== */

window.ISHUR_CONFIG = (function () {

  /* ══ FILL ME ══════════════════════════════════════════════════════════════
     Empty string = not configured yet. Every consumer degrades safely:
     a missing webhook is skipped silently, a missing payment link falls back
     to WhatsApp, a missing GTM id skips the container.
     ─────────────────────────────────────────────────────────────────────── */

  var MAKE_LEAD_WEBHOOK   = '';   // held by the Worker as a secret
  var MAKE_UPLOAD_WEBHOOK = '';   // held by the Worker as a secret
  /* Flip to true once worker/ is deployed, and paste its URL below. Every
     request then goes through the proxy and the Make URLs can be deleted from
     this file, which is the only way to stop them being public. */
  var USE_PROXY  = true;
  /* 29/09: a client on 4G could not load the dashboard — Israeli carriers
     filter *.workers.dev. go.ishur.io is the same Worker on our own domain. */
  var PROXY_BASE = 'https://go.ishur.io';

  var MAKE_STATUS_WEBHOOK = '';   // held by the Worker as a secret
                                         // dashboard reads event + guest status
                                         // from here. POST {token} -> JSON,
                                         // shape documented in HANDOFF.md.
  var MAKE_CHANGE_WEBHOOK = '';
                                         // Falls back to the setup hook.
  var MAKE_SETUP_WEBHOOK  = '';
                                         // Can be the same URL as the upload
                                         // hook; the payload is tagged
                                         // event_type: 'event_setup'.
  var GTM_ID              = '';          // GTM-XXXXXXX
  var FB_PIXEL_ID         = '1412366810814749';  // dataset "ishur.io" in the Ishur.io portfolio (same as the ad account); replaced the AutoScale-portfolio one 01.09.26 to dodge cross-portfolio sharing that Meta gates for new portfolios
  var TIKTOK_PIXEL_ID     = '';          // TikTok pixel id, optional
  var GA4_ID              = 'G-H21EMT09HL';  // GA4 property for ishur.io, owned by ishurhagaha@gmail.com
  /* PostHog: product analytics — funnels across the 14 landing pages, session
     replay, feature flags and A/B tests. GA4 answers "how many"; this answers
     "where did they give up". Stays dormant until the key is filled, exactly
     like the pixels above. Project key from posthog.com → Project Settings.
     The project (595055) was created on US Cloud, so the host must match it. */
  var POSTHOG_KEY         = 'phc_ssZmdzSM6zeFfDjvygobpNUd5zNQUnPTnBQ4pbsmRoC7';
  /* go.ishur.io/ph/* reverse-proxies to us.i.posthog.com (project 595055,
     US Cloud) through the Worker (Phase 8 housekeeping) — ad-blockers that
     catch analytics hostnames by name were costing 10-25% of events, and a
     first-party-looking path is not one of the names on those lists. */
  var POSTHOG_HOST        = 'https://go.ishur.io/ph';

  /* Support line, 055-950-4499. This is the number leads and clients talk to:
     every "questions?" link on the site, the over-900 handoff, the upload
     fallback and the post-payment page all point here.
     It is NOT the number guest invitations are sent from. Do not swap them. */
  var WHATSAPP_NUMBER     = '972559504499';   // digits only, country code, no +
  var SUPPORT_PHONE       = '0559504499';     // for tel: links
  var SUPPORT_EMAIL       = 'info@ishur.io';

  var TEMPLATE_URL        = '';          // sample .xlsx for the upload form. empty hides the row

  /* ══ PACKAGES ═════════════════════════════════════════════════════════════ */

  var PLANS = {
    basic: {
      key: 'basic', name: 'בסיס', label: 'BASE',
      desc: 'שליחת הזמנה + דף מעקב 24/7 + תזכורת יום לפני + סידורי הושבה + ניהול תקציב אירוע + קישור מתנות ביט/פייבוקס',
      features: [
        'הזמנה דיגיטלית לאורחים בוואטסאפ',
        '2 הודעות אישורי הגעה (הזמנה + תזכורת למי שלא ענה)',
        'דף מעקב 24/7 מי אישר',
        'תזכורת יום לפני עם כתובת האולם וניווט',
        'סידורי הושבה, ניהול תקציב, קישור מתנות ביט/פייבוקס',
        'עד 10 מוזמנים נוספים חינם'
      ]
    },
    pro: {
      key: 'pro', name: 'פרמיום', label: 'PREMIUM',
      desc: 'שליחת הזמנה + דף מעקב 24/7 + תזכורת יום לפני + סבב שיחות אחד + הודעת תודה יום אחרי + סידורי הושבה + ניהול תקציב אירוע + קישור מתנות ביט/פייבוקס',
      features: [
        'כל מה שבחבילת בסיס',
        'סבב שיחות מסוכן AI למי שלא ענה ולמתלבטים',
        'הודעת תודה לאורחים יום אחרי האירוע',
        'דוח מסודר ביום האירוע'
      ]
    },
    premium: {
      key: 'premium', name: 'הכל כלול', label: 'ALL INCLUSIVE',
      desc: 'שליחת הזמנה + דף מעקב 24/7 + תזכורת יום לפני + 3 סבבי שיחות + הודעת דחייה או ביטול + הודעת תודה יום אחרי האירוע + סידורי הושבה + ניהול תקציב אירוע + קישור מתנות ביט/פייבוקס',
      features: [
        'כל מה שבחבילת פרמיום',
        '3 סבבי שיחות מסוכן AI',
        'טיפול ידני במוזמנים שלא עונים',
        'הודעת דחייה או עדכון מועד',
        'הודעת ביטול אירוע',
        'עדיפות בתמיכה'
      ]
    }
  };

  var PLAN_ORDER = ['basic', 'pro', 'premium'];

  /* ══ GUEST TIERS ══════════════════════════════════════════════════════════
     value is what the payment links and price table are keyed on.
     'custom' = over 900, no self-serve payment, routed to WhatsApp.
     ─────────────────────────────────────────────────────────────────────── */

  /* A tier counts phone numbers, not people. One family on one number is one
     invitation however many seats it covers, so the wording says רשומות (Richard 22/09). */
  var GUEST_TIERS = [
    { value: '50',     label: 'עד 50 רשומות' },
    { value: '100',    label: 'עד 100 רשומות' },
    { value: '200',    label: 'עד 200 רשומות' },
    { value: '300',    label: 'עד 300 רשומות' },
    { value: '400',    label: 'עד 400 רשומות' },
    { value: '500',    label: 'עד 500 רשומות' },
    { value: '600',    label: 'עד 600 רשומות' },
    { value: '700',    label: 'עד 700 רשומות' },
    { value: '800',    label: 'עד 800 רשומות' },
    { value: '900',    label: 'עד 900 רשומות' },
    { value: 'custom', label: 'מעל 900 רשומות' }
  ];

  /* ══ PRICES ═══ ₪ per event, by guest tier × package ══════════════════════ */

  /* pro sits deliberately CLOSE to premium, not close to basic. At +20 over
     basic it was a free upgrade nobody had to think about; at ~55% of the gap
     it forces the real question — with calls or without — and once someone
     says "with", the last 70-130 for all three rounds is the easy yes. */
  var PRICE_TABLE = {
    50:  { basic: 50,  pro: 95,   premium: 140 },
    100: { basic: 99,  pro: 149,  premium: 199 },
    200: { basic: 199, pro: 279,  premium: 339 },
    300: { basic: 299, pro: 379,  premium: 449 },
    400: { basic: 399, pro: 489,  premium: 559 },
    500: { basic: 499, pro: 589,  premium: 669 },
    600: { basic: 599, pro: 699,  premium: 789 },
    700: { basic: 699, pro: 819,  premium: 919 },
    800: { basic: 799, pro: 929,  premium: 1049 },
    900: { basic: 899, pro: 1049, premium: 1179 }
  };

  /* ══ SPECIAL BUNDLES ═══ a dedicated link (?offer=<key>) that opens the order
     pre-filled and prices package + hostesses at one agreed number. The real
     total from the tables is struck through next to it. The Worker holds the
     same table and is the one that actually prices the Grow link. ═══════════ */
  var BUNDLES = {
    vip1990: { plan: 'premium', hostesses: 2, guests: [300, 400, 500], total: 1990, label: 'הכל כלול + 2 דיילות', note: 'מחיר מיוחד' },
    /* 01/11: winter deal — the same ₪1,990 all the way up to 800 records */
    /* anyPlan: whatever package they tick, with hostesses the price is capped at
       the bundle total and they get הכל כלול for it (Richard 01/11) */
    /* Richard 03/11 20:20 (final): with hostesses it is ALWAYS a bundle. Up to
       700 records: 1 hostess ₪1,790, 2 hostesses ₪1,990. Above 700: 2 hostesses
       ₪2,390, 3 hostesses ₪2,590. Mirrors worker/paylink.js BUNDLES. */
    winter1990: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 2, guests: [50, 100, 200, 300, 400, 500, 600, 700], total: 1990, label: 'הכל כלול + 2 דיילות עד 700 רשומות', note: 'מבצע חורף', until: '2026-11-30T23:59:59+02:00' },
    winter1790: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 1, guests: [50, 100, 200, 300, 400, 500, 600, 700], total: 1790, label: 'הכל כלול + דיילת אחת עד 700 רשומות', note: 'מבצע חורף', until: '2026-11-30T23:59:59+02:00' },
    winter2390: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 2, guests: [800, 900], total: 2390, label: 'הכל כלול + 2 דיילות מעל 700 רשומות', note: 'מבצע חורף', until: '2026-11-30T23:59:59+02:00' },
    winter2590: { plan: 'premium', anyPlan: true, travel: 250, hostesses: 3, guests: [800, 900], total: 2590, label: 'הכל כלול + 3 דיילות מעל 700 רשומות', note: 'מבצע חורף', until: '2026-11-30T23:59:59+02:00' }
  };
  function bundleFor(key) { return (key && BUNDLES[key]) || null; }
  /* a dated bundle stops applying the second its clock runs out (Richard 01/11:
     "after it ends we really do not discount") */
  function bundleLive(b) { return !!b && (!b.until || Date.now() <= Date.parse(b.until)); }
  /* 03/11 20:20: the live bundle for a records tier + hostess count (any plan),
     the same order as worker/paylink.js pickBundle */
  function bundlePick(guests, n) {
    var g = parseInt(guests, 10), order = ['vip1990', 'winter1990', 'winter1790', 'winter2390', 'winter2590'];
    for (var i = 0; i < order.length; i++) { var b = BUNDLES[order[i]]; if (b && bundleLive(b) && b.hostesses === n && b.guests.indexOf(g) > -1) return b; }
    return null;
  }
  function bundleKeyOf(b) { for (var k in BUNDLES) if (BUNDLES[k] === b) return k; return ''; }
  /* hostess counts per tier + their bundle price (3 only above 700) */
  function bundleTable(guests) { return parseInt(guests, 10) > 700 ? { 2: 2390, 3: 2590 } : { 1: 1790, 2: 1990 }; }
  /* does the bundle cover what is on screen? plan + quantity in its range */
  function bundleApplies(b, guests, plan, hostess) {
    if (!b || !hostess || !bundleLive(b)) return false;
    var n = parseInt(guests, 10);
    /* 03/11: the bundle's hostess count must match the size rule (300+ → 2) */
    var t = hostessTier(n);
    if (b.hostesses && t && t.count !== b.hostesses) return false;
    return (b.anyPlan || plan === b.plan) && b.guests.indexOf(n) > -1;
  }

  /* ══ PAYMENT ═══ Grow links, keyed '<guests>_<plan>' ══════════════════════ */

  var GROW_LINKS = {
    '50_basic':    'https://pay.grow.link/63837d8806ad3fddd77d2c4de191f6d6-MzMwMDM0OA',
    '50_pro':      'https://pay.grow.link/d9c255f8a1ab7b16700779b251519c09-MzMwMDM1Mw',
    '50_premium':  'https://pay.grow.link/9b22787a5822cef6825fb217b6691bb0-MzMwMDM1NQ',
    '100_basic':   'https://pay.grow.link/d633fac130d3bc882a15868b286bb09e-MzMwMDM1OQ',
    '100_pro':     'https://pay.grow.link/f671ceaf46b8c41c2eaf0a0fd092dc5f-MzMwMDM2MQ',
    '100_premium': 'https://pay.grow.link/20432f1e23930c44550bfb5fa969a255-MzMwMDM2Mg',
    '200_basic':   'https://pay.grow.link/3d5abb2f20d11d103530ee4f1aa351e6-MzMwMDM2NQ',
    '200_pro':     'https://pay.grow.link/0c517d7cab0a7aae5a66a9a2f99cad6c-MzMwMDM2Nw',
    '200_premium': 'https://pay.grow.link/7a4036d47428b14a1c855b689bd928a0-MzMwMDM2OQ',
    '300_basic':   'https://pay.grow.link/7300295e529fbbef06ad003997fff37e-MzMwMDM3MA',
    '300_pro':     'https://pay.grow.link/3652a9284848893900dd4d931b7da4fa-MzMwMDM3Mg',
    '300_premium': 'https://pay.grow.link/e3fc1b79a12f43b21a540012ab2c6a16-MzMwMDM3Mw',
    '400_basic':   'https://pay.grow.link/1906552907dbc5fb6029a1d39d3902b2-MzMwMDM3NQ',
    '400_pro':     'https://pay.grow.link/f4feebf6816812162a3113a14091cc42-MzMwMDM3Ng',
    '400_premium': 'https://pay.grow.link/d49baafcf8b90061b4e11c16d9e872aa-MzMwMDM3OQ',
    '500_basic':   'https://pay.grow.link/8e4108603713f7dc3f85e2256f352990-MzMwMDM4MQ',
    '500_pro':     'https://pay.grow.link/2e8143c56fd9f59dcdb621dfebd7d2ff-MzMwMDM4Mw',
    '500_premium': 'https://pay.grow.link/37e6ef830751c527803ad91409405f92-MzMwMDM4NQ',
    '600_basic':   'https://pay.grow.link/7ccfb90823621420824d81f9bea18591-MzMwMDM4Ng',
    '600_pro':     'https://pay.grow.link/89505e155694e788c38f1597820f0dbb-MzMwMDM4OQ',
    '600_premium': 'https://pay.grow.link/5ff7364c47f9c39c9706e5e7720b2624-MzMwMDM5MA',
    '700_basic':   'https://pay.grow.link/NTY2OTg~6fee0687208ad54a752069e5ea3e610b-Mzg3NDE1OA',
    '700_pro':     'https://pay.grow.link/NTY2OTg~cc4ae55f425a3285e3dc6b1c80736c2e-Mzg3NDE1Nw',
    '700_premium': 'https://pay.grow.link/NTY2OTg~6ec74307cfc76fe84bf6e9c5ca6bad83-Mzg3NDE1NQ',
    '800_basic':   'https://pay.grow.link/NTY2OTg~d38ef2cdc904adff19e8904b85ff2fda-Mzg3NDE2MA',
    '800_pro':     'https://pay.grow.link/NTY2OTg~0c6743cc6490f13a96a8a6359e53e5ab-Mzg3NDE2MQ',
    '800_premium': 'https://pay.grow.link/NTY2OTg~31e109098f79dd4340267f6997ac9f24-Mzg3NDE2Ng',
    '900_basic':   'https://pay.grow.link/NTY2OTg~093a3d23b75ef497e3f96e996394ff70-Mzg3NDE3Ng',
    '900_pro':     'https://pay.grow.link/NTY2OTg~9833d477964944bf8d1a49098d2ff34d-Mzg3NDE3OA',
    '900_premium': 'https://pay.grow.link/NTY2OTg~70a109d46c6ecb9d90eda76f4e2b6593-Mzg3NDE4MQ'
  };

  /* ══ OCCASIONS ════════════════════════════════════════════════════════════
     `rec` is the package pre-selected when this occasion is chosen.
     Change a `rec` here and both site versions follow.
     ─────────────────────────────────────────────────────────────────────── */

  /* `names` are the labels for the two name fields; a null second entry means
     the occasion has one name. `title` adds a free line for what the event is,
     for the cases a template cannot guess. */
  var OCCASIONS = [
    /* one wedding, full stop. Who is a bride and who is a groom is chosen
       per-name in the setup form AFTER purchase (including two brides or two
       grooms) — a public dropdown listing family shapes is not the place. */
    { value: 'wedding',    label: 'חתונה',              rec: 'premium',
      names: ['שם בן/בת הזוג', 'שם בן/בת הזוג השני/ה'] },
    { value: 'hina',       label: 'חינה',               rec: 'pro',
      names: ['שם הכלה', 'שם החתן'] },
    { value: 'bar',        label: 'בר מצווה',           rec: 'pro',
      names: ['שם החוגג', null] },
    { value: 'bat',        label: 'בת מצווה',           rec: 'pro',
      names: ['שם החוגגת', null] },
    { value: 'brit',       label: 'ברית / בריתה',       rec: 'basic',
      names: ['שם ההורה', 'שם ההורה השני'], familyHint: true },
    { value: 'bday',       label: 'יום הולדת',          rec: 'basic',
      names: ['שם החוגג/ת', null] },
    { value: 'chalaka',    label: 'חלאקה',              rec: 'basic',
      names: ['שם הילד', null], familyHint: true },
    { value: 'chala',      label: 'הפרשת חלה',          rec: 'basic',
      names: ['שם הכלה', null] },
    { value: 'biz',        label: 'אירוע עסקי',         rec: 'pro',
      names: ['שם החברה', null], title: 'שם האירוע' },
    { value: 'other',      label: 'אחר',                rec: 'pro',
      names: ['שם המארגן/ת', null], title: 'מה האירוע' }
  ];

  var DEFAULT_PLAN = 'pro';

  /* ══ UPLOAD FORM ══════════════════════════════════════════════════════════ */

  var UPLOAD = {
    maxMB: 10,
    allowed: ['csv', 'xlsx', 'xls'],
    /* the file is read by column position, not by header text, so the order
       is the contract */
    columns: [
      { letter: 'A', label: 'שם',            note: 'שם המוזמן או המשפחה', required: true },
      { letter: 'B', label: 'טלפון',          note: 'נייד ישראלי, 05X', required: true },
      { letter: 'C', label: 'כמות מוזמנים',   note: 'כמה אנשים ההזמנה מכסה', required: true }
    ]
  };

  /* ══ REQUEST GUARD ════════════════════════════════════════════════════════
     The webhook URLs are visible in this file, so this is not a secret. It is
     a marker that the page actually ran, cheap for Make to verify and enough to
     drop anything posted straight at the URL.

     Verify in Make, as the first filter after each webhook:
       sha256(APP_KEY + "|" + nonce + "|" + stamp_ts)  ==  sig
     and reject when now - stamp_ts is more than 24 hours.

     Rotating appKey here invalidates every stamp immediately, which is the
     lever to pull if the URLs start getting hit.
     ─────────────────────────────────────────────────────────────────────── */

  var GUARD = {
    appId: 'ishur-web',
    appKey: 'aee02297c1578a7453b79cb4cf4b0c5d60b899ed45e0cfd0',
    minDwellMs: 2500,          // a submit faster than this is not a person
    duplicateWindowMs: 120000, // the same payload twice inside two minutes
    limits: {                  // per browser, per hour
      lead: 8,
      upload: 6,
      setup: 8,
      change: 12,
      status: 60
    }
  };

  /* ══ RECEPTION TIMES ══════════════════════════════════════════════════════
     Half hours through the day, quarter hours across the evening window where
     most receptions actually start. Nothing before 08:00 or after 23:30.
     ─────────────────────────────────────────────────────────────────────── */

  var TIME_OPTIONS = {
    from: '08:00', to: '23:30', step: 30,
    fineFrom: '17:00', fineTo: '23:00', fineStep: 15
  };

  /* ══ MESSAGE FOOTER ═══════════════════════════════════════════════════════
     Appended to every message a guest receives. Says who it is on behalf of
     and how to stop it, which is what the anti-spam law expects and what stops
     recipients reporting the number. Shown in the preview so the customer sees
     exactly what goes out.
     {names} is replaced with the names from the event setup.
     ─────────────────────────────────────────────────────────────────────── */

  var MESSAGE_FOOTER = {
    sentBy: 'נשלח עבור {names} · ishur.io',
    optOut: 'הגיע בטעות? השיבו "הסר" ולא נכתוב שוב.'
  };

  /* ══ ADD-ONS ══════════════════════════════════════════════════════════════
     `plans` lists the packages that already include it. Anyone on a package
     outside that list sees it locked with a buy button.
     Prices and links are keyed '<addon>_<guests>' exactly like GROW_LINKS.
     While a link is missing the button routes to WhatsApp instead of showing
     a price, so nobody is ever quoted a number we have not set.
     ─────────────────────────────────────────────────────────────────────── */

  var ADDONS = {
    hostess: {
      label: 'דיילות באירוע',
      desc: 'מקבלות אורחים, מסמנות הגעה בלוח בזמן אמת ומכוונות לשולחנות. דיילת אחת מתחת ל-300 רשומות, 2 דיילות מ-300 ומעלה. ניתן להוסיף עד שבועיים לפני האירוע. מחוץ למרכז: תוספת נסיעות 250 ₪ (דיילת אחת) או 500 ₪ (2 דיילות)',
      plans: []
    },
    extra_send: {
      label: 'שליחה נוספת',
      desc: 'תזכורת נוספת לכל הרשימה בתאריך שתבחרו, למשל שבוע לפני האירוע',
      plans: [],
      inForm: true          // the only add-on offered during setup
    },
    calls: {
      label: 'סבב שיחות מסוכן AI',
      desc: 'נציג מתקשר למי שלא הגיב ומאשר בשמו',
      plans: ['pro', 'premium'],
      /* Richard 03/11: a call round can be bought up to 2 days before the
         event, and on the day before only until 17:00 (see addonState). */
      minDaysBefore: 1, lastDayCutoffHour: 17
    },
    selfreg: {
      label: 'הפעלת הודעות לנרשמים מהקישור',
      desc: 'מי שאישר דרך הקישור הציבורי יקבל גם תזכורת, יום-לפני ושולחן',
      plans: []
    },
    more_guests: {
      label: 'הגדלת כמות מוזמנים או שדרוג מסלול',
      desc: 'עד 10 מוזמנים נוספים חינם. מעבר לזה, או למסלול עם שיחות, משלמים רק את ההפרש',
      plans: []
    },
    /* 12/11 Richard: the invitation design was only a button on the setup page — clients past setup never saw it */
    design: {
      label: 'עיצוב הזמנה',
      desc: 'הזמנה דיגיטלית מעוצבת לאירוע, לפי הסגנון שתבחרו, כולל 2 סבבי תיקונים, מוכנה לוואטסאפ',
      plans: []
    },
    postpone: {
      label: 'הודעת דחייה או עדכון מועד',
      desc: 'הודעה לכל הרשימה על שינוי במועד',
      plans: ['premium']
    },
    cancel: {
      label: 'הודעת ביטול אירוע',
      desc: 'הודעה לכל הרשימה על ביטול',
      plans: ['premium']
    }
  };

  /* ══ HOSTESSES (דיילות) ═══ add-on on top of any package, priced by tier ══
     Agreed 04/10/26. Prices include VAT. The tier is decided by the guest
     count the customer already picked, never by the package. Travel outside
     the center (+250 per hostess) is billed through one separate Grow link
     after the order, so it never multiplies the link table. */
  var HOSTESS = {
    label: 'דיילות באירוע',
    short: 'דיילות',
    desc: 'דיילות מצוות ishur עם הלוח שלנו ביד: מקבלות אורחים, מסמנות הגעה בזמן אמת ומכוונות לשולחנות.',
    tiers: [
      /* Richard 03/11 (global): under 300 records 1 hostess, 300 and up 2. No third tier. */
      { max: 299, count: 1, price: 1790, label: 'דיילת אחת', link: 'https://pay.grow.link/NTY2OTg~8aa5bfc13392e609223168761043b5ee-NDA3Nzc0MA' },
      { max: 900, count: 2, price: 1990, label: '2 דיילות', link: 'https://pay.grow.link/NTY2OTg~9ebc7cea776b48b10bcf7e6dda923f51-NDA3Nzc0MQ' }
    ],
    travel: 250,
    /* Richard 05/10: travel is per booking, not per hostess: 1 hostess ₪250, 2 hostesses ₪500 */
    travelFor: function (n) { return n >= 2 ? 500 : 250; },
    travelLinks: { 250: 'https://pay.grow.link/NTY2OTg~505b29a18711e1d7714eef22a530a0d6-NDA3NzY1Mg', 500: '' },
    travelNote: 'באזור המרכז (אשקלון עד הרצליה) הנסיעות כלולות. מחוץ למרכז: תוספת נסיעות: 250 ₪ לדיילת אחת, 500 ₪ ל-2 דיילות, לפי כתובת האירוע, בתשלום נפרד.',
    /* "center" = Ashkelon to Herzliya (Richard 04/10). Matched by substring on
       the city the client types in setup; anything else is "outside". */
    centerCities: ['אשקלון','אשדוד','יבנה','גדרה','רחובות','נס ציונה','ראשון לציון','ראשל"צ','חולון','בת ים','תל אביב','ת"א','יפו','רמת גן','גבעתיים','בני ברק','פתח תקווה','פ"ת','ראש העין','כפר סבא','רעננה','הוד השרון','הרצליה','רמת השרון','מודיעין','לוד','רמלה','קריית אונו','אור יהודה','יהוד','גבעת שמואל','סביון','גני תקווה','שוהם','באר יעקב','קריית גת','קריית מלאכי','גן יבנה','בית דגן','אזור','כפר שמריהו'],
    travelLink: 'https://pay.grow.link/NTY2OTg~505b29a18711e1d7714eef22a530a0d6-NDA3NzY1Mg'   /* ₪250 per hostess, pay N times */
  };
  /* Grow links for package + hostesses, keyed '<guests>_<plan>'. An empty
     entry routes the order to WhatsApp instead of a dead end. */
  var HOSTESS_LINKS = {
    '50_basic': 'https://pay.grow.link/NTY2OTg~241654276db29e9eb91c12fc00b3649f-NDA3NzQ2OQ',
    '50_pro': 'https://pay.grow.link/NTY2OTg~f63e7b8c481787c51cf1a188a8b26137-NDA3NzQ3MQ',
    '50_premium': 'https://pay.grow.link/NTY2OTg~c03e14c2afd5b9b26e1462cd153fdebc-NDA3NzQ3NA',
    '100_basic': 'https://pay.grow.link/NTY2OTg~41a7de1c1eb2cf6d6328d8b0740411d8-NDA3NzQ3Ng',
    '100_pro': 'https://pay.grow.link/NTY2OTg~ede6a34fde8c884d575cbf823726bd8a-NDA3NzQ3OA',
    '100_premium': 'https://pay.grow.link/NTY2OTg~4a8544cda3e952343fce432cb5bc106f-NDA3NzQ4Mg',
    '200_basic': 'https://pay.grow.link/NTY2OTg~f13a966ae2a4c4ad2ce2208c7ac3cf40-NDA3NzQ4NA',
    '200_pro': 'https://pay.grow.link/NTY2OTg~f64bbeb5fff61704e43faf9deb5b36e0-NDA3NzQ4OA',
    '200_premium': 'https://pay.grow.link/NTY2OTg~c445905645eb38d0d22ebcf4f7282196-NDA3NzQ5MA',
    '300_basic': 'https://pay.grow.link/NTY2OTg~7a08145b5dec8c17a96c993d8a63ac2f-NDA3NzQ5Mg',
    '300_pro': 'https://pay.grow.link/NTY2OTg~2c22da449eafc827345a10547a3ddab1-NDA3NzQ5NA',
    '300_premium': 'https://pay.grow.link/NTY2OTg~0432829b451cbebf3669c22062e5dbcf-NDA3NzQ5OA',
    '400_basic': 'https://pay.grow.link/NTY2OTg~0f272692e8b402a8f2e028cdd1bbb02f-NDA3NzUwMg',
    '400_pro': 'https://pay.grow.link/NTY2OTg~ea7ebcdd1b4ec2a4ae8193984adab0d8-NDA3NzU0MQ',
    '400_premium': 'https://pay.grow.link/NTY2OTg~28d29ab37b1b72d3dceac55b73440e4d-NDA3NzUxMw',
    '500_basic': 'https://pay.grow.link/NTY2OTg~3eb9b27187aca5b34e9f8264b98a0b16-NDA3NzU3Mg',
    '500_pro': 'https://pay.grow.link/NTY2OTg~7c77e2e248750a7c6680f7f1ebc13e64-NDA3NzU4Mw',
    '500_premium': 'https://pay.grow.link/NTY2OTg~82d7ac132171dfddd30ae3cc2be7db51-NDA3NzU4OA',
    '600_basic': 'https://pay.grow.link/NTY2OTg~0b6ed379154c4c9c885ec49054d2cb23-NDA3NzU4OQ',
    '600_pro': 'https://pay.grow.link/NTY2OTg~496785f5e2e74919596226799db427b3-NDA3NzU5Mg',
    '600_premium': 'https://pay.grow.link/NTY2OTg~8e43d3600dcfe57c13c90c47e92c22e7-NDA3NzU5Mw',
    '700_basic': 'https://pay.grow.link/NTY2OTg~af37e6b9da25e366581686f2239e4b1a-NDA3NzU5OQ',
    '700_pro': 'https://pay.grow.link/NTY2OTg~066ba6054f97362603f8757aa260dd17-NDA3NzYwMg',
    '700_premium': 'https://pay.grow.link/NTY2OTg~305d048e9b970e25d018196ede787c82-NDA3NzY2Mw',
    '800_basic': 'https://pay.grow.link/NTY2OTg~f21996fa78d5931da5a8297b469bce2e-NDA3NzYxNg',
    '800_pro': 'https://pay.grow.link/NTY2OTg~d1ef326c199d53c32b4642fd651414f8-NDA3NzYyMA',
    '800_premium': 'https://pay.grow.link/NTY2OTg~a8ab0ac29e978906286e4a95af2117f1-NDA3NzY0Mw',
    '900_basic': 'https://pay.grow.link/NTY2OTg~e262facb2b49b24d80852688a79eb8a7-NDA3NzQzMg',
    '900_pro': 'https://pay.grow.link/NTY2OTg~2b50ae9c729e3128ea91d4cfa27229a0-NDA3NzQ0NQ',
    '900_premium': 'https://pay.grow.link/NTY2OTg~66fbd0abbddbabe0687d09d439dbab0b-NDA3NzYyNA',
  };

  function hostessTier(guests) {
    var n = parseInt(guests, 10);
    if (!n) return null;
    for (var i = 0; i < HOSTESS.tiers.length; i++) {
      if (n <= HOSTESS.tiers[i].max) return HOSTESS.tiers[i];
    }
    return null;
  }
  function hostessPrice(guests) { var t = hostessTier(guests); return t ? t.price : null; }
  function hostessIsCenter(city) {
    var c = String(city || '').replace(/[\u200e\u200f'"]/g, '').trim();
    if (!c) return null;
    for (var i = 0; i < HOSTESS.centerCities.length; i++) {
      var n = HOSTESS.centerCities[i].replace(/"/g, '');
      if (c.indexOf(n) > -1 || n.indexOf(c) > -1) return true;
    }
    return false;
  }
  function hostessLink(guests, plan) {
    if (!guests || guests === 'custom' || !plan) return null;
    return HOSTESS_LINKS[guests + '_' + plan] || null;
  }

  /* ══ GIFTS (מתנות באשראי) ═══ coming soon, display only ═══════════════════ */
  var GIFTS = {
    label: 'מתנות באשראי',
    desc: 'האורחים נותנים מתנה באשראי ישירות מההזמנה. בעלי האירוע מקבלים דוח מי נתן כמה, והכסף מועבר תוך 3 ימי עסקים.',
    coupleFee: 0,
    guestPct: 3.5,
    guestFixed: 3,
    live: false
  };

  /* ══ INVITATION DESIGN (עיצוב הזמנה) ═══ one Grow page, fixed price ══════
     Empty link hides the button on upload.html. The event token rides along
     as cField1 so the worker can tie the payment to the event. */
  var DESIGN_LINK = 'https://pay.grow.link/NTY2OTg~9ea1ad8e8ceaa6c871674aa2dce7c53a-NDExNDMxMQ';
  var DESIGN_PRICE = 79;

  var ADDON_PRICES = {};   // '<addon>_<guests>': 120
  var ADDON_LINKS  = {};   // '<addon>_<guests>': 'https://pay.grow.link/...'

  /* ══ PROMOS ═══════════════════════════════════════════════════════════════
     Display only, for now. A promo changes what the pricing block and the
     popup SHOW, it does not change what Grow charges: every GROW_LINKS entry
     is a fixed amount created in Grow, so a discounted amount needs its own
     link (or the Make Grow module creating the charge on the fly) before the
     customer is actually billed the lower number.

     kind 'flat'    fixed price, only on `plan`, only up to `maxTier` guests
     kind 'percent' the same cut off every package
     `greeting` is what the visitor reads in the discount popup.

     Arriving with ?promo=<key> pins the promo for 60 days. The existing
     referral link, ?utm_source=referral&utm_medium=friend&utm_campaign=<code>,
     counts as the 'friend' promo and its code is kept in `ishur_ref`.
     ─────────────────────────────────────────────────────────────────────── */

  var PROMOS = {
    biz: {
      label: 'מבצע בעלי עסקים',
      kind: 'flat', plan: 'basic', maxTier: 300, price: 49,
      greeting: 'היי לאפ עסקים 👋 שמחים שבחרתם להשתמש בנו. לכל שאלה אפשר לפנות לנועה מקשרי לקוחות כאן בוואטסאפ, או ישירות לריצארד.'
    },
    friend: {
      label: 'הנחת חבר',
      /* the bar says "<label> <activeWord> · ...", and הנחה is feminine */
      activeWord: 'פעילה',
      kind: 'percent', percent: 10,
      greeting: 'הגעתם דרך המלצה של חבר 🎁 ההנחה כבר מוחלת על כל החבילות.'
    }
  };

  var PROMO_KEY_STORE = 'ishur_promo';   // { promo, ts }
  var PROMO_REF_STORE = 'ishur_ref';     // { code, ts }
  var PROMO_TTL_MS    = 60 * 24 * 60 * 60 * 1000;   // 60 days — referral credit, and the promo "which group" flag
  /* the code itself is shorter-lived on purpose (Phase 8 housekeeping): a
     code typed or linked once should not quietly keep discounting a visit
     two months later with no reminder it was ever applied */
  var PROMO_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

  /* ══ SENDING RULES ════════════════════════════════════════════════════════
     Enforced in the date picker, so an impossible date cannot be chosen.
     Weekdays are JS numbers: 0 Sunday … 6 Saturday.
     ─────────────────────────────────────────────────────────────────────── */

  var SCHEDULE = {
    minEventDays: 1,          // tomorrow is the closest an event can be
    autoUnderDays: 3,         // event this close, the schedule is fixed for them
    firstSendDaysBefore: 30,  // the invitation, about a month out
    secondSendDaysBefore: 7,  // the chase, about a week out
    minGapDays: 7,            // never chase someone less than a week later
    /* Derived from the event date, not chosen.
       The day-of reminder carries the address, so it has to land while it is
       still useful: an evening reception gets it the same morning, an event
       that starts before `earlyBefore` gets it the day before instead. */
    auto: [
      {
        key: 'event_day', offset: 0,
        label: 'תזכורת עם הכתובת', to: 'למי שאישר',
        earlyBefore: '16:00', earlyOffset: -1,
        earlyLabel: 'תזכורת עם הכתובת, ערב לפני'
      },
      { key: 'day_after', offset: 1, label: 'הודעת תודה', to: 'למי שאישר' }
    ]
  };

  /* Review raffle (Richard 03/11): feedback.html → "מגישים = נכנסים להגרלה".
     Keep equal to worker/raffle.js RAFFLE (a test checks). Empty links → the
     worker uses the brain sheet's reviewLink / testimonialLink at runtime;
     no Google link → the Google step is hidden. on:false hides everything. */
  var RAFFLE = {
    on: false,
    prize_he: '₪1,000 או PlayStation 5 חדש',
    draw_at: '2027-06-01T15:00:00Z',
    google_review_url: '',
    video_url: '',
    video_max_sec: 60
  };

  var SEND_RULES = {
    /* The daily batch leaves at 06:00. To go out on a given day the event has
       to be set up before 06:00 that morning, so tomorrow is available right up
       until 06:00 tonight, and from 06:00 the earliest becomes the day after. */
    setupCutoffHour: 6,
    blockedWeekdays: [6],     // Saturday, no sending at all
    cutoff: { 5: '15:00' },   // Friday, everything goes out before this
    maxMonthsAhead: 18
  };

  /* ══════════════════════════════════════════════════════════════════════════
     Derived helpers. Nothing to fill below this line.
     ═══════════════════════════════════════════════════════════════════════ */

  /* one place decides whether a caller talks to Make or to the proxy */
  function endpoint(kind) {
    if (USE_PROXY && PROXY_BASE) {
      return PROXY_BASE.replace(/\/$/, '') + ({
        lead: '/api/lead', event: '/api/event', status: '/api/status',
        claim: '/api/claim', 'shir-calls': '/api/shir-calls', ops: '/api/ops-stats',
        brain: '/api/brain-toggle', adspend: '/api/adspend', seating: '/api/seating',
        daily: '/api/daily-run',
        fixedcost: '/api/fixedcost', costlog: '/api/cost-log', otp: '/api/otp-send',
        inbox: '/api/inbox', wasend: '/api/wa-send', senddate: '/api/send-date',
        pause: '/api/pause', blockphone: '/api/block-phone', eventflag: '/api/event-flag',
        traffic: '/api/traffic', campaigns: '/api/campaign-stats', callheard: '/api/call-heard', callboard: '/api/call-board',
        'client-flags': '/api/client-flags', 'grant-addon': '/api/grant-addon', 'client-active': '/api/client-active', 'guests-reset': '/api/guests-reset', media: '/api/media', 'addon-quote': '/api/addon-quote', 'addon-pay': '/api/addon-pay', human: '/api/human', mediadl: '/api/media-dl', feedback: '/api/feedback', 'raffle-config': '/api/raffle/config', 'raffle-enter': '/api/raffle/enter', 'raffle-claim': '/api/raffle/claim-google', 'guest-add': '/api/guest-add', 'guest-edit': '/api/guest-edit', 'custom-template': '/api/custom-template', checkin: '/api/checkin', interest: '/api/interest', 'guest-rsvp': '/api/guest-rsvp', budget: '/api/budget', 'client-link': '/api/client-link', 'preview-invite': '/api/preview-invite', 'board-move': '/api/board-move', calendar: '/api/calendar', skip: '/api/skip', seatplan: '/api/seatplan', 'rsvp-info': '/api/rsvp-info', 'rsvp-self': '/api/rsvp-self', navlink: '/api/navlink', giftlinks: '/api/giftlinks', 'hostess-check': '/api/hostess-check', 'design-brief': '/api/design-brief', 'event-change': '/api/event-change', 'feedback-list': '/api/feedback-list', 'account-otp': '/api/account/otp', 'account-login': '/api/account/login', 'account-me': '/api/account/me', 'account-logout': '/api/account/logout', 'account-contact': '/api/account/contact', 'review-claim': '/api/review-claim', leads: '/api/leads', 'lead-update': '/api/lead-update'
      }[kind] || ('/api/' + String(kind || 'event'))); /* 27/10: a key missing here used to post to /api/event and fail as "לא נשמר" (guest-edit, custom-template, checkin, interest). Now it 404s as unknown-route, visible in the worker log. */
    }
    return {
      lead: MAKE_LEAD_WEBHOOK,
      event: MAKE_UPLOAD_WEBHOOK || MAKE_SETUP_WEBHOOK,
      status: MAKE_STATUS_WEBHOOK
    }[kind] || '';
  }

  function isSet(v) {
    return typeof v === 'string' && v.length > 0 && v.indexOf('PASTE_') !== 0 && v.indexOf('XXXX') === -1;
  }

  function waLink(text) {
    var t = text || 'היי, אני מעוניין/ת בשירות אישורי הגעה';
    return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(t);
  }

  /* price for a guests+plan pair. null when there is no self-serve price. */
  function priceFor(guests, plan) {
    var row = PRICE_TABLE[parseInt(guests, 10)];
    return row && row[plan] ? row[plan] : null;
  }

  /* payment link for a guests+plan pair. null routes the caller to WhatsApp. */
  function growLink(guests, plan) {
    if (!guests || guests === 'custom' || !plan) return null;
    return GROW_LINKS[guests + '_' + plan] || null;
  }

  /* what a package already covers, versus what has to be bought */
  function addonState(key, plan, daysToEvent) {
    var a = ADDONS[key];
    if (!a) return null;
    if (a.plans.indexOf(plan) > -1) return 'included';
    if (a.minDaysBefore != null && daysToEvent != null && daysToEvent < a.minDaysBefore) return 'too-late';
    /* the day before the event: only until the cutoff hour (Israel time) */
    if (a.lastDayCutoffHour != null && daysToEvent === 1) {
      var ilHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date()));
      if (ilHour >= a.lastDayCutoffHour) return 'too-late';
    }
    return 'locked';
  }

  function addonPrice(key, guests) {
    return ADDON_PRICES[key + '_' + guests] || null;
  }

  function addonLink(key, guests) {
    return ADDON_LINKS[key + '_' + guests] || null;
  }

  function occasion(value) {
    for (var i = 0; i < OCCASIONS.length; i++) {
      if (OCCASIONS[i].value === value) return OCCASIONS[i];
    }
    return null;
  }

  function occasionLabel(value) {
    var o = occasion(value);
    return o ? o.label : '';
  }

  function occasionNames(value) {
    var o = occasion(value);
    return (o && o.names) || ['שם', null];
  }

  function recommendedPlan(occasionValue) {
    var o = occasion(occasionValue);
    return o ? o.rec : DEFAULT_PLAN;
  }

  function guestLabel(value) {
    for (var i = 0; i < GUEST_TIERS.length; i++) {
      if (GUEST_TIERS[i].value === value) return GUEST_TIERS[i].label;
    }
    return '';
  }

  /* cheapest price at a guest tier, for "החל מ-" copy on the pricing block */
  function fromPrice(plan) {
    return PRICE_TABLE[50][plan];
  }

  /* ══ PROMO CODES ══════════════════════════════════════════════════════════
     The discounted price and its Grow link are deliberately NOT in this file.

     ishur.io is a public GitHub repo, so a cheap payment link written here is a
     link anybody can find and pay 49 with instead of 299. The cheap price and
     its link live in the Worker's KV, and the Worker hands them out only
     against a code that is real, unused, and still has a seat left:

       GET /promo/check?code=XXXX-XXXX  read-only, and it never returns the
                                        link. The page asks this before it
                                        dares print 49 beside a struck 299.
       GET /promo/go?code=XXXX-XXXX     the buy button. Holds a seat, then 302s
                                        to the real link. Navigate the browser
                                        to it — a fetch would follow the redirect
                                        into Grow and die on CORS.

     This is the same rule the old PROMO_LINKS / promoLive() pair enforced from
     the client while the Worker could not yet: never show a price we are not
     able to charge. Enforcement now lives on the server, next to the link, so
     the client-side pair is gone.
     ─────────────────────────────────────────────────────────────────────── */

  var PROMO_CODE_STORE = 'ishur_promo_code';   // { v: 'XXXX-XXXX', ts }

  /* Codes are read aloud in a WhatsApp group and typed by hand, so "m9hc qkts",
     "m9hcqkts" and "M9HC-QKTS" all mean the same thing. Mirrors normCode() in
     worker/promo.js; the Worker normalises again on arrival, this copy only
     lets the page recognise and pin what was typed. */
  function normPromoCode(raw) {
    var s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length !== 8) return '';
    return s.slice(0, 4) + '-' + s.slice(4);
  }

  function promoBase() {
    return String(PROXY_BASE || '').replace(/\/$/, '');
  }

  function promoCheckUrl(code) {
    var c = normPromoCode(code), b = promoBase();
    return (c && b) ? b + '/promo/check?code=' + encodeURIComponent(c) : '';
  }

  /* The buy button's href. `phone` is optional but worth passing: it is the
     only thread tying the payment Grow reports back to the code that gets
     burned, and by checkout the lead form already knows it. */
  function promoGoUrl(code, phone) {
    var c = normPromoCode(code), b = promoBase();
    if (!c || !b) return '';
    var u = b + '/promo/go?code=' + encodeURIComponent(c);
    var p = String(phone || '').replace(/\D/g, '');
    if (p.length >= 9) u += '&phone=' + encodeURIComponent(p);
    return u;
  }

  /* The code this visitor is on: ?code= first, then whatever an earlier visit
     pinned. A code in the url is pinned for 7 days, not 60 — a code applied
     once and forgotten should not keep quietly discounting a visit two
     months later with no sign it was ever there. */
  function promoCode() {
    var fromUrl = normPromoCode(queryParam('code'));
    if (fromUrl) { stash(PROMO_CODE_STORE, fromUrl); return fromUrl; }
    return normPromoCode(unstash(PROMO_CODE_STORE, PROMO_CODE_TTL_MS));
  }

  function rememberPromoCode(code) {
    var c = normPromoCode(code);
    if (c) stash(PROMO_CODE_STORE, c);
    return c;
  }

  function forgetPromoCode() {
    var s = store(); if (!s) return;
    try { s.removeItem(PROMO_CODE_STORE); } catch (e) {}
  }

  /* Why a code is not being honoured, in words a visitor understands. Anything
     unrecognised — a network failure, a Worker that is down — gets no message
     at all, and the page just shows the full price. That is the only direction
     of mismatch that is safe. */
  var PROMO_REASONS = {
    'bad-code':     'הקוד לא נמצא',
    'used':         'הקוד הזה כבר נוצל',
    'sold-out':     'כל המקומות במבצע נתפסו',
    'closed':       'המבצע לא פעיל כרגע',
    'unavailable':  'המבצע לא פעיל כרגע',
    'rate-limited': 'נסו שוב בעוד רגע'
  };

  function promoReason(reason) {
    return PROMO_REASONS[String(reason || '')] || '';
  }

  /* What a Worker-validated offer does to one card. `offer` is exactly what
     /promo/check returned; not one number here comes from this file. */
  function offerPrice(offer, tier, planKey) {
    var original = priceFor(tier, planKey);
    var out = { original: original, final: original, saved: 0, applies: false };
    if (!offer || !offer.ok || original == null) return out;
    if (offer.plan && offer.plan !== planKey) return out;        // wrong package
    var n = parseInt(tier, 10);
    if (!(n > 0)) return out;                                    // 'custom', no price
    if (offer.maxTier != null && n > offer.maxTier) return out;  // tier too big
    var cut = parseInt(offer.price, 10);
    if (!(cut >= 0) || cut >= original) return out;              // not cheaper
    out.final = cut;
    out.saved = original - cut;
    out.applies = true;
    return out;
  }

  function promoPrice(promoKey, tier, planKey) {
    var p = PROMOS[promoKey];
    var original = priceFor(tier, planKey);
    var out = { original: original, final: original, saved: 0, applies: false };
    if (!p || original == null) return out;

    var n = parseInt(tier, 10);
    var cut = null;

    if (p.kind === 'flat') {
      if (p.plan && p.plan !== planKey) return out;          // wrong package
      if (!(n > 0)) return out;                              // 'custom', no price
      if (p.maxTier != null && n > p.maxTier) return out;    // tier too big
      cut = p.price;
    } else if (p.kind === 'percent') {
      cut = Math.round(original * (1 - p.percent / 100));
    } else {
      return out;
    }

    /* a promo that is not cheaper is not a promo */
    if (cut == null || cut >= original) return out;

    out.final = cut;
    out.saved = original - cut;
    out.applies = true;
    return out;
  }

  /* localStorage is not there in every context: private mode, a node test
     harness, a locked-down browser. Every read and write is optional. */
  function store() {
    try { return (typeof window !== 'undefined' && window.localStorage) || null; }
    catch (e) { return null; }
  }

  /* ══ הזמן חבר (12/11) ═══ the 80% Grow pages for a friend who came through a
     client's link in DISCOUNT mode. Richard creates each page by hand in Grow
     (list: .sdlc/referral-program/grow-pages.md) and pastes the link here.
     '' = not created yet → the popup mints a server-priced link instead. */
  var GROW_LINKS_REF = {
    '50_basic': 'https://pay.grow.link/NTY2OTg~74d13a95cd635406a34814241134a655-NDI4NjU5Mw',
    '50_pro': 'https://pay.grow.link/NTY2OTg~4255133f8f619a26bc571bbdd398795e-NDI4NjU5OA',
    '50_premium': 'https://pay.grow.link/NTY2OTg~82a4ffe408518d88aa6515723954251f-NDI4NjU5OQ',
    '100_basic': 'https://pay.grow.link/NTY2OTg~8f3d836778ea6f4927f163055c1f9467-NDI4NjYwMQ',
    '100_pro': 'https://pay.grow.link/NTY2OTg~e1c6fa118d99ba1f14edd1311dbe3b40-NDI4NjYwNA',
    '100_premium': 'https://pay.grow.link/NTY2OTg~ed745ae9fcf410085a1095b74594fa52-NDI4NjYwNQ',
    '200_basic': 'https://pay.grow.link/NTY2OTg~a6008dad411551714bd7e6c577f11604-NDI4NjYwNg',
    '200_pro': 'https://pay.grow.link/NTY2OTg~8b932f3a2d584568ca095031b2af2ba2-NDI4NjYwNw',
    '200_premium': 'https://pay.grow.link/NTY2OTg~0a632588bb77b22af2af78c17af111e6-NDI4NjYwOQ',
    '300_basic': 'https://pay.grow.link/NTY2OTg~1757c4af27628dc5367791d8a73558dc-NDI4NjYxMA',
    '300_pro': 'https://pay.grow.link/NTY2OTg~bfed288015cb647a79d2bc97f2daf33c-NDI4NjYxMQ',
    '300_premium': 'https://pay.grow.link/NTY2OTg~9801a836f9f44a94a3f3e50c6a6e7bee-NDI4NjYxMg',
    '400_basic': 'https://pay.grow.link/NTY2OTg~c8a4108d38a92d0945b98fffe072dc4b-NDI4NjYxMw',
    '400_pro': 'https://pay.grow.link/NTY2OTg~190968f85114a90c873e6900a5b54b7c-NDI4NjYxNA',
    '400_premium': 'https://pay.grow.link/NTY2OTg~e8616162a0036188d25f71787eeb7371-NDI4NjYxNg',
    '500_basic': 'https://pay.grow.link/NTY2OTg~207ee631121ac123e50f8bd55e078828-NDI4NjYxOQ',
    '500_pro': 'https://pay.grow.link/NTY2OTg~6408061e4a47b53d1f993adc9f2c76d7-NDI4NjYyMA',
    '500_premium': 'https://pay.grow.link/NTY2OTg~e5bbdacf44a79065a55c3a93d3202b99-NDI4NjYyMQ',
    '600_basic': 'https://pay.grow.link/NTY2OTg~5d491375c8562390bc073416bf23d8b8-NDI4NjYyMg',
    '600_pro': 'https://pay.grow.link/NTY2OTg~5ab4019b1d48d2ca4d55b67de71fdec5-NDI4NjYyMw',
    '600_premium': 'https://pay.grow.link/NTY2OTg~3973f892550c358c4d04cdaeaf934c5a-NDI4NjYyNQ',
    '700_basic': 'https://pay.grow.link/NTY2OTg~993c747b5d4ff28b6e88a05b6b6a879a-NDI4NjYyNg',
    '700_pro': 'https://pay.grow.link/NTY2OTg~4a5621b1a7273260d32f49fe78896959-NDI4NjYyNw',
    '700_premium': 'https://pay.grow.link/NTY2OTg~c0dcb11d50123b224e5c28b27ff105a5-NDI4NjYyOQ',
    '800_basic': 'https://pay.grow.link/NTY2OTg~b2a9a1796a562648440e1a75d7bb09a8-NDI4NjYzMA',
    '800_pro': 'https://pay.grow.link/NTY2OTg~8e78ccc6d6bbf10f17c93defda56e070-NDI4NjYzMQ',
    '800_premium': 'https://pay.grow.link/NTY2OTg~2ec6e9cb2a75e44e6fe77f9076fc8a9a-NDI4NjYzMg',
    '900_basic': 'https://pay.grow.link/NTY2OTg~cdd743d42a3dfa3aaac057743fab92fd-NDI4NjYzMw',
    '900_pro': 'https://pay.grow.link/NTY2OTg~b6f9f474cbf922de04f4825979645eb8-NDI4NjYzNg',
    '900_premium': 'https://pay.grow.link/NTY2OTg~94b500c572cfbe8500e518a883151b3c-NDI4NjYzNw',
  };
  var REF_STORE = PROMO_REF_STORE;                 // 'ishur_ref' { v: '<8 hex>', ts } — shared with the old utm path
  var REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;       // the cookie lives 30 days
  var REF_PCT = 20;
  function normRefCode(v) { v = String(v || '').trim().toLowerCase(); return /^[0-9a-f]{8}$/.test(v) ? v : ''; }
  /* ?ref=CODE, or the old share link (utm_source=referral&utm_campaign=CODE); remembered 30 days */
  function refCode() {
    var fromUrl = normRefCode(queryParam('ref'));
    if (!fromUrl && /^referral$/i.test(queryParam('utm_source'))) fromUrl = normRefCode(queryParam('utm_campaign'));
    if (fromUrl) { stash(REF_STORE, fromUrl); return fromUrl; }
    return normRefCode(unstash(REF_STORE, REF_TTL_MS));
  }
  function forgetRef() { var st = store(); if (st) try { st.removeItem(REF_STORE); } catch (e) {} }
  /* 80% of the package, whole shekels — the same rule as worker/referral.js */
  function refPrice(tier, plan) {
    var original = priceFor(tier, plan);
    var out = { original: original, final: original, saved: 0, applies: false };
    if (original == null) return out;
    out.final = Math.round(original * (100 - REF_PCT) / 100);
    out.saved = original - out.final;
    out.applies = out.saved > 0;
    return out;
  }
  function refGrowLink(guests, plan, code) {
    if (!guests || guests === 'custom' || !plan) return null;
    var u = GROW_LINKS_REF[guests + '_' + plan] || '';
    if (!u) return null;
    return u + (u.indexOf('?') > -1 ? '&' : '?') + 'cField3=' + encodeURIComponent('ref:' + code);
  }
  function refLink(code) { return 'https://ishur.io/?ref=' + code; }

  function stash(key, value) {
    var s = store(); if (!s) return;
    try { s.setItem(key, JSON.stringify({ v: value, ts: Date.now() })); } catch (e) {}
  }

  /* a stashed value, or null once it is older than ttlMs (default 60 days) */
  function unstash(key, ttlMs) {
    var s = store(); if (!s) return null;
    var raw = null;
    try { raw = s.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || !o.v || !o.ts) return null;
    if (Date.now() - o.ts > (ttlMs || PROMO_TTL_MS)) {
      try { s.removeItem(key); } catch (e) {}
      return null;
    }
    return o.v;
  }

  function queryParam(name) {
    try {
      if (typeof window === 'undefined' || !window.location) return '';
      var q = String(window.location.search || '');
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(q);
      return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    } catch (e) { return ''; }
  }

  /* Which promo this visitor is on, or null.
     Order: an explicit ?promo=, then the referral link, then what was pinned
     on an earlier visit. A promo found in the url is pinned for 60 days. */
  /* The legacy display-only promos (?promo=, the referral link) are no longer
     allowed to change a printed price — nothing exists to charge their amount.
     They are still pinned, so a referral code keeps riding along on the lead,
     but the only thing that may strike a price now is a code the Worker has
     just validated. See the PROMO CODES note above. */
  function activePromo() {
    activePromoRaw();
    return null;
  }

  function activePromoRaw() {
    var direct = queryParam('promo');
    if (direct && PROMOS[direct]) {
      stash(PROMO_KEY_STORE, direct);
      return direct;
    }

    /* the referral link the dashboard hands out:
       ?utm_source=referral&utm_medium=friend&utm_campaign=<code> */
    var src  = queryParam('utm_source').toLowerCase();
    var code = queryParam('utm_campaign');
    if (src === 'referral' && code) {
      stash(PROMO_REF_STORE, code);      // the lead still reads utm_campaign
      if (PROMOS.friend) {
        stash(PROMO_KEY_STORE, 'friend');
        return 'friend';
      }
    }

    var saved = unstash(PROMO_KEY_STORE);
    return (saved && PROMOS[saved]) ? saved : null;
  }

  function promoInfo(promoKey) {
    return PROMOS[promoKey] || null;
  }

  /* refCode() (12/11) lives above with the הזמן חבר helpers; same store (ishur_ref), 30 days */

  return {
    PROMOS: PROMOS,
    promoPrice: promoPrice,
    activePromo: activePromo,
    promoInfo: promoInfo,

    /* promo codes — the Worker owns the price and the link, these only ask */
    normPromoCode: normPromoCode,
    promoCode: promoCode,
    rememberPromoCode: rememberPromoCode,
    forgetPromoCode: forgetPromoCode,
    promoCheckUrl: promoCheckUrl,
    promoGoUrl: promoGoUrl,
    GROW_LINKS_REF: GROW_LINKS_REF, REF_PCT: REF_PCT, refCode: refCode, forgetRef: forgetRef, refPrice: refPrice, refGrowLink: refGrowLink, refLink: refLink,
    promoReason: promoReason,
    offerPrice: offerPrice, BUNDLES: BUNDLES, bundleFor: bundleFor, bundlePick: bundlePick, bundleKeyOf: bundleKeyOf, bundleTable: bundleTable, bundleLive: bundleLive, bundleApplies: bundleApplies,

    MAKE_LEAD_WEBHOOK: MAKE_LEAD_WEBHOOK,
    MAKE_UPLOAD_WEBHOOK: MAKE_UPLOAD_WEBHOOK,
    MAKE_SETUP_WEBHOOK: MAKE_SETUP_WEBHOOK,
    MAKE_STATUS_WEBHOOK: MAKE_STATUS_WEBHOOK,
    MAKE_CHANGE_WEBHOOK: MAKE_CHANGE_WEBHOOK,
    GTM_ID: GTM_ID,
    FB_PIXEL_ID: FB_PIXEL_ID,
    TIKTOK_PIXEL_ID: TIKTOK_PIXEL_ID,
    GA4_ID: GA4_ID,
    POSTHOG_KEY: POSTHOG_KEY,
    POSTHOG_HOST: POSTHOG_HOST,
    WHATSAPP_NUMBER: WHATSAPP_NUMBER,
    SUPPORT_PHONE: SUPPORT_PHONE,
    SUPPORT_EMAIL: SUPPORT_EMAIL,
    TEMPLATE_URL: TEMPLATE_URL,

    PLANS: PLANS,
    PLAN_ORDER: PLAN_ORDER,
    GUEST_TIERS: GUEST_TIERS,
    PRICE_TABLE: PRICE_TABLE,
    GROW_LINKS: GROW_LINKS,
    OCCASIONS: OCCASIONS,
    DEFAULT_PLAN: DEFAULT_PLAN,
    UPLOAD: UPLOAD,
    SEND_RULES: SEND_RULES,
    RAFFLE: RAFFLE,
    SCHEDULE: SCHEDULE,
    GUARD: GUARD,
    TIME_OPTIONS: TIME_OPTIONS,
    MESSAGE_FOOTER: MESSAGE_FOOTER,
    ADDONS: ADDONS,
    HOSTESS: HOSTESS, HOSTESS_LINKS: HOSTESS_LINKS, hostessTier: hostessTier, hostessPrice: hostessPrice, hostessLink: hostessLink, hostessIsCenter: hostessIsCenter,
    GIFTS: GIFTS,
    ADDON_PRICES: ADDON_PRICES,
    DESIGN_LINK: DESIGN_LINK,
    DESIGN_PRICE: DESIGN_PRICE,
    ADDON_LINKS: ADDON_LINKS,

    USE_PROXY: USE_PROXY,
    endpoint: endpoint,
    isSet: isSet,
    waLink: waLink,
    priceFor: priceFor,
    addonState: addonState,
    addonPrice: addonPrice,
    addonLink: addonLink,
    growLink: growLink,
    occasion: occasion,
    occasionLabel: occasionLabel,
    occasionNames: occasionNames,
    recommendedPlan: recommendedPlan,
    guestLabel: guestLabel,
    fromPrice: fromPrice
  };
})();
