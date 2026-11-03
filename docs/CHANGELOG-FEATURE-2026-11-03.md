# Ops center: change log + registry auto-sync (03/11/2026)

Branch `ops-changelog` (from `integ-2026-11-02`). Not deployed.

Richard's ask: "every new automation must appear in the ops center; every change must be written there; a full change log like Git, so I know what changed and can roll back."

## 1. Change log (`שינויים`, nav + `g h`)

Every change that alters how the business behaves becomes one row in `worker/changes.js`.

| kind | Written by | Revert |
|---|---|---|
| `deploy` | the doctor, once per new `CF_VERSION_METADATA.id` (`recordDeploy`) | `rollback` to the previous version |
| `registry` | the same deploy tick: a diff of `AUTOMATIONS` against the snapshot in KV `registry:snapshot` (added / removed / changed nodes + which fields changed). The first deploy writes a baseline row. Line-number moves don't count as changes. | none |
| `edit` / `hold` | `/api/ops/edit` (cfg.js settings / `event_hold`) with who, from → to, and the reason | `edit` back to the previous value |
| `toggle` | `/api/ops/toggle` (kill switches) and `/api/brain-toggle` (Noa AI) | `toggle` flips the kill switch back. Noa AI has no revert, on purpose: it stays off by decision. |
| `pause` | `/api/pause` (the global stop) | flip back |
| `template` | the brain's hourly `template_watch`, on every Meta status change (PENDING → APPROVED/REJECTED…), and `/api/custom-template` submissions | none |
| `brain` | `execPlaybook` when it runs for real (auto or approved) and `decide` on a reject | none |
| `subevent` / `blast` | `/api/subevent` create, and the non-dry runs of `/api/gift-blast`, `/api/subevent-send`, `/api/sms-blast`, `/api/resend`, `/api/wave-retry`, `/api/event-day` set/clear, `/api/call-round` set/run/clear | none |
| `revert` | a deploy rollback done from the log | rolls forward again |

Manual routes are logged by a wrapper (`CHANGE_ROUTES` + `changeWrap` in index.js). The wrapper reads a clone of the request and the response, and only records when the handler answered OK and the call wasn't a dry run. The handlers themselves are unchanged.

**Storage.** D1 `OPS_DB` table `changes` (`worker/migrations/0004_changes.sql`). When D1 isn't there, rows go to a KV ring `chg:<inverted ms>:<id>` (TTL 400 days), the same pattern as the runs ledger. `recordChange` never throws into its caller.

**Entry shape.** `GET /api/ops/changes?from&to&kind&actor&cursor&limit` returns `{ok, source, kinds, actors, items, next_cursor}`. Each item looks like this:

```
{ id, at, kind, actor: Richard|Claude|brain|system, summary_he, details,
  revert: { possible, how: toggle|edit|rollback|none, payload, confirm },
  reverted_at, reverted_by }
```

- `kind` takes a comma list.
- `cursor` is the `at` of the last row seen.
- `actor` comes from `who`: `admin`/`richard` map to Richard, `claude*` to Claude, `brain` to brain, and `client`/`cron` to system.

### Deploy info

`worker/scripts/build-info.mjs` writes `worker/build-info.json`:

```
{ version_tag, commit, branch, date, by, since, dirty, commits: [{hash, subject}] }
```

- **When it runs:** wrangler's `[build] command` runs it, so every `npx wrangler deploy` gets it. So do `npm run predeploy` and `deploy.sh`.
- **Which commits it lists:** the commits since `$DEPLOY_SINCE`, else since git ref `refs/ishur/deployed`, else the last 20.
- **Where the ref comes from:** `deploy.sh` moves `refs/ishur/deployed` after a good deploy, then restores the committed stub `build-info.json`.
- **Worker side:** the Worker also cuts the list at the commit it stored for the previous version (KV `build:info`), so the list is never wrong, only sometimes longer.
- **What one entry carries:** `deploy:<version8>` plus the commit, branch, commit subjects, previous version id and the exact rollback command.

## 2. Rollback: `POST /api/ops/revert {id, confirm, who}`

Without `confirm`, the call returns a preview (`preview`, `confirm_required`) and changes nothing. The confirm word is:

- `revert:<change id>` for edits, toggles and pause;
- `rollback:<previous version id>` for a deploy;
- `noa_chase:on:richard` when the revert would turn Noa-chase back on. The cfg.js rule still applies, so the generic word is refused.

What each kind does:

- **edit:** calls `editSetting` with the previous value (`validateEdit` runs again). This writes a new `edit` row with `details.reverts`.
- **toggle:** calls `toggle` with the opposite state.
- **pause:** sets or deletes `paused`. On resume it also re-arms `pacer:pending`, like `/api/pause`.
- **deploy:** the Worker can't run `wrangler rollback`.
  - If the secrets `CF_API_TOKEN` and `CF_ACCOUNT_ID` are set, it calls `POST https://api.cloudflare.com/client/v4/accounts/{id}/workers/scripts/ishur-webhooks/deployments` with `{strategy:"percentage", versions:[{version_id:<previous>, percentage:100}]}`. Then it writes a `revert` row (which can itself be rolled forward), an audit row and a Slack line.
  - Without the token it returns `applied:false, manual:true` and the exact command: `cd worker && npx wrangler rollback <previous> --name ishur-webhooks`.
- **After any revert:** the original row gets `reverted_at` and `reverted_by`. Reverting the same row twice returns 409.

**What revert cannot do.**
- It can't undo sends (gift links, sub-event blasts, SMS, resends). A message that went out stays out, so these rows are records only.
- It can't undo brain playbooks, template status changes or registry diffs.
- A deploy rollback brings back code only. It doesn't restore KV or D1 state, and it doesn't reverse migrations.
- Rolling back to a version older than this feature means the change log stops recording deploys until you roll forward.
- The CF token needs *Workers Scripts: Edit*. This hasn't been tested against the live API, because this branch wasn't deployed. The request shape follows the Cloudflare "Create Deployment" API.

## 3. Registry auto-sync

`worker/scripts/registry-sync.mjs` scans the code. `worker/test/registry-sync.test.mjs` fails on any gap. It checks:

- the ledger ids in `withRun(env,'…')` / `manualRun` / `opsJob` (through `JOB_TO_ID`) / `step('…')`, plus the brain's `withRun` ids (`brain_fix:<pb>` maps to node `brain_fix`);
- that every brain `CHECKS` id is listed in `brain_health.checks` and every `PLAYBOOKS` id in `brain_fix.playbooks`;
- every POST route in index.js whose block, or the handler it calls one level deep, sends a WhatsApp, SMS or call, or runs the engine. The `/api/crm/*` router (crm.js `d.send…`) is checked too. A route counts as covered when a node lists the path in `routes[]` or `trigger.via`, or when it's in `EXEMPT` with a reason (auth codes, test harnesses, inbound webhooks).

A mutation test proves the check fails when a node, route, playbook or `JOB_TO_ID` entry is removed. Run `node worker/scripts/registry-sync.mjs` to print the gaps.

**Missing on 03/11, now added** (each with `added: '2026-11-03'`):

| node | covers |
|---|---|
| `brain_health` | the brain's 10-minute check loop (17 checks) + `/api/ops/brain-run` |
| `brain_fix` | the 10 playbooks + `/api/ops/brain-decision` |
| `brain_agent` | escalation to the external agent |
| `crm_lead_send` | `/api/crm/leads` quick send to a lead from 4499 (sales flow) |
| `outreach` | `/api/outreach` |
| `guest_text` | `/api/guest-text` |
| `client_link` | `/api/client-link` |
| `invoice_manual` | `/api/evlog {action:"invoice-make"}` (sends the invoice to the client) |
| `voice_test_call` | `/api/voice-tools` |
| `wa_send` | `/api/wa-send` |

`routes[]` was added to existing nodes: `d_pacer` (`/api/pacer`), `d_engine` (`/api/daily-run`), `shir_dispatch`, `call_rounds`, `event_day_blast` (`/api/event-day`), `manual_blasts` (gift-blast / subevent-send / sms-blast / resend) and `wave_retry`.

These were already covered and needed no new node: gift-blast and subevent-send (through `manual_blasts`), `calendar_build`, the lead watchers (`lead_pings`, `meta_form_leads`) and every `opsJob`. `registry-code.json` was regenerated (71 nodes).

**"חדש" badge.** `/api/ops/registry` now returns `added_at` (the node's `added` field, else the first deploy that saw it in `registry:snapshot.first_seen`) and `is_new` (added in the last 7 days). The automations list shows a `חדש` badge.

## 4. UI

`assets/ops/lazy/changes.js` is lazy, so it sits outside the 120 KB counted JS budget, like calendar. The screen has:

- a timeline grouped by Israel day, with kind chips (multi-select, remembered in localStorage `ops:chg`), actor tabs, a from/to date range and text search;
- deploy rows that show their first 3 commit subjects;
- an entry drawer with kind-specific details: commits and the rollback command for a deploy, added/removed/changed lists for a registry diff, from → to for edits, JSON otherwise;
- a `שחזר` button on revertible rows. It asks the server for a preview, then opens `confirmTyped` with the server's confirm word, then POSTs the revert. A manual rollback shows the command in the drawer.

Mock mode (`?mock=1`) uses `fixtures/ops/changes.json`. It is hand-written in the real shape, with masked ids, because no live change rows exist yet.

## Activation (when deploying)

1. `bash worker/scripts/ops-d1-setup.sh` (or `npx wrangler d1 migrations apply ishur-ops --remote`) applies `0004_changes.sql`. Until D1 is bound, the KV ring is used.
2. Optional, for one-click deploy rollback: `npx wrangler secret put CF_API_TOKEN` (Workers Scripts: Edit) and `npx wrangler secret put CF_ACCOUNT_ID`.
3. Deploy with `./worker/deploy.sh "note"`. The first deploy writes the registry baseline and a deploy row with no rollback target. Every deploy after that can be rolled back.

## Verification (03/11)

- `cd worker && node --test test/*.test.mjs`: 383 pass, 0 fail (370 before; +9 `changes.test.mjs`, +4 `registry-sync.test.mjs`).
- `node scripts/ops-ui-smoke.mjs`: 148 passed, 0 failed (119 before), including the browser flow: `g h`, kind filter, deploy drawer with commits, typed-confirm revert, no console errors, and no horizontal scroll at 375 px.

What these checks don't prove:
- the Cloudflare rollback API call against the real account (it's stubbed in tests);
- D1 on the real database (the D1 path is tested with a fake binding);
- that wrangler's `[build]` command runs in Richard's deploy environment (it ran locally as `node scripts/build-info.mjs`).

Known and pre-existing: `node worker/scripts/check-registry.mjs` already reported 186 stale line anchors on `integ-2026-11-02` before this branch. The 11 anchors added here all pass. The old ones need `repin-registry.mjs` against the right base.
