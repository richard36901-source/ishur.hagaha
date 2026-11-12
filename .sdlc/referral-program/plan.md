# referral-program · plan (stage 3) — draft for Richard, 12/11/26

Spec: `.sdlc/referral-program/spec.md` (approved fb1433f). Repo `ishur-deploy`, branch `integ-2026-11-02` (as today). Production deploy = `cd worker && node --test test/*.test.mjs && node scripts/ops-ui-smoke.mjs --no-browser && npx wrangler deploy`, then `git push origin HEAD:main`.

## Files / resources that change
| What | Change |
|---|---|
| `worker/referral.js` (new, pure) | code/mode rules, `discountPrice(p)`, `attribute(flat, kv, leadRow)`, record + ledger builders, `slackLine(rec)`, review credit table, `refSummary(code, recs, ledger)` |
| `worker/index.js` | routes `/api/referral` (GET public / POST client), `/api/ref-touch`, `/api/referrals`, `/api/referrals/act` (admin); hook in `processGrowPayment` after `creditReferral`; `createQuoteLink` passes `ref`/`cField3`; `/api/dashboard` adds `referral:{…}`; `/api/raffle/*` claim fallback when raffle off → `revclaim:` |
| `worker/paylink.js` | `priceQuote(b)` honours `b.discount_pct` on the package line only; `buildCode` adds `ref:<code>` |
| `worker/ops-plan.js` | one todo line "זיכויים ממתינים" when any unredeemed balance |
| `worker/test/referral.test.mjs`, `worker/test/referral-routes.test.mjs` (new) | P1, P2 |
| `config.js` | `GROW_LINKS_REF` (30 keys, empty), `refLink(code)`, `refPrice(p)`, bump `?v=` |
| `index.html` | `IshurRef` module next to `IshurPromo`: reads `?ref=` / `utm_source=referral`, cookie 30d, validates via GET, strikes prices + tag in `renderPlans` |
| `assets/popup.js` | discount path: `GROW_LINKS_REF` + `?cField3=`, or `payViaQuote` with `ref`; `POST /api/ref-touch` before redirect |
| `dashboard.html` | new הזמן חבר card (choice, link, stats copy, למימוש, ערכת שיתוף) |
| `share.html` (new) | canvas kit: 3 sizes × 2 variants, QR (qrcodejs from cdnjs as table.html), download + Web Share |
| `feedback.html` | high-score step shows credit copy (₪30 video / ₪20 review) when raffle off; claims go to the same endpoints with `kind` |
| `clients.html` | tab bar לקוחות / הפניות; referrals table + pending reviews; act buttons |
| `.sdlc/referral-program/grow-pages.md`, `noa-template.md` | Richard's Grow list; Noa template text (not wired) |
| Make scenario 7362541 | module 2 mapper `cField3: {{1.cField3}}` (Make MCP `scenarios_update`) |
| `scripts/referral-ui-smoke.mjs` (new) | P4, vm-sandbox like paylink-ui-smoke (no browser) |

KV keys (all new, prefixed, TTL 730d unless noted): `ref:<tok8>`, `refpend:<phone>` (30d), `refrec:<code>:<ref>`, `refidx` (list via prefix, no index key), `credit:<phone>`, `revclaim:<token>:<kind>`. Existing untouched: `refcred:`, `refdone:`.

## Order of work (each step = one commit, verifiable alone)
1. **Core module + unit tests** — `worker/referral.js` + `referral.test.mjs`. Check: P1 green. (nothing user-visible)
2. **Worker routes + IPN hook + paylink discount + dashboard payload** — index.js, paylink.js; `referral-routes.test.mjs`. Check: P2 + P3 green.
3. **Make scenario cField3** — via MCP, then `scenarios_get` shows the mapping; one minted test link (P6, unpaid).
4. **Site capture + 80% pricing + checkout** — config.js, index.html, popup.js. Check: P4 (index part).
5. **Dashboard card + share.html** — Check: P4 (dashboard + share parts).
6. **Reviews credit + admin tab + ops todo + Slack** — feedback.html, clients.html, ops-plan.js, raffle claim fallback. Check: P3 green again, ops-ui-smoke green.
7. **Docs for Richard** — grow-pages.md (30 rows), noa-template.md.
8. **Deploy + production checks** — deploy command, `curl` P5, simulated IPN P7 (test phone, `_simulated`), push `HEAD:main`.
9. **Report** — `.sdlc/referral-program/report.md` (verify-loop format).

## Risks and mitigations
- **IPN path is live money.** Every referral step sits in its own `try{}` after `ok` is decided (same as `creditReferral`); a thrown error logs a journal row, never changes the HTTP status Grow sees. Rollback: `npx wrangler rollback` (previous version) — no KV migration to undo.
- **Grow echo of cField3 unknown.** `refpend:<phone>` fallback is written by the site before redirect, so attribution works either way; `_simulated` replay tests both branches.
- **Double credit** (cField3 + lead row both match): the attribution returns one code; `refdone:<last9>` guards forever, as today.
- **Wrong tier parse** on the new page names: P1 asserts `parsePaidDesc` on "<N> מוזמנים <plan> · הנחת חבר" and `looksIshur` still matches (word מוזמנים).
- **Site regression for non-referred visitors.** `IshurRef` is inert without a cookie/param; renderPlans only changes when `IshurRef.active()`; P4 asserts plain render unchanged.
- **Branch.** `integ-2026-11-02` is ahead of `main`? Verified before deploy with `git log main..HEAD`; push stays `HEAD:main` as Richard's deploy line says.
- **No staging** — the dashboard card is the only visible change on day one; the discount path needs a `?ref=` link to activate.

## Proof strategy (which check after which step)
P1 after 1 · P2+P3 after 2 · P6 after 3 · P4 after 4 and 5 · P3 + ops-ui-smoke after 6 · P5 + P7 after 8 · report after 9. Nothing is "done" before its check ran and its real output is in report.md.
