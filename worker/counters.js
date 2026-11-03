/* ============================================================================
   ishur.io · counters.js · precomputed daily counters (03/11/2026, Phase 5)
   ----------------------------------------------------------------------------
   KV cnt:<IL day>:<kind> = integer. Kinds: wa_out (guest+client sends that
   Meta accepted), wa_fail (rejected at send), call (Retell/Shir dial rows),
   pay (Grow IPN rows). Bumped from audit.record() — every send/call/IPN path
   writes an audit row, so one hook covers the pacer, sendTemplate, the call
   paths and the IPN. KV has no atomic increment: two writes in the same instant
   can lose one bump. The 10-min tick re-derives TODAY and YESTERDAY from the
   audit when the read is complete (backfillDay), so the number converges.
   History: backfillCounters() rebuilds up to 30 past days, one day per call
   budget (cnt:bf:<day> marks a finished day), from the 10-min tick.
   ========================================================================== */
export const CNT_KINDS = ['wa_out', 'wa_fail', 'call', 'pay'];
export const cntKey = (day, kind) => `cnt:${day}:${kind}`;
export const cntMonthKey = (month, kind) => `cnt:m:${month}:${kind}`;
const TTL = 400 * 86400;
export const ilDay = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/* audit row → counter kinds it bumps (pure) */
export function kindsOf(r) {
  if (!r) return [];
  if (r.kind === 'wa_out') return [r.ok === false ? 'wa_fail' : 'wa_out'];
  if (r.kind === 'call') return ['call'];
  if (r.kind === 'pay') return ['pay'];
  return [];
}
/* audit rows → {day: {kind: n}} (pure; backfill + tests) */
export function countRows(rows) {
  const out = {};
  for (const r of rows || []) for (const k of kindsOf(r)) { const d = ilDay(r.ts); (out[d] = out[d] || {})[k] = ((out[d] || {})[k] || 0) + 1; }
  return out;
}

export async function bump(env, kind, n = 1, ts = Date.now()) {
  if (!env || !env.RATE || !CNT_KINDS.includes(kind)) return;
  try {
    const day = ilDay(ts);
    for (const k of [cntKey(day, kind), cntMonthKey(day.slice(0, 7), kind)]) { const v = Number(await env.RATE.get(k)) || 0; await env.RATE.put(k, String(v + n), { expirationTtl: TTL }); }
  } catch {}
}
/* month rollup = the sum of its day keys (after a backfill) */
export async function recomputeMonth(env, month, kinds = CNT_KINDS) {
  const [y, m] = month.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (const k of kinds) {
    let s = 0; for (let i = 1; i <= n; i++) s += Number(await env.RATE.get(cntKey(`${month}-${String(i).padStart(2, '0')}`, k)).catch(() => 0)) || 0;
    await env.RATE.put(cntMonthKey(month, k), String(s), { expirationTtl: TTL });
  }
}
export async function readMonths(env, months, kinds = CNT_KINDS) {
  const series = {};
  for (const k of kinds) series[k] = await Promise.all(months.map(async mo => Number(env.RATE ? await env.RATE.get(cntMonthKey(mo, k)).catch(() => 0) : 0) || 0));
  return { months, series };
}
export async function bumpFromAudit(env, r) { for (const k of kindsOf(r)) await bump(env, k, 1, r.ts); }

/* {days:[...], series:{kind:[n per day]}} oldest first */
export async function readCounters(env, from, to, kinds = CNT_KINDS) {
  const days = []; for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  const series = {};
  for (const k of kinds) series[k] = await Promise.all(days.map(async d => Number(env.RATE ? await env.RATE.get(cntKey(d, k)).catch(() => 0) : 0) || 0));
  return { days, series };
}

/* rebuild one day from the audit; only written when the audit read was complete */
export async function backfillDay(env, d, day) {
  const q = kind => d.auditQueryEx(env, { from: day.replace(/-/g, ''), to: day.replace(/-/g, ''), kind, limit: 50000, budget: 8000 }).catch(() => ({ items: [], truncated: true }));
  const res = await Promise.all(['wa_out', 'call', 'pay'].map(q));
  if (res.some(r => r.truncated)) return { day, ok: false, why: 'audit-truncated' };
  const c = countRows(res.flatMap(r => r.items || []))[day] || {};
  for (const k of CNT_KINDS) await env.RATE.put(cntKey(day, k), String(c[k] || 0), { expirationTtl: TTL });
  return { day, ok: true, counts: c };
}
export async function backfillCounters(env, d, { now = Date.now(), days = 30, perRun = 2, converge = true } = {}) {
  const today = ilDay(now), out = [];
  /* today + yesterday (converge lost bumps) — the caller asks once an hour */
  for (const day of converge ? [today, addDays(today, -1)] : []) out.push(await backfillDay(env, d, day).catch(e => ({ day, ok: false, why: String(e) })));
  let done = 0;
  for (let i = 2; i <= days && done < perRun; i++) {
    const day = addDays(today, -i);
    if (await env.RATE.get('cnt:bf:' + day).catch(() => null)) continue;
    const r = await backfillDay(env, d, day).catch(e => ({ day, ok: false, why: String(e) }));
    if (r.ok) await env.RATE.put('cnt:bf:' + day, '1', { expirationTtl: TTL });
    out.push(r); done++;
  }
  for (const mo of [...new Set(out.filter(r => r.ok).map(r => r.day.slice(0, 7)))]) await recomputeMonth(env, mo).catch(() => {});
  return out;
}
