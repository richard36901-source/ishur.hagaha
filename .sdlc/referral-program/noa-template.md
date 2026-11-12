# referral-program · Noa post-event message (utility template, NOT wired yet)

Richard 12/11: one calm message to the host after the event — credit for a review / video, no raffle text. The engine keeps
sending `ishur_syum_v3` (feedback link) until this template is approved by Meta **and** Richard says "שלח". Nothing in the
referral build sends it.

**Name:** `ishur_syum_credit` · **Category:** Utility · **Language:** he

**Body:**
```
איזה כיף שהיה! 🎉 {{1}} מאחוריכם, ותודה שסמכתם עלינו ברגע הכי חשוב.

נשמח לעשר שניות מכם: שתי שאלות קצרות על איך היה איתנו, זה עוזר לנו להשתפר לזוגות הבאים 💚
{{2}}

וכתודה: סרטון המלצה קצר = ₪30 זיכוי, ביקורת בגוגל = ₪20, לאירוע הבא שלכם או של מי שתבחרו להמליץ לו.

מזל טוב מכל הלב,
צוות ishur.io
```
**Variables:** `{{1}}` = event name (as `ishur_syum_v3` today, `eventDisplayName`) · `{{2}}` = `https://ishur.io/feedback.html?t=<token>`

**Sample values for Meta:** `{{1}}` = החתונה של דנה ויוסי · `{{2}}` = https://ishur.io/feedback.html?t=abcd1234-0000-0000-0000-000000000000

**Footer (small print, optional):** הזיכוי למימוש על החבילות והתוספות שלנו, לא במזומן.

**Wiring once approved (one line in worker/index.js, stage 3 of the engine):** replace `'ishur_syum_v3'` with
`'ishur_syum_credit'` in the `sendClientE` call (same two params) and add the name to the template guard list next to it.
