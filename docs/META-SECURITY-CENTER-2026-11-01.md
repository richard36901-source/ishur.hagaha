# Security Center: 4 פריטים שמחכים לך (ריצארד לוחץ, אני לא שיניתי כלום)

נכנסים ל-business.facebook.com/latest/settings/security_center ובוחרים את התיק **Ishur.io** (1888051741895896).

| # | פריט | איפה לוחצים | מה להזין או לעשות | מי מושפע | חוסם אימות עסק? |
|---|---|---|---|---|---|
| 1 | אין trusted domains | Security Center ← **Peer approval** ← **Domain security** ← Manage ← מזינים דומיין ← Add domain ← Confirm | **`ishur.io`** בלבד | כל המודעות בתיק. מודעה עם URL שהוא לא ishur.io תחכה לאישור של trusted user | **לא** לפי המאמרים שבדקתי. Meta לא מצהירה על זה במפורש ← **לא מאומת** |
| 2 | חשבון מודעות בלי ad account security | Security Center ← **Peer approval** ← **Ad account security** ← Manage ← בוחרים חשבון ← רמת הגנה ← בוחרים מאשרים ← Save | **`ishur.io - מודעות` (act_1944903292858482)** ← **Default protection**. רק מודעות חשודות ידרשו אישור, כך שלא תצטרך ללחוץ על כל מודעה | חשבון המודעות היחיד בבעלות התיק (נבדק ב-API) | **לא** לפי המאמרים שבדקתי ← **לא מאומת** |
| 3 | משתמש אחד בלי passkey | המשתמש עצמו: Accounts Center ← Password and security ← **Passkeys** ← Create. אחר כך חוזרים ל-Security Center ומרעננים | ליצור passkey במכשיר אישי, לא במכשיר משותף | **לא ידוע.** ה-API לא מחזיר את רשימת האנשים (ראו למטה). Security Center מראה את השם בלחיצה על הפריט | **לא** ← **לא מאומת** |
| 4 | שני משתמשים עם מייל ציבורי (gmail וכו') | Settings ← **People** ← בוחרים את המשתמש ← בודקים את המייל | **לא להסיר בלי לבדוק קודם.** אם אחד מהם הוא ריצארד (‎richard…@gmail.com) והוא היחיד עם full control, הסרה תנעל אותך מחוץ לתיק. המלצה: להשאיר, או לעבור למייל ‎@ishur.io כשיהיה כזה. Meta ממליצה להסיר ([608572510632070](https://www.facebook.com/business/help/608572510632070)), אבל זו המלצה ולא חובה | **לא ידוע מה-API** (ראו למטה) | **לא** ← **לא מאומת** |

**trusted domains, למה רק ishur.io:** `dig +short autoscale.co.il` מחזיר תשובה ריקה (גם לרשומות A, www, NS ו-MX). המחרוזת `autoscale.co.il` מופיעה ב-repo רק בבריף, ולא ב-`config.js` או ב-README. לכן **לא ממליץ** עליו. `ishur.io` נפתר ל-185.199.108–111.153 (GitHub Pages).

**המשתמשים, פלט גולמי** של `/api/ads {path:'/1888051741895896/business_users?fields=name,email,role'}`:
```
{"ok":true,"status":200,"data":{"data":[],"paging":{"cursors":{...}}}}
```
הרשימה ריקה. הטוקן שייך ל-`Conversions API System User` (role `EMPLOYEE`, עם `business_management` granted), ומשתמש מערכת מסוג EMPLOYEE לא רואה אנשים. ניסיתי גם `/api/meta-admin channel:'guests'` ← אותה רשימה ריקה. בטוקן ברירת המחדל קיבלתי `403 (#200) Requires business_management permission`. בנוסף, `pending_users` מחזיר `[]`. **בפועל לא יודע מי שני המשתמשים**, ולכן אין מיילים למסך כאן.

**פריט שלא ברשימה אבל כן משפיע על האימות:** לפי הבריף, תיבת "סוג השימוש באימות" ב-Security Center עדיין לא נבחרה. כדאי לבחור בה ערך. פרטים ב-`docs/META-SUPPORT-TICKET-2026-11-01.md`.

**מקורות:** [Add another review of your ads with peer approval](https://www.facebook.com/business/help/529947753306370) (מסלולי הלחיצה לפריטים 1 ו-2). [Best practices for making a business portfolio more secure](https://www.facebook.com/business/help/608572510632070) (פריטים 3 ו-4). [About business verification](https://www.facebook.com/business/help/1095661473946872): מה שהמאמר מגדיר כדרישות לאימות הוא ישות רשומה, טלפון או כתובת רשמיים, וקוד בטלפון, במייל או בדומיין. **אף אחד מארבעת הפריטים לא מופיע שם.** מכאן ה"לא" בעמודה האחרונה. אבל Meta לא כותבת במפורש שהם לא חוסמים, ולכן "לא מאומת".

**לא הוכח:** שמות הכפתורים בממשק בעברית (לא נכנסתי). מי שני המשתמשים ומי המשתמש בלי passkey. שהוספת trusted domain לא תעצור מודעה פעילה עם URL חיצוני. כדאי לבדוק את ה-URLs של המודעות הפעילות לפני שלוחצים Confirm.
