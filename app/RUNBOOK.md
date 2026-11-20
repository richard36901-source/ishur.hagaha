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
Exit 0 and "37/37 passed" is the pass. The script first clears the staging sign-in counters (6 tries an hour per
phone); that reset exists on staging only. Screenshots land in `test/shots/`.

## Build for the simulator (no signing needed)
```bash
cd app && npx cap sync
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```
"** BUILD SUCCEEDED **" is the pass. The app is at `ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app`.
Running it needs an iOS simulator runtime: Xcode → Settings → Components → iOS. On 20/11/2026 the iOS 27.2
runtime took 8 GB on disk (a second, unused 27.2 image for iPhone Duo was deleted that day:
`xcrun simctl runtime list`, `xcrun simctl runtime delete <id>`), and a booted simulator 4 to 7 GB more while it
runs. Keep 15 GB free. The first launch after a boot shows a black screen for about a minute; taps arrive late.
```bash
xcrun simctl boot "iPhone 18 Pro" && xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted io.ishur.client && xcrun simctl io booted screenshot shot.png
xcrun simctl shutdown all      # frees the 7.5 GB
```

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

## Push (server side)
- Code: `worker/app-push.js`, routes `/api/app/*`, tests `node --test worker/test/app-push.test.mjs`.
- Master switch: KV `cfg:app_push` = `1` turns sending on. Missing = off. Production stays off until Richard says so.
- Secrets the Worker needs for iPhone: `APNS_KEY_P8` (the text of the .p8 file from Apple), `APNS_KEY_ID`,
  `APNS_TEAM_ID`. Set with `npx wrangler secret put NAME --env staging` (and without `--env` for production).
- One test notification: `POST /api/app/push-test {admin_key, phone}`. Answers `apns-not-configured` until the
  secrets are set, `no-devices` until a phone registered from the app.
- A delete-account request from the app is a journal row marked for review ("בקשת מחיקת חשבון…") and a KV row
  `appdelete:<phone>`. A person carries it out within 7 days.
- Not connected yet: the call from "a guest answered" to `notifyAnswer`, the 09:00 summary cron, Android (FCM).

## Usage data (how clients use the app)
- Code: `worker/app-events.js`, `www/track.js`, `assets/app-track.js` (the board inside the frame). Tests:
  `node --test worker/test/app-events.test.mjs`. Stored in the Worker's KV under `appev:`, kept 400 days.
- Read it: `POST /api/app/analytics {admin_key, days}` (1 to 90). Add `phone` for one client's own counts. It answers
  clients per day, event counts, tabs, board pages and controls, script errors, platform, version, a funnel and
  return on day 1 and day 7.
- A new event: add its name to `NAMES` in `worker/app-events.js`, then call `T('name', {…})` in the app. Props are a
  fixed list of keys; a value with Hebrew letters or 7+ digits in a row is dropped on purpose.
- A board control is reported only when it has an `id` (or `data-tab` / `data-f` / `data-act`) in Latin letters.
- Remove one client's events: `POST /api/app/events-purge {admin_key, phone}`. A delete-account request from the app
  does this by itself.
- Database: the code writes to a D1 database when the Worker has one bound as `APP_DB` (tables in
  `worker/migrations-app/`), and to KV when it does not. To switch staging over: give the Cloudflare API token
  Account → D1 → Edit, run `sh worker/scripts/app-d1-setup.sh`, then `scripts/deploy-staging.sh worker`. The report
  answers the same from both (a test compares them). Events already in KV are not copied; they age out in 400 days.
- Not there yet: a screen to read the report (today it is JSON); purchase events (names reserved, nothing sends them).

## Signing and the first upload to Apple (written 21/11, before the account was active: steps not yet run)
1. Xcode → Settings → Accounts: the Apple account of the developer program is signed in.
2. `ios/App/App.xcodeproj` → target App → Signing & Capabilities: tick "Automatically manage signing", Team = the
   individual team. Bundle identifier stays `io.ishur.client` (cannot change after the first upload).
3. Same screen → "+ Capability" → Push Notifications (Xcode registers it on the App ID).
4. Build number: raise it for every upload (`CURRENT_PROJECT_VERSION`); the version (`MARKETING_VERSION`) only for a
   new store release.
5. `npm run env:production && npx cap sync ios`, then in Xcode: device "Any iOS Device" → Product → Archive →
   Distribute App → App Store Connect → Upload. `npm run env:staging` afterwards; `git diff www/env.js` must be empty.
6. The build appears in App Store Connect → TestFlight after processing (usually under an hour). Answer the export
   question: the app uses only standard HTTPS, so "None of the algorithms mentioned above".

## Push keys
- iPhone (APNs): developer.apple.com → Certificates, IDs & Profiles → Keys → "+" → tick Apple Push Notifications
  service → download the `.p8` (downloads once only). Put it in the Worker:
  `npx wrangler secret put APNS_KEY_P8 --env staging < AuthKey_XXXX.p8`, then `APNS_KEY_ID` and `APNS_TEAM_ID` the
  same way. Without `--env staging` for production. Test: `POST /api/app/push-test {admin_key, phone}`.
- Android (Firebase): not built yet. The Worker needs a service-account key and a sender written for FCM HTTP v1.

## The push switch
KV `cfg:app_push` = `1` turns sending on. Staging: `npx wrangler kv key put --env staging --binding RATE cfg:app_push 1`.
Production stays off until Richard says so.

## TestFlight (iPhone testers)
- Internal testers (people on the developer account): no review, the build is available as soon as it is processed.
- External testers (anyone by email or public link): the first build goes through a short Beta App Review.
- Testers install the TestFlight app, open the invitation on the phone, install ishur.

## Google Play closed test
Personal accounts made after 13/11/2023 must run a closed test with at least 12 testers opted in for 14 days in a
row before production access (Google's page, read 20/11/2026). Testers need a Google account; add their emails to
the closed-test list, send them the opt-in link, and they must keep the app installed for the 14 days.

## When Apple rejects
1. Read the message in App Store Connect → the version → Resolution Center. It names the guideline number.
2. The usual ones for this app: 2.1 (demo account did not work: check the reviewer demo client on production),
   4.2 (looks like a website: point to notifications, offline copy, help, calendar), 5.1.1 (sign-in or deletion),
   3.1.1 (anything that looks like buying: there must be no price, no buy button and no "buy on the website" text).
3. Fix, raise the build number, upload, and reply in the Resolution Center with what changed. Or, if the reviewer
   misread, reply with an explanation and screenshots without a new build.

## The reviewer demo client
Not built yet (spec R11). Needs: a fixed phone and code on production that never expire, invented guests, no
message ever sent from it, and not blocked by the sign-in limits.

## Not written yet
Android build and signing (no Android tools on this Mac yet), FCM sender.
