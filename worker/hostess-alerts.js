/* ============================================================================
   Hostess alerts to Slack (16/11/2026, Richard approved both):
     1. the client set (or changed) the event date for an event with hostesses
     2. a reminder 7 days before and 1 day before every event with hostesses
   Each line goes out once: a KV marker per event + kind + date, so a changed
   date arms the reminders again. Text follows his Slack format: a title, one
   fact per line, and a "מה לעשות" footer.
   §1 pure (unit-tested in test/hostess-alerts.test.mjs) · §2 I/O
   ============================================================================ */
const HOSTESS_SCREEN = 'https://ishur.io/next/calendar.html';
const dmy = iso => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
export const ilDay = (ts = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
export const ilHour = (ts = Date.now()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(ts))) % 24;
export function daysUntil(dateIso, todayIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(todayIso || ''))) return null;
  return Math.round((Date.parse(dateIso + 'T12:00:00Z') - Date.parse(todayIso + 'T12:00:00Z')) / 86400e3);
}
/* on site 40 minutes before the reception (Richard 12/11); travel time is not part of what Slack shows */
export function arrivalOf(reception) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(reception || '')); if (!m) return '';
  const t = ((Number(m[1]) * 60 + Number(m[2]) - 40) % 1440 + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
/* Slack's 24h title mute strips digits from the key, so two events could collapse into one: the event id goes in as letters only */
export const keyTok = tok8 => String(tok8 || '').replace(/\d/g, d => 'ghijklmnop'[d]);
const nHe = n => (Number(n) === 1 ? 'דיילת אחת' : (Number(n) || 1) + ' דיילות');
function facts(b, names) {
  const place = [b.venue, b.city].map(x => String(x || '').trim()).filter(Boolean).join(', ');
  const arr = arrivalOf(b.reception);
  return [
    '• ' + (String(b.client || '').trim() || 'אירוע ' + String(b.tok8 || '')),
    '• ' + dmy(b.date) + ' · ' + nHe(b.n),
    place ? '• ' + place : '',
    arr ? `• הגעה ${arr} (קבלת פנים ${b.reception})` : '',
    names == null ? '' : names.length ? '• משובצות: ' + names.join(', ') : '• עוד לא שובצו דיילות',
  ].filter(Boolean);
}
/* changed = the date or the number of hostesses is different from what was booked before */
export function bookingChanged(prev, next) {
  if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(String(next.date || ''))) return false;
  if (!prev) return true;
  return String(prev.date || '') !== String(next.date) || (Number(prev.n) || 1) !== (Number(next.n) || 1);
}
export function dateSetText(b, prev) {
  const title = prev && prev.date && prev.date !== b.date ? `📅 *דיילות: התאריך השתנה* (היה ${dmy(prev.date)})` : '📅 *דיילות: נקבע תאריך לאירוע*';
  return [title, '', ...facts(b, null), '', 'מה לעשות: לשבץ דיילות במסך דיילות', HOSTESS_SCREEN].join('\n');
}
export function reminderText(b, kind, names) {
  const title = kind === 'd1' ? '🧑‍💼 *דיילות: האירוע מחר*' : '🧑‍💼 *דיילות: האירוע בעוד שבוע*';
  const todo = names && names.length ? (kind === 'd1' ? 'לוודא שכל דיילת יודעת שעה ומקום' : 'לאשר הגעה מול הדיילות') : 'לשבץ דיילות עכשיו, אין שיבוץ לאירוע';
  return [title, '', ...facts(b, names || []), '', 'מה לעשות: ' + todo, HOSTESS_SCREEN].join('\n');
}
/* which reminder is due today for one booking: 7 days before, or the day before. Booked later than a week ahead → only the day-before one. */
export function dueKind(b, todayIso) {
  const d = daysUntil(b && b.date, todayIso);
  return d === 7 ? 'd7' : d === 1 ? 'd1' : null;
}

/* ── §2 I/O ─────────────────────────────────────────────────────────────── */
const pj = v => { try { return JSON.parse(v); } catch { return null; } };
/* called from writeHostessBooking BEFORE the new booking is stored (prev = what KV held) */
export async function alertDateSet(env, tok8, next, prev, { post } = {}) {
  if (!post || !bookingChanged(prev, next)) return { sent: false };
  await post(dateSetText({ ...next, tok8 }, prev), { key: 'hostess_date:' + keyTok(tok8) + ':' + keyTok(next.date), important: true, oneoff: true, urgent: false });
  return { sent: true };
}
/* cron: from 09:00 Israel time, once per event + kind + date */
export async function hostessReminders(env, { now = Date.now(), post, kvPrefix } = {}) {
  const out = { checked: 0, sent: 0 };
  if (!env.RATE || !post || !kvPrefix) return out;
  const h = ilHour(now); if (h < 9 || h >= 21) return out;
  const today = ilDay(now);
  const books = await kvPrefix(env, 'hostessbook:').catch(() => ({}));
  let staff = null, asg = null;
  for (const [tok, v] of Object.entries(books)) {
    const b = pj(v); if (!b) continue; out.checked++;
    const kind = dueKind(b, today); if (!kind) continue;
    const tok8 = tok.slice(0, 8), mk = `hostrem:${tok8}:${kind}:${b.date}`;
    if (await env.RATE.get(mk).catch(() => '1')) continue;
    if (!staff) { [staff, asg] = await Promise.all([kvPrefix(env, 'staff:').catch(() => ({})), kvPrefix(env, 'hostassign:').catch(() => ({}))]); }
    const names = (pj(asg[tok8] || 'null') || []).map(ph => (pj(staff[ph] || 'null') || {}).name).filter(Boolean);
    await env.RATE.put(mk, new Date(now).toISOString(), { expirationTtl: 30 * 86400 });
    await post(reminderText({ ...b, tok8 }, kind, names), { key: `hostess_${kind === 'd1' ? 'day' : 'week'}:${keyTok(tok8)}:${keyTok(b.date)}`, important: true, oneoff: true, urgent: true });
    out.sent++;
  }
  return out;
}
