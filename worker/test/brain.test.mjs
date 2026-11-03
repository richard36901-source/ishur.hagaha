// node --test worker/test/brain.test.mjs — brain.js: every check, every playbook, de-dup, escalation, pending approvals,
// and the three chat-side watchers (template / gift blast / wedding day) firing in the Worker.
// KV + deps are doubles; Meta/Telnyx/the agent hook are stubbed through globalThis.fetch; Slack is captured. Nothing leaves.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runBrain, buildBrain, decide, runLogAppend, PLAYBOOKS, CHECKS, assertCatalog, mergeFindings, P, clientHoursOpen } from '../brain.js';
import { withRun } from '../ops-run.js';

const ilDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
/* a fixed Wednesday, 13:00 Israel (UTC+2 in November) */
const WED13 = Date.parse('2026-11-04T11:00:00Z');
const TOK = 'c1c5fcf5-0000-4000-8000-0000000000aa';
const H = 3600e3, MIN = 60e3;

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }) };
}
const J = o => JSON.stringify(o);
let routes = [], calls = [], realFetch;
const route = (re, fn) => routes.push([re, fn]);
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ u, init });
    for (const [re, fn] of routes) if (re.test(u)) { const r = await fn(u, init); return r instanceof Response ? r : new Response(J(r)); }
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { routes = []; calls = []; });

function harness({ kvInit = {}, audit = [], snap = null, env: envX = {}, d: dx = {}, fns = {} } = {}) {
  const env = { WA_TOKEN_GUESTS: 'gt', WA_TOKEN: 'ct', RATE: kv(kvInit), ...envX };
  const slack = [], audits = [], sent = [], monday = { find: [], upsert: [] }, ed = [], gifts = [], probes = [];
  const d = {
    ilDate: dt => ilDay(dt), guestPhoneIds: () => ['A', 'B'], clientPhoneId: () => 'N', clientWaba: () => 'CW', clientToken: () => 'ct',
    sendingPaused: async () => false, sendWindowState: () => ({ open: true }),
    kvPrefix: async (e, prefix) => Object.fromEntries([...e.RATE.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v])),
    auditQueryEx: async () => ({ items: audit }), snapshotCached: async () => snap, fetchSnapshot: async () => snap,
    slackSend: async (e, t, o) => { slack.push({ t, urgent: !!(o && o.urgent) }); }, slackPost: async (e, t) => { slack.push({ t }); },
    auditRecord: async (e, r) => { audits.push(r); return r; },
    mondayFindLead: async (e, p) => { monday.find.push(p); return { found: false }; }, mondayUpsertLead: async (e, p) => { monday.upsert.push(p); return { ok: true, id: 'M' + p.slice(-3), created: true }; },
    runEventDayBlasts: async (e, o) => { ed.push(o); return { ok: true, res: [{ token: o.only.slice(0, 8), sent: o.dry ? 0 : 12 }] }; },
    giftBlast: async (e, token, o) => { gifts.push({ token, ...o }); return { ok: true, counts: { send: 5, sent: o.dry ? 0 : 5 } }; },
    waProbe: async (e, pid) => { probes.push(pid); return { ok: true, mode: 'health', detail: 'can_send_message=AVAILABLE' }; },
    sendText: async (e, to, text, ch) => { sent.push({ to, text, ch }); return { ok: true }; },
    ...dx,
  };
  return { env, d, slack, audits, sent, monday, ed, gifts, probes, fns, run: (o = {}) => runBrain(env, d, { sleep: async () => {}, fns, ...o }) };
}
const finding = (h, id) => JSON.parse(h.env.RATE.m.get(P.finding + id) || 'null');
const pendings = h => [...h.env.RATE.m.entries()].filter(([k]) => k.startsWith(P.pending) && k !== P.pending + 'index').map(([, v]) => JSON.parse(v));
const runsOf = (h, aid) => [...h.env.RATE.m.entries()].filter(([k]) => k.startsWith('opsrun:')).map(([, v]) => JSON.parse(v)).filter(r => !aid || r.automation_id === aid);

/* ── catalog ── */
test('catalog: auto only for cap probe, snapshot retry, Monday item, capacity warning; messaging playbooks can never be auto', () => {
  assert.deepEqual(PLAYBOOKS.filter(p => p.auto).map(p => p.id).sort(), ['cap_probe_release', 'capacity_warning', 'lead_monday_create', 'snapshot_retry']);
  assert.ok(PLAYBOOKS.filter(p => p.messages).every(p => !p.auto));
  assert.throws(() => assertCatalog([{ id: 'x', messages: true, auto: true }]), /cannot be auto/);
  assert.equal(new Set(CHECKS.map(c => c.id)).size, CHECKS.length);
});

test('mergeFindings: new → open, gone after its check ran → resolved, check not run → untouched', () => {
  const now = Date.now();
  const a = mergeFindings({}, [{ id: 'x:1', check_id: 'x', status: 'warn', title_he: 't' }], { now, ranChecks: ['x'] });
  assert.equal(a.next['x:1'].state, 'open'); assert.equal(a.events[0].type, 'new');
  const b = mergeFindings(a.next, [], { now, ranChecks: ['y'] });
  assert.equal(Object.keys(b.next).length, 0, 'check x did not run → nothing resolved');
  const c = mergeFindings(a.next, [], { now, ranChecks: ['x'] });
  assert.equal(c.next['x:1'].state, 'resolved');
  const e = mergeFindings(a.next, [], { now, ranChecks: ['x'], failedChecks: ['x'] });
  assert.equal(Object.keys(e.next).length, 0, 'a failed check resolves nothing');
});

/* ── 1. template watcher (chat watcher #1, now in the Worker) ── */
test('template_watch: PENDING > 24 h → warn + pending variant (copy _v2, category flipped); new REJECTED → fail + Slack; PENDING→APPROVED → Slack note', async () => {
  const now = Date.now();
  const h = harness({ kvInit: { [P.tmpl]: J({ base: true, t: { '1378764257421712/wave1_x/he': { status: 'PENDING', since: now - 26 * H }, '1378764257421712/old_ok/he': { status: 'PENDING', since: now - 2 * H } } }) } });
  route(/1378764257421712\/message_templates\?fields=name,status/, () => ({ data: [{ name: 'wave1_x', status: 'PENDING', category: 'MARKETING', language: 'he' }, { name: 'brand_new', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', language: 'he' }, { name: 'old_ok', status: 'APPROVED', language: 'he' }] }));
  route(/CW\/message_templates\?fields=name,status/, () => ({ data: [] }));
  route(/message_templates\?name=wave1_x/, () => ({ data: [{ name: 'wave1_x', status: 'PENDING', category: 'MARKETING', language: 'he', components: [{ type: 'BODY', text: 'שלום {{1}}' }] }] }));
  route(/message_templates\?fields=name&limit/, () => ({ data: [{ name: 'wave1_x' }] }));
  const r = await h.run({ only: 'template_watch' });
  assert.equal(r.ok, true);
  const pend = finding(h, 'template_watch:pending:wave1_x:he');
  assert.equal(pend.status, 'warn'); assert.equal(pend.state, 'needs_approval'); assert.equal(pend.playbook, 'template_variant');
  const pa = pendings(h).find(x => x.finding_id === pend.id);
  assert.equal(pa.preview.name, 'wave1_x_v2'); assert.equal(pa.preview.category, 'UTILITY', 'MARKETING → UTILITY');
  assert.ok(!calls.some(c => c.init.method === 'POST'), 'the preview never POSTs to Meta');
  const rej = finding(h, 'template_watch:rejected:brand_new:he');
  assert.equal(rej.status, 'fail');
  assert.ok(h.slack.some(s => /נדחתה/.test(s.t)), 'rejected → Slack');
  assert.ok(h.slack.some(s => /old_ok אושרה/.test(s.t)), 'PENDING → APPROVED is announced');
  /* approve the variant: typed confirm required, then one POST to Meta */
  const noConf = await decide(h.env, h.d, { id: pa.id, approve: true });
  assert.equal(noConf.body.applied, false); assert.equal(noConf.body.confirm_required, 'template_variant');
  route(/1378764257421712\/message_templates$/, (u, init) => ({ id: 'T2', status: 'PENDING', echo: JSON.parse(init.body) }));
  const ok = await decide(h.env, h.d, { id: pa.id, approve: true, confirm: 'template_variant', who: 'richard' });
  assert.equal(ok.body.applied, true); assert.equal(ok.body.action.state, 'done');
  const post = calls.find(c => c.init.method === 'POST' && /message_templates$/.test(c.u));
  assert.equal(JSON.parse(post.init.body).name, 'wave1_x_v2');
  assert.ok(runsOf(h, 'brain_fix:template_variant').length >= 1, 'ledger row for the fix');
  assert.ok(h.audits.some(a => /template_variant/.test(a.action)), 'audit line');
});

/* ── 2. cap hold ── */
test('cap_hold_stale: held 2 h, backoff over, Meta AVAILABLE → finding + auto probe releases wacap:A (and the global hold); backoff still on → nothing', async () => {
  const now = Date.now();
  const h = harness({ kvInit: { 'wacap:A': new Date(now - 2 * H).toISOString(), 'wacapuntil:A': String(now - MIN), 'wacapn:A': '3', 'wacap:guests': '1', 'wacap:B': new Date(now - 10 * MIN).toISOString(), 'wacapuntil:B': String(now + H) } });
  route(/\/A\?fields=health_status/, () => ({ health_status: { can_send_message: 'AVAILABLE' } }));
  route(/\/B\?fields=health_status/, () => ({ health_status: { can_send_message: 'BLOCKED' } }));
  await h.run({ only: 'cap_hold_stale' });
  assert.ok(finding(h, 'cap_hold_stale:A'), 'A is stale');
  assert.equal(finding(h, 'cap_hold_stale:B'), null, 'B is inside its backoff');
  assert.deepEqual(h.probes, ['A']);
  assert.ok(!h.env.RATE.m.has('wacap:A') && !h.env.RATE.m.has('wacapuntil:A') && !h.env.RATE.m.has('wacapn:A'));
  assert.ok(h.env.RATE.m.has('wacap:guests'), 'global hold stays while B is still held');
  assert.ok(runsOf(h, 'brain_fix:cap_probe_release').some(r => r.status === 'ok'));
});
test('cap_probe_release: a failed probe keeps the hold', async () => {
  const now = Date.now();
  const h = harness({ kvInit: { 'wacap:A': new Date(now - 25 * H).toISOString() }, d: { waProbe: async () => ({ ok: false, mode: 'template', detail: '131048' }) } });
  route(/health_status/, () => ({ health_status: { can_send_message: 'LIMITED' } }));
  await h.run({ only: 'cap_hold_stale' });
  assert.ok(h.env.RATE.m.has('wacap:A'));
});

/* ── 3. pacer tick + de-dup + agent escalation ── */
test('pacer_tick: 40 min silent → fail, ONE Slack alert in 6 h, and ONE agent-hook POST with the finding JSON', async () => {
  const now = Date.now();
  const h = harness({ kvInit: { 'pacer:last': J({ at: new Date(now - 40 * MIN).toISOString() }) }, env: { BRAIN_AGENT_HOOK: 'https://agent.test/hook', BRAIN_AGENT_HOOK_TOKEN: 'tt' } });
  route(/agent\.test/, () => ({ ok: true }));
  await h.run({ only: 'pacer_tick' });
  await h.run({ only: 'pacer_tick' });
  const f = finding(h, 'pacer_tick');
  assert.equal(f.status, 'fail'); assert.equal(f.severity, 'P1');
  assert.equal(h.slack.filter(s => /הפייסר לא רץ/.test(s.t)).length, 1, 'de-duplicated within 6 h');
  const hooks = calls.filter(c => /agent\.test/.test(c.u));
  assert.equal(hooks.length, 1, 'escalated once');
  const body = JSON.parse(hooks[0].init.body);
  assert.equal(body.finding.id, 'pacer_tick'); assert.match(body.run_id, /^r/); assert.equal(hooks[0].init.headers.Authorization, 'Bearer tt');
  assert.ok(runsOf(h, 'brain_agent').length === 1);
  /* the external agent streams into that run */
  const a = await runLogAppend(h.env, { run_id: body.run_id, lines: ['קראתי את pacer:last', 'השערה: הקרון נתקע'] });
  assert.equal(a.status, 200); assert.equal(a.body.appended, 2);
  const br = await buildBrain(h.env);
  assert.ok(br.stream.some(l => l.src === 'agent' && /השערה/.test(l.text)));
  const since = br.cursor;
  await runLogAppend(h.env, { run_id: body.run_id, line: 'מסקנה' });
  const br2 = await buildBrain(h.env, { since });
  assert.deepEqual(br2.stream.map(l => l.text), ['מסקנה'], 'since cursor returns only new lines');
  /* 6 h later: alerted again */
  await h.run({ only: 'pacer_tick', now: now + 6.1 * H });
  assert.equal(h.slack.filter(s => /הפייסר לא רץ/.test(s.t)).length, 2);
});
test('pacer_tick: fresh tick → no finding; the old one resolves', async () => {
  const now = Date.now();
  const h = harness({ kvInit: { 'pacer:last': J({ at: new Date(now - 40 * MIN).toISOString() }) } });
  await h.run({ only: 'pacer_tick' });
  h.env.RATE.m.set('pacer:last', J({ at: new Date().toISOString() }));
  await h.run({ only: 'pacer_tick' });
  assert.equal(finding(h, 'pacer_tick').state, 'resolved');
});

/* ── 4. snapshot ── */
test('snapshot_fail: 2× no-snapshot in 30 min → auto retry; third try loads → pacer:pending re-armed', async () => {
  const now = Date.now(); let n = 0;
  const audit = [{ ts: now - 5 * MIN, at: '', kind: 'cron', action: '⚙️ runPacer', detail: '{"error":"no-snapshot"}' }, { ts: now - 15 * MIN, at: '', kind: 'cron', action: '⚙️ runPacer', detail: '{"error":"no-snapshot"}' }];
  const h = harness({ audit, d: { fetchSnapshot: async () => (++n < 3 ? null : { events: { values: [] }, guests: { values: [] } }) } });
  await h.run({ only: 'snapshot_fail' });
  assert.equal(finding(h, 'snapshot_fail').status, 'fail');
  assert.equal(n, 3);
  assert.equal(h.env.RATE.m.get('pacer:pending'), ilDay());
  const log = JSON.parse(h.env.RATE.m.get(P.log + runsOf(h, 'brain_fix:snapshot_retry')[0].id));
  assert.ok(log.lines.some(l => /ניסיון 3: נטען/.test(l.text)), 'step log');
});
test('snapshot_retry: 3 failures → P1 Slack', async () => {
  const now = Date.now();
  const audit = [1, 2].map(i => ({ ts: now - i * MIN, kind: 'cron', action: 'x', detail: 'no-snapshot' }));
  const h = harness({ audit, d: { fetchSnapshot: async () => null } });
  await h.run({ only: 'snapshot_fail' });
  assert.ok(h.slack.some(s => /3 ניסיונות נכשלו/.test(s.t) && s.urgent));
});

/* ── 5. Noa 131042 ── */
test('noa_billing: billingalert:client → P1 fail, no playbook', async () => {
  const h = harness({ kvInit: { 'billingalert:client': '1' } });
  await h.run({ only: 'noa_billing' });
  const f = finding(h, 'noa_billing'); assert.equal(f.severity, 'P1'); assert.equal(f.playbook, null);
});

/* ── 6. Telnyx ── */
test('telnyx_order: a pending order → pending nudge; approval posts ONE comment on the order', async () => {
  const h = harness({ env: { TELNYX_KEY: 'tk' } });
  route(/number_orders\?filter\[status\]=pending/, () => ({ data: [{ id: 'ord1', created_at: new Date(Date.now() - 3 * 86400e3).toISOString(), phone_numbers: [{ phone_number: '+972500000000' }] }] }));
  route(/v2\/comments/, () => ({ data: { id: 'c1' } }));
  await h.run({ only: 'telnyx_order' });
  const pa = pendings(h).find(p => p.playbook === 'telnyx_nudge');
  assert.ok(pa && pa.preview.comment_record_id === 'ord1');
  assert.ok(!calls.some(c => /comments/.test(c.u)), 'nothing posted before approval');
  const r = await decide(h.env, h.d, { id: pa.id, approve: true, confirm: 'telnyx_nudge' });
  assert.equal(r.body.result.ok, true);
  assert.equal(calls.filter(c => /v2\/comments/.test(c.u)).length, 1);
});
test('telnyx_order: no TELNYX_KEY → check is silent', async () => {
  const h = harness();
  await h.run({ only: 'telnyx_order' });
  assert.equal(calls.filter(c => /telnyx/.test(c.u)).length, 0);
});

/* ── 7. Monday ── */
test('lead_monday: lead without a known item → auto find (read) then create; known ones untouched; next run resolves', async () => {
  const old = new Date(Date.now() - 2 * H).toISOString();
  const h = harness({ env: { MONDAY_API_TOKEN: 'm' }, kvInit: { 'lead:972521111111': J({ name: 'א', at: old }), 'lead:972522222222': J({ name: 'ב', at: old }), 'leadx:972522222222': J({ mondayId: '99' }), 'lead:972523333333': J({ name: 'ג', at: new Date().toISOString() }) } });
  await h.run({ only: 'lead_monday' });
  assert.deepEqual(h.monday.find, ['972521111111']);
  assert.deepEqual(h.monday.upsert, ['972521111111'], 'created only after the read-only lookup missed');
  assert.equal(JSON.parse(h.env.RATE.m.get(P.monday))['972521111111'], 'M111');
  await h.run({ only: 'lead_monday', force: true });
  assert.equal(finding(h, 'lead_monday').state, 'resolved');
});

/* ── 8. 131047 ── */
test('reply_wrong_number: 131047 today → pending requeue; approval re-sends from the number the guest wrote to', async () => {
  const now = Date.now();
  const audit = [
    { ts: now - 10 * MIN, at: '', kind: 'wa_out', ok: false, phone: '972524444444', area: 'שיר', detail: '131047: Re-engagement message · תודה, נרשם 🙂', data: { phone_id: 'B' } },
    { ts: now - 30 * MIN, at: '', kind: 'wa_in', area: 'שיר', phone: '972524444444', detail: 'מגיע' },
  ];
  const h = harness({ audit });
  await h.run({ only: 'reply_wrong_number' });
  const pa = pendings(h).find(p => p.playbook === 'requeue_reply');
  assert.ok(pa); assert.equal(pa.preview[0].channel, 'guests'); assert.ok(!JSON.stringify(pa.preview).includes('972524444444'), 'phone masked in the preview');
  assert.equal(h.sent.length, 0);
  await decide(h.env, h.d, { id: pa.id, approve: true, confirm: 'requeue_reply' });
  assert.deepEqual(h.sent, [{ to: '972524444444', text: 'תודה, נרשם 🙂', ch: 'guests' }]);
});
test('requeue_reply: a client reply is refused at night even after approval', async () => {
  const night = Date.parse('2026-11-04T21:30:00Z'); /* 23:30 IL */
  const audit = [{ ts: night - 10 * MIN, kind: 'wa_out', ok: false, phone: '972525555555', detail: '131047 · שלום', data: {} }, { ts: night - 20 * MIN, kind: 'wa_in', area: 'נועה', phone: '972525555555' }];
  const h = harness({ audit, d: { ilDate: () => ilDay(new Date(night)) } });
  /* ilDay(r.ts) must equal today: use the same night clock */
  await h.run({ only: 'reply_wrong_number', now: night });
  const pa = pendings(h).find(p => p.playbook === 'requeue_reply');
  assert.ok(pa);
  const realNow = Date.now; Date.now = () => night;
  try { await decide(h.env, h.d, { id: pa.id, approve: true, confirm: 'requeue_reply' }, night); } finally { Date.now = realNow; }
  assert.equal(h.sent.length, 0, 'client messaging hours enforced in code');
});

/* ── 9. capacity ── */
test('capacity_overflow: overflow tomorrow → auto Slack warning with the recommended plan (once per 6 h)', async () => {
  const today = ilDay(), tomorrow = ilDay(new Date(Date.now() + 864e5));
  const cap = { ok: true, days: [{ day: today, planned: 100, capacity: 230, overflow: 0, by_event: [] }, { day: tomorrow, planned: 400, capacity: 230, overflow: 170, by_event: [{ name: 'אירוע א', type: 'w1', count: 400 }] }],
    recommendations: [{ due: tomorrow, he: 'להקדים 170 הודעות של אירוע א להיום' }] };
  const h = harness({ fns: { buildCapacity: async () => cap } });
  await h.run({ only: 'capacity_overflow' });
  await h.run({ only: 'capacity_overflow', force: true });
  const msgs = h.slack.filter(s => /חריגת קיבולת/.test(s.t));
  assert.equal(msgs.length, 1); assert.match(msgs[0].t, /להקדים 170/);
  assert.equal(finding(h, 'capacity_overflow:' + tomorrow).severity, 'P2');
});

/* ── 10. Noa unanswered ── */
test('noa_unanswered: lead wrote to 4499 3 h ago, no reply → warn in business hours; silent at night', async () => {
  const audit = [{ ts: WED13 - 3 * H, kind: 'wa_in', area: 'נועה', phone: '972526666666' }, { ts: WED13 - 3 * H, kind: 'wa_in', area: 'נועה', phone: '972527777777' }, { ts: WED13 - H, kind: 'wa_out', ok: true, area: 'נועה', phone: '972527777777', data: { phone_id: 'N' } }];
  const h = harness({ audit, kvInit: { 'lead:972526666666': '{}', 'lead:972527777777': '{}' } });
  await h.run({ only: 'noa_unanswered', now: WED13 });
  const f = finding(h, 'noa_unanswered'); assert.ok(f); assert.match(f.title_he, /^1 פניות/);
  const h2 = harness({ audit, kvInit: { 'lead:972526666666': '{}' } });
  await h2.run({ only: 'noa_unanswered', now: Date.parse('2026-11-04T20:30:00Z') });
  assert.equal(finding(h2, 'noa_unanswered'), null);
  assert.equal(clientHoursOpen(Date.parse('2026-11-07T10:00:00Z')), false, 'Shabbat');
});

/* ── 11–14 ── */
test('balances_low: a vendor below threshold → warn', async () => {
  const h = harness({ fns: { buildBalances: async () => ({ vendors: [{ vendor: 'telnyx', status: 'low', amount: 3, currency: 'USD', low_threshold: 10, source: 'api' }, { vendor: 'retell', status: 'ok' }] }) } });
  await h.run({ only: 'balances_low' });
  assert.ok(finding(h, 'balances_low:telnyx')); assert.equal(finding(h, 'balances_low:retell'), null);
});
test('d1_ledger: unbound → P3 warn; bound but throwing → fail', async () => {
  const h = harness(); await h.run({ only: 'd1_ledger' });
  assert.equal(finding(h, 'd1_ledger').severity, 'P3');
  const bad = { prepare: () => ({ bind() { return this; }, first: async () => { throw new Error('D1_ERROR'); }, run: async () => { throw new Error('D1_ERROR'); }, all: async () => { throw new Error('D1_ERROR'); } }) };
  const h2 = harness({ env: { OPS_DB: bad } }); await h2.run({ only: 'd1_ledger' });
  assert.equal(finding(h2, 'd1_ledger').status, 'fail');
});
test('failed_runs: a failed run in the last hour → finding per automation (brain_health itself excluded)', async () => {
  const h = harness();
  await withRun(h.env, 'wave1', async () => { throw new Error('boom'); }).catch(() => {});
  await h.run({ only: 'failed_runs' });
  const f = finding(h, 'failed_runs:wave1'); assert.equal(f.severity, 'P1'); assert.match(f.detail, /boom/);
});
test('biz_verification: status change is recorded with history and refreshes biz:verif', async () => {
  const h = harness({ kvInit: { [P.biz]: J({ status: 'not_verified', at: 0, history: [] }) } });
  route(/business_verification_status/, () => ({ business_verification_status: 'verified' }));
  await h.run({ only: 'biz_verification' });
  const st = JSON.parse(h.env.RATE.m.get(P.biz));
  assert.equal(st.history[0].to, 'verified'); assert.equal(JSON.parse(h.env.RATE.m.get('biz:verif')).verified, true);
  assert.ok(finding(h, 'biz_verification'));
});

/* ── 15. gift blast watcher (chat watcher #2) ── */
test('gift_blast: failures/waiting in today\'s blast → fail + pending resume; approval runs ONE real slice through the gift-blast handler', async () => {
  const audit = [{ ts: Date.now() - 20 * MIN, at: new Date().toISOString(), kind: 'event', action: 'מתנה לאורחים אחרי האירוע (gift-blast)', ok: false, token: TOK, detail: 'נשלחו 30 · נכשלו 2 · ממתינים 14 · דולגו 1' }];
  const h = harness({ audit });
  await h.run({ only: 'gift_blast' });
  const f = finding(h, 'gift_blast:c1c5fcf5'); assert.equal(f.status, 'fail');
  const pa = pendings(h).find(p => p.playbook === 'gift_blast_resume');
  assert.deepEqual(h.gifts, [{ token: TOK, dry: true, max: 50 }], 'the preview is a dry run');
  await decide(h.env, h.d, { id: pa.id, approve: true, confirm: 'gift_blast_resume' });
  assert.deepEqual(h.gifts[1], { token: TOK, dry: false, max: 50 });
});

/* ── 16. wedding-day recovery (chat watcher #3) ── */
test('wedding_day: event today is on hold + its event-day message not out at 13:00 → two P1 findings; approvals unpark and re-run the blast', async () => {
  const ev = Array(50).fill(''); ev[1] = TOK; ev[2] = 'לקוח'; ev[6] = '2026-11-04'; ev[7] = 'כן'; ev[34] = 'אורי ויצחק';
  const h = harness({ snap: { events: { values: [ev] }, guests: { values: [] } }, kvInit: { ['hold:' + TOK]: '2026-11-01T00:00:00Z', ['edblast:' + TOK]: J({ at: '2026-11-04', what: 'חניה בחניון' }) } });
  await h.run({ only: 'wedding_day', now: WED13 });
  const hold = finding(h, 'wedding_day:hold:c1c5fcf5'), blast = finding(h, 'wedding_day:blast:c1c5fcf5');
  assert.equal(hold.severity, 'P1'); assert.equal(blast.severity, 'P1');
  assert.equal(h.slack.filter(s => /מוח/.test(s.t) && s.urgent).length, 2, 'both alerted as urgent');
  const pas = pendings(h);
  const pHold = pas.find(p => p.playbook === 'event_hold'), pBlast = pas.find(p => p.playbook === 'eventday_retry');
  assert.ok(pHold && pBlast);
  assert.deepEqual(h.ed, [{ only: TOK, dry: true }], 'preview = dry event-day run');
  await decide(h.env, h.d, { id: pHold.id, approve: true, confirm: 'event_hold' });
  assert.ok(!h.env.RATE.m.has('hold:' + TOK), 'unparked');
  await decide(h.env, h.d, { id: pBlast.id, approve: true, confirm: 'eventday_retry' });
  assert.deepEqual(h.ed[1], { only: TOK, dry: false });
  /* before 12:00 the blast check stays quiet */
  const h2 = harness({ snap: { events: { values: [ev] }, guests: { values: [] } }, kvInit: { ['edblast:' + TOK]: J({ at: '2026-11-04' }) } });
  await h2.run({ only: 'wedding_day', now: Date.parse('2026-11-04T08:00:00Z') });
  assert.equal(finding(h2, 'wedding_day:blast:c1c5fcf5'), null);
});

/* ── lifecycle ── */
test('a resolved finding makes its pending action obsolete; reject is recorded and runs nothing', async () => {
  const h = harness({ env: { TELNYX_KEY: 'tk' } });
  let pending = true;
  route(/number_orders/, () => ({ data: pending ? [{ id: 'o9' }] : [] }));
  await h.run({ only: 'telnyx_order' });
  const pa = pendings(h)[0];
  const rj = await decide(h.env, h.d, { id: pa.id, approve: false, who: 'richard' });
  assert.equal(rj.body.action.state, 'rejected');
  assert.equal((await decide(h.env, h.d, { id: pa.id, approve: true, confirm: 'telnyx_nudge' })).status, 409);
  pending = false;
  await h.run({ only: 'telnyx_order', force: true });
  assert.equal(finding(h, 'telnyx_order:o9').state, 'resolved');
});
test('a throwing check → "<id>:error" warn; it resolves nothing else', async () => {
  const h = harness({ kvInit: { 'billingalert:client': '1' } });
  await h.run({ only: 'noa_billing' });
  h.env.RATE.m.delete('billingalert:client');
  const orig = CHECKS.find(c => c.id === 'noa_billing').run;
  CHECKS.find(c => c.id === 'noa_billing').run = async () => { throw new Error('kv down'); };
  try { await h.run({ only: 'noa_billing' }); } finally { CHECKS.find(c => c.id === 'noa_billing').run = orig; }
  assert.equal(finding(h, 'noa_billing').state, 'open', 'not resolved by a failed check');
  assert.equal(finding(h, 'noa_billing:error').status, 'warn');
});
test('BRAIN_AUTOFIX=off: auto playbooks do not run', async () => {
  const h = harness({ env: { BRAIN_AUTOFIX: 'off' }, kvInit: { 'wacap:A': new Date(Date.now() - 25 * H).toISOString() } });
  route(/health_status/, () => ({ health_status: { can_send_message: 'AVAILABLE' } }));
  await h.run({ only: 'cap_hold_stale' });
  assert.equal(h.probes.length, 0); assert.ok(h.env.RATE.m.has('wacap:A'));
});
test('due(): hourly checks skip on the next 10-minute tick', async () => {
  const h = harness({ env: { TELNYX_KEY: 'tk' } });
  route(/number_orders/, () => ({ data: [] }));
  await h.run();
  const n1 = calls.filter(c => /number_orders/.test(c.u)).length;
  await h.run({ now: Date.now() + 10 * MIN });
  assert.equal(calls.filter(c => /number_orders/.test(c.u)).length, n1, 'telnyx_order is hourly');
  const last = JSON.parse(h.env.RATE.m.get(P.last));
  assert.ok(last.checks.pacer_tick && last.checks.telnyx_order);
});
test('buildBrain: shape the Brain screen reads (findings open/resolved, pending, playbooks with auto, runs, stream, cursor), no raw data / phones', async () => {
  const h = harness({ env: { MONDAY_API_TOKEN: 'm' }, kvInit: { 'lead:972528888888': J({ at: '2020-01-01' }) }, d: { mondayUpsertLead: async () => ({ ok: false, why: 'x' }) } });
  await h.run({ only: 'lead_monday' });
  const b = await buildBrain(h.env);
  for (const k of ['last_check_at', 'checks', 'findings', 'pending', 'playbooks', 'runs', 'stream', 'cursor']) assert.ok(k in b, k);
  assert.ok(Array.isArray(b.findings.open) && Array.isArray(b.findings.resolved));
  assert.equal(b.playbooks.find(p => p.id === 'lead_monday_create').auto, true);
  assert.ok(b.runs.some(r => r.automation_id === 'brain_health'));
  assert.ok(!JSON.stringify(b).includes('972528888888'), 'no unmasked phone');
  assert.ok(!('data' in b.findings.open[0]), 'playbook data is server-side only');
});

/* ── 04/11 call_round_not_dialing: שילת ושי (395962fa…, 73 guests, free round 03/11) must dial at 10:00 ── */
const SHILAT = '395962fa-0000-4000-8000-0000000000cc';
const WED1030 = Date.parse('2026-11-04T08:30:00Z');   /* 10:30 Israel */
function callHarness({ kvx = {}, at = WED1030, dx = {} } = {}) {
  const ev = Array(40).fill(''); ev[1] = SHILAT; ev[6] = '2026-11-12'; ev[7] = 'כן'; ev[31] = 'בסיס'; ev[34] = 'שילת ושי';
  const queue = Array.from({ length: 73 }, (_, i) => ({ token: SHILAT, guest_id: 'G' + i, phone: '97250' + String(1000000 + i), event_date: '2026-11-12' }));
  const h = harness({ kvInit: { ['callround:' + SHILAT]: J({ at: '2026-11-04', guest_ids: queue.map(g => g.guest_id), done: '2026-11-04T07:00:00Z', flagged: 73 }), ...kvx },
    snap: { events: { values: [ev] }, guests: { values: [] } }, env: { RETELL_KEY: 'r', SHIR_FROM: '+972' },
    d: { buildCallQueue: () => ({ queue }), planKeyOf: e => (/בסיס/.test(e[31]) ? 'basic' : 'pro'), callWindowState: () => ({ open: true }), isNoContactDay: () => false, dailyCallCap: () => 0,
      runShirDispatch: async (e, o) => { h.kicks = (h.kicks || []).concat(o); return { ok: true, dialed: 6, queued: 73 }; }, ...dx } });
  return { h, at };
}

test('call_round_not_dialing: 10:30, 73 queued, 0 dials → P1 finding with the reason, Slack line, pending call_round_kick (not auto)', async () => {
  const { h, at } = callHarness({ kvx: { 'auto:off:shir_dispatch': '1' } });
  await h.run({ now: at, only: 'call_round_not_dialing' });
  const f = finding(h, 'call_round_not_dialing:395962fa');
  assert.ok(f, 'finding exists'); assert.equal(f.status, 'fail'); assert.equal(f.severity, 'P1'); assert.equal(f.playbook, 'call_round_kick');
  assert.match(f.title_he, /שילת ושי.*73 בתור ו-0 חיוגים/);
  assert.match(f.detail, /מתג כיבוי: shir_dispatch/);
  assert.ok(h.slack.some(s => /שילת ושי/.test(s.t) && s.urgent), 'urgent Slack line');
  const p = pendings(h).filter(x => x.playbook_id === 'call_round_kick' || x.playbook === 'call_round_kick');
  assert.equal(p.length, 1, 'kick waits for approval'); assert.equal(h.kicks, undefined, 'nothing dialed by the check');
});

test('call_round_not_dialing: stays quiet when a dial happened <60 min ago, before 10:20, after 19:00, on Saturday, or when everyone was tried today', async () => {
  const quiet = async (o, at) => { const { h } = callHarness(o); await h.run({ now: at || WED1030, only: 'call_round_not_dialing' }); return finding(h, 'call_round_not_dialing:395962fa'); };
  assert.equal(await quiet({ kvx: { ['calllast:' + SHILAT]: new Date(WED1030 - 20 * MIN).toISOString() } }), null);
  assert.equal(await quiet({}, Date.parse('2026-11-04T08:10:00Z')), null);   /* 10:10 */
  assert.equal(await quiet({}, Date.parse('2026-11-04T17:10:00Z')), null);   /* 19:10 */
  assert.equal(await quiet({}, Date.parse('2026-11-07T08:30:00Z')), null);   /* Saturday */
  const tried = Object.fromEntries(Array.from({ length: 73 }, (_, i) => [`shirtry:G${i}:2026-11-04`, '1']));
  assert.equal(await quiet({ kvx: tried }), null);
  /* a stale dial (>60 min) fires again; unknown reason is said out loud */
  const f = await quiet({ kvx: { ['calllast:' + SHILAT]: new Date(WED1030 - 90 * MIN).toISOString() } });
  assert.ok(f && /סיבה לא ידועה/.test(f.detail), f && f.detail);
  /* no round, no addon, basic plan → not this check's business */
  const { h } = callHarness({}); h.env.RATE.m.delete('callround:' + SHILAT); await h.run({ now: WED1030, only: 'call_round_not_dialing' });
  assert.equal(finding(h, 'call_round_not_dialing:395962fa'), null);
});

test('call_round_kick: approved → runShirDispatch (max 6); dry → preview only', async () => {
  const { h } = callHarness();
  const pb = PLAYBOOKS.find(p => p.id === 'call_round_kick');
  assert.equal(pb.auto, false);
  const c = { env: h.env, d: h.d, now: WED1030 };
  const f = { data: { token: SHILAT, queued: 73, dialable: 73, reasons: ['x'] } };
  const dry = await pb.run(c, f, { dry: true, log: () => {} });
  assert.equal(dry.ok, true); assert.equal(h.kicks, undefined);
  const real = await pb.run(c, f, { dry: false, log: () => {} });
  assert.equal(real.ok, true); assert.deepEqual(h.kicks, [{ max: 6, quiet: true }]);
});
