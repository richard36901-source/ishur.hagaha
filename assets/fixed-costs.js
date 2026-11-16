/* ishur.io · fixed-costs.js · הוצאות קבועות חודשיות (Richard 16/11/2026)
   One list of everything that is charged every month. A row added today is counted from its start month on, every
   month, until it is removed with the ✕ (it then stops from next month; history keeps it). Amount in ₪ or in $
   (the ₪ value is shown beside a $ price), and the day of the month it is charged on — the journal puts it on that day.
   Server: POST /api/adspend {action:'list'|'add'|'update'|'remove', item, id}.
   IshurFixed.mount(host, post, onChange) · IshurFixed.render(data, state) → html (pure) */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n2(x) { return (Number(x) || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function monthHe(m) { return m ? m.slice(5, 7) + '/' + m.slice(2, 4) : ''; }
  function render(d, st) {
    var items = ((d && d.items) || []).filter(function (x) { return !x.to_month; });
    var rows = items.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td>' +
        '<td class="fxc-n">' + (x.unknown ? '<span class="fxc-q">חסר סכום</span>' : (x.approx ? '≈ ' : '') + '₪' + n2(x.ils)) + '</td>' +
        '<td class="fxc-n">' + (x.usd != null ? '$' + n2(x.usd) : '') + '</td>' +
        '<td class="fxc-n">' + (x.day || 10) + '</td><td class="fxc-n">' + esc(monthHe(x.from_month)) + '</td>' +
        '<td><span class="fxc-set"><input class="fxc-in" inputmode="decimal" aria-label="סכום חדש ל' + esc(x.name) + '" placeholder="סכום" data-fx-v="' + esc(x.id) + '"><select aria-label="מטבע" data-fx-c="' + esc(x.id) + '"><option value="ils">₪</option><option value="usd"' + (x.usd != null ? ' selected' : '') + '>$</option></select>' +
        '<button type="button" data-fx-upd="' + esc(x.id) + '">עדכון</button></span></td>' +
        '<td><button type="button" class="fxc-x" data-fx-rm="' + esc(x.id) + '" aria-label="הסרת ' + esc(x.name) + '" title="הסרה מהחודש הבא">✕</button></td></tr>';
    }).join('');
    return '<div class="fxc"><div class="fxc-h"><h3>הוצאות קבועות חודשיות</h3><b>₪' + n2(d && d.month_total) + '</b><span>לחודש</span>' +
      '<button type="button" class="fxc-i" data-fx-info aria-expanded="' + (!!st.info) + '" aria-label="הסבר">i</button></div>' +
      (st.info ? '<p class="fxc-info">כל שורה נספרת בכל חודש, מהחודש שבו התחילה ועד שמסירים אותה ב-✕ (ההסרה חלה מהחודש הבא). מחיר בדולר מומר לשקלים לפי ₪3.7 לדולר. היום בחודש קובע באיזה יום ההוצאה מופיעה ביומן.</p>' : '') +
      '<div class="fxc-tw"><table><thead><tr><th>שם</th><th>₪ לחודש</th><th>$</th><th>יום חיוב</th><th>מ-</th><th>שינוי סכום</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="fxc-e">עוד אין הוצאות קבועות.</td></tr>') + '</tbody></table></div>' +
      '<div class="fxc-add"><input data-fx-name placeholder="שם ההוצאה (למשל Make)" aria-label="שם ההוצאה"><input data-fx-amt inputmode="decimal" placeholder="סכום לחודש" aria-label="סכום לחודש">' +
      '<select data-fx-cur aria-label="מטבע"><option value="ils">₪</option><option value="usd">$</option></select><input data-fx-day inputmode="numeric" placeholder="יום חיוב (10)" aria-label="יום חיוב בחודש">' +
      '<button type="button" class="fxc-go" data-fx-add>הוספה</button></div>' + (st.err ? '<p class="fxc-err">' + esc(st.err) + '</p>' : '') + '</div>';
  }
  var CSS = '.fxc{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.8rem .9rem;margin:0 0 16px}' +
    '.fxc-h{display:flex;align-items:baseline;gap:.5rem;margin:0 0 .5rem}.fxc-h h3{margin:0;font-size:.95rem;color:var(--pine,#0F2E22)}.fxc-h b{font-size:1.1rem;margin-inline-start:auto}.fxc-h span{font-size:.74rem;color:var(--ink3,#7A8279)}' +
    '.fxc-i{font:inherit;font-size:.78rem;font-weight:700;font-style:italic;width:26px;height:26px;border-radius:50%;border:1px solid var(--line,#E3E1D8);background:none;color:var(--ink3,#7A8279);cursor:pointer;align-self:center}' +
    '.fxc-info{font-size:.78rem;line-height:1.6;color:var(--ink2,#4A554C);margin:0 0 .5rem;max-width:70ch}' +
    '.fxc-tw{overflow:auto}.fxc table{border-collapse:collapse;width:100%;font-size:.84rem}.fxc th{font-size:.7rem;color:var(--ink3,#7A8279);text-align:start;padding:.35rem .5rem;border-bottom:1px solid var(--line,#E3E1D8);white-space:nowrap;letter-spacing:0;text-transform:none}' +
    '.fxc td{padding:.4rem .5rem;border-bottom:1px solid rgba(0,0,0,.05);white-space:nowrap}.fxc-n{font-variant-numeric:tabular-nums}.fxc-q{color:#8E2F22;font-size:.76rem}.fxc-e{color:var(--ink3,#7A8279)}' +
    '.fxc input,.fxc select,.fxc button{font:inherit;font-size:.82rem;min-height:34px;border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);color:var(--ink,#1B2620);padding:0 .55rem}' +
    '.fxc button{cursor:pointer;font-weight:600}.fxc-set{display:inline-flex;gap:.3rem}.fxc-in{width:5.5rem}.fxc-x{width:34px;padding:0;color:#8E2F22}' +
    '.fxc-add{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.7rem}.fxc-add [data-fx-name]{flex:1;min-width:150px}.fxc-add [data-fx-amt]{width:8rem}.fxc-add [data-fx-day]{width:7.5rem}' +
    'html[data-theme=dark] .fxc-go{color:#0A2119!important}html[data-theme=dark] .fxc-err{color:#F2A79C}.fxc-go{background:var(--pine,#0F2E22)!important;color:#fff!important;border-color:transparent!important;padding:0 1rem!important}.fxc-err{color:#8E2F22;font-size:.78rem;margin:.4rem 0 0}';
  function mount(host, post, onChange) {
    var doc = root.document; if (!host || host.dataset.fxc) return null; host.dataset.fxc = '1';
    var st0 = doc.createElement('style'); st0.textContent = CSS; doc.head.appendChild(st0);
    var data = null, st = { info: false, err: '' };
    function draw() { host.innerHTML = render(data || { items: [], month_total: 0 }, st); }
    function call(body) { return post(body).then(function (r) { if (r && r.ok) { data = r; st.err = ''; if (body.action !== 'list' && onChange) onChange(); } else st.err = 'לא נשמר' + (r && r.error ? ': ' + r.error : ''); draw(); }, function () { st.err = 'לא נשמר: אין חיבור'; draw(); }); }
    function money(v, cur) { var n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < 0) return null; return cur === 'usd' ? { usd: n, ils: '' } : { ils: n, usd: '' }; }
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.fxInfo != null) { st.info = !st.info; draw(); return; }
      if (b.dataset.fxAdd != null) {
        var name = host.querySelector('[data-fx-name]').value.trim(), amt = host.querySelector('[data-fx-amt]').value, cur = host.querySelector('[data-fx-cur]').value, day = host.querySelector('[data-fx-day]').value;
        if (!name) { st.err = 'חסר שם להוצאה'; draw(); return; }
        var m = amt === '' ? {} : money(amt, cur); if (m === null) { st.err = 'הסכום לא תקין'; draw(); return; }
        b.disabled = true; call({ action: 'add', item: Object.assign({ name: name, unknown: amt === '', day: day || 10 }, m) }); return;
      }
      if (b.dataset.fxUpd) {
        var id = b.dataset.fxUpd, v = host.querySelector('[data-fx-v="' + (root.CSS && root.CSS.escape ? root.CSS.escape(id) : id) + '"]').value, c = host.querySelector('[data-fx-c="' + (root.CSS && root.CSS.escape ? root.CSS.escape(id) : id) + '"]').value;
        var mm = v === '' ? null : money(v, c); if (!mm) { st.err = 'כדי לעדכן צריך סכום'; draw(); return; }
        b.disabled = true; call({ action: 'update', item: Object.assign({ id: id, unknown: false }, mm) }); return;
      }
      if (b.dataset.fxRm) { b.disabled = true; call({ action: 'remove', id: b.dataset.fxRm }); }
    });
    draw(); call({ action: 'list' });
    return { reload: function () { call({ action: 'list' }); } };
  }
  /* ── cost of one event (hostess wages, a courier…): typed here, counted on its day in every sum ── */
  function renderEvents(events, extras, st) {
    var opts = (events || []).filter(function (e) { return !e.cancelled; }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
      .map(function (e) { return '<option value="' + esc(e.token8) + '">' + esc((e.name || e.client || e.token8) + (e.date ? ' · ' + String(e.date).slice(8, 10) + '/' + String(e.date).slice(5, 7) : '')) + '</option>'; }).join('');
    var total = (extras || []).reduce(function (t, x) { return t + (Number(x.ils) || 0); }, 0);
    var rows = (extras || []).map(function (x) { return '<tr><td>' + esc(x.name || x.tok8) + '</td><td>' + esc(x.label) + '</td><td class="fxc-n">₪' + n2(x.ils) + '</td><td class="fxc-n">' + esc(String(x.day || '').slice(8, 10) + '/' + String(x.day || '').slice(5, 7)) + '</td><td><button type="button" class="fxc-x" data-ev-rm="' + esc(x.id) + '" data-ev-tok="' + esc(x.tok8) + '" aria-label="הסרה" title="הסרה">✕</button></td></tr>'; }).join('');
    return '<div class="fxc"><div class="fxc-h"><h3>עלויות לפי אירוע</h3><b>₪' + n2(total) + '</b><span>סה״כ</span><button type="button" class="fxc-i" data-ev-info aria-expanded="' + (!!st.info) + '" aria-label="הסבר">i</button></div>' +
      (st.info ? '<p class="fxc-info">עלות ששייכת לאירוע אחד, למשל שכר דיילות או שליח. היא נספרת ביום שנרשם (ברירת מחדל: היום), ומופיעה ברווח של אותו יום ושל החודש.</p>' : '') +
      '<div class="fxc-tw"><table><thead><tr><th>אירוע</th><th>מה</th><th>₪</th><th>יום</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="fxc-e">עוד לא נרשמה עלות לאירוע.</td></tr>') + '</tbody></table></div>' +
      '<div class="fxc-add"><select data-ev-tok8 aria-label="אירוע" style="flex:1;min-width:170px"><option value="">בחירת אירוע</option>' + opts + '</select><input data-ev-label placeholder="מה (למשל שכר דיילת)" aria-label="תיאור העלות" style="flex:1;min-width:150px"><input data-ev-ils inputmode="decimal" placeholder="₪" aria-label="סכום בשקלים" style="width:6.5rem"><input data-ev-day type="date" aria-label="יום העלות">' +
      '<button type="button" class="fxc-go" data-ev-add>הוספה</button></div>' + (st.err ? '<p class="fxc-err">' + esc(st.err) + '</p>' : '') + '</div>';
  }
  function mountEvents(host, post, onChange) {
    var doc = root.document; if (!host || host.dataset.evc) return null; host.dataset.evc = '1';
    if (!doc.getElementById('fxc-css')) { var st0 = doc.createElement('style'); st0.id = 'fxc-css'; st0.textContent = CSS; doc.head.appendChild(st0); }
    var events = [], extras = [], st = { info: false, err: '' };
    function draw() { host.innerHTML = renderEvents(events, extras, st); }
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.evInfo != null) { st.info = !st.info; draw(); return; }
      var done = function (r) { if (r && r.ok) { st.err = ''; if (onChange) onChange(); } else { st.err = 'לא נשמר' + (r && r.error ? ': ' + r.error : ''); draw(); } };
      if (b.dataset.evAdd != null) {
        var tok = host.querySelector('[data-ev-tok8]').value, label = host.querySelector('[data-ev-label]').value.trim(), ils = Number(String(host.querySelector('[data-ev-ils]').value).replace(',', '.')), day = host.querySelector('[data-ev-day]').value;
        if (!tok) { st.err = 'צריך לבחור אירוע'; draw(); return; }
        if (!Number.isFinite(ils) || ils <= 0) { st.err = 'הסכום לא תקין'; draw(); return; }
        b.disabled = true; post({ action: 'add', tok8: tok, label: label || 'עלות אירוע', ils: ils, day: day }).then(done, function () { st.err = 'לא נשמר: אין חיבור'; draw(); }); return;
      }
      if (b.dataset.evRm) { b.disabled = true; post({ action: 'remove', tok8: b.dataset.evTok, id: b.dataset.evRm }).then(done, function () { st.err = 'לא נשמר: אין חיבור'; draw(); }); }
    });
    draw();
    return { set: function (ev, ex) { events = ev || []; extras = ex || []; draw(); } };
  }
  var api = { mount: mount, render: render, mountEvents: mountEvents, renderEvents: renderEvents };
  root.IshurFixed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
