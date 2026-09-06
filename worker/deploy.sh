#!/bin/sh
# Deploy with the git sha (and an optional note) so the journal row
# "גרסה חדשה של הוורקר עלתה" says exactly which code went live.
#   ./deploy.sh "what changed"
set -e
cd "$(dirname "$0")"
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
NOTE=${1:-}
npx wrangler deploy --var BUILD_SHA:"$SHA" --var BUILD_NOTE:"$NOTE"
