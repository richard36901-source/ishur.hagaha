/* ============================================================================
   ishur.io · inbox-search.js · the inbox search box (Richard 23/11/2026:
   "באינבוקס תוסיף חיפוש לפי טלפון שם או שם אירוע")
   ----------------------------------------------------------------------------
   Pure. The inbox list is filtered on the server, over every conversation and
   not only the 400 newest the page shows.
   nameOf: { <phone 972…>: { name, kind, event } } from the sheet.
   ========================================================================== */
const low = s => String(s == null ? '' : s).replace(/[‎‏]/g, '').trim().toLowerCase();

export function cleanQuery(q) { return low(q).slice(0, 60); }

/* a phone typed any way people type it: 052-333…, 97252…, +972 52… → the digits that sit inside 9725… */
export function phoneNeedle(q) {
  const d = String(q || '').replace(/\D/g, '');
  if (d.length < 3) return '';
  if (d.startsWith('972')) return d;
  return d.replace(/^0/, '');
}

/* Hebrew names are spelled both ways ("חגי" / "חגאי", "נתנאל" / "נתנל"): a second pass without the vowel letters */
const bare = s => low(s).replace(/[אוי]/g, '');
/* every typed word has to be somewhere in the text, in any order */
export function textHit(hay, q) {
  const words = cleanQuery(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = low(hay), hb = bare(hay);
  return words.every(w => h.includes(w) || (bare(w).length >= 2 && hb.includes(bare(w))));
}
/* true when the query is a phone (no letters) and its digits sit inside this number */
export function phoneHit(phone, q) {
  if (/[a-z\u0590-\u05ff]/.test(low(q))) return false;
  const d = phoneNeedle(q);
  return !!d && String(phone || '').replace(/\D/g, '').includes(d);
}

export function inboxSearch(list, nameOf, q) {
  if (!cleanQuery(q)) return list;
  return list.filter(c => {
    if (phoneHit(c.phone, q)) return true;
    const h = (nameOf && nameOf[c.phone]) || {};
    return textHit([h.name, h.event, c.wa_name].join(' '), q);
  });
}
