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

  var S = { step: 1, name: '', phone: '', email: '', occasion: '', guests: '', plan: '', consent: false, hostess: false, hostessLocked: false };
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

  /* The discount lives in index.html's IshurPromo module, which asks the
     Worker and answers asynchronously. This popup drew its prices from
     CFG.priceFor — the list price — so a visitor who arrived on a valid code
     saw 299 in the one place that decides whether they buy. */
  function offerNow() {
    try { return (window.IshurPromo && window.IshurPromo.offer()) || null; }
    catch (e) { return null; }
  }

  /* {original, final, saved, applies} for one package */
  function priceOf(guests, plan) {
    if (guests === 'custom') return { original: null, final: null, saved: 0, applies: false };
    return CFG.offerPrice(offerNow(), guests, plan);
  }

  /* ₪50 with ₪299 struck through beside it, or just the price */
  function priceHtml(pr) {
    if (pr.final == null) return '';
    if (!pr.applies) return '<span class="cur">₪</span>' + pr.final;
    return '<s class="plan-was">₪' + pr.original + '</s>' +
           '<span class="cur">₪</span>' + pr.final;
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
      var pr = priceOf(S.guests, k);
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
          '<span class="plan-opt-price' + (pr.applies ? ' cut' : '') + '">' +
            (pr.final != null ? priceHtml(pr) : (custom ? 'הצעה אישית' : '')) +
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

  /* The Worker answers after this script has already drawn its cards, and the
     visitor may be looking at them when it does. Redraw rather than leave a
     stale list price on screen. */
  document.addEventListener('ishur:offer', function () {
    try { renderPlans(); } catch (e) {}
  });

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
    var pr = priceOf(S.guests, S.plan);
    /* the hostess line follows the quantity: its tier and price redraw here */
    var hRow = $('f-hostess-row'), hTier = CFG.hostessTier(S.guests), hPrice = hTier ? hTier.price : null;
    if (hRow) {
      hRow.hidden = !(S.guests && S.guests !== 'custom' && hTier);
      var hp = $('f-hostess-price'), hl = $('f-hostess-tier');
      if (hp) hp.textContent = hPrice ? '₪' + hPrice : '';
      if (hl) hl.textContent = hTier ? hTier.label + ' · עד ' + hTier.max + ' רשומות' : '';
    }
    var withHost = S.hostess && hPrice != null;
    if (pr.final != null) {
      t.hidden = false;
      t.className = 'pop-total' + (pr.applies ? ' cut' : '');
      var hTravel = withHost && S.hostessTravel ? S.hostessTravel : 0;
      var total = pr.final + (withHost ? hPrice : 0) + hTravel;
      t.innerHTML = '<span class="pt-l">' + CFG.PLANS[S.plan].name + ' · ' +
                    CFG.guestLabel(S.guests) +
                    (withHost ? ' · ' + hTier.label : '') +

                    (pr.applies ? ' <em class="pt-save">חסכתם ₪' + pr.saved + '</em>' : '') +
                    '</span>' +
                    '<span class="pt-v">' +
                      (pr.applies ? '<s>₪' + (pr.original + (withHost ? hPrice : 0)) + '</s> ' : '') +
                      '₪' + total +
                    '</span>';
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
    plan:     'בחרו חבילה',
    hdate:    'באיזה תאריך האירוע?',
    hcity:    'באיזו עיר האירוע?',
    hcheck:   'בודקים זמינות לתאריך…',
    hbusy:    'אין דיילות פנויות בתאריך הזה. אפשר להמשיך בלי דיילות.',
    hlink:    'רגע, מכינים לכם את התשלום…',
    hfail:    'נשלים את זה איתכם בוואטסאפ, לחצו על הכפתור.'
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
    if (n === 3 && window.__hostessCheck) setTimeout(window.__hostessCheck, 0);
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

    var d1 = $('wd1'), d2 = $('wd2'), d3 = $('wd3'), lbl = $('wiz-lbl');
    if (d1) d1.classList.toggle('done', true);
    if (d2) d2.classList.toggle('done', n >= 2);
    if (d3) d3.classList.toggle('done', n >= 3);
    if (lbl) lbl.textContent = S.quote ? ('הצעה אישית · מעל 900 הזמנות' +
                                          (S.plan && CFG.PLANS[S.plan] ? ' · חבילת ' + CFG.PLANS[S.plan].name : ''))
                             : n === 1 ? 'שלב 1 מתוך 3 · הפרטים שלכם'
                             : n === 2 ? 'שלב 2 מתוך 3 · פרטי האירוע'
                                       : 'שלב 3 מתוך 3 · דיילות ותשלום';

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

  function back() { setStep(Math.max(1, S.step - 1), 'back'); }

  function next2() {
    var ok = true;
    if (!S.occasion && S.guests !== 'custom') { showError('occasion', MSG.occasion); ok = false; }
    if (!S.guests) { showError('guests', MSG.guests); ok = false; }
    if (!S.plan) { var pe = $('e-plan2'); if (pe) { pe.textContent = MSG.plan; pe.classList.add('on'); } ok = false; }
    if (!ok) return;
    var pe2 = $('e-plan2'); if (pe2) { pe2.textContent = ''; pe2.classList.remove('on'); }
    if (S.guests === 'custom') { submit(); return; }
    IshurLead.track('order_step3', { guests: S.guests, plan: S.plan });
    setStep(3);
    updateTotal();
  }

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
    /* the terms box is a hard gate: no consent, no payment */
    var terms = $('f-terms');
    if (terms && !terms.checked) {
      var te = $('e-terms');
      if (te) { te.textContent = 'כדי להמשיך צריך לאשר את התקנון'; te.classList.add('on'); }
      ok = false;
    }
    /* דיילות: date + city must be in, and the date must be free */
    if (S.hostess && S.guests !== 'custom' && window.__hostessReady) {
      if (!window.__hostessReady(false)) ok = false;
    }
    if (!ok) return;

    var fields = {
      name: S.name, phone: S.phone, email: S.email,
      occasion: S.occasion, guests: S.guests, plan: S.plan,
      consent: S.consent,
      hostess: S.hostess ? (CFG.hostessTier(S.guests) || {}).count || 1 : 0,
      event_date: S.hostess ? S.hDate || '' : '',
      venue_city: S.hostess ? S.hCity || '' : ''
    };

    /* timestamped consent record — lands as its own line in the lead history */
    try {
      var tsIso = new Date().toISOString();
      localStorage.setItem('ishur_terms_ok', tsIso);
      var cp = IshurLead.build('terms_accepted', fields);
      cp.event_name = 'אישר תקנון (ללא החזרים)';
      IshurLead.send(cp);
    } catch (e) {}

    IshurLead.submitted(fields);

    /* over 900: no self-serve payment. The details already went out through
       submitted() above; here we only confirm and stop. */
    if (S.guests === 'custom') {
      IshurLead.track('quote_request', { occasion: S.occasion, plan: S.plan });
      showQuoteOk();
      return;
    }

    /* one link for package + hostesses + travel when the server minted it;
       otherwise the static package+hostess link (travel paid at setup) */
    var url = S.hostess ? S.hostessPay : CFG.growLink(S.guests, S.plan);
    if (S.hostess && !url) {
      IshurLead.track('hostess_pay_whatsapp', { guests: S.guests, plan: S.plan, city: S.hCity, date: S.hDate });
      location.href = CFG.waLink('היי, רוצה לסגור ' + CFG.PLANS[S.plan].name + ' ל' + CFG.guestLabel(S.guests) + ' עם ' + ((CFG.hostessTier(S.guests) || {}).label || 'דיילות') + ' לאירוע ב-' + (S.hCity || '') + ' בתאריך ' + (S.hDate || '') + '. אפשר קישור לתשלום?');
      return;
    }

    /* A validated promo code swaps the LINK, never the price shown. The cheap
       Grow link is not in this repo at all: /promo/go holds a seat and 302s to
       it, and refuses anything that is spent, closed or sold out. Only the
       package the offer covers is redirected; everything else pays as usual.
       This has to be a real navigation — a fetch would follow the redirect
       into Grow and die on CORS. */
    try {
      if (window.IshurPromo && IshurPromo.goUrl) {
        var promoUrl = IshurPromo.goUrl(S.guests, S.plan, S.phone);
        if (promoUrl) url = promoUrl;
      }
    } catch (e) {}

    var btn = $('pop-submit');

    if (!url) {
      /* no link configured for this combination: never a dead end */
      IshurLead.track('payment_link_missing', { tier: S.guests + '_' + S.plan });
      location.href = CFG.waLink('היי, רציתי לשלם על חבילת ' + CFG.PLANS[S.plan].name +
                                 ' ל' + CFG.guestLabel(S.guests) +
                                 (S.hostess ? ' עם ' + (CFG.hostessTier(S.guests) || {}).label : '') +
                                 ' ולא הצלחתי להשלים באתר.');
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
    ['ws1', 'ws2', 'ws3'].forEach(function (id) {
      var el = $(id); if (el) el.classList.remove('active');
    });
    var prog = inner.querySelector('.wiz-progress'); if (prog) prog.hidden = true;
    var lbl = $('wiz-lbl'); if (lbl) lbl.hidden = true;

    var box = $('quote-ok');
    if (!box) {
      box = document.createElement('div');
      box.id = 'quote-ok';
      box.className = 'quote-ok';
      inner.appendChild(box);
    }
    var planLine = S.plan && CFG.PLANS[S.plan] ? ' · חבילת ' + CFG.PLANS[S.plan].name : '';
    box.innerHTML =
      '<div class="qo-ico" aria-hidden="true">✓</div>' +
      '<h3>הפרטים נשלחו</h3>' +
      '<p>קיבלנו את הבקשה להצעה אישית למעל 900 מוזמנים' + planLine + '.<br>נחזור אליכם בהקדם.</p>' +
      '<button type="button" class="wiz-next" data-quote-close>סגירה</button>';
    box.querySelector('[data-quote-close]').addEventListener('click', closePopup);
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

    S.step = 1; S.plan = ''; S.occasion = ''; S.guests = ''; S.consent = false; S.locked = false; S.quote = false; S.guestsLocked = false; S.hostess = false; S.hostessLocked = false; S.hostessTouched = false;
    var hb = $('f-hostess'); if (hb) { hb.checked = false; hb.disabled = false; }
    var hy = $('f-hostess-yes'), hn = $('f-hostess-no');
    if (hy) hy.setAttribute('aria-checked', 'false');
    if (hn) { hn.setAttribute('aria-checked', 'true'); hn.disabled = false; }
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
      /* Richard 04/10: the tapped package is pre-selected, the others stay
         visible so they can change their mind. Only a dedicated offer link locks. */
      S.locked = !!pre.hostessLocked;
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

    /* add-on card: a quantity without a package rides in, nothing locked */
    if (pre && !pre.plan && pre.guests && pre.guests !== 'custom') {
      S.guests = pre.guests;
      var gsel0 = $('f-guests');
      if (gsel0) { gsel0.value = pre.guests; if (window.IshurSelect && gsel0.dataset.enhanced) IshurSelect.refresh(gsel0); }
    }

    /* hostesses pre-ticked (pricing add-on card, or a dedicated offer link):
       the box arrives checked, and on an offer it cannot be unchecked */
    if (pre && pre.hostess) {
      S.hostess = true;
      S.hostessLocked = !!pre.hostessLocked;
      var hb2 = $('f-hostess');
      if (hb2) { hb2.checked = true; hb2.disabled = S.hostessLocked; }
      var y2 = $('f-hostess-yes'), n2 = $('f-hostess-no');
      if (y2) y2.setAttribute('aria-checked', 'true');
      if (n2) { n2.setAttribute('aria-checked', 'false'); n2.disabled = S.hostessLocked; }
    }

    /* Richard 05/10: a quoted lead arrives with everything typed for him
       (name, phone, date, city); he only picks the package and yes/no hostesses.
       Every field stays editable. */
    if (pre) {
      if (pre.name && $('f-name')) $('f-name').value = pre.name;
      if (pre.phone && $('f-phone')) $('f-phone').value = pre.phone;
      if (pre.email && $('f-email')) $('f-email').value = pre.email;
      if (pre.occasion && $('f-occasion')) { S.occasion = pre.occasion; $('f-occasion').value = pre.occasion; if (window.IshurSelect && $('f-occasion').dataset.enhanced) IshurSelect.refresh($('f-occasion')); }
      if (pre.hDate && window.__setHDate) window.__setHDate(pre.hDate);
      if (pre.hCity && $('f-hcity')) $('f-hcity').value = pre.hCity;
      var ex0 = $('f-hostess-extra'); if (ex0) ex0.hidden = !S.hostess;
      /* date + city already known: price the travel right away, on step 1 */
      if (S.hostess && pre.hDate && pre.hCity && window.__hostessCheck) setTimeout(window.__hostessCheck, 80);
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
      if (sub1) sub1.textContent = S.plan && CFG.PLANS[S.plan]
        ? 'בחרתם את חבילת ' + CFG.PLANS[S.plan].name + '. השאירו פרטים ונחזור אליכם עם הצעה אישית.'
        : 'השאירו פרטים ונחזור אליכם עם הצעה אישית.';
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
    var backBtn2 = $('pop-back2');
    if (backBtn2) backBtn2.addEventListener('click', back);
    var nextBtn2 = $('pop-next2');
    if (nextBtn2) nextBtn2.addEventListener('click', next2);
    var subBtn = $('pop-submit');
    if (subBtn) subBtn.addEventListener('click', submit);

    /* inline validation on blur, and clear the error as soon as they retype */
    [['name', checkName], ['phone', checkPhone], ['email', checkEmail]].forEach(function (pair) {
      var el = $('f-' + pair[0]);
      if (!el) return;
      el.addEventListener('blur', function () { pair[1](); });
      el.addEventListener('input', function () { clearError(pair[0]); });
    });

    /* lead_partial — Richard, 07/09: "we need to listen to every action that
       lets us reach him again later".

       Blur alone was not enough. A browser autofill fills name, phone and mail
       in one go without the visitor ever focusing the phone field, so no blur
       ever fires and a real, reachable person left no trace. On mobile, where
       autofill is the norm, that was the common case, not the rare one.

       Four triggers now, all funnelling into the same once-per-visit call:
         blur        — typed it and moved on (the original)
         change      — autofill, or a paste, committing a value
         input       — settles 1.2s after typing stops, for someone who fills
                       the phone and then just sits there
         pagehide    — closing the tab or navigating away with a valid number
       IshurLead.partial() guards itself with partialSent, so four triggers
       still produce exactly one lead row and one Meta event. */
    var phone = $('f-phone');
    if (phone) {
      var fireP = function () {
        IshurLead.partial({
          name: ($('f-name').value || ''), phone: phone.value,
          email: ($('f-email').value || ''),
          occasion: S.occasion, guests: S.guests, plan: S.plan,
          consent: S.consent
        });
      };
      var idle = null;
      phone.addEventListener('blur', fireP);
      phone.addEventListener('change', fireP);
      phone.addEventListener('input', function () {
        clearTimeout(idle);
        idle = setTimeout(fireP, 1200);
      });
      /* the last chance: they are leaving. pagehide fires on mobile where
         beforeunload does not, and the beacon in lead.js uses keepalive. */
      window.addEventListener('pagehide', fireP);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') fireP();
      });
      /* autofill often lands before our listeners are attached */
      setTimeout(fireP, 800);
    }

    var consent = $('f-consent');
    if (consent) consent.addEventListener('change', function () {
      S.consent = consent.checked;
      IshurLead.track('marketing_consent', { consent: S.consent });
    });

    var terms = $('f-terms');
    if (terms) terms.addEventListener('change', function () {
      var te = $('e-terms');
      if (terms.checked && te) { te.textContent = ''; te.classList.remove('on'); }
      IshurLead.track('terms_checkbox', { checked: terms.checked });
    });

    /* returning visitor: the details they typed last time come back by
       themselves; every keystroke keeps the stored copy fresh */
    try {
      var prof = JSON.parse(localStorage.getItem('ishur_profile') || '{}');
      [['f-name', 'name'], ['f-phone', 'phone'], ['f-email', 'email']].forEach(function (pair) {
        var el = $(pair[0]);
        if (!el) return;
        if (!el.value && prof[pair[1]]) el.value = prof[pair[1]];
        el.addEventListener('input', function () {
          try {
            var p2 = JSON.parse(localStorage.getItem('ishur_profile') || '{}');
            p2[pair[1]] = el.value;
            localStorage.setItem('ishur_profile', JSON.stringify(p2));
          } catch (e) {}
        });
      });
    } catch (e) {}

    var occ = $('f-occasion');
    if (occ) occ.addEventListener('change', function () {
      S.occasion = occ.value;
      clearError('occasion');
      /* pre-select the package that fits this occasion, they can override —
         unless the package came fixed from the pricing block */
      if (S.occasion && !S.locked && !S.plan) S.plan = CFG.recommendedPlan(S.occasion);
      renderPlans();
    });

    var hbx = $('f-hostess');
    function setHost(on, touched) {
      if (S.hostessLocked && !on) return;
      S.hostess = !!on;
      if (touched) S.hostessTouched = true;
      if (hbx) hbx.checked = S.hostess;
      var y = $('f-hostess-yes'), nn = $('f-hostess-no');
      if (y) y.setAttribute('aria-checked', S.hostess ? 'true' : 'false');
      if (nn) nn.setAttribute('aria-checked', S.hostess ? 'false' : 'true');
      /* Richard 05/10: "yes" opens two questions (date, city) right below;
         the pay button stays dim until both are in and the date is free */
      var ex = $('f-hostess-extra');
      if (ex) ex.hidden = !S.hostess;
      if (!S.hostess) { S.hostessPay = ''; S.hostessTravel = 0; S.hostessAvail = null; S.hostessTries = 0; S.hostessWa = false; clearError('hdate'); clearError('hcity'); setAvail(''); }
      else hostessCheck();
      IshurLead.track('hostess_toggle', { on: S.hostess, guests: S.guests || '' });
      updateTotal();
      paintPayBtn();
    }
    window.__setHost = setHost;
    window.__hostessReady = function (quiet) { return hostessReady(quiet); };
    window.__hostessCheck = function () { if (S.hostess) hostessCheck(); paintPayBtn(); };

    /* ── date picker, styled like the rest of the form (no native widget) ── */
    var HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    var HE_DAYS = ['א','ב','ג','ד','ה','ו','ש'];
    function hdateIso() { var f = $('f-hdate'); return (f && f.dataset.iso) || ''; }
    function setHDate(iso) {
      var f = $('f-hdate'); if (!f) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) { f.dataset.iso = ''; f.value = ''; return; }
      f.dataset.iso = iso;
      var p = iso.split('-'); f.value = p[2] + '.' + p[1] + '.' + p[0];
      clearError('hdate');
    }
    window.__setHDate = setHDate;
    (function () {
      var f = $('f-hdate'), dp = $('f-hdate-dp'); if (!f || !dp) return;
      var view = new Date(); view.setDate(1);
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      function todayIso() { var t = new Date(); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); }
      function draw() {
        var y = view.getFullYear(), m = view.getMonth();
        var first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
        var cur = hdateIso(), tod = todayIso();
        var h = '<div class="dp-h"><button type="button" class="dp-nav" data-d="-1" aria-label="חודש קודם">‹</button><span>' + HE_MONTHS[m] + ' ' + y + '</span><button type="button" class="dp-nav" data-d="1" aria-label="חודש הבא">›</button></div><div class="dp-g">';
        for (var i = 0; i < 7; i++) h += '<span class="dp-dn">' + HE_DAYS[i] + '</span>';
        for (var b = 0; b < first; b++) h += '<span></span>';
        for (var d = 1; d <= days; d++) {
          var iso = y + '-' + pad(m + 1) + '-' + pad(d);
          var dis = iso < tod;
          h += '<button type="button" class="dp-d' + (iso === cur ? ' on' : '') + (iso === tod ? ' today' : '') + '" data-iso="' + iso + '"' + (dis ? ' disabled' : '') + '>' + d + '</button>';
        }
        dp.innerHTML = h + '</div>';
      }
      function openDp() { var c = hdateIso(); if (c) { view = new Date(c.slice(0, 4), Number(c.slice(5, 7)) - 1, 1); } draw(); dp.hidden = false; f.setAttribute('aria-expanded', 'true'); }
      function closeDp() { dp.hidden = true; f.setAttribute('aria-expanded', 'false'); }
      f.addEventListener('click', function () { dp.hidden ? openDp() : closeDp(); });
      f.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dp.hidden ? openDp() : closeDp(); } if (e.key === 'Escape') closeDp(); });
      dp.addEventListener('click', function (e) {
        var nav = e.target.closest('.dp-nav');
        if (nav) { view.setMonth(view.getMonth() + Number(nav.dataset.d)); draw(); return; }
        var d = e.target.closest('.dp-d');
        if (d && !d.disabled) { setHDate(d.dataset.iso); closeDp(); hostessCheck(); }
      });
      document.addEventListener('click', function (e) { if (!dp.hidden && !dp.contains(e.target) && e.target !== f) closeDp(); });
    })();

    function setAvail(text, cls) {
      var a = $('f-hostess-avail'); if (!a) return;
      a.textContent = text || ''; a.className = 'addon-q-avail' + (cls ? ' ' + cls : '');
      a.hidden = !text;
    }
    /* true when the hostess questions are complete and the date is free.
       quiet=true only reads; otherwise it marks the missing field in red. */
    function hostessReady(quiet) {
      if (!S.hostess) return true;
      var d = hdateIso(), c = (($('f-hcity') && $('f-hcity').value) || '').trim();
      var ok = true;
      if (!d) { if (!quiet) showError('hdate', MSG.hdate); ok = false; } else clearError('hdate');
      if (c.length < 2) { if (!quiet) showError('hcity', MSG.hcity); ok = false; } else clearError('hcity');
      if (!ok) return false;
      if (S.hostessAvail === false) { if (!quiet) setAvail(MSG.hbusy, 'bad'); return false; }
      if (S.hostessAvail !== true) { if (!quiet) setAvail(MSG.hcheck, 'wait'); return false; }
      /* the price the customer saw must be the price on the Grow page: only
         the per-customer link (package + hostesses + travel) is allowed */
      if (!S.hostessPay && !S.hostessWa) { if (!quiet) { setAvail(MSG.hlink, 'wait'); if (!S.hostessPending) hostessCheck(); } return false; }
      return true;
    }
    function paintPayBtn() {
      var btn = $('pop-submit'); if (!btn) return;
      btn.classList.toggle('dim', S.hostess && !hostessReady(true));
    }
    /* no link yet: keep a calm line, retry quietly a few times, and if it still
       fails hand the customer to WhatsApp with the order ready. Never an error. */
    function availText() { var nH = (CFG.hostessTier(S.guests) || {}).count || 1; return '✓ ' + (nH === 1 ? 'יש דיילת פנויה' : 'יש ' + nH + ' דיילות פנויות') + ' ב-' + S.hDate.split('-').reverse().join('.'); }
    function hostessSoft(knownFree) {
      S.hostessTries = (S.hostessTries || 0) + 1;
      S.hostessPay = '';
      if (S.hostessTries < 6) { S.hostessAvail = knownFree ? true : null; setAvail(knownFree ? availText() : MSG.hcheck, knownFree ? 'ok' : 'wait'); setTimeout(hostessCheck, 2000); }
      else { S.hostessAvail = true; S.hostessWa = true; setAvail(MSG.hfail, ''); }
      paintPayBtn(); updateTotal();
    }
    var hostessSeq = 0;
    function hostessCheck() {
      S.hDate = hdateIso();
      S.hCity = (($('f-hcity') && $('f-hcity').value) || '').trim();
      S.hostessAvail = null; S.hostessPay = '';
      if (!S.hDate || S.hCity.length < 2 || !S.guests || S.guests === 'custom' || !S.plan) { setAvail(''); paintPayBtn(); updateTotal(); return; }
      /* price first, from the city, before the server answers: the client sees
         the travel line in the total the moment the city is typed */
      try {
        var tierN = (CFG.hostessTier(S.guests) || {}).count || 1;
        S.hostessTravel = CFG.hostessIsCenter(S.hCity) ? 0 : (CFG.HOSTESS.travelFor ? CFG.HOSTESS.travelFor(tierN) : CFG.HOSTESS.travel);
      } catch (e) {}
      updateTotal();
      var seq = ++hostessSeq;
      setAvail(MSG.hcheck, 'wait'); paintPayBtn();
      var body = { date: S.hDate, city: S.hCity, guests: S.guests, plan: S.plan, name: ($('f-name') && $('f-name').value) || S.name || '', phone: ($('f-phone') && $('f-phone').value) || S.phone || '', occasion: S.occasion || '' };
      var call = function (withLink) { return fetch(CFG.endpoint('hostess-check'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ link: withLink }, body)) }).then(function (r) { return r.json(); }); };
      /* step 1: availability + price, fast. step 2: the link, quietly. */
      S.hostessPending = true;
      call(false)
        .then(function (j) {
          if (seq !== hostessSeq) return null;
          if (j && j.ok && j.available) {
            S.hostessAvail = true; S.hostessTravel = Number(j.travel) || 0; setAvail(availText(), 'ok'); paintPayBtn(); updateTotal();
            return call(true);
          }
          return j;
        })
        .then(function (j) {
          if (seq !== hostessSeq || j === null) return;
          S.hostessPending = false;
          if (!j || !j.ok) { hostessSoft(); return; }
          S.hostessAvail = !!j.available;
          if (j.available) {
            S.hostessTravel = Number(j.travel) || 0; S.hostessPay = j.url || '';
            if (!S.hostessPay) { hostessSoft(true); return; }
            S.hostessTries = 0;
            setAvail(availText(), 'ok');
          } else {
            setAvail(MSG.hbusy, 'bad');
          }
          IshurLead.track('hostess_check', { available: !!j.available, travel: j.travel || 0, city: S.hCity, date: S.hDate });
          paintPayBtn(); updateTotal();
        })
        .catch(function () { if (seq !== hostessSeq) return; S.hostessPending = false; hostessSoft(S.hostessAvail === true); });
    }
    (function () {
      var el = $('f-hcity'); if (!el) return;
      el.addEventListener('change', hostessCheck);
      el.addEventListener('blur', hostessCheck);
      el.addEventListener('input', function () { clearError('hcity'); });
    })();
    var skipBtn = $('f-hostess-skip');
    if (skipBtn) skipBtn.addEventListener('click', function () { setHost(false, true); });
    /* the dim button still listens: a hover or a click explains what is missing */
    var payBtn = $('pop-submit');
    if (payBtn) payBtn.addEventListener('mouseenter', function () { if (S.hostess) hostessReady(false); });
    var yBtn = $('f-hostess-yes'), nBtn = $('f-hostess-no');
    if (yBtn) yBtn.addEventListener('click', function () { setHost(true, true); });
    if (nBtn) nBtn.addEventListener('click', function () { setHost(false, true); });

    var g = $('f-guests');
    if (g) g.addEventListener('change', function () {
      S.guests = g.value;
      clearError('guests');
      /* Richard 04/10: hostesses start on "no" for every size; the customer opts in. */

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
