# פנייה לתמיכת Meta: אימות עסק תקוע (הכנה בלבד, לא נשלח)

הוכן 01/11/2026. שום דבר לא נשלח, שום הגדרה לא שונתה. ריצארד שולח בעצמו.

## 0. מה Meta מחזירה היום (קריאות GET בלבד, פלט גולמי)

כל הקריאות: `POST https://go.ishur.io/api/meta-admin` או `/api/ads` עם `admin_key` (לא מוצג), `method: GET`.

**(א) העסק** `/api/meta-admin {channel:'guests', path:'/1888051741895896?fields=verification_status,name'}`
```
{"ok":true,"status":200,"data":{"verification_status":"pending","name":"Ishur.io","id":"1888051741895896"}}
```

**(ב) ה-WABA** `/api/meta-admin {channel:'guests', path:'/1378764257421712?fields=name,account_review_status,business_verification_status,ownership_type,health_status,timezone_id'}`
```
{"ok":true,"status":200,"data":{"id":"1378764257421712","name":"בן - דיגיטל אונליין","timezone_id":"70","account_review_status":"APPROVED","business_verification_status":"pending","ownership_type":"CLIENT_OWNED","health_status":{"can_send_message":"BLOCKED","entities":[{"entity_type":"WABA","id":"1378764257421712","can_send_message":"AVAILABLE"},{"entity_type":"BUSINESS","id":"1888051741895896","can_send_message":"BLOCKED","errors":[{"error_code":141010,"error_description":"The Business has not passed business verification.","possible_solution":"Visit business settings and start or resolve the business verification request."},{"error_code":141015,"error_description":"You have reached the limit for business-initiated conversations for this 24 hour rolling period.","possible_solution":"You can start more conversations as soon\n          as one or more active conversations end."}]},{"entity_type":"APP","id":"1084149031015902","can_send_message":"AVAILABLE"}]}}}
```

**(ג) המספרים ב-WABA** `/api/meta-admin {channel:'guests', path:'/1378764257421712/phone_numbers?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,status,code_verification_status,throughput,platform_type'}` (ה-paging cursors הושמטו)
```
{"ok":true,"status":200,"data":{"data":[{"display_phone_number":"+972 55-972-6673","verified_name":"אישורי הגעה לאירועים","quality_rating":"GREEN","messaging_limit_tier":"TIER_250","name_status":"AVAILABLE_WITHOUT_REVIEW","status":"CONNECTED","code_verification_status":"EXPIRED","throughput":{"level":"STANDARD"},"platform_type":"CLOUD_API","id":"1107514695777584"},{"display_phone_number":"+972 55-308-9799","verified_name":"Ishur.io","quality_rating":"UNKNOWN","messaging_limit_tier":"TIER_250","name_status":"AVAILABLE_WITHOUT_REVIEW","status":"CONNECTED","code_verification_status":"VERIFIED","throughput":{"level":"STANDARD"},"platform_type":"CLOUD_API","id":"1409632775565601"}], ...}}
```

**(ד) מספר 6673 לבד** `/api/meta-admin {channel:'guests', path:'/1107514695777584?fields=display_phone_number,messaging_limit_tier,quality_rating,health_status'}` (מקוצר: רק ישות PHONE_NUMBER. ישויות BUSINESS ו-WABA זהות ל-(ב))
```
{"entity_type":"PHONE_NUMBER","id":"1107514695777584","can_send_message":"BLOCKED","can_receive_call_sip":"BLOCKED","errors":[{"error_code":141012,"error_description":"The phone number has reached the limit for business-initiated conversations.", ...},{"error_code":138024,"error_description":"WhatsApp Business calling cannot use SIP because it is not enabled", ...}],"additional_info":["Your display name has not been approved yet. Your message limit will increase after the display name is approved."]}
```

**מה מאומת מזה:** סטטוס האימות `pending`. 6673 ב-`TIER_250` עם איכות `GREEN`. ברמת העסק מופיעים 141010 + 141015. ב-6673 עצמו מופיע 141012, ובנוסף ההערה "display name has not been approved yet". שתי סתירות שכדאי שריצארד יכיר לפני השליחה: ה-API מחזיר `name_status: AVAILABLE_WITHOUT_REVIEW` למרות ההערה הזו, ושם ה-WABA הוא "בן - דיגיטל אונליין" עם `ownership_type: CLIENT_OWNED`. אלה לא נושאי הפנייה, אבל נציג של Meta עלול לשאול עליהם.

**מה לא מאומת:** תאריך ההגשה המדויק. ה-API לא מחזיר אותו, ו"~שבועיים" לקוח מהבריף. גם תיבת "סוג השימוש באימות" שעוד לא נבחרה (לפי הבריף) לא נבדקה, כי ה-API לא חושף אותה.

## 1. הדרך לפתוח פנייה (לפי מאמרי עזרה של Meta. את הממשק עצמו לא ראיתי)

**לפני הכול:** ב-Security Center צריך לבחור ערך בתיבת סוג השימוש באימות, אם היא באמת עדיין ריקה. בקשה שלא הושלמה יכולה להיראות "בבדיקה" בלי לזוז. זו השערה, לא מאומת.

**מסלול א' (כללי, Meta Business):**
1. נכנסים ל-business.facebook.com/business-support-home (Business Support Home) מחוברים כריצארד, ובוחרים את התיק **Ishur.io**.
2. אפשרות נוספת: Meta Business Help Center, ואז **Get support** בפינה הימנית העליונה. המקור הוא [Recover a hacked or compromised business portfolio](https://www.facebook.com/business/help/25302697499431030), שמתאר את שני מסלולי הכניסה האלה.
3. בוחרים נושא שקשור ל-Business verification, מדביקים את הטקסט מסעיף 2 ושולחים. שמות הנושאים בתפריט לא מאומתים.

**מסלול ב' (WhatsApp Business Platform, Direct Support):**
1. נכנסים ל-business.facebook.com/direct-support, ואז **Ask a question**.
2. Topic: **WABiz: Onboarding**. את סוג הבקשה בוחרים לפי מה שמופיע. המסלול הזה מתועד ב-[Troubleshoot partner-led business verification submissions](https://www.facebook.com/business/help/907136494249328), אבל שם הוא מתואר לאימות דרך שותף. **לא מאומת** שהוא זמין לעסק ישיר כמו שלנו.

מאמרי רקע: [About business verification](https://www.facebook.com/business/help/1095661473946872), [Official documents to upload](https://www.facebook.com/business/help/159334372093366), [Why documents were not sufficient](https://www.facebook.com/business/help/1893666784936805). דף [Verify your business](https://www.facebook.com/business/help/2058515294227817) קיים, אבל רק הכותרת שלו נטענה.

## 2. טקסט הפנייה

### English (to send)
> **Subject:** Business verification pending ~2 weeks – WhatsApp messaging blocked (Business ID 1888051741895896)
>
> Hello,
>
> Our business portfolio **Ishur.io** (Business ID **1888051741895896**) submitted business verification about two weeks ago (around mid-October 2026). As of 1 November 2026 the status is still **pending** (Graph API `verification_status: "pending"`), and Security Center shows the verification for Richard Tomskiy as "In review".
>
> Impact on our WhatsApp Business Account **1378764257421712**:
> - Business-level health status is **BLOCKED** with error **141010** ("The Business has not passed business verification") and **141015** (business-initiated conversation limit reached).
> - Phone number **+972 55-972-6673** (phone number ID 1107514695777584) has GREEN quality but is stuck at messaging limit **TIER_250**. It returns error **141012** and the note "Your display name has not been approved yet".
>
> We are an Israeli WhatsApp RSVP service for weddings and events (https://ishur.io), registered as a licensed dealer (עוסק מורשה) no. **322414905**. Event hosts upload their own guest list and we send them the invitation and reminders on the host's behalf. With the 250 limit we cannot deliver all invitations and reminders for events already booked, and we have had to spread sends across days and a second number.
>
> Could you please review our verification, tell us whether any document or information is missing, and confirm what we need to do to complete it? We can provide our business registration certificate and other documents right away.
>
> Thank you,
> Richard Tomskiy – Ishur.io – info@ishur.io – +972 55-950-4499

### עברית (תרגום לריצארד, לא לשליחה)
> **נושא:** אימות העסק ממתין כשבועיים, שליחת וואטסאפ חסומה (מזהה עסק 1888051741895896)
>
> שלום,
>
> תיק העסק **Ishur.io** (מזהה **1888051741895896**) הגיש בקשה לאימות עסק לפני כשבועיים (בערך באמצע אוקטובר 2026). נכון ל-1 בנובמבר 2026 הסטטוס עדיין **ממתין**, וב-Security Center מופיע "אימות עבור ריצארד טומסקי · בבדיקה".
>
> ההשפעה על חשבון הוואטסאפ העסקי **1378764257421712**:
> - ברמת העסק המצב **חסום**, עם שגיאה **141010** (העסק לא עבר אימות) ושגיאה **141015** (הגעתם לתקרת השיחות שהעסק יוזם).
> - המספר **+972 55-972-6673** באיכות ירוקה, אבל תקוע על תקרה של **250**. מופיעה בו שגיאה **141012** וההערה "שם התצוגה עדיין לא אושר".
>
> אנחנו שירות ישראלי לאישורי הגעה בוואטסאפ לחתונות ואירועים, עוסק מורשה **322414905**. בעלי האירוע מעלים את רשימת המוזמנים שלהם, ואנחנו שולחים להם הזמנה ותזכורות בשמם. בתקרה של 250 אנחנו לא מצליחים לשלוח את כל ההזמנות והתזכורות לאירועים שכבר נסגרו, ונאלצנו לפזר את השליחה על פני כמה ימים ועל מספר שני.
>
> נבקש שתבדקו את האימות, תגידו לנו אם חסר מסמך או מידע כלשהו, ותאשרו מה עלינו לעשות כדי להשלים אותו. נוכל לשלוח מיד תעודת עוסק ומסמכים נוספים.
>
> תודה, ריצארד טומסקי

לפני השליחה ריצארד ממלא: תאריך ההגשה המדויק (נמצא ב-Security Center). צריך גם לבדוק שהאיות "Richard Tomskiy" זהה לאיות שמופיע ב-Business Info.

## 3. צ'קליסט מסמכים לעוסק מורשה ישראלי

לפי [Official documents to upload](https://www.facebook.com/business/help/159334372093366): עברית היא שפה נתמכת. המסמכים צריכים להוכיח שם משפטי וגם כתובת או טלפון רשמיים. לא מקבלים מסמכים שהעסק מילא בעצמו או מסמכים שפג תוקפם. חשבון חשמל, מים וכדומה מתקבל רק לכתובת ולטלפון, ורק כשהשם המשפטי מופיע עליו.

- [ ] **תעודת עוסק מורשה** ממע"מ (רשות המסים) עם המספר 322414905. זה מסמך הרישום הראשי.
- [ ] **אישור ניהול ספרים** או **אישור ניכוי מס במקור** מרשות המסים: מסמך מס ממשלתי שלא מולא על ידי העסק.
- [ ] **דף חשבון בנק עסקי** על שם העוסק, עם כתובת.
- [ ] חשבון חשמל, מים או טלפון על שם העוסק, רק אם הכתובת לא מופיעה בתעודה.
- [ ] להשחיר את מספר תעודת הזהות אם הוא לא נדרש. לא להשחיר את מספר העוסק.
- [ ] **התאמת שם:** השם המשפטי ב-Business Info צריך להיות זהה לתעודה, אות באות. באתר מופיע "ריצארד טומסקי". אם בתעודה כתוב איות אחר (למשל ריצ'רד), צריך ליישר.
- [ ] **התאמת כתובת:** הכתובת ב-Business Info זהה לתעודה. **TODO לריצארד:** כתובת העסק לא נמצאת בשום מקום ב-repo, אז היא לא נוספה לאתר.
- [ ] **טלפון ואתר:** ב-Business Info רשומים https://ishur.io ו-055-950-4499. שניהם מופיעים באתר (בתנאי השימוש, סעיף 11, ובכפתור הוואטסאפ).
- [ ] **דומיין:** תג `facebook-domain-verification` כבר נמצא ב-`index.html` (שורה 5), אבל לא אימתתי שהדומיין מסומן כמאומת ב-Brand Safety → Domains.
- [ ] אם בוחרים אימות במייל: info@ishur.io נמצא על הדומיין של האתר, וזה מה ש-Meta מחפשת.

### מה האתר מציג היום, ומה שיניתי (patch על הענף, לא commit ולא deploy)
| קובץ | לפני | אחרי |
|---|---|---|
| `index.html` | מספר העוסק הופיע רק ב-JSON-LD (`vatID`). השם הופיע רק בחלון התשלום. **לא הייתה כתובת.** | שורת © בפוטר: `© 2026 אישורי הגעה · ishur.io · ריצארד טומסקי, עוסק מורשה 322414905 · כל הזכויות שמורות` |
| `terms.html` | בסעיף "יצירת קשר" היו רק ishur.io וטלפון | נוספה שורה: `<p>מפעיל השירות: ריצארד טומסקי, עוסק מורשה 322414905</p>` |
| `llms.txt` | לא היו שם ולא מספר עוסק | נוספה שורה: `- Operator: ריצארד טומסקי, עוסק מורשה 322414905 (Israel). Website: https://ishur.io` |

המקורות, מילה במילה מתוך ה-repo: מספר העוסק מגיע מ-`index.html:27` (`"vatID": "322414905"`) ומ-`.sdlc/seo-gen.py:189` (`עוסק מורשה 322414905`, שכבר מוצג בפוטרים של דפי הערים). השם מגיע מ-`index.html:2779` ("החיוב מופיע על שם ריצארד טומסקי").

**TODO, כתובת (ריצארד ממלא, לא להמציא):** אחרי שהכתובת ידועה, מעתיקים אותה בדיוק כמו בתעודת העוסק לשלושה המקומות האלה:
```html
<!-- index.html, f-copy2 -->
… ריצארד טומסקי, עוסק מורשה 322414905 · [כתובת כמו בתעודת העוסק] · כל הזכויות שמורות
<!-- terms.html, #contact -->
<p>כתובת: [כתובת כמו בתעודת העוסק]</p>
```
ובקובץ `llms.txt` מוסיפים `Address: …` לשורת ה-Operator.

## אימות (מה רץ ומה לא הוכח)
- 6 קריאות GET לקריאה בלבד דרך `/api/meta-admin` ו-`/api/ads`, כולן HTTP 200. הפלט מוצג למעלה.
- `grep` ב-repo: אין כתובת עסק. שם ומספר עוסק נמצאו מילה במילה.
- **לא הוכח:** שהמסלולים בסעיף 1 נראים כך בממשק. לא נכנסתי ל-Business Suite. גם לא הוכח שהאיות של השם בתעודה זהה לאתר, ולא שהוספת השורה לאתר משפיעה על הבדיקה של Meta.
