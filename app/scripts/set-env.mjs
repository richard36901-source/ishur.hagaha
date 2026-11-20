#!/usr/bin/env node
/* Writes www/env.js for a build. `node scripts/set-env.mjs staging|production`.
   The committed env.js is staging; switch to production only for a store build, and switch back after. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENVS = {
  staging: { name: 'staging', api: 'https://go-staging.ishur.io', site: 'https://staging.ishur.io', board: 'https://staging.ishur.io/dashboard', apnsSandbox: true },
  production: { name: 'production', api: 'https://go.ishur.io', site: 'https://go.ishur.io', board: 'https://go.ishur.io/dashboard.html', apnsSandbox: false },
};
const which = process.argv[2];
if (!ENVS[which]) { console.error('usage: set-env.mjs staging|production'); process.exit(2); }
const version = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
/* androidPush: Android notifications need Firebase (google-services.json). Until that file is in android/app/,
   push stays off on Android, because registering without it crashes the app. Set to true together with the file. */
const env = { ...ENVS[which], androidPush: false, whatsapp: '972559504499', version };
const head = which === 'staging'
  ? '/* Which servers this build talks to. The committed file is STAGING on purpose: a build made by mistake can never\n   reach a real client. `npm run env:production` (app/scripts/set-env.mjs) rewrites it for a store build. */\n'
  : '/* PRODUCTION build. Do not commit this state: run `npm run env:staging` after the store build. */\n';
fs.writeFileSync(path.join(HERE, '..', 'www', 'env.js'), head + 'window.ISHUR_ENV = ' + JSON.stringify(env, null, 2) + ';\n');
console.log('www/env.js → ' + which + ' (' + env.api + '), version ' + version);
