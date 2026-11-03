# Sales flow on Noa (4499) · 03/11/2026

Deterministic lead qualification. No AI (Noa AI stays off). Code: `worker/salesflow.js`; glue in `worker/index.js` (`salesCtx`, `salesDeps`); pricing in `worker/paylink.js`. Tests: `worker/test/salesflow.test.mjs`, `worker/test/salesflow-routes.test.mjs`, `scripts/prefill-smoke.mjs`.

## The two switches (ops center → node "נועה · זרימת מכירה ללידים" → עריכה)

| cfg key | default | what it does | typed confirm |
|---|---|---|---|
| `sales_flow` | off | the flow answers a lead's inbound messages (questions → design question → one offer). Never writes first. | `sales_flow` |
| `sales_followups` | off | our own initiative: one nudge per question (60–150 min, random), the no-reply fallback offer (~2h after the second nudge), two check-ins after the offer (20–26h, then +48h). | `sales_followups` |

Both are in the cfg whitelist (`worker/cfg.js` SETTINGS). Env fallbacks: `SALES_FLOW=on`, `SALES_FOLLOWUPS=on`. Off = no-op.

## Who gets it
- A **new** lead (number unknown to KV/sheet) whose first message has an occasion and/or a number ("חתונה 650"), or a Meta-form lead's first inbound.
- Never: `client:` phones, a phone with an event in the sheet, a guest of an upcoming event, test/admin phones. Re-checked by the tick before every send.
- Once per phone (`sfseen:<phone>`, 180 days). State `sf:<phone>`, 7-day TTL.

## Rules
- Free text only, inside the 24h window. Window closed → nothing sent, Slack line, flow stops. No templates, ever.
- 09:00–21:00 Israel, no Shabbat. Outside: the reply is parked in `sf:<phone>.pending` and the 10-minute pacer sends it at the next opening (same due/drain shape as `noaq:`).
- Before **every** automated message: Monday item notes + updates and the CRM (`leadx:`) notes are read (cached 10 min, `sfmon:<phone>`). A human note newer than the lead's last inbound (or a changed notes column) → not sent, Slack "ליד X: יש עדכון ידני במונדי/CRM, הזרימה נעצרה", flow `paused`. "לא לפנות" / "סגר" / "שילם" / "לא רלוונטי" → flow ends. Facts in notes ("2 דיילות", a date, a city) prefill but never override the lead's explicit answer. Resume: `POST /api/sales-flow-resume {admin_key, phone}` (`peek:true` to read the state).
- "ריצארד" / "נציג" / "תתקשרו אליי" / a question the parser cannot read → flow stops, Slack "ליד מבקש אדם", one reply. After the offer, "בשיחה"/"נציג"/"תתקשרו" is the phone option → same handoff.
- "הסר" / "לא רלוונטי" / "לא מעוניינים" → flow stops, no flow reply (the normal opt-out handler answers "הסר").
- A price question ("כמה עולה בלי שיחות?", "כמה עולה דיילת?") → that one number, then the flow goes on. "כמה עולה?" at the start → the questions with one line first.
- One offer, one number, only after the answers.

## Pricing (server-side, `paylink.priceQuote`)
- Records tier = the next tier up from their number (650 → 700). Over 900 → a person.
- Plan: no calls → בסיס, 1 round → פרמיום, 3 rounds → הכל כלול. Fallback offer: בסיס / פרמיום, never הכל כלול.
- Hostesses wanted: under 300 records 1, 300+ records 2 (global rule; config.js, hostess-check, paylink).
- Hostesses wanted while a bundle is live → the offer IS the bundle (winter1990 400–800 · 2 hostesses ₪1,990; winter1790 50–200 · 1 hostess ₪1,790; vip1990 300–500 · 2 hostesses ₪1,990), הכל כלול, design free ("עיצוב ההזמנה במתנה"). Nothing above ₪1,990 is quoted while the bundles run: hostesses with no bundle for the size (900) → a person.
- No hostesses → plan by the calls rule + design ₪79 if wanted.

## Messages (exact)

**1 · questions** (if the number is unknown, a 4th line "4. כמה מוזמנים בערך?" is added; unknown occasion → "האירוע")
```
היי 🙂 נשמח לעזור עם החתונה! כמה שאלות קצרות, ונתאים לכם הצעה אחת מדויקת:
1. חוץ מהזמנות ותזכורות בוואטסאפ, תרצו שנציגה שלנו גם תתקשר למי שלא ענה?
2. תרצו דיילת בקבלת הפנים ובסידורי ההושבה ביום האירוע?
3. מתי האירוע ואיפה?
```
Price asked in the first message: `המחיר תלוי בחבילה שמתאימה לכם, אז נתאים לכם הצעה אחת מדויקת 🙂` above it.

**2 · design**
```
תודה! ודבר אחרון: יש לכם הזמנה מוכנה, או שתרצו שנעצב לכם אחת?
```

**3 · offer** (Hormozi order: dream outcome → how it works → [proof, only with a real count via `deps.proofCount`, not wired yet] → value stack as benefits → risk line → [tip] → price last with the bundle label → urgency from `BUNDLES[..].until` → one CTA → the agreed closing). Risk line is what terms.html actually promises (no refunds; failed delivery is fixed and resent). Copy lives in `OFFER_COPY` / `INCLUDED` in salesflow.js; snapshot test `offer snapshot, demo …`.

Demo: 650 guests, 1 call round, hostesses yes, design yes
```
אתם מגיעים לאירוע בראש שקט, עם מספר סופי מדויק של מי שמגיע.
איך זה עובד: אתם מעלים רשימה, אנחנו עושים את השאר. ההזמנה יוצאת בוואטסאפ, מי שלא ענה מקבל תזכורת, ואתם רואים כל אישור בזמן אמת.

מה אתם מקבלים:
• הזמנה בוואטסאפ עם תמונה או וידאו, והאורחים מאשרים בלחיצה אחת
• תזכורת אוטומטית למי שלא ענה, בלי שתצטרכו לרדוף אחרי אף אחד
• תזכורת יום לפני עם ניווט בוויז, כדי שכולם יגיעו בזמן
• ביום האירוע כל אורח מקבל את מספר השולחן שלו
• קישורי מתנה בביט ופייבוקס, ישר מהטלפון של האורחים
• סידורי הושבה וניהול תקציב במקום אחד
• לוח בקרה בזמן אמת, 24/7, כדי שתדעו בכל רגע איפה אתם עומדים
• 3 סבבי שיחות של נציגה למי שלא ענה, כדי שאף אחד לא ייפול בין הכיסאות
• הודעת תודה לאורחים יום אחרי האירוע, בשמכם
• הודעת דחייה או ביטול אם צריך, בלי להתקשר לכל אחד
• 2 דיילות בקבלת הפנים ביום האירוע, מגיעות שעה לפני ומושיבות את האורחים
• עיצוב ההזמנה במתנה
• עד 700 רשומות (מספר טלפון = רשומה)

אנחנו איתכם עד הסוף: הודעה שלא הגיעה, מתקנים ושולחים שוב.

לפי מה שבחרתם, הכי משתלם לכם מבצע החורף: הכל כלול + 2 דיילות ב-₪1,990.
ועיצוב ההזמנה במתנה 🎁
מבצע החורף עד 30/11.

כדי לבצע את ההזמנה תוכלו לעשות את זה כאן בקישור, או בשיחה טלפונית מול נציג:
https://ishur.io/?offer=winter1990&guests=700&hostess=2&design=1&occasion=wedding&date=2027-03-15&city=%D7%97%D7%99%D7%A4%D7%94&name=%D7%93%D7%A0%D7%94+%D7%9B%D7%94%D7%9F&phone=0501234567&src=noa
הפרטים שלכם כבר מולאו חלקית, כך שהורדנו מכם עוד משהו 🙂 ותכף נוריד מכם גם את אישורי ההגעה, כדי שתוכלו להתעסק במה שבאמת חשוב באירוע.
```
Without hostesses (same answers):
```
אתם מגיעים לאירוע בראש שקט, עם מספר סופי מדויק של מי שמגיע.
איך זה עובד: אתם מעלים רשימה, אנחנו עושים את השאר. ההזמנה יוצאת בוואטסאפ, מי שלא ענה מקבל תזכורת, ואתם רואים כל אישור בזמן אמת.

מה אתם מקבלים:
• הזמנה בוואטסאפ עם תמונה או וידאו, והאורחים מאשרים בלחיצה אחת
• תזכורת אוטומטית למי שלא ענה, בלי שתצטרכו לרדוף אחרי אף אחד
• תזכורת יום לפני עם ניווט בוויז, כדי שכולם יגיעו בזמן
• ביום האירוע כל אורח מקבל את מספר השולחן שלו
• קישורי מתנה בביט ופייבוקס, ישר מהטלפון של האורחים
• סידורי הושבה וניהול תקציב במקום אחד
• לוח בקרה בזמן אמת, 24/7, כדי שתדעו בכל רגע איפה אתם עומדים
• סבב שיחות של נציגה למי שלא ענה
• הודעת תודה לאורחים יום אחרי האירוע, בשמכם
• עיצוב הזמנה מקצועי, בלי לחפש מעצב
• עד 700 רשומות (מספר טלפון = רשומה)

אנחנו איתכם עד הסוף: הודעה שלא הגיעה, מתקנים ושולחים שוב.

טיפ קטן: חבילת פרמיום (סבב שיחות אחד) מתאימה בדרך כלל לקהל צעיר שעונה בעיקר בוואטסאפ. אם יש הרבה מוזמנים מבוגרים, אנחנו ממליצים על הכל כלול (3 סבבי שיחות), כדי לוודא שכולם יודעים על האירוע. אתם מכירים את האורחים הכי טוב, ואפשר לשנות בקישור 🙂

לפי מה שבחרתם: חבילת פרמיום ל-700 רשומות (כולל שיחות למי שלא ענה) + עיצוב הזמנה = ₪898.

כדי לבצע את ההזמנה תוכלו לעשות את זה כאן בקישור, או בשיחה טלפונית מול נציג:
https://ishur.io/?plan=pro&guests=700&design=1&calls=1&occasion=wedding&date=2027-03-15&city=%D7%97%D7%99%D7%A4%D7%94&name=%D7%93%D7%A0%D7%94+%D7%9B%D7%94%D7%9F&phone=0501234567&src=noa
הפרטים שלכם כבר מולאו חלקית, כך שהורדנו מכם עוד משהו 🙂 ותכף נוריד מכם גם את אישורי ההגעה, כדי שתוכלו להתעסק במה שבאמת חשוב באירוע.
```
Fallback offer (sales_followups on, no answer to the design question): opens with "הכנו לכם הצעה לפי מה שסיפרתם 🙂" on its own line, same body.

**handoff** `ריצארד יחזור אליכם בהקדם 🙂` · **nudge** `רק מזכירים 🙂 ברגע שתענו נשלח הצעה מדויקת` · **after the offer** `היי 🙂 רק בודקים אם ההצעה ברורה, ואם יש שאלה אני כאן` then `אם נוח יותר בטלפון, תגידו מתי ונתקשר` · **price answer tail** `ונשמח לתשובות לשאלות למעלה, כדי לשלוח לכם הצעה אחת מדויקת 🙂`

On the offer: lead status → `leadx:<phone>` "נשלח פרטים" + a note with the offer and link; `lead:<phone>.sf_status = quoted`; Slack line; activity log.

## Site prefill link (part A)
```
https://ishur.io/?plan=basic|pro|premium&guests=<tier>&hostess=0|1|2&design=1&calls=1&occasion=wedding|hina|bar|bat|brit|bday|chalaka|chala|biz|other&date=YYYY-MM-DD&city=&name=&phone=05XXXXXXXX&src=noa
https://ishur.io/?offer=winter1990|winter1790|vip1990&guests=<tier>&design=1&occasion=&date=&city=&name=&phone=&src=noa   (bundle)
```
Opens the purchase popup with everything filled, nothing locked. Totals from config.js tables (no promo overlay on `?plan=`). `calls=1` with `plan=basic` opens on פרמיום. Payment:
- no hostesses + design → `POST /api/quote-from-site` (stamped, 8/h per IP) → server-priced Grow link, `cField1 = q:<id>|pkg:…;design:1;…` → the IPN grants design (`design:<token>`), the quote is marked paid, Monday lead closed by the existing path.
- hostesses (with or without a bundle) → the existing `/api/hostess-check` link, now carrying `design` (free in a bundle, ₪79 otherwise) and the pkg code in cField2.
- neither → the fixed Grow page, as before.

## Untrusted lead text (prompt-injection hardening, 03/11)
Lead text is data, never instructions. `injectionCheck()` runs on every inbound before any state is read or written: "forget/ignore previous instructions", "you are now…", system prompt / jailbreak / DAN, admin / admin link / password / token / api key / cField, other clients' data or someone else's guest list, `javascript:` / `<script` / `onerror=` / iframe. On a hit: one reply `לא בטוחה שהבנתי 🙂 תרצו שריצארד יחזור אליכם?` (lead hours only; outside them, Slack only), a Slack 🛡️ note with the text de-fanged (no `<>@*`, links → `[link]`), `sfinj:<phone>` for 24h. `sf:` / `sfseen:` are not touched. A "כן"/human word as the next message → the normal Richard handoff.
- Name: `sanitizeName()` — NFKC, control/format chars and emojis stripped, only letters/marks/space/`'-.`, ≤ 40, empty if it reads like an instruction or a URL. It is the only free text that reaches the link, the quote or the Grow code.
- Everything else the lead writes is mapped onto fixed sets: occasion keys, `CITIES`, ISO dates, records tiers. Guests: 20–3000 (`saneGuests`), applied to the parser, `ctx.guests` and `buildOffer`.
- Slack echoes of lead text go through `slackSafe`.
