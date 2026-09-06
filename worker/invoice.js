/* ============================================================================
   ishur.io · invoices, straight from the worker (Morning / Green Invoice API)
   ----------------------------------------------------------------------------
   Richard (06/09): every paying client gets a tax invoice-receipt with the
   package, the amount, the payment method, and the service terms written on
   it — orderly, part of the system, not a "we told you" afterthought.

   Why here and not in Make: the worker already holds every fact at the second
   the payment lands (name, phone, email, tax id, package, tier, sum, method,
   promo) and already sends the WhatsApp with the link. One place, one journal
   row, no operation spent in Make, no filter to forget.

   Secrets: MORNING_ID + MORNING_SECRET (Morning → הגדרות → API).
   Without them createInvoice() returns {ok:false, why:'not-configured'} and
   the payment path continues exactly as before.
   ========================================================================== */

const API = 'https://api.greeninvoice.co.il/api/v1';
const DOC_INVOICE_RECEIPT = 320;   // חשבונית מס קבלה

/* Grow's free-text payment method → Morning payment type */
function paymentType(method) {
  const m = String(method || '').toLowerCase();
  if (/כרטיס|אשראי|card|visa|master|amex|credit/.test(m)) return 3;
  if (/bit|ביט|paybox|פייבוקס|apple|google/.test(m)) return 10;
  if (/העברה|transfer|bank/.test(m)) return 4;
  if (/paypal/.test(m)) return 5;
  if (/מזומן|cash/.test(m)) return 1;
  return 11;
}

/* The terms, as they appear on the document. A digest of terms.html, in the
   order a client would ask about them. Section numbers match the site. */
export function invoiceTerms({ tier, plan } = {}) {
  const cap = tier ? `עד ${tier} הזמנות (מספר טלפון אחד = הזמנה אחת)` : 'לפי החבילה שנרכשה';
  return [
    'תנאי השירות (תמצית; הנוסח המלא והמחייב: ishur.io/terms.html)',
    `1. השירות: איסוף אישורי הגעה בוואטסאפ${plan ? ` · חבילת ${plan}` : ''} · ${cap}. הרחבה או שליחה נוספת בתשלום נפרד.`,
    '2. תשלום וביטול: השירות דיגיטלי ואספקתו מתחילה מיד עם התשלום (פתיחת האירוע ושליחת קישור אישי). לא יינתן החזר לאחר מכן, מכל סיבה, כולל ביטול, דחייה או אי-שימוש. אושר בתיבת ההסכמה ברכישה לפי סעיף 14ג(ד) לחוק הגנת הצרכן.',
    '3. הרשימה: הלקוח אחראי לדיוק השמות, המספרים והכמויות, ולכך שהמספרים נאספו כדין. מספר שגוי או כפול אינו מזכה בהחזר.',
    '4. מועדי שליחה: ההודעות יוצאות בחלון הבוקר, לא בשבת, בשישי עד 15:00. הודעה שיצאה אינה ניתנת לביטול.',
    '5. מגבלות: השירות פועל על גבי וואטסאפ וכפוף למגבלותיה. אחריות ishur.io מוגבלת לסכום ששולם עבור האירוע.',
    '6. פרטיות: פרטי האירוע והרשימה משמשים לאירוע הזה בלבד ונמחקים עד 90 יום אחריו.',
  ].join('\n');
}

async function token(env) {
  const r = await fetch(API + '/account/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: env.MORNING_ID, secret: env.MORNING_SECRET }),
  }).catch(() => null);
  if (!r) return null;
  const j = await r.json().catch(() => ({}));
  return r.ok && j.token ? j.token : null;
}

/* → {ok, url, number, id} | {ok:false, why, detail} */
export async function createInvoice(env, p) {
  if (!env.MORNING_ID || !env.MORNING_SECRET) return { ok: false, why: 'not-configured' };
  const sum = Number(String(p.sum || '').replace(/[^\d.]/g, '')) || 0;
  if (!sum) return { ok: false, why: 'no-sum' };
  const t = await token(env);
  if (!t) return { ok: false, why: 'auth-failed' };

  const today = new Date().toISOString().slice(0, 10);
  const phone = String(p.phone || '').replace(/^972/, '0');
  const line = [
    'אישורי הגעה בוואטסאפ',
    p.plan ? `חבילת ${p.plan}` : '',
    p.tier ? `עד ${p.tier} הזמנות` : '',
    p.occasion ? `אירוע: ${p.occasion}` : '',
  ].filter(Boolean).join(' · ');

  const doc = {
    type: DOC_INVOICE_RECEIPT,
    lang: 'he',
    currency: 'ILS',
    date: today,
    description: line,
    remarks: invoiceTerms({ tier: p.tier, plan: p.plan }),
    footer: `אסמכתת סליקה (Grow): ${p.ref || ''} · שירות לקוחות בוואטסאפ 055-950-4499 · ishur.io`,
    client: {
      name: String(p.name || 'לקוח ishur.io').slice(0, 100),
      phone,
      emails: p.email ? [String(p.email)] : [],
      ...(p.taxId ? { taxId: String(p.taxId) } : {}),
      country: 'IL',
      add: false,
    },
    income: [{
      description: line,
      quantity: 1,
      price: sum,
      currency: 'ILS',
      vatType: 1,            // the price already includes VAT (what the client paid)
    }],
    payment: [{
      type: paymentType(p.payMethod),
      price: sum,
      currency: 'ILS',
      date: today,
    }],
  };
  const r = await fetch(API + '/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify(doc),
  }).catch(() => null);
  if (!r) return { ok: false, why: 'unreachable' };
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) return { ok: false, why: 'rejected', detail: JSON.stringify(j).slice(0, 300) };
  const url = (j.url && (j.url.he || j.url.origin)) || '';
  return { ok: true, id: String(j.id), number: String(j.number || ''), url };
}
