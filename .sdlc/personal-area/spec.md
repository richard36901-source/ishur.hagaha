# personal-area · spec (Claude for Richard, 12/11/26)

Builds on what exists: `/api/otp-send` (ishur_kod via Noa 4499), `eventsForPhone()` (column D owner
+ column AU second phone, paid + not cancelled), `fb:<token>` feedback records, dashboard.html gate +
picker, assets/pwa.js, assets/lux.css.

## Answers to the open questions
- **Login store**: a separate code key `acctotp:<phone>` (10 min, 5 tries) and a signed session
  `acct.<nonce>.<sig>` (90 days, revocable via KV `acctsess:<nonce>`), kept in localStorage only.
  The dashboard's own `otp:<phone>` 30-day rule is untouched.
- **Email fallback**: the events sheet has no email column. The code falls back to email only when
  WhatsApp fails (131042 or any send error) AND the leads sheet (column D) has an email for that
  phone. Otherwise the page says the code could not be sent and offers WhatsApp to Noa.
- **Feedback threshold**: stays `min(nps, exp) >= 6` (Richard 12/11). Under 6 → thanks only.
- **Code delivery ladder** (Richard 12/11: Noa 4499 unpaid, 131042): (1) `ishur_kod` from Noa;
  (2) on any WhatsApp failure, the same template from the guests number (WA_TOKEN_GUESTS /
  WA_PHONE_IDS_GUESTS — template created once on that WABA, ~₪0.02); (3) email when the client has
  one (personal-area contact or leads sheet column D); (4) none → `send-failed` + WhatsApp to Noa.
  SMS (Telnyx, ~₪0.1–0.9 to Israel, unreliable from foreign senders) is NOT built.
- **Contact preferences** live in KV `contact:<phone>` `{email, phone_alt, marketing:boolean, at}`.
  Operational event messages are always sent (terms §9); marketing (דיוור) only when `marketing`
  is true. terms.html §9 gains "או מהאזור האישי" as a way to withdraw consent.
- **Credit ledger**: `credit:<phone>` JSON `{entries:[{kind, ils, at, token}], redeemed:[...]}`.
  Reviews write to it now (video ₪30, Google ₪20, once per kind per event); referral-program will
  append `referral` entries to the same ledger later. "למימוש" opens WhatsApp to Noa with a prefilled
  text until partner redemption exists.
- **Tokens in URLs**: the session never appears in a URL. Event tokens stay in `dashboard.html?t=`
  / `feedback.html?t=` links (already the product's convention).

## Requirements
R1. `account.html` (Hebrew, RTL, lux.css letterhead, radius ≤ 8px, light default + dark by device)
    shows a phone field → "שליחת קוד" → code field → "כניסה". No token in the URL.
R2. `POST /api/account/otp {phone, stamp}`: phone must own ≥1 paid event (eventsForPhone) else 404;
    rate limit 3/h per phone and 10/h per IP; code 6 digits, `acctotp:<phone>` TTL 600 s; delivery
    ladder Noa → guests number → email (contact:<phone>.email or leads sheet); response
    `{ok, via:'whatsapp'|'whatsapp-guests'|'email'}`; nothing worked → 502 `send-failed`.
R3. `POST /api/account/login {phone, code}`: 5 wrong tries delete the code; success deletes the
    code and returns `{ok, session}` where session = `acct.<nonce>.<sig>`,
    sig = HMAC-SHA256(ADMIN_KEY, 'acct:'+nonce+':'+phone) first 32 hex; KV `acctsess:<nonce>` holds
    {phone, at} for 90 days. Wrong/expired code → 403.
R4. `POST /api/account/me {session}`: verifies the signature + KV row, then returns
    `{ok, phone, events:[...], credit:{balance_ils, entries}}`. Each event: token, name, occasion,
    date, venue, `past` (date < today IL), `dashboard_url`, `feedback_url`,
    `review:{scored, route:'high'|'low'|'', video, google}` from `fb:<token>`.
    Events sorted: upcoming by date asc, then past by date desc. 403 on a bad session.
R5. `POST /api/account/logout {session}` deletes `acctsess:<nonce>`.
R6. account.html renders upcoming events as cards opening `dashboard.html?t=<token>`; past events
    are greyed and show only: "השאר ביקורת" (no scores yet → feedback.html?t=), or the buttons of
    the review kinds not yet done ("המלצת וידאו · ₪30", "ביקורת בגוגל · ₪20" →
    feedback.html?t=&step=video|google) when route is high; "תודה על הביקורת ✓" when both done;
    nothing when route is low.
R6b. Contact card ("פרטי קשר"): email (add/edit), the phone we contact (default column D; an
    alternative Israeli mobile can be saved), and a marketing toggle "לקבל מאיתנו דיוור ומבצעים"
    with the line "הודעות על האירוע עצמו נשלחות תמיד". `POST /api/account/contact {session,
    email?, phone_alt?, marketing?}` validates (email RFC-ish, phone 05x) and writes `contact:`;
    `/api/account/me` returns `contact`. A marketing opt-out also writes `optout:` is NOT done
    (that key means "stop everything"); instead `contact.marketing=false` is what future דיוור checks.
R7. Credit card: balance "₪N זיכוי" with the entries list (date · what · ₪); "למימוש" button visible
    only when balance > 0, opens `wa.me/972559504499?text=…` (Noa) with the balance.
R8. Install-as-app card identical in behaviour to dashboard.html (assets/pwa.js, iOS steps /
    Android prompt, hidden once installed or dismissed).
R9. feedback.html: scores → free text → when min(nps,exp) ≥ 6 and raffle is off: a CHOICE screen
    with two cards, "🎥 המלצת וידאו · ₪30 זיכוי" and "⭐ ביקורת בגוגל · ₪20 זיכוי" (plus "לא עכשיו").
    Picking one opens that step (link + "שלחתי ✓"/"סיימתי ✓" → `POST /api/review-claim`). After a
    claim: a thank-you screen "₪30 נזקפו לזיכוי שלכם · סה״כ ₪N" with the OTHER kind offered once
    more ("רוצים גם ביקורת בגוגל? עוד ₪20") or "סיימתם, תודה" when both are done. `?step=video|google`
    jumps straight to that step when scores exist. Under 6 → thanks only. Raffle flow unchanged
    when RAFFLE.on.
R10. `POST /api/review-claim {token, kind}`: 400 unless kind ∈ {video, google}; 404 bad token;
    409 `not-scored` when no scores, 409 `low-score` when route is low, 409 `already` when the kind
    was claimed; otherwise writes `fb.video_at`/`fb.google_at`, appends `{kind:'review_'+kind,
    ils:30|20, at, token}` to `credit:<ownerPhone>`, logs a Slack line, returns
    `{ok, ils, balance_ils}`. Rate limit 10/h per token.
R11. `/api/feedback` route rule stays `>= 6`; the response adds `scored`, `video`, `google`,
    `balance_ils` so a returning client is not asked twice and sees the money.
R12. dashboard.html header gets a small "האזור האישי" link to account.html (no other change).
R12b. terms.html §9: add "או מהאזור האישי" to the withdrawal line (no other change).
R13. Nothing is sent to any client number during the build: tests stub `fetch`; the only live OTP
    goes to 0545764327 and only after Richard writes "שלח".

## Pass conditions (machine-checkable)
P1. `node --test worker/test/*.test.mjs` exits 0, including a new `account.test.mjs` that drives the
    real `worker.fetch` with a KV stub and a fetch stub and asserts: otp 404 for a phone with no
    event; otp 200 + a code stored under `acctotp:` with TTL 600 and the stubbed Meta call carrying
    `ishur_kod`; login 403 ×5 then the code is gone; login 200 returns `acct.` session;
    me 200 lists 2 events for a 2-event phone with `past` flags and review states; me 403 with a
    tampered signature; review-claim 409 before scores, 200 after high scores with
    `balance_ils` 30 then 50, 409 on repeat, 409 for a low-score event; logout → me 403;
    feedback route `high` at 6/6 and `low` at 5/6; otp falls back to the guests phone id when the
    Noa call answers 131042, and to email when both WhatsApp calls fail and `contact:` has an
    email; contact 400 on a bad email, 200 then `me.contact.marketing === false`.
P2. `node scripts/ops-ui-smoke.mjs --no-browser` exits 0 (unchanged ops smoke still green).
P3. `node --check` passes on account.html's inline script extracted to a temp file, and a grep of
    account.html finds `assets/lux.css`, `assets/pwa.js`, `data-theme`, and no `border-radius`
    value above 8px.
P4. Local render check: serve the repo on localhost, open account.html in the built-in browser with
    the worker calls stubbed (`?mock=1` returns a fixture), assert no console errors, the login
    card, a 2-event list with one greyed past card showing only "ביקורת בגוגל", the credit card
    with "למימוש", at 375 px width with no horizontal scroll; screenshot saved to
    docs/ops-screens/account-*.png.
P5. After deploy: `curl -X POST https://go.ishur.io/api/account/me -d '{"session":"x"}'` returns
    403 JSON; `curl https://ishur.io/account.html` returns 200 with the Hebrew title.
P6. Live OTP to 0545764327 only on Richard's "שלח": the code arrives on WhatsApp (or email
    fallback is reported), login succeeds, the list shows his events.

## Policy flags
- **Security**: session is HMAC-signed with ADMIN_KEY (same primitive as admin sessions), 90-day
  TTL, revocable; codes 10 min, 5 tries, 3/h per phone, 10/h per IP; session only in POST bodies
  and localStorage; event tokens already appear in links (unchanged exposure). PII returned: the
  client's own phone, event names, credit.
- **Cost**: one `ishur_kod` authentication template per OTP (~₪0.05); Meta billing block 131042
  may make every WhatsApp OTP fail → email fallback (Cloudflare Email Sending, domain must be
  enabled: `npx wrangler email sending enable ishur.io`, unknown whether done — verified in P6).
- **Live data**: reads the production sheet snapshot; writes only to KV (`acctotp:`, `acctsess:`,
  `credit:`, `fb:`, `contact:`). One Meta template creation (`ishur_kod` on the guests WABA) needs
  Richard's OK before it is submitted. No sheet writes. No client sends in tests.

## Out of scope
- Referral credit accrual (referral-program), partner redemption, admin view of credits, cash.
- Changing the dashboard's own 30-day code rule or its gate UI.
- A review flow for the second host (`p=2`) earning separate credit (credit always goes to the
  owner phone, column D).
