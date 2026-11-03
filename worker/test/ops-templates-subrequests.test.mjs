import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplates, WABAS, tplKey } from '../ops-money.js';

function mkEnv() {
  const kv = new Map(); let ops = 0;
  const RATE = {
    async get(k) { ops++; return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { ops++; kv.set(k, v); },
    async delete(k) { ops++; kv.delete(k); },
    async list() { ops++; return { keys: [], list_complete: true }; },
  };
  return { env: { RATE, WA_TOKEN: 't', WA_TOKEN_GUESTS: 't2' }, kv, ops: () => ops };
}
const tpls = n => Array.from({ length: n }, (_, i) => ({ id: String(i), name: 'tpl_' + i, status: i % 7 ? 'APPROVED' : 'PENDING', category: 'UTILITY', language: 'he' }));

test('GET templates: 3 WABAs x 60 templates stays within 20 subrequests (fetch + KV + audit)', async () => {
  const { env, ops } = mkEnv(); let fetches = 0;
  const fetchFn = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ data: tpls(60) }) }; };
  let auditOps = 0;
  const d = { auditQueryEx: async (e, q) => { assert.equal(q.kind, undefined); assert.ok(q.budget <= 10); auditOps = q.budget; for (let i = 0; i < q.budget; i++) await e.RATE.get('stream:x:' + i); return { items: [{ kind: 'wa_out', ts: Date.now(), phone: '972500000001', ok: true, data: { template: 'tpl_1', wamid: 'w1' } }, { kind: 'wa_status', ts: Date.now(), data: { wamid: 'w1', status: 'delivered' } }], truncated: true }; } };
  const r = await buildTemplates(env, d, { fetchFn, fresh: true });
  assert.equal(r.ok, true); assert.equal(r.templates.length, 180); assert.equal(fetches, 3);
  assert.ok(fetches + ops() <= 20, `subrequests ${fetches + ops()}`);
  assert.equal(r.stats_partial, true);
  assert.ok(auditOps <= 10);
  const t1 = r.templates.find(t => t.name === 'tpl_1'); assert.equal(t1.sends, 1);
  // warm call: cache hit, zero fetches
  const before = fetches; const r2 = await buildTemplates(env, d, { fetchFn });
  assert.equal(r2.cached, true); assert.equal(fetches, before);
});

test('GET templates: serves stale cache when Meta fails', async () => {
  const { env, kv } = mkEnv();
  kv.set(tplKey('7d'), JSON.stringify({ at: Date.now() - 3600e3, data: { ok: true, templates: [{ name: 'old' }], by_status: {}, errors: [] } }));
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r = await buildTemplates(env, { auditQueryEx: async () => ({ items: [] }) }, { fetchFn });
  assert.equal(r.stale, true); assert.equal(r.templates[0].name, 'old');
});
