# Store listing · decisions and drafts

## Name (Richard, 20/11/2026)
- Hebrew: **אישורי הגעה לאירועים** (20 characters; the App Store limit is 30)
- English: **Ishur**
- Under the icon on the phone (short, about 12 characters fit): proposal **אישורי הגעה** in Hebrew, **Ishur** in English.
- Not checked: whether the names are free on the App Store and Google Play. That can only be seen when creating
  the app record inside each account.
- Bundle / package id: `io.ishur.client` (proposed; becomes permanent when registered).
- Availability: Israel only in version 1.

## App Store text (drafts for Richard's approval, 20/11/2026)

### עברית
- **שם (30):** אישורי הגעה לאירועים
- **כותרת משנה (30):** מי מגיע לאירוע, בזמן אמת
- **מילות מפתח (100):** אישורי הגעה,חתונה,בר מצווה,מוזמנים,RSVP,אירוע,הזמנה,וואטסאפ,ברית,סידור הושבה
- **טקסט קידום (170):** רואים מי אישר הגעה, מי עוד לא ענה ומה נשלח מתי, ומקבלים הודעה ברגע שמוזמן עונה.
- **תיאור:**
  האפליקציה של לקוחות ishur.io: שירות אישורי הגעה לאירועים בוואטסאפ.

  אחרי שהזמנתם את השירות, נכנסים עם הטלפון והקוד שקיבלתם ורואים את האירוע שלכם:
  · כמה מגיעים, כמה אישרו, מי לא בטוח ומי עוד לא ענה
  · רשימת המוזמנים המלאה, עם חיפוש לפי שם
  · למי ההזמנה לא הגיעה, ולמה
  · לוח השליחות: מה יוצא למוזמנים ומתי, עם אפשרות לשנות תאריך
  · הזמנה עם תמונה ונוסח משלכם, והוספת מוזמנים
  · קישור אישור הגעה לשיתוף בקבוצות

  התראות, אם תרצו: כשמוזמן עונה, סיכום קצר כל בוקר, וכשהזמנה לא הגיעה. בלי התראות בלילה.

  גם בלי קליטה רואים את המצב האחרון שנשמר במכשיר.
  יש מרכז עזרה עם הסברים קצרים ומונפשים, ותמיד אפשר לכתוב לנו בוואטסאפ.

  האפליקציה מיועדת ללקוחות קיימים של ishur.io. פרטים על השירות: ishur.io

### English
- **Name (30):** Ishur
- **Subtitle (30):** Event RSVPs, as they come in
- **Keywords (100):** rsvp,wedding,event,guests,invitation,guest list,whatsapp,bar mitzvah,seating,attendance
- **Promotional text (170):** See who confirmed, who has not answered and what goes out when. Get a notification the moment a guest replies.
- **Description:**
  The app for ishur.io clients: WhatsApp RSVP management for events in Israel.

  Sign in with the phone number and code you received when you ordered the service, and follow your event:
  · How many are coming, who confirmed, who is unsure and who has not answered
  · The full guest list, searchable by name
  · Which invitations did not arrive, and why
  · The send schedule: what goes out to guests and when, with the option to move a date
  · Your invitation image and wording, and adding guests
  · A shareable RSVP link for groups

  Optional notifications: when a guest answers, a short summary every morning, and when an invitation did not arrive. Never at night.

  Without a connection you still see the last saved state. A help centre explains each step, and you can always reach us on WhatsApp.

  For existing ishur.io clients. About the service: ishur.io

- **Support URL:** https://ishur.io/faq.html · **Marketing URL:** https://ishur.io · **Privacy policy URL:** https://ishur.io/terms.html#privacy
- **Category:** Lifestyle (secondary: Productivity) · **Price:** Free · **Availability:** Israel

## App Review notes (draft)
Ishur is the companion app for clients of ishur.io, a service that sends event invitations over WhatsApp and
collects RSVPs. Clients buy the service on our website or through a sales call, and an account is created for
them then; the app has no sign-up and sells nothing. Sign in with the demo account below to see a demo event.
Demo phone: [to fill] · Code: [to fill]. Notifications: after sign-in the app explains them and asks; they are
optional. Account deletion: Account tab → "בקשה למחיקת החשבון והמידע".

## Privacy answers (App Store "App Privacy" and Google "Data safety"), draft
| Data | Collected | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|---|
| Phone number | yes | yes | no | App functionality (sign-in) |
| Name | yes | yes | no | App functionality |
| User ID (client id) | yes | yes | no | App functionality |
| Contacts (guest names and phones the client uploaded) | yes | yes | no | App functionality |
| Device ID (push token) | yes, only if notifications are allowed | yes | no | App functionality |
| Usage data, diagnostics, location, advertising data | no | | | |
- Data is encrypted in transit (HTTPS). Users can request deletion: in the app and at https://ishur.io/delete-account.html.
- No third-party advertising or analytics SDK in the app; the board inside the app loads none (check P13/P14).
- Still open, and it changes the answers above: the worker's own page counter `/px` (a random visitor id, path) is
  requested by the board inside the app. Either switch it off in app mode or declare "Product interaction, not linked".

## Age rating answers (draft)
No web browsing outside our own pages, no user-generated content shown to other users, no chat, no ads, no
gambling, no violence or mature content. Expected rating: 4+.
