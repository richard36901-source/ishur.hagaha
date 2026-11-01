# סקירת לילה · main-executer · 01→02/11/2026

## בקצרה (לריצארד)

כל שבעת התוצרים (A–G) בנויים ונבדקו מקומית, והכול יושב כ-commits על הענף `main-executer`. **שום דבר לא נפרס** (גם לא `agent/`, כי אין לו פרטי גישה), **לא נשלחה אף הודעה** לאורחים, ללקוחות או ללידים, ו-**`/api/wave-retry` לא נקרא**.

מה צריך לדעת לפני החתונה של הדר ויצחק מחר:
- **"החזק" לא עוצר את הודעת יום האירוע.** `runEventDayBlasts` לא בודק את `hold:`. כדי לעצור אותה צריך `/api/event-day` עם `action:"clear"`.
- **הודעת יום-לפני של הדר:** נמסרו 25 / נשלחו 271. ‏242 ממתינות ונפתחו מחדש (224 מהן חסומות בגלל תקרת המספר, 131048). זה לא 27/244 כמו בבריף, וההסבר בסעיף F.
- **גל גלילי `tries:0`:** זו לא תקלה. האירוע היה ב-13/10, ושיר לא מחייגת לאירועים שעברו. בינתיים תוקן ב-`de121f4` גם לוח השיחות, שלא יציג אותם.

תיקונים לבריף:
- **`/api/wave-retry {dry:true}` ו-`/api/daily-run {dry:true}` כותבים ל-RATE**, ו-wave-retry גם מוחק מפתחות. "יבש" שם לא באמת יבש.
- **כל קריאה עם admin_key ל-`/api/*` כותבת שורת יומן ל-RATE**, חוץ מ-`/api/stream`. כלומר קריאות "קריאה בלבד" הלילה יצרו כ-100 שורות יומן. הפירוט בסעיף "אירועים".

ממצאים שכדאי לטפל בהם:
- **באג אמיתי:** התשובה "טעות 2 מגיעים" (תיקון מספר מגיעים) מתפרשת כ"מספר שגוי" (`whatsapp.js:518-519`), והאורח מושתק לכל האירוע.
- **עלות:** הודעת יום-לפני עוברת דרך `ishur_yom_lifnei_f`, שמסווגת שיווקית (₪0.13), במקום `ishur_yom_lifnei` שמסווגת כ-utility (₪0.02).
- **פרטיות:** GitHub Pages מגיש את כל הריפו. ‏`/docs/`, `/worker/` ו-`HANDOFF.md` פתוחים לכל אחד. ‏robots.txt לא עוצר קריאה.

מחכה לאישור שלך: פריסה (Fable), "מאשר" לכל צעד שליחה, ההחלטות שבסוף המסמך.

---

## Branch and commits

All on `main-executer`, branched from `a1c3d8a` (tonight's hotfix, deployed as 1461afe4). Not pushed.

| Commit | What |
|---|---|
| `4d7ac76` `b480ed7` `5873046` `c2ad504` | the brief + additions F, G, G.1 |
| `0210e34` | D+E: Meta ticket + Security Center sheet; legal name + עוסק מורשה on site |
| `6d4ccb2` | B: `agent/` Slack Worker (not deployed) |
| `39c9164` | A: automations registry, `/api/automations` module, `automations.html` |
| `1fdc72a` | G + G.1: GEO plan, site patches, 5 landing pages, offers.json |
| `83377bc` | site: promo popup now says "קיבלתם הטבה" (banned-word house rule) |
| `bf761d4` | C: A/B spec, `ab.js`, `template-stats.js`, `templates.html`, tests |
| `0107c2b` | F: send board + calls board, scrubbed fixture |
| `cdeef5c` | **worker wiring 1:** `/api/automations` + `/api/send-board` routes |
| `73f2f6b` | **worker wiring 2:** A/B hooks + `/api/template-stats` (inert unless `AB_ENABLED=on`) |
| `4a29f56` | registry: every index.js anchor on its exact line |

Other sessions also committed on this branch tonight. Those commits are not part of this review: `7e737dc` `60cda49` `e69094a` `ebf51b4` (`.sdlc/noa-chase/*`) and `de121f4` (call board drops past-event guests, `worker/index.js` +4/−1).

### Final check run (after the last commit)

| Check | Real output |
|---|---|
| `node --check worker/index.js` | exit 0 |
| `node -e 'import("./index.js")'` (in worker/) | `import ok, default keys: scheduled,fetch` |
| `node worker/scripts/check-registry.mjs` | `check-registry: OK — 189 anchors, 54 nodes, 7 crons, window ±3` |
| exact-line audit of registry | `exact: 175 / 175` (index.js anchors) |
| `cd worker && node --test test/*.test.mjs` | `pass 49 · fail 0` (ab, template-stats, send-board, call-board) |
| `cd agent && node --test test/*.test.mjs` | `pass 42 · fail 0` |
| `node scripts/build-offers.mjs --check` | `up to date` ×3, exit 0 |
| site validator (scratchpad `validate.py`) | `RESULT PASS failures= 0` before C's spec landed. Its later FAIL was C's spec containing the banned word, since reworded |

What this does NOT prove: none of the new routes has run inside a Worker or against production KV/audit volume. Every browser check used fixtures.

---

## Incidents and disclosures (read this first, Fable)

1. **`/api/wave-retry {dry:true}` is not dry.** It deletes `wfail/wdead/wferr/gday` and `wave:<token>:<w>` keys and puts `pacer:pending` *before* it checks `b.dry` (`worker/index.js`, `/api/wave-retry` handler). It was never called tonight; all agents were told so. The B agent marks it 🔴.
2. **`/api/daily-run {dry:true}` / `runDailyEngine(env, true)` is not dry.** It writes `wa:cap` (`waCapInfo`), `brain:cache` (`getBrain`) and `snapcache` (`runEventDayBlasts` dry → `snapshotCached`). It also *deletes* `lead:<phone>` keys that are empty or belong to an existing client (`chaseAbandonedLeads` dry path). **Agent A called it twice, at 21:39:59 and 21:40:05 UTC**, before the hazard was known. Possible effects: cache rewrites, and deletion of empty or already-client `lead:` keys. We cannot tell which happened.
3. **Every admin-key POST to `/api/*` except `/api/stream` writes a `stream:` audit row to RATE** (request middleware, `ctx.waitUntil(stream(...))` → `audit.js:147`). Read-only calls made tonight therefore created audit rows:
   - A: `/api/automations` ×1 (404), `/api/daily-run` ×2
   - B smoke test: `cap_status` and `automations` through the agent's tools
   - C: `/api/audit` ×63, `/api/meta-admin` ×3, `/api/msg-stats` ×1 (≈67 rows)
   - F: `/api/wave-audit` ×1, `/api/call-board` ×1, `/api/audit` ×21, `/api/delivery-report` ×4 (≈27 rows; its 13 `/api/stream` calls write nothing)

   These are journal rows, not engine state, but they are RATE writes. After the discovery, all agents were limited to `/api/stream`.
4. **Guest PII nearly committed to the public repo.** F's `send-board.fixture.json` was built from live data and held 769 real guest phones and 747 names. It was scrubbed before commit with the new `worker/scripts/scrub-fixture.mjs`, which maps them to stable fakes (`9725000xxxxx`, "אורח N") and renames events "אירוע <short>". The real file stays only in the session scratchpad. One real-looking phone in `worker/test/call-board.test.mjs` was also replaced. **Rule for next time:** run `build-send-board-fixture.mjs`, then `scrub-fixture.mjs`, then commit.
5. **No sends, no Meta submissions, no deploys, no RATE writes by our own code paths** (apart from the side effects in 2 and 3).

---

## A — Automations map

**Status:** built, wired (`cdeef5c`), not deployed.

- `worker/automations-registry.js`: 54 nodes, 55 edges, 7 crons. Every node and claim is pinned to a `file:line:symbol`. `wave_retry` and `d_engine` are marked `mutates_on_dry`.
- `worker/scripts/check-registry.mjs` checks every anchor (±3) and the cron list against `wrangler.toml`. The new `worker/scripts/repin-registry.mjs [base]` re-pins after edits to `index.js`, using the git diff line map.
- `worker/automations.js` serves `POST /api/automations`: registry + live state + a 7-day **projection** of the engine's date rules. It deliberately does not run the engine (see incident 2), so its counts are upper bounds ("≤"). It is given only `fetchSnapshot`.
- `automations.html` (rewritten): node map, "ציר זמן לאירועים" tab, "החזק" → confirm → `/api/event-flag {flag:'hold'}`. It falls back to `automations.fixture.json` on 404, with hold disabled in fixture mode.

**Ran:**
- `check-registry`: OK.
- Mutation test with 3 injected faults: exit 1, as expected.
- Fixture build against a fake KV whose `put`/`delete` throw: `no KV writes ✓`, `403 on bad key ✓`.
- Browser at 375px, dark mode: no horizontal scroll.
- Hold with a mocked fetch: cancel made 0 calls, confirm made exactly 1.

**Attempts:** registry 2 (syntax error in a comment). The committed `39c9164` had 2 anchors slightly off (`wa:cap` by 4 lines, `waCapInfo` by 1); both are fixed in `4a29f56`.

**Not proven:**
- The handler has never run in a Worker. A full audit day is about 7k rows (21 s via `/api/stream`), so expect a slow first load.
- The projection is not the engine: cancel, postpone, upgrade offers, lead chase and nudges are not projected.

**Gaps the registry flags (real code, not fixed):**
- **"החזק" does not stop the event-day blast.** `runEventDayBlasts` never checks `hold:`. Stop it with `/api/event-day {action:"clear"}`.
- **Event-day 131048 cap failures are not resent.** The job is deleted after a run with no immediate failures.
- **Day-before and table messages that fail later with non-cap codes are never resent.** The per-guest marker clears, but the event flag stays.
- **Thank-you and cancel sends don't record a wamid**, so a later cap failure can't reopen them.
- **Party-size nudges ignore `paused` and `hold`.**
- **Client messages have no send-window check.** The week-before report, wrap-up, file reminder and upgrade offer can go out at 08:35 Israel time in winter.

**Rollback:** `git revert cdeef5c` (the route returns 404 and the page falls back to the fixture).

---

## B — Slack agent `ishur-agent`

**Status:** built (`6d4ccb2`), **not deployed** (no Slack app or bot token exists). Setup is in `agent/SETUP.md`, with the app manifest in `agent/slack-app-manifest.json`.

Tiers are enforced in code (`agent/src/gate.js`): 🟢 read-only runs immediately; 🟡 needs a confirm click; 🔴 needs Richard's "מאשר". `wave_retry` is 🔴. Nothing that can send WhatsApp is 🟢.

**Ran:**
- `node --test agent/test/*.test.mjs`: 42/42.
- Mutation checks: flipping a tier or removing the gate fails the tests.
- Smoke against live: `cap_status` returned 200 `{"tier":"TIER_250","used":542,"left":0,"capped":false}`; `automations` returned 404 (not deployed then).

**Not proven:** anything inside Slack: Events API signature handling with a real app, the approval click flow, rate limits.

**Risks:**
- **`AGENT_ADMIN_KEY` is the full admin key.** A leak equals full admin access. A scoped read key would be better.
- **Approval double-click race:** KV has no transactions, so two fast clicks could run a 🟡 action twice.

**Needs Richard:** create the Slack app from the manifest, set the secrets listed in `agent/SETUP.md`, then Fable deploys the 🟢 tier only.

---

## C — A/B testing on guest copy

**Status:** built (`bf761d4`), wired (`73f2f6b`), **inert**: everything is off unless `AB_ENABLED=on`. Challengers drafted, **not submitted**.

**Built:**
- `docs/SPEC-ab-testing.md`: intent, spec, plan, analysis (C.2), stopping rule, challengers.
- `worker/ab.js`: `pickVariant`, `recordOutcome`, `evaluate`, `startTest`.
- `worker/template-stats.js`: `POST /api/template-stats`.
- `templates.html` + `templates.fixture.json`: real 22/10–01/11 numbers, no phones.

**Rules as built:**
- **Stopping rule:** each arm needs ≥200 delivered sends that are ≥72h old. A winner needs |z| ≥ 2.24·√(1000/n). At 1000 per arm with no winner, the control stays.
- **Guardrails:** opt-out (+0.5pt); every guest number must be GREEN quality. Today 9799 is UNKNOWN, so marketing challengers are blocked.

**Wiring (`73f2f6b`):** hooks in `sendWave`, thank-you and day-before; a 06:00 IL evaluate hook inside the `*/10` cron; the `/api/template-stats` route. The hooks are inert when off:
- `pickVariant` returns the engine's own template without touching KV.
- `remindTmpl` equals `inviteTmpl` unless `AB_AUTOROTATE=on`.
- I gated the evaluate hook on `AB_ENABLED` in `index.js` too, so the off state writes no journal rows. Before that, `audit.job` would have logged 6 rows a day.
- I read every changed send call in the diff: each sends `abv.template`, which equals the template the old code sent.

**Ran:**
- `node --test` on C's suites: 37/37.
- Anytime-valid simulation, A/A: `79/2000 = 3.95%` false winners.
- Power: `473/500 = 94.6%`, mean n/arm at stop 604.
- Mutation (C=1.2): 3 tests fail, false winners rise to 39.35%.
- Patched worker run locally with a seeded fake KV: `/api/template-stats` gave 403 on a bad key, 200 on a good one (602 sends), closed days cached, today never cached.

**Attempts:**
- Test suites passed first run.
- Design fixes: sends held back by the GREEN guardrail were being counted in the control arm; the evaluator now refuses to decide on a partial log.
- Two spec numbers corrected.

**C.2 findings (only 11 days of data exist; the audit log starts 22/10):**
- **Marketing limits drive most non-cap failures.** Every guest template is billed as marketing; 130472 ×47 and 131049 ×42 out of 108.
- **Day-before costs about 6× more than it should.** `ishur_yom_lifnei_f` (marketing, ₪0.13) replaced `ishur_yom_lifnei` (utility, ₪0.02) via the `tmplf:` switch. **Richard's call.**
- **The reminder is the best-answered message.** It is `hazmana_ishur_v2` on wave 2: 278 sent, 52.6% replied within 72h (95% range 45.6–59.6%).
- **Bug:** "טעות 2 מגיעים בבקשה" is read as wrong-number (`whatsapp.js:518-519`); 1 of 4 "טעות" replies. **Not fixed.**
- **Billing error on Noa's number:** 131042 on every client template from 25/10 to 01/11.
- **`/api/stream` drops days:** multi-day calls return partial data. A 7-day call returned 3 days, so readers go one day at a time.

**Not proven:**
- KV read cost on an empty cache in production.
- That Meta keeps the challengers as utility.
- Button press vs. typed reply can't be told apart; replies use last-touch attribution.

**Rollback:** `git revert 73f2f6b` (independent of `cdeef5c`).

---

## D — Meta verification ticket · E — Security Center

**Status:** prepared, **not sent**. Files: `docs/META-SUPPORT-TICKET-2026-11-01.md`, `docs/META-SECURITY-CENTER-2026-11-01.md` (`0210e34`).

**Raw from Graph:**
- Business 1888051741895896: `verification_status: pending`.
- Guests WABA 1378764257421712: blocked with 141010 and 141015; name "בן - דיגיטל אונליין"; CLIENT_OWNED.
- 6673: GREEN, TIER_250, blocked with 141012.
- 9799: TIER_250.
- `business_users` returned `[]`.

**Site edits for verification:** one legal line on each of `index.html` (footer), `terms.html` and `llms.txt`: "ריצארד טומסקי, עוסק מורשה 322414905".

**Needs Richard:**
- The business address. It isn't in the repo; it's a TODO in the ticket.
- Send the ticket himself.
- Do the Security Center clicks from the sheet.

Also: `autoscale.co.il` does not resolve.

---

## F — Send board + calls board

**Status:** built (`0107c2b`), `/api/send-board` wired (`cdeef5c`), not deployed. The pages fall back to the scrubbed fixture.

**Built:**
- `worker/send-board.js`: per event × message type, it shows **"נמסרו X / נשלחו Y / מתוך Z"** with ⓘ drill-downs: per guest, Meta code, Hebrew reason, sending number.
  - Delivery is joined to the send by wamid from the audit log, plus the engine's KV markers.
  - Sends from before 22/10 show **לא ידוע**, never "not sent".
  - Its only write is a 5-min `sendboard:*` cache key. **Fable: accept or drop.**
- `assets/sendboard.js` on `calendar.html` and on `admin.html` "אירועים קרובים".
- `assets/callboard.js` on `admin.html` "לוח שיחות" and `calls.html`. It uses only deployed endpoints: Today / 7 days / all, recording and transcript per call, dial-window state.

**Hadar ec9f3b84 (the brief expected 244 ממתין / 27 נמסר):**

| Message | Delivered / Sent | Detail |
|---|---|---|
| יום-לפני | **25 / 271** | 12 read · 4 failed (131026) · **242 pending (reopened: 224×131048, 10×131049, 8×130472)** · 4 replied |
| גל 2 | 173 / 198 | 10 failed · 10 reopened · 53 unknown |
| גל 1 | — | 445 unknown (sent 18/10, before the audit log) |
| שולחן | 0 / 0 | 260 scheduled for 02/11 |

Screenshot (scrubbed fixture, 375px dark): `docs/img/sendboard-hadar-375-dark.jpg`.

Why the brief said 27: `/api/delivery-report` tallies each guest's *last outgoing message of any kind* in the last 3 days (12 delivered + 15 read). It does not look at the day-before message specifically.

**Caveat on the 242:** "reopened" is *inferred* from the retry rules. If the wamid wasn't recorded before those sends, the `s5d` markers are still set and they will **not** be resent. Only the deployed endpoint (marker reads) can confirm this.

**גל גלילי c2f63d20 `tries: 0`:**
- None of the 38 calls on 01/11 were for it; the event date is 13/10.
- The dialer skips past events (`shir.js:116`).
- The call queue never dropped past events (`dashboard.js:41-85`) and labelled them "waiting". This is now fixed in `de121f4`, made by another session.
- Before 13/10, voicemail didn't count as a try (`shir.js:529-532`). This can't be checked because the audit log starts 22/10.

**Other finding:** inbound call records store *our* number as the guest's phone (`to_number`, index.js ~2165).

**Calls board on real data (c1c5fcf5, 01/11):** 38 calls, 29 answered; 1 מגיע / 4 לא מגיע / 14 לחייג שוב; average 11 s; ₪3.38. 18 calls had no outcome and are labelled "להעביר לריצארד". That label is our mapping; please confirm it.

**Ran:**
- Tests: 12/12 (send board passed first try; calls board took 2, because one of our expected values was wrong, not the code).
- Fixture: 2 builds, fixing two rules after the first.
- Browser: desktop and 375px dark, all go.ishur.io calls stubbed.
- After scrubbing: re-rendered at 375px dark on a temp page with no key, no horizontal scroll, Hadar row present.

**Not proven:**
- `/api/send-board` inside the Worker: marker reads, KV read count (about 450 guests × 7 types), the 20k-row audit limit.
- `admin.html` with a real login (not opened, to avoid live calls).
- Event-day type (no job data read).
- The recording button.

**Rollback:** `git revert 0107c2b` for the pages; the route goes with `cdeef5c`.

---

## G + G.1 — GEO visibility

**Status:** plan + site patches committed (`1fdc72a`), not pushed (the site deploys on push).

**Files:** `docs/GEO-PLAN-2026-11.md`, `docs/SPEC-reviews.md`, `offers.json`, `scripts/build-offers.mjs`, 5 new pages: `dayalot`, `sidurei-hoshava`, `shihot`, `kishur-kvutza`, `matanot` (בקרוב + lead form).

**Not tested directly:** we did not query ChatGPT, Gemini, Claude, Perplexity or AI Overviews; the plan marks each "לא נבדק ישירות". As a proxy (web search, US index): ishur.io did not appear for any of the 3 Hebrew prompts, or even for its own name. Competitors that did: WiWi, MyInvite, Attending, Lunsoul, CheckIt, SaveDate, plus mit4mit / engaged.co.il.

**Fixed:**
- **Prices visible to crawlers:** the homepage price table was JS-only, so crawlers saw no prices. It now has a static table.
- **Wrong facts:** `llms.txt` and `faq.html` had wrong package names and a ₪989 top price; the real top is ₪1,179.
- **robots.txt:** the separate AI-bot groups let those bots into `admin.html`. Now there is one group, internal paths blocked first, AI bots allowed.
- **One business entity:** city pages, `hatuna` and `bar-mitzvah` now point to a single entity.
- **Offers single-sourced from `config.js`:** `offers.json`, the `llms.txt` offers block, the dated Offer JSON-LD and the price table are all generated by `build-offers.mjs` (`--check` fails if anything is stale). Only "מבצע חורף" is published.
- **Smaller fixes:** canonical, description and FAQ markup on `why.html`; canonical on `terms.html`; "וואטסאפ" in the homepage title; sitemap now lists 20 pages.

**Reviews:** no Review or AggregateRating markup, because there are 2 real reviews and nothing may be invented. `SPEC-reviews.md` specs a review request to the host 2 days after the event. The send itself is 🔴, so it stops at spec and template text.

**Ran:**
- Validator: first FAIL (robots first-match let bots into admin; banned word in a spec) → fixed → `PASS` (20 pages, 20 JSON-LD blocks parse, all canonical, sitemap = public set).
- `build-offers --check`: exit 0.
- 375px render of `dayalot` and the price table.

**Not proven:**
- Any change in what the assistants answer.
- Google rich-result acceptance (Google's validators not run).
- The gifts form submission (it would write RATE).

**Needs Richard:**
1. **Positioning numbers** ("X אירועים · Y מוזמנים · Z% מענה") were not computed. The event history is in the sheet, behind a Make secret. The Worker endpoints that read it write RATE. The audit log only starts 22/10. Also, the live "500+ אירועים · 98% שביעות רצון" has no source in the repo.
2. **Hostess prices:** the brief says ₪1,790/2,390/3,090. `config.js` says ₪1,790 for one, ₪1,990 for two, no third tier. **We used `config.js`.**
3. **City pages** are near-duplicates. They need real local content or merging.
4. **`dashboard.html` / `upload.html` show "עד 899 מוזמנים".** This is a guest-count tier label, not a price; we left it. Say if the rule covers it.
5. **Off-site drafts** (GBP, directories, forums, r/Israel, comparison pitch) are in the plan, in your name with disclosure. Competitor prices come from search snippets; check them before posting.

**Rollback:** `git revert 1fdc72a 83377bc`.

---

## Proposal: one event-day message per guest (body only, not submitted)

Today a guest can get two messages on the event day: `ishur_shulchan` (name, event, table) and the event-day blast (time, what, address, nav). Proposal: **two utility templates**, of which each guest gets exactly one, with the navigation link as a dynamic URL button instead of a body variable.

**`ishur_hayom_shulchan`** — {{1}} שם האורח · {{2}} האירוע · {{3}} שעת קבלת פנים · {{4}} המקום · {{5}} מספר השולחן

> היי {{1}}, היום זה קורה! 🎉
> {{2}} מחכים לך.
> 🕐 קבלת פנים: {{3}}
> 📍 {{4}}
> 🪑 השולחן שלך: {{5}}
> לניווט למקום לחצו על הכפתור. נתראה!

Button: dynamic URL `https://go.ishur.io/nav/{{1}}` (per-event nav redirect, a route still to be built) → "ניווט למקום".

**`ishur_hayom`** (no seating, or the guest has no table) — same body without the table line:

> היי {{1}}, היום זה קורה! 🎉
> {{2}} מחכים לך.
> 🕐 קבלת פנים: {{3}}
> 📍 {{4}}
> לניווט למקום לחצו על הכפתור. נתראה!

**Engine change it needs (not built):**
- `runEventDayBlasts` picks the template per guest by table presence.
- The separate `ishur_shulchan` send is skipped on the event day when the blast covers the guest.
- `s5e:` stays the one per-guest marker.

**Open questions:**
- Utility classification is Meta's decision. The text is transactional (a confirmed guest's own event details), which is the case for utility.
- The 09:00 send window still applies.

---

## Needs Richard / Fable (action footer)

**Fable — deploy decisions**
- [ ] Review `cdeef5c` (2 read-only routes) and `73f2f6b` (A/B hooks, inert). Deploy after the wedding, **not before 03/11**.
- [ ] Accept or drop the `sendboard:*` 5-min cache write in `worker/send-board.js`.
- [ ] Fix `/api/wave-retry` so `b.dry` is checked before any KV delete/put. Make `runDailyEngine` dry truly read-only.
- [ ] Decide whether `/api/*` admin audit rows should skip reads (they're why "read-only" isn't).
- [ ] Fix the "טעות 2 מגיעים" parse (`whatsapp.js:518-519`).
- [ ] Event-day blast: check `hold:`; resend 131048 failures.
- [ ] Add `{ href: 'templates.html', label: 'תבניות' }` to `assets/adminbar.js`.

**Richard — approvals and clicks**
- [ ] **Tomorrow:** if Hadar's event-day message must be stopped, use `/api/event-day {action:"clear"}`. "החזק" won't stop it.
- [ ] `tmplf:ishur_yom_lifnei`: stay on the marketing `_f` (₪0.13) or go back to utility (₪0.02)?
- [ ] A/B: "מאשר" for each step: deploy → submit challengers → `startTest` → `AB_ENABLED=on`.
- [ ] Slack agent: create the app from `agent/slack-app-manifest.json`, then set the secrets.
- [ ] Meta: add the business address to the ticket, send it, do the Security Center clicks.
- [ ] Repo is public: move the site to a folder or branch with only public files (`/docs`, `/worker` are readable today).
- [ ] G.1: give a source for the positioning numbers; confirm the hostess tiers; confirm the "להעביר לריצארד" label for calls with no outcome.
