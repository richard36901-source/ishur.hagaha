/* ============================================================================
   ishur.io · guest-card.js · the guest card (Richard 25/11/2026)
   ----------------------------------------------------------------------------
   IshurGuestCard.open({ token, guest_id, name? })  — any admin page.
   Or markup: <button data-guest-card data-token="…" data-guest="g123">דנה כהן</button>
   (a delegated click opens the card; IshurGuestCard.bind() is called on load).

   Everything goes through POST /api/guest-card (worker/guest-card.js):
     read → every WhatsApp message to/from the guest, every call (our player + transcript),
            what is planned for the guest (sends + the next call)
     actions → cancel the next send / the next call (and undo), stop this guest for this event,
               stop everywhere (and undo). Each one is logged by the Worker.
   Needs assets/rec-player.js on the page for the recordings.
   Light/dark: the page's own colour variables, with fallbacks.
   ========================================================================== */
(function () {
  if (window.IshurGuestCard) return;
  var CSS = '.gcard{border:1px solid var(--line,#E1E4DE);border-radius:8px;background:var(--card,#fff);color:var(--ink,#1B2620);padding:0;width:min(96vw,640px);max-height:90vh;margin:auto;direction:rtl;font-family:inherit}' +
    '.gcard::backdrop{background:rgba(0,0,0,.5)}' +
    '.gcard .gh{display:flex;gap:.6rem;align-items:flex-start;padding:.8rem 1rem;border-bottom:1px solid var(--line,#E1E4DE);position:sticky;top:0;background:var(--card,#fff);z-index:2}' +
    '.gcard .gh h2{flex:1;font-size:1.02rem;margin:0;overflow-wrap:anywhere}.gcard .gh small{display:block;font-weight:400;color:var(--ink3,#7F8C86);font-size:.78rem}' +
    '.gcard .gx{font:inherit;border:1px solid var(--line,#E1E4DE);background:var(--card,#fff);color:var(--ink,#1B2620);border-radius:8px;padding:.2rem .6rem;cursor:pointer}' +
    '.gcard .gb{padding:.7rem 1rem 1rem;overflow:auto}' +
    '.gcard h3{font-size:.8rem;color:var(--ink3,#7F8C86);font-weight:600;margin:1rem 0 .4rem}.gcard h3:first-child{margin-top:0}' +
    '.gcard .pl{display:flex;align-items:center;gap:.5rem;border:1px solid var(--line,#E1E4DE);border-radius:8px;padding:.45rem .6rem;margin:.3rem 0;font-size:.84rem}' +
    '.gcard .pl .w{flex:1;min-width:0}.gcard .pl .w small{display:block;color:var(--ink3,#7F8C86);font-size:.74rem;direction:ltr;text-align:right;overflow-wrap:anywhere}' +
    '.gcard .pl.off{opacity:.65}' +
    '.gcard .ab{font:inherit;font-size:.78rem;font-weight:600;border:1px solid var(--line,#E1E4DE);background:var(--card,#fff);color:var(--ink,#1B2620);border-radius:8px;padding:.3rem .6rem;cursor:pointer;white-space:nowrap}' +
    '.gcard .ab.warn{border-color:var(--no,var(--warn,#A8402F));color:var(--no,var(--warn,#A8402F))}.gcard .ab.sure{background:var(--no,var(--warn,#A8402F));color:#fff}' +
    '.gcard .ab:disabled{opacity:.5;cursor:wait}' +
    '.gcard .msg{max-width:86%;border-radius:8px;padding:.4rem .6rem;margin:.25rem 0;font-size:.85rem;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line,#E1E4DE)}' +
    '.gcard .msg.in{background:var(--soft,var(--paper,#F4F2EC));margin-inline-end:auto}.gcard .msg.out{margin-inline-start:auto}' +
    '.gcard .msg time{display:block;font-size:.68rem;color:var(--ink3,#7F8C86);margin-top:.15rem}' +
    '.gcard .cl{border:1px solid var(--line,#E1E4DE);border-radius:8px;padding:.55rem .65rem;margin:.4rem 0}' +
    '.gcard .cl .ct{font-size:.8rem;color:var(--ink2,#4E5C55)}' +
    '.gcard details summary{cursor:pointer;font-size:.8rem;color:var(--ink2,#4E5C55);margin-top:.3rem}' +
    '.gcard pre{font:inherit;font-size:.82rem;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft,var(--paper,#F4F2EC));border-radius:8px;padding:.5rem .6rem;margin:.3rem 0 0}' +
    '.gcard .gf{display:flex;gap:.4rem;flex-wrap:wrap;border-top:1px solid var(--line,#E1E4DE);padding:.7rem 1rem;position:sticky;bottom:0;background:var(--card,#fff)}' +
    '.gcard .note{font-size:.8rem;color:var(--ink3,#7F8C86)}.gcard .stop{font-size:.8rem;color:var(--no,var(--warn,#A8402F));font-weight:600;margin:.2rem 0}' +
    '.gcard .ok{font-size:.8rem;color:var(--ok,var(--good,#2E7D5B));margin:.3rem 0}';
  var dlg = null, cur = null;
  function $q(s) { return dlg.querySelector(s); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pretty(p) { var d = String(p || '').replace(/\D/g, ''); if (d.slice(0, 3) === '972') d = '0' + d.slice(3); return d.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'); }
  function when(ts) { var d = new Date(ts); if (isNaN(d)) return ''; return d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function dm(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] : ''; }
  function api(body) {
    var key = '', sess = '';
    try { key = localStorage.getItem('ishur_calls_key') || ''; sess = localStorage.getItem('ishur_session') || ''; } catch (e) {}
    var payload = Object.assign({ admin_key: key }, sess ? { session: sess } : {}, body);
    if (window.IshurGuard && IshurGuard.stamp) payload = IshurGuard.stamp(payload);
    var url = window.ISHUR_CONFIG ? ISHUR_CONFIG.endpoint('guest-card') : 'https://go.ishur.io/api/guest-card';
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function ensure() {
    if (dlg) return;
    if (!document.getElementById('gcard-css')) { var st = document.createElement('style'); st.id = 'gcard-css'; st.textContent = CSS; document.head.appendChild(st); }
    dlg = document.createElement('dialog'); dlg.className = 'gcard'; dlg.setAttribute('aria-label', 'כרטיס אורח');
    dlg.innerHTML = '<div class="gh"><h2 id="gcName"></h2><button class="gx" type="button" data-close aria-label="סגירה">✕</button></div><div class="gb" id="gcBody"></div><div class="gf" id="gcFoot"></div>';
    document.body.appendChild(dlg);
    if (window.IshurRec) IshurRec.bind(dlg);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('close', function () { if (window.IshurRec) IshurRec.pauseAll(dlg); cur = null; });
  }
  var LABELS = { 'no-planned-send': 'אין שליחה מתוכננת לבטל', 'already-closed': 'השליחה הזאת כבר נסגרה', 'no-planned-call': 'אין שיחה מתוכננת לבטל', 'not-skipped': 'אין מה להחזיר' };
  function paint(j) {
    var g = j.guest || {}, ev = j.event || {}, pl = j.planned || {}, st = j.stops || {};
    $q('#gcName').innerHTML = esc(g.name || cur.name || 'אורח') + '<small>' + esc(pretty(g.phone)) + ' · ' + esc(g.rsvp ? g.rsvp + (g.party ? ' ' + g.party : '') : 'לא ענו') + (g.table ? ' · שולחן ' + esc(g.table) : '') + ' · ' + esc(ev.name || '') + (ev.date ? ' · ' + dm(ev.date) : '') + '</small>';
    var h = '';
    if (st.block) h += '<div class="stop">חסום לכל ההודעות והשיחות, בכל האירועים</div>';
    else if (st.wrong) h += '<div class="stop">לא שולחים ולא מתקשרים לאורח הזה באירוע הזה</div>';
    if (st.optout) h += '<div class="stop">האורח ביקש הסרה מוואטסאפ (שיחות עדיין מותרות)</div>';
    if (st.nocall) h += '<div class="stop">האורח ביקש שלא יתקשרו אליו</div>';
    h += '<h3>מה מתוכנן</h3>';
    var sends = pl.sends || [];
    h += sends.length ? sends.map(function (s, i) {
      return '<div class="pl' + (s.held || s.dropped ? ' off' : '') + '"><div class="w">' + esc(dm(s.day)) + ' · ' + esc(s.type_he) + (s.held ? ' · מוקפא' : '') + (s.dropped ? ' · לא יישלח (עבר המועד)' : '') + '<small>' + esc(s.template || '') + '</small></div>' +
        (i === 0 && !s.dropped ? '<button class="ab" type="button" data-act="cancel_send" data-type="' + esc(s.type) + '">ביטול השליחה הזאת</button>' : '') + '</div>';
    }).join('') : '<div class="note">אין שליחות מתוכננות לאורח הזה.</div>';
    (st.skips || []).forEach(function (s) { h += '<div class="pl off"><div class="w">בוטל ידנית: ' + esc({ w1: 'הזמנה', w2: 'תזכורת', w3: 'שליחה נוספת', daybefore: 'יום-לפני', eventday: 'יום האירוע', thanks: 'תודה' }[s.type] || s.type) + '</div><button class="ab" type="button" data-act="undo_send" data-type="' + esc(s.type) + '">החזרה</button></div>'; });
    var c = pl.call || {};
    if (c.in_queue) h += '<div class="pl' + (c.next_at ? '' : ' off') + '"><div class="w">שיחה: ' + (c.next_at ? 'הבאה ' + esc(c.next_he) : 'לא תתבצע') + ' · ניסיון ' + (Number(c.tries || 0) + 1) + '/' + esc(c.max_tries) + (c.blocked_he ? '<small style="direction:rtl">' + esc(c.blocked_he) + '</small>' : '') + '</div>' +
      (c.next_at ? '<button class="ab" type="button" data-act="cancel_call">ביטול השיחה הבאה</button>' : '') + '</div>';
    else h += '<div class="note">האורח לא בתור השיחות.</div>';
    if (st.call_skip_day) h += '<div class="pl off"><div class="w">שיחה בוטלה ידנית ל-' + esc(dm(st.call_skip_day)) + '</div><button class="ab" type="button" data-act="undo_call">החזרה</button></div>';
    var calls = j.calls || [];
    h += '<h3>שיחות (' + calls.length + ')</h3>';
    h += calls.length ? calls.map(function (x) {
      return '<div class="cl"><div class="ct">' + esc(when(x.ts)) + ' · ' + esc(x.duration_s || 0) + ' שניות · ' + esc(x.outcome || x.answer || x.disconnection || 'ללא תוצאה') + '</div>' +
        (x.has_recording && window.IshurRec ? IshurRec.html({ id: x.call_id, name: x.recording_name, duration_s: x.duration_s }) : '<div class="note">אין הקלטה</div>') +
        (x.summary ? '<div class="note">' + esc(x.summary) + '</div>' : '') +
        (x.transcript ? '<details><summary>תמלול</summary><pre dir="auto">' + esc(String(x.transcript).replace(/^Agent:/gm, 'שיר:').replace(/^User:/gm, 'אורח:')) + '</pre></details>' : '') + '</div>';
    }).join('') : '<div class="note">לא נמצאו שיחות ב-14 הימים האחרונים.</div>';
    var wa = j.whatsapp || [];
    h += '<h3>וואטסאפ (' + wa.length + ')</h3>';
    h += wa.length ? wa.map(function (m) {
      return '<div class="msg ' + (m.dir === 'in' ? 'in' : 'out') + '" dir="auto">' + esc(m.text || '(' + m.type + ')') + '<time>' + (m.dir === 'in' ? 'האורח' : esc(m.who || 'אנחנו')) + ' · ' + esc(when(m.ts)) + (m.ok ? (m.status ? ' · ' + esc({ delivered: 'נמסרה', read: 'נקראה', sent: 'נשלחה', failed: 'לא נמסרה' }[m.status] || m.status) : '') : ' · לא נמסרה') + '</time></div>';
    }).join('') : '<div class="note">אין הודעות עם האורח הזה.</div>';
    $q('#gcBody').innerHTML = h;
    $q('#gcFoot').innerHTML = (st.wrong ? '<button class="ab" type="button" data-act="resume_event">להחזיר באירוע הזה</button>' : '<button class="ab warn" type="button" data-act="stop_event" data-confirm>לא לשלוח לאורח הזה יותר באירוע הזה</button>') +
      (st.block ? '<button class="ab" type="button" data-act="resume_all">לשחרר את החסימה</button>' : '<button class="ab warn" type="button" data-act="stop_all" data-confirm>בכלל (כל האירועים)</button>') +
      '<span class="note" id="gcMsg" role="status" aria-live="polite"></span>';
  }
  function load() {
    var c = cur; $q('#gcBody').innerHTML = '<div class="note">טוען…</div>'; $q('#gcFoot').innerHTML = '';
    return api({ token: c.token, guest_id: c.guest_id }).then(function (j) {
      if (cur !== c) return;
      if (!j || !j.ok) { $q('#gcBody').innerHTML = '<div class="note">לא הצלחנו לטעון את הכרטיס. נסו שוב בעוד רגע.</div>'; return; }
      paint(j);
    }).catch(function () { if (cur === c) $q('#gcBody').innerHTML = '<div class="note">אין חיבור כרגע. נסו שוב בעוד רגע.</div>'; });
  }
  function onClick(e) {
    if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
    var b = e.target.closest('[data-act]'); if (!b || !cur) return;
    if (b.hasAttribute('data-confirm') && !b.classList.contains('sure')) { b.classList.add('sure'); b.dataset.txt = b.textContent; b.textContent = 'לחצו שוב לאישור'; setTimeout(function () { if (b.isConnected) { b.classList.remove('sure'); b.textContent = b.dataset.txt; } }, 4000); return; }
    b.disabled = true;
    var c = cur, body = { token: c.token, guest_id: c.guest_id, action: b.dataset.act, who: c.who || '' };
    if (b.dataset.type) body.type = b.dataset.type;
    api(body).then(function (j) {
      if (cur !== c) return;
      if (!j || !j.ok) { b.disabled = false; var m = $q('#gcMsg'); if (m) m.textContent = LABELS[j && j.error] || 'לא נשמר, נסו שוב'; return; }
      load().then(function () { var m = $q('#gcMsg'); if (m) { m.className = 'ok'; m.textContent = 'נשמר: ' + j.done_he; } });
      try { window.dispatchEvent(new CustomEvent('ishur:guestcard', { detail: { token: c.token, guest_id: c.guest_id, action: body.action } })); } catch (x) {}
    }).catch(function () { b.disabled = false; });
  }
  function open(o) {
    if (!o || !o.token || !o.guest_id) return;
    ensure(); cur = { token: o.token, guest_id: String(o.guest_id), name: o.name || '', who: o.who || '' };
    $q('#gcName').textContent = cur.name || 'אורח';
    if (!dlg.open) dlg.showModal();
    load();
  }
  function bind(root) {
    root = root || document; if (root.__gcard) return; root.__gcard = true;
    root.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-guest-card]'); if (!t) return;
      e.preventDefault(); e.stopPropagation();
      open({ token: t.getAttribute('data-token'), guest_id: t.getAttribute('data-guest'), name: t.textContent.trim() });
    }, true);
  }
  window.IshurGuestCard = { open: open, bind: bind };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { bind(document); }); else bind(document);
})();
