/* ============================================================================
   ishur.io · message styles
   ----------------------------------------------------------------------------
   The tone of the invitation each guest receives, with a sample per event type.
   Shared by the landing page preview and the post-upload setup step, so what a
   customer picks is exactly what they were shown.
   ========================================================================== */

window.ISHUR_MESSAGES = (function () {

  /* the four tones an invitation can be sent in */
  var STYLES = [
    { key: 'happy',      label: 'שמחה',  note: 'חמה וישירה, מתאימה לרוב האירועים' },
    { key: 'serious',    label: 'רשמי',  note: 'מנוסחת בגוף שלישי, ללא סלנג' },
    { key: 'respectful', label: 'מכובד', note: 'לשון גבוהה, לאירועים דתיים ומסורתיים' },
    { key: 'playful',    label: 'שובב',  note: 'קלילה, לחברים ולאירועים צעירים' }
  ];

  /* sent only if something changes, never as the invitation itself */
  var SITUATIONAL = ['postponed', 'canceled'];

  var BY_EVENT = {
  wedding:{
    happy:{tag:'😊 שמחה',html:`<div class="msg-style-tag">סגנון שמחה</div><p class="msg-text">שלום [שם]! 🎊<br><br>נועה ויונתן מתחתנים ומזמינים אתכם לשמוח איתם!<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>נשמח מאוד לראותכם! 🤍</p>`,note:''},
    serious:{tag:'🎩 רשמי',html:`<div class="msg-style-tag">סגנון רשמי</div><p class="msg-text">🎊 החתונה של נועה ויונתן!<br><br>אנו שמחים להזמינכם לשמוח איתנו ביום המאושר בחיינו 💍<br>15/09/2025 | אולם הגן הקסום, רמת גן<br><br>בברכה, נועה ויונתן 🤍</p>`,note:''},
    respectful:{tag:'🙏 מכובד',html:`<div class="msg-style-tag">סגנון מכובד</div><p class="msg-text">שלום רב, 🙏<br><br>הננו מתכבדים להזמינכם לאירוע נישואינו. 💍<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>בהוקרה, נועה ויונתן 🤍</p>`,note:''},
    playful:{tag:'🎉 שובב',html:`<div class="msg-style-tag">סגנון שובב</div><p class="msg-text">נועה ויונתן עושים את זה רשמי ואתם מוזמנים! 🥳<br><br>15.9.2025 | הגן הקסום, רמת גן<br><br>בואו תרקדו איתנו 💃🕺<br>נועה ויונתן</p>`,note:''},
    postponed:{tag:'📅 דחייה/עדכון',html:`<div class="msg-style-tag">הודעת דחייה</div><p class="msg-text">שלום,<br><br>רוצים לעדכן שאירוע החתונה שלנו <b>נדחה</b>.<br><br>📅 <b>התאריך החדש: 1 בנובמבר 2025</b><br>📍 המקום נשאר: אולם הגן הקסום<br><br>מצטערים על אי הנוחות 🙏<br>נועה ויונתן</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'},
    canceled:{tag:'⚠️ ביטול',html:`<div class="msg-style-tag">הודעת ביטול</div><p class="msg-text">שלום,<br><br>מצטערים להודיע שנאלצנו <b>לבטל</b> את אירוע החתונה שתוכנן ל-15 בספטמבר 2025.<br><br>תודה על ההבנה ועל התמיכה 🙏<br>נועה ויונתן</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'}
  },
  bar:{
    happy:{tag:'😊 שמחה',html:`<div class="msg-style-tag">סגנון שמחה</div><p class="msg-text">שלום [שם]! 🎊<br><br>דניאל עולה לתורה ואתם מוזמנים לשמוח איתנו!<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>נשמח לראותכם! 🎉</p>`,note:''},
    serious:{tag:'🎩 רשמי',html:`<div class="msg-style-tag">סגנון רשמי</div><p class="msg-text">🎉 בר המצווה של דניאל!<br><br>אנו מתכבדים להזמינכם לחגוג את עלייתו לתורה 📖<br>15/09/2025 | אולם הגן הקסום, רמת גן<br><br>בברכה, משפחת לוי</p>`,note:''},
    respectful:{tag:'🙏 מכובד',html:`<div class="msg-style-tag">סגנון מכובד</div><p class="msg-text">שלום רב, 🙏<br><br>הננו מתכבדים להזמינכם לאירוע בר המצווה של בננו דניאל.<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>בהוקרה, משפחת לוי</p>`,note:''},
    playful:{tag:'🎉 שובב',html:`<div class="msg-style-tag">סגנון שובב</div><p class="msg-text">דניאל נעשה גדול ועושה מסיבה! 🎉<br><br>15.9.2025 | הגן הקסום, רמת גן<br><br>בואו לחגוג איתנו 🕺<br>משפחת לוי</p>`,note:''},
    postponed:{tag:'📅 דחייה',html:`<div class="msg-style-tag">הודעת דחייה</div><p class="msg-text">שלום,<br><br>אירוע בר המצווה של דניאל <b>נדחה</b>.<br>📅 <b>תאריך חדש: 1 בנובמבר 2025</b><br><br>מצטערים על אי הנוחות 🙏<br>משפחת לוי</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'},
    canceled:{tag:'⚠️ ביטול',html:`<div class="msg-style-tag">הודעת ביטול</div><p class="msg-text">שלום,<br><br>מצטערים להודיע על ביטול אירוע בר המצווה שתוכנן ל-15 בספטמבר.<br><br>תודה על ההבנה 🙏<br>משפחת לוי</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'}
  },
  bat:{
    happy:{tag:'😊 שמחה',html:`<div class="msg-style-tag">סגנון שמחה</div><p class="msg-text">שלום [שם]! 🎊<br><br>מיה חוגגת בת מצווה ואתם מוזמנים!<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>נשמח לראותכם! 🌸</p>`,note:''},
    serious:{tag:'🎩 רשמי',html:`<div class="msg-style-tag">סגנון רשמי</div><p class="msg-text">🌸 בת המצווה של מיה!<br><br>אנו שמחים להזמינכם לחגוג את האירוע המיוחד<br>15/09/2025 | אולם הגן הקסום, רמת גן<br><br>בברכה, משפחת כהן</p>`,note:''},
    respectful:{tag:'🙏 מכובד',html:`<div class="msg-style-tag">סגנון מכובד</div><p class="msg-text">שלום רב, 🙏<br><br>הננו מתכבדים להזמינכם לאירוע בת המצווה של בתנו מיה.<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>בהוקרה, משפחת כהן</p>`,note:''},
    playful:{tag:'🎉 שובב',html:`<div class="msg-style-tag">סגנון שובב</div><p class="msg-text">מיה נעשית גדולה ועושה מסיבה! 🌸🎉<br><br>15.9.2025 | הגן הקסום, רמת גן<br><br>בואו לחגוג 💃<br>משפחת כהן</p>`,note:''},
    postponed:{tag:'📅 דחייה',html:`<div class="msg-style-tag">הודעת דחייה</div><p class="msg-text">שלום,<br><br>אירוע בת המצווה של מיה <b>נדחה</b>.<br>📅 <b>תאריך חדש: 1 בנובמבר 2025</b><br><br>מצטערים על אי הנוחות 🙏<br>משפחת כהן</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'},
    canceled:{tag:'⚠️ ביטול',html:`<div class="msg-style-tag">הודעת ביטול</div><p class="msg-text">שלום,<br><br>מצטערים להודיע על ביטול אירוע בת המצווה שתוכנן ל-15 בספטמבר.<br><br>תודה על ההבנה 🙏<br>משפחת כהן</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'}
  },
  brit:{
    happy:{tag:'😊 שמחה',html:`<div class="msg-style-tag">סגנון שמחה</div><p class="msg-text">שלום [שם]! 🎊<br><br>אנחנו שמחים לבשר על הגעתו של יובל ולהזמינכם לברית!<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>נשמח לראותכם! 👶</p>`,note:''},
    serious:{tag:'🎩 רשמי',html:`<div class="msg-style-tag">סגנון רשמי</div><p class="msg-text">👶 ברית המילה של יובל<br><br>אנו מתכבדים להזמינכם לשמוח עמנו באירוע הברית<br>15/09/2025 | אולם הגן הקסום, רמת גן<br><br>בברכה, משפחת ישראלי</p>`,note:''},
    respectful:{tag:'🙏 מכובד',html:`<div class="msg-style-tag">סגנון מכובד</div><p class="msg-text">שלום רב, 🙏<br><br>הננו מתכבדים להזמינכם לאירוע ברית בננו יובל.<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>בהוקרה, משפחת ישראלי</p>`,note:''},
    playful:{tag:'🎉 שובב',html:`<div class="msg-style-tag">סגנון שובב</div><p class="msg-text">יובל הגיע לעולם ואנחנו חוגגים! 👶🎉<br><br>15.9.2025 | הגן הקסום, רמת גן<br><br>בואו לשמוח איתנו!<br>משפחת ישראלי</p>`,note:''},
    postponed:{tag:'📅 דחייה',html:`<div class="msg-style-tag">הודעת דחייה</div><p class="msg-text">שלום,<br><br>אירוע הברית <b>נדחה</b> לתאריך חדש.<br>📅 <b>1 בנובמבר 2025</b><br><br>מצטערים על אי הנוחות 🙏<br>משפחת ישראלי</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'},
    canceled:{tag:'⚠️ ביטול',html:`<div class="msg-style-tag">הודעת ביטול</div><p class="msg-text">שלום,<br><br>מצטערים להודיע על ביטול אירוע הברית שתוכנן ל-15 בספטמבר.<br><br>תודה על ההבנה 🙏<br>משפחת ישראלי</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'}
  },
  bday:{
    happy:{tag:'😊 שמחה',html:`<div class="msg-style-tag">סגנון שמחה</div><p class="msg-text">שלום [שם]! 🎊<br><br>רינה חוגגת יום הולדת 40 ואתם מוזמנים!<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>נשמח לחגוג יחד! 🎂</p>`,note:''},
    serious:{tag:'🎩 רשמי',html:`<div class="msg-style-tag">סגנון רשמי</div><p class="msg-text">🎂 יום הולדת 40 לרינה!<br><br>אנו מזמינים אתכם לחגוג את האירוע המיוחד<br>15/09/2025 | אולם הגן הקסום, רמת גן<br><br>בברכה, משפחת כהן</p>`,note:''},
    respectful:{tag:'🙏 מכובד',html:`<div class="msg-style-tag">סגנון מכובד</div><p class="msg-text">שלום רב, 🙏<br><br>הננו מתכבדים להזמינכם לאירוע יום הולדת 40 של רינה.<br>📅 15 בספטמבר 2025 | 📍 אולם הגן הקסום<br><br>בהוקרה, משפחת כהן</p>`,note:''},
    playful:{tag:'🎉 שובב',html:`<div class="msg-style-tag">סגנון שובב</div><p class="msg-text">רינה עושה 40 ועושה מסיבה! 🎂🥳<br><br>15.9.2025 | הגן הקסום, רמת גן<br><br>בואו לחגוג איתה 🎉<br>משפחת כהן</p>`,note:''},
    postponed:{tag:'📅 דחייה',html:`<div class="msg-style-tag">הודעת דחייה</div><p class="msg-text">שלום,<br><br>מסיבת יום ההולדת של רינה <b>נדחתה</b>.<br>📅 <b>תאריך חדש: 1 בנובמבר 2025</b><br><br>מצטערים על אי הנוחות 🙏</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'},
    canceled:{tag:'⚠️ ביטול',html:`<div class="msg-style-tag">הודעת ביטול</div><p class="msg-text">שלום,<br><br>מצטערים להודיע על ביטול אירוע יום ההולדת שתוכנן ל-15 בספטמבר.<br><br>תודה על ההבנה 🙏</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'}
  },
  biz:{
    happy:{tag:'😊 ידידותי',html:`<div class="msg-style-tag">סגנון ידידותי</div><p class="msg-text">שלום [שם]! 🎊<br><br>אנחנו שמחים להזמינכם לכנס השנתי של חברת אלפא!<br>📅 15 בספטמבר 2025 | 📍 מלון הילטון, תל אביב<br><br>נשמח לראותכם!</p>`,note:''},
    serious:{tag:'🎩 רשמי',html:`<div class="msg-style-tag">סגנון רשמי</div><p class="msg-text">🏢 כנס שנתי – חברת אלפא<br><br>אנו מזמינים אתכם לאירוע השנתי שלנו<br>15/09/2025 | מלון הילטון, תל אביב<br><br>בברכה, הנהלת חברת אלפא</p>`,note:''},
    respectful:{tag:'🙏 מכובד',html:`<div class="msg-style-tag">סגנון מכובד</div><p class="msg-text">שלום רב,<br><br>הננו מתכבדים להזמינכם לכנס השנתי של חברת אלפא.<br>📅 15 בספטמבר 2025 | 📍 מלון הילטון, תל אביב<br><br>בהוקרה, הנהלת חברת אלפא</p>`,note:''},
    playful:{tag:'🎉 שובב',html:`<div class="msg-style-tag">סגנון שובב</div><p class="msg-text">חברת אלפא עושה כנס ואתם מוזמנים! 🎉<br><br>15.9.2025 | מלון הילטון, תל אביב<br><br>בואו נצמח ביחד 🚀</p>`,note:''},
    postponed:{tag:'📅 דחייה',html:`<div class="msg-style-tag">הודעת דחייה</div><p class="msg-text">שלום,<br><br>הכנס השנתי <b>נדחה</b> לתאריך חדש.<br>📅 <b>1 בנובמבר 2025</b><br><br>מצטערים על אי הנוחות 🙏<br>הנהלת חברת אלפא</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'},
    canceled:{tag:'⚠️ ביטול',html:`<div class="msg-style-tag">הודעת ביטול</div><p class="msg-text">שלום,<br><br>מצטערים להודיע על ביטול הכנס שתוכנן ל-15 בספטמבר.<br><br>תודה על ההבנה 🙏<br>הנהלת חברת אלפא</p>`,note:'⚠️ זמין בחבילת "הכל כלול" בלבד'}
  }
};

  /* occasions added later fall back to the wedding wording */
  var ALIAS = { hina: 'wedding', other: 'wedding' };

  function forEvent(key) {
    return BY_EVENT[key] || BY_EVENT[ALIAS[key]] || BY_EVENT.wedding;
  }

  function sample(eventKey, styleKey) {
    var set = forEvent(eventKey);
    return set[styleKey] || set.happy;
  }

  return {
    STYLES: STYLES,
    SITUATIONAL: SITUATIONAL,
    BY_EVENT: BY_EVENT,
    forEvent: forEvent,
    sample: sample
  };
})();
