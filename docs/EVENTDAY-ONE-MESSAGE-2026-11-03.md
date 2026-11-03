# One message on the event day · 03/11/2026

Branch `eventday-one-message`, from `integ-2026-11-02` @ 231f5b0. **Not deployed. No message sent. No template submitted.**

Tests: `cd worker && node --test test/*.test.mjs` → **338 / 338 pass** (base 324; 14 new in `test/eventday-one-message.test.mjs`). `npx wrangler deploy --dry-run` builds (2541 KiB).

## Richard's rules

- **R1** The day-before reminder is never sent on the event day. If it did not go out the day before, it is dropped.
- **R2** Each guest gets exactly ONE event-day message: address + navigation (always), the table (seating and a table), the gift button (links on).
- **R3** A guest the day-before missed still gets only that one message.

## What changed

| where | what |
|---|---|
| `worker/eventday.js` (new) | pure helpers + `eventDayMessageFor(env, ev, guest, deps, {job})`: picks the richest **APPROVED + UTILITY** combo (`tg → t` for table guests, `g` for gift-only guests). Returns `legacy` when none is approved, no combo applies, or the address is empty. |
| `index.js` stage 4 (table) | checks `ed:<token>:<phone>` first. Sends the combo when there is one, else `ishur_shulchan(_matana)` as before. Claims the mark before the send and releases it if the send fails. |
| `index.js` `runEventDayBlasts` | same mark. A table guest with no combo is left to the table stage (R2: never shulchan + yom_haerua). A combo can go out while the job's own template is still pending. The job stays open while guests wait for approval. |
| `index.js` day-before | runs only when `daysLeft === 1` (`dayBeforeAllowed`). On the event day it writes one journal line per event: **"יום-לפני דולג — האירוע היום"**, with the number of confirmed guests it missed. |
| status webhook | a reopened table/event-day send (131048 etc.) also clears `ed:` so the retry can leave. |
| `GET /nav/<slug>` (new) | the combo's navigation button. Redirects (302) to the validated `navlink:<token>`, else the job's nav link, else a Waze search of the venue, else ishur.io. |
| `ops.js` planner | a day-before not sent by D-1 (or with D-1 on Shabbat) becomes a `dropped` item on the event day. It is not in `planned` and gets no recommendation. The event-day count excludes table guests, who are counted under `table`. |
| `send-board.js` + `assets/sendboard.js` | day-before on/after the event date: `dropped` count and a people bucket ("דולג"), never `pending`. Event-day audience = confirmed guests without a table. Combo templates are classified as table or event-day. Cache-bust bumped to `?v=3`. |

Mark: `ed:<token>:<phone>` (2 days). Its value is the template name, `seating`, `eventday`, or `claim` while a send is in flight. Legacy markers `s5t` / `s5e` are still written, so the board and the reopen logic keep working.

## Templates to submit (`worker/templates/ishur_yom_combo_{t,g,tg}.json`)

All three are UTILITY, `he`, on the guests WABA, with `allow_category_change: false`. Submit them the same way as the `_matana` ones (GIFTS doc §2). **Deploy first**: `/nav/<slug>` must exist before any combo is sent.

| template | body params | buttons |
|---|---|---|
| `ishur_yom_combo_t` | 1 name · 2 event (no article, hosts only) · 3 time · 4 address · 5 table | 0 nav |
| `ishur_yom_combo_g` | 1–4 | 0 nav · 1 gift |
| `ishur_yom_combo_tg` | 1–5 | 0 nav · 1 gift |

Navigation is a button (`https://go.ishur.io/nav/{{1}}`, suffix = the first 8 characters of the token), not a raw URL in the body. The approved `ishur_yom_haerua` carries Waze in body `{{4}}`. A third-party URL as the dynamic part of a button is a rejection risk, and our own domain lets the link change without a template edit.

## Behaviour matrix (one message per guest in every row)

| combo approved? | table guest | no-table guest (needs an `edblast:` job) |
|---|---|---|
| tg/t (+g) | combo_tg (gift on) / combo_t | combo_g (gift on) / yom_haerua(_matana) (gift off) |
| none | ishur_shulchan(_matana): table, no waze | yom_haerua(_matana) |
| approved mid-day | nothing more (`ed:` mark) | nothing more |

## What the tests do NOT prove

- That Meta approves the three templates, or approves them as UTILITY with two URL buttons.
- That two URL buttons with dynamic suffixes are passed exactly as Meta expects. The component shape (`index` 0/1, `sub_type: url`) matches the working `_matana` button; the second index is untested against Meta.
- KV is eventually consistent. The claim narrows the race between the two event-day paths in one tick but cannot rule it out across isolates.
- Nothing ran against production KV or the live sheet.
- `worker/scripts/check-registry.mjs` was already failing at base (stale line anchors). It still fails and was not re-pinned.

## Existing tests changed (rule change, not weakening)

`test/audit-send-pipeline.test.mjs`:
- "engine e2e: no guest template…": `>= 5` → `>= 4` sends. Two of the five were the day-before sent **on** the event day, which R1 forbids. The table finder also accepts `ishur_yom_combo_t`, because the fake Meta approves every name. The `ב{{2}}` assertion is unchanged.
- "day-before closes its flag…" now uses an event dated tomorrow. It used today's event, which meant a day-before sent on the event day.
