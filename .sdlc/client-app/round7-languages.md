# client-app · round 7: languages (plan, 21/11/2026)

## What Richard asked (21/11, his words shortened)
1. "language support so they can choose what language they want to see it all": English, Russian, Arabic, French, then
   Spanish, Yiddish, "Ethiopian". "Later we'll add more languages."
2. Guest messages in other languages: when a client submits a custom text, ask whether to add a language to the buttons,
   either the same language as the text, or one or two languages for the buttons; the reminders, thank-you and every
   later message of that event follow the choice.
3. "Plan it all properly and execute with a goal set, work in loops, check yourself."

## Part A · the client sees the app and the board in their language (this round)

Languages: he (source), en, ru, ar, fr, es, yi, am. "Ethiopian" read as Amharic (Claude's reading; Tigrinya can be
added the same way). Right to left: he, ar, yi. Left to right: en, ru, fr, es, am.

Design:
- One list of languages in `assets/i18n/langs.js`; adding a language later = one entry + one file `assets/i18n/<code>.json`.
- The pages stay written in Hebrew. A small layer (`assets/i18n.js`) swaps each Hebrew text it knows for the chosen
  language: text nodes, placeholder, title, aria-label, document title, and anything the page adds later (a
  MutationObserver). Texts with numbers ("נותרו 12 ימים לאירוע") are translated by known pieces around the numbers.
  A text that still has Hebrew after that (a guest's or venue's name) is left as it is.
- Choice: a picker in the app's חשבון; default Hebrew (Claude's choice: many Israelis keep their phone in English, so
  following the phone would switch Hebrew speakers to English). The app passes
  `lang=` to every board page it opens; the board remembers it for the tab.
- Translations: Claude writes them from `i18n/strings.json` (collected by `app/scripts/i18n-collect.mjs`).
  Amharic and Yiddish especially need a native speaker's check before launch; marked as unverified.

Implementation note (21/11): another session built a language overlay for the board home (`assets/i18n.js`, menu in
the header). So the board home uses that overlay, the app's own screens use `app/www/i18n.js`, and the board's other
pages use `assets/i18n-pages.js` (a copy of the app's). All three read `?lang=` and remember the choice.

Pass conditions (machine-checked by `app/scripts/i18n-check.mjs`):
- A1. For each of the 7 languages, on the app's four tabs, the events page, and the board pages (dashboard home,
  guests, sends views; upload step 2; schedule; budget; seating; checklist), no visible text equals a collected Hebrew
  UI text. Names and other client data are allowed to stay Hebrew.
- A2. `<html dir>` is rtl for he/ar/yi and ltr for the others; no page is wider than the screen at 400 px.
- A3. The choice survives closing and reopening the app, and the board in the frame follows it.
- A4. Hebrew is unchanged: `npm run check` 51/51 for both demo clients.
- A5. Every language file has a value for every key that A1 needs; no value is empty or still Hebrew (except yi,
  which uses Hebrew letters: checked against the Hebrew key instead).

Loops: 1 the layer and picker with English, A1–A4 for English · 2 the other six languages · 3 fix what A1/A2 report,
until all pass or 5 rounds; then report what is left.

## Part B · guest messages in other languages (plan only; decisions first)
What changes: every message an event sends (invitation, reminder, extra send, day-before, table number, thank-you,
cancel/postpone) would exist per language, and the event remembers its choice. WhatsApp messages with buttons go out
as Meta-approved templates, so each language is a set of templates Meta must approve, and the buttons' text is part
of the template. Today the engine sends Hebrew templates only.

Size, counted 21/11 in the Worker: the engine uses about 50 WhatsApp templates, about 40 of them sent to guests
(invitation and reminder per client wording, the day-before message in 16 variants for gift/table/bus links, the event-day
message in 16 variants, table number, thank-you in 4, cancel, postpone). Every guest language adds about 40 templates for
Meta to approve; a two-language combination is a further set of its own. A custom wording is already submitted to Meta
per client (`/api/custom-template`), so a custom wording in another language goes through the same path.
Recommended start (Claude): the custom-wording path first (it already exists per client), with buttons and the later
messages in the language the client picks; then the fixed templates for the languages clients actually choose.

Decisions for Richard, one at a time:
1. ~~"Two languages": one message or two?~~ **Decided 21/11** (Richard: "they can choose if they want one other
   language instead of hebrew or one hebrew and another one in one message"). Per event the client picks one of:
   Hebrew only (today) · one other language instead of Hebrew · Hebrew + one other language in the same message
   (text and buttons in both). Never two separate messages. So each guest language needs two template sets: alone,
   and paired with Hebrew.
2. ~~Which languages for guests first~~ **Decided 21/11** (Richard: "do all languages we got time", "all the requested"):
   all of them: en, ru, ar, fr, es, yi, am (+ pt, already in the app). Checked the same day on Meta's pages
   (message-templates, supported-languages): Yiddish and Amharic are **not** template languages Meta lists; the others
   are. Limits: 250 templates per account if the business is unverified, 6,000 if verified; every language version
   counts; at most 100 new templates an hour. All 8 languages x 2 sets (alone, with Hebrew) x about 40 = about 640
   templates, so this needs the verified limit, and submitting takes at least 7 hours at Meta's rate. Meta's pages say
   nothing about mixing two languages in one template.
   **Decided 21/11** (Richard: "Skip those two"): no guest messages in Yiddish or Amharic. Guest languages are
   en, ru, ar, fr, es, pt (the app and board keep all 9). 6 x 2 sets x about 40 = about 480 new templates: still over
   250, so the business must be verified with Meta (6,000).
3. Custom text in another language: does the client write it in that language, or do we translate it?
Build after the answers; it touches the live sending engine, so it gets its own spec and tests.
