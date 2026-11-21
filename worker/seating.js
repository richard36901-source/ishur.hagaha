/* ============================================================================
   ishur.io · seating.js · "איזה שולחן אני?" answered on the guests line (09/11)
   ----------------------------------------------------------------------------
   Richard 09/11 (שילת): the event-day message with the table number could not
   reach everyone (daily cap). A guest who WRITES to 6673 opens a 24h window, so
   a free-text answer costs no template and no cap. When the question is about
   the table, answer with the guest's table (sheet column AE = index 30) and
   who else sits there. No table on the sheet → not handled (falls through to
   the usual "מעבירים לבעלי השמחה").
   Pure functions only; index.js wires them into guestFreeText.
   ========================================================================== */

/* the guest is asking where they sit (not "is there a table for kids" etc. — good enough for event day) */
export function isTableQuestion(text) {
  const t = String(text || '').replace(/[‎‏]/g, '').trim();
  if (!t) return false;
  if (/שולחן|שולחנות|הושבה|סידור\s*ישיבה/.test(t)) return true;
  return /(איפה|היכן|באיזה\s*מקום)\s*(אני|אנחנו|אנו)?\s*(יושב|יושבת|יושבים|יושבות|נשב|אשב)/.test(t);
}

const norm = v => String(v ?? '').trim().replace(/\s+/g, ' ');
const tableKey = v => norm(v).replace(/^שולחן\s*(מס(פר|׳|')?\.?)?\s*/, '').toLowerCase();

/* raw = sheet snapshot; guest = findGuestByPhone result ({token, guest_id, name})
   → null when the guest has no table, else { table, mates: [names, self first], more } */
export function tableFor(raw, guest, { max = 30 } = {}) {
  if (!raw || !guest || !guest.token) return null;
  const rows = (raw.guests && raw.guests.values) || [];
  const mine = rows.find(r => norm(r[28]) === guest.token && norm(r[2]) === String(guest.guest_id || ''));
  const table = mine ? norm(mine[30]) : '';
  if (!table) return null;
  const key = tableKey(table);
  const self = norm(mine[3]);
  const seen = new Set(), names = [];
  for (const r of rows) {
    if (norm(r[28]) !== guest.token || tableKey(r[30]) !== key) continue;
    if (norm(r[15]) === 'לא מגיע') continue;
    const n = norm(r[3]);
    if (!n || seen.has(n)) continue;
    seen.add(n); names.push(n);
  }
  names.sort((a, b) => (a === self ? -1 : b === self ? 1 : 0));
  return { table, mates: names.slice(0, max), more: Math.max(0, names.length - max) };
}

/* the WhatsApp text */
export function tableReply(info) {
  if (!info) return '';
  const label = /^שולחן/.test(info.table) ? info.table : `שולחן ${info.table}`;
  const lines = [`🪑 ${label}`];
  if (info.mates.length > 1) {
    lines.push('', 'יושבים בשולחן:');
    for (const n of info.mates) lines.push('• ' + n);
    if (info.more) lines.push(`ועוד ${info.more}`);
  }
  lines.push('', 'נתראה באירוע 🙂');
  return lines.join('\n');
}

/* ══ 22/11 Richard: venue items on the seating plan (חופה, בר, במה, מטבח…), each with its own shape, name and colour,
   so the client lays out the whole hall. They sit next to the tables in seatplan:<token> and never take guests.
   Everything a client sends is cleaned here: known kinds and shapes only, a #rrggbb colour, short plain text. ══ */
export const VENUE_KINDS = ['chuppah', 'bar', 'stage', 'kitchen', 'dance', 'dj', 'entrance', 'buffet', 'photo', 'gifts', 'other'];
export const VENUE_SHAPES = ['rect', 'round', 'hex', 'oct'];
export function cleanVenueItems(list) {
  if (!Array.isArray(list)) return [];
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
  return list.slice(0, 60).filter(it => it && typeof it === 'object').map(it => ({
    kind: VENUE_KINDS.includes(it.kind) ? it.kind : 'other',
    shape: VENUE_SHAPES.includes(it.shape) ? it.shape : 'rect',
    label: String(it.label == null ? '' : it.label).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24),
    color: /^#[0-9a-f]{6}$/i.test(String(it.color || '')) ? String(it.color).toLowerCase() : '#e8dcc0',
    x: num(it.x, 0, 4000, 0), y: num(it.y, 0, 4000, 0),
    w: num(it.w, 30, 800, 140), h: num(it.h, 30, 800, 100),
  }));
}
