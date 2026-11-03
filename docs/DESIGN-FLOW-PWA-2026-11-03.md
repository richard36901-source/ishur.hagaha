# Invitation design flow + dashboard PWA (03/11/26)

Branch `design-flow` (from `integ-2026-11-02` @ 52e4c55). Not deployed.

## A. Design flow in the client dashboard

Shown in `dashboard.html?t=<token>` only when the event's design is paid
(`design:<token>.status === 'paid'`, written by the ₪79 design IPN or by a package bought with design).
UI: `assets/design-card.js` (card `#designCard`, hidden by default).

### Flow
1. **"מה תרצו בהזמנה"**: free text (≤3000 chars) + up to 5 inspiration images (JPG/PNG/WebP, ≤4MB each).
   After submit the card says "נשלח, נחזור עם עיצוב ראשון"; "עריכת הבקשה" stays available until the first version is uploaded.
   Slack line on submit and on each edit.
2. **Our side** uploads a version (image or PDF) from admin.html → section "🎨 עיצוב הזמנה · העלאת גרסה".
3. **Client** sees the latest version + history, and either:
   - **מאשר/ת ✅** → status `approved` → Slack "עיצוב אושר ✅" → we mark **done** in admin.
   - **יש לי הערות ✍️** → textarea → status `changes_requested` (Slack line). The round is counted
     (`rounds_used++`) only when we upload the next version in answer to it.
   - Counter: "סבבי תיקונים: X מתוך Y", Y = 1 free + paid rounds.
   - **רכישת סבב נוסף**: the first click, while no round was bought and the included round is unused, claims
     the free round (no payment, "1/1 חינם"). Every later click creates a ₪49 Grow link; the IPN adds one round.

### State machine (`worker/design.js`)
```
new ──upload──▶ awaiting_client ──approve──▶ approved ──admin done──▶ done
                  │      ▲
          changes │      │ upload (rounds_used++)
                  ▼      │
            changes_requested
```
`changes` is refused when `rounds_used + pending ≥ rounds_free + rounds_paid` (`no-rounds-left`).
An extra upload without a client request does not burn a round. Nothing can be uploaded after approval.

### Routes (worker/index.js)
| Route | Auth | Body | Does |
|---|---|---|---|
| `POST /api/design-flow` | event token | `{token, action:'state'}` | `{paid, status, versions[], brief, rounds_*, can_request_changes}` |
| | | `{token, action:'brief', text, refs:[mediaId]}` | save brief (402 if not paid, `locked` after v1) |
| | | `{token, action:'approve'}` / `{action:'changes', comment}` | client decisions |
| | | `{token, action:'buy'}` | free round once, else `{pay:true, url}` (₪49, server price) |
| `POST /api/media` (multipart) | token, or `admin_key` | `token, purpose=design_ref\|design_version, file` | stores bytes, returns `{media:id, url}`. Without `purpose` it is the old invitation-image swap, unchanged |
| `GET /api/design-file?t=<token>&id=<id>` | key scoped by token | | serves the file (an id under another token → 404) |
| `POST /api/design-version` | `admin_key` (or `sess.` session) | `{token, media, note}` / `{action:'done'}` / `{action:'state'}` | add version / mark done / read |

### KV keys
| Key | Value | TTL |
|---|---|---|
| `design:<token>` | paid flag `{status:'paid', ref, …}` — **unchanged**, still the only "is design paid" source | 400d |
| `designbrief:<token>` | `{source:'dashboard', text, refs[], token, at}` (design.html writes its long form here too) | 400d |
| `designflow:<token>` | `{versions:[{n, media, note, at, mime}], status, rounds_used, rounds_free:1, rounds_paid, free_claimed, comments[], paid_refs[]}` | 400d |
| `dfile:<token>:<id>` | file bytes, metadata `{mime, purpose}` | 400d |
| `dfilen:<token>` | client upload counter (cap 20; a counter, never a `list()`) | 400d |
| `quote:<id>` | `{kind:'design_round', token, sum:49, code:'design_round:1'}` | 30d |
| `grow:<ref>` | `'design_round'` once granted (dedupe) | 30d |

### Price + IPN
- ₪49 per paid round, `DESIGN_ROUND_PRICE` in `worker/design.js` — the client never sends a sum.
- Grow description: "סבב תיקונים נוסף לעיצוב" (deliberately without "עיצוב הזמנה", so `isDesignPayment` never takes it).
- `cField1 = q:<id>|design_round:1|t:<token>`. `handleGrowIpn` routes it to `processGrowPayment`, which grants via
  `grantDesignRound` before any package/add-on logic: the stored quote must exist, be `kind:'design_round'`, match the
  token in cField1, and the paid sum must be ≥ 49 — else parked under `addonpark:<ref>` + alert. `/api/ipn-replay`
  takes the same path. A replayed ref is `duplicate`.

### Admin runbook: uploading a design
1. admin.html → scroll to **"🎨 עיצוב הזמנה · העלאת גרסה"** (above "שליטה").
2. Paste the event token (or the whole `dashboard.html?t=…` link) → **טעינת מצב**: shows paid/not, status, brief text,
   inspiration image links, client comments.
3. Choose the file (JPG/PNG/WebP/PDF, ≤15MB), optional note to the client → **העלאת גרסה ללקוח**.
   The client sees it on their next dashboard load. (No WhatsApp is sent; tell the client yourself if needed.)
4. After the Slack "עיצוב אושר ✅" line → **סימון "בוצע"**.
5. Errors: `design-not-paid` (no paid flag — grant/charge first), `already-approved`, `unknown-media`, 403 (key).

## B. Client dashboard PWA
- `manifest.webmanifest`: "ishur · אישורי הגעה", he/rtl, standalone, `theme_color #0F4C35` (dashboard `--green`),
  `background_color #FBF8F1`, `start_url dashboard.html?pwa=1`, `scope dashboard.html`.
- Icons `assets/icons/icon-192.png`, `icon-512.png` from `logo.png` via `node scripts/pwa-icons.mjs`
  (sharp if importable from the repo's node_modules — it is not today — else macOS `sips`; else prints manual steps).
- `sw.js`, registered **only** by `assets/pwa.js` on dashboard.html with scope `dashboard.html`, so no other page is
  controlled. Precaches the shell (dashboard.html, config.js, every local asset it loads, icons); navigations and
  `GET /api/*` are network-first with cache fallback; other same-origin GETs cache-first with background refresh;
  POSTs and cross-origin (fonts, analytics) untouched. Bump `VERSION` in sw.js to drop old caches.
- `start_url` carries no token: pwa.js stores the last `?t=` in `localStorage.ishur_pwa_t`, and dashboard.html uses it
  when opened with `?pwa=1` and no `t`.
- Card "📲 הוסיפו למסך הבית" (`#pwaCard`): iOS → share → "הוספה למסך הבית" → "הוסף"; Android/Chrome → button that
  fires the saved `beforeinstallprompt`. Hidden in `display-mode: standalone`, after install, or after "×".

## Checks
- `cd worker && node --test test/*.test.mjs` (incl. `test/design-flow.test.mjs`).
- `node scripts/design-pwa-smoke.mjs` — syntax, manifest/icons, wiring, card render for every state, sw.js routing,
  and (with Playwright) browser runs of `dashboard.html?demo=1&preview=1&designmock=brief|sent|v1|limit|approved`,
  screenshots in `docs/design-screens/` (demo data only).
