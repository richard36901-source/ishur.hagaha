# ops-self-serve · report (11/11/26, deployed)

**Live:** https://ishur.io/ops.html#/messages?tab=now (nav: הודעות › לייב, shortcut `g w`). Worker version 832f53e1, site commit e72f62f on main.

## What I checked
- `cd worker && node --test test/*.test.mjs` → 782 pass, 0 fail (5 new in sendlive.test.mjs with the real 10–11/11 buckets: 230 used, 12:00 +128 / 17:00 +52 / 18:00 +47, Mor ETA 12:32; 1 new route test `/api/ops/sendlive`).
- `node scripts/ops-ui-smoke.mjs --no-browser` → 266 passed, 0 failed (new fixture `fixtures/ops/sendlive.json`, view check, "never says לא נשלח").
- Mock in the browser pane (`ops.html?mock=1#/messages?tab=now`): renders, no console errors.
- Real page in Richard's Chrome at 12:16 IL: counter 152/240, free 88, Meta 152/250, sent today 53, releases 17:00 +52 / 18:00 +47 / tomorrow 11:00 +3 / 13:00 +50; Mor 460/502 sent, 50 today, 42 left, ETA 12:26; Shoham 137/344, 3 today, ETA 18:00 (112 today); Eti wave 1 "ננטש (3 ימים)" 54/63; Gil held; 4499 "תקין"; verification "בבדיקה"; two "נשלח לאורחים" notes today. No console errors.
- KV cross-check at the same minute: `billingalert:client` absent, Mor's wsent today = 50 (12:01–12:12), current-hour buckets 27+23.

## Attempts
3. First route test failed on margin (code default 20 vs toml 10) → kept the code default, the test sets the var like production does. A perl edit mangled whatsapp.js once → restored from git, one-line Edit instead. Smoke/JS budget forced the screen into `lazy/`.

## Not covered
- The 4499 card trusts `billingalert:client`; the flag cleared by itself this morning and I did not find a recovery post in Slack — a real client template since then is the only proof, not yet seen.
- Verification status is Meta's `business_verification_status` cached 6 h, not the security-center page.
- ETA assumes the pacer's 25 per 10-min tick and no new holds; it is an estimate line, not a promise.
- Browser part of the smoke (Playwright) was not run.
- Morning digest lines are code-reviewed and unit-untested; first real proof is tomorrow 09:00.
