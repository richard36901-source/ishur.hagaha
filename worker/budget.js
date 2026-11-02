/* ============================================================================
   ishur.io · budget.js · how many guest templates may still leave (02/11)
   ----------------------------------------------------------------------------
   Richard 02/11: "never send a batch that will be refused because the cap is
   reached — if there's no room, don't send, queue."

   Meta's rule (developers.facebook.com/docs/whatsapp/messaging-limits, read
   02/11): the limit counts unique users who get a message OUTSIDE a customer
   service window, inside a MOVING 24-hour period, and it is "calculated and
   set at the business portfolio level and shared by all business phone
   numbers within a portfolio". Both guest numbers (6673, 9799) sit on WABA
   1378764257421712 — one portfolio. So the default scope here is
   'portfolio': two numbers do NOT double the cap. GUEST_CAP_SCOPE=number
   restores per-number addition (250 + 250) if Meta ever shows otherwise.

   Two counters feed "used":
     gsend:<pid>:<IL day>       — the calendar-day counter (02/11 hotfix)
     gsendh:<pid>:<epoch hour>  — hourly buckets; the sum of the last 25 is the
                                  rolling 24h Meta counts (a 20:00 burst still
                                  counts at 09:00 the next morning, which the
                                  day counter forgot at midnight)
   used = max(day, rolling). Counting KV keys is never used (list() lags its
   own writes — memory: cloudflare-kv-list-lag).

   §1 pure math (unit-tested) · §2 KV readers used by whatsapp.js / index.js
   ========================================================================== */

export const TIER_LIMITS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: Infinity };
export function tierLimit(name, fallback = 0) {
  const v = TIER_LIMITS[String(name || '')];
  return v === undefined ? fallback : v;
}

/* ── §1 pure ─────────────────────────────────────────────────────────────── */
export function epochHour(ms) { return Math.floor(Number(ms) / 3600e3); }
/* the 25 hour buckets that can hold a send still inside Meta's 24h window
   (the current, partial hour + the 24 before it — conservative by ≤1h) */
export function windowHours(nowMs) { const h = epochHour(nowMs); const out = []; for (let i = 24; i >= 0; i--) out.push(h - i); return out; }
export function rollingUsed(buckets, nowMs) {
  let n = 0;
  for (const h of windowHours(nowMs)) n += Math.max(0, Number((buckets || {})[h]) || 0);
  return n;
}
/* when the oldest send still counted leaves the window → a slot frees */
export function nextFreeAt(buckets, nowMs) {
  for (const h of windowHours(nowMs)) if (Number((buckets || {})[h]) > 0) return (h + 25) * 3600e3;
  return null;
}

/* one number. limit = its own cap (tier or override), used = max(day, rolling) */
export function numberState({ id = '', limit = 0, dayUsed = 0, rolling = 0, held = false, heldUntil = 0, now = Date.now(), margin = 0, freeAt = null, tier = '' } = {}) {
  const used = Math.max(Number(dayUsed) || 0, Number(rolling) || 0);
  const capEff = Math.max(0, (Number(limit) || 0) - (Number(margin) || 0));
  const isHeld = !!held || (Number(heldUntil) || 0) > now;
  return { id, tier, limit: Number(limit) || 0, used, day_used: Number(dayUsed) || 0, rolling_used: Number(rolling) || 0,
    remaining: isHeld ? 0 : Math.max(0, capEff - used), held: isHeld, held_until: Number(heldUntil) > now ? Number(heldUntil) : null, frees_at: freeAt };
}

/* all guest numbers together.
   scope 'portfolio': one shared limit (the portfolio tier; every number reports
     the same one) — remaining = shared limit − everything sent from any number,
     and never more than what the open numbers can still carry on their own.
   scope 'number': the per-number remainders simply add up. */
export function capacity(numbers, { scope = 'portfolio', portfolioLimit = 0, margin = 0 } = {}) {
  const per = numbers || [];
  const sumPer = per.reduce((n, x) => n + x.remaining, 0);
  const used = per.reduce((n, x) => n + x.used, 0);
  if (scope === 'number') {
    const limit = per.reduce((n, x) => n + x.limit, 0);
    return { scope, limit, used, remaining: sumPer, numbers: per, all_held: per.length > 0 && per.every(x => x.held) };
  }
  const limit = Number(portfolioLimit) || Math.max(0, ...per.map(x => x.limit));
  const shared = Math.max(0, limit - (Number(margin) || 0) - used);
  return { scope, limit, used, remaining: Math.min(shared, sumPer), numbers: per, all_held: per.length > 0 && per.every(x => x.held) };
}

/* a batch never starts bigger than the room left: send what fits, hold the rest */
export function fitBatch(remaining, wanted) {
  const r = Math.max(0, Math.floor(Number(remaining) || 0));
  const w = Math.max(0, Math.floor(Number(wanted) || 0));
  const send = Math.min(r, w);
  return { send, held: w - send, reason: w > send ? 'cap' : '' };
}

/* planned sends for the next days vs. the room each day.
   today's room = what is left now; a later day's room = the full limit (the
   window will have rolled by then). over → the board paints it red. */
export function planVsCapacity(plannedByDay, { today, remainingNow, limit, days = 3 } = {}) {
  const out = [];
  const base = Date.parse(today + 'T12:00:00Z');
  for (let i = 0; i < days; i++) {
    const day = new Date(base + i * 864e5).toISOString().slice(0, 10);
    const planned = Number((plannedByDay || {})[day]) || 0;
    const room = i === 0 ? Math.max(0, Number(remainingNow) || 0) : Math.max(0, Number(limit) || 0);
    out.push({ day, planned, capacity: room, over: planned > room, short_by: Math.max(0, planned - room) });
  }
  return out;
}

/* ── §2 KV readers ────────────────────────────────────────────────────────── */
function ilDayKey(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d); }
export async function readHourBuckets(kv, pid, nowMs = Date.now()) {
  const hs = windowHours(nowMs);
  const vals = await Promise.all(hs.map(h => kv.get(`gsendh:${pid}:${h}`).catch(() => null)));
  const b = {}; hs.forEach((h, i) => { const n = Number(vals[i]) || 0; if (n) b[h] = n; });
  return b;
}
export async function bumpHourBucket(kv, pid, nowMs = Date.now()) {
  const k = `gsendh:${pid}:${epochHour(nowMs)}`;
  const n = Number(await kv.get(k).catch(() => 0)) || 0;
  await kv.put(k, String(n + 1), { expirationTtl: 26 * 3600 }).catch(() => {});
}
/* the per-number tiers cached by waCapInfo (wa:cap, 6h) */
export async function cachedTiers(kv) {
  try { const c = JSON.parse((await kv.get('wa:cap')) || 'null'); return (c && Array.isArray(c.numbers)) ? c.numbers : []; } catch { return []; }
}
export { ilDayKey };
