/* 25/11/2026: the future log (planned sends / calls, live calls) and the guest card. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { markKeys, skipKey, templateOf, nextCallAt, callRoundDay, whenHe, buildFuture, buildLive, handleFutureLog } from '../future-log.js';
import { handleGuestCard, doneHe, ACTIONS } from '../guest-card.js';
import { buildCallQueue, planKeyOf } from '../dashboard.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m,
    get: async k => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }) };
}
const ilDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const add = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const TODAY = ilDate();
const TOK = 'abcdef12-0000-4000-8000-000000000000';
function evRow({ date = add(TODAY, 6), w1 = add(TODAY, 1), w2 = '', plan = 'הכל כלול', time = '19:30' } = {}) {
  const r = new Array(46).fill('');
  r[1] = TOK; r[2] = 'לקוח'; r[5] = 'חתונה'; r[6] = date; r[7] = 'כן'; r[31] = plan; r[34] = 'דנה ויוסי'; r[36] = time; r[39] = w1; r[40] = w2; r[43] = 'כן';
  return r;
}
function gRow(id, name, phone, { rsvp = '', call = '', tries = 0, table = '' } = {}) {
  const r = new Array(32).fill(''); r[2] = id; r[3] = name; r[4] = phone; r[5] = '2'; r[15] = rsvp; r[21] = call; r[28] = TOK; r[29] = String(tries); r[30] = table; return r;
}
const RAW = () => ({ events: { values: [evRow()] }, guests: { values: [
  gRow('g1', 'דנה כהן', '972501111111', { call: 'נדרשת שיחה' }), gRow('g2', 'אבי לוי', '972502222222'), gRow('g3', 'רון', '972503333333'), gRow('g4', 'לא בא', '972504444444', { rsvp: 'לא מגיע' }),
  gRow('g5', 'מגיעה', '972505555555', { rsvp: 'מגיע' }) ] } });
const OPEN = () => ({ open: true });
function deps(raw, extra = {}) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  return { okJson: (o) => json(o), deny: (st, err) => json({ ok: false, error: err }, st), adminKeyOk: async (e, k) => k === 'k', ilDate: () => TODAY,
    isNoContactDay: () => false, callWindowState: OPEN, buildCallQueue, planKeyOf, isTestEventRow: () => false,
    kvPrefix: async (env, pre) => Object.fromEntries([...env.RATE.m.keys()].filter(k => k.startsWith(pre)).map(k => [k.slice(pre.length), env.RATE.m.get(k)])),
    snapshotCached: async () => raw, readSnapshot: async () => raw, auditQuery: async () => [], logEvent: async (e, r) => { (extra.log = extra.log || []).push(r); }, ...extra };
}
const post = (body) => new Request('https://go.ishur.io/api/x', { method: 'POST', body: JSON.stringify({ admin_key: 'k', ...body }) });

test('pure: the per-guest marks, the skip key, the templates, the call round day', () => {
  assert.deepEqual(markKeys('w1', TOK, '0501111111'), [`wsent:${TOK}:1:972501111111`, `wdead:${TOK}:1:972501111111`]);
  assert.equal(skipKey('w2', TOK, '972501111111'), `wsent:${TOK}:2:972501111111`);
  assert.equal(skipKey('eventday', TOK, '972501111111'), `ed:${TOK}:972501111111`);
  assert.equal(skipKey('daybefore', TOK, '972501111111'), `s5d:${TOK}:972501111111`);
  assert.equal(templateOf('w1', { invite: 'ishur_c_abcdef12_1' }), 'ishur_c_abcdef12_1');
  assert.equal(templateOf('daybefore', {}), 'ishur_lifnei_combo_n');
  assert.equal(templateOf('thanks'), 'ishur_toda_orach');
  assert.equal(callRoundDay({ 1: '2026-11-24', 2: '2026-11-26', 3: '' }), '2026-11-29', 'Thursday +1 = Friday → Sunday');
  assert.equal(callRoundDay({ 1: '', 2: '', 3: '' }), '');
});

test('nextCallAt: the first open minute, not today when already tried today', () => {
  const now = Date.parse('2026-11-25T08:03:00Z');   /* 10:03 Israel */
  const win = d => ({ open: (d.getUTCHours() + 2) >= 10 && (d.getUTCHours() + 2) < 20 });
  assert.equal(new Date(nextCallAt({ now, callWindowState: win })).toISOString(), '2026-11-25T08:10:00.000Z');
  const t = nextCallAt({ now, triedToday: true, callWindowState: win });
  assert.equal(new Date(t).toISOString(), '2026-11-26T08:00:00.000Z');
  assert.equal(whenHe(t, now), 'מחר 10:00');
  assert.equal(nextCallAt({ now, callWindowState: () => ({ open: false }), horizonDays: 1 }), null);
});

test('buildFuture: upper bound across events, exact per guest for one event; calls queue + next ring', async () => {
  const raw = RAW();
  const env = { RATE: kv({ ['optout:972502222222']: '1', [`wsent:${TOK}:1:972503333333`]: '1' }) };
  const all = await buildFuture(env, deps(raw), { days: 14 });
  assert.equal(all.ok, true);
  const w1 = all.sends.find(s => s.type === 'w1');
  assert.equal(w1.count, 4, 'upper bound: everyone not declined'); assert.equal(w1.exact, false);
  assert.equal(w1.day, add(TODAY, 1)); assert.equal(w1.template, 'hazmana_ishur');
  assert.ok(all.sends.some(s => s.type === 'daybefore' && s.day === add(TODAY, 5)));
  const one = await buildFuture(env, deps(raw), { days: 14, token: TOK });
  const w1x = one.sends.find(s => s.type === 'w1');
  assert.equal(w1x.count, 2, 'one opted out, one already sent'); assert.equal(w1x.exact, true);
  const c = one.calls.find(x => x.token === TOK);
  assert.equal(c.queued, 1); assert.ok(c.next_at); assert.equal(c.guests[0].name, 'דנה כהן');
  env.RATE.m.set('hold:' + TOK, '1');
  const held = await buildFuture(env, deps(raw), { days: 14, token: TOK });
  assert.equal(held.calls.find(x => x.token === TOK).next_at, null);
  assert.match(held.calls.find(x => x.token === TOK).blocked_he, /מוקפא/);
});

test('/api/future-log: admin only; live = Retell ongoing calls + the newest audit calls', async () => {
  const raw = RAW();
  const env = { RATE: kv({ ['evmeta:' + TOK]: JSON.stringify({ event: 'החתונה של דנה ויוסי' }), ['gmap:' + TOK]: JSON.stringify({ '972501111111': { name: 'דנה כהן', id: 'g1' } }) }), RETELL_KEY: 'x' };
  assert.equal((await handleFutureLog(new Request('https://x', { method: 'POST', body: JSON.stringify({ admin_key: 'bad' }) }), env, '', deps(raw))).status, 403);
  const d = deps(raw, {
    retellListCalls: async () => [{ call_id: 'call_a', call_status: 'ongoing', to_number: '+972501111111', start_timestamp: Date.now() - 42000, metadata: { guest_id: 'g1', token: TOK } }, { call_id: 'call_b', call_status: 'ended' }],
    auditQuery: async () => [{ kind: 'call', ts: Date.now() - 6e4, phone: '972501111111', token: TOK, detail: 'Agent: שלום', data: { call_id: 'call_z', outcome: 'מגיע', duration_s: 40, recording: '/rec/call_z', recording_name: 'z.wav', guest_id: 'g1' } }] });
  const j = await (await handleFutureLog(post({ action: 'live' }), env, '', d)).json();
  assert.equal(j.in_progress.length, 1);
  assert.equal(j.in_progress[0].guest, 'דנה כהן'); assert.equal(j.in_progress[0].event, 'החתונה של דנה ויוסי'); assert.ok(j.in_progress[0].seconds >= 42);
  assert.ok(j.recent.length >= 1); assert.equal(j.recent[0].call_id, 'call_z'); assert.equal(j.recent[0].has_recording, true);
  assert.equal(typeof (await buildLive({ RATE: kv() }, deps(raw))).ok, 'boolean');
});

test('guest card: read shows messages, planned sends, the next call and the stops', async () => {
  const raw = RAW();
  const env = { RATE: kv({ 'log:972501111111:1700000000000': JSON.stringify({ dir: 'out', type: 'template', text: 'הזמנה' }), 'log:972501111111:1700000100000': JSON.stringify({ dir: 'in', text: 'מגיעים 2' }) }) };
  const j = await (await handleGuestCard(post({ token: TOK, guest_id: 'g1' }), env, '', deps(raw))).json();
  assert.equal(j.ok, true); assert.equal(j.guest.name, 'דנה כהן');
  assert.equal(j.whatsapp.length, 2); assert.equal(j.whatsapp[1].dir, 'in');
  assert.equal(j.planned.sends[0].type, 'w1');
  assert.equal(j.planned.call.in_queue, true); assert.ok(j.planned.call.next_at);
  assert.equal(j.stops.block, false);
  assert.equal(j.planned.sends[0].skip_key, undefined, 'internal keys stay inside');
  assert.equal((await handleGuestCard(post({ token: TOK, guest_id: 'nope' }), env, '', deps(raw))).status, 404);
});

test('guest card actions reuse the existing marks, never overwrite a real one, and are all logged', async () => {
  const raw = RAW(); const extra = {};
  const env = { RATE: kv() };
  const act = async (body) => handleGuestCard(post({ token: TOK, guest_id: 'g1', ...body }), env, '', deps(raw, extra));
  let r = await (await act({ action: 'cancel_send' })).json();
  assert.equal(r.ok, true); assert.match(r.done_he, /^ביטול ההזמנה \(\d\d\/\d\d\) לדנה כהן$/);
  assert.equal(env.RATE.m.get(`wsent:${TOK}:1:972501111111`), 'skip');
  r = await (await act({})).json();
  assert.ok(!r.planned.sends.some(s => s.type === 'w1'), 'the invitation is no longer planned');
  assert.deepEqual(r.stops.skips, [{ type: 'w1' }]);
  r = await (await act({ action: 'undo_send', type: 'w1' })).json();
  assert.equal(r.ok, true); assert.equal(env.RATE.m.has(`wsent:${TOK}:1:972501111111`), false);
  env.RATE.m.set(`wsent:${TOK}:1:972501111111`, '1');
  assert.equal((await act({ action: 'undo_send', type: 'w1' })).status, 409, 'a real "sent" mark is never removed');
  env.RATE.m.delete(`wsent:${TOK}:1:972501111111`);
  r = await (await act({ action: 'cancel_call' })).json();
  assert.equal(r.ok, true); assert.match(r.done_he, /^ביטול השיחה הבאה/);
  assert.ok([...env.RATE.m.entries()].some(([k, v]) => k.startsWith('shirtry:g1:') && v === 'skip'));
  r = await (await act({ action: 'undo_call' })).json(); assert.equal(r.ok, true);
  r = await (await act({ action: 'stop_event' })).json();
  assert.equal(r.done_he, 'עצירת כל ההודעות והשיחות לדנה כהן באירוע הזה');
  assert.ok(env.RATE.m.get(`wrong:${TOK}:972501111111`));
  r = await (await act({})).json();
  assert.equal(r.planned.call.next_at, null, 'no call once stopped for the event'); assert.match(r.planned.call.blocked_he, /לא לשלוח/);
  r = await (await act({ action: 'stop_all' })).json();
  assert.ok(env.RATE.m.get('block:972501111111'));
  await act({ action: 'resume_all' }); await act({ action: 'resume_event' });
  assert.equal(env.RATE.m.has('block:972501111111'), false); assert.equal(env.RATE.m.has(`wrong:${TOK}:972501111111`), false);
  assert.equal((await act({ action: 'delete_everything' })).status, 400);
  assert.equal(extra.log.length, 8, 'every successful action wrote a journal line (the two refusals did not)');
  assert.ok(extra.log.every(l => l.area === 'כרטיס אורח' && l.action));
  assert.ok(!extra.log.some(l => /972501111111/.test(l.detail)), 'the phone is masked in the detail');
});

test('doneHe covers every action; the routes are wired', () => {
  for (const a of ACTIONS) assert.ok(doneHe(a, { name: 'דנה' }));
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("url.pathname === '/api/future-log' && request.method === 'POST'"));
  assert.ok(src.includes("url.pathname === '/api/guest-card' && request.method === 'POST'"));
});

test('pages: our player replaces <audio controls>; the guest card opens from answers, the live log and the future page', () => {
  const rd = p => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  const ans = rd('answers.html'), live = rd('next/live.html'), fut = rd('next/future.html'), rp = rd('assets/rec-player.js'), gc = rd('assets/guest-card.js');
  for (const h of [ans, live, fut]) { assert.ok(h.includes('rec-player.js')); assert.ok(h.includes('guest-card.js')); }
  assert.ok(!/<audio controls/.test(ans), 'answers.html has no browser player any more');
  assert.ok(ans.includes('data-guest-card data-token='));
  assert.ok(live.includes('data-guest-card data-token='));
  assert.ok(fut.includes("ISHUR_CONFIG.endpoint('future-log')"));
  for (const w of ['rp-play', 'type="range"', 'rp-sp', 'rp-dl', "'X-Admin-Key'", '[1, 1.5, 2]']) assert.ok(rp.includes(w), w);
  assert.ok(!/[?&](key|admin_key)=/.test(rp), 'the key never rides in a URL');
  for (const a of ['cancel_send', 'cancel_call', 'stop_event', 'stop_all', 'undo_send', 'undo_call', 'resume_event', 'resume_all']) assert.ok(gc.includes(a), a);
  assert.ok(gc.includes("endpoint('guest-card')"));
});
