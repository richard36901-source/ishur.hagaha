/* ============================================================================
   ishur.io · d1mirror.js · the sheet mirrored into Cloudflare D1 (26/11/2026)
   ----------------------------------------------------------------------------
   Richard 26/11: move ishur.io off the Google Sheet onto a real database,
   cheaply (the KV bill was $100). docs/D1-PLAN.md has the phases. This file
   is PHASE 1: D1 is a faithful MIRROR of the three snapshot tabs (events,
   guests, leads). NOTHING reads from it in production.

   · mirrorAfterRefresh(env, raw) — called by snapshot.js refresh() with the
     sheet exactly as Google/Make returned it (before the KV overlay patches
     are applied). It copies the rows synchronously, then upserts only the
     rows whose hash changed. Unchanged rows cost no D1 write; an unchanged
     tab costs no D1 read either (a per-isolate whole-tab hash).
   · reconcile(env, raw, deps) — the nightly full pass: hashes re-read from
     D1 (not the memo), every changed row written, rows gone from the sheet
     soft-deleted, then row counts sheet vs D1 posted to Slack.
   · handleD1Mirror — POST /api/d1-mirror (admin) {action: status|sync|reconcile}.
     Staging has no crons, so this is how the mirror is driven there.

   Off unless BOTH hold: the D1 binding DB exists (staging only, wrangler.toml)
   and KV cfg:d1_mirror = {"value":"on"}. Without DB nothing here touches KV.
   Without the flag: one KV read per snapshot refresh, memoised 60 s.

   Row keys (stable across row moves; sheet position is NOT in the hash):
     events  token (col B)                    fallback row:<i>
     guests  guest id (col C)                 fallback np:<token>:<phone>, then row:<i>
     leads   phone (col C, digits)            fallback row:<i>
   A key seen twice in one tab gets #2, #3… in sheet order, so the counts
   reconcile exactly; the duplicates are reported.

   Deletes are SOFT (deleted_at). A tab that is missing, empty, or shrank to
   under half of what D1 holds (when D1 holds > 20 rows) deletes nothing and
   reports 'delete-guard' — a broken read must never wipe the mirror.
   ========================================================================== */

export const FLAG_KEY = 'cfg:d1_mirror';
const FLAG_MEMO_MS = 60e3;
export const MAX_WRITES_PER_PASS = 3000;   /* statements; a first backfill finishes over two refreshes */
const BATCH = 100;                          /* statements per db.batch() (one query toward the 1,000/invocation cap) */
const REFRESH_WAIT_MS = 2000;               /* the snapshot reader never waits longer than this for the mirror */

const letters = i => { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(97 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/* index → [column, type]. Unnamed columns keep their sheet letter (c_g = column G). */
const NAMED = {
  events: { 1: 'token', 2: 'client', 3: 'phone', 4: 'venue', 5: 'occasion', 6: 'event_date', 7: 'paid', 27: 'cancelled', 31: 'plan', 32: 'tier',
    33: 'style', 34: 'hosts', 36: 'event_time', 37: 'city', 38: 'address', 39: 'send_date_1', 40: 'send_date_2', 41: 'send_date_3' },
  guests: { 2: 'guest_id', 3: 'name', 4: 'phone', 5: ['invited', 'INTEGER'], 8: 'sent', 13: ['party', 'INTEGER'], 15: 'rsvp', 21: 'call_status',
    22: 'call_answer', 24: 'notes', 25: 'last_change', 28: 'token', 29: ['tries', 'INTEGER'], 30: 'table_no' },
  leads: { 1: 'name', 2: 'phone', 3: 'email' },
};
const WIDTH = { events: 51, guests: 32, leads: 26 };   /* A:AY · A:AF · A:Z (gsheets.js SNAPSHOT_RANGES) */
export const TABLES = ['events', 'guests', 'leads'];

export function columnsOf(tab) {
  const out = [];
  for (let i = 0; i < WIDTH[tab]; i++) {
    const n = NAMED[tab][i];
    const [name, type] = Array.isArray(n) ? n : [n || 'c_' + letters(i), 'TEXT'];
    out.push({ i, name, type });
  }
  return out;
}
const COLS = Object.fromEntries(TABLES.map(t => [t, columnsOf(t)]));

/* ── pure helpers ─────────────────────────────────────────────────────── */
const cell = v => (v == null ? '' : String(v));
/* Google drops trailing empty cells, so the same row arrives at different lengths: normalise them away */
export function normRow(r) {
  const a = (Array.isArray(r) ? r : []).map(cell);
  while (a.length && a[a.length - 1] === '') a.pop();
  return a;
}
const digits = s => String(s || '').replace(/\D/g, '');
export function keyOf(tab, row, i) {
  const t = s => String(s || '').trim();
  if (tab === 'events') return t(row[1]) || 'row:' + i;
  if (tab === 'guests') return t(row[2]) || (t(row[28]) && digits(row[4]) ? `np:${t(row[28])}:${digits(row[4])}` : 'row:' + i);
  return digits(row[2]) || 'row:' + i;
}
async function sha1(text) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const toInt = v => { const s = String(v || '').trim(); return /^-?\d+$/.test(s) ? Number(s) : null; };

/* values[] of one tab → [{key, row, raw, i}] with duplicate keys suffixed; dupes = how many were suffixed */
export function keyedRows(tab, values) {
  const seen = new Map(); const out = []; let dupes = 0;
  (values || []).forEach((r, i) => {
    const row = normRow(r);
    if (!row.length) return;   /* a fully empty line is not a row */
    let k = keyOf(tab, row, i);
    const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    if (n > 1) { k = k + '#' + n; dupes++; }
    out.push({ key: k, row, i });
  });
  return { rows: out, dupes };
}

function upsertSql(tab) {
  const cols = COLS[tab].map(c => c.name);
  const all = ['key', ...cols, 'sheet_row', 'raw', 'hash', 'updated_at'];
  const set = [...cols, 'sheet_row', 'raw', 'hash', 'updated_at'].map(c => `${c}=excluded.${c}`).join(', ');
  return `INSERT INTO ${tab} (${all.join(', ')}, first_seen) VALUES (${all.map(() => '?').join(', ')}, ?) ON CONFLICT(key) DO UPDATE SET ${set}, deleted_at=NULL`;
}
function upsertArgs(tab, r, hash, now) {
  const vals = COLS[tab].map(c => { const v = r.row[c.i] == null ? '' : r.row[c.i]; return c.type === 'INTEGER' ? toInt(v) : v; });
  return [r.key, ...vals, r.i + 2, JSON.stringify(r.row), hash, now, now];
}

/* ── per-isolate memo, keyed by the D1 binding (each test db is fresh) ── */
const MEMO = new WeakMap();
function memoOf(env) {
  let m = MEMO.get(env.DB);
  if (!m) { m = { flag: null, flagAt: 0, tabHash: {}, hashes: {} }; MEMO.set(env.DB, m); }
  return m;
}
export function _resetD1Memo(env) { if (env && env.DB) MEMO.delete(env.DB); }

export async function mirrorOn(env) {
  if (!env || !env.DB || !env.RATE) return false;
  const m = memoOf(env);
  if (m.flag !== null && Date.now() - m.flagAt < FLAG_MEMO_MS) return m.flag;
  let on = false;
  try { const v = JSON.parse((await env.RATE.get(FLAG_KEY)) || 'null'); on = !!v && (v.value === 'on' || v.value === true); } catch { on = false; }
  m.flag = on; m.flagAt = Date.now();
  return on;
}

async function loadHashes(env, tab) {
  const r = await env.DB.prepare(`SELECT key, hash, deleted_at FROM ${tab}`).all();
  const map = new Map();
  for (const x of (r && r.results) || []) map.set(x.key, { hash: x.hash, deleted: !!x.deleted_at });
  return map;
}
async function runBatches(env, stmts) {
  for (let i = 0; i < stmts.length; i += BATCH) await env.DB.batch(stmts.slice(i, i + BATCH));
}

/* one tab: diff against the stored hashes, upsert the changed rows, soft-delete the vanished ones */
async function mirrorTab(env, tab, values, { force = false, now, budget }) {
  const m = memoOf(env);
  const res = { tab, sheet: 0, upserted: 0, deleted: 0, unchanged: 0, dupes: 0, capped: false, guard: '' };
  if (!Array.isArray(values)) { res.guard = 'tab-missing'; return res; }
  const { rows, dupes } = keyedRows(tab, values);
  res.sheet = rows.length; res.dupes = dupes;
  const tabHash = await sha1(JSON.stringify(rows.map(r => [r.key, r.row])));
  if (!force && m.tabHash[tab] === tabHash) { res.unchanged = rows.length; res.skippedTab = true; return res; }
  const stored = (!force && m.hashes[tab]) || await loadHashes(env, tab);
  const sql = upsertSql(tab); const stmts = []; const written = [];
  for (const r of rows) {
    const h = await sha1(JSON.stringify(r.row));
    const s = stored.get(r.key);
    if (s && s.hash === h && !s.deleted) { res.unchanged++; continue; }
    if (budget.left <= 0) { res.capped = true; break; }
    stmts.push(env.DB.prepare(sql).bind(...upsertArgs(tab, r, h, now))); written.push([r.key, h]);
    budget.left--;
  }
  /* deletes: only on a full, plausible read */
  const live = [...stored.entries()].filter(([, v]) => !v.deleted).map(([k]) => k);
  const inSheet = new Set(rows.map(r => r.key));
  const gone = live.filter(k => !inSheet.has(k));
  const delStmts = [];
  if (gone.length) {
    if (!rows.length || (live.length > 20 && rows.length < live.length / 2)) res.guard = 'delete-guard';
    else for (const k of gone) {
      if (budget.left <= 0) { res.capped = true; break; }
      delStmts.push(env.DB.prepare(`UPDATE ${tab} SET deleted_at=? WHERE key=? AND deleted_at IS NULL`).bind(now, k)); budget.left--;
    }
  }
  await runBatches(env, [...stmts, ...delStmts]);
  res.upserted = stmts.length; res.deleted = delStmts.length;
  /* the memo only learns what D1 now holds */
  for (const [k, h] of written) stored.set(k, { hash: h, deleted: false });
  for (const st of delStmts.length ? gone.slice(0, delStmts.length) : []) { const v = stored.get(st); if (v) v.deleted = true; }
  m.hashes[tab] = stored;
  if (!res.capped && !res.guard) m.tabHash[tab] = tabHash; else delete m.tabHash[tab];
  return res;
}

/* the whole pass over a snapshot. Never throws. */
export async function mirrorSnapshot(env, raw, { force = false, now = new Date().toISOString(), maxWrites = MAX_WRITES_PER_PASS } = {}) {
  const t0 = Date.now();
  if (!env || !env.DB) return { ok: false, skipped: 'no-db' };
  if (!raw || typeof raw !== 'object') return { ok: false, skipped: 'no-snapshot' };
  const budget = { left: maxWrites }; const tabs = {};
  try {
    for (const tab of TABLES) tabs[tab] = await mirrorTab(env, tab, raw[tab] && raw[tab].values, { force, now, budget });
  } catch (e) {
    MEMO.delete(env.DB);   /* the memo may be ahead of D1 now: start the next pass from D1 */
    return { ok: false, error: String((e && e.message) || e).slice(0, 300), tabs, ms: Date.now() - t0 };
  }
  const changed = TABLES.reduce((n, t) => n + tabs[t].upserted + tabs[t].deleted, 0);
  const out = { ok: true, changed, tabs, ms: Date.now() - t0 };
  if (changed || force) {
    await env.DB.prepare('INSERT INTO mirror_runs (at, kind, upserted, deleted, ms, note) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now, force ? 'full' : 'refresh', TABLES.reduce((n, t) => n + tabs[t].upserted, 0), TABLES.reduce((n, t) => n + tabs[t].deleted, 0), out.ms,
        JSON.stringify(Object.fromEntries(TABLES.map(t => [t, { sheet: tabs[t].sheet, dupes: tabs[t].dupes, guard: tabs[t].guard, capped: tabs[t].capped }])))).run().catch(() => {});
  }
  return out;
}

/* a deep copy of the three tabs' values, taken synchronously (the caller mutates raw right after) */
export function copyTabs(raw) {
  const out = {};
  for (const t of TABLES) { const v = raw && raw[t] && raw[t].values; if (Array.isArray(v)) out[t] = { values: v.map(r => (Array.isArray(r) ? r.slice() : [])) }; }
  return out;
}

/* snapshot.js refresh() hook. Production (no DB) returns before touching anything. */
export async function mirrorAfterRefresh(env, raw) {
  if (!env || !env.DB) return null;
  const copy = copyTabs(raw);
  const work = (async () => (await mirrorOn(env)) ? mirrorSnapshot(env, copy) : null)().catch(() => null);
  let timer;
  const wait = new Promise(r => { timer = setTimeout(() => r({ ok: false, waiting: true }), REFRESH_WAIT_MS); });
  try { return await Promise.race([work, wait]); } finally { clearTimeout(timer); }
}

/* row counts, sheet vs D1 (live rows only) */
export async function counts(env, raw) {
  const out = {};
  for (const t of TABLES) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NULL`).first().catch(() => null);
    const sheet = raw && raw[t] && Array.isArray(raw[t].values) ? keyedRows(t, raw[t].values).rows.length : null;
    out[t] = { sheet, d1: r ? Number(r.n) : null, match: sheet !== null && r ? Number(r.n) === sheet : false };
  }
  return out;
}

export function reconcileText(rep) {
  const line = t => { const c = rep.counts[t], b = rep.before ? rep.before[t] : null, x = rep.mirror.tabs ? rep.mirror.tabs[t] : null;
    return `${c.match && (!b || b.match) ? '✅' : '⚠️'} ${t}: גיליון ${c.sheet ?? '—'} · D1 לפני ${b ? b.d1 ?? '—' : '—'} · אחרי ${c.d1 ?? '—'}` + (x ? ` · נכתבו ${x.upserted} · נמחקו ${x.deleted}` + (x.dupes ? ` · כפולים ${x.dupes}` : '') + (x.guard ? ` · ${x.guard}` : '') : ''); };
  return `🗄️ *מראת D1 · בדיקת לילה*\n${TABLES.map(line).join('\n')}` + (rep.mirror.ok ? '' : `\nהמעבר נכשל: ${rep.mirror.error || rep.mirror.skipped || ''}`);
}

/* the nightly full pass + counts → Slack. deps.slackPost(env, text, opts) injected (tests, index.js). */
export async function reconcile(env, raw, deps = {}) {
  if (!env || !env.DB) return { ok: false, skipped: 'no-db' };
  if (!deps.ignoreFlag && !(await mirrorOn(env))) return { ok: false, skipped: 'off' };
  if (!raw) return { ok: false, skipped: 'no-snapshot' };
  const copy = copyTabs(raw);
  /* before = what the incremental path left (the real check); after = once the full pass has healed it */
  const before = await counts(env, copy);
  const mirror = await mirrorSnapshot(env, copy, { force: true, maxWrites: deps.maxWrites || 20000 });
  const c = await counts(env, copy);
  const drift = TABLES.reduce((n, t) => n + ((mirror.tabs && mirror.tabs[t]) ? mirror.tabs[t].upserted + mirror.tabs[t].deleted : 0), 0);
  const rep = { ok: mirror.ok && TABLES.every(t => c[t].match), clean: mirror.ok && drift === 0 && TABLES.every(t => before[t].match), drift, mirror, before, counts: c };
  if (deps.slackPost && !deps.quiet) await deps.slackPost(env, reconcileText(rep), { oneoff: true }).catch(() => {});
  return rep;
}

export async function status(env) {
  const bound = !!(env && env.DB);
  if (!bound) return { ok: true, bound: false };
  const flag = await mirrorOn(env);
  const c = {};
  for (const t of TABLES) { const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NULL`).first().catch(() => null); c[t] = r ? Number(r.n) : null; }
  const runs = await env.DB.prepare('SELECT at, kind, upserted, deleted, ms, note FROM mirror_runs ORDER BY id DESC LIMIT 10').all().catch(() => null);
  return { ok: true, bound, flag, counts: c, runs: (runs && runs.results) || [] };
}

/* POST /api/d1-mirror {admin_key, action:'status'|'sync'|'reconcile'}
   status    → {ok, bound, flag, counts:{events,guests,leads}, runs:[{at,kind,upserted,deleted,ms,note}]}
   sync      → {ok, changed, tabs:{<tab>:{sheet,upserted,deleted,unchanged,dupes,capped,guard}}, ms}   (works with the flag off: a hand-run)
   reconcile → {ok, clean, drift, mirror, before:{<tab>:{sheet,d1,match}}, counts:{…after}} and the Slack line (clean = nothing to heal)                       (works with the flag off)
   503 not-configured when the Worker has no DB binding (production in phase 1). */
export async function handleD1Mirror(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  const action = ['status', 'sync', 'reconcile'].includes(b.action) ? b.action : 'status';
  if (action === 'status') return d.okJson(await status(env), origin);
  if (!env.DB) return d.deny(503, 'not-configured', origin);
  const raw = await d.readSnapshot(env, 'background').catch(() => null);
  if (!raw) return d.okJson({ ok: false, error: 'no-snapshot' }, origin);
  if (action === 'sync') return d.okJson(await mirrorSnapshot(env, copyTabs(raw), { force: !!b.full }), origin);
  return d.okJson(await reconcile(env, raw, { slackPost: d.slackPost, ignoreFlag: true, quiet: !!b.quiet }), origin);
}
