#!/usr/bin/env node
/* ============================================================================
   ops-check-realtime.mjs — does /api/ops/realtime equal /api/stream (+ /api/shir-calls) for today?
   ----------------------------------------------------------------------------
   Read-only: GET /api/ops/realtime, POST /api/stream {days:1, kind:'wa_out'},
   POST /api/shir-calls {limit:100}. No toggles, no sends. (The Worker itself
   logs one `admin` audit row per admin call it receives — that is the
   server's own behaviour on every admin read, not a write by this script.)

   The comparison is ops.js compareRealtime(): the same aggregateWa() runs over
   the stream rows (cut at realtime.audit_until_ts, so rows that arrive between
   the two requests do not count as a mismatch), per phone id:
     sent_today, rejected_today, and the total; plus calls.dialed vs the
   outbound calls /api/shir-calls lists for today (a lower bound when it hits
   its 100-call cap).

   usage: OPS_ADMIN_KEY=… node worker/scripts/ops-check-realtime.mjs [--base https://go.ishur.io]
   exit 0 = every check matches · 1 = a mismatch · 2 = /api/ops/realtime not
   deployed on that base (prints what the stream says, so the run still shows
   today's numbers) · 3 = auth/network error
   ========================================================================== */
import { compareRealtime, aggregateWa, ilDayOf } from '../ops.js';

const ai = process.argv.indexOf('--base');
const BASE = (ai > 0 ? process.argv[ai + 1] : process.env.OPS_BASE || 'https://go.ishur.io').replace(/\/$/, '');
const KEY = process.env.OPS_ADMIN_KEY || '';
if (!KEY) { console.error('set OPS_ADMIN_KEY'); process.exit(3); }
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: KEY, ...body }) });

console.log(`ops-check-realtime · ${BASE} · ${new Date().toISOString()}`);
let rt = null, rtStatus = 0;
try { const r = await fetch(BASE + '/api/ops/realtime', { headers: { 'X-Admin-Key': KEY } }); rtStatus = r.status; if (r.ok) rt = await r.json(); } catch (e) { console.error('realtime: ' + e.message); process.exit(3); }
const sr = await post('/api/stream', { days: 1, kind: 'wa_out', limit: 20000 }).catch(e => { console.error('stream: ' + e.message); process.exit(3); });
if (sr.status === 403) { console.error('stream: 403 bad admin key'); process.exit(3); }
const stream = await sr.json();
const sc = await post('/api/shir-calls', { limit: 100 }).then(r => r.ok ? r.json() : null).catch(() => null);
const today = rt ? rt.today : ilDayOf(Date.now());
console.log(`stream: ${stream.items.length} wa_out rows (truncated=${stream.truncated}, ops=${stream.ops}) · shir-calls: ${sc ? sc.calls.length + ' calls' : 'unavailable'}`);

if (!rt) {
  const agg = aggregateWa(stream.items, [], { today });
  console.log(`/api/ops/realtime → HTTP ${rtStatus}: not deployed on ${BASE} (branch ops-backend is not live). Stream aggregate for ${today}:`);
  for (const [id, a] of Object.entries(agg).sort()) console.log(`  ${id.padEnd(18)} sent_today=${a.sent_today}  rejected_today=${a.rejected_today}  by_reason=${JSON.stringify(a.by_reason)}`);
  const dayStart = Date.parse(today + 'T00:00:00+02:00');
  if (sc) console.log(`  calls today (outbound, from /api/shir-calls ≤100): ${sc.calls.filter(c => Number(c.started_at) >= dayStart && c.direction !== 'inbound').length}`);
  process.exit(2);
}
const res = compareRealtime(rt, stream.items, { shirCalls: sc, today });
for (const c of res.checks) console.log(`  ${c.ok ? 'OK ' : 'BAD'} ${c.check.padEnd(34)} realtime=${c.realtime}  stream=${c.stream}${c.note ? '  (' + c.note + ')' : ''}`);
if (stream.truncated || rt.audit_truncated) console.log('  note: an audit read was truncated (KV op budget) — a mismatch may be the cut, not the logic');
console.log(res.ok ? 'MATCH' : 'MISMATCH');
process.exit(res.ok ? 0 : 1);
