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
export function declineGiftText(gl, token) {
  if (!giftActive(gl)) return '';
  /* 22/11 Richard: one link for every guest (go.ishur.io/gift/<slug>). With one way to give it forwards straight there,
     with two it shows the choose page, and the open and the tap are counted. Without a token: the two links, as before. */
  if (token) return 'תודה שעדכנתם 🙏 אם תרצו לתת מתנה לבעלי השמחה, אפשר כאן:\n' + giftPageUrl(token);
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

/* ── 22/11 Richard: one link for every guest. One way to give → the link goes straight there (no page).
   Two or more → the page, where the guest chooses. Either way we count: opened, and which way was tapped.
   We can never know who actually paid in Bit or PayBox, only who tapped. ── */
export const GIFT_METHODS = ['bit', 'paybox'];   /* a credit-card method joins this list when it exists */
export function giftMethods(gl) {
  const m = {}; if (!giftActive(gl)) return m;
  const b = cleanLink(gl.bit), p = cleanLink(gl.paybox);
  if (b) m.bit = b; if (p) m.paybox = p;
  return m;
}
/* GET /gift/<slug>[/<method>] → { go, count } (forward) | { page:true } | { none:true } */
export function giftRoute(gl, method) {
  const m = giftMethods(gl), keys = Object.keys(m);
  if (!keys.length) return { none: true };
  if (method) return m[method] ? { go: m[method], count: method } : { page: keys.length > 1, go: keys.length === 1 ? m[keys[0]] : '', count: keys.length === 1 ? keys[0] : '' };
  if (keys.length === 1) return { go: m[keys[0]], count: keys[0], direct: true };
  return { page: true };
}
/* link previews and crawlers open the link too; they are forwarded like anyone, never counted */
export function giftCountable(ua) { return !/whatsapp|facebookexternalhit|facebot|bot\b|crawler|spider|preview|slack|telegram|curl|wget/i.test(String(ua || '')); }
/* Every open and every tap is its own small key (gifthit:<token>:<kind>:<time>:<rand>), written without reading
   anything first, so two guests in the same second never overwrite each other. The numbers are the count of keys.
   (This is a display number, not a limit: a listing that is a few seconds behind only shows the count a moment late.) */
export const GIFT_HIT_TTL = 400 * 86400;
export function giftHitKey(token, kind, now = Date.now(), rand = Math.random().toString(36).slice(2, 8)) { return `gifthit:${token}:${kind}:${now}:${rand}`; }
export function giftStatsFromKeys(names) {
  const s = { open: 0, bit: 0, paybox: 0 }; let first = 0, last = 0;
  for (const n of names || []) {
    const p = String(n).split(':'); const kind = p[2], ts = Number(p[3]) || 0;
    if (!(kind in s)) continue;
    s[kind]++; if (ts) { if (!first || ts < first) first = ts; if (ts > last) last = ts; }
  }
  if (first) { s.first = new Date(first).toISOString(); s.last = new Date(last).toISOString(); }
  return s;
}
export async function giftStats(env, token) {
  const names = []; let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await env.RATE.list({ prefix: 'gifthit:' + token + ':', cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    for (const k of page.keys || []) names.push(k.name);
    if (page.list_complete || !page.cursor) break; cursor = page.cursor;
  }
  return giftStatsFromKeys(names);
}

/* the page behind the button (GET /gift/<slug>) */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
/* Bit and PayBox open only on a phone with the app. On a computer the page also shows a code to scan with the phone. */
const QR_BLOCK = `<div id="qr" hidden style="margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--bdr)"><p style="margin:0 0 .7rem">במחשב? סרקו עם הטלפון:</p><div id="qrc" style="display:inline-block;background:#fff;padding:10px;border-radius:8px"></div></div>
<script>(function(){try{if(!(matchMedia('(hover:hover) and (pointer:fine)').matches&&innerWidth>700))return;var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';s.onload=function(){try{new QRCode(document.getElementById('qrc'),{text:location.origin+location.pathname,width:160,height:160});document.getElementById('qr').hidden=false}catch(e){}};document.head.appendChild(s)}catch(e){}})()</script>`;
export function giftPageHtml(gl, hosts, slug) {
  const bit = giftActive(gl) ? cleanLink(gl.bit) : '', pb = giftActive(gl) ? cleanLink(gl.paybox) : '';
  /* with a slug the buttons pass through us (/gift/<slug>/<method>) so the tap is counted; without one they are the links themselves */
  const via = (m, href) => (slug ? '/gift/' + esc(slug) + '/' + m : esc(href));
  const btn = (m, href, label) => `<a class="b" href="${via(m, href)}" rel="noopener" data-direct="${esc(href)}">${label}</a>`;
  const body = bit || pb
    ? `<h1>מתנה ל${esc(hosts || 'בעלי השמחה')}</h1><p>${bit && pb ? 'בחרו איך לתת:' : 'אפשר לשלוח מתנה ישירות, בלחיצה:'}</p>${bit ? btn('bit', bit, 'ביט') : ''}${pb ? btn('paybox', pb, 'פייבוקס') : ''}`
    : `<h1>אין כרגע קישור למתנה</h1><p>בעלי השמחה לא הוסיפו קישור ביט או פייבוקס.</p>`;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>מתנה לבעלי השמחה</title>
<style>:root{--bg:#F9FAFB;--ink:#111827;--mute:#6b7280;--card:#fff;--bdr:#e5e7eb;--acc:#0F4C35;--on:#fff}@media (prefers-color-scheme:dark){:root{--bg:#0E1512;--ink:#F3F4F6;--mute:#9CA3AF;--card:#141D19;--bdr:#2B3440;--acc:#7FD1A8;--on:#0E1512}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Heebo,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:24px 20px;max-width:420px;width:100%;text-align:center}h1{font-size:1.3rem;margin:0 0 .4rem}p{color:var(--mute);margin:0 0 1.2rem}
.b{display:block;padding:15px;border-radius:8px;background:var(--acc);color:var(--on);text-decoration:none;font-weight:600;font-size:1.05rem;margin:.6rem 0}.b:active{transform:scale(.99)}small{display:block;margin-top:1rem;color:var(--mute);font-size:.75rem}</style></head>
<body><main>${body}${bit || pb ? QR_BLOCK : ''}<small>ishur.io · אישורי הגעה</small></main></body></html>`;
}
