/* Which servers this build talks to. The committed file is STAGING on purpose: a build made by mistake can never
   reach a real client. `npm run env:production` (app/scripts/set-env.mjs) rewrites it for a store build. */
window.ISHUR_ENV = {
  "name": "staging",
  "api": "https://go-staging.ishur.io",
  "site": "https://staging.ishur.io",
  "board": "https://staging.ishur.io/dashboard",
  "apnsSandbox": true,
  "androidPush": false,
  "whatsapp": "972559504499",
  "version": "1.0.0"
};
