# round 7 · Part B: guest messages in other languages (spec, draft 21/11/2026)

Status: draft. Not built. Touches the live sending engine, so it is built on staging behind a switch that is off by
default, and reaches production only on Richard's "promote".

## Decided by Richard (21/11)
- Per event the client picks one of: Hebrew only (today) · one other language instead of Hebrew · Hebrew + one other
  language in the same message (text and buttons in both). Never two separate messages.
- Guest languages: English, Russian, Arabic, French, Spanish, Portuguese. Not Yiddish or Amharic: Meta does not list
  them as template languages ("Skip those two"). The app and the board keep all 9 languages for the client.

## Facts it rests on (checked 21/11)
- Meta (developers.facebook.com, message-templates and supported-languages): en, ru, ar, fr, es, pt_BR/pt_PT, he
  are template languages. 250 templates per account if the business is unverified, 6,000 if verified; every language
  version counts; at most 100 new templates an hour. Nothing about mixing two languages in one template.
- The engine sends about 40 guest templates (invitation, reminders, day-before and event-day variants, table number,
  thank-you, cancel, postpone; list in the Worker: `index.js`, `subevent.js`). `sendTemplate(env, to, name, params,
  image, lang)` in `worker/whatsapp.js` already takes a language code; every caller passes Hebrew.
- Guest replies are understood from **Hebrew text**: `parseInboundReply` reads a button tap by its text
  (`msg.button.text`, then `payload`) and matches Hebrew words; `guestIntent` uses Hebrew word lists. A tap on
  "Coming" or "Приду" is not understood today. This is the main risk and is solved before anything is sent.

## Size
6 languages x 2 sets (alone, with Hebrew) x about 40 = about 480 new templates, on top of about 50 today. Over the
250 limit, so the business must be verified with Meta first (to check in Business settings). Submitting at Meta's
100 an hour takes at least 5 hours, done by a script that waits between batches.

## Design
1. **The event remembers the choice**: `guest_lang = { mode: 'he' | 'alone' | 'pair', lang: 'en'|'ru'|'ar'|'fr'|'es'|'pt' }`,
   default `{ mode: 'he' }`. Set by the client in the board (שליחות) before the invitation goes out; locked after it
   goes out, like today's wording (a guest gets one language from start to end).
2. **One place picks the template**: `guestTemplate(name, ev)` returns `{ name, lang }`:
   alone → `<name>_<lang>` with Meta code `<lang>`; pair → `<name>_he<lang>` with code `he`. Every guest send goes
   through it. If that version is not approved at Meta, the Hebrew one is sent and the ops center is told (a guest
   never misses a message because of a language).
3. **Buttons are read by a fixed code, not by their words**: each quick-reply button gets a payload (`yes`, `no`,
   `maybe`, `party_<n>`, …) when the template is sent, and `parseInboundReply` reads a known payload first. Hebrew
   buttons keep working as today (their text still matches).
4. **Typed replies in the 6 languages**: word lists for yes / no / maybe / "remove me" / "wrong number" / numbers per
   language, next to the Hebrew ones. Anything else goes to the existing free-text path, as today.
5. **Our replies to guests** (the confirmations the engine writes back, e.g. "תודה, רשמנו 2") in the event's
   language, from the same dictionaries the app uses, Hebrew first in a pair.
6. **The texts**: Claude writes the 6 x 40 x 2 texts from today's Hebrew templates, same variables and buttons; marked
   unverified until a native speaker reads them. A client's own wording in another language goes through the existing
   per-client custom-template path (`/api/custom-template`).

## Pass conditions (machine-checked before any promote)
- B1. Worker tests: every guest send path, for each mode and each of the 6 languages, asks Meta for the right template
  name and language code (Meta stubbed); Hebrew-only events send exactly what they send today (existing tests unchanged).
- B2. A button tap in each language, and its typed equivalents, is recorded as the same answer as the Hebrew one.
- B3. A version that Meta has not approved falls back to Hebrew and raises one ops note.
- B4. On staging, a full invitation → reminder → thank-you run to the test phone in two languages (alone and pair).
- B5. The submit script stays under 100 templates an hour and never resubmits an approved one.

## Open (Richard)
- 3. A client's own wording in another language: the client writes it in that language, or writes Hebrew and we
  translate it?
- Is the business verified with Meta (needed for over 250 templates)? Claude checks this in Business settings.
