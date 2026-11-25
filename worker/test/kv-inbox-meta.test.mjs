// node --test worker/test/kv-inbox-meta.test.mjs — 25/11 the KV bill: the inbox list reads each conversation from the
// conv: listing's metadata (written by touchConversation) instead of one read per conversation; same answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';
import { touchConversation } from '../whatsapp.js';

function kv() {
  const m = new Map(), md = new Map(), gets = [];
  return { m, md, gets, get: async k => { gets.push(k); return m.has(k) ? m.get(k) : null; }, getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: md.get(k) || null }),
    put: async (k, v, o) => { m.set(k, String(v)); if (o && o.metadata) md.set(k, o.metadata); else md.delete(k); }, delete: async k => { m.delete(k); md.delete(k); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(); const s = Number(cursor) || 0; const keys = all.slice(s, s + limit).map(name => ({ name, ...(md.has(name) ? { metadata: md.get(name) } : {}) })); const done = s + limit >= all.length; return { keys, list_complete: done, ...(done ? {} : { cursor: String(s + limit) }) }; } };
}
let realFetch;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async () => new Response('{}', { status: 200 }); });
after(() => { globalThis.fetch = realFetch; });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
async function inbox(RATE, body = {}) {
  const env = { ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', SWR_OFF: '1', RATE };   /* the route cache would answer the second store from memory */
  const r = await worker.fetch(new Request('https://go.ishur.io/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...body }) }), env, ctx);
  return r.json();
}
async function seed() {
  const RATE = kv(); const env = { RATE };
  for (let i = 0; i < 120; i++) {
    const phone = '9725000' + String(i).padStart(5, '0');
    await touchConversation(env, phone, { ts: 1760000000000 + i * 1000, dir: i % 3 ? 'out' : 'in', text: 'שלום ' + 'ש'.repeat(i % 90), ch: i % 2 ? 'guests' : 'client' });
    if (i % 4 === 0) await touchConversation(env, phone, { ts: 1760000500000 + i, dir: 'in', text: 'תשובה', ch: 'client' });
  }
  /* written before 25/11: no metadata */
  RATE.m.set('conv:972500099999', JSON.stringify({ phone: '972500099999', msgs: 3, first_ts: 1, last_ts: 1761000000000, last_dir: 'in', last_text: 'ישן', ch: ['client'], last_in_ts: 1761000000000 }));
  RATE.m.set('inboxnames:cache2', '{}');
  return RATE;
}

test('inbox list: same conversations and fields as the read-every-value path; conv: values read only where metadata is missing', async () => {
  const withMeta = await seed();
  const noMeta = await seed(); for (const k of [...noMeta.md.keys()]) if (k.startsWith('conv:')) noMeta.md.delete(k);
  let n = 0;
  for (const body of [{}, { channel: 'guests' }, { channel: 'client' }]) {
    for (const k of [...noMeta.md.keys()]) if (k.startsWith('conv:')) noMeta.md.delete(k);   /* the old path every time (the list backfills) */
    withMeta.gets.length = 0; noMeta.gets.length = 0;
    const a = await inbox(withMeta, body), b = await inbox(noMeta, body);
    assert.deepEqual(a, b, JSON.stringify(body));
    assert.ok(a.conversations.length > 50, 'conversations came back: ' + a.conversations.length);
    assert.deepEqual(withMeta.gets.filter(k => k.startsWith('conv:')), n++ ? [] : ['conv:972500099999', 'conv:972500099999'], 'only the legacy conversation is read (and read again right before its backfill write), then never');
    assert.ok(noMeta.gets.filter(k => k.startsWith('conv:')).length >= 121, 'the old path reads every conversation (plus the backfill re-reads here)');
  }
});

test('a conversation written before 25/11 gets its metadata on the next list (quiet ones only), then costs no read', async () => {
  const RATE = await seed();
  RATE.m.set('conv:972500088888', JSON.stringify({ phone: '972500088888', msgs: 1, first_ts: Date.now(), last_ts: Date.now() - 60e3, last_dir: 'in', last_text: 'עכשיו', ch: ['client'] }));
  const first = await inbox(RATE);
  assert.ok(RATE.md.has('conv:972500099999'), 'the quiet legacy conversation now carries metadata');
  assert.equal(RATE.m.get('conv:972500099999'), JSON.stringify({ phone: '972500099999', msgs: 3, first_ts: 1, last_ts: 1761000000000, last_dir: 'in', last_text: 'ישן', ch: ['client'], last_in_ts: 1761000000000 }), 'value unchanged');
  assert.ok(!RATE.md.has('conv:972500088888'), 'an active one (last message a minute ago) is left alone');
  RATE.gets.length = 0;
  const second = await inbox(RATE);
  assert.deepEqual(second, first);
  assert.deepEqual(RATE.gets.filter(k => k.startsWith('conv:')), ['conv:972500088888']);
});

test('backfill: a conversation that changed between the list read and the write is not written back (no lost message)', async () => {
  const RATE = await seed(); const env = { RATE };
  const key = 'conv:972500099999'; const g0 = RATE.get; let n = 0;
  /* a webhook lands on this conversation right after the inbox read it */
  RATE.get = async k => { const v = await g0(k); if (k === key && ++n === 1) await touchConversation(env, '972500099999', { ts: 1761000005000, dir: 'in', text: 'חדש', ch: 'client' }); return v; };
  await inbox(RATE);
  const after = JSON.parse(RATE.m.get(key));
  assert.equal(after.last_text, 'חדש', 'the new message survived'); assert.equal(after.msgs, 4);
  assert.equal(RATE.md.get(key).v.last_text, 'חדש', 'and its metadata is touchConversation\'s own');
});

test('backfill: at most 300 conversations per call', async () => {
  const RATE = await seed();
  for (let i = 0; i < 700; i++) RATE.m.set('conv:97259' + String(i).padStart(7, '0'), JSON.stringify({ phone: '97259' + String(i).padStart(7, '0'), msgs: 1, first_ts: 1, last_ts: 1700000000000, last_dir: 'in', last_text: 'x', ch: ['client'] }));
  const convMd = () => [...RATE.md.keys()].filter(k => k.startsWith('conv:')).length;
  const puts0 = convMd();
  await inbox(RATE);
  assert.equal(convMd() - puts0, 300);
});
