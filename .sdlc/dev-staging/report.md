# dev-staging · verify report (12/11/26)

Branch `staging` (origin), 13 commits over `main` at the time of the dry-run. Staging is live:
site https://staging.ishur.io (Worker `ishur-site-staging`), worker https://go-staging.ishur.io
(`ishur-webhooks-staging`, KV `ef2534ea…`, R2 `ishur-audit-staging`, sheet copy `1QAfl1gn…`, crons off).
Runbook: `.sdlc/dev-staging/README-staging.md`.

## Pass conditions — what ran, what it said

| # | Check | Ran | Result | Attempts |
|---|---|---|---|---|
| P1 | `cd worker && node --test 'test/*.test.mjs'` | yes | `tests 814 · pass 814 · fail 0` (12 new in `staging-guard.test.mjs`) | 2 — first run after adding `/api/staging-probe` failed `registry-sync` ("sending POST routes without a node"); fixed by an exemption with reason in `scripts/registry-sync.mjs`, not by touching the test |
| P2 | `grep -c 05a171c6… worker/wrangler.toml` / staging id | yes | prod id `1` (production block only); `ef2534ea…` `1`; `STAGING = "1"` appears once, under `[env.staging]` | 1 |
| P3 | `wrangler deploy --env staging --dry-run`, `wrangler deploy --dry-run` | yes | both `--dry-run: exiting now.` with the full binding table | 1 |
| P4 | `curl go-staging.ishur.io/api/health` / `go.ishur.io/api/health` | yes | staging: `{"ok":true,"staging":true,"worker":"ishur-webhooks-staging","version":"5fbe6ea9","crons":"off"}` · prod: `{"ok":false,"error":"unknown-route"}` (route not on main yet) and no `staging:true` | 1 |
| P5 | `curl staging.ishur.io/config.js \| grep -c go-staging` / `ishur.io/config.js` | yes | staging `1`; prod `0`; `scripts/check-config.mjs` on the served file: 5/5 hosts resolve right (`ishur.io`, `www`, `staging.ishur.io`, `*.pages.dev`, `localhost`) | 1 |
| P6 | `POST go-staging.ishur.io/api/staging-probe {phone: 0501234567}` | yes | `{"ok":true,"staging":true,"allowlisted":false,"result":{"ok":false,"error":"staging-blocked"}}`; allowlisted number → `wa-not-configured` (no WA token on staging, expected); staging KV has the `evlog:` block rows; prod answers 404 on the route | 1 |
| P7 | `PROMOTE_DRY=1 scripts/promote.sh` | yes | first run exit 1 at step 1/9 ("origin/main has commits that are not on staging") — the gate stops before any push; after merging main: exit 0, `PROMOTE DRY-RUN OK — nothing touched production`, steps 5–9 printed as `[dry]` | 2 |
| P8 | `git diff origin/main staging -- worker/wrangler.toml` | yes | 0 removed lines, 56 added, all inside `[env.staging]` | 1 |

Smoke, full output (`scripts/smoke.sh staging`): 10/10 ok → `SMOKE PASS`. `scripts/smoke.sh prod` fails today on
3 checks (`/api/health` unknown-route, hostname switch absent) because main is not promoted yet — expected,
promote runs it only after deploying.

## What is NOT covered

- **No real WhatsApp / call left staging.** `WA_TOKEN*`, `RETELL_KEY` are not set on staging (Richard's choice at
  `.staging.secrets`). The guard was proven on the live worker (P6) and in 12 unit tests, but an allowlisted
  send with real tokens has not been exercised end-to-end.
- **No Slack / Sheets from staging yet**: `SLACK_ALERT_HOOK`, `BRAIN_HOOK` not set. Journal rows sit in the
  staging KV until a flush job runs with `BRAIN_HOOK`.
- **Promote has only been dry-run.** The real first promote (which ships the guard code — inert in production,
  `/api/health`, `sheetId(env)`, the config.js switch) is Richard's call.
- **P7 failing-test variant** was not run literally; the abort path was proven through the precondition gate
  (exit 1 before step 5). The test step uses the same `|| exit 1` pattern.
- **Links inside staging messages still say go.ishur.io** (message text, not fetches). Only the allowlist can
  receive them.
- **Production incident impact** (see plan.md): what the rogue `ishur-staging` worker's crons wrote to
  production KV between 13:35 and 13:47 UTC, and whether Meta redelivered the inbound webhooks it rejected,
  is unverified. The ops journal for 15:35–15:48 Israel time is the place to look.
- Production now runs `ishur-webhooks` version 97f800d5 deployed from `ishur-deploy` HEAD f8ff2a3 (worker
  files clean) during the fix — not from a promote.
