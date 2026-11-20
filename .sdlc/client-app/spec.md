# client-app · spec (draft 20/11/2026, waits for Richard's approval of intent first)

Store rules below were read from Apple's and Google's own pages on 20/11/2026; quotes and URLs are in
`research-2026-11-20.md`. Policy text is not reviewer behaviour: 4.2, 3.1.3(e) and account deletion are judgment calls.

## Technology decision
**Capacitor 8, with the app's own bundled screens written in the repo's plain HTML/CSS/JS** (`app/www/`), not a
remote web view of `dashboard.html`.
- One codebase for iOS and Android; the same language as the rest of the repo, so whoever maintains the site can
  maintain the app. Official plugins for push, share, haptics, preferences. iOS project uses Swift Package Manager.
- Why not a remote wrapper of the board: guideline 4.2 ("beyond a repackaged website") is the main rejection risk,
  the board's service worker does not run under the app's scheme, and `config.js` would point `localhost` at staging.
- Why not SwiftUI + Kotlin: two codebases, two skill sets. Why not Expo/React Native: a new language and build
  service in a repo that has neither; no gain for review.
- The web board stays the full tool. The app covers the daily use: who answered, who did not, what goes out when.

## Requirements
R1. Sign-in screen in the app: phone + 4-digit code, against the existing `/api/account/pin-login` + `/api/account/me`
    routes (the `/api/status` phone+code branch needs the website stamp, found 20/11). No change
    to any existing route. "שכחתי את הקוד" opens WhatsApp to ishur. No sign-up, no link to register (keeps Apple
    5.1.1(v) FAQ and 4 out of the way).
R2. Tab bar with four tabs: סיכום (event, counts, next send), מוזמנים (tabs הכל / אישרו / לא בטוחים / לא ענו /
    לא מגיעים / נכשלו, search, pull to refresh), לוח שליחות (send schedule, read-only), חשבון.
R3. Several events for one phone: event picker.
R4. Offline: the last loaded state is shown with "עודכן ב-…" when there is no network. No error wording.
R5. Share: the group RSVP link through the system share sheet.
R6. Push: device registers its token with the Worker after the client agrees in an in-app explanation screen.
    Three kinds, each with its own switch in חשבון: guest answered, daily summary, invitation not delivered.
    Payload: first name of the guest, counts, event token id. Never a phone number. Not required for the app to work.
R7. Quiet hours: no push 21:00–09:00 Israel time; answers in that window go into the 09:00 summary. (Open question 2.)
R8. Account: sign out (revokes the session, removes the push token), delete-account request inside the app plus a
    public web page with the same request, privacy policy link, support link (WhatsApp).
R9. No purchase UI, prices or "buy" calls to action anywhere in the app (Apple 3.1.1 / 3.1.3). Add-ons: not shown.
R10. Light by default, dark by device setting, RTL, sizes in rem, radius ≤ 8px, brand colours
     (pine #0F2E22, green #0F4C35, gold #A8853C, cream #FAF8F1), the device system font (no font CDN).
R11. Reviewer demo client on production: a fixed phone + code that never expires, invented guests, cannot send.
R12. Runbook `app/RUNBOOK.md`: build, test, release an update on both stores, renew keys, without Claude.
R13. Store listing kit in `app/store/`: name, subtitle, description (HE + EN), keywords, screenshots at the sizes
     App Store Connect asks for, privacy labels answers, Data safety answers, age-rating answers, review notes.
R14. Distribution: Israel storefront only in version 1 (per Apple's DSA page this means no trader status and no
     address or phone on the product page).

## Pass conditions (machine-checkable)
P1 (R1,R3). `node app/test/app-check.mjs` signs in on a served `app/www` against go-staging with the demo phone and
   its code, lands on סיכום with the demo event's name; a wrong code stays on the sign-in screen with no word from
   the error list (`שגיאה|error|נכשל|failed|exception`) on screen. Exit 0.
P2 (R2). Same script: each of the six guest tabs shows a count equal to the count computed from the same
   `/api/status` JSON; search for one demo name leaves exactly the matching rows.
P3 (R4). Same script: after a load, network is cut, the app is reloaded, and the סיכום counts are still on screen
   together with "עודכן".
P4 (R6,R7). `node --test worker/test/app-push.test.mjs`: payload builder output never matches `/\d{7,}/`; a 23:00
   answer produces no send and appears in the 09:00 summary; an unregistered token is dropped after APNs answers 410.
P5 (R6). On staging: `POST /api/app/push-test` (admin key) to a registered token returns APNs status 200 and the
   notification is seen on a real iPhone. (Needs Richard's Apple account, `.p8` key and a device.)
P6 (R8). Worker test: `POST /api/app/delete-request` with a valid session writes a journal row and answers ok;
   without a session answers 401. `curl -s https://ishur.io/delete-account.html` returns 200.
P7 (R9). `grep -rnE "₪|מחיר|לרכישה|קנו|שדרג" app/www` returns nothing.
P8 (R10). `grep -rnE "border-radius:\s*(9|[1-9][0-9])px|fonts.googleapis" app/www` returns nothing; screenshots in
   light and dark are produced by the check script.
P9 (iOS). `xcodebuild -scheme App -sdk iphonesimulator build` exits 0 and the simulator sign-in reaches סיכום
   against staging (screenshot). (Needs Xcode on this Mac.)
P10 (Android). `./gradlew assembleDebug` exits 0. (Needs the Android SDK.)
P11 (existing behaviour). `scripts/staging-check.mjs` 13/13 and `scripts/smoke.sh staging` pass after every Worker
   deploy to staging; worker tests pass.
P12 (submission). Every line of `app/store/CHECKLIST.md` has evidence (file, screenshot or command output).

## Policy flags
- **Security/PII**: guest names and phones are shown in the app and cached on the device (app sandbox only). The
  session token is the existing 90-day `acct.` session. Push tokens stored per phone in KV, removed on sign-out and
  on APNs 410. Push text has no phone numbers. The APNs key and the Firebase service account are Worker secrets,
  delivered by Richard as files, never pasted in chat. Rate caps of the existing sign-in apply unchanged.
- **Review**: reviewer signs in on production. Sign-in caps (6/h per phone, 30/h per IP) must not block the demo
  phone; the demo client must be unable to send anything. Both need a Worker change that goes staging → production.
- **Payments**: none in the app.
- **Cost**: Apple 99 USD/year, Google 25 USD once. APNs and FCM are free. No new paid service.
- **Live clients**: no push goes to real clients until Richard says so; the push sender has an off switch
  (`cfg:app_push`), default off in production.
- **Unverified**: whether a Cloudflare Worker reaches APNs (HTTP/2 required). Tested in loop 4; fallback is FCM for
  both platforms.

## Out of scope (version 1)
Buying add-ons, editing the guest list, uploading guests, seating, gifts, partner and hostess screens, iPad layout,
EU storefronts, turning the board lock back on.
