#!/usr/bin/env node
/* ============================================================================
   ops-snapshot-code.mjs — worker/registry-code.json for GET /api/ops/code
   ----------------------------------------------------------------------------
   For every registry node: opsMeta(node).code = { file, symbol }. Finds the
   symbol in the file (the occurrence nearest to the node's `source.line` when
   the file is the same, else the first), then cuts the source:
     · a function start (`function`, `async scheduled(`) → up to its closing
       brace (naive brace count, strings/templates not parsed), max 200 lines;
     · anything else (an engine stage comment, a route test) → 40 lines.
   Blocks are stored once and shared by nodes that point at the same lines.
   Re-run after editing index.js (the Worker serves the committed snapshot):
     node worker/scripts/ops-snapshot-code.mjs
   Exit 1 when a node's symbol is not found (prints which).
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const { AUTOMATIONS, opsMeta } = await import(resolve(ROOT, 'worker/automations-registry.js'));
const MAX_FN = 200, CTX = 40;
const cache = new Map();
const lines = f => { if (!cache.has(f)) cache.set(f, readFileSync(resolve(ROOT, f), 'utf8').split('\n')); return cache.get(f); };

export function cut(L, idx) {
  const first = L[idx];
  const isFn = /\bfunction\b|async scheduled\(|^\s*async \w+\(/.test(first);
  if (!isFn) return { start: idx, end: Math.min(L.length - 1, idx + CTX - 1), truncated: false };
  let depth = 0, opened = false;
  for (let i = idx; i < L.length && i < idx + MAX_FN; i++) {
    for (const ch of L[i]) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
    if (opened && depth <= 0) return { start: idx, end: i, truncated: false };
  }
  return { start: idx, end: Math.min(L.length - 1, idx + MAX_FN - 1), truncated: true };
}

const blocks = {}, nodes = {}, missing = [];
for (const n of AUTOMATIONS) {
  const c = opsMeta(n).code; if (!c) continue;
  let L; try { L = lines(c.file); } catch { missing.push(`${n.id}: cannot open ${c.file}`); continue; }
  const hits = []; L.forEach((t, i) => { if (t.includes(c.symbol)) hits.push(i); });
  if (!hits.length) { missing.push(`${n.id}: "${c.symbol}" not in ${c.file}`); continue; }
  const want = n.source && n.source.file === c.file ? n.source.line - 1 : hits[0];
  const idx = hits.slice().sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
  const { start, end, truncated } = cut(L, idx);
  const key = `${c.file}:${start + 1}`;
  if (!blocks[key]) blocks[key] = L.slice(start, end + 1).join('\n');
  nodes[n.id] = { file: c.file, symbol: c.symbol, line_start: start + 1, line_end: end + 1, truncated, block: key };
}
let git = ''; try { git = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch {}
/* the Worker reads nodes[id] + blocks[block]; inline the text per node for a single lookup */
for (const v of Object.values(nodes)) v.source = blocks[v.block];
const out = { generated_at: new Date().toISOString(), git, max_fn_lines: MAX_FN, nodes };
writeFileSync(resolve(ROOT, 'worker/registry-code.json'), JSON.stringify(out));
console.log(`ops-snapshot-code: ${Object.keys(nodes).length} nodes, ${Object.keys(blocks).length} distinct blocks, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB, git ${git}`);
if (missing.length) { console.error('missing:\n  ' + missing.join('\n  ')); process.exit(1); }
