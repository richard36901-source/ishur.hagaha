/* ishur client app · help centre (spec R19). For clients who are not technical: one idea per screen, large text,
   a small moving picture that shows where to touch, "הבא" to go on, "להראות שוב" to replay, and WhatsApp at the end.
   To add or change an explanation, edit TOPICS below: each step is { text, scene }. Scenes are drawn by SCENES. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var App = window.IshurApp || {}, ENV = window.ISHUR_ENV || {};

  var TOPICS = [
    { title: 'מה המספרים אומרים', steps: [
      { text: 'המספר הגדול למעלה הוא כמה אנשים מגיעים לאירוע.', scene: ['count', '86', 'מגיעים'] },
      { text: 'מתחתיו רואים כמה אישרו, כמה לא בטוחים, כמה עוד לא ענו וכמה לא מגיעים.', scene: ['tiles', 'אישרו', 'לא בטוחים', 'לא ענו', 'לא מגיעים'] },
      { text: 'נגיעה במספר פותחת את רשימת האנשים שמאחוריו.', scene: ['tap', 'לא ענו', '12'] } ] },
    { title: 'איך מוסיפים מוזמן', steps: [
      { text: 'בלשונית "ראשי" גוללים למטה עד "הוספת מוזמן".', scene: ['scroll', 'הוספת מוזמן'] },
      { text: 'כותבים את השם ואת מספר הטלפון של המוזמן.', scene: ['type', 'שם', 'טלפון'] },
      { text: 'נוגעים ב"הוספה". המוזמן נכנס לרשימה ויקבל הזמנה בשליחה הבאה.', scene: ['tap', 'הוספה', ''] } ] },
    { title: 'איך משנים תאריך שליחה', steps: [
      { text: 'בלשונית "ראשי" גוללים עד "לוח השליחות".', scene: ['scroll', 'לוח השליחות'] },
      { text: 'ליד השליחה שרוצים להזיז נוגעים ב"שינוי תאריך".', scene: ['tap', 'שינוי תאריך', ''] },
      { text: 'בוחרים יום חדש. אפשר לשנות עד השעה 06:00 בבוקר של יום השליחה.', scene: ['calendar'] } ] },
    { title: 'מה זה "נכשלו" ומה עושים', steps: [
      { text: '"נכשלו" הם מוזמנים שההזמנה לא הגיעה לטלפון שלהם.', scene: ['row', 'דנה כהן', 'לא נמסר'] },
      { text: 'ליד כל שם כתובה הסיבה: אין וואטסאפ במספר, או שההודעה לא נמסרה.', scene: ['row', 'יוסי לוי', 'אין וואטסאפ'] },
      { text: 'בודקים שהמספר נכון. אם הוא נכון, שולחים להם את קישור אישור ההגעה מהטלפון שלכם.', scene: ['share'] } ] },
    { title: 'איך משתפים קישור אישור הגעה', steps: [
      { text: 'יש קישור אחד שכל מוזמן יכול לאשר דרכו הגעה, גם מי שלא קיבל הזמנה.', scene: ['share'] },
      { text: 'נוגעים ב"שיתוף קישור אישור ההגעה" ובוחרים וואטסאפ או כל אפליקציה אחרת.', scene: ['tap', 'שיתוף קישור', ''] } ] }
  ];

  var el = function (cls, text) { var d = document.createElement('div'); d.className = cls; if (text != null) d.textContent = text; return d; };
  var SCENES = {
    count: function (s, a) { var b = el('sc-big', a[1]); s.appendChild(b); s.appendChild(el('sc-cap', a[2])); },
    tiles: function (s, a) { var g = el('sc-grid'); a.slice(1).forEach(function (t, i) { var c = el('sc-tile lit', ''); c.style.animationDelay = (i * 0.7) + 's'; c.appendChild(el('sc-n', String([48, 9, 12, 7][i]))); c.appendChild(el('sc-l', t)); g.appendChild(c); }); s.appendChild(g); },
    tap: function (s, a) { var c = el('sc-tile wide target'); if (a[2]) c.appendChild(el('sc-n', a[2])); c.appendChild(el('sc-l', a[1])); s.appendChild(c); s.appendChild(el('sc-finger')); },
    scroll: function (s, a) { var w = el('sc-page'); w.appendChild(el('sc-line')); w.appendChild(el('sc-line short')); w.appendChild(el('sc-line')); w.appendChild(el('sc-goal', a[1])); s.appendChild(w); s.appendChild(el('sc-finger swipe')); },
    type: function (s, a) { a.slice(1).forEach(function (t, i) { var f = el('sc-field'); f.appendChild(el('sc-ph', t)); var ink = el('sc-ink'); ink.style.animationDelay = (i * 1.1) + 's'; f.appendChild(ink); s.appendChild(f); }); },
    calendar: function (s) { var g = el('sc-cal'); for (var i = 0; i < 14; i++) g.appendChild(el('sc-day' + (i === 9 ? ' pick' : ''), String(i + 14))); s.appendChild(g); },
    row: function (s, a) { var r = el('sc-row'); r.appendChild(el('sc-name', a[1])); r.appendChild(el('sc-pill', a[2])); s.appendChild(r); },
    share: function (s) { var c = el('sc-link', 'קישור אישור הגעה'); s.appendChild(c); var w = el('sc-apps'); ['וואטסאפ', 'הודעות', 'העתקה'].forEach(function (t, i) { var b = el('sc-app', t); b.style.animationDelay = (0.4 + i * 0.25) + 's'; w.appendChild(b); }); s.appendChild(w); }
  };

  var topic = null, step = 0;
  function draw() {
    var st = topic.steps[step], last = step === topic.steps.length - 1;
    $('helpText').textContent = st.text;
    var sc = $('helpScene'); sc.textContent = ''; sc.className = 'scene sc-' + st.scene[0];
    (SCENES[st.scene[0]] || function () {})(sc, st.scene);
    $('helpDots').innerHTML = topic.steps.map(function (_, i) { return '<i' + (i === step ? ' class="on"' : '') + '></i>'; }).join('');
    $('helpNext').hidden = last; $('helpReplay').hidden = !last; $('helpWa').hidden = !last;
  }
  var T = function (n, p) { if (window.IshurTrack) window.IshurTrack.track(n, p); };
  function openTopic(i) {
    topic = TOPICS[i]; step = 0; T('help_topic', { topic: i });
    $('helpTopics').hidden = true; $('helpPlayer').hidden = false; $('helpBack').hidden = false;
    $('helpPlayer').setAttribute('data-steps', topic.steps.length); $('helpTitle').textContent = topic.title; draw();
  }
  function list() { topic = null; $('helpTopics').hidden = false; $('helpPlayer').hidden = true; $('helpBack').hidden = true; $('helpTitle').textContent = 'עזרה והסברים'; }
  function open(i) { $('help').hidden = false; if (typeof i === 'number') openTopic(i); else list(); }

  $('helpTopics').innerHTML = TOPICS.map(function (t, i) { return '<button type="button" class="row nav" data-i="' + i + '"><span class="nm">' + t.title + '</span></button>'; }).join('');
  $('helpTopics').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) openTopic(Number(b.getAttribute('data-i'))); });
  $('helpNext').addEventListener('click', function () { if (step < topic.steps.length - 1) { step++; draw(); if (step === topic.steps.length - 1) T('help_done', { topic: TOPICS.indexOf(topic) }); } });
  $('helpReplay').addEventListener('click', function () { step = 0; draw(); });
  $('helpBack').addEventListener('click', list);
  $('helpClose').addEventListener('click', function () { $('help').hidden = true; });
  $('helpOpen').addEventListener('click', function () { T('help_open'); open(); });
  $('helpWa').addEventListener('click', function (e) {
    e.preventDefault();
    var url = 'https://wa.me/' + ENV.whatsapp + '?text=' + encodeURIComponent('היי, צריך/ה עזרה באפליקציה: ' + (topic ? topic.title : ''));
    var b = App.plugin && App.plugin('Browser'); if (b) b.open({ url: url }); else window.open(url, '_blank', 'noopener');
  });
  window.IshurHelp = { open: open, topics: TOPICS };
})();
