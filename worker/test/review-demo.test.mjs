// node --test worker/test/review-demo.test.mjs — the App Store review demo client (review-demo.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../review-demo.js';

const TOK = 'eeeeeeee-0000-4000-8000-00000000000e';
const env = (o = {}) => ({ REVIEW_TOKEN: TOK, REVIEW_PHONE: '0500005201', ...o });
function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } }; }

test('off unless both the token and the phone are set', () => {
  assert.equal(R.reviewOn(env()), true);
  assert.equal(R.reviewOn(env({ REVIEW_TOKEN: '' })), false);
  assert.equal(R.reviewOn(env({ REVIEW_PHONE: '' })), false);
  assert.equal(R.demoGate({}, 'POST', '/api/guest-add', JSON.stringify({ token: TOK })), null);
});
test('any route that could send is refused for the demo token or phone; safe routes and other clients pass', () => {
  for (const p of ['/api/guest-add', '/api/guest-edit', '/api/send-date', '/api/custom-template', '/api/addon-pay', '/api/event-change', '/api/event', '/api/design-brief', '/api/feedback', '/api/some-new-route'])
    assert.deepEqual(R.demoGate(env(), 'POST', p, JSON.stringify({ token: TOK, phone: '0521234567' })), { error: 'demo-readonly' }, p);
  for (const ph of ['0500005201', '972500005201', '050-0005201'])
    assert.deepEqual(R.demoGate(env(), 'POST', '/api/otp-send', JSON.stringify({ phone: ph })), { error: 'demo-readonly' }, ph);
  for (const p of ['/api/status', '/api/budget', '/api/lineup', '/api/venue-commit', '/api/account/pin-login'])
    assert.equal(R.demoGate(env(), 'POST', p, JSON.stringify({ token: TOK })), null, p);
  assert.equal(R.demoGate(env(), 'POST', '/api/guest-add', JSON.stringify({ token: 'aaaaaaaa-0000-4000-8000-000000000001' })), null, 'a real client is untouched');
  assert.equal(R.demoGate(env(), 'GET', '/api/guest-add', ''), null);
});
test('the demo rows are added only where asked, re-keyed to the demo token and owner', async () => {
  const src = { events: [['x', 'bbbbbbbb-0000-4000-8000-000000000002', 'איתי', '972500000102', 'אולם', 'בר מצווה', '2026-12-02', 'לא']], guests: [Array.from({ length: 29 }, (_, i) => (i === 28 ? 'bbbbbbbb-0000-4000-8000-000000000002' : 'g')), Array.from({ length: 29 }, (_, i) => (i === 28 ? 'other' : 'h'))] };
  const rows = R.rekey(env(), src);
  assert.equal(rows.events[0][1], TOK); assert.equal(rows.events[0][3], '972500005201'); assert.equal(rows.events[0][7], 'כן');
  assert.equal(rows.guests.length, 1); assert.equal(rows.guests[0][28], TOK);
  const e = env({ RATE: kv({ 'review:rows': JSON.stringify(rows) }) });
  const raw = { events: { values: [['r1']] }, guests: { values: [['g1']] }, other: 1 };
  const out = await R.withDemo(e, raw);
  assert.equal(out.events.values.length, 2); assert.equal(out.guests.values.length, 2); assert.equal(out.other, 1);
  assert.equal(raw.events.values.length, 1, 'the snapshot itself is not changed');
  assert.equal(await R.withDemo(env({ RATE: kv(), REVIEW_TOKEN: '' }), raw), raw);
});
