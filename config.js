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

  var MAKE_LEAD_WEBHOOK   = 'https://hook.eu1.make.com/pc0r3vknvc1tpg7as1cn8wefsemab61w';
  var MAKE_UPLOAD_WEBHOOK = '';          // guest-list file uploads (multipart)
  var GTM_ID              = '';          // GTM-XXXXXXX
  var FB_PIXEL_ID         = '';          // Meta pixel, optional

  var WHATSAPP_NUMBER     = '972559504499';   // digits only, country code, no +
  var SUPPORT_PHONE       = '0559504499';     // for tel: links
  var SUPPORT_EMAIL       = 'info@ishur.io';

  var TEMPLATE_URL        = '';          // sample .xlsx for the upload form. empty hides the row

  /* ══ PACKAGES ═════════════════════════════════════════════════════════════ */

  var PLANS = {
    basic: {
      key: 'basic', name: 'בסיס', label: 'BASE',
      desc: 'הודעות אישור, מעקב תשובות ותזכורת יום לפני',
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
      desc: 'ועוד: 2 סבבי שיחות ממוקד אנושי, דף צפייה בזמן אמת',
      features: [
        'כל מה שבחבילת בסיס',
        '2 סבבי שיחות ממוקד אנושי',
        'דף צפייה בזמן אמת 24/7',
        'דוח מסודר ביום האירוע'
      ]
    },
    premium: {
      key: 'premium', name: 'הכל כלול', label: 'ALL INCLUSIVE',
      desc: 'ועוד: 3 סבבי שיחות, הודעת דחייה וביטול, טיפול ידני',
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
     'custom' = over 600, no self-serve payment, routed to WhatsApp.
     ─────────────────────────────────────────────────────────────────────── */

  var GUEST_TIERS = [
    { value: '50',     label: 'עד 50 מוזמנים' },
    { value: '100',    label: 'עד 100 מוזמנים' },
    { value: '200',    label: 'עד 200 מוזמנים' },
    { value: '300',    label: 'עד 300 מוזמנים' },
    { value: '400',    label: 'עד 400 מוזמנים' },
    { value: '500',    label: 'עד 500 מוזמנים' },
    { value: '600',    label: 'עד 600 מוזמנים' },
    { value: 'custom', label: 'מעל 600 מוזמנים' }
  ];

  /* ══ PRICES ═══ ₪ per event, by guest tier × package ══════════════════════ */

  var PRICE_TABLE = {
    50:  { basic: 50,  pro: 70,  premium: 90  },
    100: { basic: 99,  pro: 129, premium: 149 },
    200: { basic: 199, pro: 219, premium: 239 },
    300: { basic: 299, pro: 319, premium: 339 },
    400: { basic: 399, pro: 419, premium: 439 },
    500: { basic: 499, pro: 519, premium: 539 },
    600: { basic: 599, pro: 619, premium: 639 }
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
    '600_premium': 'https://pay.grow.link/5ff7364c47f9c39c9706e5e7720b2624-MzMwMDM5MA'
  };

  /* ══ OCCASIONS ════════════════════════════════════════════════════════════
     `rec` is the package pre-selected when this occasion is chosen.
     Change a `rec` here and both site versions follow.
     ─────────────────────────────────────────────────────────────────────── */

  var OCCASIONS = [
    { value: 'wedding', label: 'חתונה',        icon: '💍', rec: 'premium' },
    { value: 'hina',    label: 'חינה',         icon: '🪘', rec: 'pro'     },
    { value: 'bar',     label: 'בר מצווה',     icon: '🎉', rec: 'pro'     },
    { value: 'bat',     label: 'בת מצווה',     icon: '🎀', rec: 'pro'     },
    { value: 'brit',    label: 'ברית / בריתה', icon: '👶', rec: 'basic'   },
    { value: 'bday',    label: 'יום הולדת',    icon: '🎂', rec: 'basic'   },
    { value: 'biz',     label: 'אירוע עסקי',   icon: '💼', rec: 'pro'     },
    { value: 'other',   label: 'אחר',          icon: '✨', rec: 'pro'     }
  ];

  var DEFAULT_PLAN = 'pro';

  /* ══ UPLOAD FORM ══════════════════════════════════════════════════════════ */

  var UPLOAD = {
    maxMB: 10,
    allowed: ['csv', 'xlsx', 'xls']
  };

  /* ══════════════════════════════════════════════════════════════════════════
     Derived helpers. Nothing to fill below this line.
     ═══════════════════════════════════════════════════════════════════════ */

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
    GTM_ID: GTM_ID,
    FB_PIXEL_ID: FB_PIXEL_ID,
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

    isSet: isSet,
    waLink: waLink,
    priceFor: priceFor,
    growLink: growLink,
    occasion: occasion,
    occasionLabel: occasionLabel,
    recommendedPlan: recommendedPlan,
    guestLabel: guestLabel,
    fromPrice: fromPrice
  };
})();
