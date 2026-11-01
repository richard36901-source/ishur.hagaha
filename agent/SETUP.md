# ishur-agent · הקמה (ריצארד)

**מצב:** הקוד בנוי ונבדק (42 בדיקות עוברות). **לא נפרס**, כי אין עדיין טוקן בוט של סלאק, signing secret ומפתח Anthropic.
כתיבה כבויה (`AGENT_WRITE = "off"`): הסוכן רק קורא ומדווח. 🟡 ו-🔴 חסומות בקוד עד שמשנים ל-`on` ופורסים שוב.

---

## חלק א׳ · סלאק (5 קליקים)

1. **api.slack.com/apps → Create New App → From a manifest** → בוחרים את סביבת העבודה **RTHQ** → מדביקים את כל התוכן של `agent/slack-app-manifest.json` → **Create**.
   (סלאק יתריע שכתובת האירועים לא מאומתת. זה צפוי: ה-Worker עוד לא קיים. מאמתים בשלב 8.)
2. **Install to Workspace → Allow.**
3. **OAuth & Permissions** → מעתיקים את **Bot User OAuth Token** (מתחיל ב-`xoxb-`).
4. **Basic Information → App Credentials → Signing Secret → Show** → מעתיקים.
5. בערוץ **#ishur-hagaa** כותבים: `/invite @claude`

## חלק ב׳ · מפתח Claude

6. **console.anthropic.com → API Keys → Create Key** (שם: `ishur-agent`) → מעתיקים.

## חלק ג׳ · פקודות (ריצארד או Fable, מתוך `agent/`)

```bash
cd ~/ishur.io/agent

# KV נפרד לסוכן. לא ה-RATE של המנוע.
npx wrangler kv namespace create AGENT_KV
#   → להדביק את ה-id שהודפס ב-wrangler.toml במקום REPLACE_WITH_AGENT_KV_ID

npx wrangler secret put SLACK_BOT_TOKEN        # להדביק xoxb-… (שלב 3)
npx wrangler secret put SLACK_SIGNING_SECRET   # שלב 4
npx wrangler secret put ANTHROPIC_API_KEY      # שלב 6
npx wrangler secret put AGENT_ADMIN_KEY < ~/.ishur-keys/admin.txt
# אופציונלי, למשימות ליינר (🟡): LINEAR_API_KEY, LINEAR_TEAM_ID

node --test test/*.test.mjs                    # חייב להיות: pass 42, fail 0
npx wrangler deploy                            # AGENT_WRITE="off" = קריאה בלבד
curl -s https://ishur-agent.richardtomskiy.workers.dev/health
#   חייב להחזיר: "write":"off" וכל ה-has: true
```

7. (אחרי הפריסה) **api.slack.com/apps → claude → Event Subscriptions → Retry** ליד ה-Request URL. אמור להופיע **Verified ✓**.

## חלק ד׳ · בדיקת קבלה

ב-#ishur-hagaa: `@claude מה יוצא מחר?`
- **עובר אם:** תוך דקה מגיעה תשובה **באותו שרשור**, בעברית, 2–4 שורות, והיומן של go.ishur.io מראה קריאה ל-`/api/automations`.
  אם תוצר A (`/api/automations`) עוד לא נפרס, הסוכן יקבל 404 ויחזור ל-`daily_run_dry` של מחר. זה מצב ביניים, לא מעבר בדיקה.
- את קישור השרשור מדביקים ב-`docs/REVIEW-main-executer.md`.

---

## איך ההרשאות עובדות (נאכפות בקוד: `src/gate.js`, טבלה: `src/tools.js`)

| דרג | דוגמאות | מה קורה |
|---|---|---|
| 🟢 | audit, stream, cap-status, wave-audit, delivery-report, call-board, automations, daily-run **dry**, event-day dry, call-round dry, meta/ads GET | מתבצע לכל מי שבערוץ |
| 🟡 | השהיית אירוע (hold on), ביטול סבב מתוזמן, תחזוקת יומן, mutation במאנדיי (בלי מחיקה), קישור תשלום, משימת ליינר | רק אם `AGENT_WRITE=on` ורק לריצארד/שלו. מתבצע ומדווח בשרשור |
| 🔴 | כל דבר ששולח לאורחים/לקוחות/לידים, wave-retry, הרצת מנוע אמיתית, event-day/call-round set/run, עריכת אורח, כתיבה למטא/מודעות, קוד מבצע | **לעולם לא מיד.** הודעת אישור עם כפתור **"אשר"**. רק ה-Slack ID של ריצארד (`U0BTHU91Z3N`) יכול לאשר. שלו יכולה לבקש. מתבצע פעם אחת, רק אם ה-hash של התוכן לא השתנה, ורק בין 09:00 ל-21:00 |

**חשוב:** גם `wave-retry` עם `dry:true` הוא 🔴. ה-handler ב-`worker/index.js:9566` מוחק מפתחות `wfail/wdead/wferr/gday/wave` וכותב `pacer:pending` ב-RATE לפני שהוא בודק את `dry`.

## מה לא מכוסה / סיכונים ידועים

- `AGENT_ADMIN_KEY` הוא מפתח האדמין המלא של go.ishur.io. השער מגביל מה הסוכן קורא לו, אבל מי שמשיג את המפתח מתוך ה-Worker מקבל אדמין מלא. עדיף בהמשך מפתח נפרד לסוכן, וזה דורש שינוי ב-`isAdmin` של ה-Worker הראשי.
- KV אינו טרנזקציוני: שתי לחיצות "אשר" באותה שנייה בדיוק יכולות תאורטית לרוץ פעמיים. הסטטוס `executing` נכתב לפני הביצוע כדי לצמצם את זה.
- כל קריאת אדמין של הסוכן נרשמת ביומן של go.ishur.io (שורת `admin`, "Claude · …"). זו התנהגות קיימת של ה-Worker הראשי.
- הבדיקה ש-`runDailyEngine` במצב dry לא כותב ל-KV נעשתה בדגימה (כל ה-`RATE.put` שנבדקו מוגנים ב-`!dry`), לא בקריאה מלאה של כל המנוע.

## להדליק כתיבה (רק אחרי ריוויו)
ב-`wrangler.toml`: `AGENT_WRITE = "on"` → `npx wrangler deploy`. לכבות: חזרה ל-`"off"` ופריסה.
