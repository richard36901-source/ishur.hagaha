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
  var PROXY_BASE = 'https://ishur-webhooks.richardtomskiy.workers.dev';

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
  var FB_PIXEL_ID         = '';          // Meta pixel id (digits only)
  var TIKTOK_PIXEL_ID     = '';          // TikTok pixel id, optional
  var GA4_ID              = 'G-H21EMT09HL';  // GA4 property for ishur.io, owned by ishurhagaha@gmail.com

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
      desc: 'שליחת הזמנה + דף מעקב 24/7 + תזכורת יום לפני',
      features: [
        'הזמנה דיגיטלית לאורחים',
        '2 הודעות אישורי הגעה בוואטסאפ',
        'דוח אחד לפני האירוע',
        'תזכורת יום לפני עם כתובת האולם',
        'הודעת תודה בסיום'
      ]
    },
    pro: {
      key: 'pro', name: 'פרמיום', label: 'PREMIUM',
      desc: 'שליחת הזמנה + דף מעקב 24/7 + תזכורת יום לפני + סבב שיחות אחד',
      features: [
        'כל מה שבחבילת בסיס',
        'סבב שיחות ממוקד אנושי למי שלא ענה',
        'דף צפייה בזמן אמת 24/7',
        'דוח מסודר ביום האירוע'
      ]
    },
    premium: {
      key: 'premium', name: 'הכל כלול', label: 'ALL INCLUSIVE',
      desc: 'שליחת הזמנה + דף מעקב 24/7 + תזכורת יום לפני + 3 סבבי שיחות + הודעת דחייה או ביטול + הודעת תודה יום אחרי האירוע',
      features: [
        'כל מה שבחבילת פרמיום',
        '3 סבבי שיחות ממוקד אנושי',
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
     invitation however many seats it covers, so the wording says הזמנות. */
  var GUEST_TIERS = [
    { value: '50',     label: 'עד 50 הזמנות' },
    { value: '100',    label: 'עד 100 הזמנות' },
    { value: '200',    label: 'עד 200 הזמנות' },
    { value: '300',    label: 'עד 300 הזמנות' },
    { value: '400',    label: 'עד 400 הזמנות' },
    { value: '500',    label: 'עד 500 הזמנות' },
    { value: '600',    label: 'עד 600 הזמנות' },
    { value: '700',    label: 'עד 700 הזמנות' },
    { value: '800',    label: 'עד 800 הזמנות' },
    { value: '900',    label: 'עד 900 הזמנות' },
    { value: 'custom', label: 'מעל 900 הזמנות' }
  ];

  /* ══ PRICES ═══ ₪ per event, by guest tier × package ══════════════════════ */

  var PRICE_TABLE = {
    50:  { basic: 50,  pro: 70,  premium: 140 },
    100: { basic: 99,  pro: 129, premium: 199 },
    200: { basic: 199, pro: 219, premium: 289 },
    300: { basic: 299, pro: 319, premium: 389 },
    400: { basic: 399, pro: 419, premium: 489 },
    500: { basic: 499, pro: 519, premium: 589 },
    600: { basic: 599, pro: 619, premium: 689 },
    700: { basic: 699, pro: 719, premium: 789 },
    800: { basic: 799, pro: 819, premium: 889 },
    900: { basic: 899, pro: 919, premium: 989 }
  };

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
    { value: 'wedding',    label: 'חתונה',              rec: 'premium',
      names: ['שם הכלה', 'שם החתן'] },
    { value: 'wedding_mm', label: 'חתונה · שני חתנים',  rec: 'premium',
      names: ['שם החתן', 'שם החתן השני'] },
    { value: 'wedding_ff', label: 'חתונה · שתי כלות',   rec: 'premium',
      names: ['שם הכלה', 'שם הכלה השנייה'] },
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
    extra_send: {
      label: 'שליחה נוספת',
      desc: 'תזכורת נוספת לכל הרשימה בתאריך שתבחרו, למשל שבוע לפני האירוע',
      plans: [],
      inForm: true          // the only add-on offered during setup
    },
    calls: {
      label: 'סבב שיחות ממוקד אנושי',
      desc: 'נציג מתקשר למי שלא הגיב ומאשר בשמו',
      plans: ['pro', 'premium'],
      /* a call round needs lead time. Closer than this to the event it stops
         being offered at all rather than being sold and not delivered. */
      minDaysBefore: 7
    },
    more_guests: {
      label: 'הגדלת כמות מוזמנים',
      desc: 'מעבר למדרגה גבוהה יותר, עם אפשרות להעלות קובץ נוסף',
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

  var ADDON_PRICES = {};   // '<addon>_<guests>': 120
  var ADDON_LINKS  = {};   // '<addon>_<guests>': 'https://pay.grow.link/...'

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
        pause: '/api/pause', blockphone: '/api/block-phone', eventflag: '/api/event-flag'
      }[kind] || '/api/event');
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

  return {
    MAKE_LEAD_WEBHOOK: MAKE_LEAD_WEBHOOK,
    MAKE_UPLOAD_WEBHOOK: MAKE_UPLOAD_WEBHOOK,
    MAKE_SETUP_WEBHOOK: MAKE_SETUP_WEBHOOK,
    MAKE_STATUS_WEBHOOK: MAKE_STATUS_WEBHOOK,
    MAKE_CHANGE_WEBHOOK: MAKE_CHANGE_WEBHOOK,
    GTM_ID: GTM_ID,
    FB_PIXEL_ID: FB_PIXEL_ID,
    TIKTOK_PIXEL_ID: TIKTOK_PIXEL_ID,
    GA4_ID: GA4_ID,
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
    SCHEDULE: SCHEDULE,
    GUARD: GUARD,
    TIME_OPTIONS: TIME_OPTIONS,
    MESSAGE_FOOTER: MESSAGE_FOOTER,
    ADDONS: ADDONS,
    ADDON_PRICES: ADDON_PRICES,
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
