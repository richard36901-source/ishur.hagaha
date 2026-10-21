/* ============================================================================
   ishur.io · guest-list helpers for upload.html
   ----------------------------------------------------------------------------
   1. "הורדת קובץ למילוי": an .xlsx template built in the browser with SheetJS,
      laid out on the worker's column contract (A שם, B טלפון, C כמות מוזמנים).
      The two example rows sit in columns E:G with A and B empty, so the
      worker's guestsFromRows() skips them silently (no name + no phone).
   2. Contacts: Android contact picker + .vcf upload, a review table, then the
      reviewed rows become a CSV File handed to the page's own setFile() and
      upload button, so the worker receives exactly what an Excel upload sends.
   Pure functions are exported for node tests (module.exports).
   ========================================================================== */
(function (root) {
  'use strict';

  var HEADERS = ['שם', 'טלפון', 'כמות מוזמנים'];
  var EXAMPLES = [
    ['משפחת כהן (דוגמה - למחוק)', '050-1234567', 4],
    ['דנה לוי (דוגמה - למחוק)', '052-7654321', 2]
  ];
  var SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

  /* ── phones ── any Israeli mobile spelling → 05XXXXXXXX, anything else → '' */
  function normIL(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('00972') === 0) d = d.slice(5);
    else if (d.indexOf('972') === 0) d = d.slice(3);
    if (d.charAt(0) === '0') d = d.slice(1);       // +972 (0)54...
    return /^5\d{8}$/.test(d) ? '0' + d : '';
  }

  /* ── vCard ─────────────────────────────────────────────────────────────── */
  function qpBytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else if (c === '=' && i === s.length - 1) { /* soft break leftover */ }
      else {
        var code = s.charCodeAt(i);
        if (code < 128) out.push(code);
        else { var u = unescape(encodeURIComponent(c)); for (var k = 0; k < u.length; k++) out.push(u.charCodeAt(k)); }
      }
    }
    return new Uint8Array(out);
  }
  function b64Bytes(s) {
    try {
      var bin = (typeof atob === 'function') ? atob(s.replace(/\s/g, '')) : Buffer.from(s, 'base64').toString('binary');
      var a = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return a;
    } catch (e) { return new Uint8Array(0); }
  }
  function decodeBytes(bytes, charset) {
    var cs = String(charset || 'utf-8').toLowerCase();
    try { return new TextDecoder(cs).decode(bytes); }
    catch (e) { try { return new TextDecoder('utf-8').decode(bytes); } catch (e2) { return ''; } }
  }
  function unesc(v) {
    return v.replace(/\\n/gi, ' ').replace(/\\([,;:\\])/g, '$1');
  }

  /* one content line → { name, params:{}, types:[], value } */
  function parseLine(line) {
    var inQ = false, cut = -1;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') inQ = !inQ;
      else if (ch === ':' && !inQ) { cut = i; break; }
    }
    if (cut < 0) return null;
    var left = line.slice(0, cut), value = line.slice(cut + 1);
    var parts = left.split(';');
    var name = parts[0].toUpperCase();
    if (name.indexOf('.') >= 0) name = name.slice(name.lastIndexOf('.') + 1); // item1.TEL
    var params = {}, types = [];
    for (var p = 1; p < parts.length; p++) {
      var kv = parts[p].split('=');
      var k = kv[0].trim().toUpperCase();
      var v = kv.length > 1 ? kv.slice(1).join('=').replace(/"/g, '') : '';
      if (!v) { types.push(k.toLowerCase()); continue; }   // vCard 2.1 bare CELL / QUOTED-PRINTABLE
      if (k === 'TYPE') v.split(',').forEach(function (t) { types.push(t.trim().toLowerCase()); });
      else params[k] = v;
    }
    if (types.indexOf('quoted-printable') >= 0) params.ENCODING = 'QUOTED-PRINTABLE';
    var enc = String(params.ENCODING || '').toUpperCase();
    if (enc === 'QUOTED-PRINTABLE' || enc === 'QP') value = decodeBytes(qpBytes(value), params.CHARSET);
    else if (enc === 'B' || enc === 'BASE64') value = decodeBytes(b64Bytes(value), params.CHARSET);
    return { name: name, params: params, types: types, value: value };
  }

  function nameOf(card) {
    if (card.FN && card.FN.trim()) return card.FN.trim();
    if (card.N) {
      var n = card.N.split(';');                       // family;given;middle;prefix;suffix
      var s = [n[3], n[1], n[2], n[0], n[4]].filter(function (x) { return x && x.trim(); }).join(' ').trim();
      if (s) return s;
    }
    return (card.ORG || '').split(';')[0].trim();
  }

  function pickPhone(tels) {
    var best = '', bestScore = -1;
    tels.forEach(function (t) {
      var p = normIL(t.value);
      if (!p) return;
      var mobileTyped = t.types.some(function (x) { return x === 'cell' || x === 'mobile' || x === 'iphone'; });
      var score = (mobileTyped ? 2 : 1) + (t.types.indexOf('pref') >= 0 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = p; }
    });
    return best;
  }

  /* text of a .vcf → { contacts:[{name,phone}], total, noPhone, dup } */
  function parseVcf(text) {
    text = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var raw = text.split('\n');
    /* RFC folding: a line starting with space/tab continues the previous one */
    var lines = [];
    for (var i = 0; i < raw.length; i++) {
      var l = raw[i];
      if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += l.slice(1);
      else lines.push(l);
    }
    /* vCard 2.1 quoted-printable soft breaks: line ends with '=' */
    var joined = [];
    for (var j = 0; j < lines.length; j++) {
      var cur = lines[j];
      if (/QUOTED-PRINTABLE/i.test(cur.split(':')[0])) {
        while (/=$/.test(cur) && j + 1 < lines.length) { cur = cur.slice(0, -1) + lines[++j]; }
      }
      joined.push(cur);
    }
    var out = [], seen = {}, total = 0, noPhone = 0, dup = 0, card = null;
    joined.forEach(function (line) {
      if (/^BEGIN:VCARD/i.test(line)) { card = { tels: [] }; return; }
      if (/^END:VCARD/i.test(line)) {
        if (!card) return;
        total++;
        var phone = pickPhone(card.tels);
        if (!phone) noPhone++;
        else if (seen[phone]) dup++;
        else { seen[phone] = 1; out.push({ name: nameOf(card), phone: phone }); }
        card = null; return;
      }
      if (!card) return;
      var p = parseLine(line);
      if (!p) return;
      if (p.name === 'TEL') card.tels.push({ value: p.value, types: p.types });
      else if (p.name === 'FN' || p.name === 'N' || p.name === 'ORG') { if (!card[p.name]) card[p.name] = unesc(p.value); }
    });
    return { contacts: out, total: total, noPhone: noPhone, dup: dup };
  }

  /* Contact Picker API results → same shape */
  function fromPicker(list) {
    var out = [], seen = {}, noPhone = 0, dup = 0;
    (list || []).forEach(function (c) {
      var tels = (c.tel || []).map(function (t) { return { value: t, types: [] }; });
      var phone = pickPhone(tels);
      if (!phone) { noPhone++; return; }
      if (seen[phone]) { dup++; return; }
      seen[phone] = 1;
      out.push({ name: ((c.name || [])[0] || '').trim(), phone: phone });
    });
    return { contacts: out, total: (list || []).length, noPhone: noPhone, dup: dup };
  }

  /* ── outputs on the column contract ─────────────────────────────────────── */
  function toCsv(rows) {
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [HEADERS.map(q).join(',')];
    rows.forEach(function (r) { lines.push([q(r.name), q(r.phone), q(r.count || 1)].join(',')); });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /* rows given → filled list; no rows → blank template with side examples */
  function buildWorkbook(XLSX, rows) {
    var aoa = [HEADERS.slice()];
    if (rows && rows.length) {
      rows.forEach(function (r) { aoa.push([r.name, r.phone, Number(r.count) || 1]); });
    }  /* blank template: headers only, no examples (Richard 11/10) */
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    /* phone column as text so Excel keeps the leading zero */
    for (var r = 1; r <= Math.max(aoa.length, 300); r++) {
      var a = 'B' + (r + 1);
      if (ws[a]) { ws[a].t = 's'; ws[a].z = '@'; }
    }
    ws['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 14 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'רשימת מוזמנים');
    wb.Workbook = { Views: [{ RTL: true }] };
    return wb;
  }

  var api = { HEADERS: HEADERS, normIL: normIL, parseVcf: parseVcf, fromPicker: fromPicker, toCsv: toCsv, buildWorkbook: buildWorkbook };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.IshurGuestList = api;

  /* ══ UI ═══════════════════════════════════════════════════════════════════ */
  var doc = root.document;
  var $ = function (id) { return doc.getElementById(id); };
  /* Richard 21/10: no phone number in the warning, one tap opens the chat */
  var WA_HELP = 'https://wa.me/972559504499?text=' + encodeURIComponent('היי, לא הצלחתי להעלות את רשימת המוזמנים');
  var WA_LINK = '<a href="' + WA_HELP + '" target="_blank" rel="noopener">לפתוח קריאה בוואטסאפ</a>';
  var SOFT = 'לא הצלחנו לקרוא את הקובץ, אפשר לנסות שוב או ' + WA_LINK + '.';

  function track(ev, p) { try { root.IshurLead && IshurLead.track(ev, p || {}); } catch (e) {} }

  var sheetjs = null;
  function loadSheetJS() {
    if (root.XLSX) return Promise.resolve(root.XLSX);
    if (sheetjs) return sheetjs;
    sheetjs = new Promise(function (res, rej) {
      var s = doc.createElement('script');
      s.src = SHEETJS_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { root.XLSX ? res(root.XLSX) : rej(); };
      s.onerror = function () { sheetjs = null; rej(); };
      doc.head.appendChild(s);
    });
    return sheetjs;
  }
  function downloadXlsx(rows, name, noteEl) {
    return loadSheetJS().then(function (X) {
      X.writeFile(buildWorkbook(X, rows), name, { bookType: 'xlsx' });
    })['catch'](function () {
      if (noteEl) { noteEl.innerHTML = 'ההורדה לא נפתחה כרגע, אפשר לנסות שוב בעוד רגע או ' + WA_LINK + '.'; noteEl.hidden = false; }
    });
  }

  function init() {
    if (!$('glTemplateBtn')) return;
    var note = $('glNote');
    function soft(msg) { note.innerHTML = msg || SOFT; note.hidden = false; }

    $('glTemplateBtn').addEventListener('click', function () {
      track('template_download', {});
      downloadXlsx(null, 'ishur-רשימת-מוזמנים.xlsx', $('glTplNote'));
    });

    /* Android / Chrome contact picker */
    if ('contacts' in navigator && 'ContactsManager' in root) {
      $('glPickBtn').hidden = false;
      $('glPickBtn').addEventListener('click', function () {
        navigator.contacts.select(['name', 'tel'], { multiple: true }).then(function (list) {
          if (!list || !list.length) return;
          track('contacts_picker', { n: list.length });
          addContacts(fromPicker(list));
        })['catch'](function () { soft('לא הצלחנו לפתוח את אנשי הקשר, אפשר לנסות שוב או ' + WA_LINK + '.'); });
      });
    }

    /* .vcf upload (everyone, mostly iPhone) */
    var vin = $('glVcfInput');
    $('glVcfBtn').addEventListener('click', function () { vin.click(); });
    vin.addEventListener('change', function () {
      var f = vin.files && vin.files[0];
      vin.value = '';
      if (!f) return;
      note.hidden = true;
      var fr = new FileReader();
      fr.onload = function () {
        var res;
        try { res = parseVcf(String(fr.result || '')); } catch (e) { res = null; }
        if (!res || !res.total) { soft(); track('vcf_unreadable', {}); return; }
        if (!res.contacts.length) { soft('לא מצאנו בקובץ מספרי נייד ישראליים. אפשר לנסות קובץ אחר או ' + WA_LINK + '.'); return; }
        track('vcf_loaded', { total: res.total, kept: res.contacts.length });
        addContacts(res);
      };
      fr.onerror = function () { soft(); };
      fr.readAsText(f);
    });

    /* ── review table ── */
    var rows = [], reachedEnd = false;
    var wrap = $('glTableWrap'), tbody = $('glTbody'), chk = $('glChk'), ok = $('glConfirm');

    function addContacts(res) {
      var have = {};
      rows.forEach(function (r) { have[r.phone] = 1; });
      var added = 0;
      res.contacts.forEach(function (c) {
        if (have[c.phone]) return;
        have[c.phone] = 1; added++;
        rows.push({ name: c.name, phone: c.phone, count: 1 });
      });
      var skipped = res.noPhone + res.dup + (res.contacts.length - added);
      $('glSkipped').textContent = skipped ? skipped + ' רשומות בלי נייד ישראלי או כפולות לא נכנסו' : '';
      reachedEnd = false; chk.checked = false;
      $('glReview').hidden = false;   /* visible first, so scroll sizes are real */
      wrap.scrollTop = 0;
      render();
      $('glReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function render() {
      tbody.innerHTML = '';
      rows.forEach(function (r, i) {
        var tr = doc.createElement('tr');
        var tdN = doc.createElement('td');
        var inN = doc.createElement('input');
        inN.type = 'text'; inN.value = r.name; inN.className = 'gl-in'; inN.setAttribute('aria-label', 'שם');
        inN.addEventListener('input', function () { r.name = inN.value; });
        tdN.appendChild(inN);
        var tdP = doc.createElement('td'); tdP.className = 'gl-ph'; tdP.textContent = r.phone;
        var tdC = doc.createElement('td');
        var inC = doc.createElement('input');
        inC.type = 'number'; inC.min = '1'; inC.max = '99'; inC.inputMode = 'numeric'; inC.value = r.count; inC.className = 'gl-in gl-n';
        inC.setAttribute('aria-label', 'כמה מגיעים');
        inC.addEventListener('input', function () { var n = parseInt(inC.value, 10); r.count = n > 0 && n < 1000 ? n : 1; });
        tdC.appendChild(inC);
        var tdX = doc.createElement('td');
        var x = doc.createElement('button');
        x.type = 'button'; x.className = 'gl-x'; x.textContent = '×'; x.setAttribute('aria-label', 'הסרה של ' + (r.name || r.phone));
        x.addEventListener('click', function () { rows.splice(i, 1); render(); });
        tdX.appendChild(x);
        tr.appendChild(tdN); tr.appendChild(tdP); tr.appendChild(tdC); tr.appendChild(tdX);
        tbody.appendChild(tr);
      });
      $('glCount').textContent = rows.length + ' אנשי קשר ברשימה';
      checkEnd();
    }

    function checkEnd() {
      if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 6) reachedEnd = true;
      $('glScrollHint').hidden = reachedEnd;
      gate();
    }
    function gate() { ok.disabled = !(reachedEnd && chk.checked && rows.length); }
    wrap.addEventListener('scroll', checkEnd, { passive: true });
    chk.addEventListener('change', gate);

    $('glExcel').addEventListener('click', function () {
      if (!rows.length) return;
      downloadXlsx(rows.map(clean), 'ishur-רשימת-מוזמנים.xlsx', note);
    });

    function clean(r) { return { name: String(r.name || '').trim(), phone: r.phone, count: r.count || 1 }; }

    ok.addEventListener('click', function () {
      if (ok.disabled) return;
      var up = root.IshurUpload;
      if (!up || !root.File) { soft(); return; }
      var csv = toCsv(rows.map(clean));
      var f = new File([csv], 'anshei-kesher.csv', { type: 'text/csv' });
      track('contacts_confirmed', { n: rows.length });
      if (up.setFile(f) !== false) up.send();
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : this);
