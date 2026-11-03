import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS, buildRequest, callTool, ToolInputError } from '../src/tools.js';
import { formatReply } from '../src/claude.js';
import { toMessages, shouldHandle } from '../src/index.js';
import { baseEnv, recFetch } from './helpers.mjs';

const TOK = 'ec9f3b84-0000-4000-8000-000000000000';
const env = baseEnv();
const req = (name, args) => { const r = buildRequest(env, name, args); return { url: r.url, method: r.init.method, body: JSON.parse(r.init.body), headers: r.init.headers }; };

test('every endpoint path exists in worker/index.js route table (no invented endpoints)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../worker/index.js', import.meta.url)), 'utf8');
  for (const t of TOOLS) {
    if (t.linear || t.path === '/api/automations') continue; // Linear is external; automations = Deliverable A
    assert.ok(src.includes(`url.pathname === '${t.path}'`), `${t.name}: ${t.path} not in route table`);
  }
});

test('shape: audit_query passes filters, adds admin_key, never csv', () => {
  const r = req('audit_query', { days: 2, kind: 'wa_out', token: TOK, limit: 50, format: 'csv' });
  assert.equal(r.url, 'https://go.ishur.io/api/audit');
  assert.equal(r.method, 'POST');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.deepEqual(r.body, { admin_key: 'test-admin-key', days: 2, kind: 'wa_out', token: TOK, limit: 50 });
});

test('shape: event_status uses token only (no admin key, as /api/status token read)', () => {
  assert.deepEqual(req('event_status', { token: TOK }).body, { token: TOK });
});

test('shape: daily_run_dry always sends dry:true, never force', () => {
  assert.deepEqual(req('daily_run_dry', { today: '2026-11-02', dry: false, force: true }).body, { admin_key: 'test-admin-key', dry: true, today: '2026-11-02' });
});

test('shape: event_day_dry / call_round_dry fix action=dry', () => {
  assert.deepEqual(req('event_day_dry', { token: TOK, action: 'run' }).body, { admin_key: 'test-admin-key', token: TOK, action: 'dry' });
  assert.deepEqual(req('call_round_dry', { token: TOK, action: 'run' }).body, { admin_key: 'test-admin-key', token: TOK, action: 'dry' });
});

test('shape: event_flag_get never carries "on" (a read in handleEventFlag)', () => {
  const b = req('event_flag_get', { token: TOK, flag: 'hold', on: true }).body;
  assert.deepEqual(b, { admin_key: 'test-admin-key', token: TOK, flag: 'hold' });
  assert.throws(() => req('event_flag_get', { token: TOK, flag: 'cancel' }), ToolInputError);
});

test('shape: meta_get / ads_get force GET', () => {
  assert.deepEqual(req('meta_get', { channel: 'guests', path: '/1888051741895896?fields=name', method: 'POST', payload: { x: 1 } }).body,
    { admin_key: 'test-admin-key', channel: 'guests', path: '/1888051741895896?fields=name', method: 'GET' });
  assert.deepEqual(req('ads_get', { path: '/me', method: 'DELETE' }).body, { admin_key: 'test-admin-key', path: '/me', method: 'GET' });
  assert.throws(() => req('ads_get', { path: 'me' }), ToolInputError);
});

test('shape: monday_query refuses mutations; monday_mutation refuses deletes', () => {
  assert.deepEqual(req('monday_query', { gql: '{boards(ids:[1]){name}}' }).body, { admin_key: 'test-admin-key', gql: '{boards(ids:[1]){name}}', vars: {} });
  assert.throws(() => req('monday_query', { gql: 'mutation { x }' }), ToolInputError);
  assert.throws(() => req('monday_mutation', { gql: 'mutation { delete_item(item_id:1){id} }' }), ToolInputError);
});

test('shape: cap_status / wave_audit / call_board / automations send only admin_key', () => {
  for (const n of ['cap_status', 'wave_audit', 'call_board', 'automations']) assert.deepEqual(req(n, { junk: 1 }).body, { admin_key: 'test-admin-key' }, n);
});

test('shape: delivery_report {token, since}', () => {
  assert.deepEqual(req('delivery_report', { token: TOK, since: 123 }).body, { admin_key: 'test-admin-key', token: TOK, since: 123 });
});

test('shape: red tools build the request the worker expects', () => {
  assert.deepEqual(req('wave_retry', { token: TOK, wave: '2', dry: true }).body, { admin_key: 'test-admin-key', token: TOK, wave: '2', dry: true });
  assert.deepEqual(req('event_flag_set', { token: TOK, flag: 'cancel', on: true, reason: 'r' }).body, { admin_key: 'test-admin-key', token: TOK, flag: 'cancel', on: true, reason: 'r' });
  assert.deepEqual(req('guest_edit', { token: TOK, guest_id: 'G1', name: 'דנה', phone: '0501234567' }).body, { token: TOK, guest_id: 'G1', name: 'דנה', phone: '0501234567' });
  assert.deepEqual(req('promo_create', { campaign: 'winter', price: 990 }).body, { admin_key: 'test-admin-key', action: 'create', campaign: 'winter', price: 990 });
  assert.throws(() => req('meta_write', { path: '/x', method: 'GET' }), ToolInputError);
});

test('bad token is rejected before any request', () => {
  assert.throws(() => req('delivery_report', { token: 'ec9f3b84' }), ToolInputError);
});

test('every tool builds a POST JSON request with its sample input', () => {
  const sample = { token: TOK, flag: 'hold', on: true, path: '/x', method: 'POST', action: 'set', gql: 'mutation { a }', sum: 10, title: 't', guest_id: 'g', name: 'n', wave: '1', campaign: 'c', note: 'n' };
  for (const t of TOOLS) {
    let s = { ...sample };
    if (t.name === 'monday_query') s.gql = '{a}';
    if (t.name === 'evlog_maintenance') s.action = 'audit-root';
    if (t.name === 'event_flag_get') s.flag = 'hold';
    const r = buildRequest(env, t.name, s);
    assert.equal(r.init.method, 'POST', t.name);
    JSON.parse(r.init.body);
  }
});

test('callTool returns http_status + parsed JSON from the mocked fetch', async () => {
  const f = recFetch(() => ({ status: 403, body: { ok: false, error: 'bad-admin-key' } }));
  const r = await callTool(env, 'cap_status', {}, f);
  assert.equal(r.http_status, 403);
  assert.equal(r.ok, false);
  assert.equal(r.data.error, 'bad-admin-key');
});

test('formatReply: max 4 lines, result first, yellow footer appended by code', () => {
  const t = formatReply('א\nב\nג\nד\nה\nו', [{ tool: 'event_hold_on', args: { token: 'x' }, ok: true, http_status: 200 }]);
  const lines = t.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['א', 'ב', 'ג', 'ד']);
  assert.match(lines[4], /🟡 בוצע: `event_hold_on`/);
  assert.equal(lines.length, 5);
});

test('thread → messages alternate and start/end with the user', () => {
  const m = toMessages([
    { user: 'U_R', text: '<@UBOT> מה יוצא מחר?' }, { user: 'UBOT', bot_id: 'B', text: 'מחר: 14 תזכורות' },
    { user: 'U_S', text: 'ומה עם הדר?' }, { user: 'U_S', text: 'ויצחק' },
  ], 'UBOT');
  assert.deepEqual(m.map(x => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[0].content, '<@U_R>: מה יוצא מחר?');
  assert.match(m[2].content, /ומה עם הדר\?\n<@U_S>: ויצחק/);
});

test('event filter: mentions yes, bots no, other channels no, thread replies only in known threads', () => {
  const b = ev => ({ authorizations: [{ user_id: 'UBOT' }], event: ev });
  const e = baseEnv();
  assert.equal(shouldHandle(e, b({ type: 'app_mention', channel: 'C_HAGAA', user: 'U_R', text: '<@UBOT> hi', ts: '1' }), false), true);
  assert.equal(shouldHandle(e, b({ type: 'app_mention', channel: 'C_OTHER', user: 'U_R', ts: '1' }), false), false);
  assert.equal(shouldHandle(e, b({ type: 'message', channel: 'C_HAGAA', bot_id: 'B', thread_ts: '1', ts: '2' }), true), false);
  assert.equal(shouldHandle(e, b({ type: 'message', channel: 'C_HAGAA', user: 'U_S', text: 'עוד?', thread_ts: '1', ts: '2' }), true), true);
  assert.equal(shouldHandle(e, b({ type: 'message', channel: 'C_HAGAA', user: 'U_S', text: 'עוד?', thread_ts: '1', ts: '2' }), false), false);
  assert.equal(shouldHandle(e, b({ type: 'message', channel: 'C_HAGAA', user: 'U_S', text: '<@UBOT> עוד?', thread_ts: '1', ts: '2' }), true), false, 'app_mention copy handles it');
});
