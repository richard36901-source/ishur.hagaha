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

/* 25/11 the KV bill: the live days were still one read per message on every build (~2,700 reads every ten minutes by
   the evening). Every log write now carries what the calendar shows in its list() METADATA: {c: slim entry} for an
   outgoing message, {c: 0} for anything else. The listing the calendar already makes then answers without a read.
   An entry with no metadata (written before this, or too big for the 1 KB metadata cap) is read as before. */
const META_MAX = 1000;
export function logMeta(rec) {
  if (!rec || typeof rec !== 'object') return undefined;
  if (rec.dir !== 'out') return { c: 0 };
  const m = { c: slim(JSON.stringify(rec)) };
  return new TextEncoder().encode(JSON.stringify(m)).length <= META_MAX ? m : undefined;
}
/* the one way a log:<phone>:<ts> entry is written: value + calendar metadata */
export function putLog(env, key, rec, opts = {}) {
  const m = logMeta(rec);
  return env.RATE.put(key, JSON.stringify(rec), m ? { ...opts, metadata: m } : opts);
}
/* the log listing with each key's metadata (same list calls as a plain listing) */
export async function listLogKeys(env, cap = 60000) {
  const names = [], meta = new Map();
  if (!env || !env.RATE || !env.RATE.list) return { names, meta };
  let cursor;
  while (names.length < cap) {
    const page = await env.RATE.list({ prefix: 'log:', cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    for (const k of page.keys) { names.push(k.name); if (k.metadata && typeof k.metadata === 'object' && 'c' in k.metadata) meta.set(k.name, k.metadata); }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return { names, meta };
}

/* names: log keys (log:<phone>:<ts>) → their values as JSON strings, in the same order (null = nothing to show).
   meta (optional, from listLogKeys): an entry whose metadata already says what the calendar shows is not read. */
export async function readLogValues(env, names, { now = Date.now(), liveDays = LIVE_DAYS, meta = null } = {}) {
  const out = new Array(names.length).fill(null);
  const stats = { reads: 0, failed: 0, live_days: 0, cached_days: 0, built_days: 0, failed_days: 0, put_failed: 0, ...(meta ? { from_meta: 0 } : {}) };
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
  for (const d of days.filter(x => x >= firstLive)) {
    stats.live_days++;
    const toRead = [];
    for (const i of byDay[d]) { const m = meta && meta.get(names[i]); if (m) { out[i] = m.c ? JSON.stringify(m.c) : null; stats.from_meta++; } else toRead.push(i); }
    await readDay(toRead);
  }
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

/* 22/11: the calendar asked KV about every planned message of the month, one read per guest per wave (2,838 reads a
   build on 22/11), to find the few that are already marked. A marker either exists or it does not, and its name says
   which guest it is: one listing per event and wave shows which exist, and only those are read.
   keys: marker names (wsent:<token>:<wave>:<phone>, s5d:<token>:<phone>, …) → their values in the same order (null = no marker).
   Display only. A listing can be a few seconds behind a marker that was just set; the next build shows it. */
export async function plannedMarks(env, keys) {
  const out = new Array(keys.length).fill(null);
  const stats = { lists: 0, reads: 0 };
  if (!env || !env.RATE || !keys.length) return { marks: out, stats };
  const groups = {};
  keys.forEach((k, i) => { const cut = String(k).lastIndexOf(':'); const pre = String(k).slice(0, cut + 1); (groups[pre] = groups[pre] || []).push(i); });
  await Promise.all(Object.keys(groups).map(async pre => {
    const have = new Set(); let cursor, okList = true;
    for (let p = 0; p < 20; p++) {
      stats.lists++;
      const page = await env.RATE.list({ prefix: pre, cursor, limit: 1000 }).catch(() => null);
      if (!page) { okList = false; break; }
      for (const k of page.keys || []) have.add(k.name);
      if (page.list_complete || !page.cursor) break; cursor = page.cursor;
    }
    /* a listing that failed says nothing: those rows are asked one by one, as before */
    const idx = okList ? groups[pre].filter(i => have.has(keys[i])) : groups[pre];
    for (let s = 0; s < idx.length; s += BATCH) {
      const part = idx.slice(s, s + BATCH); stats.reads += part.length;
      const vals = await Promise.all(part.map(i => env.RATE.get(keys[i]).catch(() => null)));
      part.forEach((i, j) => { out[i] = vals[j] || null; });
    }
  }));
  return { marks: out, stats };
}
