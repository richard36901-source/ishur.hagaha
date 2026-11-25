/* 25/11/2026 track-board: who did it on the client board, and the admin add-round dialog's date rule */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { staffOf, clientOf, actorOf, actorLabel, boardActor, STAFF_HEADER } from '../actor.js';
import { rowOf, actorOfAnswer } from '../answers-log.js';

const req = h => new Request('https://x/api/guest-rsvp', { method: 'POST', headers: h || {} });
const US = 'us.' + 'a'.repeat(64);
const deps = {
  readSession: async (e, t) => (t === US ? { email: 'richard@ishur.io', name: 'Richard', active: true } : null),
  adminSessionOk: async (e, t) => t === 'sess.' + '1'.repeat(32) + '.' + '2'.repeat(32),
  verifySession: async (e, t) => (t === 'acct.good' ? '972501112233' : null),
};

test('a valid team session in x-ishur-staff → the action is the team\'s', async () => {
  const a = await actorOf({}, req({ [STAFF_HEADER]: US }), { board_session: 'acct.good' }, deps);
  assert.deepEqual(a, { kind: 'staff', email: 'richard@ishur.io', name: 'Richard', via: 'google' });
  assert.equal(actorLabel(a), 'צוות: Richard');
  assert.deepEqual(boardActor(a), { staff: true, name: 'Richard' });
  const dev = await staffOf({}, req({ [STAFF_HEADER]: 'sess.' + '1'.repeat(32) + '.' + '2'.repeat(32) }), deps);
  assert.equal(dev.kind, 'staff'); assert.equal(actorLabel(dev), 'צוות: מכשיר מנהל');
});
test('a bad, expired or raw-key staff header is ignored: the action stays the client\'s, never an error', async () => {
  for (const h of ['us.' + 'f'.repeat(64), 'sess.bad', 'the-raw-admin-key', 'x'.repeat(500), '']) {
    const a = await actorOf({}, req(h ? { [STAFF_HEADER]: h } : {}), {}, deps);
    assert.equal(a.kind, 'client', h); assert.equal(boardActor(a), null);
  }
  const boom = { ...deps, readSession: async () => { throw new Error('kv down'); } };
  assert.equal((await actorOf({}, req({ [STAFF_HEADER]: US }), {}, boom)).kind, 'client');
});
test('the client: PIN session vs link, with a short session id and never the token itself', async () => {
  const pin = await clientOf({}, { board_session: 'acct.good' }, deps);
  assert.equal(pin.via, 'pin'); assert.match(pin.session, /^[0-9a-f]{10}$/); assert.ok(!pin.session.includes('acct'));
  assert.equal(actorLabel(pin), `הלקוח (כניסה בקוד, מכשיר ${pin.session.slice(0, 6)})`);
  assert.equal((await clientOf({}, { board_session: 'acct.forged' }, deps)).via, 'link');
  const link = await clientOf({}, {}, deps);
  assert.deepEqual(link, { kind: 'client', via: 'link', session: '' });
  assert.equal(actorLabel(link), 'הלקוח (מהקישור)');
});
test('the worker records the actor on every client action, the view, the guest answer and the CSV; the header grants nothing', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const audit = src.slice(src.indexOf('async function auditClient'), src.indexOf('async function auditExport'));
  assert.match(audit, /const actor = await actorOf\(env, request, body, actorDeps\(\)\)/);
  assert.match(audit, /actor: actorLabel\(actor\), actor_kind: actor \? \(actor\.kind === 'staff' \? 'admin-on-client' : 'client'\)/);
  assert.match(audit, /admin_key\|board_session\)\$\/\.test\(k\)/, 'the client session token is not stored in the audit body');
  assert.match(src, /👁 \$\{actorLabel\(va\)\} צפה בלוח הבקרה/);
  assert.match(src, /if \(rsvpActor && rsvpActor\.kind === 'staff'\) guest\.answer_label = 'תוקן ידנית \(צוות\)';/);
  assert.match(src, /'verified', 'actor'\]/);
  assert.match(src, /snapshot\.viewer = boardActor\(await actorOf\(env, request, stampFields, actorDeps\(\)\)/);
  assert.ok(!fs.readFileSync(new URL('../auth.js', import.meta.url), 'utf8').includes('x-ishur-staff'), 'the sign-in gate never turns the staff header into rights');
  assert.match(fs.readFileSync(new URL('../lib.js', import.meta.url), 'utf8'), /X-Ishur-Staff/);
  const dash = fs.readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
  assert.match(dash, /if \(\/\^\(us\|sess\)\\\.\/\.test\(ck0\)\) STAFF_SESS = ck0;/, 'the board sends a session, never a raw key');
  assert.match(dash, /'מצב צוות · ' \+ v\.name/);
});
test('answers log: a manual answer says who gave it', () => {
  const g = w => { const r = Array(35).fill(''); r[2] = 'G'; r[15] = 'מגיע'; r[22] = w; return r; };
  assert.equal(actorOfAnswer(g('תוקן ידנית (צוות)')), 'צוות');
  assert.equal(actorOfAnswer(g('סומן ידנית (מארח)')), 'המארח');
  assert.equal(actorOfAnswer(g('ענה בוואטסאפ')), '');
  assert.equal(rowOf(g('תוקן ידנית (צוות)')).method_he, 'סומן ידנית · צוות');
  assert.equal(rowOf(g('סומן ידנית (מארח)')).method_he, 'סומן ידנית · המארח');
  assert.equal(rowOf(g('ענה בוואטסאפ')).method_he, 'וואטסאפ');
});

/* rule 4 (admin side): the dialog's first allowed day — today until 19:00 Israel time, then tomorrow */
function dialogAt(isoUtc) {
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [isoUtc])); } static now() { return new RealDate(isoUtc).getTime(); } }
  const ctx = { window: {}, Date: FakeDate, Intl, document: {}, requestAnimationFrame: () => {} };
  vm.runInNewContext(fs.readFileSync(new URL('../../assets/addround.js', import.meta.url), 'utf8'), ctx);
  return ctx.window.IshurAddRound;
}
test('add-round dialog: today only before 19:00, never a past day; calls never offer "everybody"', () => {
  assert.equal(dialogAt('2026-11-25T16:59:00Z').minDay(), '2026-11-25', '18:59 in Israel');
  assert.equal(dialogAt('2026-11-25T17:00:00Z').minDay(), '2026-11-26', '19:00 in Israel');
  const src = fs.readFileSync(new URL('../../assets/addround.js', import.meta.url), 'utf8');
  assert.match(src, /return !\(calls && a\[0\] === 'all'\);/);
  for (const p of ['../../clients.html', '../../next/clients.html']) {
    const h = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.match(h, /api\('grant-addon', \{ token: t, kind: act, when: plan\.when, scope: plan\.scope \}\)/, p);
    assert.match(h, /api\('client-stop-lift', \{ token: t \}\)/, p);
  }
});
