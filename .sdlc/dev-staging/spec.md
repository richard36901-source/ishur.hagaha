# dev-staging · spec (12/11/26)

Intent: `.sdlc/dev-staging/intent.md`. Findings that shaped this spec:

- Site: GitHub Pages serves branch `main` (CNAME ishur.io). One branch per repo, so the staging
  site cannot be a second GitHub Pages deploy. It becomes a **Cloudflare Pages** project
  (`ishur-staging`) deployed by direct upload from branch `staging`, custom domain `staging.ishur.io`.
- Worker: `ishur-webhooks` (go.ishur.io). All sends leave through `fetch()` to four hosts:
  `graph.facebook.com` (WhatsApp, `whatsapp.js` + 1 template read), `api.retellai.com`
  (calls: 6 sites in `index.js`, `dial.js`, `noa.js`), `hooks.slack.com` (Slack), `api.telnyx.com`
  (balance/numbers only). Make webhooks are secrets (`HOOK_*`, `BRAIN_HOOK`, `ALERT_HOOK`).
  Google Sheet id is hard-coded (`evlog.js:29 SHEET_ID`, used by `evlog.js` + `sheetlogs.js`), all
  Sheets traffic goes through `BRAIN_HOOK` (Make proxy, generic Sheets API).
- `wrangler [env.staging]` inherits nothing (vars, bindings, triggers, routes must all be repeated).
- D1 `OPS_DB` is not created in production either (commented out; KV ring fallback). Staging mirrors that.
- HEAD == origin/main == origin/integ-2026-11-02 — `main` is production for both site and worker.
- Tests: `cd worker && node --test 'test/*.test.mjs'` → 788 pass today.

## Decisions taken from the open questions

| Open question | Decision (Richard confirms at this gate) |
|---|---|
| Staging domain | `staging.ishur.io` (site) + `go-staging.ishur.io` (worker). Both on the ishur.io Cloudflare zone. |
| Allowlist | `STAGING_ALLOWLIST = "972545764327,972526979535"` (Richard + the second ADMIN_PHONES number = Shalev). Richard adds/changes in wrangler.toml only. |
| Test sheet | Copy of the live sheet made once via the Google Drive connector (or by Richard), id goes to `SHEET_ID` var in `[env.staging]`. Code reads `env.SHEET_ID` with the production id as default. |
| Slack | `SLACK_ALERT_HOOK` staging secret = incoming webhook of `#ishur-staging` (Richard creates the webhook; until then unset = silent). |
| Crons | **Off** in staging (`crons = []`). Jobs run on demand through the existing admin endpoints (`/api/daily-run` etc.). |
| Secrets | Never read from production (wrangler cannot). `worker/.staging.secrets` (gitignored, KEY=VALUE) → `scripts/staging-secrets.sh` pushes each with `wrangler secret put --env staging`. Meta tokens optional: absent = WhatsApp returns `wa-not-configured`; present = the guard still restricts to the allowlist. |

## Requirements

R1. `worker/wrangler.toml` has `[env.staging]`: name `ishur-webhooks-staging`, own KV namespace (new, binding `RATE`),
    own R2 bucket `ishur-audit-staging`, AI binding, version_metadata, `send_email` binding, all `[vars]` repeated,
    plus `STAGING = "1"`, `STAGING_ALLOWLIST`, `SHEET_ID`, `crons = []`, route `go-staging.ishur.io` (custom_domain).
    No `[env.staging]` value points at a production resource id.
R2. Hard egress guard (`worker/staging-guard.js`): when `env.STAGING === "1"` every outbound `fetch` from the
    Worker is wrapped. WhatsApp (`graph.facebook.com/*/messages`) and Retell (`create-phone-call`) requests whose
    recipient (`to` / `to_number`) is not in `STAGING_ALLOWLIST` are **not sent**; the call returns a synthetic
    response `{ok:false, error:'staging-blocked', ...}` (HTTP 403) so the caller's error path runs and the block is
    logged to the KV journal. Any other host than the allowlist of hosts
    (`graph.facebook.com`, `api.retellai.com`, `hooks.slack.com`, `hook.*.make.com`, `api.telnyx.com` GET only,
    `us.i.posthog.com`, `api.monday.com`, `api.linear.app`, `api.github.com`, `*.googleapis.com`) is blocked
    the same way. Telnyx `POST`/SMS and `env.EMAIL.send` are blocked outright in staging.
    Production (`STAGING` unset) is untouched: the guard module installs nothing.
R3. Defense in depth: `whatsapp.js sendWA` also checks the allowlist itself when `STAGING === "1"`, so the
    guard holds even if the fetch wrapper is ever removed.
R4. `SHEET_ID` is `env.SHEET_ID || <production id>` everywhere (`evlog.js`, `sheetlogs.js`).
R5. `config.js` (and `demo/config.js`) pick the proxy by hostname: `staging.ishur.io` / `*.pages.dev` /
    `localhost` → `https://go-staging.ishur.io`; everything else → `https://go.ishur.io`.
R6. Branch `staging` exists on origin; `scripts/deploy-staging.sh` deploys site (Cloudflare Pages direct upload
    of the repo root honouring `_config.yml` excludes) + worker (`wrangler deploy --env staging`) from it.
R7. `scripts/promote.sh` is the one documented production command: refuses on dirty tree, runs the worker
    test suite, runs `scripts/smoke.sh` against `go-staging.ishur.io` and `staging.ishur.io`, then fast-forwards
    `main` to `staging`, pushes (GitHub Pages redeploys) and runs `worker/deploy.sh`. Any failing step aborts
    before anything touches production.
R8. `scripts/smoke.sh <worker-base> <site-base>`: worker `/health`-type endpoint returns 200 and reports
    `staging:true` on staging / `false` on prod; site root returns 200 and its `config.js` resolves the expected
    proxy base; on staging one blocked send to a non-allowlisted number returns `staging-blocked`.
R9. `.sdlc/dev-staging/README-staging.md`: how to deploy staging, set secrets, run a cron job by hand, promote.

## Pass conditions (machine-checkable; these ARE the verify-loop checks)

P1. `node --test 'worker/test/*.test.mjs'` exits 0, with new `staging-guard.test.mjs` covering: non-allowlisted WA
    → blocked; allowlisted WA → passes through; Retell `to_number` non-allowlisted → blocked; unknown host → blocked;
    `STAGING` unset → wrapper not installed (`globalThis.fetch` identity unchanged); EMAIL.send blocked.
P2. `grep -c 05a171c6b3cb46f2af7cc72b1ac19f14 worker/wrangler.toml` == 1 (only in the production block) and the
    staging block has its own KV id (`wrangler kv namespace list` shows `RATE-staging`).
P3. `npx wrangler deploy --env staging --dry-run` succeeds; `npx wrangler deploy --dry-run` (prod) still succeeds.
P4. After a real staging deploy: `curl -s https://go-staging.ishur.io/api/health` (or the existing health route)
    returns 200 with `"staging":true`; the same route on `go.ishur.io` has no `staging:true`.
P5. `curl -s https://staging.ishur.io/config.js | grep go-staging` matches; `curl -s https://ishur.io/config.js`
    still resolves to `go.ishur.io` at runtime (the string `go-staging` only appears inside the hostname switch).
P6. A staging send to a non-allowlisted number through the admin preview endpoint returns `staging-blocked`
    and the KV journal has the block row; nothing arrives at the number (checked by the response, not by a phone).
P7. `scripts/promote.sh` with a deliberately failing test (run in a throwaway worktree) exits non-zero before
    `git push`/`wrangler deploy` (verified by a dry-run flag `PROMOTE_DRY=1` that prints the steps it would run).
P8. `git diff main staging -- worker/wrangler.toml` after promote is empty: the production block never changes
    through staging.

## Policy flags

- **Secrets**: production secrets are never read or copied. Staging secrets come only from Richard's local file,
  which is gitignored. The script never echoes values.
- **Live client data**: staging KV starts empty; staging sheet is a copy frozen at copy time. Nothing on staging
  reads production KV/R2. Inbound Meta/Retell webhooks stay pointed at production.
- **Cost**: a second Worker (free tier is fine), one KV namespace, one R2 bucket, one Pages project. Retell/Meta
  sends to the allowlist cost the same as today, only to 2 numbers.
- **Public**: `staging.ishur.io` is public like the site. No new PII on it (static pages). The Worker admin routes
  keep their `ADMIN_KEY` gate; staging gets its own key.

## Out of scope

- Separate Meta phone numbers / WABA for staging (sends go out from the production numbers, to the allowlist only).
- Routing inbound WhatsApp/Retell webhooks to staging.
- D1 for staging (production has none yet).
- Make scenarios for staging (HOOK_* stay unset on staging; the code already treats a missing hook as "skip").
- Automatic promotion on merge (promote is a manual command by design).
