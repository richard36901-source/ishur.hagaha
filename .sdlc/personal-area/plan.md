# personal-area · plan (Claude, 12/11/26) — implements spec.md

## Files / resources that change
| Path | Change |
|---|---|
| `worker/account.js` (new) | all personal-area logic: OTP ladder, session mint/verify, `me`, `contact`, `logout`, `review-claim`, credit ledger helpers, `routeOf(nps,exp)` (≥6). Pure functions exported for tests; handlers take a `deps` object like raffle.js. |
| `worker/whatsapp.js` | `sendOtpTemplate(env, to, code, channel)` gains the channel arg; `ishur_kod` is exempt from the client-only block when sent on `guests` (the one template both numbers may send). |
| `worker/index.js` | router: `/api/account/*` → `handleAccount`, `/api/review-claim` → `handleReviewClaim`; `/api/feedback` keeps `>= 6` but answers with `scored/video/google/balance_ils`; `handleOtpSend` (dashboard gate) uses the same ladder; one admin route `/api/account/setup-template` that submits `ishur_kod` on the guests WABA (run once, only on Richard's OK). |
| `account.html` (new) | login card → events list → credit card → contact card → install card; `?mock=1` fixture; theme bootstrap like dashboard.html; radius ≤ 8px. |
| `manifest-account.webmanifest` (new) | start_url/scope `account.html`, same icons/colours. |
| `feedback.html` | after the text: choice screen (video ₪30 / Google ₪20 / not now) → step → thank-you with the other kind; `?step=` deep link; raffle branch untouched. |
| `config.js` | endpoints `account-otp`, `account-login`, `account-me`, `account-logout`, `account-contact`, `review-claim`; `v` bump on the pages that load it. |
| `dashboard.html` | one link "האזור האישי" under the header subtitle. |
| `terms.html` | §9 withdrawal line + "או מהאזור האישי". |
| `worker/test/account.test.mjs` (new) | P1 cases. |
| `docs/ops-screens/account-*.png` | P4 screenshots. |
| KV keys (new) | `acctotp:<phone>`, `acctsess:<nonce>`, `credit:<phone>`, `contact:<phone>`; `fb:<token>` gains `video_at`/`google_at`. |

## Order of work (each step = one commit, each verifiable)
1. `account.js` pure parts + tests: `routeOf`, `ledgerBalance`, `sessionToken/verify` (HMAC with ADMIN_KEY), `pastOf(date, today)`, `eventsView()`.  Check: the new test file passes on those units.
2. OTP ladder: `whatsapp.js` channel arg + exemption; `account.js` `sendLoginCode(env, phone, code, {email})` → Noa → guests → email; wire `handleOtpSend` to it. Check: tests with a fetch stub that answers 131042 on Noa's phone id and 200 on the guests id; existing `node --test` still green.
3. Routes: `/api/account/otp|login|me|logout|contact`, `/api/review-claim`, `/api/feedback` response fields, `config.js` endpoints. Check: P1 end-to-end cases through `worker.fetch`.
4. `account.html` + manifest + dashboard link + terms line. Check: P3 (syntax, lux.css, pwa.js, data-theme, radius grep).
5. `feedback.html` choice flow. Check: `node --check` on its script; mock walk-through in the browser (scores 6/6 → choice → video → thank-you → Google → done).
6. P4 browser pass on account.html at 375 px + screenshots; P2 ops smoke.
7. `setup-template` admin route (code only; not run). Deploy: push branch → main, `wrangler deploy` from ishur-deploy, P5 curls.
8. Richard's "שלח": live OTP to 0545764327 (P6), optionally run `setup-template` on his OK; write `report.md`.

## Risks and mitigations
- **131042 on every Noa send** → the ladder's guests step; if the `ishur_kod` template does not exist on the guests WABA the step answers 132001 and the ladder moves to email. The template is created by the admin route only after Richard's OK.
- **Guest daily budget**: a code from the guests number counts as one template in the 250/day budget (negligible), and is refused when the budget is exhausted → email/`send-failed`.
- **Session forgery**: HMAC with ADMIN_KEY + KV row check; tampered sig → 403 (tested).
- **KV eventual consistency** right after login: the signature verifies without KV, the KV row is only consulted for revocation (missing row ≤ 60 s after mint is tolerated by storing `at` in the token's KV write and treating "no row" as valid only when the token is < 2 min old).
- **Double credit**: claim is idempotent per (token, kind) via `fb.<kind>_at`; 409 `already`.
- **Email binding not enabled**: `sendEmail` answers `email-domain-not-enabled` → `send-failed` with `why` in the log; P6 reveals it.
- **feedback.html regression for the raffle**: the raffle branch is entered first when `RAFFLE.on`; the credit flow is the else branch.
- **Rollback**: every step is its own commit; `git revert` + `wrangler deploy`; new KV keys are inert for the old code.

## Proof strategy
P1 after steps 1–3 (and on every later step), P3 after 4, browser mock after 5, P4 + P2 after 6, P5 after 7, P6 after 8. Report in `report.md`.
