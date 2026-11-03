/* ============================================================================
   ishur.io · store.js · the CRM repository (03/11/2026)
   ----------------------------------------------------------------------------
   One interface, two backends (docs/CRM-API-2026-11-03.md):
     · D1 (env.OPS_DB, migrations/0003_crm.sql) when bound
     · KV (env.RATE) otherwise — same methods, same results, so moving to D1
       is binding the database, nothing else.

   makeStore(env) → {
     kind                                  'd1' | 'kv'
     get(table, id)                        row | null
     upsert(table, row)                    patch-merge by id → the stored row
     remove(table, id)                     true
     list(table, query)                    { items, total, next_cursor }
     findBy(table, field, value)           first row whose field === value
     appendNote({entity_type, entity_id, text, author, pinned, at, origin})
     listNotes(entity_type, entity_id)     pinned first, then oldest → newest
     setNotePinned(entity_type, entity_id, note_id, pinned)
     appendActivity({entity_type, entity_id, kind, dir, text, at, id?, meta})
     listActivities(entity_type, entity_id, {limit})   newest first
   }
   query = { filter: {field: value | [values] | {from, to}}, q, sort: '-updated_at',
             limit (≤500, default 50), cursor (offset string) }

   The filtering/sorting/paging is ONE pure function (applyQuery) for both
   backends; D1 only narrows by indexed columns first. Datasets are small
   (hundreds of leads), so this keeps the two backends provably identical.

   KV layout (no key counting anywhere — list() lags its own writes):
     crm:t:<table>                    {rows:{id:row}}   one doc per table
     crm:n:<entity_type>:<entity_id>  [note…]           notes per entity
     crm:a:<entity_type>:<entity_id>  [activity…]       newest last, ≤ 500
   Known limit: KV is last-write-wins per doc; two writes to the same table
   within the same instant can drop one. D1 does not have this problem.
   ========================================================================== */

export const TABLES = {
  leads: ['phone', 'name', 'source', 'status', 'owner', 'occasion', 'event_date', 'next_action_at', 'quote_id', 'client_token', 'monday_item_id', 'created_at', 'updated_at', 'last_inbound_at', 'last_outbound_at'],
  clients: ['phone', 'name', 'status', 'event_date', 'lead_id', 'created_at', 'updated_at'],
  hostesses: ['phone', 'name', 'city', 'active', 'created_at', 'updated_at'],
  hostess_assignments: ['hostess_id', 'event_token', 'date', 'status', 'created_at', 'updated_at'],
  reminders: ['entity_type', 'entity_id', 'due_at', 'done', 'owner', 'created_at', 'updated_at'],
};
export const ENTITY_TYPES = ['lead', 'client', 'hostess', 'event'];
const ACT_CAP = 500;
const SEARCH_FIELDS = ['name', 'phone', 'occasion', 'next_action_text', 'city', 'text', 'title', 'id'];

export const nowIso = () => new Date().toISOString();
export function newId(prefix) {
  const r = Array.from(crypto.getRandomValues(new Uint8Array(5)), x => x.toString(16).padStart(2, '0')).join('');
  return prefix + Date.now().toString(36) + r;
}

/* ── the one query function both backends run ─────────────────────────── */
function matchOne(v, want) {
  if (Array.isArray(want)) return want.some(w => matchOne(v, w));
  if (want && typeof want === 'object') {
    const s = v == null ? '' : String(v);
    if (want.from != null && !(s >= String(want.from))) return false;
    if (want.to != null && !(s && s <= String(want.to))) return false;
    if (want.empty === true) return v == null || v === '';
    if (want.empty === false) return !(v == null || v === '');
    return true;
  }
  if (Array.isArray(v)) return v.map(String).includes(String(want));       /* tags */
  if (typeof want === 'boolean') return !!v === want;
  return String(v ?? '') === String(want);
}
export function applyQuery(rows, query = {}) {
  const { filter = {}, q = '', sort = '-updated_at' } = query || {};
  const limit = Math.max(1, Math.min(500, Number(query.limit) || 50));
  const offset = Math.max(0, parseInt(query.cursor, 10) || 0);
  let out = (rows || []).filter(r => r && Object.entries(filter).every(([k, w]) => w === undefined || w === '' || matchOne(r[k], w)));
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    const digits = needle.replace(/\D/g, '');
    out = out.filter(r => SEARCH_FIELDS.some(f => String(r[f] ?? '').toLowerCase().includes(needle)) ||
      (digits.length >= 4 && String(r.phone || '').includes(digits.replace(/^0/, ''))) ||
      (Array.isArray(r.tags) && r.tags.some(t => String(t).toLowerCase().includes(needle))));
  }
  const keys = String(sort || '-updated_at').split(',').map(s => s.trim()).filter(Boolean).map(s => s[0] === '-' ? [s.slice(1), -1] : [s, 1]);
  out.sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] ?? '', y = b[k] ?? '';
      if (x === y) continue;
      if (x === '') return 1;                     /* empties last, whatever the direction */
      if (y === '') return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1;
      return c * dir;
    }
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  const total = out.length;
  const items = out.slice(offset, offset + limit);
  return { items, total, next_cursor: offset + limit < total ? String(offset + limit) : null };
}

/* patch-merge: undefined never overwrites; tags union unless replace_tags */
export function mergeRow(prev, patch, at = nowIso()) {
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || k === 'replace_tags') continue;
    if (k === 'tags' && Array.isArray(v) && !patch.replace_tags) { out.tags = [...new Set([...(out.tags || []), ...v.map(String)])]; continue; }
    out[k] = v;
  }
  if (!out.created_at) out.created_at = at;
  out.updated_at = at;
  return out;
}
const sortNotes = arr => [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(a.at).localeCompare(String(b.at)));
function noteOf(n) {
  return { id: n.id || newId('N'), entity_type: n.entity_type, entity_id: String(n.entity_id), text: String(n.text || '').slice(0, 4000),
    author: String(n.author || '').slice(0, 40), pinned: !!n.pinned, at: n.at || nowIso(), origin: n.origin || '' };
}
function actOf(a) {
  return { id: a.id || newId('A'), entity_type: a.entity_type, entity_id: String(a.entity_id), kind: String(a.kind || 'note'), dir: a.dir || '',
    text: String(a.text || '').slice(0, 1000), at: a.at || nowIso(), meta: a.meta || {} };
}

/* ── KV backend ────────────────────────────────────────────────────────── */
export function kvStore(kv) {
  const readJson = async (k, dflt) => { try { const v = await kv.get(k); return v ? JSON.parse(v) : dflt; } catch { return dflt; } };
  const tableDoc = t => readJson('crm:t:' + t, { rows: {} });
  const saveTable = (t, doc) => kv.put('crm:t:' + t, JSON.stringify(doc));
  const check = t => { if (!TABLES[t]) throw new Error('unknown-table:' + t); };
  return {
    kind: 'kv',
    async get(t, id) { check(t); const d = await tableDoc(t); return d.rows[String(id)] || null; },
    async upsert(t, row) {
      check(t); if (!row || !row.id) throw new Error('row-needs-id');
      const d = await tableDoc(t); const id = String(row.id);
      d.rows[id] = mergeRow(d.rows[id], { ...row, id }); await saveTable(t, d); return d.rows[id];
    },
    async remove(t, id) { check(t); const d = await tableDoc(t); delete d.rows[String(id)]; await saveTable(t, d); return true; },
    async list(t, query) { check(t); const d = await tableDoc(t); return applyQuery(Object.values(d.rows), query); },
    async all(t) { check(t); const d = await tableDoc(t); return Object.values(d.rows); },
    async findBy(t, field, value) { check(t); const d = await tableDoc(t); return Object.values(d.rows).find(r => String(r[field] ?? '') === String(value)) || null; },
    async appendNote(n) {
      const note = noteOf(n); const k = `crm:n:${note.entity_type}:${note.entity_id}`;
      const arr = await readJson(k, []); arr.push(note); await kv.put(k, JSON.stringify(arr)); return note;
    },
    async listNotes(type, id) { return sortNotes(await readJson(`crm:n:${type}:${id}`, [])); },
    async setNotePinned(type, id, noteId, pinned) {
      const k = `crm:n:${type}:${id}`; const arr = await readJson(k, []); const n = arr.find(x => x.id === noteId);
      if (!n) return null; n.pinned = !!pinned; await kv.put(k, JSON.stringify(arr)); return n;
    },
    async appendActivity(a) {
      const act = actOf(a); const k = `crm:a:${act.entity_type}:${act.entity_id}`;
      const arr = await readJson(k, []);
      if (a.id && arr.some(x => x.id === a.id)) return arr.find(x => x.id === a.id);
      arr.push(act); arr.sort((x, y) => String(x.at).localeCompare(String(y.at)));
      await kv.put(k, JSON.stringify(arr.slice(-ACT_CAP))); return act;
    },
    async listActivities(type, id, { limit = 200 } = {}) { const arr = await readJson(`crm:a:${type}:${id}`, []); return arr.slice().reverse().slice(0, Math.max(1, Math.min(ACT_CAP, limit))); },
  };
}

/* ── D1 backend ────────────────────────────────────────────────────────── */
const toCol = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
export function d1Store(db) {
  const check = t => { if (!TABLES[t]) throw new Error('unknown-table:' + t); };
  const parse = r => { try { return JSON.parse(r.data_json); } catch { return null; } };
  const getRow = async (t, id) => { const r = await db.prepare(`SELECT data_json FROM ${t} WHERE id = ?`).bind(String(id)).first(); return r ? parse(r) : null; };
  const write = async (t, row) => {
    const cols = ['id', ...TABLES[t], 'data_json'];
    await db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .bind(...cols.map(c => c === 'data_json' ? JSON.stringify(row) : toCol(row[c]))).run();
  };
  const rowsOf = r => ((r && r.results) || []).map(parse).filter(Boolean);
  return {
    kind: 'd1',
    get: async (t, id) => { check(t); return getRow(t, id); },
    async upsert(t, row) {
      check(t); if (!row || !row.id) throw new Error('row-needs-id');
      const merged = mergeRow(await getRow(t, row.id), { ...row, id: String(row.id) }); await write(t, merged); return merged;
    },
    async remove(t, id) { check(t); await db.prepare(`DELETE FROM ${t} WHERE id = ?`).bind(String(id)).run(); return true; },
    async list(t, query = {}) {
      check(t);
      /* narrow by indexed scalar/array filters in SQL, then the shared applyQuery */
      const where = [], args = [];
      for (const [k, w] of Object.entries((query && query.filter) || {})) {
        if (!TABLES[t].includes(k) || w === undefined || w === '' || w === null) continue;
        if (Array.isArray(w) && w.length && w.every(x => typeof x !== 'object')) { where.push(`${k} IN (${w.map(() => '?').join(',')})`); args.push(...w.map(toCol)); }
        else if (typeof w === 'string' || typeof w === 'number') { where.push(`${k} = ?`); args.push(w); }
      }
      const r = await db.prepare(`SELECT data_json FROM ${t}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`).bind(...args).all();
      return applyQuery(rowsOf(r), query);
    },
    async all(t) { check(t); return rowsOf(await db.prepare(`SELECT data_json FROM ${t}`).all()); },
    async findBy(t, field, value) {
      check(t);
      if (field === 'id' || TABLES[t].includes(field)) { const r = await db.prepare(`SELECT data_json FROM ${t} WHERE ${field} = ? LIMIT 1`).bind(String(value)).first(); return r ? parse(r) : null; }
      return (rowsOf(await db.prepare(`SELECT data_json FROM ${t}`).all()).find(x => String(x[field] ?? '') === String(value))) || null;
    },
    async appendNote(n) {
      const note = noteOf(n);
      await db.prepare('INSERT INTO notes (id, entity_type, entity_id, at, pinned, author, text, data_json) VALUES (?,?,?,?,?,?,?,?)')
        .bind(note.id, note.entity_type, note.entity_id, note.at, note.pinned ? 1 : 0, note.author, note.text, JSON.stringify(note)).run();
      return note;
    },
    async listNotes(type, id) { return sortNotes(rowsOf(await db.prepare('SELECT data_json FROM notes WHERE entity_type = ? AND entity_id = ?').bind(type, String(id)).all())); },
    async setNotePinned(type, id, noteId, pinned) {
      const r = await db.prepare('SELECT data_json FROM notes WHERE id = ? AND entity_type = ? AND entity_id = ?').bind(noteId, type, String(id)).first();
      if (!r) return null; const n = { ...parse(r), pinned: !!pinned };
      await db.prepare('UPDATE notes SET pinned = ?, data_json = ? WHERE id = ?').bind(n.pinned ? 1 : 0, JSON.stringify(n), noteId).run(); return n;
    },
    async appendActivity(a) {
      const act = actOf(a);
      if (a.id) { const ex = await db.prepare('SELECT data_json FROM activities WHERE id = ?').bind(a.id).first(); if (ex) return parse(ex); }
      await db.prepare('INSERT INTO activities (id, entity_type, entity_id, at, kind, dir, data_json) VALUES (?,?,?,?,?,?,?)')
        .bind(act.id, act.entity_type, act.entity_id, act.at, act.kind, act.dir, JSON.stringify(act)).run();
      return act;
    },
    async listActivities(type, id, { limit = 200 } = {}) {
      return rowsOf(await db.prepare('SELECT data_json FROM activities WHERE entity_type = ? AND entity_id = ? ORDER BY at DESC, id DESC LIMIT ?').bind(type, String(id), Math.max(1, Math.min(ACT_CAP, limit))).all());
    },
  };
}

export function makeStore(env) {
  if (env && env.OPS_DB && String(env.CRM_STORE || '') !== 'kv') return d1Store(env.OPS_DB);
  if (env && env.RATE) return kvStore(env.RATE);
  throw new Error('no-store: neither OPS_DB nor RATE bound');
}
