#!/bin/sh
# dev-staging smoke (12/11/2026). Usage:
#   scripts/smoke.sh staging      → go-staging.ishur.io + staging.ishur.io, expects staging:true, probes the guard
#   scripts/smoke.sh prod         → go.ishur.io + ishur.io, expects staging:false
#   scripts/smoke.sh <worker-base> <site-base> <0|1 expect staging>
# Exit 0 only when every check passed. Prints each check with its real output.
set -u
case "${1:-}" in
  staging) W=https://go-staging.ishur.io; S=https://staging.ishur.io; EXP=1;;
  prod)    W=https://go.ishur.io;         S=https://ishur.io;         EXP=0;;
  *)       W=${1:?worker base}; S=${2:?site base}; EXP=${3:-0};;
esac
ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail=0
ok()  { echo "ok    $1"; }
bad() { echo "FAIL  $1"; fail=1; }

H=$(curl -s -m 20 "$W/api/health")
echo "health: $H"
case "$H" in *'"ok":true'*) ok "worker health 200";; *) bad "worker health: $H";; esac
if [ "$EXP" = 1 ]; then
  case "$H" in *'"staging":true'*) ok "worker reports staging:true";; *) bad "worker is not staging";; esac
  case "$H" in *'"crons":"off"'*) ok "crons off";; *) bad "crons not off";; esac
else
  case "$H" in *'"staging":true'*) bad "PRODUCTION worker reports staging:true";; *) ok "worker reports staging:false";; esac
fi

code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$S/")
[ "$code" = 200 ] && ok "site root 200" || bad "site root $code"
CFG=$(curl -s -m 20 "$S/config.js")
if [ "$EXP" = 1 ]; then
  echo "$CFG" | grep -q "go-staging.ishur.io" && ok "staging config.js carries the staging proxy" || bad "staging config.js lacks go-staging"
  curl -s -m 20 "$S/robots.txt" | grep -qx 'Disallow: /' && ok "robots.txt blocks crawlers" || bad "robots.txt open on staging"
else
  echo "$CFG" | grep -q "PROXY_BASE = 'https://go.ishur.io'" && ok "prod config.js default is go.ishur.io" || bad "prod config.js default changed"
  curl -s -m 20 "$S/robots.txt" | grep -qx 'Disallow: /' && bad "PRODUCTION robots.txt blocks everything" || ok "prod robots.txt open"
fi
# the hostname switch itself, evaluated offline against the served file
TMP=$(mktemp); echo "$CFG" > "$TMP"
node "$ROOT/scripts/check-config.mjs" "$TMP" >/dev/null 2>&1 && ok "served config.js resolves every hostname correctly" || bad "served config.js hostname switch broken"
rm -f "$TMP"

if [ "$EXP" = 1 ]; then
  # the guard, live: a number outside STAGING_ALLOWLIST must come back staging-blocked
  KEY=$(grep '^ADMIN_KEY=' "$ROOT/worker/.staging.secrets" 2>/dev/null | cut -d= -f2-)
  if [ -z "$KEY" ]; then
    bad "no ADMIN_KEY in worker/.staging.secrets — guard probe NOT run"
  else
    P=$(curl -s -m 25 "$W/api/staging-probe" -H 'Content-Type: application/json' -d "{\"admin_key\":\"$KEY\",\"phone\":\"0501234567\"}")
    echo "probe: $P"
    case "$P" in *'"error":"staging-blocked"'*) ok "send to a non-allowlisted number was blocked";; *) bad "guard did not block: $P";; esac
  fi
  P2=$(curl -s -m 20 -o /dev/null -w '%{http_code}' https://go.ishur.io/api/staging-probe -H 'Content-Type: application/json' -d '{}')
  [ "$P2" = 404 ] && ok "probe route absent in production (404)" || bad "probe route answered $P2 in production"
fi

[ $fail = 0 ] && echo "SMOKE PASS ($W / $S)" || echo "SMOKE FAIL ($W / $S)"
exit $fail
