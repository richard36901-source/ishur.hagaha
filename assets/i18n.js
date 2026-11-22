/* ============================================================================
   ishur.io · the client board in other languages (Richard 21/11/2026)
   ----------------------------------------------------------------------------
   The board is written in Hebrew and stays that way. This file lays a
   translation OVER what the board renders: every text node, placeholder,
   title and aria-label whose Hebrew is in the dictionary is shown in the
   chosen language, and put back when Hebrew is chosen again. The board's own
   code never changes and never reads the translated text.

   · Hebrew is the source and the default. A text that is not in the
     dictionary stays in Hebrew — never blank, never broken.
   · Numbers are lifted out before the lookup ("אישרו · 30" is looked up as
     "אישרו · {n}"), so one line covers every count.
   · Dates ("יום שבת, 21 בנובמבר 2026") are rebuilt by the browser in the
     chosen language.
   · What belongs to the event is never translated: guest names, the hosts'
     names, the venue, and the invitation wording the guests receive.
   · The choice is kept per device (localStorage ishur_lang); ?lang=en sets it.

   Rows: [Hebrew, English, French, Spanish, Yiddish, Arabic, Russian]
   ========================================================================== */
(function () {
  'use strict';
  var LANGS = [
    { c: 'he', n: 'עברית', dir: 'rtl', loc: 'he-IL' },
    { c: 'en', n: 'English', dir: 'ltr', loc: 'en-GB' },
    { c: 'fr', n: 'Français', dir: 'ltr', loc: 'fr-FR' },
    { c: 'es', n: 'Español', dir: 'ltr', loc: 'es-ES' },
    { c: 'yi', n: 'ייִדיש', dir: 'rtl', loc: 'yi' },
    { c: 'ar', n: 'العربية', dir: 'rtl', loc: 'ar' },
    { c: 'ru', n: 'Русский', dir: 'ltr', loc: 'ru-RU' },
    { c: 'am', n: 'አማርኛ', dir: 'ltr', loc: 'am' },
    { c: 'pt', n: 'Português', dir: 'ltr', loc: 'pt-BR' }
  ];
  /* languages that live only in a dictionary file (assets/i18n/<code>.json), with no column in ROWS below */
  var FILE_ONLY = { am: 1, pt: 1 };
  var IDX = { en: 1, fr: 2, es: 3, yi: 4, ar: 5, ru: 6 };

  var ROWS = [
    /* ── sign-in ── */
    ['קוד כניסה', 'Sign-in code', 'Code d’accès', 'Código de acceso', 'אַרײַנגאַנג־קאָד', 'رمز الدخول', 'Код входа'],
    ['הקלידו את הקוד בן {n} הספרות שקיבלתם מאיתנו', 'Type the {n}-digit code you received from us', 'Saisissez le code à {n} chiffres que nous vous avons envoyé', 'Escriba el código de {n} dígitos que le enviamos', 'שרײַבט אַרײַן דעם קאָד פֿון {n} ציפֿערן וואָס איר האָט באַקומען פֿון אונדז', 'اكتبوا الرمز المكوّن من {n} أرقام الذي استلمتموه منّا', 'Введите код из {n} цифр, который вы получили от нас'],
    ['כניסה', 'Sign in', 'Entrer', 'Entrar', 'אַרײַנגיין', 'دخول', 'Войти'],
    ['שלחו לי את הקוד לוואטסאפ', 'Send me the code on WhatsApp', 'Envoyez-moi le code sur WhatsApp', 'Envíenme el código por WhatsApp', 'שיקט מיר דעם קאָד אויף וואַטסאַפּ', 'أرسلوا لي الرمز على واتساب', 'Пришлите мне код в WhatsApp'],
    ['הקוד נשלח רק למספר שאיתו נרשמתם.', 'The code is sent only to the number you registered with.', 'Le code est envoyé uniquement au numéro avec lequel vous vous êtes inscrit.', 'El código se envía solo al número con el que se registró.', 'דער קאָד ווערט געשיקט נאָר צום נומער מיט וועלכן איר האָט זיך פֿאַרשריבן.', 'يُرسل الرمز فقط إلى الرقم الذي سجّلتم به.', 'Код отправляется только на номер, с которым вы регистрировались.'],
    ['משהו לא מסתדר?', 'Something not working?', 'Un souci ?', '¿Algo no funciona?', 'עפּעס גייט נישט?', 'هل هناك مشكلة؟', 'Что-то не получается?'],
    ['כתבו לנו', 'Write to us', 'Écrivez-nous', 'Escríbanos', 'שרײַבט אונדז', 'اكتبوا لنا', 'Напишите нам'],
    ['כניסה ללוח הבקרה', 'Sign in to your board', 'Accès à votre tableau de bord', 'Acceso a su panel', 'אַרײַנגאַנג צום ברעט', 'الدخول إلى لوحة المتابعة', 'Вход в панель'],
    ['נכנסים עם מספר הטלפון וקוד הכניסה שלכם ({n} ספרות)', 'Sign in with your phone number and your sign-in code ({n} digits)', 'Connectez-vous avec votre numéro de téléphone et votre code d’accès ({n} chiffres)', 'Entre con su número de teléfono y su código de acceso ({n} dígitos)', 'מען גייט אַרײַן מיטן טעלעפֿאָן־נומער און אײַער אַרײַנגאַנג־קאָד ({n} ציפֿערן)', 'ادخلوا برقم الهاتف ورمز الدخول الخاص بكم ({n} أرقام)', 'Войдите по номеру телефона и коду входа ({n} цифры)'],
    ['מספר טלפון', 'Phone number', 'Numéro de téléphone', 'Número de teléfono', 'טעלעפֿאָן־נומער', 'رقم الهاتف', 'Номер телефона'],
    ['אין לי את הקוד · שלחו לי קוד חד-פעמי לוואטסאפ', 'I don’t have the code · send me a one-time code on WhatsApp', 'Je n’ai pas le code · envoyez-moi un code à usage unique sur WhatsApp', 'No tengo el código · envíenme un código de un solo uso por WhatsApp', 'איך האָב נישט דעם קאָד · שיקט מיר אַן איינמאָליקן קאָד אויף וואַטסאַפּ', 'ليس لديّ الرمز · أرسلوا لي رمزًا لمرة واحدة على واتساب', 'У меня нет кода · пришлите одноразовый код в WhatsApp'],
    ['הקוד מגיע לוואטסאפ של המספר שאיתו נרשמתם.', 'The code arrives on the WhatsApp of the number you registered with.', 'Le code arrive sur le WhatsApp du numéro avec lequel vous vous êtes inscrit.', 'El código llega al WhatsApp del número con el que se registró.', 'דער קאָד קומט אָן אויף וואַטסאַפּ פֿונעם נומער מיט וועלכן איר האָט זיך פֿאַרשריבן.', 'يصل الرمز إلى واتساب الرقم الذي سجّلتم به.', 'Код придёт в WhatsApp на номер, с которым вы регистрировались.'],
    /* ── header and menu ── */
    ['נותרו {n} ימים לאירוע', '{n} days to the event', 'J-{n} avant l’événement', 'Faltan {n} días para el evento', 'נאָך {n} טעג ביז דער שׂימחה', 'بقي {n} يومًا على المناسبة', 'До события {n} дн.'],
    ['האירוע היה לפני {n} ימים', 'The event was {n} days ago', 'L’événement a eu lieu il y a {n} jours', 'El evento fue hace {n} días', 'די שׂימחה איז געווען מיט {n} טעג צוריק', 'كانت المناسبة قبل {n} يومًا', 'Событие прошло {n} дн. назад'],
    ['האירוע שלכם', 'Your event', 'Votre événement', 'Su evento', 'אײַער שׂימחה', 'مناسبتكم', 'Ваше событие'],
    ['האירועים שלכם', 'Your events', 'Vos événements', 'Sus eventos', 'אײַערע שׂימחות', 'مناسباتكم', 'Ваши события'],
    ['בחרו את האירוע שתרצו לראות', 'Choose the event you want to see', 'Choisissez l’événement à afficher', 'Elija el evento que quiere ver', 'קלײַבט אויס די שׂימחה וואָס איר ווילט זען', 'اختاروا المناسبة التي تريدون عرضها', 'Выберите событие'],
    ['בלוח', 'On this board', 'Dans le tableau', 'En el panel', 'אויפֿן ברעט', 'في اللوحة', 'В панели'],
    ['כל האירועים שלי ›', 'All my events ›', 'Tous mes événements ›', 'Todos mis eventos ›', 'אַלע מײַנע שׂימחות ›', 'كل مناسباتي ›', 'Все мои события ›'],
    ['ההזמנה שלכם', 'Your invitation', 'Votre invitation', 'Su invitación', 'אײַער אײַנלאַדונג', 'دعوتكم', 'Ваше приглашение'],
    ['המצב', 'Status', 'Situation', 'Estado', 'דער מצבֿ', 'الحالة', 'Сводка'],
    ['המוזמנים', 'Guests', 'Invités', 'Invitados', 'די געסט', 'المدعوون', 'Гости'],
    ['לוח השליחות', 'Send schedule', 'Calendrier des envois', 'Calendario de envíos', 'שיק־פּלאַן', 'جدول الإرسال', 'График рассылок'],
    ['הזמן חבר', 'Refer a friend', 'Parrainer un ami', 'Recomiende a un amigo', 'ברענג אַ חבֿר', 'ادعُ صديقًا', 'Пригласить друга'],
    ['קישור לקבוצה', 'Group link', 'Lien pour le groupe', 'Enlace para el grupo', 'לינק פֿאַר דער גרופּע', 'رابط للمجموعة', 'Ссылка для группы'],
    ['הוספת מוזמנים', 'Add guests', 'Ajouter des invités', 'Añadir invitados', 'צולייגן געסט', 'إضافة مدعوين', 'Добавить гостей'],
    ['שדרוגים ותוספות', 'Upgrades and add-ons', 'Options et suppléments', 'Mejoras y extras', 'אויפֿבעסערונגען און צוגאָבן', 'ترقيات وإضافات', 'Улучшения и дополнения'],
    ['חשבונית', 'Invoice', 'Facture', 'Factura', 'חשבון', 'الفاتورة', 'Счёт'],
    ['האירוע הסתיים. הנתונים נשמרים לצפייה.', 'The event is over. The data is kept for viewing.', 'L’événement est terminé. Les données restent consultables.', 'El evento ha terminado. Los datos se conservan para consulta.', 'די שׂימחה איז פֿאַריבער. די דאַטן בלײַבן צום אָנקוקן.', 'انتهت المناسبة. البيانات محفوظة للعرض.', 'Событие завершено. Данные сохранены для просмотра.'],
    ['האירוע הסתיים, הנתונים נשמרים לצפייה', 'The event is over, the data is kept for viewing', 'L’événement est terminé, les données restent consultables', 'El evento ha terminado, los datos se conservan para consulta', 'די שׂימחה איז פֿאַריבער, די דאַטן בלײַבן צום אָנקוקן', 'انتهت المناسبة، البيانات محفوظة للعرض', 'Событие завершено, данные сохранены для просмотра'],
    ['האירוע הסתיים. השיבוץ נשמר לצפייה.', 'The event is over. The seating is kept for viewing.', 'L’événement est terminé. Le plan de table reste consultable.', 'El evento ha terminado. La distribución de mesas se conserva para consulta.', 'די שׂימחה איז פֿאַריבער. דער זיץ־סדר בלײַבט צום אָנקוקן.', 'انتهت المناسبة. ترتيب الجلوس محفوظ للعرض.', 'Событие завершено. Рассадка сохранена для просмотра.'],
    ['האירוע הסתיים', 'The event is over', 'L’événement est terminé', 'El evento ha terminado', 'די שׂימחה איז פֿאַריבער', 'انتهت المناسبة', 'Событие завершено'],
    /* ── the invitation ── */
    ['אין תמונה או וידאו', 'No image or video', 'Pas d’image ni de vidéo', 'Sin imagen ni vídeo', 'נישטאָ קיין בילד אָדער ווידעאָ', 'لا توجد صورة أو فيديو', 'Нет изображения или видео'],
    ['להזמנה. ההזמנה תישלח כטקסט בלבד.', 'for the invitation. It will be sent as text only.', 'pour l’invitation. Elle sera envoyée en texte seul.', 'para la invitación. Se enviará solo como texto.', 'פֿאַר דער אײַנלאַדונג. זי וועט געשיקט ווערן נאָר ווי טעקסט.', 'للدعوة. ستُرسل الدعوة كنص فقط.', 'для приглашения. Оно будет отправлено только текстом.'],
    ['ההזמנות כבר יצאו, אי אפשר להחליף.', 'The invitations have already gone out, so it can’t be replaced.', 'Les invitations sont déjà parties, le remplacement n’est plus possible.', 'Las invitaciones ya se enviaron, no se puede cambiar.', 'די אײַנלאַדונגען זענען שוין אַרויס, מען קען נישט בײַטן.', 'تم إرسال الدعوات، لا يمكن الاستبدال.', 'Приглашения уже отправлены, заменить нельзя.'],
    ['החלפת התמונה / הווידאו', 'Replace the image / video', 'Remplacer l’image / la vidéo', 'Cambiar la imagen / el vídeo', 'בײַטן דאָס בילד / דעם ווידעאָ', 'استبدال الصورة / الفيديو', 'Заменить изображение / видео'],
    ['אפשר להחליף עד {n} שעות לפני השליחה הראשונה ({n}).', 'You can replace it up to {n} hours before the first send ({n}).', 'Remplacement possible jusqu’à {n} heures avant le premier envoi ({n}).', 'Se puede cambiar hasta {n} horas antes del primer envío ({n}).', 'מען קען בײַטן ביז {n} שעה פֿאַרן ערשטן שיקן ({n}).', 'يمكن الاستبدال حتى {n} ساعة قبل الإرسال الأول ({n}).', 'Заменить можно не позднее чем за {n} ч. до первой рассылки ({n}).'],
    ['נוסח ההזמנה', 'Invitation wording', 'Texte de l’invitation', 'Texto de la invitación', 'נוסח פֿון דער אײַנלאַדונג', 'نص الدعوة', 'Текст приглашения'],
    ['נוסח שמחה', 'Festive wording', 'Texte festif', 'Texto festivo', 'פֿריילעכער נוסח', 'صيغة احتفالية', 'Праздничный текст'],
    ['שנה נוסח', 'Change wording', 'Changer le texte', 'Cambiar el texto', 'בײַטן דעם נוסח', 'تغيير الصيغة', 'Изменить текст'],
    ['שמחה', 'Festive', 'Festif', 'Festivo', 'פֿריילעך', 'احتفالية', 'Праздничный'],
    ['רשמי · בקרוב', 'Formal · soon', 'Formel · bientôt', 'Formal · pronto', 'אָפֿיציעל · באַלד', 'رسمية · قريبًا', 'Официальный · скоро'],
    ['מכובד · בקרוב', 'Dignified · soon', 'Solennel · bientôt', 'Solemne · pronto', 'כּבֿודיק · באַלד', 'وقورة · قريبًا', 'Торжественный · скоро'],
    ['שובב · בקרוב', 'Playful · soon', 'Espiègle · bientôt', 'Divertido · pronto', 'שטיפֿעריש · באַלד', 'مرحة · قريبًا', 'Игривый · скоро'],
    ['נוסח אישי', 'Your own wording', 'Texte personnalisé', 'Texto propio', 'אייגענער נוסח', 'صيغة خاصة', 'Свой текст'],
    ['נוסח בהתאמה אישית', 'Custom wording', 'Texte sur mesure', 'Texto a medida', 'צוגעפּאַסטער נוסח', 'صيغة مخصّصة', 'Индивидуальный текст'],
    ['רוצים ניסוח משלכם? כותבים אותו, אנחנו מגישים לאישור וואטסאפ, וברגע שמאושר ההזמנה יוצאת בניסוח שלכם.', 'Want your own wording? Write it, we submit it to WhatsApp for approval, and once approved the invitation goes out in your words.', 'Vous voulez votre propre texte ? Écrivez-le, nous le soumettons à WhatsApp, et dès qu’il est approuvé l’invitation part avec vos mots.', '¿Quiere su propio texto? Escríbalo, lo enviamos a WhatsApp para su aprobación y, una vez aprobado, la invitación sale con sus palabras.', 'ווילט איר אַן אייגענעם נוסח? שרײַבט אים, מיר גיבן אים אַרײַן צו וואַטסאַפּ צו באַשטעטיקן, און ווי נאָר ער ווערט באַשטעטיקט גייט די אײַנלאַדונג אַרויס מיט אײַער נוסח.', 'تريدون صيغتكم الخاصة؟ اكتبوها، ونحن نقدّمها لموافقة واتساب، وعند الموافقة تُرسل الدعوة بصيغتكم.', 'Хотите свой текст? Напишите его, мы отправим на одобрение в WhatsApp, и после одобрения приглашение уйдёт в вашей редакции.'],
    ['הנוסח הזה עוד בבדיקה של וואטסאפ', 'This wording is still under review by WhatsApp', 'Ce texte est encore en cours de validation par WhatsApp', 'Este texto aún está en revisión por WhatsApp', 'דער נוסח איז נאָך אין בדיקה בײַ וואַטסאַפּ', 'هذه الصيغة ما زالت قيد المراجعة لدى واتساب', 'Этот текст ещё на проверке в WhatsApp'],
    ['סגנון הנוסח', 'Wording style', 'Style du texte', 'Estilo del texto', 'סטיל פֿונעם נוסח', 'أسلوب الصيغة', 'Стиль текста'],
    ['📱 איך זה נראה למוזמנים', '📱 How guests see it', '📱 Ce que voient les invités', '📱 Cómo lo ven los invitados', '📱 ווי די געסט זעען עס', '📱 كيف يراها المدعوون', '📱 Как это видят гости'],
    ['📲 הוסיפו למסך הבית', '📲 Add to home screen', '📲 Ajouter à l’écran d’accueil', '📲 Añadir a la pantalla de inicio', '📲 לייגט צו צום היים־עקראַן', '📲 أضيفوا إلى الشاشة الرئيسية', '📲 Добавить на главный экран'],
    ['🎨 עיצוב ההזמנה', '🎨 Invitation design', '🎨 Design de l’invitation', '🎨 Diseño de la invitación', '🎨 אויסזען פֿון דער אײַנלאַדונג', '🎨 تصميم الدعوة', '🎨 Дизайн приглашения'],
    /* ── the numbers ── */
    ['מוזמנים', 'Guests', 'Invités', 'Invitados', 'געסט', 'مدعوون', 'Гостей'],
    ['{n} רשומות', '{n} records', '{n} fiches', '{n} registros', '{n} רשימות', '{n} سجلًا', 'Записей: {n}'],
    ['אישרו', 'Confirmed', 'Confirmés', 'Confirmados', 'באַשטעטיקט', 'أكّدوا', 'Придут'],
    ['לא מגיעים', 'Not coming', 'Absents', 'No asisten', 'קומען נישט', 'لن يحضروا', 'Не придут'],
    ['לא בטוחים', 'Not sure', 'Indécis', 'Indecisos', 'נישט זיכער', 'غير متأكدين', 'Не уверены'],
    ['לא ענו', 'No answer', 'Sans réponse', 'Sin respuesta', 'נישט געענטפֿערט', 'لم يجيبوا', 'Не ответили'],
    ['נכשלו', 'Not delivered', 'Non remis', 'No entregados', 'נישט אָנגעקומען', 'لم تصلهم', 'Не доставлено'],
    ['הוספה', 'Add', 'Ajouter', 'Añadir', 'צולייגן', 'إضافة', 'Добавить'],
    ['התחייבות לאולם', 'Commitment to the venue', 'Engagement auprès de la salle', 'Compromiso con el salón', 'התחייבֿות צום זאַל', 'الالتزام للقاعة', 'Гарантия для зала'],
    ['מומלץ: {n}', 'Recommended: {n}', 'Recommandé : {n}', 'Recomendado: {n}', 'רעקאָמענדירט: {n}', 'المقترح: {n}', 'Рекомендуем: {n}'],
    ['המלצה תופיע כשרוב המוזמנים יענו', 'A recommendation appears once most guests have answered', 'Une recommandation s’affichera quand la plupart des invités auront répondu', 'La recomendación aparecerá cuando la mayoría de los invitados haya respondido', 'אַ רעקאָמענדאַציע וועט זיך באַווײַזן ווען ס׳רובֿ געסט וועלן ענטפֿערן', 'ستظهر التوصية عندما يجيب معظم المدعوين', 'Рекомендация появится, когда ответит большинство гостей'],
    ['אחוז מענה', 'Response rate', 'Taux de réponse', 'Tasa de respuesta', 'פּראָצענט ענטפֿערס', 'نسبة الرد', 'Доля ответивших'],
    ['🚌 הסעה', '🚌 Shuttle', '🚌 Navette', '🚌 Transporte', '🚌 הסעה', '🚌 مواصلات', '🚌 Трансфер'],
    ['🪑 סידור הושבה', '🪑 Seating plan', '🪑 Plan de table', '🪑 Distribución de mesas', '🪑 זיץ־סדר', '🪑 ترتيب الجلوس', '🪑 Рассадка'],
    ['🖨 רשימה להדפסה', '🖨 Printable list', '🖨 Liste à imprimer', '🖨 Lista para imprimir', '🖨 רשימה צום דרוקן', '🖨 قائمة للطباعة', '🖨 Список для печати'],
    ['📱 ברקוד שולחנות', '📱 Table QR code', '📱 QR code des tables', '📱 Código QR de mesas', '📱 QR־קאָד פֿאַר טישן', '📱 رمز QR للطاولات', '📱 QR-код столов'],
    ['💰 תקציב', '💰 Budget', '💰 Budget', '💰 Presupuesto', '💰 בודזשעט', '💰 الميزانية', '💰 Бюджет'],
    ['🗓 לוז אירוע', '🗓 Event timeline', '🗓 Déroulé de l’événement', '🗓 Programa del evento', '🗓 סדר פֿון דער שׂימחה', '🗓 برنامج المناسبة', '🗓 Программа события'],
    ['⟳ החלפת הרשימה', '⟳ Replace the list', '⟳ Remplacer la liste', '⟳ Reemplazar la lista', '⟳ בײַטן די רשימה', '⟳ استبدال القائمة', '⟳ Заменить список'],
    ['רשימת מוזמנים לפי שולחן, עם ריבוע סימון למי שהגיע — להדפסה או PDF', 'Guest list by table, with a tick box for arrivals — to print or save as PDF', 'Liste des invités par table, avec une case à cocher à l’arrivée — à imprimer ou en PDF', 'Lista de invitados por mesa, con casilla para marcar la llegada — para imprimir o PDF', 'רשימה פֿון געסט לויט טיש, מיט אַ קעסטל צו צייכענען ווער ס׳איז געקומען — צום דרוקן אָדער PDF', 'قائمة المدعوين حسب الطاولة مع مربع لتأشير الحضور — للطباعة أو PDF', 'Список гостей по столам с отметкой о приходе — для печати или PDF'],
    ['ברקוד לכניסה: האורח סורק, מקליד שם או טלפון ורואה את השולחן שלו', 'A code at the entrance: the guest scans it, types a name or phone and sees their table', 'Un code à l’entrée : l’invité scanne, saisit son nom ou son téléphone et voit sa table', 'Un código en la entrada: el invitado escanea, escribe su nombre o teléfono y ve su mesa', 'אַ קאָד בײַם אַרײַנגאַנג: דער גאַסט סקאַנירט, שרײַבט אַ נאָמען אָדער טעלעפֿאָן און זעט זײַן טיש', 'رمز عند المدخل: يمسحه الضيف، يكتب اسمه أو هاتفه ويرى طاولته', 'Код на входе: гость сканирует, вводит имя или телефон и видит свой стол'],
    /* ── the list ── */
    ['הכל · {n}', 'All · {n}', 'Tous · {n}', 'Todos · {n}', 'אַלע · {n}', 'الكل · {n}', 'Все · {n}'],
    ['אישרו · {n}', 'Confirmed · {n}', 'Confirmés · {n}', 'Confirmados · {n}', 'באַשטעטיקט · {n}', 'أكّدوا · {n}', 'Придут · {n}'],
    ['לא בטוחים · {n}', 'Not sure · {n}', 'Indécis · {n}', 'Indecisos · {n}', 'נישט זיכער · {n}', 'غير متأكدين · {n}', 'Не уверены · {n}'],
    ['לא ענו · {n}', 'No answer · {n}', 'Sans réponse · {n}', 'Sin respuesta · {n}', 'נישט געענטפֿערט · {n}', 'لم يجيبوا · {n}', 'Не ответили · {n}'],
    ['לא מגיעים · {n}', 'Not coming · {n}', 'Absents · {n}', 'No asisten · {n}', 'קומען נישט · {n}', 'لن يحضروا · {n}', 'Не придут · {n}'],
    ['נכשלו · {n}', 'Not delivered · {n}', 'Non remis · {n}', 'No entregados · {n}', 'נישט אָנגעקומען · {n}', 'لم تصلهم · {n}', 'Не доставлено · {n}'],
    ['{n} רשומות · {n} מוזמנים', '{n} records · {n} guests', '{n} fiches · {n} invités', '{n} registros · {n} invitados', '{n} רשימות · {n} געסט', '{n} سجلًا · {n} مدعوًّا', 'Записей: {n} · гостей: {n}'],
    ['חיפוש לפי שם, טלפון או שולחן', 'Search by name, phone or table', 'Rechercher par nom, téléphone ou table', 'Buscar por nombre, teléfono o mesa', 'זוכן לויט נאָמען, טעלעפֿאָן אָדער טיש', 'بحث بالاسم أو الهاتف أو الطاولة', 'Поиск по имени, телефону или столу'],
    ['שמירת שיבוץ שולחנות', 'Save table seating', 'Enregistrer le plan de table', 'Guardar la distribución de mesas', 'אָפּהיטן דעם זיץ־סדר', 'حفظ ترتيب الطاولات', 'Сохранить рассадку'],
    ['מי שאישרו הגעה יקבלו ביום האירוע הודעה עם מספר השולחן', 'Guests who confirmed will get a message with their table number on the day of the event', 'Les invités confirmés recevront le jour J un message avec leur numéro de table', 'Quienes confirmaron recibirán el día del evento un mensaje con su número de mesa', 'ווער ס׳האָט באַשטעטיקט וועט באַקומען אין טאָג פֿון דער שׂימחה אַ מעלדונג מיטן טיש־נומער', 'من أكّدوا الحضور سيستلمون يوم المناسبة رسالة برقم الطاولة', 'Подтвердившие гости в день события получат сообщение с номером стола'],
    ['רשומה', 'Record', 'Fiche', 'Registro', 'רשימה', 'السجل', 'Запись'],
    ['תשובה', 'Answer', 'Réponse', 'Respuesta', 'ענטפֿער', 'الرد', 'Ответ'],
    ['כמה', 'How many', 'Combien', 'Cuántos', 'וויפֿל', 'العدد', 'Сколько'],
    ['סטטוס', 'Status', 'Statut', 'Estado', 'סטאַטוס', 'الحالة', 'Статус'],
    ['שולחן', 'Table', 'Table', 'Mesa', 'טיש', 'طاولة', 'Стол'],
    ['✓✓ נקרא', '✓✓ Read', '✓✓ Lu', '✓✓ Leído', '✓✓ געלייענט', '✓✓ قُرئت', '✓✓ Прочитано'],
    ['✓✓ התקבל', '✓✓ Delivered', '✓✓ Reçu', '✓✓ Entregado', '✓✓ אָנגעקומען', '✓✓ وصلت', '✓✓ Доставлено'],
    ['✓ נשלח', '✓ Sent', '✓ Envoyé', '✓ Enviado', '✓ געשיקט', '✓ أُرسلت', '✓ Отправлено'],
    ['ההודעה נקראה (וי כחול)', 'The message was read (blue ticks)', 'Le message a été lu (coches bleues)', 'El mensaje fue leído (doble check azul)', 'די מעלדונג איז געלייענט געוואָרן (בלויע צייכנס)', 'تمت قراءة الرسالة (علامتان زرقاوان)', 'Сообщение прочитано (синие галочки)'],
    ['ההודעה הגיעה לטלפון', 'The message reached the phone', 'Le message est arrivé sur le téléphone', 'El mensaje llegó al teléfono', 'די מעלדונג איז אָנגעקומען צום טעלעפֿאָן', 'وصلت الرسالة إلى الهاتف', 'Сообщение доставлено на телефон'],
    ['וואטסאפ קיבל את ההודעה, עדיין לא נמסרה לטלפון', 'WhatsApp accepted the message, it has not reached the phone yet', 'WhatsApp a accepté le message, il n’est pas encore arrivé sur le téléphone', 'WhatsApp aceptó el mensaje, aún no ha llegado al teléfono', 'וואַטסאַפּ האָט אָנגענומען די מעלדונג, זי איז נאָך נישט אָנגעקומען צום טעלעפֿאָן', 'استلم واتساب الرسالة ولم تصل إلى الهاتف بعد', 'WhatsApp принял сообщение, на телефон оно ещё не дошло'],
    ['עדכון ידני', 'Manual update', 'Mise à jour manuelle', 'Actualización manual', 'מאַנועלער דערהײַנטיקונג', 'تحديث يدوي', 'Изменить вручную'],
    ['אין וואטסאפ', 'No WhatsApp', 'Pas de WhatsApp', 'Sin WhatsApp', 'נישטאָ קיין וואַטסאַפּ', 'لا يوجد واتساب', 'Нет WhatsApp'],
    ['לא נמסר', 'Not delivered', 'Non remis', 'No entregado', 'נישט איבערגעגעבן', 'لم تُسلَّم', 'Не доставлено'],
    ['לא נמסר עדיין', 'Not delivered yet', 'Pas encore remis', 'Aún no entregado', 'נאָך נישט איבערגעגעבן', 'لم تُسلَّم بعد', 'Пока не доставлено'],
    ['ננסה שוב', 'We’ll try again', 'Nouvel essai prévu', 'Lo intentaremos de nuevo', 'מיר וועלן פּרוּוון ווידער', 'سنحاول مجددًا', 'Попробуем ещё раз'],
    ['טרם נשלח', 'Not sent yet', 'Pas encore envoyé', 'Aún no enviado', 'נאָך נישט געשיקט', 'لم تُرسل بعد', 'Ещё не отправлено'],
    ['אין כאן אף אחד עדיין.', 'Nobody here yet.', 'Personne ici pour l’instant.', 'Aún no hay nadie aquí.', 'דאָ איז נאָך קיינער נישטאָ.', 'لا أحد هنا بعد.', 'Здесь пока никого нет.'],
    ['ההזמנות עוד לא נשלחו.', 'The invitations have not been sent yet.', 'Les invitations n’ont pas encore été envoyées.', 'Las invitaciones aún no se han enviado.', 'די אײַנלאַדונגען זענען נאָך נישט געשיקט געוואָרן.', 'لم تُرسل الدعوات بعد.', 'Приглашения ещё не отправлены.'],
    ['ההזמנה הגיעה לכל המוזמנים.', 'The invitation reached every guest.', 'L’invitation est arrivée à tous les invités.', 'La invitación llegó a todos los invitados.', 'די אײַנלאַדונג איז אָנגעקומען צו אַלע געסט.', 'وصلت الدعوة إلى جميع المدعوين.', 'Приглашение дошло до всех гостей.'],
    ['לא נמצא מוזמן שמתאים לחיפוש.', 'No guest matches the search.', 'Aucun invité ne correspond à la recherche.', 'Ningún invitado coincide con la búsqueda.', 'קיין גאַסט פּאַסט נישט צום זוכן.', 'لا يوجد مدعو مطابق للبحث.', 'По запросу никого не найдено.'],
    ['הוספת מוזמן', 'Add a guest', 'Ajouter un invité', 'Añadir un invitado', 'צולייגן אַ גאַסט', 'إضافة مدعو', 'Добавить гостя'],
    ['{n} מתוך {n} בחבילה · נותרו {n}', '{n} of {n} in the package · {n} left', '{n} sur {n} dans le forfait · {n} restants', '{n} de {n} en el paquete · quedan {n}', '{n} פֿון {n} אין פּאַקעט · געבליבן {n}', '{n} من {n} في الباقة · بقي {n}', '{n} из {n} в пакете · осталось {n}'],
    ['{n} מתוך {n}', '{n} of {n}', '{n} sur {n}', '{n} de {n}', '{n} פֿון {n}', '{n} من {n}', '{n} из {n}'],
    ['שם', 'Name', 'Nom', 'Nombre', 'נאָמען', 'الاسم', 'Имя'],
    ['טלפון', 'Phone', 'Téléphone', 'Teléfono', 'טעלעפֿאָן', 'الهاتف', 'Телефон'],
    ['כמות', 'How many', 'Nombre', 'Cantidad', 'וויפֿל', 'العدد', 'Кол-во'],
    ['שליחה', 'Send', 'Envoyer', 'Enviar', 'שיקן', 'إرسال', 'Отправить'],
    ['שכחתם מישהו? עד {n} מוזמנים נוספים בחינם. ממלאים שם, טלפון וכמה מגיעים, ולוחצים שליחה. אם ההזמנות כבר יצאו, ההזמנה נשלחת אליהם מיד.', 'Forgot someone? Up to {n} extra guests free. Fill in a name, a phone and how many are coming, and press Send. If the invitations already went out, theirs is sent right away.', 'Vous avez oublié quelqu’un ? Jusqu’à {n} invités supplémentaires offerts. Indiquez le nom, le téléphone et le nombre de personnes, puis appuyez sur Envoyer. Si les invitations sont déjà parties, la leur est envoyée aussitôt.', '¿Olvidó a alguien? Hasta {n} invitados adicionales gratis. Indique nombre, teléfono y cuántos vienen, y pulse Enviar. Si las invitaciones ya salieron, la suya se envía de inmediato.', 'פֿאַרגעסן עמעצן? ביז {n} נאָך געסט בחינם. מען פֿילט אויס נאָמען, טעלעפֿאָן און וויפֿל קומען, און מען דריקט שיקן. אויב די אײַנלאַדונגען זענען שוין אַרויס, ווערט זייערע געשיקט באַלד.', 'نسيتم أحدًا؟ حتى {n} مدعوين إضافيين مجانًا. اكتبوا الاسم والهاتف وعدد الحضور ثم اضغطوا إرسال. إن كانت الدعوات قد أُرسلت، تُرسل دعوتهم فورًا.', 'Кого-то забыли? До {n} дополнительных гостей бесплатно. Укажите имя, телефон и сколько человек придёт, затем нажмите «Отправить». Если приглашения уже ушли, им отправят сразу.'],
    /* ── the send schedule ── */
    ['ההזמנה ואישור ההגעה', 'The invitation and RSVP', 'L’invitation et la confirmation de présence', 'La invitación y la confirmación de asistencia', 'די אײַנלאַדונג און באַשטעטיקונג פֿון קומען', 'الدعوة وتأكيد الحضور', 'Приглашение и подтверждение'],
    ['תזכורת למי שלא ענה', 'Reminder to those who didn’t answer', 'Rappel à ceux qui n’ont pas répondu', 'Recordatorio a quienes no respondieron', 'דערמאָנונג פֿאַר די וואָס האָבן נישט געענטפֿערט', 'تذكير لمن لم يجيبوا', 'Напоминание тем, кто не ответил'],
    ['שיחה טלפונית למי שלא ענה', 'Phone call to those who didn’t answer', 'Appel téléphonique à ceux qui n’ont pas répondu', 'Llamada a quienes no respondieron', 'טעלעפֿאָן־רוף פֿאַר די וואָס האָבן נישט געענטפֿערט', 'اتصال هاتفي بمن لم يجيبوا', 'Звонок тем, кто не ответил'],
    ['תזכורת עם הכתובת', 'Reminder with the address', 'Rappel avec l’adresse', 'Recordatorio con la dirección', 'דערמאָנונג מיטן אַדרעס', 'تذكير مع العنوان', 'Напоминание с адресом'],
    ['הודעת תודה לאורחים', 'Thank-you message to guests', 'Message de remerciement aux invités', 'Mensaje de agradecimiento a los invitados', 'דאַנק־מעלדונג פֿאַר די געסט', 'رسالة شكر للضيوف', 'Благодарность гостям'],
    ['עבר', 'Done', 'Passé', 'Pasado', 'פֿאַרבײַ', 'انتهى', 'Прошло'],
    ['נשלח', 'Sent', 'Envoyé', 'Enviado', 'געשיקט', 'أُرسل', 'Отправлено'],
    ['מתוכנן', 'Scheduled', 'Prévu', 'Programado', 'פּלאַנירט', 'مجدول', 'Запланировано'],
    ['בשליחה', 'Sending', 'En cours d’envoi', 'Enviando', 'מען שיקט', 'جارٍ الإرسال', 'Отправляется'],
    ['שינוי תאריך', 'Change date', 'Modifier la date', 'Cambiar la fecha', 'בײַטן דאַטע', 'تغيير التاريخ', 'Изменить дату'],
    ['אוטומטי', 'Automatic', 'Automatique', 'Automático', 'אויטאָמאַטיש', 'تلقائي', 'Автоматически'],
    ['אפשר להזיז תאריך שליחה בעצמכם, כל עוד לא עברה השעה', 'You can move a send date yourselves, as long as the time has not passed', 'Vous pouvez déplacer vous-mêmes une date d’envoi, tant que l’heure n’est pas passée', 'Puede mover usted mismo una fecha de envío, mientras no haya pasado la hora', 'איר קענט אַליין איבעררוקן אַ שיק־דאַטע, כּל־זמן די שעה איז נאָך נישט פֿאַרבײַ', 'يمكنكم تغيير تاريخ الإرسال بأنفسكم ما دامت الساعة لم تمضِ', 'Дату рассылки можно перенести самостоятельно, пока не наступило время'],
    ['ביום שהוא נקבע. אחרי זה השליחה כבר יצאה לדרך.', 'on the day it is set for. After that the send is already on its way.', 'le jour prévu. Après cela, l’envoi est déjà parti.', 'del día fijado. Después, el envío ya está en marcha.', 'אין טאָג וואָס ער איז באַשטימט. נאָך דעם איז דאָס שיקן שוין אויפֿן וועג.', 'في اليوم المحدد. بعد ذلك يكون الإرسال قد بدأ.', 'в назначенный день. После этого рассылка уже ушла.'],
    /* ── after the event ── */
    ['תודה שחגגתם איתנו 💚', 'Thank you for celebrating with us 💚', 'Merci d’avoir fêté avec nous 💚', 'Gracias por celebrar con nosotros 💚', 'אַ דאַנק וואָס איר האָט געפּראַוועט מיט אונדז 💚', 'شكرًا لاحتفالكم معنا 💚', 'Спасибо, что отпраздновали с нами 💚'],
    ['האירוע מאחוריכם. נשמח אם תקדישו דקה, זה עוזר לזוגות הבאים למצוא אותנו:', 'The event is behind you. We’d be glad if you spared a minute — it helps the next couples find us:', 'L’événement est derrière vous. Une minute de votre temps nous aiderait : cela permet aux prochains couples de nous trouver :', 'El evento ya pasó. Le agradeceríamos un minuto: ayuda a que las próximas parejas nos encuentren:', 'די שׂימחה איז שוין הינטער אײַך. מיר וועלן זיך פֿרייען אויב איר וועט געבן אַ מינוט, עס העלפֿט די קומענדיקע פּאָרלעך אונדז געפֿינען:', 'المناسبة أصبحت خلفكم. يسعدنا أن تمنحونا دقيقة، فهذا يساعد الأزواج القادمين على إيجادنا:', 'Событие позади. Будем рады, если уделите минуту — это помогает следующим парам найти нас:'],
    ['🎥 המלצה קצרה בווידאו או באודיו', '🎥 A short video or audio recommendation', '🎥 Une courte recommandation en vidéo ou en audio', '🎥 Una breve recomendación en vídeo o audio', '🎥 אַ קורצע רעקאָמענדאַציע אין ווידעאָ אָדער אַודיאָ', '🎥 توصية قصيرة بالفيديو أو بالصوت', '🎥 Короткий видео- или аудиоотзыв'],
    /* ── refer a friend ── */
    ['דרגת ארד', 'Bronze level', 'Niveau bronze', 'Nivel bronce', 'בראָנדז־מדרגה', 'المستوى البرونزي', 'Бронзовый уровень'],
    ['דרגת כסף', 'Silver level', 'Niveau argent', 'Nivel plata', 'זילבער־מדרגה', 'المستوى الفضي', 'Серебряный уровень'],
    ['דרגת זהב', 'Gold level', 'Niveau or', 'Nivel oro', 'גאָלד־מדרגה', 'المستوى الذهبي', 'Золотой уровень'],
    ['מכירים זוג לפני אירוע? בחרו מה מתאים לכם, ושתפו את הקישור או את התמונה לסטורי.', 'Know a couple before their event? Choose what suits you, and share the link or the story image.', 'Vous connaissez un couple avant son événement ? Choisissez ce qui vous convient, puis partagez le lien ou l’image pour la story.', '¿Conoce a una pareja antes de su evento? Elija lo que le convenga y comparta el enlace o la imagen para la historia.', 'איר קענט אַ פּאָרל פֿאַר אַ שׂימחה? קלײַבט אויס וואָס פּאַסט אײַך, און טיילט דעם לינק אָדער דאָס בילד פֿאַר סטאָרי.', 'تعرفون زوجين قبل مناسبتهما؟ اختاروا ما يناسبكم وشاركوا الرابط أو الصورة في القصة.', 'Знаете пару, у которой скоро событие? Выберите удобный вариант и поделитесь ссылкой или картинкой для сторис.'],
    ['{n}% הנחה לחברים', '{n}% off for friends', '{n} % de réduction pour les amis', '{n}% de descuento para amigos', '{n}% הנחה פֿאַר חבֿרים', 'خصم {n}% للأصدقاء', 'Скидка {n}% друзьям'],
    ['החברים מקבלים {n}% הנחה על החבילה', 'Friends get {n}% off the package', 'Les amis bénéficient de {n} % de réduction sur le forfait', 'Los amigos obtienen un {n}% de descuento en el paquete', 'די חבֿרים באַקומען {n}% הנחה אויפֿן פּאַקעט', 'يحصل الأصدقاء على خصم {n}% على الباقة', 'Друзья получают скидку {n}% на пакет'],
    ['{n}% עמלה לי', '{n}% commission for me', '{n} % de commission pour moi', '{n}% de comisión para mí', '{n}% קאָמיסיע פֿאַר מיר', 'عمولة {n}% لي', 'Комиссия {n}% мне'],
    ['מכל חבילה שחבר סוגר דרככם', 'On every package a friend buys through you', 'Sur chaque forfait qu’un ami achète grâce à vous', 'De cada paquete que un amigo contrate a través de usted', 'פֿון יעדן פּאַקעט וואָס אַ חבֿר קויפֿט דורך אײַך', 'من كل باقة يشتريها صديق عن طريقكم', 'С каждого пакета, который друг купит по вашей ссылке'],
    ['הבחירה ננעלה אחרי ההפניה הראשונה.', 'The choice was locked after the first referral.', 'Le choix a été verrouillé après le premier parrainage.', 'La elección quedó fijada tras la primera recomendación.', 'די ברירה איז פֿאַרשלאָסן געוואָרן נאָך דער ערשטער רעקאָמענדאַציע.', 'تم تثبيت الاختيار بعد أول إحالة.', 'Выбор зафиксирован после первой рекомендации.'],
    ['העתקה', 'Copy', 'Copier', 'Copiar', 'קאָפּירן', 'نسخ', 'Копировать'],
    ['חברים חסכו ₪{n} · הרווחתם ₪{n}', 'Friends saved ₪{n} · you earned ₪{n}', 'Vos amis ont économisé {n} ₪ · vous avez gagné {n} ₪', 'Sus amigos ahorraron ₪{n} · usted ganó ₪{n}', 'חבֿרים האָבן אײַנגעשפּאָרט ₪{n} · איר האָט פֿאַרדינט ₪{n}', 'وفّر الأصدقاء ₪{n} · ربحتم ₪{n}', 'Друзья сэкономили ₪{n} · вы заработали ₪{n}'],
    ['בחרו למעלה: הנחה לחברים או עמלה לכם. אפשר להחליף מתי שרוצים, וקישור שכבר שיתפתם נשאר כמו שהיה.', 'Choose above: a discount for friends or a commission for you. You can switch whenever you like, and a link you already shared stays as it was.', 'Choisissez ci-dessus : une réduction pour vos amis ou une commission pour vous. Vous pouvez changer quand vous voulez, et un lien déjà partagé reste tel quel.', 'Elija arriba: descuento para amigos o comisión para usted. Puede cambiar cuando quiera, y un enlace ya compartido queda como estaba.', 'קלײַבט אויס אויבן: אַ הנחה פֿאַר חבֿרים אָדער אַ קאָמיסיע פֿאַר אײַך. מען קען בײַטן ווען מען וויל, און אַ לינק וואָס איר האָט שוין געטיילט בלײַבט ווי ער איז געווען.', 'اختاروا أعلاه: خصم للأصدقاء أو عمولة لكم. يمكن التبديل متى شئتم، والرابط الذي شاركتموه يبقى كما هو.', 'Выберите выше: скидка друзьям или комиссия вам. Менять можно когда угодно, а уже отправленная ссылка останется прежней.'],
    ['🎁 צברתם הטבה: סבב שליחה נוסף מתנה. היא רשומה על שמכם ומחכה לכם כאן בלוח.', '🎁 You earned a benefit: one extra send round as a gift. It is on your name and waits for you here on the board.', '🎁 Vous avez gagné un avantage : une série d’envois supplémentaire offerte. Elle est à votre nom et vous attend ici.', '🎁 Ha ganado un beneficio: una ronda de envío adicional de regalo. Está a su nombre y le espera aquí en el panel.', '🎁 איר האָט פֿאַרדינט אַ הטבֿה: נאָך אַ שיק־רונדע ווי אַ מתּנה. זי איז פֿאַרשריבן אויף אײַער נאָמען און וואַרט אויף אײַך דאָ אויפֿן ברעט.', '🎁 حصلتم على ميزة: جولة إرسال إضافية هدية. مسجّلة باسمكم وتنتظركم هنا في اللوحة.', '🎁 Вы получили бонус: дополнительная рассылка в подарок. Она записана на вас и ждёт здесь, в панели.'],
    ['ערכת שיתוף לסטורי', 'Story sharing kit', 'Kit de partage pour la story', 'Kit para compartir en historias', 'סטאָרי־טייל־קיט', 'عدّة المشاركة في القصة', 'Набор для сторис'],
    ['שיתוף בוואטסאפ', 'Share on WhatsApp', 'Partager sur WhatsApp', 'Compartir por WhatsApp', 'טיילן אויף וואַטסאַפּ', 'مشاركة على واتساب', 'Поделиться в WhatsApp'],
    ['למימוש', 'To redeem', 'À utiliser', 'Para canjear', 'צו ניצן', 'للاستخدام', 'К использованию'],
    ['העמלה נצברת כזיכוי למימוש על החבילות והתוספות שלנו, לא במזומן. ההפניה נספרת כשחבר משלם דרך הקישור.', 'The commission accumulates as credit to use on our packages and add-ons, not as cash. A referral counts when a friend pays through the link.', 'La commission s’accumule sous forme de crédit à utiliser sur nos forfaits et suppléments, pas en espèces. Le parrainage est compté quand un ami paie via le lien.', 'La comisión se acumula como crédito para usar en nuestros paquetes y extras, no en efectivo. La recomendación cuenta cuando un amigo paga a través del enlace.', 'די קאָמיסיע זאַמלט זיך ווי אַ קרעדיט צו ניצן אויף אונדזערע פּאַקעטן און צוגאָבן, נישט אין מזומן. די רעקאָמענדאַציע ווערט געציילט ווען אַ חבֿר באַצאָלט דורכן לינק.', 'تتراكم العمولة كرصيد يُستخدم لباقاتنا وإضافاتنا، وليس نقدًا. تُحتسب الإحالة عندما يدفع الصديق عبر الرابط.', 'Комиссия копится как кредит на наши пакеты и дополнения, не деньгами. Рекомендация засчитывается, когда друг оплатит по ссылке.'],
    ['ההפניות והאירועים שלכם קידמו אתכם. תודה שאתם ממליצים עלינו!', 'Your referrals and events moved you up. Thank you for recommending us!', 'Vos parrainages et vos événements vous ont fait progresser. Merci de nous recommander !', 'Sus recomendaciones y eventos le han hecho subir de nivel. ¡Gracias por recomendarnos!', 'אײַערע רעקאָמענדאַציעס און שׂימחות האָבן אײַך אַרויפֿגעהויבן. אַ דאַנק וואָס איר רעקאָמענדירט אונדז!', 'إحالاتكم ومناسباتكم رفعت مستواكم. شكرًا لتوصيتكم بنا!', 'Ваши рекомендации и события повысили ваш уровень. Спасибо, что советуете нас!'],
    ['לערכת השיתוף', 'To the sharing kit', 'Vers le kit de partage', 'Al kit para compartir', 'צום טייל־קיט', 'إلى عدّة المشاركة', 'К набору для сторис'],
    ['סגירה', 'Close', 'Fermer', 'Cerrar', 'פֿאַרמאַכן', 'إغلاق', 'Закрыть'],
    /* ── group link, navigation, gifts ── */
    ['שלחו לקבוצת הוואטסאפ של המשפחה. מי שלוחץ "מגיע/ה" נכנס לרשימה ולסידור ההושבה. הודעות ותזכורות אליהם נפתחות בתוספת אחת קטנה.', 'Send it to the family WhatsApp group. Whoever presses “Coming” joins the list and the seating plan. Messages and reminders to them open with one small add-on.', 'Envoyez-le au groupe WhatsApp de la famille. Ceux qui appuient sur « Je viens » entrent dans la liste et le plan de table. Les messages et rappels pour eux s’activent avec un petit supplément.', 'Envíelo al grupo de WhatsApp de la familia. Quien pulse «Asisto» entra en la lista y en la distribución de mesas. Los mensajes y recordatorios para ellos se activan con un pequeño extra.', 'שיקט עס צו דער משפּחה־גרופּע אויף וואַטסאַפּ. ווער ס׳דריקט "איך קום" קומט אַרײַן אין דער רשימה און אינעם זיץ־סדר. מעלדונגען און דערמאָנונגען צו זיי עפֿענען זיך מיט איין קליינעם צוגאָב.', 'أرسلوه إلى مجموعة واتساب العائلة. من يضغط «سأحضر» يدخل القائمة وترتيب الجلوس. الرسائل والتذكيرات لهم تُفعَّل بإضافة صغيرة واحدة.', 'Отправьте в семейную группу WhatsApp. Кто нажмёт «Приду», попадёт в список и в рассадку. Сообщения и напоминания для них включаются одним небольшим дополнением.'],
    ['פתיחה בוואטסאפ', 'Open in WhatsApp', 'Ouvrir dans WhatsApp', 'Abrir en WhatsApp', 'עפֿענען אין וואַטסאַפּ', 'فتح في واتساب', 'Открыть в WhatsApp'],
    ['העתקת ההודעה', 'Copy the message', 'Copier le message', 'Copiar el mensaje', 'קאָפּירן די מעלדונג', 'نسخ الرسالة', 'Скопировать сообщение'],
    ['קישור ניווט (Waze / Google Maps) · לא חובה', 'Navigation link (Waze / Google Maps) · optional', 'Lien d’itinéraire (Waze / Google Maps) · facultatif', 'Enlace de navegación (Waze / Google Maps) · opcional', 'נאַוויגאַציע־לינק (Waze / Google Maps) · נישט קיין חובֿ', 'رابط الملاحة (Waze / Google Maps) · اختياري', 'Ссылка на маршрут (Waze / Google Maps) · по желанию'],
    ['איך מוציאים קישור?', 'How do I get a link?', 'Comment obtenir un lien ?', '¿Cómo obtengo un enlace?', 'ווי באַקומט מען אַ לינק?', 'كيف أحصل على رابط؟', 'Как получить ссылку?'],
    ['שמירה', 'Save', 'Enregistrer', 'Guardar', 'אָפּהיטן', 'حفظ', 'Сохранить'],
    ['יצורף להזמנה בקישור ולתזכורת של יום לפני האירוע.', 'It will be attached to the invitation link and to the reminder on the day before the event.', 'Il sera joint à l’invitation et au rappel de la veille de l’événement.', 'Se adjuntará a la invitación y al recordatorio del día anterior al evento.', 'ער וועט צוגעלייגט ווערן צו דער אײַנלאַדונג און צו דער דערמאָנונג פֿון טאָג פֿאַר דער שׂימחה.', 'سيُرفق بالدعوة وبتذكير اليوم السابق للمناسبة.', 'Будет добавлена к приглашению и к напоминанию накануне события.'],
    ['הדביקו כאן קישור מוויז או גוגל מפות', 'Paste a Waze or Google Maps link here', 'Collez ici un lien Waze ou Google Maps', 'Pegue aquí un enlace de Waze o Google Maps', 'קלעפּט דאָ אַרײַן אַ לינק פֿון Waze אָדער Google Maps', 'الصقوا هنا رابط Waze أو خرائط Google', 'Вставьте сюда ссылку из Waze или Google Maps'],
    ['קישור למתנה (ביט / פייבוקס) · חינם, לא חובה', 'Gift link (Bit / PayBox) · free, optional', 'Lien pour le cadeau (Bit / PayBox) · gratuit, facultatif', 'Enlace para el regalo (Bit / PayBox) · gratis, opcional', 'מתּנה־לינק (Bit / PayBox) · בחינם, נישט קיין חובֿ', 'رابط الهدية (Bit / PayBox) · مجاني، اختياري', 'Ссылка для подарка (Bit / PayBox) · бесплатно, по желанию'],
    ['הסבר לביט', 'Bit guide', 'Guide Bit', 'Guía de Bit', 'דערקלערונג פֿאַר Bit', 'شرح Bit', 'Инструкция для Bit'],
    ['הסבר לפייבוקס', 'PayBox guide', 'Guide PayBox', 'Guía de PayBox', 'דערקלערונג פֿאַר PayBox', 'شرح PayBox', 'Инструкция для PayBox'],
    ['קישור ביט (bit.co.il)', 'Bit link (bit.co.il)', 'Lien Bit (bit.co.il)', 'Enlace de Bit (bit.co.il)', 'Bit־לינק (bit.co.il)', 'رابط Bit (bit.co.il)', 'Ссылка Bit (bit.co.il)'],
    ['קישור פייבוקס (payboxapp.com)', 'PayBox link (payboxapp.com)', 'Lien PayBox (payboxapp.com)', 'Enlace de PayBox (payboxapp.com)', 'PayBox־לינק (payboxapp.com)', 'رابط PayBox (payboxapp.com)', 'Ссылка PayBox (payboxapp.com)'],
    ['אורח ששואל איך לתת מתנה יקבל את הקישור אוטומטית. כבוי כברירת מחדל.', 'A guest who asks how to give a gift gets the link automatically. Off by default.', 'Un invité qui demande comment offrir un cadeau reçoit le lien automatiquement. Désactivé par défaut.', 'Un invitado que pregunte cómo hacer un regalo recibe el enlace automáticamente. Desactivado por defecto.', 'אַ גאַסט וואָס פֿרעגט ווי צו געבן אַ מתּנה באַקומט דעם לינק אויטאָמאַטיש. אויסגעלאָשן לויט ברירת־מחדל.', 'الضيف الذي يسأل كيف يقدّم هدية يحصل على الرابط تلقائيًا. معطّل افتراضيًا.', 'Гость, который спросит, как сделать подарок, получит ссылку автоматически. По умолчанию выключено.'],
    ['בקרוב: מתנה באשראי דרכנו', 'Coming soon: gift by card through us', 'Bientôt : cadeau par carte via notre service', 'Próximamente: regalo con tarjeta a través de nosotros', 'באַלד: מתּנה מיט קאַרטל דורך אונדז', 'قريبًا: هدية ببطاقة الائتمان عبرنا', 'Скоро: подарок картой через нас'],
    ['מעניין אותי', 'I’m interested', 'Ça m’intéresse', 'Me interesa', 'עס אינטערעסירט מיך', 'يهمّني', 'Мне интересно'],
    ['לשלוח את הקישור לאורחים', 'Send the link to guests', 'Envoyer le lien aux invités', 'Enviar el enlace a los invitados', 'שיקן דעם לינק צו די געסט', 'إرسال الرابط للضيوف', 'Отправлять ссылку гостям'],
    /* ── add-ons ── */
    ['דיילות באירוע', 'Hostesses at the event', 'Hôtesses à l’événement', 'Azafatas en el evento', 'אויפֿנעמערינס בײַ דער שׂימחה', 'مضيفات في المناسبة', 'Хостес на событии'],
    ["מקבלות אורחים, מסמנות הגעה בלוח בזמן אמת ומכוונות לשולחנות. דיילת אחת מתחת ל-{n} רשומות, {n} דיילות מ-{n} ומעלה. ניתן להוסיף עד שבועיים לפני האירוע. מחוץ למרכז: תוספת נסיעות {n} ₪ (דיילת אחת) או {n} ₪ ({n} דיילות)", "They welcome guests, mark arrivals on the board in real time and show people to their tables. One hostess under {n} records, {n} hostesses from {n} up. Can be added up to two weeks before the event. Outside the centre: travel supplement {n} ₪ (one hostess) or {n} ₪ ({n} hostesses)", "Elles accueillent les invités, notent les arrivées en temps réel et orientent vers les tables. Une hôtesse en dessous de {n} fiches, {n} hôtesses à partir de {n}. Ajout possible jusqu’à deux semaines avant l’événement. Hors région centre : supplément de déplacement {n} ₪ (une hôtesse) ou {n} ₪ ({n} hôtesses)", "Reciben a los invitados, marcan las llegadas en el panel en tiempo real y los acompañan a sus mesas. Una azafata por debajo de {n} registros, {n} azafatas a partir de {n}. Se pueden añadir hasta dos semanas antes del evento. Fuera del centro: suplemento de desplazamiento {n} ₪ (una azafata) o {n} ₪ ({n} azafatas)", "זיי נעמען אויף די געסט, צייכענען אָן אויפֿן ברעט אין עכטער צײַט ווער ס׳איז געקומען און ווײַזן צו די טישן. איין אויפֿנעמערין אונטער {n} רשימות, {n} אויפֿנעמערינס פֿון {n} און מער. מען קען צולייגן ביז צוויי וואָכן פֿאַר דער שׂימחה. אויסערן צענטער: צוגאָב פֿאַר נסיעה {n} ₪ (איין אויפֿנעמערין) אָדער {n} ₪ ({n} אויפֿנעמערינס)", "يستقبلن الضيوف، يسجّلن الحضور في اللوحة لحظيًا ويوجّهن إلى الطاولات. مضيفة واحدة لأقل من {n} سجلًا، {n} مضيفات من {n} فأكثر. يمكن الإضافة حتى أسبوعين قبل المناسبة. خارج المركز: إضافة سفر {n} ₪ (مضيفة واحدة) أو {n} ₪ ({n} مضيفات)", "Встречают гостей, отмечают приход в панели в реальном времени и провожают к столам. Одна хостес при менее чем {n} записях, {n} хостес от {n} и больше. Можно добавить не позднее чем за две недели до события. Вне центра: доплата за дорогу {n} ₪ (одна хостес) или {n} ₪ ({n} хостес)"],
    ["מקבלות אורחים, מסמנות הגעה בלוח בזמן אמת ומכוונות לשולחנות. דיילת אחת מתחת ל-{n} רשומות, {n} דיילות מ-{n} ומעלה. ניתן להוסיף עד שבועיים לפני האירוע. מחוץ למרכז: תוספת נסיעות {n} ₪ (דיילת אחת) או {n} ₪ ({n} דיילות) · פחות משבועיים לאירוע, נבדוק זמינות ידנית", "They welcome guests, mark arrivals on the board in real time and show people to their tables. One hostess under {n} records, {n} hostesses from {n} up. Can be added up to two weeks before the event. Outside the centre: travel supplement {n} ₪ (one hostess) or {n} ₪ ({n} hostesses) · less than two weeks to the event, we check availability by hand", "Elles accueillent les invités, notent les arrivées en temps réel et orientent vers les tables. Une hôtesse en dessous de {n} fiches, {n} hôtesses à partir de {n}. Ajout possible jusqu’à deux semaines avant l’événement. Hors région centre : supplément de déplacement {n} ₪ (une hôtesse) ou {n} ₪ ({n} hôtesses) · à moins de deux semaines de l’événement, nous vérifions la disponibilité manuellement", "Reciben a los invitados, marcan las llegadas en el panel en tiempo real y los acompañan a sus mesas. Una azafata por debajo de {n} registros, {n} azafatas a partir de {n}. Se pueden añadir hasta dos semanas antes del evento. Fuera del centro: suplemento de desplazamiento {n} ₪ (una azafata) o {n} ₪ ({n} azafatas) · a menos de dos semanas del evento, comprobamos la disponibilidad a mano", "זיי נעמען אויף די געסט, צייכענען אָן אויפֿן ברעט אין עכטער צײַט ווער ס׳איז געקומען און ווײַזן צו די טישן. איין אויפֿנעמערין אונטער {n} רשימות, {n} אויפֿנעמערינס פֿון {n} און מער. מען קען צולייגן ביז צוויי וואָכן פֿאַר דער שׂימחה. אויסערן צענטער: צוגאָב פֿאַר נסיעה {n} ₪ (איין אויפֿנעמערין) אָדער {n} ₪ ({n} אויפֿנעמערינס) · ווייניקער ווי צוויי וואָכן ביז דער שׂימחה, קוקן מיר נאָך מיט דער האַנט צי ס׳איז פֿראַנען", "يستقبلن الضيوف، يسجّلن الحضور في اللوحة لحظيًا ويوجّهن إلى الطاولات. مضيفة واحدة لأقل من {n} سجلًا، {n} مضيفات من {n} فأكثر. يمكن الإضافة حتى أسبوعين قبل المناسبة. خارج المركز: إضافة سفر {n} ₪ (مضيفة واحدة) أو {n} ₪ ({n} مضيفات) · أقل من أسبوعين على المناسبة، نتحقق من التوفّر يدويًا", "Встречают гостей, отмечают приход в панели в реальном времени и провожают к столам. Одна хостес при менее чем {n} записях, {n} хостес от {n} и больше. Можно добавить не позднее чем за две недели до события. Вне центра: доплата за дорогу {n} ₪ (одна хостес) или {n} ₪ ({n} хостес) · меньше двух недель до события — проверим наличие вручную"],
    ['פנייה בוואטסאפ', 'Contact us on WhatsApp', 'Nous contacter sur WhatsApp', 'Contactar por WhatsApp', 'ווענדט זיך אויף וואַטסאַפּ', 'تواصل عبر واتساب', 'Написать в WhatsApp'],
    ['שליחה נוספת', 'Extra send', 'Envoi supplémentaire', 'Envío adicional', 'נאָך אַ שיקן', 'إرسال إضافي', 'Дополнительная рассылка'],
    ['תזכורת נוספת לכל הרשימה בתאריך שתבחרו, למשל שבוע לפני האירוע', 'One more reminder to the whole list on a date you choose, for example a week before the event', 'Un rappel de plus à toute la liste à la date de votre choix, par exemple une semaine avant l’événement', 'Un recordatorio más a toda la lista en la fecha que elija, por ejemplo una semana antes del evento', 'נאָך אַ דערמאָנונג פֿאַר דער גאַנצער רשימה אין אַ דאַטע וואָס איר קלײַבט אויס, למשל אַ וואָך פֿאַר דער שׂימחה', 'تذكير إضافي لكل القائمة في تاريخ تختارونه، مثلًا قبل المناسبة بأسبوع', 'Ещё одно напоминание всему списку в выбранную дату, например за неделю до события'],
    ['הוספה · ₪{n}', 'Add · ₪{n}', 'Ajouter · {n} ₪', 'Añadir · ₪{n}', 'צולייגן · ₪{n}', 'إضافة · ₪{n}', 'Добавить · ₪{n}'],
    ['סבב נוסף · ₪{n}', 'Another round · ₪{n}', 'Série supplémentaire · {n} ₪', 'Otra ronda · ₪{n}', 'נאָך אַ רונדע · ₪{n}', 'جولة إضافية · ₪{n}', 'Ещё раунд · ₪{n}'],
    ['סבב שיחות מסוכן AI', 'A round of calls by an AI agent', 'Série d’appels par un agent IA', 'Ronda de llamadas con un agente de IA', 'אַ רונדע רופֿן פֿון אַן AI־אַגענט', 'جولة اتصالات من وكيل ذكاء اصطناعي', 'Обзвон ИИ-агентом'],
    ['נציג מתקשר למי שלא הגיב ומאשר בשמו · {n} מוזמנים עדיין לא ענו', 'An agent calls those who didn’t respond and confirms for them · {n} guests have not answered yet', 'Un agent appelle ceux qui n’ont pas répondu et confirme pour eux · {n} invités n’ont pas encore répondu', 'Un agente llama a quienes no respondieron y confirma por ellos · {n} invitados aún no han respondido', 'אַן אַגענט רופֿט אָן די וואָס האָבן נישט רעאַגירט און באַשטעטיקט אין זייער נאָמען · {n} געסט האָבן נאָך נישט געענטפֿערט', 'يتصل مندوب بمن لم يرد ويؤكّد عنه · {n} مدعوًّا لم يجيبوا بعد', 'Агент звонит тем, кто не ответил, и подтверждает за них · пока не ответили {n} гостей'],
    ['הפעלת הודעות לנרשמים מהקישור', 'Turn on messages for those who joined through the link', 'Activer les messages pour les inscrits via le lien', 'Activar mensajes para quienes se apuntaron por el enlace', 'אָנצינדן מעלדונגען פֿאַר די וואָס האָבן זיך פֿאַרשריבן דורכן לינק', 'تفعيل الرسائل للمسجّلين عبر الرابط', 'Включить сообщения для записавшихся по ссылке'],
    ['מי שאישר דרך הקישור הציבורי יקבל גם תזכורת, יום-לפני ושולחן', 'Whoever confirmed through the public link also gets the reminder, the day-before message and their table', 'Ceux qui ont confirmé via le lien public recevront aussi le rappel, le message de la veille et leur table', 'Quien confirmó por el enlace público recibirá también el recordatorio, el mensaje del día anterior y su mesa', 'ווער ס׳האָט באַשטעטיקט דורכן עפֿנטלעכן לינק וועט אויך באַקומען אַ דערמאָנונג, דעם טאָג־פֿריִער און דעם טיש', 'من أكّد عبر الرابط العام يستلم أيضًا التذكير ورسالة اليوم السابق ورقم الطاولة', 'Подтвердившие по общей ссылке тоже получат напоминание, сообщение накануне и номер стола'],
    ['עדיין אין נרשמים מהקישור', 'Nobody has joined through the link yet', 'Personne ne s’est encore inscrit via le lien', 'Aún nadie se ha apuntado por el enlace', 'נאָך קיינער האָט זיך נישט פֿאַרשריבן דורכן לינק', 'لا يوجد مسجّلون عبر الرابط بعد', 'По ссылке пока никто не записался'],
    ['הגדלת כמות מוזמנים או שדרוג מסלול', 'More guests or a plan upgrade', 'Plus d’invités ou passage à un forfait supérieur', 'Más invitados o mejora de plan', 'מער געסט אָדער אַ העכערער פּלאַן', 'زيادة عدد المدعوين أو ترقية الباقة', 'Больше гостей или тариф выше'],
    ['עד {n} מוזמנים נוספים חינם. מעבר לזה, או למסלול עם שיחות, משלמים רק את ההפרש', 'Up to {n} extra guests free. Beyond that, or for a plan with calls, you pay only the difference', 'Jusqu’à {n} invités supplémentaires offerts. Au-delà, ou pour un forfait avec appels, vous ne payez que la différence', 'Hasta {n} invitados adicionales gratis. Más allá, o para un plan con llamadas, solo paga la diferencia', 'ביז {n} נאָך געסט בחינם. איבער דעם, אָדער פֿאַר אַ פּלאַן מיט רופֿן, צאָלט מען נאָר דעם חילוק', 'حتى {n} مدعوين إضافيين مجانًا. ما زاد عن ذلك، أو للباقة مع الاتصالات، تدفعون الفرق فقط', 'До {n} дополнительных гостей бесплатно. Сверх этого или для тарифа со звонками вы платите только разницу'],
    ['שדרוג', 'Upgrade', 'Changer de forfait', 'Mejorar', 'אויפֿבעסערן', 'ترقية', 'Улучшить'],
    ['עיצוב הזמנה', 'Invitation design', 'Design de l’invitation', 'Diseño de la invitación', 'אויסזען פֿון אײַנלאַדונג', 'تصميم الدعوة', 'Дизайн приглашения'],
    ['הזמנה דיגיטלית מעוצבת לאירוע, לפי הסגנון שתבחרו, כולל {n} סבבי תיקונים, מוכנה לוואטסאפ', 'A designed digital invitation for the event, in the style you choose, including {n} rounds of changes, ready for WhatsApp', 'Une invitation numérique sur mesure pour l’événement, dans le style de votre choix, avec {n} séries de retouches, prête pour WhatsApp', 'Una invitación digital diseñada para el evento, en el estilo que elija, con {n} rondas de cambios, lista para WhatsApp', 'אַ דיגיטאַלע אויסגעאַרבעטע אײַנלאַדונג פֿאַר דער שׂימחה, לויטן סטיל וואָס איר קלײַבט אויס, אַרײַנגערעכנט {n} רונדעס תּיקונים, גרייט פֿאַר וואַטסאַפּ', 'دعوة رقمية مصمّمة للمناسبة بالأسلوب الذي تختارونه، تشمل {n} جولات تعديل، جاهزة لواتساب', 'Оформленное цифровое приглашение в выбранном стиле, включая {n} круга правок, готовое для WhatsApp'],
    ['הודעת דחייה או עדכון מועד', 'Postponement or date-change message', 'Message de report ou de changement de date', 'Mensaje de aplazamiento o cambio de fecha', 'מעלדונג וועגן אָפּלייגן אָדער בײַטן די דאַטע', 'رسالة تأجيل أو تغيير موعد', 'Сообщение о переносе или смене даты'],
    ['הודעה לכל הרשימה על שינוי במועד', 'A message to the whole list about a change of date', 'Un message à toute la liste pour annoncer un changement de date', 'Un mensaje a toda la lista sobre un cambio de fecha', 'אַ מעלדונג פֿאַר דער גאַנצער רשימה וועגן אַ שינוי אין דער דאַטע', 'رسالة لكل القائمة عن تغيير الموعد', 'Сообщение всему списку об изменении даты'],
    ['הודעת ביטול אירוע', 'Event cancellation message', 'Message d’annulation de l’événement', 'Mensaje de cancelación del evento', 'מעלדונג וועגן אָפּזאָגן די שׂימחה', 'رسالة إلغاء المناسبة', 'Сообщение об отмене события'],
    ['הודעה לכל הרשימה על ביטול', 'A message to the whole list about the cancellation', 'Un message à toute la liste pour annoncer l’annulation', 'Un mensaje a toda la lista sobre la cancelación', 'אַ מעלדונג פֿאַר דער גאַנצער רשימה וועגן דעם אָפּזאָגן', 'رسالة لكل القائمة عن الإلغاء', 'Сообщение всему списку об отмене'],
    ['נסגר, פחות מ-{n} יום לאירוע', 'Closed, less than {n} days to the event', 'Fermé, moins de {n} jours avant l’événement', 'Cerrado, menos de {n} días para el evento', 'פֿאַרמאַכט, ווייניקער ווי {n} טעג ביז דער שׂימחה', 'مغلق، أقل من {n} يومًا على المناسبة', 'Закрыто, до события меньше {n} дн.'],
    /* ── invoice, contact, cookies, tour ── */
    ['החשבונית תופיע כאן ברגע שתופק. אם שילמתם ועדיין לא רואים אותה,', 'The invoice appears here as soon as it is issued. If you paid and still don’t see it,', 'La facture s’affichera ici dès son émission. Si vous avez payé et ne la voyez toujours pas,', 'La factura aparecerá aquí en cuanto se emita. Si ya pagó y todavía no la ve,', 'דער חשבון וועט זיך באַווײַזן דאָ ווי נאָר ער ווערט אַרויסגעגעבן. אויב איר האָט באַצאָלט און זעט אים נאָך נישט,', 'ستظهر الفاتورة هنا فور إصدارها. إذا دفعتم ولم تروها بعد،', 'Счёт появится здесь, как только будет выставлен. Если вы оплатили, но его ещё нет,'],
    ['יש שאלה על האירוע?', 'A question about the event?', 'Une question sur l’événement ?', '¿Alguna pregunta sobre el evento?', 'אַ פֿראַגע וועגן דער שׂימחה?', 'لديكم سؤال عن المناسبة؟', 'Есть вопрос о событии?'],
    ['דברו איתנו', 'Talk to us', 'Parlez-nous', 'Hable con nosotros', 'רעדט מיט אונדז', 'تحدّثوا إلينا', 'Свяжитесь с нами'],
    ['האתר משתמש בעוגיות למדידה ולפרסום (Meta, Google, TikTok).', 'This site uses cookies for measurement and advertising (Meta, Google, TikTok).', 'Ce site utilise des cookies de mesure et de publicité (Meta, Google, TikTok).', 'Este sitio usa cookies de medición y publicidad (Meta, Google, TikTok).', 'דער וועבזײַטל ניצט קיכלעך פֿאַר מעסטן און רעקלאַמע (Meta, Google, TikTok).', 'يستخدم الموقع ملفات تعريف الارتباط للقياس والإعلان (Meta, Google, TikTok).', 'Сайт использует файлы cookie для аналитики и рекламы (Meta, Google, TikTok).'],
    ['מה זה אומר', 'What this means', 'Ce que cela signifie', 'Qué significa', 'וואָס דאָס מיינט', 'ماذا يعني ذلك', 'Что это значит'],
    ['אישור', 'Accept', 'Accepter', 'Aceptar', 'מסכּים', 'موافقة', 'Принять'],
    ['רק הכרחי', 'Essential only', 'Essentiels uniquement', 'Solo lo esencial', 'נאָר דאָס נייטיקע', 'الضروري فقط', 'Только необходимые'],
    ['עוגיות', 'Cookies', 'Cookies', 'Cookies', 'קיכלעך', 'ملفات تعريف الارتباط', 'Cookie'],
    ['שלב {n} מתוך {n}', 'Step {n} of {n}', 'Étape {n} sur {n}', 'Paso {n} de {n}', 'שריט {n} פֿון {n}', 'الخطوة {n} من {n}', 'Шаг {n} из {n}'],
    ['המספרים האלה מתעדכנים בזמן אמת: כמה אישרו, כמה מגיעים בפועל, כמה סירבו ומי עוד לא ענה.', 'These numbers update in real time: how many confirmed, how many are actually coming, how many declined and who has not answered yet.', 'Ces chiffres se mettent à jour en temps réel : combien ont confirmé, combien viennent réellement, combien ont décliné et qui n’a pas encore répondu.', 'Estas cifras se actualizan en tiempo real: cuántos confirmaron, cuántos vienen realmente, cuántos declinaron y quién aún no ha respondido.', 'די צאָלן ווערן דערהײַנטיקט אין עכטער צײַט: וויפֿל האָבן באַשטעטיקט, וויפֿל קומען טאַקע, וויפֿל האָבן אָפּגעזאָגט און ווער ס׳האָט נאָך נישט געענטפֿערט.', 'هذه الأرقام تتحدّث لحظيًا: كم أكّدوا، كم سيحضرون فعلًا، كم اعتذروا ومن لم يجب بعد.', 'Эти цифры обновляются в реальном времени: сколько подтвердили, сколько реально придёт, сколько отказались и кто ещё не ответил.'],
    ['הבא', 'Next', 'Suivant', 'Siguiente', 'ווײַטער', 'التالي', 'Далее'],
    ['דלגו על הכל', 'Skip all', 'Tout passer', 'Omitir todo', 'איבערהיפּן אַלץ', 'تخطي الكل', 'Пропустить всё'],
    ['מצב תצוגה', 'Display mode', 'Mode d’affichage', 'Modo de visualización', 'אויסזען־מאָדוס', 'وضع العرض', 'Режим отображения'],
    ['תוכן הלוח', 'Board contents', 'Sommaire du tableau', 'Contenido del panel', 'אינהאַלט פֿונעם ברעט', 'محتوى اللوحة', 'Содержание панели'],
    ["בוצע ✓", "Done ✓", "Fait ✓", "Hecho ✓", "געטאָן ✓", "تم ✓", "Готово ✓"],
    ["תוצאות הסבב", "Round results", "Résultats de la série", "Resultados de la ronda", "רעזולטאַטן פֿון דער רונדע", "نتائج الجولة", "Итоги раунда"],
    ["מצורפת תמונה", "Image attached", "Image jointe", "Imagen adjunta", "אַ בילד איז צוגעלייגט", "صورة مرفقة", "Изображение прикреплено"],
    ["✓ נוסח אישי מאושר", "✓ Your wording is approved", "✓ Votre texte est approuvé", "✓ Su texto está aprobado", "✓ אײַער נוסח איז באַשטעטיקט", "✓ صيغتكم معتمدة", "✓ Ваш текст одобрен"],
    ["ההזמנות כבר יצאו, הנוסח נעול.", "The invitations have already gone out, the wording is locked.", "Les invitations sont déjà parties, le texte est verrouillé.", "Las invitaciones ya se enviaron, el texto está bloqueado.", "די אײַנלאַדונגען זענען שוין אַרויס, דער נוסח איז פֿאַרשלאָסן.", "تم إرسال الدعوات، الصيغة مقفلة.", "Приглашения уже отправлены, текст зафиксирован."],
    ["להזמנה. כך היא תיראה אצל המוזמנים.", "for the invitation. This is how guests will see it.", "pour l’invitation. Voici ce que verront les invités.", "para la invitación. Así la verán los invitados.", "פֿאַר דער אײַנלאַדונג. אַזוי וועלן די געסט זי זען.", "للدعوة. هكذا ستظهر لدى المدعوين.", "для приглашения. Так его увидят гости."],
    ["ההזמנה הראשונה יצאה בנוסח הרגיל. מוזמנים שתוסיפו מעכשיו יקבלו את הנוסח שלכם. התזכורות הן הודעה נפרדת ולא משתנות.", "The first invitation went out with the regular wording. Guests you add from now on will get your wording. Reminders are a separate message and do not change.", "La première invitation est partie avec le texte habituel. Les invités ajoutés désormais recevront votre texte. Les rappels sont un message distinct et ne changent pas.", "La primera invitación salió con el texto habitual. Los invitados que añada a partir de ahora recibirán su texto. Los recordatorios son un mensaje aparte y no cambian.", "די ערשטע אײַנלאַדונג איז אַרויס מיטן געוויינטלעכן נוסח. געסט וואָס איר וועט צולייגן פֿון איצט וועלן באַקומען אײַער נוסח. די דערמאָנונגען זענען אַ באַזונדערע מעלדונג און בײַטן זיך נישט.", "الدعوة الأولى أُرسلت بالصيغة العادية. المدعوون الذين تضيفونهم من الآن سيستلمون صيغتكم. التذكيرات رسالة منفصلة ولا تتغير.", "Первое приглашение ушло с обычным текстом. Гости, которых вы добавите с этого момента, получат ваш текст. Напоминания — отдельное сообщение, они не меняются."],
    ["חשבונית מס/קבלה אחת הופקה לאירוע.", "One tax invoice/receipt was issued for the event.", "Une facture/reçu a été émise pour l’événement.", "Se emitió una factura/recibo para el evento.", "איין שטײַער־חשבון/קבלה איז אַרויסגעגעבן געוואָרן פֿאַר דער שׂימחה.", "صدرت فاتورة ضريبية/إيصال واحد للمناسبة.", "Для события выставлен один счёт-фактура/чек."],
    ["{n} חשבוניות מס/קבלה הופקו לאירוע.", "{n} tax invoices/receipts were issued for the event.", "{n} factures/reçus ont été émis pour l’événement.", "Se emitieron {n} facturas/recibos para el evento.", "{n} שטײַער־חשבונות/קבלות זענען אַרויסגעגעבן געוואָרן פֿאַר דער שׂימחה.", "صدرت {n} فواتير ضريبية/إيصالات للمناسبة.", "Для события выставлено счетов-фактур/чеков: {n}."],
    ["מס׳ {n} · רכישה · {n}", "No. {n} · purchase · {n}", "N° {n} · achat · {n}", "N.º {n} · compra · {n}", "נומ׳ {n} · קויף · {n}", "رقم {n} · شراء · {n}", "№ {n} · покупка · {n}"],
    ["מס׳ {n} · רכישה · ₪{n} · {n}", "No. {n} · purchase · ₪{n} · {n}", "N° {n} · achat · {n} ₪ · {n}", "N.º {n} · compra · ₪{n} · {n}", "נומ׳ {n} · קויף · ₪{n} · {n}", "رقم {n} · شراء · ₪{n} · {n}", "№ {n} · покупка · ₪{n} · {n}"],
    ["מס׳ {n} · תוספת · ₪{n} · {n}", "No. {n} · add-on · ₪{n} · {n}", "N° {n} · supplément · {n} ₪ · {n}", "N.º {n} · extra · ₪{n} · {n}", "נומ׳ {n} · צוגאָב · ₪{n} · {n}", "رقم {n} · إضافة · ₪{n} · {n}", "№ {n} · дополнение · ₪{n} · {n}"],
    ["המספר לא פעיל בוואטסאפ, או שהגדרות הפרטיות שלו חוסמות הודעות ממי שלא שמור אצלו באנשי הקשר", "The number is not active on WhatsApp, or its privacy settings block messages from senders not saved in its contacts", "Le numéro n’est pas actif sur WhatsApp, ou ses réglages de confidentialité bloquent les messages des expéditeurs absents de ses contacts", "El número no está activo en WhatsApp, o su configuración de privacidad bloquea mensajes de quien no está en sus contactos", "דער נומער איז נישט אַקטיוו אויף וואַטסאַפּ, אָדער זײַנע פּריוואַטקייט־אײַנשטעלונגען בלאָקירן מעלדונגען פֿון ווער ס׳איז נישט אין זײַנע קאָנטאַקטן", "الرقم غير نشط على واتساب، أو إعدادات الخصوصية لديه تحجب الرسائل ممن ليسوا في جهات اتصاله", "Номер не активен в WhatsApp, либо настройки приватности блокируют сообщения от тех, кого нет в контактах"],
    ["וואטסאפ מגביל לאיש הקשר הזה הודעות מעסקים שלא שמורים אצלו", "WhatsApp limits messages to this contact from businesses not saved in their contacts", "WhatsApp limite pour ce contact les messages d’entreprises absentes de ses contacts", "WhatsApp limita para este contacto los mensajes de empresas que no tiene guardadas", "וואַטסאַפּ באַגרענעצט פֿאַר דעם קאָנטאַקט מעלדונגען פֿון געשעפֿטן וואָס זענען נישט בײַ אים פֿאַרשריבן", "واتساب يقيّد لهذه الجهة الرسائل من الأعمال غير المحفوظة لديها", "WhatsApp ограничивает для этого контакта сообщения от компаний, которых нет в его контактах"],
    ["זה מצב זמני מצד וואטסאפ", "This is a temporary state on WhatsApp’s side", "C’est une situation temporaire du côté de WhatsApp", "Es una situación temporal por parte de WhatsApp", "דאָס איז אַ צײַטווײַליקער מצבֿ פֿון וואַטסאַפּס זײַט", "هذه حالة مؤقتة من جهة واتساب", "Это временное ограничение со стороны WhatsApp"],
    ["וואטסאפ מגביל לאיש הקשר הזה הודעות מעסקים כרגע (מצב זמני מצד וואטסאפ)", "WhatsApp is currently limiting business messages to this contact (a temporary state on WhatsApp’s side)", "WhatsApp limite actuellement les messages d’entreprises pour ce contact (situation temporaire du côté de WhatsApp)", "WhatsApp limita por ahora los mensajes de empresas a este contacto (situación temporal por parte de WhatsApp)", "וואַטסאַפּ באַגרענעצט איצט געשעפֿט־מעלדונגען צו דעם קאָנטאַקט (אַ צײַטווײַליקער מצבֿ פֿון וואַטסאַפּס זײַט)", "واتساب يقيّد حاليًا رسائل الأعمال لهذه الجهة (حالة مؤقتة من جهة واتساب)", "WhatsApp сейчас ограничивает сообщения от компаний этому контакту (временно, со стороны WhatsApp)"],
    ["הסרטון או התמונה לא נטענו אצל וואטסאפ באותו רגע", "The video or image did not load at WhatsApp at that moment", "La vidéo ou l’image ne s’est pas chargée chez WhatsApp à ce moment-là", "El vídeo o la imagen no se cargó en WhatsApp en ese momento", "דער ווידעאָ אָדער דאָס בילד האָט זיך נישט אָנגעלאָדן בײַ וואַטסאַפּ אין יענעם מאָמענט", "لم يُحمَّل الفيديو أو الصورة لدى واتساب في تلك اللحظة", "Видео или изображение не загрузилось в WhatsApp в тот момент"],
    ["תקלה זמנית בחיבור לוואטסאפ מצידנו", "A temporary connection issue with WhatsApp on our side", "Un souci temporaire de connexion à WhatsApp de notre côté", "Un problema temporal de conexión con WhatsApp por nuestra parte", "אַ צײַטווײַליקע שטערונג אין דער פֿאַרבינדונג מיט וואַטסאַפּ פֿון אונדזער זײַט", "خلل مؤقت في الاتصال بواتساب من جهتنا", "Временный сбой соединения с WhatsApp на нашей стороне"],
    ["וואטסאפ קיבל את ההודעה אבל לא מסר אותה לטלפון כבר יממה (טלפון כבוי, בלי קליטה או מספר לא פעיל)", "WhatsApp accepted the message but has not delivered it to the phone for a day (phone off, no reception or an inactive number)", "WhatsApp a accepté le message mais ne l’a pas remis au téléphone depuis un jour (téléphone éteint, sans réseau ou numéro inactif)", "WhatsApp aceptó el mensaje pero lleva un día sin entregarlo al teléfono (teléfono apagado, sin cobertura o número inactivo)", "וואַטסאַפּ האָט אָנגענומען די מעלדונג אָבער האָט זי שוין אַ מעת־לעת נישט איבערגעגעבן צום טעלעפֿאָן (אויסגעלאָשענער טעלעפֿאָן, אָן אָפּנעם אָדער אַ נישט־אַקטיווער נומער)", "استلم واتساب الرسالة لكنه لم يسلّمها إلى الهاتف منذ يوم (هاتف مغلق، بلا تغطية أو رقم غير نشط)", "WhatsApp принял сообщение, но уже сутки не доставил его на телефон (телефон выключен, нет сети или номер не активен)"],
    ["וואטסאפ לא הצליח למסור את ההודעה", "WhatsApp could not deliver the message", "WhatsApp n’a pas pu remettre le message", "WhatsApp no pudo entregar el mensaje", "וואַטסאַפּ האָט נישט געקענט איבערגעבן די מעלדונג", "تعذّر على واتساب تسليم الرسالة", "WhatsApp не смог доставить сообщение"],
    ["ננסה לשלוח שוב אוטומטית ב-{n}", "We will try to send again automatically on {n}", "Nous réessaierons automatiquement le {n}", "Lo intentaremos de nuevo automáticamente el {n}", "מיר וועלן פּרוּוון שיקן ווידער אויטאָמאַטיש דעם {n}", "سنحاول الإرسال مجددًا تلقائيًا في {n}", "Мы автоматически попробуем снова {n}"],
    ["ננסה לשלוח שוב אוטומטית", "We will try to send again automatically", "Nous réessaierons automatiquement", "Lo intentaremos de nuevo automáticamente", "מיר וועלן פּרוּוון שיקן ווידער אויטאָמאַטיש", "سنحاول الإرسال مجددًا تلقائيًا", "Мы автоматически попробуем снова"],
    ["ניסינו שלוש פעמים", "We tried three times", "Nous avons essayé trois fois", "Lo intentamos tres veces", "מיר האָבן געפּרוּווט דרײַ מאָל", "حاولنا ثلاث مرات", "Мы пробовали три раза"],
    ["כדאי לשלוח להם את ההזמנה מהטלפון שלכם", "It is worth sending them the invitation from your own phone", "Mieux vaut leur envoyer l’invitation depuis votre téléphone", "Conviene enviarles la invitación desde su teléfono", "ס׳איז כּדאַי זיי צו שיקן די אײַנלאַדונג פֿון אײַער טעלעפֿאָן", "يُستحسن إرسال الدعوة لهم من هاتفكم", "Лучше отправить им приглашение со своего телефона"],
    ["למה לא נמסר?", "Why was it not delivered?", "Pourquoi n’a-t-il pas été remis ?", "¿Por qué no se entregó?", "פֿאַרוואָס איז עס נישט איבערגעגעבן געוואָרן?", "لماذا لم تُسلَّم؟", "Почему не доставлено?"],
    ["מה קורה עכשיו", "What happens now", "Et maintenant", "Qué pasa ahora", "וואָס געשעט איצט", "ماذا يحدث الآن", "Что дальше"],
    ["תקציב", "Budget", "Budget", "Presupuesto", "בודזשעט", "الميزانية", "Бюджет"],
    ["קבלת פנים {n}", "Reception {n}", "Accueil {n}", "Recepción {n}", "קבלת־פּנים {n}", "الاستقبال {n}", "Сбор гостей {n}"],
    ["חתונה", "Wedding", "Mariage", "Boda", "חתונה", "زفاف", "Свадьба"],
    ["בר מצווה", "Bar mitzvah", "Bar-mitsva", "Bar mitzvá", "בר־מצווה", "بار متسفا", "Бар-мицва"],
    ["בת מצווה", "Bat mitzvah", "Bat-mitsva", "Bat mitzvá", "בת־מצווה", "بات متسفا", "Бат-мицва"],
    ["ברית", "Brit milah", "Brit mila", "Brit milá", "ברית", "ختان", "Брит-мила"],
    ["חינה", "Henna", "Henné", "Henna", "חינה", "حنّة", "Хина"],
    ["מכובד", "Dignified", "Solennel", "Solemne", "כּבֿודיק", "وقورة", "Торжественный"],
    ["רשמי", "Formal", "Formel", "Formal", "אָפֿיציעל", "رسمية", "Официальный"],
    ["שובב", "Playful", "Espiègle", "Divertido", "שטיפֿעריש", "مرحة", "Игривый"],
    ['שפה', 'Language', 'Langue', 'Idioma', 'שפּראַך', 'اللغة', 'Язык']
  ];

  var DICT = Object.create(null);
  ROWS.forEach(function (r) { DICT[r[0]] = r; });

  var HEB = /[֐-׿]/;
  var NUM = /\d+(?:[.,:\/]\d+)*/g;
  var DAYS = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
  var MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  var DATE_RE = /^יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת), (\d{1,2}) ב(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר) (\d{4})$/;

  /* The full dictionaries (about 1,500 texts per language, every client screen) live in assets/i18n/<code>.json as
     { Hebrew: translation }. They are fetched once, when the language is chosen. ROWS above stays the first word on
     the board's own texts; the file covers everything else. A number inside a text is lifted out here too, so
     "3 מגיעים" in the file also answers "7 מגיעים". */
  var DICT_V = '20261122b';
  var BASE = (function () { try { var cs = document.currentScript && document.currentScript.src; return cs ? cs.replace(/i18n\.js(\?.*)?$/, 'i18n/') : 'assets/i18n/'; } catch (e) { return 'assets/i18n/'; } })();
  var EXTRA = Object.create(null), LOADING = Object.create(null);
  function indexFile(obj) {
    var exact = Object.create(null), norm = Object.create(null);
    for (var he in obj) {
      var v = obj[he]; if (typeof v !== 'string' || !v) continue;
      exact[he] = v;
      var nums = he.match(NUM); if (!nums) continue;
      var tpl = v, ok = true;
      for (var q = 0; q < nums.length; q++) { var at = tpl.indexOf(nums[q]); if (at < 0) { ok = false; break; } tpl = tpl.slice(0, at) + '\u0001' + q + '\u0002' + tpl.slice(at + nums[q].length); }
      var nk = he.replace(NUM, '{n}');
      if (ok && !norm[nk]) norm[nk] = tpl;
    }
    return { exact: exact, norm: norm };
  }
  function fromFile(he) {
    var x = EXTRA[lang]; if (!x) return null;
    if (x.exact[he]) return x.exact[he];
    var nums = []; var key = he.replace(NUM, function (m) { nums.push(m); return '{n}'; });
    if (!nums.length) return null;
    /* a file row that was written with {n} itself ("שלב {n} מתוך {n}") */
    if (x.exact[key]) { var k2 = 0; return x.exact[key].replace(/\{n\}/g, function () { return nums[k2++] != null ? nums[k2 - 1] : ''; }); }
    var tpl = x.norm[key]; if (!tpl) return null;
    return tpl.replace(/\u0001(\d+)\u0002/g, function (_, q) { return nums[Number(q)] != null ? nums[Number(q)] : ''; });
  }
  function loadFile(c, then) {
    if (c === 'he' || EXTRA[c] || LOADING[c]) { if (EXTRA[c] && then) then(); return; }
    LOADING[c] = 1;
    /* 22/11: the dictionaries change more often than this file; DICT_V is bumped with every dictionary change so a returning device does not keep an old copy */
    fetch(BASE + c + '.json?v=' + DICT_V).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      LOADING[c] = 0; if (j && typeof j === 'object') { EXTRA[c] = indexFile(j); if (then) then(); }
    }).catch(function () { LOADING[c] = 0; });
  }

  var lang = 'he';
  function meta(c) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i].c === c) return LANGS[i]; return LANGS[0]; }

  /* one Hebrew string → the chosen language, or null when we have nothing for it */
  function tr(he) {
    if (lang === 'he' || !he || !HEB.test(he)) return null;
    var i = IDX[lang];
    var row = i ? DICT[he] : null;
    if (row) return row[i];
    var b0 = i ? withNumbers(he, i) : null; if (b0 != null) return b0;   /* the board's own rows first, numbers included */
    var f0 = fromFile(he); if (f0 != null) return f0;
    var d = DATE_RE.exec(he);
    if (d) {
      try {
        var dt = new Date(Date.UTC(Number(d[4]), MONTHS.indexOf(d[3]), Number(d[2]), 12));
        var loc = meta(lang).loc;
        /* Yiddish has no browser calendar names: day and month number, the same way a Hebrew date is read */
        if (lang === 'yi') return d[2] + '.' + (MONTHS.indexOf(d[3]) + 1) + '.' + d[4];
        return new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dt);
      } catch (e) { return null; }
    }
    var one = i ? withNumbers(he, i) : null;
    if (one != null) return one;
    /* a text built from several sentences (the "why was it not delivered" card): each sentence on its own; all or nothing */
    /* "חתונה · דיקלה ואריאל" — pieces joined by a middle dot: translate the pieces we know, leave the event's own words */
    if (he.indexOf(' · ') > 0 && !DICT[he]) {
      var ps = he.split(' · '), hit = 0, o2 = [];
      for (var z = 0; z < ps.length; z++) { var tz = HEB.test(ps[z]) ? trPiece(ps[z], i) : null; if (tz != null) hit++; o2.push(tz != null ? tz : ps[z]); }
      if (hit) return o2.join(' · ');
    }
    var parts = he.split(/(?<=[.!?])\s+/);
    if (parts.length < 2) return null;
    var out = [];
    for (var p = 0; p < parts.length; p++) {
      var seg = parts[p], end = /[.!?]$/.test(seg) ? seg.slice(-1) : '', body = end ? seg.slice(0, -1) : seg;
      if (!HEB.test(seg)) { out.push(seg); continue; }
      var t = part(seg, i);
      if (t == null) { t = part(body, i); if (t != null) t += end; }
      if (t == null) return null;
      out.push(t);
    }
    return out.join(' ');
  }
  function trPiece(x, i) {
    var d = DATE_RE.exec(x) || /^(\d{1,2}) ב(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר) (\d{4})$/.exec(x);
    if (d) { try { var day = d.length === 5 ? d[2] : d[1], mon = d.length === 5 ? d[3] : d[2], yr = d.length === 5 ? d[4] : d[3];
      if (lang === 'yi') return day + '.' + (MONTHS.indexOf(mon) + 1) + '.' + yr;
      return new Intl.DateTimeFormat(meta(lang).loc, d.length === 5 ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(yr), MONTHS.indexOf(mon), Number(day), 12))); } catch (e) { return null; } }
    return part(x, i);
  }
  function part(x, i) { return (i && DICT[x] && DICT[x][i]) || (i ? withNumbers(x, i) : null) || fromFile(x); }
  function withNumbers(he, i) {
    var nums = [];
    var key = he.replace(NUM, function (m) { nums.push(m); return '{n}'; });
    if (!nums.length) return null;
    var row = DICT[key];
    if (!row) return null;
    var k = 0;
    return row[i].replace(/\{n\}/g, function () { return nums[k++] != null ? nums[k - 1] : ''; });
  }

  /* ── applying it to the page ── */
  var orig = new WeakMap();          /* text node → its Hebrew */
  var shown = new WeakMap();         /* text node → what we last wrote */
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  var busy = false;

  function skip(el) { return !el || !!(el.closest && el.closest('script,style,[data-noi18n],.row-n')); }

  function doText(n) {
    var cur = n.nodeValue;
    if (!cur || !cur.trim()) return;
    if (skip(n.parentElement)) return;
    /* the board wrote something new into this node: that is the new Hebrew */
    if (shown.get(n) !== cur) orig.set(n, cur);
    var he = orig.get(n);
    if (he == null) return;
    var core = he.replace(/\s+/g, ' ').trim();
    var t = tr(core);
    var out = t == null ? he : he.replace(/^(\s*)[\s\S]*?(\s*)$/, function (_, a, b) { return a + t + b; });
    if (out !== cur) { n.nodeValue = out; }
    shown.set(n, out);
    /* Hebrew that stays Hebrew (the invitation text, the hosts' names) keeps its own direction on a left-to-right page */
    var pe = n.parentElement;
    if (pe) { if (t == null && HEB.test(core) && meta(lang).dir === 'ltr') { if (!pe.hasAttribute('dir')) { pe.setAttribute('dir', 'auto'); pe.setAttribute('data-i18n-dir', ''); } } else if (pe.hasAttribute('data-i18n-dir') && (lang === 'he' || meta(lang).dir === 'rtl')) { pe.removeAttribute('dir'); pe.removeAttribute('data-i18n-dir'); } }
    /* a button whose own code reads its label back gets the Hebrew kept beside it */
    if (n.parentElement && n.parentElement.childNodes.length === 1) n.parentElement.setAttribute('data-he', core);
  }

  function doAttrs(el) {
    if (!el.getAttribute || skip(el)) return;
    for (var a = 0; a < ATTRS.length; a++) {
      var name = ATTRS[a], cur = el.getAttribute(name);
      if (cur == null) continue;
      var keep = 'data-he-' + name, last = 'data-tr-' + name;
      if (el.getAttribute(last) !== cur) el.setAttribute(keep, cur);
      var he = el.getAttribute(keep);
      if (he == null) continue;
      var t = tr(he.replace(/\s+/g, ' ').trim());
      var out = t == null ? he : t;
      if (out !== cur) el.setAttribute(name, out);
      el.setAttribute(last, out);
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    doAttrs(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  function applyAll() {
    busy = true;
    try {
      var m = meta(lang);
      document.documentElement.setAttribute('lang', m.c);
      document.documentElement.setAttribute('dir', m.dir);
      walk(document.body);
    } finally { busy = false; }
  }

  var queued = false, pending = [];
  function flush() {
    queued = false;
    var list = pending; pending = [];
    busy = true;
    try { for (var i = 0; i < list.length; i++) if (list[i].isConnected !== false) walk(list[i]); } finally { busy = false; }
  }
  function watch() {
    new MutationObserver(function (muts) {
      if (busy) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') pending.push(m.target);
        else if (m.type === 'attributes') pending.push(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) pending.push(m.addedNodes[j]);
      }
      if (pending.length && !queued) { queued = true; (window.requestAnimationFrame || setTimeout)(flush); }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  /* ── the picker: a button with the current language, and a short list under it (our look, not a browser select) ── */
  /* it sits on the dark header beside the light/dark button, so it wears the same quiet gold outline */
  var CSS = '.lng{position:absolute;top:.85rem;left:calc(.85rem + 34px + .5rem);z-index:6;font-family:inherit}' +
    '.lng-b{display:inline-flex;align-items:center;gap:.4rem;height:34px;font:inherit;font-size:.8rem;font-weight:500;padding:0 .65rem;border:1px solid rgba(199,174,122,.35);border-radius:8px;background:rgba(248,244,234,.08);color:#F8F4EA;cursor:pointer;line-height:1}' +
    '.lng-b:hover{border-color:rgba(199,174,122,.8)}.lng-b:active{transform:scale(.97)}.lng-b:focus-visible,.lng-o:focus-visible{outline:2px solid #C7AE7A;outline-offset:2px}' +
    '.lng-b svg{width:15px;height:15px;flex:none;opacity:.75}.lng-b .car{font-size:.6rem;opacity:.6}' +
    '.lng-m{position:absolute;top:calc(100% + 6px);left:0;z-index:60;min-width:11rem;padding:.3rem;background:var(--card,#fff);border:1px solid var(--bdr,#e5e7eb);border-radius:8px;box-shadow:0 10px 30px rgba(15,46,34,.16);display:none}' +
    '.lng.open .lng-m{display:block}' +
    '.lng-o{display:flex;align-items:center;justify-content:space-between;gap:.8rem;width:100%;font:inherit;font-size:.88rem;padding:.5rem .65rem;border:0;border-radius:6px;background:transparent;color:var(--ink,#111827);cursor:pointer;text-align:start}' +
    '.lng-o:hover{background:var(--green4,#F3F8F5)}.lng-o[aria-checked=true]{font-weight:600;color:var(--green,#0F4C35)}' +
    '.lng-o .ck{visibility:hidden;color:var(--gold,#A8853C)}.lng-o[aria-checked=true] .ck{visibility:visible}' +
    'html[data-theme=dark] .lng-o:hover{background:rgba(255,255,255,.07)}html[data-theme=dark] .lng-m{box-shadow:0 10px 30px rgba(0,0,0,.5)}';
  var GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/></svg>';
  function paintPicker() {
    var w = document.getElementById('langPick'); if (!w) return;
    /* on the header the button is short (the brand sits right beside it): the code of the language, the full name is in the list */
    w.querySelector('.lng-n').textContent = ({ he: 'עב', yi: 'יי', ar: 'ع' })[lang] || lang.toUpperCase();
    var os = w.querySelectorAll('.lng-o');
    for (var i = 0; i < os.length; i++) os[i].setAttribute('aria-checked', os[i].getAttribute('data-l') === lang ? 'true' : 'false');
  }
  function picker() {
    var anchor = document.getElementById('themeTog');
    if (document.getElementById('langPick') || !document.body) return;
    var floating = !anchor || !!document.querySelector('[data-i18n-float]') || !/dashboard/.test(location.pathname);
    var st = document.createElement('style'); st.textContent = CSS + (floating ? '.lng.flt{position:fixed;top:.6rem;left:.6rem;z-index:8000}.lng.flt .lng-b{background:var(--card,#fff);color:var(--ink,#111827);border-color:var(--bdr,#e5e7eb);box-shadow:0 2px 10px rgba(15,46,34,.12)}html[data-theme=dark] .lng.flt .lng-b{background:#141D19;color:#F3F4F6;border-color:#2B3440}@media print{.lng{display:none}}' : ''); document.head.appendChild(st);
    var w = document.createElement('div'); w.id = 'langPick'; w.className = 'lng'; w.setAttribute('data-noi18n', '');
    var b = document.createElement('button'); b.type = 'button'; b.className = 'lng-b'; b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', 'שפה · Language');
    b.innerHTML = GLOBE + '<span class="lng-n"></span><span class="car" aria-hidden="true">▾</span>';
    var m = document.createElement('div'); m.className = 'lng-m'; m.setAttribute('role', 'menu');
    LANGS.forEach(function (l) {
      var o = document.createElement('button'); o.type = 'button'; o.className = 'lng-o'; o.setAttribute('role', 'menuitemradio'); o.setAttribute('data-l', l.c); o.setAttribute('lang', l.c); o.setAttribute('dir', l.dir);
      var n = document.createElement('span'); n.textContent = l.n; var c = document.createElement('span'); c.className = 'ck'; c.textContent = '✓'; c.setAttribute('aria-hidden', 'true');
      o.appendChild(n); o.appendChild(c);
      o.addEventListener('click', function () { close(); set(l.c); b.focus(); });
      m.appendChild(o);
    });
    function close() { w.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); }
    b.addEventListener('click', function (e) { e.stopPropagation(); var on = !w.classList.contains('open'); w.classList.toggle('open', on); b.setAttribute('aria-expanded', on ? 'true' : 'false'); if (on) { var cur = m.querySelector('[aria-checked=true]') || m.firstChild; cur && cur.focus(); } });
    document.addEventListener('click', function (e) { if (!w.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && w.classList.contains('open')) { close(); b.focus(); } });
    m.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; e.preventDefault();
      var os = [].slice.call(m.querySelectorAll('.lng-o')), i = os.indexOf(document.activeElement);
      os[(i + (e.key === 'ArrowDown' ? 1 : os.length - 1)) % os.length].focus();
    });
    w.appendChild(b); w.appendChild(m);
    if (floating) { w.classList.add('flt'); document.body.appendChild(w); } else anchor.parentNode.insertBefore(w, anchor);
    paintPicker();
  }

  function set(c) {
    lang = IDX[c] || FILE_ONLY[c] || c === 'he' ? c : 'he';
    loadFile(lang, function () { if (lang === c) applyAll(); });
    try { localStorage.setItem('ishur_lang', lang); } catch (e) {}
    paintPicker();
    applyAll();
  }

  function start() {
    var want = '';
    try { want = new URLSearchParams(location.search).get('lang') || localStorage.getItem('ishur_lang') || ''; } catch (e) {}
    lang = IDX[want] || FILE_ONLY[want] ? want : 'he';
    if (!meta(lang) || meta(lang).c !== lang) lang = 'he';
    picker();
    if (lang !== 'he') { applyAll(); loadFile(lang, function () { applyAll(); }); }
    watch();
  }

  window.IshurI18n = { set: set, get: function () { return lang; }, tr: tr, langs: LANGS.map(function (l) { return l.c; }), rows: ROWS.length };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
