# ishur.io webhook proxy

Keeps the three Make URLs off the public site and enforces the guard stamp,
origin and a per-IP budget before a request can cost a Make operation.

## Deploy

```bash
cd worker
npx wrangler login

npx wrangler secret put HOOK_LEADS     # the leads webhook URL
npx wrangler secret put HOOK_EVENTS    # the events webhook URL
npx wrangler secret put HOOK_STATUS    # the status webhook URL
npx wrangler secret put APP_KEY        # GUARD.appKey from config.js

npx wrangler deploy
```

Deploy prints a URL like `https://ishur-webhooks.<subdomain>.workers.dev`.

## Switch the site over

In `config.js`:

```js
var USE_PROXY  = true;
var PROXY_BASE = 'https://ishur-webhooks.<subdomain>.workers.dev';
```

Bump `?v=` on the script tags and push. The Make URLs can then be deleted from
`config.js` entirely, which is the whole point.

## Rate limits, optional but worth it

Without KV the counters live in Worker memory and reset when the instance
recycles. With KV they hold properly:

```bash
npx wrangler kv namespace create RATE
```

Paste the id into `wrangler.toml`, uncomment the block, deploy again.

## Routes

| Path | Forwards to | Budget per IP |
|---|---|---|
| `/api/lead` | leads webhook | 12 / hour |
| `/api/event` | events webhook | 20 / hour |
| `/api/status` | status webhook | 120 / hour |

## A note on ishur.io/api/*

Serving this from the domain itself needs the DNS record proxied through
Cloudflare (orange cloud). It is currently DNS-only, pointing straight at
GitHub Pages, so the `workers.dev` URL is the safe option and changes nothing
about how the site is served.
