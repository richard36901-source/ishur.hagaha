#!/bin/sh
# Deploy with the git sha (and an optional note) so the journal row
# "גרסה חדשה של הוורקר עלתה" says exactly which code went live, and the
# change log (ops center · שינויים) lists the commits since the last deploy.
#   ./deploy.sh "what changed"
set -e
cd "$(dirname "$0")"
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
NOTE=${1:-}
# build-info.json is (re)written by wrangler's [build] command too; running it
# here keeps deploy.sh correct even if [build] is removed.
node scripts/build-info.mjs
npx wrangler deploy --var BUILD_SHA:"$SHA" --var BUILD_NOTE:"$NOTE"
# the next deploy's commit list starts here
git update-ref refs/ishur/deployed HEAD 2>/dev/null || true
# keep the committed stub clean in git (the deployed bundle already has the real one)
git checkout -- build-info.json 2>/dev/null || true
