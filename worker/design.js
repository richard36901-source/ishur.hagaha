/* ══ invitation design add-on (עיצוב הזמנה, ₪79) ════════════════════════════
   design.html posts a short brief here after the Grow payment. The brief
   becomes one item on the Monday board "עיצובי הזמנות - אישור הגעה".
   Pure validation lives in validateDesignBrief so it can be unit-tested. */

export const DESIGN_BOARD = '18434975667';
export const DESIGN_STYLES = ['קלאסי', 'מודרני', 'מינימליסטי', 'צבעוני', 'זהב/שמנפניה', 'אחר'];
const TYPES = ['חתונה', 'חינה', 'בר מצווה', 'בת מצווה', 'ברית / בריתה', 'יום הולדת', 'אירוע חברה', 'אחר'];

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const clipLong = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);

/* returns { ok:true, brief } or { ok:false, why } */
export function validateDesignBrief(b) {
  if (!b || typeof b !== 'object') return { ok: false, why: 'bad-body' };
  if (b.hp) return { ok: false, why: 'bot' };
  const names = clip(b.names, 120);
  if (names.length < 2) return { ok: false, why: 'names' };
  const event_type = clip(b.event_type, 40);
  if (!TYPES.includes(event_type)) return { ok: false, why: 'event_type' };
  const date = clip(b.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) return { ok: false, why: 'date' };
  const time = clip(b.time, 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, why: 'time' };
  const digits = String(b.phone || '').replace(/\D/g, '');
  const phone = /^05\d{8}$/.test(digits) ? '972' + digits.slice(1) : /^9725\d{8}$/.test(digits) ? digits : '';
  if (!phone) return { ok: false, why: 'phone' };
  const link = clip(b.link, 500);
  if (link && !/^https?:\/\/[^\s"<>]+$/i.test(link)) return { ok: false, why: 'link' };
  const token = clip(b.token, 64);
  if (token && !/^[0-9a-f-]{8,64}$/i.test(token)) return { ok: false, why: 'token' };
  const styles = (Array.isArray(b.styles) ? b.styles : []).map(s => clip(s, 20)).filter(s => DESIGN_STYLES.includes(s));
  return { ok: true, brief: {
    token, names, event_type, date, time, phone, link, styles,
    venue: clip(b.venue, 200), colors: clip(b.colors, 120), wording: clipLong(b.wording, 2000),
  } };
}

export function designItemName(br) {
  const [y, m, d] = br.date.split('-');
  return `${br.names} · ${br.event_type} · ${d}/${m}/${y}`.slice(0, 250);
}

export function designColumns(br, withStatus) {
  const details = [
    `שמות: ${br.names}`,
    br.time ? `שעה: ${br.time}` : '',
    br.venue ? `מקום: ${br.venue}` : '',
    br.wording ? `נוסח:\n${br.wording}` : '',
  ].filter(Boolean).join('\n');
  const cv = {
    phone_mm81hqna: { phone: br.phone, countryShortName: 'IL' },
    text_mm81ph5z: br.event_type,
    date_mm81mey2: { date: br.date },
    long_text_mm81e12k: { text: details },
    text_mm81xtxv: [br.styles.join(', '), br.colors].filter(Boolean).join(' · '),
    numeric_mm81k0s: '0',
    text_mm81q0xy: br.token || '',
  };
  if (br.link) cv.link_mm81f8cd = { url: br.link, text: 'השראה' };
  if (withStatus) cv.color_mm81wt31 = { label: 'חדש' };
  return cv;
}

/* creates the Monday item; tries with status "חדש" first and, if the board has
   no such label, once more without it. Throws when both fail. */
export async function createDesignItem(mondayGql, env, br) {
  const q = 'mutation($b: ID!, $n: String!, $v: JSON!) { create_item(board_id: $b, item_name: $n, column_values: $v, create_labels_if_missing: false) { id } }';
  const name = designItemName(br);
  try {
    const r = await mondayGql(env, q, { b: DESIGN_BOARD, n: name, v: JSON.stringify(designColumns(br, true)) });
    return r && r.create_item ? r.create_item.id : (r && r.data && r.data.create_item ? r.data.create_item.id : null);
  } catch (e) {
    const r = await mondayGql(env, q, { b: DESIGN_BOARD, n: name, v: JSON.stringify(designColumns(br, false)) });
    return r && r.create_item ? r.create_item.id : (r && r.data && r.data.create_item ? r.data.create_item.id : null);
  }
}

/* Grow IPN: is this the design add-on page? */
export function isDesignPayment(flat) {
  const d = [flat.paymentDesc, flat.description, flat.productName, flat.pageTitle, flat.title].map(x => String(x || '')).join(' ');
  return /עיצוב\s*הזמנה/.test(d);
}
export function designTokenOf(flat) {
  for (const k of ['cField1', 'cfield1', 'customField1', 'cField2', 'cField3']) {
    const v = String(flat[k] || '').trim();
    const m = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) return m[0].toLowerCase();
  }
  return '';
}
