/* 08/11: a call the carrier refused (telephony_provider_permission_denied) is NOT one of the guest's tries */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retellToCallResult } from '../shir.js';
const body = reason => ({ event: 'call_analyzed', call: { call_id: 'c1', disconnection_reason: reason, metadata: { kind: 'guest', guest_id: 'G-x-1', tries: 0, token: 't' }, start_timestamp: 1, end_timestamp: 3000 } });
test('carrier refused / telephony error → skip (no try); a real no-answer still counts', () => {
  for (const r of ['telephony_provider_permission_denied', 'telephony_provider_unavailable', 'error_inbound_webhook', 'concurrency_limit_reached']) {
    const a = retellToCallResult(body(r));
    assert.equal(a.kind, 'skip', r); assert.match(a.why, /^not-connected/);
  }
  assert.equal(retellToCallResult(body('voicemail_reached')).kind, 'skip');
  assert.equal(retellToCallResult(body('dial_no_answer')).kind, 'end');
});
