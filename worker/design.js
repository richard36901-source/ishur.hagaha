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
  if (!/עיצוב\s*הזמנה/.test(d)) return false;
  /* 03/11 incident: "100 רשומות בסיס + עיצוב הזמנה" is a package WITH design,
     not design-only. A package in the words or a pkg: code in the custom
     fields sends it down the normal purchase path. */
  if (/\d{2,4}\s*(?:מוזמנים|רשומות)/.test(d)) return false;
  const cf = ['cField1', 'cfield1', 'customField1', 'cField2', 'cField3'].map(k => String(flat[k] || '')).join(' ');
  return !/pkg:(?:basic|pro|premium):\d/.test(cf);
}
export function designTokenOf(flat) {
  for (const k of ['cField1', 'cfield1', 'customField1', 'cField2', 'cField3']) {
    const v = String(flat[k] || '').trim();
    const m = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) return m[0].toLowerCase();
  }
  return '';
}

/* ══ 03/11 design flow inside the client dashboard ═══════════════════════════
   Only for events whose design is paid (design:<token>.status === 'paid').
   KV:
     designbrief:<token>  the client's wishes {source:'dashboard', text, refs[], at}
                          (design.html writes the same key with its long form)
     designflow:<token>   versions + status + rounds (this module's state machine)
     dfile:<token>:<id>   uploaded bytes (inspiration images / design versions)
   design:<token> stays the paid flag only: four readers and the paylink tests
   key on its status === 'paid', so the flow state lives next to it. */

export const DESIGN_ROUND_PRICE = 49;          /* ₪ per paid round, server-side only */
export const DESIGN_REF_MAX = 5;               /* inspiration images per brief */
export const DESIGN_FLOW_STATUSES = ['new', 'awaiting_client', 'changes_requested', 'approved', 'done'];
export const DESIGN_ROUND_DESC = 'סבב תיקונים נוסף לעיצוב';   /* never "עיצוב הזמנה": isDesignPayment would grab it */
export const DFILE_ID_RE = /^[0-9a-f]{16}$/;

/* dashboard brief: free text + up to 5 uploaded media ids */
export function validateClientBrief(b) {
  if (!b || typeof b !== 'object') return { ok: false, why: 'bad-body' };
  const text = clipLong(b.text, 3000);
  if (text.replace(/\s/g, '').length < 5) return { ok: false, why: 'text' };
  const raw = Array.isArray(b.refs) ? b.refs : [];
  if (raw.length > DESIGN_REF_MAX) return { ok: false, why: 'too-many-refs' };
  const refs = [...new Set(raw.map(String))];
  if (refs.some(id => !DFILE_ID_RE.test(id))) return { ok: false, why: 'bad-ref' };
  return { ok: true, brief: { source: 'dashboard', text, refs } };
}

/* 12/11 Richard: "סך הכל 2 סבבים ומעבר 49" — two rounds are part of the design, every further one is paid.
   A flow saved under the old rule (rounds_free: 1) is read with the two it is now owed. */
export const DESIGN_ROUNDS_INCLUDED = 2;
export function newFlow() {
  return { versions: [], status: 'new', rounds_used: 0, rounds_free: DESIGN_ROUNDS_INCLUDED, rounds_paid: 0, free_claimed: false, comments: [] };
}
export const roundsTotal = f => Math.max(f.rounds_free || 0, DESIGN_ROUNDS_INCLUDED) + (f.rounds_paid || 0);
/* a change request that has not been answered yet holds a round already */
const roundsCommitted = f => (f.rounds_used || 0) + (f.status === 'changes_requested' ? 1 : 0);
export const canRequestChanges = f => f.status === 'awaiting_client' && roundsCommitted(f) < roundsTotal(f);

/* every transition returns { ok, flow } or { ok:false, why } and never mutates its input */
export function addVersion(flow, { media, note, at }) {
  const f = JSON.parse(JSON.stringify(flow || newFlow()));
  if (f.status === 'approved' || f.status === 'done') return { ok: false, why: 'already-approved' };
  if (!DFILE_ID_RE.test(String(media || ''))) return { ok: false, why: 'bad-media' };
  /* rounds_used grows only when we answer a change request with a new version */
  if (f.status === 'changes_requested') f.rounds_used = (f.rounds_used || 0) + 1;
  f.versions.push({ n: f.versions.length + 1, media: String(media), note: clipLong(note, 1000), at: at || new Date().toISOString() });
  f.status = 'awaiting_client';
  return { ok: true, flow: f };
}
export function approveDesign(flow, at) {
  const f = JSON.parse(JSON.stringify(flow || newFlow()));
  if (f.status !== 'awaiting_client' || !f.versions.length) return { ok: false, why: 'nothing-to-approve' };
  f.status = 'approved'; f.approved_at = at || new Date().toISOString(); f.approved_version = f.versions.length;
  return { ok: true, flow: f };
}
export function requestChanges(flow, comment, at) {
  const f = JSON.parse(JSON.stringify(flow || newFlow()));
  const text = clipLong(comment, 2000);
  if (text.replace(/\s/g, '').length < 2) return { ok: false, why: 'comment' };
  if (f.status !== 'awaiting_client') return { ok: false, why: 'not-awaiting' };
  if (!canRequestChanges(f)) return { ok: false, why: 'no-rounds-left' };
  f.status = 'changes_requested';
  f.comments.push({ v: f.versions.length, text, at: at || new Date().toISOString() });
  return { ok: true, flow: f };
}
/* "רכישת סבב נוסף": the first click, before any paid round and while the
   included round is still unused, claims the free round with no payment.
   Every later click is a ₪49 payment (granted by the IPN, grantPaidRound). */
export function buyRound(flow) {
  const f = JSON.parse(JSON.stringify(flow || newFlow()));
  if (f.status === 'approved' || f.status === 'done') return { ok: false, why: 'already-approved' };
  /* 12/11: a round is bought only when none is left — while one is open the client simply writes the notes */
  if (roundsCommitted(f) < roundsTotal(f)) return { ok: false, why: 'rounds-left' };
  return { ok: true, free: false, pay: true, price: DESIGN_ROUND_PRICE, flow: f };
}
export function grantPaidRound(flow, ref) {
  const f = JSON.parse(JSON.stringify(flow || newFlow()));
  f.rounds_paid = (f.rounds_paid || 0) + 1;
  f.paid_refs = [...(f.paid_refs || []), String(ref || '')].slice(-20);
  return { ok: true, flow: f };
}
export function markDone(flow, at) {
  const f = JSON.parse(JSON.stringify(flow || newFlow()));
  if (f.status !== 'approved') return { ok: false, why: 'not-approved' };
  f.status = 'done'; f.done_at = at || new Date().toISOString();
  return { ok: true, flow: f };
}

/* Grow IPN: "q:<id>|design_round:1|t:<token>" in the custom fields */
export function designRoundRef(flat) {
  flat = flat || {};
  const all = ['cField1', 'cfield1', 'customField1', 'cField2', 'cField3'].map(k => String(flat[k] || '')).join(' ');
  if (!/\bdesign_round:1\b/.test(all)) return null;
  const id = (all.match(/\bq:([0-9a-f]{12})\b/) || [])[1] || '';
  const token = ((all.match(/\bt:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i) || [])[1] || '').toLowerCase();
  return { id, token };
}
