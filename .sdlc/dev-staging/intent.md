# dev-staging · intent (Richard 12/11/26)

**Problem:** every change goes straight to production (ishur.io + worker ishur-webhooks). Richard wants a place to build/test/change things without touching live clients.

**Outcome:** a staging environment: staging site (staging.ishur.io on the same repo, branch `staging`), a staging worker (`ishur-webhooks-staging`, wrangler env `staging`, own KV namespace, own D1, test Google Sheet copy, Meta test numbers or sends disabled, Slack to #ishur-staging), one command to promote staging → main. Production never receives a deploy without the tests + smoke + staging check.

**Constraints:** no real guest sends from staging (hard switch: WA_SEND_DISABLED=1 unless phone is on an allowlist); secrets copied except Meta tokens; cron disabled on staging or pointed at the test sheet.
**Open:** which Google Sheet copy, test phone numbers (Richard's, Shalev's), domain for staging.
