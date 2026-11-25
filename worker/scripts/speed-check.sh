#!/usr/bin/env bash
# 26/11 track-speed · times the admin reads each back-office page makes on open, three times in a row
# (1st ≈ cold, 2nd/3rd ≈ warm). READ routes only — no body carries an action. Run before and after a deploy:
#   ISHUR_ADMIN_KEY=… worker/scripts/speed-check.sh [https://go-staging.ishur.io]
# The key is read from the environment and never printed. x-ishur-age = seconds old when served from a copy.
set -euo pipefail
BASE="${1:-https://go.ishur.io}"; K="${ISHUR_ADMIN_KEY:?set ISHUR_ADMIN_KEY}"
ROUTES=(
  'status|{"view":"biz"}' 'leads|{}' 'evlog|{"n":400}' 'ads-health|{}' 'brain-toggle|{}' 'pause|{}'
  'ops-stats|{}' 'cost-log|{}' 'traffic|{"days":90}' 'campaign-stats|{"days":400}' 'call-board|{}' 'feedback-list|{}'
  'client-flags|{"tokens":[]}' 'referrals|{}' 'partner/list|{}' 'design-list|{}'
  'inbox|{}' 'callers|{}' 'stream|{"days":2,"limit":2000}' 'answers-log|{}' 'future-log|{"days":14}' 'calls-log|{"queue":true}'
)
printf '%-16s %8s %8s %8s  %s\n' route run1_ms run2_ms run3_ms age3
for r in "${ROUTES[@]}"; do
  p="${r%%|*}"; b="${r#*|}"; body=$(printf '%s' "$b" | sed "s/^{/{\"admin_key\":\"$K\",/; s/,}$/}/")
  out=(); age=''
  for i in 1 2 3; do
    res=$(curl -s -o /dev/null -D - -w 'MS=%{time_total}\n' -X POST -H 'Content-Type: application/json' -H 'Origin: https://ishur.io' "$BASE/api/$p" --data-binary @- <<<"$body")
    out+=("$(printf '%s' "$res" | sed -n 's/^MS=//p' | awk '{printf "%d", $1*1000}')")
    age=$(printf '%s' "$res" | tr -d '\r' | sed -n 's/^x-ishur-age: //Ip')
  done
  printf '%-16s %8s %8s %8s  %s\n' "$p" "${out[0]}" "${out[1]}" "${out[2]}" "${age:--}"
done
