# -*- coding: utf-8 -*-
"""SEO landing pages generator for ishur.io — one page per city/event type.
Run from the repo root: python3 .sdlc/seo-gen.py
Each page carries unique copy, Service+FAQPage JSON-LD, canonical and OG tags.
"""
import json, html

PAGES = [
    {
        "slug": "hatuna",
        "title": "אישורי הגעה לחתונה בוואטסאפ",
        "h1": "אישורי הגעה לחתונה",
        "desc": "אישורי הגעה לחתונה בוואטסאפ: ההזמנה נשלחת לכל הרשימה, האורחים מאשרים בלחיצה, ואתם רואים בזמן אמת מי מגיע. מ-50 ₪ לאירוע.",
        "intro": "חתונה ממוצעת בישראל מזמינה בין 200 ל-500 איש, ומישהו צריך לדעת כמה מהם באמת מגיעים. הדרך הישנה היא שבועיים של טלפונים. הדרך של ishur: ההזמנה יוצאת בוואטסאפ לכל הרשימה, כל אורח לוחץ כפתור ועונה כמה תהיו, ומי שלא ענה מקבל תזכורת מנומסת בדיוק בזמן. אתם פותחים דשבורד ורואים מספר אחד ברור: כמה סועדים סופרים.",
        "faq": [
            ("כמה זמן לפני החתונה שולחים את ההזמנות?", "המקובל הוא שלושה עד ארבעה שבועות לפני, עם תזכורת שבועיים לפני וסבב אחרון בשבוע של האירוע. את התאריכים קובעים אתם, והמערכת שולחת לבד בבוקר שנבחר."),
            ("מה קורה עם אורחים שלא עונים גם אחרי תזכורות?", "הם עוברים אוטומטית לרשימת שיחות מסודרת, ובחבילות המתאימות מוקד אנושי או סוכנת הטלפון שלנו משלימים את מי שוואטסאפ לא הספיק לו."),
            ("האורחים צריכים להתקין אפליקציה?", "לא. הכל קורה בוואטסאפ הרגיל שלהם: כפתור מגיע, כפתור לא מגיע, ותשובה של כמה תהיו."),
            ("כמה זה עולה?", "לפי כמות מוזמנים: מ-50 ₪ לחבילת הבסיס. משלמים פעם אחת לאירוע, בלי מנוי."),
        ],
    },
    {
        "slug": "bar-mitzvah",
        "title": "אישורי הגעה לבר מצווה ובת מצווה",
        "h1": "אישורי הגעה לבר/בת מצווה",
        "desc": "אישורי הגעה לבר מצווה ובת מצווה בוואטסאפ: שליחה לכל הכיתה והמשפחה, אישור בלחיצה, ומעקב חי של כמה מגיעים. מ-50 ₪.",
        "intro": "בר מצווה זה שני עולמות בהזמנה אחת: המשפחה והחברים של ההורים מצד אחד, וכיתה שלמה של ילדים מצד שני. ההורים של החברים הם בדיוק הקהל שנוח לו לענות בוואטסאפ ולא לטלפון ממספר לא מוכר. ishur שולח, מתזכר וסופר, ואתם סוגרים מול האולם מספר אמיתי במקום ניחוש.",
        "faq": [
            ("איך זה עובד עם הזמנות לילדים מהכיתה?", "ההזמנה נשלחת להורה, והוא עונה כמה מגיעים מהמשפחה. ברשימה אפשר לסמן כל קבוצה בנפרד, כיתה, משפחה, חברים, ולראות כמה אישרו מכל קבוצה."),
            ("אפשר לשלוח גם הזמנה מעוצבת?", "כן. מעלים את ההזמנה המעוצבת שלכם והיא נשלחת יחד עם הודעת האישור."),
            ("מתי כדאי לשלוח?", "לבר מצווה מספיקים שבועיים עד שלושה לפני, כי רוב הרשימה קרובה. תזכורת שבוע לפני סוגרת את רוב הפתוחים."),
        ],
    },
    {
        "slug": "tel-aviv",
        "city": "תל אביב",
        "title": "אישורי הגעה לאירועים בתל אביב",
        "desc": "אישורי הגעה בוואטסאפ לחתונות ואירועים בתל אביב: שליחה, תזכורות ומעקב חי של כמה מגיעים. מ-50 ₪ לאירוע.",
        "intro": "אירוע בתל אביב מתחרה על הערב של האורחים מול עוד אלף תוכניות, ולכן אחוז המענה להזמנות כאן הוא הנמוך בארץ כשמסתמכים על טלפונים. וואטסאפ הופך את זה: תשובה בלחיצה, בזמן שנוח לאורח, ותזכורת אוטומטית למי שנשאר פתוח. מגני התערוכה ועד לופטים בדרום העיר, המספר שסוגרים מול המקום הוא מספר אמיתי.",
        "faqcity": "רוב אולמות האירועים בתל אביב מבקשים מספר סועדים סופי 48-72 שעות לפני. הדוח הסופי שלנו נשלח אוטומטית שבוע לפני, ואפשר לרדת לרזולוציה יומית בדשבורד עד יום האירוע.",
    },
    {
        "slug": "jerusalem",
        "city": "ירושלים",
        "title": "אישורי הגעה לאירועים בירושלים",
        "desc": "אישורי הגעה בוואטסאפ לחתונות ושמחות בירושלים: שליחה מכובדת, תזכורות ומעקב חי. שומרים שבת. מ-50 ₪.",
        "intro": "שמחות בירושלים מביאות רשימות גדולות ומגוונות: משפחה מורחבת, קהילה, ואורחים שמגיעים מחוץ לעיר. אצלנו ברירת המחדל מכבדת את כולם: שום הודעה לא נשלחת בשבת או בחג, הניסוח מנומס, ומי שמעדיף שלא לקבל הודעות מוסר בלחיצה אחת ועובר לרשימת הזמנה טלפונית.",
        "faqcity": "המערכת לא שולחת הודעות בשבתות ובחגים בכלל, ובימי שישי עוצרת מוקדם. גם התזכורות מתוזמנות סביב זה אוטומטית.",
    },
    {
        "slug": "haifa",
        "city": "חיפה",
        "title": "אישורי הגעה לאירועים בחיפה והצפון",
        "desc": "אישורי הגעה בוואטסאפ לאירועים בחיפה, בקריות ובצפון: שליחה, תזכורות ומעקב חי של מגיעים. מ-50 ₪ לאירוע.",
        "intro": "כשחצי מהרשימה מגיעה מהמרכז לאירוע בחיפה או בצפון, השאלה של מי באמת מגיע שווה כסף: הסעות, סידורי לינה וכמות מנות. אישור בוואטסאפ עם שאלת \"כמה תהיו\" נותן לכם את המספר הזה שבועות מראש, בלי לרדוף אף אחד בטלפון.",
        "faqcity": "אפשר להוסיף להודעת ההזמנה שדות מותאמים, למשל שאלה על הסעה מנקודת איסוף, והתשובות נאספות לאותו דשבורד.",
    },
    {
        "slug": "rishon-lezion",
        "city": "ראשון לציון",
        "title": "אישורי הגעה לאירועים בראשון לציון",
        "desc": "אישורי הגעה בוואטסאפ לאירועים בראשון לציון והסביבה: שליחת הזמנות, תזכורות ומעקב חי. מ-50 ₪ לאירוע.",
        "intro": "מתחם האולמות של ראשון לציון הוא מהעמוסים בארץ, והתחרות על תאריכים טובים מתחילה מוקדם. ברגע שסגרתם מקום, הדבר הבא זה רשימת מוזמנים, ואצלנו היא הופכת תוך שלוש דקות מקובץ אקסל למערכת שעובדת לבד: שולחת, מתזכרת, סופרת ומדווחת.",
        "faqcity": "מעלים כל קובץ אקסל או גוגל-שיטס עם שם וטלפון. המערכת סלחנית לפורמטים: גם בלי אפס מוביל, גם עם שורת כותרת, וכל שורה בעייתית מסומנת לתיקון במקום להיכשל.",
    },
    {
        "slug": "petah-tikva",
        "city": "פתח תקווה",
        "title": "אישורי הגעה לאירועים בפתח תקווה",
        "desc": "אישורי הגעה בוואטסאפ לאירועים בפתח תקווה: הזמנות, תזכורות ומעקב חי של כמה מגיעים. מ-50 ₪ לאירוע.",
        "intro": "בין גני האירועים בכפר סירקין לאולמות על ז'בוטינסקי, אירוע בפתח תקווה אוסף אורחים מכל גוש דן. הרשימות האלה מלאות במספרים ישנים ובאורחים שעונים רק אחרי תזכורת שנייה, ובדיוק בשביל זה יש גלי שליחה אוטומטיים ומעקב שמראה בכל רגע מי נשאר פתוח.",
        "faqcity": "מספר שכבר לא פעיל או שגוי מסומן בדשבורד ככישלון שליחה, כך שאפשר לתקן אותו ולשלוח שוב במקום לגלות ביום האירוע.",
    },
    {
        "slug": "netanya",
        "city": "נתניה",
        "title": "אישורי הגעה לאירועים בנתניה",
        "desc": "אישורי הגעה בוואטסאפ לחתונות ואירועים בנתניה והשרון: שליחה, תזכורות ומעקב חי. מ-50 ₪ לאירוע.",
        "intro": "אולמות החוף של נתניה מושכים אורחים מכל הארץ, וגם משפחה וחברים מחו\"ל. ההזמנות שלנו יוצאות בוואטסאפ ומגיעות לכל מספר, גם בינלאומי, והאורח עונה באותה לחיצה מכל מקום בעולם. בלי SMS שלא נפתח ובלי שיחות באמצע היום.",
        "faqcity": "אורחים עם מספר חו\"ל מקבלים את אותה הודעה בדיוק, כל עוד יש להם וואטסאפ. את המספר מזינים עם קידומת המדינה וזהו.",
    },
    {
        "slug": "beer-sheva",
        "city": "באר שבע",
        "title": "אישורי הגעה לאירועים בבאר שבע והדרום",
        "desc": "אישורי הגעה בוואטסאפ לאירועים בבאר שבע והדרום: הזמנות, תזכורות ומעקב חי של מגיעים. מ-50 ₪ לאירוע.",
        "intro": "אנחנו בעצמנו מהדרום, אז אירועים בבאר שבע, בדימונה ובכל הנגב קרובים לליבנו במיוחד. המרחקים בדרום עושים את אישורי ההגעה קריטיים: כשאורח צריך לנסוע שעה וחצי, לדעת מראש אם הוא מגיע חוסך שולחנות ריקים ומנות שנזרקות.",
        "faqcity": "התמיכה שלנו בוואטסאפ עונה גם בערב, ולאירועים בדרום אנחנו תמיד זמינים לשיחת הכנה קצרה לפני השליחה הראשונה.",
    },
    {
        "slug": "ramat-gan",
        "city": "רמת גן",
        "title": "אישורי הגעה לאירועים ברמת גן וגבעתיים",
        "desc": "אישורי הגעה בוואטסאפ לאירועים ברמת גן וגבעתיים: שליחת הזמנות, תזכורות ומעקב חי. מ-50 ₪ לאירוע.",
        "intro": "מגני האירועים ליד הספארי ועד אולמות הבורסה, רמת גן מארחת כמה מהאירועים הצפופים ביומן של גוש דן. כשהאולם מבקש מספר סופי והמשפחה עוד מתלבטת, דשבורד חי עם מספר סועדים מעודכן הוא ההבדל בין ניחוש להזמנה מדויקת.",
        "faqcity": "בדשבורד רואים בכל רגע כמה אישרו, כמה סירבו וכמה עוד פתוחים, כולל חיתוך של סועדים בפועל לסגירה מול האולם.",
    },
]

COMMON_FAQ = [
    ("איך מתחילים?", "בוחרים חבילה באתר, משלמים, ומיד מקבלים בוואטסאפ קישור אישי להעלאת רשימת המוזמנים ולהגדרת האירוע. משם הכל אוטומטי."),
    ("המחיר חד פעמי?", "כן. משלמים פעם אחת לאירוע לפי כמות המוזמנים, בלי מנוי ובלי הפתעות."),
]

def faq_for(p):
    items = list(p.get("faq") or [])
    if p.get("faqcity"):
        items.insert(0, ("מה חשוב לדעת לאירוע ב" + p["city"] + "?", p["faqcity"]))
    items += COMMON_FAQ
    return items

TEMPLATE = """<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · ishur.io</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="https://ishur.io/{slug}.html">
<link rel="icon" type="image/png" sizes="128x128" href="assets/favicon.png">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="https://ishur.io/{slug}.html">
<meta property="og:type" content="website">
<meta property="og:locale" content="he_IL">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@700&family=Heebo:wght@400;600;700&display=swap" rel="stylesheet">
<script type="application/ld+json">{jsonld}</script>
<style>
  :root{{--pine:#0F2E22;--navy:#16233A;--green:#0F4C35;--gold:#A8853C;--gold-soft:#C7AE7A;
    --ink:#1B2420;--ink2:#4A554E;--bg:#F8F4EA;--card:#fff;--line:#E3E1D8}}
  *{{margin:0;padding:0;box-sizing:border-box}}
  body{{font-family:'Heebo',system-ui,sans-serif;background:var(--bg);color:var(--ink);direction:rtl;line-height:1.75}}
  .top{{background:radial-gradient(130% 140% at 50% -30%,#17402F 0%,var(--pine) 60%,#0A2119 100%);color:#F8F4EA;padding:2.2rem 1rem 2.6rem;text-align:center;border-bottom:1px solid rgba(199,174,122,.3)}}
  .brand{{font-family:'Frank Ruhl Libre',serif;font-size:1rem;margin-bottom:1rem}}
  .brand a{{color:#F8F4EA;text-decoration:none}}
  .brand span{{color:var(--gold-soft)}}
  h1{{font-family:'Frank Ruhl Libre',serif;font-size:clamp(1.6rem,5vw,2.3rem);max-width:22ch;margin:0 auto;text-wrap:balance}}
  .sub{{color:rgba(248,244,234,.75);margin-top:.6rem;font-size:1rem}}
  .cta{{display:inline-block;margin-top:1.4rem;background:linear-gradient(135deg,var(--gold),#8A6D2F);color:#fff;font-weight:700;padding:.8rem 2.2rem;border-radius:99px;text-decoration:none;font-size:1.05rem}}
  .cta:hover{{filter:brightness(1.07)}}
  .wrap{{max-width:680px;margin:0 auto;padding:0 1.2rem 4rem}}
  .intro{{font-size:1.02rem;color:var(--ink2);margin:2rem 0 0}}
  h2{{font-family:'Frank Ruhl Libre',serif;color:var(--green);font-size:1.25rem;margin:2.2rem 0 .8rem;padding-bottom:.35rem;border-bottom:1px solid var(--gold-soft)}}
  .steps{{counter-reset:s;list-style:none}}
  .steps li{{counter-increment:s;position:relative;padding:.45rem 2.4rem .45rem 0;color:var(--ink2)}}
  .steps li::before{{content:counter(s);position:absolute;right:0;top:.65rem;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--pine);color:var(--gold-soft);font-size:.8rem;font-weight:700;display:flex;align-items:center;justify-content:center}}
  .faq{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.4rem 1.2rem;margin-top:.6rem}}
  .faq details{{border-bottom:1px solid var(--line);padding:.7rem 0}}
  .faq details:last-child{{border-bottom:none}}
  .faq summary{{font-weight:600;cursor:pointer;list-style:none}}
  .faq summary::-webkit-details-marker{{display:none}}
  .faq p{{color:var(--ink2);font-size:.92rem;margin-top:.45rem}}
  .price{{background:rgba(15,76,53,.06);border:1px solid rgba(15,76,53,.3);border-radius:14px;padding:1rem 1.2rem;margin-top:2rem;text-align:center}}
  .price b{{color:var(--green);font-size:1.15rem}}
  .bottom-cta{{text-align:center;margin-top:2.2rem}}
  footer{{background:#0A2119;color:rgba(248,244,234,.6);text-align:center;padding:1.4rem 1rem;font-size:.75rem}}
  footer a{{color:var(--gold-soft);text-decoration:none;margin:0 .5rem}}
</style>
</head>
<body>
<header class="top">
  <div class="brand"><a href="https://ishur.io/">אישורי <span>הגעה</span> · ishur.io</a></div>
  <h1>{h1}</h1>
  <p class="sub">שליחה בוואטסאפ · אישור בלחיצה · מעקב חי של כמה מגיעים</p>
  <a class="cta" href="https://ishur.io/?utm_source=seo&utm_medium=organic&utm_campaign={slug}">להתחלה מ-50 ₪</a>
</header>
<div class="wrap">
  <p class="intro">{intro}</p>

  <h2>איך זה עובד</h2>
  <ol class="steps">
    <li>בוחרים חבילה ומשלמים באתר. תוך דקה מגיע אליכם בוואטסאפ קישור אישי.</li>
    <li>מעלים את רשימת המוזמנים (אקסל או גוגל-שיטס) ובוחרים תאריכי שליחה.</li>
    <li>ההזמנות יוצאות בוואטסאפ, כל אורח מאשר בלחיצה ועונה כמה תהיו.</li>
    <li>מי שלא ענה מקבל תזכורות אוטומטיות, ואתם רואים הכל בדשבורד חי.</li>
  </ol>

  <h2>שאלות נפוצות</h2>
  <div class="faq">
{faq_html}
  </div>

  <div class="price"><b>מ-50 ₪ לאירוע, תשלום חד פעמי.</b><br>המחיר לפי כמות מוזמנים. בלי מנוי, בלי אותיות קטנות.</div>
  <div class="bottom-cta"><a class="cta" href="https://ishur.io/?utm_source=seo&utm_medium=organic&utm_campaign={slug}">לבחירת חבילה באתר</a></div>
</div>
<footer>
  <a href="https://ishur.io/">דף הבית</a> · <a href="faq.html">שאלות נפוצות</a> · <a href="terms.html">תנאי שימוש</a><br>
  © 2026 אישורי הגעה · ishur.io · עוסק מורשה 322414905
</footer>
</body>
</html>
"""

def build(p):
    faqs = faq_for(p)
    faq_html = "\n".join(
        '    <details{}>\n      <summary>{}</summary>\n      <p>{}</p>\n    </details>'.format(
            " open" if i == 0 else "", html.escape(q), html.escape(a))
        for i, (q, a) in enumerate(faqs))
    jsonld = json.dumps([
        {
            "@context": "https://schema.org", "@type": "Service",
            "name": p["title"], "description": p["desc"],
            "provider": {"@type": "LocalBusiness", "name": "ishur.io · אישורי הגעה",
                          "url": "https://ishur.io", "vatID": "322414905"},
            "areaServed": p.get("city", "ישראל"),
            "offers": {"@type": "Offer", "priceCurrency": "ILS", "price": "50",
                        "description": "מחיר פתיחה לאירוע, לפי כמות מוזמנים"},
        },
        {
            "@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": q,
                             "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs],
        },
    ], ensure_ascii=False)
    page = TEMPLATE.format(title=p["title"], desc=p["desc"], slug=p["slug"],
                           h1=p["h1"] if "h1" in p else p["title"], intro=p["intro"],
                           faq_html=faq_html, jsonld=jsonld)
    with open(p["slug"] + ".html", "w", encoding="utf-8") as f:
        f.write(page)
    return p["slug"] + ".html"

if __name__ == "__main__":
    for p in PAGES:
        print("wrote", build(p))
