# dev-staging · plan (12/11/26)

Spec: `.sdlc/dev-staging/spec.md` (approved). Work happens on branch `staging` (cut from `main`), in the
session worktree. Every step is its own commit; the proof column names the spec pass condition it satisfies.

## Files / resources that change

| Path / resource | Change |
|---|---|
| `worker/staging-guard.js` | NEW. `installStagingGuard(env)` wraps `globalThis.fetch` once per isolate when `env.STAGING === "1"`; `isAllowed(env, phone)`; `blockedResponse(why)`; `wrapEmail(env)`. Pure, testable. |
| `worker/test/staging-guard.test.mjs` | NEW. The P1 cases. |
| `worker/index.js` | `fetch`/`scheduled` wrappers call `installStagingGuard(env)` first (2 lines); new route `GET /api/health` → `{ok:true, staging, version, build}`; `env.EMAIL` wrapped in staging. |
| `worker/whatsapp.js` | `sendWA`: in staging, recipient not in allowlist → return `{ok:false, error:'staging-blocked'}` before any fetch (R3). |
| `worker/evlog.js`, `worker/sheetlogs.js` | `SHEET_ID` → `sheetId(env)` = `env.SHEET_ID || PROD_SHEET_ID` (21 call sites, mechanical). |
| `worker/wrangler.toml` | `[env.staging]` block (name, route `go-staging.ishur.io`, KV `RATE` new id, R2 `ishur-audit-staging`, AI, version_metadata, send_email, limits, all vars + `STAGING`, `STAGING_ALLOWLIST`, `SHEET_ID`, `crons = []`). Production block untouched. |
| `worker/.gitignore` → root `.gitignore` | `worker/.staging.secrets` |
| `worker/scripts/staging-secrets.sh` | NEW. Reads `worker/.staging.secrets`, `wrangler secret put <K> --env staging` per line, never prints values. |
| `config.js`, `demo/config.js` | `PROXY_BASE` chosen by `location.hostname` (R5). |
| `scripts/deploy-staging.sh` | NEW. Builds a `dist-site/` (rsync of repo root minus `_config.yml` excludes + `.git`), `wrangler pages deploy dist-site --project-name ishur-staging --branch staging`, then `wrangler deploy --env staging` from `worker/`. Refuses if not on branch `staging`. |
| `scripts/smoke.sh` | NEW. `smoke.sh <worker-base> <site-base> [expect-staging 0/1]` (R8). |
| `scripts/promote.sh` | NEW. The one production command (R7). `PROMOTE_DRY=1` prints instead of pushing/deploying. |
| `.sdlc/dev-staging/README-staging.md` | NEW. Runbook (R9). |
| Cloudflare (one-time, by me, with the wrangler token) | KV namespace `RATE-staging`; R2 bucket `ishur-audit-staging`; Pages project `ishur-staging`; custom domain `staging.ishur.io` on it (API) ; Worker route `go-staging.ishur.io` is created by `wrangler deploy --env staging` (custom_domain). |
| Google Drive (one-time) | copy of sheet `1VAHaP32…` named `ishur.io · STAGING log` → id into `[env.staging.vars] SHEET_ID`. |
| Richard (one-time) | fills `worker/.staging.secrets` (ADMIN_KEY, APP_KEY, RETELL_KEY, BRAIN_HOOK, optional WA_TOKEN/WA_PHONE_ID*, SLACK_ALERT_HOOK for #ishur-staging) and runs `staging-secrets.sh`. |

## Guard policy (R2), deny-by-default in staging

| Host | Rule |
|---|---|
| `graph.facebook.com` `…/messages` POST | body `to` must be in allowlist, else block. Other Graph GETs (template reads, media) allowed. |
| `api.retellai.com` `create-phone-call` POST | `to_number` (digits) must be in allowlist, else block. Other Retell GETs allowed. |
| `hooks.slack.com`, `hook.*.make.com` (BRAIN_HOOK/HOOK_*), `api.anthropic.com`, `us.i.posthog.com` | allowed (staging secrets decide where they land). |
| `api.telnyx.com`, `api.monday.com`, `api.linear.app`, `api.cloudflare.com`, `*.googleapis.com` | GET allowed, POST/PUT/PATCH/DELETE blocked (no CRM / billing writes from staging). |
| `api.greeninvoice.co.il`, `api.morning.co`, `secure.meshulam.co.il` | blocked entirely (invoices, payments). |
| anything else | blocked. |
| `env.EMAIL.send` | blocked (returns `{ok:false, error:'staging-blocked'}`). |

Blocked = no network call; synthetic `Response` 403 `{"ok":false,"error":"staging-blocked","host":…,"to":…}` and one
`stagingblock:<ts>` KV row (TTL 7d) so the ops journal can show it.

## Deviation (build, 12/11): staging site = Workers static assets, not a Pages project

`wrangler pages project create` on wrangler 4.160 no longer creates a Pages project (Pages is folded into
Workers). The staging site is therefore `site-staging/wrangler.toml`: a Workers project `ishur-site-staging`
with `[assets] directory = "../dist-site"` and custom domain `staging.ishur.io` (wrangler creates the DNS
record itself, so the Cloudflare API step for the Pages domain is gone). `deploy-staging.sh` builds `dist-site/`
and runs `wrangler deploy` there. R5/R6/P5 are unchanged; `*.pages.dev` in the hostname switch stays harmless
and `*.workers.dev` is added. `robots.txt` on staging disallows everything.

## Order of work

1. Branch `staging` from `main`. Commit plan. — proof: `git branch --show-current` = staging.
2. `staging-guard.js` + tests (test first). — proof: P1 (node --test, all 788 + new pass).
3. Wire guard into `index.js` + `whatsapp.js` + `/api/health`; `sheetId(env)` refactor. — proof: P1 again, `grep -c "SHEET_ID\b" evlog.js sheetlogs.js` only in the const definition.
4. `wrangler.toml [env.staging]` + create KV/R2 + `.staging.secrets` script. — proof: P2, P3 (both dry-runs).
5. `config.js` hostname switch (+ demo). — proof: `node -e` loads config.js under a fake `window.location.hostname` for 3 hosts and asserts the base (added as `scripts/check-config.mjs`, also used by smoke).
6. `deploy-staging.sh`, Pages project + domain, first staging deploy. — proof: P4, P5 (curl against the live staging hosts).
7. `smoke.sh`, blocked-send check on staging. — proof: P6 (needs ADMIN_KEY staging secret from Richard; if absent, P6 runs with the unit test + a direct `/api/health` only and is reported as NOT covered).
8. `promote.sh` + README. — proof: P7 (dry run), P8 (diff of wrangler.toml production block = empty).
9. Verify-loop over P1–P8, write `report.md`. — gate: Richard accepts.

## Risks

| Risk | Mitigation / rollback |
|---|---|
| `[env.staging]` accidentally reuses a production id | P2 grep + the plan lists every id; staging block is written from scratch, not copied. |
| Wrapping `globalThis.fetch` affects production | Install is gated on `STAGING === "1"` literal; P1 asserts identity unchanged when unset; prod dry-run + the full suite run on the same code. |
| Worker self-calls to `go.ishur.io` from staging | grep found no `fetch()` to go.ishur.io (only links in messages). Links in staging messages still say go.ishur.io — acceptable (allowlist numbers only), noted in README. |
| Staging Meta sends still come from the production numbers | Spend the same daily budget; allowlist limits to 2 numbers. Richard may leave WA_TOKEN unset on staging to disable entirely. |
| Pages custom domain needs a DNS record | `staging` CNAME → `ishur-staging.pages.dev` created via API on the ishur.io zone; rollback = delete record + project. |
| Promote pushes a broken main | promote runs tests + smoke first and fast-forwards only; rollback = `git push origin <prev-sha>:main` + `worker/deploy.sh` from main (documented in README). |
| Sheet copy contains real guest data | It is a private copy in the same Drive; staging writes test rows only. Noted as policy; Richard can clear tabs. |

## Proof strategy

P1 after steps 2, 3, 8 · P2/P3 after step 4 · P5 (local check) after step 5 · P4/P5 (live) after step 6 ·
P6 after step 7 · P7/P8 after step 8 · all of them again in step 9 before the report.
