/* 25/11/2026 הגדרות מתקדמות (event-settings.js): parents' names, follow-up questions after a yes, per-event call hours,
   the gift line after a yes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parentsText, normalizeSettings, normCallWindow, eventCallWindowOpen, questionMessage, parseFollowupAnswer,
  shirFollowupVars, followupsFromRetell, startFollowups, handleFollowupReply, listAnswers, yesGift, saveSettings,
  getSettings, handleEventSettings, whoIsText, cleanText, enabledSteps, FOOD_OPTIONS, GIFT_YES_LINE, callWindowGate,
} from '../event-settings.js';
import { buildCallPayload, introFor } from '../shir.js';

const TOK = '0f8a2c1e-1111-4222-8333-444455556666';

function kv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, { v, meta: undefined }]));
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k).v : null; },
    async put(k, v, o = {}) { m.set(k, { v: String(v), meta: o.metadata }); },
    async delete(k) { m.delete(k); },
    async list({ prefix, cursor }) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, page = all.slice(start, start + 2);   /* tiny pages: the cursor must be followed */
      const done = start + 2 >= all.length;
      return { keys: page.map(name => ({ name, metadata: m.get(name).meta })), list_complete: done, cursor: done ? undefined : String(start + 2) };
    },
  };
}
/* Israel is UTC+2 in November */
const at = (iso) => new Date(iso);

test('parents: one speakable sentence, ≤ 140 characters even with the longest inputs, never cut mid-name', () => {
  assert.equal(parentsText({ bride: 'משה ורחל כהן', groom: 'דוד ושרה לוי' }), 'הורי הכלה משה ורחל כהן, והורי החתן דוד ושרה לוי');
  assert.equal(parentsText({ groom: 'דוד ושרה לוי' }), 'הורי החתן דוד ושרה לוי');
  assert.equal(parentsText({ hosts: 'משפחת אברהם' }), 'משפחת אברהם');
  assert.equal(parentsText({ bride: 'א', hosts: 'משפחת אברהם' }), 'הורי הכלה א', 'the couple form wins over the generic one');
  assert.equal(parentsText({}), '');
  const long = parentsText({ bride: 'א'.repeat(200), groom: 'ב'.repeat(200) });
  assert.ok(long.length <= 140, long.length);
  assert.ok(long.endsWith('ב'.repeat(55)), 'each name capped before joining, so the sentence ends with the whole capped name');
  /* the dialer's hostExtra (140) keeps it whole */
  assert.equal(introFor(JSON.stringify({ text: long })), long);
});

test('client text that reaches guests and Shir: no links, braces, markup or new lines', () => {
  assert.equal(cleanText('בואו {{x}} <b>היום</b>\nhttps://evil.example/x www.a.com'), 'בואו x b היום /b');
  const s = normalizeSettings({ questions: { custom: { on: true, q: 'תצטרכו חניה? https://x.co.il' }, shuttle: { on: true, details: 'מבאר שבע {{18:00}}' } } });
  assert.equal(s.questions.custom.q, 'תצטרכו חניה?');
  assert.equal(s.questions.shuttle.details, 'מבאר שבע 18:00');
  assert.equal(normalizeSettings({ questions: { custom: { on: true, q: '   ' } } }).questions.custom.on, false, 'a custom question with no words is off');
});

test('call window: clamped into the legal one, never wider; default = null', () => {
  assert.deepEqual(normCallWindow({ start: '08:00', end: '23:00' }), null, 'wider than legal = the legal default');
  assert.deepEqual(normCallWindow({ start: '12:00', end: '18:00' }), { start: '12:00', end: '18:00', fri: true, fri_end: '13:00' });
  assert.deepEqual(normCallWindow({ start: '12:00', end: '12:30' }), { error: 'window-too-short' });
  assert.deepEqual(normCallWindow({ start: '10:00', end: '20:30', fri: false }), { start: '10:00', end: '20:30', fri: false, fri_end: '13:00' });
  assert.equal(normalizeSettings({ call_window: { start: '12:00', end: '12:10' } }).error, 'window-too-short');
});

test('call window: the event hours and the legal hours are both honoured', () => {
  const cw = { start: '12:00', end: '18:00', fri: false };
  /* Wed 25/11/2026 */
  assert.equal(eventCallWindowOpen(null, at('2026-11-25T08:30:00Z')), true, '10:30 legal, no event window');
  assert.equal(eventCallWindowOpen(cw, at('2026-11-25T08:30:00Z')), false, '10:30 is before the client\'s 12:00');
  assert.equal(eventCallWindowOpen(cw, at('2026-11-25T11:00:00Z')), true, '13:00');
  assert.equal(eventCallWindowOpen(cw, at('2026-11-25T16:30:00Z')), false, '18:30 is after the client\'s 18:00');
  assert.equal(eventCallWindowOpen(null, at('2026-11-25T18:45:00Z')), false, '20:45 is after the legal 20:30');
  /* a stored record that tries to widen is clamped on read too */
  assert.equal(eventCallWindowOpen({ start: '06:00', end: '23:59' }, at('2026-11-25T05:00:00Z')), false, '07:00');
  /* Fri 27/11 and Sat 28/11 */
  assert.equal(eventCallWindowOpen(null, at('2026-11-27T08:00:00Z')), true, 'Fri 10:00');
  assert.equal(eventCallWindowOpen(cw, at('2026-11-27T08:00:00Z')), false, 'no Fridays for this event');
  assert.equal(eventCallWindowOpen({ start: '10:00', end: '19:00', fri_end: '11:00' }, at('2026-11-27T09:30:00Z')), false, 'Fri 11:30, the event stops at 11:00');
  assert.equal(eventCallWindowOpen(null, at('2026-11-28T10:00:00Z')), false, 'Saturday');
});

test('call window gate for the dialer: per token, cached, default open in legal hours', async () => {
  const env = { RATE: kv({ ['evsettings:' + TOK]: JSON.stringify({ call_window: { start: '15:00', end: '18:00' } }) }) };
  const gate = callWindowGate(env, at('2026-11-25T09:00:00Z'));   /* 11:00 */
  assert.equal(await gate(TOK), false);
  assert.equal(await gate('other-token'), true);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("if (!force && !(await evWinOpen(g.token))) { blocked++; continue; }"), 'skipped guests count as blocked, so the "nobody dialled" alarm stays quiet');
  const brain = fs.readFileSync(new URL('../brain.js', import.meta.url), 'utf8');
  assert.ok(brain.includes('!eventCallWindowOpen(es.call_window, new Date(c.now))) continue;'), 'the brain does not call it a stall either');
});

test('WhatsApp questions: shuttle buttons, food list, the client\'s own question with a skip button', () => {
  const s = { questions: { shuttle: { on: true, details: 'מבאר שבע ב-18:00' }, food: { on: true }, custom: { on: true, q: 'תצטרכו חניה?' } } };
  assert.deepEqual(enabledSteps(s), ['shuttle', 'food', 'custom']);
  const a = questionMessage('shuttle', s);
  assert.equal(a.kind, 'buttons'); assert.match(a.text, /מבאר שבע ב-18:00/); assert.ok(a.buttons.every(b => b.title.length <= 20));
  const f = questionMessage('food', s);
  assert.equal(f.kind, 'list'); assert.deepEqual(f.rows.map(r => r.title), FOOD_OPTIONS); assert.ok(f.rows.every(r => r.title.length <= 24));
  const c = questionMessage('custom', s);
  assert.match(c.text, /^תצטרכו חניה\?/); assert.equal(c.buttons[0].id, 'fq:custom:skip');
});

test('answers: buttons, list rows and typed words; a change of RSVP is never swallowed', () => {
  assert.deepEqual(parseFollowupAnswer('shuttle', 'כן, נצטרף', 'fq:shuttle:yes'), { answer: 'כן' });
  assert.deepEqual(parseFollowupAnswer('shuttle', 'לא', ''), { answer: 'לא' }, 'a typed "לא" answers the bus, it is not "לא מגיע"');
  assert.equal(parseFollowupAnswer('shuttle', 'בסוף לא נגיע', ''), null);
  assert.deepEqual(parseFollowupAnswer('food', 'צמחוני', 'fq:food:1'), { answer: 'צמחוני' });
  assert.deepEqual(parseFollowupAnswer('food', 'טבעונית', ''), { answer: 'טבעוני' });
  assert.deepEqual(parseFollowupAnswer('food', 'בלי גלוטן', ''), { answer: 'ללא גלוטן' });
  assert.equal(parseFollowupAnswer('food', 'אנחנו 4', ''), null);
  assert.deepEqual(parseFollowupAnswer('custom', 'כן, רכב אחד', ''), { answer: 'כן, רכב אחד' });
  assert.deepEqual(parseFollowupAnswer('custom', 'דילוג', 'fq:custom:skip'), { answer: '' });
  assert.equal(parseFollowupAnswer('custom', 'בסוף לא נגיע', '', { rsvpish: true }), null);
  assert.equal(parseFollowupAnswer('custom', 'כן', 'xq:bus:yes'), null, 'another question\'s button is not this answer');
});

test('the WhatsApp flow end to end: ask, answer, next question, thanks; answers listed for the board', async () => {
  const env = { RATE: kv({ ['evsettings:' + TOK]: JSON.stringify({ questions: { shuttle: { on: true, details: 'מבאר שבע' }, food: { on: true }, custom: { on: true, q: 'תצטרכו חניה?' } } }) }) };
  const sent = [];
  const deps = {
    normPhone: p => String(p).replace(/\D/g, '').replace(/^0/, '972'),
    sendReplyButtons: async (e, to, text, buttons) => { sent.push({ kind: 'buttons', text, buttons }); return { ok: true }; },
    sendList: async (e, to, text, button, rows) => { sent.push({ kind: 'list', text, rows }); return { ok: true }; },
    sendText: async (e, to, text) => { sent.push({ kind: 'text', text }); return { ok: true }; },
    logEvent: async () => {},
  };
  const guest = { token: TOK, guest_id: 'G-0f8a2c1e-7', name: 'דנה' };
  assert.equal(await startFollowups(env, guest, '0501234567', 'guests', deps), true);
  assert.equal(sent.length, 1); assert.equal(sent[0].kind, 'buttons');
  assert.equal(await startFollowups(env, guest, '0501234567', 'guests', deps), true);
  assert.equal(sent.length, 1, 'never asked twice while open');
  /* an unrelated message while open is not an answer */
  assert.equal(await handleFollowupReply(env, guest, '0501234567', { type: 'text', text: { body: 'מה השעה?' } }, 'guests', deps, { rsvpish: true }), false);
  assert.equal(await handleFollowupReply(env, guest, '0501234567', { type: 'interactive', interactive: { button_reply: { id: 'fq:shuttle:yes', title: 'כן, נצטרף' } } }, 'guests', deps), true);
  assert.equal(sent[1].kind, 'list');
  assert.equal(await handleFollowupReply(env, guest, '0501234567', { type: 'interactive', interactive: { list_reply: { id: 'fq:food:2', title: 'טבעוני' } } }, 'guests', deps), true);
  assert.match(sent[2].text, /תצטרכו חניה/);
  assert.equal(await handleFollowupReply(env, guest, '0501234567', { type: 'text', text: { body: 'כן, רכב אחד' } }, 'guests', deps), true);
  assert.equal(sent[3].kind, 'text'); assert.match(sent[3].text, /תודה/);
  assert.equal(await env.RATE.get('awaitfq:' + guest.guest_id), null);
  /* the flow does not start again once everything was answered */
  assert.equal(await startFollowups(env, guest, '0501234567', 'guests', deps), true); assert.equal(sent.length, 4);
  /* a second and third guest, so the board's list call has to follow the cursor (pages of 2 in this fake) */
  await env.RATE.put(`fqa:${TOK}:G-0f8a2c1e-8`, '{}', { metadata: { s: 'לא', f: '', c: '', v: 'call' } });
  await env.RATE.put(`fqa:${TOK}:G-0f8a2c1e-9`, '{}', { metadata: { s: '', f: 'רגיל', c: '', v: 'whatsapp' } });
  const all = await listAnswers(env, TOK);
  assert.deepEqual(all['G-0f8a2c1e-7'], { shuttle: 'כן', food: 'טבעוני', custom: 'כן, רכב אחד', via: 'whatsapp' });
  assert.equal(Object.keys(all).length, 3);
});

test('an event without new questions keeps the old single question (Shoham\'s extraq)', async () => {
  const env = { RATE: kv() };
  assert.equal(await startFollowups(env, { token: TOK, guest_id: 'G-1' }, '0501234567', 'guests', {}), false);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('if (await startFollowups(env, guest, from, sendCh, FQ_DEPS)) return true;\n    const q = await extraQOf(env, guest && guest.token);'));
  assert.ok(src.includes("const ans = extraAnswerOf(String((msg.text && msg.text.body) || '').trim() || textOf(parsed), bid);"), 'the old question reads the typed words too');
  /* the yes/no events reach the questions as well */
  assert.ok(src.includes('if (saved && yesNoOnly) await askExtraQ(env, guest, from, sendCh);'));
  assert.ok(src.includes('if (saved && yesNoOnly2) await askExtraQ(env, guest, from, sendCh);'));
});

test('Shir: the questions ride as always-present variables, empty when off', () => {
  const G = { kind: 'guest', phone: '972500000000', guest_id: 'G-1', token: TOK, name: 'דנה', event_name: 'שוהם ושי', occasion: 'חתונה', event_date: '2026-12-03', party: '2' };
  const off = buildCallPayload(G, '+97200').retell_llm_dynamic_variables;
  for (const k of ['followup_questions', 'ask_shuttle', 'shuttle_details', 'ask_food', 'food_options', 'custom_question']) assert.equal(off[k], '', k);
  const on = buildCallPayload({ ...G, followups: shirFollowupVars({ questions: { shuttle: { on: true, details: 'מבאר שבע ב-18:00' }, food: { on: true }, custom: { on: true, q: 'תצטרכו חניה?' } } }) }, '+97200').retell_llm_dynamic_variables;
  assert.equal(on.ask_shuttle, 'כן'); assert.equal(on.shuttle_details, 'מבאר שבע ב-18:00');
  assert.equal(on.ask_food, 'כן'); assert.equal(on.food_options, 'רגיל, צמחוני, טבעוני, ללא גלוטן, אחר');
  assert.equal(on.custom_question, 'תצטרכו חניה?');
  assert.match(on.followup_questions, /הסעה.*\|.*אוכל.*\|.*תצטרכו חניה/);
  for (const v of Object.values(on)) assert.ok(!/\{\{|\}\}/.test(String(v)));
  assert.equal(on.opening, off.opening, 'the opening does not change');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("g.followups = introCache.get('f:' + g.token);"));
});

test('Shir\'s answers come back through the tool args or the post-call analysis; absent = nothing', () => {
  const meta = { guest_id: 'G-1', token: TOK, kind: 'guest' };
  assert.deepEqual(followupsFromRetell({ name: 'record_rsvp_outcome', args: { outcome: 'מגיע', party_size: 2, shuttle: 'כן', food: 'צמחוני', custom_answer: 'רכב אחד' }, call: { metadata: meta } }),
    { token: TOK, guest_id: 'G-1', answers: { shuttle: 'כן', food: 'צמחוני', custom: 'רכב אחד' } });
  assert.deepEqual(followupsFromRetell({ event: 'call_analyzed', call: { metadata: meta, call_analysis: { custom_analysis_data: { outcome: 'מגיע', shuttle_answer: 'לא', food_answer: 'כשר למהדרין' } } } }),
    { token: TOK, guest_id: 'G-1', answers: { shuttle: 'לא', food: 'אחר' } });
  assert.equal(followupsFromRetell({ name: 'record_rsvp_outcome', args: { outcome: 'מגיע' }, call: { metadata: meta } }), null);
  assert.equal(followupsFromRetell({ name: 'record_rsvp_outcome', args: { shuttle: 'כן' }, call: { metadata: {} } }), null, 'no guest, nowhere to write');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("try { const fu = followupsFromRetell(body); if (fu) await fqPut(env, fu.token, fu.guest_id, fu.answers, 'call'); } catch {}"));
});

test('gift line after a yes: once, only with active links, the client can turn it off', async () => {
  const GL = { on: true, bit: 'https://www.bitpay.co.il/app/me/x' };
  const env = { RATE: kv() };
  const g1 = await yesGift(env, TOK, '972501234567', GL);
  assert.equal(g1.text, '\n\n' + GIFT_YES_LINE + 'https://go.ishur.io/gift/' + TOK.slice(0, 8));
  assert.ok(GIFT_YES_LINE.startsWith('לנוחיותכם אפשר להעניק מתנה ישירות כאן'));
  await g1.mark();
  assert.equal((await yesGift(env, TOK, '972501234567', GL)).text, '', 'the same once-per-guest mark as the decline reply');
  assert.equal((await yesGift(env, TOK, '972501234568', { on: false, bit: GL.bit })).text, '', 'links switched off');
  assert.equal((await yesGift(env, TOK, '972501234568', null)).text, '', 'no links');
  await env.RATE.put('evsettings:' + TOK, JSON.stringify({ gift_on_yes: false }));
  assert.equal((await yesGift(env, TOK, '972501234568', GL)).text, '', 'turned off in the advanced settings');
});

test('parents → callintro: written for Shir, a hand-written start day kept, clearing removes only what this screen wrote', async () => {
  const env = { RATE: kv({ ['callintro:' + TOK]: JSON.stringify({ text: 'ישן', from: '2026-11-26' }) }) };
  await saveSettings(env, TOK, { parents: { bride: 'משה ורחל כהן', groom: 'דוד ושרה לוי' } });
  const ci = JSON.parse(await env.RATE.get('callintro:' + TOK));
  assert.deepEqual(ci, { text: 'הורי הכלה משה ורחל כהן, והורי החתן דוד ושרה לוי', src: 'settings', from: '2026-11-26' });
  assert.equal(introFor(await env.RATE.get('callintro:' + TOK), '2026-11-27'), ci.text);
  await saveSettings(env, TOK, { parents: { bride: '', groom: '' } });
  assert.equal(await env.RATE.get('callintro:' + TOK), null);
  const team = { RATE: kv({ ['callintro:' + TOK]: 'והוריהם יעקב ומירי' }) };
  await saveSettings(team, TOK, { parents: { bride: '' } });
  assert.equal(await team.RATE.get('callintro:' + TOK), 'והוריהם יעקב ומירי', 'the team\'s own text is not removed by an empty save');
  /* a save of one part keeps the others */
  await saveSettings(team, TOK, { questions: { food: { on: true } } });
  await saveSettings(team, TOK, { call_window: { start: '12:00', end: '18:00' } });
  const s = await getSettings(team, TOK);
  assert.equal(s.questions.food.on, true); assert.equal(s.call_window.start, '12:00');
});

test('"מי זה?" on WhatsApp carries the parents when set, and stays as before when not', () => {
  assert.equal(whoIsText('החתונה של שוהם ושי', ''), 'זו הזמנה להחתונה של שוהם ושי, נשלחה דרך אישורי הגעה (ishur.io). אפשר לענות כאן מגיע / לא מגיע 🙂');
  assert.match(whoIsText('החתונה של שוהם ושי', 'הורי הכלה משה ורחל כהן'), /\(הורי הכלה משה ורחל כהן\), נשלחה/);
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("await say(whoIsText(guestEventName(ev, { article: false }), await introNow(env, guest.token, ilDate()).catch(() => '')));"));
});

test('route POST /api/event-settings: token-gated, saves, reads, refuses a too-short window', async () => {
  const env = { RATE: kv() };
  const deps = {
    okJson: (o) => ({ status: 200, body: o }), deny: (s, e) => ({ status: s, body: { error: e } }),
    tokenRecord: async (e, t) => (t === TOK ? { phone: '972' } : null), overBudget: async () => false, logEvent: async () => {},
  };
  const req = b => ({ json: async () => b });
  assert.equal((await handleEventSettings(req({ token: 'nope' }), env, '', deps)).status, 404);
  const r0 = await handleEventSettings(req({ token: TOK }), env, '', deps);
  assert.equal(r0.status, 200); assert.equal(r0.body.settings.gift_on_yes, true); assert.equal(r0.body.settings.call_window, null);
  assert.deepEqual(r0.body.legal, { start: '10:00', end: '20:30', fri_start: '09:30', fri_end: '13:00' });
  const r1 = await handleEventSettings(req({ token: TOK, settings: { parents: { hosts: 'משפחת לוי' }, questions: { shuttle: { on: true } }, call_window: { start: '11:00', end: '19:00' } } }), env, '', deps);
  assert.equal(r1.status, 200); assert.equal(r1.body.intro, 'משפחת לוי'); assert.equal(r1.body.settings.questions.shuttle.on, true);
  const r2 = await handleEventSettings(req({ token: TOK, settings: { call_window: { start: '11:00', end: '11:30' } } }), env, '', deps);
  assert.equal(r2.status, 422); assert.equal(r2.body.error, 'window-too-short');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("url.pathname === '/api/event-settings' && request.method === 'POST'"));
});

test('board data: answers ride in the status answer and are stripped from the limited (upload) view, with the bus list', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("'media', 'extra', 'followups']) delete snapshot[k]"));
  assert.ok(src.includes('snapshot.followups = { steps: steps0.map('));
});

test('setup step: the surnames are kept (not sent to Make), and the Make field list is untouched', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("await evSettingsSave(env, token, { names: { last1: String(l1 || ''), last2: String(l2 || '') } });"));
  const setup = src.slice(src.indexOf('const SETUP_FIELDS = ['), src.indexOf('];', src.indexOf('const SETUP_FIELDS = [')));
  assert.ok(!/last1|last2/.test(setup), 'the Make field list is untouched');
});
