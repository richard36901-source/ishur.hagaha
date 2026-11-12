# personal-area · intent (Richard 12/11/26)

**Problem:** clients now have 2+ events; each dashboard is a separate token link. No place to see all events, past ones, reviews, credit.

**Outcome:** login by phone + WhatsApp code (or email) → personal area: event 1, event 2…; a past event is greyed with only "השאר ביקורת" if none left (or only video / only Google done); the review flow: 1–10 score first → under 5: no video/Google offered; 5+: video then Google (or straight to the missing one). Credit balance (referral + reviews) and "למימוש" button. Future: partner offers redemption.

**Affected:** new account.html, worker auth (OTP via Noa 4499 or email), dashboard.html links, feedback.html flow, crm clients.
**Depends on:** referral-program for credit; feedback gate rules already live (feedback.html scores → links).
