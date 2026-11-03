# Admin console audit · 22/10/2026

Scope: every back-office page under `ishur.io/*.html` that loads `assets/adminbar.js`, plus `admin-login.html` and `seating.html`. Read-only review; nothing was changed. Routes referenced are `url.pathname === '/api/...'` matches in `worker/index.js` (110 POST routes total). Line numbers are as of this date.

Design lens: this is a dense ops console used all day by 2–3 people, so the bar is Apple's "feedback, wayfinding, restraint" foundations (apple-design SKILL.md §1, §7), not landing-page aesthetics. Taste-skill's own header says it is "not dashboards, not data tables"; its only rule that applies here is anti-default discipline (don't invent a new visual system per page).

---

## 0. Cross-cutting findings (fix these once, every page benefits)

1. **Thirteen top-level nav items, three of them duplicates.** `adminbar.js:31-43` lists `admin.html` and `admin.html?view=calls` as two tabs; `calls.html` (Shir's manual queue) is a third calls page linked only from inside admin. `ops.html` ("שליטה") duplicates the `<section class="ctl">` at `admin.html:806-845` (pause, block phone, hold) and the AI switch at `admin.html:598-602` / `brain.html:114`. Three places to flip the same switch is how a switch gets flipped wrong.
2. **Two visual systems.** `hq/clients/leads/calendar` use the "paper" palette (`--paper:#FBFAF7`, flat `h1`, no header band). `admin/inbox/calls/ops/brain/automations/ad-report` use the older pine gradient `<header class="head">` + `ishur.io · X` title. Fonts, radii, button classes (`.btn` vs `.act` vs `.rng` vs `.chip`) differ per file. Each page carries its own `:root` block; `assets/lux.css` is not loaded by any admin page.
3. **Six copies of the key gate.** Every page has its own `<div class="gate">` + `keyGo` handler + its own 403 retry logic (`/^sess\./.test(adminKey) && __k403 < 4`). `ops.html`, `brain.html`, `automations.html`, `ad-report.html` also skip `guard.js`, so they post unstamped bodies and will break if those routes ever require a stamp. Move the gate into `adminbar.js` (it already owns `syncKey()` at line ~100) and delete the per-page copies.
4. **Dark mode is inconsistent.** `admin/inbox/automations` have a theme toggle; `hq/leads/calendar/ops/brain/ad-report` honour `data-theme=dark` via CSS but have no toggle; `clients.html` and `calls.html` have no dark palette at all (white cards on `#FBFAF7` regardless). One toggle belongs in the rail.
5. **No notion of "who".** Every write is `admin_key`; `logEvent(...)` rows say `'ריצ׳רד, מהעמוד לקוחות'` as a hard-coded string (`index.js:~9702`). With Shalev and an employee on the same console, the live log cannot say who did what. See §4.
6. **Phone is the universal key but nothing is clickable.** Phones render as text in `clients`, `calendar`, `admin` tables, `calls`. Only `leads.html:238` gives `wa.me` + `tel:` actions. A phone should be one element everywhere: `<a class="ph">` with copy / WhatsApp / call / "open in inbox".
7. **Native `confirm()`/`prompt()` still in use** on `ops.html:181,244` and `leads.html:286`, despite `ux.js:33-67` providing `askConfirm`. `ux.js` also overrides `window.alert` to a toast, so any page without `ux.js` (ops, brain, automations) still gets raw browser alerts.
8. **Emoji as icons** (`📲 📋 ⏸ ▶ 🧊 ❌ 🚫 🔍 🌙`) on `clients.html:141-143`, `ops.html:85-128`, `inbox.html` header. The rail already has a drawn SVG icon set (`adminbar.js:ic`); reuse it. Emoji render differently per OS and read as unfinished.

---

## 1. Page-by-page

### hq.html — "HQ"
- **For:** the morning screen: is anything broken, what needs a hand, what's coming, leads, money.
- **Data/actions:** status strip (sending / Shir / Noa / ads) from `pause`, `wave-audit`, `cap-status`, `call-board`, `evlog`, `ads-health`; "דורש אותך" to-do list; upcoming events with RSVP bars; lead KPIs from `leads`; money from `status?view=biz`. Read-only, links out.
- **Problems:**
  1. Greeting is hard-coded `'ריצארד'` (`hq.html:141`). Shalev sees Richard's name. Needs the session's user (§4).
  2. Every to-do row links to a whole page (`calendar.html`, `clients.html`, `ops.html`), never to the event itself (`hq.html:159-160,194,210`). "X — 12 מוזמנים בלי הזמנה" should open that event's sending tab, not the month grid.
  3. `s-noa` status is inferred by regex over log text (`/131042/`, `/נועה כבויה/`, `hq.html:180-181`). Fragile; one wording change in `logEvent` silently turns the tile green. Worker should expose a `noa` block in `cap-status` or `status`.
- **Verdict:** keep as home. Add the live stream (sprint goal 2) as a 10-row strip under "דורש אותך". Rename nav label `HQ` → `היום`.

### admin.html — "מרכז הבקרה"
- **For:** everything else: KPIs, traffic, funnel, campaigns, events table, Shir call log, P&L, fixed costs, cost CSVs, lead sources, controls. 3,213 lines, 63 listeners, 14 endpoints, two "views" switched by CSS (`admin.html:428-429`).
- **Data/actions:** `status(view:biz)`, `traffic`, `campaign-stats`, `shir-calls`, `call-board`, `call-heard`, `ops-stats`, `cost-log`, `fixedcost`, `adspend`, `pause`, `block-phone`, `event-flag`, `brain-toggle`. Writes: pause, block/release phone, hold event, AI toggle, ad spend per month, fixed costs, mark call heard, download recordings.
- **Problems:**
  1. It is five pages in one file. The `?view=calls` trick hides ~60% of the DOM with CSS, but both halves load and poll. Cmd+F in the browser finds hidden rows. A user who lands on `admin.html` sees KPIs, a traffic chart, a funnel, then eight collapsible folds before reaching the controls at the very bottom (`admin.html:804-845`).
  2. Finance (`כספים · רווח והפסד` → `שורה תחתונה`, lines 661-725) is the only place with a date-range control, and it sits between the events table and packages. The P&L tax % and "הוצאות קבועות" inputs are inline-styled form fields with no save feedback beyond a flash.
  3. Events table (lines 585-596) has 14 columns including `הקפאה`, `חשבונית`, `קובץ` but no row click, no link to `clients.html`, no phone. The same event appears on `clients.html` with different fields and different actions; the two never link to each other.
- **Verdict:** split. KPIs + traffic + funnel + campaigns + P&L → `finance.html` ("כספים") under עוד. Events table → fold into `clients.html` list view (it has the money columns clients lacks). Shir call log + call board → `calls.html` (§2). Controls section → delete; `ops.html` becomes the single control page. Kill `?view=calls`.

### clients.html — "לקוחות"
- **For:** list of paid events with per-event free add-ons, links, reset, hold.
- **Data/actions:** `status(view:biz)` events, `client-flags`, `feedback-list`; writes `client-link`, `guests-reset`, `grant-addon`, `client-active`, `eventflag(hold)`. 11 buttons per card.
- **Problems:**
  1. Eleven equal-weight buttons on every card (`clients.html:137-150`), including three "חינם" grants and a red "ביטול לקוח", all visible for every event always. Dangerous and routine actions share a row. Restraint rule: primary (open), secondary (send link), everything else behind a menu.
  2. No detail view. Card shows paid/plan/tags, but sending status, calls, messages and invoice live on four other pages. Phone is plain text at the end of the action row (line 150).
  3. The "search" field matches `client+name+phone+occasion` with raw `includes` (line 109): typing `054-441` won't match `972544418714`; no normalisation, no debounce.
- **Verdict:** becomes the list half of the customer object. Card click → `client.html?t=` (§3). Keep list filters (active/inactive, search), add columns from admin's events table (date, ₪, invoice, file, RSVP %). Move all 11 actions to the customer page's "פעולות" tab.

### leads.html — "לידים"
- **For:** lead board: status, owner, follow-up date, notes, groups, source.
- **Data/actions:** `leads`, `lead-update` (status/owner/group/followup/note). WhatsApp + tel links. Already the most CRM-like page.
- **Problems:**
  1. Default filter is `all` (`leads.html:166`). A salesperson opens it to see "מעקב היום"; today that is a chip click every time. Sticky last filter via `localStorage` like `ishur_leads_grp` already does for groups.
  2. Row grid is 9 columns, `17.5rem` reserved for the action pills (`leads.html:53`); at 1240px the name column truncates while 5 small pills get fixed room. Owner `<select>` and follow-up `<input type=date>` are invisible until hover (line 75-76): discoverability cost for a new employee.
  3. `prompt()` for new group name (line 286); won leads disable the status select with a `title` only (line 234), no visible reason; no link to the client page for won leads except a dashboard link opened in a new tab.
- **Verdict:** keep. Default to "מעקב היום" when count > 0 else "חדש". Won lead → `client.html?t=`. Notes drawer becomes the lead's timeline (same component as customer log). Rename label stays `לידים`.

### inbox.html — "אינבוקס"
- **For:** WhatsApp threads on both numbers (Noa 4499, guests 6673), reply, send template, per-thread AI off.
- **Data/actions:** `inbox` ({channel}|{phone}), `wa-send` (text/template), `human` (AI on/off per phone), `media-dl`. Has its own sessionStorage cache (`inbox.html:290-298`) that duplicates `ux.js` SWR.
- **Problems:**
  1. Thread header shows name + phone + "נועה עונה כאן" switch, but not *which client/event* this phone belongs to, nor whether it's a lead. Pane has `pKind` but no link to `clients`/`leads`. The operator must copy the phone and search elsewhere.
  2. Own header with `→ מרכז הבקרה` link and emoji theme button (lines ~200-205) sits under the adminbar: two headers, two nav systems on one screen.
  3. 24-hour window rule is a static `<p class="note24">`; the composer stays enabled and the error only comes back from the API. Compose should switch to template mode automatically when `last_inbound > 24h`.
- **Verdict:** keep as the messaging surface, embedded as a tab inside the customer page (`?phone=`) and reachable from search. Nav: merge with calls under `שיחות` (§2). Drop own header.

### calendar.html — "לוח שליחות"
- **For:** month grid of planned/sent/failed/skipped sends; skip a planned send.
- **Data/actions:** `calendar({month})`, `skip({token,phone,kind,on})`.
- **Problems:**
  1. Arrow keys and buttons are inverted for RTL: `prev` button shows `›` and `ArrowLeft` → next month (`calendar.html:95,223`). Apple Calendar in Hebrew puts "previous" on the right with `‹`... this file does the opposite of what the comment claims.
  2. Day pane rows show name/phone/what, but no link to the event or thread. "נכשל" rows show the raw error string; no retry (`wave-retry` exists at `index.js:9124`).
  3. Grid cells are count pills only; one event with 300 sends and five events with 60 each look identical. Operators think per event, not per day.
- **Verdict:** keep as a view, add "per event" toggle (list of events × next 5 sends). Also surface the same data as the "שליחות" tab on the customer page. Nav: under עוד or as a secondary tab of לקוחות.

### calls.html — "מוקד שיחות" (manual queue)
- **For:** human dial list for guests who did not answer (Shir's leftovers): script, 5 outcome buttons.
- **Data/actions:** `status` (queue, max_tries), `event(call_result)`.
- **Problems:**
  1. Nav label "מוקד שיחות" points to `admin.html?view=calls`, not here (`adminbar.js:38`); this page is only linked from a sentence inside admin (`admin.html:480`). Two "call centre" pages with the same name.
  2. Writes without `admin_key` semantics of who called; outcome buttons are 5 full-colour pills of equal weight including "לחייג שוב" (same colour family as "מגיע" at a glance).
  3. No dark palette, own header, no `ishur:fresh` repaint of counts beyond k-due.
- **Verdict:** fold into `calls.html` v2 = Shir's auto log (admin fold `fold-calls`) + call board + this manual queue as three tabs. One page named `שיחות`.

### automations.html — "אוטומציות"
- **For:** documentation of the daily engine (16 steps) and event-driven routes, plus a dry run for a chosen date.
- **Data/actions:** static card content in JS (titles at body lines 108-323); one real call `daily-run({dry:true,today})`.
- **Problems:**
  1. 90% prose. Cards describe automations but show no live state (last run, last result, next run), so it is a manual, not a console.
  2. Dry-run output renders in-page but the real run lives on `ops.html` ("פעימה עכשיו"); the two are not cross-linked.
  3. No `ux.js`, no `guard.js`; own theme toggle; raw alerts.
- **Verdict:** move under עוד as "מנוע" documentation; merge the dry-run block into `ops.html` next to the real run, and add "last run / result" per step from `evlog`.

### brain.html — "המוח"
- **For:** edit Noa's persona + FAQ (sheet) and four Retell prompts (Noa out/in, Shir out/in); Noa AI on/off.
- **Data/actions:** `brain-admin(get/set)`, `shir-admin` (Retell proxy, get-agent / get-retell-llm / update-retell-llm PATCH).
- **Problems:**
  1. Five full-prompt textareas save straight to production Retell with no diff, no version, no undo (`brain.html:306-319`). A mistyped paste changes the next live call. Needs: show "last saved by/when", confirm on save, keep previous version in KV.
  2. The AI toggle here (line 114) is the third copy of the same switch (ops.html, admin.html). Memory rule "Noa AI off by decision": a switch that is this easy to flip in three places invites an accidental on.
  3. Retell agent IDs are hard-coded in the page (lines 280-283); page breaks silently if an agent is recreated.
- **Verdict:** keep, under עוד as "הגדרות · סוכנות". Owner-only (§4). Remove the toggle (one place: ops).

### ops.html — "שליטה"
- **For:** emergency switches: global pause, Noa AI, per-event hold/cancel/extra wave by pasted token, block phone, dry run / real pacer run, IPN replay.
- **Data/actions:** `pause`, `brain-toggle`, `event-flag`, `block-phone`, `daily-run(dry)`, `pacer`, `ipn-replay`.
- **Problems:**
  1. "אירוע בודד" requires pasting a 36-char UUID (`ops.html:103,208`). No picker, no search. The same actions exist as buttons on `clients.html` cards. Pick one home (customer page) and link here.
  2. Native `confirm()` for the two most dangerous buttons (lines 181, 244); no `ux.js` loaded; "פעימה עכשיו (שולח באמת)" sits one row under "הרצה יבשה" with the same button style.
  3. No log of who pressed what; result text lives only in a `<p class="st">` that disappears on reload.
- **Verdict:** this is the right single control page. Rename to `הגדרות ובקרה`; absorb admin's `.ctl` section and brain's toggle; replace token paste with a client search field; owner/ops role only.

### ad-report.html — "דוח קמפיין"
- **For:** archive of the automatic 4-day Meta campaign reports, print to PDF.
- **Data/actions:** `ad-reports({date?})`. Read-only.
- **Problems:**
  1. Three separate ad views: this page, admin's `קמפיינים` fold (`admin.html:550-570`), and HQ's `מודעות` tile. CAC appears on all three with different wording.
  2. Report list is a 220px aside of dates only; no sparkline / verdict colour in the list, so you open each to know if it was red.
  3. Legacy reports render as `<pre>`; no filter by campaign (Shalev's vs auto).
- **Verdict:** under עוד as "דוחות · קמפיין", or a tab of `finance.html`. Fine as is otherwise.

### seating.html — "סידור הושבה"
- **For:** client-side floor plan editor (round/long tables, drag guests, auto-seat). Token-scoped (`?t=`), client-facing; loads `guard.js` but not `adminbar.js`.
- **Data/actions:** `seatplan`, `seating`, guest list via status.
- **Admin relevance:** only as a link from the customer page ("פתח הושבה"). Not a nav item. No changes proposed here beyond that link.

### admin-login.html — OTP login
- **For:** phone → 6-digit code → year-long `sess.<nonce>.<sig>` token in `localStorage` + cookie.
- **Flow (worker):** `handleAdminOtp` (`index.js:1912-1940`): phone must be in `env.ADMIN_PHONES` (wrangler.toml:28 lists two numbers), 5/hour, code to Slack webhook, WhatsApp `sendOtpTemplate` fallback. `handleAdminLogin` (1942-1975) mints HMAC-signed token; `resolveAdminSession` (1878-1902) swaps any valid `sess.` for `ADMIN_KEY` before routing.
- **Problems:**
  1. Copy says "הקוד מגיע לסלאק" (line 53) but the button says "שלחו לי קוד לוואטסאפ" (line 58). Shalev is not in Slack; her code goes to Richard's channel (`SLACK_ALERT_HOOK`), so she cannot log in without him.
  2. All sessions resolve to the single `ADMIN_KEY`; the KV row keeps `{phone, at}` but no handler reads it, so there is no identity or role after login.
  3. Every admin page keeps its own raw-key gate as the primary path; this page is a footnote link on 4 of them and absent on the rest.
- **Verdict:** make this the only login (§4); raw key becomes a hidden fallback behind `?key=`.

---

## 2. Proposed information architecture

Rail (`adminbar.js` INTERNAL), 5 items + עוד, in this order (RTL):

| # | Label | File | Contains |
|---|-------|------|----------|
| 1 | היום | `hq.html` | status strip, needs-you, upcoming, lead/money KPIs, **live stream (10 rows)** |
| 2 | לקוחות | `clients.html` → `client.html?t=` | list (filters, money columns from admin events table) → one customer page with tabs (§3) |
| 3 | לידים | `leads.html` | as is + defaults + link to client on won |
| 4 | שיחות והודעות | `calls.html` (tabs: אינבוקס · לוח שיחות · תור ידני · יומן שיר) | `inbox.html` content, admin `fold-board` + `fold-calls`, current `calls.html` |
| 5 | לוג | `live.html` (sprint 2.2) | stream from `msg-stats`/`stream:` keys, filters, freeze |
| עוד | | | כספים (`finance.html`: admin KPIs, funnel, P&L, costs, campaigns) · לוח שליחות (`calendar.html`) · דוח קמפיין · הגדרות ובקרה (`ops.html` + brain toggle + admin `.ctl`) · סוכנות/המוח (`brain.html`) · מנוע (`automations.html`) · האקסל · Make · כלים (existing TOOLS groups) |

Rules:
- Rail owns: gate, theme toggle, Cmd+K, user chip (name + role from session), "עודכן HH:MM" stamp. Pages drop their own `<header class="head">`, gate, theme code.
- One stylesheet: promote the paper palette (`hq.html:18-19`) into `assets/admin.css`; retire per-page `:root` blocks. One button scale: `.btn` (primary pine), `.btn.ghost`, `.btn.danger`, `.chip` for filters. No emoji icons.
- Delete: `admin.html?view=calls` route, admin `.ctl` section, `brain.html` toggle, `ops.html` raw-token input, duplicate 403 handlers.
- Mobile: rail already collapses externals under עוד (`adminbar.js` media query). With 5 items the one-line rule at `adminbar.js:44` holds at 375px without horizontal scroll.

---

## 3. Single customer page spec · `client.html?t=<token>`

Header (always visible): client name · event name/occasion · date (+ days-to) · plan/tier/₪ · phone as action element (copy / WhatsApp / call / inbox) · status pills (active, hold, cancelled, file uploaded, sent) · primary buttons: `הדשבורד שלו` (`dashboard.html?t=`), `שלח קישור` menu. Everything else in tabs:

| Tab (`?t=…&tab=`) | Shows | Existing routes (worker/index.js) |
|---|---|---|
| `status` סטטוס | guests/answered/sent/dead bars (hq's `renderEvents` logic), file/settings state, feedback (NPS) | `/api/status` `{view:'biz'}` filtered by token (10372); `/api/wave-audit`; `/api/client-flags` `{tokens:[t]}` (9685); `/api/feedback-list` |
| `sends` שליחות | planned/sent/failed/skipped for this event, skip/unskip, retry failed wave, change send date | `/api/calendar` `{month}` filtered by token; `/api/skip` `{token,phone,kind,on}` (10296); `/api/wave-retry` (9124); `/api/send-date`; `/api/event-day` `{token, action:set|clear|run}` (9251) |
| `calls` שיחות | Shir calls for this event's guests + manual queue rows | `/api/shir-calls`; `/api/call-board` (8880) filtered by token; `/api/call-get` `{id}` for transcript; `/api/call-round` `{token, action}` |
| `messages` הודעות | inbox threads for client phone (Noa) and guest phones (6673) | `/api/inbox` `{phone}` / `{channel}`; `/api/wa-send`; `/api/human` `{phone, ai}` |
| `guests` אורחים | guest list with RSVP, edit/add, seating link | `/api/guest-edit` (9754), `/api/guest-add`, `/api/guest-rsvp`, `/api/guest-text`; link `seating.html?t=` |
| `money` תשלום | paid_at, sum, plan, invoice status, add-ons granted, hostess/gift add-ons | `/api/status` fields `paid/paid_at/sum/invoice`; `/api/addon-quote`; `/api/giftlinks` (9548); `/api/hostess-check` (9435); `/api/evlog` `{action:'invoice-make', token}` (8581) |
| `actions` פעולות | the 11 `clients.html` buttons + ops per-event flags, grouped: links · grants · list reset · hold/cancel (danger, confirm) | `/api/client-link` `{token,kind}`; `/api/grant-addon` `{token,kind,n}`; `/api/guests-reset`; `/api/client-active`; `/api/event-flag` `{token,flag:hold|cancel|extrasend,on}`; `/api/event-change` (10123) |
| `log` יומן | every `logEvent` row with this token, newest first; link into live.html filtered | `/api/evlog` `{n}` filtered by `token`; later `/api/stream` `{token}` (sprint 2.1) |

Behaviour: tab in URL so links from HQ/leads/inbox deep-link (`client.html?t=…&tab=sends`). Danger actions use `askConfirm` with `danger:true`. Every write toasts and appends to the `log` tab immediately (optimistic). Phone element reused in leads, inbox, calendar.

Gaps to add in the worker (small): a `token` filter param on `/api/evlog` and `/api/calendar`; a `phone→token` lookup (today only `eventsForPhone(raw, phone)` at ~5802 exists server-side).

---

## 4. Global search spec · Cmd+K

`ux.js:184-188` already binds Cmd/Ctrl+K to focus a page's search box. Replace with a rail-owned palette:

- Trigger: Cmd/Ctrl+K anywhere; `/` when not in a field; search icon in rail; on phone a magnifier in the bottom bar.
- Index (client-side, built once per session from reads already cached by `ux.js` SWR, refreshed on `ishur:fresh`):
  - clients: `/api/status {view:'biz'}` → `{token, client, name, phone, occasion, date, plan}`
  - leads: `/api/leads` → `{phone, name, occasion, status, owner, token?}`
  - conversations: `/api/inbox {channel:'all'}` → `{phone, name, wa_name, ch, last_ts}`
  - call ids: `/api/shir-calls` → `{id, to, name}` (only when query starts with `call_`)
- Matching: normalise phones (`972…`, `05…`, dashes) before compare; name/occasion `includes` on lowercase; token prefix match (8+ hex chars). Rank: exact phone > client name > lead name > thread.
- Results: grouped `לקוחות / לידים / שיחות`; each row shows name · phone · one-line state (e.g. "שולם · 12.11 · 240 מוזמנים · 61% ענו"). Enter opens: client → `client.html?t=`; lead → `leads.html?p=` (scroll + open drawer); thread → `calls.html?tab=inbox&phone=`.
- Actions from a result (⌘↵ or hover): WhatsApp, call, copy phone, "הקפא"(owner/ops only).
- Verification: typing `0544418714` returns the client in <150 ms from cache and Enter opens the customer page (sprint 3.3).

---

## 5. Multi-user login proposal · OTP per user with roles

Reuse what exists; change as little as possible in the worker.

**Data**
- Replace `env.ADMIN_PHONES` string with a KV record per user: `user:<phone>` → `{name, role: 'owner'|'sales'|'ops', active, slack_hook?}`. Seed from the two numbers in `wrangler.toml:28` (Richard=owner, Shalev=sales). Managed from `ops.html` "משתמשים" card, owner only (`/api/users` create/list/disable).
- Session KV row `adminsess:<nonce>` already stores `{phone, at}` (`index.js:1971`); add `role, name`.

**Flow**
1. `admin-login.html` unchanged UI; copy fixed: "הקוד מגיע בוואטסאפ". Owner may keep Slack by `user.slack_hook`.
2. `handleAdminOtp` (1912): look up `user:<phone>` instead of `ADMIN_PHONES`; deliver via `sendOtpTemplate(env, phone, code)` (`whatsapp.js:392`, template `ishur_kod`, already approved and used by `handleOtpSend` at 5789 for clients) unless the user record has a Slack hook. Keep the 5/hour cap and non-revealing response.
3. `handleAdminLogin` (1942): unchanged minting; write `role/name` into the KV row; Slack line says who.
4. `resolveAdminSession` (1878): after validating the signature, read `adminsess:<nonce>` (one KV get; fall back to `role:'owner'` if KV lags, since the token is already proven) and set `body.admin_key = env.ADMIN_KEY` **and** `body._actor = {phone, name, role}`. Handlers do not change signatures; `logEvent` gains `by: body._actor?.name` so the live log says who.
5. Add `/api/me` → `{name, role}` for the rail's user chip and HQ greeting (`hq.html:141`).

**Roles (enforced in `resolveAdminSession` by route allow-list, 403 otherwise; UI hides the rest)**

| Route group | owner | sales | ops |
|---|---|---|---|
| read: status, leads, inbox, calendar, call-board, shir-calls, evlog, ad-reports | ✓ | ✓ | ✓ |
| leads writes: lead-update, lead-monday | ✓ | ✓ | ✓ |
| customer actions: client-link, grant-addon, guests-reset, client-active, skip, wa-send, human | ✓ | ✓ (no guests-reset, no cancel) | ✓ |
| control: pause, event-flag, block-phone, pacer, daily-run, ipn-replay, wave-retry | ✓ | ✗ | ✓ |
| settings: brain-admin, brain-toggle, shir-admin, fixedcost, adspend, users | ✓ | ✗ | ✗ |
| raw `ADMIN_KEY` (no session) | treated as owner |

**Revocation:** already exists (`adminrev:<nonce>`, line 1894). Expose "התקנים מחוברים" list from `adminsess:*` on the users card with a revoke button.

**Verification for the build:** Shalev's number requests a code → `ishur_kod` template arrives on WhatsApp (no Slack); login → `/api/me` returns `role:'sales'`; `POST /api/pause {paused:true}` with her token → 403; `POST /api/lead-update` → 200 and the evlog row carries `by:'שלו'`.

---

## 6. Order of work (smallest reversible steps)

1. `adminbar.js` v14: new 5+עוד list, shared gate, theme toggle, user chip. Pages lose own headers. (One file + deletions.)
2. `assets/admin.css` from hq palette; load on all admin pages; delete per-page `:root`.
3. `client.html` with tabs status/actions/log first (all routes exist), then sends/calls/messages/guests/money.
4. Cmd+K palette in `adminbar.js` over cached reads.
5. Login: KV users + `_actor` + `/api/me`; role allow-list.
6. Split `admin.html` → `finance.html`; fold calls into `calls.html`; retire `?view=calls`, admin `.ctl`, brain toggle.
7. `live.html` (sprint goal 2) and the HQ strip.
