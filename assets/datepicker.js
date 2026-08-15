/* ============================================================================
   ishur.io · date picker
   ----------------------------------------------------------------------------
   A Hebrew calendar that drops out of the field's own bottom line, reusing the
   select's markup so it inherits the same skin on every version.

   The sending rules live here rather than in a validation message: a Saturday,
   or anything inside the 48 hour window, simply cannot be clicked.

   Enhances <input data-idate>. The input keeps the ISO value (YYYY-MM-DD), so
   anything reading `.value` or listening for `change` works unchanged.

   Requires config.js.
   ========================================================================== */

window.IshurDate = (function () {

  var CFG = window.ISHUR_CONFIG || {};
  var RULES = CFG.SEND_RULES || { minHoursAhead: 0, blockedWeekdays: [], cutoff: {}, maxMonthsAhead: 18 };
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  var DAYS_LONG = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  var DAYS_SHORT = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

  var openOne = null;
  var seq = 0;

  function iso(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function parse(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  function midnight(d) {
    var x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /* "יום שלישי, 3 בספטמבר 2026" */
  function pretty(d) {
    return 'יום ' + DAYS_LONG[d.getDay()] + ', ' + d.getDate() + ' ב' +
           MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* earliest allowed day: now + the notice period, rounded up to a whole day */
  function minDate() {
    var now = new Date();
    if (RULES.setupCutoffHour == null) return midnight(now);
    var d = midnight(now);
    if (now.getHours() >= RULES.setupCutoffHour) d = new Date(d.getTime() + 864e5);
    return midnight(d);
  }

  function maxDate() {
    var d = new Date();
    d.setMonth(d.getMonth() + (RULES.maxMonthsAhead || 18));
    return midnight(d);
  }

  function blockedDay(d) {
    return (RULES.blockedWeekdays || []).indexOf(d.getDay()) > -1;
  }

  function cutoffFor(d) {
    return (RULES.cutoff || {})[d.getDay()] || null;
  }

  function why(d, min, max) {
    if (d < min) return 'too-soon';
    if (d > max) return 'too-far';
    if (blockedDay(d)) return 'blocked';
    return null;
  }

  /* data-idate="send"  the sending rules apply (default)
     data-idate="free"  any future date, used for the event date itself, which
                        may well fall on a Saturday */
  function rulesFor(input) {
    var mode = input.dataset.idate;
    if (mode === 'free' || mode === 'event') {
      /* the event itself is not a send: Saturday is fine, plenty of events are
         on מוצאי שבת. It only needs enough notice to be worth setting up. */
      return {
        setupCutoffHour: null,
        blockedWeekdays: [],
        cutoff: {},
        minDays: mode === 'event' ? ((CFG.SCHEDULE || {}).minEventDays || 0) : 0,
        maxMonthsAhead: RULES.maxMonthsAhead
      };
    }
    return RULES;
  }

  function enhance(input) {
    if (!input || input.dataset.enhanced) return;
    input.dataset.enhanced = '1';
    var R = rulesFor(input);

    var id = 'idate-' + (++seq);
    var wrap = document.createElement('div');
    wrap.className = 'isel idate';
    wrap.dataset.open = 'false';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'isel-btn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    var lbl = document.querySelector('label[for="' + input.id + '"]');
    if (lbl) {
      if (!lbl.id) lbl.id = input.id + '-label';
      btn.setAttribute('aria-labelledby', lbl.id);
    }

    var val = document.createElement('span');
    val.className = 'isel-val';
    btn.appendChild(val);

    var ico = document.createElement('span');
    ico.className = 'isel-arrow';
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none">' +
      '<rect x="1.5" y="2.8" width="13" height="11.7" rx="2" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M1.5 6.3h13M5 1.5v2.6M11 1.5v2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    btn.appendChild(ico);

    var panel = document.createElement('div');
    panel.className = 'isel-panel idate-panel';
    panel.id = id;
    panel.setAttribute('role', 'dialog');
    panel.hidden = true;

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    wrap.appendChild(input);

    input.classList.add('isel-native');
    input.setAttribute('tabindex', '-1');
    input.setAttribute('aria-hidden', 'true');
    input.type = 'hidden';

    /* today is still on the table until the cutoff hour passes, then the
       earliest possible send moves to tomorrow */
    function minD() {
      var now = new Date();
      if (R.setupCutoffHour == null) {
        return midnight(new Date(now.getTime() + (R.minDays || 0) * 864e5));
      }
      var d = midnight(now);
      if (now.getHours() >= R.setupCutoffHour) d = new Date(d.getTime() + 864e5);
      return midnight(d);
    }
    function maxD() {
      var d = new Date();
      d.setMonth(d.getMonth() + (R.maxMonthsAhead || 18));
      return midnight(d);
    }
    function blocked(d) { return (R.blockedWeekdays || []).indexOf(d.getDay()) > -1; }
    function cutoff(d) { return (R.cutoff || {})[d.getDay()] || null; }
    function reason(d, mn, mx) {
      if (d < mn) return 'too-soon';
      if (d > mx) return 'too-far';
      if (blocked(d)) return 'blocked';
      return null;
    }

    var view = midnight(parse(input.value) || minD());

    function syncLabel() {
      var d = parse(input.value);
      val.textContent = d ? pretty(d) : (input.dataset.placeholder || 'בחרו תאריך');
      wrap.dataset.placeholder = d ? 'false' : 'true';
      var note = wrap.querySelector('.idate-note');
      if (note) note.remove();
      if (d && cutoff(d)) {
        var n = document.createElement('p');
        n.className = 'idate-note';
        n.textContent = 'יום שישי, השליחה יוצאת עד ' + cutoff(d);
        wrap.appendChild(n);
      }
    }

    function build() {
      var min = minD(), max = maxD();
      var y = view.getFullYear(), m = view.getMonth();
      var first = new Date(y, m, 1);
      var lead = first.getDay();
      var days = new Date(y, m + 1, 0).getDate();
      var sel = parse(input.value);

      var prevOk = new Date(y, m, 0) >= new Date(min.getFullYear(), min.getMonth(), 1);
      var nextOk = new Date(y, m + 1, 1) <= max;

      var h = '<div class="idate-head">' +
        '<button type="button" class="idate-nav" data-nav="-1"' + (prevOk ? '' : ' disabled') +
        /* RTL: going back points right, forward points left */
        ' aria-label="חודש קודם"><svg width="9" height="14" viewBox="0 0 9 14" fill="none">' +
        '<path d="M1.5 1 7 7l-5.5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
        '<span class="idate-title">' + MONTHS[m] + ' ' + y + '</span>' +
        '<button type="button" class="idate-nav" data-nav="1"' + (nextOk ? '' : ' disabled') +
        ' aria-label="חודש הבא"><svg width="9" height="14" viewBox="0 0 9 14" fill="none">' +
        '<path d="M7.5 1 2 7l5.5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
        '</div><div class="idate-grid">';

      DAYS_SHORT.forEach(function (d, i) {
        h += '<span class="idate-dow' + (i === 6 ? ' off' : '') + '">' + d + '</span>';
      });
      for (var i = 0; i < lead; i++) h += '<span class="idate-cell empty"></span>';

      for (var day = 1; day <= days; day++) {
        var d = new Date(y, m, day);
        var bad = reason(d, min, max);
        var cls = 'idate-cell';
        if (bad) cls += ' off';
        if (sel && iso(sel) === iso(d)) cls += ' on';
        if (!bad && cutoff(d)) cls += ' cut';
        h += '<button type="button" class="' + cls + '" data-d="' + iso(d) + '"' +
             (bad ? ' disabled aria-disabled="true"' : '') + '>' + day + '</button>';
      }
      h += '</div>';

      if (R.setupCutoffHour != null) {
        var hh = String(R.setupCutoffHour).padStart(2, '0') + ':00';
        h += '<p class="idate-legend">' +
             'השליחה יוצאת בבוקר. כדי לצאת ביום מסוים צריך לסיים את ההגדרה עד ' + hh + ' באותו יום. ' +
             'בשבת לא שולחים, וביום שישי השליחה יוצאת עד ' + ((R.cutoff || {})[5] || '15:00') + '.' +
             '</p>';
      }

      panel.innerHTML = h;

      panel.querySelectorAll('[data-nav]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          view = new Date(view.getFullYear(), view.getMonth() + (+b.dataset.nav), 1);
          build();
        });
      });
      panel.querySelectorAll('.idate-cell[data-d]').forEach(function (c) {
        if (c.disabled) return;
        c.addEventListener('click', function () { choose(c.dataset.d); });
      });
    }

    function choose(v) {
      input.value = v;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      syncLabel();
      close();
      btn.focus();
    }

    function open() {
      if (wrap.dataset.open === 'true') return;
      if (openOne && openOne !== close) openOne();
      openOne = close;
      view = midnight(parse(input.value) || minD());
      build();
      panel.hidden = false;
      wrap.dataset.open = 'true';
      btn.setAttribute('aria-expanded', 'true');
      if (!REDUCED) { panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = ''; }
      setTimeout(function () {
        var r = panel.getBoundingClientRect();
        if (r.bottom > innerHeight - 8) panel.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
      }, 40);
    }

    function close() {
      if (wrap.dataset.open !== 'true') return;
      wrap.dataset.open = 'false';
      btn.setAttribute('aria-expanded', 'false');
      if (REDUCED) { panel.hidden = true; return; }
      setTimeout(function () { if (wrap.dataset.open === 'false') panel.hidden = true; }, 160);
      if (openOne === close) openOne = null;
    }

    btn.addEventListener('click', function () {
      wrap.dataset.open === 'true' ? close() : open();
    });

    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && wrap.dataset.open === 'true') {
        e.preventDefault(); e.stopPropagation(); close();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        if (wrap.dataset.open !== 'true') { e.preventDefault(); open(); }
      }
    });

    document.addEventListener('pointerdown', function (e) {
      if (!wrap.contains(e.target)) close();
    });

    syncLabel();
    wrap._input = input;
    input._idate = { syncLabel: syncLabel, close: close };
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('input[data-idate]').forEach(enhance);
  }

  /* is this ISO date sendable? used for cross-field checks */
  function valid(v) {
    var d = parse(v);
    if (!d) return false;
    return !why(midnight(d), minDate(), maxDate());
  }

  return {
    enhance: enhance,
    enhanceAll: enhanceAll,
    valid: valid,
    pretty: function (v) { var d = parse(v); return d ? pretty(d) : ''; },
    minDate: minDate,
    iso: iso,
    parse: parse
  };
})();
