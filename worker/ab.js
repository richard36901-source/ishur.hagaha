/* ============================================================================
   ishur.io · ab.js · A/B tests on guest message copy ("ניסוי נוסחים")
   ----------------------------------------------------------------------------
   Spec: docs/SPEC-ab-testing.md. NOT LIVE: nothing here runs unless the
   worker var AB_ENABLED = "on", and nothing here sends a message — it only
   chooses WHICH approved template name the existing send code uses.

     pickVariant(env, msgType, guestPhone, eventToken, opts)
         → { template, arm, test_id, reason }      (one KV read, memoised)
     recordOutcome(env, { test_id, arm, wamid, phone, token, msg_type })
         → one KV write per send in a running test (the assignment). Delivery,
           replies and opt-outs are NOT written on the hot path: evaluate()
           joins them from the audit log by wamid (template-stats.js).
     evaluate(env, deps)  daily 06:00 IL. Activates approved challengers,
           applies guardrails, applies the stopping rule, rotates the winner.

   KV (binding env.RATE, or deps.kv):
     ab:tests                 { <msgType>: test }   — at most ONE test per type
     ab:o:<test_id>:<arm>:<wamid>   ''  metadata {p: phone, t: token8, ts}
     ab:history               [ finished tests ] (last 50)
     ab:eval:<YYYYMMDD>       once-a-day guard for evaluate()
     ab:control:<msgType>     the current control template name after a rotation

   test = { id, msg_type, control, challenger, category ('MARKETING'|'UTILITY'),
            split (0..1 share of challenger), status, created_at, started_at,
            ended_at, winner, reason, quality_ok, looks: [...] }
   status: needs_draft → pending (submitted, waiting for Meta) → running →
           done | stopped
   ========================================================================== */

import { attributeSends, wilson } from './template-stats.js';

/* ── the stopping rule (spec §5) ───────────────────────────────────────────── */
export const STOP = {
  MIN_PER_ARM: 200,      // no decision before both arms have 200 mature delivered sends
  N_MAX: 1000,           // per arm; reaching it without a crossing = "no difference"
  C: 2.24,               // boundary |z| ≥ C·sqrt(N_MAX / n): valid under ANY number of looks
  OPTOUT_DELTA: 0.005,   // challenger opt-out − control opt-out > 0.5pt → stop challenger
  OPTOUT_MIN_N: 100,     // …once both arms have 100 delivered
  OPTOUT_MIN_EVENTS: 3,  // …and the challenger has at least 3 opt-out/טעות events
};

export const MSG_TYPES_AB = ['invite', 'reminder', 'daybefore', 'thanks'];

/* ── deterministic, sticky assignment ──────────────────────────────────────
   FNV-1a 32-bit over "<test_id>|<event token>|<phone>". Same guest + same event
   + same test → same arm, every tick, every Worker, no KV needed. A new test id
   re-randomises, so consecutive tests are independent. */
export function hashUnit(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  /* final avalanche (murmur3 fmix32) so near-identical phones spread evenly */
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function normPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.startsWith('0') ? '972' + d.slice(1) : d; }
export function assignArm(test, guestPhone, eventToken) {
  const u = hashUnit(`${test.id}|${String(eventToken || '').trim()}|${normPhone(guestPhone)}`);
  const split = test.split == null ? 0.5 : Math.max(0, Math.min(1, Number(test.split)));
  return u < split ? 'challenger' : 'control';
}

/* ── KV access, always through env.RATE or an injected kv ─────────────────── */
function kvOf(env, deps) {
  const kv = (deps && deps.kv) || (env && env.RATE);
  if (!kv) return null;
  return kv;
}
/* one read of ab:tests per Worker invocation (the env object lives for one) */
const memo = new WeakMap();
export async function loadTests(env, deps) {
  const kv = kvOf(env, deps);
  if (!kv) return {};
  if (env && typeof env === 'object' && memo.has(env)) return memo.get(env);
  let t = {};
  try { t = JSON.parse((await kv.get('ab:tests')) || '{}') || {}; } catch { t = {}; }
  if (env && typeof env === 'object') memo.set(env, t);
  return t;
}
export function clearMemo(env) { memo.delete(env); }
async function saveTests(env, deps, tests) {
  const kv = kvOf(env, deps);
  await kv.put('ab:tests', JSON.stringify(tests));
  if (env && typeof env === 'object') memo.set(env, tests);
}

/* ── pickVariant ────────────────────────────────────────────────────────────
   opts.current: the template the send code chose on its own (inviteTmpl, the
   image/video variant, a client's custom template…). The test applies ONLY
   when that equals the test's control; anything else goes out untouched. */
export async function pickVariant(env, msgType, guestPhone, eventToken, opts = {}) {
  const current = opts.current || '';
  const same = (template, reason) => ({ template: current || template || '', arm: 'control', test_id: null, reason });
  if (!env || String(env.AB_ENABLED || '') !== 'on') return same('', 'ab-off');
  let tests;
  try { tests = await loadTests(env, opts.deps); } catch { return same('', 'kv-error'); }
  const t = tests && tests[msgType];
  if (!t) return same('', 'no-test');
  if (t.status !== 'running') return same(t.control, 'not-running:' + t.status);
  if (current && current !== t.control) return same(t.control, 'not-eligible');
  if (!eventToken || !guestPhone) return same(t.control, 'no-unit');
  /* guardrail: a MARKETING challenger only while every guests number is GREEN
     (refreshed by evaluate(); the sender picks the number later, so all must be) */
  /* test_id stays null: these sends are NOT recorded, or the control arm would
     collect the whole non-green period and the arms would differ by time */
  if (String(t.category || '').toUpperCase() === 'MARKETING' && !t.quality_ok) return same(t.control, 'quality-not-green');
  const arm = assignArm(t, guestPhone, eventToken);
  return { template: arm === 'challenger' ? t.challenger : t.control, arm, test_id: t.id, reason: 'assigned' };
}

/* ── recordOutcome: the assignment, keyed by Meta's message id ─────────────
   Called right after a successful send that pickVariant assigned. KV list()
   returns the metadata, so evaluate() needs no per-key get(). */
export async function recordOutcome(env, o = {}, deps) {
  if (!o || !o.test_id || !o.wamid || !(o.arm === 'control' || o.arm === 'challenger')) return false;
  const kv = kvOf(env, deps);
  if (!kv) return false;
  const key = `ab:o:${o.test_id}:${o.arm}:${o.wamid}`;
  try {
    await kv.put(key, '', { expirationTtl: 120 * 86400, metadata: { p: normPhone(o.phone), t: String(o.token || '').slice(0, 8), ts: Number(o.ts) || Date.now(), m: String(o.msg_type || '') } });
    return true;
  } catch { return false; }
}

async function listAll(kv, prefix) {
  const out = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys || []) out.push(k);
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

/* ── per-arm numbers from the audit rows (pure) ────────────────────────────
   assignments: [{ wamid, arm }]. rows: template-stats compact rows. */
export function armStats(assignments, rows, now) {
  const armOf = new Map(assignments.map(a => [a.wamid, a.arm]));
  const sends = attributeSends(rows, { now });
  const s = { control: blankArm(), challenger: blankArm() };
  for (const x of sends) {
    const arm = armOf.get(x.o.w);
    if (!arm) continue;
    const a = s[arm];
    a.sent++;
    if (x.delivered) a.delivered++;
    if (x.delivered && x.mature72) { a.n++; if (x.replied72) a.k++; }
    if (x.delivered && (x.optout || x.mistake)) a.optouts++;
    if (x.rsvp === 'מגיע') a.coming++;
    a.cost += x.cost;
  }
  for (const a of Object.values(s)) {
    const w = wilson(a.k, a.n);
    a.rate = w.p; a.lo = w.lo; a.hi = w.hi;
    a.optout_rate = a.delivered ? a.optouts / a.delivered : 0;
    a.cost = Math.round(a.cost * 100) / 100;
  }
  return s;
}
function blankArm() { return { sent: 0, delivered: 0, n: 0, k: 0, optouts: 0, coming: 0, cost: 0 }; }

/* two-proportion z (pooled), challenger − control */
export function zScore(c, x) {
  if (!c.n || !x.n) return 0;
  const p = (c.k + x.k) / (c.n + x.n);
  const se = Math.sqrt(p * (1 - p) * (1 / c.n + 1 / x.n));
  if (!se) return 0;
  return (x.k / x.n - c.k / c.n) / se;
}
export function boundary(n) {
  const m = Math.max(1, Math.min(STOP.N_MAX, n));
  return STOP.C * Math.sqrt(STOP.N_MAX / m);
}

/* ── the decision (pure) ────────────────────────────────────────────────────
   → { action: 'continue'|'stop_optout'|'winner'|'no_difference', winner, z, bound, n } */
export function decide(stats) {
  const c = stats.control, x = stats.challenger;
  /* guardrail first, at every look */
  if (c.delivered >= STOP.OPTOUT_MIN_N && x.delivered >= STOP.OPTOUT_MIN_N && x.optouts >= STOP.OPTOUT_MIN_EVENTS &&
      x.optout_rate - c.optout_rate > STOP.OPTOUT_DELTA) {
    return { action: 'stop_optout', winner: 'control', z: zScore(c, x), bound: null, n: Math.min(c.n, x.n),
      reason: `הסרות/טעות במתחרה ${(x.optout_rate * 100).toFixed(1)}% מול ${(c.optout_rate * 100).toFixed(1)}% בבקרה` };
  }
  const n = Math.min(c.n, x.n);
  const z = zScore(c, x);
  const bound = boundary(n);
  if (n < STOP.MIN_PER_ARM) return { action: 'continue', winner: null, z, bound, n, reason: `${n}/${STOP.MIN_PER_ARM} לכל צד` };
  if (Math.abs(z) >= bound) {
    const winner = z > 0 ? 'challenger' : 'control';
    return { action: 'winner', winner, z, bound, n, reason: `z=${z.toFixed(2)} ≥ ${bound.toFixed(2)} ב-${n} לכל צד` };
  }
  if (n >= STOP.N_MAX) return { action: 'no_difference', winner: 'control', z, bound, n, reason: `הגענו ל-${STOP.N_MAX} לכל צד בלי הבדל מובהק` };
  return { action: 'continue', winner: null, z, bound, n, reason: `z=${z.toFixed(2)}, צריך ${bound.toFixed(2)}` };
}

/* the next challenger's name: <control family>_ab<n+1>, never reused */
export function nextChallengerName(control, history = [], tests = {}) {
  const base = String(control || '').replace(/_ab\d+$/, '');
  let max = 0;
  const seen = [...history, ...Object.values(tests || {})];
  for (const t of seen) for (const nm of [t && t.challenger, t && t.control]) {
    const m = String(nm || '').match(/^(.*)_ab(\d+)$/);
    if (m && m[1] === base) max = Math.max(max, Number(m[2]));
  }
  return `${base}_ab${max + 1}`;
}

/* what the loser did worse, for the drafting step (Claude writes the copy) */
export function weaknesses(stats, loserArm) {
  const l = stats[loserArm], w = stats[loserArm === 'control' ? 'challenger' : 'control'];
  const out = [];
  if (l.rate < w.rate) out.push(`פחות תשובות תוך 72 שעות (${(l.rate * 100).toFixed(1)}% מול ${(w.rate * 100).toFixed(1)}%)`);
  if (l.optout_rate > w.optout_rate) out.push(`יותר "טעות"/הסרות (${(l.optout_rate * 100).toFixed(1)}% מול ${(w.optout_rate * 100).toFixed(1)}%)`);
  const lc = l.delivered ? l.coming / l.delivered : 0, wc = w.delivered ? w.coming / w.delivered : 0;
  if (lc < wc) out.push(`פחות "מגיע" (${(lc * 100).toFixed(1)}% מול ${(wc * 100).toFixed(1)}%)`);
  return out;
}

/* ── evaluate (cron, daily 06:00 IL) ────────────────────────────────────────
   deps:
     kv                       KV binding (default env.RATE)
     queryRows(env, sinceMs)  → compact rows since then, as an array or as
                                template-stats loadRows()' { rows, missing };
                                any missing day → no decision this look
     isApproved(name)         → bool, Meta status APPROVED (required to activate)
     numberQuality()          → [{ id, quality }] for every guests number
     categoryOf(name)         → 'MARKETING'|'UTILITY' (optional)
     notify(text)             → Slack line (optional)
     promote(msgType, name)   → make the winner the production template; called
                                ONLY when env.AB_AUTOROTATE === 'on'
     now()                    → ms                                              */
export async function evaluate(env, deps = {}) {
  const kv = kvOf(env, deps);
  if (!kv) return { ok: false, why: 'no-kv' };
  if (String(env.AB_ENABLED || '') !== 'on' && !deps.force) return { ok: true, skipped: 'ab-off' };
  const now = deps.now ? deps.now() : Date.now();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(now)).replace(/-/g, '');
  if (!deps.force && await kv.get('ab:eval:' + day)) return { ok: true, skipped: 'already-ran' };
  await kv.put('ab:eval:' + day, '1', { expirationTtl: 3 * 86400 });

  clearMemo(env);
  const tests = await loadTests(env, deps);
  let history = [];
  try { history = JSON.parse((await kv.get('ab:history')) || '[]') || []; } catch { history = []; }
  const notify = deps.notify || (async () => {});
  const report = [];

  let qualityOk = false;
  try {
    const q = deps.numberQuality ? await deps.numberQuality() : [];
    qualityOk = q.length > 0 && q.every(n => String(n.quality || '').toUpperCase() === 'GREEN');
  } catch { qualityOk = false; }

  for (const [msgType, t] of Object.entries(tests)) {
    t.quality_ok = qualityOk;
    if (t.status === 'needs_draft') { report.push({ msgType, id: t.id, action: 'needs_draft', challenger: t.challenger }); continue; }
    if (t.status === 'pending') {
      const ok = deps.isApproved ? await deps.isApproved(t.challenger) : false;
      if (ok) {
        t.status = 'running'; t.started_at = new Date(now).toISOString();
        if (deps.categoryOf) t.category = (await deps.categoryOf(t.challenger)) || t.category;
        report.push({ msgType, id: t.id, action: 'started' });
        await notify(`🧪 ניסוי נוסחים התחיל · ${msgType} · ${t.control} מול ${t.challenger}`);
      } else report.push({ msgType, id: t.id, action: 'waiting-approval' });
      continue;
    }
    if (t.status !== 'running') continue;

    /* the challenger must still be APPROVED (Meta can pause/disable a template) */
    if (deps.isApproved && !(await deps.isApproved(t.challenger))) {
      t.status = 'stopped'; t.ended_at = new Date(now).toISOString(); t.reason = 'challenger-not-approved';
      report.push({ msgType, id: t.id, action: 'stopped', reason: t.reason });
      await notify(`⏸ ניסוי ${t.id} נעצר: ${t.challenger} כבר לא מאושרת במטא`);
      continue;
    }
    const keys = await listAll(kv, `ab:o:${t.id}:`);
    const assignments = keys.map(k => { const p = k.name.split(':'); return { arm: p[3], wamid: p.slice(4).join(':'), ts: (k.metadata && k.metadata.ts) || 0 }; });
    const since = Math.min(...assignments.map(a => a.ts || now), Date.parse(t.started_at || new Date(now).toISOString()));
    /* queryRows may answer { rows, missing } (template-stats loadRows): never
       decide on a partial log — a missing day could hold one arm's replies */
    const got = deps.queryRows ? await deps.queryRows(env, since) : [];
    const rows = Array.isArray(got) ? got : ((got && got.rows) || []);
    const missing = Array.isArray(got) ? [] : ((got && got.missing) || []);
    if (missing.length) { report.push({ msgType, id: t.id, action: 'incomplete-data', missing }); continue; }
    const stats = armStats(assignments, rows, now);
    const d = decide(stats);
    t.looks = [...(t.looks || []), { at: new Date(now).toISOString(), n: d.n, z: Math.round(d.z * 100) / 100, bound: d.bound && Math.round(d.bound * 100) / 100, c: stats.control.rate, x: stats.challenger.rate }].slice(-60);
    report.push({ msgType, id: t.id, action: d.action, decision: d, stats });
    if (d.action === 'continue') continue;

    /* finished: record, rotate, queue the next challenger */
    t.status = d.action === 'stop_optout' ? 'stopped' : 'done';
    t.ended_at = new Date(now).toISOString();
    t.winner = d.winner === 'challenger' ? t.challenger : t.control;
    t.reason = d.reason;
    t.final = stats;
    const loserArm = d.winner === 'challenger' ? 'control' : 'challenger';
    history = [{ ...t }, ...history].slice(0, 50);
    if (d.winner === 'challenger') {
      await kv.put('ab:control:' + msgType, t.challenger);
      if (String(env.AB_AUTOROTATE || '') === 'on' && deps.promote) await deps.promote(msgType, t.challenger);
    }
    const control = t.winner;
    const next = {
      id: `${msgType}-${day}-${hashUnit(control + now).toString(36).slice(2, 7)}`,
      msg_type: msgType, control, challenger: nextChallengerName(control, history, {}),
      category: t.category || '', split: t.split == null ? 0.5 : t.split, status: 'needs_draft',
      created_at: new Date(now).toISOString(), brief: weaknesses(stats, loserArm),
    };
    tests[msgType] = next;   // one challenger per message type, always
    await notify(`🏁 ניסוי ${t.id} (${msgType}) הסתיים · מנצחת: ${t.winner} · ${d.reason}` +
      (d.winner === 'challenger' && String(env.AB_AUTOROTATE || '') !== 'on' ? ' · ההחלפה לייצור ממתינה לאישור ריצארד' : '') +
      ` · המתחרה הבאה: ${next.challenger} (טיוטה)`);
  }
  await saveTests(env, deps, tests);
  await kv.put('ab:history', JSON.stringify(history));
  return { ok: true, day, quality_ok: qualityOk, report };
}

/* ── starting a test (admin action, tier 🟡) ───────────────────────────────
   Refuses when the message type already has a test that is not finished. */
export async function startTest(env, { msg_type, control, challenger, category = '', split = 0.5 }, deps) {
  const kv = kvOf(env, deps);
  if (!kv) return { ok: false, why: 'no-kv' };
  if (!msg_type || !control || !challenger) return { ok: false, why: 'missing-fields' };
  if (!/_ab\d+$/.test(challenger)) return { ok: false, why: 'challenger-name-must-end-_ab<n>' };
  clearMemo(env);
  const tests = await loadTests(env, deps);
  const cur = tests[msg_type];
  if (cur && !['done', 'stopped', 'needs_draft'].includes(cur.status)) return { ok: false, why: 'one-challenger-per-type', current: cur.id };
  const now = (deps && deps.now) ? deps.now() : Date.now();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(now)).replace(/-/g, '');
  tests[msg_type] = { id: `${msg_type}-${day}-${hashUnit(challenger + now).toString(36).slice(2, 7)}`, msg_type, control, challenger,
    category: String(category || '').toUpperCase(), split, status: 'pending', created_at: new Date(now).toISOString(), looks: [] };
  await saveTests(env, deps, tests);
  return { ok: true, test: tests[msg_type] };
}
