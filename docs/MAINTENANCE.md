# ishur.io · מדריך תחזוקה

עודכן 20/10/2026. קובץ אחד שמסביר איפה כל דבר, איך פורסים, ומה עושים כשמשהו נופל.

## 1. המפה בקצרה

| רכיב | איפה | מה עושה |
|---|---|---|
| אתר + לוחות | GitHub Pages מ-`main` (ishur.io) | כל ה-HTML בשורש: אתר שיווקי, לוח לקוח (`dashboard.html`), העלאה (`upload.html`), ניהול (`hq.html`, `admin.html`, `clients.html`, `leads.html`, `calendar.html`, `calls.html`, `inbox.html`, `ops.html`, `brain.html`, `ad-report.html`) |
| Worker | Cloudflare `ishur-webhooks` → `go.ishur.io` (`worker/`) | כל הלוגיקה: תשלומים, וואטסאפ, שיחות, מנוע יומי, לוחות, חשבוניות, מודעות |
| KV | namespace `05a171c6b3cb46f2af7cc72b1ac19f14` (binding `RATE`) | מצב: מי קיבל, מי ענה, תורים, מטמונים, דגלים |
| הגיליון | Google Sheets `1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q` | מקור האמת: אירועים, אורחים, לידים, לקוחות, יומן |
| Make | eu1.make.com · team 577708 · תיקייה 379970 | כותב לגיליון (1 · תשלום Grow, 2 · העלאות/תוצאות, 3 · קריאת דשבורד) ומעביר לידים מהאתר |
| וואטסאפ | Meta Cloud API · נועה 4499 (לקוחות ולידים) · שיר 6673 (אורחים בלבד) | חוק ברזל: 6673 לאורחים בלבד, 4499 ללקוחות ולידים |
| שיחות | Retell (סוכנים שיר/נועה) + Telnyx (SIP) | פרומפטים מנוהלים ב-`/api/voice-prompt` עם גרסאות ו-rollback |
| חשבוניות | Morning (api.morning.co OAuth2 + api.greeninvoice.co.il/api/v1) | `worker/invoice.js` |
| לידים | Monday board 18432553641 + `leads.html` | `worker/monday.js`, `worker/leads.js` |
| מודעות | Meta act_1944903292858482 · הקמפיין שלנו 120250009883070731 · של שלו 120250670197650731 (קריאה בלבד) | `runAdReview`, `adsHealth` ב-index.js |

## 2. פריסה

```bash
# Worker (כל שינוי ב-worker/)
cd ~/ishur.io/worker && node --check index.js && npx -y wrangler deploy

# אתר/לוחות: הקבצים נמצאים בענף העבודה; מפרסמים ל-main
cd ~/ishur.io && git worktree add /tmp/m main && cp <files> /tmp/m/ && cd /tmp/m && git add -A && git commit -m "..." && git push origin main
```

- כל שינוי ב-`config.js` או ב-`assets/*.js` → להעלות את `?v=` בדפים שטוענים אותו, אחרת הדפדפן מגיש גרסה ישנה.
- סודות: `npx wrangler secret put <NAME>` (רשימה בסעיף 6). משתנים לא-סודיים ב-`wrangler.toml [vars]`.

## 3. מבנה הקוד (worker/)

| קובץ | שורות | תחום |
|---|---|---|
| `index.js` | ~10.7k | הראוטר (`fetch`), הקרונים (`scheduled`), וכל הזרימות. חלוקה לפי כותרות `/* ══ … ══ */` (ראו סעיף 4) |
| `lib.js` | 120 | עזרים משותפים: `normPhone`, `isAdmin`, `okJson/deny/cors`, `kvPrefix`, `seenOnce`, `sha256Hex`, `isTestPhone`, `sendingPaused` |
| `slack.js` | 130 | סלאק: `slackPost` (עם שכבת quiet), `slackSend`, שעות שקט ותור לילה, `alert` |
| `ads.js` | 230 | מטא: בריאות חשבון המודעות, CAPI, `metaAds`, דוחות; הקמפיין של שלו קריאה בלבד |
| `whatsapp.js` | 600 | שליחה/קבלה בוואטסאפ, בחירת מספר (`clientOnPortfolio`, `pickPhone`), פענוח תשובות אורח |
| `shir.js` | 670 | שיר: חלונות שליחה/חיוג, payload לרטל, פתיחים, אימות חתימת webhook |
| `dashboard.js` | 340 | בניית snapshot ללוח הלקוח + סטטיסטיקות עסק (`buildBizStats`) — פונקציות טהורות, ניתנות לבדיקה ב-node |
| `leads.js` | 240 | לוח הלידים: פענוח שורות, מיזוג עם KV, סטטוסים/בעלים/קבוצות |
| `invoice.js` | 130 | מורנינג: טוקן OAuth2, חשבונית מס-קבלה |
| `monday.js` | 90 | upsert ליד למאנדיי (מפת עמודות ב-KV `monday:cols:*`) |
| `promo.js` | 380 | קודי הנחה וקמפיינים (`/api/promo`) |
| `evlog.js` | 180 | היומן (גיליון "יומן") — `logEvent` ו-`readLogTail` |
| `sheetlogs.js` | 300 | לוגים לגיליון לפי הודעה/שיחה |
| `traffic.js` | 220 | מונה תנועה לאתר |
| `design.js`, `parse.js` | קטנים | הזמנות עיצוב; פענוח תיאור רכישה |

## 4. מפת הסקשנים ב-index.js (לפי שורה, 20/10)

51 עלות הודעה · 90 תשלומי Grow · 133 מתג ראשי (pause) · 168 שעות שקט סלאק · 716 לידים שנטשו · 814 לידים מטופס מטא · 1193 העלאות · 1805 רשימה בוואטסאפ · 1954 שיר יוצאת · 2016 סשן ניהול · 2407 שיר נכנסת · 2654 שיחת מכירה (לא מחוברת) · 2899 וואטסאפ נכנס (כפתורי RSVP) · 3429 שירות לקוחות · 4023 תזכורות "כמה תהיו" · 4080 מנוע יומי · 5061 פייסר · 5282 הרופא · 5408 תזכורות צוות · 5479 גיבוי · 5536 אינבוקס · 5798 כניסה בקוד · 5853 הושבה · 5906–5948 הוצאות · 6005 כיבוי AI · 6053 המוח · 6114 Retell proxy · 6140 פרומפטים מגורסים · 6407 סקירה יומית · 6523 לולאת שיפור · 6744 ביצועי הודעות · 6901 שליחה מחדש · 6966 עלות שיחות · 7010 פקדים · 7079 שומר חיוב · 7239 שינוי תאריך · 7315 Meta proxy · 7402 מודעות · 8008 לוח כסף · 8165 ניטור שיחות · 8246 שליחה · 8429 go.ishur.io · 8524 `export default` (scheduled / fetch)

`grep -n "^/\* ══" worker/index.js` מחזיר את המפה העדכנית.

## 5. קרונים (UTC)

| cron | מה |
|---|---|
| `*/10 * * * *` | הפייסר: גלים ב-25 לפעימה, חיוגי שיר, תורים (נועה, תזכורות כמות, לידים), בריאות מודעות (שעתי), לידים מטופס מטא |
| `35 6 * * *` | המנוע היומי (09:35 חורף / 08:35 קיץ בישראל): דוחות, תזכורות, גלים, OTP לפורטפוליו |
| `0 4 * * *` | הרופא + גיבוי + ניקוי |
| `0 9,10,16 * * 2` | תזכורות צוות (שלישי) |
| `0 17/18/19 * * *` | לולאת שיפור + דוח יומי (20:00 ישראל, שעון קיץ/חורף) |

## 6. סודות ומשתנים (wrangler)

סודות: `WA_TOKEN`, `WA_TOKEN_GUESTS`, `WA_VERIFY`, `WA_VERIFY_GUESTS`, `WA_PHONE_ID`, `WA_PHONE_ID_GUESTS`, `HOOK_STATUS`, `HOOK_EVENTS`, `HOOK_LEADS`, `HOOK_GROW`, `BRAIN_HOOK`, `GROW_LINK_HOOK`, `GROW_API_KEY/GROW_USER_ID/GROW_PAGE_CODE`, `RETELL_KEY`, `RETELL_WEBHOOK_KEY`, `TELNYX_KEY`, `META_ADS_TOKEN`, `MONDAY_API_TOKEN`, `MORNING_ID`, `MORNING_SECRET`, `LINEAR_API_KEY`, `SLACK_ALERT_HOOK`, `ADMIN_KEY`, `APP_KEY`, `SHIR_FROM`, `TEST_PHONES`, `HOSTESS_CAL_ICS`.
משתנים (toml): `CLIENT_PORTFOLIO`, `WA_PHONE_ID_CLIENT_NEW`, `NOA_*`, `SHIR_INBOUND_AGENT`, `ADMIN_PHONES`, `SLACK_RICHARD/SHALEV`, `SLACK_VERBOSE` (1 = גם הודעות שקטות).

## 7. פעולות שגרה (admin_key נדרש)

| מה | איך |
|---|---|
| השהיית כל השליחות / חידוש | `POST /api/pause {paused:true|false}` |
| ביקורת שליחות | `POST /api/wave-audit` — לכל אירוע חי: נשלחו/ענו/מתים/חסרים |
| תקרת 24 שעות (שיר) | `POST /api/cap-status` — used/limit, מתי נפתח (`bic:*` ב-KV) |
| תשלום שלא נכתב לגיליון | `POST /api/ipn-replay {payload:{...grow fields, _force:true, _token:"<token>"}}` (שומר את הטוקן שהלקוח קיבל) |
| חשבונית שלא הופקה | `POST /api/evlog {action:"invoice-make", token, phone, name, sum, ref, plan, tier, send:false}` |
| בדיקת מורנינג | `POST /api/evlog {action:"morning-check"}` |
| פרומפט של שיר/נועה | `POST /api/voice-prompt {agent:"shir_out|shir_in|noa_out|noa_in", action:"get|save|rollback"}` |
| מצב מספר וואטסאפ | `POST /api/meta-admin {channel:"guests|client", path:"/<phone_id>?fields=health_status"}` |
| לידים מטופס מטא | `POST /api/meta-leads {dry:true}` |
| יומן | `POST /api/evlog {n:300}` · `{action:"flush"}` |

## 8. דגלים ומפתחות KV שחשוב להכיר

`paused` (הכל עצור) · `hold:<token>` (אירוע בהשהיה — "ביטול לקוח") · `wacap:guests` (המספר של שיר בתקרת 250, הגלים ממתינים) · `wsent/wfail/wdead/wferr:<token>:<wave>:<phone>` (מצב כל הזמנה) · `optout:<phone>` · `awaitparty:<guest_id>` (ממתינים לכמות + תזכורות) · `grow:<ref>` (dedupe תשלום) · `token:<token>` · `paid:<token>` · `hostess:<token>` · `monday:cols:<board>` (מפת עמודות; למחוק כדי לרענן) · `snapcache` (snapshot ל-60 שניות) · `vp:<agent>:<n>` + `vpmeta:<agent>` (גרסאות פרומפט).

## 9. תקלות נפוצות

| סימפטום | סיבה שראינו | מה לעשות |
|---|---|---|
| "לא נמסרה 131042" מנועה | חשבון התשלום של מטא חסום (AutoScale) | המעבר לתיק Ishur.io (CLIENT_PORTFOLIO) — דורש ניתוק המספר מהאפליקציה בטלפון |
| "Spam Rate limit 131048" בשיר | תקרת 250 שיחות/24ש (עסק לא מאומת) | אוטומטי מ-20/10: הגל ממתין; לטווח ארוך — אימות עסק |
| לקוח שילם ולא מופיע | סצנריו 1 ב-Make נפל (חיבור ישן) | לבדוק את תור ה-webhook ב-Make; `ipn-replay` עם `_force` |
| לוח לקוח 404 "event-not-found" | אין שורת אירוע בגיליון | כנ"ל |
| מורנינג auth-failed | endpoint/מפתח | `morning-check`; מפתח חדש ב-app.greeninvoice.co.il → כלי מפתחים |
| "המנוע היומי לא רץ" ביום ראשון | פער שישי-שבת | אזעקת שווא — תוקן 18/10 |
| לידים → מאנדיי נכשל "column ID doesn't exist" | עמודה נמחקה בלוח | למחוק `monday:cols:18432553641` ב-KV |

## 10. כללי שינוי

1. `node --check` לפני כל deploy; לבדיקות: `node --test worker/*.test.mjs` כשקיימות.
2. שינוי התנהגות ללקוח = שורה ביומן + הודעת סלאק אחת (לא לכל אורח).
3. אין הודעות ללקוחות 21:00–09:00; אין שליחה לאורחים בשבת/חג (`isNoContactDay`).
4. כל עמודה חדשה בגיליון = לעדכן את חוזה העמודות ב-`dashboard.js` (ראש הקובץ).
5. הקמפיין של שלו — לקרוא בלבד.
