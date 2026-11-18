// node --test worker/test/guest-event-separation.test.mjs — 15/11: an answer belongs to the event that wrote to the guest
import test from 'node:test';
import assert from 'node:assert/strict';
import { findGuestByPhone } from '../whatsapp.js';

const HENNA = 'aaaaaaaa-0000-4000-8000-000000000001', WEDDING = 'bbbbbbbb-0000-4000-8000-000000000002';
const ev = (tok, date) => { const r = Array(48).fill(''); r[1] = tok; r[6] = date; return r; };
const guest = (tok, id, phone, o = {}) => { const r = Array(31).fill(''); r[2] = id; r[3] = 'אופיר'; r[4] = phone; r[28] = tok; r[8] = o.sent1 || ''; r[15] = o.rsvp || ''; r[29] = o.tries || ''; return r; };
const snap = (...g) => ({ events: { values: [ev(HENNA, '2026-11-09'), ev(WEDDING, '2026-11-26')] }, guests: { values: g } });
const TODAY = '2026-11-15';

test('the henna passed, the wedding has not invited yet: the answer stays on the henna', () => {
  const raw = snap(guest(HENNA, 'G-aaaaaaaa-1', '0501234567', { sent1: '2026-11-01 09:01', rsvp: 'מגיע' }), guest(WEDDING, 'G-bbbbbbbb-1', '0501234567'));
  assert.equal(findGuestByPhone(raw, '0501234567', TODAY, { preferContacted: true }).token, HENNA);
  /* callers that only ask "is this person on an upcoming list" keep the old rule */
  assert.equal(findGuestByPhone(raw, '0501234567', TODAY).token, WEDDING);
});

test('once the wedding invitation went out, the wedding takes the answer', () => {
  const raw = snap(guest(HENNA, 'G-aaaaaaaa-1', '0501234567', { sent1: '2026-11-01 09:01', rsvp: 'מגיע' }), guest(WEDDING, 'G-bbbbbbbb-1', '0501234567', { sent1: '2026-11-16 09:05' }));
  assert.equal(findGuestByPhone(raw, '0501234567', TODAY, { preferContacted: true }).token, WEDDING);
});

test('a late invitation leaves only a send mark: the caller passes it in', () => {
  const raw = snap(guest(HENNA, 'G-aaaaaaaa-1', '0501234567', { sent1: '2026-11-01 09:01' }), guest(WEDDING, 'G-bbbbbbbb-1', '0501234567'));
  assert.equal(findGuestByPhone(raw, '0501234567', TODAY, { preferContacted: true, sent: new Set([WEDDING]) }).token, WEDDING);
});

test('nobody wrote to them yet: nearest upcoming, as before', () => {
  const raw = snap(guest(HENNA, 'G-aaaaaaaa-1', '0501234567'), guest(WEDDING, 'G-bbbbbbbb-1', '0501234567'));
  assert.equal(findGuestByPhone(raw, '0501234567', TODAY, { preferContacted: true }).token, WEDDING);
});

test('one list only: unchanged', () => {
  const raw = snap(guest(WEDDING, 'G-bbbbbbbb-1', '0501234567'));
  assert.equal(findGuestByPhone(raw, '0501234567', TODAY, { preferContacted: true }).token, WEDDING);
  assert.equal(findGuestByPhone(raw, '0509999999', TODAY, { preferContacted: true }), null);
});
