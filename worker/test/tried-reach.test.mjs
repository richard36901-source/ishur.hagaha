// node --test worker/test/tried-reach.test.mjs — "ניסינו להשיג" (tried-reach.js): the 10:00–20:00 hours and the
// 10:00 queue, the template payload Meta would get, the 24h free-text path, the calm failure + Slack, the cooldown,
// the page route (m<itemId> / L<phone>, admin auth) and the monday webhook (secret, challenge, board, burst cap).
// Meta, monday and Slack are fakes here; the clock is fixed; nothing leaves the machine.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { reachOpen, nextReachAt, firstName, decide, isRepeat, triedReach, drainTriedReach, TEMPLATE, PROPOSED, FAIL_HE, textFor, COOLDOWN_MS, MONDAY_CAP } from '../tried-reach.js';
import { MCOL, BOARD } from '../leads-sync.js';

/* Israel is UTC+2 in late November. 2026-11-25 is a Wednesday, 27 Friday, 28 Saturday, 29 Sunday. */
const IL = (day, hm) => Date.parse(`2026-11-${day}T${hm}:00+02:00`);

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}

/* ── pure: hours ──────────────────────────────────────────────────────────── */
test('hours: open 10:00–19:59 Israel, closed at 20:00, before 10:00 and on Shabbat', () => {
  assert.equal(reachOpen(IL(25, '09:59')), false);
  assert.equal(reachOpen(IL(25, '10:00')), true);
  assert.equal(reachOpen(IL(25, '19:59')), true);
  assert.equal(reachOpen(IL(25, '20:00')), false);
  assert.equal(reachOpen(IL(25, '23:00')), false);
  assert.equal(reachOpen(IL(27, '12:00')), true, 'Friday midday is open');
  assert.equal(reachOpen(IL(28, '12:00')), false, 'Shabbat');
});
test('queue time: after 20:00 → next morning 10:00; before 10:00 → the same day 10:00; Shabbat → Sunday 10:00; open → now', () => {
  assert.equal(nextReachAt(IL(25, '20:05')), IL(26, '10:00'));
  assert.equal(nextReachAt(IL(25, '23:40')), IL(26, '10:00'));
  assert.equal(nextReachAt(IL(26, '07:12')), IL(26, '10:00'));
  assert.equal(nextReachAt(IL(28, '11:00')), IL(29, '10:00'));
  assert.equal(nextReachAt(IL(27, '20:30')), IL(29, '10:00'), 'Friday night waits through Shabbat');
  assert.equal(nextReachAt(IL(25, '14:07')), IL(25, '14:07'));
});
test('decide: off / opt-out refuse; closed hours queue; paused refuses inside hours; window picks text, else template', () => {
  assert.deepEqual(decide({ now: IL(25, '12:00'), off: true }), { action: 'refuse', reason: 'off' });
  assert.deepEqual(decide({ now: IL(25, '23:00'), optout: true }), { action: 'refuse', reason: 'optout' });
  assert.deepEqual(decide({ now: IL(25, '23:00') }), { action: 'queue', due: IL(26, '10:00') });
  assert.deepEqual(decide({ now: IL(25, '12:00'), paused: true }), { action: 'refuse', reason: 'paused' });
  assert.deepEqual(decide({ now: IL(25, '12:00'), inWindow: true }), { action: 'send', via: 'text' });
  assert.deepEqual(decide({ now: IL(25, '12:00') }), { action: 'send', via: 'template' });
});
test('first name and the words', () => {
  assert.equal(firstName('דנה לוי'), 'דנה');
  assert.equal(firstName('דנה-לוי חתונה'), 'דנה');
  assert.equal(firstName(''), 'שלום');
  assert.equal(firstName('0521234567'), 'שלום', 'a phone in the name cell is not a name');
  assert.equal(textFor('דנה'), 'היי דנה, ניסינו להשיג אותך בנוגע לאישורי הגעה — אל דאגה, ננסה שוב בהמשך, או כתבו לנו מתי הכי נוח שנחייג 🙂');
  assert.equal(PROPOSED.category, 'UTILITY'); assert.equal(PROPOSED.name, 'noa_tried_reach'); assert.match(PROPOSED.body, /^היי \{\{1\}\}, ניסינו להשיג/);
  assert.equal(isRepeat({ state: 'sent', at: 1000 }, 1000 + COOLDOWN_MS - 1), true);
  assert.equal(isRepeat({ state: 'sent', at: 1000 }, 1000 + COOLDOWN_MS), false);
  assert.equal(isRepeat({ state: 'failed', at: 1000 }, 1001), false, 'a failed press may be pressed again at once');
});

/* ── the module with injected deps ────────────────────────────────────────── */
function deps(o = {}) {
  const sent = [], slack = [];
  return { sent, slack,
    sendClient: async (env, phone, name, params, ctx) => { sent.push({ kind: 'template', phone, name, params, ctx }); return o.fail ? { ok: false, error: o.fail } : { ok: true, id: 'wamid.T' }; },
    sendText: async (env, phone, text, ch, ctx) => { sent.push({ kind: 'text', phone, text, ch }); return o.fail ? { ok: false, error: o.fail } : { ok: true, id: 'wamid.X' }; },
    sendingPaused: async () => !!o.paused,
    slackSend: async (env, text, opts) => { slack.push({ text, opts }); } };
}
function store() {
  const acts = [];
  return { acts, appendActivity: async a => { acts.push(a); return a; }, get: async () => null };
}
const L = { phone: '0521234567', name: 'דנה לוי' };

test('inside hours, no open window → the template from 4499, history + journal, then a second press is a repeat', async () => {
  const env = { RATE: kv() }, d = deps(), st = store();
  const r = await triedReach(env, d, { lead: L, who: 'שלו' }, { now: IL(25, '12:00'), store: st });
  assert.deepEqual([r.status, r.body.ok, r.body.state, r.body.via], [200, true, 'sent', 'template']);
  assert.deepEqual(d.sent.map(s => [s.kind, s.phone, s.name, s.params]), [['template', '972521234567', TEMPLATE, ['דנה']]]);
  assert.equal(st.acts.length, 1); assert.equal(st.acts[0].entity_id, 'L972521234567'); assert.equal(st.acts[0].kind, 'reach'); assert.equal(st.acts[0].meta.who, 'שלו');
  assert.ok([...env.RATE.m.keys()].some(k => k.startsWith('evlog:')), 'a journal line');
  const again = await triedReach(env, d, { lead: L, who: 'שלו' }, { now: IL(25, '12:03'), store: st });
  assert.equal(again.body.state, 'repeat'); assert.equal(d.sent.length, 1, 'nothing new went out');
});
test('inside the 24h window → the same words as free text on the client channel', async () => {
  const env = { RATE: kv({ 'conv:972521234567': JSON.stringify({ last_in_ts: IL(25, '09:00') }) }) }, d = deps();
  const r = await triedReach(env, d, { lead: L }, { now: IL(25, '12:00'), store: store() });
  assert.equal(r.body.via, 'text');
  assert.deepEqual(d.sent.map(s => [s.kind, s.ch, s.text]), [['text', 'client', textFor('דנה')]]);
});
test('after 20:00 → queued for 10:00 (nothing sent); the cron sends it at 10:00, once', async () => {
  const env = { RATE: kv() }, d = deps(), st = store();
  const r = await triedReach(env, d, { lead: L, who: 'ריצארד' }, { now: IL(25, '23:00'), store: st });
  assert.deepEqual([r.body.ok, r.body.state, r.body.due], [true, 'queued', new Date(IL(26, '10:00')).toISOString()]);
  assert.equal(d.sent.length, 0);
  assert.ok(env.RATE.m.has('reachq:972521234567'));
  assert.deepEqual(await drainTriedReach(env, d, { now: IL(26, '07:00'), store: st }), { ok: true, skipped: 'hours', sent: 0 });
  const out = await drainTriedReach(env, d, { now: IL(26, '10:00'), store: st });
  assert.equal(out.sent, 1); assert.equal(d.sent.length, 1); assert.equal(env.RATE.m.has('reachq:972521234567'), false);
  assert.equal((await drainTriedReach(env, d, { now: IL(26, '10:10'), store: st })).sent, 0, 'a queued press goes out once');
  assert.deepEqual(st.acts.map(a => a.meta.state), ['queued', 'sent']);
});
test('Noa refused by Meta (131042) → calm failure line, history, one Slack alert keyed by the code; a retry is allowed', async () => {
  const env = { RATE: kv() }, d = deps({ fail: '131042: Business eligibility payment issue' }), st = store();
  const r = await triedReach(env, d, { lead: L }, { now: IL(25, '12:00'), store: st });
  assert.deepEqual([r.body.ok, r.body.state, r.body.he], [false, 'failed', FAIL_HE]);
  assert.equal(d.slack.length, 1); assert.equal(d.slack[0].opts.key, 'tried_reach:131042');
  assert.doesNotMatch(d.slack[0].text, /0521234567|972521234567/, 'the phone is masked in Slack');
  assert.equal(st.acts[0].meta.state, 'failed');
  await triedReach(env, d, { lead: L }, { now: IL(25, '12:01'), store: st });
  assert.equal(d.sent.length, 2, 'failed → pressing again tries again');
});
test('paused, opted out, switched off, no phone: nothing is sent', async () => {
  let d = deps({ paused: true });
  assert.equal((await triedReach({ RATE: kv() }, d, { lead: L }, { now: IL(25, '12:00') })).body.state, 'failed'); assert.equal(d.sent.length, 0);
  d = deps();
  assert.equal((await triedReach({ RATE: kv({ 'optout:972521234567': '1' }) }, d, { lead: L }, { now: IL(25, '12:00') })).body.error, 'optout');
  assert.equal((await triedReach({ RATE: kv(), TRIED_REACH: 'off' }, d, { lead: L }, { now: IL(25, '12:00') })).body.error, 'off');
  assert.equal((await triedReach({ RATE: kv({ 'cfg:tried_reach': 'off' }) }, d, { lead: L }, { now: IL(25, '12:00') })).body.error, 'off');
  assert.equal((await triedReach({ RATE: kv() }, d, { lead: { phone: '', name: 'x' } }, { now: IL(25, '12:00') })).status, 400);
  assert.equal(d.sent.length, 0);
});

/* ── through the Worker: the page route, the real template payload, the monday webhook ── */
let realFetch, realNow, calls, M;
const item = (id, name, phone) => ({ id: String(id), name, state: 'active', created_at: '2026-11-10T08:00:00Z', updated_at: '2026-11-16T08:00:00Z', group: { id: 'g', title: 'פעילים' }, board: { id: BOARD },
  column_values: [{ id: MCOL.phone, text: phone, value: JSON.stringify(phone) }, { id: MCOL.status, text: 'לא ענה', label: 'לא ענה', value: '{}' }] });
before(() => {
  realFetch = globalThis.fetch; realNow = Date.now;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), body = init.body ? String(init.body) : '';
    calls.push({ u, body });
    if (u === 'https://api.monday.com/v2') {
      const { query, variables } = JSON.parse(body);
      if (/mutation/.test(query)) throw new Error('tried-reach must never write to monday');
      if (/items\(ids/.test(query)) return new Response(JSON.stringify({ data: { items: (variables.i || []).map(i => M.get(String(i))).filter(Boolean) } }));
      if (/settings_str/.test(query)) return new Response(JSON.stringify({ data: { boards: [{ columns: [] }] } }));
      if (/items_page/.test(query)) return new Response(JSON.stringify({ data: { boards: [{ items_page: { cursor: null, items: [...M.values()] } }] } }));
      return new Response('{}');
    }
    if (/graph\.facebook\.com\/.*\/messages$/.test(u)) return new Response(JSON.stringify({ messages: [{ id: 'wamid.FAKE' }] }));
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; Date.now = realNow; });
beforeEach(() => { calls = []; M = new Map([['101', item(101, 'דנה לוי', '052-123-4567')], ['102', item(102, 'בלי טלפון', '')]]); Date.now = realNow; });
const env = (init = {}, extra = {}) => ({ ADMIN_KEY: 'k', MONDAY_API_TOKEN: 'tok', MONDAY_WEBHOOK_SECRET: 'whsecret', WA_TOKEN: 'watok', WA_PHONE_ID: '4499ID', RATE: kv(init), ...extra });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const post = (e, path, body, key = 'k') => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: key, ...body }) }), e, ctx);
const hook = (e, body, k = 'whsecret') => worker.fetch(new Request('https://go.ishur.io/webhooks/monday-tried-reach' + (k ? '?k=' + k : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, ctx);
const metaSends = () => calls.filter(c => /graph\.facebook\.com\/.*\/messages$/.test(c.u)).map(c => ({ u: c.u, b: JSON.parse(c.body) }));

test('POST /api/crm/leads/m<id>/tried-reach: admin only; the template payload Meta gets is noa_tried_reach, Hebrew, {{1}} = first name, from 4499', async () => {
  Date.now = () => IL(25, '12:00');
  const e = env();
  assert.equal((await post(e, '/api/crm/leads/m101/tried-reach', {}, 'bad')).status, 403);
  const r = await post(e, '/api/crm/leads/m101/tried-reach', {});
  const j = await r.json();
  assert.equal(r.status, 200); assert.deepEqual([j.ok, j.state, j.via], [true, 'sent', 'template']);
  const s = metaSends();
  assert.equal(s.length, 1);
  assert.match(s[0].u, /\/4499ID\/messages$/, 'Noa\'s number, not a guests number');
  assert.deepEqual({ to: s[0].b.to, type: s[0].b.type, name: s[0].b.template.name, lang: s[0].b.template.language.code }, { to: '972521234567', type: 'template', name: 'noa_tried_reach', lang: 'he' });
  const bodyComp = s[0].b.template.components.find(c => c.type === 'body');
  assert.deepEqual(bodyComp.parameters, [{ type: 'text', text: 'דנה' }]);
  /* the drawer's timeline shows the press */
  await worker.fetch(new Request('https://go.ishur.io/api/crm/leads/board', { headers: { 'X-Admin-Key': 'k' } }), e, ctx);   /* the page loads the board first: the mirror holds m101 */
  const det = await (await worker.fetch(new Request('https://go.ishur.io/api/crm/leads/m101', { headers: { 'X-Admin-Key': 'k' } }), e, ctx)).json();
  assert.ok((det.activities || []).some(a => a.kind === 'reach' && a.meta && a.meta.state === 'sent'), 'history row on the lead');
});
test('page route: after hours queues (no Meta call); a lead without a phone says so; unknown id → 404; GET → 405', async () => {
  Date.now = () => IL(25, '22:30');
  const e = env();
  const j = await (await post(e, '/api/crm/leads/m101/tried-reach', {})).json();
  assert.deepEqual([j.ok, j.state, j.due], [true, 'queued', new Date(IL(26, '10:00')).toISOString()]);
  assert.equal(metaSends().length, 0);
  Date.now = () => IL(25, '12:00');
  const np = await post(e, '/api/crm/leads/m102/tried-reach', {});
  assert.equal(np.status, 400); assert.equal((await np.json()).error, 'no-phone');
  assert.equal((await post(e, '/api/crm/leads/m999/tried-reach', {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://go.ishur.io/api/crm/leads/m101/tried-reach', { headers: { 'X-Admin-Key': 'k' } }), e, ctx)).status, 405);
});
test('page route by L<phone> (a lead that lives only in our store)', async () => {
  Date.now = () => IL(25, '12:00');
  const e = env();
  const j = await (await post(e, '/api/crm/leads/L972541112233/tried-reach', {})).json();
  assert.equal(j.state, 'sent');
  assert.equal(metaSends()[0].b.template.components.find(c => c.type === 'body').parameters[0].text, 'שלום', 'no name → a word Meta accepts');
});
test('Meta refuses (131042) through the real send path → ok:false with the calm line', async () => {
  Date.now = () => IL(25, '12:00');
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => /graph\.facebook\.com\/.*\/messages$/.test(String(url)) ? new Response(JSON.stringify({ error: { code: 131042, message: 'Business eligibility payment issue' } }), { status: 400 }) : saved(url, init);
  try {
    const j = await (await post(env(), '/api/crm/leads/m101/tried-reach', {})).json();
    assert.deepEqual([j.ok, j.state, j.he], [false, 'failed', FAIL_HE]); assert.match(j.why, /131042/);
  } finally { globalThis.fetch = saved; }
});
test('monday webhook: closed without a secret, wrong key 403, challenge echoed, other board ignored, item read back and sent', async () => {
  Date.now = () => IL(25, '12:00');
  assert.equal((await hook(env({}, { MONDAY_WEBHOOK_SECRET: '' }), { event: {} })).status, 503);
  assert.equal((await hook(env(), { event: {} }, 'nope')).status, 403);
  assert.equal((await hook(env(), { event: {} }, '')).status, 403);
  assert.equal((await (await hook(env(), { challenge: 'xyz' })).json()).challenge, 'xyz');
  assert.equal((await (await hook(env(), { event: { boardId: 1, pulseId: 101 } })).json()).ignored, 'board');
  const e = env();
  /* the payload carries a different phone: it is ignored, monday's own item is what counts */
  const r = await hook(e, { event: { type: 'update_column_value', boardId: Number(BOARD), pulseId: 101, columnId: 'button', value: { phone: '0500000000' } } });
  const j = await r.json();
  assert.equal(r.status, 200); assert.deepEqual([j.ok, j.state, j.id], [true, 'sent', 'm101']);
  assert.equal(metaSends()[0].b.to, '972521234567');
  /* monday's retry of the same click is the same press */
  const again = await (await hook(e, { event: { boardId: Number(BOARD), pulseId: 101 } })).json();
  assert.equal(again.state, 'repeat'); assert.equal(metaSends().length, 1);
});
test('monday webhook: column / label narrowing, and a burst stops after the cap', async () => {
  Date.now = () => IL(25, '12:00');
  const e = env({}, { MONDAY_REACH_COLUMN: 'button_x' });
  assert.equal((await (await hook(e, { event: { boardId: BOARD, pulseId: 101, columnId: 'status' } })).json()).ignored, 'column');
  const e2 = env({}, { MONDAY_REACH_LABEL: 'ניסינו להשיג' });
  assert.equal((await (await hook(e2, { event: { boardId: BOARD, pulseId: 101, value: { label: { text: 'חדש' } } } })).json()).ignored, 'label');
  assert.equal((await (await hook(e2, { event: { boardId: BOARD, pulseId: 101, value: { label: { text: 'ניסינו להשיג' } } } })).json()).state, 'sent');
  const e3 = env();
  for (let i = 0; i < 12; i++) M.set(String(200 + i), item(200 + i, 'ליד ' + i, '05400000' + String(10 + i)));
  const res = [];
  for (let i = 0; i < 12; i++) res.push(await (await hook(e3, { event: { boardId: BOARD, pulseId: 200 + i } })).json());
  assert.equal(res.filter(x => x.state === 'sent').length, MONDAY_CAP);
  assert.equal(res.filter(x => x.error === 'burst-cap').length, 12 - MONDAY_CAP);
});
