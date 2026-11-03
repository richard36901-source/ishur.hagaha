/* ============================================================================
   ishur.io · gifts.js · Bit / PayBox gift links to guests (Richard 02/11)
   ----------------------------------------------------------------------------
   "נניח אם לא מגיעים — לשלוח: במידה ותרצו לתת מתנה תוכלו לבצע זאת כאן. רק
    במידה והוסיפו קישור. ואז ביום האירוע ביחד עם הוויז או השולחן, אחד מהם..."

   KV giftlinks:<token> = { bit, paybox, on }  (set from the client dashboard,
   POST /api/giftlinks — only bit/paybox domains are accepted there).

   Three places a gift line can appear:
     a) a guest answers "לא מגיע" → the in-window reply carries the links
        (free text, no template). Once per guest: gift:<token>:<phone>.
     b) event day → ONE gift line, on the table message if the event has
        seating, otherwise on the event-day (waze) message. Never both.
        Templates *_matana carry a URL button https://go.ishur.io/gift/{{1}}
        (our own domain; {{1}} = the first 8 chars of the token) — the page
        lists the Bit / PayBox buttons. Used only once Meta APPROVED them as
        UTILITY; otherwise the current template goes out unchanged.
     c) /api/gift-blast — a one-off after the event (Kriaf, 03/11).

   §1 pure (unit-tested) · §2 KV/route helpers
   ========================================================================== */

const LINK_RE = /^https:\/\/(www\.)?(bit\.co\.il|bitpay\.co\.il|app\.bitpay\.co\.il|paybox\.co\.il|payboxapp\.com|links\.payboxapp\.com)\//i;
export function cleanLink(u) { const s = String(u || '').trim(); return s && LINK_RE.test(s.replace(/^http:/i, 'https:')) ? s.replace(/^http:/i, 'https:') : ''; }
export function giftActive(gl) { return !!(gl && gl.on && (cleanLink(gl.bit) || cleanLink(gl.paybox))); }
export function giftKey(token, phone) { return `gift:${token}:${String(phone || '').replace(/\D/g, '')}`; }
export function giftSlug(token) { return String(token || '').slice(0, 8); }
export function giftPageUrl(token) { return 'https://go.ishur.io/gift/' + giftSlug(token); }

/* a) the reply to "לא מגיע". Plural address, no "הנחה". '' = nothing to add. */
export function declineGiftText(gl) {
  if (!giftActive(gl)) return '';
  const bit = cleanLink(gl.bit), pb = cleanLink(gl.paybox);
  return ['תודה שעדכנתם 🙏 אם תרצו לתת מתנה לבעלי השמחה, אפשר כאן:', bit ? 'ביט: ' + bit : '', pb ? 'פייבוקס: ' + pb : ''].filter(Boolean).join('\n');
}

/* b) which ONE event-day message carries the gift line */
export function eventDayGiftSlot({ giftOn, hasSeating }) {
  if (!giftOn) return null;
  return hasSeating ? 'table' : 'eventday';
}
export function eventHasSeating(gRows, token) {
  return (gRows || []).some(g => String((g || [])[28] || '').trim() === token && String((g || [])[30] || '').trim() && String((g || [])[15] || '').trim() === 'מגיע');
}
/* the gift variant of a base template: '<base>_matana'. ishur_shulchan_f (the
   footer copy) maps to ishur_shulchan_matana too — the new one has the footer. */
export function giftVariantName(base) {
  const b = String(base || '').replace(/_f$/, '');
  if (b === 'ishur_shulchan') return 'ishur_shulchan_matana';
  if (b === 'ishur_yom_haerua') return 'ishur_yom_haerua_matana';
  return '';
}
/* the URL-button component every *_matana template needs at send time */
export function giftButtonComponent(token) {
  return { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: giftSlug(token) }] };
}

/* c) who gets what in the post-event blast. Pure.
   guests: [{ phone, name, rsvp }] (deduped by phone here)
   sentMarks: Set of phones already given a gift message (gift:<token>:<phone>)
   blocked:   Set of phones that opted out / wrong number
   returns { refuse, why, list:[{phone,name,rsvp,kind,template,action,reason}] } */
export function planGiftBlast({ today, eventDate, hour, windowOpen, gl, guests, sentMarks = new Set(), blocked = new Set(), room = 0, max = 50, templates = {} }) {
  const refuse = why => ({ refuse: true, why, list: [], counts: {} });
  if (!giftActive(gl)) return refuse('gift-links-off');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || ''))) return refuse('no-event-date');
  if (today === eventDate) return refuse('event-day');
  if (today < eventDate) return refuse('before-event');
  const daysAfter = Math.round((Date.parse(today) - Date.parse(eventDate)) / 864e5);
  if (daysAfter > 7) return refuse('too-late');
  const h = Number(hour);
  if (!(h >= 9 && h < 21)) return refuse('outside-09-21');
  if (!windowOpen) return refuse('send-window-closed');
  const seen = new Set(); const list = [];
  const roomN = Math.max(0, Number(room) || 0), maxN = Math.max(0, Number(max) || 0);
  let sendN = 0;
  for (const g of guests || []) {
    const phone = String(g.phone || ''); if (!phone || seen.has(phone)) continue; seen.add(phone);
    const rsvp = String(g.rsvp || '');
    const kind = rsvp === 'מגיע' ? 'thanks' : rsvp === 'לא מגיע' ? 'declined' : '';
    if (!kind) continue;   /* never answered / undecided: no gift message */
    const template = kind === 'thanks' ? (templates.thanks || '') : (templates.declined || '');
    const row = { phone, name: String(g.name || '').trim(), rsvp, kind, template };
    if (sentMarks.has(phone)) { list.push({ ...row, action: 'skip', reason: 'already-got-gift-message' }); continue; }
    if (blocked.has(phone)) { list.push({ ...row, action: 'skip', reason: 'optout-or-wrong-number' }); continue; }
    if (!template) { list.push({ ...row, action: 'hold', reason: 'template-not-approved' }); continue; }
    if (sendN >= roomN) { list.push({ ...row, action: 'hold', reason: 'held: cap' }); continue; }
    if (sendN >= maxN) { list.push({ ...row, action: 'hold', reason: 'max-reached' }); continue; }
    sendN++; list.push({ ...row, action: 'send', reason: '' });
  }
  const counts = { thanks: 0, declined: 0, send: 0, hold: 0, skip: 0 };
  for (const x of list) { counts[x.kind]++; counts[x.action]++; }
  return { refuse: false, why: '', list, counts };
}

/* the page behind the button (GET /gift/<slug>) */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function giftPageHtml(gl, hosts) {
  const bit = giftActive(gl) ? cleanLink(gl.bit) : '', pb = giftActive(gl) ? cleanLink(gl.paybox) : '';
  const btn = (href, label) => `<a class="b" href="${esc(href)}" rel="noopener">${label}</a>`;
  const body = bit || pb
    ? `<h1>מתנה ל${esc(hosts || 'בעלי השמחה')} 🎁</h1><p>אפשר לשלוח מתנה ישירות, בלחיצה:</p>${bit ? btn(bit, 'ביט') : ''}${pb ? btn(pb, 'פייבוקס') : ''}`
    : `<h1>אין כרגע קישור למתנה</h1><p>בעלי השמחה לא הוסיפו קישור ביט או פייבוקס.</p>`;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>מתנה לבעלי השמחה</title>
<style>:root{--bg:#FAF8F3;--ink:#1B2620;--mute:#5F6B64;--card:#fff;--acc:#0F2E22}@media (prefers-color-scheme:dark){:root{--bg:#121714;--ink:#EDEFEA;--mute:#A9B3AD;--card:#1B221E;--acc:#7BC9A4}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:var(--card);border-radius:18px;padding:24px 20px;max-width:420px;width:100%;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{font-size:1.3rem;margin:0 0 .4rem}p{color:var(--mute);margin:0 0 1.2rem}
.b{display:block;padding:14px;border-radius:12px;background:var(--acc);color:var(--card);text-decoration:none;font-weight:600;margin:.6rem 0}small{display:block;margin-top:1rem;color:var(--mute);font-size:.75rem}</style></head>
<body><main>${body}<small>ishur.io · אישורי הגעה</small></main></body></html>`;
}
