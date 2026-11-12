# referral-program · verify report (stage 5) — 12/11/26, for Richard's acceptance

Built on branch `referral-merge` (= your `integ-2026-11-02` commits + `origin/main` personal-area), pushed to `main`
(site live on ishur.io), worker deployed (version `608b95ca-133c-4ce1-8c50-5cc547e2c4be`, BUILD_NOTE "referral-program הזמן חבר + personal-area merge").

## What ran, what it said, attempts
| # | Check (spec) | Command | Result | Attempts |
|---|---|---|---|---|
| P1 | rules module | `node --test worker/test/referral.test.mjs` | 7/7 pass | 1 (+1 after the ledger merge, pass) |
| P2 | routes + IPN through the real Worker | `node --test worker/test/referral-routes.test.mjs` | 10/10 pass | 1 (+1 after the ledger merge, pass) |
| P3 | no regression | `cd worker && node --test test/*.test.mjs` | **819/819 pass** (803 before the personal-area merge, 819 after) | 3 runs, all green |
| P4 | site/dashboard/share UI | `node scripts/referral-ui-smoke.mjs` | **44/44 pass** | 1 fail (my own regex, fixed) → pass |
| — | ops UI | `node scripts/ops-ui-smoke.mjs --no-browser` | 267/267 pass | 1 |
| P5 | deploy + production | `./deploy.sh` → Uploaded, Deployed · `curl go.ishur.io/api/referral?code=zzzzzzzz` → `{"ok":false}` (no other fields) · malformed code → `{"ok":false}` · unstamped `/api/ref-touch` → 403 · `/api/referrals` wrong key → `bad-admin-key` · `/api/raffle/links` → links + `{video:30,text:20}` · `/api/raffle/config` → `{on:false}` unchanged | all as specified | 1 |
| P6a | Make 7362541 | `scenarios_update` then `scenarios_get` | module 2 mapper now has `"cField3": "{{1.cField3}}"` | 1 |
| P4 visual | share.html live | built-in browser on `ishur.io/share.html?demo=1&v=…` | story / square / WhatsApp render, QR + link + hostess line-art, no console errors — `docs/referral/*.jpg` | 2 (the 1200×630 layout was cramped → own two-column layout → pass) |

## What is NOT covered (honest list)
- **P6b / P7 on production** (a real minted 80% link through Make, a simulated IPN replay on go.ishur.io): need the admin key, which this session does not have. Both paths are covered by P2 against the real Worker code with Make/Slack stubbed. To run them yourself:
  `curl -X POST https://go.ishur.io/api/pay-link -H 'Content-Type: application/json' -d '{"admin_key":"…","plan":"pro","records":300,"name":"בדיקה","phone":"05xxxxxxxx","occasion":"wedding","ref":"<code of a client who chose discount>"}'` → a Grow URL whose page says "הנחת חבר", sum 303 (do not pay it).
- **A real paid 80% Grow page end-to-end** — the 30 pages do not exist yet (`.sdlc/referral-program/grow-pages.md`); until then a discount checkout mints the link through Make.
- **Whether Grow echoes `cField3` on the IPN** — unknown; attribution does not depend on it (`refpend:<phone>` fallback, tested).
- **Noa post-event template** — text only (`noa-template.md`), nothing wired, nothing sent.
- **Hostess photography** — line-art in the kit until photos land in `brand/hostesses/`.
- **Dashboard card on a real client** — rendered from the API payload (tested), not eyeballed in a browser with a live token.

## Deviations from the plan (all logged in plan.md)
1. **Merged with personal-area** (landed on `main` while this was built): one credit ledger (`credit:<phone>`, account.js shape), reviews credit on claim there (₪30 video / ₪20 Google, no admin verification), its feedback.html wins. My duplicate review-claim route, pending-reviews admin section and feedback block were removed. Referral credit appends to the same ledger (tested together: review ₪30 + referral ₪76 = ₪106, readable by account.js).
2. **Built and deployed from a separate worktree** (`referral-merge`), because the shared checkout `/Users/richardtomskiy/ishur-deploy` carries another session's uncommitted worker edits (`GUEST_DAILY_BUDGET=2000`, `GUEST_PORTFOLIO_BUDGET=4000`, a graph tier read in index.js). Those are NOT deployed and NOT committed by me. That checkout's branch `integ-2026-11-02` is now behind `main`; whoever owns it should `git merge origin/main` there.

## What Richard has to do
- Create the 30 Grow pages (`grow-pages.md`) and paste the links into `config.js` → `GROW_LINKS_REF`, bump `config.js?v=`, run the smoke.
- Decide on the Noa template text (`noa-template.md`) and submit it to Meta; say "שלח" when it should replace `ishur_syum_v3`.
- Optionally run P6b/P7 with the admin key (commands above).
