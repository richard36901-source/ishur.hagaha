/* node --test worker/test/outreach.test.mjs
   In-memory KV, fake EMAIL binding, fake sendTemplate. Nothing touches the
   network: templateStatus gets a stub fetch through deps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  venueId, pickWhatsapp, parseRow, assignVariant, SUBJECT, outreachWindow, dailyLimit, planBatch,
  makeToken, verifyToken, safeRedirect, emailFor, sendEmail, computeStats, noteOutreachReply,
  handleOutreach, handleOutreachTrack, EMAIL_TEXT, PACING,
} from '../outreach.js';

function fakeKv() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }; },
  };
}
const okJson = (p) => ({ status: 200, body: p });
const deny = (s, r) => ({ status: s, body: { ok: false, error: r } });
const isAdmin = (env, k) => k === 'K';
const req = (body) => ({ json: async () => body });
/* Tue 03/11/2026 12:00 IL = 10:00 UTC */
const OPEN = () => new Date('2026-11-03T10:00:00Z');
const CLOSED = () => new Date('2026-11-03T18:00:00Z');   // 20:00 IL
const SAT = () => new Date('2026-11-07T10:00:00Z');
const okFetch = async () => ({ json: async () => ({ data: [{ name: 'ishur_venue_intro', status: 'APPROVED' }] }) });
function mkEnv(over = {}) {
  const sends = [];
  return {
    RATE: fakeKv(), ADMIN_KEY: 'K', OUTREACH_ENABLED: 'off', WA_TOKEN: 't',
    EMAIL: { sends, async send(m) { sends.push(m); return { messageId: 'mid-' + sends.length }; } },
    ...over,
  };
}
const ROWS = [
  { name: 'נסיה', city: 'צומת כנות', email: 'kabala@nesyaevent.co.il', phone_whatsapp: '08-8535353; 050-2158706 (WhatsApp)' },
  { name: 'הרמוזו', city: 'מודיעין', email: '', phone_whatsapp: '052-9095176 (WhatsApp); 077-2309736' },
  { name: 'צל החורש', city: 'כפר סבא', email: '', phone_whatsapp: '054-5503301 (WhatsApp); 055-4539289' },
  { name: 'אולם מייל', city: 'חיפה', email: 'A@Venue.co.il', phone_whatsapp: '' },
  { name: 'ללא כתובת', city: '', email: '', phone_whatsapp: '' },
];
function deps(over = {}) { return { isAdmin, okJson, deny, now: OPEN, fetch: okFetch, sendWindowState: () => ({ open: true }), sendTemplate: async () => ({ ok: true, id: 'wamid.1' }), ...over }; }

test('parseRow: id is stable, WhatsApp picks the marked number, email lowercased', () => {
  const a = parseRow(ROWS[0]), b = parseRow({ ...ROWS[0], city: 'x' });
  assert.equal(a.id, b.id);
  assert.equal(a.whatsapp, '972502158706');
  assert.equal(pickWhatsapp('077-2309736; 052-1111111'), '972521111111');
  assert.equal(pickWhatsapp('03-1234567'), '');
  assert.equal(parseRow(ROWS[3]).email, 'a@venue.co.il');
  assert.equal(parseRow(ROWS[4]), null);
  assert.match(venueId('x@y', '0501'), /^[0-9a-f]{12}$/);
});

test('variant assignment is sticky and both subjects exist; B carries the suffix', () => {
  const ids = Array.from({ length: 200 }, (_, i) => venueId('v' + i + '@x.il', ''));
  const seen = new Set(ids.map(id => assignVariant(id)));
  assert.deepEqual([...seen].sort(), ['A', 'B']);
  for (const id of ids) assert.equal(assignVariant(id), assignVariant(id));
  assert.equal(SUBJECT.A('נסיה'), 'נסיה');
  assert.equal(SUBJECT.B('נסיה'), 'נסיה — מספר סופי לכל אירוע');
});

test('window: Sun–Thu 10:00–16:00 IL; WA also needs the house send window', () => {
  assert.equal(outreachWindow('email', OPEN()).open, true);
  assert.equal(outreachWindow('email', CLOSED()).why, 'hours');
  assert.equal(outreachWindow('email', SAT()).why, 'weekend');
  assert.equal(outreachWindow('wa', OPEN(), () => ({ open: false, why: 'shabbat' })).why, 'send-window:shabbat');
  assert.equal(outreachWindow('wa', OPEN(), () => ({ open: true })).open, true);
});

test('pacing: email 10/day in week 1 then 20/day; WhatsApp 15', () => {
  assert.equal(dailyLimit('email', '', '2026-11-03'), 10);
  assert.equal(dailyLimit('email', '2026-11-03', '2026-11-09'), 10);
  assert.equal(dailyLimit('email', '2026-11-03', '2026-11-10'), 20);
  assert.equal(dailyLimit('wa', '', '2026-11-03'), PACING.wa);
});

test('planBatch: skips sent/replied/optout/bounced, no-address, already-out; honours cap and window', () => {
  const venues = ROWS.map(r => parseRow(r)).filter(Boolean).map((v, i) => ({ ...v, status: 'new', at: '2026-11-0' + (i + 1) }));
  venues[0].status = 'replied';
  const p = planBatch({ venues, channel: 'wa', limit: 10, now: OPEN(), sendWindowState: () => ({ open: true }) });
  assert.equal(p.batch.length, 2);
  assert.equal(p.skipped.status, 1);
  assert.equal(p.skipped.no_address, 1);
  assert.equal(p.blocked, '');
  const capped = planBatch({ venues, channel: 'wa', limit: 10, sentToday: 15, now: OPEN(), sendWindowState: () => ({ open: true }) });
  assert.equal(capped.batch.length, 0); assert.equal(capped.blocked, 'daily-cap');
  const e = planBatch({ venues, channel: 'email', limit: 1, now: OPEN(), outs: { [venues[3].id + ':email']: { at: 'x' } } });
  assert.equal(e.batch.length, 0); assert.equal(e.skipped.already, 1);
  const night = planBatch({ venues, channel: 'email', now: CLOSED() });
  assert.equal(night.blocked, 'window:hours');
  for (const v of venues) if (v.status === 'new') v.status = 'optout';
  assert.equal(planBatch({ venues, channel: 'wa', now: OPEN() }).batch.length, 0);
});

test('tokens: HMAC round-trip, kind preserved, tamper and foreign secret rejected', async () => {
  const env = { ADMIN_KEY: 'secret-1' };
  const id = venueId('a@b.c', '');
  const t = await makeToken(env, id, 'o');
  assert.deepEqual(await verifyToken(env, t), { id, kind: 'o' });
  assert.equal((await verifyToken(env, await makeToken(env, id, 'c'))).kind, 'c');
  assert.equal(await verifyToken(env, t.slice(0, -1) + (t.endsWith('0') ? '1' : '0')), null);
  assert.equal(await verifyToken({ ADMIN_KEY: 'other' }, t), null);
  assert.equal(await verifyToken(env, 'o' + id + '.zz'), null);
});

test('safeRedirect only allows ishur.io and wa.me over https', () => {
  assert.equal(safeRedirect('https://ishur.io/partners.html?x=1'), 'https://ishur.io/partners.html?x=1');
  assert.equal(safeRedirect('https://wa.me/972559504499'), 'https://wa.me/972559504499');
  assert.equal(safeRedirect('https://evil.com/ishur.io'), '');
  assert.equal(safeRedirect('http://ishur.io/'), '');
  assert.equal(safeRedirect('https://ishur.io.evil.com/'), '');
});

test('email: approved text, RTL html + text, pixel + /r/ links, unsubscribe, no "הנחה"', async () => {
  const env = { ADMIN_KEY: 's' };
  const v = { id: venueId('a@b.il', ''), name: 'נסיה', email: 'a@b.il', contact: '' };
  const m = await emailFor(env, v, 'B');
  assert.equal(m.subject, 'נסיה — מספר סופי לכל אירוע');
  assert.equal(m.from.email, 'richard@ishur.io'); assert.equal(m.replyTo, 'richard@ishur.io');
  assert.match(m.headers['List-Unsubscribe'], /^<mailto:richard@ishur\.io/);
  assert.ok(m.text.includes('שלום נסיה,'));
  assert.ok(m.text.includes("להסרה השיבו 'הסר'"));
  assert.ok(m.html.includes('dir="rtl"'));
  assert.match(m.html, /src="https:\/\/go\.ishur\.io\/px\/o[0-9a-f]{12}\.[0-9a-f]{20}\.gif"/);
  assert.match(m.html, /href="https:\/\/go\.ishur\.io\/r\/c[0-9a-f]{12}\.[0-9a-f]{20}\?u=https%3A%2F%2Fishur\.io%2Fpartners\.html/);
  assert.ok(m.html.includes(encodeURIComponent('https://wa.me/972559504499')));
  assert.ok(!/הנחה/.test(m.html + m.text + m.subject + EMAIL_TEXT('x')));
  assert.ok(!/ריצ'רד|ריצ׳רד/.test(m.html + m.text));
});

test('sendEmail: missing binding and unverified domain degrade to named errors', async () => {
  assert.deepEqual(await sendEmail({}, {}), { ok: false, error: 'email-binding-missing' });
  const err = Object.assign(new Error('sender domain not verified'), { code: 'E_SENDER_NOT_VERIFIED' });
  const r = await sendEmail({ EMAIL: { async send() { throw err; } } }, {});
  assert.equal(r.error, 'email-domain-not-enabled');
  const ok = await sendEmail({ EMAIL: { async send() { return { messageId: 'm1' }; } } }, {});
  assert.deepEqual(ok, { ok: true, message_id: 'm1' });
});

test('handler: import → list → plan; send refused while OUTREACH_ENABLED is off', async () => {
  const env = mkEnv();
  const d = deps();
  const imp = await handleOutreach(req({ admin_key: 'K', action: 'import', rows: ROWS, source: 'test' }), env, '', d);
  assert.deepEqual(imp.body, { ok: true, added: 4, updated: 0, skipped: 1 });
  const again = await handleOutreach(req({ admin_key: 'K', action: 'import', rows: ROWS }), env, '', d);
  assert.equal(again.body.updated, 4);
  assert.equal((await handleOutreach(req({ admin_key: 'bad', action: 'list' }), env, '', d)).status, 403);
  const list = await handleOutreach(req({ admin_key: 'K', action: 'list' }), env, '', d);
  assert.equal(list.body.venues.length, 4);
  assert.equal(list.body.stats.statuses.new, 4);
  const plan = await handleOutreach(req({ admin_key: 'K', action: 'plan', channel: 'email', limit: 5 }), env, '', d);
  assert.equal(plan.body.dry, true); assert.equal(plan.body.batch.length, 2); assert.equal(plan.body.cap, 10);
  const send = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'email' }), env, '', d);
  assert.equal(send.body.error, 'outreach-off'); assert.deepEqual(send.body.sent, []);
  assert.equal(env.EMAIL.sends.length, 0);
  assert.equal([...env.RATE.m.keys()].filter(k => k.startsWith('out:')).length, 0);
});

test('handler: send with the flag on → email + wa go out, records written, pacing counted', async () => {
  const env = mkEnv({ OUTREACH_ENABLED: 'on' });
  const waSends = [];
  const d = deps({ sendTemplate: async (e, to, name, params, img, lang, ch) => { waSends.push({ to, name, params, ch }); return { ok: true, id: 'wamid.' + waSends.length }; } });
  await handleOutreach(req({ admin_key: 'K', action: 'import', rows: ROWS }), env, '', d);
  const em = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'email' }), env, '', d);
  assert.equal(em.body.sent.length, 2); assert.equal(em.body.failed.length, 0);
  assert.equal(env.EMAIL.sends.length, 2);
  assert.ok(env.EMAIL.sends.every(m => m.html && m.text && m.headers['List-Unsubscribe']));
  assert.equal(await env.RATE.get('outreach:day:email:2026-11-03'), '2');
  assert.equal(await env.RATE.get('outreach:first:email'), '2026-11-03');
  const wa = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'wa' }), env, '', d);
  assert.equal(wa.body.sent.length, 2, 'נסיה already has status sent from the email batch, so WA skips it (spec)');
  assert.deepEqual(waSends[0].params, [waSends[0].params[0]]); assert.equal(waSends[0].name, 'ishur_venue_intro'); assert.equal(waSends[0].ch, 'client');
  const st = await handleOutreach(req({ admin_key: 'K', action: 'stats' }), env, '', d);
  assert.equal(st.body.by.email.all.sent, 2); assert.equal(st.body.by.wa.all.sent, 2);
  assert.equal(st.body.by.email.A.sent + st.body.by.email.B.sent, 2);
  /* second email batch: nothing left (all sent) */
  const again = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'email' }), env, '', d);
  assert.equal(again.body.sent.length, 0);
  const list = await handleOutreach(req({ admin_key: 'K', action: 'list' }), env, '', d);
  assert.ok(list.body.venues.every(v => v.status === 'sent'));
});

test('handler: email-domain-not-enabled stops the batch, keeps venues "new", logs the error', async () => {
  const err = Object.assign(new Error('E_SENDER_NOT_VERIFIED'), { code: 'E_SENDER_NOT_VERIFIED' });
  const env = mkEnv({ OUTREACH_ENABLED: 'on', EMAIL: { async send() { throw err; } } });
  const logs = [];
  const d = deps({ stream: async (e, r) => { logs.push(r); } });
  await handleOutreach(req({ admin_key: 'K', action: 'import', rows: ROWS }), env, '', d);
  const r = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'email' }), env, '', d);
  assert.equal(r.body.error, 'email-domain-not-enabled'); assert.equal(r.body.stopped, true);
  assert.equal(r.body.failed.length, 1); assert.equal(r.body.sent.length, 0);
  const list = await handleOutreach(req({ admin_key: 'K', action: 'list' }), env, '', d);
  assert.ok(list.body.venues.every(v => v.status === 'new'));
  assert.ok(logs.some(l => l.kind === 'outreach' && l.ok === false));
  /* a venue whose last send errored is planned again */
  const plan = await handleOutreach(req({ admin_key: 'K', action: 'plan', channel: 'email' }), env, '', d);
  assert.equal(plan.body.batch.length, 2);
});

test('handler: WhatsApp refused while the template is not APPROVED; window and cap block sends', async () => {
  const env = mkEnv({ OUTREACH_ENABLED: 'on' });
  const d = deps({ fetch: async () => ({ json: async () => ({ data: [{ name: 'ishur_venue_intro', status: 'PENDING' }] }) }) });
  await handleOutreach(req({ admin_key: 'K', action: 'import', rows: ROWS }), env, '', d);
  const r = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'wa' }), env, '', d);
  assert.equal(r.body.error, 'template-not-approved'); assert.equal(r.body.template_status, 'PENDING');
  const st = await handleOutreach(req({ admin_key: 'K', action: 'status' }), env, '', d);
  assert.equal(st.body.template.approved, false); assert.equal(st.body.enabled, true);
  const night = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'email' }), env, '', deps({ now: CLOSED }));
  assert.equal(night.body.error, 'window:hours'); assert.equal(env.EMAIL.sends.length, 0);
  await env.RATE.put('outreach:day:email:2026-11-03', '10');
  const cap = await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'email' }), env, '', deps());
  assert.equal(cap.body.error, 'daily-cap'); assert.equal(env.EMAIL.sends.length, 0);
});

test('tracking: pixel marks opened once, /r/ marks clicked and 302s only to allowed hosts', async () => {
  const env = mkEnv({ OUTREACH_ENABLED: 'on' });
  const d = deps();
  await handleOutreach(req({ admin_key: 'K', action: 'import', rows: ROWS }), env, '', d);
  await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'email' }), env, '', d);
  const m = env.EMAIL.sends[0];
  const px = /\/px\/([^"]+)\.gif/.exec(m.html)[1];
  const r1 = await handleOutreachTrack({}, env, new URL('https://go.ishur.io/px/' + px + '.gif'));
  assert.equal(r1.status, 200); assert.equal(r1.headers.get('Content-Type'), 'image/gif');
  const outKey = [...env.RATE.m.keys()].find(k => k.startsWith('out:') && k.endsWith(':email') && JSON.parse(env.RATE.m.get(k)).opened_at);
  assert.ok(outKey);
  const opened1 = JSON.parse(env.RATE.m.get(outKey)).opened_at;
  await handleOutreachTrack({}, env, new URL('https://go.ishur.io/px/' + px + '.gif'));
  assert.equal(JSON.parse(env.RATE.m.get(outKey)).opened_at, opened1);
  /* a forged token is served the gif but marks nothing */
  const bad = await handleOutreachTrack({}, env, new URL('https://go.ishur.io/px/o000000000000.00000000000000000000.gif'));
  assert.equal(bad.status, 200);
  const ctok = /\/r\/([^?"]+)\?/.exec(m.html)[1];
  const r2 = await handleOutreachTrack({}, env, new URL('https://go.ishur.io/r/' + ctok + '?u=' + encodeURIComponent('https://ishur.io/partners.html?utm_source=outreach')));
  assert.equal(r2.status, 302); assert.equal(r2.headers.get('Location'), 'https://ishur.io/partners.html?utm_source=outreach');
  assert.ok(JSON.parse(env.RATE.m.get(outKey)).clicked_at);
  const r3 = await handleOutreachTrack({}, env, new URL('https://go.ishur.io/r/' + ctok + '?u=' + encodeURIComponent('https://evil.com/')));
  assert.equal(r3.status, 404);
  const r4 = await handleOutreachTrack({}, env, new URL('https://go.ishur.io/r/' + px + '?u=' + encodeURIComponent('https://ishur.io/')));
  assert.equal(r4.status, 404, 'an open token must not work as a click token');
  const st = await handleOutreach(req({ admin_key: 'K', action: 'stats' }), env, '', d);
  assert.equal(st.body.by.email.all.opened, 1); assert.equal(st.body.by.email.all.clicked, 1);
  assert.ok(st.body.leading && st.body.leading.subject);
});

test('replies: "לא רלוונטי"/הסר → optout and never planned again; "כן" → replied + Slack; strangers → null', async () => {
  const env = mkEnv({ OUTREACH_ENABLED: 'on' });
  const slack = [];
  const d = deps({ slackSend: async (e, t) => { slack.push(t); } });
  await handleOutreach(req({ admin_key: 'K', action: 'import', rows: ROWS }), env, '', d);
  await handleOutreach(req({ admin_key: 'K', action: 'send', channel: 'wa' }), env, '', d);
  assert.equal(await noteOutreachReply(env, { channel: 'wa', from: '972500000000', text: 'כן' }, d), null);
  const no = await noteOutreachReply(env, { channel: 'wa', from: '0529095176', text: 'לא רלוונטי' }, d);
  assert.equal(no.kind, 'optout'); assert.equal(no.name, 'הרמוזו');
  const rm = await noteOutreachReply(env, { channel: 'wa', from: '972545503301', text: 'הסר' }, d);
  assert.equal(rm.kind, 'optout');
  const yes = await noteOutreachReply(env, { channel: 'wa', from: '972502158706', text: 'כן, שלחו פרטים' }, d);
  assert.equal(yes.kind, 'yes'); assert.equal(slack.length, 1); assert.ok(slack[0].includes('נסיה'));
  const byMail = await noteOutreachReply(env, { channel: 'email', from: 'A@venue.co.il', text: 'הסר' }, d);
  assert.equal(byMail.kind, 'optout');
  const list = await handleOutreach(req({ admin_key: 'K', action: 'list' }), env, '', d);
  assert.deepEqual(list.body.stats.statuses, { optout: 3, replied: 1 });
  assert.equal(list.body.stats.by.wa.all.optout, 2); assert.equal(list.body.stats.by.wa.all.replied, 1);
  for (const ch of ['email', 'wa']) {
    const p = await handleOutreach(req({ admin_key: 'K', action: 'plan', channel: ch }), env, '', d);
    assert.equal(p.body.batch.length, 0, ch + ' plans nobody after replies/opt-outs');
  }
});
