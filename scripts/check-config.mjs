// dev-staging: config.js must pick the proxy by hostname. node scripts/check-config.mjs [path/to/config.js]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const file = process.argv[2] || new URL('../config.js', import.meta.url).pathname;
const src = readFileSync(file, 'utf8');
const want = { 'ishur.io': 'https://go.ishur.io', 'www.ishur.io': 'https://go.ishur.io', 'staging.ishur.io': 'https://go-staging.ishur.io', 'ishur-staging.pages.dev': 'https://go-staging.ishur.io', 'localhost': 'https://go-staging.ishur.io' };
let bad = 0;
for (const [host, base] of Object.entries(want)) {
  const window = { location: { hostname: host, protocol: 'https:', href: 'https://' + host + '/' }, document: {} };
  const ctx = vm.createContext({ window, document: window.document, navigator: {}, console });
  try { vm.runInContext(src, ctx, { filename: file }); } catch (e) { console.log('FAIL', host, 'threw', e.message); bad++; continue; }
  const got = window.ISHUR_CONFIG && window.ISHUR_CONFIG.PROXY_BASE;
  const ok = got === base;
  console.log(ok ? 'ok  ' : 'FAIL', host, '→', got);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
