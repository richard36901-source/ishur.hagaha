/* 25/11/2026: the users page shows what the team CHANGED, in words; polling, screens and clicks are not "actions". */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { quietRead, describe, teamActionAfter, namesFor } from '../team-log.js';
import { queryActions, logAction } from '../auth.js';
import { homeReadOk } from '../index.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init)), meta = new Map();
  return { m, meta,
    get: async k => (m.has(k) ? m.get(k) : null),
    put: async (k, v, o = {}) => { m.set(k, String(v)); if (o.metadata) meta.set(k, o.metadata); },
    delete: async k => { m.delete(k); meta.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: meta.get(name) })), list_complete: true }) };
}
const TOK = '0123abcd-0000-4000-8000-000000000000';

test('quietRead: polling and reads are never an action; the writes on the same routes are', () => {
  assert.equal(quietRead('/api/stream', { days: 1, since: 5 }), true);
  assert.equal(quietRead('/api/answers-log', { token: TOK }), true);
  assert.equal(quietRead('/api/answers-log', { token: TOK, action: 'proof' }), true);
  assert.equal(quietRead('/api/answers-log', { token: TOK, action: 'set' }), false);
  assert.equal(quietRead('/api/guest-card', { token: TOK, guest_id: 'g1' }), true);
  assert.equal(quietRead('/api/guest-card', { action: 'cancel_send' }), false);
  assert.equal(quietRead('/api/future-log', {}), true);
  assert.equal(quietRead('/api/future-log', { action: 'live' }), true);
  assert.equal(quietRead('/api/event-flag', { on: true }), false);
  assert.equal(quietRead('/api/pause', {}), false);
});

test('authGate is told stream/answers-log reads are reads, and HOME_READS (the batch list) is untouched', () => {
  assert.equal(homeReadOk('/api/stream', 'POST', {}), false, '/api/admin/home batching does not gain the stream');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('isRead: (p, m, b) => homeReadOk(p, m, b) || quietRead(p, b)'));
  assert.ok(src.includes('!quietRead(url.pathname, peek) && isAdmin(env, peek.admin_key)'), 'the admin stream tap skips them too');
  assert.ok(src.includes('teamActionAfter(env, { path: new URL(g.request.url).pathname'));
});

test('describe: the words for the changes the team makes', () => {
  const names = { event: 'החתונה של דנה ויוסי', guest: k => (k === 'g7' || k === '972501112233' ? 'דנה כהן' : '') };
  assert.equal(describe('/api/answers-log', { action: 'set', guest_id: 'g7', rsvp: 'מגיע' }, { ok: true, party: 2 }, names), 'סימון דנה כהן: מגיע (2) · החתונה של דנה ויוסי');
  assert.equal(describe('/api/answers-log', { token: TOK }, { ok: true }, names), '', 'a read is not an action');
  assert.equal(describe('/api/event-flag', { flag: 'hold', on: true }, { ok: true }, names), 'הקפאת שליחות · החתונה של דנה ויוסי');
  assert.equal(describe('/api/event-flag', { flag: 'hold' }, { ok: true }, names), '');
  assert.equal(describe('/api/send-date', { send: 'reminder', date: '2026-11-26' }, { ok: true }, names), 'שינוי תאריך שליחה 2 ל-26/11 · החתונה של דנה ויוסי');
  assert.equal(describe('/api/skip', { kind: 'daybefore', phone: '972501112233' }, { ok: true }, names), 'ביטול יום-לפני לאורח דנה כהן · החתונה של דנה ויוסי');
  assert.equal(describe('/api/guest-card', { action: 'stop_event' }, { ok: true, done_he: 'עצירת כל השליחות והשיחות לדנה כהן באירוע הזה' }, names), 'עצירת כל השליחות והשיחות לדנה כהן באירוע הזה · החתונה של דנה ויוסי');
  assert.equal(describe('/api/event-flag', { flag: 'hold', on: true }, { ok: false }, names), '', 'a refused change is not logged');
  /* the change-log summaries are reused, the event named instead of its tok8 */
  const cr = { '/api/pause': { when: b => typeof b.paused === 'boolean', summary: b => (b.paused ? 'עצירה כללית הופעלה' : 'בוטלה') },
    '/api/call-round': { when: b => b.action === 'set', summary: () => 'סבב שיחות נקבע לאירוע 0123abcd' } };
  assert.equal(describe('/api/pause', { paused: true }, { ok: true }, {}, cr), 'עצירה כללית הופעלה');
  assert.equal(describe('/api/call-round', { action: 'set' }, { ok: true }, names, cr), 'סבב שיחות נקבע לאירוע החתונה של דנה ויוסי');
  assert.equal(describe('/api/whatever', { x: 1 }, { ok: true }, names, cr), '', 'an unknown route is not shown');
});

test('teamActionAfter writes one meaningful act: row; queryActions(meaningful) returns only those', async () => {
  const env = { RATE: kv({ ['evmeta:' + TOK]: JSON.stringify({ event: 'החתונה של דנה ויוסי' }), ['gmap:' + TOK]: JSON.stringify({ '972501112233': { id: 'g7', name: 'דנה כהן' } }) }) };
  const user = { email: 'shalev@x.com' };
  const req = b => new Request('https://go.ishur.io/x', { method: 'POST', body: JSON.stringify(b) });
  const res = j => new Response(JSON.stringify(j));
  await logAction(env, { u: user.email, a: 'stream', p: '/api/stream' });
  await logAction(env, { u: user.email, a: 'לחץ: עוד', p: '/next/live.html' });
  assert.equal(await teamActionAfter(env, { path: '/api/stream', reqClone: req({ days: 1 }), resClone: res({ ok: true }), user }), '');
  const k = await teamActionAfter(env, { path: '/api/answers-log', reqClone: req({ action: 'set', token: TOK, guest_id: 'g7', rsvp: 'מגיע', party: 2 }), resClone: res({ ok: true, party: 2 }), user });
  assert.ok(k.startsWith('act:'));
  assert.deepEqual(env.RATE.meta.get(k), { u: user.email, a: 'סימון דנה כהן: מגיע (2) · החתונה של דנה ויוסי', p: '/api/answers-log', m: 1, t: '0123abcd' });
  const all = await queryActions(env, { days: 1 }), mean = await queryActions(env, { days: 1, meaningful: true });
  assert.equal(all.length, 3);
  assert.equal(mean.length, 1);
  assert.equal(mean[0].a, 'סימון דנה כהן: מגיע (2) · החתונה של דנה ויוסי');
  assert.equal((await namesFor(env, 'not-a-token')).event, '');
});

test('the users page asks for the meaningful rows, with a switch for the raw ones', () => {
  const html = fs.readFileSync(new URL('../../next/users.html', import.meta.url), 'utf8');
  assert.ok(html.includes("meaningful: !$('fAll').checked"));
});

test('the live log filters on the server and drops stale answers', () => {
  const html = fs.readFileSync(new URL('../../next/live.html', import.meta.url), 'utf8');
  assert.ok(html.includes("api('stream', Object.assign(full ?"));
  assert.ok(html.includes('serverFilter()'));
  assert.ok(html.includes("if (!j || !j.ok || my !== seq) return;"));
  assert.ok(/kindSel'\)\.addEventListener\('change', function \(\) \{ kind = [^}]*reload\(\)/.test(html));
});
