# ishur.io · TASKS

Live progress file. Checked off as work lands, never pruned.

## Funnel as built (supersedes brief §5)

Two steps, then payment. Decided 15.8.2026.

**Step 1 · פרטים:** שם מלא, טלפון, אימייל (לא חובה), אישור דיוור
**Step 2 · האירוע:** סוג האירוע, כמות מוזמנים, חבילה (המלצה מסומנת לפי סוג האירוע)
**→ המשך לתשלום:** Grow link mapped from `<guests>_<plan>`, all 21 combinations kept.

Guest tiers: 50 / 100 / 200 / 300 / 400 / 500 / 600 / מעל 600.
מעל 600 has no self-serve price, routes to WhatsApp with the lead already sent.

**After payment:** Grow returns to `thanks.html`. No upload form there.
Make sends the tokenized `upload.html?t=<token>` link over WhatsApp once the Grow
payment webhook confirms the charge. A token cannot be reached by editing a URL.

---

## Phase 1 · Foundation

- [x] Repo audit: mapped current site (10-step wizard, 21 Grow links, 3 inline base64 logos)
- [x] Create repo at `~/ishur.io`, seed with the live site
- [x] Extract base64 logos to `assets/` (476KB page → 129KB, 252KB of inline data → 46KB of files)
- [x] `config.js`: webhooks, platform ids, WhatsApp, 21 Grow links, price table, guest tiers, occasions + per-occasion package recommendation
- [x] `assets/lead.js`: shared session, validation, payload, keepalive delivery
- [x] `assets/select.js`: dropdown whose panel continues the field's own line
- [x] `assets/popup.js`: shared two-step controller, so any version runs identical logic
- [x] `assets/tracking.js`: platform loading, attribution, conversion event ids

## Phase 2 · Site v1

- [x] Strip the 10-step wizard and its dead helpers
- [x] Two-step popup: 5 fields + package picker, validation, autocomplete attributes
- [x] Marketing consent checkbox, unchecked by default, carried as `marketing_consent`
- [x] `lead_partial` on first valid phone blur, `lead_submitted` on continue, both keepalive
- [x] Grow redirect from `<guests>_<plan>`, WhatsApp fallback for מעל 600 and for any missing link
- [x] GTM + dataLayer: `popup_open`, `lead_partial`, `lead_submitted`, `payment_redirect`, variant v1
- [x] Pricing section rebuilt as a guest-tier table, every row opens the popup
- [x] `thanks.html`: Purchase event, order summary, WhatsApp fallback
- [x] Mobile RTL QA: 375 wide, no horizontal overflow, 16px inputs, draggable sheet, cookie bar no longer covers the CTA

## Phase 3 · Upload form v1

- [x] `upload.html` in the current design language
- [x] Token gate, honeypot, extension and size checks, `aria-live`
- [x] Multipart contract verified: `token` + `file` + `source`, no custom headers
- [x] Response branches verified: 200 success, 403/404 dead link, 500 retry, network error
- [x] Graceful message while `MAKE_UPLOAD_WEBHOOK` is empty, routing to WhatsApp

## Phase 4 · Tracking

- [x] Meta, TikTok, GA4 and GTM all load from `config.js`, skipped when unset
- [x] Attribution persisted 30 days: utm, fbclid, gclid, gbraid, wbraid, ttclid, msclkid, `_fbp`, `_fbc`
- [x] `_fbc` synthesized from `fbclid` when the pixel is blocked, stamped once
- [x] `event_id` + `event_name` in every payload for Conversions API deduplication
- [x] Order stashed before the Grow redirect so Purchase fires with a real value
- [x] Purchase reuses the checkout `session_id` so it joins to the lead row

## Phase 5 · Handoff

- [x] `HANDOFF.md`: file map, placeholder table, payload contract, CAPI field mapping, how to add a tier

## Parked

- [ ] **Site v2 (Invitation / "old money")** — `v2/index.html` exists and renders:
      pine ground, ivory paper cards, gold flourishes, Frank Ruhl Libre display.
      Shares `config.js` and all of `assets/`, so it stays in sync on its own.
      Paused 15.8.2026 to focus on v1. Not linked from anywhere.
      Remaining if resumed: `v2/upload.html`, `v2/thanks.html`, `terms.html`,
      mobile QA, then A/B split.

## Open on Richard

- [ ] `MAKE_UPLOAD_WEBHOOK` — not created yet, upload form is inert until filled
- [ ] `GTM_ID` and `FB_PIXEL_ID` — no container or pixel is loading yet
- [ ] Confirm `MAKE_LEAD_WEBHOOK` reuses the existing orders hook or gets its own
- [ ] Point Grow's post-payment redirect at `https://ishur.io/thanks.html`
- [ ] Make scenario should upsert `lead_partial` on `session_id`, not insert
