/* ============================================================================
   ishur.io · eventday.js · ONE message per guest on the event day (Richard 03/11)
   ----------------------------------------------------------------------------
   R1. The day-before reminder is never sent on the event day itself. If it
       did not go out the day before (cap, hold, window), it is dropped.
   R2. On the event day every guest gets exactly ONE message that carries
       everything that applies: address + navigation (always), the table
       number (event has seating and the guest has a table), the gift button
       (gift links on).
   R3. A guest the day-before never reached still gets just that one message.

   Templates (worker/templates/ishur_yom_combo_*.json, guests WABA, UTILITY):
     ishur_yom_combo_t   name, event, time, address, table   + nav button
     ishur_yom_combo_g   name, event, time, address          + nav + gift button
     ishur_yom_combo_tg  name, event, time, address, table   + nav + gift button
   Buttons are URL buttons on OUR domain with a dynamic suffix = the first 8
   characters of the token (same design as the *_matana gift button):
     index 0  https://go.ishur.io/nav/{{1}}   → 302 to the event's navigation
     index 1  https://go.ishur.io/gift/{{1}}  → the Bit / PayBox page

   Per-guest mark ed:<token>:<phone> (2 days): whichever event-day path sends
   first (the table stage of the engine or the event-day blast) sets it, and
   no other event-day path sends to that guest again that day.

   §1 pure (unit-tested) · §2 the resolver (I/O through deps)
   ========================================================================== */

export const COMBO = { t: 'ishur_yom_combo_t', g: 'ishur_yom_combo_g', tg: 'ishur_yom_combo_tg' };
export const COMBO_NAMES = Object.values(COMBO);
export function edMarkKey(token, phone) { return `ed:${token}:${String(phone || '').replace(/\D/g, '')}`; }
export const ED_MARK_TTL = 2 * 86400;
export function navSlug(token) { return String(token || '').slice(0, 8); }
export function navPageUrl(token) { return 'https://go.ishur.io/nav/' + navSlug(token); }

/* R1: the day-before stage may run only BEFORE the event date. daysLeft = 1
   normally; >1 never happened (the window was 0..1). A Sunday event whose
   Friday/Saturday had no engine run loses its reminder — by decision. */
export function dayBeforeAllowed(today, eventDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return false;
  const daysLeft = Math.round((Date.parse(eventDate) - Date.parse(today)) / 864e5);
  return daysLeft === 1;
}
export function dayBeforeDropped(today, eventDate) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || '')) && String(today || '') >= eventDate;
}

/* which combos would carry what this guest needs, richest first.
   A table guest never falls to combo_g (that would drop the table number). */
export function comboCandidates({ hasTable, giftOn }) {
  if (hasTable && giftOn) return [COMBO.tg, COMBO.t];
  if (hasTable) return [COMBO.t];
  if (giftOn) return [COMBO.g];
  return [];
}

/* body params in template order; '' anywhere → not sendable (Meta 131008) */
export function comboParams(name, { guestName, eventName, time, address, table }) {
  const base = [guestName, eventName, time, address];
  return name === COMBO.g ? base : [...base, table];
}
export function comboComponents(name, token) {
  const btn = (index) => ({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: navSlug(token) }] });
  return name === COMBO.t ? [btn(0)] : [btn(0), btn(1)];
}

/* where the nav button lands: the client's validated nav link, then the
   event-day job's link, then a Waze search of the venue */
export function navTarget({ navlink = '', jobNav = '', venue = '' }, navLinkOk) {
  if (navlink && navLinkOk(navlink)) return navlink;
  if (jobNav && navLinkOk(jobNav)) return jobNav;
  const v = String(venue || '').trim();
  return v ? 'https://waze.com/ul?q=' + encodeURIComponent(v) + '&navigate=yes' : '';
}

/* ── §2 the resolver ─────────────────────────────────────────────────────
   eventDayMessageFor(env, ev, guest, deps, { job })
     ev    = the sheet event row; guest = { phone, name, table }
     deps  = { comboUsable(env,name), giftOn(env,token), guestEventName(ev,o), cleanParam }
   → { kind:'combo', template, params, components } — the one message to send
   → { kind:'legacy', why }  — no combo is approved (or a field is empty):
       the caller sends what it sent before 03/11, still under the ed: mark. */
export async function eventDayMessageFor(env, ev, guest, deps, { job = null } = {}) {
  const token = String((ev && ev[1]) || '').trim();
  const hasTable = !!String((guest && guest.table) || '').trim();
  const giftOn = !!(await deps.giftOn(env, token));
  const cands = comboCandidates({ hasTable, giftOn });
  if (!cands.length) return { kind: 'legacy', why: 'no-combo-applies', hasTable, giftOn };
  const j = job || {};
  const clean = deps.cleanParam || (x => String(x || '').trim());
  const fields = {
    guestName: clean(String((guest && guest.name) || '').trim() || 'אורח יקר'),
    eventName: clean(deps.guestEventName(ev, { article: false })),
    time: clean(String(j.time || '').trim() || String(ev[36] || '').trim() || 'בשעות הערב'),
    address: clean(String(j.address || '').trim() || [String(ev[38] || '').trim(), String(ev[37] || '').trim()].filter(Boolean).join(', ')),
    table: clean(String((guest && guest.table) || '').trim()),
  };
  if (!fields.address) return { kind: 'legacy', why: 'no-address', hasTable, giftOn };
  for (const name of cands) {
    if (!(await deps.comboUsable(env, name))) continue;
    return { kind: 'combo', template: name, params: comboParams(name, fields), components: comboComponents(name, token), hasTable, giftOn };
  }
  return { kind: 'legacy', why: 'combo-not-approved', hasTable, giftOn };
}
