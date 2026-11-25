import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sheetHookFetch, brainDirect, eventsDirect, callCells, setupCells, colLetter } from '../sheetsdirect.js';

/* a KV with the write token already cached, so no JWT is signed in tests */
function kv(extra = {}) {
  const m = new Map(Object.entries({ 'gsa:tokenrw': JSON.stringify({ token: 'T', exp: Date.now() + 3600e3 }), ...extra }));
  return { get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, m };
}
const ON = { 'cfg:sheets_direct': JSON.stringify({ value: 'on' }) };
const envOf = (extra = {}) => ({ GOOGLE_SA: '{"client_email":"x","private_key":"y"}', RATE: kv({ ...ON, ...extra }), BRAIN_HOOK: 'https://make/brain', HOOK_EVENTS: 'https://make/events', SHEET_ID: 'SID' });
function fake(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: decodeURIComponent(url), init });
    for (const [re, h] of routes) if (re.test(decodeURIComponent(url))) return h(url, init);
    return new Response('{}', { status: 200 });
  };
  f.calls = calls; return f;
}

test('column letters', () => { assert.equal(colLetter(0), 'A'); assert.equal(colLetter(13), 'N'); assert.equal(colLetter(29), 'AD'); assert.equal(colLetter(43), 'AR'); assert.equal(colLetter(44), 'AS'); });

test('off by default: everything goes to Make untouched', async () => {
  const env = envOf(); await env.RATE.delete('cfg:sheets_direct');
  const f = fake([]);
  await sheetHookFetch(env, env.BRAIN_HOOK, { method: 'POST', body: '{"url":"spreadsheets/SID"}' }, f);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://make/brain');
});

test('other hooks (Grow, leads) never take the direct path', async () => {
  const env = envOf(); const f = fake([]);
  await sheetHookFetch(env, 'https://make/grow', { method: 'POST', body: '{}' }, f);
  assert.equal(f.calls[0].url, 'https://make/grow');
});

test('BRAIN_HOOK: the proxy contract becomes one Google call, body passed through with 200', async () => {
  const env = envOf();
  const f = fake([[/sheets\.googleapis/, () => new Response('{"totalUpdatedCells":3}', { status: 200 })]]);
  const r = await sheetHookFetch(env, env.BRAIN_HOOK, { method: 'POST', body: JSON.stringify({ url: 'spreadsheets/SID/values:batchUpdate', method: 'POST', payload: JSON.stringify({ valueInputOption: 'RAW', data: [] }) }) }, f);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { totalUpdatedCells: 3 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://sheets.googleapis.com/v4/spreadsheets/SID/values:batchUpdate');
  assert.equal(f.calls[0].init.method, 'POST'); assert.equal(f.calls[0].init.headers.Authorization, 'Bearer T');
  assert.equal(f.calls[0].init.body, JSON.stringify({ valueInputOption: 'RAW', data: [] }));
});

test('BRAIN_HOOK: a GET with a Hebrew range in the query string', async () => {
  const env = envOf(); const f = fake([[/googleapis/, () => new Response('{"valueRanges":[]}')]]);
  await brainDirect(env, JSON.stringify({ url: 'spreadsheets/SID/values:batchGet', qk1: 'ranges', qv1: 'לידים - לא סגרו!A2:P500' }), f);
  assert.equal(f.calls[0].url, 'https://sheets.googleapis.com/v4/spreadsheets/SID/values:batchGet?ranges=לידים - לא סגרו!A2:P500');
  assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.body, undefined);
});

test('a 403 (no permission yet) falls back to Make; nothing was written', async () => {
  const env = envOf(); const f = fake([[/googleapis/, () => new Response('{}', { status: 403 })]]);
  const r = await sheetHookFetch(env, env.BRAIN_HOOK, { method: 'POST', body: '{"url":"spreadsheets/SID","method":"POST","payload":"{}"}' }, f);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url, 'https://make/brain'); assert.equal(r.status, 200);
  assert.equal(env.RATE.m.has('gsa:tokenrw'), false, 'the refused token is dropped');
});

test('a 5xx / network error is a failure, never a second write through Make', async () => {
  const env = envOf(); const f = fake([[/googleapis/, () => new Response('oops', { status: 503 })]]);
  const r = await sheetHookFetch(env, env.HOOK_EVENTS, { method: 'POST', body: JSON.stringify({ event_type: 'guests_file', token: 't', append_body: '{"values":[["a"]]}', guest_count: 1 }) }, f);
  assert.equal(r.status, 503); assert.ok(f.calls.every(c => !c.url.startsWith('https://make')));
  const env2 = envOf(); const f2 = async () => { throw new Error('timeout'); };
  const r2 = await brainDirect(env2, '{"url":"spreadsheets/SID","method":"POST","payload":"{}"}', f2);
  assert.equal(r2.status, 502);
});

test('call_result: finds the row by id, writes N P V W X Z AD, __keep__ leaves a cell, "" clears it', async () => {
  const env = envOf();
  const f = fake([[/values\/אורחים!C2:C/, () => new Response(JSON.stringify({ values: [['G-1'], ['G-2'], ['G-3']] }))], [/values:batchUpdate/, () => new Response('{"totalUpdatedCells":5}')]]);
  const r = await eventsDirect(env, JSON.stringify({ event_type: 'call_result', guest_id: 'G-3', rsvp: 'מגיע', call_status: '', answer: 'ענה בוואטסאפ', tries: '__keep__', party: '2', ts: 'TS' }), f);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.valueInputOption, 'USER_ENTERED');
  const cells = Object.fromEntries(body.data.map(d => [d.range, d.values[0][0]]));
  assert.deepEqual(cells, { 'אורחים!N4': '2', 'אורחים!P4': 'מגיע', 'אורחים!V4': '', 'אורחים!W4': 'ענה בוואטסאפ', 'אורחים!X4': 'TS', 'אורחים!Z4': 'TS' });
});

test('call_result for an id that is not on the sheet writes nothing and answers like Make did', async () => {
  const env = envOf(); const f = fake([[/C2:C/, () => new Response('{"values":[["G-1"]]}')]]);
  const r = await eventsDirect(env, JSON.stringify({ event_type: 'call_result', guest_id: 'G-9', rsvp: 'מגיע' }), f);
  assert.equal(r.status, 200); assert.equal(await r.text(), 'Accepted'); assert.equal(f.calls.length, 1);
});

test('event_setup: the settings cells of the event row; an empty or absent field is left alone', async () => {
  const cells = Object.fromEntries(setupCells({ venue_name: 'אולם', venue_addr: 'רחוב 1', occasion: 'חתונה', name1: 'דנה', event_date: '2026-12-01', send_date_1: '2026-11-28', send_date_3: '' }));
  assert.equal(cells[4], 'אולם'); assert.equal(cells[5], 'חתונה'); assert.equal(cells[34], 'דנה'); assert.equal(cells[38], 'אולם רחוב 1'); assert.equal(cells[39], '2026-11-28');
  assert.equal(cells[41], null, 'empty send date 3 untouched'); assert.equal(cells[44], null, 'no image → the image cell is untouched');
  const env = envOf();
  const f = fake([[/values\/אירועים!B2:B/, () => new Response('{"values":[["x"],["tok"]]}')], [/batchUpdate/, () => new Response('{}')]]);
  const r = await eventsDirect(env, JSON.stringify({ event_type: 'event_setup', token: 'tok', venue_name: 'אולם' }), f);
  assert.equal(r.status, 200);
  const data = JSON.parse(f.calls[1].init.body).data;
  assert.deepEqual(data.map(d => d.range), ['אירועים!E3', 'אירועים!AM3']);
});

test('guests_file: one append (USER_ENTERED), then AR=כן on the event row; the answer carries the count', async () => {
  const env = envOf();
  const f = fake([[/B2:B/, () => new Response('{"values":[["tok"]]}')], [/:append/, () => new Response('{"updates":{}}')], [/batchUpdate/, () => new Response('{}')]]);
  const r = await eventsDirect(env, JSON.stringify({ event_type: 'guests_file', token: 'tok', guest_count: 2, append_body: '{"values":[["a"],["b"]]}' }), f);
  assert.deepEqual(await r.json(), { ok: true, guests: 2 });
  const ap = f.calls.find(c => /:append/.test(c.url));
  assert.equal(ap.url, 'https://sheets.googleapis.com/v4/spreadsheets/SID/values/אורחים!A1:append?valueInputOption=USER_ENTERED');
  assert.equal(ap.init.body, '{"values":[["a"],["b"]]}');
  assert.deepEqual(JSON.parse(f.calls.at(-1).init.body).data, [{ range: 'אירועים!AR2', values: [['כן']] }]);
});

test('guests_file: once the append landed the answer is success even if the AR flag fails (a retry would duplicate guests)', async () => {
  const env = envOf();
  const f = fake([[/B2:B/, () => new Response('{"values":[["tok"]]}')], [/:append/, () => new Response('{}')], [/batchUpdate/, () => new Response('x', { status: 500 })]]);
  const r = await eventsDirect(env, JSON.stringify({ event_type: 'guests_file', token: 'tok', guest_count: 1, append_body: '{"values":[["a"]]}' }), f);
  assert.equal(r.status, 200);
});

test('unknown event types are acknowledged without touching Google', async () => {
  const env = envOf(); const f = fake([]);
  const r = await eventsDirect(env, '{"event_type":"lead"}', f);
  assert.deepEqual(await r.json(), { ok: true, noted: 'lead' }); assert.equal(f.calls.length, 0);
});

test('call cells map 1:1 to the Make blueprint (N P V W X Z AD)', () => {
  assert.deepEqual(callCells({ rsvp: '__keep__', party: '__keep__', tries: '__keep__', call_status: 'נדרשת שיחה', answer: 'x', ts: 't' }).map(([c, v]) => [colLetter(c), v]),
    [['N', null], ['P', null], ['V', 'נדרשת שיחה'], ['W', 'x'], ['X', 't'], ['Z', 't'], ['AD', null]]);
});

test('no file calls the Make sheet hooks around the one door', () => {
  for (const f of fs.readdirSync(new URL('..', import.meta.url)).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /[^.\w]fetch\(env\.(BRAIN_HOOK|HOOK_EVENTS)\b/, f);
  }
});

test('a body that is not JSON text goes to Make untouched, never a silent ok', async () => {
  const env = envOf(); const f = fake([]);
  await sheetHookFetch(env, env.HOOK_EVENTS, { method: 'POST', body: new URLSearchParams({ a: '1' }) }, f);
  await sheetHookFetch(env, env.HOOK_EVENTS, { method: 'POST', body: '' }, f);
  assert.deepEqual(f.calls.map(c => c.url), ['https://make/events', 'https://make/events']);
});
