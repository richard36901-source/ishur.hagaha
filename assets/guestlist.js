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
   3. "להקליד את הרשימה כאן" (15/11, Richard): clients with no Excel, or a phone
      that opens every file in a PDF reader, type the list into a table on the
      page. It is kept in this browser (localStorage, per event token) until they
      reset it, and goes out through the same CSV path as the contacts list.
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
    var s = String(raw || '').trim();
    var intl = /^(\+|00)/.test(s) && !/^(\+|00)972/.test(s);   // a foreign number written with its country code
    var d = s.replace(/\D/g, '');
    if (intl) { if (d.indexOf('00') === 0) d = d.slice(2); return /^[1-9]\d{8,14}$/.test(d) ? '+' + d : ''; } // Richard 21/10: abroad = WhatsApp only
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

  /* ── typed list ──────────────────────────────────────────────────────────── */
  function countOf(v) { var n = parseInt(String(v == null ? '' : v).trim(), 10); return n > 0 && n < 100 ? n : 1; }
  function blankRow(r) { return !String((r && r.name) || '').trim() && !String((r && r.phone) || '').trim(); }

  /* pasted text (from a sheet, Notes, WhatsApp) → rows. One guest per line; cells split on
     tab / comma / semicolon, or a single free line like "דנה לוי 052-1234567 2". */
  function parsePaste(text) {
    var out = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
      line = line.replace(/[‎‏‪-‮]/g, '').trim();
      if (!line) return;
      var cells = line.split(/\t|;|,(?!\d{3}\b)/).map(function (c) { return c.trim(); }).filter(Boolean);
      var name = '', phone = '', count = '';
      if (cells.length > 1) {
        cells.forEach(function (c) {
          if (!phone && normIL(c)) phone = c;
          else if (!count && /^\d{1,2}$/.test(c)) count = c;
          else if (!name && /\D/.test(c.replace(/[\d\s+\-().]/g, '')) ) name = c;
        });
        if (!phone) cells.forEach(function (c) { if (!phone && c !== name && c !== count && c.replace(/\D/g, '').length >= 7) phone = c; });
      } else {
        var m = /(\+?\d[\d\-\s().]{6,}\d)/.exec(line);
        if (m) {
          phone = m[1].trim();
          var tail = /^(.*\d)\s+(\d{1,2})$/.exec(phone);            /* "052-7654321 2": the last small number is the count */
          if (tail && normIL(tail[1])) { phone = tail[1]; count = tail[2]; }
          var rest = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[1].length)).replace(/\s+/g, ' ').trim();
          var c2 = /(?:^|\s)(\d{1,2})$/.exec(rest);
          if (c2) { count = c2[1]; rest = rest.slice(0, c2.index).trim(); }
          name = rest.replace(/^[\-–:,.\s]+|[\-–:,.\s]+$/g, '');
        } else name = line;
      }
      if (/^(שם|name)$/i.test(name) && !normIL(phone)) return;      /* a header line */
      out.push({ name: name, phone: phone, count: countOf(count) });
    });
    return out;
  }

  /* what is ready to send and what still needs a look.
     → { good:[{name,phone,count}], bad:[index], dup:[index], guests } — blank rows are ignored */
  function manualCheck(rows) {
    var good = [], bad = [], dup = [], seen = {}, guests = 0;
    (rows || []).forEach(function (r, i) {
      if (blankRow(r)) return;
      var name = String(r.name || '').trim(), phone = normIL(r.phone);
      if (!name || !phone) { bad.push(i); return; }
      if (seen[phone]) { dup.push(i); return; }
      seen[phone] = 1;
      var c = countOf(r.count); guests += c;
      good.push({ name: name, phone: phone, count: c });
    });
    return { good: good, bad: bad, dup: dup, guests: guests };
  }

  /* the saved draft: only rows with something in them, capped so one event cannot fill the storage */
  function draftPack(rows, now) {
    var keep = (rows || []).filter(function (r) { return !blankRow(r); }).slice(0, 3000)
      .map(function (r) { return { name: String(r.name || '').slice(0, 80), phone: String(r.phone || '').slice(0, 24), count: countOf(r.count) }; });
    return JSON.stringify({ v: 1, at: now || Date.now(), rows: keep });
  }
  function draftUnpack(raw) {
    try {
      var d = JSON.parse(raw || 'null');
      if (!d || d.v !== 1 || !Array.isArray(d.rows)) return null;
      return { at: Number(d.at) || 0, rows: d.rows.filter(function (r) { return r && !blankRow(r); })
        .map(function (r) { return { name: String(r.name || ''), phone: String(r.phone || ''), count: countOf(r.count) }; }) };
    } catch (e) { return null; }
  }

  var api = { HEADERS: HEADERS, normIL: normIL, parseVcf: parseVcf, fromPicker: fromPicker, toCsv: toCsv, buildWorkbook: buildWorkbook,
    parsePaste: parsePaste, manualCheck: manualCheck, draftPack: draftPack, draftUnpack: draftUnpack };
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
        if (!res.contacts.length) { soft('לא מצאנו בקובץ מספרי נייד. אפשר לנסות קובץ אחר או ' + WA_LINK + '.'); return; }
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
      $('glSkipped').textContent = skipped ? skipped + ' רשומות בלי נייד או כפולות לא נכנסו' : '';
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

    initManual();
  }

  /* ══ typed list UI ════════════════════════════════════════════════════════ */
  function initManual() {
    if (!$('glmOpen')) return;
    var token = '';
    try { token = (new URLSearchParams(root.location.search).get('t') || '').trim(); } catch (e) {}
    var KEY = 'ishur_gl_draft:' + (token || 'none');
    var mrows = [], canSave = true, saveT = null, drawn = false;
    var ed = $('glmEditor'), tb = $('glmTbody'), okb = $('glmConfirm'), mnote = $('glmNote'), saved = $('glmSaved');
    var hm = function (ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };

    function store(now) {
      try {
        var real = mrows.filter(function (r) { return !blankRow(r); });
        if (!real.length) { root.localStorage.removeItem(KEY); saved.textContent = ''; return; }
        root.localStorage.setItem(KEY, draftPack(mrows, now));
        saved.textContent = 'נשמר במכשיר הזה · ' + hm(now || Date.now());
      } catch (e) {
        if (canSave) { canSave = false; saved.textContent = 'במכשיר הזה השמירה האוטומטית לא זמינה. כדאי להוריד כאקסל לפני שיוצאים מהדף.'; }
      }
    }
    function save() { clearTimeout(saveT); saveT = setTimeout(function () { store(Date.now()); }, 300); }
    function flush() { clearTimeout(saveT); store(Date.now()); }

    function summary() {
      var c = manualCheck(mrows);
      $('glmCount').textContent = c.good.length ? c.good.length + ' רשומות · ' + c.guests + ' מוזמנים' : 'עוד אין רשומות ברשימה';
      var parts = [];
      if (c.bad.length) parts.push(c.bad.length === 1 ? 'שורה אחת מסומנת: חסר בה שם או מספר נייד תקין.' : c.bad.length + ' שורות מסומנות: חסר בהן שם או מספר נייד תקין.');
      if (c.dup.length) parts.push(c.dup.length === 1 ? 'מספר אחד מופיע פעמיים, הוא ייכנס פעם אחת.' : c.dup.length + ' מספרים מופיעים פעמיים, כל אחד ייכנס פעם אחת.');
      mnote.textContent = parts.join(' '); mnote.hidden = !parts.length;
      okb.disabled = !(c.good.length && !c.bad.length);
      var badSet = {}; c.bad.forEach(function (i) { badSet[i] = 1; });
      Array.prototype.forEach.call(tb.children, function (tr, i) { tr.classList.toggle('glm-bad', !!badSet[i] && !!tr._touched); });
      return c;
    }

    function ensureTail() { if (!mrows.length || !blankRow(mrows[mrows.length - 1])) { var r = { name: '', phone: '', count: 1 }; mrows.push(r); tb.appendChild(rowEl(r)); } }

    function rowEl(r) {
      var tr = doc.createElement('tr');
      tr._touched = !blankRow(r);
      var mk = function (type, cls, label, val) {
        var td = doc.createElement('td'), inp = doc.createElement('input');
        inp.type = type; inp.className = 'gl-in ' + cls; inp.value = val; inp.setAttribute('aria-label', label); inp.autocomplete = 'off';
        td.appendChild(inp); tr.appendChild(td); return inp;
      };
      var inN = mk('text', 'glm-name', 'שם', r.name); inN.placeholder = 'שם המוזמן או המשפחה';
      var inP = mk('tel', 'glm-ph', 'טלפון', r.phone); inP.inputMode = 'tel'; inP.dir = 'ltr'; inP.placeholder = 'נייד 05X';
      var inC = mk('number', 'gl-n', 'כמות מוזמנים', r.count); inC.min = '1'; inC.max = '99'; inC.inputMode = 'numeric'; inC.title = 'כמה מוזמנים';
      var tdX = doc.createElement('td'), x = doc.createElement('button');
      x.type = 'button'; x.className = 'gl-x'; x.textContent = '×'; x.setAttribute('aria-label', 'הסרת השורה');
      tdX.appendChild(x); tr.appendChild(tdX);

      var changed = function () { ensureTail(); summary(); save(); };
      inN.addEventListener('input', function () { r.name = inN.value; changed(); });
      inP.addEventListener('input', function () { r.phone = inP.value; changed(); });
      inC.addEventListener('input', function () { r.count = countOf(inC.value); changed(); });
      /* leaving the row is when a half-filled line starts to count as "needs a look" */
      tr.addEventListener('focusout', function (e) {
        if (tr.contains(e.relatedTarget)) return;
        var n = normIL(r.phone); if (n) { r.phone = n; inP.value = n; }
        tr._touched = !blankRow(r); summary(); save();
      });
      inC.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return; e.preventDefault(); ensureTail();
        var next = tr.nextElementSibling; if (next) next.querySelector('.glm-name').focus();
      });
      var onPaste = function (e) {
        var t = (e.clipboardData || root.clipboardData); t = t ? t.getData('text') : '';
        if (!/[\n\t]/.test(t)) return;                       /* one plain value: the browser pastes it as usual */
        var add = parsePaste(t); if (!add.length) return;
        e.preventDefault();
        var at = mrows.indexOf(r);
        if (blankRow(r)) mrows.splice.apply(mrows, [at, 1].concat(add)); else mrows.splice.apply(mrows, [at + 1, 0].concat(add));
        track('manual_paste', { n: add.length });
        render(); flush();
      };
      inN.addEventListener('paste', onPaste); inP.addEventListener('paste', onPaste);
      x.addEventListener('click', function () {
        var at = mrows.indexOf(r); if (at < 0) return;
        mrows.splice(at, 1); tb.removeChild(tr); ensureTail(); summary(); flush();
      });
      return tr;
    }

    function render() {
      tb.innerHTML = '';
      mrows.forEach(function (r) { tb.appendChild(rowEl(r)); });
      ensureTail(); var c = summary(); renderCards(c);
    }

    /* ── narrow screens (Richard 15/11): no table to scroll sideways. The list is a column of
       rows; a guest is typed in a small form, one field under the other, that closes by itself
       once the count is picked. Tapping a row opens the same form to edit it. ── */
    var mq = root.matchMedia ? root.matchMedia('(max-width:560px)') : null;
    function narrow() { return !!(mq && mq.matches); }
    var cards = $('glmCards'), bg = $('glmSheetBg'), fN = $('glmFName'), fP = $('glmFPhone'), fC = $('glmFCount'),
      chips = $('glmFChips'), fHint = $('glmFHint'), fDel = $('glmFDel'), cur = null, curNew = false;

    function renderCards(c) {
      if (!cards) return;
      c = c || manualCheck(mrows);
      var bad = {}, dup = {}; c.bad.forEach(function (i) { bad[i] = 1; }); c.dup.forEach(function (i) { dup[i] = 1; });
      cards.innerHTML = '';
      mrows.forEach(function (r, i) {
        if (blankRow(r)) return;
        var b = doc.createElement('button'); b.type = 'button'; b.className = 'glm-card' + (bad[i] ? ' glm-bad' : '');
        var n = doc.createElement('b'); n.textContent = String(r.name || '').trim() || 'בלי שם';
        var p = doc.createElement('span'); p.className = 'glm-card-p'; p.dir = 'ltr'; p.textContent = normIL(r.phone) || String(r.phone || '').trim() || '—';
        var k = doc.createElement('span'); k.className = 'glm-card-c';
        k.textContent = bad[i] ? 'לבדוק' : dup[i] ? 'מספר כפול' : (countOf(r.count) === 1 ? 'מוזמן אחד' : countOf(r.count) + ' מוזמנים');
        b.appendChild(n); b.appendChild(p); b.appendChild(k);
        b.setAttribute('aria-label', 'עריכת ' + n.textContent);
        b.addEventListener('click', function () { openSheet(r); });
        cards.appendChild(b);
      });
    }

    function paintChips() {
      var v = cur ? countOf(cur.count) : 0, picked = cur && cur._picked;
      Array.prototype.forEach.call(chips.children, function (ch) {
        var on = picked && (ch.dataset.n === String(v) || (ch.dataset.n === 'more' && v > 6));
        ch.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    function phoneHint() {
      var raw = String(fP.value || '').trim();
      fHint.hidden = !raw || !!normIL(raw);
    }
    function openSheet(r) {
      if (!bg) return;
      curNew = !r; cur = r || { name: '', phone: '', count: 1 };
      cur._picked = !curNew;
      $('glmSheetT').textContent = curNew ? 'מוזמן חדש' : 'עריכת מוזמן';
      fN.value = cur.name; fP.value = cur.phone; fC.hidden = !(cur._picked && countOf(cur.count) > 6); fC.value = fC.hidden ? '' : cur.count;
      fDel.hidden = curNew; fHint.hidden = true; paintChips();
      bg.hidden = false; doc.documentElement.classList.add('glm-lock');
      setTimeout(function () { (curNew ? fN : null) && fN.focus(); }, 60);
    }
    function closeSheet(drop) {
      if (!bg || bg.hidden || !cur) return;
      var r = cur; cur = null;
      bg.hidden = true; doc.documentElement.classList.remove('glm-lock');
      if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
      if (drop) { var at = mrows.indexOf(r); if (at >= 0) mrows.splice(at, 1); }
      else {
        r.name = fN.value; r.phone = normIL(fP.value) || fP.value; delete r._picked;
        if (curNew && !blankRow(r)) {
          while (mrows.length && blankRow(mrows[mrows.length - 1])) mrows.pop();
          mrows.push(r); track('manual_add', {});
        }
      }
      render(); flush();
    }
    if (bg) {
      doc.body.appendChild(bg);   /* out of the animated card, so position:fixed is the screen */
      fC.addEventListener('change', function () { if (cur && countOf(fC.value) > 1 && String(fN.value || '').trim() && normIL(fP.value)) closeSheet(false); });
      fN.addEventListener('input', function () { if (cur) cur.name = fN.value; });
      fP.addEventListener('input', function () {
        if (!cur) return; cur.phone = fP.value;
        /* a full Israeli mobile and a name: put the keyboard away so the count is in view */
        var d = fP.value.replace(/\D/g, '');
        if (/^05\d{8}$/.test(d) && String(fN.value || '').trim()) { fP.blur(); chips.scrollIntoView({ block: 'nearest' }); }
        if (!fHint.hidden) phoneHint();
      });
      fP.addEventListener('blur', phoneHint);
      fN.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fP.focus(); } });
      fP.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fP.blur(); } });
      var sheetPaste = function (e) {
        var t = (e.clipboardData || root.clipboardData); t = t ? t.getData('text') : '';
        if (!/[\n\t]/.test(t)) return;
        var add = parsePaste(t); if (!add.length) return;
        e.preventDefault();
        while (mrows.length && blankRow(mrows[mrows.length - 1])) mrows.pop();
        Array.prototype.push.apply(mrows, add); track('manual_paste', { n: add.length });
        fN.value = ''; fP.value = ''; cur = { name: '', phone: '', count: 1 }; curNew = true; closeSheet(false);
      };
      fN.addEventListener('paste', sheetPaste); fP.addEventListener('paste', sheetPaste);
      chips.addEventListener('click', function (e) {
        var ch = e.target.closest ? e.target.closest('button') : null; if (!ch || !cur) return;
        if (ch.dataset.n === 'more') { cur._picked = true; cur.count = 7; fC.hidden = false; fC.value = ''; paintChips(); fC.focus(); return; }
        cur.count = countOf(ch.dataset.n); cur._picked = true;
        /* picking the count is the last step — nothing else to press. A form with no name or number yet stays open */
        if (String(fN.value || '').trim() && normIL(fP.value)) closeSheet(false);
        else { paintChips(); phoneHint(); (String(fN.value || '').trim() ? fP : fN).focus(); }
      });
      fC.addEventListener('input', function () { if (cur) cur.count = countOf(fC.value); });
      fC.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); closeSheet(false); } });
      $('glmSheetX').addEventListener('click', function () { closeSheet(false); });
      bg.addEventListener('click', function (e) { if (e.target === bg) closeSheet(false); });
      doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(false); });
      fDel.addEventListener('click', function () { closeSheet(true); });
      if (mq) { var onMq = function () { if (!narrow()) closeSheet(false); }; mq.addEventListener ? mq.addEventListener('change', onMq) : mq.addListener(onMq); }
    }

    function openEd(focus) {
      ed.hidden = false; $('glmOpen').hidden = true;
      if (!drawn) { drawn = true; render(); }   /* not "is the body empty": ux.js parks placeholder rows in empty table bodies */
      if (focus) { var f = tb.querySelector('tr:last-child .glm-name'); if (f) f.focus(); }
    }

    $('glmOpen').addEventListener('click', function () { track('manual_open', {}); openEd(!narrow()); if (narrow()) openSheet(null); });
    $('glmAdd').addEventListener('click', function () {
      if (narrow()) { openSheet(null); return; }
      ensureTail(); var f = tb.querySelector('tr:last-child .glm-name'); if (f) { f.focus(); f.scrollIntoView({ block: 'nearest' }); }
    });

    /* reset asks once more on the same button, no browser dialog */
    var rs = $('glmReset'), rsT = null, rsLabel = rs.textContent;
    rs.addEventListener('click', function () {
      if (!rs._armed) {
        rs._armed = true; rs.textContent = 'למחוק את כל הרשימה? לחצו שוב';
        rsT = setTimeout(function () { rs._armed = false; rs.textContent = rsLabel; }, 4000);
        return;
      }
      clearTimeout(rsT); rs._armed = false; rs.textContent = rsLabel;
      mrows = []; try { root.localStorage.removeItem(KEY); } catch (e) {}
      saved.textContent = ''; track('manual_reset', {}); render();
    });

    $('glmExcel').addEventListener('click', function () {
      var c = manualCheck(mrows); if (!c.good.length) return;
      downloadXlsx(c.good, 'ishur-רשימת-מוזמנים.xlsx', mnote);
    });

    okb.addEventListener('click', function () {
      var c = summary(); if (okb.disabled) return;
      var up = root.IshurUpload;
      if (!up || !root.File) { mnote.innerHTML = 'לא הצלחנו להמשיך מכאן, אפשר לנסות שוב או ' + WA_LINK + '.'; mnote.hidden = false; return; }
      flush();
      var f = new File([toCsv(c.good)], 'reshima-yadanit.csv', { type: 'text/csv' });
      track('manual_confirmed', { n: c.good.length });
      if (up.setFile(f) !== false) up.send();
    });

    root.addEventListener('pagehide', flush);
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') flush(); });

    /* a list they started earlier comes back as they left it */
    var d = null; try { d = draftUnpack(root.localStorage.getItem(KEY)); } catch (e) {}
    if (d && d.rows.length) {
      mrows = d.rows; openEd(false);
      saved.textContent = 'המשכנו מהמקום שעצרתם · נשמר ' + hm(d.at);
      track('manual_restored', { n: d.rows.length });
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : this);
