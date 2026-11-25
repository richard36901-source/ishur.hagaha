/* 25/11/2026 track-board: client stop button, added-round audience + day, board state line, no past dates */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateStop, handleClientStop, handleClientStopLift, publicStop, STOP_REASONS } from '../client-stop.js';
import { normAudience, audienceIncludes, parseAddon, dateGuard, addonDialOk, addonDayReady, rowStateHe, handleCallsAddonDate, firstSentAt } from '../send-plan.js';
import { buildDashboard } from '../dashboard.js';
import { extraSendWave } from '../index.js';
import { writeSetting } from '../cfg.js';

const TOK = '11111111-2222-3333-4444-555555555555';
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
}
const okJson = (p) => new Response(JSON.stringify(p), { status: 200 });
const deny = (st, why) => new Response(JSON.stringify({ ok: false, error: why }), { status: st });
const req = b => new Request('https://x/api', { method: 'POST', body: JSON.stringify(b) });
const NOTE = 'האירוע בוטל בגלל מחלה במשפחה, מצטערים';

/* ── rule 1: the stop button ── */
test('stop: a reason from the list, a note of at least 20 characters and the confirm word are all required', () => {
  assert.equal(validateStop({ reason: 'cancelled', note: NOTE, confirm: 'עצירה' }).mode, 'stop');
  assert.equal(validateStop({ reason: 'cancelled', note: NOTE, confirm: 'ביטול' }).mode, 'cancel');
  assert.equal(validateStop({ reason: 'nope', note: NOTE, confirm: 'עצירה' }).error, 'bad-reason');
  assert.equal(validateStop({ reason: 'other', note: 'קצר מדי', confirm: 'עצירה' }).error, 'note-too-short');
  assert.equal(validateStop({ reason: 'other', note: '                         x', confirm: 'עצירה' }).error, 'note-too-short', 'spaces do not count');
  assert.equal(validateStop({ reason: 'other', note: NOTE, confirm: 'כן' }).error, 'bad-confirm');
  assert.deepEqual(Object.values(STOP_REASONS), ['לא מרוצה מהשירות', 'האירוע בוטל', 'האירוע נדחה', 'טעות בפרטים', 'אחר']);
});

function stopDeps(slack, notes) {
  return { okJson, deny, tokenRecord: async (e, t) => (t === TOK ? { phone: '1' } : null), overBudget: async () => false, logEvent: async () => {},
    slackSend: async (e, t) => { slack.push(t); }, notifyEvent: async (e, d, rule, c) => { notes.push({ rule, ...c }); }, eventName: async () => 'דנה ויוסי' };
}
test('stop: freezes sends, calls and the dates nudge at once, removes the two automatic releases, alerts Slack and the team', async () => {
  const RATE = kv({ ['holdtill:' + TOK]: '2026-12-01', ['relonappr:' + TOK]: '1' });
  const slack = [], notes = [];
  const r = await handleClientStop(req({ token: TOK, reason: 'unhappy', note: NOTE, confirm: 'עצירה' }), { RATE }, '', stopDeps(slack, notes));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.stop.mode, 'stop'); assert.equal(j.stop.reason_he, 'לא מרוצה מהשירות');
  for (const k of ['clientstop:', 'hold:', 'callstop:', 'sendsoff:']) assert.ok(RATE.m.has(k + TOK), k);
  assert.ok(!RATE.m.has('holdtill:' + TOK) && !RATE.m.has('relonappr:' + TOK));
  assert.equal(slack.length, 1); assert.match(slack[0], /עצר את כל השליחות/);
  assert.equal(notes[0].rule, 'incident');
  assert.equal(j.stop.ip, undefined, 'the board never gets the ip');
  /* pressing again changes nothing */
  const r2 = await handleClientStop(req({ token: TOK, reason: 'other', note: NOTE, confirm: 'ביטול' }), { RATE }, '', stopDeps(slack, notes));
  assert.equal((await r2.json()).already, true); assert.equal(slack.length, 1);
});
test('stop: "ביטול" records a cancel request and writes nothing that would message the guests', async () => {
  const RATE = kv(); const slack = [];
  await handleClientStop(req({ token: TOK, reason: 'cancelled', note: NOTE, confirm: 'ביטול' }), { RATE }, '', stopDeps(slack, []));
  assert.equal(JSON.parse(RATE.m.get('clientstop:' + TOK)).mode, 'cancel');
  assert.match(slack[0], /לא נשלחה הודעת ביטול/);
  assert.deepEqual([...RATE.m.keys()].sort(), ['callstop:', 'clientstop:', 'hold:', 'sendsoff:'].map(k => k + TOK).sort());
});
test('stop: refused without a valid token or a long enough note; an alert failure does not undo the stop', async () => {
  const RATE = kv();
  assert.equal((await handleClientStop(req({ token: 'bad', reason: 'other', note: NOTE, confirm: 'עצירה' }), { RATE }, '', stopDeps([], []))).status, 404);
  assert.equal((await handleClientStop(req({ token: TOK, reason: 'other', note: 'short', confirm: 'עצירה' }), { RATE }, '', stopDeps([], []))).status, 422);
  assert.equal(RATE.m.size, 0);
  const d = stopDeps([], []); d.slackSend = async () => { throw new Error('slack down'); };
  const r = await handleClientStop(req({ token: TOK, reason: 'other', note: NOTE, confirm: 'עצירה' }), { RATE }, '', d);
  assert.equal(r.status, 200); assert.ok(RATE.m.has('hold:' + TOK));
});
test('lift: team only, clears every key and wakes the pacer', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: '{"mode":"stop"}', ['hold:' + TOK]: 'x', ['callstop:' + TOK]: 'x', ['sendsoff:' + TOK]: 'x' });
  const d = { okJson, deny, isAdmin: (e, k) => k === 'K', logEvent: async () => {}, slackSend: async () => {} };
  assert.equal((await handleClientStopLift(req({ admin_key: 'no', token: TOK }), { RATE }, '', d)).status, 403);
  const r = await handleClientStopLift(req({ admin_key: 'K', token: TOK }), { RATE }, '', d);
  assert.equal((await r.json()).lifted, true);
  assert.deepEqual([...RATE.m.keys()], ['pacer:pending']);
});
test('lift: the timed release, template approval, the hold switch, the brain and the calls centre cannot lift a client stop', async () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /if \(await clientStopOf\(env, token\)\) \{ await env\.RATE\.delete\('holdtill:' \+ token\); continue; \}/);
  assert.match(src, /relonappr:' \+ token\)\.catch\(\(\) => null\) && !\(await clientStopOf\(env, token\)\)/);
  assert.match(src, /flag === 'hold' && !body\.on && await clientStopOf\(env, token\)\) return deny\(409, 'client-stopped'/);
  assert.match(src, /queue = queue\.filter\(g => !stops\[g\.token\] && addonDialOk\(/, 'Shir dials nobody of a stopped event');
  assert.match(src, /target\.token && await clientStopOf\(env, target\.token\)\)/, 'and rings no guest of it back');
  assert.match(fs.readFileSync(new URL('../brain.js', import.meta.url), 'utf8'), /!on && await isClientStopped\(c\.env, token\)/);
  assert.match(fs.readFileSync(new URL('../ops-calls.js', import.meta.url), 'utf8'), /action === 'start' && await isClientStopped\(env, tok\)/);
  const RATE = kv({ ['clientstop:' + TOK]: '{"mode":"stop"}', ['hold:' + TOK]: 'x' });
  const out = await writeSetting({ RATE }, 'event_hold', TOK, false).catch(e => ({ err: String(e) }));
  assert.ok(RATE.m.has('hold:' + TOK), JSON.stringify(out));
});
test('every guest send path already stops on hold: (the stop writes it)', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok((src.match(/RATE\.get\('hold:' \+ token\)/g) || []).length >= 9);
  assert.equal(publicStop(null), null);
});

/* ── rule 4: audience ── */
test('audience: the four choices, declined guests never, calls never "everybody"', () => {
  const who = a => ['', 'מתלבט', 'מגיע', 'לא מגיע'].filter(r => audienceIncludes(a, r));
  assert.deepEqual(who('all'), ['', 'מתלבט', 'מגיע']);
  assert.deepEqual(who('unanswered'), ['', 'מתלבט']);
  assert.deepEqual(who('noanswer'), ['']);
  assert.deepEqual(who('undecided'), ['מתלבט']);
  assert.equal(normAudience('all', { calls: true }), 'unanswered');
  assert.equal(normAudience('junk'), 'all');
  assert.equal(normAudience(undefined, { calls: true }), 'unanswered');
});
test('extra send wave honours the new audiences and keeps the old values', () => {
  const W3 = { key: 3, col: 41, onlyUnanswered: false };
  assert.equal(extraSendWave(W3, JSON.stringify({ scope: 'noanswer' })).audience, 'noanswer');
  assert.equal(extraSendWave(W3, JSON.stringify({ scope: 'undecided' })).audience, 'undecided');
  assert.equal(extraSendWave(W3, JSON.stringify({ scope: 'unanswered' })).audience, undefined);
  assert.equal(extraSendWave(W3, JSON.stringify({ scope: 'all' })), W3);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /if \(wave\.audience && !audienceIncludes\(wave\.audience, rsvp\)\) \{ skippedAnswered\+\+/);
});
test('calls add-on: waits for its day or the client, rings only its audience; the plan\'s own tries are untouched', () => {
  const rec = o => JSON.stringify({ at: '2026-11-25T10:00:00Z', ...o });
  const g = (tries, rsvp) => ({ tries, rsvp, plan: 'pro' });   /* pro = one call try of its own */
  assert.equal(addonDialOk(rec({ start: '2026-11-30', scope: 'undecided' }), g(0, ''), '2026-11-26'), true, 'plan round');
  assert.equal(addonDialOk(rec({ start: '2026-11-30' }), g(1, ''), '2026-11-26'), false, 'before its day');
  assert.equal(addonDialOk(rec({ start: '2026-11-26', scope: 'undecided' }), g(1, ''), '2026-11-26'), false, 'not in the audience');
  assert.equal(addonDialOk(rec({ start: '2026-11-26', scope: 'undecided' }), g(1, 'מתלבט'), '2026-11-26'), true);
  assert.equal(addonDialOk(rec({ client_decides: true }), g(1, ''), '2026-11-26'), false, 'the client has not picked');
  assert.equal(addonDialOk('2026-11-25T10:00:00Z', g(1, ''), '2026-11-26'), true, 'an old plain value behaves as before');
  assert.equal(addonDayReady(rec({ client_decides: true }), '2026-11-26'), false);
  assert.equal(addonDayReady(rec({ start: '2026-11-27' }), '2026-11-26'), false);
  assert.equal(addonDayReady(rec({}), '2026-11-26'), true);
  assert.equal(parseAddon(null), null);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!audienceIncludes\(addonAud, rsvp\) \|\| !gid\) continue;/);
  assert.match(src, /const ready = !addonDayReady\(addonRaw, today\) \? false/);
});

/* ── rule 5: no past dates ── */
test('date guard: no past day; today only before 19:00; tomorrow always', () => {
  assert.equal(dateGuard('2026-11-24', { today: '2026-11-25', hm: '08:00' }), 'date-in-past');
  assert.equal(dateGuard('2026-11-25', { today: '2026-11-25', hm: '18:59' }), '');
  assert.equal(dateGuard('2026-11-25', { today: '2026-11-25', hm: '19:00' }), 'too-late-today');
  assert.equal(dateGuard('2026-11-26', { today: '2026-11-25', hm: '23:50' }), '');
  assert.equal(dateGuard('x', { today: '2026-11-25', hm: '10:00' }), 'bad-date');
});
test('date guard is applied in send-date, board-move (calls / thanks) and the admin grant', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const sd = src.slice(src.indexOf('async function handleSendDate'), src.indexOf('async function handleSendDate') + 3000);
  assert.match(sd, /dateGuard\(date, \{ today, hm: ilHM\(\) \}\)/);
  assert.match(sd, /clientStopOf\(env, token\)\) return deny\(409, 'client-stopped'/);
  assert.match(src, /if \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(d\)\) return deny\(400, 'bad-date', origin\);\n\s+\{ const why = dateGuard\(d,/);
  assert.match(src, /if \(when && when !== 'client'\) \{ const why = dateGuard\(when,/);
});
function addonDeps(over = {}) {
  return { okJson, deny, tokenRecord: async (e, t) => (t === TOK ? {} : null), overBudget: async () => false, logEvent: async () => {}, clientStopOf: async () => null,
    ilDate: () => '2026-11-25', eventDate: async () => '2026-12-10', now: () => new Date('2026-11-25T08:00:00Z'), ...over };
}
test('client picks the calls round day: past / late / after the event / no add-on / stopped are refused', async () => {
  const RATE = kv({ ['callsaddon:' + TOK]: JSON.stringify({ at: 'x', scope: 'undecided', client_decides: true }) });
  const call = (date, d = addonDeps()) => handleCallsAddonDate(req({ token: TOK, date }), { RATE }, '', d);
  assert.equal((await call('2026-11-24')).status, 422);
  assert.equal((await call('2026-11-25', addonDeps({ now: () => new Date('2026-11-25T17:30:00Z') }))).status, 422, '19:30 in Israel');
  assert.equal((await call('2026-12-10')).status, 422);
  assert.equal((await call('2026-11-28')).status, 422, 'Shabbat');
  assert.equal((await call('2026-11-26', addonDeps({ clientStopOf: async () => ({}) }))).status, 409);
  const r = await call('2026-11-26');
  assert.equal(r.status, 200);
  const rec = JSON.parse(RATE.m.get('callsaddon:' + TOK));
  assert.equal(rec.start, '2026-11-26'); assert.equal(rec.scope, 'undecided');
  RATE.m.delete('callsaddon:' + TOK);
  assert.equal((await call('2026-11-26')).status, 402);
});

/* ── rule 3: the board's state line ── */
test('state line: sent with time and delivered, scheduled with the hour, waiting for a date, calls, stopped', () => {
  assert.equal(rowStateHe({ key: 'invite', status: 'sent', date: '2026-11-25', sent_at: '2026-11-25 10:12', delivered_n: 412, sent_n: 420 }), 'נשלח ב-25/11 10:12 · 412 נמסרו');
  assert.equal(rowStateHe({ key: 'invite', status: 'sent', date: '2026-11-25', sent_n: 420 }), 'נשלח ב-25/11 · 420 נשלחו');
  assert.equal(rowStateHe({ key: 'reminder', status: 'scheduled', date: '2026-11-26' }), 'מתוזמן ל-26/11 · מ-09:00');
  assert.equal(rowStateHe({ key: 'calls', status: 'scheduled', date: '2026-11-27', auto: true }), 'מתוזמן ל-27/11 · מ-10:00');
  assert.equal(rowStateHe({ key: 'extra', status: 'scheduled', date: '' }), 'ממתין לבחירת תאריך');
  assert.equal(rowStateHe({ key: 'calls2', status: 'sent', date: '2026-11-20', stats: { dialed: 30, answered: 12 } }), 'בוצע ב-20/11 · חויגו 30 · ענו 12');
  assert.equal(rowStateHe({ key: 'reminder', status: 'scheduled', date: '2026-11-26' }, { stopped: true }), 'נעצר לבקשתכם');
  assert.match(firstSentAt([Date.parse('2026-11-25T08:12:30Z') / 1000 + 100], 100), /^2026-11-25 10:12$/);
});
test('board payload: rows carry state_he / sent_at / delivered_n, the stop and the dates the client has to pick', () => {
  const row = Array(45).fill(''); row[1] = TOK; row[6] = '2099-12-20'; row[31] = 'בסיס'; row[39] = '2099-12-01'; row[40] = '2099-12-05';
  const raw = { events: { values: [Array(45).fill('h'), row] }, guests: { values: [] } };
  const d = buildDashboard(TOK, raw, 0, { 1: true, count: { 1: 5 }, sentAt: { 1: '2099-12-01 09:03' }, delivered: { 1: 4 }, extraPaid: true, extraPick: true, callsAddon: true, callsAddonPick: true, clientStop: { mode: 'stop', at: 'x' } });
  const inv = d.sends.find(s => s.key === 'invite');
  assert.equal(inv.state_he, 'נשלח ב-01/12 09:03 · 4 נמסרו');
  const ex = d.sends.find(s => s.key === 'extra');
  assert.equal(ex.pick, true);
  assert.deepEqual(d.pick_date.sort(), ['calls', 'extra']);
  assert.equal(d.stop.mode, 'stop');
  assert.equal(d.sends.find(s => s.key === 'reminder').state_he, 'נעצר לבקשתכם');
  for (const s of d.sends) assert.equal(typeof s.state_he, 'string', s.key);
});

/* ── advisor follow-ups (25/11) ── */
import vm from 'node:vm';
import { deliveredCount, bumpDelivered } from '../send-plan.js';
test('lift keeps what the team had set before the client pressed stop, and puts back the timed release', async () => {
  const RATE = kv({ ['hold:' + TOK]: 'team', ['holdtill:' + TOK]: '2026-12-01' });
  const d = stopDeps([], []);
  await handleClientStop(req({ token: TOK, reason: 'other', note: NOTE, confirm: 'עצירה' }), { RATE }, '', d);
  assert.ok(!RATE.m.has('holdtill:' + TOK));
  const ld = { okJson, deny, isAdmin: (e, k) => k === 'K', logEvent: async () => {}, slackSend: async () => {} };
  const j = await (await handleClientStopLift(req({ admin_key: 'K', token: TOK }), { RATE }, '', ld)).json();
  assert.deepEqual(j.still, ['hold']);
  assert.ok(RATE.m.has('hold:' + TOK), 'the team hold stays');
  assert.equal(RATE.m.get('holdtill:' + TOK), '2026-12-01');
  assert.ok(!RATE.m.has('callstop:' + TOK) && !RATE.m.has('sendsoff:' + TOK) && !RATE.m.has('clientstop:' + TOK));
});
test('delivered count: one key, bumped by the status webhook; none yet → null (the row says "נשלחו")', async () => {
  const RATE = kv();
  assert.equal(await deliveredCount({ RATE }, TOK, 1), null);
  await bumpDelivered({ RATE }, TOK, 1); await bumpDelivered({ RATE }, TOK, 1);
  assert.equal(await deliveredCount({ RATE }, TOK, 1), 2);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /\(st\.status === 'delivered' \|\| st\.status === 'read'\) && cur2 !== 'delivered' && cur2 !== 'read'\) await bumpDelivered\(env, m2\.token, m2\.wave \|\| 1\)/);
  assert.equal(rowStateHe({ key: 'event_day', status: 'scheduled', date: '2026-12-20', auto: true }), 'מתוזמן ל-20/12');
});
function prefs(storage) {
  const ctx = { window: { localStorage: storage } };
  vm.runInNewContext(fs.readFileSync(new URL('../../assets/boardprefs.js', import.meta.url), 'utf8'), ctx);
  return ctx.window.IshurBoardPrefs;
}
const memStore = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };
test('folded sections are remembered per device; blocked storage never breaks the page', () => {
  const st = memStore();
  const a = prefs(st);
  a.setClosed('sendsCard', true); a.setClosed('guestsCard', true); a.setClosed('sendsCard', false);
  assert.deepEqual([...prefs(st).closedList()], ['guestsCard'], 'a new page load on the same device reads it back');
  const thrower = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const b = prefs(thrower);
  assert.deepEqual([...b.closedList()], []);
  b.setClosed('statusCard', true);
  assert.equal(b.isClosed('statusCard'), true, 'kept in memory for this visit');
  const c = prefs({ getItem: () => 'not json', setItem() {} });
  assert.deepEqual([...c.closedList()], []);
});
test('the pick-a-date popup shows once per event and set of rounds, also without storage; "להגדיר" turns the pulse on', () => {
  const st = memStore();
  const a = prefs(st);
  assert.equal(a.pickShouldShow(TOK, ['extra']), true);
  assert.equal(a.pickShouldShow(TOK, ['extra']), false);
  assert.equal(prefs(st).pickShouldShow(TOK, ['extra']), false, 'not again on this device');
  assert.equal(a.pickShouldShow(TOK, ['extra', 'calls']), true, 'a new round to date asks again');
  assert.equal(a.pickShouldShow(TOK, []), false);
  const b = prefs({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } });
  assert.equal(b.pickShouldShow(TOK, ['extra']), true); assert.equal(b.pickShouldShow(TOK, ['extra']), false, 'blocked storage: once per visit, not on every render');
  assert.equal(a.pickPulse(TOK, ['extra']), false); a.setPickPulse(TOK, ['extra']); assert.equal(a.pickPulse(TOK, ['extra']), true);
  const dash = fs.readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
  assert.match(dash, /<script src="assets\/boardprefs\.js\?v=1"><\/script>/);
  assert.match(dash, /if \(window\.IshurTour && IshurTour\.seen && !IshurTour\.seen\('dashboard'\)\) return;/);
  assert.match(dash, /\.card\.sec-closed>:not\(\.card-h\)\{display:none!important\}/);
});
