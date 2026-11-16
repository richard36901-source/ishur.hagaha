import test from 'node:test'; import assert from 'node:assert/strict';
import { closeShift, hoursOf, monthSummary, normEmail, handleCallers, MAX_SHIFT_MS, ilMonth } from '../callers.js';
const A = '972500000001', B = '972500000002';
function kv(init = {}) { const m = new Map(Object.entries(init)), meta = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v, o) => { m.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); }, delete: async k => { m.delete(k); meta.delete(k); },
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name, metadata: meta.get(name) })), list_complete: true }) }; }
const dOf = store => ({ deny: (s, e) => new Response(JSON.stringify({ ok: false, error: e }), { status: s }), okJson: o => new Response(JSON.stringify(o)), isAdmin: (env, k) => k === 'k', normPhone: v => String(v || '').replace(/\D/g, '').replace(/^0/, '972'),
  kvPrefix: async (env, p) => Object.fromEntries([...store.m].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v])) });
const post = (store, body, user) => handleCallers(new Request('https://x/api/callers', { method: 'POST', headers: user ? { 'x-ishur-user': user } : {}, body: JSON.stringify({ admin_key: 'k', ...body }) }), { RATE: store }, '', dOf(store)).then(r => r.json());

test('a shift is never negative and is cut at 12 hours; hours round to two places', () => {
  assert.deepEqual(closeShift(1000, 1000 + 90 * 60e3), { in: 1000, out: 1000 + 90 * 60e3, ms: 90 * 60e3, capped: false });
  assert.equal(closeShift(1000, 500).ms, 0); const long = closeShift(0, 30 * 3600e3); assert.deepEqual([long.ms, long.capped], [MAX_SHIFT_MS, true]);
  assert.equal(hoursOf(90 * 60e3), 1.5); assert.equal(normEmail(' Dana@X.co '), 'dana@x.co'); assert.equal(normEmail('nope'), '');
});
test('month summary: closed shifts plus the running one; a forgotten open shift is flagged and counted to the cap only', () => {
  const now = 100 * 3600e3;
  const s = monthSummary([{ phone: A, name: 'דנה' }, { phone: B, name: 'מיכל' }], [{ phone: A, ms: 2 * 3600e3 }, { phone: A, ms: 3600e3 }], { [A]: { in: now - 1800e3 }, [B]: { in: now - 20 * 3600e3 } }, now);
  assert.deepEqual([s[0].shifts, s[0].hours, s[0].on_shift, s[0].stale], [3, 3.5, true, false]); assert.deepEqual([s[1].hours, s[1].stale], [12, true]);
});
test('route: add, clock in and out (by the agent through her Google account, or by an admin for her), ownership of a conversation', async () => {
  const store = kv();
  assert.equal((await handleCallers(new Request('https://x', { method: 'POST', body: JSON.stringify({ admin_key: 'no' }) }), { RATE: store }, '', dOf(store))).status, 403);
  assert.equal((await post(store, { add: { name: 'ד', phone: '0500000001' } })).error, 'bad-input');
  let r = await post(store, { add: { name: 'דנה', phone: '0500000001', email: 'Dana@X.co' } }); assert.deepEqual([r.callers.length, r.callers[0].email, r.callers[0].on_shift], [1, 'dana@x.co', false]);
  await post(store, { add: { name: 'מיכל', phone: '0500000002' } });
  assert.equal((await post(store, { clock: { on: true } })).error, 'not-a-caller', 'an admin with no caller record must name the agent');
  r = await post(store, { clock: { on: true } }, 'dana@x.co'); assert.equal(r.me.phone, A); assert.equal(r.callers.find(c => c.phone === A).on_shift, true);
  const first = JSON.parse(store.m.get('callshift:' + A)).in; r = await post(store, { clock: { on: true } }, 'dana@x.co'); assert.equal(JSON.parse(store.m.get('callshift:' + A)).in, first, 'a second clock-in does not restart the shift');
  store.m.set('callshift:' + A, JSON.stringify({ in: Date.now() - 2 * 3600e3 }));
  r = await post(store, { clock: { on: false } }, 'dana@x.co'); const d = r.callers.find(c => c.phone === A); assert.deepEqual([d.on_shift, d.shifts, d.hours], [false, 1, 2]); assert.equal(r.shifts.length, 1);
  r = await post(store, { clock: { phone: B, on: true } }); assert.equal(r.callers.find(c => c.phone === B).on_shift, true);
  r = await post(store, { own: { phone: '972541111111', owner: 'me' } }, 'dana@x.co'); assert.deepEqual(r.owners['972541111111'], { owner: A, name: 'דנה' }); assert.equal(r.callers.find(c => c.phone === A).conversations, 1);
  r = await post(store, { own: { phone: '972541111111', owner: B } }); assert.equal(r.owners['972541111111'].name, 'מיכל');
  r = await post(store, { own: { phone: '972541111111', owner: '0509999999' } }); assert.equal(r.owners['972541111111'].name, 'מיכל', 'someone who is not an agent cannot own');
  r = await post(store, { own: { phone: '972541111111', owner: '' } }); assert.equal(r.owners['972541111111'], undefined);
  r = await post(store, { remove: { phone: B } }); assert.equal(r.callers.length, 1); assert.equal(ilMonth().length, 7);
});
