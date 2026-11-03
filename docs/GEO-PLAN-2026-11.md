# GEO plan · ishur.io in AI assistants · November 2026

Deliverable G (+ G.1) of the 01/11 brief. Author: main executer. Date: 01/11/2026.
Status: on-site patches applied on branch `main-executer` (not deployed, not committed by me).
Off-site: drafts only, nothing posted.

> ⚠️ **Read first: this file is public once deployed.** GitHub Pages serves the whole repo root,
> so `https://ishur.io/docs/AGENT.md`, `https://ishur.io/worker/index.js`, `README.md` and
> `HANDOFF.md` all answer 200 today (checked 01/11 with curl). This plan, with its draft forum
> posts and competitor notes, will be readable at `ishur.io/docs/GEO-PLAN-2026-11.md` after the
> next push. The new `robots.txt` asks crawlers to skip `/docs/`, `/worker/`, `/agent/`,
> `/scripts/` and `*.md`, but robots.txt is a request, not access control. Real fix (Richard /
> Fable): publish the site from a subfolder or a separate branch that holds only the public files.

---

## 1. What the assistants see today (evidence)

### 1.1 Prompt tests

| Assistant | Tested directly? | What I used instead |
|---|---|---|
| ChatGPT | **לא נבדק ישירות** | Claude WebSearch (Bing-like web index, US region) as a proxy for "what a web-grounded assistant retrieves" |
| Gemini | **לא נבדק ישירות** | same proxy |
| Claude | **לא נבדק ישירות** (the consumer app with web search was not available here) | same proxy |
| Perplexity | **לא נבדק ישירות** | same proxy |
| Google AI Overviews | **לא נבדק ישירות** (no Google SERP access from this session) | same proxy |

The proxy shows which pages a web-grounded assistant can find for the prompt. It does **not**
show what any of the five assistants actually answers. Results 01/11/2026, Hebrew queries:

| Prompt | Mode | ishur.io cited? | Who came up |
|---|---|---|---|
| אישורי הגעה בוואטסאפ | standard | no | nothing relevant (WhatsApp privacy articles) |
| אישורי הגעה בוואטסאפ לחתונה שירות | extended | **no** | diginet.co.il, savedate.co.il, wiwi.co.il, wedix.co.il, hzmanaplus.co.il, bamoos.co.il, attending.co.il (×2), flashback.co.il, lunsoul.com/whatsapp-guide |
| אישור הגעה לחתונה מחיר | standard | no | d.co.il, bizportal, kipa.co.il, midrag — no RSVP prices |
| אישור הגעה לחתונה מחיר | extended | **no** | wiwi.co.il/wedding-rsvp-pricing-models, savedate.co.il, **mit4mit.co.il/category/366**, **engaged.co.il** (×2), myinvite.co.il, saveadate.co.il, attending.co.il, magiimolo.co.il |
| מערכת אישורי הגעה מומלצת | standard | no | nothing relevant (government systems) |
| מערכת אישורי הגעה מומלצת | extended | **no** | mazaltov.walla.co.il, wiwi.co.il, diginet.co.il, app-checkit.co.il, myinvite.co.il (×2), flashback.co.il, kala-crm.co.il, lunsoul.com/ishur-hagaa |
| ishur.io אישורי הגעה (brand) | standard | **no** | only unrelated "ishur" (Israel entry permits) pages |
| best WhatsApp RSVP service Israel wedding | standard | no | quikrsvp, inviqo, rsvpify, savethisdate — no Israeli vendor |

**Reading:** in this index ishur.io is not retrieved even for its own brand name. Competitors
that do appear win with (a) a dedicated price article ("כמה עולה…", WiWi, MyInvite, engaged),
(b) listings on wedding directories (mit4mit category 366, engaged.co.il), (c) a free tier
(MyInvite, Lunsoul, SaveDate), (d) "recommended" lists on media sites (Walla מזל טוב).
The client who came from ChatGPT yesterday shows ChatGPT *can* surface ishur.io; this test
cannot say how often.

### 1.2 Technical audit (repo + live site, 01/11)

| Check | Finding before this patch |
|---|---|
| robots.txt (live == repo) | GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended allowed ✓. **Bug:** each AI bot had its own `Allow: /` group, and a crawler that matches a named group ignores `*`, so the AI bots were allowed into admin.html, calls.html, etc. hq/leads/live/calendar/coexist/admin.new were not listed at all. |
| AI bot fetch | `curl -A "<bot>"` on /faq.html → 200 for GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended (no Cloudflare/GitHub block). |
| llms.txt | Present, good summary. **Wrong facts:** packages named "בסיס / פרו / פרימיום" (real: בסיס / פרמיום / הכל כלול), top price "₪989" (real top: ₪1,179 for 900 records הכל כלול). No per-package prices, no offers, no new pages. |
| Homepage prices | **The price table is drawn by JS.** GPTBot / ClaudeBot / PerplexityBot do not run JS, so they saw "מחירון · בחרו כמה רשומות" and no number. |
| JSON-LD | 13 blocks, all parse. Organization thin (no description, founder, contact). Service `highPrice: 989` wrong. City/landing pages used `LocalBusiness` with no address (invalid for rich results, and a second, disconnected entity). No Review/AggregateRating — correct, none verifiable in the repo. |
| faq.html | Same wrong package names and "עד 989 ₪". Call follow-up described as if every package has calls (Basic has none). |
| hashvaa.html | Says thank-you message is only in הכל כלול; config.js puts it in פרמיום too. Competitor data dated October 2026. |
| why.html | No canonical, no description, not in sitemap. |
| terms.html | No canonical. |
| sitemap.xml | 14 URLs, no lastmod (except hashvaa), why.html missing. |
| City pages | 8 pages of ~510–550 words; tel-aviv vs haifa differ in 12 text lines. Near-duplicates: low citation value. |
| Homepage claims | "500+ אירועים · 98% שביעות רצון" — no data source in the repo. Not used in any markup. |
| Homepage title | "אישורי הגעה לאירועים" — no "וואטסאפ", no brand. |
| G.1 intents | No public page for דיילות, סידורי הושבה, שיחות, קישור לקבוצה, מתנות באשראי. No machine-readable offers. |

---

## 2. The 10 highest-leverage changes (all applied on the branch)

1. **Static, crawlable price table on the homepage** — `index.html`, inside `#pricing`, between
   `<!-- price-static:start -->` / `<!-- price-static:end -->`: a `<details class="pr-static">`
   table of all 30 prices + hostess tiers, generated from `config.js`. Collapsed by default, so
   the visual design does not change. *Why:* answers "אישור הגעה לחתונה מחיר" from our own page.

2. **Fix wrong facts everywhere** —
   `index.html` JSON-LD `highPrice` 989 → 1179; `faq.html` (JSON-LD + visible): package names
   בסיס / פרמיום / הכל כלול, "מ-50 ₪ · פרמיום מ-95 ₪ · הכל כלול מ-140 ₪ · 200 רשומות 199/279/339 ₪",
   calls only in פרמיום/הכל כלול; `hashvaa.html` thank-you in פרמיום (2 places) + `dateModified`
   2026-11-01; `llms.txt` package names and prices. *Why:* assistants quote what they read;
   a wrong number is worse than none.

3. **One Organization entity, richer** — `index.html` `#org`: `alternateName`, `legalName`
   "ריצארד טומסקי", `description`, `founder`, `email`, `contactPoint` (+972-55-950-4499,
   info@ishur.io), `knowsAbout`, `areaServed` Country. Plus `Service.hasOfferCatalog` with the
   three packages and their from-prices.

4. **City + wedding + bar-mitzvah pages point at that entity** — 10 files: `provider` was a bare
   `LocalBusiness` → now `{"@type":"Organization","@id":"https://ishur.io/#org",…}`; Service gets
   `@id`, `url`, `serviceType`; `areaServed` is a `City` (or `Country`); offer gets `url`.

5. **robots.txt: one group for all agents** — `*` + 14 named bots (GPTBot, OAI-SearchBot,
   ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User,
   Google-Extended, Googlebot, Bingbot, Applebot, Applebot-Extended, CCBot) share the same
   Disallows (all internal pages + /docs/ /worker/ /agent/ /scripts/ /*.md), `Allow: /` last.

6. **llms.txt rewritten** — correct packages, per-size prices, hostesses, gifts, contact, all
   key pages incl. the 5 new ones, and a generated "Current offers" block.

7. **Machine-readable offers from config.js (G.1)** — new `scripts/build-offers.mjs` loads
   `config.js` in a sandbox and writes: `/offers.json`, the llms.txt offers block, a JSON-LD
   `Offer` block with `validThrough` in `index.html` (`<!-- offers-ld:start/end -->`), and the
   static price table (#1). Public promo rule: only `BUNDLES` entries with an `until` date still
   in the future (today: `winter1990`, `winter1790`, "מבצע חורף"); `vip1990` and `PROMOS`
   (friend / biz codes) are never published. `--check` exits 1 if any output is stale.
   **Run `node scripts/build-offers.mjs` after every price/promo change** (and once after
   30/11, so the expired winter offer drops out — the JSON-LD `validThrough` already marks it).

8. **Five intent landing pages (G.1)** — same design system as `hatuna.html`, each with
   Service + Offer + FAQPage JSON-LD, primary CTA to order on-site, secondary CTA to WhatsApp
   055-950-4499:
   - `dayalot.html` — דיילות לאירוע (₪1,790 / ₪1,990 from `config.js`; live winter promo
     rendered from `CFG.BUNDLES` in JS)
   - `sidurei-hoshava.html` — סידורי הושבה (features read from `seating.html`)
   - `shihot.html` — שיחות למוזמנים (Shir; opening line checked in `worker/shir.js`:
     "מדברת שיר מאישורי הגעה")
   - `kishur-kvutza.html` — קישור לקבוצה / "מעטפה" (`rsvp.html?t=` + `rsvp-self`, selfreg add-on)
   - `matanot.html` — מתנות באשראי, "בקרוב" + lead form → `/api/interest`
     `{kind:'gift_credit', where:'matanot'}` (same endpoint/kind as the home-page gifts card)

9. **Internal links + sitemap** — homepage footer gains a row (השוואת מחירים + 5 new pages;
   hashvaa was not linked from the homepage at all); the 10 landing pages get a fuller footer
   with the legal line "ריצארד טומסקי, עוסק מורשה 322414905"; faq/hashvaa footers link the new
   pages. `sitemap.xml`: 20 URLs (all public pages, incl. why.html and the 5 new ones), each with
   `lastmod`.

10. **Small page fixes** — homepage `<title>` → "אישורי הגעה בוואטסאפ לחתונות ואירועים ·
    ishur.io"; `why.html` canonical + description + FAQPage ("למה קיבלתי הודעה מ-ishur.io",
    "איך מפסיקים" — answers the guest-side query that assistants get); `terms.html` canonical.

### Not done on-site (needs a decision or data)

- **City pages** stay near-duplicates. Making them citable needs real local facts (events served
  per city, typical hall lead times you actually see). I did not invent any. Options: merge into
  one "אזורי שירות" page with 301s, or add per-city data from the snapshot.
- **"500+ אירועים · 98% שביעות רצון"** on the homepage: keep only if there is a source; see §3.
- **Hostess tiers:** the brief says 1/2/3 hostesses at ₪1,790/2,390/3,090. `config.js` says 1
  hostess ≤300 records ₪1,790, 2 hostesses ₪1,990, "No third tier" (Richard 20/10). I used
  config.js. If the brief is right, change `HOSTESS.tiers` and rerun the script.
- **Reviews:** none in markup. Plan in `docs/SPEC-reviews.md`.

---

## 3. Positioning numbers (G.1) — not computed

The brief asks for "שנתיים בתחום · X אירועים · Y מוזמנים · Z% מענה" from the sheet snapshot.
I had no `admin_key` in this session and the brief says not to guess, so **no number was
computed and none was written to the site.** To fill it (read-only):

```
POST https://go.ishur.io/api/audit {admin_key, kind:'wa_out', days:730}      → Y (unique guest phones)
snapshotCached → events with ≥1 send                                         → X
wa_in replies / wa_out delivered, per event, then pooled                     → Z
```

Then replace the hero stat row in `index.html` (`500+ אירועים / 98% שביעות רצון`) with the real
three numbers, strongest first, and add them to `llms.txt` "Facts". "שנתיים בתחום" also needs a
date source (first paid event). Claims like "מובילים בתחום" are allowed by the brief; any
comparative claim ("יותר מ-X") needs evidence.

---

## 4. Off-site: where to get cited (drafts only — nothing posted)

Rules for every item: posted by Richard under his own name, with clear disclosure that he runs
ishur.io; no fake customer accounts, no fake reviews; prices "מ-50 ₪"; never the word the house rule bans
(promo = "מבצע חורף"). Forums and Reddit remove undisclosed self-promotion and assistants down-rank it.

### 4.1 Google Business Profile (highest leverage for Gemini / AI Overviews)

Service-area business (no public address), area: ישראל. Category: "Event planner" / "Wedding
service" (pick the closest Hebrew category offered). Website https://ishur.io, phone
055-950-4499, hours 09:00–20:00 Sun–Thu, Fri until 15:00.

Description (≤750 chars):

> אישורי הגעה בוואטסאפ לחתונות, בר ובת מצווה, בריתות ואירועים עסקיים. ההזמנה שלכם נשלחת לכל
> רשימת המוזמנים בוואטסאפ, האורחים מאשרים בלחיצת כפתור, מי שלא ענה מקבל תזכורת, ובחבילות
> המתאימות סוכנת AI מתקשרת למי שעדיין לא הגיב. אתם רואים בלוח בקרה חי כמה מגיעים, כמה לא ומי
> עוד לא ענה. כלול בכל חבילה: תזכורת יום לפני עם ניווט, סידורי הושבה, ניהול תקציב וקישור
> מתנות. תוספות: דיילות בכניסה לאירוע. תשלום אחד לאירוע, החל מ-50 ₪, בלי מנוי.

Services list: אישורי הגעה בוואטסאפ (מ-50 ₪) · שיחות למוזמנים שלא ענו (מ-95 ₪) · סידורי הושבה
(כלול) · דיילות לאירוע (מ-1,790 ₪). First post: the winter offer with its end date.
Then: the review request in `SPEC-reviews.md` points here.

### 4.2 Vendor directories (they already rank for "אישור הגעה לחתונה מחיר")

| Directory | Why | Action |
|---|---|---|
| mit4mit.co.il — category 366 "אישורי הגעה וסידורי הושבה" | appeared in the price query | business listing |
| engaged.co.il — "אישורי הגעה וסידורי הושבה" | appeared twice in the price query | listing |
| midrag.co.il | appears for wedding price queries | listing if the category exists |
| d.co.il (דפי זהב) | general Israeli business index | free listing |
| mazaltov.walla.co.il | "recommended RSVP" article ranks | pitch for inclusion |

Listing text (short):

> **ishur.io · אישורי הגעה בוואטסאפ**
> הזמנה בוואטסאפ לכל המוזמנים, אישור בלחיצת כפתור, תזכורות אוטומטיות, שיחות AI למי שלא ענה
> ולוח בקרה חי. סידורי הושבה וקישור מתנות כלולים. תשלום אחד לאירוע, החל מ-50 ₪, בלי מנוי.
> מחירון מלא: ishur.io · וואטסאפ: 055-950-4499

### 4.3 Hebrew wedding forums / Facebook groups

Targets: wedding Facebook groups (e.g. groups for couples planning a wedding, ask Shalev which
ones she is in), tapuz wedding forum if active, mit4mit Q&A. Only answer an existing question
about RSVP services; never open a thread to advertise.

Draft answer:

> גילוי נאות: אני ריצארד, אני מפעיל את ishur.io, שירות אישורי הגעה בוואטסאפ.
> כמה דברים שכדאי לבדוק בכל שירות, לא רק אצלנו:
> 1. משלמים לפי אירוע או לפי אישור? לפי אישור נשמע זול, אבל הסכום ידוע רק בסוף.
> 2. האם ההודעה יוצאת ממספר עסקי רשמי של וואטסאפ או מהטלפון שלכם.
> 3. מה קורה עם מי שלא ענה: רק תזכורת, או גם שיחה.
> 4. האם הלוח מראה כמה סועדים, לא רק כמה אישרו.
> אצלנו זה תשלום אחד לאירוע, מ-50 ₪, ההשוואה המלאה שעשינו (כולל מתחרים) כאן: ishur.io/hashvaa.html

### 4.4 Reddit r/Israel (English; assistants read Reddit heavily)

Only in a thread where someone asks how to manage RSVPs for an Israeli wedding/bar mitzvah:

> Disclosure: I run ishur.io, an Israeli WhatsApp RSVP service, so weigh this accordingly.
> In Israel most couples now skip paper RSVP cards and send the invitation on WhatsApp with
> "coming / not coming" buttons. Things worth comparing between services: flat price per event
> vs per confirmed guest, whether non-responders get a phone call, and whether the dashboard
> shows seat counts. Ours is a one-time payment per event starting at ₪50; there is a neutral-ish
> comparison of the main Israeli options (Lunsoul, Guini, WiWi, Attending) at ishur.io/hashvaa.html.

### 4.5 A comparison article on someone else's site

Assistants cite third-party comparisons more than vendor pages. Pitch to a wedding content site
(mit4mit magazine, Walla מזל טוב, a wedding-planner blog):

> כותרת: "אישורי הגעה בוואטסאפ ב-2026: כמה זה עולה ומה לבדוק לפני שבוחרים"
> מבנה: 4 מודלים של תשלום (חינם ידני / לפי אישור / לפי אירוע / חבילה עם שיחות) · טבלת מחירים
> ל-150, 350 ו-900 רשומות אצל 6–8 שירותים (כולל flashback, CheckIt, MyInvite, WiWi, Lunsoul,
> Attending, ishur.io) · 5 שאלות לשאול ספק · מתי שווה לשלם על שיחות.
> גילוי נאות בסוף הכתבה אם ריצארד הוא הכותב.

Before anyone publishes competitor prices: check each competitor's site the same day. The
figures I saw in search snippets (flashback 85 ₪, CheckIt from 199 ₪, Attending from 199 ₪,
hzmanaplus 300 ₪, bamoos from 55 ₪) were **not verified** on their sites.
Same goes for refreshing `hashvaa.html` (data "נכון לאוקטובר 2026").

---

## 5. Measuring it

- **Monthly prompt panel (manual, 15 min):** run the 3 prompts + "ishur.io" in ChatGPT (search
  on), Gemini, Claude (web search on), Perplexity, and a Google search (AI Overview). Log:
  cited yes/no, position, which competitor, which URL of ours. Keep in this file's appendix.
- **Referral traffic:** GA4/PostHog referrers `chatgpt.com`, `chat.openai.com`, `perplexity.ai`,
  `gemini.google.com`, `copilot.microsoft.com`, `claude.ai`. Ask every new lead "איך הגעתם?"
  (Noa already asks; add "ChatGPT / AI" as an option).
- **Bing Webmaster Tools:** submit sitemap (ChatGPT search leans on Bing's index) — Richard,
  needs login. **Google Search Console:** resubmit sitemap after deploy.

---

## 6. Verification (01/11/2026)

Pass condition (stated before building): *every JSON-LD block on every public page parses; every
public page parses with balanced tags, has a canonical and a meta description; robots.txt has only
valid directives, allows every listed AI bot on every public page and blocks admin + /docs/;
sitemap URLs == set of public (non-noindex) pages; zero new occurrences of the two banned strings (house rule 3 and the "up to 899" price phrase) in files I changed;
`build-offers.mjs --check` exits 0.*

Command: `python3 <scratchpad>/validate.py` (HTML via `html.parser` tag-balance, JSON via
`json.loads`, robots via `urllib.robotparser`, sitemap via `ElementTree`, word counts vs `git show HEAD:`).

- Attempt 1: FAIL — robots: Python's parser is first-match, so `Allow: /` before the Disallows
  let every bot into admin.html; the banned word (used in its "assumption" sense) in SPEC-reviews.md; the brief
  file (not mine) gained one occurrence from the coordinator's G.1 edit.
- Fix: Disallows first, `Allow: /` last (correct under both first-match and longest-match);
  reworded SPEC-reviews; excluded the coordinator's brief from my word check.
- Attempt 2: **PASS** — 20 public pages, 20 JSON-LD blocks parsed, 9 user-agents checked,
  sitemap 20/20, 29 changed files clean. Pre-existing: index.html has the banned word 4× ("קיבלתם ..." in the
  promo popup (lines ~2238, 2289, 2903)) — not added by me, but it breaks the house rule.
- `node scripts/build-offers.mjs --check` → all 3 targets "up to date", exit 0.
- Negative tests: the HTML checker flags `<div><section><p>x</div>`; `json.loads` flags a
  trailing comma.
- Visual: `dayalot.html` at 375px and the homepage price table at 375px rendered in the browser;
  no horizontal overflow (`scrollWidth 375 == innerWidth`), the live winter promo renders from
  config.js on dayalot.

**Not proven:**
- Any effect on ChatGPT / Gemini / Claude / Perplexity / AI Overviews. None were queried
  directly; the proxy search only shows retrieval in one web index.
- Google Rich Results / Schema.org validator were not run (no network access to them from here);
  JSON-LD is syntactically valid, not certified eligible.
- The new pages were not tested on real iOS Safari; the gifts lead form was not submitted
  (a submit writes to the production RATE KV, which the brief forbids).
- Nothing is deployed; live robots.txt / llms.txt are still the old versions until the push.
