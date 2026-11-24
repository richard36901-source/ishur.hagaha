# Store listing · decisions and drafts

## Name (Richard, 20/11/2026)
- Hebrew: **אישורי הגעה לאירועים** (20 characters; the App Store limit is 30)
- English: **Ishur**
- Under the icon on the phone (short, about 12 characters fit): proposal **אישורי הגעה** in Hebrew, **Ishur** in English.
- Not checked: whether the names are free on the App Store and Google Play. That can only be seen when creating
  the app record inside each account.
- Bundle / package id: `io.ishur.client` (proposed; becomes permanent when registered).
- Availability: Israel only in version 1.

## App Store text (20/11/2026: Richard delegated the decision to Claude; he has not read these texts)

### עברית
- **שם (30):** אישורי הגעה לאירועים
- **כותרת משנה (30):** מי מגיע לאירוע, בזמן אמת
- **מילות מפתח (100):** אישורי הגעה,חתונה,בר מצווה,מוזמנים,RSVP,אירוע,הזמנה,וואטסאפ,ברית,סידור הושבה
- **טקסט קידום (170):** רואים מי אישר הגעה, מי עוד לא ענה ומה נשלח מתי, ומקבלים הודעה ברגע שמוזמן עונה.
- **תיאור:**
  האפליקציה של לקוחות ishur.io: שירות אישורי הגעה לאירועים בוואטסאפ.

  אחרי שהזמנתם את השירות, נכנסים עם הטלפון והקוד שקיבלתם ורואים את האירוע שלכם:
  · ראשי: כמה מגיעים, כמה אישרו, מי לא בטוח ומי עוד לא ענה, וכמה מנות כדאי להתחייב לאולם
  · סידורי הושבה, ברקוד שולחנות ומעקב תקציב
  · מוזמנים: הרשימה המלאה עם חיפוש, רשימה להדפסה, החלפת רשימה והוספת מוזמנים
  · שליחות: מה יוצא למוזמנים ומתי, ההזמנה והנוסח, וקישור אישור הגעה לשיתוף בקבוצות
  · חשבון: כל האירועים שלכם ומה כלול בחבילה

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
  · Home: how many are coming, who confirmed, who is unsure, who has not answered, and how many to commit to the venue
  · Seating plan, table QR codes and budget
  · Guests: the full list with search, a printable list, replacing the list and adding guests
  · Sends: what goes out to guests and when, your invitation and wording, and a shareable RSVP link for groups
  · Account: all your events and what your package includes

  Optional notifications: when a guest answers, a short summary every morning, and when an invitation did not arrive. Never at night.

  Without a connection you still see the last saved state. A help centre explains each step, and you can always reach us on WhatsApp.

  For existing ishur.io clients. About the service: ishur.io

- **Support URL:** https://ishur.io/faq.html · **Marketing URL:** https://ishur.io · **Privacy policy URL:** https://ishur.io/terms.html#privacy
- **Category:** Lifestyle (secondary: Productivity) · **Price:** Free · **Availability:** Israel

## App Review notes (draft)
Ishur is the companion app for clients of ishur.io, a service that sends event invitations over WhatsApp and
collects RSVPs. Clients buy the service on our website or through a sales call, and an account is created for
them then; the app has no sign-up and sells nothing. Sign in with the demo account below to see a demo event.
Demo phone: 050-000-5201 · Code: [read with /api/client-pin after the promote; the production code differs from staging]. The demo event is invented and sends nothing: actions that would message guests are refused. Notifications: after sign-in the app explains them and asks; they are
optional. Account deletion: Account tab → "בקשה למחיקת החשבון והמידע".
Sign in with Apple / Google (iPhone): these sign in an existing client only. A client signs in once with the phone and
code, then connects Apple or Google, and uses that from then on. An Apple or Google account that was never connected gets
a message to sign in with the phone and code first. The demo phone above always signs in with its code and is never asked
to connect.

## Privacy answers (App Store "App Privacy" and Google "Data safety"), draft
| Data | Collected | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|---|
| Phone number | yes | yes | no | App functionality (sign-in) |
| Email address and Apple/Google account ID (only if the client connects Sign in with Apple or Google; Apple may give a private relay address) | yes | yes | no | App functionality (sign-in) |
| Name | yes | yes | no | App functionality |
| User ID (client id) | yes | yes | no | App functionality |
| Contacts (guest names and phones the client uploaded) | yes | yes | no | App functionality |
| Device ID (push token) | yes, only if notifications are allowed | yes | no | App functionality |
| Usage data: product interaction (screens opened, controls tapped) | yes | yes (a keyed hash of the phone) | no | Analytics, App functionality |
| Diagnostics: crash/error data (script error text, no personal data) | yes | yes | no | Analytics |
| Location, advertising data, browsing history, purchases | no | | | |
- Data is encrypted in transit (HTTPS). Users can request deletion: in the app and at https://ishur.io/delete-account.html.
- No third-party advertising or analytics SDK in the app; the board inside the app loads none (check P13/P14). Usage data is
  our own log on our own Worker (`worker/app-events.js`, spec R20-R25): not shared, not used for tracking, kept 400 days,
  deleted with a delete-account request. Google Data safety: "App interactions" and "Diagnostics", collected, not shared.
- The worker's own page counter `/px` does not run in app mode (20/11, check P13/P14 count it as a tracking request).

## Age rating answers (draft)
No web browsing outside our own pages, no user-generated content shown to other users, no chat, no ads, no
gambling, no violence or mature content. Expected rating: 4+.
