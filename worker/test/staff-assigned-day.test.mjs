/* 18/11 Richard: a registered number is a hostess only on a day she is assigned to an event */
import test from 'node:test';
import assert from 'node:assert/strict';
import { staffOnMessage } from '../staff.js';

const PH = '972501112233', TOK = 'abcdef12-0000-4000-8000-000000000001';
const kv = init => { const m = new Map(Object.entries(init)); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); },
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) }; };
const d = { ilDate: () => '2026-11-18', ilTime: () => '18:20', logEvent: async () => {} };
const run = async store => { const env = { RATE: kv({ ['staff:' + PH]: JSON.stringify({ name: 'נועה', sid: 's1' }), ...store }) }; const r = await staffOnMessage(env, PH, 'הגעתי', Date.now(), d); return { r, logged: [...env.RATE.m.keys()].some(k => k.startsWith('stafflog:')) }; };

test('no event today → an ordinary message: no reply, no attendance row', async () => {
  const { r, logged } = await run({}); assert.equal(r, null); assert.equal(logged, false);
});
test('an event today but she is not assigned to it → ordinary message', async () => {
  const { r, logged } = await run({ ['hostessbook:' + TOK]: JSON.stringify({ date: '2026-11-18', name: 'דנה ויוסי' }), 'hostassign:abcdef12': JSON.stringify(['972509999999']) });
  assert.equal(r, null); assert.equal(logged, false);
});
test('assigned, but the event is on another day → ordinary message', async () => {
  const { r } = await run({ ['hostessbook:' + TOK]: JSON.stringify({ date: '2026-11-20', name: 'דנה ויוסי' }), 'hostassign:abcdef12': JSON.stringify([PH]) });
  assert.equal(r, null);
});
test('assigned to an event today → the report is recorded and answered', async () => {
  const { r, logged } = await run({ ['hostessbook:' + TOK]: JSON.stringify({ date: '2026-11-18', name: 'דנה ויוסי' }), 'hostassign:abcdef12': JSON.stringify([PH]) });
  assert.ok(r && r.ack && r.parsed.kind === 'arrive'); assert.equal(r.tok, TOK); assert.equal(logged, true);
});
