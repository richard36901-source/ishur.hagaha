// node --test worker/test/teamfiles.test.mjs — 26/11 files on team items (teamfiles.js, /api/team-upload, /api/team-file, /api/team attach|comment|file-delete)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { handleTeam, loadItem, canComment } from '../teamissues.js';
import { handleTeamUpload, handleTeamFile, typeOf, safeName, keyOk, MAX_BYTES, deleteError } from '../teamfiles.js';
import { createSession } from '../auth.js';

const R = 'richardtomskiy@gmail.com', S = 'shalevdrix3@gmail.com', X = 'agent@example.com', Y = 'other@example.com';
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
/* a fake R2: what the Worker uses (put / head / get / delete) */
function r2() {
  const m = new Map(), ops = { put: 0, head: 0, get: 0, delete: 0 };
  const obj = (k, v) => ({ key: k, size: v.buf.byteLength, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata });
  return { m, ops,
    put: async (k, val, o = {}) => { ops.put++; const buf = val instanceof ArrayBuffer ? new Uint8Array(val) : new TextEncoder().encode(String(val)); m.set(k, { buf, httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {} }); return obj(k, m.get(k)); },
    head: async k => { ops.head++; return m.has(k) ? obj(k, m.get(k)) : null; },
    get: async k => { ops.get++; return m.has(k) ? { ...obj(k, m.get(k)), body: m.get(k).buf } : null; },
    delete: async k => { ops.delete++; m.delete(k); } };
}
const users = () => ({
  ['user:' + R]: JSON.stringify({ email: R, name: 'ריצארד', role: 'owner', pages: 'all', layers: 'all', active: true }),
  ['user:' + S]: JSON.stringify({ email: S, name: 'שלו', role: 'staff', pages: 'all', layers: 'all', active: true }),
  ['user:' + X]: JSON.stringify({ email: X, name: 'נציגה', role: 'staff', pages: ['sales'], layers: [], active: true }),
  ['user:' + Y]: JSON.stringify({ email: Y, name: 'אחר', role: 'staff', pages: [], layers: [], active: true }),
});
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const mkD = (log = []) => ({ okJson: o => json(o), deny: (s, e) => json({ ok: false, error: e }, s), isAdmin: (_e, k) => k === 'k', cors: () => ({ 'Access-Control-Allow-Origin': 'https://ishur.io' }),
  slackSend: async () => {}, notifyEvent: async () => ({ id: 'n1' }), logEvent: async (_e, row) => { log.push(row); }, listEvents: async () => [],
  loadItem, canComment });
const team = async (env, who, body, d = mkD()) => { const r = await handleTeam(new Request('https://x/api/team', { method: 'POST', headers: { 'x-ishur-user': who }, body: JSON.stringify({ admin_key: 'k', ...body }) }), env, '', d); return { status: r.status, ...(await r.json()) }; };
const upload = async (env, who, id, name, bytes, extra = {}) => {
  const body = typeof bytes === 'number' ? new Uint8Array(bytes).fill(65) : bytes;
  const h = { 'x-admin-key': extra.key === undefined ? 'k' : extra.key, 'Content-Type': 'application/octet-stream', ...(who ? { 'x-ishur-user': who } : {}), ...(extra.headers || {}) };
  const r = await handleTeamUpload(new Request(`https://x/api/team-upload?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}${extra.hint ? '&hint=' + extra.hint : ''}`, { method: 'POST', headers: h, body }), env, '', mkD());
  return { status: r.status, ...(await r.json()) };
};
const fetchFile = (env, who, key, q = '') => handleTeamFile(new Request(`https://x/api/team-file?k=${encodeURIComponent(key)}${q}`, { headers: { 'x-admin-key': 'k', ...(who ? { 'x-ishur-user': who } : {}) } }), env, '', mkD());
async function setup() {
  const env = { ADMIN_KEY: 'k', RATE: kv(users()), AUDIT_R2: r2() };
  const c = await team(env, S, { action: 'create', type: 'issue', title: 'הלוח לא נטען', assignee: X });
  assert.equal(c.ok, true);
  return { env, id: c.item.id };
}

/* ── pure ──────────────────────────────────────────────────────────────── */
test('types: allow-list by extension, the client type is not trusted; svg/html/exe refused; webm audio by hint', () => {
  assert.deepEqual(typeOf('צילום מסך.PNG'), { mime: 'image/png', kind: 'image' });
  assert.deepEqual(typeOf('a.xlsx').kind, 'excel'); assert.equal(typeOf('a.xls').kind, 'excel'); assert.equal(typeOf('a.csv').mime, 'text/csv');
  assert.equal(typeOf('rec.m4a').kind, 'audio'); assert.equal(typeOf('clip.mov').kind, 'video'); assert.equal(typeOf('a.pdf').kind, 'pdf');
  assert.equal(typeOf('a.heic').kind, 'image'); assert.equal(typeOf('a.docx').kind, 'doc'); assert.equal(typeOf('a.zip').kind, 'zip'); assert.equal(typeOf('a.txt').kind, 'text');
  assert.deepEqual(typeOf('voice.webm', 'audio/webm'), { mime: 'audio/webm', kind: 'audio' });
  assert.equal(typeOf('screen.webm', 'video/webm').kind, 'video');
  for (const bad of ['x.svg', 'x.html', 'x.htm', 'x.exe', 'x.js', 'noext', '']) assert.equal(typeOf(bad), null, bad);
  assert.equal(safeName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(safeName('C:\\Users\\a\\רשימת אורחים "סופית".xlsx'), 'רשימת_אורחים_סופית.xlsx');
  const long = safeName('א'.repeat(200) + '.pdf'); assert.ok(long.length <= 80 && long.endsWith('.pdf'));
  assert.equal(keyOk('team/tiabc12345/fabc123456-a.png'), true);
  assert.equal(keyOk('rec/call_123'), false, 'the recordings are not reachable through the team route');
  assert.equal(keyOk('team/tiabc12345/../../rec/x'), false);
});
test('delete rights: the uploader or an admin role; nobody else', () => {
  const f = { key: 'k', by: S };
  assert.equal(deleteError(f, S, ['sales']), '');
  assert.equal(deleteError(f, X, ['staff']), 'not-yours');
  assert.equal(deleteError(f, X, ['dev']), 'not-yours', 'dev without admin cannot delete another person\'s file');
  assert.equal(deleteError(f, R, ['dev', 'admin']), '');
  assert.equal(deleteError({ ...f, deleted: true }, S, ['admin']), 'no-file');
});

/* ── upload ────────────────────────────────────────────────────────────── */
test('upload: needs a person and the key; size and type checked; only the item\'s people (or a lead) may upload', async () => {
  const { env, id } = await setup();
  assert.equal((await upload(env, '', id, 'a.png', 10)).status, 401, 'the shared key alone carries no person');
  assert.equal((await upload(env, S, id, 'a.png', 10, { key: 'nope' })).status, 403);
  const big = await upload(env, S, id, 'big.mp4', 10, { headers: { 'Content-Length': String(MAX_BYTES + 1) } });
  assert.equal(big.status, 413); assert.equal(big.error, 'too-big'); assert.match(big.he, /25MB/);
  const big2 = await upload(env, S, id, 'big.mp4', MAX_BYTES + 1);
  assert.equal(big2.status, 413, 'the real byte count is checked, not only the header');
  const svg = await upload(env, S, id, 'x.svg', 10);
  assert.equal(svg.status, 415); assert.equal(svg.error, 'bad-type'); assert.ok(svg.he);
  assert.equal((await upload(env, S, id, 'x.html', 10)).status, 415);
  assert.equal((await upload(env, S, id, 'empty.png', new Uint8Array(0))).status, 400);
  assert.equal((await upload(env, S, 'tizzzzzzzzzz', 'a.png', 10)).status, 404);
  assert.equal((await upload(env, Y, id, 'a.png', 10)).status, 403, 'not the opener, not the assignee, not a lead');
  assert.equal(env.AUDIT_R2.m.size, 0, 'nothing refused was stored');
  const ok = await upload(env, X, id, 'צילום מסך 2026-11-26.png', 1234);
  assert.equal(ok.ok, true);
  assert.match(ok.file.key, new RegExp('^team/' + id + '/f[a-z0-9]+-צילום_מסך_2026-11-26\\.png$'));
  assert.deepEqual([ok.file.name, ok.file.type, ok.file.kind, ok.file.size, ok.file.by], ['צילום_מסך_2026-11-26.png', 'image/png', 'image', 1234, X]);
  const stored = env.AUDIT_R2.m.get(ok.file.key);
  assert.deepEqual([stored.customMetadata.by, stored.customMetadata.opener, stored.customMetadata.assignee], [X, S, X]);
  assert.equal(stored.httpMetadata.contentType, 'image/png');
  assert.equal(JSON.parse(env.RATE.m.get('teamissue:' + id)).files, undefined, 'an upload never writes the item record');
  assert.equal((await upload(env, R, id, 'lead.pdf', 5)).ok, true, 'a lead may add to any item, as on /api/team');
});

/* ── attach / comment ──────────────────────────────────────────────────── */
test('comment with files: R2 decides the metadata; a file-only comment is fine; foreign or reused keys refused', async () => {
  const { env, id } = await setup();
  const a = await upload(env, X, id, 'shot.png', 300), b = await upload(env, X, id, 'list.xlsx', 900), s1 = await upload(env, S, id, 'mine.pdf', 50);
  const c = await team(env, X, { action: 'comment', id, text: '', files: [a.file.key, b.file.key] });
  assert.equal(c.ok, true);
  const last = c.item.comments.at(-1);
  assert.equal(last.text, '');
  assert.deepEqual(last.files.map(f => [f.name, f.kind, f.size, f.by]), [['shot.png', 'image', 300, X], ['list.xlsx', 'excel', 900, X]]);
  assert.equal((await team(env, X, { action: 'comment', id, files: [a.file.key] })).error, 'bad-file', 'a key already attached');
  assert.equal((await team(env, X, { action: 'comment', id, files: [s1.file.key] })).error, 'bad-file', 'someone else\'s upload');
  assert.equal((await team(env, X, { action: 'comment', id, files: ['team/' + id + '/fzzzzzzzzzz-nothere.png'] })).error, 'bad-file', 'not in R2');
  const other = await team(env, S, { action: 'create', type: 'request', title: 'אחר', assignee: X });
  const o1 = await upload(env, X, other.item.id, 'o.png', 5);
  assert.equal((await team(env, X, { action: 'comment', id, files: [o1.file.key] })).error, 'bad-file', 'a key from another item');
  assert.equal((await team(env, X, { action: 'comment', id, text: '' })).error, 'empty');
  assert.equal((await team(env, X, { action: 'comment', id, files: new Array(11).fill(0).map((_, i) => 'team/' + id + '/fzzzzzzzzz' + i + '-a.png') })).error, 'too-many');
});
test('attach: the opener puts files on the opening message (create first, upload, attach); nobody else', async () => {
  const { env, id } = await setup();
  const f = await upload(env, S, id, 'הקלטה.m4a', 4000);
  const g = await upload(env, X, id, 'x.png', 10);
  assert.equal((await team(env, X, { action: 'attach', id, files: [g.file.key] })).status, 403, 'the assignee does not edit the opening message');
  const a = await team(env, S, { action: 'attach', id, files: [f.file.key] });
  assert.equal(a.ok, true);
  assert.deepEqual(a.item.files.map(x => [x.name, x.kind, x.type]), [['הקלטה.m4a', 'audio', 'audio/mp4']]);
  assert.equal((await team(env, S, { action: 'attach', id, files: [] })).error, 'empty');
  assert.equal((await team(env, Y, { action: 'attach', id, files: [f.file.key] })).status, 404, 'an outsider cannot see the item');
});

/* ── serve ─────────────────────────────────────────────────────────────── */
test('serve: the item\'s people and leads get the bytes with the right type; outsiders get 404; nothing public', async () => {
  const { env, id } = await setup();
  const f = await upload(env, X, id, 'shot.png', 321), x = await upload(env, X, id, 'list.xlsx', 77), p = await upload(env, X, id, 'doc.pdf', 10);
  for (const who of [X, S, R]) {
    const r = await fetchFile(env, who, f.file.key);
    assert.equal(r.status, 200, who);
    assert.equal(r.headers.get('Content-Type'), 'image/png');
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(r.headers.get('Content-Security-Policy'), /sandbox/);
    assert.match(r.headers.get('Content-Disposition'), /^inline; filename\*=UTF-8''shot\.png$/);
    assert.equal((await r.arrayBuffer()).byteLength, 321);
  }
  assert.equal((await fetchFile(env, Y, f.file.key)).status, 404, 'an outsider (not uploader/opener/assignee, not a lead)');
  assert.equal((await fetchFile(env, '', f.file.key)).status, 401);
  assert.equal((await fetchFile(env, S, 'rec/call_abcdef')).status, 404, 'only team/ keys');
  const xr = await fetchFile(env, S, x.file.key);
  assert.match(xr.headers.get('Content-Disposition'), /^attachment;/); assert.equal(xr.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match((await fetchFile(env, S, f.file.key, '&dl=1')).headers.get('Content-Disposition'), /^attachment;/);
  const pr = await fetchFile(env, S, p.file.key);
  assert.equal(pr.headers.get('Content-Type'), 'application/pdf'); assert.equal(pr.headers.get('Content-Security-Policy'), null, 'the PDF viewer must run');
});
test('serve: no KV read of the item per file (the rights come from the object\'s own metadata)', async () => {
  const { env, id } = await setup();
  const f = await upload(env, X, id, 'shot.png', 10);
  const reads = []; const g = env.RATE.get; env.RATE.get = async k => { reads.push(k); return g(k); };
  assert.equal((await fetchFile(env, S, f.file.key)).status, 200);
  assert.deepEqual(reads, [], 'the opener reads a file with zero KV reads');
});

/* ── delete ────────────────────────────────────────────────────────────── */
test('delete: the uploader or an admin; R2 object removed, a trace kept in the thread and the history, logged', async () => {
  const { env, id } = await setup();
  const f1 = await upload(env, S, id, 'a.png', 10), f2 = await upload(env, S, id, 'b.png', 10);
  await team(env, S, { action: 'comment', id, text: 'שני צילומים', files: [f1.file.key, f2.file.key] });
  const log = [];
  const no = await team(env, X, { action: 'file-delete', id, key: f1.file.key }, mkD(log));
  assert.equal(no.error, 'not-yours', 'the assignee did not upload it and is not an admin');
  assert.ok(env.AUDIT_R2.m.has(f1.file.key));
  const own = await team(env, S, { action: 'file-delete', id, key: f1.file.key }, mkD(log));
  assert.equal(own.ok, true);
  assert.equal(env.AUDIT_R2.m.has(f1.file.key), false);
  const c = own.item.comments.at(-1);
  assert.deepEqual([c.files[0].deleted, c.files[0].key, c.files[0].del_by, c.files[0].name], [true, '', S, 'a.png']);
  assert.equal(c.files[1].key, f2.file.key, 'the other file stays');
  assert.equal(own.item.history.at(-1).file, 'deleted'); assert.match(own.item.history.at(-1).note, /a\.png/);
  assert.equal(log.length, 1); assert.match(log[0].detail, /a\.png/);
  assert.equal((await team(env, S, { action: 'file-delete', id, key: f1.file.key })).error, 'no-file', 'twice');
  /* X uploads, R (admin) removes it */
  const f3 = await upload(env, X, id, 'c.csv', 10); await team(env, X, { action: 'comment', id, files: [f3.file.key] });
  assert.equal((await team(env, R, { action: 'file-delete', id, key: f3.file.key })).ok, true, 'an admin may delete anyone\'s file');
  assert.equal((await fetchFile(env, X, f3.file.key)).status, 404);
});

/* ── wired in the Worker ───────────────────────────────────────────────── */
test('wired: a Google session uploads raw bytes, comments with the key and reads the file back; the shared key alone cannot', async () => {
  const env = { ADMIN_KEY: 'k', RATE: kv(users()), AUDIT_R2: r2() };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const tok = await createSession(env, S);
  const api = body => worker.fetch(new Request('https://go.ishur.io/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify({ session: tok, ...body }) }), env, ctx).then(r => r.json());
  const c = await api({ action: 'create', type: 'issue', title: 'צילום מסך', assignee: R });
  assert.equal(c.ok, true);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const up = await worker.fetch(new Request(`https://go.ishur.io/api/team-upload?id=${c.item.id}&name=${encodeURIComponent('מסך.png')}`, { method: 'POST', headers: { 'x-ishur-session': tok, 'Content-Type': 'application/octet-stream', Origin: 'https://ishur.io' }, body: bytes }), env, ctx);
  assert.equal(up.status, 200);
  const uj = await up.json();
  assert.equal(uj.ok, true); assert.equal(uj.file.by, S);
  const at = await api({ action: 'attach', id: c.item.id, files: [uj.file.key] });
  assert.equal(at.ok, true); assert.equal(at.item.files[0].name, 'מסך.png');
  const got = await worker.fetch(new Request('https://go.ishur.io/api/team-file?k=' + encodeURIComponent(uj.file.key), { headers: { 'x-ishur-session': tok, Origin: 'https://ishur.io' } }), env, ctx);
  assert.equal(got.status, 200);
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [...bytes]);
  assert.equal(got.headers.get('Content-Type'), 'image/png');
  const shared = await worker.fetch(new Request('https://go.ishur.io/api/team-file?k=' + encodeURIComponent(uj.file.key), { headers: { 'X-Admin-Key': 'k' } }), env, ctx);
  assert.equal(shared.status, 401, 'the shared key carries no person');
  const spoof = await worker.fetch(new Request('https://go.ishur.io/api/team-file?k=' + encodeURIComponent(uj.file.key), { headers: { 'X-Admin-Key': 'k', 'x-ishur-user': S } }), env, ctx);
  assert.equal(spoof.status, 401, 'a client cannot name itself with the header');
  const anon = await worker.fetch(new Request('https://go.ishur.io/api/team-file?k=' + encodeURIComponent(uj.file.key)), env, ctx);
  assert.equal(anon.status, 403);
  assert.ok([...env.RATE.m.keys()].some(k => k.startsWith('act:')), 'the upload and the writes are in her action log');
});
test('status with files: "בוצע" with a screenshot keeps the file on the comment; a bad key refuses the move', async () => {
  const { env, id } = await setup();
  const f = await upload(env, X, id, 'fixed.png', 20);
  const bad = await team(env, X, { action: 'status', id, to: 'done', files: ['team/' + id + '/fzzzzzzzzzz-x.png'] });
  assert.equal(bad.error, 'bad-file');
  assert.equal(JSON.parse(env.RATE.m.get('teamissue:' + id)).status, 'open', 'nothing moved');
  const ok = await team(env, X, { action: 'status', id, to: 'done', text: '', files: [f.file.key] });
  assert.equal(ok.ok, true); assert.equal(ok.item.status, 'done');
  assert.deepEqual(ok.item.comments.at(-1).files.map(x => x.name), ['fixed.png']);
  const r = await fetchFile(env, S, f.file.key);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store', 'the browser cache is keyed by URL, not by person');
});
