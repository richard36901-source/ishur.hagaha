/* ============================================================================
   ishur.io · seatplan-items.js · the things in the hall that are not tables
   (Richard 22/11/2026: "חופה בכל מיני צורות, בר, במה, מטבח… לשים צורה ולרשום
   או לצבוע בצבע שהם רוצים")
   ----------------------------------------------------------------------------
   The seating screen keeps them with the table map, in seatplan:<token>.items.
   Everything a client sends is cut to a fixed set here: a kind, a shape and a
   colour from the lists below, a short name, and a place inside the map.
   Nothing here touches guests, tables or messages.
   ========================================================================== */
export const ITEM_KINDS = ['chuppah', 'bar', 'stage', 'dance', 'kitchen', 'entrance', 'dj', 'buffet', 'photo', 'gifts', 'free'];
export const ITEM_SHAPES = ['rect', 'round', 'arch', 'diamond', 'hex', 'oct'];
export const ITEM_COLORS = ['gold', 'green', 'blue', 'purple', 'pink', 'red', 'gray', 'dark'];
export const MAX_ITEMS = 60;
const num = (v, lo, hi, d) => { const n = Number(v); return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : d)); };
const pick = (v, list) => (list.includes(v) ? v : list[0]);

/* what a client sent → what is kept */
export function cleanItems(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ITEMS).filter(o => o && typeof o === 'object').map(o => ({
    kind: pick(String(o.kind || ''), ITEM_KINDS.slice().reverse()),   /* an unknown kind is kept as a free shape */
    label: String(o.label == null ? '' : o.label).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 30),
    shape: pick(String(o.shape || ''), ITEM_SHAPES),
    /* one of the eight, or the client's own colour: exactly #rrggbb, nothing else gets through */
    color: /^#[0-9a-f]{6}$/i.test(String(o.color || '')) ? String(o.color).toLowerCase() : pick(String(o.color || ''), ITEM_COLORS),
    x: num(o.x, 0, 4000, 0), y: num(o.y, 0, 4000, 0),
    w: num(o.w, 30, 900, 140), h: num(o.h, 30, 900, 100),
  }));
}

/* a save from a device that still runs the page from before 22/11 carries no `items` at all:
   the ones already kept stay. An empty list is a real "there are none". */
export function itemsToKeep(sent, existing) {
  return Array.isArray(sent) ? cleanItems(sent) : cleanItems(existing);
}
