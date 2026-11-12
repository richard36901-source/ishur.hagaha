# referral-program · intent (Richard 12/11/26) — "הזמן חבר": 20% הנחה או 20% עמלה

**Problem:** the dashboard card "הזמן חבר" (dashboard.html, tier badge + share buttons) only counts referrals (refcred:). No choice, no discount, no credit, no tracking screen.

**Outcome (one sentence):** a client picks "20% הנחה לחברים" or "20% עמלה לי", gets a code + link + a branded share image (Instagram story / WhatsApp), friends who pay through it are tracked automatically, credit accrues to the client and is redeemable against our packages from the client's personal area; Richard follows everything from the admin clients screen.

## Decisions (final, 12/11)
- 20% of the PACKAGE only (not hostesses/design add-ons).
- Commission is **credit, not cash**: accrues at the friend's payment (IPN), redeemable only against our packages/add-ons (future: partner offers like DJ etc.). No minimum. Shown in small print, never shouted.
- Discount path: duplicate Grow permanent pages at 80% (we have NO Grow API — only the Make Grow app + IPN; pages are built once by hand in Grow, list prepared by Claude: name/title/price per package).
- Choice saved per event; changeable until the first referral.
- Card default copy to motivate: "חברים חסכו ₪0" / "הרווחתם ₪0" + "למימוש" button when credit > 0.
- Share kit: link `ishur.io/?ref=CODE` + QR + designed image/sticker templates in the site/campaign design language (lux.css: Frank Ruhl Libre + Heebo, gold #A8853C, pine, ivory; show hostesses, the ✓ brand); discount version says "20% הנחה על כל החבילות", commission version shows no discount. Instagram story 1080×1920 + square + WhatsApp.
- Reviews earn credit too: text/Google review ₪20, video ₪30 (replaces the raffle for now).
- **Raffle frozen**: worker/raffle.js RAFFLE.on is already false (config.js mirrors it) — leave off; raffle returns next round.
- Noa post-event message to the host: one message, credit for review/video (no raffle text). Keep it calm, not "too much".
- Site: ?ref= → cookie 30d → prices at 80% (discount path) with "הנחת חבר של <name>" tag → Grow 80% page; code into cField3 → IPN → referral record {referrer, friend, sum, path, status:verified}.
- Admin: clients › הפניות tab (referrer → friend → date → sum → path → discount given / credit earned → redeemed), a line on the home todo when credit waits, Slack 🎉 line per referral payment.

## Depends on
- personal-area (login by phone + WhatsApp code or email): credit balance + "למימוש" live there. See .sdlc/personal-area/intent.md. The referral card can ship first with "למימוש" opening WhatsApp to Noa until the personal area exists.
- dev-staging environment (.sdlc/dev-staging) preferred before this build.

**Affected:** dashboard.html, index.html (pricing), worker/index.js (IPN, refcred), worker/dashboard.js, worker/crm.js, clients.html, Grow (duplicate pages), Noa templates (new utility template for post-event credit), Make scenario 7362541 (cField3).
**Out of scope:** cash payouts, partner redemption (future), raffle.
