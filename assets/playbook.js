/* ishur.io · sales playbook (01/11): script, branches, objections, notes and
   quick pay links. One KV blob (/api/playbook). Mounted on admin.html and
   leads.html — same data, one save. Usage: IshurPlaybook.mount(containerId, adminKey) */
(function () {
  var CFG = window.ISHUR_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var BASE = CFG.endpoint('status').replace(/\/api\/status$/, '');
  var adminKey = '';
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var CSS = '  /* ══ 01/11: sales playbook — editable script, branches, objections, quick pay links ══ */\n  .pbwrap .pb{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:.8rem}\n  .pbwrap .pbcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.9rem 1rem;display:flex;flex-direction:column;gap:.5rem}\n  .pbwrap .pbcard h3{margin:0;font-size:.95rem;display:flex;align-items:center;justify-content:space-between;gap:.5rem}\n  .pbwrap .pbcard h3 span{font-size:.7rem;font-weight:500;color:var(--ink3)}\n  .pbwrap textarea{width:100%;min-height:9rem;font:inherit;font-size:.86rem;line-height:1.55;padding:.6rem .7rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);resize:vertical}\n  .pbwrap textarea.note{min-height:3.6rem;background:rgba(199,174,122,.12);border-color:var(--gold-pale)}\n  .pbwrap textarea:focus{outline:none;border-color:var(--gold)}\n  .pbwrap .pbbar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:.6rem 0 0}\n  .pbwrap .pbbar .state{font-size:.76rem;color:var(--ink3)}\n  .pbwrap .pbbar .state.dirty{color:#A8402F;font-weight:600}\n  .pbwrap .pbbar .state.saved{color:#0F4C35;font-weight:600}\n  .pbwrap .links{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:.6rem;margin-top:.5rem}\n  .pbwrap .lk{background:var(--card);border:1px solid var(--line);border-inline-start:5px solid var(--gold);border-radius:12px;padding:.7rem .85rem;display:flex;flex-direction:column;gap:.35rem}\n  .pbwrap .lk .t{font-weight:600;font-size:.92rem;display:flex;justify-content:space-between;gap:.5rem}\n  .pbwrap .lk .t b{color:var(--pine);font-variant-numeric:tabular-nums}\n  html[data-theme=dark] .pbwrap .lk .t b{color:var(--gold-soft)}\n  .pbwrap .lk .d{font-size:.76rem;color:var(--ink2)}\n  .pbwrap .lk .u{font-size:.7rem;color:var(--ink3);direction:ltr;text-align:left;word-break:break-all}\n  .pbwrap .lk .row{display:flex;gap:.4rem;flex-wrap:wrap}\n  .pbwrap .lk input{font:inherit;font-size:.78rem;padding:.25rem .45rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:0}\n  .pbwrap .lk input.n{flex:2}.pbwrap .lk input.s{width:5.2rem}.pbwrap .lk input.g{width:4.5rem}.pbwrap .lk input.h{width:3.2rem}\n  .pbwrap .lk .lbl{font-size:.68rem;color:var(--ink3)}\n  .pbwrap .sbtn{font:inherit;font-size:.76rem;font-weight:600;padding:.3rem .7rem;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;white-space:nowrap}\n  .pbwrap .sbtn.p{background:var(--pine);border-color:var(--pine);color:#fff}\n  .pbwrap .sbtn.d{color:#A8402F}\n';
  var HTML = '  <h2 style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">מכירות · תשריט שיחה, מקרים, התנגדויות <span style="font-size:.72rem;font-weight:500;color:var(--ink3)">עורכים כאן, שמירה נשארת לתמיד (KV) · ההערות הצהובות הן שלך על אזור בשיחה</span></h2>\n  <div class="pb">\n    <div class="pbcard"><h3>1 · פתיחה ושאלות <span>כל שיחה מתחילה כאן</span></h3>\n      <textarea id="pb-script" placeholder="התשריט"></textarea>\n      <textarea id="pb-script-note" class="note" placeholder="הערות שלי על הפתיחה (מה עבד, מה לשנות)"></textarea></div>\n    <div class="pbcard"><h3>2 · התפלגות למקרים <span>לפי מה שענו</span></h3>\n      <textarea id="pb-branches" placeholder="מקרים"></textarea>\n      <textarea id="pb-branches-note" class="note" placeholder="הערות שלי על המקרים"></textarea></div>\n    <div class="pbcard"><h3>3 · טיפול בהתנגדויות <span>מה אומרים ומה עונים</span></h3>\n      <textarea id="pb-objections" placeholder="התנגדויות"></textarea>\n      <textarea id="pb-objections-note" class="note" placeholder="הערות שלי על ההתנגדויות"></textarea></div>\n    <div class="pbcard"><h3>4 · סגירה ואחרי השיחה <span>איך מסיימים</span></h3>\n      <textarea id="pb-close" placeholder="סגירה"></textarea>\n      <textarea id="pb-close-note" class="note" placeholder="הערות שלי על הסגירה"></textarea></div>\n  </div>\n  <div class="pbbar">\n    <button type="button" class="sbtn p" id="pb-save">💾 שמירה</button>\n    <span class="state" id="pb-state">טוען…</span>\n  </div>\n\n  <h2 style="margin-top:1.4rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">קישור תשלום <span style="font-size:.72rem;font-weight:500;color:var(--ink3)">חבילה + תוספות · המחיר מחושב בשרת · התשלום פותח אירוע ומפעיל את התוספות לבד</span></h2>\n  <div class="plg-card">\n    <div id="pl-gen"></div>\n    <div class="plg-saved"><h3>קישורים שמורים <span>מבצעים קבועים · "צור" מייצר קישור Grow חדש, "העתק" מעתיק את האחרון · נשמרים עם התשריט</span></h3>\n    <div class="links" id="pb-links"></div>\n    <div class="pbbar"><button type="button" class="sbtn" id="pb-addlink">+ מבצע חדש</button></div></div>\n  </div>\n';
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
var pbData = null, pbDirty = false;
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
      '<div class="d">הכל כלול עד ' + (l.tier || '?') + ' רשומות' + (l.hostess ? ' + ' + (l.hostess === 1 ? 'דיילת אחת' : l.hostess + ' דיילות') : '') + '</div>' +
      '<div class="row"><span class="lbl">שם</span><input class="n" value="' + esc(l.name || '') + '"><span class="lbl">₪</span><input class="s" type="number" value="' + (l.sum || '') + '"><span class="lbl">עד</span><input class="g" type="number" value="' + (l.tier || '') + '"><span class="lbl">דיילות</span><input class="h" type="number" min="0" max="3" value="' + (l.hostess || 0) + '"></div>' +
      '<div class="u">' + (l.url ? esc(l.url) : 'עדיין אין קישור – לחץ "צור"') + '</div>' +
      '<div class="row">' +
        (l.url ? '<button type="button" class="sbtn p" data-act="copy">📋 העתק קישור</button><button type="button" class="sbtn p" data-act="copymsg">📋 העתק הודעה + קישור</button>' : '') +
        '<button type="button" class="sbtn" data-act="make">' + (l.url ? '↻ צור קישור חדש' : '⚡ צור קישור') + '</button>' +
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
        if (window.IshurPayLinkGen) IshurPayLinkGen.mount('pl-gen', adminKey);
        $('pb-addlink').addEventListener('click', function () { if (!pbData) return; pbCollect(); pbData.links.push({ name: 'מבצע חדש', sum: 0, tier: 0, plan: 'premium', hostess: 0, url: '' }); pbRenderLinks(); });
      }
      if (!pbData) pbLoad();
    }
  };
})();
