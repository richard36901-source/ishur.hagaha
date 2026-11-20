# Translation brief · ishur.io client app and board (21/11/2026)

ishur.io is an Israeli service that sends wedding / bar-mitzvah / event invitations to guests over WhatsApp and collects
their RSVPs (who is coming, how many). Clients (the couple or the family) use an app and a web "board" to follow
answers, manage the guest list, seating, budget, the send schedule and the event-day schedule.

Input: `i18n/keys.json` — a JSON array of 1518 Hebrew UI texts, exactly as they appear on screen (some are fragments
that sit next to numbers or names, e.g. "ענו ב-" before a date, "נותרו " before a number).

Output: `assets/i18n/<code>.json` — ONE JSON object: { "<Hebrew key exactly as in keys.json>": "<translation>" }.
Every key must be present. Valid JSON, UTF-8, no comments.

Rules
- Keep: numbers, dates, times, ₪ amounts, emoji, URLs, "ishur.io", "ishur", WhatsApp, Waze, Google, Apple, Bit,
  PayBox, punctuation like · and spacing at the start/end of fragments (a fragment ending in a space keeps it).
- Fragments: translate so they read naturally when the number/name follows or precedes as in Hebrew. If word order
  must change, still translate the fragment alone; do not invent placeholders.
- Tone: warm, short, plain, like a friendly service. Hebrew uses plural "you" (אתם) for the couple; use the natural
  polite/plural form of the language (e.g. French "vous", Spanish "ustedes" neutral, Russian "вы").
- Hebrew gender slashes like "מגיע/ה" → a neutral form.
- Sample names in help animations (דנה כהן, יוסי לוי, איתי…) → transliterate (Dana Cohen, Yossi Levi, Itai).
- Jewish/Israeli event words: חתונה wedding, בר מצווה bar mitzvah, בת מצווה bat mitzvah, ברית brit milah, חופה chuppah,
  כתובה ketubah, קבלת פנים reception, אולם venue/hall.
- Glossary (English; keep the same meaning in your language):
  אישורי הגעה = RSVPs · אישרו = Confirmed · לא מגיעים = Not coming · לא בטוחים = Not sure · לא ענו = No reply ·
  נכשלו = Not delivered · מוזמנים = Guests · רשומות = entries (list rows) · מקומות = seats · הזמנה = invitation ·
  שליחה / שליחות = send / sends · לוח השליחות = Send schedule · תזכורת = reminder · לוח / לוח בקרה = board ·
  סידור הושבה = Seating plan · שולחן = table · תקציב = Budget · לוז אירוע = Event schedule · התחייבות לאולם = Venue
  commitment · מומלץ = Recommended · חבילה = package · נוסח = wording · קישור לקבוצה = Group link · חשבון = Account ·
  ראשי = Home · עזרה והסברים = Help · המלצה עלינו = Recommend us · דיילות = hostesses · סבב שיחות = call round.

Check before finishing (must print "ok"):
  node -e "const k=require('./i18n/keys.json'),t=require('./assets/i18n/<code>.json');const miss=k.filter(x=>!(x in t)||!String(t[x]).trim());if(miss.length){console.log('missing',miss.length,miss.slice(0,5));process.exit(1)}console.log('ok',Object.keys(t).length)"
