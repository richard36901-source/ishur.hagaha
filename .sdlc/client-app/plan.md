# client-app · plan (draft 20/11/2026)

## What changes
- `app/` (new): `www/` (screens), `capacitor.config.json`, `package.json`, `ios/`, `android/`, `test/app-check.mjs`,
  `store/` (listing kit + CHECKLIST.md), `RUNBOOK.md`.
- `worker/app-push.js` (new) + routes in `worker/index.js`: `/api/app/push-register`, `/api/app/push-unregister`,
  `/api/app/push-prefs`, `/api/app/push-test` (admin), `/api/app/delete-request`; a hook where a guest answer is
  recorded; the 09:00 summary inside an existing cron. Tests `worker/test/app-push.test.mjs`.
- `delete-account.html` (new public page), `terms.html` privacy section (app + push).
- Worker secrets (staging, then production): `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `FCM_SERVICE_ACCOUNT`.
- Nothing in `dashboard.html`, `config.js`, `assets/guard.js`, `sw.js` or the existing sign-in routes.

## Loops (each ends with its check run and read)
| # | Goal | Check | Needs Richard |
|---|---|---|---|
| 1 | App screens work in a browser against staging: sign-in, four tabs, offline | P1 P2 P3 P7 P8 | no |
| 2 | Worker push module + routes, tests green, deployed to staging | P4 P6 P11 | no |
| 3 | Listing kit, privacy answers, checklist skeleton, runbook draft, delete-account page | files exist, P6 curl | texts: his approval |
| 4 | iOS project builds, runs in the simulator against staging | P9 | Xcode installed |
| 5 | Push arrives on a real iPhone from staging | P5 | Apple account, .p8, his iPhone |
| 6 | Android build + closed test starts | P10, Play Console shows 12 opted in | Play account, 12 testers |
| 7 | Reviewer demo client + push hook promoted to production | P11, demo sign-in on prod | his OK for promote |
| 8 | TestFlight build, checklist all green, submit iOS | P12 | his approval to submit |
| 9 | Android production access request, then production release | Play Console state | his approval |

## Timeline (calendar dates, assuming Richard's items arrive on the day shown)
| Date | iOS | Android |
|---|---|---|
| 20–22/11 | Loops 1–3 (no dependency) | same code |
| 23/11 | Richard: Apple enrolment paid, Xcode installed | Richard: Play account opened, testers list started |
| 24–26/11 | Loop 4 simulator; Loop 5 push on device | Loop 6 build |
| 27/11–01/12 | Demo client + production promote (Loop 7); TestFlight; screenshots | Closed test opens once 12 testers opted in (target 30/11) |
| 02–03/12 | Checklist green, Richard approves, submit | 14-day clock running |
| 04–07/12 | Apple review (their figure: 90% under 48 h) → live | |
| 14/12 | | 14 days complete (if started 30/11) → request production access |
| 15–21/12 | | Google review of the request ("usually seven days or less") |
| 22–28/12 | | Production release + its review → live |

Plain reading: iOS in about 2.5 weeks (around 7/12) if the Apple account and Xcode are ready by 23/11 and there is
no rejection; every day of delay on those two moves the date by a day. Android is about 5 weeks (end of December),
not 3–4: 14 days + up to 7 days of Google review are fixed, and the clock starts only when the 12th tester opts in.
Apple's enrolment verification time is not published; I did not verify how long it takes for an Israeli individual.

## Risks
- **4.2 rejection**: bundled native-feeling screens, push, share sheet, offline, no web chrome; review notes explain
  the app's purpose and the demo account. Rollback: none needed; a rejection costs 2–4 days per round.
- **APNs from a Worker (HTTP/2)**: unverified. Test in loop 5 first thing. Fallback: FCM HTTP v1 for both platforms.
- **Reviewer cannot sign in**: demo client exempt from caps, checked from a clean network before submitting.
- **Push to real clients by mistake**: `cfg:app_push` off by default; staging has no inbound webhooks, so the test
  route is the only trigger there.
- **Sign-in regression on the web**: no existing route is edited; `staging-check.mjs` after each staging deploy.
- **Disk**: 16 GB free on this Mac on 20/11; Xcode with one simulator runtime needs more. Size not verified.
- **Seller name**: Individual enrolment shows Richard's personal name. Changing to a company later is possible
  per Apple but is their process; timing not verified.

## Proof strategy
Loop n runs the pass conditions in its row; the report (`report.md`) lists command, real output, attempts, and what
is not covered. Nothing is submitted to a store without Richard's explicit approval of that submission.
