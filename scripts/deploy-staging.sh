#!/bin/sh
# dev-staging: deploy branch `staging` → staging.ishur.io (Workers static assets, site-staging/)
#                                      + ishur-webhooks-staging (go-staging.ishur.io)
#   scripts/deploy-staging.sh            both
#   scripts/deploy-staging.sh site       site only
#   scripts/deploy-staging.sh worker     worker only
# Refuses on any branch but `staging`, so production code never lands here by mistake.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
[ -f ~/.zshenv ] && . ~/.zshenv >/dev/null 2>&1 || true
BR=$(git branch --show-current)
[ "$BR" = "staging" ] || { echo "deploy-staging: on branch '$BR', need 'staging'"; exit 1; }
WHAT=${1:-all}
if [ "$WHAT" = all ] || [ "$WHAT" = site ]; then
  rm -rf dist-site && mkdir dist-site
  # the same files GitHub Pages serves: repo root minus _config.yml's excludes
  rsync -a --exclude .git --exclude .github --exclude .gitignore --exclude dist-site --exclude .wrangler --exclude .claude --exclude .sdlc \
    --exclude worker --exclude agent --exclude docs --exclude scripts --exclude node_modules --exclude '*.fixture.json' \
    --exclude HANDOFF.md --exclude README.md --exclude SENDING-LOGIC.md --exclude TASKS.md --exclude CNAME ./ dist-site/
  # <meta name="robots"> is not injected: staging is for people with the link; robots.txt below keeps crawlers out
  printf 'User-agent: *\nDisallow: /\n' > dist-site/robots.txt
  (cd site-staging && npx wrangler deploy)
fi
if [ "$WHAT" = all ] || [ "$WHAT" = worker ]; then
  (cd worker && node scripts/build-info.mjs && npx wrangler deploy --env staging --var BUILD_SHA:"$(git rev-parse --short HEAD)" && git checkout -- build-info.json 2>/dev/null || true)
fi
echo "staging deployed ($WHAT) from $(git rev-parse --short HEAD)"
