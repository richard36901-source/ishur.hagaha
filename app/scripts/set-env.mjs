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
/* googleClientId: the iOS OAuth client in Google Cloud project "ishur app" (richardtomskiy@gmail.com, 22/11). Not a
   secret: it ships in every app. The worker accepts tokens for it (GOOGLE_CLIENT_IDS in wrangler.toml). */
const GOOGLE_IOS = '141736472121-38deufih5suu1nvrch1a4mvh53qv0qoh.apps.googleusercontent.com';
const env = { ...ENVS[which], androidPush: false, googleClientId: GOOGLE_IOS, whatsapp: '972559504499', version };
const head = which === 'staging'
  ? '/* Which servers this build talks to. The committed file is STAGING on purpose: a build made by mistake can never\n   reach a real client. `npm run env:production` (app/scripts/set-env.mjs) rewrites it for a store build. */\n'
  : '/* PRODUCTION build. Do not commit this state: run `npm run env:staging` after the store build. */\n';
fs.writeFileSync(path.join(HERE, '..', 'www', 'env.js'), head + 'window.ISHUR_ENV = ' + JSON.stringify(env, null, 2) + ';\n');
console.log('www/env.js → ' + which + ' (' + env.api + '), version ' + version);
