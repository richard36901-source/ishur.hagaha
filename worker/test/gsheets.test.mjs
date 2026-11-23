// node --test worker/test/gsheets.test.mjs — 23/11 the snapshot read straight from Google, Make as the fallback
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseSa, signedJwt, shapeSnapshot, readSnapshotDirect, SNAPSHOT_RANGES } from '../gsheets.js';
import { fetchRaw } from '../snapshot.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SA = { client_email: 'reader@test.iam.gserviceaccount.com', private_key: privateKey };
const kv = () => { const m = new Map(); return { get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, _m: m }; };
const GOOD = { valueRanges: [
  { range: "'אירועים'!A2:AY500", majorDimension: 'ROWS', values: [['C-1', 'tok-1', 'לקוח']] },
  { range: "'אורחים'!A2:AF30000", majorDimension: 'ROWS', values: [['C-1', 'לקוח', 'G-1', 'אורח']] },
  { range: "'לידים - לא סגרו'!A2:Z3000", majorDimension: 'ROWS' }] };
const fetcher = (log, sheets = { status: 200, body: GOOD }) => async (url, init) => {
  log.push(String(url).split('?')[0]);
  if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'T-1', expires_in: 3600 }), { status: 200 });
  assert.equal(init.headers.Authorization, 'Bearer T-1');
  for (const r of SNAPSHOT_RANGES) assert.ok(String(url).includes('ranges=' + encodeURIComponent(r)), r);
  return new Response(JSON.stringify(sheets.body), { status: sheets.status });
};

test('the key: parsed only when it is a service-account key', () => {
  assert.equal(parseSa({}), null); assert.equal(parseSa({ GOOGLE_SA: 'not json' }), null); assert.equal(parseSa({ GOOGLE_SA: '{"client_email":"x"}' }), null);
  assert.equal(parseSa({ GOOGLE_SA: JSON.stringify(SA) }).client_email, SA.client_email);
});
test('the token request is signed with the key and asks for read-only access', async () => {
  const jwt = await signedJwt(SA, 1700000000); const [h, c, s] = jwt.split('.');
  const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claim.iss, SA.client_email); assert.equal(claim.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly'); assert.equal(claim.exp - claim.iat, 3600);
  const v = createVerify('RSA-SHA256'); v.update(h + '.' + c); assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')), 'signature verifies with the public key');
});
test("Google's answer becomes the shape the Make scenario returns; a wrong answer is refused", () => {
  const s = shapeSnapshot(GOOD);
  assert.equal(s.ok, true); assert.equal(s.events.values[0][1], 'tok-1'); assert.equal(s.guests.values[0][2], 'G-1'); assert.equal(s.leads.values, undefined);
  assert.equal(shapeSnapshot(null), null); assert.equal(shapeSnapshot({ valueRanges: GOOD.valueRanges.slice(0, 2) }), null);
  assert.equal(shapeSnapshot({ valueRanges: [GOOD.valueRanges[2], GOOD.valueRanges[1], GOOD.valueRanges[0]] }), null, 'tabs in the wrong order');
  assert.equal(shapeSnapshot({ valueRanges: [{ ...GOOD.valueRanges[0], values: [] }, GOOD.valueRanges[1], GOOD.valueRanges[2]] }), null, 'no events at all');
});
test('one read: a token once, then the three tabs; the token is reused', async () => {
  const env = { GOOGLE_SA: JSON.stringify(SA), RATE: kv() }; const log = [];
  const a = await readSnapshotDirect(env, fetcher(log)); assert.equal(a.guests.values[0][3], 'אורח');
  await readSnapshotDirect(env, fetcher(log));
  assert.equal(log.filter(u => u.includes('oauth2')).length, 1, 'one token for two reads');
  assert.equal(log.filter(u => u.includes('sheets.googleapis.com')).length, 2);
  assert.equal(await readSnapshotDirect({ RATE: kv() }, fetcher([])), null, 'no key = not used');
});
test('Google refuses (403): null, and the kept token is dropped', async () => {
  const env = { GOOGLE_SA: JSON.stringify(SA), RATE: kv() };
  assert.equal(await readSnapshotDirect(env, fetcher([], { status: 403, body: { error: 'no access' } })), null);
  assert.equal(await env.RATE.get('gsa:token'), null);
});
test('fetchRaw: Google first, Make only when Google does not answer, and unchanged without the key', async () => {
  const real = globalThis.fetch; const calls = [];
  const make = { ok: true, events: { values: [['m']] }, guests: { values: [] }, leads: {} };
  try {
    globalThis.fetch = async (url, init) => { calls.push(String(url).split('?')[0]);
      if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'T-1', expires_in: 3600 }), { status: 200 });
      if (String(url).includes('sheets.googleapis.com')) return new Response(JSON.stringify(GOOD), { status: 200 });
      return new Response(JSON.stringify(make), { status: 200 }); };
    const viaGoogle = await fetchRaw({ HOOK_STATUS: 'https://make.example/hook', GOOGLE_SA: JSON.stringify(SA), RATE: kv() });
    assert.equal(viaGoogle.events.values[0][1], 'tok-1'); assert.ok(!calls.includes('https://make.example/hook'), 'Make was not called');
    calls.length = 0;
    globalThis.fetch = async (url) => { calls.push(String(url).split('?')[0]);
      if (String(url).includes('googleapis.com')) return new Response('down', { status: 503 });
      return new Response(JSON.stringify(make), { status: 200 }); };
    const viaMake = await fetchRaw({ HOOK_STATUS: 'https://make.example/hook', GOOGLE_SA: JSON.stringify(SA), RATE: kv() });
    assert.equal(viaMake.events.values[0][0], 'm'); assert.ok(calls.includes('https://make.example/hook'));
    calls.length = 0;
    const noKey = await fetchRaw({ HOOK_STATUS: 'https://make.example/hook', RATE: kv() });
    assert.equal(noKey.events.values[0][0], 'm'); assert.deepEqual(calls, ['https://make.example/hook']);
  } finally { globalThis.fetch = real; }
});
