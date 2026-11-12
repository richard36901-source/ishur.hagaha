#!/bin/sh
# dev-staging: push the staging Worker's secrets from a local, gitignored file.
#   worker/.staging.secrets   one KEY=VALUE per line, # comments allowed
#   ./scripts/staging-secrets.sh
# Values are never printed. Production secrets are never read (wrangler cannot).
# Minimum useful set: ADMIN_KEY APP_KEY RETELL_KEY BRAIN_HOOK
# Optional: WA_TOKEN WA_TOKEN_GUESTS WA_PHONE_ID WA_PHONE_ID_GUESTS WA_VERIFY SLACK_ALERT_HOOK
set -e
cd "$(dirname "$0")/.."
F=.staging.secrets
[ -f "$F" ] || { echo "missing worker/$F — create it with KEY=VALUE lines"; exit 1; }
n=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue;; esac
  k=${line%%=*}; v=${line#*=}
  [ -n "$k" ] && [ -n "$v" ] || continue
  printf '%s' "$v" | npx wrangler secret put "$k" --env staging >/dev/null
  echo "set $k"; n=$((n+1))
done < "$F"
echo "$n secrets set on ishur-webhooks-staging"
