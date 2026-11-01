/* Live read-only smoke test of green tool wrappers against go.ishur.io.
   Reads the admin key from ~/.ishur-keys/admin.txt and never prints it.
   Usage: node scripts/smoke.mjs [tool ...]   (default: cap_status automations) */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { callTool, TIERS } from '../src/tools.js';

const key = readFileSync(homedir() + '/.ishur-keys/admin.txt', 'utf8').trim();
const env = { AGENT_ADMIN_KEY: key, ISHUR_BASE: 'https://go.ishur.io' };
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['cap_status', 'automations'];
for (const n of names) {
  if (TIERS[n] !== 'green') { console.log(`${n}: SKIPPED (tier ${TIERS[n]}, smoke runs green only)`); continue; }
  const r = await callTool(env, n, {});
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  const safe = n === 'cap_status' ? { ok: d.ok, tier: d.tier, used: d.used, left: d.left, capped: d.capped } : { keys: Object.keys(d).slice(0, 8), snippet: typeof r.data === 'string' ? r.data.slice(0, 60) : undefined };
  console.log(`${n}: HTTP ${r.http_status}`, JSON.stringify(safe));
}
