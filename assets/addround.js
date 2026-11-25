/* 25/11/2026 track-board · the "add a send / add a calls round" dialog of the clients screens
   (clients.html, next/clients.html). Asks right away:
     (a) when — a day from today on (today only before 19:00 Israel time), or "הלקוח יחליט"
     (b) for whom — כולם / רק מי שלא ענה / מתלבטים / לא ענו + מתלבטים (a calls round never offers "כולם")
   IshurAddRound.ask({kind:'extrasend'|'calls', name}) → Promise<null | {when:'YYYY-MM-DD'|'client', scope}>
   The worker checks the same date rule again (POST /api/grant-addon). Uses the ux.js dialog look. */
(function () {
  function ilNow() {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    var g = function (k) { return (p.filter(function (x) { return x.type === k; })[0] || {}).value || ''; };
    return { day: g('year') + '-' + g('month') + '-' + g('day'), hm: (g('hour') === '24' ? '00' : g('hour')) + ':' + g('minute') };
  }
  function plusDay(iso) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  /* the first day that may be chosen: today until 19:00, then tomorrow */
  function minDay() { var n = ilNow(); return n.hm < '19:00' ? n.day : plusDay(n.day); }
  var AUD = [['all', 'כולם'], ['noanswer', 'רק מי שלא ענה'], ['undecided', 'מתלבטים'], ['unanswered', 'לא ענו + מתלבטים']];

  function ask(o) {
    o = o || {};
    var calls = o.kind === 'calls';
    return new Promise(function (resolve) {
      var bg = document.createElement('div'); bg.className = 'ux-dlg-bg';
      var box = document.createElement('div'); box.className = 'ux-dlg'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      var title = calls ? 'סבב שיחות נוסף' : 'שליחה נוספת';
      box.setAttribute('aria-label', title);
      var min = minDay();
      var aud = AUD.filter(function (a) { return !(calls && a[0] === 'all'); });
      var def = calls ? 'unanswered' : 'all';
      box.innerHTML = '<h3>' + title + (o.name ? ' · ' + String(o.name).replace(/[<>&"]/g, '') : '') + '</h3>' +
        '<p style="margin:0 0 .4rem;font-weight:600">מתי?</p>' +
        '<div style="display:grid;gap:.4rem;margin:0 0 .9rem">' +
          '<label style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="arWhen" value="date" checked> בתאריך <input type="date" data-ar-date min="' + min + '" value="' + min + '" style="font:inherit;padding:.35rem .5rem;border:1px solid var(--line,#e4dfd2);border-radius:6px;background:var(--card,#fff);color:var(--ink,#1c1c1c)"></label>' +
          '<label style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="arWhen" value="client"> הלקוח יחליט (יופיע לו בלוח "צריך לבחור מתי לשלוח")</label>' +
        '</div>' +
        '<p style="margin:0 0 .4rem;font-weight:600">למי?</p>' +
        '<div style="display:grid;gap:.35rem;margin:0 0 .6rem">' + aud.map(function (a) {
          return '<label style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="arAud" value="' + a[0] + '"' + (a[0] === def ? ' checked' : '') + '> ' + a[1] + '</label>';
        }).join('') + '</div>' +
        '<p data-ar-err role="alert" style="min-height:1.2em;margin:0 0 .6rem;font-size:.85rem;color:var(--warn,#b3261e)"></p>' +
        '<div class="row"><button type="button" class="ok">לתת</button><button type="button" data-no>ביטול</button></div>';
      document.body.appendChild(bg); document.body.appendChild(box);
      requestAnimationFrame(function () { bg.classList.add('on'); box.classList.add('on'); });
      var di = box.querySelector('[data-ar-date]'), err = box.querySelector('[data-ar-err]');
      di.addEventListener('focus', function () { box.querySelector('input[name=arWhen][value=date]').checked = true; });
      function done(v) { bg.classList.remove('on'); box.classList.remove('on'); setTimeout(function () { bg.remove(); box.remove(); }, 200); document.removeEventListener('keydown', onKey); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') done(null); }
      box.querySelector('.ok').addEventListener('click', function () {
        var when = box.querySelector('input[name=arWhen]:checked').value;
        var scope = box.querySelector('input[name=arAud]:checked').value;
        if (when === 'date') {
          var d = di.value, m = minDay();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { err.textContent = 'בחרו תאריך'; return; }
          if (d < m) { err.textContent = m > ilNow().day ? 'היום כבר אחרי 19:00, אפשר מחר והלאה' : 'אי אפשר תאריך שעבר'; return; }
          when = d;
        }
        done({ when: when, scope: scope });
      });
      box.querySelector('[data-no]').addEventListener('click', function () { done(null); });
      bg.addEventListener('click', function () { done(null); });
      document.addEventListener('keydown', onKey);
      di.focus();
    });
  }
  window.IshurAddRound = { ask: ask, minDay: minDay };
})();
