# Build app · ishur client app

The one file to follow. Claude updates it after every step. Last update: 20/11/2026, 21:30.

Legend: `[x]` done · `[ ]` open · **You** = only Richard can do it · **Claude** = Claude does it · **Together** = Claude does it, you sign in or approve.

## Milestones

| # | Milestone | Status |
|---|---|---|
| M1 | App built and checked on staging | done 20/11 |
| M2 | Apple Developer account active | paid 20/11, waiting for Apple (up to 2 days) |
| M3 | Server and site changes live on production | open |
| M4 | App signed, App Store record created | open, needs M2 |
| M5 | App on your own iPhone through TestFlight | open, needs M3 + M4 |
| M6 | Approved on the App Store | open, about a week after M2 |
| M7 | On Google Play | open, 3 weeks or more |
| M8 | Real clients using it | open |
| M9 | Version 1.1: buying the next event in the app | later |

## Now: the next three things

1. **You:** tell Claude when Apple's "Welcome to the Apple Developer Program" email arrives.
2. **You:** read the store texts, icon and screenshots (step 2 below) and say yes or what to change.
3. **You:** say "promote" when you are ready for the server changes to go live (step 3 below).

---

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
- [ ] **Together:** install Android Studio on this Mac (about 10 GB; the Mac has 12 GB free, so free more space first).
- [ ] **Claude:** build the Android app, run it, connect Android notifications (Firebase).
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
- [ ] **You:** add D1 permission to the Cloudflare API token so usage data can move to a real database.
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

- The status-bar fix (keyboard open on sign-in) is written but not yet seen working on a device.
- Android has never been built: no Java or Android SDK on this Mac.
- Board buttons without an id are not counted in the usage report.
- Usage data sits in key-value storage; the report can lag by up to a minute.
