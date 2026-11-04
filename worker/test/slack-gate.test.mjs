// node --test worker/test/slack-gate.test.mjs — the Slack state-change gate (04/11/2026, "תצמצם ספאם בסלאק"):
// OPEN / SILENT / WORSE / CLOSE with the repeat count, info-class routing to the notifications center + digest,
// the shared finding:<id> key between the brain and notify.js, the morning digest, the kill switch, and a scan
// that every Slack poster in worker/*.js carries a key / oneoff / cls / quiet (nothing bypasses the gate by accident).
// KV is a double; Slack is a fetch stub counting posts. Nothing leaves.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../slack-gate.js';
import { slackSend, slackPost, slackResolve, alert } from '../slack.js';
import * as N from '../notify.js';
import { runBrain, P } from '../brain.js';
import * as reg from '../automations-registry.js';

const W = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3600e3, MIN = 60e3;
const T0 = Date.parse('2026-11-04T08:00:00Z');   /* Wednesday 10:00 Israel */
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v, o) => { m.set(k, String(v)); if (o && o.metadata) m.set('@meta:' + k, JSON.stringify(o.metadata)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix) && !k.startsWith('@meta:')).sort().map(name => ({ name, metadata: m.has('@meta:' + name) ? JSON.parse(m.get('@meta:' + name)) : undefined })), list_complete: true }) };
}
const J = o => JSON.stringify(o);
let posts = [], realFetch;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (url, init = {}) => { if (/hooks\.slack\.test/.test(String(url))) posts.push(JSON.parse(init.body).text); return new Response('{}'); }; });
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { posts = []; });
const env = (init = {}) => ({ RATE: kv(init), SLACK_ALERT_HOOK: 'https://hooks.slack.test/x' });
const state = (e, key) => JSON.parse(e.RATE.m.get(G.STATE + key) || 'null');

/* ── 1. pure ── */
test('decide: new key → open; same again → silent with count; level band up → worse; severity up → worse; within band → silent', () => {
  const a = G.decide(null, { sev: 'P2', level: 86, bands: [85, 90, 97, 100], title: 'cap' }, T0);
  assert.equal(a.kind, 'open'); assert.equal(a.next.count, 1); assert.equal(a.next.sev, 'P2');
  const b = G.decide(a.next, { sev: 'P2', level: 88, bands: [85, 90, 97, 100] }, T0 + 10 * MIN);
  assert.equal(b.kind, 'silent'); assert.equal(b.next.count, 2); assert.equal(b.next.last_level, 88, 'tracked within the band');
  const c = G.decide(b.next, { sev: 'P2', level: 91, bands: [85, 90, 97, 100] }, T0 + 20 * MIN);
  assert.equal(c.kind, 'worse'); assert.equal(c.next.count, 3);
  const d = G.decide(c.next, { sev: 'P1', level: 91, bands: [85, 90, 97, 100] }, T0 + 30 * MIN);
  assert.equal(d.kind, 'worse', 'P2 → P1'); assert.equal(d.next.sev, 'P1');
  const e = G.decide(d.next, { sev: 'P2', level: 85, bands: [85, 90, 97, 100] }, T0 + 40 * MIN);
  assert.equal(e.kind, 'silent', 'getting better is not a new line'); assert.equal(e.next.sev, 'P1', 'keeps the worst seen');
  assert.equal(G.decide(G.decide(null, { sev: 'P2' }, T0).next, { sev: 'P2' }, T0).kind, 'silent', 'no level at all: repeat is silent');
});
test('band + autoKey: default bands; the auto key drops numbers, tokens, emoji and links so repeats of one title collide', () => {
  assert.equal(G.band(0), 0); assert.equal(G.band(1), 1); assert.equal(G.band(14), 2); assert.equal(G.band(15), 3); assert.equal(G.band(NaN), -1);
  const k1 = G.autoKey('⚠️ גל 2 · c1c5fcf5: 5 שליחות נכשלו, 20 יצאו. https://ishur.io/x');
  const k2 = G.autoKey('⚠️ גל 3 · deadbeef: 12 שליחות נכשלו, 3 יצאו.');
  assert.equal(k1, k2); assert.match(k1, /^auto:גל/);
  assert.notEqual(G.autoKey('💳 תשלום חדש'), k1);
});
test('withAction / closeText: Richard\'s format — footer "מה לעשות:" exactly once, CLOSE says how many times it repeated', () => {
  assert.match(G.withAction('🔴 *תקלה*\n\n• פרט', 'לטעון יתרה'), /───\nמה לעשות: לטעון יתרה$/);
  assert.equal(G.withAction('x\n\nמה לעשות: כבר יש', 'אחר'), 'x\n\nמה לעשות: כבר יש');
  assert.equal(G.withAction('🔴 *נדרשת פעולה ממך:* y'), '🔴 *נדרשת פעולה ממך:* y', 'slackFormat footers count as an action');
  const t = G.closeText('k', { title: '🚨 *מוח · הפייסר לא רץ*', opened_at: new Date(T0).toISOString(), count: 14 }, T0 + H);
  assert.match(t, /^✅ \*נפתר\* · 🚨 מוח · הפייסר לא רץ/); assert.match(t, /חזר 14 פעמים/); assert.match(t, /מה לעשות: כלום/);
  assert.doesNotMatch(G.closeText('k', { title: 't', opened_at: new Date(T0).toISOString(), count: 1 }), /חזר/);
});

/* ── 2. gate + resolve on KV ── */
test('gate: open → silent (counted) → worse → resolve posts ONE close with the count; resolving a closed key posts nothing', async () => {
  const e = env();
  const o = { key: 'hold_stale:c1c5fcf5', text: '🟡 *אירוע עצור* · c1c5fcf5 · 3 ימים', sev: 'P2', level: 3, bands: [2, 5, 10], now: T0 };
  const a = await G.gate(e, o); assert.equal(a.kind, 'open'); assert.ok(a.post); assert.match(a.text, /מה לעשות:/);
  const b = await G.gate(e, { ...o, now: T0 + 6 * H }); assert.equal(b.kind, 'silent'); assert.equal(b.post, false); assert.equal(b.text, '');
  const c = await G.gate(e, { ...o, now: T0 + 12 * H }); assert.equal(c.kind, 'silent');
  assert.equal(state(e, o.key).count, 3);
  const d = await G.gate(e, { ...o, level: 6, now: T0 + 24 * H }); assert.equal(d.kind, 'worse'); assert.match(d.text, /^⬆️ \*החמיר\* \(P2 · 3 → P2 · 6\)/);
  const closes = [];
  const r = await G.resolve(e, o.key, { now: T0 + 30 * H, post: async t => closes.push(t) });
  assert.equal(r.posted, true); assert.equal(closes.length, 1); assert.match(closes[0], /חזר 4 פעמים/);
  assert.equal(state(e, o.key), null, 'state gone');
  assert.deepEqual((JSON.parse(e.RATE.m.get(G.CLOSED + G.ilDay(T0 + 30 * H))) || []).map(x => x.key), [o.key], 'recorded for the digest');
  const r2 = await G.resolve(e, o.key, { post: async t => closes.push(t) });
  assert.equal(r2.posted, false); assert.equal(closes.length, 1, 'closing twice posts once');
});
test('gate without a key is always open (never swallowed); without KV every call is open (nothing lost, just not deduped)', async () => {
  const e = env();
  assert.equal((await G.gate(e, { text: 'x' })).post, true); assert.equal((await G.gate(e, { text: 'x' })).post, true);
  const noKv = { SLACK_ALERT_HOOK: 'h' };
  assert.equal((await G.gate(noKv, { key: 'k', text: 'x' })).kind, 'open'); assert.equal((await G.gate(noKv, { key: 'k', text: 'x' })).kind, 'open');
});
test('sweep: open keys under a prefix that are not active any more close (one line each); active ones stay', async () => {
  const e = env();
  for (const k of ['hold_stale:aaaaaaaa', 'hold_stale:bbbbbbbb', 'cap_high']) await G.gate(e, { key: k, text: k, now: T0 });
  const closes = [];
  const r = await G.sweep(e, 'hold_stale:', ['hold_stale:aaaaaaaa'], { now: T0 + H, post: async t => closes.push(t) });
  assert.deepEqual(r.closed, ['hold_stale:bbbbbbbb']); assert.equal(closes.length, 1); assert.match(closes[0], /✅ \*נפתר\* · hold_stale:bbbbbbbb/);
  assert.ok(state(e, 'hold_stale:aaaaaaaa')); assert.ok(state(e, 'cap_high'), 'other prefixes untouched');
});

/* ── 3. slackSend is the choke point ── */
test('slackSend with a key: first posts, repeats are silent, slackResolve posts "✅ נפתר"; oneoff always posts; no key → auto key dedupes', async () => {
  const e = env();
  const o = { key: '131042:4499', urgent: true, sev: 'P1', action: 'להוסיף אמצעי תשלום ב-WhatsApp Manager' };
  await slackSend(e, '🚨 *בעיית תשלום בחשבון מטא (131042)* · נועה לא שולחת', o);
  await slackSend(e, '🚨 *בעיית תשלום בחשבון מטא (131042)* · נועה לא שולחת', o);
  await slackSend(e, '🚨 *בעיית תשלום בחשבון מטא (131042)* · נועה לא שולחת', o);
  assert.equal(posts.length, 1, 'one Slack line for a standing condition'); assert.match(posts[0], /מה לעשות: להוסיף אמצעי תשלום/);
  assert.equal((posts[0].match(/מה לעשות|נדרשת פעולה/g) || []).length, 1, 'no second footer from slackFormat');
  assert.equal(state(e, '131042:4499').count, 3);
  await slackResolve(e, '131042:4499', 'התשלום חזר');
  assert.equal(posts.length, 2); assert.match(posts[1], /✅ \*נפתר\*/); assert.match(posts[1], /חזר 3 פעמים/); assert.match(posts[1], /התשלום חזר/);
  await slackSend(e, '💳 תשלום חדש · ₪1,790', { oneoff: true, urgent: true });
  await slackSend(e, '💳 תשלום חדש · ₪2,390', { oneoff: true, urgent: true });
  assert.equal(posts.length, 4, 'one-off events always post');
  await slackPost(e, '⚠️ גל 2 · c1c5fcf5: 5 שליחות נכשלו, 20 יצאו.');
  await slackPost(e, '⚠️ גל 2 · c1c5fcf5: 7 שליחות נכשלו, 18 יצאו.');
  assert.equal(posts.length, 5, 'an unannotated poster is deduped on its title, not dropped');
  assert.ok([...e.RATE.m.keys()].some(k => k.startsWith(G.STATE + 'auto:')), 'auto key state');
  await alert(e, 'גל שליחה', 'גל 2 לאירוע c1c5fcf5: 5 שליחות נכשלו', '', { key: 'wave_fail:c1c5fcf5:2', level: 5, urgent: true });
  await alert(e, 'גל שליחה', 'גל 2 לאירוע c1c5fcf5: 6 שליחות נכשלו', '', { key: 'wave_fail:c1c5fcf5:2', level: 6, urgent: true });
  assert.equal(posts.length, 6, 'alert() goes through the same gate');
});
test('cls info: never Slack — lands in slackinfo:<day> for the digest and in the notifications center (rule info, app only)', async () => {
  const e = env();
  await slackPost(e, '✅ מטא אישרה את התבנית *x* — הופעלה אוטומטית.', { cls: 'info', key: 'template_ok:x', now: new Date(T0) });
  await slackPost(e, '⏳ ניסיון יומי לקוד אימות ל-4499 נכשל: y. ננסה מחר.', { cls: 'info', key: 'otp_4499', now: new Date(T0) });
  assert.equal(posts.length, 0);
  const info = JSON.parse(e.RATE.m.get(G.INFO + G.ilDay(T0)));
  assert.equal(info.length, 2); assert.equal(info[0].key, 'template_ok:x');
  const ring = [...e.RATE.m.keys()].filter(k => k.startsWith('ntf:r:'));
  assert.equal(ring.length, 2, 'stored as notifications');
  const n = JSON.parse(e.RATE.m.get('@meta:' + ring[0]));
  assert.equal(n.rule, 'info'); assert.deepEqual(n.channels, ['app']);
});

/* ── 4. notify.js: shared keys, info routing, sweep ── */
test('notify keys: incident shares finding:<id> with the brain; cap_high is one key with the % as level; info rules route to the digest; leads/payments are one-off', () => {
  const inc = N.slackOptsOf({ rule: 'incident', entity: 'finding:pacer_tick', severity: 'P0' });
  assert.equal(inc.key, 'finding:pacer_tick'); assert.equal(inc.urgent, true); assert.equal(inc.cls, undefined); assert.equal(inc.oneoff, undefined);
  const cap = N.slackOptsOf({ rule: 'cap_high', entity: 'day:2026-11-04', severity: 'P2', data: { pct: 91 } });
  assert.equal(cap.key, 'cap_high'); assert.equal(cap.level, 91); assert.deepEqual(cap.bands, [85, 90, 97, 100]); assert.equal(cap.cls, 'info');
  assert.equal(N.slackOptsOf({ rule: 'cap_high', entity: 'day:x', severity: 'P1', data: { pct: 98 } }).cls, undefined, '97%+ is P1 → Slack');
  assert.equal(N.slackOptsOf({ rule: 'brain_autofix', entity: 'chg:1', severity: 'P3' }).cls, 'info');
  assert.equal(N.slackOptsOf({ rule: 'template_status', entity: 'chg:2', severity: 'P1' }).cls, undefined, 'a rejected template is actionable');
  assert.equal(N.slackOptsOf({ rule: 'new_lead', entity: 'lead:1', severity: 'P2' }).oneoff, true);
  assert.equal(N.slackOptsOf({ rule: 'payment', entity: 'pay:r', severity: 'P1' }).oneoff, true);
  assert.equal(N.slackOptsOf({ rule: 'event_readiness', entity: 'event:aaaaaaaa:list,invite', severity: 'P1', data: { gaps: ['list', 'invite'] } }).key, 'event_readiness:event:aaaaaaaa');
  assert.ok(N.RULE.info && N.RULE.info.d.channels.length === 1 && N.RULE.info.d.channels[0] === 'app');
});
test('deliver: an info-class rule stores the notification but calls no Slack; incident calls d.slackSend with the shared key', async () => {
  const e = env(); const sent = [];
  const d = { slackSend: async (x, t, o) => { sent.push({ t, o }); } };
  const a = await N.deliver(e, d, { rule: 'brain_autofix', entity: 'chg:9', title_he: 'המוח תיקן לבד: שחרור תקרה' }, { now: T0 });
  assert.ok(a && a.stored); assert.equal(sent.length, 0); assert.equal(a.slack_class, 'info'); assert.ok(!a.channels.includes('slack'));
  assert.equal(JSON.parse(e.RATE.m.get(G.INFO + G.ilDay(T0))).length, 1);
  const b = await N.deliver(e, d, { rule: 'incident', entity: 'finding:snapshot_fail', severity: 'P0', title_he: 'קובץ האורחים לא נטען', deep_link: '#/brain?focus=snapshot_fail' }, { now: T0 });
  assert.ok(b); assert.equal(sent.length, 1); assert.equal(sent[0].o.key, 'finding:snapshot_fail'); assert.equal(sent[0].o.sev, 'P0'); assert.match(sent[0].o.action, /ops\.html#\/brain/);
});
test('runNotify sweep: a standing key that stopped appearing closes; the brain-owned finding: prefix is swept too; unanswered is not swept out of hours', async () => {
  const e = env(); const sent = [];
  const d = { slackSend: async (x, t, o) => { sent.push({ t, o }); }, auditQueryEx: async () => ({ items: [] }) };
  await G.gate(e, { key: 'hold_stale:gonegone', text: 'old hold', now: T0 - H });
  await G.gate(e, { key: 'unanswered:lead:972500000000', text: 'waiting', now: T0 - H });
  const out = await N.runNotify(e, d, { now: T0, fns: { realtime: async () => ({ today: '2026-11-04', cap: { used: 0, limit: 250 }, wa: { totals: {} } }), balances: async () => ({ vendors: [] }), inbox: async () => ({ items: [] }) } });
  assert.ok(out.ok);
  assert.ok(out.closed.includes('hold_stale:gonegone'), 'hold gone → closed: ' + J(out.closed));
  assert.ok(sent.some(s => /✅ \*נפתר\*/.test(s.t) && s.o.oneoff), 'the CLOSE line went out once, as a one-off');
  assert.ok(out.closed.includes('unanswered:lead:972500000000'), '10:00 Wednesday is in hours: swept');
  const e2 = env(); const sent2 = [];
  await G.gate(e2, { key: 'unanswered:lead:972500000000', text: 'waiting', now: T0 });
  const night = Date.parse('2026-11-04T21:30:00Z');   /* 23:30 Israel */
  const out2 = await N.runNotify(e2, { slackSend: async (x, t, o) => sent2.push({ t, o }), auditQueryEx: async () => ({ items: [] }) }, { now: night, fns: { realtime: async () => ({ today: '2026-11-04', cap: { used: 0, limit: 250 }, wa: { totals: {} } }), balances: async () => ({ vendors: [] }) } });
  assert.ok(!out2.closed.includes('unanswered:lead:972500000000'), 'not evaluated at night → not closed');
});

/* ── 5. the brain through the REAL slackSend: dedupe across reporters, CLOSE on resolve ── */
test('brain pacer_tick: the 6-hour re-alert is silenced by the gate (one Slack line), resolution posts one "נפתר" on the shared key', async () => {
  const now = T0;
  const e = { ...env({ 'pacer:last': J({ at: new Date(now - 40 * MIN).toISOString() }) }), WA_TOKEN_GUESTS: 'gt', WA_TOKEN: 'ct' };
  const d = { ilDate: dt => G.ilDay(dt), guestPhoneIds: () => ['A'], clientPhoneId: () => 'N', clientWaba: () => 'CW', clientToken: () => 'ct', sendingPaused: async () => false, sendWindowState: () => ({ open: true }),
    kvPrefix: async (x, prefix) => Object.fromEntries([...x.RATE.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v])),
    auditQueryEx: async () => ({ items: [] }), snapshotCached: async () => null, fetchSnapshot: async () => null, auditRecord: async (x, r) => r,
    slackSend: (x, t, o) => slackSend(x, t, o), slackPost: (x, t, o) => slackPost(x, t, o), resolveSlack: (x, k) => slackResolve(x, k) };
  const run = o => runBrain(e, d, { sleep: async () => {}, fns: {}, only: 'pacer_tick', ...o });
  await run({ now }); await run({ now: now + 10 * MIN });
  assert.equal(posts.filter(t => /הפייסר לא רץ/.test(t)).length, 1);
  assert.ok(state(e, 'finding:pacer_tick'), 'gate state under the shared key');
  await run({ now: now + 6.1 * H });
  assert.equal(posts.filter(t => /הפייסר לא רץ/.test(t)).length, 1, 'the brain wanted to re-alert; the gate said silent');
  assert.equal(state(e, 'finding:pacer_tick').count, 2);
  /* notify.js sees the same finding → same key → nothing new */
  await N.deliver(e, d, { rule: 'incident', entity: 'finding:pacer_tick', severity: 'P0', title_he: 'הפייסר לא רץ' }, { now: now + 6.2 * H });
  assert.equal(posts.filter(t => /הפייסר לא רץ/.test(t)).length, 1, 'second reporter, same condition, no second line');
  e.RATE.m.set('pacer:last', J({ at: new Date(now + 7 * H).toISOString() }));
  await run({ now: now + 7 * H });
  assert.equal(JSON.parse(e.RATE.m.get(P.finding + 'pacer_tick')).state, 'resolved');
  const closes = posts.filter(t => /✅ \*נפתר\*/.test(t));
  assert.equal(closes.length, 1); assert.match(closes[0], /חזר 3 פעמים/);
  assert.equal(state(e, 'finding:pacer_tick'), null);
});

/* ── 6. the morning digest ── */
test('slackDigest: one message with open / resolved overnight / info / night queue / plan; once per day; not before 09:00; the night queue is consumed', async () => {
  const day = G.ilDay(T0), yday = G.ilDay(T0 - 86400e3);
  const e = env({ 'slackq:list': J(['📨 ליד חדש בלילה', '🗂 עדכון כרטיס']), [G.CLOSED + yday]: J([{ key: 'hold_stale:x', title: 'אירוע עצור x', count: 14 }]), [G.INFO + yday]: J([{ at: 'x', text: '✅ מטא אישרה את התבנית *t1*' }]) });
  await G.gate(e, { key: '131042:4499', text: '🚨 *בעיית תשלום בחשבון מטא*', sev: 'P1', now: T0 - 30 * H });
  await G.gate(e, { key: '131042:4499', text: '🚨 *בעיית תשלום בחשבון מטא*', sev: 'P1', now: T0 - 20 * H });
  await G.gate(e, { key: 'cap_number:A', text: 'מספר A בתקרה', sev: 'P3', now: T0 - H });
  const early = await G.slackDigest(e, { now: Date.parse('2026-11-04T05:30:00Z'), post: async () => { throw new Error('no'); } });
  assert.equal(early.skipped, 'before-09');
  const out = [];
  const r = await G.slackDigest(e, { now: T0, post: async t => out.push(t), plan: async () => ({ sends: '120 (תקרה 250)', calls: 7, events: 2 }) });
  assert.equal(r.posted, true); assert.equal(out.length, 1);
  const t = out[0];
  assert.match(t, /^☀️ \*בוקר · סיכום\* 04\/11/);
  assert.match(t, /\*פתוח \(2\):\*\n• P1 · 🚨 בעיית תשלום בחשבון מטא — מ-03\/11 · חזר 2×\n• P3 · מספר A בתקרה/);
  assert.match(t, /\*נפתר בלילה \(1\):\*\n• אירוע עצור x \(חזר 14×\)/);
  assert.match(t, /\*מידע \(1\):\*\n• ✅ מטא אישרה את התבנית t1/);
  assert.match(t, /\*מה קרה בלילה \(2\):\*\n1\. 📨 ליד חדש בלילה\n2\. 🗂 עדכון כרטיס/);
  assert.match(t, /\*תוכנית להיום:\*\n• שליחות: 120 \(תקרה 250\)\n• שיחות: 7\n• אירועים: 2/);
  assert.match(t, /───\nמה לעשות: לטפל בפתוחים האדומים/);
  assert.equal(e.RATE.m.get('slackq:list'), undefined, 'night queue consumed'); assert.equal(e.RATE.m.get(G.INFO + yday), undefined);
  const again = await G.slackDigest(e, { now: T0 + 10 * MIN, post: async t => out.push(t) });
  assert.equal(again.skipped, 'sent'); assert.equal(out.length, 1);
  const empty = await G.slackDigest(env(), { now: T0, post: async t => out.push(t) });
  assert.equal(empty.posted, true); assert.match(out[1], /אין תנאים פתוחים/); assert.match(out[1], /מה לעשות: כלום דחוף/);
});
test('digest wiring: registry node slack_digest with kill switch auto:off:slack_digest, in KILL_SWITCH_IDS, and index.js checks isOff before step(\'slack_digest\')', () => {
  const n = reg.AUTOMATIONS.find(x => x.id === 'slack_digest');
  assert.ok(n && n.kind === 'slack' && /^\d{4}-\d{2}-\d{2}$/.test(n.added), 'node + added date');
  assert.deepEqual(reg.opsMeta(n).kill_switch, { key: 'auto:off:slack_digest', wired: true });
  assert.ok(reg.KILL_SWITCH_IDS.includes('slack_digest'));
  const ix = readFileSync(resolve(W, 'index.js'), 'utf8');
  const i = ix.indexOf("step('slack_digest'"); assert.ok(i > 0);
  assert.ok(ix.lastIndexOf("isOff(env, 'slack_digest')", i) > i - 400, 'the kill switch is checked right before the step');
  assert.match(ix.slice(i, i + 200), /oneoff: true/, 'the digest post itself is the one daily event');
});

/* ── 7. nothing bypasses the gate by accident: every poster in worker/*.js is annotated ── */
function callsOf(src, re) {
  const out = []; let m;
  while ((m = re.exec(src))) {
    let k = m.index + m[0].length, depth = 1; const st = [];
    for (; k < src.length && depth > 0; k++) {
      const c = src[k];
      if (st.length && st[st.length - 1] === '`') { if (c === '\\') { k++; continue; } if (c === '`') st.pop(); else if (c === '$' && src[k + 1] === '{') { st.push('${'); k++; } continue; }
      if (st.length && (st[st.length - 1] === "'" || st[st.length - 1] === '"')) { if (c === '\\') { k++; continue; } if (c === st[st.length - 1]) st.pop(); continue; }
      if (c === "'" || c === '"' || c === '`') st.push(c);
      else if (c === '(' || c === '[' || c === '{') st.push(c);
      else if (c === '}' && st.length && st[st.length - 1] === '${') st.pop();
      else if (c === ')' || c === ']' || c === '}') { if (st.length) st.pop(); else depth--; }
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, k + 60) });
  }
  return out;
}
test('every slackPost / slackSend / alert / d.slack* / c.slack call outside slack.js carries key: | oneoff: true | cls: | quiet: true', () => {
  const files = readdirSync(W).filter(f => f.endsWith('.js') && !['slack.js', 'slack-gate.js', 'automations-registry.js'].includes(f));   /* the registry is data: its evidence strings quote alert() calls */
  const bad = []; let n = 0;
  for (const f of files) {
    const src = readFileSync(resolve(W, f), 'utf8');
    for (const c of callsOf(src, /(?<![\w.])(?:await\s+)?(?:d\.|c\.)?(?:slackPost|slackSend|alert|slack)\(env?\b[^)]*?,|(?<![\w.])c\.slack\(/g)) {
      if (/^\s*(?:await\s+)?(?:d\.|c\.)?(?:slackPost|slackSend|alert)\(e\b/.test(c.text) && !/\(env,/.test(c.text)) continue;   /* a one-letter env in a deps shim: (e, t, o) => slackPost(e, t, o) */
      if (/,\s*(?:o|opts|so)\)/.test(c.text.split('\n')[0])) continue;   /* a forwarding shim: (env, text, opts) */
      n++;
      if (!/key:|oneoff: true|cls:|quiet: true/.test(c.text)) bad.push(`${f}:${c.line} ${c.text.split('\n')[0].slice(0, 90)}`);
    }
  }
  assert.ok(n > 80, 'the scan sees the posters: ' + n);
  assert.deepEqual(bad, [], 'posters with no key / oneoff / cls / quiet');
});
