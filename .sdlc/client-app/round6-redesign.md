# client-app · round 6: the app's layout, sign-in, buying, schedule (plan for approval)

Status: **draft, waiting for Richard**. Nothing in this file is built. Written 20/11/2026 from Richard's message that evening.
Rule for this round: no code on `client-app` until Richard answers question 1 below; about 65 commits already wait for one promote.

## What Richard asked for (his words, shortened)

1. **שליחות**: all settings, how the invitation looks, wording and so on, including links, except the group link.
2. **ראשי**: the status, and the buttons that sit above the guests on the board (budget, seating). Add an event schedule ("לוז אירוע") with recommendations by venue, where they leave from, chuppah and reception times, and one button that puts the whole schedule into Google Calendar or Apple Calendar.
3. **מוזמנים**: the guest list only here; the list for printing; replacing the list; both ways of adding guests (within the quota, and the 10 extra).
4. **חשבון**: "recommend us" with its tiers and credits.
5. **Event picker**: someone with several events taps and gets a dropdown, or a page with all events and an "add event" button.
6. **Add-ons** (hostesses and so on) need a place, maybe in שליחות.
7. Plan it all properly: most convenient for clients, within Apple's rules, so they can upgrade, add things, manage the event, buy more events; a new event starts with the full onboarding (file upload and so on).
8. **Sign in with Apple or Google** in the app. The website keeps the code as today. In the app: a client with a code types it once, is then asked to connect Apple or Google to continue, and from then on that client signs in to the app only with Apple or Google.

## Added by Richard later the same evening

9. **My package**: a place that shows the terms and everything included in the package they bought, with an option to upgrade. So maybe all add-ons and upgrades live in חשבון, and adding another event too.
10. **A page of all events**: one row per event; an event that has passed is greyed and moves to the bottom, with a way to leave a review of that event. Or: on opening the app after the event, the client is taken to a review with a 1 to 10 score. A high score offers a Google review or a video; a low score asks why and is kept with us. Or simply an internal review in the app.
11. **Rate the app**: ask from time to time.

## 1. Where everything goes

Lines marked (reading) are Claude's interpretation of Richard's wording, to confirm.

| Today on the board | Tab | Note |
|---|---|---|
| Event name, date, countdown | ראשי | with the event picker in the header |
| המצב (six tiles, with the venue commitment) | ראשי | |
| Progress bar under the tiles | ראשי | |
| מעקב תקציב, סידורי הושבה, צ'קליסט (the row of buttons) | ראשי | |
| **לוז אירוע** (new) | ראשי | section 5 |
| קישור לקבוצה | ראשי | (reading) "except the group link" means it stays out of שליחות; it could also sit in מוזמנים |
| רשימת המוזמנים, filters, search | מוזמנים | not shown on ראשי any more |
| רשימה להדפסה | מוזמנים | |
| החלפת רשימה (upload a new file) | מוזמנים | |
| הוספת מוזמן within the quota + the 10 extra | מוזמנים | the counter stays visible |
| לוח השליחות (what goes out, when, change a date) | שליחות | |
| ההזמנה שלכם (image or video, wording, "how guests see it") | שליחות | |
| עיצוב ההזמנה (style) | שליחות | |
| Links in the message: Waze, Bit, PayBox, gifts | שליחות | |
| הסעה and other extras of the message | שליחות | |
| תוספות לאירוע (hostesses, phone calls, extra send) and upgrades | חשבון | Richard's second message moved them here from שליחות; hidden until section 4 is settled |
| **החבילה שלי** (new): what the package includes, its terms, upgrade | חשבון | what is included can ship in 1.0; the upgrade button waits for section 4 |
| **כל האירועים** (new): a row per event, past events greyed and last, review button on a past event | the page behind the event picker | section 7 |
| המלצה עלינו, tiers, credits | חשבון | |
| חשבונית | חשבון | |
| כל האירועים שלי + הוספת אירוע | חשבון, and the picker in the header | "add event" depends on section 4 |
| Notifications, help, WhatsApp, privacy, sign-out, delete account | חשבון | as today |

## 2. How the split is built

Today ראשי is the whole board in a frame, and מוזמנים and שליחות are the app's own slim screens (they double as the offline copy).

**Proposed: one board, four views.** The app opens the same board with `&app=1&view=home|guests|sends|account`; each view shows only its cards. The website's board does not change, because the view switch runs only in app mode.

- Why: printing, replacing the list, adding guests, the invitation editor and the send dates already work in the board. Rebuilding them as native screens is weeks of work and a second copy to keep in step.
- The app's own slim screens stay as what you see with no network.
- Risk: Apple's 4.2 asks that an app be more than "a repackaged website". What carries the app: native tabs, notifications, the offline copy, the help centre, sharing, the calendar button. (reading) enough, but it is a reviewer's call.

## 3. Sign in with Apple or Google

Flow in the app:
1. First time: phone + code, as today.
2. Straight after: "connect Apple or Google to continue". The Worker stores the link between that Apple or Google identity and the phone's account.
3. From then on, that phone cannot sign in to the app with the code; the app offers only the Apple and Google buttons. The website keeps the code.

What has to be decided or supplied:
- **Apple's rule 4.8** (fetched 20/11): an app that uses a third-party login such as Google "must also offer as an equivalent option another login service" that limits data to name and email and lets people hide their email. Sign in with Apple is that option, so offering both, as Richard wants, satisfies it.
- **Lost Apple or Google account**: the client writes to us on WhatsApp and an admin unlinks; then the code works once more in the app.
- **Apple's reviewer**: the demo client stays on phone + code with no linking step, and the review notes say so.
- **New people with no phone and no code** signing up in the app: only needed once buying in the app exists (section 4).
- **Delete account** must also remove the link. Unverified: whether Apple requires revoking the Sign in with Apple token on deletion; check before building.
- **Richard supplies**: the "Sign in with Apple" capability on the App ID, and Google OAuth client IDs (iOS and Android) from Google Cloud.
- Store answers change: the app would collect an email address (or Apple's relay address).

## Decided by Richard, 20/11/2026 late evening

"הכל כרגע ללא תשלומים ... הכי חשוב שנגיש אפליקציה שאנשים יוכלו להשתמש ומקסימום כל השדרוגים יהיו רק בווב."

- No payments in the app for now. Upgrades, add-ons and buying another event happen on the website only.
- What follows for the app (Israel storefront): no buy button, no price, and no text or link that sends people to the website to buy; Apple's rule quoted in the research file says apps may not encourage other purchase methods in the app outside the United States storefront. Clients hear about upgrades from us on WhatsApp, outside the app.
- The app shows what the client already has: "my package" (what is included, the terms) and every event bought on the website, which appears in the app by itself.
- So checks P7 and P13 (no prices, nothing that sells) stay exactly as they are, and the spec lines "Payments: none" stay true.
- Section 4 below is kept for the day buying in the app is reopened.
- Still open: whether sign-in with Apple or Google and the event schedule go into the first submission or into updates.

## 4. Buying: add-ons, upgrades, another event

Not designed yet. First the payment rule has to be settled, because it decides the whole flow and who takes a cut.

Apple's text, fetched 20/11/2026:
- 3.1.1: "If you want to unlock features or functionality within your app ... you must use in-app purchase."
- 3.1.3(e): "If your app enables people to purchase physical goods or services that will be consumed outside of the app, you must use purchase methods other than in-app purchase to collect those payments, such as Apple Pay or traditional credit card entry."
- 3.1.1(a): linking out to buy digital content needs an entitlement outside the United States storefront.

(reading) Hostesses at the venue and phone-call rounds to guests are services consumed outside the app. The RSVP package itself (WhatsApp invitations to guests of a real event) can be argued either way, and a reviewer decides. With in-app purchase Apple takes its commission; under 3.1.3(e) payment is by card or Apple Pay with no commission.

Google's payments policy was not fetched: unverified.

This conflicts with what is written today, and each is Richard's to change, not a check to loosen quietly:
- spec "Policy flags": "Payments: none in the app"; "Out of scope (version 1): buying anything".
- checks P7 (no prices or buy wording in the app) and P13 (nothing that sells, no ₪ on screen).
- the store drafts: review notes say "the app has no sign-up and sells nothing".

## 5. Event schedule and calendar

- **What the client gives**: venue (already known), where they leave from, reception time (already known), chuppah time.
- **What the app proposes**: a schedule worked back from the chuppah: getting ready, photos, leaving, arriving, reception, chuppah, meal, dancing, end. Every line can be edited.
- **Travel time**: the spec says no new paid service. So in the first version the client types the drive time, with a button that opens Waze for the route. An automatic travel time needs a maps service that charges past a free quota; that is a cost decision.
- **Calendar button**: the app hands the phone one calendar file with all the lines; the phone offers Apple Calendar or Google Calendar. No calendar permission and no new privacy answer. Unverified: whether pressing it again updates the same entries or adds a second set in Google Calendar; test before promising "update".

## 7. Reviews after the event, and rating the app

What exists today: the board shows a "תודה שחגגתם איתנו" card after the event, `feedback.html`, and the Worker keeps a review state per event with a claim for a Google review or a video (`worker/account.js`). The app should reuse this, not build a second one.

Proposed:
- After the event date, the first time the client opens the app, a review screen comes up: a 1 to 10 score and an optional line of text, saved with us. It can be closed once with "לא עכשיו" and stays available on the event's row.
- After the score, the same next step for everyone: the Google review link and the video option.

Two rule points, both from memory and **not fetched today**, to check before building:
- **Offering the Google review only to people who gave a high score** is what Google calls review gating, and Google's review policy forbids it. The safe version shows the Google link to everyone and asks low scorers "what went wrong" as well, not instead.
- **Rating the app itself**: Apple wants its own rating prompt to be used and limits how often it appears (about three times a year); a home-made "rate us in the App Store" prompt can be rejected. So "from time to time" is Apple's prompt, triggered by us after a good moment (for example after a guest confirms).

A review that blocks the app until it is filled is Richard's call; Claude's recommendation is one skip.

## 6. Proposed order of releases

Putting all of this into the first submission moves the launch from about a week after Apple activates the account to a month or more, and puts the riskiest review question (payments) in the first review.

| Release | What | Why this order |
|---|---|---|
| **1.0** | What is built now + the four views (sections 1, 2) + event picker and the all-events page, without "add event" + "my package" (what is included, no upgrade button) + the review after the event and Apple's rating prompt (section 7) | Ships soon; no payments in the first review |
| **1.1** | Sign in with Apple or Google (section 3) | Needs Richard's capability and OAuth clients |
| **1.2** | Event schedule and calendar (section 5) | Self-contained, no rule questions |
| **1.3** | Buying: add event with onboarding, add-ons, upgrades (section 4) | After the payment rule is settled |

Each of 1.1 to 1.3 gets its own sdlc slug with intent, spec and plan.

## Questions for Richard, one at a time

1. Release order: section 6 as proposed, or everything in the first submission?
2. The group link: ראשי or מוזמנים?
3. Add-ons in שליחות, or their own place?
4. Buying: aim for card payment as a service outside the app, with in-app purchase as the fallback if Apple refuses?
5. Travel time: typed by the client, or pay for a maps service?

After question 1 is answered: update `app/PLAN.md`, the Linear task AUT-1141 and the timeline in both.
