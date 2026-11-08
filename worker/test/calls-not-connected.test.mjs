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

import { buildCallPayload, guestOpening } from '../shir.js';
test('opener · spoken the moment the guest picks up; undecided guests get their own; never literal braces', () => {
  const g = { guest_id: 'G-1', token: 't', name: 'דנה', event_name: 'שילת ושי', occasion: 'חינה', event_date: '2026-11-09', phone: '972500000000' };
  const p = buildCallPayload(g, '+972000', {});
  assert.match(p.retell_llm_dynamic_variables.opening, /^היי, מדברת שיר מאישורי הגעה בשם שילת ושי — מגיעים לחינה ב-/);
  assert.match(guestOpening({ host_name: 'א', occasion: 'חינה', guest_state: 'מתלבט' }), /עוד לא סגרתם/);
  for (const v of Object.values(p.retell_llm_dynamic_variables)) assert.ok(!/\{\{/.test(String(v)));
});

import { qaDigest } from '../index.js';
test('QA digest · sums qastat days and lists lessons added in the period', async () => {
  const m = new Map([['qastat:2026-11-08', JSON.stringify({ calls: 10, talked: 6, recorded: 4, fixed: 1, gap: 1, notconn: 2, voicemail: 1, noanswer: 1 })],
    ['qastat:2026-11-07', JSON.stringify({ calls: 5, talked: 3, recorded: 3 })]]);
  const env = { RATE: { get: async k => m.get(k) ?? null, put: async () => {}, list: async () => ({ keys: [], list_complete: true }) } };
  const d1 = await qaDigest(env, 1, '2026-11-08');
  assert.equal(d1.calls, 10); assert.equal(d1.fixed, 1);
  const d7 = await qaDigest(env, 7, '2026-11-08');
  assert.equal(d7.calls, 15); assert.equal(d7.talked, 9);
});
