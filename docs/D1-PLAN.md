# ishur.io: from the Google Sheet to Cloudflare D1 (plan, 26/11/2026)

Richard's ask (26/11): move off the Google Sheet onto a real database, and keep it cheap. The $100 bill was 215.7M KV reads in 30 days (kvmeter.js).
D1 on the Workers Paid plan we already pay for includes **25B rows read, 50M rows written and 5 GB a month**.
Above that it costs $0.001 per 1M rows read, $1.00 per 1M rows written and $0.75 per GB-month (Cloudflare D1 pricing page, read 26/11).

Two billing rules matter for this plan:
- Rows read means rows **scanned**, so every hot query needs an index.
- A write that touches an indexed column counts one extra row written per index.

## Phases

| # | What | Production reads from | Off switch |
|---|---|---|---|
| 1 | **Mirror.** Each snapshot refresh upserts only the changed sheet rows into D1. A nightly full pass reconciles row counts (before and after healing) and posts them to Slack. | the sheet (unchanged) | KV `cfg:d1_mirror` off, or remove the `DB` binding |
| 2 | **Dual-write + nightly diff.** Every writer that touches the sheet or a KV marker also writes D1 (sends, calls, messages, answers, team items). A nightly job diffs D1 against sheet+KV field by field and posts the diffs. | the sheet + KV (unchanged) | `cfg:d1_dual` off |
| 3 | **Readers switch, one area at a time,** each behind its own flag: `d1_read_board` (client board), `d1_read_send` (pacer/waves), `d1_read_dial` (Shir dialer), `d1_read_ops` (admin screens), `d1_read_log` (answers log / inbox). The sheet stays the write target, and the diff from phase 2 keeps running. | D1 for the switched areas | each `d1_read_*` flag |
| 4 | **The sheet becomes a nightly export.** D1 is the source of truth. A nightly job writes events/guests/leads back to the sheet for humans, and the sheet's hand edits stop flowing in. | D1 | `cfg:d1_primary` off, plus a reverse import (below) |

## Schema (worker/d1/schema.sql, migrations in worker/d1/migrations/)

- **events / guests / leads**: every sheet column as a typed column.
  - Named columns: token, client, phone, venue, occasion, event_date, paid, cancelled, plan, tier, style, hosts, event_time, send_date_1..3 (events); guest_id, name, phone, invited, sent, party, rsvp, call_status, call_answer, notes, last_change, token, tries, table_no (guests).
  - Any other column keeps its sheet letter, e.g. `c_g`. Name these once Richard confirms the headers.
  - Every row also stores `raw` (the row as read, JSON), `hash`, `sheet_row`, `first_seen`, `updated_at` and `deleted_at` (soft delete).
- **Keys**:
  - events: the token.
  - guests: the guest id. A guest with no id falls back to `np:<token>:<phone>`, then `row:<i>`.
  - leads: the phone digits.
  - A repeated key gets `#2`, `#3` so the row counts still match.
- **sends** (token, wave, phone): status sent/failed/error/dead, code, tries, wa_id, template, day.
- **calls**: call_id, token, guest_id, phone, agent, outcome, rsvp, party, recording_key (the bytes stay in R2), summary, transcript, day.
- **messages**: the WhatsApp log (in/out/status per wamid), phone, token, line, body, day.
- **answers_history**: every answer ever given, with method (call/wa/link/manual), source_id and who.
- **team_items**: team notes and issues.
- **mirror_runs**: the mirror's own run log.
- **Indexes**:
  - guests(token, rsvp): board counts, and it also serves "by token".
  - guests(phone), events(phone), leads(phone).
  - guests(updated_at).
  - sends(day), sends(phone).
  - calls(day), calls(token), calls(guest_id, day), calls(phone).
  - messages(phone, at), messages(day), messages(token).
  - answers_history(token, guest_id, at), answers_history(day).

### Which KV families move where (phase 2 writes them, phase 3 stops reading KV)

| KV today | D1 |
|---|---|
| `wsent:<tok>:<wave>:<phone>`, `wfail:`, `wferr:`, `wdead:` | `sends` (one row per guest per wave; status + code) |
| `shirtry:<guest>:<day>` | `calls` (count by guest_id, day) |
| `rsvpfinal:<guest>` | `answers_history` (latest final answer), plus `guests.rsvp` |
| `log:<phone>:<ts>` | `messages` |
| `conv:<phone>` | a query on `messages` (phone, at). The conversation state stays in KV until phase 3 proves the query is enough. |
| `stream:*` call records (audit.js) | `calls`. The audit stream itself stays in KV + the R2 anchor, because the legal export is built on it. |
| `teamnote:*`, `teamissue:*` | `team_items` |
| `snapcache` / `snaplast` / `snappatch` | gone in phase 3: D1 is the cache |

Phase 1 does **not** backfill any KV family. Listing and reading KV to backfill is exactly the bill this move removes. Backfill in phase 2 happens per event as it is next written, plus one bounded `list()` pass per family, run only with Richard's OK.

## Cost estimate (real volumes: ≈5,500 guests, ≈40 events, 2–4k sends/day, ~1k calls/day)

| Phase | Rows written / month | Rows read / month | Storage | Extra $ |
|---|---|---|---|---|
| 1 mirror | ≈6k changed guest rows/day × ~4 (row + 3 index entries) ≈ **0.7M** (1.4% of 50M) | Unchanged tab: 0. Cold isolate: ≈5.6k hash rows per refresh; worst case 288 refreshes/day ≈ **50M** (0.2% of 25B). Nightly reconcile ≈ 17k. | ≈15 MB (typed + raw) | **$0** |
| 2 dual-write | + sends 4k×3, calls 1k×5, messages ≈17k×2, answers 1.5k×3 ≈ 55k/day ≈ **2.5M total** (5%) | Nightly diff: one full scan of each table ≈ 0.5M | +≈80 MB/month (messages dominate) | **$0** |
| 3 readers on D1 | same as 2 | Board open ≈ 150 indexed rows; ~20k board/API reads/day plus pacer/dialer day queries ≈ **100–200M** (<1%) | same | **$0**; KV reads drop with each area switched |
| 4 sheet export | + nightly export reads ≈ 6k rows | ≈0.2M | ≈1 GB after a year | **$0** until ~5 GB (years) |

The KV side is what saves money. kvmeter's `kvmeter:<day>` top prefixes pick the phase-3 order, heaviest prefix first. If the wsent/log/snap families are most of the 215M, the bill returns to roughly the $5 base plan.

## Rollback per phase

- **1:** set `cfg:d1_mirror` off (takes effect within 60 s per isolate), or drop the binding. Production never read D1, so nothing else changes.
- **2:** set `cfg:d1_dual` off. The sheet and KV were still written as before, so nothing is lost. The D1 rows can be truncated and rebuilt by the mirror.
- **3:** turn each `d1_read_*` flag off and that area reads the sheet/KV again. These were kept current by the dual-write, so the switch back is instant.
- **4:** set `cfg:d1_primary` off and run the one-time "D1 → sheet" export (the same job as the nightly). The sheet becomes the source again and the phase-3 flags go back on. This is the only phase where a rollback needs a job run, so it waits until phase 3 has been clean for 2 weeks.

## What Richard approves at each gate

1. **Gate 1, mirror to production.** Staging has no crons, so the nightly job cannot run there. The gate is instead ≥3 hand-run `reconcile` calls on staging, on different days, each with `clean: true`. Clean means the counts matched **before** the full pass and the full pass wrote and deleted 0 rows. Then approve:
   - creating `ishur-main`
   - adding the binding to production
   - turning `cfg:d1_mirror` on

   Commands (NOT run against production):
   ```
   cd worker
   npx wrangler d1 create ishur-main
   # add to the top-level wrangler.toml:
   # [[d1_databases]]
   # binding = "DB"
   # database_name = "ishur-main"
   # database_id = "<id printed above>"
   # migrations_dir = "d1/migrations"
   npx wrangler d1 migrations apply ishur-main --remote
   # deploy, then (admin): KV cfg:d1_mirror = {"value":"on"}
   ```
2. **Gate 2, dual-write.** A week of production mirror counts matching. Approve the writers list and the one-time KV backfill passes.
3. **Gate 3, per area.** A week of zero nightly diffs for that area. Approve each `d1_read_*` flag separately, starting with the board, the lowest risk.
4. **Gate 4, sheet becomes export.** All areas on D1 for 2 weeks. Approve the end of hand edits in the sheet; the team edits through the admin screens instead.

## Staging runbook (after the lead deploys staging)

1. Turn the flag on in the staging KV:
   ```
   node -e "import('./worker/scripts/staging-seed.mjs').then(m=>m.kv({'cfg:d1_mirror':{value:'on'}})).then(r=>console.log(r.status))"
   ```
   `cfg:d1_mirror` is not in the cfg.js whitelist on purpose: the ops screen cannot flip it.
2. Do the first backfill with `POST https://go-staging.ishur.io/api/d1-mirror {"admin_key":…, "action":"reconcile"}`. Use `reconcile`, not `sync`: `sync` caps at 3,000 statements, and the refresh hook waits only 2 s.
3. Check with `{"action":"status"}`. It shows the counts and the last 10 runs.
4. On later days, run `{"action":"reconcile"}` and expect `clean: true` and `drift: 0`.

## Phase 1 as built (track-d1, 26/11)

- **`worker/d1mirror.js`**:
  - `mirrorAfterRefresh` is called from `snapshot.js refresh()` on the sheet **as read**, before the KV overlay patches are applied. It never throws and waits at most 2 s.
  - Without `env.DB` it returns before touching KV.
  - Hashes are kept per isolate. An unchanged tab costs nothing, and only changed rows are written, capped at 3,000 statements per pass in batches of 100.
  - Deletes are soft, and guarded: a missing, empty or collapsed tab deletes nothing.
- **Nightly reconcile:** on the existing `0 19 * * *` cron, only where `env.DB` exists. It does a full pass, compares counts and posts to Slack.
- **Route:** `POST /api/d1-mirror` (admin) `{action: status|sync|reconcile}`, for staging, which has no crons.
- **Staging database:** `ishur-staging` (409578a4-2963-4493-ab5b-0fe981b37021) is created and migrated, bound as `DB` in `[env.staging]` only.
- **Known limits:**
  - `sheet_row` is informational. A row that only moved is not rewritten, so its `sheet_row` may lag.
  - The `sync`/`reconcile` route mirrors the snapshot the reader holds, which includes the overlay patches of the last 15 minutes.
  - Unnamed columns keep their letters until the headers are confirmed.
  - The hash memo is per isolate. Suppose isolate A writes a change and the row is reverted in the sheet before isolate A refreshes again. Isolate B, whose memo still says "unchanged", does not rewrite it. That row stays stale in D1 until the nightly full pass, and the same holds for a delete followed by a revive. The nightly `drift` number shows exactly these cases.
  - Isolates also re-write each other's rows, because each one learns D1's state only from its own passes or a cold load. The write estimate above is therefore a lower bound; ×2–3 still leaves it under 5% of the included writes.
  - Side finding, not changed here: `noteHookWrite` in snapshot.js patches party into column 16, while sheetsdirect.js `CALL_COLS` and the boards use column 13.
