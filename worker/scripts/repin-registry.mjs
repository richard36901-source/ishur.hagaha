// Re-pins worker/index.js anchors in automations-registry.js after index.js
// changes, using the old→new line map from `git diff -U0 <base> -- index.js`.
// Anchors for other files (explicit 'worker/…' arg) are left alone.
// Run check-registry.mjs afterwards: it still verifies every symbol.
// usage: node worker/scripts/repin-registry.mjs [base=HEAD]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const W = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'HEAD';
const diff = execFileSync('git', ['diff', '-U0', base, '--', 'index.js'], { cwd: W, encoding: 'utf8' });
const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
  .map(m => ({ os: +m[1], oc: m[2] === undefined ? 1 : +m[2], nc: m[4] === undefined ? 1 : +m[4] }));
const map = n => {
  let d = 0;
  for (const h of hunks) {
    const oEnd = h.oc ? h.os + h.oc - 1 : h.os;      // pure insert: after line os
    if (h.oc === 0 ? n > h.os : n > oEnd) d += h.nc - h.oc;
    else if (h.oc && n >= h.os && n <= oEnd) return null; // anchor line itself changed
  }
  return n + d;
};
const p = resolve(W, 'automations-registry.js');
const src = readFileSync(p, 'utf8');
const ms = [...src.matchAll(/\b([SE])\((\d+),/g)];
let out = '', last = 0, moved = 0, lost = [];
ms.forEach((m, i) => {
  const chunk = src.slice(m.index, i + 1 < ms.length ? ms[i + 1].index : src.length);
  const other = /'worker\/(?!index\.js)/.test(chunk.split('\n')[0].split(/\b[SE]\(\d+,/)[1] || '');
  const n = +m[2];
  let nn = n;
  if (!other) { const r = map(n); if (r === null) lost.push(n); else nn = r; }
  if (nn !== n) moved++;
  out += src.slice(last, m.index) + `${m[1]}(${nn},`; last = m.index + m[0].length;
});
out += src.slice(last);
writeFileSync(p, out);
console.log(`repin: ${hunks.length} hunks, ${moved} anchors moved${lost.length ? ', anchor lines edited: ' + lost.join(',') : ''}`);
