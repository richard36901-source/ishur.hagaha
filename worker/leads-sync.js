/* ============================================================================
   ishur.io · leads-sync.js · the leads screen ⇄ the monday leads board (16/11/2026)
   ----------------------------------------------------------------------------
   Richard: leads "more like a list from a CRM system", with "full and immediate
   sync with monday, including updates". next/leads.html shows the board's own
   items; this module keeps a mirror of the board in KV and moves every change
   both ways.

   Routes (admin auth by handleCrm, like every /api/crm/* route):
     GET  /api/crm/leads/board            the whole list + labels + a cursor
     GET  /api/crm/leads/changes?since=   what changed after the cursor (the page polls it)
     GET  /api/crm/leads/m<itemId>        one lead + its notes and activity timeline
     POST /api/crm/leads/m<itemId>        {fields:{status|owner|price|next|note}, base:{…}} → monday
   Webhook (monday → us):
     POST /webhooks/monday-leads?k=<MONDAY_WEBHOOK_SECRET>

   Who holds the truth: monday. A screen edit is written to monday first and is
   stored here only after monday accepted it. A webhook is only a signal: the
   item is read back from monday and that read is what gets stored, so a forged
   webhook can cause a read and nothing else.

   The conflict rule (mergeLead + editConflicts, both pure, both tested):
     · two reads of one item: the one with the later monday `updated_at` wins; a
       stale read never overwrites a newer one;
     · a field we just wrote is held for HOLD_MS against a read that predates the
       write (monday's `updated_at` has not moved past what we saw before writing);
     · a screen edit carries the value the user was looking at (`base`). When
       monday's live value of that field is neither that value nor the new one,
       somebody changed it there meanwhile: the edit is refused (409 conflict),
       nothing is written, and the screen shows monday's value;
     · different fields never conflict; a note is appended, never replaced.

   Never written from here: "נועה תחייג" (boolean_mm945ymc) and every column
   outside WRITABLE. Nothing here sends a WhatsApp or places a call.
   Off switch: CRM_MONDAY_SYNC="off" → no edit, no webhook handling, no reconcile.

   KV (no single shared doc is rewritten on a change, so two webhooks landing
   together cannot drop each other):
     mlb:snap       {started, at, items:{itemId: lead}, labels}   written by the reconcile only
     mlb:meta       {started, at, reload_at, count}                small twin of the snapshot
     mlb:i:<itemId> {rev, lead} | {rev, deleted:true}              one key per changed item, 6 h
     mlb:j          {e:[[itemId, rev]…]}                           recent changes (list() lags its own writes)
   ========================================================================== */
import { mondayGql, digitsIl } from './monday.js';
import { safeEqual } from './lib.js';
import { LEAD_STATUSES, LEAD_OWNERS } from './leads.js';

export const BOARD = '18432553641';
export const MCOL = {
  status: 'status', owner: 'color_mm7g6y7g', phone: 'phone_mm7g3mjv', guests: 'numeric_mm7g6kn3',
  event: 'text_mm7g5b2h', package: 'text_mm7gqfce', source: 'text_mm7gk14c', price: 'numeric_mm8asmzg',
  dial: 'boolean_mm945ymc', ad: 'dropdown_mm94r0td',
  notes: 'long_text_mm7gh65j',   /* הערות (crm.js mondayPush appends to the same column) */
  next: 'date_mm8970h',          /* מתי לחייג (noa.js COL.callback) */
  updates: 'text_mm8a3mbn',      /* עדכונים (noa.js COL.updates) */
};
/* the only columns a screen edit may touch: field → column id */
export const WRITABLE = { status: MCOL.status, owner: MCOL.owner, price: MCOL.price, next: MCOL.next, note: MCOL.notes };
export const EDIT_FIELDS = Object.keys(WRITABLE);
export const HOLD_MS = 10 * 60e3;
export const RECON_STALE_MS = 2 * 60e3;      /* someone is watching: the board is re-read at most this often */
export const OVERLAP_MS = 20e3;              /* a change stamped just before a cursor was issued is served again */
export const ITEM_TTL = 6 * 3600;
const BULK = 60;                             /* a reconcile that finds more changes than this asks the page to reload */
const K = { snap: 'mlb:snap', meta: 'mlb:meta', item: 'mlb:i:', journal: 'mlb:j', lock: 'mlb:lock' };
const COL_IDS = JSON.stringify(Object.values(MCOL));
const ITEM_FIELDS = `id name state created_at updated_at group{ id title } board{ id } column_values(ids:${COL_IDS}){ id text value ... on StatusValue{ index label } }`;

const jparse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const kvJson = async (env, k) => (env.RATE ? jparse(await env.RATE.get(k).catch(() => null)) : null);
const ms = v => Date.parse(v || '') || 0;
const syncOn = env => String((env && env.CRM_MONDAY_SYNC) || 'on') !== 'off';
export const leadId = itemId => 'm' + String(itemId);
export const itemIdOf = id => (/^m\d+$/.test(String(id || '')) ? String(id).slice(1) : '');
const numOrNull = v => { const t = String(v ?? '').replace(/[,\s₪]/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

/* ══ §1 pure: the mapping, both ways ═══════════════════════════════════════ */

/* a monday item (GraphQL shape) → the lead the screen shows */
export function itemToLead(it) {
  const cv = id => (it.column_values || []).find(c => c.id === id) || {};
  const text = id => String(cv(id).text || '').trim();
  const val = id => jparse(cv(id).value) || {};
  const label = id => String(cv(id).label || cv(id).text || '').trim();
  const p = digitsIl(text(MCOL.phone) || val(MCOL.phone).phone || '');
  const dialV = val(MCOL.dial);
  return {
    id: leadId(it.id), item_id: String(it.id), name: String(it.name || '').trim(),
    phone: /^972\d{8,9}$/.test(p) ? p : '', phone_text: text(MCOL.phone),
    event: text(MCOL.event), guests: numOrNull(text(MCOL.guests)), package: text(MCOL.package),
    price: numOrNull(text(MCOL.price)), source: text(MCOL.source), ad: text(MCOL.ad),
    status: label(MCOL.status), owner: label(MCOL.owner),
    dial: text(MCOL.dial) === 'v' || String(dialV.checked) === 'true',
    notes: String(cv(MCOL.notes).text || '').trim(),
    next: /^\d{4}-\d{2}-\d{2}/.test(text(MCOL.next)) ? text(MCOL.next).slice(0, 10) : String(val(MCOL.next).date || ''),
    touch_text: text(MCOL.updates),
    group: String((it.group && it.group.title) || ''),
    created_at: String(it.created_at || ''), m_at: String(it.updated_at || ''),
  };
}

/* the request → clean fields, or the reason it is refused */
export function validateEdit(raw, labels = {}) {
  const f = {}, b = raw && typeof raw === 'object' ? raw : {};
  const statuses = (labels.status && labels.status.length ? labels.status : LEAD_STATUSES), owners = (labels.owner && labels.owner.length ? labels.owner : LEAD_OWNERS);
  for (const k of Object.keys(b)) if (!EDIT_FIELDS.includes(k)) return { error: 'field-not-editable', field: k };
  if (b.status !== undefined) { const s = String(b.status || '').trim(); if (!statuses.includes(s)) return { error: 'bad-status' }; f.status = s; }
  if (b.owner !== undefined) { const o = String(b.owner || '').trim(); if (o && !owners.includes(o)) return { error: 'bad-owner' }; f.owner = o; }
  if (b.price !== undefined) {
    if (b.price === '' || b.price === null) f.price = null;
    else { const n = numOrNull(b.price); if (n === null || n < 0 || n > 1e6) return { error: 'bad-price' }; f.price = n; }
  }
  if (b.next !== undefined) { const d = String(b.next || '').trim(); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'bad-date' }; f.next = d; }
  if (b.note !== undefined) { const t = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 600); if (!t) return { error: 'empty-note' }; f.note = t; }
  if (!Object.keys(f).length) return { error: 'nothing-to-update' };
  return { fields: f };
}

/* clean fields → monday column_values (change_multiple_column_values). `current`
   is the item as monday holds it right now: the note is appended to its הערות. */
export function fieldsToColumns(fields, current = {}, { stamp = '' } = {}) {
  const v = {};
  if (fields.status !== undefined) v[MCOL.status] = { label: fields.status };
  if (fields.owner !== undefined) v[MCOL.owner] = fields.owner ? { label: fields.owner } : null;       /* null clears a status column */
  if (fields.price !== undefined) v[MCOL.price] = fields.price === null ? '' : String(fields.price);
  if (fields.next !== undefined) v[MCOL.next] = fields.next ? { date: fields.next } : null;
  if (fields.note !== undefined) v[MCOL.notes] = { text: noteAppended(current.notes, fields.note, stamp) };
  return v;
}
export function noteAppended(existing, note, stamp = '') {
  const line = (stamp ? stamp + ' · ' : '') + note;
  return (existing ? String(existing) + '\n' : '') + line;
}
/* what the lead looks like once monday accepted `fields` */
export function applyFields(lead, fields, { stamp = '' } = {}) {
  const out = { ...lead };
  for (const k of ['status', 'owner', 'price', 'next']) if (fields[k] !== undefined) out[k] = fields[k];
  if (fields.note !== undefined) out.notes = noteAppended(lead.notes, fields.note, stamp);
  return out;
}
const HELD = { status: 'status', owner: 'owner', price: 'price', next: 'next', note: 'notes' };

/* ══ §1 pure: the conflict rule ════════════════════════════════════════════ */
const same = (a, b) => (a ?? '') === (b ?? '') || (a == null && b === '') || (a === '' && b == null);

/* fields the user edited while monday changed them to something else */
export function editConflicts(current, fields, base) {
  const out = [];
  if (!base || typeof base !== 'object') return out;
  for (const k of ['status', 'owner', 'price', 'next']) {
    if (fields[k] === undefined || base[k] === undefined) continue;
    const b = k === 'price' ? numOrNull(base[k]) : String(base[k] ?? '');
    if (!same(current[k], b) && !same(current[k], fields[k])) out.push(k);
  }
  return out;
}

const DATA = ['name', 'phone', 'phone_text', 'event', 'guests', 'package', 'price', 'source', 'ad', 'status', 'owner', 'dial', 'notes', 'next', 'touch_text', 'group', 'created_at'];
export function sameLead(a, b) { return !!a && !!b && DATA.every(k => same(a[k], b[k])); }

/* stored + a fresh read from monday → what to keep */
export function mergeLead(stored, incoming, now = Date.now()) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  if (ms(incoming.m_at) < ms(stored.m_at)) return stored;                   /* a stale read */
  const h = stored.hold;
  if (h && now - h.at < HOLD_MS && ms(incoming.m_at) <= h.floor) return { ...incoming, ...h.f, hold: h };   /* read predates our own write */
  const { hold, ...rest } = incoming; void hold;
  return rest;
}

/* ══ §2 the mirror in KV ═══════════════════════════════════════════════════ */
async function journal(env) { const j = await kvJson(env, K.journal); return j && Array.isArray(j.e) ? j.e : []; }
async function writeChange(env, itemId, payload, now = Date.now()) {
  const rev = now;
  await env.RATE.put(K.item + itemId, JSON.stringify({ rev, ...payload }), { expirationTtl: ITEM_TTL, metadata: { rev } });
  const e = (await journal(env)).filter(x => String(x[0]) !== String(itemId)); e.push([String(itemId), rev]);
  await env.RATE.put(K.journal, JSON.stringify({ e: e.slice(-300) })).catch(() => {});
  return rev;
}
/* every per-item key changed after `since`: the journal and the key listing, together */
async function changedSince(env, since) {
  const revs = new Map();
  for (const [id, rev] of await journal(env)) if (rev > since) revs.set(String(id), rev);
  let cursor;
  for (let i = 0; i < 5 && env.RATE.list; i++) {
    const pg = await env.RATE.list({ prefix: K.item, cursor, limit: 1000 }).catch(() => null);
    if (!pg) break;
    for (const k of pg.keys || []) { const id = k.name.slice(K.item.length); const rev = k.metadata && k.metadata.rev; if (rev == null || rev > since) revs.set(id, Math.max(revs.get(id) || 0, rev || 0)); }
    if (pg.list_complete || !pg.cursor) break; cursor = pg.cursor;
  }
  const out = [];
  await Promise.all([...revs.keys()].map(async id => { const v = await kvJson(env, K.item + id); if (v && v.rev > since) out.push({ id, ...v }); }));
  return out.sort((a, b) => a.rev - b.rev);
}
/* the snapshot with every later per-item change folded in → { items: Map, snap } */
async function loadBoard(env, now = Date.now()) {
  const snap = (await kvJson(env, K.snap)) || { started: 0, at: 0, items: {}, labels: {} };
  const items = new Map(Object.entries(snap.items || {}));
  const revs = new Map();
  for (const c of await changedSince(env, (snap.started || 0) - OVERLAP_MS)) {
    if (c.deleted) { if (c.rev > (snap.started || 0)) items.delete(c.id); continue; }
    if (c.lead) { items.set(c.id, mergeLead(items.get(c.id), c.lead, now)); revs.set(c.id, c.rev); }
  }
  return { items, snap, revs };
}
async function storedLead(env, itemId) {
  const o = await kvJson(env, K.item + itemId);
  if (o && o.lead) return o.lead;
  const snap = await kvJson(env, K.snap);
  return (!o || !o.deleted) && snap && snap.items ? snap.items[itemId] || null : null;
}

/* ══ §2 monday reads ═══════════════════════════════════════════════════════ */
export function labelsFromColumns(columns) {
  const out = { status: [], owner: [], ad: [] };
  for (const c of columns || []) {
    const s = jparse(c.settings_str) || {};
    const list = Array.isArray(s.labels) ? s.labels.map(l => l && l.name) : Object.values(s.labels || {});
    const names = [...new Set(list.map(x => String(x || '').trim()).filter(Boolean))];
    if (c.id === MCOL.status) out.status = names; else if (c.id === MCOL.owner) out.owner = names; else if (c.id === MCOL.ad) out.ad = names;
  }
  return out;
}
async function readBoard(env, gql) {
  const cols = await gql(env, `query($b:[ID!]){ boards(ids:$b){ columns(ids:["${MCOL.status}","${MCOL.owner}","${MCOL.ad}"]){ id settings_str } } }`, { b: [BOARD] });
  const labels = labelsFromColumns(cols && cols.boards && cols.boards[0] && cols.boards[0].columns);
  const items = []; let cursor = null, complete = false;
  for (let page = 0; page < 20; page++) {
    const r = await gql(env, cursor ? `query($c:String!){ next_items_page(limit:500,cursor:$c){ cursor items{ ${ITEM_FIELDS} } } }`
      : `query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ cursor items{ ${ITEM_FIELDS} } } } }`, cursor ? { c: cursor } : { b: [BOARD] });
    const pg = r && (cursor ? r.next_items_page : r.boards && r.boards[0] && r.boards[0].items_page);
    if (!pg) throw new Error('monday: no items page');
    items.push(...(pg.items || [])); cursor = pg.cursor;
    if (!cursor) { complete = true; break; }
  }
  return { labels, items, complete };
}
async function readItem(env, gql, itemId) {
  const r = await gql(env, `query($i:[ID!]){ items(ids:$i){ ${ITEM_FIELDS} } }`, { i: [String(itemId)] });
  const it = r && r.items && r.items[0];
  if (!it) return { gone: true };
  if ((it.state && it.state !== 'active') || (it.board && String(it.board.id) !== BOARD)) return { gone: true };
  return { lead: itemToLead(it) };
}

/* the healing read: the whole board against the mirror. Cron-safe: no token or
   sync off → a no-op; a failed or partial board read changes nothing. */
export async function reconcileLeads(env, { gql = mondayGql, now = Date.now(), force = false } = {}) {
  if (!syncOn(env)) return { ok: false, why: 'sync-off' };
  if (!env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token' };
  if (!env.RATE) return { ok: false, why: 'no-kv' };
  if (!force && await env.RATE.get(K.lock).catch(() => null)) return { ok: false, why: 'running' };
  await env.RATE.put(K.lock, String(now), { expirationTtl: 60 }).catch(() => {});
  try {
    const started = now;
    const board = await readBoard(env, gql);
    const { items: cur, snap, revs } = await loadBoard(env, now);
    const first = !snap.at;
    const next = {}, changes = [];
    for (const it of board.items) {
      const inc = itemToLead(it), id = String(it.id), had = cur.get(id);
      const merged = mergeLead(had, inc, now);
      next[id] = merged;
      if (!had || !sameLead(had, merged)) changes.push([id, { lead: merged }]);
    }
    for (const [id, had] of cur) {
      if (next[id]) continue;
      if ((revs.get(id) || 0) >= started || !board.complete) { next[id] = had; continue; }   /* created after the read began, or the read was cut short */
      changes.push([id, { deleted: true }]);
    }
    const bulk = first || changes.length > BULK;
    if (!bulk) for (const [id, payload] of changes) await writeChange(env, id, payload, now);
    const at = now;
    await env.RATE.put(K.snap, JSON.stringify({ started, at, items: next, labels: board.labels }));
    const meta = (await kvJson(env, K.meta)) || {};
    await env.RATE.put(K.meta, JSON.stringify({ started, at, count: Object.keys(next).length, reload_at: bulk && changes.length ? at : meta.reload_at || 0 }));
    return { ok: true, items: board.items.length, changed: changes.length, bulk, first };
  } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 200) }; }
  finally { await env.RATE.delete(K.lock).catch(() => {}); }
}

/* ══ §2 monday → us: the webhook ═══════════════════════════════════════════ */
const b64u = s => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), c => c.charCodeAt(0)); };
/* monday signs only webhooks created with an app token (JWT, HS256, the app's signing secret) */
export async function jwtOk(token, secret) {
  try {
    const [h, p, s] = String(token || '').replace(/^Bearer\s+/i, '').split('.');
    if (!h || !p || !s) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, b64u(s), new TextEncoder().encode(h + '.' + p));
  } catch { return false; }
}
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

export async function handleMondayWebhook(request, env, url, { gql = mondayGql, now = Date.now() } = {}) {
  if (request.method !== 'POST') return jres({ ok: false, error: 'method' }, 405);
  /* closed until a secret is set: monday does not sign token-created webhooks, the URL carries the proof */
  if (!env.MONDAY_WEBHOOK_SECRET) return jres({ ok: false, error: 'not-configured' }, 503);
  if (!safeEqual(String(url.searchParams.get('k') || ''), String(env.MONDAY_WEBHOOK_SECRET))) return jres({ ok: false, error: 'forbidden' }, 403);
  const auth = request.headers.get('Authorization');
  if (auth && env.MONDAY_SIGNING_SECRET && !(await jwtOk(auth, env.MONDAY_SIGNING_SECRET))) return jres({ ok: false, error: 'bad-signature' }, 403);
  let body = null; try { body = await request.json(); } catch { return jres({ ok: false, error: 'bad-json' }, 400); }
  if (body && typeof body.challenge === 'string') return jres({ challenge: body.challenge });
  const ev = (body && (body.event || body)) || {};
  if (ev.boardId != null && String(ev.boardId) !== BOARD) return jres({ ok: true, ignored: 'board' });
  const itemId = String(ev.pulseId || ev.itemId || '').replace(/\D/g, '');
  if (!itemId) return jres({ ok: true, ignored: 'no-item' });
  if (!syncOn(env)) return jres({ ok: true, ignored: 'sync-off' });
  if (!env.MONDAY_API_TOKEN || !env.RATE) return jres({ ok: false, why: 'no-token' });
  /* the payload is a signal only: what gets stored is what monday answers for this item */
  let read; try { read = await readItem(env, gql, itemId); } catch (e) { return jres({ ok: false, error: 'monday-read-failed' }, 503); }   /* monday retries every minute for 30 minutes */
  const had = await storedLead(env, itemId);
  if (read.gone) {
    if (had) await writeChange(env, itemId, { deleted: true }, now);
    return jres({ ok: true, id: leadId(itemId), deleted: true, changed: !!had });
  }
  const merged = mergeLead(had, read.lead, now);
  const changed = !had || !sameLead(had, merged);
  if (changed) await writeChange(env, itemId, { lead: merged }, now);
  return jres({ ok: true, id: leadId(itemId), changed });
}

/* ══ §2 us → monday: one edit ══════════════════════════════════════════════ */
const ddmm = t => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value])); return p.day + '.' + p.month; };
const FIELD_HE = { status: 'סטטוס', owner: 'טיפול', price: 'מחיר', next: 'הצעד הבא' };

export async function editLead(env, id, body, { gql = mondayGql, now = Date.now(), store = null, who = 'admin' } = {}) {
  const itemId = itemIdOf(id);
  if (!itemId) return { status: 400, body: { ok: false, error: 'bad-id' } };
  if (!syncOn(env)) return { status: 503, body: { ok: false, error: 'sync-off' } };
  if (!env.MONDAY_API_TOKEN) return { status: 503, body: { ok: false, error: 'no-token' } };
  const snapLabels = ((await kvJson(env, K.snap)) || {}).labels || {};
  const v = validateEdit(body.fields, snapLabels);
  if (v.error) return { status: 400, body: { ok: false, error: v.error, field: v.field } };
  const fields = v.fields;
  /* the item as monday holds it this second: existence, the conflict check, the notes to append to */
  let read; try { read = await readItem(env, gql, itemId); } catch (e) { return { status: 502, body: { ok: false, error: 'monday-failed', why: String((e && e.message) || e).slice(0, 200) } }; }
  if (read.gone) { await writeChange(env, itemId, { deleted: true }, now).catch(() => {}); return { status: 404, body: { ok: false, error: 'gone' } }; }
  const current = read.lead;
  const conflicts = editConflicts(current, fields, body.base);
  if (conflicts.length) {
    const had = await storedLead(env, itemId), merged = mergeLead(had, current, now);
    if (!had || !sameLead(had, merged)) await writeChange(env, itemId, { lead: merged }, now).catch(() => {});
    return { status: 409, body: { ok: false, error: 'conflict', fields: conflicts, lead: current } };
  }
  const stamp = ddmm(now) + (who && who !== 'admin' ? ' ' + who : '');
  const cols = fieldsToColumns(fields, current, { stamp });
  for (const c of Object.keys(cols)) if (!Object.values(WRITABLE).includes(c)) return { status: 500, body: { ok: false, error: 'column-not-writable' } };
  let ret = null;
  try {
    ret = await gql(env, 'mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id updated_at } }', { b: BOARD, i: itemId, v: JSON.stringify(cols) });
  } catch (e) { return { status: 502, body: { ok: false, error: 'monday-failed', why: String((e && e.message) || e).slice(0, 200) } }; }
  /* accepted: only now does our copy change */
  const after = applyFields(current, fields, { stamp });
  const back = ret && ret.change_multiple_column_values && ret.change_multiple_column_values.updated_at;
  if (ms(back) > ms(after.m_at)) after.m_at = String(back);
  const held = {}; for (const k of Object.keys(fields)) held[HELD[k]] = after[HELD[k]];
  after.hold = { at: now, floor: ms(current.m_at), f: held };
  const rev = await writeChange(env, itemId, { lead: after }, now);
  /* the local timeline (the drawer). A failure here does not undo what monday accepted. */
  if (store && current.phone) {
    const eid = 'L' + current.phone;
    try {
      if (fields.note) await store.appendNote({ entity_type: 'lead', entity_id: eid, text: fields.note, author: who, origin: 'leads-screen' });
      const moved = Object.keys(fields).filter(k => k !== 'note').map(k => `${FIELD_HE[k]}: ${current[k] ?? ''} → ${fields[k] ?? ''}`);
      if (moved.length) await store.appendActivity({ entity_type: 'lead', entity_id: eid, kind: 'status', text: moved.join(' · '), meta: { who, via: 'leads-screen' } });
    } catch { /* timeline only */ }
  }
  return { status: 200, body: { ok: true, lead: pub(after), rev, saved_at: new Date(now).toISOString() } };
}

/* ══ §2 the routes under /api/crm/leads/ ═══════════════════════════════════ */
const pub = l => { if (!l) return l; const { hold, ...rest } = l; void hold; return rest; };
/* what our own store knows about the same phone: the last message either way, the client it became */
async function withCrm(store, leads) {
  let rows = []; try { rows = store ? await store.all('leads') : []; } catch { rows = []; }
  const by = new Map(rows.map(r => [r.phone, r]));
  return leads.map(l => {
    const c = l.phone ? by.get(l.phone) : null, o = pub(l);
    o.touch_at = [o.m_at, c && c.last_inbound_at, c && c.last_outbound_at].filter(Boolean).sort((a, b) => ms(a) - ms(b)).pop() || '';
    if (c) { o.crm_id = c.id; o.client_token = c.client_token || ''; o.next_text = c.next_action_text || ''; }
    return o;
  });
}
async function freshen(env, o) {
  const meta = (await kvJson(env, K.meta)) || {};
  if (syncOn(env) && env.MONDAY_API_TOKEN && o.now - (meta.at || 0) > RECON_STALE_MS) return reconcileLeads(env, o);
  return null;
}

export async function leadsBoardRoute(env, { b, isPost, body, q, store, who, gql = mondayGql, now = Date.now() }) {
  if (b !== 'board' && b !== 'changes' && !itemIdOf(b)) return null;
  if (!env.RATE) return { status: 503, body: { ok: false, error: 'no-store' } };
  const monday = !syncOn(env) ? 'sync-off' : !env.MONDAY_API_TOKEN ? 'no-token' : 'ok';
  if (b === 'board') {
    const rec = await freshen(env, { gql, now });
    const { items, snap } = await loadBoard(env, now);
    const labels = snap.labels || {};
    return { status: 200, body: { ok: true, monday: rec && !rec.ok && rec.why !== 'running' ? 'error' : monday, why: rec && !rec.ok ? rec.why : undefined,
      items: await withCrm(store, [...items.values()]), cursor: now, synced_at: snap.at ? new Date(snap.at).toISOString() : '',
      statuses: labels.status && labels.status.length ? labels.status : LEAD_STATUSES, owners: labels.owner && labels.owner.length ? labels.owner : LEAD_OWNERS } };
  }
  if (b === 'changes') {
    const since = Number(q('since')) || 0;
    await freshen(env, { gql, now });
    const meta = (await kvJson(env, K.meta)) || {};
    if (!since || now - since > (ITEM_TTL - 600) * 1000 || (meta.reload_at || 0) > since) return { status: 200, body: { ok: true, reload: true, cursor: now, monday } };
    const ch = await changedSince(env, since - OVERLAP_MS);
    return { status: 200, body: { ok: true, monday, cursor: now, synced_at: meta.at ? new Date(meta.at).toISOString() : '',
      items: await withCrm(ch.some(c => c.lead) ? store : null, ch.filter(c => c.lead).map(c => ({ ...c.lead, rev: c.rev }))), deleted: ch.filter(c => c.deleted).map(c => leadId(c.id)) } };
  }
  if (isPost) return editLead(env, b, body, { gql, now, store, who });
  const lead = await storedLead(env, itemIdOf(b));
  if (!lead) return { status: 404, body: { ok: false, error: 'not-found' } };
  let notes = [], activities = [];
  if (store && lead.phone) { try { [notes, activities] = await Promise.all([store.listNotes('lead', 'L' + lead.phone), store.listActivities('lead', 'L' + lead.phone, { limit: 100 })]); } catch { /* timeline only */ } }
  return { status: 200, body: { ok: true, lead: (await withCrm(store, [lead]))[0], notes, activities } };
}
