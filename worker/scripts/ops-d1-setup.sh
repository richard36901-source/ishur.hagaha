#!/usr/bin/env bash
# ops-d1-setup.sh — create the ishur-ops D1 database and apply the runs migration.
# Run ONCE by Richard (needs `npx wrangler login`), from anywhere:
#   bash worker/scripts/ops-d1-setup.sh
# Until this runs, worker/ops-run.js falls back to the KV ring buffer (opsrun:*),
# so nothing breaks at runtime — but `wrangler deploy` will reject the placeholder
# database_id in wrangler.toml, so run this BEFORE the next deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "1/3 create database ishur-ops"
out=$(npx wrangler d1 create ishur-ops 2>&1) || { echo "$out"; echo "(already exists? npx wrangler d1 info ishur-ops — then paste its id into wrangler.toml)"; exit 1; }
echo "$out"
id=$(printf '%s\n' "$out" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
[ -n "$id" ] || { echo "could not read database_id from the output above — paste it into wrangler.toml by hand"; exit 1; }
echo "2/3 database_id = $id -> wrangler.toml"
sed -i.bak "s/database_id = \"REPLACE_WITH_ID_FROM_ops-d1-setup.sh\"/database_id = \"$id\"/" wrangler.toml && rm -f wrangler.toml.bak
grep -n "database_id" wrangler.toml
echo "3/3 apply migrations (remote)"
npx wrangler d1 migrations apply ishur-ops --remote
npx wrangler d1 execute ishur-ops --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
echo "done. Deploy as usual (deploy.sh); runs land in D1 from the next tick."
