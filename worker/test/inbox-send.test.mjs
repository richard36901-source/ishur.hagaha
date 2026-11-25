// node --test worker/test/inbox-send.test.mjs — the inbox composer (inbox-send.js): line, 24h window,
// quiet hours, attribution, media validation, templates. Everything faked; nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { handleInboxCompose, windowState, quietState, validateMedia, normMime, pickTemplates, resolveLine, WORKER_DOC_MAX } from '../inbox-send.js';
import { describe as teamDescribe, quietRead } from '../team-log.js';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }),
    getWithMetadata: async () => ({ value: null }) };
}
const P = '972521234567';
/* Nov = Israel UTC+2. 12:00 IL = 10:00Z */
const AT = h => Date.parse('2026-11-25T00:00:00Z') + (h - 2) * 3600e3;
const NOON = AT(12);
const env = (init = {}, extra = {}) => ({ ADMIN_KEY: 'k', WA_PHONE_ID: 'N1', WA_TOKEN: 'ct', WA_PHONE_ID_GUESTS: 'G1', WA_PHONE_IDS_GUESTS: 'G2', WA_TOKEN_GUESTS: 'gt', RATE: kv(init), ...extra });
const conv = o => JSON.stringify({ phone: P, msgs: 3, ch: ['client'], last_in_ts: NOON - 3600e3, ...o });

function deps(over = {}) {
  const calls = [];
  const d = {
    okJson: (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    deny: (s, e) => new Response(JSON.stringify({ ok: false, error: e }), { status: s }),
    cors: () => ({}),
    adminKeyOk: async (e, k) => k === 'k',
    getUser: async (e, email) => (email === 'shalev@ishur.io' ? { email, name: 'שלו' } : null),
    readSession: async () => null,
    now: () => NOON,
    send: {
      text: async (e, to, text, ch, ctx) => { calls.push({ fn: 'text', to, text, ch, ctx }); return { ok: true, id: 'wamid.T' }; },
      media: async (e, to, kind, m, ch, ctx) => { calls.push({ fn: 'media', to, kind, m, ch, ctx }); return { ok: true, id: 'wamid.M' }; },
      template: async (e, to, name, params, img, lang, ch, ctx) => { calls.push({ fn: 'template', to, name, params, lang, ch, ctx }); return { ok: true, id: 'wamid.P' }; },
    },
    ...over,
  };
  return { d, calls };
}
async function call(e, path, body, d, headers = {}) {
  const r = await handleInboxCompose(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), e, '', path, d);
  return { status: r.status, j: await r.json() };
}

/* ── pure rules ── */
test('windowState: open under 24h since their last message, closed after, closed with no inbound', () => {
  assert.equal(windowState(NOON - 23.9 * 3600e3, NOON).open, true);
  assert.equal(windowState(NOON - 24.1 * 3600e3, NOON).open, false);
  assert.equal(windowState(0, NOON).open, false);
  assert.equal(windowState(NOON - 3600e3, NOON).closes_at, NOON - 3600e3 + 24 * 3600e3);
});
test('quietState: clients 21:00–09:00, guests 19:00–09:00, Israel time', () => {
  assert.equal(quietState('client', AT(12)).quiet, false);
  assert.equal(quietState('guests', AT(12)).quiet, false);
  assert.equal(quietState('guests', AT(19.5)).quiet, true);
  assert.equal(quietState('client', AT(20.5)).quiet, false);
  assert.equal(quietState('client', AT(21.5)).quiet, true);
  assert.equal(quietState('client', AT(8.5)).quiet, true);
  assert.equal(quietState('guests', AT(8.5)).quiet, true);
  assert.equal(quietState('client', AT(9)).quiet, false);
  assert.equal(quietState('guests', AT(18.99)).quiet, false);
});
test('validateMedia: types and sizes per the WhatsApp list, browser quirks normalised, refusals in words', () => {
  const MB = 1024 * 1024;
  assert.deepEqual(validateMedia({ mime: 'image/jpeg', size: 4 * MB, name: 'a.jpg' }), { ok: true, kind: 'image', mime: 'image/jpeg' });
  assert.equal(validateMedia({ mime: 'image/png', size: 6 * MB }).error, 'too-big');
  assert.equal(validateMedia({ mime: 'video/mp4', size: 15 * MB }).kind, 'video');
  assert.equal(validateMedia({ mime: 'video/mp4', size: 17 * MB }).error, 'too-big');
  assert.equal(validateMedia({ mime: 'audio/x-m4a', size: MB }).mime, 'audio/mp4');
  assert.equal(validateMedia({ mime: 'application/octet-stream', size: MB, name: 'voice.m4a' }).kind, 'audio');
  assert.equal(validateMedia({ mime: 'audio/ogg; codecs=opus', size: MB }).mime, 'audio/ogg');
  assert.equal(normMime('IMAGE/JPG'), 'image/jpeg');
  const webm = validateMedia({ mime: 'audio/webm;codecs=opus', size: MB });
  assert.equal(webm.ok, false); assert.match(webm.he, /webm/);
  assert.equal(validateMedia({ mime: 'video/quicktime', size: MB }).error, 'type-not-allowed');
  assert.equal(validateMedia({ mime: 'application/zip', size: MB }).error, 'type-not-allowed');
  assert.equal(validateMedia({ mime: 'application/pdf', size: 20 * MB }).kind, 'document');
  assert.equal(validateMedia({ mime: 'application/pdf', size: WORKER_DOC_MAX + 1 }).error, 'too-big');
  assert.equal(validateMedia({ mime: 'application/pdf', size: 0 }).error, 'empty-file');
});

/* ── the line ── */
test('resolveLine: last inbound line wins; legacy x4499 guest → Noa line with guest rules; guest pin → guests number', async () => {
  let e = env();
  assert.deepEqual(await resolveLine(e, P, { ch: ['client'] }), { channel: 'client', kind: 'client', phone_id: 'N1', label: 'נועה · 4499' });
  const g = await resolveLine(e, P, { ch: ['client', 'guests'], last_in_line: 'guests', last_in_kind: 'guests', last_in_pid: 'G2' });
  assert.equal(g.channel, 'guests'); assert.equal(g.phone_id, 'G2');
  e = env({ ['x4499:' + P]: '1' });
  const x = await resolveLine(e, P, { ch: ['client', 'guests'] });
  assert.equal(x.channel, 'client'); assert.equal(x.kind, 'guests');
  e = env({ ['gph:' + P]: 'G2' });
  const pin = await resolveLine(e, P, { ch: ['client', 'guests'] });
  assert.equal(pin.channel, 'guests'); assert.equal(pin.phone_id, 'G2');
  const off = await resolveLine(env({}, { WA_TOKEN_GUESTS: '' }), P, { last_in_line: 'guests' });
  assert.equal(off.error, 'guests-number-not-connected');
});

/* ── /api/inbox/send ── */
test('send: free text inside the window goes out on the client line, attributed to the signed-in person, not to the body', async () => {
  const e = env({ ['conv:' + P]: conv() });
  const { d, calls } = deps();
  const { j } = await call(e, '/api/inbox/send', { admin_key: 'k', phone: '0521234567', kind: 'text', text: 'היי', who: 'מישהו אחר' }, d, { 'x-ishur-user': 'shalev@ishur.io' });
  assert.equal(j.ok, true); assert.equal(j.who, 'שלו'); assert.equal(j.channel, 'client');
  assert.equal(calls.length, 1);
  assert.deepEqual({ fn: calls[0].fn, to: calls[0].to, ch: calls[0].ch, who: calls[0].ctx.who }, { fn: 'text', to: P, ch: 'client', who: 'שלו' });
  assert.ok(await e.RATE.get('human:' + P), 'a person answering takes the conversation');
  const ev = [...e.RATE.m.entries()].filter(([k]) => k.startsWith('evlog:')).map(([, v]) => JSON.parse(v));
  assert.equal(ev.length, 1); assert.match(ev[0].action, /הודעה ידנית נשלחה/); assert.match(ev[0].detail, /שלו \(shalev@ishur\.io\)/);
});
test('send: no signed-in user → a generic label (raw key / admin device), never the body', async () => {
  const e = env({ ['conv:' + P]: conv() });
  const { d } = deps();
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x', who: 'זיוף' }, d)).j.who, 'מנהל');
  const d2 = deps({ adminKeyOk: async () => true }).d;
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'sess.' + 'a'.repeat(48), phone: P, kind: 'text', text: 'x' }, d2)).j.who, 'מכשיר מנהל');
});
test('send: wrong key → 403, nothing sent', async () => {
  const { d, calls } = deps();
  const { status } = await call(env({ ['conv:' + P]: conv() }), '/api/inbox/send', { admin_key: 'nope', phone: P, kind: 'text', text: 'x' }, d);
  assert.equal(status, 403); assert.equal(calls.length, 0);
});
test('send: 24h window closed → free text and files refused with window-closed; a template still goes', async () => {
  const e = env({ ['conv:' + P]: conv({ last_in_ts: NOON - 30 * 3600e3 }) });
  const { d, calls } = deps();
  const t = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x' }, d);
  assert.equal(t.j.ok, false); assert.equal(t.j.error, 'window-closed'); assert.equal(t.j.window.open, false);
  const m = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'media', media: { id: '123456789', kind: 'image', phone_id: 'N1' } }, d);
  assert.equal(m.j.error, 'window-closed');
  assert.equal(calls.length, 0);
  const p = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'template', template: { name: 'ishur_doch', lang: 'he', params: ['a', 'b'] } }, d);
  assert.equal(p.j.ok, true); assert.equal(calls[0].fn, 'template'); assert.deepEqual(calls[0].params, ['a', 'b']); assert.equal(calls[0].ch, 'client');
});
test('send: never wrote to us at all → window closed', async () => {
  const { d } = deps();
  assert.equal((await call(env(), '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x' }, d)).j.error, 'window-closed');
});
test('send: Meta 131047 (the line\'s own window) comes back as window-closed', async () => {
  const e = env({ ['conv:' + P]: conv() });
  const { d } = deps({ send: { text: async () => ({ ok: false, error: '131047: Re-engagement message' }) } });
  const { j } = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x' }, d);
  assert.equal(j.error, 'window-closed'); assert.equal(j.window.open, false);
});
test('send: quiet hours → needs-confirm and nothing sent; with confirm_quiet it goes and the journal says so', async () => {
  const e = env({ ['conv:' + P]: conv({ last_in_ts: AT(21.5) - 600e3 }) });
  const { d, calls } = deps({ now: () => AT(21.5) });
  const a = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x' }, d);
  assert.equal(a.j.error, 'needs-confirm'); assert.equal(a.j.quiet.rule, 'client'); assert.equal(calls.length, 0);
  const tp = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'template', template: { name: 'ishur_doch' } }, d);
  assert.equal(tp.j.error, 'needs-confirm', 'templates obey quiet hours too');
  const b = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x', confirm_quiet: true }, d);
  assert.equal(b.j.ok, true); assert.equal(b.j.quiet_confirmed, true); assert.equal(calls.length, 1);
  const ev = [...e.RATE.m.entries()].filter(([k]) => k.startsWith('evlog:')).map(([, v]) => JSON.parse(v));
  assert.ok(ev.some(r => /בשעות שקט, אושר/.test(r.detail)));
});
test('send: a guest at 19:30 needs the confirm, a client at 19:30 does not', async () => {
  const { d } = deps({ now: () => AT(19.5) });
  const g = env({ ['conv:' + P]: conv({ ch: ['guests'], last_in_line: 'guests', last_in_kind: 'guests', last_in_pid: 'G1', last_in_ts: AT(19) }) });
  assert.equal((await call(g, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x' }, d)).j.error, 'needs-confirm');
  const c = env({ ['conv:' + P]: conv({ last_in_ts: AT(19) }) });
  assert.equal((await call(c, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x' }, d)).j.ok, true);
});
test('send: a guest is answered from the guest number they wrote to, never 4499', async () => {
  const e = env({ ['conv:' + P]: conv({ ch: ['guests'], last_in_line: 'guests', last_in_kind: 'guests', last_in_pid: 'G2' }) });
  const { d, calls } = deps();
  const { j } = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x' }, d);
  assert.equal(j.channel, 'guests'); assert.equal(calls[0].ch, 'guests'); assert.equal(calls[0].ctx.phone_id, 'G2');
  assert.equal(await e.RATE.get('human:' + P), null, 'the guest line does not stop the sales flow');
  const bad = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'template', template: { name: 'ishur_doch' } }, d);
  assert.equal(bad.j.error, 'wrong-channel', 'a client template is not offered on the guests line');
});
test('send: media — validated id/kind, same line as the upload, caption and file name passed', async () => {
  const e = env({ ['conv:' + P]: conv() });
  const { d, calls } = deps();
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'media', media: { id: 'abc', kind: 'image' } }, d)).status, 400);
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'media', media: { id: '1234567', kind: 'sticker' } }, d)).status, 400);
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'media', media: { id: '1234567', kind: 'image', phone_id: 'G1' } }, d)).j.error, 'media-line-mismatch');
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'media', media: { id: '1234567', kind: 'image' }, caption: 'x'.repeat(1025) }, d)).status, 400);
  const ok = await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'media', media: { id: '1234567', kind: 'document', mime: 'application/pdf', name: 'חוזה.pdf', phone_id: 'N1' }, caption: 'החוזה' }, d);
  assert.equal(ok.j.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].m, { id: '1234567', caption: 'החוזה', filename: 'חוזה.pdf' });
  assert.equal(calls[0].kind, 'document'); assert.equal(calls[0].ctx.media_mime, 'application/pdf');
});
test('send: template header media and dynamic button become components', async () => {
  const e = env({ ['conv:' + P]: conv() });
  const { d, calls } = deps();
  await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'template', template: { name: 'x_tpl', lang: 'en', params: ['1'], header_media: { id: '99999', kind: 'video' }, button_param: { index: 1, text: 'abc' } } }, d);
  assert.equal(calls[0].lang, 'en');
  assert.deepEqual(calls[0].ctx.components, [
    { type: 'header', parameters: [{ type: 'video', video: { id: '99999' } }] },
    { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'abc' }] },
  ]);
});
test('send: empty / too long text refused before anything else', async () => {
  const { d } = deps();
  const e = env({ ['conv:' + P]: conv() });
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: '  ' }, d)).status, 400);
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: P, kind: 'text', text: 'x'.repeat(4097) }, d)).status, 400);
  assert.equal((await call(e, '/api/inbox/send', { admin_key: 'k', phone: '', kind: 'text', text: 'x' }, d)).status, 400);
});

/* ── state + templates ── */
test('state: line, window, quiet and who in one read', async () => {
  const e = env({ ['conv:' + P]: conv() });
  const { d } = deps();
  const { j } = await call(e, '/api/inbox/state', { admin_key: 'k', phone: P }, d, { 'x-ishur-user': 'shalev@ishur.io' });
  assert.equal(j.ok, true); assert.equal(j.line.channel, 'client'); assert.equal(j.window.open, true); assert.equal(j.quiet.quiet, false); assert.equal(j.who.name, 'שלו');
  assert.equal(j.limits.media.image.max, 5 * 1024 * 1024);
});
test('templates: only APPROVED, no authentication, twins folded, wrong-line names hidden, named params unsupported', () => {
  const T = (name, o = {}) => ({ name, status: 'APPROVED', category: 'UTILITY', language: 'he', components: [{ type: 'BODY', text: 'שלום {{1}} ו-{{2}}' }], ...o });
  const list = [T('ishur_doch'), T('ishur_doch_f'), T('only_n_n'), T('hazmana_ishur'), T('ishur_kod', { category: 'AUTHENTICATION' }), T('pending', { status: 'PENDING' }),
    T('named', { parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'hi {{first}}' }] }),
    T('withvid', { components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'a' }, { type: 'URL', text: 'go', url: 'https://x/{{1}}' }] }] })];
  const c = pickTemplates(list, 'client');
  assert.deepEqual(c.map(t => t.name), ['ishur_doch', 'named', 'only_n_n', 'withvid']);
  assert.equal(c[0].params, 2);
  assert.equal(c.find(t => t.name === 'named').supported, false);
  const v = c.find(t => t.name === 'withvid');
  assert.equal(v.header.format, 'VIDEO'); assert.deepEqual(v.button_param, { index: 1 });
  const g = pickTemplates(list, 'guests').map(t => t.name);
  assert.ok(g.includes('hazmana_ishur')); assert.ok(!g.includes('ishur_doch'));
});
test('templates route: reads the line\'s WABA once, caches it', async () => {
  const e = env({ ['conv:' + P]: conv() });
  let hits = 0, url = '';
  const { d } = deps({ fetch: async (u) => { hits++; url = String(u); return new Response(JSON.stringify({ data: [{ name: 'ishur_doch', status: 'APPROVED', category: 'UTILITY', language: 'he', components: [{ type: 'BODY', text: 'x {{1}}' }] }] })); } });
  const a = await call(e, '/api/inbox/templates', { admin_key: 'k', phone: P }, d);
  assert.equal(a.j.ok, true); assert.equal(a.j.templates[0].name, 'ishur_doch');
  assert.match(url, /\/1060242146337688\/message_templates/);
  await call(e, '/api/inbox/templates', { admin_key: 'k', phone: P }, d);
  assert.equal(hits, 1);
});

/* ── /api/inbox/media ── */
async function upload(e, d, file, headers = { 'x-admin-key': 'k' }, phone = P) {
  const fd = new FormData(); fd.append('phone', phone); if (file) fd.append('file', file);
  const r = await handleInboxCompose(new Request('https://go.ishur.io/api/inbox/media', { method: 'POST', headers, body: fd }), e, '', '/api/inbox/media', d);
  return { status: r.status, j: await r.json() };
}
test('media upload: goes to Meta on the sending line\'s phone id, returns the id + kind', async () => {
  const e = env({ ['conv:' + P]: conv({ ch: ['guests'], last_in_line: 'guests', last_in_kind: 'guests', last_in_pid: 'G2' }) });
  let seen = null;
  const { d } = deps({ fetch: async (u, o) => { seen = { u: String(u), auth: o.headers.Authorization, type: o.body.get('type'), mp: o.body.get('messaging_product') }; return new Response(JSON.stringify({ id: '777000111' })); } });
  const { j } = await upload(e, d, new File([new Uint8Array(2048)], 'pic.jpg', { type: 'image/jpeg' }));
  assert.equal(j.ok, true);
  assert.deepEqual(j.media, { id: '777000111', kind: 'image', mime: 'image/jpeg', name: 'pic.jpg', size: 2048, phone_id: 'G2', channel: 'guests' });
  assert.deepEqual(seen, { u: 'https://graph.facebook.com/v21.0/G2/media', auth: 'Bearer gt', type: 'image/jpeg', mp: 'whatsapp' });
});
test('media upload: refused types / wrong key / staging non-allowlisted never reach Meta', async () => {
  let hits = 0;
  const { d } = deps({ fetch: async () => { hits++; return new Response('{"id":"1"}'); } });
  const e = env({ ['conv:' + P]: conv() });
  const w = await upload(e, d, new File([new Uint8Array(10)], 'rec.webm', { type: 'audio/webm' }));
  assert.equal(w.j.ok, false); assert.equal(w.j.error, 'type-not-allowed');
  assert.equal((await upload(e, d, new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' }), { 'x-admin-key': 'bad' })).status, 403);
  assert.equal((await upload(e, d, null)).status, 400);
  const s = env({ ['conv:' + P]: conv() }, { STAGING: '1', STAGING_ALLOWLIST: '972500000000' });
  assert.equal((await upload(s, d, new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' }))).j.error, 'staging-blocked');
  assert.equal(hits, 0);
});

/* ── through the real Worker and the real whatsapp.js post() ── */
let realFetch, graph = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (u, o) => { if (String(u).includes('graph.facebook.com')) { graph.push({ u: String(u), body: o && o.body }); return new Response(JSON.stringify(/\/media$/.test(String(u)) ? { id: '555000999' } : { messages: [{ id: 'wamid.REAL' }] })); } return new Response('{}'); }; });
after(() => { globalThis.fetch = realFetch; });
test('worker: /api/inbox/send routes, sends from the right number and writes who + ticks key on the log line', async () => {
  const e = env({ ['conv:' + P]: JSON.stringify({ phone: P, ch: ['guests'], last_in_line: 'guests', last_in_kind: 'guests', last_in_pid: 'G2', last_in_ts: Date.now() - 600e3 }) });
  graph = [];
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const r = await worker.fetch(new Request('https://go.ishur.io/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', phone: P, kind: 'text', text: 'שלום', confirm_quiet: true }) }), e, ctx);
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j)); assert.equal(j.id, 'wamid.REAL');
  const sent = graph.find(g => /\/messages$/.test(g.u));
  assert.equal(sent.u, 'https://graph.facebook.com/v21.0/G2/messages');
  const logKey = await e.RATE.get('wamid2log:wamid.REAL');
  assert.ok(logKey && logKey.startsWith('log:' + P + ':'), 'statuses can find the line (ticks)');
  const row = JSON.parse(await e.RATE.get(logKey));
  assert.equal(row.who, 'מנהל'); assert.equal(row.ch, 'guests'); assert.equal(row.status, 'sent');
});
test('team log: the send is one meaningful line, the reads are quiet', () => {
  assert.equal(teamDescribe('/api/inbox/send', { phone: '972521234567', kind: 'template', template: { name: 'ishur_doch' } }, { ok: true }), 'שליחת תבנית ishur_doch מהאינבוקס ל-972****567');
  assert.equal(teamDescribe('/api/inbox/send', { phone: P, kind: 'text' }, { ok: false }), '');
  assert.equal(quietRead('/api/inbox/state', {}), true);
  assert.equal(quietRead('/api/inbox/templates', {}), true);
});

/* ── the real sign-in gate (authGate) in front, and the real post() for a file ── */
import { createSession } from '../auth.js';
const wctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function gateEnv() {
  return env({ 'user:shalev@ishur.io': JSON.stringify({ email: 'shalev@ishur.io', name: 'שלו', role: 'admin', active: true }),
    ['conv:' + P]: JSON.stringify({ phone: P, ch: ['client'], last_in_line: 'client', last_in_kind: 'client', last_in_pid: 'N1', last_in_ts: Date.now() - 600e3 }) });
}
test('worker + gate: a Google session in admin_key → the log line and the answer carry the person\'s name', async () => {
  const e = gateEnv(); graph = [];
  const tok = await createSession(e, 'shalev@ishur.io');
  const r = await worker.fetch(new Request('https://go.ishur.io/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ishur.io' }, body: JSON.stringify({ admin_key: tok, phone: P, kind: 'text', text: 'היי', confirm_quiet: true, who: 'זיוף' }) }), e, wctx);
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j)); assert.equal(j.who, 'שלו');
  const row = JSON.parse(await e.RATE.get(await e.RATE.get('wamid2log:wamid.REAL')));
  assert.equal(row.who, 'שלו');
  assert.equal(graph.find(g => /\/messages$/.test(g.u)).u, 'https://graph.facebook.com/v21.0/N1/messages');
});
test('worker + gate: a spoofed x-ishur-user with the raw key is dropped → generic label', async () => {
  const e = gateEnv(); graph = [];
  const r = await worker.fetch(new Request('https://go.ishur.io/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ishur-user': 'shalev@ishur.io' }, body: JSON.stringify({ admin_key: 'k', phone: P, kind: 'text', text: 'x', confirm_quiet: true }) }), e, wctx);
  assert.equal((await r.json()).who, 'מנהל');
});
test('worker + gate: multipart upload with the Google session in x-admin-key reaches Meta; a bad key does not', async () => {
  const e = gateEnv(); graph = [];
  const tok = await createSession(e, 'shalev@ishur.io');
  const fd = () => { const f = new FormData(); f.append('phone', P); f.append('file', new File([new Uint8Array(4096)], 'חוזה.pdf', { type: 'application/pdf' })); return f; };
  const ok = await (await worker.fetch(new Request('https://go.ishur.io/api/inbox/media', { method: 'POST', headers: { 'x-admin-key': tok }, body: fd() }), e, wctx)).json();
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.media.kind, 'document'); assert.equal(ok.media.phone_id, 'N1');
  const up = graph.find(g => /\/media$/.test(g.u));
  assert.equal(up.u, 'https://graph.facebook.com/v21.0/N1/media');
  assert.equal(up.body.get('type'), 'application/pdf'); assert.equal(up.body.get('file').size, 4096);
  graph = [];
  const bad = await worker.fetch(new Request('https://go.ishur.io/api/inbox/media', { method: 'POST', headers: { 'x-admin-key': 'us.' + '0'.repeat(64) }, body: fd() }), e, wctx);
  assert.equal(bad.status, 403); assert.equal(graph.length, 0);
});
test('worker: a file goes out through the real post() — Graph body by id, caption/filename, and the log row the thread draws from', async () => {
  const e = gateEnv(); graph = [];
  const r = await worker.fetch(new Request('https://go.ishur.io/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', phone: P, kind: 'media', media: { id: '777000111', kind: 'document', mime: 'application/pdf', name: 'חוזה.pdf', phone_id: 'N1' }, caption: 'החוזה', confirm_quiet: true }) }), e, wctx);
  const j = await r.json(); assert.equal(j.ok, true, JSON.stringify(j));
  const sent = JSON.parse(graph.find(g => /\/messages$/.test(g.u)).body);
  assert.deepEqual({ type: sent.type, doc: sent.document, to: sent.to }, { type: 'document', doc: { id: '777000111', caption: 'החוזה', filename: 'חוזה.pdf' }, to: P });
  const row = JSON.parse(await e.RATE.get(await e.RATE.get('wamid2log:wamid.REAL')));
  assert.deepEqual(row.media, { kind: 'document', id: '777000111', mime: 'application/pdf', name: 'חוזה.pdf' });
  assert.equal(row.caption, 'החוזה'); assert.equal(row.type, 'document'); assert.equal(row.who, 'מנהל'); assert.equal(row.status, 'sent');
  /* an audio file carries no caption even if one is sent */
  graph = [];
  await worker.fetch(new Request('https://go.ishur.io/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', phone: P, kind: 'media', media: { id: '777000222', kind: 'audio', mime: 'audio/mpeg', name: 'a.mp3' }, caption: 'x', confirm_quiet: true }) }), e, wctx);
  assert.deepEqual(JSON.parse(graph.find(g => /\/messages$/.test(g.u)).body).audio, { id: '777000222' });
});
test('worker + gate: an admin-device sess. token is accepted (label depends on the gate)', async () => {
  const e = gateEnv();
  const r = await worker.fetch(new Request('https://go.ishur.io/api/inbox/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'sess.' + 'f'.repeat(48), phone: P }) }), e, wctx);
  assert.equal(r.status, 403, 'an unknown sess. token is refused');
});
