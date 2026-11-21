/* ============================================================================
   ishur.io · calendar-log.js · the calendar's read of the message log (21/11/2026)
   ----------------------------------------------------------------------------
   The calendar month is rebuilt every ten minutes, and it used to read EVERY
   log:<phone>:<ts> entry of the month, one KV read per message, on every build:
   15,640 reads per build on 21/11, 2.2 million a day, growing through the month.
   A message of four days ago does not change any more. So:
     · the last LIVE_DAYS days (today included) are read from the log as before,
     · an older day is read once and kept in callog:<day>, one KV read per day
       from then on. The copy is rebuilt when the number of entries of that day
       changes, and is never written from an incomplete read.
   Display only: nothing here sends, dials or decides anything.
   ========================================================================== */
export const CAL_DAY_KEY = day => 'callog:' + day;
export const LIVE_DAYS = 3;
const TTL = 45 * 86400;
export const BATCH = 300;   /* log reads in flight at once */
/* the calendar's own day of a timestamp (the page has always used UTC+3) */
export const calDayOf = ts => new Date(ts + 3 * 3600e3).toISOString().slice(0, 10);
/* what the calendar uses of a log entry; anything that is not an outgoing message is dropped */
function slim(raw) {
  let v = null; try { v = JSON.parse(raw); } catch { return null; }
  if (!v || v.dir !== 'out') return null;
  return { dir: 'out', at: v.at, tok: v.tok, ch: v.ch, tmpl: v.tmpl, type: v.type, ok: v.ok, status: v.status, error: v.error, text: String(v.text || '').slice(0, 120) };
}

/* names: log keys (log:<phone>:<ts>) → their values as JSON strings, in the same order (null = nothing to show) */
export async function readLogValues(env, names, { now = Date.now(), liveDays = LIVE_DAYS } = {}) {
  const out = new Array(names.length).fill(null);
  const stats = { reads: 0, failed: 0, live_days: 0, cached_days: 0, built_days: 0, failed_days: 0, put_failed: 0 };
  if (!env || !env.RATE) return { vals: out, stats };
  const firstLive = calDayOf(now - (liveDays - 1) * 864e5);
  const byDay = {};
  names.forEach((n, i) => { const d = calDayOf(Number(String(n).split(':').pop()) || 0); (byDay[d] = byDay[d] || []).push(i); });
  /* 21/11 (evening): in production the whole month fired at once failed in bulk, so no old day ever came back whole.
     Reads go out in batches, one day after another: a day that came back whole is kept, and the next build skips it. */
  const readDay = async idx => {
    const v = new Array(idx.length);
    for (let s = 0; s < idx.length; s += BATCH) {
      const part = idx.slice(s, s + BATCH);
      stats.reads += part.length;
      const got = await Promise.all(part.map(i => env.RATE.get(names[i]).catch(() => undefined)));
      got.forEach((x, j) => { v[s + j] = x; out[part[j]] = x || null; if (x === undefined) stats.failed++; });
    }
    return v;
  };
  const days = Object.keys(byDay).sort();
  /* the live days first: they are what the page is opened for */
  for (const d of days.filter(x => x >= firstLive)) { stats.live_days++; await readDay(byDay[d]); }
  const old = days.filter(x => x < firstLive);
  stats.reads += old.length;
  const hits = await Promise.all(old.map(async d => { try { return JSON.parse((await env.RATE.get(CAL_DAY_KEY(d))) || 'null'); } catch { return null; } }));
  const build = [];
  old.forEach((d, k) => {
    const idx = byDay[d], hit = hits[k];
    if (hit && hit.n === idx.length && hit.v && typeof hit.v === 'object') {
      stats.cached_days++;
      for (const i of idx) { const e = hit.v[names[i]]; out[i] = e ? JSON.stringify(e) : null; }
    } else build.push(d);
  });
  for (const d of build) {   /* oldest first, one at a time */
    const idx = byDay[d];
    const v = await readDay(idx);
    if (v.some(x => x === undefined)) { stats.failed_days++; continue; }   /* a read failed: show what came back, keep nothing */
    const keep = {};
    idx.forEach((i, j) => { const e = v[j] ? slim(v[j]) : null; if (e) keep[names[i]] = e; });
    const ok = await env.RATE.put(CAL_DAY_KEY(d), JSON.stringify({ n: idx.length, at: now, v: keep }), { expirationTtl: TTL }).then(() => true, () => false);
    if (ok) stats.built_days++; else stats.put_failed++;
  }
  return { vals: out, stats };
}
