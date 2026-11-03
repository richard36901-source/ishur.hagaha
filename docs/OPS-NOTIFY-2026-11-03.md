# Ops center Phase 5: notifications + smart overview (03/11/2026)

Plan: docs/OPS-CENTER-PLAN-2026-11-03.md §10. Branch p5-notify (from integ-2026-11-02). Not deployed.

## Files
- worker/notify.js: rules, de-dup, channels, storage, settings, the overview payload, the series endpoint, router.
- worker/counters.js: daily counters cnt:<day>:<kind> plus month rollups cnt:m:<YYYY-MM>:<kind>; backfill.
- worker/migrations/0005_notifications.sql: the D1 table. KV ring fallback ntf:r:<inverted ms>:<id>, with the notification stored in the key metadata.
- Hooks, one line each: ops.js handleOps routes notify paths to notify.js; index.js scheduled() runs runNotify after the brain; audit.js record() calls bumpFromAudit.
- UI: assets/ops/lazy/notify.js (bell + #/notify screen), assets/ops/lazy/overview2.js (overview). screens/overview.js delegates to overview2 and falls back to the classic overview if /api/ops/overview is missing. app.js has 3 small edits: the route, LAZY, and mountBell at boot.
- Tests: worker/test/notify.test.mjs (16 tests); scripts/ops-notify-smoke.mjs (runs alone and from ops-ui-smoke.mjs); fixtures from scripts/build-notify-fixtures.mjs.

## Endpoints (admin key)
| | |
|---|---|
| GET /api/ops/notifications?unread=1&cursor=&limit= | items, unread count, next_cursor |
| POST /api/ops/notifications/mark {ids[], read?, snooze_until?} | |
| POST /api/ops/notifications/push-pull | returns the KV push:queue and clears it |
| GET/POST /api/ops/notify-settings | POST {rule, patch:{on,min_severity,channels,quiet,digest_hour,mute}} |
| POST /api/ops/edit {id:"notify:<rule>", field, value} | same thing, no typed confirm. Other settings still need one. |
| GET /api/ops/overview · POST {seen:true} | the whole overview · stamps lastseen:ops (the UI sends it after 4 s on screen) |
| GET /api/ops/overview-series?range=week\|month\|3m\|year&offset=N | buckets plus series revenue, orders, leads, closed, sends, fails, calls, visits, ad_spend, ad_leads; why{} gives the reason when a series is empty; prev_totals for the comparison |

Every settings change goes into the change log as kind edit, with the text "התראות · …". These changes cannot be undone from the change log yet (revert: none). Flip the setting back by hand.

## Rules and defaults
| id | name | sev | sends out from | channels | night-quiet | de-dup |
|---|---|---|---|---|---|---|
| incident | תקלה במערכת (מהמוח) | P1 | P1+ | app, slack, push, whatsapp | yes | 6 h |
| new_lead | ליד חדש | P2 | P2+ | app, slack, push | yes | 24 h |
| lead_reply | ליד ענה בשיחת המכירה | P2 | P2+ | app, push | yes | 1 h |
| payment | תשלום התקבל | P1 | P2+ | app, slack, push | yes | 168 h |
| unanswered | ליד / לקוח מחכה לתשובה מעל שעתיים | P1 | P1+ | app, slack, push | yes | 6 h |
| event_readiness | אירוע בעוד 3 ימים וחסר משהו | P1 | P1+ | app, slack, push | yes | 24 h |
| failures_spike | קפיצה בכשלי וואטסאפ | P1 | P1+ | app, slack, push | yes | 3 h |
| cap_high | התקרה היומית מעל 85% | P2 | P2+ | app, slack | yes | 12 h |
| hold_stale | אירוע בהחזקה יותר מיומיים | P2 | P2+ | app, slack | yes | 24 h |
| balances_low | יתרה נמוכה אצל ספק | P1 | P1+ | app, slack, push | yes | 24 h |
| template_status | תבנית אושרה / נדחתה | P2 | P2+ | app, slack | yes | 24 h |
| brain_autofix | המוח תיקן משהו לבד | P3 | P2+ | app, slack | yes | 6 h |
| deploy | גרסה חדשה עלתה | P3 | P3+ | app | yes | 720 h |
| weekly_digest | סיכום שבועי (ראשון) | P3 | P3+ | app, slack | no | 144 h |

- In-app always shows everything when the rule is on. A notification below min_severity stays in-app only.
- Quiet hours run 21:00–09:00 Israel time: push and WhatsApp are held. Slack keeps its own quiet queue (slack.js).
- WhatsApp goes free text to 972545764327 through Noa (sendText 'client'), only for P0, only 09–21, never on Shabbat. It needs Richard's 24h window with 4499 open. Outside the window Meta rejects it and the notification shows that WhatsApp was not delivered.
- Event rules (new lead, lead reply, payment, deploy, template, brain auto-fix) catch up every tick from state: CRM store leads, Grow pay audit rows, the change log. Hooks can call notifyEvent(env, d, rule, cand) directly.
- Push: a session-side watcher (Claude's PushNotification while a session is open) polls POST /notifications/push-pull every few minutes.

## Overview data sources
- Revenue: mergeRevenue combines Grow pay rows (from 22/10), the sheet's paid events (paid_sum, paid_at) and invoice:<token>. Each sale is counted once per tok8. A sale with no date counts in the totals but not on the chart.
- Sends, fails, calls per day: counters bumped in audit.record. From the 10-min tick, backfill rebuilds 2 past days per tick (30 days in about 2.5 h) and re-derives today and yesterday once an hour. A day is never written from a truncated audit read. KV has no atomic increment, so two bumps in the same instant can lose one. The hourly re-derive corrects that.
- Ads: Meta insights for the window, one Graph call, KV cache for 15 min. Needs META_ADS_TOKEN. Traffic: traffic.js trafficReport, last 30 days only.
- Anything missing shows "אין נתונים עדיין: <reason>".

## Verification (03/11)
- node --test worker/test/*.test.mjs: 445 pass, 0 fail.
- node scripts/ops-ui-smoke.mjs: 268 pass, 0 fail, including notify smoke 50/50 (bell, dropdown, mark read, #/notify filters and settings, trend range/arrows/tooltip/table, dark mode, 375 px layout).
- The ops-ui-smoke overview CRM check changed: it used to assert the 3 static crm/today.js charts, which Richard rejected. It now asserts the ממתין לך list, the interactive trend chart and the funnel tile.
- Not proven: real production data, the live Meta and Retell responses, D1 (tests ran on the KV path), WhatsApp delivery to Richard, the cron path under real load or the subrequest limit (1000) for buildOverview. The mock series ignores range and offset.

## Needs Richard
1. Apply migration 0005 to OPS_DB before deploy, or KV is used.
2. Confirm that WhatsApp-to-self through Noa is fine (P0 only). It only works when his window with 4499 is open.
3. META_ADS_TOKEN must be set in the Worker for the ads tiles.
