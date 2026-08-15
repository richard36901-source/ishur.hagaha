# ishur.io · handoff

Static site, no build step. Open a file, edit, push. GitHub Pages serves it as is.

## Files

```
index.html        the site. Landing page + the two-step order popup.
upload.html       guest list upload, then event setup. Needs a valid ?t= token.
dashboard.html    what the customer sees afterwards. Same token.
thanks.html       where Grow returns after payment.
config.js         every id, link, price and rule. The only file you normally edit.
assets/
  tracking.js     ad platforms, attribution, conversion event ids
  lead.js         session, phone validation, payload, delivery
  select.js       the dropdown whose panel continues the field
  datepicker.js   Hebrew calendar, enforces the sending rules
  messages.js     the four message tones and a sample per event type
  popup.js        the two-step order popup controller
  logo.png        navy mark, for light backgrounds
  logo-light.png  white mark, for the dark footer
  favicon.png
v2/index.html     parked. Second design ("Invitation") for A/B testing, not finished.
```

Load order matters and is the same on every page:
`config.js` → `tracking.js` → `lead.js` → `select.js` → `popup.js`.

## Where each placeholder is consumed

Everything lives in the `FILL ME` block at the top of `config.js`.

| Key | Consumed by | What breaks while it is empty |
|---|---|---|
| `MAKE_LEAD_WEBHOOK` | `lead.js` → `send()` | Leads are not recorded. The funnel still works and still redirects to payment. |
| `MAKE_UPLOAD_WEBHOOK` | `upload.html` step 1 | Upload shows "ההעלאה עדיין לא מחוברת" and points the customer to WhatsApp. **Currently empty.** |
| `MAKE_STATUS_WEBHOOK` | `dashboard.html` | Dashboard says it is not connected yet and points to WhatsApp. Everything else still works. |
| `MAKE_CHANGE_WEBHOOK` | `dashboard.html` date edits | Falls back to `MAKE_SETUP_WEBHOOK`; if both are empty the change is sent over WhatsApp instead. |
| `MAKE_SETUP_WEBHOOK` | `upload.html` step 2 | Falls back to `MAKE_UPLOAD_WEBHOOK`; if both are empty the setup step says so and points to WhatsApp. Can be the same URL, the payload is tagged `event_type: "event_setup"`. |
| `GTM_ID` | `tracking.js` → `loadGTM()` | No GTM container loads. `dataLayer` still fills, so nothing is lost once you add the id. |
| `FB_PIXEL_ID` | `tracking.js` → `loadMeta()` | No browser-side Meta events. Server-side via Make still works. |
| `TIKTOK_PIXEL_ID` | `tracking.js` → `loadTikTok()` | No TikTok events. Optional. |
| `GA4_ID` | `tracking.js` → `loadGA4()` | Only used when `GTM_ID` is empty. With GTM set, GTM owns GA4. |
| `WHATSAPP_NUMBER` | `config.waLink()`, used everywhere | Nothing, it is already set. |
| `SUPPORT_EMAIL` | `[data-mail]` links | Nothing, already set. |
| `TEMPLATE_URL` | `upload.html` | The "sample file" row stays hidden. |
| `GROW_LINKS` | `config.growLink()` | A missing pair routes to WhatsApp instead of a dead page. All 21 are filled. |

Nothing is hardcoded outside `config.js`. If you find a URL or id in a page, that is a bug.

## The funnel

1. Any element with `data-order="<where>"` opens the popup. No inline handlers.
2. Step 1: name, phone, email, marketing consent.
3. Step 2: occasion, guest count, package. Picking an occasion pre-selects the
   package from `OCCASIONS[].rec`, and the customer can override it.
4. `המשך לתשלום` redirects to `GROW_LINKS['<guests>_<plan>']`.
5. Grow returns to `thanks.html`, which fires Purchase and tells the customer to
   watch WhatsApp.
6. Make sends the tokenized `upload.html?t=<token>` link over WhatsApp, only
   after Grow's payment webhook confirms the charge.

**Step 6 is the security boundary.** The upload form is never linked from the
site and shows nothing without a token, so it cannot be reached by editing a URL.
Do not add a link to it from `thanks.html`.

### What the customer does on the token link

`upload.html` is two steps.

**Step 1, the guest list.** The file is read **by column position, not by header
text**, so the order is the contract and the page states it plainly:

| Column | Holds | Required |
|---|---|---|
| A | name of the guest or family, as it appears in the message | yes |
| B | Israeli mobile, 05X | yes |
| C | how many people that invitation covers | no, defaults to 1 |

Column C is what makes the totals mean chairs rather than invitations. One row
"משפחת כהן / 0521234567 / 4" is a single WhatsApp covering four seats, and the
guest's reply is capped at that number.

**Step 2, the event setup.** Occasion, names, event date, reception time, venue,
message tone, and the send dates. Posted as JSON:

```json
{
  "event_type": "event_setup",
  "token": "…",
  "occasion": "bar", "occasion_label": "בר מצווה",
  "name1": "דניאל", "name2": "",
  "event_date": "2026-09-10", "reception_time": "19:30",
  "venue_name": "…", "venue_addr": "…", "venue_city": "…",
  "style": "respectful",
  "send_date_1": "2026-08-25", "send_date_2": "2026-09-01",
  "notes": "", "source": "…", "ts": "…"
}
```

`style` is one of `happy`, `serious`, `respectful`, `playful`. The wording for
each lives in `assets/messages.js`, and the customer picked it from a live
preview of that exact text, so send what they were shown.

## The dashboard

After the setup saves, `upload.html` sends the customer straight to
`dashboard.html?t=<token>` in the same tab. That is also the page to link from
any later WhatsApp message.

`dashboard.html?demo=1` renders the whole thing with sample data and no
webhook, which is the quickest way to see it.

**This is the only webhook that has to answer.** The other two receive data and
nothing is read back. This one is asked a question, so the Make scenario needs a
**Webhook response** module at the end. Without one, Make replies `Accepted` in
plain text and the dashboard reports that it is not returning data yet.

The scenario shape:

1. Custom webhook, receives `{ "token": "..." }`
2. Search the events sheet for `upload_token = token`
3. No match, respond 404 with `{"ok":false}`
4. Search guests by `event_id`, aggregate the counts
5. Webhook response, status 200, body the JSON below, content type
   `application/json`

Make already sends `Access-Control-Allow-Origin: *`, so the browser can read the
reply. Nothing extra to configure for CORS.

**The token is the only credential.** Anyone holding it sees that event's guest
list, which is the point, but it means tokens must be long and random, must
never appear in a public sheet or a shared screenshot, and an unknown token must
answer 404 rather than an empty success.

It POSTs `{token}` to `MAKE_STATUS_WEBHOOK` and expects:

```json
{
  "ok": true,
  "event": {
    "name1": "נועה", "name2": "יונתן",
    "occasion": "wedding",
    "event_date": "2026-12-10", "reception_time": "19:30",
    "venue_name": "אולם הגן הקסום", "venue_city": "רמת גן",
    "plan": "pro", "guests_tier": "300"
  },
  "totals": {
    "invitations": 240,
    "confirmed": 150, "confirmed_seats": 380,
    "declined": 30, "pending": 60,
    "awaiting_call": 42
  },
  "sends": [
    { "key": "invite",   "label": "ההזמנה ואישור ההגעה", "date": "2026-11-10", "status": "sent" },
    { "key": "reminder", "label": "תזכורת למי שלא ענה",  "date": "2026-12-03", "status": "scheduled" },
    { "key": "event_day","label": "תזכורת עם הכתובת",    "date": "2026-12-10", "status": "scheduled", "auto": true },
    { "key": "day_after","label": "הודעת תודה",          "date": "2026-12-11", "status": "scheduled", "auto": true }
  ],
  "guests": [
    { "name": "משפחת כהן", "phone": "0521234567", "status": "confirmed", "seats": 4 }
  ]
}
```

`status` on a guest is one of `confirmed`, `declined`, `pending`,
`awaiting_call`. `status` on a send is `sent` or `scheduled`; `auto: true`
marks the ones derived from the event date, which the customer cannot move.

**Moving a send.** Only a send that is `scheduled`, not `auto`, and still
passes the calendar rules shows a change button. It POSTs to
`MAKE_CHANGE_WEBHOOK`:

```json
{ "event_type": "send_date_change", "token": "…", "send": "reminder",
  "date": "2026-12-04", "ts": "…" }
```

Re-check the 06:00 rule server-side before accepting it. The browser enforces
it, but the browser is not the authority.

**Add-ons.** Every add-on other than the extra send is offered here rather than
during setup. `calls` shows how many guests are waiting for one, and stops
being offered inside 14 days of the event. No add-on ever shows a price until
`ADDON_PRICES` and `ADDON_LINKS` are filled; until then the button opens
WhatsApp with the request written out.

## Locking down the webhooks

**Start from what is true: the three URLs are in `config.js`, and anyone can
read them.** Nothing on the page hides that. Someone who reads `assets/guard.js`
can reproduce every stamp it makes. What follows raises the cost of abuse and
makes it trivial to filter; it is not a secret.

### What the page sends

Every request carries four extra fields:

| Field | Meaning |
|---|---|
| `app` | `ishur-web` |
| `nonce` | random per page load |
| `stamp_ts` | epoch **milliseconds** at page load |
| `sig` | `sha256(appKey + "|" + nonce + "|" + stamp_ts)` |

On the file upload these ride as form fields alongside `token` and `file`.

### The filter to add in Make

First module after each of the three webhooks, before anything writes:

```
sha256( APP_KEY + "|" + nonce + "|" + stamp_ts )   equals   sig
AND   now − stamp_ts  <  24 hours        (stamp_ts is epoch ms)
```

`APP_KEY` is `GUARD.appKey` in `config.js`. Anything failing that filter was not
sent by the page. Drop it before it costs a row, a message or an operation.

**Rotating `appKey` invalidates every stamp at once.** That is the lever to pull
if the URLs start getting hit: change it in `config.js`, bump `?v=`, change it in
the Make filter.

### What the page already refuses to send

Enforced in `assets/guard.js`, tuned in `GUARD` in `config.js`:

- a submit within **2.5 seconds** of page load, which is most naive bots
- more than **8 leads, 6 uploads, 8 setups, 12 date changes, 60 status reads**
  per browser per hour
- the **same payload twice** inside two minutes, which is what a stuck retry or
  a leant-on button produces

A blocked attempt fires a `blocked` dataLayer event with the reason, so a real
customer hitting a limit is visible rather than silent.

A `purchase` is deliberately exempt from the caps. It is the record of money
changing hands and fires once on a page the customer has just landed on.

### What this does not stop

Someone who reads `guard.js` can mint valid stamps and post at will. The caps
live in that browser's `localStorage` and a fresh incognito window resets them.

**The real fix is to stop publishing the URLs.** ishur.io is already on
Cloudflare, so a Worker sitting at `ishur.io/api/*` can hold the Make URLs as
secrets, rate limit by IP, and let `config.js` point at your own domain. That is
roughly thirty lines and turns all of the above into a genuine boundary rather
than a speed bump.

## Sending rules

Set once in `SEND_RULES` in `config.js` and enforced inside the calendar, so an
impossible date cannot be clicked rather than being rejected afterwards:

- `setupCutoffHour: 6` — the batch leaves at 06:00. To go out on a given day the
  setup has to be finished before 06:00 that morning. Tomorrow stays available
  until 06:00 tonight; from 06:00 the earliest becomes the day after.
- `blockedWeekdays: [6]` — no sending on Saturday at all.
- `cutoff: { 5: '15:00' }` — Friday sends leave before 15:00. Fridays are marked
  with a dot in the calendar rather than blocked.

These apply to the send dates. The **event date itself** uses
`data-idate="free"` and allows any future day including Saturday, because plenty
of events are on מוצאי שבת.

Change the hour or the blocked days in `config.js` and the calendar, the legend
and the warning text all follow.

### Guests over 600

No self-serve price. The package cards show "הצעה אישית", the button becomes
"לשיחה בוואטסאפ", and the lead is still sent before the handoff, so you keep it.

## Payloads

`POST` JSON to `MAKE_LEAD_WEBHOOK`, `keepalive` so the request survives the
redirect to Grow. Never blocks the customer: a webhook failure is swallowed and
payment proceeds.

Four `event_type` values: `lead_partial`, `lead_submitted`, `purchase`, plus
whatever `IshurLead.track()` pushes to `dataLayer` (that stays in the browser).

```json
{
  "event_type": "lead_submitted",
  "session_id": "uuid",
  "variant": "v1",
  "name": "נועה כהן",
  "phone": "0521234567",
  "email": "",
  "occasion": "בר מצווה",
  "occasion_key": "bar",
  "guest_range": "עד 200 מוזמנים",
  "guests": "200",
  "plan": "pro",
  "plan_name": "פרמיום",
  "price": 219,
  "marketing_consent": true,
  "page": "https://ishur.io/",
  "ts": "2026-08-15T12:00:00.000Z",
  "utm_source": "facebook",
  "utm_medium": "",
  "utm_campaign": "weddings_aug",
  "fbclid": "...", "fbc": "fb.1.1786.....", "fbp": "",
  "landing_page": "...", "referrer": "", "first_seen": "...",
  "user_agent": "...",
  "event_id": "uuid",
  "event_name": "InitiateCheckout"
}
```

Rules worth knowing:
- `phone` is always normalized to 10 digits starting `05`. `+972` and dashes are
  handled before sending.
- `session_id` is minted when the popup opens and is the same across
  `lead_partial`, `lead_submitted` and `purchase`. Join on it.
- `lead_partial` fires once per session, the first time the phone field holds a
  valid number and loses focus. Partial rows should upsert, not insert.
- `price` is `null` when the guest tier is `custom`.

## Feeding conversions back to Meta

Each conversion carries `event_id` and `event_name`. The browser already fired
that event with the same id.

**In Make: send the same `event_name` to the Conversions API with the same
`event_id`.** Meta then counts one conversion instead of two, and still receives
it when the browser pixel is blocked, which on iOS is often.

Send these to the CAPI, hashed with SHA-256 where Meta requires it:

| CAPI field | From the payload |
|---|---|
| `event_name` | `event_name` |
| `event_id` | `event_id` |
| `event_source_url` | `page` |
| `user_data.ph` | `phone`, prefixed `972` and stripped of the leading 0, then hashed |
| `user_data.em` | `email` lowercased, then hashed (skip when empty) |
| `user_data.fbc` / `fbp` | `fbc` / `fbp`, sent raw, never hashed |
| `user_data.external_id` | `session_id`, hashed |
| `user_data.client_user_agent` | `user_agent` |
| `custom_data.value` / `currency` | `price` / `"ILS"` |

Funnel mapping: `ViewContent` on popup open, `Lead` on first valid phone,
`InitiateCheckout` on continue, `Purchase` on `thanks.html`.

The authoritative Purchase is the one Make sends from Grow's payment webhook.
The browser copy on `thanks.html` exists so Meta gets it fast; the shared
`event_id` keeps them from double counting.

Attribution is kept in `localStorage` for 30 days, so a purchase that lands back
from Grow is still tied to the ad that caused it. First touch wins for UTMs, last
click wins for click ids.

## How to change prices

`PRICE_TABLE` in `config.js`. Both the pricing table on the page and the popup
read from it. Nothing else to touch.

## How to add a guest tier

1. Add a row to `GUEST_TIERS`, for example `{ value: '800', label: 'עד 800 מוזמנים' }`.
   Keep `custom` last.
2. Add the matching row to `PRICE_TABLE`: `800: { basic: …, pro: …, premium: … }`.
3. Create three Grow links and add them to `GROW_LINKS` as `800_basic`,
   `800_pro`, `800_premium`.

The pricing table, the popup dropdown and the payment mapping all pick it up.
Miss step 3 and that tier routes to WhatsApp rather than breaking.

## How to change which package is recommended

`OCCASIONS[].rec` in `config.js`. One word per occasion.

## Consent

The marketing checkbox ships **unchecked**, and it must stay that way. Israeli
anti-spam law wants explicit prior opt-in, and a pre-ticked box is not that. Send
marketing only to rows where `marketing_consent` is `true`.

## Before going live

- [ ] Fill `MAKE_UPLOAD_WEBHOOK`, or the upload form cannot accept files
- [ ] Fill `GTM_ID` and `FB_PIXEL_ID`
- [ ] Point Grow's post-payment redirect at `https://ishur.io/thanks.html`
- [ ] Confirm whether `MAKE_LEAD_WEBHOOK` should stay on the existing orders
      hook or get its own scenario
- [ ] Check the Make scenario upserts `lead_partial` on `session_id`

## After you edit config.js or anything in assets/

Bump the `?v=` on the script tags in `index.html`, `upload.html`, `thanks.html`
(and `v2/index.html` if you resume it). They all carry `?v=1` today.

GitHub Pages caches assets, so without a bump some visitors keep running the old
`config.js` for a while. That matters most for payment links: a stale config
sends someone to the wrong Grow page. One find-and-replace of `?v=1` to `?v=2`
across those files is the whole job.

## Notes

- No build step, no framework, no dependencies. Fonts come from Google Fonts.
- Everything is RTL and mobile-first. The popup becomes a draggable sheet under
  640px.
- Motion respects `prefers-reduced-motion`, `prefers-reduced-transparency` and
  `prefers-contrast`.
- `v2/` is a parked second design for A/B testing. It shares `config.js` and all
  of `assets/`, so it stays in sync automatically. It is not linked from
  anywhere and is not finished.
