# ishur.io Ops Center — research, inventory, architecture, plan (03/11/2026)

Goal: one page (ops.html) from which Richard runs the business with no Claude Code chat open.
Read at ishur-int working tree, 03/11. Line numbers are worker/index.js unless noted. URLs below are cited from prior knowledge (not re-fetched today) — re-check before quoting externally.

## 1. RESEARCH (patterns worth stealing)

Sources:
1. Make scenario history & on/off: https://www.make.com/en/help/scenarios/scenario-execution-history
2. Make incomplete executions (failure queue + retry): https://www.make.com/en/help/scenarios/incomplete-executions
3. n8n executions list / retry / error workflow: https://docs.n8n.io/workflows/executions/
4. monday Automations Center (per-board list, run log, toggle): https://support.monday.com/hc/en-us/articles/360001222900
5. Datadog incident management / monitors status taxonomy: https://docs.datadoghq.com/monitors/manage/status/
6. Grafana alerting states (Normal/Pending/Alerting/NoData/Error): https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/state-and-health/
7. Cloudflare Workers Logs + Tail Workers + Observability: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
8. Cloudflare Durable Objects WebSocket hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
9. Cloudflare D1 (SQLite, indexes, limits): https://developers.cloudflare.com/d1/platform/limits/
10. Vercel runtime logs / deployment observability: https://vercel.com/docs/observability/runtime-logs
11. Stripe balance object (available/pending, per currency): https://docs.stripe.com/api/balance
12. Anthropic Admin API usage & cost report: https://docs.anthropic.com/en/api/usage-cost-api
13. Telnyx balance: https://developers.telnyx.com/api/billing/get-user-balance
14. Linear keyboard-first command menu: https://linear.app/docs/keyboard-shortcuts ; Apple HIG tables/data: https://developer.apple.com/design/human-interface-guidelines/charts

Patterns that matter:
- Registry model (Make scenario / n8n workflow / monday recipe): every automation is a record with
  `id, name, owner, trigger{type: cron|webhook|manual|chained, expr, il_time}, inputs, side_effects[]
  (wa_guest|wa_client|call|sms|email|sheet|kv|monday|slack|money), kill_switch{type: env|kv, key},
  depends_on[], feeds[], window (send/call hours), budget/cap, version`. We already have 80% of this in
  worker/automations-registry.js (graph with `from[]`, `kind`, `kv_markers`, `evidence[]`) — extend, don't rebuild.
- Run ledger (Make "history", n8n "executions"): one row per execution: `run_id, automation_id, parent_run_id,
  triggered_by (cron|webhook|manual:<who>|brain), started_at, ended_at, status, counts{sent,failed,skipped,dialed},
  cost{usd, tokens_in, tokens_out, meta_msgs, call_min}, error_class, logs_ref, version`. Parent/child lets the
  pacer show its 15 sub-steps as one expandable row (n8n sub-workflow pattern).
- Status taxonomy (Grafana/Datadog): `ok · partial · failed · skipped(reason: paused|window|holiday|cap|no-work) ·
  running · stale(no run when expected)`. "Skipped" is first-class — most of our "did it run?" questions are skips.
  "Stale" (Grafana NoData) is what the heartbeat at 04:00 does by hand today.
- Failure handling (Make "incomplete executions"): failures land in a queue with a Retry button and an error class;
  retries are new runs with parent_run_id.
- Alert routing (Datadog): severity → channel. P1 (guests not getting invites, sends to wrong number, money) =
  Slack + WhatsApp to Richard any hour; P2 = Slack now; P3 = morning digest (respects client-messaging 21:00–09:00 and
  slack_quiet). Dedup key per (automation, error_class, day) — already done ad hoc via `paceralert:<day>`.
- Blast radius on disable (monday/n8n warn "this is used by N boards"): compute downstream from the dependency graph
  (`from[]` edges reversed) + live counts ("turning off d_pacer stops wave1/2/3, lead_chase, shir_dispatch…; today
  that is 212 queued invites across 4 events, 31 calls"). Require typed confirmation (GitHub "type the repo name").
- Audit of overrides: every toggle/edit is itself a ledger row (`triggered_by: manual:richard`, before/after, reason).
  audit.js already hash-chains records with a daily Slack root — reuse that for overrides.
- Skeleton/streaming UX (Vercel/Linear): shell renders instantly from cache (localStorage last payload, marked
  "as of 12:03"), skeletons only for never-seen panels, data streams in per panel (independent fetches, no waterfall).
- Real-time on Workers: options are (a) DO + hibernatable WebSocket (true push, costs nearly nothing idle, but new
  binding + migration), (b) SSE from a Worker (a Worker cannot hold state across isolates, so SSE still needs a DO
  to fan out), (c) poll. For one viewer, a 3–5 s poll of a D1 `since=<last_id>` query is simplest and cheap
  (~17k reads/day while open). Recommend poll now, DO WebSocket in Phase 3 only if poll feels laggy.
- LLM cost attribution: every Anthropic call returns `usage.{input,output,cache_read,cache_creation}_tokens`;
  multiply by a price table in the registry; store on the run. For cloud routines/Agent SDK runs, the session
  result includes `total_cost_usd`; write it back via a POST to /api/ops/runs/:id. Admin usage API (source 12)
  reconciles daily totals against our per-run sums.
- Balances (Stripe-style "available / pending / low threshold / top-up link / auto-recharge on?"):
  Telnyx — API `GET /v2/balance` (already used, checkBilling 7973). Retell — no public balance endpoint I can
  confirm; we already infer billing failure in retellBillingGuard (8055); show "last successful call" + manual
  balance + dashboard link. Cloudflare — no prepaid balance; GraphQL Analytics gives usage vs. plan; show plan +
  usage. Anthropic — Admin API usage/cost (needs an admin key, sk-ant-admin…); credit balance itself is not in
  the API → manual + console link. Meta WhatsApp — per-WABA spend via Graph `analytics`/`pricing_analytics`; payment
  method/credit line not readable → manual. Meta Ads — Graph `act_<id>?fields=balance,amount_spent,spend_cap`
  (readable). Monday/Make — plan + ops quota via API (Make `organizations/:id` usage). Grow — revenue in, not a
  balance. Store manual balances as KV `bal:manual:<vendor>` with a date so staleness is visible.
- Apple HIG for dense data: SF-like system font stack, tabular numerals, 13/15 px body, 44 px hit targets on mobile,
  one accent color, status as color + glyph (never color alone), sidebars that collapse to a tab bar on phone.

## 2. INVENTORY (what runs today)

Kill-switch legend: `paused` = global KV key checked by sendingPaused (lib.js:30) — stops all guest/client sends and
dials; `hold:<token>` = per-event; env flags need a deploy. "Logged" = audit.js `job()` writes kind `cron` with
`data.job` (audit.js:215); logEvent = event journal (evlog.js).

| # | Name (registry id) | Trigger | Entry | Does | Side effects | Kill-switch today | Logged | Gaps |
|---|---|---|---|---|---|---|---|---|
| 1 | Pacer (d_pacer) | `*/10` | runPacer 6011 | slices sends+dials across window, runs sub-steps 2–12 | WA guest/client, calls, KV, Slack | paused (6036), window | job runPacer + `pacer:last` | one job row hides 12 sub-steps |
| 2 | Daily engine (d_engine) | `35 6` + via pacer | runDailyEngine 5002 | waves 1/2/3, report7, toda, syum, seating, day-before, cancel/postpone, upsells, stuck_client, no_setup | WA guest+client, sheet, KV, Slack | paused, hold:<token>, Shabbat/holiday | `engine:lastrun`, NOT wrapped in job() at 9409 | morning run has no job row |
| 3 | Auto-retry undelivered | pacer, 1/day | runPacer ~6046 | deletes wferr/gday/wave keys → re-send | KV deletes → WA | paused; `autoretry:<day>` | logEvent | mass re-send risk |
| 4 | Lead chase (lead_chase) | pacer | chaseAbandonedLeads 879 | Noa follow-ups to abandoned leads | WA client 4499, KV | paused, window | inside pacer | — |
| 5 | Shir callbacks | pacer | runShirCallbacks 2557 | calls back guests who called | Retell calls | paused, call window | inside pacer | cost not per run |
| 6 | Shir dispatch (shir_dispatch) | pacer, /api/shir-dispatch 9812 | runShirDispatch 2308 | dials guest queue | Retell calls, sheet | paused, hold, window | inside pacer | — |
| 7 | Noa lead dial | pacer | runShirLeadDial 2655 | outbound lead calls | calls | env NOA_LEADS=off | — | off |
| 8 | Reconcile calls | pacer | reconcileShirCalls 2279 | pulls Retell outcomes → sheet | sheet, KV | none | — | — |
| 9 | Template check | pacer hourly | templateCheck 5919 | Meta template status | Slack | none | — | — |
| 10 | Doctor | end of pacer | runDoctor 6169 | health of the tick, Slack | Slack | none | in pacer:last | no history |
| 11 | Slack night queue flush | pacer 09:00 | flushSlackQueue | releases quiet-hour alerts | Slack | — | — | — |
| 12 | Journal/sheetlogs/invoices flush | pacer | flushEventLog / flushSheetLogs / syncInvoices 7660 | KV→sheet, invoices | sheet, Grow docs | — | pacer:last | invoice gated off |
| 13 | Event-day blast (event_day_blast) | `*/10` | runEventDayBlasts 4396 | day-of message to guests | WA guest | paused + cap + window (4407), hold (4420) | job | — |
| 14 | Late invites | `*/10` | drainLateInvites 4371 | invites for guests added late | WA guest | paused (4344), hold (4345) | job | — |
| 15 | Call rounds | `*/10` | drainCallRounds 4673 | extra call round on chosen day | queue→calls | via dispatch | job | — |
| 16 | Party nudges | `*/10` | drainPartyNudges 4722 | "how many of you?" | WA guest | per-guest markers only (no paused check in 4722–4760) | job | **ignores global pause** — verify |
| 17 | Lead pings | `*/10` | drainLeadPings 699 | new lead → Slack after 10 min | Slack | — | job | — |
| 18 | Meta form leads | `*/10` | pullMetaFormLeads 728 | pulls lead-ads forms | sheet, Monday, Slack | — | job | — |
| 19 | Custom templates | `*/10` | checkCustomTemplates 4642 | client's personal invite template approval | Slack, KV | — | job | — |
| 20 | Calendar build | `*/10` | buildCalendarMonth 9180 | caches calendar month | KV | — | job | — |
| 21 | Noa AI queue | `*/10` | drainNoaQueue 3948 | delayed Noa replies | WA client | AI off by decision (brain-toggle) | job | must stay off |
| 22 | Admin calls | `*/10` | drainAdminCalls 8250 | scheduled call to admin | call | — | job | — |
| 23 | Noa chase | `*/10` | noaChaseTick noa.js:481 | Monday "no answer" → calls/Monday | calls, Monday | env NOA_CHASE=off | job | off |
| 24 | Ads watch | `*/10` + pacer | adsHealthWatch / adsHealthAlert | ad account health | Slack | — | job | — |
| 25 | Audit meta + mirror | `*/10`, hourly | audit.refreshMeta / mirrorRows | event metadata, audit→sheet tab | sheet, KV | — | job | — |
| 26 | A/B evaluate | `*/10` @06 IL | ab.evaluate ab.js:241 | picks template winners | KV | env AB_ENABLED | job | — |
| 27 | Morning undelivered | `35 6` | inline 9407 | Slack list of undelivered | Slack | — | none | — |
| 28 | Portfolio OTP | `35 6` | tryPortfolioOtp 8228 | 4499 portfolio registration attempt | Meta | CLIENT_PORTFOLIO | none | — |
| 29 | Call cost sync | `35 6` | syncCallCosts 7861 | Retell costs → log | sheet/KV | — | job | — |
| 30 | Backup | after engine | runBackup 6345 | sheet → KV | KV | — | alert on fail | — |
| 31 | Perf digest (Mon) | after engine | msgPerformanceDigest 7768 | weekly stats | Slack | paused (7790) | none | — |
| 32 | Heartbeat + Telnyx + billing | `0 4` | inline 9294, checkTelnyx 8076, checkBilling 7973 | engine stale alert, balances | Slack, Linear | — | none | balances not stored for UI |
| 33 | Daily improve | 20:00 IL | runDailyImprove 7430 | self-improve loop | Slack (+LLM?) | — | job | cost not tracked |
| 34 | Journal digest + traffic | 21:00 IL | dailyJournalDigest 7722, snapshotTraffic 8308 | daily report | Slack | — | job | — |
| 35 | Audit root | `0 19` | audit.dailyRoot | hash anchor | Slack | — | job | — |
| 36 | Team reminders | `0 9,10,16 * * 2` | runTeamReminders 6279 | hostess reminders | WA client | — | job | — |
| W1 | WA webhook (status+inbound) | POST /api/wa-webhook 11650 | wa_fail reopen, inbound routing | KV, WA replies, Slack | — | audit wa_in | wrong-number replies |
| W2 | Retell webhooks | /api/shir-webhook 9796, /api/noa-inbound 9800, /api/shir-inbound 9809 | call results, inbound | sheet, KV | — | keepCall | — |
| W3 | Grow IPN | /api/grow-ipn 9428 | payment → activate event | sheet, WA client, invoice | — | audit | money path |
| W4 | Monday hooks | /api/monday-hook 10557, /api/monday-won 9996 | lead stage sync | Monday, sheet | — | — | — |
| W5 | Site lead | /api/lead 11983 | lead → Monday + Noa | Monday, WA | — | audit | — |
| M1 | Manual sends | /api/gift-blast 10375, /api/subevent-send 10380, /api/sms-blast 10283, /api/resend 10265, /api/wave-retry 10199 (mutates even on dry!), /api/call-round 10336, /api/daily-run 10020, /api/outreach 9936 (OUTREACH_ENABLED), /api/dial 9948 (DIAL_ENABLED) | guest/client blasts | WA, calls, SMS, email | paused (partly) | audit | need typed confirm |

Claude-side (run only while a chat is open — CronCreate watchers, per brief; no code in repo):
| Watcher | Today | Cloud replacement |
|---|---|---|
| Template approval watcher | chat polls Meta, tells Richard when a template is APPROVED/REJECTED | Already half-done by templateCheck (#9). Extend: on status change write ledger row + Slack + (if `on_approve` action stored in KV) run it. Pure Worker cron, no LLM. |
| Gift blast watcher | chat watches the gift-link blast progress/failures | Make /api/gift-blast enqueue a job (`job:<id>` in D1); `*/10` drain sends in slices, ledger counts; failures → playbook #7. Worker cron. |
| Wedding-day recovery | chat checks event-day sends/calls and fixes misses | Brain playbook (§3d #3, #8) on `*/10` during event days; only escalate to an LLM routine for unknown failure classes. |

## 3. ARCHITECTURE

(a) Registry. Keep `worker/automations-registry.js` as the versioned source of truth (it already has graph edges,
evidence lines and a `check-registry.mjs` drift test). Add per node: `side_effects[]`, `kill{type:'kv',key:'off:<id>'}`
(new uniform switch), `severity` (P1–P3), `expected_every` (for stale detection), `price` hints, `owner`, `edit{}`
(which fields are editable in UI: cron-like IL time, text/template name, budget). Runtime state lives in D1 table
`automation_state(id, enabled, disabled_by, disabled_at, reason, overrides_json, version)` mirrored to KV `off:<id>`
for a 1-read hot check. One helper `isOff(env, id)` called at the top of every entry (and `paused` keeps meaning "all").

(b) Runs ledger — **D1, not KV.** Reasons: we need filter+sort+aggregate (runs by automation, status, day; "most run";
failures last 24 h; cost per day) — KV only lists by prefix, lags its own writes (memory: cloudflare-kv-list-lag), and
audit.js already hit the ~10k-ops-per-invocation wall reading a heavy day (02/11). D1 gives indexed SQL, `count/sum`,
cursor pagination, 10 GB, and writes are cheap at our volume (~150 ticks/day × ~20 jobs ≈ 3k rows/day + events).
KV stays for hot flags and caches; audit.js stays as the tamper-evident journal (ledger rows reference audit ids).
Schema: `runs(id TEXT PK, automation_id, parent_id, triggered_by, started_at, ended_at, status, skip_reason,
counts_json, cost_usd REAL, tokens_in, tokens_out, error_class, error, version)`, `run_logs(run_id, ts, level, msg,
data_json)`, `balances(vendor, at, amount, currency, source, ok)`, `overrides(id, at, who, automation_id, action,
before_json, after_json, reason)`, `findings(id, at, check_id, severity, status, playbook, run_id)`. Indexes on
(automation_id, started_at), (status, started_at), (started_at).
`withRun(env, id, fn, {trigger, parent})` replaces audit.job: checks `isOff`, inserts `running`, passes a `run`
object (`run.count('sent')`, `run.log()`, `run.cost({usd,tokens})`, `run.skip(reason)`, `run.child(id, fn)`),
finalises status, still calls audit.record for the chain. Writes go through `ctx.waitUntil` and a 50-row batch so a
D1 hiccup never blocks a send (on D1 failure, fall back to audit.record only).

(c) Endpoints (all POST with admin_key like today, JSON):
- `/api/ops/registry` — nodes + state + last run + 24h counts + next fire (reuse automations.js nextFire).
- `/api/ops/runs` — filters: automation_id, status, from/to, triggered_by, cursor; returns 50.
- `/api/ops/run` — one run + children + logs + linked audit records.
- `/api/ops/toggle` — `{id, enabled, confirm}`; server computes blast radius = downstream nodes (reverse `from[]`
  BFS) + live impact (queued invites/calls today per event from send-board.js / cap-status) and returns it on a
  first call without `confirm`; second call must echo `confirm === id` (typed). Writes override + Slack line.
- `/api/ops/balances` — vendor adapters (telnyx, metaAds, metaWa, anthropicAdmin, cloudflare, retell=manual,
  make, monday); cached 10 min in KV `bal:cache`, history in D1; each returns `{amount, low_threshold, topup_url,
  auto_topup: true|false|unknown, as_of, source: api|manual}`.
- `/api/ops/realtime` — calls today (out/answered/queued/remaining, per event, reason), WA per number (cap, sent,
  failed, scheduled vs exception), queue size; built from existing /api/cap-status (10395), /api/stream (10502),
  /api/ops-stats (9818), send-board.js.
- `/api/ops/live?since=<id>` — newest ledger + audit rows; UI polls every 3 s while visible (Page Visibility API).
- `/api/ops/brain` — findings + brain run logs (same `since` poll).

(d) Brain. Worker cron `*/10` runs `runChecks()` (pure code, no LLM, ~1 s): each check returns finding or ok, written
to `findings`. Known class → deterministic playbook in the Worker (no LLM, logged step by step as run_logs so the UI
shows "reasoning"). Unknown/needs-judgement class → POST to a claude.ai scheduled-routine trigger (or Agent SDK on a
small host) with the finding; the agent reports back via `/api/ops/run-log` (streaming lines) and its
`total_cost_usd`. Guardrails: playbooks may only use existing guarded functions (respect paused/hold/windows/
client-messaging hours/explicit-send rule); anything that messages a client/guest beyond re-sending an
already-approved message needs Richard's tap in the UI (pending-approval state). Noa AI stays OFF (rule).
First 10 playbooks:
1. Template pending >24 h → resubmit a variant (name_v2), alert; rejected → alert with Meta reason.
2. `paused`/`hold:` stale (>12 h, event date near) → verify reason exists, Slack "release?" button (no auto-release).
3. Snapshot fetch failed / no-snapshot → retry ×3 with backoff, then re-arm `pacer:pending`, P1 alert.
4. 131042 (payment issue) on a number → stop that number in pickGuestPhone rotation, P1 + open Meta ticket draft.
5. Telnyx number order pending → re-poll + nudge Slack daily; Telnyx balance < threshold → P2 with top-up link.
6. Lead without Monday item → create it (monday.js), log.
7. Wrong-number reply (guest wrote to 4499 / client to 6673) → resend from the right number (per number-separation rule).
8. Wave not out by 12:00 on a send day (watchdog) → diagnose (cap? window? template?) and run a pacer slice.
9. 131048/spam-rate rising on a number → shift traffic to the other guest number, lower PACE_SENDS for the day.
10. Engine stale (heartbeat) / Retell billing guard tripped → P1 alert + switch calls off for the day with reason.

(e) UI. One shell `ops.html` (replace current 286-line manual-control page; its buttons move into Automations):
left nav Overview / Automations / Runs / Live log / Brain / Messaging / Calls / Balances / Clients; phone = bottom tab
bar. Kit in `assets/ops-kit.css` + `assets/ops-kit.js`: button, segmented, custom select/listbox, switch, table with
sticky header + row drawer, drawer, sheet, toast, confirm-by-typing dialog, skeleton, sparkline, status pill,
command palette (⌘K), shortcuts (g o / g a / g r, j/k rows, / search, Esc). RTL-first (logical CSS properties),
light/dark tokens, tabular numerals. Salvage:
- automations.html (425) + automations.js: graph/timeline and live-state logic → Automations tab almost as-is.
- live.html (246): audit stream rendering → Live log (swap source to /api/ops/live).
- brain.html (354): it is Noa/Shir prompt admin, not a self-healing brain → keep as "Agents prompts" sub-page, link.
- calls.html (277): calls board → Calls tab table + drawer.
- calendar.html (238, sendboard via send-board.js): per-day send board → Messaging "scheduled" view.
- admin.html (3683): clients/events tables are the reference look ("like the clients page"); lift row/drawer CSS, not code.
- ops.html current buttons (pause, pacer, daily-run, brain-toggle, block-phone, event-flag, ipn-replay) → Automations
  row actions behind the typed-confirm dialog.
- adminbar.js / ux.js / config.js: auth + endpoint helper — reuse.

## 4. PLAN

Phase 0 (today, ~6 agent-hours) — value without new storage
- Files: ops.html (new shell), assets/ops-kit.{css,js}, worker/ops.js (new: realtime, balances, registry, toggle),
  index.js (route + `isOff` checks in the 6 risky entries), automations-registry.js (+kill/side_effects/severity).
- Endpoints: /api/ops/registry, /api/ops/realtime, /api/ops/balances (telnyx, cloudflare usage, retell+anthropic
  manual with dashboard links, meta ads balance), /api/ops/toggle for 6 switches.
- Kill-switches first (KV `off:<id>`, typed confirm, blast radius shown):
  1. d_pacer (all slices of sends+dials), 2. wave sends inside d_engine (wave1/2/3), 3. event_day_blast,
  4. autoretry (mass re-send by deleting markers), 5. shir_dispatch + callbacks (paid calls), 6. manual blasts
  (gift-blast / subevent-send / sms-blast / wave-retry).
- Acceptance tests (pass condition each, machine-checkable):
  T0.1 `curl` of /ops.html + first paint: Lighthouse mobile (Slow 4G) LCP < 1.5 s and skeletons visible before data.
  T0.2 /api/ops/realtime `wa.<phoneId>.sent_today` equals the per-number sum of today's rows from /api/stream (script
       worker/test/ops-realtime.test.mjs compares both, exit 0).
  T0.3 calls today in realtime equals the count from /api/shir-calls for ilDate().
  T0.4 /api/ops/balances returns telnyx.amount equal to a direct GET /v2/balance (±0.01) and every vendor has
       `as_of` and `source`.
  T0.5 For each of the 6 switches: set off via toggle → `wrangler dev` cron trigger of that path returns
       `{skipped:'off:<id>'}` and zero calls to graph.facebook.com/Retell (fetch mock counter = 0); toggle without
       `confirm` returns blast radius and does NOT change state.
  T0.6 `node worker/scripts/check-registry.mjs` exits 0 after registry edits.
  Does NOT prove: real Meta/Retell behaviour under load; balances for vendors with no API are manual.
- Risks: the off-check added in the wrong spot (after a marker write) → test T0.5 per path; RTL custom controls a11y.

Phase 1 (48 h, ~10 agent-hours) — ledger
- D1 database `ishur-ops` (wrangler d1 create; binding OPS_DB; migrations/0001_ops.sql). worker/run.js `withRun`.
  Replace every `audit.job(...)` call in scheduled() (≈25) + wrap morning engine + webhooks W1–W5 + manual M1.
  Pacer sub-steps become child runs.
- UI: Runs tab (filters, cursor paging, run drawer with children/logs/linked audit), per-automation counters
  (runs 24h/7d, last run, failure rate, most-run), Live log (3 s poll, pauses when tab hidden).
- Pass: after one hour in prod, `SELECT count(*) FROM runs WHERE automation_id='d_pacer' AND started_at>now-1h` = 6
  (±1) and every audit `kind:'cron'` job row has a matching ledger row (script diff = 0); /api/ops/runs p95 < 300 ms;
  Live log shows a new run within 5 s of it ending.
- Risks: D1 write failure must not block sends (fallback tested by binding a broken DB in a test); row growth →
  90-day retention cron.

Phase 2 (week, ~16 agent-hours) — brain, cost, edit
- worker/brain.js: checks + playbooks 1–10, findings table, Brain tab (live step log). Cloud agent: one claude.ai
  scheduled routine "ishur-brain" (daily review + on-demand trigger) that reads /api/ops/findings and writes back;
  move template/gift/wedding-day watchers to Worker (§2).
- Cost: price table in registry; Anthropic usage captured where Worker calls Claude (runDailyImprove etc.), Retell
  cost from syncCallCosts per call → run, Meta per-message category price × sent; daily reconcile vs Admin API.
- Edit-in-place: IL time, budget, template name, message text for nodes with `edit{}`; stored in automation_state
  overrides, versioned, rollback button.
- Pass: inject each failure class in a test fixture → matching playbook run row with status ok and step logs;
  routine run cost appears in ledger within 2 min; edited schedule is honoured on next tick (cron test); sum of
  per-run Anthropic cost for a day within 10 % of Admin API cost report.
- Risks: agent acting on clients — enforce approval gate in code, not prompt; routine auth (scoped ops key, not
  ADMIN_KEY); LLM cost loops (max runs/day per playbook).

Phase 3 (~10 agent-hours) — polish: phone layout/bottom tabs, ⌘K palette + shortcuts, dark mode audit, DO WebSocket
only if poll lag > 5 s is felt, motion. Pass: axe-core 0 serious issues; all actions reachable by keyboard
(scripted Playwright run); 375 px width no horizontal scroll.

Skills and what each contributes:
- apple-design — motion/material/typography rules for the shell, drawers and sheets.
- clean-design — skeletons, destructive-action (typed confirm) pattern, number formatting, dark mode values.
- impeccable — critique/polish pass on each tab before shipping; hierarchy and density.
- design-systems — token set + component kit structure for ops-kit.css/js.
- dataviz — stat tiles, sparklines, per-number cap meters, run-history charts that read in both themes.
- cloudflare — D1/KV/R2 choices, GraphQL analytics for usage, Cron Triggers.
- durable-objects — only if Phase 3 moves live log to hibernatable WebSockets.
- workers-best-practices — waitUntil batching, subrequest/KV-op budgets, no blocking on ledger writes.
- wrangler — d1 create/migrations, `wrangler dev --test-scheduled` for T0.5, secrets for admin keys.
- schedule — create the claude.ai cloud routine(s) for the brain and the daily review.
- agents-sdk — if the healer runs as a Cloudflare Agent instead of a claude.ai routine (stateful, scheduled, streams).
- verify-loop — mandatory per Richard's rule for every phase gate.
