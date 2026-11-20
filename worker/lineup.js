/* "לוז אירוע" (Richard 20/11/2026): the schedule of the event day, worked back from the reception and the ceremony,
   editable line by line, and one calendar feed for Apple or Google Calendar.
   KV lineup:<token> = { date, title, venue, from, drive, ceremony, items:[{m, text}] }. m = minutes from midnight of
   the event day; 1440 and up is after midnight. One KV write per save, one read per calendar refresh.
   The suggestion is Claude's first setting (20/11), to be tuned. Travel time is typed by the client: an automatic one
   needs a paid maps service (spec: no new paid service). */
const MAX_ITEMS = 40;
const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
export const toHM = m => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };

export function suggest({ occasion = '', reception = '', ceremony = '', drive = 30, from = '' } = {}) {
  const R = hm(reception) ?? 19 * 60, wedding = /חתונה|wedding/i.test(occasion);
  const C = hm(ceremony) ?? R + (wedding ? 60 : 45), D = Math.max(0, Math.min(300, Number(drive) || 0));
  const leave = R - 60 - D - 15;
  const L = wedding ? [
    [R - 300, 'תחילת איפור ושיער'],
    [R - 180, 'הצלם מגיע, התארגנות ולבוש'],
    [R - 150, 'צילומי זוג ומשפחה'],
    [leave, 'יציאה לאולם' + (from ? ' מ' + from : '') + ` (${D} דקות נסיעה + 15 דקות מרווח)`],
    [R - 60, 'הגעה לאולם ובדיקת הסידורים עם המפיק'],
    [R, 'קבלת פנים'],
    [C - 20, 'חתימה על הכתובה'],
    [C, 'חופה'],
    [C + 40, 'כניסה לאולם וריקוד ראשון'],
    [C + 70, 'מנה ראשונה'],
    [C + 150, 'ריקודים'],
    [C + 300, 'סיום האירוע'],
  ] : [
    [R - 180, 'התארגנות ולבוש'],
    [leave, 'יציאה לאולם' + (from ? ' מ' + from : '') + ` (${D} דקות נסיעה + 15 דקות מרווח)`],
    [R - 60, 'הגעה לאולם ובדיקת הסידורים'],
    [R, 'קבלת פנים'],
    [C, 'טקס / פתיחה'],
    [C + 30, 'ארוחה'],
    [C + 120, 'ריקודים'],
    [C + 240, 'סיום האירוע'],
  ];
  return L.map(([m, text]) => ({ m: Math.max(0, m), text })).sort((a, b) => a.m - b.m);
}

const str = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
export function clean(b = {}) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS)
    .map(it => ({ m: Math.round(Number(it && it.m)), text: str(it && it.text, 80) }))
    .filter(it => Number.isFinite(it.m) && it.m >= 0 && it.m < 2880 && it.text)
    .sort((a, b) => a.m - b.m);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : '';
  return { date, title: str(b.title, 80), venue: str(b.venue, 120), from: str(b.from, 80), drive: Math.max(0, Math.min(300, Math.round(Number(b.drive) || 0))), ceremony: hm(b.ceremony) != null ? toHM(hm(b.ceremony)) : '', items };
}

export async function feedKey(env, token) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.ADMIN_KEY || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('lineup:' + token)));
  return Array.from(sig.slice(0, 8), x => x.toString(16).padStart(2, '0')).join('');
}

/* Israel local time on a date → UTC "YYYYMMDDTHHMMSSZ" (the offset is read for that very day, so DST is right) */
export function ilUtc(date, m) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, 0) + m * 60e3;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asIl = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const t = new Date(guess - (asIl - guess));
  return t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,');
const fold = line => { const out = []; let s = line; while (Buffer.byteLength(s, 'utf8') > 74) { let n = 70; while (Buffer.byteLength(s.slice(0, n), 'utf8') > 74) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); };

/* One calendar entry per line. A line lasts until the next one (at most 3 hours); the last one 30 minutes.
   UIDs are fixed per token and position, so a subscribed calendar updates the same entries. */
export function ics(rec, token, stamp = new Date()) {
  const now = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ishur.io//lineup//HE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', fold('X-WR-CALNAME:' + esc('לוז · ' + (rec.title || 'האירוע'))), 'X-WR-TIMEZONE:Asia/Jerusalem', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  if (rec.date) rec.items.forEach((it, i) => {
    const next = rec.items[i + 1], end = next ? Math.min(next.m, it.m + 180) : it.m + 30;
    L.push('BEGIN:VEVENT', `UID:lineup-${token.slice(0, 8)}-${i}@ishur.io`, 'DTSTAMP:' + now, 'DTSTART:' + ilUtc(rec.date, it.m), 'DTEND:' + ilUtc(rec.date, Math.max(end, it.m + 5)), fold('SUMMARY:' + esc(it.text)));
    if (rec.venue) L.push(fold('LOCATION:' + esc(rec.venue)));
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}
