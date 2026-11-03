# Integration 02/11/2026 — `integ-2026-11-02`

Branches merged, in order: `main-executer`, `audit-inbound-leads`, `feat-gifts-sendboard` (all three clean, 185 tests), then `audit-send-pipeline` (conflicts in `worker/index.js` ×7, `worker/whatsapp.js` ×4). The merge commit is `3143e96`.

Result: `node --test test/*.test.mjs` gives 217 tests, 217 pass, 0 fail. `npx wrangler deploy --dry-run --outdir /tmp/ishur-int-build` exits 0 with 1943 KiB (442.81 KiB gzip). Nothing was deployed, no KV was written and nothing was sent.

## 1. What was reconciled

**Single source of truth for cap, budget and reply number: `feat-gifts-sendboard`** (`worker/budget.js` + `guestCapacity`/`pickGuestPhone` in `worker/whatsapp.js`):
- one shared portfolio limit, 250 by default (or the real tier cached in `wa:cap`), minus a margin of 20. That gives **230 for all guest numbers combined**. `GUEST_CAP_SCOPE=number` switches back to per-number addition.
- rolling 24h = hourly buckets `gsendh:<pid>:<epoch hour>`, and used = max(day counter, rolling).
- each batch is cut to the room left before it sends (`fitBatch`).
- `gph:<guest phone>` pin: replies always leave from the number the guest wrote to, and templates prefer that number while it has room.

**Ported from `audit-send-pipeline` onto that model** (their parallel implementation was dropped):

| Audit behaviour | Where it lives now |
|---|---|
| Counts not lost when KV rejects a write (1 write/s/key) | isolate floor `floorFor(kv)` under the day counter and the hour buckets; `bumpHourBucket(kv, pid, now, floor)` returns the new count |
| Unique people, not sends (Meta's unit) | `noteGuestTemplate` + `gbic:<phone>` (24h); `post()` counts through it and skips `ctx.probe` sends |
| `GUEST_PORTFOLIO_BUDGET` | explicit shared limit in `guestCapacity`; `guestPortfolioBudget(env)` returns it, or 250 when unset |
| Replies never budget-gated, sent from the guest's number | gifts' `pickGuestPhone({template:false})`. The audit pin `gin:<phone>` was **folded into `gph:`**, and the webhook's `gin:` write was removed |
| Batch stops at budget / permanent error | event-day blast, thank-you and table sends `break` on `held`/`permanent` and keep the gift variants (`*_matana` + gift button) |
| `/api/cap-status` fields | `budget` = the `guestCapacity` object plus `portfolio_limit`, `per_number_limit`, `left`, `late_invites_waiting` (count of `lateinv:` keys) |
| Retry cap 3 per guest; 131042 gets no strike | auto-merged unchanged (`wcapn:` 3 cap-reopens, `wfail:`/`wdead:`) |
| All 11 P0 fixes | kept. The table message now uses `guestEventName(ev,{article:false})`, which replaced gifts' `eventDisplayName` (that one falls back to the client's name) |
| Send window gate in `runDailyEngine` | kept. `budget` stays `let` so the gifts `fitBatch` cut can still set it |

**Decision defaults applied**
- Postpone notice requires an explicit OK: `postponeok:<token>` must equal the new date (audit fix P0-5, unchanged).
- **D5: 3 attempts per guest per wave, for the wave's whole life.** The daily auto-retry (pacer `autoretry:`) no longer deletes `wfail:<token>:<wave>:<phone>`, so the strike count carries across days. Before this it reset daily and a guest could get up to 9 attempts in a 3-day wave. The manual `/api/wave-retry` still clears it, because that is a human decision.

## 2. Adapted tests

No test was deleted. In every case below the asserted behaviour is still checked; only the model or key name changed.

| Test | Change | Why |
|---|---|---|
| audit · *budget is rolling 24h* | `gsend24:<pid>` JSON → `gsendh` buckets. The original assertions (`B`, 220 left) now run with `GUEST_CAP_SCOPE=number` + margin 0. Added shared-default assertions (`B`, 20 left) | the per-number model is no longer the default, and the rolling store is now the gifts bucket format |
| audit · *buckets older than 24h no longer count* | `gsend24` → `gsendh`; added `left = 230` | the merged code ignores `gsend24`, so without the change the test passed without testing anything |
| audit · *default portfolio cap = per-number × numbers (460)* | now: default 250 shared and 230 left combined; 460 only with `GUEST_CAP_SCOPE=number` + margin 0 | it asserted the pre-decision default (audit D1), which Richard has since set to shared 250 − 20 |
| audit · *budget out → template held; reply from the number the guest wrote to* | pin seeded as `gph:` instead of `gin:` | there is one pin key now |
| gifts · *lint: table message never gets a definite article* | regex accepts `guestEventName` as well as `eventDisplayName`; `article: false` still required | the audit P0 swapped the builder |

Added: a D5 lint test (mutation-checked: putting the `wfail:` delete back fails it) and a `/api/cap-status` field test run through `worker.fetch`.

## 3. What this does NOT prove

- Real Meta behaviour. Tests use a fake Graph API and a fake KV. Whether the 250 limit really is shared across 6673 and 9799 rests on Meta's docs and the 02/11 evidence (see the audit doc §1), not on a live check.
- The isolate floor protects only within one isolate. Two isolates that both get rejected KV writes can still under-count. The margin of 20 is the buffer for that.
- `/api/cap-status` still reads the deprecated `messaging_limit_tier` from one number for its top-level `tier` field (audit note, not changed here). The enforced numbers are in `budget`.
- Audit decisions D2–D4 and D6–D9 are still open.

## 4. Deploy checklist

1. Deploy from this worktree only after Richard says go: `cd worker && npx wrangler deploy`. Never deploy from another worktree.
2. Re-run `node --test test/*.test.mjs` (expect 217/217) and the dry-run first.
3. Secrets that must already exist: `WA_TOKEN_GUESTS`, `WA_PHONE_ID_GUESTS`, `WA_TOKEN`, `ADMIN_KEY`, `SLACK_ALERT_HOOK` (check with `wrangler secret list`).
4. `GUEST_CAP_SCOPE`: new, optional. Default `portfolio` (shared limit). Set `number` only if Meta shows per-number limits.
5. `GUEST_BUDGET_MARGIN`: new, optional. Default `20`, subtracted once from the shared limit.
6. `GUEST_PORTFOLIO_BUDGET`: new, optional. Default unset, which means the tier in `wa:cap`, or 250. The audit recommended 230; with the margin, 250 already gives 230, so leave it unset unless Richard wants a hard number.
7. `GUEST_DAILY_BUDGET`: existing, optional. Default `230`. Per-number override when no tier is cached (`number` scope only adds them up).
8. `WA_APP_AUTOREPLY`: new (audit-inbound-leads), optional. Default is the built-in regex in `inbound.js`.
9. `WA_PHONE_IDS_GUESTS` (vars, already `1409632775565601`) and the `RATE` KV binding stay unchanged. Nothing to migrate: `gin:` was never deployed and `gph:` fills itself from the webhook.
10. After deploy: POST `/api/cap-status` and check `budget.scope=portfolio`, `limit=250`, `margin=20`, `remaining ≤ 230`, `late_invites_waiting`. Then watch one pacer tick in the journal for `held: cap` lines.
