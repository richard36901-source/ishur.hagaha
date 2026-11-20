# ishur client app · runbook (draft 20/11/2026)

For a person shipping an update without Claude. No secrets in this file.

## What is where
- `www/` the screens (plain HTML/CSS/JS, no build step). `www/env.js` decides which servers the app talks to.
- `ios/`, `android/` the native projects (Capacitor 8). `capacitor.config.json` the shared settings.
- `test/app-check.mjs` the check for the screens. `store/` listing texts and the pre-submission checklist.

## Tools
Node 22+, Xcode 26+ (iOS), Android Studio Otter 2025.2.1+ (Android). `cd app && npm install`.

## Change a screen and check it
```bash
cd app
STAGING_SECRETS=/path/to/worker/.staging.secrets PLAYWRIGHT_PATH=/path/to/playwright/index.mjs npm run check
DEMO=2 ... npm run check        # the demo client with mixed answers
```
Exit 0 and "31/31 passed" is the pass. The script first clears the staging sign-in counters (6 tries an hour per
phone); that reset exists on staging only. Screenshots land in `test/shots/`.

## Build for a store
```bash
cd app
# 1. raise "version" in package.json; raise the build number in Xcode / android/app/build.gradle
npm run env:production          # www/env.js → go.ishur.io
npx cap sync
npm run ios                     # Xcode: Product → Archive → Distribute → App Store Connect
npm run android                 # Android Studio: Build → Generate Signed App Bundle
npm run env:staging             # ALWAYS switch back before committing
```
`git diff www/env.js` must be empty before a commit.

## Not written yet (filled in as each loop is done)
Signing and certificates, push keys (APNs .p8, Firebase), the Worker push switch `cfg:app_push`, the reviewer demo
client, TestFlight, Play closed test, what to do on a rejection.
