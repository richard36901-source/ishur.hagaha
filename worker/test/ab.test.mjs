/* node --test worker/test/ab.test.mjs
   Everything runs against an in-memory KV. Nothing here touches the network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashUnit, assignArm, pickVariant, recordOutcome, evaluate, decide, boundary, zScore, armStats,
  nextChallengerName, startTest, clearMemo, STOP,
} from '../ab.js';

/* ── in-memory KV with list()+metadata, counts reads ──────────────────────── */
function fakeKv() {
  const m = new Map();
  const kv = {
    m, gets: 0,
    async get(k) { kv.gets++; return m.has(k) ? m.get(k).v : null; },
    async put(k, v, o = {}) { m.set(k, { v, meta: o.metadata || null }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', cursor, limit = 1000 }) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = all.slice(start, start + limit).map(name => ({ name, metadata: m.get(name).meta }));
      const end = start + keys.length;
      return { keys, list_complete: end >= all.length, cursor: end >= all.length ? undefined : String(end) };
    },
  };
  return kv;
}
const phone = i => '9725' + String(10000000 + i).slice(-8);
const TOK = 'ec9f3b84-0000-4000-8000-000000000001';
const running = (o = {}) => ({ id: 'invite-20261101-abcde', msg_type: 'invite', control: 'hazmana_ishur_v2', challenger: 'hazmana_ishur_v2_ab1', category: 'MARKETING', split: 0.5, status: 'running', quality_ok: true, ...o });
async function envWith(tests, extra = {}) {
  const kv = fakeKv();
  await kv.put('ab:tests', JSON.stringify(tests));
  kv.gets = 0;
  return { RATE: kv, AB_ENABLED: 'on', ...extra };
}

/* ── assignment ───────────────────────────────────────────────────────────── */
test('hashUnit: deterministic, in [0,1), ~uniform', () => {
  assert.equal(hashUnit('a|b|c'), hashUnit('a|b|c'));
  assert.notEqual(hashUnit('a|b|c'), hashUnit('a|b|d'));
  let lo = 0;
  for (let i = 0; i < 20000; i++) { const u = hashUnit(`t|${TOK}|${phone(i)}`); assert.ok(u >= 0 && u < 1); if (u < 0.5) lo++; }
  assert.ok(Math.abs(lo / 20000 - 0.5) < 0.015, 'share ' + lo / 20000);
});

test('assignArm: sticky per guest+event, independent across events, split respected', () => {
  const t = running();
  for (let i = 0; i < 50; i++) assert.equal(assignArm(t, phone(i), TOK), assignArm(t, '0' + phone(i).slice(3), TOK), 'phone format does not matter');
  let differ = 0;
  for (let i = 0; i < 2000; i++) if (assignArm(t, phone(i), TOK) !== assignArm(t, phone(i), 'other-token')) differ++;
  assert.ok(differ > 800 && differ < 1200, 'events re-randomise: ' + differ);
  assert.equal(assignArm({ ...t, split: 0 }, phone(1), TOK), 'control');
  assert.equal(assignArm({ ...t, split: 1 }, phone(1), TOK), 'challenger');
  let ch = 0;
  for (let i = 0; i < 10000; i++) if (assignArm({ ...t, split: 0.2 }, phone(i), TOK) === 'challenger') ch++;
  assert.ok(Math.abs(ch / 10000 - 0.2) < 0.015, 'split 0.2 → ' + ch / 10000);
});

/* ── pickVariant ──────────────────────────────────────────────────────────── */
test('pickVariant: off by default → the caller\'s own template, no KV read', async () => {
  const env = await envWith({ invite: running() }, { AB_ENABLED: '' });
  const v = await pickVariant(env, 'invite', phone(1), TOK, { current: 'hazmana_ishur_v2' });
  assert.deepEqual(v, { template: 'hazmana_ishur_v2', arm: 'control', test_id: null, reason: 'ab-off' });
  assert.equal(env.RATE.gets, 0);
});

test('pickVariant: no test / pending / not eligible / no unit', async () => {
  let env = await envWith({});
  assert.equal((await pickVariant(env, 'invite', phone(1), TOK, { current: 'x' })).reason, 'no-test');
  env = await envWith({ invite: running({ status: 'pending' }) });
  assert.equal((await pickVariant(env, 'invite', phone(1), TOK, { current: 'hazmana_ishur_v2' })).reason, 'not-running:pending');
  env = await envWith({ invite: running() });
  const img = await pickVariant(env, 'invite', phone(1), TOK, { current: 'hazmana_ishur_img_u' });
  assert.equal(img.template, 'hazmana_ishur_img_u', 'artwork invitations are not in the text test');
  assert.equal(img.reason, 'not-eligible'); assert.equal(img.test_id, null);
  assert.equal((await pickVariant(env, 'invite', '', TOK, { current: 'hazmana_ishur_v2' })).reason, 'no-unit');
});

test('pickVariant: MARKETING challenger while a number is not GREEN → control, not recorded', async () => {
  const env = await envWith({ invite: running({ quality_ok: false }) });
  for (let i = 0; i < 30; i++) {
    const v = await pickVariant(env, 'invite', phone(i), TOK, { current: 'hazmana_ishur_v2' });
    assert.equal(v.template, 'hazmana_ishur_v2'); assert.equal(v.test_id, null); assert.equal(v.reason, 'quality-not-green');
  }
  const u = await envWith({ invite: running({ quality_ok: false, category: 'UTILITY' }) });
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add((await pickVariant(u, 'invite', phone(i), TOK, { current: 'hazmana_ishur_v2' })).arm);
  assert.deepEqual([...seen].sort(), ['challenger', 'control'], 'UTILITY is not held by the GREEN rule');
});

test('pickVariant: running → both arms, sticky, ONE KV read per invocation', async () => {
  const env = await envWith({ invite: running() });
  const first = [];
  for (let i = 0; i < 200; i++) first.push(await pickVariant(env, 'invite', phone(i), TOK, { current: 'hazmana_ishur_v2' }));
  assert.equal(env.RATE.gets, 1, 'memoised');
  const ch = first.filter(v => v.arm === 'challenger');
  assert.ok(ch.length > 70 && ch.length < 130, 'challenger share ' + ch.length);
  assert.ok(ch.every(v => v.template === 'hazmana_ishur_v2_ab1' && v.test_id === 'invite-20261101-abcde'));
  clearMemo(env);
  for (let i = 0; i < 200; i++) assert.equal((await pickVariant(env, 'invite', phone(i), TOK, { current: 'hazmana_ishur_v2' })).arm, first[i].arm, 'sticky across invocations');
});

/* ── recordOutcome ────────────────────────────────────────────────────────── */
test('recordOutcome: writes the assignment with metadata; refuses incomplete input', async () => {
  const env = await envWith({});
  assert.equal(await recordOutcome(env, { test_id: 't1', arm: 'challenger', wamid: 'wamid.A', phone: '0501234567', token: TOK, ts: 5, msg_type: 'invite' }), true);
  const e = env.RATE.m.get('ab:o:t1:challenger:wamid.A');
  assert.deepEqual(e.meta, { p: '972501234567', t: 'ec9f3b84', ts: 5, m: 'invite' });
  assert.equal(await recordOutcome(env, { test_id: null, arm: 'control', wamid: 'w' }), false);
  assert.equal(await recordOutcome(env, { test_id: 't1', arm: 'x', wamid: 'w' }), false);
  assert.equal(await recordOutcome(env, { test_id: 't1', arm: 'control', wamid: '' }), false);
});

/* ── the stopping rule ────────────────────────────────────────────────────── */
const arm = (n, k, o = {}) => ({ sent: n, delivered: n, n, k, optouts: 0, coming: 0, cost: 0, rate: n ? k / n : 0, optout_rate: 0, ...o });

test('boundary: C·sqrt(N_MAX/n)', () => {
  assert.ok(Math.abs(boundary(200) - 2.24 * Math.sqrt(5)) < 1e-9);
  assert.ok(Math.abs(boundary(1000) - 2.24) < 1e-9);
  assert.ok(Math.abs(boundary(5000) - 2.24) < 1e-9, 'capped at N_MAX');
});

test('decide: continue below 200/arm even with a huge gap', () => {
  const d = decide({ control: arm(150, 15), challenger: arm(150, 90) });
  assert.equal(d.action, 'continue');
});

test('decide: winner only past the boundary', () => {
  /* n=400: boundary = 2.24·sqrt(2.5) = 3.54; 30% vs 45% gives z ≈ 4.4 */
  const d = decide({ control: arm(400, 120), challenger: arm(400, 180) });
  assert.equal(d.action, 'winner'); assert.equal(d.winner, 'challenger');
  assert.ok(d.z > d.bound);
  /* 30% vs 36% at n=400: z ≈ 1.8 < 3.54 → keep going */
  assert.equal(decide({ control: arm(400, 120), challenger: arm(400, 144) }).action, 'continue');
  /* control better → control wins */
  assert.equal(decide({ control: arm(400, 180), challenger: arm(400, 120) }).winner, 'control');
});

test('decide: N_MAX without a crossing → no difference, control stays', () => {
  const d = decide({ control: arm(1000, 300), challenger: arm(1000, 320) });
  assert.equal(d.action, 'no_difference'); assert.equal(d.winner, 'control');
});

test('decide: opt-out guardrail (> 0.5pt, n ≥ 100, ≥ 3 events) beats everything', () => {
  const c = arm(150, 45, { optouts: 0, optout_rate: 0 });
  const x = arm(150, 90, { optouts: 3, optout_rate: 3 / 150 });
  assert.equal(decide({ control: c, challenger: x }).action, 'stop_optout');
  /* 2 events only → not yet */
  assert.equal(decide({ control: c, challenger: arm(150, 90, { optouts: 2, optout_rate: 2 / 150 }) }).action, 'continue');
  /* exactly +0.5pt is not "exceeds" */
  assert.equal(decide({ control: arm(1000, 300, { optouts: 5, optout_rate: 0.005 }), challenger: arm(1000, 300, { optouts: 10, optout_rate: 0.010 }) }).action, 'no_difference');
});

test('stopping rule is sequential-safe: A/A false-positive rate ≤ 5% with daily looks', () => {
  /* seeded LCG so the test is deterministic */
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const SIMS = 2000, PER_DAY = 30, p = 0.3;
  let fp = 0;
  for (let s = 0; s < SIMS; s++) {
    const c = arm(0, 0), x = arm(0, 0);
    while (true) {
      for (let i = 0; i < PER_DAY; i++) { c.n++; c.delivered++; if (rnd() < p) c.k++; x.n++; x.delivered++; if (rnd() < p) x.k++; }
      c.rate = c.k / c.n; x.rate = x.k / x.n;
      const d = decide({ control: c, challenger: x });
      if (d.action === 'winner') { fp++; break; }
      if (d.action !== 'continue') break;
    }
  }
  const rate = fp / SIMS;
  console.log(`A/A false positives: ${fp}/${SIMS} = ${(rate * 100).toFixed(2)}%`);
  assert.ok(rate <= 0.05, 'false-positive rate ' + rate);
});

test('stopping rule has power: 30% vs 38% is found before N_MAX in most runs', () => {
  let seed = 999;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const SIMS = 500; let found = 0, nSum = 0;
  for (let s = 0; s < SIMS; s++) {
    const c = arm(0, 0), x = arm(0, 0);
    while (true) {
      for (let i = 0; i < 30; i++) { c.n++; c.delivered++; if (rnd() < 0.30) c.k++; x.n++; x.delivered++; if (rnd() < 0.38) x.k++; }
      c.rate = c.k / c.n; x.rate = x.k / x.n;
      const d = decide({ control: c, challenger: x });
      if (d.action === 'winner') { if (d.winner === 'challenger') { found++; nSum += d.n; } break; }
      if (d.action !== 'continue') break;
    }
  }
  console.log(`power 30%→38%: ${found}/${SIMS} = ${(found / SIMS * 100).toFixed(1)}%, mean n/arm at stop ${Math.round(nSum / Math.max(1, found))}`);
  assert.ok(found / SIMS >= 0.8, 'power ' + found / SIMS);
});

test('zScore: sign and value', () => {
  const z = zScore(arm(100, 30), arm(100, 50));
  assert.ok(z > 2.8 && z < 3.0, 'z ' + z);   // pooled p=.4, se=.0693, diff=.2 → 2.89
  assert.equal(zScore(arm(0, 0), arm(10, 1)), 0);
});

/* ── evaluate, end to end on a fixture built here ──────────────────────────── */
const T0 = Date.UTC(2026, 9, 1, 8);           // sends start 01/10
const H = 3600e3;
/* n guests per arm; control replies on i % 10 < cRate10, challenger on < xRate10 */
function buildFixture(kv, testId, n, cRate10, xRate10, { optoutX = 0 } = {}) {
  const rows = [];
  let w = 0;
  const one = async (armName, i, replies, optout) => {
    const p = phone(i + (armName === 'challenger' ? 50000 : 0));
    const wamid = 'wamid.' + (++w);
    const ts = T0 + i * 60e3;
    rows.push({ k: 'o', ts, p, ch: 'g', t: armName === 'challenger' ? 'hazmana_ishur_v2_ab1' : 'hazmana_ishur_v2', w: wamid, ok: true, pid: '1', tok: 'ec9f3b84', e: '' });
    rows.push({ k: 's', ts: ts + 60e3, w: wamid, st: 'delivered', c: '', cost: 0.12, wv: '1', cat: 'marketing' });
    if (optout) rows.push({ k: 'i', ts: ts + H, p, ch: 'g', x: 'טעות' });
    else if (replies) rows.push({ k: 'i', ts: ts + H, p, ch: 'g', x: 'מגיע' });
    await kv.put(`ab:o:${testId}:${armName}:${wamid}`, '', { metadata: { p, t: 'ec9f3b84', ts, m: 'invite' } });
  };
  return (async () => {
    for (let i = 0; i < n; i++) {
      await one('control', i, i % 10 < cRate10, false);
      await one('challenger', i, i % 10 < xRate10, i < optoutX);
    }
    return rows;
  })();
}
const NOW = Date.UTC(2026, 10, 1, 4);         // 06:00 IL on 01/11 (winter, UTC+2)

test('evaluate: off → does nothing', async () => {
  const env = await envWith({ invite: running() }, { AB_ENABLED: '' });
  const r = await evaluate(env, { now: () => NOW });
  assert.deepEqual(r, { ok: true, skipped: 'ab-off' });
});

test('evaluate: pending → running only once Meta APPROVED it; quality refreshed', async () => {
  const env = await envWith({ invite: running({ status: 'pending', quality_ok: false }) });
  let r = await evaluate(env, { now: () => NOW, isApproved: async () => false, numberQuality: async () => [{ id: '1', quality: 'GREEN' }] });
  assert.equal(r.report[0].action, 'waiting-approval');
  assert.equal(JSON.parse(env.RATE.m.get('ab:tests').v).invite.status, 'pending');
  /* once a day */
  r = await evaluate(env, { now: () => NOW, isApproved: async () => true });
  assert.equal(r.skipped, 'already-ran');
  r = await evaluate(env, { now: () => NOW + 86400e3, isApproved: async () => true, numberQuality: async () => [{ id: '1', quality: 'GREEN' }, { id: '2', quality: 'UNKNOWN' }] });
  assert.equal(r.report[0].action, 'started');
  const t = JSON.parse(env.RATE.m.get('ab:tests').v).invite;
  assert.equal(t.status, 'running');
  assert.equal(t.quality_ok, false, 'UNKNOWN is not GREEN');
});

test('evaluate: clear winner → done, rotated, next challenger drafted, promote gated', async () => {
  const env = await envWith({ invite: running({ started_at: new Date(T0).toISOString() }) });
  const rows = await buildFixture(env.RATE, 'invite-20261101-abcde', 400, 3, 5);   // 30% vs 50%
  const notes = []; const promoted = [];
  const r = await evaluate(env, { now: () => NOW, queryRows: async () => rows, isApproved: async () => true,
    numberQuality: async () => [{ id: '1', quality: 'GREEN' }], notify: async (t) => notes.push(t), promote: async (m, n) => promoted.push([m, n]) });
  const rep = r.report[0];
  assert.equal(rep.action, 'winner');
  assert.equal(rep.stats.control.n, 400); assert.equal(rep.stats.challenger.n, 400);
  assert.equal(rep.stats.control.k, 120); assert.equal(rep.stats.challenger.k, 200);
  const tests = JSON.parse(env.RATE.m.get('ab:tests').v);
  assert.equal(tests.invite.status, 'needs_draft', 'one test per type: the next one replaces it');
  assert.equal(tests.invite.control, 'hazmana_ishur_v2_ab1', 'winner becomes control');
  assert.equal(tests.invite.challenger, 'hazmana_ishur_v2_ab2');
  assert.ok(tests.invite.brief.some(s => /פחות תשובות/.test(s)), 'loser weaknesses passed to the drafter');
  assert.equal(env.RATE.m.get('ab:control:invite').v, 'hazmana_ishur_v2_ab1');
  const hist = JSON.parse(env.RATE.m.get('ab:history').v);
  assert.equal(hist[0].winner, 'hazmana_ishur_v2_ab1'); assert.equal(hist[0].status, 'done');
  assert.deepEqual(promoted, [], 'no production flip without AB_AUTOROTATE=on');
  assert.ok(notes.some(n => /ממתינה לאישור ריצארד/.test(n)));
});

test('evaluate: AB_AUTOROTATE=on calls promote()', async () => {
  const env = await envWith({ invite: running({ started_at: new Date(T0).toISOString() }) }, { AB_AUTOROTATE: 'on' });
  const rows = await buildFixture(env.RATE, 'invite-20261101-abcde', 400, 3, 5);
  const promoted = [];
  await evaluate(env, { now: () => NOW, queryRows: async () => rows, isApproved: async () => true, numberQuality: async () => [{ id: '1', quality: 'GREEN' }], promote: async (m, n) => promoted.push([m, n]) });
  assert.deepEqual(promoted, [['invite', 'hazmana_ishur_v2_ab1']]);
});

test('evaluate: opt-out guardrail stops the challenger, control stays', async () => {
  const env = await envWith({ invite: running({ started_at: new Date(T0).toISOString() }) });
  const rows = await buildFixture(env.RATE, 'invite-20261101-abcde', 150, 3, 5, { optoutX: 4 });
  const r = await evaluate(env, { now: () => NOW, queryRows: async () => rows, isApproved: async () => true, numberQuality: async () => [{ id: '1', quality: 'GREEN' }] });
  assert.equal(r.report[0].action, 'stop_optout');
  const hist = JSON.parse(env.RATE.m.get('ab:history').v);
  assert.equal(hist[0].status, 'stopped'); assert.equal(hist[0].winner, 'hazmana_ishur_v2');
  assert.equal(env.RATE.m.get('ab:control:invite'), undefined, 'no rotation on a guardrail stop');
});

test('evaluate: challenger no longer APPROVED → stopped', async () => {
  const env = await envWith({ invite: running() });
  const r = await evaluate(env, { now: () => NOW, queryRows: async () => [], isApproved: async () => false });
  assert.equal(r.report[0].reason, 'challenger-not-approved');
});

test('evaluate: too little data → continue, a look is recorded', async () => {
  const env = await envWith({ invite: running({ started_at: new Date(T0).toISOString() }) });
  const rows = await buildFixture(env.RATE, 'invite-20261101-abcde', 50, 3, 5);
  const r = await evaluate(env, { now: () => NOW, queryRows: async () => rows, isApproved: async () => true, numberQuality: async () => [{ id: '1', quality: 'GREEN' }] });
  assert.equal(r.report[0].action, 'continue');
  const t = JSON.parse(env.RATE.m.get('ab:tests').v).invite;
  assert.equal(t.status, 'running'); assert.equal(t.looks.length, 1); assert.equal(t.looks[0].n, 50);
});

test('evaluate: a partial audit read → no decision, even with a clear winner in the rows', async () => {
  const env = await envWith({ invite: running({ started_at: new Date(T0).toISOString() }) });
  const rows = await buildFixture(env.RATE, 'invite-20261101-abcde', 400, 3, 5);
  const r = await evaluate(env, { now: () => NOW, queryRows: async () => ({ rows, missing: ['20261015'] }), isApproved: async () => true, numberQuality: async () => [{ id: '1', quality: 'GREEN' }] });
  assert.equal(r.report[0].action, 'incomplete-data');
  assert.equal(JSON.parse(env.RATE.m.get('ab:tests').v).invite.status, 'running');
});

test('armStats ignores sends that were not assigned', () => {
  const rows = [{ k: 'o', ts: 0, p: '1', ch: 'g', t: 'x', w: 'a', ok: true }, { k: 'o', ts: 0, p: '2', ch: 'g', t: 'x', w: 'b', ok: true }];
  const s = armStats([{ wamid: 'a', arm: 'control' }], rows, 1e12);
  assert.equal(s.control.sent, 1); assert.equal(s.challenger.sent, 0);
});

/* ── guardrail: one challenger per message type ───────────────────────────── */
test('startTest: refuses a second challenger for the same type; names must be _ab<n>', async () => {
  const env = await envWith({});
  assert.equal((await startTest(env, { msg_type: 'invite', control: 'hazmana_ishur_v2', challenger: 'hazmana_ishur_v3' })).why, 'challenger-name-must-end-_ab<n>');
  const a = await startTest(env, { msg_type: 'invite', control: 'hazmana_ishur_v2', challenger: 'hazmana_ishur_v2_ab1', category: 'marketing' }, { now: () => NOW });
  assert.equal(a.ok, true); assert.equal(a.test.status, 'pending'); assert.equal(a.test.category, 'MARKETING');
  const b = await startTest(env, { msg_type: 'invite', control: 'hazmana_ishur_v2', challenger: 'hazmana_ishur_v2_ab2' }, { now: () => NOW });
  assert.equal(b.ok, false); assert.equal(b.why, 'one-challenger-per-type');
  const c = await startTest(env, { msg_type: 'reminder', control: 'hazmana_ishur_v2', challenger: 'hazmana_ishur_v2_ab2' }, { now: () => NOW });
  assert.equal(c.ok, true, 'another type is independent');
});

test('nextChallengerName: never reuses a number', () => {
  assert.equal(nextChallengerName('hazmana_ishur_v2', []), 'hazmana_ishur_v2_ab1');
  assert.equal(nextChallengerName('hazmana_ishur_v2_ab1', [{ control: 'hazmana_ishur_v2', challenger: 'hazmana_ishur_v2_ab1' }]), 'hazmana_ishur_v2_ab2');
  assert.equal(nextChallengerName('hazmana_ishur_v2', [{ challenger: 'hazmana_ishur_v2_ab4' }, { challenger: 'ishur_yom_lifnei_ab9' }]), 'hazmana_ishur_v2_ab5');
});

test('STOP constants match the spec', () => {
  assert.deepEqual([STOP.MIN_PER_ARM, STOP.N_MAX, STOP.C, STOP.OPTOUT_DELTA], [200, 1000, 2.24, 0.005]);
});
