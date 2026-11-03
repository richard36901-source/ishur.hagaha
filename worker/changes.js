/* ============================================================================
   ishur.io · changes.js · the change log ("שינויים", 03/11/2026)
   ----------------------------------------------------------------------------
   Richard: "every change must be written there; a full change log like Git,
   so I know what changed and can roll back." docs/CHANGELOG-FEATURE-2026-11-03.md

   One row per thing that changes how the business behaves:
     deploy    a new Worker version went live (build-info.json: commit, branch, commit subjects)
     registry  automations added / removed / changed (registry diff at deploy time)
     edit      /api/ops/edit (cfg.js settings)          · revert: previous value
     hold      /api/ops/edit event_hold                  · revert: flip back
     toggle    /api/ops/toggle (kill switches)           · revert: flip back
     pause     /api/pause (the global stop)              · revert: flip back
     template  Meta template status changed / custom wording submitted
     brain     playbook executed (auto or approved) / rejected
     subevent  sub-event created · blast: manual guest sends (gift, sub-event, SMS, resend, wave-retry)
     revert    a revert done from the change log itself

   Storage, like ops-run.js: D1 OPS_DB table `changes` (migrations/0004_changes.sql),
   else a KV ring chg:<inverted ms>:<id> (newest first, TTL 400 days).
   recordChange NEVER throws into the caller.

   Entry shape (GET /api/ops/changes):
     {id, at, kind, actor: Richard|Claude|brain|system, summary_he, details,
      revert: {possible, how: toggle|edit|rollback|none, payload, confirm},
      reverted_at, reverted_by}
   ========================================================================== */

export const CHG_PREFIX = 'chg:';
export const CHG_TTL = 400 * 86400;
export const KINDS = {
  deploy: 'גרסה', registry: 'אוטומציות', edit: 'עריכה', hold: 'החזקה', toggle: 'מתג', pause: 'עצירה כללית',
  template: 'תבנית', brain: 'מוח', subevent: 'אירוע-בן', blast: 'שליחה ידנית', revert: 'שחזור', control: 'שליטה ידנית',
};
export const ACTORS = ['Richard', 'Claude', 'brain', 'system'];
export const REGISTRY_SNAPSHOT_KEY = 'registry:snapshot';
export const BUILD_INFO_KEY = 'build:info';
export const WORKER_NAME = 'ishur-webhooks';
const INV = 9999999999999;
const NEW_MS = 7 * 864e5;

/* ══ pure ══════════════════════════════════════════════════════════════════ */
export function newChangeId(now = Date.now()) { return `c${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`; }

/* free-text "who" → one of ACTORS */
export function actorOf(who) {
  const w = String(who || '').toLowerCase();
  if (!w) return 'system';
  if (/claude|agent|קלוד/.test(w)) return 'Claude';
  if (/^brain|מוח|^auto/.test(w)) return 'brain';
  if (/^(system|cron|doctor|meta|client|parent:)/.test(w)) return 'system';
  return 'Richard';
}

export function normRevert(r) {
  if (!r || !r.possible) return { possible: false, how: 'none', payload: null };
  const how = ['toggle', 'edit', 'rollback'].includes(r.how) ? r.how : 'none';
  return { possible: how !== 'none', how, payload: r.payload ?? null };
}
/* the word the UI must type before a revert */
export function revertWord(entry) {
  if (!entry || !entry.revert || !entry.revert.possible) return null;
  if (entry.revert.how === 'rollback') return 'rollback:' + String((entry.revert.payload || {}).version_id || '');
  return 'revert:' + entry.id;
}

export function makeEntry({ kind, actor, who, summary_he, details = null, revert = null, at = null, id = null }, now = Date.now()) {
  const k = KINDS[kind] ? kind : 'edit';
  const e = {
    id: id || newChangeId(now), at: at || new Date(now).toISOString(), kind: k,
    actor: ACTORS.includes(actor) ? actor : actorOf(who),
    summary_he: String(summary_he || KINDS[k]).slice(0, 400),
    details: details == null ? null : details, revert: normRevert(revert), reverted_at: null, reverted_by: null,
  };
  e.revert.confirm = revertWord(e);
  return e;
}

export function filterChanges(rows, f = {}) {
  const kinds = f.kind ? String(f.kind).split(',').filter(Boolean) : null;
  return rows.filter(r => (!kinds || kinds.includes(r.kind)) && (!f.actor || r.actor === f.actor) &&
    (!f.from || r.at >= f.from) && (!f.to || r.at <= f.to) && (!f.before || r.at < f.before));
}

/* build-info commits → only those newer than the previously deployed commit */
export function commitsSince(commits = [], prevCommit = '') {
  const list = Array.isArray(commits) ? commits : [];
  if (!prevCommit) return list;
  const p = String(prevCommit);
  const i = list.findIndex(c => c && c.hash && (c.hash.startsWith(p) || p.startsWith(c.hash)));
  return i >= 0 ? list.slice(0, i) : list;
}

/* registry snapshot: per node a hash of the whole node and of each field.
   Line numbers in source/evidence are dropped — moving code is not a change. */
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const h32 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const unline = x => (x && typeof x === 'object' && 'line' in x ? { ...x, line: undefined } : x);
export function nodeFingerprint(n) {
  const clean = { ...n, source: unline(n.source), evidence: (n.evidence || []).map(unline) };
  delete clean.added;
  const f = {};
  for (const k of Object.keys(clean).sort()) f[k] = h32(stable(clean[k]));
  return { h: h32(stable(clean)), f, name_he: n.name_he || n.id };
}
export function snapshotOf(nodes = []) { return Object.fromEntries(nodes.map(n => [n.id, nodeFingerprint(n)])); }
export function diffRegistry(prev = {}, cur = {}) {
  const added = [], removed = [], changed = [];
  for (const [id, c] of Object.entries(cur)) {
    const p = prev[id];
    if (!p) added.push({ id, name_he: c.name_he });
    else if (p.h !== c.h) changed.push({ id, name_he: c.name_he, fields: [...new Set([...Object.keys(c.f || {}), ...Object.keys(p.f || {})])].filter(k => (c.f || {})[k] !== (p.f || {})[k]).sort() });
  }
  for (const [id, p] of Object.entries(prev)) if (!cur[id]) removed.push({ id, name_he: p.name_he });
  return { added, removed, changed, empty: !added.length && !removed.length && !changed.length };
}
export function isNew(addedAt, now = Date.now()) { const t = Date.parse(addedAt || ''); return Number.isFinite(t) && now - t >= 0 && now - t < NEW_MS; }

/* ══ storage ═══════════════════════════════════════════════════════════════ */
const COLS = ['id', 'at', 'kind', 'actor', 'summary_he', 'details_json', 'revert_json', 'reverted_at', 'reverted_by'];
const toRow = e => ({ ...e, details_json: e.details == null ? null : JSON.stringify(e.details).slice(0, 60000), revert_json: JSON.stringify(e.revert) });
export function parseRow(r) {
  if (!r) return null;
  if (!('details_json' in r) && !('revert_json' in r)) { const { stored, ...e } = r; return { ...e, details: e.details ?? null, reverted_at: e.reverted_at || null, reverted_by: e.reverted_by || null, revert: normRevertKeep(e.revert) }; }
  let details = null, revert = null;
  try { details = r.details_json ? JSON.parse(r.details_json) : null; } catch {}
  try { revert = r.revert_json ? JSON.parse(r.revert_json) : null; } catch {}
  return { id: r.id, at: r.at, kind: r.kind, actor: r.actor, summary_he: r.summary_he || '', details, revert: normRevertKeep(revert), reverted_at: r.reverted_at || null, reverted_by: r.reverted_by || null };
}
function normRevertKeep(r) { const n = normRevert(r); n.confirm = r && r.confirm ? r.confirm : null; return n; }
const ringKey = e => `${CHG_PREFIX}${String(INV - (Date.parse(e.at) || Date.now())).padStart(13, '0')}:${e.id}`;

async function put(env, e) {
  if (env.OPS_DB) {
    try {
      const row = toRow(e);
      await env.OPS_DB.prepare(`INSERT OR REPLACE INTO changes (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).bind(...COLS.map(c => row[c] ?? null)).run();
      return 'd1';
    } catch {}
  }
  if (!env.RATE) return null;
  try { await env.RATE.put(ringKey(e), JSON.stringify(e), { expirationTtl: CHG_TTL, metadata: { k: e.kind, a: e.actor } }); return 'kv'; } catch { return null; }
}

/* record one change. Never throws. Returns the entry (with .stored = d1|kv|null). */
export async function recordChange(env, input, now = Date.now()) {
  try {
    if (!env) return null;
    const e = makeEntry(input, now);
    e.stored = await put(env, e);
    return e;
  } catch { return null; }
}

async function ringAll(env, maxKeys = 5000) {
  if (!env.RATE) return [];
  const names = []; let cursor;
  for (let i = 0; i < 6 && names.length < maxKeys; i++) {
    const page = await env.RATE.list({ prefix: CHG_PREFIX, cursor, limit: 1000 }).catch(() => null);
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

/* { kind (comma list), actor, from, to, cursor (= at of the last row seen), limit ≤ 200 } */
export async function listChanges(env, f = {}) {
  const limit = Math.max(1, Math.min(200, Number(f.limit) || 100));
  const before = f.cursor ? String(f.cursor) : '';
  if (env.OPS_DB) {
    try {
      const where = [], args = [];
      const kinds = f.kind ? String(f.kind).split(',').filter(Boolean) : [];
      if (kinds.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
      if (f.actor) { where.push('actor = ?'); args.push(String(f.actor)); }
      if (f.from) { where.push('at >= ?'); args.push(String(f.from)); }
      if (f.to) { where.push('at <= ?'); args.push(String(f.to)); }
      if (before) { where.push('at < ?'); args.push(before); }
      const r = await env.OPS_DB.prepare(`SELECT * FROM changes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`).bind(...args, limit + 1).all();
      const rows = (r.results || []).map(parseRow);
      const items = rows.slice(0, limit);
      return { source: 'd1', items, next_cursor: rows.length > limit ? items[items.length - 1].at : null };
    } catch {}
  }
  const all = filterChanges((await ringAll(env)).map(parseRow), { ...f, before });
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const items = all.slice(0, limit);
  return { source: 'kv', items, next_cursor: all.length > limit ? items[items.length - 1].at : null };
}

export async function getChange(env, id) {
  if (!id) return null;
  if (env.OPS_DB) {
    try { const r = await env.OPS_DB.prepare('SELECT * FROM changes WHERE id = ?').bind(String(id)).first(); if (r) return parseRow(r); } catch {}
  }
  if (!env.RATE) return null;
  let cursor;
  for (let i = 0; i < 6; i++) {
    const page = await env.RATE.list({ prefix: CHG_PREFIX, cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    const k = (page.keys || []).find(x => x.name.endsWith(':' + id));
    if (k) { try { return parseRow(JSON.parse((await env.RATE.get(k.name)) || 'null')); } catch { return null; } }
    if (page.list_complete) break; cursor = page.cursor;
  }
  return null;
}

export async function markReverted(env, entry, byId, now = Date.now()) {
  if (!entry) return;
  const e = { ...entry, reverted_at: new Date(now).toISOString(), reverted_by: byId || null };
  if (env.OPS_DB) {
    try { await env.OPS_DB.prepare('UPDATE changes SET reverted_at = ?, reverted_by = ? WHERE id = ?').bind(e.reverted_at, e.reverted_by, e.id).run(); return; } catch {}
  }
  if (env.RATE) { try { const { stored, ...clean } = e; await env.RATE.put(ringKey(clean), JSON.stringify(clean), { expirationTtl: CHG_TTL, metadata: { k: e.kind, a: e.actor } }); } catch {} }
}

/* ══ deploy + registry diff (called once per new version by the doctor) ═════ */
async function kjson(env, k) { try { return JSON.parse((await env.RATE.get(k)) || 'null'); } catch { return null; } }

export async function recordRegistryDiff(env, nodes, { version = '', now = Date.now() } = {}) {
  if (!env || !env.RATE) return null;
  const prev = await kjson(env, REGISTRY_SNAPSHOT_KEY);
  const cur = snapshotOf(nodes);
  const at = new Date(now).toISOString();
  const first = { ...((prev && prev.first_seen) || {}) };
  for (const n of nodes) if (!(n.id in first)) first[n.id] = prev ? (n.added || at) : (n.added || null);
  let entry = null;
  if (!prev) {
    entry = await recordChange(env, { kind: 'registry', actor: 'system', summary_he: `תמונת בסיס של הרישום: ${nodes.length} אוטומציות`, details: { baseline: true, version, count: nodes.length, ids: nodes.map(n => n.id) } }, now);
  } else {
    const d = diffRegistry(prev.nodes || {}, cur);
    for (const r of d.removed) delete first[r.id];
    if (!d.empty) {
      const parts = [d.added.length ? `+${d.added.length} חדשות` : '', d.removed.length ? `−${d.removed.length} הוסרו` : '', d.changed.length ? `${d.changed.length} שונו` : ''].filter(Boolean);
      entry = await recordChange(env, { kind: 'registry', actor: 'system', summary_he: `אוטומציות: ${parts.join(' · ')}${d.added.length ? ' — ' + d.added.slice(0, 4).map(x => x.name_he).join(', ') : ''}`, details: { version, previous_version: prev.version || null, ...d } }, now);
    }
  }
  await env.RATE.put(REGISTRY_SNAPSHOT_KEY, JSON.stringify({ at, version, nodes: cur, first_seen: first })).catch(() => {});
  return entry;
}

export async function registryFirstSeen(env) { const s = env && env.RATE ? await kjson(env, REGISTRY_SNAPSHOT_KEY) : null; return (s && s.first_seen) || {}; }

/* vid = CF_VERSION_METADATA.id; info = build-info.json; nodes = AUTOMATIONS */
export async function recordDeploy(env, vid, info = {}, nodes = [], now = Date.now()) {
  if (!env || !env.RATE || !vid) return null;
  const prev = await kjson(env, BUILD_INFO_KEY);
  const commits = commitsSince(info.commits || [], prev && prev.commit);
  const short = String(vid).slice(0, 8);
  const head = (info.commit ? String(info.commit).slice(0, 7) : '') + (info.branch ? ` (${info.branch})` : '');
  const entry = await recordChange(env, {
    kind: 'deploy', actor: actorOf(info.by || 'system'),
    summary_he: `גרסה חדשה עלתה · deploy:${short}${head ? ' · ' + head : ''}${commits.length ? ` · ${commits.length} קומיטים` : ''}`,
    details: { version_id: vid, version_tag: info.version_tag || '', commit: info.commit || env.BUILD_SHA || '', branch: info.branch || '', built_at: info.date || '', note: env.BUILD_NOTE || '',
      commits: commits.slice(0, 60), commits_truncated: commits.length > 60, previous_version_id: prev ? prev.version : null, previous_commit: prev ? prev.commit : null,
      rollback_command: prev && prev.version ? `cd worker && npx wrangler rollback ${prev.version} --name ${WORKER_NAME}` : null },
    revert: prev && prev.version ? { possible: true, how: 'rollback', payload: { version_id: prev.version, script: WORKER_NAME, from_version: vid } } : null,
  }, now);
  await env.RATE.put(BUILD_INFO_KEY, JSON.stringify({ version: vid, commit: info.commit || env.BUILD_SHA || '', branch: info.branch || '', at: new Date(now).toISOString() })).catch(() => {});
  const reg = await recordRegistryDiff(env, nodes, { version: vid, now }).catch(() => null);
  return { deploy: entry, registry: reg };
}

/* Cloudflare API: make `version_id` the 100% deployment of the Worker */
export async function cfRollback(env, versionId, { message = '', fetchFn = fetch } = {}) {
  const acct = env.CF_ACCOUNT_ID, tok = env.CF_API_TOKEN;
  if (!acct || !tok) return { ok: false, manual: true, why: 'no-cf-api-token' };
  const r = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts/${WORKER_NAME}/deployments`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }], annotations: { 'workers/message': String(message || 'rollback from ops center').slice(0, 100) } }),
  }).catch(e => ({ ok: false, status: 0, json: async () => ({ errors: [{ message: String(e && e.message || e) }] }) }));
  const j = await r.json().catch(() => ({}));
  return { ok: !!(r.ok && j && j.success !== false), status: r.status, deployment_id: j && j.result ? j.result.id : null, errors: (j && j.errors) || [] };
}
