// node --test worker/test/registry-sync.test.mjs — every cron job, ledger id, brain check/playbook and sending
// admin POST route in the code has a node in automations-registry.js (scripts/registry-sync.mjs does the scan).
// When this fails: add the node (with `added: 'YYYY-MM-DD'` and `routes: [...]`) — never widen EXEMPT to make it pass
// unless the route really is not an automation (auth codes, test harnesses, inbound webhooks), with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as reg from '../automations-registry.js';
import { gaps, ledgerIds, brainIds, sendingRoutes, EXEMPT } from '../scripts/registry-sync.mjs';

test('registry covers every ledger id, brain check/playbook and sending admin route in the code', () => {
  const g = gaps(reg);
  assert.deepEqual(g.missingIds, [], 'withRun/manualRun/opsJob/step ids without a node');
  assert.deepEqual(g.missingChecks, [], 'brain CHECKS not listed on brain_health.checks');
  assert.deepEqual(g.missingPlaybooks, [], 'brain PLAYBOOKS not listed on brain_fix.playbooks');
  assert.deepEqual(g.missingRoutes.map(r => `${r.path} (${r.hit})`), [], 'sending POST routes without a node (routes[] / trigger.via)');
});

test('the scan actually finds things (so an empty gap list means covered, not blind)', () => {
  const ids = ledgerIds();
  for (const id of ['d_engine', 'heartbeat', 'brain_health', 'brain_fix', 'job:runPacer', 'shir_dispatch', 'doctor']) assert.ok(ids.has(id), id);
  const b = brainIds();
  assert.ok(b.checks.includes('template_watch') && b.checks.length >= 15, 'checks ' + b.checks.length);
  assert.ok(b.playbooks.includes('cap_probe_release') && b.playbooks.length >= 8, 'playbooks ' + b.playbooks.length);
  const paths = sendingRoutes().map(r => r.path);
  for (const p of ['/api/gift-blast', '/api/subevent-send', '/api/sms-blast', '/api/guest-text', '/api/client-link', '/api/crm/leads', '/api/pacer', '/api/event-day']) assert.ok(paths.includes(p), p);
  for (const p of Object.keys(EXEMPT)) assert.ok(EXEMPT[p].length > 10, 'every exemption has a reason: ' + p);
});

test('mutation: a registry without a node / route / playbook fails the check', () => {
  const drop = (id) => ({ ...reg, AUTOMATIONS: reg.AUTOMATIONS.filter(n => n.id !== id) });
  assert.ok(gaps(drop('heartbeat')).missingIds.some(x => x.id === 'heartbeat'));
  assert.ok(gaps(drop('guest_text')).missingRoutes.some(x => x.path === '/api/guest-text'));
  assert.ok(gaps(drop('crm_lead_send')).missingRoutes.some(x => x.path === '/api/crm/leads'));
  assert.deepEqual(gaps(drop('brain_fix')).missingPlaybooks.length, brainIds().playbooks.length);
  assert.ok(gaps({ ...reg, JOB_TO_ID: { ...reg.JOB_TO_ID, runPacer: undefined } }).missingIds.some(x => x.id === 'job:runPacer'));
});

test('nodes added by the sync carry an `added` date (the "חדש" badge) and valid edges', () => {
  const ids = new Set(reg.AUTOMATIONS.map(n => n.id));
  assert.equal(ids.size, reg.AUTOMATIONS.length, 'ids unique');
  for (const n of reg.AUTOMATIONS) for (const f of n.from || []) assert.ok(ids.has(f), `${n.id}.from ${f}`);
  for (const id of ['brain_health', 'brain_fix', 'brain_agent', 'crm_lead_send', 'outreach', 'guest_text', 'client_link', 'invoice_manual', 'voice_test_call', 'wa_send'])
    assert.match(reg.AUTOMATIONS.find(n => n.id === id).added || '', /^\d{4}-\d{2}-\d{2}$/, id);
});
