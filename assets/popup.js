/* ============================================================================
   ishur.io · order popup controller
   ----------------------------------------------------------------------------
   Drives the two-step order popup. Shared by site v1 and site v2: same logic,
   same payloads, same validation. Each version supplies its own markup and CSS,
   using the ids listed in IDS below.

   Motion follows Apple's fluid-interface rules: feedback on pointer-down,
   1:1 drag tracking, rubber-banded boundaries, momentum projection on release,
   and springs that start from the current on-screen value so a gesture can be
   grabbed and reversed mid-flight.

   Requires config.js and lead.js.
   ========================================================================== */

window.IshurPopup = (function () {

  var CFG = window.ISHUR_CONFIG;
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ══ springs ══════════════════════════════════════════════════════════════
     damping: 1.0 = critically damped, no overshoot. ~0.8 = slight bounce,
     used only after a gesture that carried momentum.
     response: seconds to reach the target. Not a duration; a spring has none.
     ─────────────────────────────────────────────────────────────────────── */

  function spring(opts) {
    var from = opts.from, to = opts.to, v = opts.velocity || 0;
    var w0 = 2 * Math.PI / (opts.response || 0.4);
    var zeta = opts.damping == null ? 1 : opts.damping;
    var x = from - to;
    var last = performance.now();
    var raf = 0, stopped = false;

    function tick(now) {
      if (stopped) return;
      var dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      var a = -w0 * w0 * x - 2 * zeta * w0 * v;
      v += a * dt;
      x += v * dt;
      if (Math.abs(x) < 0.4 && Math.abs(v) < 12) {
        opts.onFrame(to, 0);
        if (opts.onRest) opts.onRest();
        return;
      }
      opts.onFrame(to + x, v);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return function cancel() { stopped = true; cancelAnimationFrame(raf); return v; };
  }

  /* where a flick comes to rest, exponential decay (Apple's sample code) */
  function project(velocity, decel) {
    decel = decel || 0.998;
    return (velocity / 1000) * decel / (1 - decel);
  }

  /* progressive resistance past a boundary, so an edge resists instead of
     freezing */
  function rubberband(overshoot, dimension, c) {
    c = c || 0.55;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  /* ══ state ════════════════════════════════════════════════════════════════ */

  var S = { step: 1, name: '', phone: '', email: '', occasion: '', guests: '', plan: '', consent: false };
  var open = false;
  var lastTrigger = null;
  var cancelSheet = null;

  var $ = function (id) { return document.getElementById(id); };

  /* ══ sheet gesture ════════════════════════════════════════════════════════
     Mobile only. Drag the sheet down to dismiss: tracks the finger 1:1,
     rubber-bands upward, and on release projects momentum to decide dismiss
     vs settle. Interruptible at any point.
     ─────────────────────────────────────────────────────────────────────── */

  function isSheet() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function setY(box, y) {
    box.style.transform = y ? 'translate3d(0,' + y + 'px,0)' : '';
  }

  function currentY(box) {
    var m = /translate3d\(0px,\s*(-?[\d.]+)px/.exec(box.style.transform || '');
    return m ? parseFloat(m[1]) : 0;
  }

  function bindSheet(box, handle) {
    if (!handle) return;
    var dragging = false, startY = 0, startTop = 0, points = [];

    handle.addEventListener('pointerdown', function (e) {
      if (!isSheet()) return;
      /* grabbing mid-animation: kill the spring and keep the on-screen value */
      if (cancelSheet) { cancelSheet(); cancelSheet = null; }
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startTop = currentY(box);
      points = [{ y: e.clientY, t: performance.now() }];
      /* a running CSS animation would override the inline transform we are
         about to write, so the open animation gets dropped on grab */
      box.style.transition = 'none';
      box.style.animation = 'none';
    });

    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = e.clientY - startY + startTop;
      /* pulling up past the top: resist instead of following */
      if (dy < 0) dy = -rubberband(-dy, box.offsetHeight || 600);
      setY(box, dy);
      points.push({ y: e.clientY, t: performance.now() });
      if (points.length > 6) points.shift();
    });

    function release(e) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) {}

      /* velocity from the last few moves, px/s */
      var v = 0;
      if (points.length > 1) {
        var a = points[0], b = points[points.length - 1];
        var dt = (b.t - a.t) / 1000;
        if (dt > 0) v = (b.y - a.y) / dt;
      }

      var y = currentY(box);
      var h = box.offsetHeight || 600;
      var projected = y + project(v);

      if (projected > h * 0.4) {
        /* thrown down: keep going at the finger's speed, then close */
        cancelSheet = spring({
          from: y, to: h + 40, velocity: v, damping: 1, response: 0.3,
          onFrame: function (val) { setY(box, val); },
          onRest: function () { finishClose(); setY(box, 0); }
        });
      } else {
        /* settles home with a little bounce, because a gesture preceded it */
        cancelSheet = spring({
          from: y, to: 0, velocity: v, damping: 0.8, response: 0.3,
          onFrame: function (val) { setY(box, val); }
        });
      }
    }

    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  }

  /* ══ rendering ════════════════════════════════════════════════════════════ */

  function fillSelects() {
    var occ = $('f-occasion');
    if (occ && !occ.options.length) {
      occ.appendChild(new Option('בחרו סוג אירוע', ''));
      CFG.OCCASIONS.forEach(function (o) {
        occ.appendChild(new Option(o.label, o.value));
      });
    }
    var g = $('f-guests');
    if (g && !g.options.length) {
      g.appendChild(new Option('בחרו כמות', ''));
      CFG.GUEST_TIERS.forEach(function (t) {
        g.appendChild(new Option(t.label, t.value));
      });
    }
    /* the panel is a continuation of the field, so the native select is
       enhanced only once its options are in place */
    if (window.IshurSelect) {
      [occ, g].forEach(function (el) {
        if (!el) return;
        if (el.dataset.enhanced) IshurSelect.refresh(el);
        else IshurSelect.enhance(el);
      });
    }
  }

  function renderPlans() {
    var wrap = $('f-plans');
    if (!wrap) return;
    var rec = S.occasion ? CFG.recommendedPlan(S.occasion) : null;
    var custom = S.guests === 'custom';
    /* fixed package: only the chosen one shows, marked, and cannot change */
    var order = S.locked ? [S.plan] : CFG.PLAN_ORDER;

    wrap.innerHTML = order.map(function (k) {
      var p = CFG.PLANS[k];
      var price = custom ? null : CFG.priceFor(S.guests, k);
      var on = S.plan === k;
      return '' +
        '<div class="plan-opt' + (on ? ' on' : '') + (!S.locked && rec === k ? ' rec' : '') + '"' +
        ' role="radio" tabindex="' + (S.locked ? '-1' : '0') + '"' +
        ' aria-checked="' + (on ? 'true' : 'false') + '"' +
        (S.locked ? ' aria-disabled="true" style="cursor:default"' : '') +
        ' data-plan="' + k + '">' +
          (!S.locked && rec === k ? '<span class="plan-rec">מומלץ</span>' : '') +
          '<span class="plan-chk" aria-hidden="true">' + (on ? '✓' : '') + '</span>' +
          '<span class="plan-txt">' +
            '<span class="plan-opt-name">' + p.name + '</span>' +
            '<span class="plan-opt-note">' + p.desc + '</span>' +
          '</span>' +
          '<span class="plan-opt-price">' +
            (price ? '<span class="cur">₪</span>' + price : (custom ? 'הצעה אישית' : '')) +
          '</span>' +
        '</div>';
    }).join('');

    if (!S.locked) {
      Array.prototype.forEach.call(wrap.querySelectorAll('.plan-opt'), function (el) {
        el.addEventListener('click', function () { setPlan(el.dataset.plan); });
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPlan(el.dataset.plan); }
        });
      });
    }
    updateTotal();
  }

  function setPlan(k) {
    S.plan = k;
    clearError('plan');
    renderPlans();
  }


  function updateTotal() {
    var t = $('pop-total');
    var btn = $('pop-submit');
    if (!t || !btn) return;

    var nextUp = document.querySelector('#ws2 .next-up');
    var fine = document.querySelector('#ws2 .pop-fine');

    /* over 900 chosen inside the flow: the event questions disappear — no
       event type, no quantity. What remains is the package and Send. */
    var isCustom = S.guests === 'custom';
    var occEl = $('f-occasion'), occRow = occEl && occEl.closest('.frow');
    var gEl = $('f-guests'), gRow = gEl && gEl.closest('.frow');
    var title2 = document.querySelector('#ws2 .o-title');
    var sub2 = document.querySelector('#ws2 .pop-sub');
    if (occRow) occRow.hidden = isCustom;
    if (gRow) gRow.hidden = isCustom;
    if (title2) title2.textContent = isCustom ? 'הצעה אישית' : 'על האירוע';
    if (sub2) sub2.textContent =
      isCustom                   ? 'מעל 900 הזמנות · בחרו חבילה, ונחזור אליכם עם הצעה.'
      : S.locked && S.guestsLocked ? 'נשאר רק לבחור את סוג האירוע.'
      : S.locked                 ? 'בחרו סוג אירוע וכמות, והחבילה כבר מסומנת.'
                                 : 'בחרו סוג וכמות, ונסמן את החבילה שמתאימה.';

    if (S.guests === 'custom') {
      t.hidden = false;
      t.innerHTML = 'מעל 900 מוזמנים מתומחר בהצעה אישית. שלחו את הפרטים ונחזור אליכם עם הצעה.';
      t.className = 'pop-total quote';
      btn.textContent = 'שלח';
      /* nothing here is about payment, so the payment copy steps aside */
      if (nextUp) nextUp.hidden = true;
      if (fine) fine.hidden = true;
      return;
    }
    if (nextUp) nextUp.hidden = false;
    if (fine) fine.hidden = false;
    btn.textContent = 'המשך לתשלום';
    var price = CFG.priceFor(S.guests, S.plan);
    if (price) {
      t.hidden = false;
      t.className = 'pop-total';
      t.innerHTML = '<span class="pt-l">' + CFG.PLANS[S.plan].name + ' · ' +
                    CFG.guestLabel(S.guests) + '</span>' +
                    '<span class="pt-v">₪' + price + '</span>';
    } else {
      t.hidden = true;
    }
  }

  /* ══ validation ═══════════════════════════════════════════════════════════
     Inline, on blur. Never a wall of errors on submit.
     ─────────────────────────────────────────────────────────────────────── */

  var MSG = {
    name:     'צריך שם מלא',
    phone:    'צריך מספר טלפון',
    phoneBad: 'המספר לא תקין. נייד ישראלי, 10 ספרות, מתחיל ב-05',
    email:    'כתובת המייל לא תקינה',
    occasion: 'בחרו סוג אירוע',
    guests:   'בחרו כמות מוזמנים',
    plan:     'בחרו חבילה'
  };

  function shell(f) {
    return (f && f.closest) ? (f.closest('.isel') || f) : f;
  }

  function showError(field, text) {
    var e = $('e-' + field), f = $('f-' + field);
    if (e) { e.textContent = text; e.classList.add('on'); }
    if (f) {
      shell(f).classList.add('bad');
      f.setAttribute('aria-invalid', 'true');
    }
  }

  function clearError(field) {
    var e = $('e-' + field), f = $('f-' + field);
    if (e) { e.textContent = ''; e.classList.remove('on'); }
    if (f) {
      shell(f).classList.remove('bad');
      f.removeAttribute('aria-invalid');
    }
  }

  function checkName(quiet) {
    var v = ($('f-name').value || '').trim();
    S.name = v;
    if (v.length < 2) { if (!quiet) showError('name', MSG.name); return false; }
    clearError('name'); return true;
  }

  function checkPhone(quiet) {
    var v = ($('f-phone').value || '').trim();
    S.phone = v;
    if (!v) { if (!quiet) showError('phone', MSG.phone); return false; }
    if (!IshurLead.isValidPhone(v)) { if (!quiet) showError('phone', MSG.phoneBad); return false; }
    clearError('phone'); return true;
  }

  function checkEmail(quiet) {
    var v = ($('f-email').value || '').trim();
    S.email = v;
    if (!v) { clearError('email'); return true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { if (!quiet) showError('email', MSG.email); return false; }
    clearError('email'); return true;
  }

  /* ══ steps ════════════════════════════════════════════════════════════════ */

  function setStep(n, dir) {
    var from = $('ws' + S.step), to = $('ws' + n);
    if (!to) return;
    S.step = n;

    if (from && from !== to) from.classList.remove('active');
    to.classList.add('active');
    /* enter and exit along the same path: forward slides in from the leading
       edge, back reverses it */
    if (!REDUCED) {
      to.style.animation = 'none';
      void to.offsetWidth;
      to.style.animation = '';
      to.classList.toggle('from-next', dir !== 'back');
      to.classList.toggle('from-prev', dir === 'back');
    }

    var d1 = $('wd1'), d2 = $('wd2'), lbl = $('wiz-lbl');
    if (d1) d1.classList.toggle('done', true);
    if (d2) d2.classList.toggle('done', n >= 2);
    if (lbl) lbl.textContent = S.quote ? 'הצעה אישית · מעל 900 הזמנות'
                             : n === 1 ? 'שלב 1 מתוך 2 · הפרטים שלכם'
                                       : 'שלב 2 מתוך 2 · פרטי האירוע';

    var box = $('order-modal-box');
    if (box) box.scrollTop = 0;

    var first = to.querySelector('input, .isel-btn, [role="radio"]');
    if (first && !isSheet()) setTimeout(function () { first.focus(); }, 60);
  }

  function next() {
    /* every field is checked, not short-circuited, so all problems surface
       in one pass instead of one per attempt */
    var okName = checkName();
    var okPhone = checkPhone();
    var okEmail = checkEmail();
    if (!(okName && okPhone && okEmail)) {
      var bad = document.querySelector('#ws1 .bad');
      if (bad) (bad.classList.contains('isel') ? bad.querySelector('.isel-btn') : bad).focus();
      return;
    }
    /* over-900 quote: this one step is the whole flow, so Send happens here */
    if (S.quote) {
      var fields = {
        name: S.name, phone: S.phone, email: S.email,
        occasion: '', guests: 'custom', plan: S.plan,
        consent: S.consent
      };
      IshurLead.submitted(fields);
      IshurLead.track('quote_request', { occasion: '', plan: S.plan });
      showQuoteOk();
      return;
    }
    setStep(2, 'next');
  }

  function back() { setStep(1, 'back'); }

  function submit() {
    var ok = true;
    /* over 900 asks nothing about the event, so only the package matters */
    if (!S.occasion && S.guests !== 'custom') { showError('occasion', MSG.occasion); ok = false; }
    if (!S.guests) { showError('guests', MSG.guests); ok = false; }
    if (!S.plan) {
      var pe = $('e-plan');
      if (pe) { pe.textContent = MSG.plan; pe.classList.add('on'); }
      ok = false;
    }
    if (!ok) return;

    var fields = {
      name: S.name, phone: S.phone, email: S.email,
      occasion: S.occasion, guests: S.guests, plan: S.plan,
      consent: S.consent
    };

    IshurLead.submitted(fields);

    /* over 900: no self-serve payment. The details already went out through
       submitted() above; here we only confirm and stop. */
    if (S.guests === 'custom') {
      IshurLead.track('quote_request', { occasion: S.occasion, plan: S.plan });
      showQuoteOk();
      return;
    }

    var url = CFG.growLink(S.guests, S.plan);
    var btn = $('pop-submit');

    if (!url) {
      /* no link configured for this combination: never a dead end */
      IshurLead.track('payment_link_missing', { tier: S.guests + '_' + S.plan });
      location.href = CFG.waLink('היי, רציתי לשלם על חבילת ' + CFG.PLANS[S.plan].name +
                                 ' ל' + CFG.guestLabel(S.guests) + ' ולא הצלחתי להשלים באתר.');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'מעבירים לתשלום'; }
    IshurLead.paymentRedirect(fields, url);
    location.href = url;
  }

  /* the over-900 confirmation: the steps step aside, a thank-you takes over */
  function showQuoteOk() {
    var inner = $('order-modal-inner');
    if (!inner) return;
    ['ws1', 'ws2'].forEach(function (id) {
      var el = $(id); if (el) el.classList.remove('active');
    });
    var prog = inner.querySelector('.wiz-progress'); if (prog) prog.hidden = true;
    var lbl = $('wiz-lbl'); if (lbl) lbl.hidden = true;

    var box = $('quote-ok');
    if (!box) {
      box = document.createElement('div');
      box.id = 'quote-ok';
      box.className = 'quote-ok';
      box.innerHTML =
        '<div class="qo-ico" aria-hidden="true">✓</div>' +
        '<h3>הפרטים נשלחו</h3>' +
        '<p>קיבלנו את הבקשה להצעה אישית למעל 900 מוזמנים.<br>נחזור אליכם בהקדם.</p>' +
        '<button type="button" class="wiz-next" data-quote-close>סגירה</button>';
      inner.appendChild(box);
      box.querySelector('[data-quote-close]').addEventListener('click', closePopup);
    }
    box.hidden = false;
  }

  function resetQuoteOk() {
    var box = $('quote-ok'); if (box) box.hidden = true;
    var inner = $('order-modal-inner');
    var prog = inner && inner.querySelector('.wiz-progress'); if (prog) prog.hidden = false;
    var lbl = $('wiz-lbl'); if (lbl) lbl.hidden = false;
  }

  /* ══ open / close ═════════════════════════════════════════════════════════ */

  function openPopup(where, pre) {
    var modal = $('order-modal');
    if (!modal) return;
    lastTrigger = document.activeElement;
    resetQuoteOk();

    S.step = 1; S.plan = ''; S.occasion = ''; S.guests = ''; S.consent = false; S.locked = false; S.quote = false; S.guestsLocked = false;
    var cb = $('f-consent'); if (cb) cb.checked = false;
    ['name', 'phone', 'email', 'occasion', 'guests', 'plan'].forEach(clearError);

    fillSelects();

    /* a fresh open starts clean: the selects match the reset state, so a
       leftover value from the previous visit cannot contradict it */
    ['f-occasion', 'f-guests'].forEach(function (id) {
      var el = $(id); if (!el) return;
      el.value = '';
      if (window.IshurSelect && el.dataset.enhanced) IshurSelect.refresh(el);
    });

    /* opened from a package button: that package rides in fixed. A chosen
       quantity rides along too; over 900 collapses the flow to one step. */
    if (pre && pre.plan) {
      S.plan = pre.plan;
      S.locked = true;
      if (pre.guests === 'custom') {
        S.guests = 'custom';
        S.quote = true;
      } else if (pre.guests) {
        /* the quantity they picked on the pricing block is final too */
        S.guests = pre.guests;
        S.guestsLocked = true;
        var gsel = $('f-guests');
        if (gsel) {
          gsel.value = pre.guests;
          if (window.IshurSelect && gsel.dataset.enhanced) IshurSelect.refresh(gsel);
        }
      }
    }

    /* locked quantity: the select steps aside for a read-only field that
       shows the number they chose */
    (function () {
      var gsel = $('f-guests');
      if (!gsel) return;
      var gWrap = gsel.closest('.isel') || gsel;
      var row = gsel.closest('.frow');
      var fixed = $('f-guests-fixed');
      if (S.guestsLocked) {
        gWrap.hidden = true;
        if (!fixed && row) {
          fixed = document.createElement('div');
          fixed.id = 'f-guests-fixed';
          fixed.className = 'fixed-field';
          var err = row.querySelector('.ferr');
          row.insertBefore(fixed, err || null);
        }
        if (fixed) { fixed.hidden = false; fixed.textContent = CFG.guestLabel(S.guests); }
      } else {
        gWrap.hidden = false;
        if (fixed) fixed.hidden = true;
      }
    })();

    /* quote mode: details and send, nothing else — no package shown */
    var ws1Plan = $('ws1-plan');
    if (ws1Plan) { ws1Plan.hidden = true; ws1Plan.innerHTML = ''; }
    var nextBtn = $('pop-next');
    var prog = document.querySelector('#order-modal-inner .wiz-progress');
    var sub1 = document.querySelector('#ws1 .pop-sub');
    if (S.quote) {
      if (nextBtn) nextBtn.textContent = 'שלח';
      if (prog) prog.hidden = true;
      if (sub1) sub1.textContent = 'השאירו פרטים ונחזור אליכם עם הצעה אישית.';
    } else {
      if (nextBtn) nextBtn.textContent = 'המשך';
      if (prog) prog.hidden = false;
      if (sub1) sub1.textContent = 'שלושה שדות ואפשר להמשיך.';
    }
    renderPlans();

    modal.classList.add('open');
    open = true;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    setStep(1, 'next');

    IshurLead.popupOpen(where);
  }

  function closePopup() {
    var box = $('order-modal-box');
    if (isSheet() && box && !REDUCED) {
      var h = box.offsetHeight || 600;
      if (cancelSheet) { cancelSheet(); cancelSheet = null; }
      cancelSheet = spring({
        from: currentY(box), to: h + 40, velocity: 0, damping: 1, response: 0.3,
        onFrame: function (v) { setY(box, v); },
        onRest: function () { finishClose(); setY(box, 0); }
      });
      return;
    }
    finishClose();
  }

  function finishClose() {
    var modal = $('order-modal');
    if (modal) modal.classList.remove('open');
    open = false;
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
  }

  /* ══ wiring ═══════════════════════════════════════════════════════════════ */

  function bind() {
    var modal = $('order-modal');
    if (!modal) return;

    fillSelects();

    var bg = $('order-modal-bg');
    if (bg) bg.addEventListener('click', closePopup);

    var closeBtn = modal.querySelector('[data-pop-close]');
    if (closeBtn) closeBtn.addEventListener('click', closePopup);

    var nextBtn = $('pop-next');
    if (nextBtn) nextBtn.addEventListener('click', next);
    var backBtn = $('pop-back');
    if (backBtn) backBtn.addEventListener('click', back);
    var subBtn = $('pop-submit');
    if (subBtn) subBtn.addEventListener('click', submit);

    /* inline validation on blur, and clear the error as soon as they retype */
    [['name', checkName], ['phone', checkPhone], ['email', checkEmail]].forEach(function (pair) {
      var el = $('f-' + pair[0]);
      if (!el) return;
      el.addEventListener('blur', function () { pair[1](); });
      el.addEventListener('input', function () { clearError(pair[0]); });
    });

    /* lead_partial: first time the phone holds a valid number and loses focus */
    var phone = $('f-phone');
    if (phone) {
      phone.addEventListener('blur', function () {
        IshurLead.partial({
          name: ($('f-name').value || ''), phone: phone.value,
          email: ($('f-email').value || ''),
          occasion: S.occasion, guests: S.guests, plan: S.plan,
          consent: S.consent
        });
      });
    }

    var consent = $('f-consent');
    if (consent) consent.addEventListener('change', function () {
      S.consent = consent.checked;
      IshurLead.track('marketing_consent', { consent: S.consent });
    });

    var occ = $('f-occasion');
    if (occ) occ.addEventListener('change', function () {
      S.occasion = occ.value;
      clearError('occasion');
      /* pre-select the package that fits this occasion, they can override —
         unless the package came fixed from the pricing block */
      if (S.occasion && !S.locked) S.plan = CFG.recommendedPlan(S.occasion);
      renderPlans();
    });

    var g = $('f-guests');
    if (g) g.addEventListener('change', function () {
      S.guests = g.value;
      clearError('guests');
      /* over 900 picked mid-flow: the details from step 1 are already in
         hand, so the request goes out right here and the flow ends */
      if (g.value === 'custom') {
        var fields = {
          name: S.name, phone: S.phone, email: S.email,
          occasion: S.occasion || '', guests: 'custom', plan: S.plan || '',
          consent: S.consent
        };
        IshurLead.submitted(fields);
        IshurLead.track('quote_request', { occasion: S.occasion || '', plan: S.plan || '' });
        showQuoteOk();
        return;
      }
      renderPlans();
    });

    /* enter moves forward from the text fields */
    ['f-name', 'f-phone', 'f-email'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); next(); }
      });
    });

    document.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') closePopup();
      if (e.key === 'Tab') trapFocus(e, modal);
    });

    bindSheet($('order-modal-box'), modal.querySelector('[data-sheet-handle]'));

    /* every CTA on the page opens the same popup */
    Array.prototype.forEach.call(document.querySelectorAll('[data-order]'), function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        openPopup(el.getAttribute('data-order') || '');
      });
    });
  }

  function trapFocus(e, modal) {
    var f = modal.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
    var vis = Array.prototype.filter.call(f, function (el) { return el.offsetParent !== null && !el.disabled; });
    if (!vis.length) return;
    var first = vis[0], last = vis[vis.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  return { open: openPopup, close: closePopup, state: S, spring: spring, project: project };
})();

/* legacy inline handlers on the page keep working */
function openOrderModal(where) { IshurPopup.open(where); }
function closeOrderModal() { IshurPopup.close(); }
