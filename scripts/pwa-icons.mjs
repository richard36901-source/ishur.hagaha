/* PWA icons for the client dashboard: logo.png → assets/icons/icon-192.png + icon-512.png.
   Uses sharp when it can be imported from this repo (worker/node_modules or a root
   node_modules); otherwise macOS `sips`; otherwise prints what to run by hand.
   Usage: node scripts/pwa-icons.mjs */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'logo.png'), OUT = join(ROOT, 'assets/icons');
const SIZES = [192, 512];
mkdirSync(OUT, { recursive: true });

async function loadSharp() {
  for (const base of [ROOT, join(ROOT, 'worker')]) {
    try { const req = createRequire(join(base, 'package.json')); return (await import(pathToFileURL(req.resolve('sharp')))).default; } catch (e) { /* next */ }
  }
  return null;
}
const sharp = await loadSharp();
let made = 0;
for (const n of SIZES) {
  const dst = join(OUT, `icon-${n}.png`);
  if (sharp) {
    /* cream background so the transparent logo reads on any launcher; 10% safe padding */
    const pad = Math.round(n * 0.1);
    const inner = await sharp(SRC).resize(n - 2 * pad, n - 2 * pad, { fit: 'contain', background: { r: 251, g: 248, b: 241, alpha: 1 } }).toBuffer();
    await sharp({ create: { width: n, height: n, channels: 4, background: { r: 251, g: 248, b: 241, alpha: 1 } } }).composite([{ input: inner }]).png().toFile(dst);
    made++; console.log('sharp → ' + dst);
  } else if (spawnSync('which', ['sips']).status === 0) {
    const r = spawnSync('sips', ['-z', String(n), String(n), SRC, '--out', dst], { encoding: 'utf8' });
    if (r.status === 0 && existsSync(dst)) { made++; console.log('sips → ' + dst); } else console.log('sips failed: ' + r.stderr);
  }
}
if (!made) {
  console.log('No sharp and no sips. By hand: `npm i -D sharp` in the repo root and re-run, or export logo.png at 192×192 and 512×512 to assets/icons/icon-192.png / icon-512.png.');
  process.exit(1);
}
console.log(sharp ? 'done (sharp)' : 'done (sips fallback: sharp was not in node_modules)');
