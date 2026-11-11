# ops-self-serve · intent (11/11/26)

**Problem.** Every operational question goes through the chat: who gets sends today/tomorrow, how many went to X, why so few, when does it resume, how many remain, until what hour, is 4499 back, is the business verified. Each answer costs KV digging and a correction round. Richard wants the control center to answer all of it so the chat is only for *new* things to add or change.

**Outcome.** One screen in ops.html (`#/messages?tab=live`, also a card on סקירה) that shows, live, everything asked in the 10–11/11 conversation, with no Claude in the loop.

**Affected systems.** Worker ishur-webhooks (new `/api/ops/live`), ops.html + `assets/ops/screens/live.js`, the 09:00 Slack digest, KV only read (no new state).

**Constraints.** Read-only first (no new levers beyond the existing drag-order and waveprio). Numbers must come from the same KV the engine uses (`gsendh:` buckets, `bic:`, `wsent:`, `wpused:`, `waveorder`, `wave:`) so the screen never disagrees with what actually goes out. No "לא נשלח" wording anywhere client-facing.

**Open questions (Richard).**
1. Cap scope: NOT an option while unverified — Meta caps 250 per BUSINESS (verified 02/11). Per-number scope (≈460/day) only after business verification is approved; the screen should flip automatically when `verification.status` turns approved.
2. Margin 20 → 10 (asked 02/11, still open)?
3. Verification status: poll Meta automatically (needs `business_management` scope on the stored token) or keep a manual "checked on" stamp?
