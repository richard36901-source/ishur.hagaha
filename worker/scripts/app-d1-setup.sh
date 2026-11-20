#!/bin/sh
# ishur client app · create the usage database on D1 and bind it to the STAGING worker as APP_DB.
#   sh worker/scripts/app-d1-setup.sh            staging (database ishur-app-staging)
#   sh worker/scripts/app-d1-setup.sh production  production (database ishur-app), run only as part of a promote
# Needs the Cloudflare API token to have Account → D1 → Edit. Safe to run twice: an existing database is reused.
# Never run a `wrangler pages` command from this folder (see the 12/11 incident in the runbook).
set -eu
cd "$(dirname "$0")/.."
[ -f ~/.zshenv ] && . ~/.zshenv >/dev/null 2>&1 || true
WHICH=${1:-staging}
if [ "$WHICH" = production ]; then NAME=ishur-app; HEAD='[[d1_databases]]'; ENVFLAG=''; else NAME=ishur-app-staging; HEAD='[[env.staging.d1_databases]]'; ENVFLAG='--env staging'; fi
ID=$(npx wrangler d1 list --json 2>/dev/null | python3 -c "import sys,json; print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='$NAME'), ''))" || true)
if [ -z "$ID" ]; then
  npx wrangler d1 create "$NAME" >/dev/null
  ID=$(npx wrangler d1 list --json | python3 -c "import sys,json; print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='$NAME'), ''))")
fi
[ -n "$ID" ] || { echo "app-d1-setup: could not create or find $NAME (does the token have D1:Edit?)"; exit 1; }
grep -q "database_name = \"$NAME\"" wrangler.toml || printf '\n# ishur client app: usage data (worker/app-events.js, migrations-app/). Added by scripts/app-d1-setup.sh\n%s\nbinding = "APP_DB"\ndatabase_name = "%s"\ndatabase_id = "%s"\nmigrations_dir = "migrations-app"\n' "$HEAD" "$NAME" "$ID" >> wrangler.toml
for f in migrations-app/*.sql; do npx wrangler d1 execute "$NAME" --remote --file "$f" $ENVFLAG >/dev/null; done
echo "app-d1-setup: $NAME ($ID) is ready and bound as APP_DB for $WHICH. Deploy the worker to start using it."
