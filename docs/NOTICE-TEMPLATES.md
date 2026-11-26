# Cancel / postpone notice to guests: templates and terms (26/11/2026, track-cancel)

Status: **draft for Richard. Nothing here has been submitted to Meta or published on the site.**

The client's red stop button (dashboard.html, "עצירת השליחות") can now schedule one notice to every invited guest when the client picks "האירוע בוטל" or "האירוע נדחה". The sender (`worker/guest-notice.js`) uses the four template names below. Until Meta approves all of them, a scheduled notice waits and the board shows "ממתין לאישור הנוסח". At send time the sender also checks that Meta's approved body is the same as the text below. If it differs, the notice waits and Slack gets an alert. So if you change a word when you submit, change it in `NOTICE_TEMPLATES` too. A test checks that this file and the code match.

## Templates (guests WABA, Hebrew `he`, category UTILITY, no buttons, no header)

Footer for all four: `נשלח באמצעות ishur.io`

### 1. `ishur_event_cancelled`

Variables: {{1}} guest name · {{2}} event (`guestEventName`, e.g. "החתונה של דנה ויוסי") · {{3}} original date (DD.MM.YYYY)

```
שלום {{1}},
אנחנו מעדכנים בשם בעלי השמחה על ביטול האירוע.
האירוע: {{2}}
המועד שתוכנן: {{3}}
אין צורך להגיע. תודה רבה על ההבנה.
```

Sample for Meta: {{1}} = דנה · {{2}} = החתונה של נועה ואיתי · {{3}} = 10.12.2026

### 2. `ishur_event_cancelled_nn` (for a guest without a name in the list)

Variables: {{1}} event · {{2}} original date

```
שלום,
אנחנו מעדכנים בשם בעלי השמחה על ביטול האירוע.
האירוע: {{1}}
המועד שתוכנן: {{2}}
אין צורך להגיע. תודה רבה על ההבנה.
```

### 3. `ishur_event_postponed`

Variables: {{1}} guest name · {{2}} event · {{3}} original date · {{4}} new date

```
שלום {{1}},
אנחנו מעדכנים בשם בעלי השמחה על דחיית האירוע.
האירוע: {{2}}
המועד הקודם: {{3}}
המועד החדש: {{4}}
נשמח לראותכם במועד החדש. תודה רבה על ההבנה.
```

Sample: {{1}} = דנה · {{2}} = החתונה של נועה ואיתי · {{3}} = 10.12.2026 · {{4}} = 14.01.2027

### 4. `ishur_event_postponed_nn`

Variables: {{1}} event · {{2}} original date · {{3}} new date

```
שלום,
אנחנו מעדכנים בשם בעלי השמחה על דחיית האירוע.
האירוע: {{1}}
המועד הקודם: {{2}}
המועד החדש: {{3}}
נשמח לראותכם במועד החדש. תודה רבה על ההבנה.
```

### Why this wording

- Gender-neutral. "בוטל/בוטלה" and "שתוכנן/שתוכננה" would depend on the occasion (חתונה, בר מצווה, ברית), so the event name stands alone after "האירוע:".
- No variable is empty: a guest without a name gets the `_nn` twin, and an event without hosts or occasion falls back to "האירוע".
- It promises nothing new (no "a new invitation will follow"). It is transactional only, which is what UTILITY needs.
- The old `ishur_bitul` / `ishur_dchiya` (engine stage 5, used when the team marks בוטל? = כן or changes the date) are untouched. Once the client's notice went out, `cancelmsg:<token>` is written so `ishur_bitul` can never follow it. The stop also keeps `hold:<token>`, which stage 5 skips.

### After approval (Richard)

1. Submit the four templates on the guests WABA (Ishur.io, 1378764257421712). Then the scheduled notices go out on their own in the next pacer tick inside the window.
2. Only after they are approved, add the four names to `guardWatchList()` in `worker/index.js`. They are deliberately not there now: the template guard submits a reworded copy to Meta of any template it finds **missing**, which would be an automatic submission.

## Terms (תקנון, terms.html): what is covered, what is missing

| Topic | Covered today? | Where |
|---|---|---|
| Refunds on cancellation / postponement | Yes: "ביטול, דחייה או שינוי של האירוע אינם מזכים בהחזר" | §2 |
| What is charged / no refund for messages sent or calls made | Yes | §2 |
| A sent message cannot be cancelled | Yes: "הודעה שכבר יצאה אינה ניתנת לביטול או לשינוי" | §4 |
| Client-initiated stop from the board | **No** | — |
| Notice to guests: who gets it, which package, wording, timing | **No** | — |
| Postponement: what happens to sends, the date, the hostess booking | Partly (hostess only, §2א) | §2א |
| Resuming after a stop; finality after the notice | **No** | — |

The board's flow quotes only §2 and §4, which are already published (`TERMS_LINES` in guest-notice.js). It links `terms.html#payment` and has the checkbox "קראתי ואני מסכים/ה לתנאי הביטול".

### Proposed clause (for Richard / legal review, not published)

Insert after §2ב in terms.html:

```diff
+  <section id="stop">
+    <h2>2ג. עצירה, ביטול ודחייה מלוח הבקרה</h2>
+    <ul>
+      <li><b>עצירה:</b> הלקוח רשאי לעצור בכל עת מלוח הבקרה את כל ההודעות והשיחות לאורחים. העצירה חלה מיד על כל מה שעוד לא יצא. חידוש השליחות נעשה על ידי צוות ishur.io בלבד, לאחר שיחה עם הלקוח.</li>
+      <li><b>ביטול או דחייה של האירוע:</b> בעת העצירה הלקוח מציין אם האירוע בוטל או נדחה, ובדחייה גם את המועד החדש. שינוי תאריך האירוע במערכת ומועדי השליחה החדשים נקבעים בתיאום עם הצוות.</li>
+      <li><b>הודעה לאורחים:</b> בחבילת "הכל כלול", או ברכישת תוספת הודעת ביטול / דחייה, הלקוח רשאי לתזמן הודעה אחת לכל המוזמנים שכבר קיבלו הזמנה. נוסח ההודעה קבוע ומוצג ללקוח במלואו לפני האישור, ואינו ניתן לעריכה. ההודעה נשלחת במועד שהלקוח בחר, בימים א׳–ה׳ בין 09:00 ל-19:00 ובשישי עד 13:00, לא בשבת ובחג, ולא לאחר מועד האירוע המקורי. עד לאישור הנוסח על ידי Meta / וואטסאפ ההודעה ממתינה, ואם מועד האירוע חלף לפני כן היא לא תישלח.</li>
+      <li><b>סופיות:</b> מרגע שההודעה החלה לצאת לאורחים לא ניתן לבטל אותה, לשנות אותה או לחדש את השליחות לאירוע. עד אז הלקוח רשאי לבטל את ההודעה המתוזמנת מלוח הבקרה.</li>
+      <li><b>חיוב:</b> עצירה, ביטול או דחייה אינם מזכים בהחזר (סעיף 2). תוספת הודעת ביטול / דחייה שנרכשה אינה מוחזרת לאחר שההודעה החלה לצאת. מוזמן שחסם את המספר, שמספרו שגוי או שאין לו וואטסאפ פעיל לא יקבל את ההודעה, ואין בכך עילה להחזר.</li>
+    </ul>
+  </section>
```

And in §2, after "ביטול, דחייה או שינוי של האירוע אינם מזכים בהחזר.":

```diff
+      <li>לעצירת השליחות, להודעה לאורחים על ביטול או דחייה ולחידוש השליחות ראו סעיף 2ג.</li>
```

Once this is published, change the board link (`TERMS_URL` in guest-notice.js) from `#payment` to `#stop`, and add one line about finality to `TERMS_LINES`.
