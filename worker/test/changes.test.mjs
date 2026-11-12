// node --test worker/test/changes.test.mjs — the change log (changes.js) + /api/ops/changes + /api/ops/revert
// through the real Worker fetch(). Meta/Retell/Telnyx/Cloudflare are stubbed; nothing leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker, { CHANGE_ROUTES } from '../index.js';
import * as C from '../changes.js';
import { AUTOMATIONS } from '../automations-registry.js';
import { parseLog } from '../scripts/build-info.mjs';

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async () => ({ value: null }) };
}
let realFetch; const cf = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://hook.test/status') return new Response(JSON.stringify({ events: { values: [] }, guests: { values: [] } }));
    if (u.startsWith('https://api.cloudflare.com/')) { cf.push({ u, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ success: true, result: { id: 'dep1' } })); }
    return new Response('{}');
  };
});
after(() => { globalThis.fetch = realFetch; });
const env = (init = {}, extra = {}) => ({ ADMIN_KEY: 'k', HOOK_STATUS: 'https://hook.test/status', WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', RATE: kv(init), ...extra });
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (e, path) => worker.fetch(new Request('https://go.ishur.io' + path, { headers: { 'X-Admin-Key': 'k' } }), e, ctx);
const post = (e, path, body) => worker.fetch(new Request('https://go.ishur.io' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: 'k', ...body }) }), e, ctx);
const changes = async (e, qs = '') => (await (await get(e, '/api/ops/changes' + qs)).json());

test('pure: actorOf, commitsSince, revertWord, registry diff ignores line moves', () => {
  assert.equal(C.actorOf('admin'), 'Richard'); assert.equal(C.actorOf('claude-agent'), 'Claude'); assert.equal(C.actorOf('brain'), 'brain'); assert.equal(C.actorOf(''), 'system'); assert.equal(C.actorOf('client'), 'system');
  const cm = [{ hash: 'c3', subject: 'three' }, { hash: 'b2', subject: 'two' }, { hash: 'a1', subject: 'one' }];
  assert.deepEqual(C.commitsSince(cm, 'b2').map(c => c.hash), ['c3']);
  assert.deepEqual(C.commitsSince(cm, 'b2ffffff').map(c => c.hash), ['c3'], 'a longer stored sha still matches');
  assert.equal(C.commitsSince(cm, 'zz').length, 3); assert.equal(C.commitsSince(cm, '').length, 3);
  assert.deepEqual(parseLog('abc\tFix x\ndef\tAdd: y\tz'), [{ hash: 'abc', subject: 'Fix x' }, { hash: 'def', subject: 'Add: y\tz' }]);
  const e = C.makeEntry({ kind: 'deploy', summary_he: 'x', revert: { possible: true, how: 'rollback', payload: { version_id: 'v0' } } });
  assert.equal(e.revert.confirm, 'rollback:v0');
  assert.equal(C.makeEntry({ kind: 'edit', revert: { possible: true, how: 'edit', payload: {} } }).revert.confirm.slice(0, 8), 'revert:c');
  assert.equal(C.makeEntry({ kind: 'brain' }).revert.possible, false);
  const n = { id: 'x', name_he: 'X', source: { file: 'f', line: 10, symbol: 's' }, conditions: ['a'] };
  const moved = { ...n, source: { ...n.source, line: 99 } };
  assert.ok(C.diffRegistry(C.snapshotOf([n]), C.snapshotOf([moved])).empty, 'moving code is not a change');
  const d = C.diffRegistry(C.snapshotOf([n, { id: 'gone', name_he: 'G' }]), C.snapshotOf([{ ...n, conditions: ['b'] }, { id: 'new1', name_he: 'N' }]));
  assert.deepEqual(d.added.map(x => x.id), ['new1']); assert.deepEqual(d.removed.map(x => x.id), ['gone']);
  assert.deepEqual(d.changed, [{ id: 'x', name_he: 'X', fields: ['conditions'] }]);
  assert.ok(C.isNew(new Date(Date.now() - 864e5).toISOString())); assert.ok(!C.isNew(new Date(Date.now() - 8 * 864e5).toISOString())); assert.ok(!C.isNew(null));
});

test('recordChange: KV ring when no D1, newest first, filters kind/actor/from + cursor; never throws', async () => {
  const e = env();
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  for (let i = 0; i < 5; i++) await C.recordChange(e, { kind: i % 2 ? 'toggle' : 'edit', who: i === 4 ? 'claude' : 'admin', summary_he: 's' + i }, t0 + i * 6e4);
  const all = await C.listChanges(e, {});
  assert.equal(all.source, 'kv'); assert.deepEqual(all.items.map(x => x.summary_he), ['s4', 's3', 's2', 's1', 's0']);
  assert.deepEqual((await C.listChanges(e, { kind: 'toggle' })).items.map(x => x.summary_he), ['s3', 's1']);
  assert.deepEqual((await C.listChanges(e, { kind: 'toggle,edit', actor: 'Claude' })).items.map(x => x.summary_he), ['s4']);
  const p1 = await C.listChanges(e, { limit: 2 }); assert.equal(p1.items.length, 2); assert.ok(p1.next_cursor);
  const p2 = await C.listChanges(e, { limit: 2, cursor: p1.next_cursor }); assert.deepEqual(p2.items.map(x => x.summary_he), ['s2', 's1']);
  assert.equal((await C.listChanges(e, { from: new Date(t0 + 3 * 6e4).toISOString() })).items.length, 2);
  assert.equal(await C.recordChange({ RATE: { put: async () => { throw new Error('kv down'); } } }, { kind: 'edit' }).then(x => x.stored), null);
  assert.equal(await C.recordChange(null, { kind: 'edit' }), null);
});

test('recordChange: D1 path writes the changes table (and KV is not touched)', async () => {
  const rows = [];
  const DB = { prepare: sql => ({ bind: (...a) => ({ run: async () => { if (/^INSERT/.test(sql)) rows.push(a); return { meta: { changes: 1 } }; } }) }) };
  const e = env({}, { OPS_DB: DB });
  const x = await C.recordChange(e, { kind: 'toggle', who: 'admin', summary_he: 'd1', details: { a: 1 }, revert: { possible: true, how: 'toggle', payload: { id: 'wave1', enabled: true } } });
  assert.equal(x.stored, 'd1'); assert.equal(rows.length, 1); assert.equal(rows[0][2], 'toggle'); assert.equal(rows[0][3], 'Richard');
  assert.deepEqual(JSON.parse(rows[0][5]), { a: 1 }); assert.equal(JSON.parse(rows[0][6]).how, 'toggle');
  assert.ok(![...e.RATE.m.keys()].some(k => k.startsWith('chg:')));
});

test('toggle → change entry → revert preview needs revert:<id> → revert flips it back and marks the entry', async () => {
  const e = env();
  await post(e, '/api/ops/toggle', { id: 'wave1', enabled: false, confirm: 'wave1', reason: 'בדיקה', who: 'admin' });
  const l = await changes(e);
  assert.equal(l.ok, true); assert.equal(l.items.length, 1);
  const c = l.items[0];
  assert.equal(c.kind, 'toggle'); assert.equal(c.actor, 'Richard'); assert.match(c.summary_he, /כובה/);
  assert.deepEqual(c.revert, { possible: true, how: 'toggle', payload: { id: 'wave1', enabled: true }, confirm: 'revert:' + c.id });
  const pre = await (await post(e, '/api/ops/revert', { id: c.id })).json();
  assert.equal(pre.applied, false); assert.equal(pre.confirm_required, 'revert:' + c.id); assert.ok(e.RATE.m.has('auto:off:wave1'), 'preview changes nothing');
  assert.equal((await post(e, '/api/ops/revert', { id: c.id, confirm: 'wave1' })).status, 200);
  assert.ok(e.RATE.m.has('auto:off:wave1'), 'wrong confirm changes nothing');
  const r = await (await post(e, '/api/ops/revert', { id: c.id, confirm: 'revert:' + c.id })).json();
  assert.equal(r.applied, true); assert.equal(e.RATE.m.has('auto:off:wave1'), false);
  const l2 = await changes(e);
  assert.equal(l2.items.length, 2);
  const orig = l2.items.find(x => x.id === c.id), back = l2.items.find(x => x.id !== c.id);
  assert.ok(orig.reverted_at); assert.equal(orig.reverted_by, back.id); assert.equal(back.details.reverts, c.id); assert.match(back.summary_he, /הופעל/);
  assert.equal((await post(e, '/api/ops/revert', { id: c.id, confirm: 'revert:' + c.id })).status, 409, 'twice → already-reverted');
  assert.equal((await post(e, '/api/ops/revert', { id: 'cnope' })).status, 404);
});

test('edit → change entry with from→to → revert restores the previous value', async () => {
  const e = env();
  const w = await (await post(e, '/api/ops/edit', { id: 'pacer_batch_size', value: 10, confirm: 'pacer_batch_size', who: 'admin' })).json();
  assert.equal(w.applied, true); assert.ok(w.change_id);
  const c = (await changes(e, '?kind=edit')).items[0];
  assert.equal(c.id, w.change_id); assert.equal(c.details.from, 50); assert.equal(c.details.to, 10); assert.match(c.summary_he, /50 → 10/);   /* 12/11: default 25 → 50 (dynamic pace) */
  assert.deepEqual(c.revert.payload, { id: 'pacer_batch_size', field: '', value: 50 });
  const r = await (await post(e, '/api/ops/revert', { id: c.id, confirm: c.revert.confirm })).json();
  assert.equal(r.applied, true);
  assert.equal(JSON.parse(e.RATE.m.get('cfg:pacer_batch_size')).value, 50);
  const back = (await changes(e, '?kind=edit')).items[0];
  assert.equal(back.details.reverts, c.id); assert.equal(back.details.to, 50);
});

test('revert never turns noa_chase on with the generic word — it needs Richard\'s own confirm', async () => {
  const e = env();
  await C.recordChange(e, { kind: 'edit', who: 'admin', summary_he: 'noa off', details: { setting: 'noa_chase', from: 'on', to: 'off' }, revert: { possible: true, how: 'edit', payload: { id: 'noa_chase', field: '', value: 'on' } }, id: 'cnoa1' });
  const pre = await (await post(e, '/api/ops/revert', { id: 'cnoa1' })).json();
  assert.equal(pre.confirm_required, 'noa_chase:on:richard');
  const r = await (await post(e, '/api/ops/revert', { id: 'cnoa1', confirm: 'revert:cnoa1' })).json();
  assert.equal(r.applied, false); assert.equal(e.RATE.m.has('cfg:noa_chase'), false);
  const ok = await (await post(e, '/api/ops/revert', { id: 'cnoa1', confirm: 'noa_chase:on:richard' })).json();
  assert.equal(ok.applied, true); assert.equal(JSON.parse(e.RATE.m.get('cfg:noa_chase')).value, 'on');
});

test('deploy: recordDeploy writes deploy:<version> with the commits since the last deploy, then the registry diff; rollback = command, or the CF API with a token', async () => {
  const e = env();
  const info = { version_tag: '20261103-aaa', commit: 'aaa1111', branch: 'main', date: '2026-11-03T10:00:00Z', commits: [{ hash: 'aaa1111', subject: 'second' }, { hash: '0001111', subject: 'first' }] };
  const r1 = await C.recordDeploy(e, 'ver-0000-one', info, AUTOMATIONS.slice(0, 5));
  assert.equal(r1.deploy.revert.possible, false, 'no previous version known → nothing to roll back to');
  assert.equal(r1.registry.details.baseline, true);
  const info2 = { ...info, version_tag: '20261103-bbb', commit: 'bbb2222', commits: [{ hash: 'bbb2222', subject: 'Add change log' }, { hash: 'aaa1111', subject: 'second' }, { hash: '0001111', subject: 'first' }] };
  const nodes2 = [...AUTOMATIONS.slice(0, 5), { id: 'zz_new', name_he: 'חדשה', layer: 2, from: [], kind: 'internal' }];
  const r2 = await C.recordDeploy(e, 'ver-0000-two', info2, nodes2);
  assert.match(r2.deploy.summary_he, /deploy:ver-0000/); assert.deepEqual(r2.deploy.details.commits.map(c => c.subject), ['Add change log']);
  assert.equal(r2.deploy.details.previous_version_id, 'ver-0000-one');
  assert.equal(r2.deploy.revert.how, 'rollback'); assert.equal(r2.deploy.revert.confirm, 'rollback:ver-0000-one');
  assert.match(r2.deploy.details.rollback_command, /wrangler rollback ver-0000-one --name ishur-webhooks/);
  assert.deepEqual(r2.registry.details.added.map(x => x.id), ['zz_new']);
  const fs = await C.registryFirstSeen(e);
  assert.ok(C.isNew(fs.zz_new), 'a node added at this deploy is "new"'); assert.equal(fs[AUTOMATIONS[0].id], AUTOMATIONS[0].added || null, 'baseline nodes have no first-seen date');
  /* rollback without CF_API_TOKEN → the exact command, nothing applied */
  const pre = await (await post(e, '/api/ops/revert', { id: r2.deploy.id })).json();
  assert.equal(pre.confirm_required, 'rollback:ver-0000-one'); assert.match(pre.preview.command, /wrangler rollback ver-0000-one/); assert.equal(pre.preview.api, false);
  const man = await (await post(e, '/api/ops/revert', { id: r2.deploy.id, confirm: 'rollback:ver-0000-one' })).json();
  assert.equal(man.applied, false); assert.equal(man.manual, true); assert.match(man.command, /wrangler rollback/);
  /* with a token → POST /accounts/{id}/workers/scripts/ishur-webhooks/deployments, version at 100% */
  const e2 = { ...e, CF_API_TOKEN: 'cft', CF_ACCOUNT_ID: 'acc1' };
  const ok = await (await post(e2, '/api/ops/revert', { id: r2.deploy.id, confirm: 'rollback:ver-0000-one' })).json();
  assert.equal(ok.applied, true);
  assert.equal(cf.at(-1).u, 'https://api.cloudflare.com/client/v4/accounts/acc1/workers/scripts/ishur-webhooks/deployments');
  assert.deepEqual(cf.at(-1).body.versions, [{ version_id: 'ver-0000-one', percentage: 100 }]);
  const rev = (await changes(e2, '?kind=revert')).items[0];
  assert.equal(rev.details.reverts, r2.deploy.id); assert.equal(rev.revert.payload.version_id, 'ver-0000-two', 'the rollback itself can be rolled forward');
});

test('recordDeploy on a fresh KV: deploy + registry baseline; /api/ops/registry exposes added_at + is_new', async () => {
  const e = env({}, { CF_VERSION_METADATA: { id: 'v-abcdef12-0000' } });
  await C.recordDeploy(e, e.CF_VERSION_METADATA.id, {}, AUTOMATIONS);
  const l = await changes(e);
  assert.deepEqual(l.items.map(x => x.kind).sort(), ['deploy', 'registry']);
  const reg = await (await get(e, '/api/ops/registry')).json();
  assert.ok(reg.nodes.every(n => 'added_at' in n && 'is_new' in n));
  assert.deepEqual(reg.nodes.filter(n => n.is_new).map(n => n.id).sort(), AUTOMATIONS.filter(n => C.isNew(n.added)).map(n => n.id).sort(), 'only nodes with a recent `added` date are new at baseline');
});

test('manual routes: /api/pause records a pause change (revertible); dry previews record nothing', async () => {
  const e = env();
  const r = await (await post(e, '/api/pause', { paused: true })).json();
  assert.equal(r.paused, true);
  const c = (await changes(e, '?kind=pause')).items[0];
  assert.match(c.summary_he, /עצירה כללית הופעלה/); assert.deepEqual(c.revert.payload, { pause: false });
  const back = await (await post(e, '/api/ops/revert', { id: c.id, confirm: c.revert.confirm })).json();
  assert.equal(back.applied, true); assert.equal(e.RATE.m.has('paused'), false);
  await post(e, '/api/pause', {});   /* read-only (no boolean) */
  assert.equal((await changes(e, '?kind=pause')).items.length, 2, 'only the pause + its revert');
  for (const p of ['/api/gift-blast', '/api/subevent-send', '/api/resend']) assert.equal(CHANGE_ROUTES[p].when({}, {}), false, p + ' default dry → no entry');
  assert.equal(CHANGE_ROUTES['/api/sms-blast'].when({ dry: true }, {}), false);
  assert.equal(CHANGE_ROUTES['/api/gift-blast'].when({ dry: false }, {}), true);
  assert.equal((await get(e, '/api/ops/changes?actor=nobody')).status, 400);
  assert.equal((await get(e, '/api/ops/revert')).status, 405);
});
