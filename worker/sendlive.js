/* ============================================================================
   ishur.io · sendlive.js · "לייב" — the live send picture, pure parts
   ----------------------------------------------------------------------------
   Richard 11/11: "אני רוצה לראות בלוח הבקרה את המונה לייב ומתי משתחרר" and every
   question from the 10–11/11 chat answered on one screen without Claude:
     · ours used / limit (the gsendh: hour buckets budget.js enforces), free now
     · the release timeline: each bucket frees at h+25 → "12:00 +128, 17:00 +99"
     · per event / wave: sent total, sent today, left, where it is in line, ETA
   Everything here is pure and unit-tested; ops.js gathers the KV inputs.
   Numbers come from the SAME keys the engine reads, so the screen never
   disagrees with what actually goes out (see .sdlc/ops-self-serve/plan.md).
   ============================================================================ */
import { windowHours, epochHour } from './budget.js';

const IL = 'Asia/Jerusalem';
export const ilDayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: IL }).format(new Date(ms));
function ilParts(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: IL, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  return { dow: g('weekday'), mins: Number(g('hour')) % 24 * 60 + Number(g('minute')) };
}
/* when today's send window closes (ms), or null when it is closed for the day (Shabbat / after hours) */
export function windowCloseMs(now, { end = 20 * 60 + 30, friEnd = 13 * 60, start = 9 * 60 } = {}) {
  const { dow, mins } = ilParts(now);
  if (dow === 'Sat') return null;
  const close = dow === 'Fri' ? friEnd : end;
  if (mins > close) return null;
  const open = Math.max(mins, start);
  return now + (close - open) * 60e3 + (open - mins) * 60e3;
}

/* ── the counter and the releases ──────────────────────────────────────────
   bucketsByPid = { pid: { epochHour: n } } (readHourBuckets per guest number).
   used = everything still inside Meta's window (25 buckets, conservative ≤1h);
   free = limit − margin − used; a bucket's sends leave the window at h+25.  */
export function releaseTimeline({ bucketsByPid = {}, limit = 250, margin = 10, now = Date.now() } = {}) {
  const hs = windowHours(now);
  const sum = {};
  for (const b of Object.values(bucketsByPid)) for (const h of hs) { const n = Number((b || {})[h]) || 0; if (n > 0) sum[h] = (sum[h] || 0) + n; }
  const used = Object.values(sum).reduce((a, b) => a + b, 0);
  const cap = Math.max(0, limit - margin);
  const free = Math.max(0, cap - used);
  let cum = free;
  const releases = Object.keys(sum).map(Number).sort((a, b) => a - b).map(h => { cum += sum[h]; return { at: new Date((h + 25) * 3600e3).toISOString(), at_ms: (h + 25) * 3600e3, n: sum[h], free_after: Math.min(cap, cum) }; });
  return { limit, margin, cap, used, free, releases };
}

/* ── sent per event / wave / IL day from the wsent: key list (name + expiration) ──
   wsent:<token>:<wave>:<phone>, TTL 120d → created = expiration − TTL.            */
export function dayCounts(keys = [], { ttlDays = 120 } = {}) {
  const out = {};
  for (const k of keys) {
    const parts = String(k.name || '').split(':'); if (parts.length < 4 || parts[0] !== 'wsent') continue;
    const [, token, wave] = parts; const exp = Number(k.expiration);
    const day = Number.isFinite(exp) ? ilDayOf((exp - ttlDays * 86400) * 1000) : '';
    const ev = out[token] = out[token] || {}; const w = ev[wave] = ev[wave] || { total: 0, by_day: {} };
    w.total++; if (day) w.by_day[day] = (w.by_day[day] || 0) + 1;
  }
  return out;
}

/* ── ETA: when a queue of `remaining` finishes, pacing `pace` per tick (10 min),
   inside today's window, with slots freeing on the timeline ──────────────── */
export function etaFinish({ remaining = 0, free = 0, releases = [], now = Date.now(), closeAt = null, pace = 25, tickMs = 600e3 } = {}) {
  if (remaining <= 0) return { done: true, at: null, today: 0, carried: 0, why: 'done' };
  if (!closeAt || closeAt <= now) return { done: false, at: null, today: 0, carried: remaining, why: 'window-closed' };
  let t = now, slots = free, sent = 0, ri = 0; const rel = [...releases].sort((a, b) => a.at_ms - b.at_ms);
  for (let i = 0; i < 400 && t <= closeAt && sent < remaining; i++) {
    while (ri < rel.length && rel[ri].at_ms <= t) { slots += rel[ri].n; ri++; }
    const n = Math.min(pace, slots, remaining - sent);
    if (n > 0) { sent += n; slots -= n; if (sent >= remaining) return { done: true, at: new Date(t).toISOString(), today: sent, carried: 0, why: 'fits-today' }; }
    /* nothing to send now: jump to the next release instead of ticking idly */
    if (n <= 0 && slots <= 0) { const nx = rel[ri]; if (!nx || nx.at_ms > closeAt) break; t = Math.max(t + tickMs, nx.at_ms); continue; }
    t += tickMs;
  }
  return { done: false, at: null, today: sent, carried: remaining - sent, why: sent ? 'partly-today' : 'no-room-today' };
}

/* ── the per-event rows: who is in line, how far along, what gates it ──────
   events/guests: eventsFromRaw shape; flags: projectionInputs flags (hold, prio, order, waveN done);
   counts: dayCounts(); shares: { token: usedToday }; today: IL day.           */
const ELIG = { 1: g => g.rsvp !== 'לא מגיע', 2: g => !g.rsvp || g.rsvp === 'מתלבט', 3: g => g.rsvp !== 'לא מגיע' };
export function eventRows({ events = [], guests = {}, flags = {}, counts = {}, shares = {}, today, now = Date.now(), free = 0, releases = [], closeAt = null, pace = 25 } = {}) {
  const rows = [];
  for (const ev of events) {
    const f = flags[ev.token] || {}, gl = guests[ev.token] || [], c = counts[ev.token] || {};
    for (const k of [1, 2, 3]) {
      const when = (ev.waves || {})[k]; if (!when) continue;
      if (k === 3 && !f.extrasend) continue;
      const eligible = new Set(gl.filter(g => g.phone && ELIG[k](g)).map(g => g.phone)).size;
      const w = c[String(k)] || { total: 0, by_day: {} };
      const sentToday = w.by_day[today] || 0, left = Math.max(0, eligible - w.total);
      const done = !!f['wave' + k] || (eligible > 0 && left === 0);
      const lateBy = when && today ? Math.round((Date.parse(today) - Date.parse(when)) / 864e5) : null;
      const gate = done ? 'done' : f.hold && !(f.holdtill && today >= f.holdtill) ? 'hold' : when > today ? 'not-yet' : lateBy > 3 ? 'abandoned' : f.prio && shares[ev.token] >= f.prio ? 'share-used' : 'queue';
      rows.push({ token: ev.token, tok8: ev.token.slice(0, 8), name: ev.name || '', date: ev.date || '', wave: k, due: when, eligible, sent: w.total, sent_today: sentToday, left, done, gate,
        order: f.order == null ? 1000 : f.order, prio: f.prio || 0, share_used: shares[ev.token] || 0, by_day: w.by_day });
    }
  }
  rows.sort((a, b) => a.order - b.order || (a.prio ? 0 : 1) - (b.prio ? 0 : 1) || a.due.localeCompare(b.due));
  /* the queue is served in this order out of the same room: the ETA of row n starts where row n−1 ends */
  let freeLeft = free, cursor = now, rel = releases, carryPos = 0;
  for (const r of rows) {
    if (r.gate !== 'queue' || r.left <= 0) { r.eta = null; continue; }
    const want = r.prio ? Math.min(r.left, Math.max(0, r.prio - r.share_used)) : r.left;
    const e = etaFinish({ remaining: want, free: freeLeft, releases: rel, now: cursor, closeAt, pace });
    r.eta = { ...e, today: e.today, carried: r.left - e.today, position: ++carryPos, daily_share: r.prio ? want : null };
    if (e.at) cursor = Date.parse(e.at);
    /* what this row consumed no longer feeds the next one: the free room first, then the releases in order */
    const fromFree = Math.min(freeLeft, e.today); freeLeft -= fromFree;
    let acc = fromFree; rel = rel.map(x => { if (acc >= e.today) return x; const take = Math.min(x.n, e.today - acc); acc += take; return { ...x, n: x.n - take }; }).filter(x => x.n > 0);
  }
  return rows;
}
