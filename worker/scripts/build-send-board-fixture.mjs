// Build send-board.fixture.json by running the REAL aggregation
// (worker/send-board.js · aggregateSendBoard) over data pulled read-only from
// the live admin API: /api/wave-audit, /api/delivery-report, /api/audit (per day).
//
// usage: node worker/scripts/build-send-board-fixture.mjs <dataDir> <out.json>
//   <dataDir>/wave-audit.json          POST /api/wave-audit {}
//   <dataDir>/tokens.json              {tokens:{short:full}, meta:{full: evmeta}} (from audit rows' `event`)
//   <dataDir>/dr_<short>.json          POST /api/delivery-report {token}
//   <dataDir>/days/<YYYYMMDD>.k.json   POST /api/audit {from,to:day} filtered to wa_out/wa_status/wa_in/call/guest
//
// What the fixture CANNOT know (no KV access from outside the Worker):
//   per-guest markers (wsent/wst/s5d…) → reopened-vs-final is inferred from the
//   code's rules and flagged `inferred`; sends before the first audit day are
//   "unknown". The deployed endpoint reads the markers and has neither gap.
import fs from 'node:fs';
import path from 'node:path';
import { aggregateSendBoard } from '../send-board.js';

const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) { console.error('usage: build-send-board-fixture.mjs <dataDir> <out.json>'); process.exit(2); }
const J = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

const wa = J('wave-audit.json');
const { tokens, meta } = J('tokens.json');
const dayFiles = fs.readdirSync(path.join(dir, 'days')).filter(f => f.endsWith('.k.json')).sort();
const rows = [].concat(...dayFiles.map(f => J('days/' + f)));
const nonEmpty = dayFiles.filter(f => J('days/' + f).length);
const coverageFrom = nonEmpty.length ? `${nonEmpty[0].slice(0, 4)}-${nonEmpty[0].slice(4, 6)}-${nonEmpty[0].slice(6, 8)}` : '';
const today = wa.today;
const PLAN = { 'בסיס': 'basic', 'פרמיום': 'premium', 'הכל כלול': 'all' };

/* the latest rsvp/table we have seen per (token, phone), from the audit enrichment (audit.js:96-113) */
const lastGuest = {};
for (const r of rows.slice().sort((a, b) => a.ts - b.ts)) if (r.guest && r.token && r.phone) lastGuest[r.token + '|' + r.phone] = r.guest;

const events = [], guests = {}, waveAudit = {};
for (const e of wa.events) {
  const full = tokens[e.token]; const m = meta[full] || {};
  const date = e.date || m.date;
  if (!full || date < '2026-10-30') continue;               // upcoming + just-passed only, like the board
  const drf = `dr_${e.token}.json`;
  if (!fs.existsSync(path.join(dir, drf))) continue;
  const dr = J(drf);
  events.push({ token: full, name: e.name, date, plan: PLAN[m.plan] || 'basic', waves: { 1: (m.invite_date || e.wave1 || '').slice(0, 10), 2: (m.reminder_date || '').slice(0, 10), 3: '' }, held: !!e.held, eventday: null });
  guests[full] = dr.rows.map(g => { const lg = lastGuest[full + '|' + g.phone] || {}; return { name: g.name, phone: g.phone, id: g.id, rsvp: lg.rsvp || '', table: lg.table || '' }; });
  waveAudit[full] = { guests: e.guests, sent_w1: e.sent, answered: e.answered, dead: e.dead, optout: e.optout, missing_n: e.missing_n };
}

const board = aggregateSendBoard({
  today, now: Date.now(), events, guests,
  waOut: rows.filter(r => r.kind === 'wa_out'),
  waStatus: rows.filter(r => r.kind === 'wa_status'),
  waIn: rows.filter(r => r.kind === 'wa_in'),
  gates: { paused: false, cap_all: false, window: { open: false, why: 'hours' } },
  coverageFrom, detail: true,
});
board.fixture = {
  built_at: new Date().toISOString(),
  source: 'live read-only: /api/wave-audit, /api/delivery-report, /api/audit (per day ' + (dayFiles[0] || '').slice(0, 8) + '…' + (dayFiles[dayFiles.length - 1] || '').slice(0, 8) + ')',
  note: 'אין גישה לסמני KV מבחוץ: "נפתח מחדש" מוסק מכללי הקוד; שליחות לפני ' + coverageFrom + ' מסומנות "לא ידוע".',
  audit_rows: rows.length,
};
for (const ev of board.events) ev.wave_audit = waveAudit[ev.token] || null;
fs.writeFileSync(outFile, JSON.stringify(board));
for (const ev of board.events) {
  console.log(ev.short, ev.name, ev.date, 'invited', ev.invited);
  for (const t of ev.types) console.log('  ', t.key.padEnd(9), `נמסרו ${t.delivered} / נשלחו ${t.sent} / קהל ${t.audience}`, `נקרא ${t.read} · נכשל ${t.failed.total} ${JSON.stringify(t.failed)} · ממתין ${t.pending.total} ${JSON.stringify(t.pending)} · ללא סטטוס ${t.no_status} · לא ידוע ${t.unknown} · ענו ${t.answered} · inferred ${t.inferred}`);
}
