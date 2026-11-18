/* ishur.io · sales playbook (01/11): script, branches, objections, notes and
   quick pay links. One KV blob (/api/playbook). Mounted on leads.html.
   Usage: IshurPlaybook.mount(containerId, adminKey)
   16/11: the script reads as ONE document. The saved blob keeps its shape
   (script / branches / objections / close / notes / links); the document is
   drawn from it by pbDoc(): `****` splits the script into stages, a first line
   `# title` names a stage, a blank line separates cases and objections,
   `"what they say" → answer` is an objection, `label: text` is a case. Text
   that fits no rule is shown as written, nothing is dropped. Editing (the
   same four textareas + notes) sits behind the "עריכה" button.
   Bar contract (next/assets/adminbar.js): `.plg-card` and the h2 right before
   it are the pay-link part, every other direct child of the host is the script. */
(function () {
  var CFG = window.ISHUR_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var BASE = CFG.endpoint('status').replace(/\/api\/status$/, '');
  var adminKey = '';
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var CSS = [
    '.pbwrap [hidden]{display:none!important}',
    /* the document */
    '.pbd{color:var(--ink,#1B2620);margin:0 0 1.8rem}',
    '.pbd-top{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin:0 0 .9rem}',
    '.pbd-h{font-family:"Frank Ruhl Libre",serif;font-size:1.45rem;line-height:1.2;color:var(--pine,#0F4C35);margin:0;letter-spacing:-.01em}',
    '.pbd-i{font:inherit;font-family:Georgia,serif;font-style:italic;font-weight:700;font-size:.95rem;width:32px;height:32px;display:inline-grid;place-items:center;border:1px solid var(--line,#E1E4DE);border-radius:8px;background:var(--card,#fff);color:var(--ink2,#4E5C55);cursor:pointer}',
    '.pbd-i[aria-expanded=true]{border-color:var(--pine,#0F4C35);color:var(--pine,#0F4C35)}',
    '.pbd-sp{flex:1}',
    '.pbwrap .state{font-size:.78rem;color:var(--ink3,#7F8C86)}',
    '.pbwrap .state.dirty{color:var(--warn,#A8402F);font-weight:600}',
    '.pbwrap .state.saved{color:var(--good,#2E7D5B);font-weight:600}',
    '.pbwrap .sbtn{font:inherit;font-size:.8rem;font-weight:600;min-height:32px;padding:.3rem .8rem;border-radius:8px;border:1px solid var(--line,#E1E4DE);background:var(--card,#fff);color:var(--ink,#1B2620);cursor:pointer;white-space:nowrap}',
    '.pbwrap .sbtn.p{background:var(--pine,#0F4C35);border-color:var(--pine,#0F4C35);color:var(--card,#fff)}',
    '.pbwrap .sbtn.d{color:var(--warn,#A8402F)}',
    '.pbd button:focus-visible,.pbd a:focus-visible{outline:2px solid var(--pine,#0F4C35);outline-offset:2px}',
    '.pbd-info{background:var(--card,#fff);border:1px solid var(--line,#E1E4DE);border-radius:8px;padding:.8rem 1rem;max-width:68ch;margin:0 0 1rem;font-size:.92rem;line-height:1.6;color:var(--ink2,#4E5C55)}',
    '.pbd-info ul{margin:0;padding-inline-start:1.1rem}.pbd-info li{margin:.15rem 0}.pbd-info code{font-family:ui-monospace,Menlo,monospace;font-size:.88em;background:var(--line2,#EEF0EB);border-radius:4px;padding:0 .25rem;direction:ltr;unicode-bidi:isolate}',
    '.pbd-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem}',
    '.pbd-idx{background:var(--card,#fff);border:1px solid var(--line,#E1E4DE);border-radius:8px;padding:.75rem .8rem;font-size:.9rem;line-height:1.4}',
    '.pbd-idx p{margin:0 0 .3rem;font-size:.74rem;font-weight:600;color:var(--ink3,#7F8C86)}',
    '.pbd-idx ol+p{margin-top:.8rem}',
    '.pbd-idx ol{list-style:none;margin:0;padding:0}',
    '.pbd-idx a{display:flex;gap:.45rem;padding:.38rem .5rem;border-radius:6px;color:var(--ink2,#4E5C55);text-decoration:none}',
    '.pbd-idx a b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink3,#7F8C86);min-width:1ch}',
    '.pbd-idx a:hover{background:var(--line2,#EEF0EB)}',
    '.pbd-idx a[aria-current]{background:var(--pine-s,#E7F0EB);color:var(--ink,#1B2620);font-weight:600}',
    '.pbd-idx a[aria-current] b{color:var(--pine,#0F4C35)}',
    '.pbd-doc{font-size:1.0625rem;line-height:1.7;max-width:68ch;min-width:0;overflow-wrap:anywhere}',
    '.pbd-st{padding:1.1rem 0 1.2rem;padding-inline-start:.9rem;border-top:1px solid var(--line,#E1E4DE);border-inline-start:3px solid transparent;scroll-margin-top:6.8rem;transition:border-color .2s}',
    '.pbd-st:first-child{border-top:0;padding-top:.2rem}',
    '.pbd-st.on{border-inline-start-color:var(--gold,#B4884A)}',
    '.pbd-st h3{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:0 0 .5rem;font-size:1.15rem;line-height:1.35}',
    '.pbd-st h3 small,.pbd-grp h4 small{font-size:.78rem;font-weight:500;color:var(--ink3,#7F8C86)}',
    '.pbd-n{display:inline-grid;place-items:center;min-width:1.75rem;height:1.75rem;padding:0 .3rem;border-radius:6px;background:var(--pine,#0F4C35);color:var(--card,#fff);font-size:.88rem;font-weight:700;font-variant-numeric:tabular-nums;align-self:center}',
    '.pbd-tag{font-size:.72rem;font-weight:600;color:var(--ink3,#7F8C86)}',
    /* what to say */
    '.pbd-say{background:var(--pine-s,#E7F0EB);border-inline-start:4px solid var(--pine,#0F4C35);border-radius:8px;padding:.55rem .9rem .8rem;margin:.6rem 0}',
    '.pbd-say-h{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin:0 0 .2rem}',
    '.pbd-say blockquote{margin:0;font-size:1.1rem;font-weight:500;white-space:pre-line}',
    '.pbd-copy{font:inherit;font-size:.76rem;font-weight:600;min-height:32px;padding:.2rem .75rem;border:1px solid var(--line,#E1E4DE);border-radius:8px;background:var(--card,#fff);color:var(--ink,#1B2620);cursor:pointer}',
    '.pbd-copy.done{border-color:var(--good,#2E7D5B);color:var(--good,#2E7D5B)}',
    '.pbd-note{margin:.5rem 0;font-size:.95rem;color:var(--ink2,#4E5C55);white-space:pre-line}',
    '.pbd-do{margin:.35rem 0;white-space:pre-line}',
    '.pbd-my{background:rgba(180,136,74,.12);border:1px solid rgba(180,136,74,.45);border-radius:8px;padding:.5rem .8rem;margin:.8rem 0 0;font-size:.95rem;white-space:pre-line}',
    '.pbd-my .pbd-tag{display:block;color:var(--gold,#B4884A)}',
    /* a split in the conversation: indented blocks hanging off one line */
    '.pbd-brs{margin:.7rem 0 .2rem;margin-inline-start:.6rem;border-inline-start:2px solid var(--gold,#B4884A)}',
    '.pbd-br{position:relative;padding:.2rem 0 .9rem;padding-inline-start:1.5rem;scroll-margin-top:6.8rem}',
    '.pbd-br:last-child{padding-bottom:.2rem}',
    '.pbd-br::before{content:"";position:absolute;inset-inline-start:0;top:1.1rem;width:1.05rem;border-top:2px solid var(--gold,#B4884A)}',
    '.pbd-br.hit>.pbd-if{color:var(--pine,#0F4C35)}',
    '.pbd-if{margin:0;font-weight:600;display:flex;flex-direction:column}',
    '.pbd-go{display:inline-block;margin-top:.15rem;padding:.25rem 0;font-size:.85rem;font-weight:600;color:var(--pine,#0F4C35);text-decoration:underline;text-underline-offset:3px}',
    '.pbd-grp{margin:1.1rem 0;scroll-margin-top:6.8rem}',
    '.pbd-grp h4{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:0;font-size:1rem}',
    '.pbd-empty{color:var(--ink3,#7F8C86);font-size:.95rem}',
    /* editing */
    '.pbd-edit{border:1px solid var(--line,#E1E4DE);border-radius:8px;background:var(--card,#fff);padding:.9rem;margin:0 0 1.2rem}',
    '.pbd-edit .pb{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:.9rem}',
    '.pbd-edit .pbcard{display:flex;flex-direction:column;gap:.4rem;min-width:0}',
    '.pbd-edit .pbcard h3{margin:0;font-size:.92rem}',
    '.pbwrap textarea{width:100%;min-height:11rem;font:inherit;font-size:.92rem;line-height:1.6;padding:.6rem .7rem;border:1px solid var(--line,#E1E4DE);border-radius:8px;background:var(--paper,#FBFAF7);color:var(--ink,#1B2620);resize:vertical}',
    '.pbwrap textarea.note{min-height:3.6rem;background:rgba(180,136,74,.12);border-color:rgba(180,136,74,.45)}',
    '.pbwrap textarea:focus{outline:none;border-color:var(--gold,#B4884A)}',
    '.pbwrap .pbbar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:.7rem 0 0}',
    '@media (min-width:920px){.pbd-grid{grid-template-columns:15rem minmax(0,68ch);gap:2.4rem;align-items:start}.pbd-idx{position:sticky;top:6.8rem;max-height:calc(100vh - 8rem);overflow:auto}}',
    '@media (max-width:600px){.pbd-st{padding-inline-start:.6rem}.pbd-br{padding-inline-start:1.2rem}.pbd-br::before{width:.8rem}}',
    '@media (pointer:coarse){.pbd-i,.pbd-copy,.pbd .sbtn{min-height:40px}.pbd-i{width:40px}}',
    '@media (prefers-reduced-motion:reduce){.pbd-st{transition:none}}',
    /* the pay-link heading: its display lives here, not in a style attribute, so the bar's rule can hide it in the script view */
    '.pbwrap>h2.pb-plh{margin-top:1.4rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}',
    /* saved pay links (unchanged, live inside .plg-card) */
    '.pbwrap .links{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:.6rem;margin-top:.5rem}',
    '.pbwrap .lk{background:var(--card);border:1px solid var(--line);border-inline-start:5px solid var(--gold);border-radius:8px;padding:.7rem .85rem;display:flex;flex-direction:column;gap:.35rem}',
    '.pbwrap .lk .t{font-weight:600;font-size:.92rem;display:flex;justify-content:space-between;gap:.5rem}',
    '.pbwrap .lk .t b{color:var(--pine);font-variant-numeric:tabular-nums}',
    'html[data-theme=dark] .pbwrap .lk .t b{color:var(--gold-soft)}',
    '.pbwrap .lk .d{font-size:.76rem;color:var(--ink2)}',
    '.pbwrap .lk .u{font-size:.7rem;color:var(--ink3);direction:ltr;text-align:left;word-break:break-all}',
    '.pbwrap .lk .row{display:flex;gap:.4rem;flex-wrap:wrap}',
    '.pbwrap .lk input{font:inherit;font-size:.78rem;padding:.25rem .45rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:0}',
    '.pbwrap .lk input.n{flex:2}.pbwrap .lk input.s{width:5.2rem}.pbwrap .lk input.g{width:4.5rem}.pbwrap .lk input.h{width:3.2rem}',
    '.pbwrap .lk .lbl{font-size:.68rem;color:var(--ink3)}',
    /* paper: the document only. No bar, no pay-link card, no buttons */
    '@media print{.ibar,.pbwrap .plg-card,.pbwrap h2:has(+ .plg-card),.pbd-top .sbtn,.pbd-i,.pbd-info,.pbd-edit,.pbd-copy,.pbd-idx,.pbd-go,.pbwrap .state,#pbfold>summary{display:none!important}' +
      '.pbd-grid{display:block}.pbd-doc{max-width:none;font-size:11.5pt;line-height:1.55}' +
      '.pbd-st{border-inline-start:0;padding-inline-start:0}.pbd-st h3,.pbd-grp h4,.pbd-if{break-after:avoid}.pbd-say,.pbd-br{break-inside:avoid}' +
      '.pbd-say{background:none;border:1px solid #888;border-inline-start:4px solid #000}.pbd-n{background:none;color:#000;border:1px solid #000}' +
      '.pbd-brs,.pbd-br::before{border-color:#000}}',
  ].join('\n');
  var AREAS = [
    ['script', 'פתיחה ושאלות', 'התסריט'],
    ['branches', 'התפלגות למקרים', 'מקרים'],
    ['objections', 'טיפול בהתנגדויות', 'התנגדויות'],
    ['close', 'סגירה ואחרי השיחה', 'סגירה'],
  ];
  var HTML = '<div class="pbd">' +
    '<div class="pbd-top"><h2 class="pbd-h">תסריט שיחה</h2>' +
      '<button type="button" class="pbd-i" id="pb-info-btn" aria-label="איך משתמשים בעמוד" aria-expanded="false" aria-controls="pb-info">i</button>' +
      '<span class="pbd-sp"></span><span class="state" id="pb-state">טוען…</span>' +
      '<button type="button" class="sbtn" id="pb-edit-btn" aria-expanded="false" aria-controls="pb-edit">עריכה</button>' +
      '<button type="button" class="sbtn" id="pb-print">הדפסה</button></div>' +
    '<div class="pbd-info" id="pb-info" hidden><ul>' +
      '<li>קוראים מלמעלה למטה, שלב אחרי שלב. במקום שהשיחה מתפצלת יש בלוקים מוזחים עם קו, ובסוף כל אחד כתוב לאן ממשיכים.</li>' +
      '<li>הרשימה בצד קופצת לכל שלב ולכל התנגדות. השלב שקוראים עכשיו מסומן.</li>' +
      '<li>"העתקה" מעתיקה את הנוסח שאומרים, בלי המירכאות.</li>' +
      '<li>"עריכה" פותחת את הטקסט. שורה של <code>****</code> מפרידה בין שלבים, שורה ראשונה שמתחילה ב-<code>#</code> היא שם השלב, שורה ריקה מפרידה בין מקרים ובין התנגדויות.</li>' +
      '<li>התנגדות כותבים: "מה אומרים" ואז חץ ואז התשובה. מקרה כותבים: שם המקרה, נקודתיים, ומה אומרים. נוסח בתוך מירכאות מקבל כפתור העתקה.</li>' +
      '<li>השמירה נשארת לתמיד, והקישורים השמורים נשמרים יחד עם התסריט.</li>' +
    '</ul></div>' +
    '<div class="pbd-edit" id="pb-edit" hidden><div class="pb">' +
      AREAS.map(function (a) {
        return '<div class="pbcard"><h3><label for="pb-' + a[0] + '">' + a[1] + '</label></h3>' +
          '<textarea id="pb-' + a[0] + '" placeholder="' + a[2] + '"></textarea>' +
          '<textarea id="pb-' + a[0] + '-note" class="note" aria-label="הערות שלי: ' + a[1] + '" placeholder="הערות שלי (מה עבד, מה לשנות)"></textarea></div>';
      }).join('') +
      '</div><div class="pbbar"><button type="button" class="sbtn p" id="pb-save">שמירה</button></div></div>' +
    '<div class="pbd-grid"><nav class="pbd-idx" id="pb-idx" aria-label="תוכן התסריט"></nav><article class="pbd-doc" id="pb-doc"></article></div>' +
    '</div>\n' +
    '  <h2 class="pb-plh">קישור תשלום <span style="font-size:.72rem;font-weight:500;color:var(--ink3)">חבילה + תוספות · המחיר מחושב בשרת · התשלום פותח אירוע ומפעיל את התוספות לבד</span></h2>\n  <div class="plg-card">\n    <div id="pl-gen"></div>\n    <div class="plg-saved"><h3>קישורים שמורים <span>מבצעים קבועים · "צור" מייצר קישור Grow חדש, "העתק" מעתיק את האחרון · נשמרים עם התשריט</span></h3>\n    <div class="links" id="pb-links"></div>\n    <div class="pbbar"><button type="button" class="sbtn" id="pb-addlink">+ מבצע חדש</button></div></div>\n  </div>\n';

/* ══ 16/11: the script as one document ═════════════════════════════════════
   pbModel(data) reads the four text fields into stages; pbDoc() draws them.
   Every piece of dynamic text goes through esc() before it reaches innerHTML;
   ids come from indexes, never from the text; the copy buttons read pbCopy[]. */
var QT = '"“”״';
var RE_ARROW = /→|->|=>/;
/* names for the stages of the script as it shipped; a stage the owner rewrote
   takes its name from a first line `# name`, or is shown by number only */
var PB_TITLES = [
  ['היי, מדבר ריצארד מאישורי הגעה.', 'פתיחה'],
  ['כמה מוזמנים בערך?', 'מספר מוזמנים'],
  ['ידוע לכם כבר מספר רשומות?', 'מספר רשומות'],
  ['הייתם רוצים חבילה עם שיחות טלפון?', 'שיחות טלפון'],
  ['לפי התשובה:', 'בחירת חבילה'],
];
function pbTrim(s) { return String(s == null ? '' : s).replace(/\r/g, '').trim(); }
function pbItems(text) { return pbTrim(text).split(/\n[ \t]*\n+/).map(pbTrim).filter(Boolean); }
/* the inner text when the WHOLE text is one quoted sentence, else null (a quote
   mark between two letters, as in an acronym, is part of the sentence) */
function pbUnq(t) {
  t = pbTrim(t);
  if (t.length < 3 || QT.indexOf(t[0]) < 0 || QT.indexOf(t[t.length - 1]) < 0) return null;
  var inner = t.slice(1, -1);
  return /["“”״]/.test(inner.replace(/(\S)["״](?=\S)/g, '$1')) ? null : pbTrim(inner);
}
function pbStage(chunk) {
  var lines = pbTrim(chunk).split('\n').map(pbTrim).filter(Boolean), st = { title: '', blocks: [] }, say = [], rows = [];
  if (lines.length && /^#+\s*\S/.test(lines[0])) st.title = lines.shift().replace(/^#+\s*/, '');
  else for (var i = 0; i < PB_TITLES.length; i++) if (chunk.indexOf(PB_TITLES[i][0]) >= 0) { st.title = PB_TITLES[i][1]; break; }
  function fs() { if (say.length) st.blocks.push({ k: 'say', t: say.join('\n') }); say = []; }
  function fr() { if (rows.length) st.blocks.push({ k: 'rows', rows: rows }); rows = []; }
  lines.forEach(function (l) {
    var a = RE_ARROW.exec(l);
    if (/^\(.*\)$/.test(l) || /[:：]$/.test(l)) { fs(); fr(); st.blocks.push({ k: 'note', t: l }); }
    else if (a && a.index > 0 && QT.indexOf(l[0]) < 0 && pbTrim(l.slice(a.index + a[0].length))) { fs(); rows.push({ cond: pbTrim(l.slice(0, a.index)), then: pbTrim(l.slice(a.index + a[0].length)) }); }
    else { fr(); say.push(l); }
  });
  fs(); fr();
  return st;
}
function pbCase(item) {
  if (pbUnq(item) != null) return { label: '', body: item };
  var m = /^([^:"“”״\n]{1,90}):\s+([\s\S]+)$/.exec(item);
  return m ? { label: pbTrim(m[1]), body: pbTrim(m[2]) } : { label: '', body: item };
}
function pbObjection(item) {
  var m = /^["“”״]([\s\S]+?)["“”״]\s*(?:→|->|=>)\s*([\s\S]+)$/.exec(item);
  if (m) return { said: pbTrim(m[1]), body: pbTrim(m[2]) };
  var a = RE_ARROW.exec(item);
  if (a && a.index > 0 && pbTrim(item.slice(a.index + a[0].length))) return { said: pbTrim(item.slice(0, a.index)), body: pbTrim(item.slice(a.index + a[0].length)) };
  return { said: '', body: item };
}
function pbModel(d) {
  d = d || {};
  var stages = pbTrim(d.script).split(/^[ \t]*\*{3,}[ \t]*$/m).map(pbTrim).filter(Boolean).map(pbStage);
  var cases = pbItems(d.branches).map(pbCase), close = pbItems(d.close).map(pbCase), lead = [];
  while (close.length && !close[0].label) lead.push(close.shift());
  return { stages: stages, cases: cases, objections: pbItems(d.objections).map(pbObjection), closeLead: lead, closeRest: close, notes: d.notes || {} };
}
var pbCopy = [], pbSpy = null;
function pbSayHtml(text) {
  var i = pbCopy.push(text) - 1;
  return '<div class="pbd-say"><div class="pbd-say-h"><span class="pbd-tag">אומרים</span><button type="button" class="pbd-copy" data-copy="' + i + '">העתקה</button></div><blockquote>' + esc(text) + '</blockquote></div>';
}
function pbBodyHtml(text) { var q = pbUnq(text); return q != null ? pbSayHtml(q) : '<p class="pbd-do">' + esc(text) + '</p>'; }
function pbGoHtml(id, label) { return id ? '<a class="pbd-go" href="#script" data-go="' + esc(id) + '">' + esc(label) + '</a>' : ''; }
function pbMyHtml(note, about) { note = pbTrim(note); return note ? '<aside class="pbd-my"><span class="pbd-tag">הערה שלי · ' + esc(about) + '</span>' + esc(note) + '</aside>' : ''; }
function pbBranchHtml(id, tag, cond, body, go) {
  return '<div class="pbd-br"' + (id ? ' id="' + esc(id) + '" tabindex="-1"' : '') + '>' +
    (cond ? '<p class="pbd-if"><span class="pbd-tag">' + esc(tag) + '</span>' + esc(cond) + '</p>' : '') + body + go + '</div>';
}
function pbDoc() {
  var doc = $('pb-doc'), idx = $('pb-idx'); if (!doc || !idx || !pbData) return;
  var m = pbModel(pbData), h = '', nav = '', n = 0;
  pbCopy = [];
  var nScript = m.stages.length;
  var casesN = m.cases.length ? nScript + 1 : 0;
  var hasClose = m.closeLead.length || m.closeRest.length || m.objections.length;
  var closeN = hasClose ? nScript + (casesN ? 2 : 1) : 0;
  var CASES_T = 'התפלגות למקרים', CLOSE_T = 'סגירה ואחרי השיחה';
  var goCases = casesN ? pbGoHtml('pb-s' + casesN, '← ממשיכים בשלב ' + casesN + ' · ' + CASES_T) : '';
  var goClose = closeN ? pbGoHtml('pb-s' + closeN, '← ממשיכים בשלב ' + closeN + ' · ' + CLOSE_T) : '';
  var backClose = closeN ? pbGoHtml('pb-s' + closeN, '← חוזרים לשלב ' + closeN + ' · ' + CLOSE_T) : '';
  function open(title, sub) {
    n++;
    nav += '<li><a href="#script" data-go="pb-s' + n + '"><b>' + n + '</b><span>' + esc(title || 'שלב ' + n) + '</span></a></li>';
    return '<section class="pbd-st" id="pb-s' + n + '" tabindex="-1"><h3><span class="pbd-n">' + n + '</span>' + esc(title || 'שלב ' + n) + (sub ? ' <small>' + esc(sub) + '</small>' : '') + '</h3>';
  }
  m.stages.forEach(function (st, i) {
    h += open(st.title, '');
    st.blocks.forEach(function (b) {
      if (b.k === 'say') h += pbSayHtml(b.t);
      else if (b.k === 'note') h += '<p class="pbd-note">' + esc(b.t) + '</p>';
      else h += '<div class="pbd-brs">' + b.rows.map(function (r) { return pbBranchHtml('', 'אם עונים', r.cond, '<p class="pbd-do">' + esc(r.then) + '</p>', goCases); }).join('') + '</div>';
    });
    if (i === nScript - 1) h += pbMyHtml(m.notes.script, 'פתיחה ושאלות');
    h += '</section>';
  });
  if (casesN) {
    h += open(CASES_T, 'לפי מה שענו') + '<div class="pbd-brs">' +
      m.cases.map(function (c, i) { return pbBranchHtml('pb-c' + i, 'מקרה', c.label, pbBodyHtml(c.body), goClose); }).join('') + '</div>' +
      pbMyHtml(m.notes.branches, 'המקרים') + '</section>';
  }
  var navObj = '';
  if (closeN) {
    h += open(CLOSE_T, 'איך מסיימים') + m.closeLead.map(function (c) { return pbBodyHtml(c.body); }).join('');
    if (m.objections.length) {
      h += '<div class="pbd-grp" id="pb-obj"><h4>אם עולה התנגדות <small>מה אומרים ומה עונים</small></h4><div class="pbd-brs">' +
        m.objections.map(function (o, i) {
          var name = o.said || o.body.split('\n')[0];
          navObj += '<li><a href="#script" data-go="pb-o' + i + '"><span>' + esc(name.length > 60 ? name.slice(0, 58) + '…' : name) + '</span></a></li>';
          return pbBranchHtml('pb-o' + i, 'הליד אומר', o.said, pbBodyHtml(o.body), backClose);
        }).join('') + '</div>' + pbMyHtml(m.notes.objections, 'ההתנגדויות') + '</div>';
    }
    if (m.closeRest.length) {
      h += '<div class="pbd-brs">' + m.closeRest.map(function (c, i) { return pbBranchHtml('pb-a' + i, 'מקרה', c.label, pbBodyHtml(c.body), ''); }).join('') + '</div>';
    }
    h += pbMyHtml(m.notes.close, 'הסגירה') + '</section>';
  }
  doc.innerHTML = h || '<p class="pbd-empty">התסריט ריק. "עריכה" פותחת את הטקסט.</p>';
  idx.innerHTML = (nav ? '<p>שלבים</p><ol>' + nav + '</ol>' : '') + (navObj ? '<p>התנגדויות</p><ol>' + navObj + '</ol>' : '');
  idx.hidden = !nav;
  pbWatch();
}
/* the stage being read: the first stage that crosses the reading band near the top */
function pbWatch() {
  if (pbSpy) { pbSpy.disconnect(); pbSpy = null; }
  if (!('IntersectionObserver' in window)) return;
  var seen = {};
  pbSpy = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { seen[e.target.id] = e.isIntersecting; });
    var cur = '';
    [].forEach.call(document.querySelectorAll('#pb-doc .pbd-st'), function (s) { if (!cur && seen[s.id]) cur = s.id; });
    if (!cur) return;
    [].forEach.call(document.querySelectorAll('#pb-doc .pbd-st'), function (s) { s.classList.toggle('on', s.id === cur); });
    [].forEach.call(document.querySelectorAll('#pb-idx a'), function (a) { if (a.dataset.go === cur) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
  }, { rootMargin: '-18% 0px -62% 0px' });
  [].forEach.call(document.querySelectorAll('#pb-doc .pbd-st'), function (s) { pbSpy.observe(s); });
}
function pbCopyText(txt, done) {
  function old() {
    var ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;opacity:0';
    document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta);
    if (ok) done(); else window.prompt('העתק:', txt);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, old); else old();
}
/* jumps stay inside the page: the top bar reads location.hash to choose the
   view, so the index must never put a stage id in the hash */
document.addEventListener('click', function (ev) {
  var t = ev.target.closest && ev.target.closest('.pbwrap [data-go], .pbwrap [data-copy]');
  if (!t) return;
  if (t.dataset.go) {
    ev.preventDefault();
    var el = $(t.dataset.go); if (!el) return;
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    try { el.focus({ preventScroll: true }); } catch (e) {}
    el.classList.add('hit'); setTimeout(function () { el.classList.remove('hit'); }, 1600);
    return;
  }
  var txt = pbCopy[Number(t.dataset.copy)]; if (txt == null) return;
  pbCopyText(txt, function () { t.textContent = 'הועתק'; t.classList.add('done'); setTimeout(function () { t.textContent = 'העתקה'; t.classList.remove('done'); }, 1500); });
});

/* ══ 01/11: sales playbook ══════════════════════════════════════════════ */
var PB_DEFAULT = {
  script: 'היי, מדבר ריצארד מאישורי הגעה. השארת פרטים בנוגע לאישורי הגעה לאירוע.\nהייתי שמח לדעת באיזה אירוע מדובר?\n****\nמזל טוב! כמה מוזמנים בערך?\n****\nידוע לכם כבר מספר רשומות? (רשומה = משפחה/זוג, לא אורח. בדרך כלל ~40% ממספר האורחים)\n****\n(אם לא יודעים להסביר)\nהבנתי, והייתם רוצים חבילה עם שיחות טלפון? שיחייגו לאורחים שלא ענו בוואטסאפ?\n****\nלפי התשובה:\nבלי שיחות → בסיס\nעם שיחות → פרימיום או הכל כלול',
  branches: 'בלי שיחות (בסיס): "אז הכי מתאים לכם בסיס – הזמנה בוואטסאפ עם כפתורים, תזכורות, ודשבורד חי. עד X רשומות זה ₪Y."\n\nעם שיחות, אירוע עד 300 רשומות (פרימיום): "פרימיום – כל מה שבבסיס, ועוד שיר מתקשרת לכל מי שלא ענה. עד X רשומות ₪Y."\n\nעם שיחות, אירוע גדול / רוצים שקט מוחלט (הכל כלול): "הכל כלול – גם שיחות, גם תזכורת יום לפני, גם דוח מסודר למקום. עד X רשומות ₪Y."\n\nחתונה גדולה ששואלים על דיילות: מבצע 1990 – הכל כלול + 2 דיילות (הקישור למטה).\n\nעדיין לא יודעים תאריך/מקום: "אין בעיה, משלמים עכשיו ומעלים רשימה כשנוח, השליחה יוצאת רק כשאתם מאשרים."\n\nאירוע בעוד פחות משבוע: לבדוק שיש רשימה מוכנה; לשלוח קישור העלאה מיד אחרי התשלום.',
  objections: '"יקר לי" → "תחשבו כמה עולה מנה אחת באולם. אם חסכנו לכם 5 מנות על אנשים שלא הגיעו, זה כבר החזיר את עצמו פי כמה."\n\n"נעשה את זה לבד בוואטסאפ" → "אפשר, רק שהרוב לא עונים להודעה רגילה. אצלנו יש כפתור, תזכורות, ושיחה למי שלא ענה – ואתם רואים הכל בטבלה אחת במקום לרדוף אחרי אנשים."\n\n"האורחים לא יענו לבוט" → "ההודעה יוצאת בשמכם עם ההזמנה שלכם, לא נראית כמו בוט. ואת מי שלא ענה שיר מתקשרת אליו – בעברית, בשיחה אנושית."\n\n"אני צריך לחשוב / לדבר עם בן/בת הזוג" → "ברור. אני שולח לכם עכשיו סיכום בוואטסאפ עם הקישור, ואם יש שאלה אני פה. מתי נוח שאחזור?"\n\n"יש לנו כבר מישהו שעושה את זה / המקום מציע" → "מעולה, תשאלו אותם אם זה כולל שיחות למי שלא ענה ודוח סועדים למקום. אצלנו זה בפנים."\n\n"מה עם פרטיות של האורחים?" → "הרשימה משמשת רק לאירוע שלכם, לא נשלח להם שום דבר אחר, ואחרי האירוע אפשר למחוק."\n\n"אפשר הנחה?" → לא להוריד מחיר – להוסיף ערך: "+50 רשומות חינם" או "שליחה נוספת חינם" (יש בלוח הלקוחות).',
  close: '"אז מה שמתאים לכם זה [חבילה] עד [X] רשומות ב-₪[Y]. אני שולח לכם עכשיו קישור לתשלום בוואטסאפ, ומיד אחרי זה קישור להעלאת הרשימה. לוקח 5 דקות."\n\nאחרי שסגרו: לוודא שהתשלום נכנס ללוח הלקוחות → לשלוח קישור העלאה (כפתור בלוח הלקוחות) → לקבוע תאריך שליחה.\n\nלא סגרו: לעדכן סטטוס בלוח הלידים + מעקב לעוד 2 ימים.',
  notes: {},
  links: [
    { name: 'מבצע 1990 · הכל כלול + 2 דיילות', sum: 1990, tier: 800, plan: 'premium', hostess: 2, url: '' },
    { name: 'מבצע 1790 · הכל כלול + דיילת אחת', sum: 1790, tier: 500, plan: 'premium', hostess: 1, url: '' },
  ],
};
var pbData = null, pbDirty = false, pbDocT = 0;
var PB_FIELDS = ['script', 'branches', 'objections', 'close'];
function pbApi(body) {
  var payload = Object.assign({ admin_key: adminKey }, body || {});
  return fetch(BASE + '/api/playbook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(window.IshurGuard ? IshurGuard.stamp(payload) : payload) }).then(function (r) { return r.json(); });
}
function pbState(txt, cls) { var el = $('pb-state'); if (!el) return; el.textContent = txt; el.className = 'state ' + (cls || ''); }
function pbRender() {
  if (!pbData) return;
  PB_FIELDS.forEach(function (k) {
    var ta = $('pb-' + k), nt = $('pb-' + k + '-note');
    if (ta && document.activeElement !== ta) ta.value = pbData[k] || '';
    if (nt && document.activeElement !== nt) nt.value = (pbData.notes || {})[k] || '';
  });
  pbRenderLinks();
  pbDoc();
}
function pbCollect() {
  PB_FIELDS.forEach(function (k) {
    pbData[k] = $('pb-' + k).value;
    pbData.notes = pbData.notes || {}; pbData.notes[k] = $('pb-' + k + '-note').value;
  });
  pbData.links = Array.prototype.map.call(document.querySelectorAll('#pb-links .lk'), function (card, i) {
    var old = (pbData.links || [])[i] || {};
    return { name: card.querySelector('.n').value.trim(), sum: Number(card.querySelector('.s').value) || 0, tier: Number(card.querySelector('.g').value) || 0,
      plan: 'premium', hostess: Number(card.querySelector('.h').value) || 0, url: old.url || '' };
  });
}
function pbLoad() {
  
  pbApi({}).then(function (j) {
    if (!j || !j.ok) { pbState('לא נטען', 'dirty'); return; }
    pbData = j.playbook || JSON.parse(JSON.stringify(PB_DEFAULT));
    if (!pbData.links) pbData.links = JSON.parse(JSON.stringify(PB_DEFAULT.links));
    pbDirty = false; pbRender(); pbState(j.playbook ? 'שמור' : 'ברירת מחדל – ערוך ושמור', j.playbook ? 'saved' : '');
  }).catch(function () { pbState('לא נטען', 'dirty'); });
}
function pbSave() {
  if (!pbData) return;
  pbCollect(); pbState('שומר…');
  pbApi({ set: pbData }).then(function (j) {
    if (j && j.ok) { pbDirty = false; pbState('נשמר ' + new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }), 'saved'); }
    else pbState('השמירה נכשלה', 'dirty');
  }).catch(function () { pbState('השמירה נכשלה', 'dirty'); });
}
function pbRenderLinks() {
  var host = $('pb-links'); if (!host) return;
  host.innerHTML = (pbData.links || []).map(function (l, i) {
    return '<div class="lk" data-i="' + i + '">' +
      '<div class="t"><span>' + esc(l.name || 'מבצע') + '</span><b>₪' + (Number(l.sum) || 0).toLocaleString('he-IL') + '</b></div>' +
      '<div class="d">הכל כלול עד ' + esc(l.tier || '?') + ' רשומות' + (l.hostess ? ' + ' + (l.hostess === 1 ? 'דיילת אחת' : esc(l.hostess) + ' דיילות') : '') + '</div>' +
      '<div class="row"><span class="lbl">שם</span><input class="n" value="' + esc(l.name || '') + '"><span class="lbl">₪</span><input class="s" type="number" value="' + esc(l.sum || '') + '"><span class="lbl">עד</span><input class="g" type="number" value="' + esc(l.tier || '') + '"><span class="lbl">דיילות</span><input class="h" type="number" min="0" max="3" value="' + esc(l.hostess || 0) + '"></div>' +
      '<div class="u">' + (l.url ? esc(l.url) : 'עדיין אין קישור – לחץ "צור"') + '</div>' +
      '<div class="row">' +
        (l.url ? '<button type="button" class="sbtn p" data-act="copy">העתק קישור</button><button type="button" class="sbtn p" data-act="copymsg">העתק הודעה + קישור</button>' : '') +
        '<button type="button" class="sbtn" data-act="make">' + (l.url ? 'צור קישור חדש' : 'צור קישור') + '</button>' +
        '<button type="button" class="sbtn d" data-act="del">הסר</button>' +
      '</div></div>';
  }).join('');
}
document.addEventListener('click', function (ev) {
  var b = ev.target.closest && ev.target.closest('.pbwrap [data-act]');
  if (!b || !pbData) return;
  var card = b.closest('.lk'), i = Number(card.dataset.i), act = b.dataset.act;
  pbCollect();
  var l = pbData.links[i]; if (!l) return;
  if (act === 'del') { if (!confirm('להסיר את "' + l.name + '"?')) return; pbData.links.splice(i, 1); pbRenderLinks(); pbSave(); return; }
  if (act === 'copy' || act === 'copymsg') {
    var txt = act === 'copy' ? l.url : 'היי, הנה הקישור לתשלום ל' + l.name + ' – ₪' + l.sum + ' (' + 'הכל כלול עד ' + l.tier + ' רשומות' + (l.hostess ? ' + ' + (l.hostess === 1 ? 'דיילת' : l.hostess + ' דיילות') : '') + '):\n' + l.url + '\nמיד אחרי התשלום מגיע קישור להעלאת הרשימה. ריצארד · ishur.io';
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { b.textContent = '✓ הועתק'; setTimeout(pbRenderLinks, 1500); }, function () { window.prompt('העתק:', txt); });
    else window.prompt('העתק:', txt);
    return;
  }
  if (act === 'make') {
    if (!l.sum || !l.tier) { alert('צריך סכום ומכסת רשומות'); return; }
    b.disabled = true; b.textContent = 'יוצר…';
    var payload = { admin_key: adminKey, sum: l.sum, tier: l.tier, plan: 'premium', hostess: l.hostess, note: 'playbook' };
    fetch(BASE + '/api/pay-link', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.IshurGuard ? IshurGuard.stamp(payload) : payload) }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.url) { l.url = j.url; pbRenderLinks(); pbSave(); }
      else { alert('לא נוצר קישור' + (j && j.make ? ': ' + j.make : '')); pbRenderLinks(); }
    }).catch(function () { alert('לא נוצר קישור'); pbRenderLinks(); });
  }
});
document.addEventListener('input', function (ev) {
  if (ev.target.closest && ev.target.closest('.pbwrap') && !pbDirty) { pbDirty = true; pbState('יש שינויים שלא נשמרו', 'dirty'); }
  /* the document follows the text while it is being edited */
  if (pbData && ev.target.closest && ev.target.closest('#pb-edit')) { clearTimeout(pbDocT); pbDocT = setTimeout(function () { pbCollect(); pbDoc(); }, 250); }
});
document.addEventListener('keydown', function (ev) {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 's' && ev.target.closest && ev.target.closest('.pbwrap')) { ev.preventDefault(); pbSave(); }
});
window.addEventListener('beforeunload', function (e) { if (pbDirty) { e.preventDefault(); e.returnValue = ''; } });


  var mounted = false;
  window.IshurPlaybook = {
    mount: function (id, key) {
      adminKey = key || adminKey;
      var host = $(id); if (!host) return;
      if (!mounted) {
        var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
        host.classList.add('pbwrap'); host.innerHTML = HTML; mounted = true;
        $('pb-save').addEventListener('click', pbSave);
        var fold = function (btnId, boxId, onText, offText) {
          $(btnId).addEventListener('click', function () {
            var box = $(boxId), show = box.hidden; box.hidden = !show; this.setAttribute('aria-expanded', show ? 'true' : 'false');
            if (onText) this.textContent = show ? onText : offText;
            if (!show && boxId === 'pb-edit' && pbData) { pbCollect(); pbDoc(); }
          });
        };
        fold('pb-info-btn', 'pb-info'); fold('pb-edit-btn', 'pb-edit', 'סגירת עריכה', 'עריכה');
        $('pb-print').addEventListener('click', function () { window.print(); });
        host.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('pb-info').hidden) { $('pb-info').hidden = true; $('pb-info-btn').setAttribute('aria-expanded', 'false'); $('pb-info-btn').focus(); } });
        if (window.IshurPayLinkGen) IshurPayLinkGen.mount('pl-gen', adminKey);
        $('pb-addlink').addEventListener('click', function () { if (!pbData) return; pbCollect(); pbData.links.push({ name: 'מבצע חדש', sum: 0, tier: 0, plan: 'premium', hostess: 0, url: '' }); pbRenderLinks(); });
      }
      if (!pbData) pbLoad();
    }
  };
})();
