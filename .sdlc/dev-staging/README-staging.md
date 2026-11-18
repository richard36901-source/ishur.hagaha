# staging · runbook (dev-staging, 12/11/2026)

| | production | staging |
|---|---|---|
| site | ishur.io — GitHub Pages, branch `main` | staging.ishur.io — Worker `ishur-site-staging` (static assets, `site-staging/`), branch `staging` |
| worker | `ishur-webhooks` @ go.ishur.io | `ishur-webhooks-staging` @ go-staging.ishur.io (`wrangler --env staging`) |
| KV | RATE `05a171c6…` | RATE-staging `ef2534ea…` (starts empty) |
| R2 | ishur-audit | ishur-audit-staging |
| Google Sheet | RSVP - SEND `1VAHaP32…` | "RSVP - SEND · STAGING" `1QAfl1gn…` (copy of 12/11, `SHEET_ID` var) |
| crons | on | **off** — nothing runs by itself |
| Slack | #alerts etc. | `SLACK_ALERT_HOOK` secret for #ishur-staging, or silent |
| sends | real | **only** to `STAGING_ALLOWLIST` (wrangler.toml `[env.staging.vars]`) — everything else returns `staging-blocked` |
| inbound webhooks (Meta, Retell, Make) | production | still production — staging receives none |

The guard (`worker/staging-guard.js`) wraps every outbound `fetch` in staging. WhatsApp / Retell go only to the
allowlist; Monday, Telnyx, Linear, Cloudflare, googleapis are read-only; Morning / GreenInvoice / Meshulam and
unknown hosts are blocked; `EMAIL.send` is blocked. `whatsapp.js post()` repeats the phone check. Blocked calls
land in the staging KV journal (`evlog:` rows, flushed to the staging sheet's "יומן מערכת" once a job flushes it).

## Day to day

```bash
git checkout staging && git merge main        # start from what production runs
# ... work, commit on staging ...
scripts/deploy-staging.sh                      # site + worker (or: site | worker)
scripts/smoke.sh staging                       # health, config switch, robots, guard probe
```

Open https://staging.ishur.io — every page talks to go-staging.ishur.io (config.js picks it by hostname;
`localhost` and `*.workers.dev` do too). Admin pages need the staging `ADMIN_KEY`.

## Secrets (once, and whenever one changes)

```
worker/.staging.secrets      # gitignored, KEY=VALUE per line
worker/scripts/staging-secrets.sh
```

Minimum: `ADMIN_KEY` (generated 12/11, already set). Useful: `APP_KEY`, `RETELL_KEY`, `BRAIN_HOOK` (the same Make
proxy is fine — it writes wherever `SHEET_ID` points), `SLACK_ALERT_HOOK` (#ishur-staging webhook).
Optional: `WA_TOKEN`, `WA_TOKEN_GUESTS`, `WA_PHONE_ID`, `WA_PHONE_ID_GUESTS` — without them WhatsApp returns
`wa-not-configured`; with them the allowlist still applies. **Never** `HOOK_EVENTS` / `HOOK_STATUS` / `HOOK_LEADS`
/ `HOOK_GROW` (production Make scenarios).

## Client boards and sign-in on staging (added 18/11/2026)

Staging has no Make scenario behind its client boards. Its sheet is an invented demo (3 events, 114 guests, made-up
names and numbers) kept in the staging KV and served through `HOOK_STATUS = "kv:stg:snapshot"`.

```bash
node worker/scripts/staging-seed.mjs          # (re)load the demo sheet + token records
node scripts/staging-check.mjs                # sign in the ways clients really arrive; exit 0 = 13/13
```

`scripts/staging-check.mjs` is the gate for anything that touches client sign-in, the board link, `config.js`,
`assets/guard.js`, `sw.js` or the status route. It turns the board lock ON in staging, then signs in by the personal
link (first visit), as a returning device with an OLD `config.js`, with no link at all (home-screen app), and through
the personal area; checks a wrong code is refused; checks staging cannot send; and leaves the lock off again.
It needs Chrome and playwright (`PLAYWRIGHT_PATH=/path/to/playwright/index.mjs` when it is not installed in the repo).

Known differences from production:
- event links the worker writes (personal area, messages) carry the production host `https://ishur.io/…`; on staging
  open the same path on `staging.ishur.io`;
- sheet writes are not available (no `BRAIN_HOOK`): flows that write the sheet answer a failure on staging;
- demo tokens: `aaaaaaaa-0000-4000-8000-000000000001` (wedding, 36 guests), `bbbbbbbb-…0002` (bar mitzvah, 60, sent),
  `cccccccc-…0003` (past event). Sign-in codes: `POST /api/client-pin {admin_key, token}` with the staging key.

## Running a cron job by hand on staging

Crons are off. The same admin routes production's crons call are available with the staging admin key, e.g.
`POST go-staging.ishur.io/api/daily-run {admin_key}`, `/api/pacer`, `/api/ops/...` — see `automations.html`
on staging for the list. Nothing runs unless you call it.

## Promote staging → production (the one command)

```bash
PROMOTE_DRY=1 scripts/promote.sh      # rehearsal: all checks, no push, no deploy
scripts/promote.sh "what changed"      # the real thing
```

It refuses on a dirty tree, off-branch, un-pushed staging or a main that moved ahead; runs the worker tests,
the config check and the live staging smoke; only then fast-forwards `main`, pushes (Pages redeploys), runs
`worker/deploy.sh`, smokes production and pushes `staging`. Rollback line is printed at every failure.

## Hotfix straight on main?

Don't. Commit on `staging`, deploy-staging, smoke, promote. If main was changed anyway, `git checkout staging
&& git merge main` before the next promote (promote refuses otherwise).

## Tear down

`npx wrangler delete --name ishur-webhooks-staging`, `npx wrangler delete --name ishur-site-staging` (from
`site-staging/`), `npx wrangler kv namespace delete --namespace-id ef2534eafecf4dc9bcdbfef042b5bb37`,
`npx wrangler r2 bucket delete ishur-audit-staging`, trash the staging sheet.
