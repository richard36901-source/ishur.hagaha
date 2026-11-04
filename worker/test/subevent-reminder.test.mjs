// node --test worker/test/subevent-reminder.test.mjs — 04/11 the ONE reminder to sub-event non-responders
// Pacer half + route with every I/O stubbed; nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueSubevents, handleSubeventRemind, handleSubeventSummary, reminderDue, ilStamp, planShabbatSend, SUB_SLICE } from '../subevent.js';
import { AUTOMATIONS, KILL_SWITCH_IDS } from '../automations-registry.js';

const SUB = 'ab699ac0-7a64-4a9a-abd3-0d541ad5041a', PARENT = '11111111-2222-4333-8444-555555555555';
const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } };
}
/* guests: 0..N-1. first send went to `firstSent` of them; `replied` of those answered; `optout` phones blocked */
function H({ guests = 60, firstSent = 50, replied = 20, optout = 0, completed = true, reminderAt = '2026-11-05T10:00', started = false,
  now = '2026-11-05T10:10', room = 230, open = true, offRem = false, offCont = false, remTplStatus = '' } = {}) {
  const rows = Array.from({ length: guests }, (_, i) => ({ phone: '9725' + String(20000000 + i), name: 'G' + i }));
  const rec = { parent: PARENT, kind: 'shabbat', template: 'ishur_shabat_hatan_zaguri_v2', name: 'שבת חתן · זגורי', created: 'x', started_at: '2026-11-04T10:00:00Z',
    ...(completed ? { completed_at: '2026-11-04T12:00:00Z' } : {}), ...(reminderAt ? { reminder_at: reminderAt } : {}), ...(started ? { reminder_started_at: 'x' } : {}),
    ...(remTplStatus ? { reminder_template: 'ishur_shabat_hatan_reminder' } : {}) };
  const init = { ['subevent:' + SUB]: JSON.stringify(rec) };
  for (let i = 0; i < firstSent; i++) init[`shsent:${SUB}:${rows[i].phone}`] = '{}';
  for (let i = 0; i < replied; i++) init[`shrsvp:${SUB}:${rows[i].phone}`] = JSON.stringify({ status: 'no_stay', n: 2, at: '2026-11-04T13:00:00Z' });
  const blocked = new Set(rows.slice(firstSent - optout, firstSent).map(r => r.phone));
  const e = { RATE: kv(init) };
  const out = { sends: [], slack: [], changes: [], used: 0, clock: now };
  const ev = Array(50).fill(''); ev[1] = PARENT; ev[6] = ilDay(new Date(Date.now() + 30 * 864e5)); ev[7] = 'כן';
  const raw = { events: { values: [ev] }, guests: { values: rows.map(r => { const g = Array(31).fill(''); g[28] = PARENT; g[3] = r.name; g[4] = r.phone; return g; }) } };
  const d = {
    isOff: async (env, id) => (offRem && id === 'subevent_reminder') || (offCont && id === 'subevent_continue'),
    sendWindowState: () => (open ? { open: true } : { open: false, why: 'evening' }), isNoContactDay: () => false, ilDate: () => ilDay(), ilNow: () => out.clock,
    kvPrefix: async (env, prefix) => Object.fromEntries([...env.RATE.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v])),
    guestCapacity: async () => ({ remaining: Math.max(0, room - out.used), limit: room, used: out.used, scope: 'guests' }),
    fetchSnapshot: async () => raw, snapshotCached: async () => raw, eventRowOf: (r, t) => r.events.values.find(x => x[1] === t), normPhone: p => String(p), cleanParam: s => s,
    phoneBlocked: async (env, p) => blocked.has(p), wrongNum: async () => false,
    templateDetails: async (env, name) => ({ status: name === 'ishur_shabat_hatan_reminder' ? remTplStatus : 'APPROVED', body: 'שלום {{1}}' }), sendingPaused: async () => false,
    sendTemplate: async (env, to, tpl, params) => { out.sends.push({ to, tpl, params }); out.used++; return { ok: true, id: 'wamid.R' + out.sends.length }; },
    noteGuestSend: async () => {}, logEvent: async () => {},
    recordChange: async (env, x) => { out.changes.push(x); return x; }, slackPost: async (env, t) => { out.slack.push(t); },
    isAdmin: (env, k) => k === 'k', okJson: (j) => new Response(JSON.stringify(j), { status: 200 }), deny: (s, error) => new Response(JSON.stringify({ ok: false, error }), { status: s }),
  };
  return { e, d, out, rows, rec: () => JSON.parse(e.RATE.m.get('subevent:' + SUB)) };
}
const req = body => new Request('https://go.ishur.io/api/subevent-remind', { method: 'POST', body: JSON.stringify({ admin_key: 'k', token: SUB, ...body }) });

test('pure: reminderDue — only from reminder_at (IL), never after completion/cancel; a started wave continues', () => {
  assert.equal(reminderDue({ reminder_at: '2026-11-05T10:00' }, '2026-11-05T09:59'), false);
  assert.equal(reminderDue({ reminder_at: '2026-11-05T10:00' }, '2026-11-04T23:00'), false);
  assert.equal(reminderDue({ reminder_at: '2026-11-05T10:00' }, '2026-11-05T10:00'), true);
  assert.equal(reminderDue({ reminder_at: '2026-11-05T10:00', reminder_completed_at: 'x' }, '2026-11-06T10:00'), false);
  assert.equal(reminderDue({ reminder_at: '2026-11-05T10:00', reminder_cancelled_at: 'x' }, '2026-11-06T10:00'), false);
  assert.equal(reminderDue({}, '2026-11-06T10:00'), false);
  assert.match(ilStamp(new Date('2026-11-05T08:00:00Z')), /^2026-11-05T10:00$/);   /* IST = UTC+2 in November */
});

test('pure plan: reminder phase sends only to first-message receivers without a reply; refuses before first send completed', () => {
  const rows = [1, 2, 3, 4].map(i => ({ phone: 'p' + i, name: 'G' + i }));
  const base = { approved: true, windowOpen: true, held: false, cancelled: false, rows, room: 10, max: 10, dry: false, phase: 'reminder', firstSent: new Set(['p1', 'p2', 'p3']), replied: new Set(['p2']) };
  const p = planShabbatSend(base);
  assert.deepEqual(p.list.map(x => x.action + ':' + x.reason), ['send:', 'skip:replied', 'send:', 'skip:no-first-message']);
  assert.equal(planShabbatSend({ ...base, firstDone: false }).why, 'first-send-not-completed');
  assert.equal(planShabbatSend({ ...base, firstDone: false, dry: true }).refuse, false);
});

test('route: when → reminder_at stored (10:00 default), nothing sent; bad date refused', async () => {
  const h = H({ reminderAt: '' });
  const r = await (await handleSubeventRemind(req({ when: '2026-11-05' }), h.e, '', h.d)).json();
  assert.equal(r.ok, true); assert.equal(r.scheduled, '2026-11-05T10:00'); assert.equal(h.rec().reminder_at, '2026-11-05T10:00');
  assert.equal(r.counts.send, 30);   /* 50 got the first message − 20 replied */
  assert.equal(h.out.sends.length, 0);
  assert.equal((await handleSubeventRemind(req({ when: '05/11' }), h.e, '', h.d)).status, 400);
  assert.equal((await handleSubeventRemind(req({ when: '2026-11-05', admin_key: 'x' }), h.e, '', h.d)).status, 403);
});

test('pacer: not before the day/hour; on the day from 10:00 → only non-responders, 25 per tick, completion + change-log + Slack', async () => {
  const h = H({ now: '2026-11-04T15:00' });
  let r = await continueSubevents(h.e, h.d);
  assert.equal(h.out.sends.length, 0); assert.equal(r.subs[0].skipped, 'not-yet');
  h.out.clock = '2026-11-05T09:50'; await continueSubevents(h.e, h.d); assert.equal(h.out.sends.length, 0);
  h.out.clock = '2026-11-05T10:00';
  const perTick = [];
  for (let i = 0; i < 5; i++) { const b = h.out.sends.length; await continueSubevents(h.e, h.d); perTick.push(h.out.sends.length - b); if (h.rec().reminder_completed_at) break; }
  assert.deepEqual(perTick, [25, 5]); assert.equal(SUB_SLICE, 25);
  const sentTo = new Set(h.out.sends.map(s => s.to));
  assert.equal(sentTo.size, 30);
  for (let i = 0; i < 20; i++) assert.ok(!sentTo.has(h.rows[i].phone), 'replied guest got a reminder');
  for (let i = 50; i < 60; i++) assert.ok(!sentTo.has(h.rows[i].phone), 'guest without the first message got a reminder');
  assert.ok(h.out.sends.every(s => s.tpl === 'ishur_shabat_hatan_zaguri_v2' && s.params.length === 1));
  const rec = h.rec(); assert.ok(rec.reminder_started_at && rec.reminder_completed_at); assert.equal(rec.reminder_sent, 30);
  assert.deepEqual(h.out.slack, ['שבת חתן · זגורי: תזכורת הושלמה, נשלחו 30']);
  assert.equal(h.out.changes.length, 1); assert.equal(h.out.changes[0].details.phase, 'reminder');
  /* idempotent: more ticks, a day later → nothing */
  h.out.clock = '2026-11-06T11:00'; await continueSubevents(h.e, h.d); assert.equal(h.out.sends.length, 30); assert.equal(h.out.slack.length, 1);
});

test('idempotent per guest: shrem marks survive a re-run; a manual start after a partial tick never double-sends', async () => {
  const h = H({ room: 10 });   /* cap room 10 → 10 this tick, held */
  await continueSubevents(h.e, h.d); assert.equal(h.out.sends.length, 10); assert.ok(!h.rec().reminder_completed_at);
  const r = await (await handleSubeventRemind(req({ dry: false, max: 500 }), h.e, '', h.d)).json();
  assert.equal(r.counts.sent, 0);   /* cap used up */
  const first = new Set(h.out.sends.map(s => s.to)); assert.equal(first.size, 10);
  const marks = [...h.e.RATE.m.keys()].filter(k => k.startsWith('shrem:')); assert.equal(marks.length, 10);
});

test('gates: opted-out skipped; cap 0 held; window closed; kill switches; first send not completed → refused', async () => {
  const o = H({ optout: 5 }); for (let i = 0; i < 3; i++) await continueSubevents(o.e, o.d);
  assert.equal(o.out.sends.length, 25); assert.equal(o.rec().reminder_sent, 25);
  const c = H({ room: 0 }); const rc = await continueSubevents(c.e, c.d); assert.equal(rc.subs[0].held, 'cap'); assert.equal(c.out.sends.length, 0);
  const w = H({ open: false }); assert.equal((await continueSubevents(w.e, w.d)).skipped, 'window-closed'); assert.equal(w.out.sends.length, 0);
  const k = H({ offRem: true }); const rk = await continueSubevents(k.e, k.d); assert.equal(rk.subs[0].skipped, 'off:subevent_reminder'); assert.equal(k.out.sends.length, 0);
  const k2 = H({ offCont: true }); await continueSubevents(k2.e, k2.d); assert.equal(k2.out.sends.length, 0);
  assert.equal((await handleSubeventRemind(req({ dry: false }), k.e, '', k.d)).status, 423);
  /* first send still running → the pacer keeps doing the FIRST send, the reminder never starts */
  const n = H({ completed: false, firstSent: 50 });
  const rr = await (await handleSubeventRemind(req({ dry: false }), n.e, '', n.d)).json(); assert.equal(rr.refused, 'first-send-not-completed'); assert.equal(n.out.sends.length, 0);
  await continueSubevents(n.e, n.d);   /* this tick finishes the first send (10 left) and only then marks it completed */
  assert.equal(n.out.sends.length, 10); assert.ok(n.out.sends.every(s => !n.e.RATE.m.has(`shrem:${SUB}:${s.to}`))); assert.ok(!n.rec().reminder_started_at);
  assert.ok(n.rec().completed_at);
  await continueSubevents(n.e, n.d);   /* next tick: the reminder (due) starts */
  assert.ok(n.rec().reminder_started_at);
});

test('reminder template: used only once APPROVED, else the original template', async () => {
  const p = H({ remTplStatus: 'PENDING' }); await continueSubevents(p.e, p.d);
  assert.ok(p.out.sends.every(s => s.tpl === 'ishur_shabat_hatan_zaguri_v2'));
  const a = H({ remTplStatus: 'APPROVED' }); await continueSubevents(a.e, a.d);
  assert.ok(a.out.sends.length && a.out.sends.every(s => s.tpl === 'ishur_shabat_hatan_reminder'));
});

test('summary: reminder state + masked phones + reply time for the dashboard', async () => {
  const h = H();
  let j = await (await handleSubeventSummary(new Request('https://go.ishur.io/api/subevent-summary?token=' + SUB), h.e, '', h.d)).json();
  assert.deepEqual(j.subevent.reminder, { at: '2026-11-05T10:00', started_at: '', completed_at: '', sent: 0 });
  const g = j.subevent.guests[0]; assert.match(g.phone, /^\d{3}-\*{4}-\d{3}$/); assert.equal(g.at, '2026-11-04T13:00:00Z');
  for (let i = 0; i < 3; i++) await continueSubevents(h.e, h.d);
  j = await (await handleSubeventSummary(new Request('https://go.ishur.io/api/subevent-summary?token=' + SUB), h.e, '', h.d)).json();
  assert.equal(j.subevent.reminder.sent, 30); assert.ok(j.subevent.reminder.completed_at);
});

test('registry: subevent_reminder node + kill switch', () => {
  const n = AUTOMATIONS.find(x => x.id === 'subevent_reminder'); assert.ok(n); assert.equal(n.kind, 'send_guest');
  assert.ok(KILL_SWITCH_IDS.includes('subevent_reminder'));
});
