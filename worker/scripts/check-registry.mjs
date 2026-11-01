#!/usr/bin/env node
/* ============================================================================
   check-registry.mjs — every claim in automations-registry.js points at a line
   ----------------------------------------------------------------------------
   For every node's `source` and every `evidence[]` entry (and the NUMBERS /
   WINDOWS / CRONS_SOURCE anchors), open `file` (relative to the repo root)
   and assert that some line in [line - WINDOW, line + WINDOW] contains
   `symbol` verbatim.

   WINDOW = 3 (documented, fixed). It absorbs a comment line added above a
   function; anything larger means the registry is stale and must be re-pinned
   by a human — so the script never widens it, it prints where the symbol is
   now instead.

   Also asserts: ids unique, every `from` id exists, required fields present.

   Exit 0 = all anchors hold. Exit 1 = at least one failed (each listed).
   Usage: node worker/scripts/check-registry.mjs [--quiet] [--registry <path>]
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOW = 3;
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const quiet = process.argv.includes('--quiet');
/* --registry <path>: check another copy (used for the mutation self-test) */
const ri = process.argv.indexOf('--registry');
const regPath = ri > 0 ? resolve(process.argv[ri + 1]) : resolve(ROOT, 'worker/automations-registry.js');

const reg = await import(regPath);
const files = new Map();
function lines(file) {
  if (!files.has(file)) files.set(file, readFileSync(resolve(ROOT, file), 'utf8').split('\n'));
  return files.get(file);
}

const failures = [];
let checked = 0;
function check(where, a) {
  checked++;
  if (!a || typeof a.file !== 'string' || !Number.isInteger(a.line) || typeof a.symbol !== 'string' || !a.symbol) {
    failures.push(`${where}: malformed anchor ${JSON.stringify(a)}`); return;
  }
  let L;
  try { L = lines(a.file); } catch (e) { failures.push(`${where}: cannot open ${a.file} (${e.code || e.message})`); return; }
  const lo = Math.max(1, a.line - WINDOW), hi = Math.min(L.length, a.line + WINDOW);
  for (let n = lo; n <= hi; n++) if (L[n - 1].includes(a.symbol)) return;
  const now = [];
  L.forEach((t, i) => { if (t.includes(a.symbol)) now.push(i + 1); });
  failures.push(`${where}: ${a.file}:${a.line} (±${WINDOW}) does not contain ${JSON.stringify(a.symbol)}` +
    (now.length ? ` — found at line(s) ${now.slice(0, 6).join(', ')}` : ' — symbol not found anywhere in the file'));
}

const ids = new Set();
for (const n of reg.AUTOMATIONS) {
  if (!n.id || !n.name_he || n.layer == null || !n.source) failures.push(`node ${n.id || '?'}: missing id/name_he/layer/source`);
  if (ids.has(n.id)) failures.push(`node ${n.id}: duplicate id`);
  ids.add(n.id);
  check(`${n.id}.source`, n.source);
  (n.evidence || []).forEach((e, i) => check(`${n.id}.evidence[${i}] (${e.claim || ''})`, e));
}
for (const n of reg.AUTOMATIONS) for (const f of n.from || []) if (!ids.has(f)) failures.push(`node ${n.id}: from "${f}" is not a node id`);
for (const c of reg.CRONS) if (!ids.has(c.node)) failures.push(`CRONS ${c.expr}: node "${c.node}" missing`);
for (const [k, w] of Object.entries(reg.WINDOWS)) check(`WINDOWS.${k}`, w.source);
for (const [k, w] of Object.entries(reg.NUMBERS)) { check(`NUMBERS.${k}`, w.source); (w.evidence || []).forEach((e, i) => check(`NUMBERS.${k}.evidence[${i}]`, e)); }
check('CRONS_SOURCE', reg.CRONS_SOURCE);
/* every cron string in wrangler.toml is represented in CRONS, and vice versa */
const toml = lines('worker/wrangler.toml').join('\n');
const m = toml.match(/^crons\s*=\s*\[([^\]]*)\]/m);
const live = m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : [];
for (const c of live) if (!reg.CRONS.some(x => x.expr === c)) failures.push(`wrangler.toml cron "${c}" has no CRONS entry`);
for (const c of reg.CRONS) if (!live.includes(c.expr)) failures.push(`CRONS "${c.expr}" is not in wrangler.toml`);

if (failures.length) {
  console.error(`check-registry: FAIL — ${failures.length} problem(s) in ${checked} anchors across ${reg.AUTOMATIONS.length} nodes (window ±${WINDOW})`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
if (!quiet) console.log(`check-registry: OK — ${checked} anchors, ${reg.AUTOMATIONS.length} nodes, ${live.length} crons, window ±${WINDOW}, files: ${[...files.keys()].join(', ')}`);
