/* ============================================================================
   ishur.io · guest file parsing
   ----------------------------------------------------------------------------
   The upload page promises: column A = guest name, column B = phone,
   column C (optional) = how many invited. This module turns a raw uploaded
   CSV / XLSX / XLS into that shape, or throws when the bytes are not really
   a spreadsheet. All the "is this a real file" logic lives here, in code that
   can be unit-tested with node — Make only ever sees clean rows.
   ========================================================================== */

import * as XLSX from 'xlsx';

/* Same normalization the payment route uses: everything becomes 9725XXXXXXXX */
export function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  /* Excel and Numbers store phones as numbers and eat the leading zero:
     545764327 is really 0545764327. Nine digits starting with 5 = mobile. */
  if (/^5\d{8}$/.test(d)) return '972' + d;
  return d;
}

/* ── cp1255 fallback ── old Hebrew Excel saves CSV in windows-1255, which the
   Workers runtime's TextDecoder does not know. Single-byte map, done by hand. */
const CP1255_HIGH = {
  0xA0: ' ', 0xA2: '¢', 0xA3: '£', 0xA4: '₪', 0xA5: '¥',
  0xB4: '´', 0xB7: '·', 0xBF: '¿',
};
function decodeCp1255(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xE0 && b <= 0xFA) out += String.fromCharCode(0x05D0 + b - 0xE0); // א-ת
    else out += CP1255_HIGH[b] || ' ';
  }
  return out;
}

function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  try {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
    return text;
  } catch {
    return decodeCp1255(bytes);
  }
}

/* ── CSV ── state machine so quoted cells with commas or newlines survive.
   Delimiter is whichever of , ; tab appears most outside quotes up front. */
export function parseCsv(text) {
  const head = text.slice(0, 2000);
  let best = ',', bestCount = -1;
  for (const d of [',', ';', '\t']) {
    const c = head.split(d).length;
    if (c > bestCount) { bestCount = c; best = d; }
  }
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === best) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

/* Raw upload → array-of-arrays. Throws on anything that is not a spreadsheet. */
export function parseGuestFile(fileName, buf) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.csv')) {
    return parseCsv(decodeText(buf));
  }
  /* xlsx is a ZIP (PK..), xls is a CFB container (D0 CF 11 E0). SheetJS is
     forgiving with garbage, so the magic bytes are checked here first —
     a renamed PDF or .exe stops at this line. */
  const m = new Uint8Array(buf.slice(0, 4));
  const isZip = m[0] === 0x50 && m[1] === 0x4B && m[2] === 0x03 && m[3] === 0x04;
  const isCfb = m[0] === 0xD0 && m[1] === 0xCF && m[2] === 0x11 && m[3] === 0xE0;
  if (!isZip && !isCfb) throw new Error('not-a-spreadsheet');
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const first = wb.SheetNames[0];
  if (!first) throw new Error('empty-workbook');
  return XLSX.utils.sheet_to_json(wb.Sheets[first], { header: 1, raw: false, defval: '' });
}

/* Rows → guests, applying the column contract.
   Row 1 is treated as a header when its phone column is not a phone.
   Kept out: bad phones, landlines, duplicates — each with a reason, so the
   response can tell the client what was left behind. */
export function guestsFromRows(rows) {
  const guests = [], skipped = [], seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[0] ?? '').trim();
    const rawPhone = String(r[1] ?? '').trim();
    if (!name && !rawPhone) continue;
    const phone = normPhone(rawPhone);
    const mobile = /^9725\d{8}$/.test(phone);
    if (i === 0 && !mobile) continue; // header row
    if (!mobile) { skipped.push({ row: i + 1, name, phone: rawPhone, why: 'טלפון לא תקין' }); continue; }
    if (seen.has(phone)) { skipped.push({ row: i + 1, name, phone: rawPhone, why: 'כפול' }); continue; }
    seen.add(phone);
    const party = String(r[2] ?? '').trim();
    guests.push({
      name: name || 'אורח ' + (guests.length + 1),
      phone,
      party: /^\d{1,3}$/.test(party) ? party : '',
    });
  }
  return { guests, skipped };
}
