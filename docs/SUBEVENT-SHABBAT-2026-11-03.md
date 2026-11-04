# Sub-event "שבת חתן" (kind `shabbat`) — runbook (03/11/2026)

Code: `worker/subevent.js` (pure logic + routes), wired in `worker/index.js`
(routes, WhatsApp inbound hook, parent `/api/status` → `subevents`), `worker/send-board.js`
(`data.subevents`), `assets/sendboard.js`, `dashboard.html`. Tests: `worker/test/subevent.test.mjs`.

## Model
No route creates sheet events, so a sub-event is a **KV-backed virtual event**:

| key | value |
|---|---|
| `subevent:<sub>` | `{parent, kind:'shabbat', template, name, created}` |
| `subevents:<parent>` | `[<sub>…]` (parent board card) |
| `shrsvp:<sub>:<phone>` | `{status: with_stay\|no_stay\|no\|undecided\|yes, n, at, raw, await}` |
| `shsent:<sub>:<phone>` | idempotency mark: one message per guest, ever |
| `shwamid:<wamid>` | `<sub>`, a reply quoting our message goes to the sub |
| `shctx:<phone>` | `<sub>`, free text while the conversation is open (14 days, cleared when final) |

- **Guest list = live mirror.** Every read takes the parent's guest rows (`g[28] == parent`) from the
  sheet snapshot. Nothing is copied, so nothing needs re-syncing. Guests added to the parent later
  show up on the sub board, and a later `subevent-send` run sends to them, because only the new
  phones lack a `shsent` mark.
- **The parent RSVP is never written.** The sheet hook (`HOOK_EVENTS`) is not called and
  `awaitparty` is not armed. Sub statuses live only in `shrsvp:`.
- **One message, nothing else.** No wave 2/3, day-before, event-day, table, thank-you or Shir
  calls. The engine never sees the sub-event because it reads events only from the sheet.

## Guest replies
1. Button with `context.id` = our message (`shwamid:`) → sub. A quoted *parent* message → normal flow.
2. Otherwise, while `shctx:<phone>` is open, button/text → sub.
3. Buttons: עם לינה / בלי לינה → "איזה כיף! כמה תהיו בסך הכל?". The next number is stored as `n` and
   Shir replies "מעולה, רשמנו N 🙏". לא מגיע/ה → "תודה שעדכנתם 🙏".
4. Free text: לינה / בלי (ללא) לינה / לא מגיעים / numbers / "אולי", or a question → מתלבטים.
   "כן" with no lodging info → Shir asks "עם לינה או בלי לינה?".
5. Shir's replies never contain an event name or the client's name.
6. Opt-out, nocall and "טעות" are handled by the normal flow before this hook runs.

## Send gates (`POST /api/subevent-send`)
The real send (`dry:false`) **refuses** when:
- the parent is cancelled (`AB` = כן): `parent-cancelled`
- the parent is on hold (`hold:<parent>`): `parent-on-hold`
- the parent event date is in the past
- the template in `subevent:<sub>` is not **APPROVED** on the guests WABA 1378764257421712 (live
  Meta read): `template-not-approved`
- **any** parent guest row has an empty phone: `guest-rows-with-empty-phone`, with the names in
  `empty_phone_rows`. Fix the sheet, then re-run.
- the window is closed (outside the send window, a no-contact day, sending paused, or `wacap:guests`):
  `send-window-closed`

The real send also never goes past the cap room (`guestCapacity`) or `max` (default 50, at most 500).
Guests past that are `hold`. If Meta holds a send mid-run, the run stops. Re-running is safe:
anyone with `shsent` is skipped. A cap-failed delivery (131048…) is reopened by the status webhook
through `wamid:` (wave `shabbat`), so the next run resends to that guest.

**Template parameters:** exactly one, `{{1}}` = the guest's name (`g[3]`, cleaned). If it is empty,
"אורחים יקרים". There is no header, no image, and no event or client name.

**Dry run** (the default): returns the per-guest plan (phones masked), `preview.guests[0..4].body`
(the body text with `{{1}}` filled in, read from Meta), the footer, `buttons`, the template
status, and `would_refuse_real` (why a real send would refuse right now).

## Runbook: Zaguri
```bash
K=<admin_key>; P=ffb78392-d81f-44dd-8d83-ac07603507be
# 1. create (writes KV; returns the sub token + its dashboard link)
curl -s -X POST https://go.ishur.io/api/subevent -H 'Content-Type: application/json' \
  -d "{\"admin_key\":\"$K\",\"parent_token\":\"$P\",\"kind\":\"shabbat\",\"template\":\"ishur_shabat_hatan_zaguri\",\"name\":\"שבת חתן · זגורי\"}"
S=<token from step 1>
# 2. dry run: read preview, counts, template_status, would_refuse_real
curl -s -X POST https://go.ishur.io/api/subevent-send -H 'Content-Type: application/json' \
  -d "{\"admin_key\":\"$K\",\"token\":\"$S\",\"dry\":true,\"max\":200}"
# 3. real send, only after Richard's explicit "שלח" (repeat if the cap holds some guests)
curl -s -X POST https://go.ishur.io/api/subevent-send -H 'Content-Type: application/json' \
  -d "{\"admin_key\":\"$K\",\"token\":\"$S\",\"dry\":false,\"max\":200}"
# 4. summary (client-safe, same as the dashboard)
curl -s "https://go.ishur.io/api/subevent-summary?token=$S"
```
Dashboard URL pattern: `https://ishur.io/dashboard.html?t=<subtoken>`, the same page as every event. `/api/status` answers 404 for a sub token, so the page falls back to `GET /api/subevent-summary` and renders the summary view. The admin clients page (`clients.html`, from `/api/status` `view:'biz'` → `subevents`) shows each sub-event as its own row, "שבת חתן · <client>", under its parent, with both dashboard links. The parent board shows an "אירועים מקושרים"
card. The admin send-board lists the sub-event with its single message type.

Step 1 is idempotent: the same parent, kind and template returns the existing sub (`existed:true`).

## 04/11 — v2: normal-looking board + one reminder

**Board.** `dashboard.html?t=<sub>` now renders with the normal board's components (`.kpis` row of 5, `.filt` status chips, `.gsearch`, sort chips, `.rows-h` + `.row` + brand `.pill`s, masked phone + IL reply time). Pure renderer `subeventHtml()` between `SUBEV-HTML-START/END`, tested in `worker/test/subevent-dashboard.test.mjs`. Screens: `docs/subevent-screens/` (sample data, masked).

**Reminder (one per guest).** `POST /api/subevent-remind {admin_key, token, dry=true, max, when?, at='10:00', cancel?, reminder_template?}`
- `when:'YYYY-MM-DD'` only schedules: `subevent:<sub>.reminder_at = '<when>T<at>'` (Israel time). Nothing is sent by that call.
- From `reminder_at` the pacer (`continueSubevents` → `continueReminder`, registry node `subevent_reminder`) sends 25 per tick inside the send window and cap. When it finishes it sets `reminder_completed_at`, writes a change-log row and posts to Slack: "<name>: תזכורת הושלמה, נשלחו X".
- Who gets it: guests who got the first message (`shsent`), have no reply (`shrsvp`), aren't opted out or marked wrong number, have fewer than 3 failures (`shremfail`), and have no `shrem:<sub>:<phone>` mark. The reminder refuses until the first send is `completed_at`.
- Template: `reminder_template` once Meta APPROVED it, else the original template. Draft: `worker/templates/ishur_shabat_hatan_reminder.json`.
- Kill switch `auto:off:subevent_reminder`. `subevent_continue` also stops it, because it gates the whole pacer half.
- Dashboard line: "תזכורת: מתוכננת 05/11 מ-10:00" → "תזכורת: נשלחה X".
- Scheduled 04/11 for זגורי (ab699ac0…): `reminder_at = 2026-11-05T10:00` (written to prod KV). It only takes effect once this code is deployed.
