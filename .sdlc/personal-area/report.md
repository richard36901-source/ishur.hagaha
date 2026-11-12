# personal-area · verify report (Claude, 12/11/26)

## What I checked and what it said
| # | Check | Result |
|---|---|---|
| P1 | `node --test worker/test/*.test.mjs` | 802 pass, 0 fail (14 in the new account.test.mjs: otp 404/200/429, ladder Noa→guests→email→502, login 5 tries + single use, me/403/logout, contact, feedback 6/6 high · 5/6 low, review-claim 30→50 idempotent, low-score 409, dashboard gate on the ladder, setup-template admin) |
| P2 | `node scripts/ops-ui-smoke.mjs --no-browser` | 267 passed, 0 failed |
| P3 | `node --check` on the inline scripts of account.html + feedback.html; grep | OK; lux.css / pwa.js / data-theme present; radii 4/6/8px, one 13px (the switch pill track) |
| P4 | account.html?mock=1 at 375 px, built-in browser | login card; 2 upcoming/past groups; past card shows only "⭐ ביקורת בגוגל · ₪20", older one "השאירו ביקורת"; credit ₪30 + למימוש; contact toggle; scrollWidth 375; dark by device OK; console errors = analytics CORS from localhost only. Screenshots docs/ops-screens/account-*.jpg |
| P7 | tour | "שלב 1 מתוך 5" → הבא → "שלב 2 מתוך 5" (הקודם + דלגו על הכל present) → דלגו → reload does not reopen (localStorage ishur_tour_account=skip). dashboard.html?demo=1: "שלב 1 מתוך 5", header link "האזור האישי שלי ›" |
| P5 | live, after the referral session deployed main (9929ae3) | `POST go.ishur.io/api/account/me {session:x}` → 403 `{"ok":false,"error":"bad-session"}`; login bad code → 403; review-claim bad token → 400; `ishur.io/account.html` → 200 with the Hebrew title; tour.js 200; config.js carries account-me |
| P6 | live code to 0545764327 | NOT RUN — waits for Richard's "שלח" |

## Attempts
- Tests: 2 runs. First failed in my own stub (it matched numeric Meta phone ids only). Code unchanged.
- Rebase onto main: 1 conflict (config.js endpoint map) resolved by hand; a second rebase after the referral session pushed was clean.
- Deploy: not run by me. ishur-deploy was held by the referral session (unpushed commits + budget vars); it pushed and deployed main including this code.

## What is NOT covered
- No real code was sent yet: the Noa → guests → email ladder is proven only against a stubbed Meta.
- `ishur_kod` does not exist on the guests WABA yet. `POST /api/account/setup-template {admin_key}` creates it (check:true reads only); needs Richard's OK and the admin key (I do not hold it).
- Cloudflare Email Sending for ishur.io: unknown whether enabled; the email step answers `email-domain-not-enabled` cleanly if not.
- iOS "add to home screen" with manifest-account.webmanifest is not tested on a device.
- The referral ledger entries (kind `referral`) are written by the referral-program build; this report covers review credit only.
