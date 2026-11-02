# Gift links + send-status board · 02/11/2026

Branch `feat-gifts-sendboard`, based on `main-executer` @ c3c9604. **Not deployed. No KV written. No message sent. No template submitted.**

Tests: `cd worker && node --test test/*.test.mjs` (Node 24 rejects the bare directory form `node --test test/`). Result on this branch: **151 / 151 pass** (baseline was 113 / 113).

---

## 0. Finding that changes the "500" assumption

Meta's messaging-limits page (read 02/11) says the limit is calculated at the business-portfolio level and is *shared by all business phone numbers within a portfolio*. It counts unique users who get a message outside a customer-service window, in a *moving* 24-hour period.

Both guest numbers (6673 and 9799) are on WABA `1378764257421712`, so they are in one portfolio. **Two numbers do not make 500. The ceiling is the portfolio tier, which is 250 today.**

The code therefore defaults to `portfolio` scope. If Meta's dashboard ever shows two independent 250 limits, set `GUEST_CAP_SCOPE=number` (one var, no deploy logic change) and the board and scheduler switch to 250 + 250.

A second fix is in the same area. The 02/11 hotfix counted sends per Israeli **calendar day** (`gsend:<pid>:<day>`). Meta counts a **rolling** 24 hours, so 200 sends at 20:00 still count at 09:00 the next morning, while the day counter has already reset to 0. Hourly buckets (`gsendh:<pid>:<epochHour>`, 26h TTL) now feed a rolling sum. `used` is the larger of the day counter and the rolling sum. KV keys are never counted (memory: KV `list()` lags its own writes).

---

## 1. What changed, by commit

| commit | what |
|---|---|
| `7ce7451` budget | `worker/budget.js` (pure math + KV readers). `whatsapp.js`: `guestCapacity()`, `pickGuestPhone(env,{template})`, `guestBudgetLeft()`, `bumpGuestSend()` now also writes hour buckets. **Only templates count, and only templates are blocked.** A free-text reply inside the guest's own window (for example the answer to "לא מגיע") is never refused by our counter. `waCapInfo` caches each number's `id` so tiers match by phone id. |
| `202814f` scheduler | `runDailyEngine`: before the first send, the tick budget is cut to `fitBatch(capRemaining, tickBudget)`. The waves stop at `budget.left = 0` and keep their cursor, so the rest is the next tick's queue. A journal row `held: cap — המנה קוצרה לפני שליחה` is written at most once per hour. `runEventDayBlasts` (which had no budget at all) now stops at the cap room. It counts `held_cap` and keeps the job until everyone is sent. |
| `bdd4082` gifts module | `worker/gifts.js` (decline text, never-both slot, blast planner, gift page) + 4 template JSONs in `worker/templates/`. |
| `cad063b` gifts wired | (a) decline reply, (b) event-day gift line, thank-you uses the gift twin when links are on, `GET /gift/<slug>`, `POST /api/gift-blast`. Also a **regression fix**: the table message again uses `eventDisplayName(ev,{article:false})`. `fa3f07c` had reverted `4425386`, and the live log on 02/11 shows "מחכים לראותכם היום **בהחתונה** של הדר ויצחק". |
| `72902be` send-board | Failures broken out by code, a `gift` type, the due date, a cap panel and the 3-day plan. `/api/cap-status` also returns `budget` (what the scheduler enforces). |
| `779e5a6` test | Route test: `/api/gift-blast` + `/gift/<slug>` through the real Worker `fetch()`, with Meta and the sheet stubbed. |

New config vars (all optional, none set):

| var | default | meaning |
|---|---|---|
| `GUEST_CAP_SCOPE` | `portfolio` | `number` = the per-number limits add up |
| `GUEST_PORTFOLIO_BUDGET` | portfolio tier from `wa:cap`, else 250 | hard shared ceiling |
| `GUEST_DAILY_BUDGET` | number's tier from `wa:cap`, else 230 | per-number ceiling (unchanged meaning) |
| `GUEST_BUDGET_MARGIN` | 0 | subtracted from the shared room |

---

## 2. Feature 1: gift links (Bit / PayBox)

Source of links: `giftlinks:<token>` = `{bit, paybox, on}` (client dashboard → `/api/giftlinks`). "Active" means `on` is set **and** at least one link is a real bit/paybox URL (`gifts.js giftActive`).

### a) Guest answers "לא מגיע"

This covers both the button and parsed free text (`guestFreeText` → `saysNo`). `sayDeclined()` replies inside the guest's window as free text, so no template and no cost:

```
תודה שעדכנתם 🙏 אם תרצו לתת מתנה לבעלי השמחה, אפשר כאן:
ביט: <link>
פייבוקס: <link>
```

- A line is only included for a link that exists.
- Links off or empty: the old text is sent ("חבל שלא תהיו, תודה שעדכנתם 🙏").
- Exactly once per guest: `gift:<token>:<phone>` (120d) is set **only after the reply really left**, so a failed send is retried at the next "לא".
- Someone who is coming never gets this; it is wired only into the two "לא מגיע" branches.

### b) Event day: one gift line, never both

`eventDayGiftSlot({giftOn, hasSeating})` decides:
- `table` if any confirmed guest of the event has a table;
- `eventday` (the waze message) otherwise;
- `null` when links are off.

Both send sites call this one function. A test enumerates all four cases, and a lint test asserts both call sites use it with `eventHasSeating`.

**Template design (minimal approval risk):**
- The body gets **one static sentence** and no new variable.
- The link is a **URL button on our own domain with a dynamic suffix**: `https://go.ishur.io/gift/{{1}}`, where `{{1}}` = the first 8 characters of the event token.
- The page lists the Bit / PayBox buttons. It never shows the full token.

Why not the suggested `{{n}}` text parameter with the URLs:
- Meta rejects a body that starts or ends with a variable.
- A newline inside a parameter fails at send time (132018).
- Reviewers reject URLs whose domain is not the business's.

URLs in body params do work on this WABA: `ishur_yom_haerua` carries the Waze link in `{{4}}` and was approved and delivered on 02/11. Even so, a fixed own-domain button removes all three risks and lets the links change without touching the template.

| template | file | category | params |
|---|---|---|---|
| `ishur_shulchan_matana` | `worker/templates/ishur_shulchan_matana.json` | UTILITY | body {{1}} name, {{2}} event (no article), {{3}} table; button {{1}} slug |
| `ishur_yom_haerua_matana` | `worker/templates/ishur_yom_haerua_matana.json` | UTILITY | body = the same 4 as `ishur_yom_haerua`; button slug |

Fallback: the code uses a `_matana` twin **only when Meta says APPROVED + UTILITY** (`giftVariantUsable`, cached 10 min in `tmplinfo:<name>`). If Meta re-categorises it MARKETING, the current template goes out unchanged. That is the 131049 lesson from 02/11.

### c) After the event

- **Stage 3 (day-after thank-you):** when links are active and `ishur_toda_matana` is approved, the thank-you **is** the gift message: one message, A/B bypassed, and the gift flag set.
- **`POST /api/gift-blast {admin_key, token, dry=true, max=50}`:** confirmed guests get `ishur_toda_matana`, declined guests get `ishur_matana`.
  - Undecided guests and guests who never answered get nothing.
  - Phones are deduped, and opt-outs and wrong numbers are skipped.
  - Skips anyone with `gift:` and any confirmed guest with `s3t:` (already thanked).
  - Never sends more than `min(cap room, max)`; the rest is `hold` with reason `held: cap` / `max-reached`.
  - Refuses with `event-day`, `before-event`, `too-late` (>7 days), `outside-09-21`, `send-window-closed` (Shabbat, Friday after 13:00, after 20:30, holiday, paused), or `gift-links-off`.
  - Dry run is the default. Every response has a full per-guest list (phones masked), the template status, the links state and the cap.
  - On a real run each send sets `gift:` (and `s3t:` for confirmed guests), records the wamid (a cap failure reopens the guest like the waves do), and posts one Slack line.

| template | file | category | why |
|---|---|---|---|
| `ishur_toda_matana` | `worker/templates/ishur_toda_matana.json` | MARKETING | thank-you + gift. `ishur_toda_orach`/`_v2` cannot carry links (no variable; v2's button is a fixed ishur.io URL) |
| `ishur_matana` | `worker/templates/ishur_matana.json` | MARKETING | gift-only, for declined guests |

These two are submitted honestly as MARKETING. A thank-you with a gift ask is not utility, and a wrong UTILITY claim is the most common rejection. The price is that some guests can fail with 131049 / 130472; the blast reports those per guest.

### How to submit the templates (Fable / Richard, not done here)

Each JSON is exactly the body `/api/meta-admin` takes. The `_note` key is ignored by the route.

```bash
K=<admin_key>
for n in ishur_shulchan_matana ishur_yom_haerua_matana ishur_toda_matana ishur_matana; do
  jq --arg k "$K" '. + {admin_key:$k} | del(._note)' worker/templates/$n.json \
  | curl -s -X POST https://go.ishur.io/api/meta-admin -H 'Content-Type: application/json' -d @- ; echo
done
```

Check status:

```bash
curl -s -X POST https://go.ishur.io/api/meta-admin -H 'Content-Type: application/json' \
  -d '{"admin_key":"'$K'","channel":"guests","path":"/1378764257421712/message_templates?name=ishur_toda_matana&fields=name,status,category"}'
```

`/gift/<slug>` must be live (deploy) **before** any `_matana` template is sent, or the button opens the site's 404.

---

## 3. Feature 2: send-status board

`POST /api/send-board` (rendered by `assets/sendboard.js` in `calendar.html` and `admin.html`; cache-bust bumped to `?v=2`). For every event and every message type (waves 1–3, day-before, table, event-day, thank-you, and the new **gift to declined**) it shows:

- **total / sent / delivered / read / failed / queued-held / due date**
- failures by group as before, **plus by code**: 131048, 131049, 131047, 131042, 130472 always broken out, with any other code shown as "קודים אחרים". This is `failed.codes` in the JSON.
- pending reasons: בתור / חלון / תקרה / השהיה / נפתח מחדש / מתוכנן (date)

Above the events there is a **cap panel** (`data.cap`). It is recomputed on every call, even when the board itself is served from its 5-minute cache. It shows:
- the scope (shared or per number), the limit, what was used in 24h, and what remains;
- per number: label, tier, used today, used in the rolling 24h, remaining, `held` + **held until** (`wacapuntil`), and when the next slot frees.
- **the next 3 days:**
  - planned per day: today = queue + window + cap + reopened (holds excluded), later days = scheduled;
  - capacity: today = the room left, later days = the full limit;
  - each day's row is red with "חסרים N — יחכו בתור" when planned > capacity, and the panel border turns red.

Verified visually with a stub payload (Hebrew RTL, warning state).

### Never send a batch that will be refused

- **Per tick:** `runDailyEngine` cuts the batch to the room *before* sending and logs `held: cap`.
- **Per message (backstop):** `pickGuestPhone` returns no number once the room is 0, so `post()` returns `guests-daily-budget` (held) without calling Meta.
- **Event-day blast and gift blast:** both stop at the room.

---

## 4. Tomorrow 03/11: Kriaf gift blast (token `c1c5fcf5-dcf4-4b30-8014-e866a3623c79`, event 02/11)

Read-only numbers from `/api/send-board` on 02/11 18:44:
- **83** unique guests: **31 מגיע**, **24 לא מגיע** (83 − 59 non-declined), 28 other.
- Plan is not basic, so stage 3 *will* send a thank-you to the 31 tomorrow morning.
- `/api/cap-status` at the same time: `capped:true`, `frees_at 2026-11-03T13:22Z` (15:22 IL). Read that as "probably after 15:22".

**Before 09:00** (the stage-3 thank-you runs at the first tick):
1. Deploy this branch (`/gift/<slug>` must exist first) and submit `ishur_toda_matana` + `ishur_matana` (section 2).
2. If `ishur_toda_matana` is **APPROVED before 09:00**, stage 3 sends it to the 31 confirmed guests automatically (thank-you + gift, one message). The blast then only does the 24 declined guests.
3. If it is **not approved by 09:00** and you want the 31 to get the gift version instead of the plain thank-you, put the event on hold first:

   ```bash
   curl -s -X POST https://go.ishur.io/api/event-flag -H 'Content-Type: application/json' \
     -d '{"admin_key":"'$K'","token":"c1c5fcf5-dcf4-4b30-8014-e866a3623c79","flag":"hold","on":true}'
   ```

   This writes `hold:<token>` (`handleEventFlag`, `EVENT_FLAGS = ['extrasend','hold','cancel']`). Stage 3 skips events on hold; the blast does not look at hold.

**After approval, inside 09:00–20:30, and once the cap has room:**

```bash
# dry run (default) — read the per-guest list, counts, template status, cap
curl -s -X POST https://go.ishur.io/api/gift-blast -H 'Content-Type: application/json' \
  -d '{"admin_key":"'$K'","token":"c1c5fcf5-dcf4-4b30-8014-e866a3623c79","max":60}' | jq '{ok,refused,templates,gift_links,cap,counts}'

# real run — only after the dry run looks right
curl -s -X POST https://go.ishur.io/api/gift-blast -H 'Content-Type: application/json' \
  -d '{"admin_key":"'$K'","token":"c1c5fcf5-dcf4-4b30-8014-e866a3623c79","dry":false,"max":60}' | jq '{ok,counts,guests:[.guests[]|select(.result!="sent")]}'
```

**Expected counts** (dry, both templates approved):
- Stage 3 has not run: `thanks 31 + declined 24 = 55 send`, minus opt-outs, wrong numbers and decliners who already got the links in their reply.
- Stage 3 ran with the plain thank-you: the 31 show `skip: already-got-gift-message` (the `s3t:` marker), so **24 send**.
- `hold: held: cap` rows mean the cap is still closed. Run the same command again later; it only sends to the guests who have not got it yet.

To undo the hold afterwards, use the same call with `"on":false`.

---

## 5. What the tests do NOT prove

- Meta behaviour is stubbed everywhere. Nothing proves the four templates will be **approved**, or approved in the category they were submitted under.
- "Portfolio-shared" comes from Meta's docs, not from a measurement on these two numbers.
- Nothing ran against production KV. `wa:cap` with ids only appears after the next `waCapInfo` refresh (6h cache) or the first `/api/cap-status` / `/api/send-board` call after deploy. Until then tiers are unknown, which falls back to 230 per number and 250 shared.
- `gift-blast-route.test.mjs` depends on the clock. Outside 09:00–20:30 its two send-path tests accept the window refusal instead of exercising the send.
- The rolling counter starts empty on deploy. For the first 24h after deploy `used` is the old day counter only.
- `worker/scripts/check-registry.mjs` was already failing at base (stale line anchors). It is still failing and was not re-pinned.
