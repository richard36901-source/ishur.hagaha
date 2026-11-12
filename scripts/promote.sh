#!/bin/sh
# dev-staging (12/11/2026): THE production command. staging → main, site + worker.
#
#   scripts/promote.sh ["deploy note"]
#   PROMOTE_DRY=1 scripts/promote.sh     → runs every check, prints the production steps, touches nothing
#
# Order, and it stops at the first failure — nothing after a failed step runs:
#   1. clean tree, on branch `staging`, staging == origin/staging
#   2. worker unit tests (node --test)
#   3. config.js hostname switch check
#   4. smoke against the LIVE staging (go-staging.ishur.io + staging.ishur.io, incl. the guard probe)
#   5. main fast-forwards to staging (never a merge commit, never a force)   ← production starts here
#   6. git push origin main          → GitHub Pages redeploys ishur.io
#   7. worker/deploy.sh "<note>"     → ishur-webhooks (go.ishur.io), production block of wrangler.toml
#   8. smoke against production
#   9. git push origin staging (so staging and main point at the same commit)
# Rollback: git push origin <previous-main-sha>:main --force-with-lease && (cd worker && git checkout <sha> && ./deploy.sh "rollback")
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
[ -f ~/.zshenv ] && . ~/.zshenv >/dev/null 2>&1 || true
NOTE=${1:-"promote staging → main"}
DRY=${PROMOTE_DRY:-0}
say() { echo; echo "── $1"; }
run() { if [ "$DRY" = 1 ]; then echo "   [dry] $*"; else "$@"; fi; }

say "1/9 preconditions"
[ -z "$(git status --porcelain)" ] || { git status --short; echo "promote: working tree not clean"; exit 1; }
BR=$(git branch --show-current); [ "$BR" = staging ] || { echo "promote: on '$BR', need 'staging'"; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/staging)" ] || { echo "promote: local staging != origin/staging (push or pull first)"; exit 1; }
git merge-base --is-ancestor origin/main HEAD || { echo "promote: origin/main has commits that are not on staging — merge main into staging first"; exit 1; }
echo "   staging $(git rev-parse --short HEAD) · main $(git rev-parse --short origin/main) · $(git log --oneline origin/main..HEAD | wc -l | tr -d ' ') commits to promote"

say "2/9 worker tests"
(cd worker && node --test 'test/*.test.mjs' 2>&1 | grep -E '^ℹ (tests|pass|fail)' | tr '\n' ' '; echo)
(cd worker && node --test 'test/*.test.mjs' >/dev/null 2>&1) || { echo "promote: tests failed"; exit 1; }

say "3/9 config.js hostname switch"
node scripts/check-config.mjs >/dev/null || { echo "promote: check-config failed"; exit 1; }
node scripts/check-config.mjs demo/config.js >/dev/null || { echo "promote: demo check-config failed"; exit 1; }
echo "   ok"

say "4/9 smoke: staging (live)"
sh scripts/smoke.sh staging || { echo "promote: staging smoke failed — deploy staging first? (scripts/deploy-staging.sh)"; exit 1; }

say "5/9 main ← staging (fast-forward only)"
PREV=$(git rev-parse --short origin/main)
run git branch -f main HEAD
echo "   previous main: $PREV (rollback target)"

say "6/9 push main → GitHub Pages (ishur.io)"
run git push origin main:main

say "7/9 worker → production (go.ishur.io)"
run sh worker/deploy.sh "$NOTE"

say "8/9 smoke: production"
if [ "$DRY" = 1 ]; then echo "   [dry] sh scripts/smoke.sh prod"; else sleep 10; sh scripts/smoke.sh prod || { echo "promote: PRODUCTION SMOKE FAILED — rollback: git push origin $PREV:main --force-with-lease; cd worker && git checkout $PREV && ./deploy.sh rollback"; exit 1; }; fi

say "9/9 push staging"
run git push origin staging:staging
echo
[ "$DRY" = 1 ] && echo "PROMOTE DRY-RUN OK — nothing touched production" || echo "PROMOTED $(git rev-parse --short HEAD) → production (was $PREV)"
