# Audit: the automated guest send pipeline (02/11/2026)

Branch `audit-send-pipeline`, built on `main-executer` @ c3c9604, so it includes 30ea5ae, 4425386, fa3f07c, dbc143c and c3c9604. Nothing was deployed, nothing was written to production KV, and nothing was sent. The production reads were `/api/cap-status` and `/api/stream` (wa_out, wa_status, meta) for 02/11. File:line references are to this branch.

## 0. What the production data says (02/11, 03:40–14:33 UTC)

| Measure | Value | Source |
|---|---|---|
| Templates Meta accepted (HTTP 200) | 2,350 to guests | `/api/stream kind=wa_out` |
| Templates that later failed | 2,091: 131048 ×1,512, 131049 ×545, 131042 ×128, 131047 ×28, 130472 ×28, 131026 ×11 | `kind=wa_status` |
| Delivered or read | 254 | joined on wamid |
| Unique recipients delivered, both guest numbers together | **~251** (125 on …7584, 109 on …5601, 17 unattributed) | joined |
| First 131048 | 07:01:16Z on …5601 and 07:01:49Z on …7584, with **0** deliveries before it on either number | joined |
| Most times Meta accepted one template for one phone | 28 (yom_haerua / shulchan) | wa_out |
| Duplicate *delivered* messages (same phone + same template delivered twice) | **0** | joined |
| `/api/cap-status` (bic: keys) | tier TIER_250, used 2,423 in 24h, capped | live |
| Table message still sent at 14:33Z | `…מחכים לראותכם היום בהחתונה של הדר ויצחק` (double article; c3c9604 is not deployed) | wa_out |

**What the budget number should be.** Both numbers hit the cap within 33 seconds of each other, and together they delivered to about 250 unique people. That matches a single TIER_250 shared by the business portfolio, not two 250 caps. Meta's [messaging-limits doc](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits.md) says the phone numbers in a portfolio share its limit. Secondary guides date the move to portfolio-level limits to October 2025 ([YCloud](https://docs.ycloud.com/en/documentation/whatsapp-business-platform/pricing-limits-and-quality/messaging-limits-and-throughput.md), [WATI](https://www.wati.io/blog/whatsapp-api-rate-limits)). The unit is unique users reached by business-initiated (template) messages in a rolling 24h. Service replies inside a guest's 24h window do not count.

The rule "500 across the 2 numbers" therefore overstates the real limit by 2×, and so does the c3c9604 default (230 per number = 460). **Recommended: `GUEST_PORTFOLIO_BUDGET=230`** (250 minus a margin of 20). The code now enforces a portfolio cap. Its default keeps the old behaviour (230 × numbers) because the existing `guest-budget.test.mjs` encodes it; see decision D1. Note that `/api/cap-status` reads `messaging_limit_tier`, which Meta has deprecated, from one number only. The current field is `whatsapp_business_manager_messaging_limit`.

## 1. Findings

Severity scale: P0 = can send a wrong, duplicate or unwanted message to a guest. P1 = can miss a send or burn the cap. P2 = cosmetic.

### P0

| # | Where (before → now) | Failing scenario | Status |
|---|---|---|---|
| P0-1 | `eventDisplayName` fa3f07c: `ev[34] \|\| ev[2]`; `sendWave` hosts, `resendInvitation` hosts, dashboard guest-add hosts, guestFreeText "מי זה" reply | An event with an empty hosts cell (AI) tells every guest "החתונה של <paying client>". This is the incident's root pattern one level down: 30ea5ae fixed only the cases where ev[34] is filled. | **Fixed** de7e0c6. New `guestEventName`/`eventHosts` (index.js:4178) never read column C. Every guest template uses them. `eventDisplayName` keeps its tested contract for client-facing text. Lint and e2e tests cover it. |
| P0-2 | seating stage, index.js:5323 | 4425386 put `article:false` on the thank-you/wrap-up stage instead of the table stage, so the table message went out as "בהחתונה של …" (live log at 14:33Z). Thank-you and syum lost the article they had used since launch. | **Fixed** de7e0c6. Table: no article. Thank-you/syum: article restored. Pinned by the e2e test. |
| P0-3 | whatsapp.js `parseInboundReply` | "בטח שלא", "אשמח לדעת מה הכתובת", "אשמח אבל לא נוכל" and "כן, לא נוכל להגיע בסוף" were all written to the sheet as **מגיע**. "מגיעים ב-19:30" was written as party 19, "מגיעים 0" as party 0. Each was reproduced on the pre-audit code. | **Fixed** de7e0c6, 383bd1b. The soft-yes words (בטח/אשמח/ברור) count only when followed by an arrival word. A yes-word followed by a negation goes to the free-text reader. Head counts skip times, dates, long numbers and "בשעה 8", and accept 1–30 only. |
| P0-4 | `guestFreeText` / `partyFromText` | "נגיע בסביבות 20:00" was saved as **מגיע 20**, "באיזו שעה מתחיל? 19:30?" as **מגיע 19**, and "לא יודע, אולי 2" as **מגיע 2** (the number won over the doubt). All reproduced on the old code. | **Fixed** de7e0c6. Questions are never read as a head count (`isQuestion`), and doubt wins over a number. |
| P0-5 | engine postpone stage, index.js:5448 | Any edit of the date in column G (a typo fix, a reformat, a Make sync) sent "האירוע נדחה" to every invited guest of a הכל-כלול event, with no human in the loop. | **Fixed** de7e0c6. Sending needs `postponeok:<token>` equal to the new date. The client's postpone button and restore write it, and admins write it with `/api/event-flag {flag:'postponeok', on:true}`. Without it the stage raises one alert and sends nothing. |
| P0-6 | `eventDayRecipients` | A guest who got the day-before reminder and then answered לא מגיע still got "today we celebrate". | **Fixed** dbec9f4. |
| P0-7 | `runEventDayBlasts` | The KV job ran even after the event was cancelled or put on `hold:`, and it ran on no-contact days. | **Fixed** dbec9f4. |
| P0-8 | `/api/guest-add` → invitation | A guest added from the dashboard after wave 1 got the invitation immediately: at 23:40, on Shabbat, on a holiday, while sending was paused, while the event was on hold, or after the event. No wamid was recorded, so a failure could never reopen the send. | **Fixed** de7e0c6. `lateInvite` (index.js:4191) applies the waves' gates and queues `lateinv:` when one is closed. `drainLateInvites` sends the queue from the pacer. Past events are dropped and the wamid is recorded. |
| P0-9 | `runDailyEngine` | The send window was enforced only by the callers. A manual `/api/daily-run` with no budget at 22:00 sent every due wave and lifecycle message. Client stages (doch, syum, nudges, upsell) had no window at all; the registry already flagged this. | **Fixed** de7e0c6. With the window closed the guest budget is 0 and client templates wait while the pacer stays armed. `force` still overrides. Covered by a test with the clock pinned to 23:30 IL. |
| P0-10 | `resendInvitation` | `findGuestByPhone` falls back to the latest past row, so a guest could be re-sent an invitation with RSVP buttons for an event that had already happened. There was also no hours check and no wrong-number check. | **Fixed** de7e0c6. |
| P0-11 | `/api/navlink` | The regex had no end anchor, so `https://waze.com.evil.example/x` and `https://waze.com@evil.example` were accepted, then sent to every confirmed guest in the day-before reminder and in "איפה זה?" replies. | **Fixed** de7e0c6. `links.js` parses the URL, requires https, rejects `user@`, and checks the hostname against an allowlist. Links already stored are re-checked at send time. Gift links (Bit/PayBox) get the same treatment. |

### P1

| # | Where | Failing scenario | Status |
|---|---|---|---|
| P1-1 | status webhook, index.js:2960 | A 131048 hit reopened the same guest with no limit: one phone was accepted 28 times in a day and 2,091 of 2,350 templates failed. | **Fixed** de7e0c6. At most 3 cap reopens per guest per stage (rolling 3 days), then `wdead` and it waits for a human. The Slack note goes out once per number per hour (it used to be one per failed message). |
| P1-2 | `pickGuestPhone` / `bumpGuestSend` | (a) The budget reset at Israeli midnight while Meta's window is rolling: 230 at 20:00 plus 230 at 09:00 is 460 inside 24h. (b) KV allows 1 write/sec per key, so a tick lost increments. (c) Free-form replies were counted and then **blocked**, so Shir would go silent to a guest asking for the address once the budget ran out. (d) Every send was counted, not unique recipients. | **Fixed** de7e0c6. Usage is max(day counter, rolling 24h hourly buckets) plus a tally local to the isolate. Only templates are counted, once per recipient per 24h (`gbic:`). A portfolio cap (`GUEST_PORTFOLIO_BUDGET`) applies across numbers. Replies are never budget-gated. |
| P1-3 | `post()` | A free-form reply left from the "least used" number instead of the one the guest wrote to. The 24h window is per number, so these died with 131047 (28 on 02/11). | **Fixed** de7e0c6. The inbound webhook writes `gin:<phone>` and replies use it. The x4499 guests' CTA replies now use `sendCh`. |
| P1-4 | `sendWave` and every lifecycle loop | Once the budget ran out, each remaining guest was "failed" one at a time, which logged a wall of failures for a batch that was simply queued. | **Fixed** de7e0c6. `held` stops the batch and the cursor stays put. An empty variable stops the batch and keeps the stage open, with one journal line. |
| P1-5 | `sendTemplate` | A newline, tab or more than 4 spaces in a variable (venue, name) is refused by Meta (132018), and an empty variable fails (131008). Callers retried this every tick. | **Fixed** de7e0c6. `cleanParam` runs on every variable. An empty variable is refused before Meta is called (`permanent`), with one journal line per day. |
| P1-6 | day-before loop, index.js:5540 | `else failed++` was attached to the A/B `if`, so every plain successful send counted as a failure. The flag stayed open and "N שליחות נכשלו" fired. | **Fixed** de7e0c6, confirmed with a mutation check. |
| P1-7 | `guestFreeText` | It referenced `ch`, which is undefined in that scope. A "כן נגיע"-style free text was written as מגיע 1, then threw a ReferenceError, so the guest got no reply and no nudge was armed. | **Fixed** de7e0c6. A lint test checks for it. |
| P1-8 | `/api/event-change restore` | Restore deleted `sentdate:`, which permanently disabled the postpone stage, so the promised "the event is back on" message never left. | **Fixed** de7e0c6. A sentinel value plus `postponeok` makes stage 5 send ishur_dchiya once. |
| P1-9 | status webhook | 131042 (payment/eligibility on the WABA) counted as a guest strike: 3 strikes made the guest dead. | **Fixed** de7e0c6. It is held like a cap, with no strike. |
| P1-10 | status webhook | For the one-day lifecycle messages, 131049, 130472 and 131050 were retried 3 times, 10 minutes apart. Each retry failed the same way and spent a budget slot. | **Fixed** de7e0c6. These codes are terminal for lifecycle messages. Waves keep their existing 131049 defer. |
| P1-11 | pacer `autoretry:` (index.js:5777) | Clears `wfail:` every send day, so "3 attempts" is really 3 per day. A wave window is 3 days, so a guest can get up to 9 attempts. | Open: D5 |
| P1-12 | day-before window `daysLeft 0..1` (index.js:5510) | A guest who confirms on the event morning gets the day-before template on the event day, plus the table message, plus the event-day blast: three messages. If ishur_yom_lifnei says "מחר", the text is also wrong. | Open: D3 |
| P1-13 | date parsing everywhere (`/^\d{4}-\d{2}-\d{2}/`) | A sheet date in any other format (02/11/2026) silently skips every lifecycle stage for that event. Only wave 1 has a watchdog. | Open: D7 |
| P1-14 | `ishur_toda_orach(_v2)` is MARKETING | Fails with 131049 for many guests, and costs ₪0.12 a send. | Open: D4 |
| P1-15 | `NO_CONTACT_DAYS` (shir.js:81) | The list ends at Shavuot 2027 and has no Yom HaShoah (2027-05-04), no Tisha B'Av, and no autumn 5788. | Open: D6 |
| P1-16 | `drainPartyNudges` | No no-contact-day check and no `hold:` check (free text inside the guest's 24h window). | Open (low risk) |
| P1-17 | sync Meta errors in loops | A synchronous 130429 or 131056 is counted and the loop moves to the next guest. It doesn't burn the cap, but it wastes the tick. | Open (low) |

### P2

| # | Where | What | Status |
|---|---|---|---|
| P2-1 | lead chase, index.js:911 | The ishur_lo_siyem templates read "ל{{2}}" with the default "האירוע שלכם", which produced "להאירוע שלכם" in the live log. A form tracking type ("lead_partial") could also reach the text. | **Fixed** de7e0c6 (`cleanOccasion`, default "אירוע שלכם") |
| P2-2 | lead chase first name | A stray quote produced `היי "הבוטח` in the live log. | **Fixed** by `cleanParam` |
| P2-3 | engine upsell | The client was greeted with the *hosts'* first name (`name = ev[34] \|\| ev[2]`). | **Fixed** de7e0c6 (uses ev[2]) |
| P2-4 | `resendInvitation` | Hard-codes `hazmana_ishur` instead of `invitetmpl`. | Open |
| P2-5 | fallbacks | "אורח יקר" is masculine. Gender-neutral wording such as "אורח/ת יקר/ה" or no name is a template decision. | Open: D9 |
| P2-6 | `findGuestByPhone` | When two past rows match, it keeps the first row, not the latest. | Open |
| P2-7 | `/api/cap-status` | Counts `bic:` keys with `list()` (lags its own writes) and reads the deprecated tier field from one number. Now also returns our own budget per number, the portfolio total and the late-invite queue. | Partly fixed |
| P2-8 | `automations-registry.js` | Already stale on main-executer: `check-registry.mjs` fails 178 anchors there, 179 here. | Needs a re-pin pass |

## 2. Message paths covered

| Path | Template | Variables (sheet column) | Gates |
|---|---|---|---|
| wave 1/2/3 `sendWave` | invitetmpl / _img_u / _vid_u / custom / A/B | name G3 · occasion E5 · hosts **E34 only** · date E6 · time E36 · venue E38+E37 | window, budget, paused, Shabbat/holiday, hold, wsent/gday, optout/wrong, wdead, 131049 defer |
| late add `lateInvite` | same as wave 1 | same | same, plus a queue |
| re-invite `resendInvitation` | ishur_hazmana_shuv / hazmana_ishur | same, plus what the guest already answered | window, past, wrong, optout, 3/h |
| day-before | ishur_yom_lifnei / navtmpl (+nav) | name, guestEventName, date, time, venue, navlink (validated) | engine gates, s5d marker |
| table | ishur_shulchan | name, guestEventName no article, table G30 | event day, s5t marker |
| event-day | job.template (ishur_yom_haerua) | job.time/what/address/nav | window, holiday, paused, hold, cancelled, MARKETING refused, s5e |
| thank-you | ishur_toda_orach(_v2) | name, guestEventName | the day after, plan ≠ basic, s3t |
| cancel / postpone | ishur_bitul / ishur_dchiya | name, guestEventName (+date, time, venue) | plan or add-on, s5c / s5p, **postponeok** |
| לא סיימת (leads) | ishur_lo_siyem 1/2/3 | first name, cleanOccasion | pacer window, reply ends the sequence |
| gift / navigation replies | free text | giftlinks (validated) / navlink (validated) | reply to the guest's own question only |

## 3. Tests

`cd worker && node --test test/*.test.mjs` → **143 pass, 0 fail**. 113 of these existed before; 30 are new, in `test/audit-send-pipeline.test.mjs`. Note: the documented `node --test test/` form fails on Node 24, which reads the directory as a module path; use the glob.

Mutation checks: each fix was reverted and the run went red. The reverted fixes were the day-before else-binding, the table article, the postpone gate, the ev[2] hosts fallback, the parser negation guard, reply pinning, the engine window gate and the event-day declined guard.

**What the tests do NOT prove:**
- That the real template bodies take the variables as assumed. The article logic depends on "ב{{2}}" in ishur_shulchan (confirmed from the live render). The bodies of ishur_toda_orach, ishur_yom_lifnei and ishur_dchiya were not read from Meta.
- That Meta counts exactly as modelled.
- KV behaviour across isolates or under real write rate limits.
- Anything about deploy.

## 4. Decisions needed from Richard

1. **D1:** Set `GUEST_PORTFOLIO_BUDGET=230` (total across both numbers). The 02/11 data and Meta's documentation say the 250 cap is shared, so "500 across 2 numbers" will be refused. The existing `guest-budget.test.mjs` encodes 230 *per number*, and I did not change it.
2. **D2:** Who may approve a postpone notice besides the client's button? Today it is an admin call to `/api/event-flag postponeok`. Should the dashboard show an "notify guests of the new date?" button?
3. **D3:** Should a guest who confirms on the event day get the day-before reminder (then three messages that day), or should the day-before stage stop at D-1?
4. **D4:** Submit a UTILITY version of the thank-you, or keep the MARKETING one and accept 131049 losses?
5. **D5:** Is "3 attempts" per guest per wave meant for its whole life (today's autoretry allows up to 9)?
6. **D6:** Extend the no-contact days (Yom HaShoah, Tisha B'Av, autumn 5788) and decide whether Friday after 13:00 stays closed.
7. **D7:** Should a non-ISO event date in the sheet raise an alert, or be parsed?
8. **D8:** After 3 cap reopens a guest is parked (`wdead`, code 131048). Should it go to Shir's call round automatically, or wait for you?
9. **D9:** Guest-name fallback: keep "אורח יקר" or move to a neutral form?
10. **D10:** Deploy order: main-executer (c3c9604 is still not live; the 14:33Z table message proves it), then this branch. Both need your go.
