/* ============================================================================
   ishur.io · select
   ----------------------------------------------------------------------------
   Enhances a native <select> into a dropdown whose panel is a continuation of
   the field itself: same width, same border, joined edge, opening downward from
   the field's own bottom line so the two read as one object.

   The native <select> stays in the DOM and keeps holding the value, so anything
   reading `.value` or listening for `change` works unchanged.

   Shared by both site versions. Each version skins `.isel*` in its own CSS.
   ========================================================================== */

window.IshurSelect = (function () {

  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var openOne = null;
  var seq = 0;

  function enhance(sel) {
    if (!sel || sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';

    var id = 'isel-' + (++seq);
    var wrap = document.createElement('div');
    wrap.className = 'isel';
    wrap.dataset.open = 'false';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'isel-btn';
    btn.setAttribute('role', 'combobox');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    if (sel.id) btn.setAttribute('aria-labelledby', findLabelId(sel));

    /* data-typeable turns the trigger into a combobox: the list still opens,
       but typing filters it and a value outside the list is accepted when it
       passes the field's own format check. */
    var typeable = sel.hasAttribute('data-typeable');
    var val;
    if (typeable) {
      val = document.createElement('input');
      val.type = 'text';
      val.className = 'isel-val isel-input';
      val.setAttribute('autocomplete', 'off');
      val.setAttribute('inputmode', sel.dataset.accept === 'time' ? 'numeric' : 'text');
      if (sel.dataset.placeholder) val.placeholder = sel.dataset.placeholder;
      btn.appendChild(val);
    } else {
      val = document.createElement('span');
      val.className = 'isel-val';
      btn.appendChild(val);
    }

    var arrow = document.createElement('span');
    arrow.className = 'isel-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<svg width="12" height="8" viewBox="0 0 12 8" fill="none">' +
                      '<path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="1.8" ' +
                      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.appendChild(arrow);

    var panel = document.createElement('div');
    panel.className = 'isel-panel';
    panel.id = id;
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    wrap.appendChild(sel);

    sel.classList.add('isel-native');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');

    var active = -1;

    function options() {
      return Array.prototype.slice.call(panel.querySelectorAll('.isel-opt')).filter(function (o) {
        return !o.hidden;
      });
    }

    function build() {
      panel.innerHTML = '';
      /* the empty first entry is a placeholder, not a choice: it stays in the
         native select but never becomes a row, so keyboard navigation cannot
         land on it */
      Array.prototype.forEach.call(sel.options, function (o, i) {
        if (o.value === '') return;
        var d = document.createElement('div');
        d.className = 'isel-opt';
        d.setAttribute('role', 'option');
        d.id = id + '-o' + i;
        d.dataset.index = i;
        d.dataset.value = o.value;
        d.textContent = o.textContent;
        d.setAttribute('aria-selected', o.value === sel.value ? 'true' : 'false');
        if (o.value === sel.value) d.classList.add('on');
        d.addEventListener('click', function () { choose(indexOf(d)); });
        d.addEventListener('pointerenter', function () { setActive(indexOf(d)); });
        panel.appendChild(d);
      });
      syncLabel();
    }

    function indexOf(el) {
      return options().indexOf(el);
    }

    /* position of the current value among the rendered rows */
    function activeRow() {
      var opts = options();
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].dataset.value === sel.value) return i;
      }
      return 0;
    }

    function syncLabel() {
      var o = sel.options[sel.selectedIndex];
      var empty = !o || o.value === '';
      var text = o ? o.textContent : '';
      if (typeable) val.value = empty ? '' : text;
      else val.textContent = text;
      wrap.dataset.placeholder = empty ? 'true' : 'false';
    }

    /* accept a value the list does not contain, when the format allows it */
    function normalise(raw) {
      var v = String(raw || '').trim();
      if (!v) return null;
      if (sel.dataset.accept === 'time') {
        var m = /^(\d{1,2})[:.]?(\d{2})$/.exec(v.replace(/\s/g, ''));
        if (!m) return null;
        var hh = +m[1], mm = +m[2];
        if (hh > 23 || mm > 59) return null;
        return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
      }
      return null;
    }

    function commitTyped() {
      if (!typeable) return;
      var raw = val.value;
      if (!raw.trim()) { sel.selectedIndex = 0; sel.dispatchEvent(new Event('change', { bubbles: true })); build(); return; }
      var exact = null;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].textContent.trim() === raw.trim()) { exact = i; break; }
      }
      if (exact != null) { sel.selectedIndex = exact; }
      else {
        var n = normalise(raw);
        if (n) {
          var found = null;
          for (var j = 0; j < sel.options.length; j++) if (sel.options[j].value === n) { found = j; break; }
          if (found == null) {
            /* keep the list ordered so the new value lands where it belongs */
            var opt = new Option(n, n);
            var at = null;
            for (var k = 1; k < sel.options.length; k++) if (sel.options[k].value > n) { at = sel.options[k]; break; }
            sel.add(opt, at);
            found = opt.index;
          }
          sel.selectedIndex = found;
        }
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      build();
    }

    function filter(q) {
      q = String(q || '').trim();
      options().forEach(function (o) {
        o.hidden = q ? o.textContent.trim().indexOf(q) !== 0 : false;
      });
    }

    function setActive(i) {
      var opts = options();
      opts.forEach(function (el, n) { el.classList.toggle('active', n === i); });
      active = i;
      if (opts[i]) {
        btn.setAttribute('aria-activedescendant', opts[i].id);
        var o = opts[i], p = panel;
        if (o.offsetTop < p.scrollTop) p.scrollTop = o.offsetTop;
        else if (o.offsetTop + o.offsetHeight > p.scrollTop + p.clientHeight) {
          p.scrollTop = o.offsetTop + o.offsetHeight - p.clientHeight;
        }
      }
    }

    function choose(row) {
      var opts = options();
      if (!opts[row]) return;
      sel.selectedIndex = parseInt(opts[row].dataset.index, 10);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      build();
      if (typeable) { val.value = sel.options[sel.selectedIndex].textContent; filter(''); }
      close();
      (typeable ? val : btn).focus();
    }

    function open() {
      if (wrap.dataset.open === 'true') return;
      if (openOne && openOne !== close) openOne();
      openOne = close;

      panel.hidden = false;
      wrap.dataset.open = 'true';
      btn.setAttribute('aria-expanded', 'true');
      if (!REDUCED) {
        panel.style.animation = 'none';
        void panel.offsetWidth;
        panel.style.animation = '';
      }
      setActive(typeable && val.value.trim() && sel.selectedIndex <= 0 ? -1 : activeRow());
      /* if the panel would open past the bottom of a scrolling container,
         bring it into view rather than letting it clip */
      setTimeout(function () {
        var r = panel.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) {
          panel.scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
        }
      }, 40);
    }

    function close() {
      if (wrap.dataset.open !== 'true') return;
      wrap.dataset.open = 'false';
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-activedescendant');
      if (REDUCED) { panel.hidden = true; return; }
      /* let the collapse play out before removing it from the tree */
      setTimeout(function () { if (wrap.dataset.open === 'false') panel.hidden = true; }, 160);
      if (openOne === close) openOne = null;
    }

    function toggle() { wrap.dataset.open === 'true' ? close() : open(); }

    if (typeable) {
      val.addEventListener('focus', function () { open(); });
      val.addEventListener('click', function (e) { e.stopPropagation(); open(); });
      val.addEventListener('input', function () { open(); filter(val.value); });
      val.addEventListener('blur', function () { setTimeout(commitTyped, 120); });
      btn.addEventListener('click', function (e) {
        if (e.target === val) return;
        wrap.dataset.open === 'true' ? close() : open();
        val.focus();
      });
    } else {
      btn.addEventListener('click', toggle);
    }

    (typeable ? val : btn).addEventListener('keydown', function (e) {
      var opts = options(), isOpen = wrap.dataset.open === 'true';
      if (e.key === 'Enter' && typeable && isOpen && active < 0) {
        e.preventDefault(); commitTyped(); close(); return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) { open(); return; }
        var n = active + (e.key === 'ArrowDown' ? 1 : -1);
        if (n < 0) n = 0;
        if (n > opts.length - 1) n = opts.length - 1;
        setActive(n);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen && active > -1) choose(active); else toggle();
      } else if (e.key === 'Escape') {
        if (isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
      } else if (e.key === 'Home' || e.key === 'End') {
        if (isOpen) { e.preventDefault(); setActive(e.key === 'Home' ? 0 : opts.length - 1); }
      } else if (!typeable && e.key.length === 1) {
        /* type-ahead */
        var q = e.key.toLowerCase();
        for (var i = 0; i < opts.length; i++) {
          if (opts[i].textContent.trim().toLowerCase().indexOf(q) === 0) {
            if (!isOpen) open();
            setActive(i);
            break;
          }
        }
      }
    });

    document.addEventListener('pointerdown', function (e) {
      if (!wrap.contains(e.target)) close();
    });

    /* keep the trigger in sync when something else sets the value */
    sel.addEventListener('change', function () { build(); });

    /* the controller fills options after enhancement, so rebuild on demand */
    wrap._rebuild = build;
    sel._isel = { build: build, open: open, close: close };

    build();
  }

  function findLabelId(sel) {
    var l = sel.id && document.querySelector('label[for="' + sel.id + '"]');
    if (!l) return '';
    if (!l.id) l.id = sel.id + '-label';
    return l.id;
  }

  /* call again after options change */
  function refresh(sel) {
    if (sel && sel._isel) sel._isel.build();
  }

  function enhanceAll(root) {
    var list = (root || document).querySelectorAll('select[data-isel]');
    Array.prototype.forEach.call(list, enhance);
  }

  return { enhance: enhance, enhanceAll: enhanceAll, refresh: refresh };
})();
