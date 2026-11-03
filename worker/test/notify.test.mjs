// node --test worker/test/notify.test.mjs — notifications engine (notify.js): rules, de-dup, quiet hours,
// per-rule settings, channels, storage, the routes through the real Worker fetch(), and the overview payload shape.
// Slack / WhatsApp / push are stubs; nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import * as N from '../notify.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, { v: String(v), meta: null }]));
  return { m,
    get: async k => (m.has(k) ? m.get(k).v : null),
    put: async (k, v, o = {}) => { m.set(k, { v: String(v), meta: o.metadata ? structuredClone(o.metadata) : null }); },
    delete: async k => { m.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name, metadata: m.get(name).meta })), list_complete: true }),
    getWithMetadata: async () => ({ value: null }) };
}
let realFetch;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (u) => (String(u) === 'https://hook.test/status' ? new Response(JSON.stringify({ events: { values: [] }, guests: { values: [] } })) : new Response('{}')); });
after(() => { globalThis.fetch = realFetch; });

/* IL clock: 03/11/2026 is a Tuesday; IL = UTC+2 */
const at = (hhmm, day = '2026-11-03') => Date.parse(`${day}T${hhmm}:00+02:00`);
const stubD = () => { const sent = { slack: [], wa: [] }; return { sent, slackSend: async (e, t, o) => { sent.slack.push({ t, o }); }, sendText: async (e, to, text, ch) => { sent.wa.push({ to, text, ch }); return { ok: true }; } }; };
const envK = (init) => ({ RATE: kv(init) });

test('quiet hours + in-hours clock (Israel time)', () => {
  assert.equal(N.isQuiet(at('20:59')), false); assert.equal(N.isQuiet(at('21:00')), true); assert.equal(N.isQuiet(at('08:59')), true); assert.equal(N.isQuiet(at('09:00')), false);
  assert.equal(N.inHours(at('12:00', '2026-11-07')), false, 'Saturday is not in hours');
  assert.equal(N.hoursInHours(at('19:00'), at('10:00', '2026-11-04')), 3, '19–21 + 09–10 = 3 business hours');
});

test('routeChannels: severity threshold, quiet hours, WhatsApp only P0 in hours, off and mute', () => {
  const cfg = N.mergeCfg('incident', null);
  const p0 = { severity: 'P0', entity: 'x' }, p2 = { severity: 'P2', entity: 'x' };
  assert.deepEqual(N.routeChannels(p0, cfg, at('12:00')), ['app', 'slack', 'push', 'whatsapp']);
  assert.deepEqual(N.routeChannels(p0, cfg, at('22:30')), ['app', 'slack'], 'night: no push, no WhatsApp; in-app always');
  assert.deepEqual(N.routeChannels({ severity: 'P1' }, cfg, at('12:00')), ['app', 'slack', 'push'], 'P1 never WhatsApps');
  assert.deepEqual(N.routeChannels(p2, cfg, at('12:00')), ['app'], 'below min_severity: in-app only');
  assert.deepEqual(N.routeChannels(p0, { ...cfg, on: false }, at('12:00')), [], 'rule off: nothing');
  assert.deepEqual(N.routeChannels(p0, { ...cfg, quiet: false }, at('22:30')), ['app', 'slack', 'push'], 'quiet off: push at night, still no WhatsApp after 21:00');
  assert.deepEqual(N.routeChannels(p0, { ...cfg, muted: { x: { until: null } } }, at('12:00')), ['app'], 'muted entity: in-app only');
});

test('settings: defaults, validation, merge keeps app channel', () => {
  for (const r of N.RULES) { const c = N.mergeCfg(r.id, null); assert.ok(c.on && c.channels[0] === 'app' && N.SEVERITIES.includes(c.min_severity), r.id); }
  assert.equal(N.mergeCfg('weekly_digest', null).digest_hour, 9);
  assert.deepEqual(N.mergeCfg('new_lead', { channels: ['slack'] }).channels, ['app', 'slack']);
  assert.equal(N.validPatch('nope', { on: true }).ok, false);
  assert.equal(N.validPatch('new_lead', { min_severity: 'P9' }).ok, false);
  assert.equal(N.validPatch('new_lead', { channels: ['fax'] }).ok, false);
  assert.equal(N.validPatch('new_lead', { digest_hour: 24 }).ok, false);
  assert.equal(N.validPatch('new_lead', { color: 1 }).ok, false);
  assert.deepEqual(N.validPatch('new_lead', { on: false, channels: ['push', 'push'] }).patch, { on: false, channels: ['app', 'push'] });
});

test('rules fire from data', () => {
  const since = '2026-11-03T08:00:00.000Z';
  const leads = [{ id: 'L972501112222', phone: '972501112222', name: 'דנה', source: 'meta_form', status: 'new', created_at: '2026-11-03T09:00:00.000Z', last_text: 'חתונה במרץ' },
    { id: 'L972503334444', phone: '972503334444', status: 'quoted', created_at: '2026-10-01T09:00:00.000Z', last_inbound_at: '2026-11-03T09:30:00.000Z' },
    { id: 'L972505556666', phone: '972505556666', status: 'new', created_at: '2026-10-01T09:00:00.000Z' }];
  const nl = N.evaluate.new_lead(leads, since);
  assert.equal(nl.length, 1); assert.match(nl[0].title_he, /ליד חדש: דנה מטופס פייסבוק/); assert.match(nl[0].body_he, /חתונה במרץ/); assert.equal(nl[0].deep_link, '#/leads/L972501112222');
  const lr = N.evaluate.lead_reply(leads, since); assert.equal(lr.length, 1); assert.match(lr[0].title_he, /על ההצעה/);
  assert.equal(N.evaluate.payment([{ ref: 'A1', sum: 790, event: 'דנה ויוסי', package: 'בסיס', tok8: 'abcd1234', at: 'x' }])[0].deep_link, '#/clients?focus=abcd1234');
  assert.equal(N.evaluate.failures_spike({ today: 'd', wa: { totals: { sent_today: 100, rejected_today: 10, failed_async_today: 2 } } }).length, 0, '12 failures: under the floor');
  assert.equal(N.evaluate.failures_spike({ today: 'd', wa: { totals: { sent_today: 400, rejected_today: 30, failed_async_today: 25 } } })[0].severity, 'P0');
  assert.equal(N.evaluate.cap_high({ today: 'd', cap: { used: 84, limit: 100 } }).length, 0);
  assert.equal(N.evaluate.cap_high({ today: 'd', cap: { used: 85, limit: 100 } }).length, 1);
  const now = at('14:00');
  assert.equal(N.evaluate.hold_stale([{ tok8: 'a', since: new Date(now - 49 * 3600e3).toISOString() }, { tok8: 'b', since: new Date(now - 3600e3).toISOString() }, { tok8: 'c', since: null }], now).length, 1);
  const convs = [{ role: 'lead', phone: '972501', last_dir: 'in', last_in_ts: at('11:30') }, { role: 'lead', phone: '972502', last_dir: 'in', last_in_ts: at('12:30') },
    { role: 'guest', phone: '972503', last_dir: 'in', last_in_ts: at('08:00') }, { role: 'client', phone: '972504', last_dir: 'out', last_in_ts: at('08:00') }];
  assert.deepEqual(N.evaluate.unanswered(convs, now).map(x => x.entity), ['lead:972501'], 'only lead/client, last word theirs, ≥ 2 business hours');
  assert.equal(N.evaluate.unanswered([{ role: 'lead', phone: '1', last_dir: 'in', last_in_ts: at('20:00') }], at('09:30', '2026-11-04')).length, 0, 'overnight does not count: 1.5 business hours');
  const ev = [{ tok8: 'e1', names: 'א', date: '2026-11-06', readiness: N.readinessOf({ file_uploaded: false, counts: { invited: 0 }, addons: { hostesses: { n: 2, booked: false }, design: 'paid' } }, { invite: false, gifts: { on: true } }) },
    { tok8: 'e2', names: 'ב', date: '2026-11-09', readiness: [{ id: 'list', he: 'x', state: 'missing' }] }];
  const er = N.evaluate.event_readiness(ev, '2026-11-03');
  assert.equal(er.length, 1, 'only D-3 and closer'); assert.deepEqual(er[0].data.gaps, ['list', 'invite', 'design', 'hostess', 'gifts']);
  assert.equal(N.evaluate.balances_low({ vendors: [{ vendor: 'retell', status: 'low' }, { vendor: 'meta', status: 'ok' }] }).length, 1);
  const inc = N.evaluate.incident([{ id: 'f1', status: 'fail', severity: 'P1', state: 'needs_approval', title_he: 'הפייסר לא רץ' }, { id: 'f2', status: 'warn', severity: 'P1' }]);
  assert.equal(inc.length, 1); assert.equal(inc[0].severity, 'P0'); assert.match(inc[0].title_he, /מחכה לאישור/);
  const ch = N.evaluate.changes([{ id: 'c1', kind: 'deploy', summary_he: 'v1' }, { id: 'c2', kind: 'brain', actor: 'brain', summary_he: 'שוחרר' }, { id: 'c3', kind: 'brain', actor: 'Richard' }, { id: 'c4', kind: 'template', summary_he: 'תבנית נדחתה' }]);
  assert.deepEqual(ch.map(x => x.rule), ['deploy', 'brain_autofix', 'template_status']); assert.equal(ch[2].severity, 'P1');
});

test('deliver: de-dup per rule+entity in the window, channels, push queue, WhatsApp to Richard only P0 in hours', async () => {
  const env = envK(), d = stubD();
  const c = { rule: 'incident', severity: 'P0', entity: 'finding:x', title_he: 'הפייסר לא רץ' };
  const n1 = await N.deliver(env, d, c, { now: at('12:00') });
  assert.deepEqual(n1.channels, ['app', 'slack', 'push', 'whatsapp']); assert.equal(n1.stored, 'kv');
  assert.equal(d.sent.wa.length, 1); assert.equal(d.sent.wa[0].to, N.RICHARD_PHONE); assert.equal(d.sent.wa[0].ch, 'client');
  assert.equal(d.sent.slack.length, 1); assert.equal(d.sent.slack[0].o.urgent, true);
  assert.equal(JSON.parse(await env.RATE.get(N.PUSH_KEY)).length, 1);
  assert.equal(await N.deliver(env, d, c, { now: at('12:10') }), null, 'same rule+entity inside the window → dropped');
  assert.ok(await N.deliver(env, d, { ...c, entity: 'finding:y' }, { now: at('12:10') }), 'another entity fires');
  const night = await N.deliver(env, d, { ...c, entity: 'finding:z' }, { now: at('23:00') });
  assert.deepEqual(night.channels, ['app', 'slack']); assert.equal(d.sent.wa.length, 2, 'no WhatsApp at night');
  const env2 = envK({ 'cfg:notify:incident': JSON.stringify({ on: false }) });
  assert.equal(await N.deliver(env2, d, c, { now: at('12:00') }), null, 'rule off → nothing stored');
  const fail = { ...stubD(), sendText: async () => ({ ok: false, error: 'x' }) };
  const n3 = await N.deliver(envK(), fail, c, { now: at('12:00') });
  assert.ok(!n3.channels.includes('whatsapp'), 'a failed WhatsApp is not reported as delivered');
});

test('storage (KV ring): list newest first, unread count, mark read, snooze hides from unread', async () => {
  const env = envK(), d = stubD();
  const a = await N.deliver(env, d, { rule: 'deploy', entity: 'chg:1', title_he: 'א' }, { now: at('10:00') });
  const b = await N.deliver(env, d, { rule: 'deploy', entity: 'chg:2', title_he: 'ב' }, { now: at('11:00') });
  let l = await N.listNotifications(env, { now: at('12:00') });
  assert.deepEqual(l.items.map(x => x.id), [b.id, a.id]); assert.equal(l.unread, 2); assert.equal(l.source, 'kv');
  await N.markNotifications(env, [a.id], { read: true });
  l = await N.listNotifications(env, { unread: true, now: at('12:00') }); assert.deepEqual(l.items.map(x => x.id), [b.id]); assert.equal(l.unread, 1);
  await N.markNotifications(env, [b.id], { snooze_until: new Date(at('13:00')).toISOString() });
  assert.equal((await N.listNotifications(env, { unread: true, now: at('12:30') })).unread, 0);
  assert.equal((await N.listNotifications(env, { unread: true, now: at('13:30') })).unread, 1, 'snooze ends');
  const p = await N.listNotifications(env, { limit: 1, now: at('12:00') }); assert.equal(p.items.length, 1); assert.ok(p.next_cursor);
});

test('runNotify: the tick fires from state, de-dups the next tick, survives failing sources', async () => {
  const leads = { leads: { rows: { L972501112222: { id: 'L972501112222', phone: '972501112222', name: 'דנה', source: 'web', status: 'new', created_at: new Date(at('11:55')).toISOString() } } } };
  const env = envK({ 'ntf:tick': JSON.stringify({ at: new Date(at('11:50')).toISOString() }), 'crm:t:leads': JSON.stringify(leads.leads) });
  const d = { ...stubD(), ilDate: () => '2026-11-03', auditQueryEx: async () => ({ items: [] }) };
  const fns = { realtime: async () => ({ today: '2026-11-03', cap: { used: 90, limit: 100 }, wa: { totals: {} } }), balances: async () => ({ vendors: [{ vendor: 'retell', status: 'low' }] }), inbox: async () => ({ items: [] }) };
  const r = await N.runNotify(env, d, { now: at('12:00'), fns });
  const rules = r.fired.map(x => x.rule).sort();
  assert.ok(rules.includes('cap_high') && rules.includes('balances_low'), rules.join(','));
  const r2 = await N.runNotify(env, d, { now: at('12:10'), fns });
  assert.equal(r2.fired.filter(x => ['cap_high', 'balances_low'].includes(x.rule)).length, 0, 'second tick: de-duplicated');
  assert.ok(JSON.parse(await env.RATE.get('ntf:tick')).at.startsWith('2026-11-03T10:10'));
  const bad = await N.runNotify(env, d, { now: at('12:20'), fns: { ...fns, realtime: async () => { throw new Error('boom'); } } });
  assert.ok(bad.ok && bad.errors.some(e => e.startsWith('realtime')), 'one source failing never stops the tick');
});

test('weekly digest: only Sunday at the digest hour, once', async () => {
  const sun = h => at(h, '2026-11-08');
  const env = envK(), d = { ...stubD(), auditQueryEx: async () => ({ items: [] }) };
  const fns = { realtime: async () => ({}), balances: async () => ({ vendors: [] }), inbox: async () => ({ items: [] }) };
  assert.equal((await N.runNotify(env, d, { now: sun('08:30'), fns })).fired.filter(x => x.rule === 'weekly_digest').length, 0);
  assert.equal((await N.runNotify(env, d, { now: sun('09:05'), fns })).fired.filter(x => x.rule === 'weekly_digest').length, 1);
  assert.equal((await N.runNotify(env, d, { now: sun('09:15'), fns })).fired.filter(x => x.rule === 'weekly_digest').length, 0);
  assert.match(N.digestText({ revenue: 2380, orders: 3, leads: 9, closed: 2, sends: 1200, calls: 40 }), /₪2,380 הכנסות, 3 עסקאות, 9 לידים/);
});

test('waitingFor: approvals, replies, overdue reminders, readiness gaps, each with an action', () => {
  const now = at('12:00');
  const w = N.waitingFor({ pending: [{ id: 'p1', name_he: 'שחרור החזקה', finding_id: 'f1' }], convs: [{ role: 'lead', phone: '972501', last_dir: 'in', last_in_ts: at('10:00') }],
    reminders: [{ text: 'להתקשר', due_at: '2026-11-01T00:00:00Z', entity_type: 'lead', entity_id: 'L1' }], events: [{ tok8: 'e1', names: 'א', date: '2026-11-05', readiness: [{ id: 'list', he: 'רשימה', state: 'missing' }] }] }, now);
  assert.deepEqual(w.map(x => x.kind), ['approve', 'reply', 'reminder', 'event']);
  assert.deepEqual(w[0].action, { type: 'brain-decision', id: 'p1', confirm: 'p1' });
  assert.ok(w.every(x => x.href && x.title_he && x.action));
});

/* ── through the Worker ── */
const wenv = (init = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', RATE: kv(init) });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, p, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + p, { headers: { 'X-Admin-Key': key } }), e, ctx);
const post = (e, p, b) => worker.fetch(new Request('https://go.ishur.io' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...b }) }), e, ctx);

test('routes: auth, list, mark, settings via notify-settings and via /api/ops/edit, each change logged', async () => {
  const e = wenv();
  assert.equal((await get(e, '/api/ops/notifications', 'bad')).status, 403);
  await N.deliver(e, stubD(), { rule: 'deploy', entity: 'chg:9', title_he: 'גרסה' }, { now: Date.now() });
  const l = await (await get(e, '/api/ops/notifications?unread=1')).json();
  assert.equal(l.ok, true); assert.equal(l.unread, 1); assert.equal(l.items[0].title_he, 'גרסה');
  assert.equal((await post(e, '/api/ops/notifications/mark', { ids: [] })).status, 400);
  const m = await (await post(e, '/api/ops/notifications/mark', { ids: [l.items[0].id], read: true })).json(); assert.equal(m.updated, 1);
  assert.equal((await (await get(e, '/api/ops/notifications?unread=1')).json()).unread, 0);
  const s0 = await (await get(e, '/api/ops/notify-settings')).json();
  assert.equal(s0.rules.length, N.RULES.length); assert.ok(s0.rules.every(r => r.he && r.defaults && 'on' in r && Array.isArray(r.channels)));
  assert.equal((await post(e, '/api/ops/notify-settings', { rule: 'new_lead', patch: { min_severity: 'P7' } })).status, 400);
  const s1 = await (await post(e, '/api/ops/notify-settings', { rule: 'new_lead', patch: { on: false } })).json();
  assert.equal(s1.applied, true); assert.equal(s1.after.on, false); assert.ok(s1.change_id);
  const s2 = await (await post(e, '/api/ops/edit', { id: 'notify:cap_high', field: 'channels', value: ['slack', 'push'] })).json();
  assert.equal(s2.applied, true); assert.deepEqual(s2.after.channels, ['app', 'slack', 'push']);
  const ch = await (await get(e, '/api/ops/changes?kind=edit')).json();
  assert.equal(ch.items.filter(x => /^התראות · /.test(x.summary_he)).length, 2, 'both edits in the change log');
  const pq = await (await post(e, '/api/ops/notifications/push-pull', {})).json(); assert.equal(pq.ok, true);
  const plain = await (await post(e, '/api/ops/edit', { id: 'pacer_batch_size', value: 20 })).json(); assert.equal(plain.applied, false, 'normal settings still need the typed confirm');
});

test('overview payload shape (empty world, every section present)', async () => {
  const e = wenv();
  const seen = await (await post(e, '/api/ops/overview', { seen: true })).json(); assert.ok(seen.last_seen);
  const o = await (await get(e, '/api/ops/overview')).json();
  assert.equal(o.ok, true, JSON.stringify(o).slice(0, 300));
  for (const k of ['waiting', 'incidents', 'money', 'leads', 'events', 'changes', 'balances', 'notifications', 'spark_days', 'errors']) assert.ok(k in o, k);
  assert.equal(o.last_seen, seen.last_seen);
  for (const k of ['today', 'month', 'last_month_to_date', 'open_quotes', 'spark']) assert.ok(k in o.money, 'money.' + k);
  for (const k of ['new_today', 'waiting_1h', 'quoted', 'closed_today', 'spark']) assert.ok(k in o.leads, 'leads.' + k);
  assert.equal(o.money.spark.length, 7); assert.equal(o.spark_days.length, 7);
  assert.ok(Array.isArray(o.waiting) && Array.isArray(o.events) && Array.isArray(o.changes.items));
});

/* ── revenue merge + daily counters (coordinator 03/11) ── */
import * as CNT from '../counters.js';
test('mergeRevenue: Grow pay + sheet paid events + invoices, each sale once', () => {
  const pay = [{ day: '2026-10-25', sum: 790, ref: 'G1', tok8: 'aaaaaaaa', event: 'א' }, { day: '2026-10-26', sum: 390, ref: 'G2', tok8: '', event: 'בלי טוקן' }];
  const clients = [{ tok8: 'aaaaaaaa', token: 'aaaaaaaa-1', paid: true, paid_sum: 790, paid_at: '2026-10-25' },
    { tok8: 'bbbbbbbb', token: 'bbbbbbbb-1', paid: true, paid_sum: 1290, paid_at: '2026-09-14', names: 'ב' },
    { tok8: 'cccccccc', token: 'cccccccc-1', paid: true, paid_sum: 590, paid_at: '' },
    { tok8: 'dddddddd', token: 'dddddddd-1', paid: true, paid_sum: 450, paid_at: '' },
    { tok8: 'eeeeeeee', paid: false, paid_sum: 0 }];
  const invoices = { 'cccccccc-1': { at: '2026-10-02T10:00:00Z' }, 'ffffffff-1': { at: '2026-10-03T10:00:00Z', sum: 200 } };
  const s = N.mergeRevenue({ pay, clients, invoices });
  assert.equal(s.length, 6, s.map(x => x.key).join(','));
  assert.deepEqual(s.find(x => x.tok8 === 'aaaaaaaa').sources, ['grow', 'sheet'], 'same tok8 → one sale, both sources');
  assert.equal(s.find(x => x.tok8 === 'bbbbbbbb').day, '2026-09-14', 'sheet sale before Grow existed keeps its paid date');
  assert.equal(s.find(x => x.tok8 === 'cccccccc').day, '2026-10-02', 'no paid date → invoice date');
  assert.equal(s.find(x => x.tok8 === 'dddddddd').day, '', 'no date at all → undated');
  assert.equal(s.reduce((a, x) => a + x.sum, 0), 790 + 390 + 1290 + 590 + 450 + 200);
});
test('windows + buckets: week/month/3m by day, year by month, offset steps back', () => {
  const w = N.windowOf('week', 0, '2026-11-03'); assert.deepEqual([w.start, w.end, w.n], ['2026-10-28', '2026-11-03', 7]);
  const w1 = N.windowOf('month', 1, '2026-11-03'); assert.equal(w1.end, '2026-10-04');
  assert.equal(N.bucketsOf(w).length, 7); assert.equal(N.bucketsOf(N.windowOf('3m', 0, '2026-11-03')).length, 90);
  const y = N.windowOf('year', 0, '2026-11-03'); assert.equal(y.group, 'month'); assert.equal(N.bucketsOf(y).length, 13);
});
test('daily counters: audit rows bump cnt:<day>:<kind> + month rollup, backfill rebuilds a day, truncated read never writes', async () => {
  const e = { RATE: kv() };
  const ts = Date.parse('2026-11-03T10:00:00+02:00');
  await CNT.bumpFromAudit(e, { kind: 'wa_out', ok: true, ts }); await CNT.bumpFromAudit(e, { kind: 'wa_out', ok: false, ts }); await CNT.bumpFromAudit(e, { kind: 'call', ts }); await CNT.bumpFromAudit(e, { kind: 'wa_in', ts });
  assert.equal(await e.RATE.get('cnt:2026-11-03:wa_out'), '1'); assert.equal(await e.RATE.get('cnt:2026-11-03:wa_fail'), '1'); assert.equal(await e.RATE.get('cnt:2026-11-03:call'), '1'); assert.equal(await e.RATE.get('cnt:m:2026-11:wa_out'), '1');
  const r = await CNT.readCounters(e, '2026-11-02', '2026-11-03', ['wa_out']); assert.deepEqual(r.series.wa_out, [0, 1]);
  const rows = Array.from({ length: 5 }, (_, i) => ({ kind: 'wa_out', ok: true, ts: Date.parse('2026-10-20T12:00:00+03:00') + i }));
  const d = { auditQueryEx: async (_, q) => ({ items: q.kind === 'wa_out' ? rows : [], truncated: false }) };
  assert.equal((await CNT.backfillDay(e, d, '2026-10-20')).ok, true); assert.equal(await e.RATE.get('cnt:2026-10-20:wa_out'), '5');
  const dT = { auditQueryEx: async () => ({ items: [], truncated: true }) };
  assert.equal((await CNT.backfillDay(e, dT, '2026-10-20')).ok, false); assert.equal(await e.RATE.get('cnt:2026-10-20:wa_out'), '5', 'a truncated audit read leaves the counter alone');
  const bf = await CNT.backfillCounters(e, d, { now: ts, perRun: 2, converge: false }); assert.equal(bf.length, 2); assert.ok(await e.RATE.get('cnt:bf:' + bf[0].day));
});
test('ads insights parse + summary (CPL, ROAS)', () => {
  const rows = N.parseInsights([{ date_start: '2026-11-03', spend: '100', actions: [{ action_type: 'lead', value: '4' }, { action_type: 'onsite_conversion.lead_grouped', value: '4' }], action_values: [{ action_type: 'purchase', value: '790' }] }]);
  const s = N.adsSummary(rows, '2026-11-03'); assert.equal(s.today.cpl, 25); assert.equal(s.today.roas, 7.9); assert.equal(N.adsSummary(null, 'x'), null);
});
test('overview-series route: shape + honest reasons', async () => {
  const e = wenv();
  const o = await (await get(e, '/api/ops/overview-series?range=week')).json();
  assert.equal(o.ok, true, JSON.stringify(o).slice(0, 200)); assert.equal(o.buckets.length, 7);
  for (const k of ['revenue', 'orders', 'leads', 'sends', 'fails', 'calls']) assert.equal(o.series[k].length, 7, k);
  assert.match(o.why.ads, /META_ADS_TOKEN/); assert.ok('prev_totals' in o);
  const ov = await (await get(e, '/api/ops/overview')).json();
  for (const k of ['ads', 'traffic', 'funnel', 'growth', 'totals']) assert.ok(k in ov, k);
});
