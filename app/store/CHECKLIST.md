# Pre-submission checklist · ishur client app

Every line needs evidence (file, screenshot, command output) before Richard is asked to approve a submission.
Sources read on 20/11/2026: `.sdlc/client-app/research-2026-11-20.md`. State on 20/11/2026 in the right column.

## Apple (App Store Review Guidelines)
| # | Item | Rule | Evidence / state |
|---|---|---|---|
| A1 | App is more than the website: own screens, push, share sheet, offline | 4.2 | screens: `app/store/preview/`, check 37/37 on staging. Push: server side built and tested, not connected to answers, never sent to a device |
| A2 | No sign-up, no link to register, no web sign-in | 4, 5.1.1(v) FAQ | `www/index.html` has none |
| A3 | Account deletion can be started inside the app | 5.1.1(v) | built; check P6 passes on staging; not on production |
| A4 | Demo account in App Review Information, works on production, never expires | 2.1(a) | not built (needs Richard's OK) |
| A5 | Back end is on during review; reviewer network not rate-limited out | 2.1(a) | open |
| A6 | No purchase UI, prices or calls to buy | 3.1.1, 3.1.3 | P7 grep clean |
| A6b | No advertising pixels or analytics load inside the app (board app mode) | 5.1.2, ATT | check P13: zero tracker requests on staging |
| A7 | Push is optional, asked after an in-app explanation, per-kind switches, no marketing | 4.5.4 | server switches built; in-app permission screen not built |
| A8 | Privacy policy URL, and the policy names the app and push | 5.1.1(i) | `terms.html#privacy` exists; app text not added |
| A9 | Privacy labels: Phone number, Name, User ID, Contacts (guest lists), Device ID; none for tracking | App privacy | draft in `listing.md`; `/px` counter off in app mode (staging, P13/P14) |
| A10 | Privacy manifest in the build | third-party SDK rule | in the app target; present in the built bundle (simulator build 20/11) |
| A11 | `ITSAppUsesNonExemptEncryption` = NO (HTTPS only) | export compliance | set in Info.plist |
| A12 | Built with Xcode 26+ / iOS 26 SDK | upload requirement | Xcode 27.2, iOS 27.2 SDK; simulator build succeeds and the app launches to the sign-in screen on iPhone 18 Pro / iOS 27.2 (`store/preview/15-simulator-signin.png`); sign-in inside the simulator NOT yet done; no device or archive build yet |
| A13 | iPhone only, portrait; screenshots at the size App Store Connect asks for | screenshots | device family set to iPhone; screenshots open |
| A14 | Age rating questionnaire (no web access, no UGC, no chat, no ads) | age ratings | open |
| A15 | Availability: Israel only (non-trader under DSA) | DSA page | open (App Store Connect) |
| A16 | Support URL and marketing URL live | metadata | open |
| A17 | Name, subtitle, description, keywords in Hebrew (+ English) approved by Richard | 2.3 | texts in `listing.md`; decision delegated to Claude by Richard 20/11/2026, not read by him |
| A18 | App icon 1024, no alpha; splash | 2.3 | open (Richard approves icon) |
| A19 | Review notes: what the service is, that accounts are created when a client buys the service off the app, demo phone + code, how to see a push | 2.1 | open |
| A20 | Works on a clean install with no network (shows sign-in, no blank screen) and on the oldest supported iOS (15) | 2.1 | open |
| A21 | TestFlight build tested on a real iPhone | 2.1 | open |

## Google Play
| # | Item | Rule | Evidence / state |
|---|---|---|---|
| G1 | Closed test: 12 testers opted in for 14 continuous days | answer/14151465 | not started |
| G2 | Target API 36 | answer/11926878 | `android/variables.gradle` targetSdk 36 |
| G3 | Account deletion: in-app path + web link | answer/13327111 | in-app path built (staging); public page `delete-account.html` on staging, not on production |
| G4 | Data safety form: Name, Phone, Contacts, User IDs, Device IDs; encrypted in transit; deletion request available | answer/10787469 | open |
| G5 | Not a bare web view; we own the site | WebView policy | own screens |
| G6 | Privacy policy URL | User data policy | exists; app text not added |
| G7 | Store listing: icon 512, feature graphic 1024x500, phone screenshots, short + full description | listing | open |
| G8 | Content rating questionnaire, target audience (adults), ads: none | policy | open |
| G9 | Reviewer access instructions with the demo phone + code | App access | open |
| G10 | Upload key kept outside the repo, Play App Signing on | signing | open |

## Decisions
- App ID `io.ishur.client` (iOS bundle ID and Android application ID): kept. Richard delegated the decision to Claude on 20/11/2026 ("do it all yourself"); it cannot be changed after the first store upload.
