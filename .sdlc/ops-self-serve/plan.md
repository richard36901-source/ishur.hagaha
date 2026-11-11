# ops-self-serve · plan

Every question from the 10–11/11 chat → where it will be answered on the screen.

| Richard asked | Screen answer |
|---|---|
| "נשלח היום?" / "למי מחר?" | **היום / מחר** table: per event → wave, sent today, left in wave, planned tomorrow, position in line |
| "כמה יצאו למור / לשוהם?" | per-event count by day (from `wsent:` TTL buckets), matches the client dashboard |
| "למה יצאו כל כך קצת?" | **למה נעצר** line: which gate truncated the last tick (cap / window / share / hold / paused / Shabbat) with the exact numbers |
| "ישתחרר היום? מתי? עד איזה שעה?" | **מונה לייב**: ours used/limit (gsendh, both numbers), Meta used/250 (bic), free now, **release timeline** (each `gsendh` bucket frees at h+25 → "12:00 +128, 17:00 +99"), ETA to finish each event at 25/min inside the send window |
| "כמה נשאר למור מחר?" | left-in-wave minus what fits today, carried to tomorrow |
| "4499 תשלום תקין?" | **4499** card: `billingalert:client` flag + since when, last 131042, last successful client template |
| "אימות העסק אושר?" | verification status + "checked at" (auto if token allows, else manual stamp + link to Meta security center) |
| "נשלח לאורחים" Slack notes | list of today's `wnote:` keys with event + wave + time (so he can confirm without opening Slack) |

## Files / resources
- `worker/index.js`: new `GET /api/ops/live` (admin) — assembles: `guestCapacity()`, `readHourBuckets` per number → release timeline, `bic:` count, `pacer:last`, `engine:lastrun`, `sendWindowState()`, `sendingPaused`, `waveorder`, `waveprio:`/`wpused:`, `wave:`/`wpos:` per event, `wsent:` per event per IL-day (expiration−TTL), `billingalert:client`, `wnote:` today, `capheld:` today.
- `worker/live.js` (new, pure): `releaseTimeline(buckets, limit, now)`, `etaFinish(remaining, releases, paceSends, window)`, `dayCounts(wsentKeys)` — unit-tested.
- `assets/ops/screens/live.js` (new) + tab link in `ops.html` (`#/messages?tab=live`) + compact card on `overview.js`; auto-refresh 60 s; lite.js cache key added.
- `worker/index.js` 09:00 Slack digest: add 3 lines — today's plan per event, release times, 4499 state.
- `.claude/launch.json` unchanged; deploy per the usual routine (tests → ops-ui-smoke → wrangler deploy → push main).

## Order of work
1. `live.js` pure functions + tests (release timeline, ETA, day counts). Pass: `node --test test/live.test.mjs` green; timeline for yesterday's real buckets yields 12:00 +128 / 17:00 +99.
2. `/api/ops/live` endpoint. Pass: `curl` returns `ok:true`, `meta.used` == `bic:` count, `ours.used` == sum of gsendh buckets, per-event `sent_today` == wsent bucket count for today.
3. Screen + overview card. Pass: `node scripts/ops-ui-smoke.mjs` green; page renders all 8 rows of the table above with live data; no "לא נשלח" string.
4. Slack digest lines. Pass: dry-run digest text contains "משתחרר ב-" and "4499".
5. Deploy; verify at 12:00/17:00 release that the counter moves without a reload.

## Risks
- KV `list()` lag (never enforce anything from counts — display only; memory rule).
- Subrequest budget: wsent list is ~700 keys; use one prefix list per tick, cached 60 s in KV (`live:cache`).
- Verification polling may 403 on the token → fall back to manual stamp, never block the screen.

## Decisions needed before step 2
- (dropped) per-number scope — Meta: 250 per business while unverified; revisit on approval.
- Margin 20 → 10.
