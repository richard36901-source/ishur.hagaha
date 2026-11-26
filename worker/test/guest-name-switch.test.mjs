// node --test worker/test/guest-name-switch.test.mjs — "לשלוח עם שם האורח" per event (Richard 26/11, guest-name.js).
// Off → every guest template picks the approved no-name copy, else the neutral 'אורח יקר', else (unknown template) is held
// and reported once. On → exactly as before. The board's preview follows the switch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as GN from '../guest-name.js';
import { sendTemplate, _resetBudgetMemory } from '../whatsapp.js';
import { normalizeSettings, saveSettings, legacyShuttleSettings, shirFollowupVars } from '../event-settings.js';
import { STYLES, OWN_TEMPLATE, KINDS, tmplName } from '../invite-styles.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k, t) => { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true }), getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) };
}
const TOKEN = 'dddddddd-0000-4000-8000-000000000001';
const OFF = { ['evsettings:' + TOKEN]: JSON.stringify({ guest_name: false }) };
let posts = [], hooks = [], realFetch;
beforeEach(() => {
  _resetBudgetMemory(); posts = []; hooks = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (/\/messages$/.test(u) && init.method === 'POST') { posts.push(JSON.parse(init.body)); return json({ messages: [{ id: 'wamid.' + posts.length }] }); }
    if (u === 'https://hooks.example/slack') { hooks.push(JSON.parse(init.body)); return json({}); }
    return json({});
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const envWith = (store = {}, extra = {}) => ({ RATE: kv(store), WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', WA_TOKEN: 'tc', WA_PHONE_ID: 'C', ...extra });
const send = (env, name, params, ctx = {}) => sendTemplate(env, '0501234567', name, params, '', 'he', 'guests', { token: TOKEN, name: params[0], ...ctx });
const body = p => ((p.template.components || []).find(c => c.type === 'body') || { parameters: [] }).parameters.map(x => x.text);
const P6 = ['חבר מהצבא 2', 'חתונה', 'נועה ויונתן', '12.09.2026', '19:30', 'הגן הקסום'];

/* every guest-facing family in use, by the name a sender passes, with a params list of the right length */
const FAMILIES = (() => {
  const out = [];
  for (const f of readdirSync(new URL('../templates/', import.meta.url)).filter(x => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(new URL('../templates/' + f, import.meta.url), 'utf8')), p = j.payload || j;
    const b = (p.components || []).find(c => c.type === 'BODY'); if (!b) continue;
    const n = Math.max(0, ...[...b.text.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])));
    out.push({ name: p.name, n, nameFirst: /^(שלום|היי|שלום רב) \{\{1\}\}/.test(b.text) });
  }
  for (const s of Object.keys(STYLES).filter(OWN_TEMPLATE)) for (const k of KINDS) out.push({ name: tmplName(s, k), n: 6, nameFirst: true });
  for (const name of ['hazmana_ishur_v2', 'hazmana_ishur_v2_yn', 'hazmana_ishur_img_u', 'hazmana_ishur_vid_u', 'hazmana_ishur_img', 'hazmana_ishur_vid', 'ishur_yom_lifnei_img', 'ishur_lifnei_combo_tg_img', 'hazmana_ishur_v2_ab3'])
    out.push({ name, n: name.startsWith('hazmana') ? 6 : 5, nameFirst: true });
  for (const name of ['ishur_toda_orach', 'ishur_toda_orach_v2', 'ishur_matana2', 'ishur_toda_matana2']) out.push({ name, n: 2, nameFirst: true });
  return out;
})();

test('the registry agrees with the template records: {{1}} is the name exactly where the body greets with it', () => {
  for (const f of FAMILIES) assert.equal(GN.nameFamily(f.name) === 'first', f.nameFirst, f.name);
  assert.equal(GN.nameFamily('ishur_yom_haerua_matana'), 'none', '{{1}} there is the time');
  assert.equal(GN.nameFamily('ishur_yom_haerua'), 'none');
  assert.equal(GN.nameFamily('ishur_c_0a1b2c3d_2'), 'none', 'the client\'s own wording has no variables');
  assert.equal(GN.nameFamily('hazmana_ishur_v2_anon'), 'none');
  assert.equal(GN.nameFamily('ishur_shabat_hatan_zaguri'), 'first', 'sub-event shabbat templates open with the name');
  assert.equal(GN.nameFamily('something_new'), 'unknown');
});

test('switch OFF, twin approved → the no-name copy for EVERY family, the name parameter dropped', async () => {
  for (const f of FAMILIES.filter(x => x.nameFirst)) {
    posts = [];
    const env = envWith({ ...OFF, ['tmplanon:' + f.name]: f.name + '_anon' });
    const params = Array.from({ length: f.n }, (_, i) => i ? 'v' + (i + 1) : 'דודה של הכלה');
    const r = await send(env, f.name, params);
    assert.equal(r.ok, true, f.name);
    assert.equal(posts[0].template.name, f.name + '_anon', f.name);
    assert.deepEqual(body(posts[0]), params.slice(1), f.name);
    assert.ok(!JSON.stringify(posts[0]).includes('דודה של הכלה'), f.name + ': the saved name never leaves');
  }
});

test('switch OFF, no approved twin → the same template with the neutral "אורח יקר" in {{1}}', async () => {
  for (const f of FAMILIES.filter(x => x.nameFirst)) {
    posts = [];
    const params = Array.from({ length: f.n }, (_, i) => i ? 'v' + (i + 1) : 'חבר מהצבא 2');
    const r = await send(envWith(OFF), f.name, params);
    assert.equal(r.ok, true, f.name);
    assert.equal(posts[0].template.name, f.name, f.name);
    assert.deepEqual(body(posts[0]), ['אורח יקר', ...params.slice(1)], f.name);
  }
});

test('switch OFF, a template nobody registered that carries the name → held, nothing sent, journal + Slack once', async () => {
  const env = envWith(OFF, { SLACK_ALERT_HOOK: 'https://hooks.example/slack' });
  const r1 = await send(env, 'ishur_new_notice', ['חבר מהצבא 2', 'החתונה']);
  const r2 = await send(env, 'ishur_new_notice', ['דודה של הכלה', 'החתונה']);
  assert.deepEqual(r1, { ok: false, error: 'guest-name-hold', permanent: true });
  assert.equal(r2.error, 'guest-name-hold');
  assert.equal(posts.length, 0, 'never sent with the name');
  const journal = [...env.RATE.m.entries()].filter(([k, v]) => k.startsWith('evlog:') && /בלי שם האורח/.test(v));
  assert.equal(journal.length, 1, 'one journal row, not one per guest');
  const queued = String(env.RATE.m.get('slackq:list') || '');
  assert.equal(hooks.length + (/בלי שם האורח/.test(queued) ? 1 : 0), 1, 'one Slack line (posted, or queued in quiet hours)');
});

test('switch OFF: templates without a name, or without variables, go out as they are', async () => {
  const env = envWith(OFF);
  await send(env, 'ishur_yom_haerua_matana', ['19:30', 'החתונה', 'אולם', 'https://waze.com/x']);
  await sendTemplate(env, '0501234567', 'ishur_c_0a1b2c3d_1', [], '', 'he', 'guests', { token: TOKEN, name: 'חבר מהצבא 2' });
  assert.equal(posts[0].template.name, 'ishur_yom_haerua_matana'); assert.deepEqual(body(posts[0]), ['19:30', 'החתונה', 'אולם', 'https://waze.com/x']);
  assert.equal(posts[1].template.name, 'ishur_c_0a1b2c3d_1');
});

test('switch ON (and every event before 26/11, which has no setting) → unchanged, even when a twin is approved', async () => {
  for (const store of [{}, { ['evsettings:' + TOKEN]: JSON.stringify({ guest_name: true }) }, { ['evsettings:' + TOKEN]: JSON.stringify({ gift_on_yes: false }) }]) {
    posts = [];
    const r = await send(envWith({ ...store, 'tmplanon:hazmana_ishur_v2': 'hazmana_ishur_v2_anon' }), 'hazmana_ishur_v2', P6);
    assert.equal(r.ok, true); assert.equal(posts[0].template.name, 'hazmana_ishur_v2'); assert.deepEqual(body(posts[0]), P6);
  }
  posts = [];
  await send(envWith({}), 'ishur_new_notice', ['דנה', 'x']);
  assert.equal(posts[0].template.name, 'ishur_new_notice', 'unknown templates are not held when names are on');
});

test('only the guests channel with an event token is touched (client messages never)', async () => {
  const env = envWith(OFF);
  await sendTemplate(env, '0501234567', 'ishur_doch', ['ריצארד', 'x'], '', 'he', 'client', { token: TOKEN });
  await sendTemplate(env, '0501234567', 'hazmana_ishur', P6, '', 'he', 'guests', {});
  assert.deepEqual(body(posts[0]), ['ריצארד', 'x']); assert.deepEqual(body(posts[1]), P6);
});

test('a sub-event follows its parent event\'s switch', async () => {
  const SUB = 'eeeeeeee-0000-4000-8000-000000000002';
  const env = envWith({ ...OFF, ['subevent:' + SUB]: JSON.stringify({ parent: TOKEN, kind: 'shabbat' }) });
  await sendTemplate(env, '0501234567', 'ishur_shabat_hatan_reminder', ['חבר מהצבא 2'], '', 'he', 'guests', { token: SUB, name: 'חבר מהצבא 2' });
  assert.deepEqual(body(posts[0]), ['אורח יקר']);
});

test('an event in another language gets the neutral word (translated), never the Hebrew-only twin', async () => {
  const env = envWith({ ...OFF, ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"en"}', 'tmplanon:ishur_yom_plain_t': 'ishur_yom_plain_t_anon' }, { GUEST_LANG: 'on' });
  await send(env, 'ishur_yom_plain_t', ['חבר מהצבא 2', 'החתונה', '19:30', 'אולם', '12']);
  assert.equal(posts[0].template.name, 'ishur_yom_plain_t_en');
  assert.equal(body(posts[0])[0], 'dear guest');
});

test('the settings record: absent = on, the switch survives other saves, the old shuttle question is not hidden by it', async () => {
  assert.equal(normalizeSettings({}, null).guest_name, true);
  assert.equal(normalizeSettings({ guest_name: false }, null).guest_name, false);
  assert.equal(normalizeSettings({ gift_on_yes: false }, { guest_name: false }).guest_name, false, 'kept when not sent');
  const env = envWith({});
  await saveSettings(env, TOKEN, { guest_name: false });
  assert.equal(await GN.guestNameOn(env, TOKEN), false);
  await saveSettings(env, TOKEN, { guest_name: true });
  assert.equal(await GN.guestNameOn(env, TOKEN), true, 'a save is seen at once (the memo is dropped)');
  const BUS = { id: 'bus', label: 'הסעה מבאר שבע' };
  assert.equal(shirFollowupVars(legacyShuttleSettings(normalizeSettings({ guest_name: false }, null), BUS)).ask_shuttle, 'כן');
});

test('anonBody / anonPayload: the greeting loses the name and the variables are renumbered from {{1}}', () => {
  assert.equal(GN.anonBody('שלום {{1}}! הוזמנתם ל{{2}} של {{3}}.\n📅 {{4}}'), 'שלום! הוזמנתם ל{{1}} של {{2}}.\n📅 {{3}}');
  assert.equal(GN.anonBody('היי {{1}}, תזכורת קטנה: מחר חוגגים את {{2}}!'), 'היי, תזכורת קטנה: מחר חוגגים את {{1}}!');
  assert.equal(GN.anonBody('שלום רב {{1}},\n\nהננו'), 'שלום רב,\n\nהננו');
  assert.equal(GN.anonBody('היי, היום בשעה {{1}}'), 'היי, היום בשעה', 'only the first {{1}} goes; callers never send this family to the twin');
  assert.equal(GN.anonBody('אין משתנים'), null);
  for (const f of readdirSync(new URL('../templates/', import.meta.url)).filter(x => x.endsWith('.json'))) {
    const p = JSON.parse(readFileSync(new URL('../templates/' + f, import.meta.url), 'utf8')).payload;
    if (GN.nameFamily(p.name) !== 'first') continue;
    const a = GN.anonPayload(p), b = a.components.find(c => c.type === 'BODY').text;
    const nums = [...b.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
    assert.equal(a.name, p.name + '_anon');
    assert.deepEqual([...new Set(nums)].sort((x, y) => x - y), nums.length ? Array.from({ length: Math.max(...nums) }, (_, i) => i + 1) : [], p.name + ': {{1}}..{{n}} with no gap');
    assert.ok(!/^\s*\{\{/.test(b), p.name + ': Meta refuses a body that starts with a variable');
  }
});

test('the preview: mode per switch and twin, and the same decision the sender makes', async () => {
  assert.equal(GN.previewMode(true, true), 'name');
  assert.equal(GN.previewMode(false, false), 'neutral');
  assert.equal(GN.previewMode(false, true), 'twin');
  const d = GN.decideGuestName({ name: 'ishur_lifnei_combo_t', params: ['דנה', 'החתונה', '12.9', '19:30', 'אולם', '5'], on: false, twin: '' });
  assert.deepEqual(d, { action: 'neutral', name: 'ishur_lifnei_combo_t', params: ['אורח יקר', 'החתונה', '12.9', '19:30', 'אולם', '5'] });
  const t = GN.decideGuestName({ name: 'ishur_yom_combo_n', params: ['דנה', 'החתונה', '19:30', 'אולם'], on: false, twin: 'ishur_yom_combo_n_anon' });
  assert.deepEqual(t, { action: 'twin', name: 'ishur_yom_combo_n_anon', params: ['החתונה', '19:30', 'אולם'] });
  /* the board builds the invitation bubble from its own text: the same replacement as dashboard.html nameText() */
  const html = readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
  const src = /var nameText = (function \(txt, mode\) \{[\s\S]*?\n {4}\});/.exec(html);
  assert.ok(src, 'nameText is on the board');
  const nameText = new Function('return ' + src[1])();
  const inv = 'שלום {שם האורח}! הוזמנתם לחתונה של נועה ויונתן.';
  assert.equal(nameText(inv, 'name'), inv);
  assert.equal(nameText(inv, 'neutral'), 'שלום אורח יקר! הוזמנתם לחתונה של נועה ויונתן.');
  assert.equal(nameText(inv, 'twin'), 'שלום! הוזמנתם לחתונה של נועה ויונתן.');
  assert.match(html, /j\.name_mode && j\.name_mode !== mode/, 'the popup re-draws the first two bubbles from the server\'s mode');
});

test('routes: the team toggle needs the admin key and writes evsettings; the twin check sets tmplanon only for APPROVED', async () => {
  const deps = env => ({ okJson: (o, _x) => ({ status: 200, body: o }), deny: (s, e) => ({ status: s, body: { error: e } }), isAdmin: (_e, k) => k === 'K', tokenRecord: async () => true, logEvent: async () => {}, saveSettings });
  const req = b => ({ json: async () => b });
  const env = envWith({});
  assert.equal((await GN.handleGuestName(req({ admin_key: 'x', token: TOKEN }), env, '', deps(env))).status, 403);
  const r = await GN.handleGuestName(req({ admin_key: 'K', token: TOKEN, on: false }), env, '', deps(env));
  assert.deepEqual(r.body, { ok: true, token: TOKEN, on: false });
  assert.equal(JSON.parse(env.RATE.m.get('evsettings:' + TOKEN)).guest_name, false);
  const meta = async () => new Response(JSON.stringify({ data: [{ name: 'hazmana_ishur_v2_anon', status: 'APPROVED', category: 'UTILITY' }, { name: 'ishur_yom_lifnei_anon', status: 'PENDING', category: 'UTILITY' }] }));
  env.RATE.m.set('tmplanon:ishur_yom_lifnei', 'ishur_yom_lifnei_anon');
  const c = await GN.handleGuestNameTwins(req({ admin_key: 'K', action: 'check' }), env, '', { ...deps(env), fetchFn: meta });
  assert.equal(c.body.ok, true);
  assert.equal(env.RATE.m.get('tmplanon:hazmana_ishur_v2'), 'hazmana_ishur_v2_anon');
  assert.equal(env.RATE.m.has('tmplanon:ishur_yom_lifnei'), false, 'a twin that is not approved (any more) is switched off');
  assert.equal((await GN.handleGuestNameTwins(req({ admin_key: 'no' }), env, '', deps(env))).status, 403);
});

/* ── the route the board's preview calls: /api/preview-messages, through the Worker ─────────────────────── */
import worker from '../index.js';
test('/api/preview-messages: switch on → "דנה"; off → "אורח יקר" (no twin) or the no-name copy\'s text (twin approved), and the mode for the invitation bubble', async () => {
  const TOK = 'abcd1234-1111-4111-8111-111111111111';
  const ev = new Array(50).fill(''); ev[1] = TOK; ev[5] = 'חתונה'; ev[6] = '2026-12-20'; ev[34] = 'הדר ויצחק'; ev[36] = '19:30'; ev[37] = 'יקנעם'; ev[38] = 'אולמי סקיי';
  const snapshot = { events: { values: [ev] }, guests: { values: [] } };
  const bodies = { ishur_yom_lifnei_anon: 'היי, תזכורת קטנה: מחר חוגגים את {{1}}!' };
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url), json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u === 'https://hook.test/status') return json(snapshot);
    if (/message_templates/.test(u)) {
      const name = decodeURIComponent((u.match(/name=([^&]+)/) || [])[1] || ''); asked.push(name);
      const text = bodies[name] || (/^ishur_yom_combo|^ishur_yom_plain/.test(name) ? 'שלום {{1}}! מחכים לראותכם היום ב{{2}}' : 'היי {{1}}, תזכורת קטנה: מחר חוגגים את {{2}}!');
      return json({ data: [{ name, status: /_combo_|_plain_/.test(name) ? 'PENDING' : 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text }] }] });
    }
    return json({});
  };
  const call = async store => {
    const e = { RATE: kv({ ['token:' + TOK]: JSON.stringify({ token: TOK }), ...store }), HOOK_STATUS: 'https://hook.test/status', HOOK_EVENTS: 'https://hook.test/events', WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', WA_TOKEN: 'tc', WA_PHONE_ID: 'C', ADMIN_KEY: 'k' };
    const r = await worker.fetch(new Request('https://go.ishur.io/api/preview-messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOK }) }), e, { waitUntil() {}, passThroughOnException() {} });
    return r.json();
  };
  const on = await call({});
  assert.equal(on.ok, true); assert.equal(on.name_mode, 'name'); assert.equal(on.guest_name, true);
  const db = m => (m.messages || []).find(x => x.key === 'daybefore');
  assert.ok(db(on), 'a day-before bubble'); assert.match(db(on).text, /^היי דנה,/);
  const offNeutral = await call({ ['evsettings:' + TOK]: JSON.stringify({ guest_name: false }) });
  assert.equal(offNeutral.name_mode, 'neutral'); assert.equal(offNeutral.guest, '');
  assert.match(db(offNeutral).text, /^היי אורח יקר,/); assert.ok(!/דנה/.test(JSON.stringify(offNeutral.messages)));
  const offTwin = await call({ ['evsettings:' + TOK]: JSON.stringify({ guest_name: false }), 'tmplanon:ishur_yom_lifnei': 'ishur_yom_lifnei_anon', invitetmpl: 'hazmana_ishur_v2', 'tmplanon:hazmana_ishur_v2': 'hazmana_ishur_v2_anon' });
  assert.equal(offTwin.name_mode, 'twin');
  assert.match(db(offTwin).text, /^היי, תזכורת קטנה: מחר חוגגים את חתונה של הדר ויצחק!/);
  assert.ok(asked.includes('ishur_yom_lifnei_anon'), 'the copy\'s own text is what the preview shows');
});

test('the hand-set event-day job (params = the event\'s time / what / address / nav) is never held, whatever its template', async () => {
  const env = envWith(OFF);
  const r = await sendTemplate(env, '0501234567', 'some_fallback_template', ['19:30', 'החתונה', 'אולם', 'https://waze.com/x'], '', 'he', 'guests', { wave: 'eventday', token: TOKEN, noGuestName: true });
  assert.equal(r.ok, true); assert.deepEqual(body(posts[0]), ['19:30', 'החתונה', 'אולם', 'https://waze.com/x']);
  assert.match(readFileSync(new URL('../index.js', import.meta.url), 'utf8'), /sendTemplate\(env, p\.phone, job\.template, params, '', 'he', 'guests', \{ wave: 'eventday', token, noGuestName: true \}\)/);
});
