/* ============================================================================
   ishur.io · teamfiles.js · files on the team's work items (Richard 26/11/2026)
   ----------------------------------------------------------------------------
   "לאפשר במשימות להוסיף קבצים וצילומי מסך, שיוצגו שם ולא רק להורדה"

   A file is uploaded against an item that exists (the panel creates the item first),
   then ONE write on /api/team attaches the uploaded keys to the opening message
   ({action:'attach'}) or to a new comment ({action:'comment', files}). The upload
   itself never touches the item record (parallel uploads would overwrite each other).

   R2 (binding AUDIT_R2, the bucket that already keeps call recordings), never public:
       team/<itemId>/<fid>-<safe name>
       customMetadata {by, opener, assignee, name (URI-encoded), kind, at}
   Metadata shown in the thread lives on the item record (teamissue:<id>):
       {key, name, type, kind, size, by, at}   on it.files[] and on comments[].files[]
   so the thread costs no extra KV read per attachment.

   Routes (both need a Google session — the x-ishur-session header; the sign-in gate turns it
   into x-ishur-user + the admin key; the shared key alone carries no person and is refused):
     POST /api/team-upload?id=<itemId>&name=<file name>[&hint=audio]   raw file bytes as the body
          → {ok, file:{key,name,type,kind,size,by,at}} | {ok:false, error}   (413 too-big, 415 bad-type)
     GET  /api/team-file?k=<key>[&dl=1]   streams the file with its own content type
          who may read: the uploader, the item's opener or assignee (from the object's metadata,
          no item read), else a lead (admin/dev), as on /api/team.
   Both are hooked in index.js BEFORE the generic /api POST block, which clones and parses
   every body as JSON (25MB of a video through that would be wasted work).
   ========================================================================== */
import { normEmail } from './auth.js';
import { rolesOf, isLead } from './roles.js';

export const MAX_BYTES = 25 * 1024 * 1024;   /* per file; the Worker accepts 100MB bodies, the isolate has 128MB */
export const MAX_FILES_PER_MESSAGE = 10;
export const MAX_FILES_PER_ITEM = 120;
export const PREFIX = 'team/';
/* extension → canonical type + how the panel shows it. The client's own type is never trusted; svg/html are not here. */
export const FILE_TYPES = {
  jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'], png: ['image/png', 'image'], webp: ['image/webp', 'image'], gif: ['image/gif', 'image'],
  heic: ['image/heic', 'image'], heif: ['image/heif', 'image'],
  mp3: ['audio/mpeg', 'audio'], m4a: ['audio/mp4', 'audio'], wav: ['audio/wav', 'audio'], ogg: ['audio/ogg', 'audio'], oga: ['audio/ogg', 'audio'], opus: ['audio/ogg', 'audio'],
  webm: ['video/webm', 'video'], mp4: ['video/mp4', 'video'], m4v: ['video/mp4', 'video'], mov: ['video/quicktime', 'video'],
  pdf: ['application/pdf', 'pdf'],
  csv: ['text/csv', 'csv'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'excel'], xls: ['application/vnd.ms-excel', 'excel'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc'], doc: ['application/msword', 'doc'],
  txt: ['text/plain', 'text'],
  zip: ['application/zip', 'zip'],
};
/* what the browser may render in place; everything else downloads */
const INLINE = new Set(['image', 'audio', 'video', 'pdf', 'csv', 'text']);
export const ERR_HE = {
  'too-big': 'הקובץ גדול מדי — עד 25MB לקובץ.',
  'bad-type': 'סוג הקובץ לא נתמך. אפשר: תמונות, הקלטות, וידאו, PDF, CSV, Excel, Word, טקסט ו-ZIP.',
  'empty': 'הקובץ ריק.',
  'no-item': 'המשימה לא נמצאה.',
  'not-yours': 'אין לך הרשאה לקובץ הזה.',
  'too-many': 'יותר מדי קבצים בהודעה אחת (עד 10).',
};
const KEY_RE = /^team\/(ti[a-z0-9]{8,20}|tn\d{13}[A-Za-z0-9]{1,16})\/f[a-z0-9]{8,24}-[^/\u0000-\u001f]{1,100}$/;

export const extOf = name => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '').trim()); return m ? m[1].toLowerCase() : ''; };
/* name → {mime, kind} | null. A .webm the browser called audio/* is a voice recording, else a screen video */
export function typeOf(name, hint = '') {
  const e = extOf(name), t = FILE_TYPES[e];
  if (!t) return null;
  if (e === 'webm' && /^audio/.test(String(hint || ''))) return { mime: 'audio/webm', kind: 'audio' };
  return { mime: t[0], kind: t[1] };
}
/* a name safe for a key and a header: no folders, no control chars, Hebrew kept, ≤ 80 chars, the extension kept */
export function safeName(name) {
  let n = String(name || '').replace(/^.*[\\/]/, '').normalize('NFC').replace(/[\u0000-\u001f\u007f"<>|*?:\\/]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').trim();
  const e = extOf(n);
  if (n.length > 80) n = n.slice(0, 80 - (e.length + 1)) + '.' + e;
  return n || ('file.' + (e || 'bin'));
}
export const fileId = (now = Date.now()) => 'f' + now.toString(36) + [...crypto.getRandomValues(new Uint8Array(6))].map(b => (b % 36).toString(36)).join('');
export const keyOk = k => KEY_RE.test(String(k || ''));
export const itemOfKey = k => (keyOk(k) ? String(k).split('/')[1] : '');
const meta = (o, key) => ({ key, name: decodeURIComponent(String((o.customMetadata || {}).name || '')) || key.split('/').pop().replace(/^f[a-z0-9]+-/, ''),
  type: (typeOf(key, (o.customMetadata || {}).kind === 'audio' ? 'audio' : '') || {}).mime || 'application/octet-stream',
  kind: (o.customMetadata || {}).kind || (typeOf(key) || {}).kind || 'file', size: Number(o.size) || 0, by: (o.customMetadata || {}).by || '', at: (o.customMetadata || {}).at || '' });

/* every file on an item, with where it sits: [{f, list, i, ci}] (ci = comment index, -1 = the opening message) */
export function filesOf(it) {
  const out = [];
  (it && Array.isArray(it.files) ? it.files : []).forEach((f, i) => out.push({ f, list: it.files, i, ci: -1 }));
  ((it && it.comments) || []).forEach((c, ci) => (Array.isArray(c.files) ? c.files : []).forEach((f, i) => out.push({ f, list: c.files, i, ci })));
  return out;
}
/* who may delete: the one who uploaded it, or an admin (role, not the shared key) */
export function deleteError(f, who, roles) {
  if (!f || f.deleted) return 'no-file';
  const me = normEmail(who);
  if (me && f.by === me) return '';
  return (roles || []).includes('admin') ? '' : 'not-yours';
}
/* the uploaded keys → the metadata to store, checked against R2 (never the client's word).
   → {files} | {error}. Every key must be under this item, uploaded by `who`, and not attached already. */
export async function resolveFiles(env, it, who, keys) {
  const list = [...new Set((Array.isArray(keys) ? keys : []).map(String))];
  if (!list.length) return { files: [] };
  if (list.length > MAX_FILES_PER_MESSAGE) return { error: 'too-many' };
  if (!env.AUDIT_R2) return { error: 'no-bucket' };
  const have = new Set(filesOf(it).map(x => x.f.key));
  if (filesOf(it).length + list.length > MAX_FILES_PER_ITEM) return { error: 'too-many' };
  const out = [];
  for (const k of list) {
    if (!keyOk(k) || itemOfKey(k) !== it.id || have.has(k)) return { error: 'bad-file' };
    const o = await env.AUDIT_R2.head(k).catch(() => null);
    if (!o || !o.customMetadata || o.customMetadata.by !== normEmail(who)) return { error: 'bad-file' };
    out.push(meta(o, k));
  }
  return { files: out };
}

/* ── POST /api/team-upload ───────────────────────────────────────────────── */
/* d: {okJson, deny, isAdmin, loadItem(env,id,now) → item|null, canComment(item,who,roles), now?} */
export async function handleTeamUpload(request, env, origin, d) {
  const url = new URL(request.url);
  const who = normEmail(request.headers.get('x-ishur-user') || '');
  if (!d.isAdmin(env, request.headers.get('x-admin-key') || '')) return d.deny(403, 'bad-admin-key', origin);
  if (!who) return d.deny(401, 'sign-in-required', origin);
  if (!env.AUDIT_R2 || !env.RATE) return d.deny(503, 'no-bucket', origin);
  const fail = (status, error) => new Response(JSON.stringify({ ok: false, error, he: ERR_HE[error] || 'הקובץ לא עלה, נסו שוב.' }), { status, headers: { 'Content-Type': 'application/json', ...(d.cors ? d.cors(origin) : {}) } });
  const len = Number(request.headers.get('Content-Length') || NaN);
  if (Number.isFinite(len) && len > MAX_BYTES) return fail(413, 'too-big');
  const rawName = String(url.searchParams.get('name') || '');
  const t = typeOf(rawName, url.searchParams.get('hint') || '');
  if (!t) return fail(415, 'bad-type');
  const now = d.now ? d.now() : Date.now();
  const it = await d.loadItem(env, String(url.searchParams.get('id') || ''), now);
  if (!it) return fail(404, 'no-item');
  const roles = await rolesOf(env, who);
  if (!d.canComment(it, who, roles)) return fail(403, 'not-yours');
  /* buffered, not streamed: R2 needs a known length, and the byte count is checked for real here
     (a missing or wrong Content-Length must not let 100MB in). The panel uploads two at a time. */
  let buf; try { buf = await request.arrayBuffer(); } catch { return fail(400, 'empty'); }
  if (!buf || !buf.byteLength) return fail(400, 'empty');
  if (buf.byteLength > MAX_BYTES) return fail(413, 'too-big');
  const name = safeName(rawName), at = new Date(now).toISOString();
  const key = PREFIX + it.id + '/' + fileId(now) + '-' + name;
  const cm = { by: who, opener: normEmail(it.opener), assignee: normEmail(it.assignee), name: encodeURIComponent(name), kind: t.kind, at };
  await env.AUDIT_R2.put(key, buf, { httpMetadata: { contentType: t.mime }, customMetadata: cm });
  return d.okJson({ ok: true, file: { key, name, type: t.mime, kind: t.kind, size: buf.byteLength, by: who, at } }, origin);
}

/* ── GET /api/team-file?k= ───────────────────────────────────────────────── */
export async function handleTeamFile(request, env, origin, d) {
  const url = new URL(request.url);
  const who = normEmail(request.headers.get('x-ishur-user') || '');
  if (!d.isAdmin(env, request.headers.get('x-admin-key') || '')) return d.deny(403, 'bad-admin-key', origin);
  if (!who) return d.deny(401, 'sign-in-required', origin);
  if (!env.AUDIT_R2) return d.deny(503, 'no-bucket', origin);
  const key = String(url.searchParams.get('k') || '');
  if (!keyOk(key)) return d.deny(404, 'no-file', origin);
  const o = await env.AUDIT_R2.get(key).catch(() => null);
  if (!o) return d.deny(404, 'no-file', origin);
  const cm = o.customMetadata || {};
  const mine = [cm.by, cm.opener, cm.assignee].includes(who);
  if (!mine && !isLead(await rolesOf(env, who))) { try { if (o.body && o.body.cancel) await o.body.cancel(); } catch {} return d.deny(404, 'no-file', origin); }
  const m = meta(o, key);
  const inline = INLINE.has(m.kind) && url.searchParams.get('dl') !== '1';
  const h = { ...(d.cors ? d.cors(origin) : {}), 'Content-Type': m.type, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.name)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (m.kind !== 'pdf') h['Content-Security-Policy'] = "default-src 'none'; sandbox";
  if (o.size) h['Content-Length'] = String(o.size);
  return new Response(o.body, { status: 200, headers: h });
}
