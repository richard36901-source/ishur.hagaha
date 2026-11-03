// Build calls-log.fixture.json (UNSCRUBBED — always run scrub-fixture.mjs on it
// before it goes anywhere near the repo) with the real row logic of calls-log.js.
// usage: node worker/scripts/build-calls-log-fixture.mjs <dataDir> <out.json>
//   <dataDir>/days/*.k.json   audit rows per IL day (kind 'call' used)
//   <dataDir>/call-board.json /api/call-board answer (queue: waiting[])
import fs from 'node:fs';
import path from 'node:path';
import { rowFromAudit, nextAttempt, AUDIT_START } from '../calls-log.js';
import { callWindowState, ilDate } from '../shir.js';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: build-calls-log-fixture.mjs <dataDir> <out.json>'); process.exit(2); }
const files = fs.readdirSync(path.join(dir, 'days')).filter(f => f.endsWith('.k.json')).sort();
const recs = [].concat(...files.map(f => JSON.parse(fs.readFileSync(path.join(dir, 'days', f), 'utf8')))).filter(r => r.kind === 'call');
const rows = recs.map(rowFromAudit).sort((a, b) => b.ts - a.ts);
const board = JSON.parse(fs.readFileSync(path.join(dir, 'call-board.json'), 'utf8'));
const today = ilDate(), now = Date.now();
const lastDay = {}; for (const r of rows) if (r.guest_id && !lastDay[r.guest_id]) lastDay[r.guest_id] = r.day;
const queue = (board.waiting || []).map(q => {
  if (q.kind === 'lead') return { kind: 'lead', agent: 'נועה', name: q.name || '', phone: String(q.phone || '').replace(/\D/g, ''), event: q.event || '', state: 'waiting', tries: null, max_tries: null, next_at: null, next_he: 'לפי תור נועה' };
  const st = q.state === 'capped' ? 'capped' : (q.event_date && String(q.event_date).slice(0, 10) < today ? 'past' : 'waiting');
  const na = nextAttempt({ state: q.state === 'capped' ? 'capped' : 'waiting', event_date: q.event_date }, { now, today, callWindowState });
  return { kind: 'guest', agent: 'שיר', name: q.name || '', phone: String(q.phone || '').replace(/\D/g, ''), guest_id: '', token: '', event: q.event || '', event_date: q.event_date || '', tries: q.tries, max_tries: q.max_tries, state: st, last_answer: '', next_at: na.at, next_he: na.he };
});
const fx = { ok: true, rows, queue, window: board.window || null, audit_start: AUDIT_START,
  fixture: { built_at: new Date().toISOString(), source: 'audit kind call ' + files[0].slice(0, 8) + '…' + files[files.length - 1].slice(0, 8) + ' + /api/call-board queue (pulled 01/11 21:39-21:52 UTC)', rows: rows.length, queue: queue.length } };
fs.writeFileSync(out, JSON.stringify(fx));
console.log(`rows ${rows.length} · queue ${queue.length} · review ${rows.filter(r => r.review).length} · days ${[...new Set(rows.map(r => r.day))].join(',')}`);
