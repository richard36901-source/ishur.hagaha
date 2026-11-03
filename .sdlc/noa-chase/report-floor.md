# report-floor · noa-chase (R4, R5, R7, R9) — 02/11/2026

**Pass condition stated before building:** `node --check` passes on floor.js, dial.js, index.js, setup-dial.mjs; `floorState()` run headless against an in-memory KV seeded from REAL `/api/call-board` + `/api/stream` data returns three columns with state/transcript/tools/last-calls/lessons; floor.html loaded over HTTP with that fixture renders 3 columns at ≥980px and 1 column on a phone with zero console errors, and save/delete/▶ work. Nothing deployed, nothing dialled, no KV written, no Retell write.

## Files
| file | what |
|---|---|
| `worker/floor.js` | `POST /api/floor`, `POST /api/floor-note` (add / `action:'delete'`), `noteLiveCall(env, event, call)`, `floorAgentOf`, `transcriptTail`, `parseMemory`, `scrubPii`, `setFloorHooks` |
| `floor.html` | מוקד: נועה · שיר · המוח, RTL, admin.html tokens, 3 s refresh, `?fixture=` mode |
| `worker/dial.js` | `GET /api/dial` (+ `/dial`), `dialSig`, `dialLinkFor`, `dialOnEnded` (second-number fallback) |
| `worker/setup-dial.mjs` | bridge-agent creation script (NOT run) |
| `worker/index.js` | ONE block: 2 import lines + 3 route lines next to `/api/call-board`, commented "02/11 floor/dial routes" |
| `assets/adminbar.js` | one line: nav item "מוקד" → floor.html right after "מוקד שיחות" (admin.html's top nav is rendered by this file; admin.html has no inline nav) |
| `.sdlc/noa-chase/prompts/noa_out_v2.md` · `shir_out_v7.md` · `transfer_to_rep.tool.json` | text only, not applied |
| `floor.fixture.json` | real `/api/floor` shape, built from live board/stream data |

Not touched: `worker/noa.js`, `worker/callqa.js`, `worker/test/*`, `worker/shir.js`, the webhook path, `wrangler.toml`.

## What I ran, what it said, attempts
1. `node --check` on floor.js, dial.js, index.js, setup-dial.mjs → all pass. Attempts: dial.js 3 (block-key name `callblock:` → real keys `nocall:`/`block:`; `/dial` would be swallowed by the go.ishur.io site mirror → mounted `/api/dial` too), floor.js 2 (operator-precedence bug in the `noteLiveCall` phone pick; then memory writes routed through noa.js' `addMemory`).
2. Headless run (`build-fixture.mjs` in the scratchpad, output `check.log`): in-memory KV seeded with the 38 real `stream` rows (as `stream:<day>:<ms>:<rand>`), Retell `list-calls`/`get-call` stubbed from the 60 real call-board rows plus one synthetic live Noa call, `create-phone-call` stubbed to THROW.
   - `noteLiveCall(call_started)` → `livecall:noa` written (`with:'דנה'`); `call_ended` → cleared.
   - `floorState()` → noa `in_call`, 6 transcript lines, 1 tool (`record_outcome outcome=שיחה חוזרת`), 2 lessons, queue 1; shir `idle`, 10 last calls, 8 with `/rec/` links, 1 with a QA verdict (joined from a `data.verdict` stream row); brain memory {noa:2, shir:1, max:40}, pending 1, prompt heads 10/6 from `vpmeta:*`.
   - `floor-note` add → "נשמר · ייכנס לשיחה הבאה", phone+email scrubbed to `[טלפון]`/`[מייל]`; delete by `at` → removed 1; wrong key → 403; a note containing "הנחה" → refused `banned:הנחה` with a Hebrew message; duplicate → refused.
   - dial: `dialLinkFor` → `https://go.ishur.io/api/dial?item=…&who=shalev&k=<16 hex>`; bad k → 403; `DIAL_ENABLED` unset → 503 page containing "החיוג המוקלט עדיין לא הופעל"; on but no bridge agent → 503; `create-phone-call` never reached.
3. floor.html served by `python3 -m http.server` on 127.0.0.1:8765, opened in the Browser pane with `?fixture=floor.fixture.json` (own background tab): 0 console errors on load; 437px → 1 grid column; 1400px → 3 columns, no horizontal scroll; ▶ opens an inline `<audio src=go.ishur.io/rec/<id>?k=…>`; ✕ deletes (1→0); "שמירה" adds a lesson (1→2), shows the status line, clears the box. Attempts: 2 (the writer-name `prompt()` is unsupported in the pane → now try/catch with a fallback).
4. `grep -c הנחה` over my UI/JS files → 0. The prompts carry the pre-existing rule line "אין הנחות, אין מבצעים" verbatim from live noa_out v10 (it forbids the thing; it is never said to a customer).

## Hooks the webhook owner must wire (not done by me)
- `processRetellEvent` (worker/index.js ~2072), first lines: `await noteLiveCall(env, body.event, body.call)`. Needs `call_started` and `call_ended` enabled in the Retell agents' webhook events (today only `call_analyzed` + the tool body arrive; without `call_started` the board still works — it falls back to list-calls' `ongoing` status every 3 s).
- Same place, R7: `await dialOnEnded(env, body.call)` on `call_ended`/`call_analyzed` (dials the second שלו number after `dial_no_answer`/`dial_busy`).
- `audit.keepCall(env, c0, {...})` in index.js passes `kind/token/outcome` only; dial.js puts `agent:'שלו'|'ריצארד'` in `call.metadata`, so pass `agent: c0.metadata.agent` there or rep recordings get named `שיר`.
- `setFloorHooks({addMemory, deleteMemory})` exists if noa.js wants to own the writers; today floor.js imports `addMemory`/`removeMemory` from noa.js directly (trusted:true after an iron-rule check).
- Reviewer verdicts: floor.js reads any stream row whose `data.call_id` matches and `data.verdict` is set (callqa.js' "לקחים משיחה" event qualifies). Pending lessons: KV `brain:pending` (array of {text, agent, at}); weekly proposals: `vpsuggest:<agent>` ({at, note, text}) — keys I chose; callqa.js must write them or the brain column shows "אין".

## Prompts (R4/R5) — facts audit
`noa_out_v2.md`: "עובדות השירות", the price table, "חוקי ברזל", "תשובות לשאלות שחוזרות", "גבולות" are verbatim from live v10. New: `why:'chase'` branch + one-sentence opener, 3 extra objections sourced only from existing facts (records/tier rounding, WhatsApp buttons/reminders/board, form-data origin), `{{memory}}` block with a "facts win" clause, `transfer_to_rep` replacing the two transfer tools, `record_outcome` enum (סגר/שיחה חוזרת/לא רלוונטי/להעביר/לא להתקשר — needs a new custom tool on noa_out, flagged), recording disclosure, 90 s target, speak→record→end_call order. `begin_message` must be '' on save (today `{{opening_line}}`).
`shir_out_v7.md`: live v6 verbatim + `{{memory}}` + "לא יודע/לא בטוח/עדיין לא = מתלבט" + the begin_message='' note. `buildCallPayload` must send `memory` (the other agent does, behind NOA_CHASE).
`transfer_to_rep.tool.json`: warm transfer, one-line whisper, numbers from env (NOA_REP_LINE/SHALEV_PHONE/RICHARD_PHONE). Open point inside the file: Retell's `transfer_call` takes one destination; 4499→personal→Richard needs sequential dialing on the account or three identical tools called in order.

## NOT proven (needs a live run with Richard awake)
- Live transcript on a real call (P9): `call_started` delivery, the 3 s cache (`livetx:<id>` is value-stamped because KV TTL min is 60 s), Retell `get-call` shape for an ongoing call (`transcript_with_tool_calls` assumed; plain `transcript` fallback exists).
- `/api/floor` load: one `list-calls` + one `get-call` per 3 s per open screen (cached 3 s) + one 4-day `audit.query` (~200 KV reads) per request. Fine for one viewer; measure before two.
- Dial bridge (P7): `setup-dial.mjs` not run; `transfer_destination.type:'inferred'` with `{{lead_phone}}` untested; recording surviving the warm transfer (R6) untested; lead seeing 055-507-7733 untested; `dialOnEnded` depends on the webhook hook.
- `/api/dial` on the real router: GET sits after the `/api/` POST-only guard and before the mirror — reasoning, not a request.
- Monday phone column value shape (`text` vs JSON `value.phone`) — both handled, neither observed.
- Prompts not applied; the 12 skill tests not run.
- floor.html against the real API with `IshurGuard.stamp` — only the fixture path ran in a browser; `api()` is a copy of admin.html's `hqApi`.
