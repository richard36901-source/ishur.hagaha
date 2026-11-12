// 12/11 Richard: Meta accepted but never delivered for 24h → red on the board + one more attempt next morning
import test from 'node:test';
import assert from 'node:assert/strict';
import { _staleSentByEvent as staleSentByEvent } from '../index.js';
const TTL = 120 * 86400, NOW = Date.parse('2026-11-12T12:00:00Z');
const exp = agoH => Math.floor((NOW - agoH * 3600e3) / 1000) + TTL;
function env(keys, kv = {}) {
  const dels = [], puts = {};
  return { dels, puts, RATE: {
    list: async ({ prefix }) => ({ keys: keys.filter(k => k.name.startsWith(prefix)), list_complete: true }),
    get: async k => kv[k] ?? null, delete: async k => { dels.push(k); }, put: async (k, v) => { puts[k] = v; } } };
}
const ev = Array(45).fill(''); ev[1] = 'TOK'; ev[2] = 'מור'; ev[6] = '2026-11-30';
const g = (ph, rsvp = '') => { const r = Array(30).fill(''); r[3] = 'אורח ' + ph.slice(-2); r[4] = ph; r[15] = rsvp; r[28] = 'TOK'; return r; };
const raw = { events: { values: [[], ev] }, guests: { values: [[], g('972500000001'), g('972500000002'), g('972500000003', 'מגיע'), g('972500000004')] } };
test('stale = accepted 30h ago, no delivered/read, no answer; fresh, delivered or answered are not', async () => {
  const e = env([
    { name: 'wsent:TOK:1:972500000001', expiration: exp(30) },   // stale → listed
    { name: 'wsent:TOK:1:972500000002', expiration: exp(2) },    // 2h → too fresh
    { name: 'wsent:TOK:1:972500000003', expiration: exp(30) },   // answered → no
    { name: 'wsent:TOK:1:972500000004', expiration: exp(30) },   // delivered → no
  ], { 'wst:TOK:1:972500000004': 'delivered' });
  const by = await staleSentByEvent(e, raw, NOW);
  assert.deepEqual(by.TOK.list.map(x => x.phone), ['972500000001']);
  assert.equal(by.TOK.list[0].kind, 'stale');
  assert.equal(e.dels.length, 0);
});
test('mark: drops wsent so the engine resends, and wstale blocks a second extra attempt', async () => {
  const keys = [{ name: 'wsent:TOK:1:972500000001', expiration: exp(30) }];
  const e = env(keys);
  await staleSentByEvent(e, raw, NOW, { mark: true });
  assert.deepEqual(e.dels, ['wsent:TOK:1:972500000001']);
  assert.ok(e.puts['wstale:TOK:1:972500000001']);
  const e2 = env(keys, { 'wstale:TOK:1:972500000001': '2026-11-12' });
  assert.deepEqual(await staleSentByEvent(e2, raw, NOW), {});
});
