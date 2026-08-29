# Intent · ishur.io launch automation

## Problem
The site sells and collects payment, but nothing after payment is automatic.
A paying customer today gets no confirmation, no upload link, no sending. The
gf will do call rounds manually; everything else must run itself.

## Outcome
A customer can buy, upload a list, and have every WhatsApp message reach their
guests on schedule, with zero manual steps from Richard, and see it all in a
dashboard they log into with their phone number.

## Affected systems
- Make team 577708, folder 379970 (3 new scenarios wired to the live hooks)
  and folder 351092 (older S1-S8 scaffold to salvage or retire)
- WhatsApp Business Cloud connection "אישורי הגעה" (WABA 1060242146337688)
- Monday CRM (client record per purchase, switch-off status)
- Google Sheets (guests + events data, per the dashboard work in the gf's chat)
- Cloudflare Worker ishur-webhooks (proxy, and OTP auth to be added)
- ishur.io pages: dashboard.html gains phone+OTP login and share-access

## The flow as Richard described it (Notion)
1. Purchase -> client created in Monday with switch off; WhatsApp confirmation
   "order received, messages will go out on your dates"
2. Sends go out on the chosen dates between 09:00-20:00, no exact hour promised
3. Support number 055-950-4499 (phone A) for changes; adding guests costs
   min 20 ILS (1 guest = 20, if the per-guest sum exceeds 20 pay that)
4. Number B sends the blasts, confirms arrivals, and makes the call rounds.
   Coexistence: number A stays on a phone; number B's SIM goes into a phone
   for calls while its WhatsApp runs on the Cloud API
5. Call package: 2 dial attempts, then 2 more, then marked no-answer. Manual
   (gf) for now, AI voice later

## Constraints
- Tracking (GTM/Meta) is being handled in the gf's chat - out of scope here
- Calls stay manual - build the queue view, not the dialer
- Sending window 09:00-20:00; Shabbat never; Friday until 15:00; the 06:00
  setup cutoff already on the site stays
- Existing live scenarios in the team (EZGO etc.) must not be touched

## Open questions
1. Coexistence status: is number B already connected to the Cloud API and does
   the "אישורי הגעה" WABA belong to it? Are message templates approved (first
   contact to a guest requires an approved template)?
2. Where do guests live: the gf's dashboard chat says Google Sheets - one
   spreadsheet per event, or one sheet with an event column? Need the actual
   spreadsheet id(s) she used.
3. Grow: does the Grow webhook fire per payment with the payer's phone, and is
   the "Integration Grow" hook (folder-less, off) the one to use, or the
   ishur-grow hook the gf created?
4. Monday: which board is the ishur clients board (board id), and what does
   "switch off" map to (a status column)?
5. The old S1-S8 scaffold: salvage what works into the new folder, or rebuild
   clean and delete?
6. OTP login: code over WhatsApp from number B via the Cloud API - OK that a
   customer must be reachable on WhatsApp to log in? (No SMS fallback.)
7. Add-guests pricing (min 20 ILS): charged how - a Grow link per amount, or
   manual payment request over WhatsApp for now?
