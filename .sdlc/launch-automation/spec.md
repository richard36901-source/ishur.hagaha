# Spec · launch today (approved directions from Richard, 15.8)

Decisions: Google Sheets is the single store (clients + guests; Monday out).
Old scaffold discarded. Native Grow webhook module. Guest-sending built but
INACTIVE until number B. Templates last. OTP = phase 2.

## Requirements + pass conditions

R1 Sheets schema exists in spreadsheet 1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q:
   tabs לקוחות, מוזמנים, הסרות with the agreed headers.
   PASS: tabs visible with headers via a real Make read.

R2 Payment → onboarding row. Grow IPN (native Grow webhook) creates a לקוחות
   row with a minted token, plan/tier mapped from the paid sum, phone normalized.
   PASS: one real (test) IPN → row appears with token; duplicate IPN does not
   create a second row.

R3 thanks.html hands the customer their personal upload link immediately after
   payment (claim by Grow transaction ref), no WhatsApp needed.
   PASS: browser flow against the live claim route returns the tokenized URL.

R4 Upload → guests in Sheets. events-upload scenario parses CSV and XLSX,
   writes מוזמנים rows (name/phone/seats, status=ממתין, tries=0), updates the
   client row (counts, upload_confirmed), responds 200; unknown token → 403.
   PASS: real multipart runs for csv+xlsx land correct rows; bad token → 403
   shown as dead-link screen on the site.

R5 event_setup + send_date_change update the client row. PASS: real posts
   reflected in the sheet.

R6 Status endpoint returns the HANDOFF.md JSON built from Sheets; dashboard
   renders it. PASS: dashboard.html?t=TOKEN shows the real event end to end.

R7 calls.html (admin, key-gated): list guests needing a call (status=לחייג or
   status=לא ענה with tries<MAX), per-event script text, outcome buttons
   (מגיע/לא מגיע/מתלבט/לא ענה/לחייג שוב), writes result+tries via events hook.
   MAX tries configurable, default 3.
   PASS: clicking an outcome updates the sheet row and the list refilters.

R8 Daily sender scenario exists on Sheets data, window 09:00-20:00, Shabbat/
   Friday rules, per-guest send + mark (status=נשלח, tries, last_send) — built,
   verified with WhatsApp module disabled-run, left INACTIVE.
   PASS: dry execution shows correct target selection on seeded data.

## Policy flags
- Claim route: token released only against grow_ref match (payer-only secret).
- הסרות tab honored by the sender before any guest send (legal).
- Worker keeps stamping; scenarios keep responding 200 only after writes.

## Out of scope today
OTP login, S6 reports, S8 lead chase, add-guests billing, AI replies (S3),
number B, template submission.
