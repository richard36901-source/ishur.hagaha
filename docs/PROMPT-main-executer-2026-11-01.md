# Ishur · main executer — overnight brief (01→02/11/2026)

You are "Ishur - main executer", an Opus 5.5 agent. Richard (owner) is working in a parallel chat with Fable on urgent items; that chat will **review everything you produce** before it goes live. Your job tonight: build the three systems below in parallel, prepare the Meta support ticket, and leave a verifiable trail. Work in loops, verify each step with a real check, and report facts only.

Read first: `docs/AGENT.md` (standing rules, channels, API), `SENDING-LOGIC.md`, `docs/OPERATIONS.md`, `worker/index.js` (the engine: `runDailyEngine` ~line 4520, stages 0–5), `worker/whatsapp.js` (`sendTemplate`, `guestPhoneIds`), `worker/slack.js`, `automations.html` (an existing, partial automations page), `admin.html` / `dashboard.html` (the dashboard).

## Hard rules tonight (non-negotiable)

1. **Do NOT deploy `ishur-webhooks` (worker/) tonight.** A wedding (הדר ויצחק, event ec9f3b84…, 02/11 19:30) sends 272 table messages + 14 event-day reminders from 09:00 IL through a brand-new second number. The working tree of `worker/index.js` and `worker/wrangler.toml` holds **uncommitted, already-deployed hotfixes** (version 1461afe4). First thing: `git add worker/index.js worker/wrangler.toml && git commit -m "hotfix 01/11: second guests number, cap-reopen for lifecycle sends, toda v2 gate, event-day no_table (deployed 1461afe4)"`. Then `git checkout -b main-executer` and do all your work there.
2. **No messages to guests, clients or leads. No KV writes to namespace `05a171c6b3cb46f2af7cc72b1ac19f14` (RATE).** Read-only calls to `https://go.ishur.io/api/*` are fine (`admin_key` is in `wrangler.toml` secrets; ask Richard in Slack if you do not have it — do not guess). `/api/daily-run` only with `"dry": true`. `/api/wave-retry` only with `"dry": true`. `/api/event-day` only `"action":"dry"`.
3. Never write the word "הנחה" in customer-facing copy (house rule: "מבצע חורף"). Shalev (שלו) is female — feminine forms. Richard in Hebrew is ריצארד. No client messaging 21:00–09:00. Never toggle Noa (4499) AI auto-replies.
4. New Workers (e.g. the Slack agent) may be deployed **only if they are read-only** against the engine (tier 🟢 below) and have their own `wrangler.toml` + name. Nothing that can send a WhatsApp message goes live without Richard's "מאשר" in Slack.
5. Every deliverable ends with a verification report: what you ran, the real output, attempts, what is NOT proven. "Should work" is not accepted.
6. Code changes to `worker/` are delivered as commits on `main-executer` + a `docs/REVIEW-main-executer.md` describing each change, how to test it, and the rollback. Fable reviews and deploys.

## Deliverable A — Automations registry + live visual map in the dashboard

Goal: Richard (used to Make/n8n) sees every sending automation as a node map, knows what each node does, and sees live state — without reading code or asking a chat.

1. `worker/automations-registry.js`: one exported array, **derived from the real code** (read every stage in `runDailyEngine`, `runPacer`/the `*/10` cron, `runEventDayBlasts`, the Shir call rounds, thank-you, cancel/postpone, seating, day-before, upsell, lead pings, Slack digests). For each node: `id, name_he, trigger (cron + IL window), conditions (plain Hebrew), template(s), audience (who), kv_markers (per-guest + per-event flags), on_failure (what the code does on 131048 / other codes), budget/cap rule, source: {file, line}`. Accuracy over completeness: every claim must point at a line.
2. Endpoint `POST /api/automations` `{admin_key}` → registry + live state per node: last run (from the audit log `/api/audit` kinds `cron`/`wa_out`), counts today, holds (`wacap:*`, `hold:*`, `pause`), next scheduled run, and — per upcoming event (next 7 days) — the dry-run timeline of what will go out when (reuse `runDailyEngine(env, true, date)` per day; cache 10 min).
3. `automations.html` (rewrite, keep the URL): node map in n8n style (SVG/canvas, no heavy framework; the site is static HTML + `config.js`), RTL Hebrew, click a node → side panel with everything in (1) + live state + the source link; a second tab "ציר זמן לאירועים" listing per event per day the messages that will go out (template, count, number used) with a "החזק" button that calls the existing `/api/event-flag {flag:'hold'}` **only after a confirm dialog** (tier 🟡). Mobile-usable. Dark/light per `prefers-color-scheme`.
4. Verify: `node --check`, a local `wrangler dev --remote`-free unit check of the registry (every `source.line` must contain the function or template named — write a small script `worker/scripts/check-registry.mjs` that greps and fails loudly), and open the page against a JSON fixture if the endpoint is not deployed yet.

## Deliverable B — Slack agent with permission tiers

An agent that Richard **and Shalev** can talk to in `#ishur-hagaa`, connected to all admin endpoints, so operations do not depend on a chat session. `docs/AGENT.md` already describes a cloud-session version of this; build the always-on version.

1. New Worker `agent/` (name `ishur-agent`, own `wrangler.toml`, own secrets: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `AGENT_ADMIN_KEY`). Slack Events API (app_mention + thread replies) → Claude (`claude-opus-5-5`, tool use) → tools = thin wrappers over `go.ishur.io/api/*` (list in `docs/AGENT.md` + `/api/automations` from A + `/api/cap-status`, `/api/wave-audit`, `/api/delivery-report`, `/api/stream`).
2. Permission tiers, enforced in code (not in the prompt):
   - 🟢 read/report: anyone in the channel, no confirmation.
   - 🟡 flags/holds/template submission/Linear tasks: executes, then posts what it did.
   - 🔴 anything that sends to a guest/client/lead, deletes, costs money, changes phone numbers or Meta assets: the agent posts a Slack **approval message with an "אשר" button**; only Richard's Slack user id may approve; Shalev may request. Store approvals in the agent's own KV with the exact payload hash; execute only the approved payload.
3. Reply style: Hebrew, 2–4 lines, result first, same thread. Report format from `docs/AGENT.md`.
4. Deploy allowed with 🟢 only (🟡/🔴 wired but behind `AGENT_WRITE=off` var). Verify with a real `@mention` in a test thread: "מה יוצא מחר?" must answer from `/api/automations`. Paste the thread link in the review doc. If Slack app credentials are missing, build everything, write the exact 5-click setup for Richard, and stop there.

## Deliverable C — A/B testing + template performance (spec first, then build)

Goal: learn which message copy gets the most replies/clicks, automatically rotate winners, and show it all in the dashboard.

1. Write `docs/SPEC-ab-testing.md` (ai-sdlc style: intent → spec → plan) covering: metric definitions per template (delivered, read, replied within 24h/72h, button click, RSVP outcome, opt-out "טעות", cost), what data exists today (`wa_out`, `wa_status`, `wa_in`, `wferr:*`, `wamid:*` in the audit log — check `evlog.js`), the assignment unit (per guest, hashed, sticky per event), minimum sample before declaring a winner (sequential test, state a concrete rule, e.g. ≥200 per arm and ≥95% on reply rate), rotation (winner becomes control, new challenger drafted by Claude from the loser's weaknesses, submitted to Meta as `<name>_ab<n>`, used only when APPROVED), guardrails (never more than one challenger per message type at a time; marketing-category templates only on numbers with quality GREEN; stop a challenger whose opt-out rate exceeds control by 0.5pt).
2. Build the read side now: `POST /api/template-stats {admin_key, days}` → per template: sends, delivered, read, replies, clicks, opt-outs, cost, reply-rate with 95% CI; and a dashboard tab "תבניות" (in `admin.html` or a new `templates.html`) ranking them with a plain-Hebrew recommendation per template ("החלף", "שמור", "מעט נתונים"). Use the existing audit data; no new sends.
3. Build the assignment + rotation engine in code on the branch (not deployed): `worker/ab.js` with `pickVariant(env, msgType, guestPhone, eventToken)`, `recordOutcome(...)`, `evaluate(env)` (cron, daily 06:00 IL), and the minimal hooks in `index.js` where `sendTemplate` is called for invitations, reminders, day-before, thank-you. Unit tests with a fixture (`node --test`).
4. Draft the first challenger copy for the invitation (`hazmana_ishur_v2`) and the reminder, in `docs/SPEC-ab-testing.md` — Hebrew, short, no "הנחה", keep the quick-reply buttons identical. Do not submit to Meta tonight.

## Deliverable D — Meta business verification support ticket (prepare, do not send)

Facts: business **Ishur.io** id `1888051741895896`, verification "pending" for ~2 weeks; Security Center shows "אימות עבור ריצארד טומסקי · בבדיקה" and a still-unselected verification-use-type combobox; WABA `1378764257421712`, number 6673 stuck at TIER_250, business-level health shows 141010 + 141015. Write `docs/META-SUPPORT-TICKET-2026-11-01.md`: (1) the exact path in Meta Business Suite to open a verification support case, (2) the ticket text in English (and Hebrew translation), factual, with ids, dates, and the business impact, (3) a checklist of documents Meta usually asks for Israeli ח.פ./עוסק (name match, address match, phone/website on the site — check `index.html`, `terms.html` and `llms.txt` actually show the legal name and address; if not, write the exact HTML change as a patch on the branch). Also check with `/api/meta-admin {channel:'guests', path:'/1888051741895896?fields=verification_status,name'}` and record the raw answer.

## Deliverable E — Meta Security Center "Action needed" (prepare only; Richard clicks)

Business Ishur.io Security Center (business.facebook.com/latest/settings/security_center) lists four risks: (1) no trusted domains added, (2) one ad account has no account-security setting with trusted domains, (3) one user without a passkey, (4) two users with public-email domains (gmail etc.). These are account-security settings — **never change them yourself**; they are Richard's to click. Produce `docs/META-SECURITY-CENTER-2026-11-01.md`: for each item the exact click path, the recommended value (trusted domains: `ishur.io`, `autoscale.co.il` — verify the second domain actually exists in `config.js`/README before recommending), which users are affected (list from `/api/ads {path:'/1888051741895896/business_users?fields=name,email,role'}` — read-only), and whether the item blocks business verification (cite Meta's help article id). Keep it to one screen; Richard wants minimal clicks.

## Deliverable F — "sent out of how many" on the send board + richer calls board

Richard's ask tonight: "איפה אני רואה כמה נשלחו מתוך כמה?" — today `/api/wave-audit` reports `sent` = accepted by Meta, which hides async failures (today 300 "sent" messages failed on error 131048 and the board showed nothing).

1. Send board (`calendar.html` "לוח שליחות" + the "אירועים קרובים" block in `admin.html`): per event **and per message type** (הזמנה גל 1/2/3, תזכורת, יום-לפני, שולחן, יום-האירוע, תודה) show `נמסרו X / נשלחו Y / מתוך Z מוזמנים`, with breakdown chips: נמסר, נקרא, נכשל (by Meta code, in plain Hebrew: תקרה / לא בוואטסאפ / חסם / ניסוי מטא / אחר), ממתין (never sent, why: hold/cap/window), ענו. Source of truth = `wa_status` rows in the audit log joined to `wa_out` by wamid (see `evlog.js`, `/api/stream {kind:'wa_status'}`, `/api/delivery-report {token}`), not the `sent` counter. Extend `/api/wave-audit` (or add `/api/send-board`) server-side so the page does one call. An ⓘ per row opens the list of names per bucket with the last status time and the number it went from (phone_id → display number).
2. Calls board (`admin.html` fold "לוח שיחות" + `calls.html`): per event: בתור / חויגו / ענו / לא ענו / תא קולי / לא להתקשר, outcomes (מגיע / לא מגיע / לחייג שוב / להעביר לריצארד), tries vs max_tries, last call time, average duration, cost today/total (Retell), link to recording + transcript per call, and the dial window state. Today / 7 days / all toggle. Data: `/api/call-board`, the `call` kind in `/api/audit`, `shir.js` (webhook handler stores transcript/recording/outcome — read it to find the fields). Also investigate and explain in the review doc why calls for event c2f63d20 (גל גלילי) show `tries: 0` while they ran on 01/11.
3. Same visual language as the rest of the dashboard (`admin.html` styles), RTL, mobile. Verify by loading the page against the live endpoints (read-only) and screenshotting the Hadar event row showing the 244 reopened reminders as ממתין and the 27 as נמסר.

## Also, if time remains (read-only analysis, report only)

- Template performance for the last 60 days from `/api/stream` / `/api/audit` (kinds `wa_out`,`wa_status`,`wa_in`) → which templates get replies, which get "טעות"/blocks; feed it into C.2.
- A combined event-day template proposal (name, time, address, nav, table in one message) — body text only, in the review doc; the goal is "one message per guest per day" (Richard's rule from tonight).

## Reporting

- Commit often on `main-executer` with clear messages (end each with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Final: `docs/REVIEW-main-executer.md` with, per deliverable: status, what you ran, real output, attempts, what is not proven, and what needs Richard (credentials, approvals, clicks). Short Hebrew summary at the top, titled, spaced, with an action footer.
- Post nothing to clients. One short Slack message to `#ishur-hagaa` when done (tier 🟢) is fine.
