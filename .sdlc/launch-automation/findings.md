# Findings · Make audit (15.8.2026)

Team 577708. Two generations of work found.

## Folder 379970 (wired to the live site hooks)
| Scenario | State | Reality |
|---|---|---|
| Website - leads (6959453) | ACTIVE | Works: lead → Google Sheets `1VAHaP32...` sheet 'לידים - לא סגרו'. No lead id, no dedup, no error handling |
| events upload (6959458) | off | **Webhook trigger only, zero modules after it** |
| Ishur.io Status (6959463) | off | **Empty. No response module** |

## Folder 351092 (old scaffold, all off — substantial but unfinished)
Built around three Monday boards: customers 18411339558, leads 18411339547,
guests 18422660194. WhatsApp from number id 1218978741299669.

| Scenario | What it does | Blockers |
|---|---|---|
| S1 orders (6611392) | Creates customer + guest group, parses CSV to guest items, converts lead | Built for the OLD site wizard payload (order data before payment). Excel not parsed. Template vars unmapped |
| S2 Grow (6611370) | Phone-match → mark date4 paid → alert Richard | No token mint, no upload link sent, zero IPN validation |
| S3 AI reception (6611408) | Inbound WhatsApp: routes customer/guest/lead, AI writes RSVP status+seats to Monday | `isinvalid:true`. No "הסר" opt-out. Prompts duplicated 4x. JSON parse can die mid-chat |
| S4 daily engine (6612192) | Invites on send dates, day-before, thank-you, sweep to call queue | **Template variables not mapped on ANY send.** Postponed/canceled misrouted. Double-send risk |
| S6 client report (6612196) | Counts guests, sends report, +3d | Stats computed but never passed to template |
| S8 lead reminder (6611373) | 2h poll, chase unfinished leads | Failed send still marked sent |

## WhatsApp templates already referenced
ishur_order_confirm, ishur_invite_{happy,formal,respect,playful},
ishur_postponed, ishur_canceled, ishur_reminder, ishur_day_before,
ishur_thank_you, ishur_status_report, ishur_finish_order.
**Approval status in Meta unverified. None have variables mapped in Make.**

## The structural conflict
Old scaffold = guests in Monday. New leads scenario + dashboard talk = Google
Sheets. The sending engine, AI reception and reports are all built on Monday;
only the lead log uses Sheets. One source of truth must be chosen.

## Payload mismatch
S1 expects the old wizard (event details collected before payment). The live
site collects payment first; event details arrive later via the token link.
S1's order branch is dead code against the current site.
