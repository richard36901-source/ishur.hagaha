// node --test worker/test/security-sheet-formula.test.mjs — 12/11 security audit, pass 2: text typed by a lead,
// a client, a guest or a payer cannot arrive in the Google Sheet as a formula. The Make writer scenarios
// store cells as USER_ENTERED, so the Worker neutralises a leading = + - @ (tab, CR) before it posts to them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../index.js';
import { sheetSafe, sheetStrip, makeWriterBody } from '../lib.js';

test('sheetSafe: a formula-looking string is forced to text, everything else is untouched', () => {
  for (const v of ['=1+1', '=HYPERLINK("http://x","y")', '+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '  =1+1', '‏=1+1', '- לא מגיע'])
    assert.equal(sheetSafe(v), "'" + v, JSON.stringify(v));
  for (const v of ['דנה כהן', '972521234567', '0521234567', 'a=b', 'מגיעים 2', '', '2026-12-20', '__keep__', 'x@y.co'])
    assert.equal(sheetSafe(v), v, JSON.stringify(v));
  assert.equal(sheetSafe(5), 5); assert.equal(sheetSafe(null), null); assert.equal(sheetSafe(true), true);
});
test('phones that start with + are left alone', () => {
  for (const v of ['+972521234567', '+972 52-123-4567', '+1 (212) 555-0100', '+44 20 7946 0958']) { assert.equal(sheetSafe(v), v); assert.equal(sheetStrip(v), v); }
  assert.equal(sheetSafe('+972521234567+cmd'), "'+972521234567+cmd", 'not a phone'); assert.equal(sheetSafe('+12'), "'+12", 'too short to be a phone');
});
test('sheetStrip: identity fields lose the leading formula characters', () => {
  assert.equal(sheetStrip('=cmd|x'), 'cmd|x'); assert.equal(sheetStrip('+-=@ דנה'), 'דנה'); assert.equal(sheetStrip('\t=1+1'), '1+1'); assert.equal(sheetStrip(' = =x'), 'x');
  assert.equal(sheetStrip('דנה'), 'דנה'); assert.equal(sheetStrip('a-b'), 'a-b'); assert.equal(sheetStrip(7), 7);
});
test('makeWriterBody: per-field rules, guest rows inside append_body, phones kept', () => {
  const env = { HOOK_EVENTS: 'https://hook.test/events', HOOK_LEADS: 'https://hook.test/leads', HOOK_GROW: 'https://hook.test/grow', HOOK_STATUS: 'https://hook.test/status', BRAIN_HOOK: 'https://hook.test/brain' };
  const ev = JSON.parse(makeWriterBody(env, env.HOOK_EVENTS, JSON.stringify({ event_type: 'event_setup', token: 'a-b', venue_name: '=A1', venue_addr: '+B2', event_description: '=IMPORTXML("http://x","//a")', answer: '+1', party: '__keep__', tries: '2',
    append_body: JSON.stringify({ values: [['1', 'tok', 'G-1', '=HYPERLINK("http://x")', '972521234567', '+972521234567', '@note', 3]] }) })));
  assert.equal(ev.venue_name, 'A1'); assert.equal(ev.venue_addr, 'B2'); assert.equal(ev.event_description, "'=IMPORTXML(\"http://x\",\"//a\")"); assert.equal(ev.answer, "'+1");
  assert.equal(ev.party, '__keep__'); assert.equal(ev.token, 'a-b'); assert.equal(ev.event_type, 'event_setup');
  assert.deepEqual(JSON.parse(ev.append_body).values[0], ['1', 'tok', 'G-1', "'=HYPERLINK(\"http://x\")", '972521234567', '+972521234567', "'@note", 3]);
  const lead = JSON.parse(makeWriterBody(env, env.HOOK_LEADS, JSON.stringify({ name: '=cmd', phone: '+972521234567', email: 'a@b.co', utm_source: '@x', occasion: '-חתונה', plan_name: '+VIP' })));
  assert.deepEqual(lead, { name: 'cmd', phone: '+972521234567', email: 'a@b.co', utm_source: 'x', occasion: 'חתונה', plan_name: 'VIP' });
  const grow = JSON.parse(makeWriterBody(env, env.HOOK_GROW, JSON.stringify({ name: '=1+1', phone: '0521234567', sum: 900, planText: '@x' })));
  assert.equal(grow.name, '1+1'); assert.equal(grow.planText, 'x'); assert.equal(grow.sum, 900);
  /* reads and the RAW proxy are not touched; a body that is not JSON passes as is */
  const raw = JSON.stringify({ url: 'spreadsheets/x', payload: '=1' });
  assert.equal(makeWriterBody(env, env.BRAIN_HOOK, raw), raw); assert.equal(makeWriterBody(env, env.HOOK_STATUS, raw), raw); assert.equal(makeWriterBody(env, env.HOOK_EVENTS, 'not json'), 'not json');
});

/* through the real Worker: the public lead form and the client's settings step */
function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) }; }
let realFetch, hooked = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (u, init = {}) => { if (/hook\.test\/(leads|events)/.test(String(u))) { hooked.push({ u: String(u), body: JSON.parse(init.body) }); return new Response('Accepted'); } return new Response('{}'); }; });
after(() => { globalThis.fetch = realFetch; });
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
const TOK = '11111111-2222-3333-4444-555555555555';
const env = () => ({ ADMIN_KEY: 'k', APP_KEY: 'app', HOOK_LEADS: 'https://hook.test/leads', HOOK_EVENTS: 'https://hook.test/events', RATE: kv({ ['token:' + TOK]: JSON.stringify({ phone: '972521234567' }) }) });
const stamp = () => { const nonce = crypto.randomBytes(8).toString('hex'), stamp_ts = String(Date.now()); return { app: 'ishur-web', nonce, stamp_ts, sig: crypto.createHash('sha256').update(`app|${nonce}|${stamp_ts}`).digest('hex') }; };
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9', Origin: 'https://ishur.io' }, body: JSON.stringify({ ...stamp(), ...body }) }), e, ctx);

test('POST /api/lead: what reaches the Make writer has no leading formula character; the phone is intact', async () => {
  const e = env(); hooked = [];
  const r = await post(e, '/api/lead', { name: '=HYPERLINK("http://evil.example","לחץ")', phone: '+972521110001', occasion: '@SUM(1)', utm_source: '=x', event_type: 'lead_submitted' });
  assert.equal(r.status, 200); assert.equal(hooked.length, 1);
  const b = hooked[0].body;
  assert.equal(b.name, 'HYPERLINK("http://evil.example","לחץ")'); assert.equal(b.occasion, 'SUM(1)'); assert.equal(b.utm_source, 'x'); assert.equal(b.phone, '+972521110001');
  for (const [k, v] of Object.entries(b)) if (typeof v === 'string' && k !== 'phone') assert.ok(!/^[\s]*[=+\-@]/.test(v), k + ' still starts with a formula character');
});
