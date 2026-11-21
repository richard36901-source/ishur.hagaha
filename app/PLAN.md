# Build app · ishur client app

The one file to follow. Claude updates it after every step. Last update: 21/11/2026, 03:20 (night). Richard asked for language support (21/11); waiting on scope. Running cost notes: `app/RUNBOOK.md`. App check 47/47 for both demo clients; Worker tests 1052/1052 with the clock at morning.

In Linear: [AUT-1141 Build app](https://linear.app/autoscalehq/issue/AUT-1141/build-app), project Ishur.io. Its 18 sub-issues are the **You** and **Together** steps below, numbered in order.

Legend: `[x]` done · `[ ]` open · **You** = only Richard can do it · **Claude** = Claude does it · **Together** = Claude does it, you sign in or approve.

## Milestones

| # | Milestone | Status |
|---|---|---|
| M1 | App built and checked on staging | done 20/11 |
| M2 | Apple Developer account active | paid 20/11, waiting for Apple (up to 2 days) |
| M3 | Server and site changes live on production | open |
| M4 | App signed, App Store record created | open, needs M2 |
| M5 | App on your own iPhone through TestFlight | open, needs M3 + M4 |
| M6 | Approved on the App Store | open, roughly two weeks after M2 (the redesign was added on 20/11) |
| M7 | On Google Play | open, 3 weeks or more |
| M8 | Real clients using it | open |
| M9 | Version 1.1: buying the next event in the app | later |

## Now: the next three things

1. **You:** tell Claude when Apple's "Welcome to the Apple Developer Program" email arrives.
2. **You:** read the store texts, icon and screenshots (step 2 below) and say yes or what to change.
3. **You:** say "promote" when you are ready for the server changes to go live (step 3 below).

---

## The redesign (round 6): decided 20/11, build starts 21/11

Plan: `.sdlc/client-app/round6-redesign.md`. Richard decided: no payments in the app (upgrades, add-ons and new events on the website only); sign-in with Apple or Google and the event schedule come as updates after the first submission.

**Version 1.0 now also includes** (Fable, from 21/11, on staging):
- [x] The board in four views, one per tab (20/11 night, staging): ראשי = status with the venue tile, seating, table codes, budget · מוזמנים = the list, print, replace list, add guests · שליחות = send schedule, invitation, wording, design, group link. Seen in the simulator for ראשי only; the other tabs are checked in Chrome. With no network each tab falls back to the app's own screen.
- [x] All-events page (from the header picker and from חשבון): a row per event, past events greyed and last, with a review button. Checked with one event only; the demo clients have no past event, so the greyed row and the review button are not exercised.
- [x] "החבילה שלי" in חשבון: package name, guest tier, every included line, add-ons bought, link to the terms. No prices (`worker/package.js`; a test fails if its lines drift from `config.js`).
- [x] Review after the event (21/11): the prompt on opening the app, one "לא עכשיו" then only "לדרג עכשיו", opens `feedback.html` inside the app; the past event is greyed and last on the events page with a review button. Checked with an invented past event injected into the account answer (no demo client has one). Apple's/Google's own rating prompt added (`@capacitor-community/in-app-review` 8.0.0): after more guests confirmed, from the third opening, at most every 120 days; not seen on a device. Checked 21/11 against Google's current text (contributionpolicy/answer/7400114, "Rating Manipulation"): merchants may not "selectively solicit positive reviews", and may ask for reviews only "without offering incentives". The live `feedback.html` does both: the Google review and video are offered only to scores of 6 and up, and each earns a credit (₪20 Google, ₪30 video). The same page opens inside the app and shows ₪ amounts there too. Changed 21/11 on Richard's yes (staging only): everyone is asked for a Google review after the text, with no credit and no raffle ticket; the video credit stays for high scores on the website; inside the app there is no credit, raffle or ₪. Checked by walking the page with a high score, a low score and in the app. The live website still has the old flow until the promote.
- [x] "המלצה עלינו" in חשבון opens the board's referral card inside the app. It shows discount and commission wording; whether Apple reads that as steering to buy elsewhere is an open risk to decide before submission.
- [x] Store texts (HE+EN), four screenshots (`store/screenshots/ios-6.9/`, 1320x2868) and the app check updated for the four tabs (21/11). App check 51/51 for both demo clients.

This adds work before the first submission: the "about a week after Apple activates" estimate becomes roughly two weeks. Not measured; revise after the four views are built.

- [x] Event schedule (לוז אירוע), moved into 1.0 on Richard's yes (21/11): button in ראשי, `schedule.html` (works on the website too). The client types where they leave from, the drive time and the ceremony time; "הצעה ללוז" works the day back from the reception (an hour at the venue, the drive, 15 minutes for traffic); every line editable; Waze button to check the drive. Calendar: Apple (webcal subscription) and Google (add by URL), one feed that updates itself (`/api/lineup.ics`, fixed ids). Seen working in the simulator: the app handed the feed to Calendar, which showed all 8 lines on the right day and times (`app/test/shots/17-calendar-subscribe.png`). Google Calendar button checked 21/11 in Chrome: Google opened its "Add calendar" dialog with the feed (cancelled, nothing added). Not tried: a change made after subscribing showing up in a calendar. Stored in D1 (KV served stale reads for a minute). The suggested times are Claude's first setting.

**After 1.0:** 1.1 sign-in with Apple or Google.

Decided 20/11: the group link sits in שליחות (moved from ראשי after Richard saw it). The review after the event can be skipped once. No open questions for 1.0; the build can start.

## Languages (round 7, 21/11): built on staging, checking
Plan: `.sdlc/client-app/round7-languages.md`. The client picks a language in חשבון; the app and every board page follow.
- [x] Languages: Hebrew + English, Russian, Arabic, French, Spanish, Yiddish, Amharic, Portuguese (about 1,600 texts each;
  written by Claude's translators, Portuguese and the personal-area texts by the other session). All need a native
  speaker's read before launch, Yiddish and Amharic most of all.
- [x] App screens: `app/www/i18n.js` + `app/www/i18n/*.json`. Picker in חשבון. Notifications follow the language.
- [x] Board pages: the site overlay `assets/i18n.js` from another session ("ishur - main ultra"), which now uses the same
  dictionaries and added Portuguese. One layer per page; the guests' table page stays Hebrew for now (their choice).
- [x] Every language checked (21/11 night, `app/scripts/i18n-check.mjs`): all 8 pass on the app's four tabs, the events
  page and five board pages: no Hebrew interface text left (names and invitation wording stay as written), right
  direction, nothing wider than the phone, the choice kept, the board follows the app. Hebrew unchanged: app check
  51/51 for both demo clients, Worker 1073/1073. Fixed on the way: the seating page's top bar pushed Save off a phone
  screen (in Hebrew too). Not checked: a real device.
- [x] Help centre in every language (21/11, `app/scripts/help-check.mjs`): all 9 pass on every topic and step: no Hebrew
  left, nothing in the moving pictures sticking out or wrapping, right direction, and every quoted button or tab name
  is the word the app uses in that language. Fixed: the typing line covered the field label in ru, fr, es, pt; the
  Hebrew help still sent people to ראשי to add guests and change send dates (since the redesign they are in מוזמנים
  and שליחות), and named buttons that no longer exist ("הוספה", "שיתוף קישור"); the offline שליחות screen said the
  same. The check opens the real staging board at each tab a step names and fails if the label is not shown there
  (it caught the old text). Six new sentences added to the app's dictionaries only; the site's copies
  (`assets/i18n/`, other session) were asked to take them. Translations unverified by native speakers, like the rest.
- [ ] Guest messages in other languages (Part B of the plan): waiting for Richard's answers, one at a time.

## Round 8 · feel like the apps people use every day (Richard, 22/11)
His words, shortened: the bottom bar like Apple's, WhatsApp's and Instagram's ("we need to be on the level of those
apps"; the Figma connection has those designs); maybe no constant top bar, or keep one so a screenshot that gets
shared carries our brand; on opening: the logo, "אישורי הגעה לאירועים", support WhatsApp 055-9504499 and the email
(info@ishur.io, from the site); loading with the logo and skeletons; in חשבון "צרו קשר" with WhatsApp and email
buttons; swipe from the edge goes back; dragging the page down hides the keyboard, "just like all the native iOS apps".
- [x] Language button off the board pages inside the app (22/11): the choice lives in חשבון only. Website unchanged.
- [ ] Bottom bar redesign (iOS tab bar look: blur, thin top line, filled icon when selected, labels 10pt).
- [ ] Top bar: waiting for Richard's choice.
- [ ] Opening screen: logo, "אישורי הגעה לאירועים", WhatsApp and email.
- [ ] Loading: logo, then skeletons in the shape of each screen.
- [ ] חשבון: "צרו קשר" with WhatsApp and email.
- [ ] Swipe back from the edge on every pushed screen (events, help, pages).
- [ ] Keyboard hides when the page is dragged down.
- [x] Cookie notice inside the app (22/11, Richard: "if we at all need it"): the app tracks nobody, so none is shown.
  Privacy and terms links now open in app mode; the home page's own notice also stays hidden in app mode.
- [ ] Appearance in חשבון: light, dark, or as the phone.
- [ ] Top bar decided 22/11: "Yes, like iOS apps" (a big title that shrinks to a thin bar on scroll, small logo kept).
Seating (22/11, same evening):
- [ ] Landscape: turning the phone gives a bigger floor to drag on.
- [ ] Tap a guest or a group, type the table, and they are seated there.
- [ ] Change or remove a table from the list only.
- [ ] Hide the guest list to lay out the venue first, then seat.
- [ ] First-time guidance at the right steps.
- [ ] Later: video guides in חשבון (after the app is finished).

## Claude's own queue (no approval needed, staging only)

Split on 20/11 at Richard's request: routine, well-specified work for Opus now; work that needs design judgment or carries production risk for Fable.

**Opus, tonight** (each has a check that says pass or fail)
- [x] Status-bar strip with the keyboard open: seen working in the simulator 20/11 21:26 (solid pine under the clock on both fields).
- [x] Simulator left signed in to the second demo client (150 invited) 20/11 21:26, on the notification question. To do it again: Phone and code: the way `app/test/app-check.mjs` reads them with `DEMO=2`. The simulator is slow: wait about a minute after launch, and several seconds after each tap before typing.
- [x] Board taps are counted without touching the board's markup: a control with no id is named by its first `data-*` attribute or its class (`assets/app-track.js`). `npm run check` 40/40, report lists `dashboard#t-skip`.
- [ ] Runbook `app/RUNBOOK.md`: write the "Not written yet" sections that need no account (signing steps, TestFlight, what to do on a rejection), from Apple's and Capacitor's docs.
- [x] The 3 Worker tests that fail in the evening: cause is the clock, confirmed 20/11 by running them with the clock moved 12 hours back (33/33 pass) and at 21:28 (3 fail). `crm.test.mjs:269` sets a reminder 3 hours ahead and expects it on today's agenda, so it fails from 21:00 to midnight. `slack-gate.test.mjs:96` and `:172` expect a "resolved" Slack line that is held back at night. The tests were not edited. Until someone fixes them, run `scripts/promote.sh` during the day.
- [x] `origin/main` merged into `client-app` and `staging` (20/11, commit c44595f). `worker/index.js` merged by itself; two conflicts resolved (`delete-account.html` kept ours, `registry-code.json` regenerated). Worker tests 1044/1044 with the clock at morning, staging smoke PASS, app check 40/40. Not pushed to origin.
- [ ] After each item: tick it here and in Linear AUT-1141.

**Fable, tomorrow** (design or risk)
- [x] Reviewer demo client, built and checked on staging (21/11). A helper's audit found that no send path in the engine skips test events, so the demo event is kept OUT of the sheet: it lives in KV `review:rows` and is added only to sign-in, the event list and the board status (`worker/review-demo.js`). Any POST naming the demo token or phone is refused (`demo-readonly`) except read/notes routes; the phone is never locked out. Checked on staging: seeded from the second demo event (60 guests), signed in after 8 wrong codes, saw only the demo event; guest-add, send-date, custom-template, event-change, addon-pay and otp-send all refused; a real client's request unaffected. Production: set `REVIEW_TOKEN`/`REVIEW_PHONE` in the production vars and seed with invented rows at the promote. Inside the app a refused action now shows "זה חשבון הדגמה: כאן לא נשלחות הודעות…" (21/11).
- [ ] The production release itself, when Richard says "promote": review the 55+ commits and 17 Worker files going live, the rollback, and the order of steps.
- [ ] Android notifications through Firebase from the Worker (service-account sign-in, tests). Nothing is written yet.
- [x] A Cloudflare Worker reaches Apple's push service (21/11): `POST /api/app/apns-probe` got Apple's own answer `InvalidProviderToken` from both hosts. The staging guard now lets staging talk to Apple's push hosts (only staging-registered test phones can receive). A real notification still needs Richard's push key.
- [ ] Version 1.1: does Apple require its own payment for buying an RSVP package, and the purchase flow that follows from the answer.
- [ ] Richard's adjustments after he plays with the app in the simulator.
  - 20/11 21:30, Richard: the empty sixth tile in the board's status grid should hold the commitment to the venue ("כאן תעשה ההתחייבות מול האולם"). Nothing like it exists in the board or the Worker yet. Built on staging 20/11 22:00 as Richard described it: the client types the number, the line under it is our recommendation, a tick when they agree (within 5 people or 5%). Recommendation = confirmed + half the undecided + 30% of the silent, shown once half of the invited people answered; those three numbers are Claude's first setting, for Richard to tune. `worker/venue-commit.js`, `POST /api/venue-commit`, app check 42/42 for both demo clients.
- [ ] Usage data: move to D1 if the token gets the permission; design of the report screen when Richard wants it.

## 1. Apple account (M2)

- [x] **You:** enrol in the Apple Developer Program as an individual and pay (20/11, ₪324.90 a year).
- [ ] **You:** wait for Apple's welcome email. Then tell Claude "Apple is active".
- [ ] **You:** on this Mac open Xcode → Settings → Accounts → "+" → Apple Account, and sign in. Claude cannot type your password.

## 2. What the store shows (your eyes needed)

- [ ] **You:** read the Hebrew and English texts in `app/store/listing.md`. Say yes or what to change.
- [ ] **You:** look at the icon `app/store/icon-512.png`. Say yes or what to change.
- [ ] **You:** look at the three screenshots in `app/store/screenshots/ios-6.9/`. Say yes or what to change.
- [x] **Claude:** app ID is `io.ishur.client` (cannot change after the first upload).
- [x] **Claude:** privacy answers and age rating drafted in `listing.md`.

## 3. Go live on production (M3)

Nothing in the app works for real clients until this is done. Today production has only the delete-account page.

- [ ] **Claude:** merge the 5 newer production changes into staging and rerun all checks.
- [ ] **You:** say "promote". Claude runs `scripts/promote.sh` (tests, smoke check, then site and Worker go live).
- [ ] **Claude:** create the demo client for Apple's reviewer on production: fixed phone and code, invented guests, cannot send anything.
- [ ] **Claude:** check on production: sign-in from the app, delete request, usage events.

## 4. Sign the app and create the store record (M4)

- [ ] **Together:** register the App ID `io.ishur.client` with Push Notifications (Xcode does it once you are signed in).
- [ ] **You:** create the push key. developer.apple.com → Certificates, IDs & Profiles → Keys → "+" → tick "Apple Push Notifications service (APNs)" → Download. The `.p8` file downloads once only. Tell Claude where the file is and the Key ID shown on the page. Do not paste the key in chat.
- [ ] **Claude:** put the push key in the Worker (staging first), send one test notification.
- [ ] **Together:** create the app in App Store Connect: name, language Hebrew, bundle ID, Israel only, free.
- [ ] **Together:** fill App Privacy, age rating and the review notes from `listing.md`. You press Save.

## 5. TestFlight on your iPhone (M5)

- [ ] **Claude:** switch the build to production servers, archive, upload to App Store Connect.
- [ ] **You:** install the TestFlight app on your iPhone, accept the invite email, install ishur.
- [ ] **You:** use it for a day with a real event. Tell Claude anything that looks wrong.
- [ ] **Claude:** fix what you found, upload again.
- [ ] **Claude:** check on a real phone what the simulator could not prove: the status-bar fix with the keyboard open, a real push notification, no tracking requests.

## 6. App Store review (M6)

- [ ] **You:** say "submit". Claude sends the build for review.
- [ ] **Claude:** answer the reviewer if they ask or reject. A first rejection is common; usually a small fix.
- [ ] **You:** when approved, say "release" (or let it release automatically).

## 7. Android (M7)

- [ ] **You:** register at play.google.com/console/signup, personal account, pay the one-time fee, verify your identity. Pick the developer name you want shown.
- [ ] **You:** on the sign-up screens, check whether Google asks for a closed test with 12 testers for 14 days before going public. Tell Claude what it says.
- [x] Android Studio not needed: the command-line SDK is installed instead (848 MB).
- [x] **Claude:** Android debug build works on this Mac (21/11, Java 21 + Android SDK installed): 5.9 MB, target API 36. Not yet run on an emulator (disk). Push on Android stays off until Firebase.
- [x] **Claude:** Android push sender in the Worker (`worker/fcm.js`, 21/11): tested against a generated key with Google stubbed; not yet against Firebase. Needs the Firebase file (step 13), then `androidPush: true`.
- [ ] **Claude:** run it on an emulator or a phone.
- [ ] **You:** create a Firebase project when Claude asks, download the service file, tell Claude where it is.
- [ ] **You:** if Google requires it, find 12 people with Android phones and send them the test link.
- [ ] **Together:** store listing, Data safety form, submit.

## 8. Real clients (M8)

- [ ] **You:** decide when notifications go on for real clients. Claude then sets `cfg:app_push` to on.
- [ ] **Claude:** add the store links to the WhatsApp message a new client gets and to the board.
- [ ] **You:** approve the wording of that message.
- [ ] **Claude:** each week, send you the usage report: how many clients opened the app, what they used, where they stopped.

## 9. Later

- [ ] **Claude:** a screen to read the usage report (you said not now, 20/11).
- [x] Usage data in a real database (21/11 00:20): Claude added Account → D1 → Edit to the Cloudflare token in Chrome, created `ishur-app-staging` (tables `app_events`, `app_users`) and bound it to the staging Worker. Checked: three events sent as the demo client landed as rows, and the report read them back. Production gets its own database (`sh worker/scripts/app-d1-setup.sh production`) as part of the promote.
- [ ] **Together:** version 1.1, buying the next event in the app. First decide with Apple's rules whether it must use Apple's own payment.

---

## Done so far (M1)

- [x] App screens: sign-in, the board inside the app, guests, send schedule, account, help with animations.
- [x] Delete-account request in the app, and the public page live at ishur.io/delete-account.html.
- [x] Notifications built on the server and in the app, switched off until you say so.
- [x] iOS build runs in the simulator; demo client signs in and sees the event.
- [x] App icon, three store screenshots, store texts in Hebrew and English.
- [x] No ad pixels, PostHog or site counter inside the app.
- [x] Usage tracking: what clients open and tap, on our own server, with a report.
- [x] Checks: app check 39/39 on staging; Worker tests pass except 3 older tests that fail only late in the evening (not from the app work, not yet looked into).

## Known gaps

- The status-bar fix: the first version (a fixed strip) did NOT work in the simulator, seen 20/11 21:22. A second version that follows the visible area is built and installed, not yet checked.
- Android has never been built: no Java or Android SDK on this Mac.
- Board buttons without an id are not counted in the usage report.
- Usage data sits in key-value storage; the report can lag by up to a minute.
