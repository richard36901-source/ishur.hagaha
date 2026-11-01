# SPEC · A/B testing + template performance (Deliverable C)

Status: built on branch `main-executer`, **not deployed, not wired into `worker/index.js`**.
Owner of the go-live decision: Richard ("מאשר" in Slack). Reviewer: Fable.
Date: 01/11/2026. Data pulled read-only from `go.ishur.io/api/audit`, 23:09 IL.

Files:

| File | What |
|---|---|
| `worker/template-stats.js` | `POST /api/template-stats` handler, pure stats functions |
| `worker/ab.js` | `pickVariant`, `recordOutcome`, `evaluate`, `startTest`, stopping rule |
| `worker/test/template-stats.test.mjs`, `worker/test/ab.test.mjs`, `worker/test/fixtures/stats-rows.json` | `node --test` |
| `templates.html` + `templates.fixture.json` | the "תבניות" dashboard tab (fixture = real 01/11 numbers, no phone numbers) |
| `docs/ab-index-wiring.patch` | the exact `index.js` hooks (`git apply --check` clean against `a1c3d8a`) |

---

## 1. Intent

Learn which wording of each guest message gets the most answers, and keep improving it without a human
reading spreadsheets. Concretely:

1. **See** per template: sent → delivered → read → answered (24h / 72h) → what they answered → "טעות"/"הסר" → cost.
2. **Decide** per template in plain Hebrew: **החלף / שמור / מעט נתונים**, by a written rule.
3. **Test** one new wording at a time per message type, on a random half of the guests, stop by a rule
   that is safe to check every day, make the winner the new default, and queue the next challenger.

Non-goals: changing what is sent, when, or to whom. The engine only swaps a template *name* for another
APPROVED name with identical variables and buttons.

---

## 2. Data that exists today (verified)

All of it is in the audit log: `stream:<YYYYMMDD>:<ms>:<rand>`, 400-day TTL, written by `record()` —
`worker/audit.js:118`, TTL `audit.js:39`, reader `query()` `audit.js:228`.

| Kind | Written at | Fields used | Notes |
|---|---|---|---|
| `wa_out` | `worker/whatsapp.js:305` | `data.template`, `data.wamid`, `data.phone_id`, `ok`, `phone`, `token`, `area` (שיר/נועה) | `ok=false` = Meta refused at send time (`data.error`). No wave/occasion here. |
| `wa_status` | `worker/index.js:2889` | `data.wamid`, `data.status` (delivered/read/failed), `data.wave`, `data.pricing.category`, `cost`, `detail` = "<code> <title>" | `wave` comes from the `wamid:` map (`index.js:4495` sendWave, `index.js:4054` noteGuestSend, 3-day TTL). `cost` only on delivered rows. |
| `wa_in` | `worker/index.js:3077` | `phone`, `area`, `detail` | `detail` = parsed answer ("מגיע"/"לא מגיע"/"מתלבט"/a number) or the raw words for הסר/טעות (`index.js:3063-3064`). |
| `guest` | `worker/index.js:4180` | RSVP from the link page | not used yet (link answers are not template replies) |

Also present:
- `wferr:<token>:<wave>:<phone>` = last Meta failure code for a wave invitation (`index.js:2909`), 30 days.
- `wdead:` = gave up after 3 failures (`index.js:2944`).
- `tstat:<template>:<occasion>` = cumulative sent/fail/replied counters (`whatsapp.js:330`, reply credit
  `index.js:3143-3151` via `lastout:` 48h). Known under-count: read-modify-write on a hot key (`whatsapp.js:341`, AUT-903).

What is **not** in the data (so not in the metrics):
- **Button press vs typed word.** A quick-reply press and a typed "מגיע" both land as `detail:"מגיע"`. "Clicks" below = an
  RSVP-type answer (מגיע / לא מגיע / מתלבט / party size), whichever way it was given.
- **URL-button clicks** (e.g. `ishur_toda_orach_v2` "רוצים כזה לאירוע שלנו") — only visible as `utm_medium=toda` site traffic.
- **Blocks.** Meta does not report a block; the closest signal is failure `131026` ("לא בוואטסאפ / חסם").
- **History before 22/10.** The audit writer moved to `audit.js` on 22/10 with 400-day retention; the 21/10 stream kept
  7 days. Asking for 60 days returns **11 days (22/10–01/11)**. Measured: days 03/09–21/10 = 0 records.
- **Multi-day reads silently drop days.** `/api/stream {days:7, kind:'wa_in'}` returned 283 rows covering only 3 days
  (30/10, 31/10, 01/11); `/api/audit` for 29/10 alone had 23 `wa_in`. A day holds 2k–7k records. Hence the per-day reads + cache in §6.

## 3. Metric definitions (per template, per message type)

Unit = one template send (one `wa_out` with a template name). A template that serves two message types
(e.g. `hazmana_ishur_v2` as invitation wave 1 AND reminder wave 2) gets one row per type.

| Metric | Definition |
|---|---|
| sends | `wa_out` rows with this template |
| accepted / rejected | `ok` true / false at send time |
| delivered | accepted and any `wa_status` delivered or read for its wamid |
| read | a `read` status |
| failed (+code) | a `failed` status and never delivered; code = first token of `detail` |
| delivery rate | delivered / (accepted − cap failures `131048`,`130429`). The cap is the number's limit, not the copy's fault. |
| replied 24h / 72h | the first inbound from that phone, on the same number (שיר/נועה), after this send and before the next template to that phone (**last touch**), within 24h / 72h |
| reply rate | replied-72h / **delivered sends at least 72h old** (younger sends have not had the full window); 95% **Wilson** interval |
| clicks / RSVP outcome | first RSVP-type answer attributed to the send: מגיע (incl. a party size) / לא מגיע / מתלבט |
| opt-out | an attributed answer the production parser (`parseInboundReply`, `whatsapp.js:486`) classes `optout` ("הסר") or `mistake` ("טעות", `whatsapp.js:519`) |
| cost | sum of `cost` on its status rows (₪, from Meta's pricing category: utility 0.02, marketing 0.13) |

### Recommendation rule (`RULE` + `recommend()` in `template-stats.js`)

1. fewer than **100** mature delivered sends → **מעט נתונים**
2. opt-out rate (הסר + טעות) / delivered **> 2%** → **החלף**
3. delivery rate **< 85%** (cap failures excluded) → **החלף**
4. invitation/reminder types only: another template of the **same type** with ≥100 has a 95% lower bound above this one's
   95% upper bound → **החלף** (names the better one)
5. otherwise **שמור**. Information messages (יום לפני, שולחן, תודה, יום האירוע) are never judged on replies.

The thresholds were fixed before looking at the numbers in §4.

## 4. Template performance, real data (22/10–01/11, all that exists of the requested 60 days)

Source: 60 one-day `/api/audit` reads, 4,831 compact rows (1,177 template sends, 2,888 statuses, 766 inbound),
computed with `computeTemplateStats` (the same code the endpoint runs). "now" = last record, 01/11 23:09 IL.

| Template | Type | Sent | Delivered* | Read | Replied 72h (mature) | 95% CI | מגיע/לא/מתלבט | טעות/הסר | Failures | ₪ | Rule |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `hazmana_ishur_v2` | reminder (wave 2) | 278 | 236 (84.9%) | 118 | 100/190 = **52.6%** | 45.6–59.6 | 48/35/35 | 1/0 | 130472×19, 131049×16, 131026×7 | 31.33 | **החלף** (delivery 84.9%) |
| `ishur_yom_lifnei_f` | day-before | 455 | 172 (84.7%) | 121 | 10/147 = 6.8% | 3.7–12.1 | 6/6/0 | 0/0 | **131048×252** (01/11 cap), 130472×9, 131049×16, 131026×6 | 22.88 | **החלף** (delivery 84.7%) |
| `hazmana_ishur_img_u` | invitation | 329 | 294 (90.2%) | 139 | 36/79 = 45.6% | 35.1–56.5 | 118/21/11 | 2/0 | 130472×10, 131049×9, 131026×3, 131048×3 | 38.61 | מעט נתונים (79) |
| `hazmana_ishur_v2` | invitation | 18 | 9 | 3 | 4/9 | 18.9–73.3 | 1/3/2 | 0/0 | 131026×3, 130472×1 | 1.30 | מעט נתונים |
| `ishur_c_505cd735_1` (client's own) | invitation | 23 | 14 | 12 | 5/14 | 16.3–61.2 | 4/0/1 | 0/0 | 130472×8 | 1.82 | מעט נתונים |
| `ishur_lo_siyem` / `_2` (Noa, leads) | client | 41 / 17 | 10 / 6 | 5 / 1 | 1/6, 1/5 | — | — | 0/0 | **131042** ×14 / ×11 | 0 | מעט נתונים |
| `ishur_tzikoret_kovetz_f`, `ishur_doch_f`, `ishur_syum_v3_f` | client | 9, 4, 3 | 0 | 0 | — | — | — | — | 131042 | 0 | מעט נתונים |

\* delivery % excludes cap failures. Totals: 1,177 sent, 741 delivered, 399 read, 171 replied ≤72h (mature only),
294 RSVP answers, **0 "הסר", 3 attributed "טעות"**, ₪95.94.

Long run (the older `tstat:` counters, all time, `/api/msg-stats`, sent = accepted, reply = any inbound ≤48h, under-counted):
`hazmana_ishur_img_u` 711 weddings 27% · 142 henna 55% · 140 bat-mitzvah 40% · `hazmana_ishur_v2` 213 weddings 32% · 47 bat-mitzvah 72% ·
`ishur_yom_lifnei_f` 271 weddings 1%.

What this says:

1. **Every guest template is billed MARKETING** (Meta pricing on the delivered statuses: img_u 298, v2 251, yom_lifnei_f 176,
   custom 14 — all `marketing`). The non-cap failures are almost all marketing-only effects: **130472** (Meta's marketing
   experiment hold-out, 47) and **131049** (per-user marketing limit, 42) = 89 of the 108 non-cap failures on guest templates. Copy can change this only
   through the category. That is the strongest lever found, stronger than wording.
2. **`ishur_yom_lifnei_f` (MARKETING, ₪0.13) replaced `ishur_yom_lifnei` (APPROVED UTILITY, ₪0.02)** via the `tmplf:`
   footer switch (`whatsapp.js` sendTemplate). The day-before message now costs ~6× and is exposed to 130472/131049.
   Same for `ishur_yom_lifnei_nav` (MARKETING). Recommend: point `tmplf:ishur_yom_lifnei` back at nothing, or submit a
   footer copy that Meta keeps UTILITY. (Richard's decision; not changed.)
3. The reminder (`hazmana_ishur_v2` on wave 2) is the best-answered message we have: 52.6% within 72h of delivery. It is
   identical to the invitation text; the challenger in §8 tests a reminder that *says* it is a reminder.
4. "טעות" is rare (4 inbound in 11 days, 0 "הסר"). **One of the four was "טעות 2 מגיעים בבקשה"** — a guest correcting
   their count — which the production parser classes as wrong-number (`whatsapp.js:518-519`, anchored on a leading
   "טעות" followed by a space) and silences the guest for that event. Flagged in the report; not fixed here.
5. `131042` (billing problem on the Meta account behind Noa's number) recurs every day 25/10–01/11 (36 failed client-template sends).
   Not a copy problem; it kills every client-side template.

## 5. Assignment, stopping rule, guardrails (`worker/ab.js`)

**Unit:** guest × event × test. `arm = FNV-1a+fmix32("<test_id>|<event token>|<phone 972…>") < split ? challenger : control`.
Deterministic, so it is sticky per event with no KV write, identical in every Worker, and a new test id re-randomises.
Default split 50/50. Measured: 20,000 phones → 50.0% ±1.5%; split 0.2 → 20% ±1.5%.

**Who is eligible:** only sends where the engine would have sent the test's control anyway (`opts.current === control`).
Artwork (`_img_u`), video (`_vid`), and a client's own template (`ishur_c_*`) are never touched.

**Metric for the decision:** reply-within-72h rate among *delivered* sends at least 72h old, per arm.

**Stopping rule (sequential-safe, checked once a day at 06:00 IL):**
- no decision until **both arms have ≥ 200** such sends;
- pooled two-proportion z (challenger − control);
- stop with a winner when **|z| ≥ 2.24 · √(1000 / n)**, n = the smaller arm (capped at 1000):
  n=200 → 5.01, n=400 → 3.54, n=600 → 2.89, n=1000 → 2.24;
- at **n = 1000 per arm** with no crossing → "no difference", control stays, challenger retired.

Why it is safe to look every day: in score units the boundary is a constant (|S_n| ≥ 2.24·√N_max·σ), and by the
reflection principle P(sup |W(t)| ≥ c, t ≤ 1) ≤ 4·(1 − Φ(2.24)) = 0.050 for **any** number of looks.
Measured by simulation in the test suite (seeded): **A/A false positives 79/2000 = 3.95%** with 30 sends/arm/day;
**power 94.6%** to find 30% → 38%, mean stop at 604 per arm. With a naive 1.96 boundary checked daily the same
simulation gives ~39% false positives (mutation run, C=1.2 → 39.35%).

Expected duration at today's volumes (11 days, 50/50): reminders ≈ 25/day → 400 per arm ≈ 5 weeks (stops early only on a
≥ ~15pt effect), 1,000 per arm ≈ 11 weeks. Text invitations (`hazmana_ishur_v2` on wave 1) were only 18 in 11 days —
artwork events go out as `_img_u` — so the 8.1 test is slow; testing an `_img_u` challenger would be ~15× faster.

**Guardrails (enforced in code):**
1. **One challenger per message type.** `ab:tests` holds one test per type; `startTest()` refuses a second while one is pending/running.
2. **MARKETING challengers only while every guests number is GREEN.** `evaluate()` reads `quality_rating` of every guests
   number daily; `pickVariant` returns control (and does not record) when any is not GREEN. Today: 6673 GREEN,
   **9799 UNKNOWN → a MARKETING challenger would not run today.** UTILITY challengers are not held.
3. **Opt-out stop:** challenger (הסר+טעות)/delivered − control's **> 0.5pt**, once both arms have ≥100 delivered and the
   challenger has ≥3 such answers → stopped at any look, control stays.
4. **Only APPROVED:** a test is `pending` until Meta says APPROVED (`templateApproved`); if the challenger stops being
   APPROVED mid-test, the test stops.
5. **Never on a partial log:** if any day in the test window could not be read, no decision that day.
6. **Kill switch:** nothing happens unless `AB_ENABLED=on`. With it off, `pickVariant` does zero KV reads and returns the
   engine's own choice.

## 6. Rotation

On a winner: the test is archived in `ab:history`, `ab:control:<type>` = winner, and a **new test entry is created at once
with status `needs_draft`** (control = winner, challenger name = `<control family>_ab<n+1>`, never reused) plus a `brief`
listing what the loser did worse (fewer replies, more טעות, fewer מגיע). Then:

1. Claude drafts the new challenger from that brief (same variables, same buttons, Hebrew, short, promo wording only as "מבצע חורף" per the house rule).
2. It is submitted to Meta as `<name>_ab<n>` — tier 🟡, by Richard or by the Slack agent with Richard's approval.
3. Status → `pending`; `evaluate()` flips it to `running` the day Meta says APPROVED.

Production switch of the winner: only with `AB_AUTOROTATE=on` — invitation → KV `invitetmpl`; reminder → `ab:control:reminder`
(read by sendWave only under `AB_AUTOROTATE=on`). Otherwise Slack says "ההחלפה לייצור ממתינה לאישור ריצארד".

## 7. Plan (build order, all on the branch)

1. ✅ `template-stats.js` + tests (pure maths, then the handler with injected I/O; per-day reads, closed days cached
   under `tstats:rows:<day>`, ≤3 uncached days per request, the page re-asks until `partial:false`).
2. ✅ `templates.html` (auth = `localStorage.ishur_calls_key` like `admin.html`; falls back to `templates.fixture.json` on 404 or network error; `?fixture=1` forces it).
3. ✅ `ab.js` + tests (assignment, stopping rule incl. A/A + power simulation, guardrails, rotation).
4. ⏳ `index.js` hooks — `docs/ab-index-wiring.patch` (invitation/reminder/extra in `sendWave`, day-before, thank-you,
   06:00 IL evaluate in the `*/10` branch, the route). Applied to a scratch copy: `node --check` OK, the patched worker
   imports, and `POST /api/template-stats` answered 403/200 through `worker.fetch` on a fake KV seeded with 3 real days.
5. ⏳ Go-live, in this order, each a separate "מאשר": deploy with `AB_ENABLED` unset (dashboard only) → submit the two
   challengers in §8 → `startTest` → `AB_ENABLED=on` → much later, `AB_AUTOROTATE=on`.

## 8. First challengers (drafts — NOT submitted)

Variables and buttons are identical to the control, in the same order. Footer identical. Promo wording follows the house rule ("מבצע חורף" only); these drafts contain no promo wording at all.

### 8.1 Invitation · `hazmana_ishur_v2_ab1` (control `hazmana_ishur_v2`, msg type `invite`)

Control today (APPROVED, MARKETING):
> שלום {{1}}! הוזמנתם ל{{2}} של {{3}}.
> 📅 בתאריך {{4}} · 🕐 קבלת פנים בשעה {{5}} · 📍 {{6}}
> נשמח לדעת אם תגיעו. לחצו על אחת התשובות למטה, ואפשר לעדכן אותנו שוב בכל שלב:

Hypothesis: the ask is buried in a long last line. Shorter, the ask as a question, one action.

```
היי {{1}}, הוזמנתם ל{{2}} של {{3}} 🎉

📅 {{4}}
🕐 קבלת פנים {{5}}
📍 {{6}}

תגיעו? לחיצה אחת על התשובה המתאימה למטה 👇
```
Footer: `נשלח ע"י ishur.io · הגיע בטעות? השיבו "טעות"` · Buttons (QUICK_REPLY): `מגיע/ה` · `לא מגיע/ה` · `עדיין לא ידוע`
Variables: {{1}} שם · {{2}} סוג האירוע · {{3}} בעלי השמחה · {{4}} תאריך · {{5}} שעה · {{6}} מקום — example: דנה · חתונה · נועה ויונתן · 12.09.2026 · 19:30 · הגן הקסום, רמת גן.
Category requested: UTILITY (Meta decides). Note: the text invitation is the minority path today (artwork events use `_img_u`), so this test fills slowly.

### 8.2 Reminder · `hazmana_ishur_v2_ab2` (control `hazmana_ishur_v2` on wave 2, msg type `reminder`)

Today wave 2 re-sends the invitation word for word (`sendWave`, `index.js:4483-4487`; `useImg` only on wave 1).
Hypothesis: a message that says it is a reminder and why the answer matters gets more answers, and its transactional
wording has a better chance of staying UTILITY (no 130472/131049, ₪0.02).

```
היי {{1}}, עוד לא קיבלנו ממך תשובה ל{{2}} של {{3}} 🙏

📅 {{4}}, קבלת פנים {{5}}
📍 {{6}}

כדי שבעלי השמחה יוכלו להיערך, נשמח לתשובה בלחיצה אחת למטה.
```
Footer and buttons identical to 8.1. Same six variables, same order.

## 9. Verification (what was run)

- `node --check` on `template-stats.js`, `ab.js`, both tests, and the patched scratch `index.js`.
- `node --test worker/test/template-stats.test.mjs worker/test/ab.test.mjs` — see the report for the raw output.
- Mutation checks: boundary C=1.2 → 3 tests fail (A/A 39.35%); removing the 72h window → the fixture test fails.
- `templates.html` loaded at 375 px and desktop, light and dark, against the fixture: no horizontal scroll, 10 cards, 4 groups.

Not proven: behaviour on the live Worker (not deployed); Meta's category decision for the challengers; that the 72h
last-touch attribution matches guests' real intent when two templates go out within 72h (last touch wins by design);
the KV-read ceiling of `/api/template-stats` on a cold cache in production (budget 3 days/request is an estimate from
the 01/11 measurements).
