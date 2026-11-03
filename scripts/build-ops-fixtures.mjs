/* Builds fixtures/ops/*.json for ops.html?mock=1 from the LIVE ops API, so mock mode mirrors
   the real response shapes (docs at worker docs/OPS-API-2026-11-03.md).
   Run:  OPS_ADMIN_KEY=… node scripts/build-ops-fixtures.mjs [--base https://go.ishur.io]
   Read-only: GETs every endpoint, and POST /api/ops/toggle WITHOUT confirm (blast radius only).
   ishur.io is public, so before writing it masks guest/client phones (our own business numbers
   6673 / 9799 / 4499 stay), replaces event names with pseudonyms, and hides message bodies and
   contact names in the live feed. brain.json: read live from /api/ops/brain once it is deployed
   (until then scripts/build-brain-fixture.mjs builds it from the real brain.js locally).
   runs/run: when the live ledger is empty, a run fixture is synthesized in the real run shape
   from the live feed's cron rows and flagged "synthetic": true. */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures/ops');
const KEY = process.env.OPS_ADMIN_KEY;
const ai = process.argv.indexOf('--base'), BASE = ai > 0 ? process.argv[ai + 1] : 'https://go.ishur.io';
if (!KEY) { console.error('set OPS_ADMIN_KEY'); process.exit(2); }
const get = async (path) => { const r = await fetch(BASE + '/api/ops/' + path, { headers: { 'X-Admin-Key': KEY } }); const j = await r.json(); if (!r.ok && j.error !== 'not-found') throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j)); return j; };
const post = async (path, body) => { const r = await fetch(BASE + '/api/ops/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: KEY, ...body }) }); return r.json(); };

/* ── masking ── */
const OURS = /(6673|9799|4499)$/;
/* event tokens are board access secrets: keep the 8-char prefix the UI keys on, zero the rest */
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const KEYISH = /("?(?:webhookKey|admin_key|api_?key|secret|password|signature)"?\s*[:=]\s*"?)[^",\s}&]+/gi;
const maskPhone = (s) => String(s).replace(UUID, '$1-0000-4000-8000-000000000000').replace(KEYISH, '$1•••').replace(/(?<!\d)(972\d{8,9}|0\d{1,2}-?\d{3}-?\d{4})(?!\d)/g, (m) => (OURS.test(m.replace(/\D/g, '')) ? m : m.slice(0, 5) + '****' + m.slice(-3)));
const evName = new Map();
const pseudo = (tok8, name) => { if (!name) return name; if (!evName.has(tok8)) evName.set(tok8, 'אירוע ' + String.fromCharCode(0x5d0 + (evName.size % 22)) + (evName.size >= 22 ? evName.size : '')); return evName.get(tok8); };
const deep = (o, fn) => (Array.isArray(o) ? o.map((x) => deep(x, fn)) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(k, deep(v, fn), o)])) : o);
const scrub = (o) => deep(o, (k, v, parent) => {
  if (k === 'name' && parent && (parent.tok8 || parent.token)) return pseudo(parent.tok8 || String(parent.token).slice(0, 8), v);
  return typeof v === 'string' ? maskPhone(v) : v;
});
const PRIVATE_KINDS = new Set(['wa_in', 'wa_out', 'wa_status', 'lead', 'event', 'call', 'pay']);
const scrubLive = (it) => {
  const x = scrub(it); /* every string, including nested data objects */
  if (it.type !== 'audit') return x;
  if (PRIVATE_KINDS.has(it.kind)) { x.detail = it.detail ? '‹הוסתר בדמה›' : ''; x.action = x.action.replace(/ · [^·]*$/, (m) => (/\d/.test(m) ? m : ' · ‹שם›')); x.data = null; }
  else if (typeof x.detail === 'string') x.detail = maskPhone(x.detail);
  return x;
};
const write = (name, obj) => { writeFileSync(join(OUT, name + '.json'), JSON.stringify({ fixture: true, fixture_from: BASE, ...obj }, null, 1) + '\n'); console.log('  wrote ' + name + '.json'); };

/* ── fetch ── */
const [realtime, capacity, balances, registry, live, runs] = await Promise.all(['realtime', 'capacity?days=14', 'balances', 'registry', 'live?limit=200', 'runs?limit=200'].map(get));
/* names first from capacity so tok8 → pseudonym is stable across files */
const cap = scrub(capacity);
write('realtime', scrub(realtime));
write('capacity', cap);
write('balances', scrub(balances));
write('registry', scrub(registry));
write('live', { ...live, items: live.items.map(scrubLive) });

let runsOut = scrub(runs), runOut;
if (runs.items.length) {
  const pacer = runs.items.find((r) => r.automation_id === 'd_pacer') || runs.items[0];
  runOut = scrub(await get('run?id=' + encodeURIComponent(pacer.id)));
} else {
  /* ledger empty on live: synthesize real-shaped rows from the cron audit rows */
  const JOB = { runPacer: 'd_pacer', runDaily: 'd_engine', drainPartyNudges: 'party_nudges' };
  const cron = live.items.filter((i) => i.type === 'audit' && i.kind === 'cron' && i.data && i.data.job);
  const items = cron.map((c, k) => ({ id: 'syn' + c.ts.toString(36) + k, automation_id: JOB[c.data.job] || c.data.job, parent_id: null, started_at: new Date(c.ts - (c.data.ms || 0)).toISOString(), ended_at: c.at, status: c.ok === false ? 'failed' : 'ok', triggered_by: 'cron', counts: { ms: c.data.ms || 0 }, cost_usd: 0, tokens_in: 0, tokens_out: 0, summary: maskPhone(String(c.detail || '').slice(0, 400)), error: c.ok === false ? maskPhone(String(c.detail || '')).slice(0, 200) : '', logs_ref: 'audit:cron:' + c.data.job }));
  runsOut = { ok: true, source: 'kv', next_cursor: null, synthetic: true, items };
  const r0 = items.find((r) => r.automation_id === 'd_pacer') || items[0];
  runOut = r0 ? { ok: true, source: 'kv', synthetic: true, run: r0, children: [], audit: cron.filter((c) => c.at === r0.ended_at).map((c) => ({ id: c.id, ts: c.ts, at: c.at, kind: c.kind, action: c.action, ok: c.ok, token: c.token, detail: '', run_match: true })), audit_window: { from: r0.started_at, to: r0.ended_at, token: null } } : { ok: false, error: 'not-found' };
}
write('runs', runsOut);
write('run', runOut);

/* code for every node that has a snapshot */
const code = {};
for (const n of registry.nodes) { const c = await get('code?id=' + n.id).catch(() => null); if (c && c.ok) code[n.id] = c; }
write('code', { ok: true, by_id: code });

/* blast radius for every kill switch (no confirm → writes nothing) */
const toggle = {};
for (const id of registry.kill_switches) { const t = await post('toggle', { id, enabled: false }); if (t.applied) throw new Error('toggle applied?! ' + id); toggle[id] = scrub(t); }
write('toggle', { ok: true, by_id: toggle });

/* brain: only when the endpoint exists (the deployed Worker has brain.js) */
const brainLive = await fetch(BASE + '/api/ops/brain', { headers: { 'X-Admin-Key': KEY } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (brainLive && brainLive.ok) write('brain', scrub(brainLive)); else console.log('  brain.json kept (no /api/ops/brain on ' + BASE + ' yet — run scripts/build-brain-fixture.mjs)');
console.log('done · ' + evName.size + ' event names pseudonymized');
