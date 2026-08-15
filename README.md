# ishur.io

Hebrew WhatsApp RSVP service. Static site, no build step, served by GitHub Pages
at [ishur.io](https://ishur.io).

| File | What it is |
|---|---|
| `index.html` | the site |
| `upload.html` | guest list upload, then event setup. Opens from a tokenised link |
| `dashboard.html` | what the customer sees afterwards. `#demo` renders sample data |
| `thanks.html` | where Grow returns after payment |
| `terms.html` | terms of use and privacy policy |
| `config.js` | every id, link, price and rule. The only file you normally edit |
| `assets/` | shared js and the marks |
| `worker/` | Cloudflare proxy that keeps the Make URLs off the public site |

Read [`HANDOFF.md`](HANDOFF.md) before changing anything, and
[`SENDING-LOGIC.md`](SENDING-LOGIC.md) for when each message goes out.

After editing anything in `assets/` or `config.js`, bump the `?v=` on the script
tags. GitHub Pages caches, and a stale `config.js` sends buyers to the wrong
payment link.
