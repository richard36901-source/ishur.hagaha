// node --test worker/test/audit-query.test.mjs
// 02/11 blind spot: /api/stream lost everything after ~10,000 KV ops of the day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryEx, record, streamMeta } from '../audit.js';

/* KV with Cloudflare's shape (cursor paging, metadata) and a hard per-invocation
   op ceiling: every op past `cap` throws, like the real runtime did on 02/11 */
function cappedKv(cap = Infinity) {
  const m = new Map();
  let ops = 0;
  const tick = () => { ops++; if (ops > cap) throw new Error('Too many API requests by single Worker invocation'); };
  return {
    store: m,
    get ops() { return ops; },
    reset() { ops = 0; },
    async get(k) { tick(); return m.has(k) ? m.get(k).v : null; },
    async put(k, v, o = {}) { m.set(k, { v: String(v), meta: o.metadata }); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit = 1000, cursor }) {
      tick();
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      const done = start + limit >= all.length;
      return { keys: slice.map(name => ({ name, metadata: m.get(name).meta })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

function ilDay(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d).replace(/-/g, ''); }

/* n records of today, oldest first; every 100th is a wa_in, the very last is the one Richard is looking for */
function seed(kv, n, { withMeta = false } = {}) {
  const day = ilDay(new Date());
  const t0 = Date.now() - n * 1000;
  for (let i = 0; i < n; i++) {
    const ts = t0 + i * 1000;
    const kind = i === n - 1 ? 'wa_in' : (i % 100 === 0 ? 'wa_in' : 'wa_out');
    const r = { id: `${day}-${ts}-x${i}`, at: new Date(ts).toISOString(), ts, kind, phone: i === n - 1 ? '972528383205' : '9725' + String(i).padStart(8, '0'), action: 'r' + i };
    kv.store.set(`stream:${day}:${ts}:x${String(i).padStart(5, '0')}`, { v: JSON.stringify(r), meta: withMeta ? streamMeta(r) : undefined });
  }
}

test('a day bigger than the KV op ceiling still returns its NEWEST records (02/11 regression)', async () => {
  const kv = cappedKv(10000);
  seed(kv, 10949);                     /* the real 02/11 count, no metadata (pre-fix records) */
  const env = { RATE: kv };
  const r = await queryEx(env, { days: 1, limit: 600, kind: 'wa_in' });
  assert.ok(r.items.length > 0, 'got something');
  assert.equal(r.items[0].action, 'r10948', 'the newest wa_in of the day is first');
  assert.equal(r.items[0].phone, '972528383205');
  assert.ok(kv.ops <= 10000, `stayed under the ceiling (${kv.ops} ops)`);
  assert.equal(r.truncated, true, 'and it SAYS the answer was cut');
  assert.ok(r.oldest_ts > 0);
});

test('with list() metadata a kind filter costs no get() for other kinds', async () => {
  const kv = cappedKv(10000);
  seed(kv, 10949, { withMeta: true });
  const r = await queryEx({ RATE: kv }, { days: 1, limit: 2000, kind: 'wa_in' });
  assert.equal(r.truncated, false, 'the whole day fits once non-matching records are skipped unread');
  assert.equal(r.items.length, 111, 'every wa_in of the day (110 hundreds + the last one)');
  assert.ok(kv.ops < 200, `only lists + matching gets (${kv.ops})`);
  assert.equal(r.items[0].action, 'r10948');
});

test('phone filter via metadata finds the one conversation', async () => {
  const kv = cappedKv(10000);
  seed(kv, 10949, { withMeta: true });
  const items = await query({ RATE: kv }, { days: 1, phone: '972528383205' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'wa_in');
});

test('small day: same answer as before, newest first, not truncated', async () => {
  const kv = cappedKv();
  seed(kv, 300);
  const r = await queryEx({ RATE: kv }, { days: 1, limit: 50 });
  assert.equal(r.items.length, 50);
  assert.equal(r.items[0].action, 'r299');
  assert.ok(r.items[0].ts > r.items[49].ts);
  assert.equal(r.truncated, false);
  const s = await queryEx({ RATE: kv }, { days: 1, since: r.items[1].ts });
  assert.deepEqual(s.items.map(x => x.action), ['r299'], 'since still works on the key timestamp');
});

test('record() writes kind/phone/token as list metadata', async () => {
  const kv = cappedKv();
  await record({ RATE: kv }, { kind: 'wa_in', area: 'נועה', action: 'x', phone: '972507536247', token: 'abcdef12-0000-0000-0000-000000000000' });
  const [k] = [...kv.store.keys()].filter(n => n.startsWith('stream:'));
  assert.deepEqual(kv.store.get(k).meta, { k: 'wa_in', p: '972507536247', t: 'abcdef12' });
});
