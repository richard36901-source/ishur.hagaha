# ishur.io · TASKS

Live progress file. Checked off as work lands, never pruned.

## Funnel as built (supersedes brief §5)

Two steps, then payment. Decided 15.8.2026.

**Step 1 · פרטים:** שם מלא, טלפון, אימייל (לא חובה)
**Step 2 · האירוע:** סוג האירוע, כמות מוזמנים, חבילה (המלצה מסומנת לפי סוג האירוע)
**→ המשך לתשלום:** Grow link mapped from `<guests>_<plan>`, all 21 combinations kept.

Guest tiers: 50 / 100 / 200 / 300 / 400 / 500 / 600 / מעל 600.
מעל 600 has no self-serve price, routes to WhatsApp.

**After payment:** Grow returns to `thanks.html`. No upload form there.
Make sends the tokenized `upload.html?t=<token>` link over WhatsApp once the Grow
payment webhook confirms the charge. A token cannot be reached by editing a URL.

---

## Phase 1 · Foundation

- [x] Repo audit: mapped current site (10-step wizard, 21 Grow links, 3 inline base64 logos)
- [x] Create repo at `~/ishur.io`, seed with the live site
- [x] Extract base64 logos to `assets/` (252KB of inline data → 46KB of files)
- [x] `config.js`: webhooks, GTM, WhatsApp, 21 Grow links, price table, guest tiers, occasions + per-occasion package recommendation
- [x] `assets/lead.js`: shared session/validation/payload/keepalive module, so v1 and v2 emit identical payloads
- [ ] Extract Invitation tokens from `upload.html` into `assets/invitation.css`

## Phase 2 · Site v1 (existing design, new funnel)

- [ ] Strip the 10-step wizard and its dead helpers
- [ ] 2-step popup: 5 fields + package picker, validation, autocomplete attributes
- [ ] `lead_partial` on first valid phone blur, `lead_submitted` on continue, both keepalive
- [ ] Grow redirect from `<guests>_<plan>`, WhatsApp fallback for מעל 600
- [ ] GTM + dataLayer: `popup_open`, `lead_partial`, `lead_submitted`, `payment_redirect`, variant v1
- [ ] Pricing section rebuilt around guest tier × package, every CTA opens the popup
- [ ] `thanks.html` v1
- [ ] Mobile RTL QA: 360 / 390 / 430, autofill, keyboard nav, thumb-reachable dropdowns

## Phase 3 · Upload form v1

- [ ] `upload-v1.html`: current design language, identical states and contract
- [ ] Wire to `config.js`
- [ ] Mobile RTL QA

## Phase 4 · Site v2 (Invitation)

- [ ] Landing: hero, how it works, pricing by tier, FAQ, footer with terms/privacy
- [ ] Same 2-step popup, same payloads, variant v2
- [ ] `v2/upload.html`: existing Invitation form wired to `config.js`
- [ ] `v2/thanks.html`
- [ ] Mobile RTL QA

## Phase 5 · Handoff

- [ ] `HANDOFF.md`: file map, where each placeholder is consumed, how to add a pricing tier
- [ ] Cross-version check: payloads identical except `variant`

---

## Open on Richard

- [ ] `MAKE_UPLOAD_WEBHOOK` — not created yet, upload forms are inert until filled
- [ ] `GTM_ID` — still `GTM-XXXXXXX` on the live site, no container is loading
- [ ] Confirm `MAKE_LEAD_WEBHOOK` reuses the existing orders hook or gets its own
- [ ] Grow post-payment redirect must point at `https://ishur.io/thanks.html`
