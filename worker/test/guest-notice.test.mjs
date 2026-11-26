/* 26/11/2026 track-cancel: the client's cancel / postpone notice to the guests (guest-notice.js + client-stop.js) */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cancelLocked, NOTICE_TEMPLATES, NOTICE_NAMES, slotError, slotOptions, renderNotice, noticeParams, noticeVars, newDateError, invitedGuests,
  handleNoticePreview, handleNoticeSchedule, handleNoticeCancel, runGuestNotices, publicNotice, isFinal, bodyMatches, INDEX_KEY, TERMS_LINES } from '../guest-notice.js';
import { validateStop, handleClientStop, handleClientStopLift, publicStop } from '../client-stop.js';

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
const NOW = { day: '2026-11-26', hm: '10:15' };   /* a Thursday */
const ORIG = '2026-12-10';
const noHoliday = () => false;

/* guest rows: [3]=name [4]=phone [8..10]=wave stamps [15]=answer [28]=token */
function g(name, phone, { stamp = '', answer = '', token = TOK } = {}) { const r = new Array(29).fill(''); r[3] = name; r[4] = phone; r[8] = stamp; r[15] = answer; r[28] = token; return r; }
const GUESTS = [
  g('דנה', '0501111111', { stamp: '2026-11-20 09:03' }),
  g('', '0502222222', { stamp: '2026-11-20 09:03' }),           /* no name → the _nn twin */
  g('יוסי', '0503333333', { answer: 'מגיע' }),                   /* answered → invited */
  g('לא הוזמן', '0504444444'),                                   /* never invited → never told */
  g('דנה כפולה', '050-111-1111', { stamp: 'x' }),                /* the same phone twice → once */
  g('אחר', '0505555555', { stamp: 'x', token: '99999999-2222-3333-4444-555555555555' }),
  g('חסום', '0506666666', { stamp: 'x' }),
];
const norm = p => { const d = String(p || '').replace(/\D/g, ''); return d.startsWith('0') ? '972' + d.slice(1) : d; };
function facts(over = {}) {
  return { ev: [], gRows: GUESTS, plan: 'premium', addon: { cancel: false, postpone: false }, eventName: 'החתונה של דנה ויוסי', origDate: ORIG, sentPhones: new Set(), ...over };
}
function deps(over = {}) {
  const slack = [], logs = [];
  const d = { okJson, deny, tokenRecord: async (e, t) => (t === TOK ? {} : null), overBudget: async () => false, isAdmin: async (e, k) => k === 'K',
    logEvent: async (e, x) => { logs.push(x); }, slackSend: async (e, t) => { slack.push(t); }, now: () => NOW, noContact: noHoliday, normPhone: norm,
    eventFacts: async () => facts(), templateApproved: async () => true, ...over };
  d.slack = slack; d.logs = logs;
  return d;
}
const stopRec = (o = {}) => JSON.stringify({ at: '2026-11-26T08:00:00Z', mode: 'cancel', reason: 'cancelled', note: NOTE, ...o });
const SCHED = { token: TOK, kind: 'cancel', day: '2026-11-29', hm: '10:00', confirm: 'שלח', terms: true };   /* Sunday 10:00 */

/* ── the slot rules ── */
test('slot: future only, 09:00–18:30 Sun–Thu, Friday until 12:30, never Saturday, never a holiday, never after the event', () => {
  const o = { now: NOW, origDate: ORIG, noContact: noHoliday };
  assert.equal(slotError('2026-11-29', '10:00', o), '');
  assert.equal(slotError('2026-11-29', '18:30', o), '', 'last slot before the 19:00 close');
  assert.equal(slotError('2026-11-29', '19:00', o), 'quiet-hours');
  assert.equal(slotError('2026-11-29', '08:30', o), 'quiet-hours');
  assert.equal(slotError('2026-11-29', '21:00', o), 'quiet-hours');
  assert.equal(slotError('2026-11-29', '10:15', o), 'bad-hour', 'half-hour steps only');
  assert.equal(slotError('2026-11-27', '12:30', o), '', 'Friday morning');
  assert.equal(slotError('2026-11-27', '13:00', o), 'friday-hours');
  assert.equal(slotError('2026-11-28', '10:00', o), 'shabbat');
  assert.equal(slotError('2026-11-26', '10:00', o), 'not-future', 'earlier today');
  assert.equal(slotError('2026-11-26', '10:15', o), 'bad-hour');
  assert.equal(slotError('2026-11-26', '10:30', o), '', 'later today is fine');
  assert.equal(slotError('2026-11-25', '12:00', o), 'not-future');
  assert.equal(slotError('2026-12-11', '10:00', o), 'after-event');
  assert.equal(slotError('2026-12-10', '10:00', o), '', 'the event day itself, morning');
  assert.equal(slotError('2026-11-30', '10:00', { ...o, noContact: d => d === '2026-11-30' }), 'no-contact-day');
  assert.equal(slotError('x', '10:00', o), 'bad-day');
  assert.equal(slotError('2026-11-29', '9:00', o), 'bad-hour');
});
test('slot options: what the board offers obeys the same rule (no Saturday, nothing past, nothing after the event)', () => {
  const s = slotOptions({ now: NOW, origDate: ORIG, noContact: noHoliday });
  assert.equal(s[0].day, '2026-11-26'); assert.equal(s[0].hours[0], '10:30');
  assert.ok(!s.some(x => x.day === '2026-11-28'), 'no Saturday');
  assert.equal(s.find(x => x.day === '2026-11-27').hours.at(-1), '12:30');
  assert.equal(s.at(-1).day, ORIG);
  for (const x of s) for (const h of x.hours) assert.equal(slotError(x.day, h, { now: NOW, origDate: ORIG, noContact: noHoliday }), '');
});

/* ── the exact wording ── */
test('wording: fixed text, the guest\'s name or the no-name twin, never an empty variable', () => {
  const v = noticeVars({ kind: 'postpone', eventName: 'החתונה של דנה ויוסי', origDate: ORIG, newDate: '2027-01-14' });
  assert.deepEqual(v, { event: 'החתונה של דנה ויוסי', orig: '10.12.2026', neu: '14.01.2027' });
  assert.equal(renderNotice('postpone', v, 'רון'), 'שלום רון,\nאנחנו מעדכנים בשם בעלי השמחה על דחיית האירוע.\nהאירוע: החתונה של דנה ויוסי\nהמועד הקודם: 10.12.2026\nהמועד החדש: 14.01.2027\nנשמח לראותכם במועד החדש. תודה רבה על ההבנה.');
  assert.ok(renderNotice('cancel', v, '').startsWith('שלום,\n'));
  assert.deepEqual(noticeParams('cancel', v, ''), { template: 'ishur_event_cancelled_nn', params: ['החתונה של דנה ויוסי', '10.12.2026'] });
  assert.deepEqual(noticeParams('cancel', v, '  רון  '), { template: 'ishur_event_cancelled', params: ['רון', 'החתונה של דנה ויוסי', '10.12.2026'] });
  for (const k of ['cancel', 'postpone']) {
    const T = NOTICE_TEMPLATES[k];
    assert.equal((T.body.match(/\{\{\d\}\}/g) || []).length, noticeParams(k, v, 'x').params.length);
    assert.equal((T.body_nn.match(/\{\{\d\}\}/g) || []).length, noticeParams(k, v, '').params.length);
    assert.ok(noticeParams(k, v, '').params.every(Boolean) && noticeParams(k, v, 'x').params.every(Boolean));
  }
  assert.equal(noticeVars({ kind: 'cancel', eventName: '', origDate: ORIG }).event, 'האירוע');
  assert.deepEqual(NOTICE_NAMES, ['ishur_event_cancelled', 'ishur_event_cancelled_nn', 'ishur_event_postponed', 'ishur_event_postponed_nn']);
  assert.ok(bodyMatches(NOTICE_TEMPLATES.cancel.body, NOTICE_TEMPLATES.cancel.body + '\n'));
  assert.ok(!bodyMatches(NOTICE_TEMPLATES.cancel.body, NOTICE_TEMPLATES.cancel.body.replace('תודה', 'תודה!')));
});
test('docs/NOTICE-TEMPLATES.md carries every body exactly as the sender uses it, and the terms lines exist', () => {
  const md = fs.readFileSync(new URL('../../docs/NOTICE-TEMPLATES.md', import.meta.url), 'utf8');
  for (const T of Object.values(NOTICE_TEMPLATES)) { assert.ok(md.includes(T.body), T.name); assert.ok(md.includes(T.body_nn), T.nn); assert.ok(md.includes(T.name) && md.includes(T.nn)); }
  assert.ok(TERMS_LINES.length >= 3);
  const terms = fs.readFileSync(new URL('../../terms.html', import.meta.url), 'utf8');
  assert.match(terms, /ביטול, דחייה או שינוי של האירוע אינם מזכים בהחזר/, 'the board quotes only what the published terms say');
  assert.match(terms, /הודעה שכבר יצאה אינה ניתנת לביטול או לשינוי/);
});
test('audience: everyone invited (stamp, wsent marker or an answer), once per phone, this event only', () => {
  const inv = invitedGuests(GUESTS, TOK, { normPhone: norm, sentPhones: new Set(['972504444444']) });
  assert.deepEqual(inv.map(x => x.phone), ['972501111111', '972502222222', '972503333333', '972504444444', '972506666666']);
  assert.equal(invitedGuests(GUESTS, TOK, { normPhone: norm }).length, 4, 'without the wsent marker the uninvited guest stays out');
});

/* ── the postpone mode of the stop ── */
test('stop: "דחייה" is a mode of its own and needs a future, non-Saturday new date', () => {
  const b = { reason: 'postponed', note: NOTE, confirm: 'דחייה' };
  assert.equal(validateStop(b, { today: NOW.day }).error, 'bad-new-date');
  assert.equal(validateStop({ ...b, new_date: '2026-11-26' }, { today: NOW.day }).error, 'new-date-not-future');
  assert.equal(validateStop({ ...b, new_date: '2027-01-16' }, { today: NOW.day }).error, 'new-date-shabbat');
  const v = validateStop({ ...b, new_date: '2027-01-14' }, { today: NOW.day });
  assert.equal(v.mode, 'postpone'); assert.equal(v.new_date, '2027-01-14');
  assert.equal(newDateError('2027-01-14', NOW.day), '');
  assert.equal(publicStop({ mode: 'postpone', new_date: '2027-01-14', reason: 'postponed' }).mode, 'postpone');
});
test('stop: the postpone stop freezes the same keys, records the new date and writes no notice', async () => {
  const RATE = kv(); const slack = [];
  const d = { okJson, deny, tokenRecord: async (e, t) => (t === TOK ? {} : null), overBudget: async () => false, logEvent: async () => {}, slackSend: async (e, t) => { slack.push(t); }, eventName: async () => 'דנה ויוסי' };
  const r = await handleClientStop(req({ token: TOK, reason: 'postponed', note: NOTE, confirm: 'דחייה', new_date: '2099-01-14', terms: true }), { RATE }, '', d);
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.stop.mode, 'postpone'); assert.equal(j.stop.new_date, '2099-01-14'); assert.equal(j.stop.notice, undefined);
  assert.deepEqual([...RATE.m.keys()].sort(), ['callstop:', 'clientstop:', 'hold:', 'sendsoff:'].map(k => k + TOK).sort(), 'no notice, no index');
  assert.match(slack[0], /לדחות את האירוע ל-14\.01\.2099/); assert.match(slack[0], /לא נשלחה הודעת דחייה/);
});

/* ── the schedule route ── */
test('schedule: typed "שלח", the terms box, a stop first, the right kind, the package and an invited guest are all required', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() });
  const st = async (b, d = deps()) => { const r = await handleNoticeSchedule(req(b), { RATE }, '', d); return { status: r.status, j: await r.json() }; };
  assert.equal((await st({ ...SCHED, confirm: 'כן' })).j.error, 'bad-confirm');
  assert.equal((await st({ ...SCHED, confirm: '' })).j.error, 'bad-confirm');
  assert.equal((await st({ ...SCHED, terms: false })).j.error, 'terms-not-accepted');
  assert.equal((await st({ ...SCHED, terms: 'true' })).j.error, 'terms-not-accepted', 'a real boolean, not a string');
  assert.equal((await st({ ...SCHED, kind: 'postpone' })).j.error, 'kind-mismatch');
  assert.equal((await st({ ...SCHED, token: 'nope' })).status, 404);
  assert.equal((await st(SCHED, deps({ eventFacts: async () => facts({ plan: 'pro' }) }))).j.error, 'not-in-package');
  assert.equal((await st(SCHED, deps({ eventFacts: async () => facts({ gRows: [g('x', '0501111111')] }) }))).j.error, 'nobody-invited');
  assert.equal((await st({ ...SCHED, day: '2026-11-26', hm: '09:00' })).j.error, 'not-future');
  assert.equal((await st({ ...SCHED, hm: '19:00' })).j.error, 'quiet-hours');
  assert.equal((await st({ ...SCHED, day: '2026-11-28' })).j.error, 'shabbat');
  assert.ok(!JSON.parse(RATE.m.get('clientstop:' + TOK)).notice, 'nothing was written by a refused call');
  assert.ok(!RATE.m.has(INDEX_KEY));
  /* the paid add-on opens it on a plan without it */
  const ok = await st(SCHED, deps({ eventFacts: async () => facts({ plan: 'basic', addon: { cancel: true } }) }));
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.notice.status, 'scheduled'); assert.equal(ok.j.notice.total, 4); assert.equal(ok.j.notice.final, false);
  assert.match(ok.j.notice.label_he, /מתוזמנת ל-29\.11\.2026 בשעה 10:00/);
  assert.deepEqual(JSON.parse(RATE.m.get(INDEX_KEY)), [TOK]);
  const rec = JSON.parse(RATE.m.get('clientstop:' + TOK));
  assert.equal(rec.mode, 'cancel', 'the stop itself is untouched'); assert.equal(rec.notice.confirm, 'שלח'); assert.ok(rec.notice.terms_at);
  assert.equal((await st(SCHED)).j.error, 'notice-scheduled', 'one at a time: cancel first to change it');
});
test('schedule: refused without a stop; the stop route without a notice stays the no-notice path', async () => {
  const RATE = kv();
  const r = await handleNoticeSchedule(req(SCHED), { RATE }, '', deps());
  assert.equal(r.status, 409); assert.equal((await r.json()).error, 'not-stopped');
  assert.equal(RATE.m.size, 0);
});
test('preview: the exact bubble, the slots, the terms and whether the package includes it', async () => {
  const RATE = kv();
  const r = await handleNoticePreview(req({ token: TOK, kind: 'postpone', new_date: '2027-01-14' }), { RATE }, '', deps({ templateApproved: async () => false }));
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.eligible, true); assert.equal(j.invited_n, 4); assert.equal(j.named_n, 3); assert.equal(j.approved, false);
  assert.match(j.text, /המועד החדש: 14\.01\.2027/); assert.ok(j.text_nn.startsWith('שלום,'));
  assert.equal(j.confirm_word, 'שלח'); assert.ok(j.terms.url.includes('terms.html'));
  assert.ok(j.slots.length && !j.slots.some(s => s.day === '2026-11-28'));
  const r2 = await handleNoticePreview(req({ token: TOK, kind: 'cancel' }), { RATE }, '', deps({ eventFacts: async () => facts({ plan: 'pro' }) }));
  const j2 = await r2.json(); assert.equal(j2.eligible, false); assert.equal(j2.why, 'not-in-package');
  const r3 = await handleNoticePreview(req({ token: TOK, kind: 'postpone', new_date: '2026-11-20' }), { RATE }, '', deps());
  assert.equal(r3.status, 422);
});

/* ── the sender ── */
function sender(RATE, over = {}) {
  const sends = [];
  const d = deps({ sendWindowState: () => ({ open: true }), guestCapacity: async () => ({ remaining: 200 }), pace: 50,
    phoneBlocked: async (e, p) => p === '972506666666', wrongNum: async () => false,
    templateBody: async (e, n) => (n.endsWith('_nn') ? Object.values(NOTICE_TEMPLATES).find(t => t.nn === n).body_nn : Object.values(NOTICE_TEMPLATES).find(t => t.name === n).body),
    sendTemplate: async (e, to, name, params, img, lang, ch) => { sends.push({ to, name, params, ch, status: JSON.parse(RATE.m.get('clientstop:' + TOK)).notice.status }); return { ok: true, id: 'w' + sends.length }; },
    ...over });
  d.sends = sends; return d;
}
async function scheduled(RATE, b = SCHED) { const r = await handleNoticeSchedule(req(b), { RATE }, '', deps()); assert.equal(r.status, 200); }

test('sender: waits for its time, for the window, for 19:00 and for the cap', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  let d = sender(RATE);   /* NOW is before 29.11 10:00 */
  assert.equal((await runGuestNotices({ RATE }, d)).events[0].waiting, 'time');
  const due = { day: '2026-11-29', hm: '10:10' };
  d = sender(RATE, { now: () => due, sendWindowState: () => ({ open: false }) });
  assert.equal((await runGuestNotices({ RATE }, d)).events[0].waiting, 'window');
  d = sender(RATE, { now: () => ({ day: '2026-11-29', hm: '19:05' }) });
  assert.equal((await runGuestNotices({ RATE }, d)).events[0].waiting, 'window', 'never after 19:00 even if the window says open');
  d = sender(RATE, { now: () => due, noContact: () => true });
  assert.equal((await runGuestNotices({ RATE }, d)).events[0].waiting, 'window');
  d = sender(RATE, { now: () => due, guestCapacity: async () => ({ remaining: 0 }) });
  assert.equal((await runGuestNotices({ RATE }, d)).events[0].waiting, 'cap');
  assert.equal(d.sends.length, 0);
  assert.equal(JSON.parse(RATE.m.get('clientstop:' + TOK)).notice.status, 'scheduled');
});
test('sender: until Meta approved both twins — and with exactly the wording the client saw — nothing leaves ("ממתין לאישור הנוסח")', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  const due = () => ({ day: '2026-11-29', hm: '10:10' });
  let d = sender(RATE, { now: due, templateApproved: async (e, n) => n === 'ishur_event_cancelled' });
  assert.equal((await runGuestNotices({ RATE }, d)).events[0].waiting, 'template');
  assert.equal(d.sends.length, 0); assert.equal(d.slack.length, 1);
  const n = JSON.parse(RATE.m.get('clientstop:' + TOK)).notice;
  assert.equal(n.wait, 'template');
  assert.match(publicNotice(n).label_he, /ממתין לאישור הנוסח/);
  assert.match(publicNotice(n, { approved: false }).label_he, /ממתין לאישור הנוסח/);
  assert.doesNotMatch(publicNotice(n, { approved: true }).label_he, /ממתין/);
  await runGuestNotices({ RATE }, d); assert.equal(d.slack.length, 1, 'one alert, not one per tick');
  d = sender(RATE, { now: due, templateBody: async () => 'נוסח אחר {{1}}' });
  assert.equal((await runGuestNotices({ RATE }, d)).events[0].waiting, 'wording');
  assert.equal(d.sends.length, 0);
});
test('sender: FINAL before the first message, every invited guest once on the guest numbers, the no-name twin, then sent', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  const d = sender(RATE, { now: () => ({ day: '2026-11-29', hm: '10:10' }) });
  const r = await runGuestNotices({ RATE }, d);
  assert.equal(r.events[0].done, true, JSON.stringify(r));
  assert.equal(d.sends[0].status, 'sending', 'the record said "sending" before the first send');
  assert.deepEqual(d.sends.map(s => s.to), ['972501111111', '972502222222', '972503333333'], 'not the uninvited, not the other event, not the blocked one, the duplicate once');
  assert.ok(d.sends.every(s => s.ch === 'guests'));
  assert.equal(d.sends[1].name, 'ishur_event_cancelled_nn'); assert.deepEqual(d.sends[1].params, ['החתונה של דנה ויוסי', '10.12.2026']);
  assert.equal(d.sends[0].name, 'ishur_event_cancelled'); assert.equal(d.sends[0].params[0], 'דנה');
  const n = JSON.parse(RATE.m.get('clientstop:' + TOK)).notice;
  assert.equal(n.status, 'sent'); assert.equal(n.sent_n, 3); assert.equal(n.skipped_n, 1); assert.ok(isFinal(n));
  assert.match(publicNotice(n).label_he, /נשלחה לאורחים ב-.* · לא ניתן לבטל/);
  assert.deepEqual(JSON.parse(RATE.m.get(INDEX_KEY)), []);
  assert.ok(RATE.m.has('cancelmsg:' + TOK), 'the engine\'s old ishur_bitul can never follow');
  await runGuestNotices({ RATE }, d); assert.equal(d.sends.length, 3, 'nothing twice');
});
test('sender: the pace and the cap split the list across ticks; a held number stops the tick; sending stays final in between', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  const due = () => ({ day: '2026-11-29', hm: '10:10' });
  let d = sender(RATE, { now: due, guestCapacity: async () => ({ remaining: 2 }) });
  let r = await runGuestNotices({ RATE }, d);
  assert.equal(d.sends.length, 2); assert.equal(r.events[0].done, false);
  let n = JSON.parse(RATE.m.get('clientstop:' + TOK)).notice; assert.equal(n.status, 'sending'); assert.ok(isFinal(n));
  assert.match(publicNotice(n).label_he, /נשלחת לאורחים .* · לא ניתן לבטל/);
  d = sender(RATE, { now: due, sendTemplate: async () => ({ ok: false, held: true }) });
  r = await runGuestNotices({ RATE }, d); assert.equal(r.events[0].cut, true);
  d = sender(RATE, { now: due });
  r = await runGuestNotices({ RATE }, d);
  assert.equal(d.sends.length, 1); assert.equal(r.events[0].done, true);
  n = JSON.parse(RATE.m.get('clientstop:' + TOK)).notice; assert.equal(n.sent_n, 3); assert.equal(n.status, 'sent');
});
test('sender: the event day passed while it waited → expired, nothing late', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  const d = sender(RATE, { now: () => ({ day: '2026-12-11', hm: '10:00' }) });
  const r = await runGuestNotices({ RATE }, d);
  assert.equal(r.events[0].expired, true); assert.equal(d.sends.length, 0);
  assert.equal(JSON.parse(RATE.m.get('clientstop:' + TOK)).notice.status, 'expired');
});

/* ── cancel the scheduled notice / finality / resume ── */
test('cancel: the client (event token) or the team (admin key) cancels a scheduled notice; after the first send nobody can', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  const c = async b => { const r = await handleNoticeCancel(req(b), { RATE }, '', deps()); return { status: r.status, j: await r.json() }; };
  assert.equal((await c({ admin_key: 'bad', token: TOK })).status, 403);
  let r = await c({ token: TOK });
  assert.equal(r.status, 200); assert.equal(r.j.notice.status, 'cancelled');
  assert.deepEqual(JSON.parse(RATE.m.get(INDEX_KEY)), []);
  assert.equal(JSON.parse(RATE.m.get('clientstop:' + TOK)).mode, 'cancel', 'the stop stays');
  /* schedule again, then the team cancels */
  await scheduled(RATE);
  r = await c({ admin_key: 'K', token: TOK }); assert.equal(r.j.notice.status, 'cancelled');
  /* schedule again and let it start: final */
  await scheduled(RATE);
  await runGuestNotices({ RATE }, sender(RATE, { now: () => ({ day: '2026-11-29', hm: '10:10' }), guestCapacity: async () => ({ remaining: 1 }) }));
  r = await c({ token: TOK }); assert.equal(r.status, 409); assert.equal(r.j.error, 'notice-final');
  r = await c({ admin_key: 'K', token: TOK }); assert.equal(r.j.error, 'notice-final');
  const s = await handleNoticeSchedule(req({ ...SCHED, day: '2026-11-30' }), { RATE }, '', deps());
  assert.equal((await s.json()).error, 'notice-final', 'no edit, no second notice after it started');
});
test('lift (resume, team only): refused once guests got the notice; a scheduled one needs cancel_notice:true; no notice = as before', async () => {
  const lift = async (RATE, b, now = NOW) => { const r = await handleClientStopLift(req({ admin_key: 'K', token: TOK, ...b }), { RATE }, '', { okJson, deny, isAdmin: (e, k) => k === 'K', logEvent: async () => {}, slackSend: async () => {}, now: () => now }); return { status: r.status, j: await r.json() }; };
  /* scheduled */
  let RATE = kv({ ['clientstop:' + TOK]: stopRec(), ['hold:' + TOK]: 'x' }); await scheduled(RATE);
  let r = await lift(RATE, {});
  assert.equal(r.status, 409); assert.equal(r.j.error, 'notice-scheduled'); assert.ok(RATE.m.has('hold:' + TOK));
  r = await lift(RATE, { cancel_notice: true });
  assert.equal(r.status, 200); assert.equal(r.j.notice_cancelled, true); assert.ok(!RATE.m.has('hold:' + TOK) && !RATE.m.has('clientstop:' + TOK));
  assert.deepEqual(JSON.parse(RATE.m.get(INDEX_KEY) || '[]'), []);
  /* sending / sent */
  for (const status of ['sending', 'sent']) {
    RATE = kv({ ['clientstop:' + TOK]: stopRec({ notice: { kind: 'cancel', status, sent_n: 1 } }), ['hold:' + TOK]: 'x' });
    r = await lift(RATE, { cancel_notice: true });
    assert.equal(r.status, 409, status); assert.equal(r.j.error, 'notice-sent'); assert.ok(RATE.m.has('hold:' + TOK) && RATE.m.has('clientstop:' + TOK));
  }
  /* cancelled earlier → the lift works */
  RATE = kv({ ['clientstop:' + TOK]: stopRec({ notice: { kind: 'cancel', status: 'cancelled', sent_n: 0 } }), ['hold:' + TOK]: 'x' });
  assert.equal((await lift(RATE, {})).status, 200);
  /* the client has no lift route of its own */
  RATE = kv({ ['clientstop:' + TOK]: stopRec() });
  const r2 = await handleClientStopLift(req({ token: TOK }), { RATE }, '', { okJson, deny, isAdmin: (e, k) => k === 'K', logEvent: async () => {}, slackSend: async () => {} });
  assert.equal(r2.status, 403);
});
test('the board and the clients page get the notice inside the stop record (no extra key read)', () => {
  const p = publicStop(JSON.parse(stopRec({ ip: '1.2.3.4', notice: { kind: 'cancel', status: 'scheduled', day: '2026-11-29', hm: '10:00', vars: { event: 'x' } } })));
  assert.equal(p.ip, undefined); assert.equal(p.notice.status, 'scheduled'); assert.equal(p.notice.vars, undefined);
  assert.equal(p.notice.final, false);
});

/* ── wiring in index.js / whatsapp.js ── */
test('wiring: routes, the pacer step, the old event-change refuses during a stop, guest-only templates, no auto-submission', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  for (const r of ['/api/client-notice-preview', '/api/client-notice', '/api/client-notice-cancel']) assert.ok(src.includes(`'${r}'`), r);
  assert.match(src, /step\('guest_notice', \(\) => runGuestNotices\(/);
  assert.match(src, /if \(await clientStopOf\(env, token\)\) return deny\(409, 'client-stopped', origin\);\n\s+const raw = await readSnapshot\(env, 'write'\);/);
  assert.match(src, /ishur_event_cancelled: 'utility'/);
  /* the template guard submits reworded copies of a MISSING template to Meta — these stay out until Richard submits them */
  const gw = src.slice(src.indexOf('function guardWatchList()'), src.indexOf('function guardWatchList()') + 900);
  assert.doesNotMatch(gw, /ishur_event_/);
  const wa = fs.readFileSync(new URL('../whatsapp.js', import.meta.url), 'utf8');
  assert.match(wa, /\^ishur_event_\(cancelled\|postponed\)/);
});

/* ── races, the missing date, a tick that reached nobody ── */
test('lock: cancel and lift close 5 minutes before the slot (a stale read must not undo a notice that is leaving), not while it waits for Meta', async () => {
  const n = { status: 'scheduled', day: '2026-11-29', hm: '10:00' };
  assert.equal(cancelLocked(n, { day: '2026-11-29', hm: '09:54' }), false);
  assert.equal(cancelLocked(n, { day: '2026-11-29', hm: '09:55' }), true);
  assert.equal(cancelLocked(n, { day: '2026-11-30', hm: '09:00' }), true);
  assert.equal(cancelLocked({ ...n, wait: 'template' }, { day: '2026-11-30', hm: '09:00' }), false, 'held for approval: still cancellable');
  assert.equal(cancelLocked({ ...n, wait: 'refused' }, { day: '2026-11-30', hm: '09:00' }), false);
  const RATE = kv({ ['clientstop:' + TOK]: stopRec(), ['hold:' + TOK]: 'x' }); await scheduled(RATE);
  const late = () => ({ day: '2026-11-29', hm: '09:57' });
  const r = await handleNoticeCancel(req({ token: TOK }), { RATE }, '', deps({ now: late }));
  assert.equal(r.status, 409); assert.equal((await r.json()).error, 'notice-starting');
  const l = await handleClientStopLift(req({ admin_key: 'K', token: TOK, cancel_notice: true }), { RATE }, '', { okJson, deny, isAdmin: (e, k) => k === 'K', logEvent: async () => {}, slackSend: async () => {}, now: late });
  assert.equal(l.status, 409); assert.equal((await l.json()).error, 'notice-starting');
  assert.equal(JSON.parse(RATE.m.get('clientstop:' + TOK)).notice.status, 'scheduled');
});
test('race: a cancel or a lift that lands while the notice is leaving is overruled — it stays final, the event stays stopped, Slack P1', async () => {
  for (const what of ['cancel', 'lift']) {
    const RATE = kv({ ['clientstop:' + TOK]: stopRec(), ['hold:' + TOK]: 'x', ['callstop:' + TOK]: 'x', ['sendsoff:' + TOK]: 'x' }); await scheduled(RATE);
    let first = true;
    const d = sender(RATE, { now: () => ({ day: '2026-11-29', hm: '10:10' }), guestCapacity: async () => ({ remaining: 2 }),
      sendTemplate: async () => {
        if (first) { first = false;
          if (what === 'cancel') { const r = JSON.parse(RATE.m.get('clientstop:' + TOK)); r.notice.status = 'cancelled'; RATE.m.set('clientstop:' + TOK, JSON.stringify(r)); }
          else for (const k of ['clientstop:', 'hold:', 'callstop:', 'sendsoff:']) RATE.m.delete(k + TOK);
        }
        return { ok: true, id: 'w' };
      } });
    await runGuestNotices({ RATE }, d);
    const n = JSON.parse(RATE.m.get('clientstop:' + TOK)).notice;
    assert.equal(n.status, 'sending', what); assert.equal(n.sent_n, 2);
    assert.ok(RATE.m.has('hold:' + TOK) && RATE.m.has('callstop:' + TOK), what + ': stopped again');
    assert.deepEqual(JSON.parse(RATE.m.get(INDEX_KEY)), [TOK], what + ': the rest still goes out');
    assert.ok(d.slack.some(t => /כבר התחילה לצאת/.test(t)), what);
  }
});
test('no valid event date: nothing to offer, nothing to schedule (the date is in the wording)', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() });
  const d = deps({ eventFacts: async () => facts({ origDate: '' }) });
  const p = await (await handleNoticePreview(req({ token: TOK, kind: 'cancel' }), { RATE }, '', d)).json();
  assert.equal(p.eligible, false); assert.equal(p.why, 'no-event-date');
  const r = await handleNoticeSchedule(req(SCHED), { RATE }, '', d);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, 'no-event-date');
});
test('a tick that reached nobody (Meta refused the first send) goes back to waiting: not final, still cancellable', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  const d = sender(RATE, { now: () => ({ day: '2026-11-29', hm: '10:10' }), sendTemplate: async () => ({ ok: false, permanent: true, error: 'empty-param:{{3}}' }) });
  await runGuestNotices({ RATE }, d);
  const n = JSON.parse(RATE.m.get('clientstop:' + TOK)).notice;
  assert.equal(n.status, 'scheduled'); assert.equal(n.wait, 'refused'); assert.equal(isFinal(n), false);
  assert.ok(d.slack.some(t => /מטא סירבה/.test(t)));
  const c = await handleNoticeCancel(req({ token: TOK }), { RATE }, '', deps({ now: () => ({ day: '2026-11-29', hm: '10:20' }) }));
  assert.equal(c.status, 200);
});
test('the status webhook never reopens a notice guest (no gk on the wamid record): one-shot', async () => {
  const RATE = kv({ ['clientstop:' + TOK]: stopRec() }); await scheduled(RATE);
  const notes = [];
  const d = sender(RATE, { now: () => ({ day: '2026-11-29', hm: '10:10' }), noteGuestSend: async (e, wa, t, wave, ph, gk) => { notes.push({ wave, gk }); } });
  await runGuestNotices({ RATE }, d);
  assert.ok(notes.length && notes.every(x => x.gk === '' && x.wave === 'notice_cancel'));
});
