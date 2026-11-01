# Build report — noa-chase (worker side) · 02/11/2026

Branch `noa-chase`, worktree `~/ishur-noa`. **Nothing deployed, nothing dialled, nothing written to KV or monday.** Every live API call in this stage was read-only (`/api/stream`, `/api/lead-monday` GraphQL queries).

## Pass condition (stated before the build)
`node --check` clean on every changed file, and `node --test 'worker/test/*.test.mjs'` exits 0 with every test in the new files green — including the 28-transcript QA baseline: all 16 gaps of `qa-shir-2026-11-01.md` detected as `mismatch`, none of the 12 non-gaps.

## What was built
| file | what |
|---|---|
| `worker/noa.js` (new) | `scanMondayNotAnswered`, `cadenceNextAt` (pure), `drainNoaChase`, `noaChaseCallEnded`, `writeBackMonday`, `chaseOutcome`, memory (`getMemory` / `addMemory` / `removeMemory` / `memoryGuard` / `memoryBlock` / `renderMemory`), `noaChaseTick` (one pacer tick). Column ids verified against the live board (read-only). |
| `worker/callqa.js` (new) | `reviewCall` (rules first, then model: `claude-opus-5-5` when `ANTHROPIC_API_KEY` exists, else Workers AI llama-3.3-70b), `applyReview` (auto-fix through the same `call_result` path as `record_rsvp_outcome`, journal line `תוקן אוטומטית מהתמליל`, memory through the guard, one quiet Slack line per mismatch), `callFromRetell`. |
| `worker/shir.js` | `buildCallPayload(…, opts)` gains `opts.memory` → `retell_llm_dynamic_variables.memory` (always present, `''` when not passed — no call site changes behaviour). |
| `worker/index.js` | 4 small hooks, every one behind `NOA_CHASE === 'on'`, tagged 02/11: imports; `noaChaseTick` in the `*/10` cron block (with the real `snapshotCached` / `callBlocked` / `leadReplied` / `retellBillingGuard` / `logRow` as deps); `reviewCall` + `applyReview` + `noaChaseCallEnded` in the `call_analyzed` branch (try/catch, never breaks the webhook); `memory` passed at the Shir guest dial and the Noa lead dial. |
| `worker/wrangler.toml` | `NOA_CHASE = "off"` with a Hebrew comment. |
| `worker/test/` | `past-events`, `noa-cadence`, `callqa` (+ fixture `fixtures/shir-calls-2026-11-01.json`: 38 Shir rows / 28 with transcript, fetched 02/11), `memory-guard`, `noa-queue`. All offline: `fetch` is mocked (and throws in callqa if anything tries the network), `env.AI` is a stub, KV is a Map. |

## What I ran, and what it said
```
$ node --check worker/noa.js worker/callqa.js worker/shir.js worker/index.js worker/test/*.test.mjs
(clean, every file)

$ node --test 'worker/test/*.test.mjs'
ℹ tests 79   ℹ pass 79   ℹ fail 0   (49 existing + 30 new)
✔ the 16 gaps are detected as mismatches with the right suggestion (rules only, no model)
✔ the 12 non-gaps are left alone (ok or review, never mismatch, never auto_fix)
✔ 5 attempts at day offsets 0/1/3/7/14 with rotating hour bands, then null
✔ never Saturday · Friday 09:30–13:00 · Rosh Hashana 2026 skipped · max 5
✔ memoryGuard rejects הנחה/חינם/ללא הגבלה/מבטיח, off-list prices, phones, emails, names
✔ addMemory: 40-line FIFO, per-agent keys (noa-memory / shir-memory)
✔ scan: dry writes nothing; off is read-only; on writes nq: + טיפול=נועה + "נועה לקחה · 01/11"
✔ drain: flag/window gates, payload carries why:'chase' + memory + item_id
✔ call ended: no answer → attempt + next slot; reached → done; monday status/עדכונים/update with /rec/
✔ shouldDial refuses yesterday's event; calls board files them as "אירוע עבר"
```

## Attempts
1. Whole suite, first run: runner invocation error (Node 24 wants a glob, not a directory) — not a test failure.
2. 73/74: **a real rule bug** — `וואלה`/`הלאה` were in the filler set, so רון יעקב (5s, "וואלה הלאה") read as a hangup; the QA doc says "לבדיקה ידנית". Fix: only greetings/noise are ignored for the hangup rule; closings (תודה / יום טוב) are stripped only for the "לא and nothing else" rule. Gap/non-gap expectations untouched.
3. 74/74. Then `noa-queue.test.mjs` added: 3/5 on its first run — one wrong test setup (`leadReplied` returned false in the live pass, so the WhatsApp-answered entry was rightly dialled), one real bug (`writeBackMonday` stamped the wall clock instead of the injected `now`). Both fixed → **79/79**.

## Decisions worth knowing
- **Gap = `verdict: 'mismatch'`**, which only the three unambiguous rules produce (`לא יודע`→מתלבט, hangup ≤9s→לא ענה+retry, `לא`-only→לא מגיע). `כן` suggests מגיע with `count_unclear` but is never auto-fixed (סימה ודוד 33s → `review`; משה ונעמי → `ok` + `count_unclear`).
- A 2–3-letter STT shard ("על", "אנו") is noise; a longer word ("וואלה", "הלאה", "אני רוצה לבדוק") means the guest was listening → `review`.
- When the mid-call tool wrote the outcome and the end-of-call report does not carry it (`shirtool:<id>` marker), the reviewer answers `ok` ("נרשם בכלי") — it cannot see what the tool wrote, so it never "fixes" against it.
- Chase outcome → monday status: analysis enum first, then transcript cues (לא מעוניין→לא רלוונטי, תתקשרו מחר→שיחה חוזרת, …), then disconnection reason. A reached call with no clear status leaves the status alone and still posts the update + recording.
- After 5 unanswered attempts the entry is kept as `done`, עדכונים = "נועה: 5 ניסיונות, לא נענה". The final WhatsApp template is **not** sent from here (R2: needs an explicit "שלח").
- Memory entries use the same shape and keys as floor.js (`{text, at, source, by}`, `noa-memory`/`shir-memory`, max 40), so floor notes and QA lessons share one list.
- Every KV/monday/Retell write is gated on `NOA_CHASE==='on'`; `dry` previews even when off.

## NOT proven (needs a live call, a monday write, or Richard awake)
- **P1** a real "לא ענה" item becoming `nq:` + טיפול=נועה on the live board — mutation shapes exercised only against a mock. The `items_page(query_params:{rules:[{column_id:"status",compare_value:[2]}]})` read **was** run live and returned the expected items.
- **P3** a real chase call → status + עדכונים + an item update with a playing `/rec/<id>`. `create_update` has never been called on this board by this code.
- **R4** the noa_out v2 prompt with `{{memory}}` is not written/applied here; `memory` is already in every payload, so a prompt that references it will not read braces.
- **R5/R6** warm transfer and recording-after-transfer: untouched.
- The model pass against a real Workers AI / Anthropic response (mocked JSON only); the 25s AbortSignal timeout in a Worker unverified.
- `applyReview` auto-fix against the real `HOOK_EVENTS` sheet writer — mocked `writeCallResult` only. The three auto-fix rules were judged against the QA doc, **not yet by Richard** (P11: 0 wrong fixes in his manual check is still owed).
- The `*/10` hook in `index.js` is syntax-checked, not executed. A `wrangler dev` dry tick with `NOA_CHASE=on` is the next cheapest check.
- `cadenceNextAt` across the DST switch in March 2027 (bands are Israel-local by construction, but no test crosses the switch).
