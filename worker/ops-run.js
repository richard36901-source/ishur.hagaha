/* ============================================================================
   ishur.io · ops-run.js · the runs ledger + kill switches (03/11/2026)
   ----------------------------------------------------------------------------
   docs/OPS-CENTER-PLAN-2026-11-03.md §3(b). One row per execution of an
   automation: start, end, status, who triggered it, counts, cost, error.

   Storage, in order of preference:
     1. D1 binding OPS_DB (database `ishur-ops`, migrations/0001_runs.sql).
     2. When OPS_DB is missing or a D1 call throws: a KV ring buffer
        opsrun:<inverted ms>:<id> (newest sorts first, TTL 3 days). One put per
        finished run, nothing on start — so the ledger never doubles the KV
        writes of a tick, and NOTHING here can throw into the job it wraps.

   withRun(env, automation_id, fn, { triggered_by, parent, job })
     · fn(run) receives a run object: run.id, run.count(k, n), run.cost({usd,
       tokens_in, tokens_out}), run.skip(reason), run.child(id, fn2)
     · keeps the audit.js cron row (audit.job) when `job` is given, so the
       existing readers (automations.js liveState, live.html) see no change;
       the audit row carries data.run_id for the join.
     · status: ok | failed | skipped (fn returned {skipped|paused} or called
       run.skip) | partial (fn returned ok:false without throwing)
     · rethrows fn's error after recording it (callers keep their .catch).

   Kill switches: KV auto:off:<id> (value = JSON {at, by, reason}).
   isOff(env, id) is one KV get; a KV error reads as "on" (fail open: a
   broken switch must not silently stop wedding invitations — the global
   `paused` key remains the fail-safe stop).
   ========================================================================== */
import * as audit from './audit.js';

export const OFF_PREFIX = 'auto:off:';
export const RING_PREFIX = 'opsrun:';
export const RING_TTL = 3 * 86400;
const INV = 9999999999999;   /* inverted ms → lexical sort = newest first */

export async function isOff(env, id) {
  if (!env || !env.RATE || !id) return false;
  try { return !!(await env.RATE.get(OFF_PREFIX + id)); } catch { return false; }
}
export async function offState(env, id) {
  if (!env || !env.RATE) return null;
  try { const v = await env.RATE.get(OFF_PREFIX + id); if (!v) return null; try { return JSON.parse(v); } catch { return { at: null, raw: v }; } } catch { return null; }
}

export function newRunId(now = Date.now()) {
  return `r${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* the status a finished fn implies */
export function statusOf(out, err, skipReason) {
  if (err) return 'failed';
  if (skipReason) return 'skipped';
  if (out && typeof out === 'object') {
    if (out.skipped || out.paused) return 'skipped';
    if (out.ok === false) return 'partial';
  }
  return 'ok';
}
export function skipReasonOf(out, explicit) {
  if (explicit) return String(explicit);
  if (out && typeof out === 'object') {
    if (out.skipped) return String(out.skipped);
    if (out.paused) return 'paused';
  }
  return '';
}
function summarize(out) {
  try { return out === undefined ? '' : JSON.stringify(out).slice(0, 1000); } catch { return String(out).slice(0, 300); }
}

/* ── storage ─────────────────────────────────────────────────────────────── */
const COLS = ['id', 'automation_id', 'parent_id', 'started_at', 'ended_at', 'status', 'triggered_by', 'counts_json', 'cost_usd', 'tokens_in', 'tokens_out', 'summary', 'error', 'logs_ref'];

async function d1Start(env, row) {
  if (!env.OPS_DB) return false;
  try {
    await env.OPS_DB.prepare(`INSERT INTO runs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
      .bind(...COLS.map(c => row[c] ?? null)).run();
    return true;
  } catch { return false; }
}
async function d1End(env, row) {
  if (!env.OPS_DB) return false;
  try {
    const r = await env.OPS_DB.prepare('UPDATE runs SET ended_at=?, status=?, counts_json=?, cost_usd=?, tokens_in=?, tokens_out=?, summary=?, error=?, logs_ref=? WHERE id=?')
      .bind(row.ended_at, row.status, row.counts_json, row.cost_usd, row.tokens_in, row.tokens_out, row.summary, row.error, row.logs_ref, row.id).run();
    /* the start insert may have failed while the update target is missing */
    if (r && r.meta && r.meta.changes === 0) {
      await env.OPS_DB.prepare(`INSERT INTO runs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).bind(...COLS.map(c => row[c] ?? null)).run();
    }
    return true;
  } catch { return false; }
}
async function ringPut(env, row) {
  if (!env.RATE) return false;
  try {
    const ms = Date.parse(row.started_at) || Date.now();
    await env.RATE.put(`${RING_PREFIX}${String(INV - ms).padStart(13, '0')}:${row.id}`, JSON.stringify(row),
      { expirationTtl: RING_TTL, metadata: { a: row.automation_id, s: row.status, p: row.parent_id || '' } });
    return true;
  } catch { return false; }
}

/* ── the wrapper ─────────────────────────────────────────────────────────── */
export async function withRun(env, automation_id, fn, opts = {}) {
  const t0 = Date.now();
  const row = {
    id: newRunId(t0), automation_id: String(automation_id || 'unknown'), parent_id: opts.parent || null,
    started_at: new Date(t0).toISOString(), ended_at: null, status: 'running',
    triggered_by: String(opts.triggered_by || 'cron'), counts_json: null, cost_usd: 0, tokens_in: 0, tokens_out: 0,
    summary: '', error: '', logs_ref: '',
  };
  const counts = {}; const cost = { usd: 0, tokens_in: 0, tokens_out: 0 }; let skip = '';
  const run = {
    id: row.id, automation_id: row.automation_id,
    count(k, n = 1) { counts[k] = (counts[k] || 0) + (Number(n) || 0); },
    cost(c = {}) { cost.usd += Number(c.usd) || 0; cost.tokens_in += Number(c.tokens_in) || 0; cost.tokens_out += Number(c.tokens_out) || 0; },
    skip(reason) { skip = String(reason || 'skipped'); },
    child(id, fn2, o = {}) { return withRun(env, id, fn2, { triggered_by: 'parent:' + row.automation_id, ...o, parent: row.id }); },
  };
  const inD1 = await d1Start(env, row);
  let out, err = null;
  try {
    out = opts.job ? await audit.job(env, opts.job, () => fn(run), { run_id: row.id, automation_id: row.automation_id }) : await fn(run);
  } catch (e) { err = e; }
  row.ended_at = new Date().toISOString();
  row.status = statusOf(out, err, skip);
  const sr = skipReasonOf(out, skip);
  row.counts_json = JSON.stringify({ ...counts, ...(sr ? { skip_reason: sr } : {}), ms: Date.now() - t0 });
  row.cost_usd = Math.round(cost.usd * 1e6) / 1e6; row.tokens_in = cost.tokens_in; row.tokens_out = cost.tokens_out;
  row.summary = summarize(out);
  row.error = err ? String((err && err.stack) || err).slice(0, 1500) : '';
  row.logs_ref = opts.job ? 'audit:cron:' + opts.job : '';
  const stored = inD1 ? await d1End(env, row) : false;
  if (!stored) await ringPut(env, row);
  if (err) throw err;
  return out;
}

/* ── readers ─────────────────────────────────────────────────────────────── */
export function parseRow(r) {
  if (!r) return null;
  let counts = null; try { counts = r.counts_json ? JSON.parse(r.counts_json) : null; } catch {}
  return { id: r.id, automation_id: r.automation_id, parent_id: r.parent_id || null, started_at: r.started_at, ended_at: r.ended_at || null,
    status: r.status, triggered_by: r.triggered_by || '', counts: counts || {}, cost_usd: Number(r.cost_usd) || 0,
    tokens_in: Number(r.tokens_in) || 0, tokens_out: Number(r.tokens_out) || 0, summary: r.summary || '', error: r.error || '', logs_ref: r.logs_ref || '' };
}
/* filter rows in memory (KV ring path) — same semantics as the SQL path */
export function filterRows(rows, f = {}) {
  return rows.filter(r => (!f.automation_id || r.automation_id === f.automation_id) && (!f.status || r.status === f.status) &&
    (!f.from || r.started_at >= f.from) && (!f.to || r.started_at <= f.to) && (!f.parent_id || r.parent_id === f.parent_id) &&
    (!f.before || r.started_at < f.before));
}
async function ringAll(env, maxKeys = 3000) {
  if (!env.RATE) return [];
  const names = []; let cursor;
  for (let i = 0; i < 5 && names.length < maxKeys; i++) {
    const page = await env.RATE.list({ prefix: RING_PREFIX, cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    for (const k of page.keys || []) names.push(k.name);
    if (page.list_complete) break; cursor = page.cursor;
  }
  names.sort();
  const out = [];
  for (let i = 0; i < names.length; i += 50) {
    const vals = await Promise.all(names.slice(i, i + 50).map(n => env.RATE.get(n).catch(() => null)));
    for (const v of vals) { try { const r = JSON.parse(v || 'null'); if (r) out.push(r); } catch {} }
  }
  return out;
}

/* { automation_id, status, from, to, cursor (= started_at of the last row seen), limit ≤ 200 } */
export async function listRuns(env, f = {}) {
  const limit = Math.max(1, Math.min(200, Number(f.limit) || 50));
  const before = f.cursor ? String(f.cursor) : '';
  if (env.OPS_DB) {
    try {
      const where = []; const args = [];
      if (f.automation_id) { where.push('automation_id = ?'); args.push(String(f.automation_id)); }
      if (f.status) { where.push('status = ?'); args.push(String(f.status)); }
      if (f.from) { where.push('started_at >= ?'); args.push(String(f.from)); }
      if (f.to) { where.push('started_at <= ?'); args.push(String(f.to)); }
      if (f.parent_id) { where.push('parent_id = ?'); args.push(String(f.parent_id)); }
      if (before) { where.push('started_at < ?'); args.push(before); }
      const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`;
      const r = await env.OPS_DB.prepare(sql).bind(...args, limit + 1).all();
      const rows = (r.results || []).map(parseRow);
      const more = rows.length > limit; const items = rows.slice(0, limit);
      return { source: 'd1', items, next_cursor: more ? items[items.length - 1].started_at : null };
    } catch (e) { /* fall through to the ring */ }
  }
  const all = filterRows((await ringAll(env)).map(parseRow), { ...f, before });
  all.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const items = all.slice(0, limit);
  return { source: 'kv', items, next_cursor: all.length > limit ? items[items.length - 1].started_at : null };
}
export async function getRun(env, id) {
  if (!id) return null;
  if (env.OPS_DB) {
    try {
      const row = await env.OPS_DB.prepare('SELECT * FROM runs WHERE id = ?').bind(String(id)).first();
      if (row) {
        const kids = await env.OPS_DB.prepare('SELECT * FROM runs WHERE parent_id = ? ORDER BY started_at').bind(String(id)).all();
        return { source: 'd1', run: parseRow(row), children: (kids.results || []).map(parseRow) };
      }
    } catch {}
  }
  const all = (await ringAll(env)).map(parseRow);
  const run = all.find(r => r.id === id);
  if (!run) return null;
  return { source: 'kv', run, children: all.filter(r => r.parent_id === id).sort((a, b) => (a.started_at < b.started_at ? -1 : 1)) };
}
/* 24h counts + last run per automation (registry view) */
export async function runStats(env, sinceIso) {
  const out = {};
  if (env.OPS_DB) {
    try {
      const r = await env.OPS_DB.prepare('SELECT automation_id, status, COUNT(*) n, MAX(started_at) last FROM runs WHERE started_at >= ? GROUP BY automation_id, status').bind(sinceIso).all();
      for (const x of r.results || []) {
        const o = out[x.automation_id] = out[x.automation_id] || { runs_24h: 0, by_status: {}, last_started_at: null };
        o.runs_24h += Number(x.n) || 0; o.by_status[x.status] = Number(x.n) || 0;
        if (!o.last_started_at || x.last > o.last_started_at) o.last_started_at = x.last;
      }
      return { source: 'd1', stats: out };
    } catch {}
  }
  for (const r of filterRows((await ringAll(env)).map(parseRow), { from: sinceIso })) {
    const o = out[r.automation_id] = out[r.automation_id] || { runs_24h: 0, by_status: {}, last_started_at: null };
    o.runs_24h++; o.by_status[r.status] = (o.by_status[r.status] || 0) + 1;
    if (!o.last_started_at || r.started_at > o.last_started_at) o.last_started_at = r.started_at;
  }
  return { source: 'kv', stats: out };
}
