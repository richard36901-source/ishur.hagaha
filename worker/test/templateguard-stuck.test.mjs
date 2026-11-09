import test from 'node:test'; import assert from 'node:assert/strict';
import { runGuard } from '../templateguard.js';
test('09/11 a stuck template alerts once, not every hour', async () => {
  const kv = new Map(); const notes = [];
  const deps = { list: async () => [], submit: async () => ({}), kv: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, notify: async t => notes.push(t), log: async () => {} };
  await runGuard(['hazmana_ishur'], deps); await runGuard(['hazmana_ishur'], deps); await runGuard(['hazmana_ishur'], deps);
  assert.equal(notes.length, 1);
});
