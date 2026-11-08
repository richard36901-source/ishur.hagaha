/* ============================================================================
   ishur.io · snapshot.js · the ONE reader for the Make status snapshot, and the
   outbox for sheet writes while Make is down (04/11/2026, Make burn incident)
   ----------------------------------------------------------------------------
   docs/MAKE-BURN-2026-11-04.md has the inventory and the numbers.

   Why: on 04/11 10:46 the Make org ran out of credits and all 36 scenarios
   paused. The Worker had been burning ~10k credits a day, mostly by reading
   the whole sheet through the HOOK_STATUS webhook (≈4-5 credits a read) from
   ~55 call sites, most of them uncached, several of them every 10 minutes or
   every 15-60 s while an admin screen was open.

   READ — readSnapshot(env, cls)
     1. in-isolate memo (WeakMap keyed by env.RATE, so every test env is fresh)
     2. KV 'snapcache' {at, raw}
     3. one fetch per isolate at a time (single-flight); a failed fetch backs
        off FAIL_BACKOFF_SEC for EVERY caller (KV 'snapfail'), because a paused
        Make scenario queues webhook calls and runs them all — at full price —
        the moment it is switched back on.
     4. Make failed → the newest of memo / 'snapcache' / 'snaplast' (7 days),
        tagged stale (snapInfo(raw).stale_since). Classes with maxStale
        (send/dial) get null instead of a snapshot older than 15 minutes, and
        snapWhy(env) says 'snapshot-stale'.
     `at` is the time the fetch STARTED, so a write that lands during a fetch
     is never assumed to be inside it.

   FRESH AFTER OWN WRITE
     · noteSheetWrite(env, data) — after a batchUpdate (sheetBatchWrite): the
       written cells are patched into the memo and into a small KV overlay
       'snappatch' (last 15 min of patches). Every read applies overlay
       patches newer than its snapshot, so the next reader — any isolate —
       sees the cell it just wrote without paying for a fetch.
     · noteCallResult(env, payload) — the HOOK_EVENTS call_result contract
       (guest WhatsApp reply / Shir's result): rsvp (P) and party (Q) are
       patched by guest_id; tries / call_status are computed by Make, so the
       'act' dirty marker is bumped too — the dialer and senders refetch.
     · markSnapDirty(env, 'all') — any other write that touches the snapshot
       tabs (guest file, event form, payments, appends): every class that
       honours dirty refetches once.

   CLASSES (maxAge seconds · which dirty markers force a refetch)
     guest 300 · all    dashboard 300 · all    write 0 (a real read) · all, never > 15 min
     send/dial 300 · all+act, never act on > 15 min
     ops / brain / background 300 · none (screens never force a read)
     probe 0 (still single-flight + failure backoff)

   WRITE OUTBOX — sheetWrite(env, data, post)
     post(env, data) → true when Sheets confirmed cells. On failure the batch
     is stored as 'sheetq:e:<ts13>:<rand>' (7 days) and 'sheetq:pending' holds
     the time of the newest enqueue. While pending, new writes go behind the
     queue (after an inline drain attempt) so an old queued value can never
     overwrite a newer one. drainSheetQueue runs in the pacer, oldest first,
     cap per tick, stops at the first failure. Batches are absolute cell
     values (batchUpdate RAW), so replaying one twice is harmless.
     'sheetq:pending' is only cleared when list() is empty AND the newest
     enqueue is older than 90 s — list() lags its own writes.
   ========================================================================== */

export const K = {
  cache: 'snapcache', last: 'snaplast', patch: 'snappatch', dirty: 'snapdirty', dirtyAct: 'snapdirty:act', fail: 'snapfail',
  q: 'sheetq:e:', qPending: 'sheetq:pending', qLock: 'sheetq:lock', wfail: 'sheetq:fail',
};
export const CLASSES = {
  /* 300 s like everything else: own writes are patched in and other writes mark dirty, so a shorter
     age would only buy hand edits in the sheet — measured 03/11, the off-tick reads were the burn */
  guest: { maxAge: 300, dirty: 'all' },
  dashboard: { maxAge: 300, dirty: 'all' },
  write: { maxAge: 0, dirty: 'all', maxStale: 900 },   /* read-modify-write by row index: a real read (single-flight) */
  send: { maxAge: 300, dirty: 'act', maxStale: 900 },
  dial: { maxAge: 300, dirty: 'act', maxStale: 900 },
  ops: { maxAge: 300, dirty: 'none' },
  brain: { maxAge: 300, dirty: 'none' },
  background: { maxAge: 300, dirty: 'none' },
  probe: { maxAge: 0, dirty: 'none', maxStale: 0 },   /* a real answer from Make or nothing */
};
export const STALE_ACT_SEC = 900;
/* 08/11 (Richard, Make credits): 21:00–08:00 Israel nothing is sent, so the screens / background
   readers keep a snapshot up to an hour (own writes still force a refetch through the dirty markers).
   send / dial / write / probe are never stretched. */
const NIGHT_CLASSES = new Set(['guest', 'dashboard', 'ops', 'brain', 'background']);
export function nightMaxAge(cls, maxAge, nowMs = Date.now()) {
  if (!NIGHT_CLASSES.has(cls) || !maxAge) return maxAge;
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(nowMs))) % 24;
  return (h >= 21 || h < 8) ? Math.max(maxAge, 3600) : maxAge;
}
export const FAIL_BACKOFF_SEC = 60;
const CACHE_TTL = 900, LAST_TTL = 7 * 86400, PATCH_KEEP_MS = 15 * 60e3, DIRTY_TTL = 3600;
const Q_TTL = 7 * 86400, Q_SETTLE_MS = 90e3;
const TAB = { 'אורחים': 'guests', 'אירועים': 'events' };

/* ── per-isolate state, one per KV binding ─────────────────────────────── */
const STATES = new WeakMap();
function stateOf(env) {
  const key = env.RATE;
  let st = STATES.get(key);
  if (!st) { st = { entry: null, inflight: null, fail: null, why: '', patches: [], qpending: null }; STATES.set(key, st); }
  return st;
}
const INFO = new WeakMap();
/* {at, age_sec, source: memo|kv|fresh|last, stale, stale_since} for a snapshot this module returned */
export function snapInfo(raw) { return (raw && typeof raw === 'object' && INFO.get(raw)) || null; }
/* why the last read in this isolate returned null: 'snapshot-stale' | 'snapshot-unreadable' | '' */
export function snapWhy(env) { return env && env.RATE ? stateOf(env).why || 'snapshot-unreadable' : 'snapshot-unreadable'; }

async function kget(env, k) { try { return await env.RATE.get(k); } catch { return null; } }
async function kjson(env, k) { try { return JSON.parse((await env.RATE.get(k)) || 'null'); } catch { return null; } }
async function kput(env, k, v, ttl) { try { await env.RATE.put(k, typeof v === 'string' ? v : JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined); return true; } catch { return false; } }
async function kdel(env, k) { try { await env.RATE.delete(k); } catch {} }

/* the raw transport: POST {kind:'snapshot'} to the Make status scenario */
export async function fetchRaw(env) {
  if (!env.HOOK_STATUS) return null;
  const r = await fetch(env.HOOK_STATUS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'snapshot' }) }).catch(() => null);
  if (!r || r.status !== 200) return null;
  try { return await r.json(); } catch { return null; }
}
/* a paused scenario answers 200 "Accepted"; an error scenario may answer JSON without the sheets */
export const validSnapshot = raw => !!(raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.events || raw.guests));

/* ── A1 ranges → patch ops ─────────────────────────────────────────────── */
export function colIndex(letters) { let n = 0; for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
/* 'אורחים!V12' · "'אירועים'!S5:V5" → {key, r1, r2, c1, c2} (rows are sheet rows) or null */
export function parseRange(range) {
  const m = /^'?([^'!]+)'?!([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(String(range || '').trim());
  if (!m || !TAB[m[1]]) return null;
  const r1 = Number(m[3]), r2 = m[5] ? Number(m[5]) : r1, c1 = colIndex(m[2]), c2 = m[4] ? colIndex(m[4]) : c1;
  if (r1 < 2 || r2 < r1 || c2 < c1) return null;   /* row 1 is the header, not in values[] */
  return { key: TAB[m[1]], r1, r2, c1, c2 };
}
/* batchUpdate data → [{k, row, cells:{col: value}}] or null when any range is not patchable */
export function opsFromBatch(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const ops = [];
  for (const d of data) {
    const p = parseRange(d && d.range); const vals = d && Array.isArray(d.values) ? d.values : null;
    if (!p || !vals) return null;
    for (let r = p.r1; r <= p.r2; r++) {
      const line = vals[r - p.r1]; if (!Array.isArray(line)) return null;
      const cells = {};
      for (let c = p.c1; c <= p.c2; c++) cells[c] = line[c - p.c1] == null ? '' : String(line[c - p.c1]);
      ops.push({ k: p.key, row: r - 2, cells });
    }
  }
  return ops;
}
/* apply ops to a raw snapshot in place; true when every op found its row */
export function applyOps(raw, ops) {
  let all = true;
  for (const op of ops || []) {
    const vals = raw && raw[op.k] && raw[op.k].values;
    if (!Array.isArray(vals)) { all = false; continue; }
    let i = op.row;
    if (op.match) i = vals.findIndex(g => String((g || [])[op.match[0]] || '').trim() === op.match[1]);
    if (!Number.isInteger(i) || i < 0 || i >= vals.length) { all = false; continue; }
    const row = Array.isArray(vals[i]) ? vals[i] : (vals[i] = []);
    for (const [c, v] of Object.entries(op.cells)) { const ci = Number(c); while (row.length < ci) row.push(''); row[ci] = v; }
  }
  return all;
}
function applyNewer(entry, patches) {
  if (!entry || !entry.raw) return;
  entry.applied = entry.applied || {};
  for (const p of [...(patches || [])].sort((a, b) => (a && b ? a.at - b.at : 0))) {
    if (!p || p.at <= entry.at || entry.applied[p.id]) continue;   /* at <= fetch start: already inside it */
    applyOps(entry.raw, p.ops); entry.applied[p.id] = 1;
  }
}

/* ── dirty markers ─────────────────────────────────────────────────────── */
export async function markSnapDirty(env, scope = 'all') {
  if (!env || !env.RATE) return;
  const now = Date.now(); const st = stateOf(env);
  if (scope === 'act') st.dirtyAct = now; else st.dirtyAll = now;
  await kput(env, scope === 'act' ? K.dirtyAct : K.dirty, String(now), DIRTY_TTL);
}
async function addPatch(env, ops) {
  const st = stateOf(env); const now = Date.now();
  const p = { id: now.toString(36) + Math.random().toString(36).slice(2, 7), at: now, ops };
  st.patches = [...st.patches.filter(x => now - x.at < PATCH_KEEP_MS), p];
  if (st.entry) applyNewer(st.entry, [p]);
  const cur = (await kjson(env, K.patch)) || [];
  const next = [...(Array.isArray(cur) ? cur : []).filter(x => x && now - x.at < PATCH_KEEP_MS), p].slice(-200);
  /* a lost overlay write (KV 1 write/s per key) must not lose the freshness — fall back to dirty */
  if (!(await kput(env, K.patch, next, PATCH_KEEP_MS / 1000))) await markSnapDirty(env, 'all');
  return p;
}
/* after a batchUpdate that Sheets confirmed (or that the outbox will replay) */
export async function noteSheetWrite(env, data) {
  if (!env || !env.RATE) return;
  const ops = opsFromBatch(data);
  if (!ops) return markSnapDirty(env, 'all');
  const st = stateOf(env);
  /* a row past the end of what we hold is an append — the cache cannot know it */
  const e = st.entry;
  if (!e || ops.some(o => !Array.isArray(((e.raw || {})[o.k] || {}).values) || o.row >= e.raw[o.k].values.length)) await markSnapDirty(env, 'all');
  await addPatch(env, ops);
}
/* after a HOOK_EVENTS POST. call_result → patch rsvp/party by guest_id + act-dirty; anything else → dirty */
export async function noteHookWrite(env, payload) {
  if (!env || !env.RATE) return;
  let b = payload;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || b.event_type !== 'call_result' || !b.guest_id) return markSnapDirty(env, 'all');
  const cells = {};
  if (b.rsvp != null && b.rsvp !== '__keep__') cells[15] = String(b.rsvp);
  if (b.party != null && b.party !== '__keep__') cells[16] = String(b.party);
  if (Object.keys(cells).length) await addPatch(env, [{ k: 'guests', match: [2, String(b.guest_id).trim()], cells }]);
  await markSnapDirty(env, 'act');
}

/* ── the reader ────────────────────────────────────────────────────────── */
function tag(entry, source, now, stale) {
  const raw = entry.raw;
  INFO.set(raw, { at: new Date(entry.at).toISOString(), age_sec: Math.round((now - entry.at) / 1000), source, stale: !!stale, stale_since: stale ? new Date(entry.at).toISOString() : null });
  return raw;
}
async function noteFail(env, st) {
  const now = Date.now();
  const prev = st.fail || (await kjson(env, K.fail));
  st.fail = { at: now, since: (prev && prev.since) || now, n: ((prev && prev.n) || 0) + 1 };
  await kput(env, K.fail, st.fail, LAST_TTL);
}
async function noteOk(env, st, at) {
  if (st.fail || (await kget(env, K.fail))) { st.fail = null; await kdel(env, K.fail); }
  st.okAt = at;
}
function refresh(env, st, deps) {
  if (st.inflight) return st.inflight;
  st.inflight = (async () => {
    const now = Date.now();
    const fail = st.fail || (await kjson(env, K.fail));
    if (fail && now - fail.at < FAIL_BACKOFF_SEC * 1000) { st.fail = fail; return null; }
    const startedAt = Date.now();
    const raw = await (deps.fetchRaw || fetchRaw)(env).catch(() => null);
    if (!validSnapshot(raw)) { await noteFail(env, st); return null; }
    const entry = { at: startedAt, raw, applied: {} };
    const kvPatches = await kjson(env, K.patch);
    applyNewer(entry, [...st.patches, ...(Array.isArray(kvPatches) ? kvPatches : [])].sort((a, b) => a.at - b.at));
    st.entry = entry;
    const doc = JSON.stringify({ at: startedAt, raw });
    await Promise.all([kput(env, K.cache, doc, CACHE_TTL), kput(env, K.last, doc, LAST_TTL), noteOk(env, st, startedAt)]);
    return entry;
  })().finally(() => { st.inflight = null; });
  return st.inflight;
}

export async function readSnapshot(env, cls = 'background', deps = {}) {
  const c = CLASSES[cls] || CLASSES.background;
  if (!env || !env.RATE) {
    const raw = await (deps.fetchRaw || fetchRaw)(env || {}).catch(() => null);
    return validSnapshot(raw) ? raw : null;
  }
  const st = stateOf(env); const now = Date.now();
  const [dAllKv, dActKv, kvPatches] = await Promise.all([
    c.dirty === 'none' ? null : kget(env, K.dirty),
    c.dirty === 'act' ? kget(env, K.dirtyAct) : null,
    kjson(env, K.patch)]);
  const bar = c.dirty === 'none' ? 0 : Math.max(st.dirtyAll || 0, Number(dAllKv) || 0, c.dirty === 'act' ? Math.max(st.dirtyAct || 0, Number(dActKv) || 0) : 0);
  const patches = Array.isArray(kvPatches) ? kvPatches : [];
  const maxAge = nightMaxAge(cls, c.maxAge, now);
  const usable = e => !!(e && e.raw && Number.isFinite(e.at) && now - e.at < maxAge * 1000 && e.at >= bar);
  if (usable(st.entry)) { applyNewer(st.entry, patches); st.why = ''; return tag(st.entry, 'memo', now); }
  const kvE = await kjson(env, K.cache);
  if (kvE && kvE.raw && Number.isFinite(kvE.at) && (!st.entry || kvE.at > st.entry.at)) st.entry = { at: kvE.at, raw: kvE.raw, applied: {} };
  if (usable(st.entry)) { applyNewer(st.entry, [...st.patches, ...patches]); st.why = ''; return tag(st.entry, 'kv', now); }
  const fresh = await refresh(env, st, deps);
  if (fresh) { applyNewer(fresh, patches); st.why = ''; return tag(fresh, 'fresh', Date.now()); }
  /* Make did not answer: the newest copy we have, marked stale */
  let best = st.entry && st.entry.raw ? st.entry : null;
  const last = await kjson(env, K.last);
  if (last && last.raw && Number.isFinite(last.at) && (!best || last.at > best.at)) best = { at: last.at, raw: last.raw, applied: {} };
  if (!best) { st.why = 'snapshot-unreadable'; return null; }
  if (c.maxStale != null && now - best.at > c.maxStale * 1000) { st.why = 'snapshot-stale'; return null; }
  if (!st.entry || best.at >= st.entry.at) st.entry = best;
  applyNewer(best, [...st.patches, ...patches]);
  st.why = '';
  return tag(best, 'last', now, true);
}

/* {raw, why, info} for a sender/dialer: raw is null with why 'snapshot-stale' / 'snapshot-unreadable' */
export async function snapshotForAction(env, cls = 'send', deps = {}) {
  const raw = await readSnapshot(env, cls, deps).catch(() => null);
  return { raw, why: raw ? '' : snapWhy(env), info: snapInfo(raw) };
}

/* reader + writer health for the brain / ops realtime */
export async function makeStatus(env) {
  if (!env || !env.RATE) return null;
  const [fail, wfail, pending, cache] = await Promise.all([kjson(env, K.fail), kjson(env, K.wfail), kget(env, K.qPending), kjson(env, K.cache).catch(() => null)]);
  const outbox = await sheetQueueSize(env);
  return {
    reader: { ok: !fail, failing_since: fail ? new Date(fail.since).toISOString() : null, fails: fail ? fail.n : 0, last_fail_at: fail ? new Date(fail.at).toISOString() : null,
      cache_at: cache && cache.at ? new Date(cache.at).toISOString() : null },
    writer: { ok: !wfail, failing_since: wfail ? new Date(wfail.since).toISOString() : null, fails: wfail ? wfail.n : 0 },
    outbox: { size: outbox, pending: !!pending },
  };
}

/* ── the write outbox ──────────────────────────────────────────────────── */
async function listQueue(env, limit = 1000) {
  try { const r = await env.RATE.list({ prefix: K.q, limit }); return ((r && r.keys) || []).map(k => k.name).sort(); } catch { return []; }
}
/* display only (list() lags) */
export async function sheetQueueSize(env) { return env && env.RATE ? (await listQueue(env)).length : 0; }
async function enqueue(env, data) {
  const now = Date.now();
  const k = K.q + String(now).padStart(13, '0') + ':' + Math.random().toString(36).slice(2, 8);
  await kput(env, k, { at: now, data }, Q_TTL);
  await kput(env, K.qPending, String(now), Q_TTL);
  stateOf(env).qpending = now;
  return k;
}
async function noteWriteFail(env) {
  const prev = await kjson(env, K.wfail); const now = Date.now();
  await kput(env, K.wfail, { at: now, since: (prev && prev.since) || now, n: ((prev && prev.n) || 0) + 1 }, Q_TTL);
}
async function noteWriteOk(env) { if (await kget(env, K.wfail)) await kdel(env, K.wfail); }

/* replay queued batches, oldest first; stops at the first failure */
export async function drainSheetQueue(env, post, { cap = 25 } = {}) {
  if (!env || !env.RATE) return { ok: true, drained: 0, left: 0 };
  const pending = await kget(env, K.qPending);
  if (!pending) { stateOf(env).qpending = 0; return { ok: true, drained: 0, left: 0, idle: true }; }
  const names = await listQueue(env);
  let drained = 0;
  for (const name of names.slice(0, cap)) {
    const rec = await kjson(env, name);
    if (!rec || !Array.isArray(rec.data)) { await kdel(env, name); continue; }
    const ok = await post(env, rec.data).catch(() => false);
    if (!ok) { await noteWriteFail(env); return { ok: false, drained, left: names.length - drained, why: 'make-still-down' }; }
    await kdel(env, name); drained++;
  }
  if (drained) { await noteWriteOk(env); await markSnapDirty(env, 'all'); }
  const left = names.length - drained;
  if (!left && Date.now() - (Number(pending) || 0) > Q_SETTLE_MS) { await kdel(env, K.qPending); stateOf(env).qpending = 0; }
  return { ok: true, drained, left };
}

/* the one sheet writer: write now, or queue behind whatever is already queued */
export async function sheetWrite(env, data, post) {
  if (!data || !data.length) return false;
  if (!env || !env.RATE) return post(env, data);
  const st = stateOf(env);
  /* Make failed a write under a minute ago: do not knock again (a paused scenario QUEUES the
     call and replays it, at full price, when it is switched back on) — straight to the outbox */
  const wf = await kjson(env, K.wfail);
  if (wf && Date.now() - wf.at < FAIL_BACKOFF_SEC * 1000) { await enqueue(env, data); await noteSheetWrite(env, data); return false; }
  /* read every time: another isolate may have queued while this one was writing fine */
  let pending = Number(await kget(env, K.qPending)) || 0;
  if (pending) {
    const d = await drainSheetQueue(env, post, { cap: 10 }).catch(() => ({ ok: false }));
    pending = d.ok && !d.left ? 0 : 1;
  }
  st.qpending = pending;
  if (!pending) {
    const ok = await post(env, data).catch(() => false);
    if (ok) { await noteWriteOk(env); await noteSheetWrite(env, data); return true; }
    await noteWriteFail(env);
  }
  await enqueue(env, data);
  /* readers see the intended value while Make is down; the drain marks dirty when it lands */
  await noteSheetWrite(env, data);
  return false;
}

/* tests only */
export function _resetSnapshotState(env) { if (env && env.RATE) STATES.delete(env.RATE); }
