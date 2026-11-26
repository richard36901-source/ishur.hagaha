# Guest name option: "לשלוח עם שם האורח" (26/11/2026)

Richard 26/11: a switch per event in the client's message settings, on or off, that applies to every message to the guests (invitation, reminders, extra send, day-before, event-day, table, thank-you, gift, cancel, postpone, resend, sub-events and any notice added later). The reason: a guest saved as "דודה של הכלה" or "חבר מהצבא 2" must not be greeted by that.

## How the name gets into a message today

- Every guest template with a name has it as `{{1}}`, in the greeting line: `שלום {{1}}!`, `היי {{1}},`, `שלום רב {{1}},`. The sender fills `{{1}}` from the guest row (sheet column D), or `'אורח יקר'` when that cell is empty. This already happens in `eventday.js` (`eventDayMessageFor` and `dayBeforeMessageFor`) and in the thank-you (`index.js`, `TODA_U`).
- The templates without a name are `ishur_yom_haerua(_matana)`, where `{{1}}` is the time, and the client's own wording `ishur_c_<tok8>_<n>`, which has no variables.
- **None of the existing suffixes is a no-name copy:**

  | Suffix | What it is |
  |---|---|
  | `_n` | Client-portfolio rename (`whatsapp.js`), or the nav-only combo key (`ishur_yom_combo_n`) |
  | `_f` | Footer copy |
  | `_u` | UTILITY copy of a marketing template |
  | `_yn` | Two-button copy |
  | `_img` / `_vid` | Media-header copy |
  | `_r<n>` | Reworded copy from the template guard (`tmplalt:`) |
  | `_sp` | Spaced copy |
  | `_ab<n>` | A/B challenger |

  The no-name copies therefore get a new suffix, `_anon`.
- Every guest template goes out through `sendTemplate` (`whatsapp.js`). That is where the decision is made (`guest-name.js`, called first, before the guest-language copy and the `tmplalt` / `tmplsp` / `tmplf` swaps), so a new notice is covered without touching its sender.
- Free-text guest replies (follow-up questions, "תודה, רשמנו", gift line) carry no guest name. I checked this by grep.

## The switch

- KV: `evsettings:<token>.guest_name`. `false` means off. A missing value means on, so every event from before 26/11 keeps its names.
- A sub-event (`subevent:<token>`) follows its parent event.
- The client sets it on the board, in "הגדרות מתקדמות → שם האורח בהודעות". The team sets it on the client card in `clients.html` ("שם האורח בהודעות").

## What goes out when the switch is off

| Order | Case | What is sent |
|---|---|---|
| 1 | The template has no variables, or is known to carry no name (`ishur_yom_haerua*`, `ishur_c_*`) | Unchanged |
| 2 | Name template, and Meta has approved its no-name copy (KV `tmplanon:<name>` = `<name>_anon`) | The copy, without the name variable |
| 3 | Name template, no approved copy yet | The same template with `{{1}}` = **אורח יקר** |
| 4 | A template not in the registry (`guest-name.js` `NAME_FIRST_RE`) | Held, not sent (details below) |

- **Case 2, guest language:** for an event whose messages go out in another language, the neutral word is used instead of the copy. The copies have no translations, and `guest-lang.js` already translates "אורח יקר" (for example, "dear guest").
- **Case 4, unregistered templates:** this means a hand-picked sub-event or event-day template, or a new family nobody registered. The sender gets `{ok:false, error:'guest-name-hold', permanent:true}`. The wave stops and stays open, the same as an empty variable, and no sent mark is written. The journal and Slack get one line per event and template per day.
- **Exempt from the hold:** the hand-set event-day job passes `ctx.noGuestName` and is never held. Its parameters are the event's (time, what, address, nav), never a guest's.
- **Sub-events:** a sub-event that hits a hold stops its round with no per-guest failure mark.
- **The name never goes out when the client said no.**

**Fallback chosen per family:** every name family in use opens with `שלום {{1}}` / `היי {{1}}` / `שלום רב {{1}}`. A generic value reads naturally in all of them ("שלום אורח יקר! הוזמנתם ל…", "היי אורח יקר, תזכורת קטנה…"), so all of them fall back to **אורח יקר** (case 3), and none is held today. Only unregistered templates are held.

- **Wording to confirm:** the message bodies speak in the plural ("הוזמנתם", "תגיעו"). "אורח יקר" is the singular word the system already uses for an empty name. If Richard prefers "אורחים יקרים", it is one constant: `NEUTRAL` in `guest-name.js`, plus one line in `guest-lang.js`.

## Template table

- The template status was read only from code and KV pointers. Meta was not called.
- The no-name text below is generated from the repo record of the live template by `worker/scripts/anon-twins.mjs`. Only the greeting changes, and the variables are renumbered from `{{1}}`.
- The full payloads are in `worker/templates/anon/` (45 files, **none submitted**).
- The last column is what goes out while the copy is not approved.

| Family | With name | No-name copy | Copy status | Proposed no-name text (first line; the rest is unchanged, renumbered) | Until approved |
|---|---|---|---|---|---|
| הזמנה + תזכורת + שליחה נוספת (גלים 1–3) | `hazmana_ishur` | `hazmana_ishur_anon` | לא קיים, לא הוגש | שלום! הוזמנתם ל{{1}} של {{2}}. | אורח יקר |
| ביטול אירוע | `ishur_bitul` | `ishur_bitul_anon` | לא קיים, לא הוגש | שלום, עדכון חשוב לגבי {{1}}: האירוע בוטל ולא יתקיים. | אורח יקר |
| דחיית אירוע | `ishur_dchiya` | `ishur_dchiya_anon` | לא קיים, לא הוגש | שלום, עדכון לגבי {{1}}: האירוע נדחה למועד חדש 🗓 | אורח יקר |
| שליחה חוזרת (resend) | `ishur_hazmana_shuv` | `ishur_hazmana_shuv_anon` | לא קיים, לא הוגש | היי, שולחים שוב את פרטי ה{{1}} של {{2}} 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_g` | `ishur_lifnei_combo_g_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_gb` | `ishur_lifnei_combo_gb_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_gp` | `ishur_lifnei_combo_gp_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_n` | `ishur_lifnei_combo_n_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_t` | `ishur_lifnei_combo_t_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_tg` | `ishur_lifnei_combo_tg_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_tgb` | `ishur_lifnei_combo_tgb_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_combo_tgp` | `ishur_lifnei_combo_tgp_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_plain_g` | `ishur_lifnei_plain_g_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_plain_gb` | `ishur_lifnei_plain_gb_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_plain_gp` | `ishur_lifnei_plain_gp_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_plain_t` | `ishur_lifnei_plain_t_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_plain_tg` | `ishur_lifnei_plain_tg_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_plain_tgb` | `ishur_lifnei_plain_tgb_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום לפני | `ishur_lifnei_plain_tgp` | `ishur_lifnei_plain_tgp_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| מתנה (למי שלא מגיע) | `ishur_matana` | `ishur_matana_anon` | לא קיים, לא הוגש | היי, חבל שלא יכולתם להגיע ל{{1}} 🙏 | אורח יקר |
| תת-אירוע (שבת חתן) | `ishur_shabat_hatan_reminder` | `ishur_shabat_hatan_reminder_anon` | לא קיים, לא הוגש | היי, רק מזכירים 🙂 | אורח יקר |
| שולחן (יום האירוע, הושבה) | `ishur_shulchan` | `ishur_shulchan_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| שולחן (יום האירוע, הושבה) | `ishur_shulchan_matana` | `ishur_shulchan_matana_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| תודה + מתנה | `ishur_toda_matana` | `ishur_toda_matana_anon` | לא קיים, לא הוגש | היי, תודה שהייתם איתנו ב{{1}} 🤍 | אורח יקר |
| תודה | `ishur_toda_orach_u` | `ishur_toda_orach_u_anon` | לא קיים, לא הוגש | היי, עדכון לאחר {{1}}: אישור ההגעה שלכם נסגר במערכת, ואין צורך בפעולה נוספת מצדכם. תודה שאישרתם והגעתם. | אורח יקר |
| יום האירוע | `ishur_yom_combo_g` | `ishur_yom_combo_g_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_combo_gb` | `ishur_yom_combo_gb_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_combo_gp` | `ishur_yom_combo_gp_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_combo_n` | `ishur_yom_combo_n_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_combo_t` | `ishur_yom_combo_t_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_combo_tg` | `ishur_yom_combo_tg_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_combo_tgb` | `ishur_yom_combo_tgb_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_combo_tgp` | `ishur_yom_combo_tgp_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום לפני | `ishur_yom_lifnei` | `ishur_yom_lifnei_anon` | לא קיים, לא הוגש | היי, תזכורת קטנה: מחר חוגגים את {{1}}! 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_g` | `ishur_yom_plain_g_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_gb` | `ishur_yom_plain_gb_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_gp` | `ishur_yom_plain_gp_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_s` | `ishur_yom_plain_s_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_t` | `ishur_yom_plain_t_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_tg` | `ishur_yom_plain_tg_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_tgb` | `ishur_yom_plain_tgb_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| יום האירוע | `ishur_yom_plain_tgp` | `ishur_yom_plain_tgp_anon` | לא קיים, לא הוגש | שלום! מחכים לראותכם היום ב{{1}} 🎉 | אורח יקר |
| הזמנה בסגנון (רשמי / מכובד / שובב) | `hazmana_ishur_serious (+ _img, _vid)` | `hazmana_ishur_serious_anon (+ hazmana_ishur_serious_img_anon, hazmana_ishur_serious_vid_anon)` | לא קיים, לא הוגש | שלום, | אורח יקר |
| הזמנה בסגנון (רשמי / מכובד / שובב) | `hazmana_ishur_respectful (+ _img, _vid)` | `hazmana_ishur_respectful_anon (+ hazmana_ishur_respectful_img_anon, hazmana_ishur_respectful_vid_anon)` | לא קיים, לא הוגש | שלום רב, | אורח יקר |
| הזמנה בסגנון (רשמי / מכובד / שובב) | `hazmana_ishur_playful (+ _img, _vid)` | `hazmana_ishur_playful_anon (+ hazmana_ishur_playful_img_anon, hazmana_ishur_playful_vid_anon)` | לא קיים, לא הוגש | היי! 🥳 | אורח יקר |
| הזמנה, הגרסה החיה | `hazmana_ishur_v2` (KV `invitetmpl`) | `hazmana_ishur_v2_anon` | לא קיים, לא הוגש. הנוסח החי לא שמור בריפו | הגרסה החיה בלי השם, לפי אותו כלל | אורח יקר |
| הזמנה עם שני כפתורים | `hazmana_ishur_v2_yn` (`tmplyn:`) | `hazmana_ishur_v2_yn_anon` | לא קיים, לא הוגש | כנ"ל | אורח יקר |
| הזמנה עם תמונה / וידאו | `hazmana_ishur_img_u`, `hazmana_ishur_vid_u` (`invitetmpl_img/_vid`), `hazmana_ishur_img/_vid` | `<name>_anon` | לא קיים, לא הוגש; צריך דוגמת header | כנ"ל | אורח יקר |
| יום לפני עם תמונה | `ishur_yom_lifnei_img`, `ishur_lifnei_*_img` (`tmplimg:`, 16 מופעלים) | `<name>_anon` | לא קיים, לא הוגש; צריך דוגמת header | כמו השורות של יום לפני | אורח יקר |
| תודה | `ishur_toda_orach`, `ishur_toda_orach_v2` (+`_f`) | `<name>_anon` | לא קיים, לא הוגש; הנוסח לא בריפו | "היי, …" | אורח יקר |
| מתנה / תודה + מתנה, גרסה 2 | `ishur_matana2`, `ishur_toda_matana2` | `<name>_anon` | לא קיים, לא הוגש; הנוסח לא בריפו | "היי, …" | אורח יקר |
| A/B challenger | `<family>_ab<n>` | – | – | – | אורח יקר (same contract as its family) |
| יום האירוע (ישן) | `ishur_yom_haerua(_matana)` | not needed | – | אין שם בהודעה | נשלח כמו שהוא |
| נוסח אישי של הלקוח | `ishur_c_<tok8>_<n>` | not needed | – | אין משתנים | נשלח כמו שהוא |

**About the template guard:** when the guard replaced a live template with a reworded `_r<n>` copy (KV `tmplalt:` today: `ishur_hazmana_shuv`, 8 day-before and 4 event-day names, 13 in all), build that family's no-name copy from the `_r<n>` wording, not from the repo record above. `tmplalt:` is looked up after the guest-name decision, so an approved `_anon` copy goes out as is.

## Templates to submit to Meta (not submitted)

Submit in order of traffic, through the existing `POST /api/meta-admin` (each `worker/templates/anon/*.json` file minus `_note`, plus `admin_key`). Add body examples where the record has none; Meta asks for one per variable.

1. **The live invitation:** `hazmana_ishur_v2_anon`, `hazmana_ishur_img_u_anon`, `hazmana_ishur_vid_u_anon`, `hazmana_ishur_v2_yn_anon`. The wording comes from the live templates, and the media forms need a header sample.
2. **Day-before:** `ishur_yom_lifnei_anon`, then the 8 `ishur_lifnei_combo_*_anon` and 7 `ishur_lifnei_plain_*_anon`, then their `_img_anon` forms.
3. **Event-day:** the 8 `ishur_yom_combo_*_anon` and 8 `ishur_yom_plain_*_anon`, then `ishur_shulchan_anon` and `ishur_shulchan_matana_anon`.
4. **Thank-you and gift:** `ishur_toda_orach_u_anon` (plus `_orach`, `_orach_v2`), `ishur_toda_matana(2)_anon`, `ishur_matana(2)_anon`.
5. **Cancel, postpone, resend:** `ishur_bitul_anon`, `ishur_dchiya_anon`, `ishur_hazmana_shuv_anon`.
6. **Styled invitations:** `hazmana_ishur_{serious,respectful,playful}{,_img,_vid}_anon`.
7. **Sub-event:** `ishur_shabat_hatan_reminder_anon`.

**After approval:** `POST /api/guest-name-twins {admin_key, action:'check'}` reads Meta once and sets `tmplanon:<name>` for every APPROVED `_anon` copy (and clears it for one that is no longer approved). From then on, events with the switch off get the copy.

## Routes

| Route | Auth | Request → response |
|---|---|---|
| `POST /api/event-settings` (existing) | event token | `{token, settings:{…, guest_name:bool}}` → `{ok, settings:{…, guest_name}, …}` |
| `POST /api/guest-name` (new) | `admin_key` | `{admin_key, token, on?:bool}` → `{ok, token, on}` |
| `POST /api/guest-name-twins` (new) | `admin_key` | `{admin_key}` → `{ok, twins:[{base, twin, on}]}` (from KV only); `{admin_key, action:'check'}` → `{ok, twins:[{base, twin, status, category, on}]}` (reads Meta, sets/clears `tmplanon:`) |
| `POST /api/preview-messages` (changed) | event token | adds `guest_name:bool`, `name_mode` = `'name'` / `'neutral'` / `'twin'`, `neutral:'אורח יקר'`. `guest` is `''` when the switch is off. The day-before and event-day messages are already filled the way the sender will fill them. |

## Not covered

- **Shir's phone calls** still say the guest's name. They are not messages, so this was not in scope; the setting is there if the call prompt should follow it too.
- **The board's preview** decides "twin" vs "neutral" for the invitation by the live invitation (`invitetmpl`), not by the event's styled template.
