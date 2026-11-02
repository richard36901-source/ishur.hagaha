# Audit: inbound leads and the client side of 4499 — 02/11/2026

Branch `audit-inbound-leads` (from `main-executer` c3c9604). Nothing deployed, no KV written, no message sent.
Evidence was read with `/api/stream` (admin key), `wrangler kv key list` and `wrangler kv bulk get`, all read-only. Raw pulls are in the session scratchpad, not in the repo.

---

## 0. Root cause of the 17:46 "blind spot"

**The webhook received everything, and the Worker stored it. The log reader dropped it.**

1. `audit.query()` (worker/audit.js, old line 228) listed the day **oldest → newest** and called `get()` on **every** record before it filtered by `kind`. One Worker invocation gets roughly 10,000 KV operations. On 02/11 the stream had **10,949** records (`stream:20261102:*`, counted with `wrangler kv key list`). Every `get()` after about op #10,000 threw. The `.catch(() => null)` turned each failure into "no record", and the response still said `ok: true`.
2. Measured: every kind stopped at the same point. `meta` stopped at 12:19Z because it had no later records inside the readable part. `wa_in` stopped at 14:20Z, and `wa_out` and `wa_status` at 14:33Z. Exactly **9,974** keys are dated at or before 14:33:15Z, and **975** come after it. None of those 975 could be read through `/api/stream` (no kind, `since` or `phone` filter helps, because each one still lists and `get()`s from the start of the day).
3. The 975 records read directly from KV show the conversation **was** captured (times UTC):
   - 15:38:24 inbound from **972528383205 "מאי כהן"** (an existing client): "היי לא שלחתם את ההודעת תזכורת עם קישור לתשלום בביט ופייבוקס". Logged, plus the event "נועה כבויה — הודעה נכנסה ולא נענתה".
   - 15:38:26 echo to her: the **WhatsApp Business app's away message** ("היי 🙂 הגעתם לאישורי הגעה … אנחנו עונים בימים א-ה, בין 10:00 ל-17:00"). The Worker logged it as "ריצ׳רד ענה מהטלפון".
   - 15:38:59 inbound: "זו פאדיחה רצינית כי אמרנו להם שישלחו להם קישור"
   - **15:46:33 echo "היי, בודק"**. This is Richard's 17:46 IL message, sent to 972528383205.
   - 16:23:08 inbound "מגיע"
4. **Lead Maya Cohen 972507536247 had no 4499 traffic after 11:05Z.** Her `log:` keys are 10:24:06 (her form message), 10:24:09 (echo) and 11:05:50 (the `ishur_lo_siyem` template). Her only later event is the Meta-form import at 16:39Z. The 17:46 conversation was with **מאי כהן (client)**, not **מאיה כהן (lead)**. Nothing was lost at Meta or in the Worker.
5. Webhook subscription: `smb_message_echoes` and `messages` both arrive (echoes at 15:38, 15:46, 16:09, 16:11, 16:12 and 16:42Z, with inbound around them), so coexistence delivery works. Note that the `kind: meta` stream only ever holds **non-`messages`** fields (index.js webhook loop, `if (f && f !== 'messages')`). Inbound messages live under `wa_in`, never under `meta`. That is by design, not a gap. No `smb_app_state_sync` arrived in 24h, which is normal without contact edits.

**Fix (committed):** `audit.queryEx()` lists the whole day first, fetches **newest first**, skips non-matching records using list metadata (`{k,p,t}`, written by `record()` from now on), keeps to an explicit op budget (9,000), and **reports** `truncated / ops / failed / oldest_scanned`. `/api/stream` returns those fields. Test `test/audit-query.test.mjs` uses a KV double that throws after 10,000 ops. The old reader returns newest = record #9,900 out of 10,949 (reproduced). The new one returns #10,948, under the ceiling, with `truncated: true`.

What the fix does **not** solve: a single invocation still cannot read more than ~9k full records. Whole-day consumers (`dailyRoot`, `/api/template-stats`, `/api/send-board`, `/api/calls-log`, A/B `queryDay`) were silently partial on heavy days before this fix and are still partial now. They now drop the oldest records instead of the newest. See decision 10.

---

## 1. Ranked findings

Line numbers refer to this branch.

### P0: customer-facing, happening now

**F1. "לא סיימת" goes to leads who wrote to us first. Live, and it repeats tomorrow.** `index.js:872` `chaseAbandonedLeads`, old `leadReplied`.
- Scenario: a number writes to 4499, then `noteLead` (page `whatsapp`) creates `lead:` with `at = now`. The inbound was logged **~1 s earlier** (Maya: inbound 10:24:06.939, `rec.at` 10:24:07.953). `leadReplied` required `last_ts > rec.at` and `last_dir === 'in'`. The echo that follows (Richard, or the app's away message) flips `last_dir` to `out`. So 30 minutes later the lead got `ishur_lo_siyem` ("ראינו שהתחלתם להזמין אישורי הגעה … ולא סיימתם"), a marketing template with a false claim, while Richard was talking to them.
- Today, **all 4 live `lead:` records** are like this and all 4 got `t1`: עוזי יפרח 972508858863 (07:05Z; Richard was mid-sale with him at 16:11Z), "WhatsApp Business" 16465894168 (07:04Z; that is Meta's own account), Anat 972503014947 (09:32Z), Maya 972507536247 (11:05Z).
- **Tomorrow (03/11) at the first tick ≥ 09:00 IL, all 4 get `ishur_lo_siyem_2`** unless this branch is deployed first or their `lead:` keys are settled (decision 1).
- Fix (committed): `inbound.js chaseStopReason()` settles the lead when (a) it is WhatsApp-first (`types` has `whatsapp_in` / `page === 'whatsapp'`), (b) a human took the chat (`human:` / `aioff:`), or (c) an inbound landed within 10 minutes before `rec.at` or any time after it. `touchConversation` now keeps `last_in_ts`, which survives later echoes. `leadReplied` (also used by the sales-call queue) uses it too.

**F2. A client whose event Richard opened by hand becomes a "new lead" and gets chased.** `index.js:3172`.
- The new-lead check knew only `client:` (set by the Grow IPN), `lead:` and `leadchase:`. A bank-transfer or manual client, or a guest of an upcoming event writing to Noa, became a Monday item, a "🆕 ליד חדש" ping and then a "לא סיימת" chase.
- Fix (committed): before creating the lead, the cached snapshot is checked. An event owner (`eventsForPhone`) or a guest with an upcoming event gets a journal line and no lead. The snapshot read is capped at 4 s, and on timeout it falls back to the old behaviour.

### P1: Richard cannot trust what he sees

**F3. Blind log after ~10k records a day.** This is the root cause above (`audit.js:255`). Fixed.

**F4. The app's away message is shown as Richard and mutes Noa for a week.** `index.js:3077`.
- The away message arrives as an `smb_message_echoes` echo ~0.5 s before the inbound that triggered it, with nothing in the payload to tell it apart. The Worker wrote "ריצ׳רד ענה מהטלפון" and set `human:<peer>` for 7 days (today: 972528383205 at 15:38 and 972535285551 at 16:42).
- Fix (committed): `inbound.js isAppAutoReply()` matches the away text's fixed opening, overridable with the env var `WA_APP_AUTOREPLY` (a regex). Such an echo is logged as "הודעה אוטומטית (אפליקציית וואטסאפ)" and does not set `human:`. Echoes that really come from Richard behave as before.

**F5. Every WhatsApp lead is announced twice in Slack (three times if they also fill the Meta form).** `index.js:10107`, `index.js:765`.
- `mondayGql()` already returns `data`, but the Monday-hook code read `r.data.items` and `r.data.users`, which are always undefined. As a result:
  - every hook record has no phone or name ("37084112 כתב/ה על ליד · ");
  - the "is this ours?" check never matches;
  - the worker's own new items are announced again as "🆕 ליד חדש במאנדיי · טלפון: לא מולא". Seen today for Anat at 08:55, Maya at 10:24 and גריגורי at 14:38.
- Maya then got a third alert, "🆕 ליד חדש מטופס מטא" (16:39), although she had been a lead since 10:24.
- Fix (committed): the unwrap is fixed. The Meta-form and WhatsApp alerts now say "ליד קיים / לקוח קיים / כבר היה במאנדיי" when that is the case (`inbound.js leadAlertHeader`).

**F6. With Noa off, nobody hears about known people writing to 4499.** `index.js:3207`.
- `noa:off` logs "נועה כבויה — הודעה נכנסה ולא נענתה" and stops. Slack fires only for brand-new numbers.
- מאי כהן (a client) complaining "זו פאדיחה רצינית" at 17:38 IL produced no alert. The lead receives only the phone app's away message, which tells her "we answer 10:00–17:00" (and it fired at 17:38 and 18:42 IL).
- Not changed: this is a product decision (decision 3).

### P1: Monday board integrity

**F7. Duplicate items when Richard typed the phone differently.** `monday.js:107`.
- The lookup was one exact match on `0XXXXXXXXX`. A manual item stored as `+972…`, `972…`, `050-…`, with spaces, or with the phone only in the item name was not found, so a second item was created.
- Fix (committed): `findItemByPhone` first runs one exact query over every common spelling (`phoneVariants`). Only on a miss does it scan the board (up to 3,000 items) comparing normalised digits (`digitsIl`), including a phone written in the item name. When it finds such an item it fills the phone column.

**F8. Updates overwrote Richard's manual columns and notes.** `monday.js:73`.
- On every lead event (each site form step, each WhatsApp-first message, each Meta-form pull) the upsert:
  - wrote `''` into אירוע/חבילה;
  - replaced מקור and נכנס לראשונה;
  - **replaced הערות** whenever the record carried notes (the sheet-retro path);
  - on payment, `mondayMarkWon` **replaced הערות** with "שילם ₪…".
- Fix (committed): an update never blanks a column, never moves מקור or נכנס לראשונה, and **appends** to הערות (no duplicate lines). Payment appends its line as well.

**F9. `/api/lead-monday {action:'find'}` wrote to Monday.** `index.js:9573`.
- There was no read mode. `action` was ignored and the call fell through to the upsert. Another session's "find" for 972502125808 and 972507536247 (15:47Z) pushed KV values over those items.
- Fix (committed): `action:'find'` is read-only and returns `{found, id, name, notes, phoneText, matched}`.

### P2: lead intake gaps (not changed, decisions)

**F10. Meta-form leads get the "לא סיימת" sequence** (`index.js:721` routes them through `noteLead`). The template's wording is false for someone who filled an instant form. A design choice from 14/10 (decision 2).

**F11. Meta-form backfill gap.** Dry runs at 13:11–13:30Z (since 01/10) found ~34 leads. The live run at 16:39Z used `since=2026-11-02` and imported 1 (Maya). `metaleads:since` is now 10:23:56Z, so the earlier leads will never be pulled automatically (decision 5).

**F12. Non-person senders become leads.** "WhatsApp Business" 16465894168 (Meta's account) became a lead and got a marketing template. A small deny-list would cover it (not added; it is low value once F1 is deployed).

### P2: client lifecycle (Grow IPN), not changed

**F13. A Make writer failure means a second token on Grow's retry.** `index.js:363`, `index.js:435`.
- On a non-200 from `HOOK_GROW` the code deletes `grow:<ref>` so Grow can retry, but it has already set `client:`, `claimfresh:`, `token:` and posted Slack.
- The retry mints a **new** `crypto.randomUUID()` token, posts a second "💳 תשלום חדש" (now saying "לקוח קיים"), and, if Make actually wrote the first time (a timeout), creates a second event row (decision 8).

**F14. Two Slack posts per payment.** "💳 תשלום חדש" (`index.js:368`) and "🎉 רכישה חדשה" (`index.js:465`) (decision 9).

**F15.** Payment correctly deletes `lead:` and `lq:` and sets `client:` (730 days). The chase checks `client:`, and the send window is 09:00–20:30 Sun–Thu and 09:00–13:00 Fri, never on Saturday or no-contact days (the pacer skips those days, `index.js:5583`). The 21:00–09:00 rule holds for the chase. The automatic upload link and the WhatsApp invoice are off by decision (07/09), and the invoice goes by email only.

### P2: routing between the numbers

**F16. x4499 routing is dead right now.** `index.js:3124` reads `x4499:<phone>`, but **no code writes it** (`grep` finds only the reader), and KV holds **0** such keys. A guest replying to a 4499 send therefore goes down the client path. Before this branch that made them a lead; with F2 an upcoming guest is not a lead, but with Noa off they get no reply and nobody is told (decision 7).

**F17. Same person on both numbers.** `conv:` and `log:` are per phone across both lines (the inbox merges them), and `human:` is per phone but only gates the client line. A lead who replies "מגיע" on Shir's line counts as "answered" for the chase, which is acceptable. A lead writing to Shir's line is auto-redirected to Noa ("לשירות לקוחות כתבו לנועה"), creates no lead and no Slack, and Noa is off, so the message is lost unless someone reads the journal (covered by decision 3).

**F18. Test runner.** `cd worker && node --test test/` fails on Node 24.14 ("Cannot find module …/test"; a directory argument is not supported) on both the baseline and this branch. `node --test test/*.test.mjs` is the working form.

---

## 2. What was changed (files)

| File | Change |
|---|---|
| `worker/audit.js` | `record()` writes list metadata; `queryEx()` reads newest first with a budget and reports truncation; `query()` wraps it. |
| `worker/index.js` | `/api/stream` returns `truncated/ops/failed/oldest_scanned`; chase uses `chaseStopReason`; away-message echo; no lead for manual clients or upcoming guests; Meta-form and WhatsApp Slack headers; Monday-hook unwrap; `lead-monday` `find`. |
| `worker/inbound.js` (new) | `isAppAutoReply`, `chaseStopReason`, `lastInboundTs`, `leadAlertHeader`. |
| `worker/monday.js` | `digitsIl`, `phoneVariants`, `findItemByPhone` (exact + scan), non-destructive update, appending notes, `mondayFindLead`. |
| `worker/whatsapp.js` | `touchConversation` keeps `last_in_ts`. |
| `worker/test/audit-query.test.mjs`, `worker/test/inbound-leads.test.mjs` (new) | 27 tests. |

Verification: `node --test test/*.test.mjs` → 140 pass, 0 fail (113 before). `npx wrangler deploy --dry-run` bundles (1,895.64 KiB). Not proven: real Monday API behaviour of the new queries (tested against a double only), and that the away-message regex matches if Richard edits the text in the app.

---

## 3. Decisions needed from Richard

1. **Before 09:00 tomorrow:** deploy this branch, or approve settling 4 `lead:` keys (Maya, Anat, עוזי יפרח, 16465894168). Otherwise they get `ishur_lo_siyem_2`.
2. Meta instant-form leads: keep the "לא סיימת" sequence (its wording is false for them), give them their own template, or no chase?
3. With Noa off: send a Slack alert for every unanswered message on 4499 from known clients and leads (e.g. מאי כהן at 17:38), and hold it for 15 minutes if you replied from the phone?
4. The WhatsApp Business app's away message ("עונים 10:00–17:00") fires on existing clients in the middle of a complaint. Keep it, edit it, or turn it off?
5. Import the ~33 Meta-form leads from 01/10–02/11 that the dry runs found, with the chase disabled for them?
6. Confirm the new rule: a guest of an upcoming event who writes to Noa is not made a lead.
7. x4499: add the writer to the 4499 guest-send path, or delete the reader (today it is dead code with 0 keys)?
8. Grow writer-failed retry: make it idempotent (reuse the first token, one Slack post)?
9. Payment posts two Slack lines (💳 and 🎉). Keep only one?
10. The audit stream outgrows a single read (>9k records a day). Move whole-day reports (daily root, template stats, send board) to D1 or per-hour keys?
