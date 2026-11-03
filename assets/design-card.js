/* 03/11 · invitation design flow card for dashboard.html (docs/DESIGN-FLOW-PWA-2026-11-03.md)
   Shown only when the event's design is paid. render(state) is pure (the smoke
   test calls it from node); mount() wires it to /api/design-flow + /api/media. */
(function (root) {
  'use strict';
  var MAX_REFS = 5;
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function day(iso) { try { return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }); } catch (e) { return ''; } }
  function preview(v) {
    if (!v) return '';
    if (/pdf/.test(v.mime || '')) return '<a class="dz-pdf" href="' + esc(v.url) + '" target="_blank" rel="noopener">📄 פתיחת גרסה ' + v.n + ' (PDF)</a>';
    return '<a href="' + esc(v.url) + '" target="_blank" rel="noopener"><img class="dz-img" src="' + esc(v.url) + '" alt="עיצוב ההזמנה, גרסה ' + v.n + '"></a>';
  }
  var CSS = '.dz-p{margin:0 0 .6rem;font-size:.88rem;color:var(--ink2)}.dz-ok{background:var(--green4);color:var(--green2);border-radius:10px;padding:.6rem .8rem;font-size:.88rem;margin:0 0 .6rem}' +
    '.dz-ta{width:100%;box-sizing:border-box;min-height:110px;border:1px solid var(--bdr);border-radius:10px;padding:.6rem .7rem;font:inherit;font-size:.9rem;background:var(--card);color:var(--ink);resize:vertical}' +
    '.dz-refs{display:flex;gap:.45rem;flex-wrap:wrap;margin:.5rem 0}.dz-ref{position:relative;width:64px;height:64px;border-radius:9px;overflow:hidden;border:1px solid var(--bdr)}.dz-ref img{width:100%;height:100%;object-fit:cover}' +
    '.dz-ref button{position:absolute;top:2px;left:2px;border:none;border-radius:50%;width:20px;height:20px;line-height:18px;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;font-size:.8rem;padding:0}' +
    '.dz-row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:.6rem}.dz-img{display:block;max-width:100%;max-height:360px;border-radius:12px;border:1px solid var(--bdr);margin:0 auto}' +
    '.dz-pdf{display:inline-block;padding:.7rem 1rem;border:1px solid var(--bdr);border-radius:10px;color:var(--green);text-decoration:none}.dz-cnt{font-size:.8rem;color:var(--ink3)}' +
    '.dz-hist{margin-top:.7rem;font-size:.82rem;color:var(--ink3)}.dz-hist summary{cursor:pointer}.dz-hist li{margin:.25rem 0}.dz-msg{font-size:.8rem;color:var(--ink3);min-height:1em}.dz-msg.err{color:var(--err)}' +
    '.dz-sec{background:var(--green4);color:var(--green2)}.dz-add{display:inline-flex;align-items:center;gap:.35rem;border:1px dashed var(--bdr2);background:none;border-radius:10px;padding:.45rem .8rem;font:inherit;font-size:.82rem;cursor:pointer;color:var(--ink2)}';

  /* state = /api/design-flow 'state' answer + ui: { editing, changing, refs:[{id,url}], msg, err, busy } */
  function render(s, ui) {
    ui = ui || {};
    if (!s || !s.paid) return '';
    var vs = s.versions || [], last = vs[vs.length - 1], h = '';
    var counter = '<span class="dz-cnt" data-dz="counter">סבבי תיקונים: ' + (s.rounds_used || 0) + ' מתוך ' + (s.rounds_total || 0) + '</span>';
    if (!vs.length) {
      var hasBrief = !!(s.brief && s.brief.text);
      if (hasBrief && !ui.editing) {
        h += '<p class="dz-ok" data-dz="sent">נשלח, נחזור עם עיצוב ראשון ✨</p>' +
          '<p class="dz-p" style="white-space:pre-wrap">' + esc(s.brief.text) + '</p>' +
          ((s.brief.refs || []).length ? '<div class="dz-refs">' + s.brief.refs.map(function (r) { return '<span class="dz-ref"><img src="' + esc(r.url) + '" alt="תמונת השראה"></span>'; }).join('') + '</div>' : '') +
          (s.brief_editable ? '<div class="dz-row"><button type="button" class="buy dz-sec" data-act="edit">עריכת הבקשה</button></div>' : '');
      } else {
        var refs = ui.refs || (s.brief && s.brief.refs) || [];
        h += '<p class="dz-p"><b>מה תרצו בהזמנה?</b> שמות, סגנון, צבעים, נוסח, וכל מה שחשוב לכם. אפשר לצרף עד ' + MAX_REFS + ' תמונות השראה.</p>' +
          '<textarea class="dz-ta" id="dzText" maxlength="3000" placeholder="לדוגמה: דנה ואבי · 12.12 · אולם הגן · סגנון מינימליסטי, ירוק זית ושמנת · נוסח חם וקליל">' + esc(ui.text != null ? ui.text : (s.brief && s.brief.text) || '') + '</textarea>' +
          '<div class="dz-refs">' + refs.map(function (r, i) { return '<span class="dz-ref"><img src="' + esc(r.url) + '" alt="תמונת השראה ' + (i + 1) + '"><button type="button" data-act="unref" data-i="' + i + '" aria-label="הסרת התמונה">×</button></span>'; }).join('') + '</div>' +
          '<div class="dz-row">' + (refs.length < MAX_REFS ? '<input type="file" id="dzFile" accept="image/jpeg,image/png,image/webp" multiple hidden><button type="button" class="dz-add" data-act="pick">＋ תמונות השראה (' + refs.length + '/' + MAX_REFS + ')</button>' : '') +
          '<button type="button" class="buy" data-act="send"' + (ui.busy ? ' disabled' : '') + '>' + (hasBrief ? 'שמירת השינויים' : 'שליחה') + '</button></div>';
      }
    } else {
      h += preview(last) + (last.note ? '<p class="dz-p" style="margin-top:.5rem">💬 ' + esc(last.note) + '</p>' : '');
      if (s.status === 'awaiting_client') {
        h += '<p class="dz-p" style="margin-top:.6rem">גרסה ' + last.n + ' מחכה לכם. מה דעתכם?</p>';
        if (ui.changing) {
          h += '<textarea class="dz-ta" id="dzComment" maxlength="2000" placeholder="מה לשנות? כמה שיותר מדויק, כך נדייק בסבב אחד">' + esc(ui.comment || '') + '</textarea>' +
            '<div class="dz-row"><button type="button" class="buy" data-act="changes-send"' + (ui.busy ? ' disabled' : '') + '>שליחת ההערות</button><button type="button" class="buy dz-sec" data-act="changes-cancel">ביטול</button>' + counter + '</div>';
        } else {
          h += '<div class="dz-row"><button type="button" class="buy" data-act="approve"' + (ui.busy ? ' disabled' : '') + '>מאשר/ת ✅</button>' +
            (s.can_request_changes ? '<button type="button" class="buy dz-sec" data-act="changes">יש לי הערות ✍️</button>' : '') + counter + '</div>';
          if (!s.can_request_changes) h += '<p class="dz-p" style="margin-top:.6rem">סבבי התיקונים הכלולים נוצלו. אפשר להוסיף סבב בעוד ₪' + esc(s.round_price || 49) + '.</p>';
          var freeLeft = !s.rounds_paid && !s.free_claimed && (s.rounds_used || 0) < (s.rounds_free || 0);
          h += '<div class="dz-row"><button type="button" class="dz-add" data-act="buy"' + (ui.busy ? ' disabled' : '') + '>רכישת סבב נוסף' + (freeLeft ? ' · הראשון עלינו' : ' · ₪' + esc(s.round_price || 49)) + '</button></div>';
        }
      } else if (s.status === 'changes_requested') {
        h += '<p class="dz-ok" style="margin-top:.6rem">קיבלנו את ההערות, נחזור עם גרסה מתוקנת 🙌</p><div class="dz-row">' + counter + '</div>';
      } else if (s.status === 'approved') {
        h += '<p class="dz-ok" style="margin-top:.6rem" data-dz="approved">אישרתם ✅ אנחנו מכינים את הקבצים הסופיים.</p>';
      } else if (s.status === 'done') {
        h += '<p class="dz-ok" style="margin-top:.6rem">העיצוב מוכן 🎉</p>';
      }
      if (s.free_claimed && !s.rounds_paid && (s.rounds_used || 0) < (s.rounds_free || 0) && s.status === 'awaiting_client') h += '<p class="dz-cnt">סבב התיקונים שלכם פעיל · 1/1 חינם</p>';
      if (vs.length > 1 || (s.comments || []).length) {
        h += '<details class="dz-hist"><summary>היסטוריה (' + vs.length + ' גרסאות)</summary><ul>' +
          vs.slice().reverse().map(function (v) {
            var c = (s.comments || []).filter(function (x) { return x.v === v.n; }).map(function (x) { return '<br>✍️ ' + esc(x.text); }).join('');
            return '<li><a href="' + esc(v.url) + '" target="_blank" rel="noopener">גרסה ' + v.n + '</a> · ' + esc(day(v.at)) + (v.note ? ' · ' + esc(v.note) : '') + c + '</li>';
          }).join('') + '</ul></details>';
      }
    }
    h += '<p class="dz-msg' + (ui.err ? ' err' : '') + '" aria-live="polite">' + esc(ui.msg || '') + '</p>';
    return h;
  }

  var WHY = { text: 'כתבו כמה מילים על מה שתרצו', 'too-many-refs': 'עד ' + MAX_REFS + ' תמונות', locked: 'כבר התחלנו לעצב, הערות אפשר לשלוח על הגרסה', comment: 'כתבו מה לשנות', 'no-rounds-left': 'סבבי התיקונים נוצלו', 'no-hook': 'התשלום לא זמין כרגע, כתבו לנו בוואטסאפ', 'bad-file': 'JPG, PNG או WebP בלבד', 'file-too-large': 'תמונה עד 4MB' };
  function mount(card, opt) {
    if (!card || !opt || !opt.token) { if (card) card.hidden = true; return; }
    if (card.__dzTok === opt.token) return;   /* render() runs often; mount once per event */
    card.__dzTok = opt.token;
    var body = card.querySelector('[data-dz-body]') || card, s = null, ui = {};
    if (!document.getElementById('dzCss')) { var st = document.createElement('style'); st.id = 'dzCss'; st.textContent = CSS; document.head.appendChild(st); }
    function paint() { card.hidden = !(s && s.paid); body.innerHTML = render(s, ui); }
    function api(payload) {
      if (opt.mock) return Promise.resolve(opt.mock(payload, s));
      return fetch(opt.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token: opt.token }, payload)) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, why: 'http-' + r.status }; }); });
    }
    function take(j, okMsg) {
      ui.busy = false;
      if (j && j.versions) s = Object.assign({}, j, { paid: true });
      if (j && j.ok) { ui.msg = okMsg || ''; ui.err = false; } else { ui.msg = WHY[j && (j.why || j.error)] || 'לא הצלחנו לשמור, נסו שוב'; ui.err = true; }
      paint();
      return j;
    }
    body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var act = b.getAttribute('data-act'), ta = document.getElementById('dzText');
      if (ta) ui.text = ta.value;
      if (act === 'edit') { ui.editing = true; ui.refs = (s.brief && s.brief.refs) || []; ui.text = s.brief && s.brief.text; paint(); }
      else if (act === 'pick') { var f = document.getElementById('dzFile'); if (f) f.click(); }
      else if (act === 'unref') { ui.refs = (ui.refs || []).slice(); ui.refs.splice(+b.getAttribute('data-i'), 1); paint(); }
      else if (act === 'send') {
        ui.busy = true; paint();
        api({ action: 'brief', text: ui.text || '', refs: (ui.refs || (s.brief && s.brief.refs) || []).map(function (r) { return r.id; }) })
          .then(function (j) { if (j && j.ok) { ui.editing = false; ui.refs = null; ui.text = null; } take(j, ''); });
      }
      else if (act === 'approve') { ui.busy = true; paint(); api({ action: 'approve' }).then(function (j) { take(j, 'תודה! העיצוב אושר'); }); }
      else if (act === 'changes') { ui.changing = true; paint(); var c = document.getElementById('dzComment'); if (c) c.focus(); }
      else if (act === 'changes-cancel') { ui.changing = false; paint(); }
      else if (act === 'changes-send') {
        var cm = document.getElementById('dzComment'); ui.comment = cm ? cm.value : ''; ui.busy = true; paint();
        api({ action: 'changes', comment: ui.comment }).then(function (j) { if (j && j.ok) { ui.changing = false; ui.comment = ''; } take(j, 'ההערות נשלחו'); });
      }
      else if (act === 'buy') {
        ui.busy = true; paint();
        api({ action: 'buy' }).then(function (j) {
          if (j && j.ok && j.pay && j.url) { ui.msg = 'מעבירים לתשלום…'; paint(); location.href = j.url; return; }
          take(j, j && j.free ? 'סבב התיקונים הראשון עלינו · 1/1 חינם' : '');
        });
      }
    });
    body.addEventListener('change', function (e) {
      if (e.target.id !== 'dzFile') return;
      var files = Array.prototype.slice.call(e.target.files || []);
      ui.refs = (ui.refs || (s.brief && s.brief.refs) || []).slice();
      var room = MAX_REFS - ui.refs.length;
      if (files.length > room) { ui.msg = 'עד ' + MAX_REFS + ' תמונות'; ui.err = true; files = files.slice(0, room); }
      if (!files.length) { paint(); return; }
      ui.busy = true; ui.msg = 'מעלים…'; ui.err = false; paint();
      Promise.all(files.map(function (f) {
        if (f.size > 4 * 1024 * 1024) return Promise.resolve({ ok: false, why: 'file-too-large' });
        if (opt.mock) return Promise.resolve({ ok: true, media: 'mock' + Math.random().toString(16).slice(2, 14), url: URL.createObjectURL(f) });
        var fd = new FormData(); fd.append('token', opt.token); fd.append('purpose', 'design_ref'); fd.append('file', f, f.name);
        return fetch(opt.media, { method: 'POST', body: fd }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; });
      })).then(function (rs) {
        var bad = null;
        rs.forEach(function (r) { if (r && r.ok) ui.refs.push({ id: r.media, url: r.url }); else bad = r; });
        ui.busy = false; ui.msg = bad ? (WHY[bad.why || bad.error] || 'חלק מהתמונות לא עלו') : ''; ui.err = !!bad; paint();
      });
    });
    api({ action: 'state' }).then(function (j) {
      s = j && j.ok ? j : null; paint();
      if (s && s.paid && /#design/.test(location.hash)) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })['catch'](function () { card.hidden = true; });
  }
  /* local stand-in for /api/design-flow (demo mode + screenshots): ?designmock=brief|sent|v1|limit|approved */
  var SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#FBF8F1"/><rect x="30" y="30" width="540" height="740" fill="none" stroke="#A8853C" stroke-width="3"/><text x="300" y="330" font-family="serif" font-size="54" text-anchor="middle" fill="#0F4C35">דנה ואבי</text><text x="300" y="410" font-family="serif" font-size="28" text-anchor="middle" fill="#374151">12.12.2026 · אולם הגן</text></svg>');
  function mockState(kind) {
    var s = { ok: true, paid: true, status: 'new', rounds_used: 0, rounds_total: 1, rounds_free: 1, rounds_paid: 0, free_claimed: false, can_request_changes: false, round_price: 49, versions: [], comments: [], brief: null, brief_editable: true };
    if (kind === 'brief') return s;
    s.brief = { text: 'דנה ואבי · 12.12 · אולם הגן\nסגנון מינימליסטי, ירוק זית ושמנת', refs: [], at: '2026-11-03T10:00:00Z', source: 'dashboard' };
    if (kind === 'sent') return s;
    s.brief_editable = false; s.versions = [{ n: 1, note: 'גרסה ראשונה לפי הבקשה', at: '2026-11-04T10:00:00Z', url: SVG, mime: 'image/svg+xml' }];
    s.status = 'awaiting_client'; s.can_request_changes = true;
    if (kind === 'limit') { s.versions.push({ n: 2, note: 'תוקן הצבע', at: '2026-11-05T10:00:00Z', url: SVG, mime: 'image/svg+xml' }); s.comments = [{ v: 1, text: 'ירוק כהה יותר', at: '' }]; s.rounds_used = 1; s.can_request_changes = false; s.free_claimed = true; }
    if (kind === 'approved') s.status = 'approved';
    return s;
  }
  function mockApi(kind) {
    var cur = mockState(kind);
    return function (p) {
      var s = JSON.parse(JSON.stringify(cur));
      if (p.action === 'brief') { if ((p.text || '').replace(/\s/g, '').length < 5) return { ok: false, why: 'text' }; s.brief = { text: p.text, refs: [], at: new Date().toISOString() }; }
      if (p.action === 'approve') s.status = 'approved';
      if (p.action === 'changes') { s.status = 'changes_requested'; s.comments.push({ v: s.versions.length, text: p.comment }); }
      if (p.action === 'buy') { if (!s.rounds_paid && !s.free_claimed && s.rounds_used < s.rounds_free) { s.free_claimed = true; cur = s; return Object.assign({ free: true }, s); } return Object.assign({}, s, { ok: false, why: 'no-hook' }); }
      cur = s; return s;
    };
  }
  var api = { render: render, mount: mount, mockApi: mockApi, mockState: mockState, MAX_REFS: MAX_REFS };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.IshurDesign = api;
})(typeof window !== 'undefined' ? window : globalThis);
