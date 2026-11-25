/* ============================================================================
   ishur.io · teamissues.js · the team's work items (25/11/2026)
   ----------------------------------------------------------------------------
   A panel on the left of every back-office page (assets/teampanel.js) where the
   team opens a bug/issue (באג/תקלה) or a client request (בקשת לקוח) for one
   person, talks about it in a thread, and moves it along:

       open → in_progress → done (the assignee: "go check it") → closed
       closed ONLY by the person who opened it; the opener can also send it back to open.

   Who is asking = the Google user the sign-in gate put in x-ishur-user (auth.js).
   Each person sees what they opened or what is assigned to them; admin/dev may ask
   for everything ("הכל") — that is visibility only, it gives no extra rights.

   KV  teamissue:<id>  = the item {id, type, title, text, event, opener, assignee, status,
                          created_at, updated_at, comments[], history[], from_note?}
       teamissueidx    = [{id, type, title, opener, assignee, status, ev, n, updated_at, created_at}]
                          one small document (KV list() lags its own writes; never count keys).
                          The item is written first, the index second; every write answers
                          with the item and the fresh counts so the screen never re-lists.
   Team notes (teamnotes.js, Shalev's WhatsApp requests to Richard from Noa's line) are shown
   as items too (source 'whatsapp', from Shalev to Richard). The first comment or status change
   on one turns it into a real item (id 'tn…'); when that item reaches done/closed the note is
   closed in teamnotes.js as well, so the ops brain stops raising it.

   Notifications: the other side gets a Slack line and an in-app notification (notify.js,
   rule 'info'). Never WhatsApp.

   Route  POST /api/team   (admin key / Google session, like every admin route)
     reads  {op:'me'|'list'|'get'|'events', all?, id?}
     writes {action:'create'|'comment'|'status'|'roles'|'attach'|'file-delete', ...}
   26/11 files (teamfiles.js): comment {files:[keys]} (text may then be empty), attach {id, files} (the opener,
   onto the opening message, right after create), file-delete {id, key} (the uploader or an admin; logged).
   ========================================================================== */
import { normEmail, getUser } from './auth.js';
import { rolesOf, isLead, pagesFor, teamList, planRoles, setRoles, PAGE_OF, ROLES, ROLE_HE, cleanRoles } from './roles.js';
import { listNotes, closeNote } from './teamnotes.js';
import { resolveFiles, filesOf, deleteError } from './teamfiles.js';

export const TYPES = { issue: 'באג / תקלה', request: 'בקשת לקוח' };
export const STATUSES = ['open', 'in_progress', 'done', 'closed'];
export const STATUS_HE = { open: 'פתוח', in_progress: 'בטיפול', done: 'בוצע · לבדיקה', closed: 'סגור' };
export const TEAMNOTE_FROM = 'shalevdrix3@gmail.com';
export const TEAMNOTE_TO = 'richardtomskiy@gmail.com';
const IDX = 'teamissueidx';
const KEY = id => 'teamissue:' + id;
const ID_RE = /^(ti[a-z0-9]{8,20}|tn\d{13}[A-Za-z0-9]{1,16})$/;
const NOTE_RE = /^teamnote:\d{13}:[A-Za-z0-9]+$/;
const MAX_IDX = 400, MAX_COMMENTS = 200, CLOSED_TTL = 400 * 86400;
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\r/g, '').trim().slice(0, n);
const pj = v => { try { return JSON.parse(v); } catch { return null; } };

/* ── pure: the flow ─────────────────────────────────────────────────────── */
/* who may move `item` to `to`. → '' when allowed, else the reason */
export function moveError(item, who, to) {
  if (!item) return 'no-item';
  if (!STATUSES.includes(to)) return 'bad-status';
  const from = item.status, me = normEmail(who);
  if (from === to) return 'same-status';
  const assignee = me && me === item.assignee, opener = me && me === item.opener;
  if (to === 'closed') return opener ? '' : 'opener-only';
  if (to === 'open') {
    if (opener && (from === 'done' || from === 'closed' || from === 'in_progress')) return '';
    if (assignee && from === 'in_progress') return '';   /* the assignee can put back what they picked up */
    return opener || assignee ? 'bad-move' : 'not-yours';
  }
  if (to === 'in_progress') return assignee && from === 'open' ? '' : assignee ? 'bad-move' : 'assignee-only';
  if (to === 'done') return assignee && (from === 'open' || from === 'in_progress') ? '' : assignee ? 'bad-move' : 'assignee-only';
  return 'bad-move';
}
export function canView(item, who, roles, all = false) {
  const me = normEmail(who);
  if (!item || !me) return false;
  if (item.opener === me || item.assignee === me) return true;
  return !!all && isLead(roles);
}
export const canComment = (item, who, roles) => canView(item, who, roles, true);
/* the badge: what waits for me (assigned and not finished) + what waits for my check (I opened, it is done) */
export function countsFor(rows, who) {
  const me = normEmail(who); const c = { opened: 0, assigned: 0, to_me: 0, review: 0, badge: 0 };
  for (const r of rows || []) {
    if (r.opener === me && r.status !== 'closed') c.opened++;
    if (r.assignee === me && r.status !== 'closed') c.assigned++;
    if (r.assignee === me && (r.status === 'open' || r.status === 'in_progress')) c.to_me++;
    if (r.opener === me && r.status === 'done' && r.assignee !== me) c.review++;
  }
  c.badge = c.to_me + c.review;
  return c;
}
export const summaryOf = it => ({ id: it.id, type: it.type, title: it.title, opener: it.opener, assignee: it.assignee, status: it.status,
  ev: it.event ? it.event.name || '' : '', n: (it.comments || []).length, created_at: it.created_at, updated_at: it.updated_at,
  source: it.source || '', from_note: it.from_note || '' });
export function newId(now = Date.now()) { return 'ti' + now.toString(36) + [...crypto.getRandomValues(new Uint8Array(4))].map(b => (b % 36).toString(36)).join(''); }
export const noteIssueId = key => 'tn' + String(key).split(':')[1] + String(key).split(':')[2];
/* a team note as an item (read-only until someone acts on it) */
export function noteAsItem(n) {
  const text = clean(n.text, 1200);
  return { id: noteIssueId(n.key), type: 'request', title: (text.split('\n')[0] || 'בקשה מהוואטסאפ').slice(0, 80), text, event: null,
    opener: TEAMNOTE_FROM, assignee: TEAMNOTE_TO, status: n.status === 'done' ? 'closed' : 'open', created_at: n.at || new Date(n.ts).toISOString(),
    updated_at: n.done_at || n.at || new Date(n.ts).toISOString(), comments: n.result ? [{ by: TEAMNOTE_TO, at: n.done_at || n.at, text: n.result }] : [],
    history: [], source: 'whatsapp', from_note: n.key, readonly: true };
}

/* ── KV ─────────────────────────────────────────────────────────────────── */
export async function readIndex(env) { const v = pj(await env.RATE.get(IDX).catch(() => null)); return Array.isArray(v) ? v : []; }
async function writeIndex(env, rows) {
  let out = rows.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (out.length > MAX_IDX) { const keep = out.filter(r => r.status !== 'closed'); out = [...keep, ...out.filter(r => r.status === 'closed')].slice(0, MAX_IDX); }
  await env.RATE.put(IDX, JSON.stringify(out));
  return out;
}
export async function getItem(env, id) { return ID_RE.test(String(id || '')) ? pj(await env.RATE.get(KEY(id)).catch(() => null)) : null; }
async function saveItem(env, it) {
  await env.RATE.put(KEY(it.id), JSON.stringify(it), it.status === 'closed' ? { expirationTtl: CLOSED_TTL } : undefined);
  const rows = (await readIndex(env)).filter(r => r.id !== it.id);
  rows.push(summaryOf(it));
  return writeIndex(env, rows);
}
/* an item by id, or a WhatsApp note's item made up on the spot (not saved) — what an upload is checked against */
export async function loadItem(env, id, now = Date.now()) {
  const it = await getItem(env, id);
  if (it || !/^tn/.test(String(id || ''))) return it;
  return adopt(env, String(id), now);
}
/* the notes from the last 30 days that have not become items yet */
async function noteItems(env, rows, now) {
  const have = new Set(rows.map(r => r.id));
  const notes = await listNotes(env, { days: 30, now }).catch(() => []);
  return notes.map(noteAsItem).filter(it => !have.has(it.id));
}
/* a note's item, made real (first comment / status change). The note itself is not changed here. */
async function adopt(env, id, now) {
  const notes = await listNotes(env, { days: 30, now }).catch(() => []);
  const n = notes.find(x => noteIssueId(x.key) === id);
  if (!n) return null;
  const it = noteAsItem(n); delete it.readonly;
  it.history = [{ at: new Date(now).toISOString(), by: TEAMNOTE_FROM, from: '', to: it.status, note: 'נפתח בוואטסאפ' }];
  return it;
}

/* ── notifications (Slack + in-app; never WhatsApp) ──────────────────────── */
const letters = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => String.fromCharCode(97 + (b % 26))).join('');
export function noticeText(kind, it, actorName, targetName, extra = '') {
  const what = { create: (it.type === 'request' ? 'בקשת לקוח חדשה' : 'באג חדש'), comment: 'תגובה חדשה', status: 'סטטוס: ' + (STATUS_HE[it.status] || it.status) }[kind] || 'עדכון';
  const lines = [`*צוות · ${what}* · ${clean(it.title, 80)}`, '', `מאת ${actorName} אל ${targetName}${it.event && it.event.name ? ' · ' + clean(it.event.name, 60) : ''}`];
  if (extra) lines.push('', '> ' + clean(extra, 300).replace(/\n/g, '\n> '));
  lines.push('', 'לפתוח: https://ishur.io/next/admin.html#team=' + it.id);
  return lines.join('\n');
}
async function notify(env, d, kind, it, actor, extra) {
  const target = actor === it.opener ? it.assignee : it.opener;
  if (!target || target === actor) return { sent: false };
  const [an, tn] = await Promise.all([nameOf(env, actor), nameOf(env, target)]);
  const text = noticeText(kind, it, an, tn, extra);
  const out = { sent: true, to: target, slack: false, app: false };
  if (d && typeof d.slackSend === 'function') { try { await d.slackSend(env, text, { oneoff: true, important: true, key: 'teamissue:' + it.id + ':' + letters(6) }); out.slack = true; } catch {} }
  try {
    const nf = d && d.notifyEvent ? d.notifyEvent : (await import('./notify.js')).notifyEvent;
    const n = await nf(env, null, 'info', { title_he: text.split('\n')[0].replace(/[*]/g, ''), body_he: `אל ${tn}`, entity: 'teamissue:' + it.id, deep_link: '#/overview' });
    out.app = !!n;
  } catch {}
  return out;
}
async function nameOf(env, email) {
  const u = await getUser(env, email).catch(() => null);
  if (u && u.name) return clean(u.name, 40);
  return { [TEAMNOTE_FROM]: 'שלו', [TEAMNOTE_TO]: 'ריצארד' }[email] || String(email || '').split('@')[0];
}

/* ── the route ──────────────────────────────────────────────────────────── */
export async function handleTeam(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!b || typeof b !== 'object' || !d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  const who = normEmail(request.headers.get('x-ishur-user') || '');
  /* reads come as {op}, writes as {action} — the sign-in gate logs a POST with `action` and the admin home batch only takes reads,
     so a write named in `op` (or a read named in `action`) is refused rather than slipping past the action log */
  const READS = ['me', 'list', 'get', 'events'], WRITES = ['create', 'comment', 'status', 'roles', 'attach', 'file-delete'];
  const op = b.action !== undefined ? String(b.action) : String(b.op || 'me');
  if (b.action !== undefined ? !WRITES.includes(op) : !READS.includes(op)) return d.deny(400, 'bad-op', origin);
  const now = d.now ? d.now() : Date.now();
  /* the shared key or an old phone-code session carries no person: the menu hides nothing, the panel stays off */
  if (!who) return op === 'me' ? d.okJson({ ok: true, me: null }, origin) : d.deny(401, 'sign-in-required', origin);
  const roles = await rolesOf(env, who);
  const lead = isLead(roles);
  const all = !!b.all && lead;
  const visible = rows => rows.filter(r => canView(r, who, roles, all));
  const reply = (extra = {}, rows = null) => d.okJson({ ok: true, ...extra, ...(rows ? { counts: countsFor(rows, who) } : {}) }, origin);

  if (op === 'me' || op === 'list') {
    const rows = await readIndex(env);
    const merged = [...rows, ...(await noteItems(env, rows, now)).map(summaryOf).map(s => ({ ...s, readonly: true }))];
    const items = visible(merged).filter(r => r.status !== 'closed' || now - Date.parse(r.updated_at || 0) < 30 * 86400e3);
    if (op === 'list') return reply({ items, all }, merged);
    const user = await getUser(env, who).catch(() => null);
    return reply({ me: { email: who, name: await nameOf(env, who), roles, lead }, pages: pagesFor(roles, user), page_of: PAGE_OF,
      roles_all: ROLES.map(r => ({ id: r, he: ROLE_HE[r] })), team: await teamList(env), types: TYPES, status_he: STATUS_HE, items, all }, merged);
  }
  if (op === 'events') {
    const evs = d.listEvents ? await d.listEvents(env).catch(() => []) : [];
    return reply({ events: evs.slice(0, 400) });
  }
  if (op === 'get') {
    let it = await getItem(env, b.id);
    if (!it && /^tn/.test(String(b.id || ''))) { const n = await adopt(env, String(b.id), now); if (n) it = { ...n, readonly: true }; }
    if (!it || !canView(it, who, roles, true)) return d.deny(404, 'no-item', origin);
    return reply({ item: it });
  }
  if (op === 'create') {
    const type = TYPES[b.type] ? b.type : '';
    const title = clean(b.title, 120), text = clean(b.text, 2000), assignee = normEmail(b.assignee);
    if (!type || title.length < 2 || !assignee) return d.okJson({ ok: false, error: 'bad-input' }, origin);
    const team = await teamList(env);
    if (!team.some(t => t.email === assignee)) return d.okJson({ ok: false, error: 'unknown-assignee' }, origin);
    const ev = b.event && typeof b.event === 'object' ? { t8: clean(b.event.t8, 8).replace(/[^A-Za-z0-9]/g, ''), name: clean(b.event.name, 80), date: clean(b.event.date, 20) } : null;
    const at = new Date(now).toISOString();
    const it = { id: newId(now), type, title, text, event: ev && (ev.t8 || ev.name) ? ev : null, opener: who, assignee, status: 'open',
      created_at: at, updated_at: at, comments: [], history: [{ at, by: who, from: '', to: 'open' }] };
    const rows = await saveItem(env, it);
    const sent = await notify(env, d, 'create', it, who, text);
    return reply({ item: it, notified: sent }, rows);
  }
  if (op === 'attach' || op === 'file-delete') {
    const id = String(b.id || '');
    let it = await getItem(env, id);
    if (!it && /^tn/.test(id) && op === 'attach') it = await adopt(env, id, now);
    if (!it || !canView(it, who, roles, true)) return d.deny(404, 'no-item', origin);
    const at = new Date(now).toISOString();
    if (op === 'attach') {
      if (normEmail(it.opener) !== who) return d.deny(403, 'opener-only', origin);
      const r = await resolveFiles(env, it, who, b.files);
      if (r.error) return d.okJson({ ok: false, error: r.error }, origin);
      if (!r.files.length) return d.okJson({ ok: false, error: 'empty' }, origin);
      it.files = [...(it.files || []), ...r.files];
    } else {
      const hit = filesOf(it).find(x => x.f.key && x.f.key === String(b.key || ''));
      const err = deleteError(hit && hit.f, who, roles);
      if (err) return d.okJson({ ok: false, error: err }, origin);
      const f = hit.f;
      if (env.AUDIT_R2) await env.AUDIT_R2.delete(f.key).catch(() => {});
      hit.list[hit.i] = { key: '', name: f.name, kind: f.kind, size: 0, by: f.by, at: f.at, deleted: true, del_by: who, del_at: at };
      it.history = [...(it.history || []), { at, by: who, from: it.status, to: it.status, file: 'deleted', note: 'קובץ נמחק: ' + clean(f.name, 100) }].slice(-100);
      if (d.logEvent) await d.logEvent(env, { area: 'צוות', action: 'קובץ נמחק ממשימה', ok: true, detail: `${it.id} · ${clean(f.name, 100)} · הועלה ע"י ${f.by} · נמחק ע"י ${who}` }).catch(() => {});
    }
    it.updated_at = at;
    const rows = await saveItem(env, it);
    return reply({ item: it }, rows);
  }
  if (op === 'comment' || op === 'status') {
    const id = String(b.id || '');
    let it = await getItem(env, id);
    if (!it && /^tn/.test(id)) it = await adopt(env, id, now);
    if (!it || !canView(it, who, roles, true)) return d.deny(404, 'no-item', origin);
    const at = new Date(now).toISOString();
    let extra = '';
    if (op === 'comment') {
      const text = clean(b.text, 2000);
      if (!canComment(it, who, roles)) return d.deny(403, 'not-yours', origin);
      const r = await resolveFiles(env, it, who, b.files);
      if (r.error) return d.okJson({ ok: false, error: r.error }, origin);
      if (!text && !r.files.length) return d.okJson({ ok: false, error: 'empty' }, origin);
      it.comments = [...(it.comments || []), { by: who, at, text, ...(r.files.length ? { files: r.files } : {}) }].slice(-MAX_COMMENTS);
      extra = [text, r.files.length ? `${r.files.length === 1 ? 'קובץ מצורף: ' + clean(r.files[0].name, 80) : r.files.length + ' קבצים מצורפים'}` : ''].filter(Boolean).join('\n');
    } else {
      const to = String(b.to || ''); const err = moveError(it, who, to);
      if (err) return d.okJson({ ok: false, error: err, item: it }, origin);
      const rf = await resolveFiles(env, it, who, b.files);
      if (rf.error) return d.okJson({ ok: false, error: rf.error }, origin);
      it.history = [...(it.history || []), { at, by: who, from: it.status, to }].slice(-100);
      it.status = to;
      const t = clean(b.text, 2000);
      if (t || rf.files.length) { it.comments = [...(it.comments || []), { by: who, at, text: t, ...(rf.files.length ? { files: rf.files } : {}) }].slice(-MAX_COMMENTS); extra = t || `${rf.files.length} קבצים מצורפים`; }
      if (it.from_note && (to === 'done' || to === 'closed') && NOTE_RE.test(it.from_note)) await closeNote(env, it.from_note, 'בוצע בפאנל הצוות').catch(() => false);
    }
    it.updated_at = at;
    const rows = await saveItem(env, it);
    const sent = await notify(env, d, op, it, who, extra);
    return reply({ item: it, notified: sent }, rows);
  }
  if (op === 'roles') {
    const plan = planRoles(who, roles, b.email, b.roles);
    if (!plan.ok) return d.okJson({ ok: false, error: plan.error }, origin);
    await setRoles(env, who, plan.email, plan.roles);
    return reply({ email: plan.email, roles: cleanRoles(plan.roles), team: (await teamList(env)).map(t => (t.email === plan.email ? { ...t, roles: plan.roles } : t)) });
  }
  return d.deny(400, 'bad-op', origin);
}
