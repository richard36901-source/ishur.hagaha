# client-app · intent (20/11/2026)

## Problem
Clients follow their event on a web board (`dashboard.html`). They learn that a guest answered only by opening it.
Richard wants a real app in the App Store (priority) and Google Play (secondary) that tells the client what happened
("דנה אישרה הגעה, 3 מגיעים", a daily summary, "ההזמנה לא הגיעה ל-6 מוזמנים"), and it must pass store review on the
first submission.

## Outcome
An ishur client app, live in the App Store and then Google Play, where a client signs in with phone + code, sees the
event and guest list natively, gets push notifications about answers, and a human can ship an update from a runbook.

## Affected systems
- New folder `app/` in this repo (branch `client-app`, cut from `staging`).
- Worker `ishur-webhooks` (staging first): new push routes and a push sender. No change to existing sign-in routes.
- Apple Developer account, App Store Connect, Google Play Console (Richard's accounts, opened by him).
- `terms.html` (privacy section: add the app and push), a small public support page.

## Constraints
- The sign-in behaviour Richard approved on 18/11 does not change on the web. The app uses the same phone + fixed
  4-digit code the board gate already accepts.
- Anything touching sign-in, the board, config.js, guard.js, sw.js or the status route: staging, `staging-check.mjs`,
  then production. First real `promote.sh` is Richard's call.
- No messages to clients/guests/leads without "שלח". Push payloads carry no guest phone numbers.
- Nothing critical depends on Claude: build + release runbook for a human.
- Brand: light default, dark per device, radius ≤ 8px, no error wording on client screens.
- Richard never hands over credentials or payment details; he opens the accounts himself.

## Found on 20/11 (read live on this Mac)
- Xcode is not installed (`xcode-select -p` → CommandLineTools, no simulators) and the disk has 16 GB free.
  Nothing can be built or run for iOS until Xcode is installed and space is freed.
- No Android SDK either.
- The site's `config.js` treats `localhost` as staging and the Worker refuses unknown origins, so a bundled app
  cannot reuse the site's config as is. The app gets its own config.

## Open questions for Richard
1. App display name (default proposal: "ishur" with subtitle "אישורי הגעה לאירוע").
2. Push at night: a guest who confirms at 23:00. Proposal: no push 21:00–09:00, held into the 09:00 summary.
3. Add-ons that cost money (call rounds, hostess): proposal for version 1 is that the app does not sell anything and
   hands off to WhatsApp, to keep payments out of the review.
4. Reviewer demo account: a demo client on production that can never send (needs his OK, goes through staging first).
5. Seller name: enrol now as Individual under his personal name, or wait for a בע"מ + D-U-N-S.
