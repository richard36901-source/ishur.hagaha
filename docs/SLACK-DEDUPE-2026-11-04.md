# Slack de-dupe · 04/11/2026 — "תצמצם ספאם בסלאק"

Branch `slack-dedupe` (worktree `~/ishur-slackdd`). Not deployed. Nothing was sent to Slack or WhatsApp while building this; tests stub the hook.

## The problem

~15 Slack lines a day, most of them the same standing condition said again:

1. `worker/notify.js` rules carry a repeat `window` (incident 6h, cap_high 12h, hold_stale 24h …) so a condition that stays true re-alerts every window. The 4499 billing block (131042) fired every 6h for days.
2. Three independent reporters describe the same state: the brain (`brain.js`, re-alert every `REALERT_MS` = 6h), `notify.js`, and ~80 direct `slackPost` / `slackSend` / `alert()` calls in `index.js` and the modules (morning undelivered list, verification-code attempts, capacity overflow, cap 90 %, "client X undelivered 131042" …), each with its own once-per-hour / once-per-day marker or none.

## What was built

### A. The state-change gate — `worker/slack-gate.js`, enforced in `slackSend`

Every poster goes through `slackSend` (`slackPost` → `slackSend`, `alert()` → `slackSend`, notify.js `d.slackSend`, the brain's `c.slack` → `d.slackSend`). The gate sits inside `slackSend`, so there is no second door.

Each alert carries a `key` = the identity of the **condition** (`131042:4499`, `cap_high`, `hold_stale:<tok8>`, `finding:<id>`, `wave_fail:<tok8>:<wave>`). Slack gets a line only when:

| event | when | line |
|---|---|---|
| OPEN | the key has no `slackstate:<key>` in KV | the alert, with a `מה לעשות:` footer |
| WORSE | severity went up (P2 → P1) or `level` crossed a higher band (`bands`, e.g. cap `[85, 90, 97, 100]`) | `⬆️ *החמיר* (P2 · 86 → P2 · 91) · …` |
| CLOSE | `slackResolve(env, key)` or the per-tick sweep found the key gone | `✅ *נפתר* · <title>` + `חזר N פעמים בינתיים` |
| otherwise | SILENT | nothing; `count` +1 in KV; a `סלאק·שקט` row in the stream |

State: `slackstate:<key>` `{opened_at, last_at, sev, last_level, count, title, cls}` (TTL 30 d). CLOSE appends to `slackclosed:<day>`; info lines append to `slackinfo:<day>` (both feed the digest).

**No bypass by accident:** a poster with no `key` and no `oneoff: true` gets `autoKey(text)` — the title line without numbers / tokens / emoji / links — so it is deduped on its title and never dropped. `oneoff: true` is only for single events (a payment, a lead, a send completed, an admin action) and every such call site says so in a code comment. `test/slack-gate.test.mjs` scans `worker/*.js` and fails if any `slackPost` / `slackSend` / `alert` / `d.slack*` / `c.slack` call lacks `key:` / `oneoff: true` / `cls:` / `quiet: true`.

Without KV (tests, local) every call is OPEN — nothing is lost, just not deduped.

### B. Routing by class

- `cls: 'p1'` (default) — something Richard must do → Slack through the gate.
- `cls: 'info'` — cap %, template approved, brain auto-fixed, verification-code attempts, capacity-planner overflow, the morning undelivered list, parked Grow payments, Shir's number at its cap → **never Slack on its own**: stored in the ops notifications center (`notify.js` rule `info`, app channel only) and folded into the morning digest.
- `quiet: true` — unchanged: dropped unless `SLACK_VERBOSE=1` (journal only).

**Morning digest** — `slackDigest()` in `slack-gate.js`, run by the pacer on the first tick after 09:00 Israel (where the bare night-queue flush used to run), once per day (`slackdigest:sent:<day>`). One message "☀️ בוקר · סיכום": open conditions (sev, since, repeat count), what resolved overnight, the info lines, the night queue (`slackq:list`, consumed), today's plan (sends planned from the capacity planner, guests waiting for Shir, events today), and a `מה לעשות:` footer. Registry node `slack_digest` (layer 2, from `d_pacer`), kill switch `auto:off:slack_digest` checked right before the step — when off, the old `flushSlackQueue` runs so the night queue never piles up. `registry-sync` test stays green; `check-registry.mjs` anchor errors 198 → 197.

### C. One key per condition across reporters

- Brain findings: `finding:<id>` — the brain's alert and notify.js `incident` (entity `finding:<id>`) share it. Whoever sees it first OPENs; the other is silent. The brain's `resolved` event calls `resolveSlack` → one CLOSE; notify's sweep would also close it (idempotent).
- Cap: notify `cap_high` → key `cap_high`, level = %, bands `[85, 90, 97, 100]`; P2 is info-class (digest), P1 (97 %+) goes to Slack. The brain's `capacity_warning` playbook → `capacity_overflow:<day>`, info.
- WhatsApp cap: `alert('תקרת וואטסאפ')` → `wacap:guests` (P1); "▶️ התקרה נפתחה" is now `slackResolve('wacap:guests', …)` = the CLOSE line.
- Wave failures: the `slackPost` and the `alert()` on the same wave share `wave_fail:<tok8>:<wave>`.
- Ads: `adsHealthWatch` → `ads_account`; "חזר לפעול" is `slackResolve('ads_account')`.
- 131042: `alert('לא נמסרה')` with code 131042 → `131042:4499` (P1, `SLACK_FOOTERS` action). Other codes → `undelivered:<code>:<phone>`, info-class for the no-action codes (131026 / 130472 / 131049 / 131047).
- notify.js standing rules (`STANDING`) are swept every tick with the full pre-dedup candidate set: a key that stopped appearing → CLOSE. `unanswered` is not swept out of hours (it is not evaluated then).

### D. Format

`withAction()` appends `───\nמה לעשות: …` once (the `action` opt, or the ops-center link); `slackFormat` keeps its `SLACK_FOOTERS` and no longer adds a second footer when `מה לעשות:` is present. CLOSE and the digest follow the same title · spaced facts · footer shape.

## Known limits / not done

- `checkBilling` (`billing_check`, one key for all vendors) and notify `balances_low:<vendor>` describe overlapping conditions under different keys — two lines possible on the first day a balance drops. Fix: split `checkBilling` per vendor (`balances_low:<vendor>`).
- `slackstate:*` keys are listed with `RATE.list()` for the sweep and the digest; Cloudflare KV `list()` lags writes (memory: cloudflare-kv-list-lag) — a key opened seconds before a sweep can be missed once and closed on the next tick. The digest may likewise miss a key opened within the last minute.
- The digest's "today's plan" depends on `buildCapacity` / the snapshot; when either fails the section shows `?`.
- Quiet-hours queueing is unchanged: a non-urgent OPEN at night queues and appears in the digest's "מה קרה בלילה" (max 15 lines shown; all in the journal).

## Every Slack poster (generated from the code by the same scanner the test uses)

class: `p1` = Slack through the gate · `info` = notifications center + digest · `oneoff` = single event, no gate · `quiet` = dropped unless SLACK_VERBOSE. key `auto` = no explicit key → autoKey(title).

| file:line | call | title | key | class | note |
|---|---|---|---|---|---|
| ads.js:85 | slackSend | ⚠️ *מודעות*: לא הצלחתי לקרוא את מצב החשבון ממטא — ${h.error  | `'ads_read_fail'` | p1 |  |
| ads.js:95 | slackSend | 🚨 *שגיאה במודעות* (…)\n${lines.join( | `'ads_issues'` | p1 |  |
| ads.js:134 | slackPost | \n | `'ads_account'` | p1 |  |
| ads.js:200 | slackPost | ⚠️ CAPI: רכישה … לא דווחה למטא — | `—` | oneoff | oneoff: one purchase, one CAPI attempt |
| brain.js:382 | c.slack | 🚨 *מוח · קובץ האורחים לא נטען* · 3 ניסיונות נכשלו. השליחות  | `'finding:snapshot_fail'` | p1 |  |
| brain.js:407 | c.slack | capacity_overflow: | `'capacity_overflow:' + x.day` | info |  |
| brain.js:433 | c.slack | ⚙️ מוח · אירוע … ${on ? | `—` | oneoff | oneoff: a single approved action |
| brain.js:613 | c.slack | ${f.severity === | `'finding:' + f.id` | p1 |  |
| brain.js:637 | c.slack | info | `auto` | info | notes are housekeeping → center + digest |
| brain.js:727 | d.slackPost | 🧠 *מוח · אושר* · … · … → ${res.ok ? | `—` | oneoff | oneoff: Richard just approved it |
| callqa.js:232 | slackPost | 🔎 *בקרת שיחה · ${c.agent // | `—` | quiet | oneoff: one call reviewed (quiet: dropped unless SLACK_VERBOSE) |
| crm.js:569 | d.slackPost | 🗂 … · אירוע … | `—` | oneoff | oneoff: one admin edit on a client card |
| index.js:192 | alert | הפניה מאומתת 🎉 | `—` | oneoff | oneoff: a referral was verified — single event |
| index.js:239 | slackPost |  | `—` | oneoff | oneoff: salesflow lines are single lead events (quote sent, asked for a human, flow stopped) |
| index.js:367 | slackSend | 💳 שולם עיצוב הזמנה · ₪${sum // | `—` | oneoff | oneoff: a payment landed |
| index.js:391 | slackSend | 🎨 *בריף עיצוב הזמנה* · … · …${paid ? | `—` | oneoff | oneoff: a brief was submitted |
| index.js:420 | slackSend | 🎨 … · אירוע … · https://ishur.io/dashboard.h | `—` | oneoff | oneoff: one design step happened |
| index.js:514 | alert | סבב עיצוב | `—` | oneoff | oneoff: one payment that needs manual matching |
| index.js:598 | alert | תשלום Grow לא זוהה (נאמר פעם אחת) | `—` | oneoff | oneoff: already said once per payment |
| index.js:631 | alert | תשלום Grow | `—` | oneoff | oneoff: one payment |
| index.js:671 | slackPost | 💳 *תשלום חדש* · ₪${flat.paymentSum // flat.sum // | `—` | oneoff | oneoff: a payment landed |
| index.js:698 | slackPost | 🧑‍💼 *נרכשו ${bought.hostess === 1 ? | `—` | oneoff | oneoff: a purchase |
| index.js:741 | alert | תשלום Grow | `—` | oneoff | oneoff: one payment ref |
| index.js:777 | slackPost |  | `—` | oneoff | oneoff: a deal closed |
| index.js:831 | alert | חשבוניות | `—` | oneoff | oneoff: one invoice for one payment ref |
| index.js:1065 | slackPost | 📋 *ליד מטופס מטא בלי טלפון* · ${name // | `—` | oneoff | oneoff: a lead arrived |
| index.js:1087 | slackPost | meta | `—` | oneoff | oneoff: a lead arrived |
| index.js:1130 | slackPost | \n | `—` | oneoff | oneoff: one lead ping (leadslack marker) |
| index.js:1310 | slackPost | 📨 *${bits.join( | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:1342 | slackPost | ${body.on ? | `—` | quiet | oneoff: an admin action |
| index.js:1361 | slackPost | ⚙️ ${flag === | `—` | quiet | oneoff: an admin action |
| index.js:1569 | alert | תוספת | `—` | oneoff | oneoff: one purchase |
| index.js:1603 | slackSend | 🚗 *נסיעות דיילת שולמו* · … · אירוע ${token.slice(0, 8) | `—` | oneoff | oneoff: a payment |
| index.js:1608 | slackSend | 💳 *הפעלת הודעות לנרשמים מהקישור* · … · אירוע ${token.s | `—` | oneoff | oneoff: a payment |
| index.js:1615 | slackSend | 💳 *תוספת ${addon.kind === | `—` | oneoff | oneoff: a payment |
| index.js:1640 | slackSend | ⬆️ *שדרוג חבילה* · … · אירוע …\n\n${ | `—` | oneoff | oneoff: a payment (upgrade) |
| index.js:1666 | slackPost | ⚠️ *שליחה נוספת* · אירוע …: שולם, אבל אין יום פנוי | `'wave3_noslot:' + token.slice(0, 8)` | p1 |  |
| index.js:1670 | slackPost | 💳 *תוסף שליחה נוספת* · … · אירוע … | `—` | oneoff | oneoff: a payment |
| index.js:1692 | slackPost | 💳 *תוספת … מוזמנים* · … · אירוע ${token.slice | `—` | oneoff | oneoff: a payment |
| index.js:1816 | alert | העלאה | `—` | oneoff | oneoff: one upload request failed |
| index.js:1864 | slackPost | 📈 *חריגת מכסה בהעלאה* · ${rec.name // | `'over_quota:' + String(rec.token // rec.phone // '')` | p1 |  |
| index.js:1920 | slackPost | 📎 *תוספת מוזמנים הועלתה* · אירוע … · ${guests.leng | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:1924 | slackSend | 📋 *רשימת מוזמנים הועלתה* · אירוע … · ${guests.leng | `—` | oneoff | oneoff: a list was uploaded |
| index.js:2012 | slackSend | ⚙️ *הגדרות האירוע נשמרו* · אירוע …${out.title ? | `—` | oneoff | oneoff: settings saved once by the client |
| index.js:2154 | slackPost | 📈 *הזדמנות הגדלה* · ${rec.name // | `'over_quota:' + String(phone // '')` | p1 |  |
| index.js:2188 | slackPost | 📎 רשימת מוזמנים נקלטה בוואטסאפ · ${rec.name // | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:2401 | slackPost | 🔐 כניסת ניהול חדשה אושרה בקוד לטלפון שמסתיים ב-…. תו | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:2473 | slackPost | 📞 *נועה העבירה שיחה* — … (…) חובר ל${tried[tried.length - 1 | `—` | oneoff | oneoff: a call was transferred |
| index.js:2476 | slackPost |  | `—` | oneoff | oneoff: a call ended |
| index.js:2499 | slackPost | 📞 שיר רשמה תוצאה ממספר שלא מופיע בגיליון: ${inbPhone // | `—` | oneoff | oneoff: one call result |
| index.js:2567 | slackPost | 📞 *שיחת מכירה של נועה הסתיימה* · …${dur != null ? | `—` | oneoff | oneoff: a sales call ended |
| index.js:2650 | slackPost | 🕐 … אורחים ממתינים לשיחה, אבל חלון החיוג סגור (${win.wh | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:2691 | slackPost | 📞 *… אורחים ממתינים לשיחה ואף אחד לא חויג.* שווה בדיקה. | `'call_queue_stuck'` | p1 |  |
| index.js:2693 | slackPost | 📞 שיר חייגה ל-… אורחים${blocked ? | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:2840 | alert | קצב הסרות גבוה | `'optout_rate:' + day` | p1 |  |
| index.js:2965 | slackPost | 📲 שיר חזרה ל-… מי שהתקשרו אלינו ולא ענינו. | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:3058 | slackPost | 📞 *נועה יצאה ל-… שיחות מכירה* ללידים שנטשו ולא ענו להו | `—` | oneoff | oneoff: one dial batch went out |
| index.js:3353 | alert | תקרת וואטסאפ | `'wacap:guests'` | p1 |  |
| index.js:3357 | slackPost | ⚠️ מספר ${pidHit // | `'cap_number:' + (pidHit // '?')` | info |  |
| index.js:3431 | alert | לא נמסרה | `/131042/.test(String(err.code // '')) ? '131042:4499' : 'undelivered:' + String(err.code /` | info/p1 by code |  |
| index.js:3568 | slackPost | whatsapp | `—` | oneoff | oneoff: a lead arrived (leadslack marker) |
| index.js:3598 | alert | קובץ בוואטסאפ | `—` | oneoff | oneoff: one file failed |
| index.js:3707 | slackPost | 🔎 *מספר לא מזוהה ענה על הזמנה* · … לחץ | `—` | oneoff | oneoff: one unknown reply |
| index.js:3721 | slackPost | ↩️ מספר סומן | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:3800 | alert | וובהוק וואטסאפ | `'wa_webhook_error'` | p1 |  |
| index.js:3931 | slackPost | 💬 *שאלת אורח לבעלי השמחה* <@${env.SLACK_RICHARD // | `—` | oneoff | oneoff: a guest asked a question |
| index.js:4173 | slackSend | ⚠️ *ניסיון לחלץ הוראות מנועה* · …\n | `'noa_inject:' + phone` | p1 |  |
| index.js:4225 | slackSend | 🙋 *ביקשו בן אדם* · …\nנועה יצאה מהשיחה, זה אצלך. ${tail ? | `—` | oneoff | oneoff: a person asked for a human |
| index.js:4243 | slackSend | ⚠️ *${label === | `'noa_flag:' + label + ':' + phone` | p1 |  |
| index.js:4575 | slackPost |  | `—` | oneoff | oneoff: A/B rotation decisions, one per evaluation |
| index.js:4785 | alert | הודעת יום האירוע | `'eventday:' + token.slice(0, 8)` | p1 |  |
| index.js:4792 | alert | הודעת יום האירוע | `'eventday:' + token.slice(0, 8)` | p1 |  |
| index.js:4800 | alert | הודעת יום האירוע | `'eventday:' + token.slice(0, 8)` | p1 |  |
| index.js:4845 | slackPost | 🎉 *הודעת יום האירוע* · …: נשלחו …${failed ? | `—` | oneoff | oneoff: a send completed |
| index.js:4930 | slackPost | 🎁 *מתנה לאורחים* · …: נשלחו …${failed ? | `—` | oneoff | oneoff: a send completed |
| index.js:4983 | slackPost | 📝 *נוסח הזמנה בהתאמה אישית* · אירוע … · ${rec.stat | `—` | oneoff | oneoff: a template was submitted |
| index.js:5049 | slackPost | ${st === | `—` | oneoff | oneoff: Meta decided once per template |
| index.js:5092 | slackPost | 📞 *סבב שיחות נוסף* · אירוע …: … אורחים חזרו לתו | `—` | oneoff | oneoff: a round was queued |
| index.js:5160 | alert | תשובת אורח לא נשמרה | `'rsvp_write_fail'` | p1 |  |
| index.js:5413 | alert | מנוע יומי | `'engine_no_sheet'` | p1 |  |
| index.js:5428 | slackPost | 🕯️ *… מסומן כיום ללא יצירת קשר.* לא נשלחו הודעות ולא בוצעו  | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:5442 | slackPost | ⏸️ *המנוע היומי לא רץ* — השליחה מושהית ידנית. להפעלה מחדש: ה | `'engine_paused'` | p1 |  |
| index.js:5496 | slackPost | 🟠 *לקוח תקוע* · ${v.name // | `'client_stuck:' + v.phone` | p1 |  |
| index.js:5502 | alert | לקוח תקוע | `'client_stuck_check'` | p1 |  |
| index.js:5547 | alert | חבילה | `'sheet_write_plan'` | p1 |  |
| index.js:5597 | slackPost | 🟠 *אירוע משולם בלי הגדרות* · ${ev[2] // | `'no_setup:' + token.slice(0, 8)` | p1 |  |
| index.js:5608 | alert | בריאות ערוץ | `'channel_health'` | p1 |  |
| index.js:5641 | alert | 🚨 אירוע ששולם ולא יצאה ממנו הזמנה | `'no_invite:' + token.slice(0, 8)` | p1 |  |
| index.js:5710 | alert | גל 3 | `'wave3_held:' + token.slice(0, 8)` | p1 |  |
| index.js:5736 | slackPost | ⚠️ גל … · …: … שליחות נכשלו, | `'wave_fail:' + token.slice(0, 8) + ':' + wave.key` | p1 |  |
| index.js:5748 | alert | גל שליחה | `'wave_fail:' + token.slice(0, 8) + ':' + wave.key` | p1 |  |
| index.js:5843 | alert | דוח שבוע-לפני | `'send_fail:' + token.slice(0, 8) + ':doch'` | p1 |  |
| index.js:5942 | alert | סוף-אירוע | `'eoe_links:' + token.slice(0, 8)` | p1 |  |
| index.js:5956 | alert | סוף-אירוע | `'send_fail:' + token.slice(0, 8) + ':syum'` | p1 |  |
| index.js:6031 | alert | הודעות שולחן | `'send_fail:' + token.slice(0, 8) + ':table'` | p1 |  |
| index.js:6054 | alert | חבילה חסרה | `'plan_missing:' + token.slice(0, 8)` | p1 |  |
| index.js:6076 | alert | אירוע בוטל | `—` | oneoff | oneoff: the event was cancelled once |
| index.js:6108 | alert | הודעת ביטול | `'send_fail:' + token.slice(0, 8) + ':cancel'` | p1 |  |
| index.js:6128 | alert | תאריך האירוע השתנה בגיליון | `—` | oneoff | oneoff: the date changed once |
| index.js:6167 | alert | הודעת דחייה | `'send_fail:' + token.slice(0, 8) + ':postpone'` | p1 |  |
| index.js:6174 | alert | אירוע נדחה | `—` | oneoff | oneoff: the event was postponed once |
| index.js:6231 | alert | תזכורת יום-לפני | `'send_fail:' + token.slice(0, 8) + ':daybefore'` | p1 |  |
| index.js:6257 | slackPost | 💡 *הצעת שדרוג נשלחה* · … (בסיס): …/… לא ענו להוד | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:6283 | slackPost | 💡 *הצעת הכל כלול נשלחה* · … (פרמיום): …/… | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:6378 | slackPost | ✅ מטא אישרה את *…* כ-UTILITY — ההזמנות עוברות אליה (בלי מגבל | `'template_ok:' + t.name` | info |  |
| index.js:6382 | slackPost | ✅ מטא אישרה את התבנית *…* — הופעלה אוטומטית. | `'template_ok:' + t.name` | info |  |
| index.js:6395 | slackSend | 🚨 *בעיה בתבנית וואטסאפ* · … מצב: …${reason ? | `'template_bad:' + t.name` | p1 |  |
| index.js:6415 | slackSend | ✅ מטא אישרה את שם התצוגה של נועה (${j.new_display_name // j. | `—` | oneoff | oneoff: Meta approved once |
| index.js:6419 | slackSend | 🚨 מטא דחתה את שם התצוגה | `—` | oneoff | oneoff: Meta rejected once |
| index.js:6457 | slackSend |  | `—` | oneoff | oneoff: the one daily digest |
| index.js:6512 | slackPost | 🚨 *פעימת שליחה נכשלה* (${(r && r.error) // | `'pacer_failed'` | p1 |  |
| index.js:6659 | slackSend | ℹ️ *רופא · תשלומים שחנו* · | `'doctor:ipnmiss'` | info |  |
| index.js:6684 | alert | רופא · יומן המערכת | `'doctor:journal'` | p1 |  |
| index.js:6696 | alert | רופא · תור השיחות | `'doctor:callqueue'` | p1 |  |
| index.js:6705 | alert | רופא · תבניות מטא | `'doctor:templates'` | p1 |  |
| index.js:6747 | slackPost | :alarm_clock: *תזכורת צוות ל…* (לא נמסרה בוואטסאפ, חלון 2 | `—` | oneoff | oneoff: one team reminder that could not go out |
| index.js:6819 | alert | גיבוי | `—` | oneoff | oneoff: one manual backup request |
| index.js:7069 | slackSend | [phase-6 test] | `—` | oneoff | oneoff: the /api/test-slack-queue harness |
| index.js:7155 | alert | קוד כניסה | `'otp_fail:' + phone` | p1 |  |
| index.js:7740 | slackPost | 🎓 *…* · גרסה … הוחלה — … | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:7843 | slackPost | \n | `—` | oneoff | oneoff: the 20:00 daily improve report, one a day by design |
| index.js:8062 | slackSend | \n | `—` | oneoff | oneoff: the Monday performance digest, weekly by design |
| index.js:8229 | slackPost | \n | `—` | oneoff | oneoff: the 21:00 journal digest, one a day by design |
| index.js:8241 | slackPost | 📊 *ביצועי הודעות — סיכום שבועי*\n${lines.join( | `—` | oneoff | oneoff: weekly by design |
| index.js:8380 | slackPost | ⏸️ *כל השליחות הושהו* — אף הודעה לא תצא, כולל המנוע היומי וש | `—` | oneoff | oneoff: an admin action |
| index.js:8387 | slackPost | ▶️ *השליחות חזרו לפעול* — הפעימה הקרובה (עד 10 דקות) ממשיכה  | `—` | oneoff | oneoff: an admin action |
| index.js:8417 | slackPost | ${body.blocked ? | `—` | oneoff | oneoff: an admin action |
| index.js:8505 | slackSend | billing_check | `'billing_check'` | p1 |  |
| index.js:8528 | alert | Retell | `'retell_billing'` | p1 |  |
| index.js:8549 | alert | טלניקס | `'telnyx_status'` | p1 |  |
| index.js:8556 | alert | טלניקס | `'telnyx_numbers'` | p1 |  |
| index.js:8563 | slackPost | ⏳ *המספר של שיר עדיין לא פעיל*\n… · סטטוס: …\nאם זה נמש | `'telnyx_pending'` | p1 |  |
| index.js:8578 | slackPost | 🎉 *המספר של שיר פעיל וחובר*\n… משויך לחיבור ה-SIP, ורטל יכו | `—` | oneoff | oneoff: the number got wired once |
| index.js:8706 | slackPost |  | `—` | oneoff | oneoff: Meta sent the SMS — Richard must type the code |
| index.js:8708 | slackPost | ⏳ ניסיון יומי לקוד אימות ל-4499 נכשל: …. ננסה מחר. | `'otp_4499'` | info |  |
| index.js:8733 | slackPost | 📞 נועה מתקשרת עכשיו ל-… (${phone.replace(/^972/, | `— (dropped unless SLACK_VERBOSE)` | quiet |  |
| index.js:9145 | slackPost |  | `—` | oneoff | oneoff: the every-4-days ad review, by design |
| index.js:9311 | slackPost | 🔴 *CAC חצה את הקו האדום* · … ₪ ללקוח החודש (… ₪ | `'cac_red'` | p1 |  |
| index.js:9898 | alert | המנוע היומי | `'engine_stale'` | p1 |  |
| index.js:9916 | slackPost | 🔏 *עוגן יומן ביקורת* · … · … רשומות\nroot: \ | `—` | oneoff |  |
| index.js:9921 | alert | לולאת שיפור | `'job_fail:improve'` | p1 |  |
| index.js:9924 | alert | דוח יומי | `'job_fail:digest'` | p1 |  |
| index.js:9962 | alert | פייסר | `'pacer_crash'` | p1 |  |
| index.js:9999 | slackPost | 🌅 *בוקר · הזמנות שלא נמסרו*\n | `'undelivered:day:' + ilDate()` | info |  |
| index.js:10002 | alert | גיבוי יומי | `'backup_fail'` | p1 |  |
| index.js:10003 | alert | מנוע יומי | `'engine_crash'` | p1 |  |
| index.js:11126 | slackPost | 🔗 *נועה חוברה ל-API (coexistence)*\n… | `—` | oneoff | oneoff: coexistence connected once |
| index.js:11228 | slackPost | 🆕 *ליד חדש במאנדיי* | `—` | oneoff | oneoff: a new Monday lead (seenOnce mnew:) |
| index.js:11498 | slackSend | ⚠️ *דיילות: לא נוצר קישור תשלום* · ${name // phone // | `—` | oneoff | oneoff: one hostess request |
| index.js:11499 | slackSend | 📅 *דיילות: תאריך תפוס* · ${name // phone // | `—` | oneoff | oneoff: one hostess request |
| index.js:11847 | slackPost | 💳 *… · מישהו לחץ | `—` | oneoff | oneoff: one click |
| index.js:11986 | alert | תוספות | `'paylink_fail:' + tok.slice(0, 8)` | p1 |  |
| index.js:12004 | alert | תוספות | `'paylink_fail:' + tok.slice(0, 8)` | p1 |  |
| index.js:12047 | slackSend | 📝 *הערת משוב* · … · … ימליץ ${rec.nps // | `—` | oneoff | oneoff: one feedback note |
| index.js:12060 | slackSend | ${route === | `—` | oneoff | oneoff: one feedback |
| index.js:12159 | slackSend | ❌ *הלקוח ביטל את האירוע* · … · …\n\nהודעת ה | `—` | oneoff | oneoff: the client cancelled once |
| index.js:12181 | slackSend | ↩️ *האירוע חזר* · … · …${renotify ? | `—` | oneoff | oneoff: restored once |
| index.js:12204 | slackSend | 📅 *האירוע נדחה* · … · …\n\n… → ${ | `—` | oneoff | oneoff: postponed once |
| noa.js:487 | slackPost | 📞 *נועה יצאה ל-… שיחות רדיפה* ללידים מהלוח שלא ענו. | `—` | quiet | oneoff: one dial batch (quiet) |
| notify.js:465 | d.slackSend |  | `—` | oneoff | oneoff: the CLOSE line itself is the single event |
| ops.js:790 | d.slackPost | 🎛️ *מרכז בקרה* · … | `—` | oneoff | oneoff: an admin action |
| ops.js:830 | d.slackPost | 🎛️ *מרכז בקרה* · … · … | `—` | oneoff | oneoff: an admin action |
| ops.js:867 | d.slackPost | 🎛️ *מרכז בקרה* · שחזור: ${p.pause ? | `—` | oneoff | oneoff: an admin action |
| ops.js:878 | d.slackPost | 🎛️ *מרכז בקרה* · ↩️ הוורקר הוחזר לגרסה ${String(p.version_i | `—` | oneoff | oneoff: an admin action |
| raffle.js:208 | d.slackSend | 🎟️ *הגרלה* · … · ${path === | `—` | oneoff | oneoff: one raffle entry |
| subevent.js:387 | d.slackPost | …: הושלם, נשלחו … | `—` | oneoff | oneoff: completed once |
| subevent.js:416 | d.slackPost | …: תזכורת הושלמה, נשלחו … | `—` | oneoff | oneoff: completed once |
