// node --test worker/test/teamissues.test.mjs — 25/11 team roles + the team issues panel (roles.js, teamissues.js, POST /api/team)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { homeReadOk } from '../index.js';
import { rolesOf, pagesFor, canOpen, pageIdOf, fallbackRoles, planRoles, isLead, DEFAULT_ROLES, PAGE_OF, ROLE_PAGES } from '../roles.js';
import { moveError, canView, countsFor, handleTeam, noteIssueId, noticeText, TEAMNOTE_FROM, TEAMNOTE_TO } from '../teamissues.js';
import { PAGES, createSession } from '../auth.js';
import { saveNote, listNotes } from '../teamnotes.js';

const R = 'richardtomskiy@gmail.com', S = 'shalevdrix3@gmail.com', X = 'agent@example.com', Y = 'other@example.com';
const ALL = PAGES.map(p => p.id);
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
const users = () => ({
  ['user:' + R]: JSON.stringify({ email: R, name: 'ריצארד', role: 'owner', pages: 'all', layers: 'all', active: true }),
  ['user:' + S]: JSON.stringify({ email: S, name: 'שלו', role: 'staff', pages: 'all', layers: 'all', active: true }),
  ['user:' + X]: JSON.stringify({ email: X, name: 'נציגה', role: 'staff', pages: ['sales'], layers: [], active: true }),
  ['user:' + Y]: JSON.stringify({ email: Y, name: 'אחר', role: 'staff', pages: [], layers: [], active: true }),
});
const mkD = (sent = []) => ({
  okJson: (o, _origin) => new Response(JSON.stringify(o), { status: 200 }), deny: (s, e) => new Response(JSON.stringify({ ok: false, error: e }), { status: s }),
  isAdmin: (_env, k) => k === 'k', slackSend: async (_env, text, opts) => { sent.push({ text, opts }); },
  notifyEvent: async () => ({ id: 'n1' }), listEvents: async () => [{ t8: 'abcd1234', name: 'החתונה של דנה', date: '2026-12-01' }],
});
const call = async (env, who, body, d = mkD()) => {
  const r = await handleTeam(new Request('https://x/api/team', { method: 'POST', headers: who ? { 'x-ishur-user': who } : {}, body: JSON.stringify({ admin_key: 'k', ...body }) }), env, '', d);
  return { status: r.status, ...(await r.json()) };
};

/* ── roles ─────────────────────────────────────────────────────────────── */
test('roles: Richard = dev+admin, Shalev = sales+admin+client_comms, and both open every page', async () => {
  const env = { RATE: kv(users()) };
  assert.deepEqual(await rolesOf(env, R), ['dev', 'admin']);
  assert.deepEqual(await rolesOf(env, S), ['sales', 'admin', 'client_comms']);
  assert.deepEqual(DEFAULT_ROLES[R], ['dev', 'admin']);
  for (const who of [R, S]) {
    assert.deepEqual(pagesFor(await rolesOf(env, who)), ALL, who + ' opens every page');
    for (const href of Object.keys(PAGE_OF)) assert.equal(canOpen(await rolesOf(env, who), href), true, who + ' → ' + href);
  }
  assert.ok(isLead(await rolesOf(env, R)) && isLead(await rolesOf(env, S)));
});
test('roles: a stored set overrides the defaults; with nothing stored the user record decides (nobody loses a page)', async () => {
  const env = { RATE: kv(users()) };
  assert.deepEqual(await rolesOf(env, X), ['staff'], 'a staff user with a page list');
  const xu = JSON.parse(env.RATE.m.get('user:' + X));
  assert.ok(pagesFor(['staff'], xu).includes('sales'), 'the page she holds today stays open');
  assert.deepEqual(fallbackRoles({ email: 'o@x.io', role: 'owner' }), ['dev', 'admin']);
  assert.deepEqual(fallbackRoles({ email: 'a@x.io', role: 'staff', pages: 'all' }), ['admin']);
  assert.deepEqual(fallbackRoles({ email: 'a@x.io', active: false }), []);
  await env.RATE.put('staffrole:' + X, JSON.stringify({ roles: ['sales', 'nonsense', 'sales'] }));
  assert.deepEqual(await rolesOf(env, X), ['sales']);
  assert.deepEqual(await rolesOf(env, ''), []);
});
test('page map: every role sees its pages, admin all, unknown links stay open; ids are the auth.js page ids', () => {
  for (const id of Object.values(PAGE_OF)) assert.ok(ALL.includes(id), id);
  for (const [r, ps] of Object.entries(ROLE_PAGES)) if (ps !== 'all') for (const p of ps) assert.ok(ALL.includes(p), r + ':' + p);
  assert.equal(pageIdOf('/next/admin.html?view=money'), 'money');
  assert.equal(pageIdOf('admin.html?view=calls&x=1'), 'sends');
  assert.equal(pageIdOf('https://ishur.io/next/brain.html'), 'control');
  assert.equal(pageIdOf('login.html'), null);
  assert.equal(canOpen(['sales'], 'leads.html'), true);
  assert.equal(canOpen(['sales'], 'admin.html?view=money'), false);
  assert.equal(canOpen(['sales'], 'brain.html'), false);
  assert.equal(canOpen(['client_comms'], 'inbox.html'), true);
  assert.equal(canOpen(['client_comms'], 'leads.html'), false);
  assert.equal(canOpen(['staff'], 'calendar.html'), true);
  assert.equal(canOpen(['staff'], 'clients.html'), false);
  assert.equal(canOpen(['dev'], 'automations.html'), true);
  assert.equal(canOpen(['staff'], 'login.html'), true, 'no page id = open to everyone signed in');
  assert.equal(canOpen(['admin'], 'admin.html?view=money'), true);
});
test('setting roles: admin only, known roles only, an admin cannot drop their own admin', () => {
  assert.equal(planRoles(X, ['sales'], Y, ['staff']).error, 'admin-only');
  assert.equal(planRoles(R, ['admin'], 'bad', ['staff']).error, 'bad-email');
  assert.equal(planRoles(R, ['admin'], Y, ['x']).error, 'no-roles');
  assert.equal(planRoles(R, ['admin', 'dev'], R, ['dev']).error, 'keep-own-admin');
  assert.deepEqual(planRoles(R, ['admin'], Y, ['sales', 'staff', 'sales']), { ok: true, email: Y, roles: ['sales', 'staff'] });
});

/* ── the flow ──────────────────────────────────────────────────────────── */
test('status flow: assignee open → in_progress → done; ONLY the opener closes; the opener can send it back', () => {
  const it = s => ({ opener: S, assignee: R, status: s });
  assert.equal(moveError(it('open'), R, 'in_progress'), '');
  assert.equal(moveError(it('in_progress'), R, 'done'), '');
  assert.equal(moveError(it('open'), R, 'done'), '');
  assert.equal(moveError(it('open'), S, 'in_progress'), 'assignee-only');
  assert.equal(moveError(it('in_progress'), S, 'done'), 'assignee-only');
  assert.equal(moveError(it('done'), R, 'closed'), 'opener-only', 'the assignee cannot close');
  assert.equal(moveError(it('done'), Y, 'closed'), 'opener-only', 'nor an outsider');
  assert.equal(moveError(it('done'), S, 'closed'), '');
  assert.equal(moveError(it('done'), S, 'open'), '', 'the opener sends it back');
  assert.equal(moveError(it('closed'), S, 'open'), '', 'and can reopen a closed one');
  assert.equal(moveError(it('closed'), R, 'open'), 'bad-move');
  assert.equal(moveError(it('done'), R, 'in_progress'), 'bad-move');
  assert.equal(moveError(it('open'), Y, 'open'), 'same-status');
  assert.equal(moveError(it('open'), S, 'nope'), 'bad-status');
  /* one person opened it for themselves: they do both sides */
  const self = s => ({ opener: X, assignee: X, status: s });
  assert.equal(moveError(self('open'), X, 'in_progress'), '');
  assert.equal(moveError(self('done'), X, 'closed'), '');
});
test('visibility: only what I opened or what is assigned to me; admin/dev may ask for all', () => {
  const a = { opener: S, assignee: R }, b = { opener: X, assignee: X };
  assert.equal(canView(a, S, ['sales']), true);
  assert.equal(canView(a, R, ['dev', 'admin']), true);
  assert.equal(canView(b, R, ['dev', 'admin']), false, 'not mine, "all" off');
  assert.equal(canView(b, R, ['dev', 'admin'], true), true, 'lead with "all"');
  assert.equal(canView(a, X, ['sales'], true), false, '"all" does nothing for a non-lead');
  assert.equal(canView(a, Y, ['dev'], true), true, 'dev counts as lead');
  const c = countsFor([{ opener: S, assignee: R, status: 'open' }, { opener: S, assignee: R, status: 'done' }, { opener: R, assignee: S, status: 'in_progress' }, { opener: S, assignee: R, status: 'closed' }], R);
  assert.deepEqual(c, { opened: 1, assigned: 2, to_me: 1, review: 0, badge: 1 });
  assert.equal(countsFor([{ opener: S, assignee: R, status: 'done' }], S).review, 1);
});

/* ── the route ─────────────────────────────────────────────────────────── */
test('route: create → comment → status, both sides told on Slack (never WhatsApp), the opener alone closes', async () => {
  const env = { RATE: kv(users()) }; const sent = []; const d = mkD(sent);
  assert.equal((await call(env, S, { op: 'me' }, { ...d, isAdmin: () => false })).status, 403, 'admin key checked like every admin route');
  const me0 = await call(env, '', { op: 'me' }, d);
  assert.equal(me0.ok, true); assert.equal(me0.me, null, 'no person (shared key): the panel stays off, nothing hidden');
  assert.equal((await call(env, '', { action: 'create' }, d)).status, 401);
  const me = await call(env, S, { op: 'me' }, d);
  assert.deepEqual(me.me.roles, ['sales', 'admin', 'client_comms']); assert.deepEqual(me.pages, ALL);
  assert.ok(me.team.some(t => t.email === R) && me.team.some(t => t.email === X));

  assert.equal((await call(env, S, { action: 'create', type: 'request', title: 'x', assignee: R }, d)).error, 'bad-input');
  assert.equal((await call(env, S, { action: 'create', type: 'request', title: 'לשנות שעה', assignee: 'nobody@x.io' }, d)).error, 'unknown-assignee');
  const c = await call(env, S, { action: 'create', type: 'request', title: 'דנה ביקשה לשנות שעת שליחה', text: 'ל-10:00 <b>', assignee: R, event: { t8: 'abcd1234', name: 'החתונה של דנה', date: '2026-12-01' } }, d);
  assert.equal(c.ok, true); const id = c.item.id;
  assert.match(id, /^ti[a-z0-9]+$/); assert.equal(c.item.status, 'open'); assert.equal(c.item.text, 'ל-10:00 b', 'no markup kept');
  assert.equal(c.item.event.t8, 'abcd1234'); assert.deepEqual(c.counts, { opened: 1, assigned: 0, to_me: 0, review: 0, badge: 0 });
  assert.ok(env.RATE.m.has('teamissue:' + id)); assert.equal(JSON.parse(env.RATE.m.get('teamissueidx')).length, 1);
  assert.equal(sent.length, 1); assert.match(sent[0].text, /בקשת לקוח חדשה/); assert.match(sent[0].text, /מאת שלו אל ריצארד/);
  assert.equal(sent[0].opts.oneoff, true); assert.equal(sent[0].opts.important, true);
  assert.ok(!/נדרשת פעולה ממך/.test(sent[0].text), 'no Linear task per item');

  /* the assignee sees it as "to me"; an outsider does not see it at all */
  const rl = await call(env, R, { op: 'list' }, d);
  assert.deepEqual(rl.items.map(i => i.id), [id]); assert.equal(rl.counts.to_me, 1); assert.equal(rl.counts.badge, 1);
  assert.equal((await call(env, X, { op: 'list' }, d)).items.length, 0);
  assert.equal((await call(env, X, { op: 'get', id }, d)).status, 404);
  assert.equal((await call(env, X, { action: 'comment', id, text: 'שלום' }, d)).status, 404);
  assert.equal((await call(env, X, { op: 'list', all: true }, d)).items.length, 0, '"all" is for admin/dev only');

  const cm = await call(env, R, { action: 'comment', id, text: 'על זה' }, d);
  assert.equal(cm.item.comments.length, 1); assert.equal(cm.item.comments[0].by, R); assert.ok(cm.item.comments[0].at);
  assert.match(sent.at(-1).text, /תגובה חדשה/); assert.match(sent.at(-1).text, /מאת ריצארד אל שלו/);

  assert.equal((await call(env, S, { action: 'status', id, to: 'in_progress' }, d)).error, 'assignee-only');
  assert.equal((await call(env, R, { action: 'status', id, to: 'in_progress' }, d)).item.status, 'in_progress');
  const done = await call(env, R, { action: 'status', id, to: 'done', text: 'שונה' }, d);
  assert.equal(done.item.status, 'done'); assert.equal(done.item.comments.at(-1).text, 'שונה');
  assert.equal((await call(env, R, { action: 'status', id, to: 'closed' }, d)).error, 'opener-only', 'the assignee cannot close');
  assert.equal((await call(env, S, { op: 'list' }, d)).counts.review, 1, 'waits for the opener to check');
  const back = await call(env, S, { action: 'status', id, to: 'open', text: 'עדיין לא' }, d);
  assert.equal(back.item.status, 'open');
  await call(env, R, { action: 'status', id, to: 'done' }, d);
  const closed = await call(env, S, { action: 'status', id, to: 'closed' }, d);
  assert.equal(closed.item.status, 'closed');
  assert.deepEqual(closed.item.history.map(h => h.to), ['open', 'in_progress', 'done', 'open', 'done', 'closed']);
  assert.ok(closed.item.history.every(h => h.by && h.at));
  assert.ok(sent.every(s => !/whatsapp/i.test(JSON.stringify(s.opts))));
});
test('route: admin/dev see everything with "all" and may comment, but the "all" view gives no right to close', async () => {
  const env = { RATE: kv(users()) }; const d = mkD();
  const c = await call(env, X, { action: 'create', type: 'issue', title: 'באג בלוח', assignee: X }, d);
  assert.equal((await call(env, R, { op: 'list' }, d)).items.length, 0);
  assert.deepEqual((await call(env, R, { op: 'list', all: true }, d)).items.map(i => i.id), [c.item.id]);
  assert.equal((await call(env, R, { op: 'get', id: c.item.id }, d)).item.title, 'באג בלוח');
  assert.equal((await call(env, R, { action: 'comment', id: c.item.id, text: 'ראיתי' }, d)).ok, true);
  assert.equal((await call(env, R, { action: 'status', id: c.item.id, to: 'closed' }, d)).error, 'opener-only');
});
test('route: Shalev\'s WhatsApp notes show as items from her to Richard; acting on one makes it real and closes the note', async () => {
  const env = { RATE: kv(users()) }; const d = mkD();
  const now = Date.now();
  const key = await saveNote(env, { id: 'wamid.ABC==', ts: now - 3600e3, text: 'להוריד את זיו מהרשימה\nתודה', type: 'text' });
  const r = await call(env, R, { op: 'list' }, d);
  const tn = r.items.find(i => i.id === noteIssueId(key));
  assert.ok(tn); assert.equal(tn.opener, TEAMNOTE_FROM); assert.equal(tn.assignee, TEAMNOTE_TO); assert.equal(tn.source, 'whatsapp'); assert.equal(tn.readonly, true);
  assert.equal(tn.title, 'להוריד את זיו מהרשימה'); assert.equal(r.counts.to_me, 1);
  assert.ok((await call(env, S, { op: 'list' }, d)).items.some(i => i.id === tn.id), 'Shalev sees her own request');
  const g = await call(env, R, { op: 'get', id: tn.id }, d);
  assert.equal(g.item.text, 'להוריד את זיו מהרשימה\nתודה');
  const done = await call(env, R, { action: 'status', id: tn.id, to: 'done' }, d);
  assert.equal(done.ok, true); assert.equal(done.item.from_note, key); assert.ok(env.RATE.m.has('teamissue:' + tn.id));
  assert.equal((await listNotes(env, { days: 7, now })).find(n => n.key === key).status, 'done', 'the brain stops raising it');
  const again = await call(env, R, { op: 'list' }, d);
  assert.equal(again.items.filter(i => i.id === tn.id).length, 1, 'shown once, as the real item');
  assert.equal(again.items.find(i => i.id === tn.id).status, 'done');
  assert.equal((await call(env, S, { action: 'status', id: tn.id, to: 'closed' }, d)).item.status, 'closed');
});
test('route: roles set by an admin, refused for others; events picker carries no full token', async () => {
  const env = { RATE: kv(users()) }; const d = mkD();
  assert.equal((await call(env, X, { action: 'roles', email: Y, roles: ['sales'] }, d)).error, 'admin-only');
  const ok = await call(env, S, { action: 'roles', email: Y, roles: ['client_comms'] }, d);
  assert.equal(ok.ok, true); assert.deepEqual(await rolesOf(env, Y), ['client_comms']);
  assert.equal((await call(env, R, { action: 'roles', email: R, roles: ['dev'] }, d)).error, 'keep-own-admin');
  const ev = await call(env, S, { op: 'events' }, d);
  assert.deepEqual(ev.events, [{ t8: 'abcd1234', name: 'החתונה של דנה', date: '2026-12-01' }]);
  assert.equal((await call(env, S, { op: 'nope' }, d)).status, 400);
  /* a write must say `action` (so the sign-in gate logs it); named as a read it is refused and writes nothing */
  const before = [...env.RATE.m.keys()].sort().join('|');
  assert.equal((await call(env, S, { op: 'roles', email: Y, roles: ['dev'] }, d)).error, 'bad-op');
  assert.equal((await call(env, S, { op: 'create', type: 'issue', title: 'בלי לוג', assignee: R }, d)).error, 'bad-op');
  assert.equal((await call(env, S, { action: 'list' }, d)).error, 'bad-op');
  assert.equal([...env.RATE.m.keys()].sort().join('|'), before);
});
test('the notice: titled, spaced, a link footer', () => {
  const t = noticeText('status', { id: 'tiabc', title: 'באג', status: 'done', event: { name: 'דנה' } }, 'ריצארד', 'שלו', 'תוקן');
  assert.match(t.split('\n')[0], /^\*צוות · סטטוס: בוצע · לבדיקה\* · באג$/);
  assert.match(t, /לפתוח: https:\/\/ishur\.io\/next\/admin\.html#team=tiabc$/);
});
test('wired in the Worker: a Google session reaches /api/team as that person; reads are not written to the action log', async () => {
  assert.equal(homeReadOk('/api/team', 'POST', { op: 'me' }), true);
  assert.equal(homeReadOk('/api/team', 'POST', { op: 'list', all: true }), true);
  assert.equal(homeReadOk('/api/team', 'POST', { action: 'create', title: 'x' }), false);
  const env = { ADMIN_KEY: 'k', RATE: kv(users()) };
  const tok = await createSession(env, S);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const go = body => worker.fetch(new Request('https://go.ishur.io/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify(body) }), env, ctx).then(r => r.json());
  const me = await go({ session: tok, op: 'me' });
  assert.equal(me.ok, true); assert.equal(me.me.email, S);
  assert.equal([...env.RATE.m.keys()].filter(k => k.startsWith('act:')).length, 0, 'a read leaves no log row');
  const spoof = await worker.fetch(new Request('https://go.ishur.io/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ishur-user': R }, body: JSON.stringify({ admin_key: 'k', op: 'me' }) }), env, ctx).then(r => r.json());
  assert.equal(spoof.me, null, 'a client cannot name itself with the header');
  const c = await go({ session: tok, action: 'create', type: 'issue', title: 'בדיקה', assignee: R });
  assert.equal(c.ok, true); assert.equal(c.item.opener, S);
  assert.ok([...env.RATE.m.keys()].some(k => k.startsWith('act:')), 'a write is logged under her account');
});

test('26/11 to-claude: the whole task is queued for the Claude chat with its thread and file links', async () => {
  const { claudeBrief } = await import('../teamissues.js');
  const kv = new Map(); const env = { RATE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) } };
  const it = { id: 'ti1', type: 'request', status: 'open', title: 'לבדוק את שוהם', text: 'הסעה מבאר שבע', opener: 'a@x.com', assignee: 'b@x.com', created_at: '2026-11-26',
    event: { name: 'שוהם ושי', date: '2026-12-02', t8: '41630865' }, files: [{ key: 'team/ti1/f1-a.png', name: 'a.png', kind: 'image' }],
    comments: [{ by: 'b@x.com', at: '2026-11-26T10:00:00Z', text: 'בטיפול', files: [{ key: 'team/ti1/f2-r.m4a', name: 'r.m4a', kind: 'audio' }, { key: '', name: 'gone.pdf', deleted: true }] }] };
  const b = await claudeBrief(env, it);
  assert.match(b, /משימת צוות ti1: לבדוק את שוהם/); assert.match(b, /שוהם ושי · 2026-12-02/); assert.match(b, /הסעה מבאר שבע/); assert.match(b, /בטיפול/);
  assert.match(b, /team-file\?k=team%2Fti1%2Ff1-a\.png/); assert.match(b, /team-file\?k=team%2Fti1%2Ff2-r\.m4a/); assert.doesNotMatch(b, /gone\.pdf/);
});
