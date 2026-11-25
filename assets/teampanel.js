/* ==========================================================================
   Team panel (25/11/2026) — loaded by both admin bars (assets/adminbar.js,
   next/assets/adminbar.js), so it is on every back-office page.

   1. Roles: hides the menu links the signed-in person's roles may not open, and
      covers a page they may not open with a calm "no access" card. Nothing is
      hidden when there is no Google session or the call fails (no lock-out).
   2. משימות צוות: a panel fixed on the LEFT, collapsible to a slim tab with a
      badge. Bugs / client requests, a thread, open → in progress → done → closed
      (closed only by whoever opened it). Everything goes through POST /api/team.
   ========================================================================== */
(function () {
  try {
    if (window.__ishurTeam) return; window.__ishurTeam = 1;
    var here = location.pathname.split('/').pop() || 'admin.html';
    if (here === 'login.html' || /[?&]embed=1/.test(location.search)) return;
    var k = ''; try { k = localStorage.getItem('ishur_calls_key') || ''; } catch (e) {}
    if (!/^us\./.test(k)) return;   /* the panel needs a person: a Google session */
    var API = (window.ISHUR_CONFIG && window.ISHUR_CONFIG.endpoint) ? window.ISHUR_CONFIG.endpoint('status').replace(/\/api\/status$/, '') : 'https://go.ishur.io';
    var S = { me: null, team: [], items: [], counts: {}, tab: 'assigned', all: false, open: false, view: 'list', item: null, events: null, busy: false, types: {}, sh: {} };
    try { S.open = sessionStorage.getItem('ishur_tp_open') === '1'; S.tab = sessionStorage.getItem('ishur_tp_tab') || 'assigned'; } catch (e) {}

    function api(body) {
      body.session = k;
      return fetch(API + '/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); }).catch(function () { return { ok: false }; });
    }
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function nameOf(email) { for (var i = 0; i < S.team.length; i++) if (S.team[i].email === email) return S.team[i].name; return String(email || '').split('@')[0]; }
    function when(iso) { var d = new Date(iso); if (isNaN(d)) return ''; return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }); }
    /* the same rules the Worker enforces (teamissues.js moveError), only to show the right buttons */
    function moves(it) {
      var me = S.me && S.me.email, out = [], op = it.opener === me, as = it.assignee === me, s = it.status;
      if (as && s === 'open') out.push(['in_progress', 'לקחתי לטיפול']);
      if (as && (s === 'open' || s === 'in_progress')) out.push(['done', 'בוצע · לבדיקה']);
      if (as && !op && s === 'in_progress') out.push(['open', 'החזרה לפתוח']);
      if (op && (s === 'done' || s === 'closed' || s === 'in_progress')) out.push(['open', s === 'closed' ? 'פתיחה מחדש' : 'החזרה לטיפול']);
      if (op && s !== 'closed') out.push(['closed', 'סגירה']);
      return out;
    }

    /* ── 1. roles: menu + page gate ─────────────────────────────────────── */
    function keyOfHref(h) {
      h = String(h || '').replace(/^https?:\/\/[^/]+/, '').replace(/^.*\//, '');
      var base = h.split(/[?#]/)[0], view = (h.match(/[?&]view=([a-z]+)/) || [])[1];
      return { full: h, base: base, view: view ? base + '?view=' + view : '' };
    }
    function pageIdOf(map, h) {
      var x = keyOfHref(h);
      if (map[x.full] !== undefined) return map[x.full];
      if (x.view && map[x.view] !== undefined) return map[x.view];
      return map[x.base] !== undefined ? map[x.base] : null;
    }
    function applyRoles(j) {
      var map = j.page_of || {}, allowed = j.pages || [], css = [];
      if (!allowed.length) return;   /* nothing known → hide nothing */
      Object.keys(map).forEach(function (h) {
        if (allowed.indexOf(map[h]) > -1) return;
        var q = h.replace(/"/g, '');
        ['.ibar', '.ibar-menu', '.ibar-tmenu', '.ibar-sub'].forEach(function (p) { css.push(p + ' a[href="' + q + '"]', p + ' a[href$="/' + q + '"]'); });
      });
      if (css.length) { var st = el('style'); st.textContent = css.join(',') + '{display:none!important}'; document.head.appendChild(st); }
      var pid = pageIdOf(map, here + location.search);
      if (pid && allowed.indexOf(pid) < 0) {
        var first = Object.keys(map).filter(function (h) { return allowed.indexOf(map[h]) > -1 && h.indexOf('#') < 0; })[0];
        var g = el('div', 'tp-gate'); var c = el('div', 'tp-gate-card');
        c.appendChild(el('h2', '', 'אין לך גישה לעמוד הזה'));
        c.appendChild(el('p', '', 'העמוד שייך לתפקיד אחר בצוות. אם צריך גישה, אפשר לבקש מריצארד.'));
        if (first) { var a = el('a', 'tp-btn tp-pri', 'למסך שלי'); a.href = first; c.appendChild(a); }
        g.appendChild(c); document.body.appendChild(g);
      }
    }

    /* ── 2. the panel ───────────────────────────────────────────────────── */
    var css = '' +
      '.tp,.tp-tab,.tp-gate{--tp-bg:#FBFAF7;--tp-card:#fff;--tp-ink:#1B2620;--tp-ink2:#4E5C55;--tp-ink3:#7F8C86;--tp-line:#E1E4DE;--tp-pine:#0F4C35;--tp-gold:#A8853C;--tp-warn:#A8402F;--tp-good:#2E7D5B;--tp-chip:#F0EFE9;font-family:Heebo,system-ui,sans-serif;direction:rtl}' +
      'html[data-theme=dark] .tp,html[data-theme=dark] .tp-tab,html[data-theme=dark] .tp-gate{--tp-bg:#131714;--tp-card:#1A201C;--tp-ink:#E8EBE7;--tp-ink2:#C2C9C1;--tp-ink3:#8D968C;--tp-line:#2A322C;--tp-pine:#7BC9A4;--tp-gold:#C7AE7A;--tp-warn:#E58C7C;--tp-good:#6FC39B;--tp-chip:#232A25}' +
      '.tp-tab{position:fixed;left:0;top:42%;z-index:58;display:flex;flex-direction:column;align-items:center;gap:.35rem;padding:.7rem .38rem;background:var(--tp-pine);color:#fff;border:none;border-radius:0 8px 8px 0;cursor:pointer;font:600 .78rem Heebo,system-ui,sans-serif;writing-mode:vertical-rl;box-shadow:0 2px 10px rgba(0,0,0,.18)}' +
      'html[data-theme=dark] .tp-tab{color:#0F1A14}' +
      '.tp-tab:focus-visible{outline:2px solid var(--tp-gold);outline-offset:2px}' +
      '.tp-badge{writing-mode:horizontal-tb;min-width:1.2rem;height:1.2rem;padding:0 .3rem;border-radius:8px;background:var(--tp-warn);color:#fff;font-size:.7rem;line-height:1.2rem;text-align:center}' +
      '.tp{position:fixed;left:0;top:0;bottom:0;width:min(380px,100vw);z-index:70;background:var(--tp-bg);color:var(--tp-ink);border-right:1px solid var(--tp-line);box-shadow:4px 0 24px rgba(0,0,0,.14);display:flex;flex-direction:column;font-size:14px;line-height:1.45}' +
      '.tp[hidden],.tp-tab[hidden],.tp-tabs[hidden],.tp-sw[hidden]{display:none}' +
      '.tp-hd{display:flex;align-items:center;gap:.4rem;padding:.7rem .8rem;border-bottom:1px solid var(--tp-line)}' +
      '.tp-hd h2{flex:1;margin:0;font:700 1.02rem "Frank Ruhl Libre",serif;color:var(--tp-pine)}' +
      '.tp-btn{font:inherit;font-size:.82rem;font-weight:600;min-height:34px;padding:0 .75rem;border:1px solid var(--tp-line);border-radius:8px;background:var(--tp-card);color:var(--tp-ink);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:.3rem}' +
      '.tp-btn:hover{border-color:var(--tp-ink3)}.tp-btn:disabled{opacity:.55;cursor:default}' +
      '.tp-pri{background:var(--tp-pine);border-color:var(--tp-pine);color:#fff}html[data-theme=dark] .tp-pri{color:#0F1A14}' +
      '.tp-x{width:34px;justify-content:center;padding:0}' +
      '.tp-tabs{display:flex;gap:.3rem;padding:.55rem .8rem;border-bottom:1px solid var(--tp-line)}' +
      '.tp-tabs button{flex:1;font:inherit;font-size:.82rem;min-height:32px;border:1px solid var(--tp-line);border-radius:8px;background:none;color:var(--tp-ink2);cursor:pointer}' +
      '.tp-tabs button[aria-selected=true]{background:var(--tp-chip);color:var(--tp-ink);font-weight:700;border-color:var(--tp-ink3)}' +
      '.tp-body{flex:1;overflow:auto;padding:.6rem .8rem 1.2rem}' +
      '.tp-row{display:block;width:100%;text-align:right;font:inherit;color:inherit;background:var(--tp-card);border:1px solid var(--tp-line);border-radius:8px;padding:.55rem .65rem;margin:0 0 .45rem;cursor:pointer}' +
      '.tp-row:hover{border-color:var(--tp-ink3)}.tp-row.closed{opacity:.6}' +
      '.tp-row b{display:block;font-size:.9rem;font-weight:600;margin:.15rem 0}' +
      '.tp-m{font-size:.74rem;color:var(--tp-ink3)}' +
      '.tp-chip{display:inline-block;font-size:.7rem;padding:.05rem .4rem;border-radius:6px;background:var(--tp-chip);color:var(--tp-ink2);margin-inline-end:.25rem}' +
      '.tp-chip.s-open{color:var(--tp-warn)}.tp-chip.s-in_progress{color:var(--tp-gold)}.tp-chip.s-done{color:var(--tp-good)}' +
      '.tp-empty{color:var(--tp-ink3);font-size:.85rem;text-align:center;padding:2rem .5rem}' +
      '.tp-d h3{margin:.2rem 0 .4rem;font-size:1.02rem}.tp-text{white-space:pre-wrap;background:var(--tp-card);border:1px solid var(--tp-line);border-radius:8px;padding:.6rem;margin:.5rem 0;font-size:.88rem}' +
      '.tp-c{border-inline-start:2px solid var(--tp-line);padding:.15rem .6rem;margin:.5rem 0}.tp-c p{margin:.1rem 0 0;white-space:pre-wrap;font-size:.86rem}' +
      '.tp-acts{display:flex;flex-wrap:wrap;gap:.35rem;margin:.6rem 0}' +
      '.tp-f label{display:block;font-size:.78rem;color:var(--tp-ink2);margin:.6rem 0 .2rem}' +
      '.tp-f input,.tp-f select,.tp-f textarea,.tp-d textarea{width:100%;box-sizing:border-box;font:inherit;font-size:.88rem;padding:.45rem .55rem;border:1px solid var(--tp-line);border-radius:8px;background:var(--tp-card);color:var(--tp-ink)}' +
      '.tp-f textarea,.tp-d textarea{min-height:76px;resize:vertical}' +
      '.tp-seg{display:flex;gap:.3rem}.tp-seg button{flex:1}.tp-seg button[aria-pressed=true]{background:var(--tp-chip);border-color:var(--tp-ink3);font-weight:700}' +
      '.tp-msg{font-size:.8rem;color:var(--tp-warn);min-height:1.1em;margin:.3rem 0}' +
      '.tp-sw{display:flex;align-items:center;gap:.25rem;font-size:.78rem;color:var(--tp-ink2);cursor:pointer}' +
      '.tp-gate{position:fixed;inset:0;z-index:57;background:var(--tp-bg);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.tp-gate-card{max-width:360px;text-align:center;color:var(--tp-ink)}.tp-gate-card h2{font:700 1.2rem "Frank Ruhl Libre",serif;color:var(--tp-pine);margin:0 0 .5rem}.tp-gate-card p{color:var(--tp-ink2);font-size:.9rem;margin:0 0 1rem}' +
      '@media (max-width:640px){.tp-tab{top:auto;bottom:calc(72px + env(safe-area-inset-bottom));writing-mode:horizontal-tb;flex-direction:row;border-radius:0 8px 8px 0;padding:.5rem .6rem}' +
        '.tp{width:100vw;bottom:0;border-right:none;z-index:70}}' +
      '@media (prefers-reduced-motion:no-preference){.tp{animation:tpIn .16s ease-out}@keyframes tpIn{from{transform:translateX(-12px)}to{transform:none}}}';

    var tab, panel, body, tabsBox, allSw;
    function mount() {
      var st = el('style'); st.textContent = css; document.head.appendChild(st);
      tab = el('button', 'tp-tab'); tab.type = 'button'; tab.setAttribute('aria-label', 'משימות צוות'); tab.hidden = true;
      tab.appendChild(el('span', '', 'משימות'));
      tab.addEventListener('click', function () { setOpen(true); });
      panel = el('aside', 'tp'); panel.hidden = true; panel.setAttribute('aria-label', 'משימות צוות');
      var hd = el('div', 'tp-hd'); hd.appendChild(el('h2', '', 'משימות צוות'));
      allSw = el('label', 'tp-sw'); var cb = el('input'); cb.type = 'checkbox'; cb.addEventListener('change', function () { S.all = cb.checked; S.tab = S.all ? 'all' : 'assigned'; refresh(); }); allSw.appendChild(cb); allSw.appendChild(el('span', '', 'הכל')); allSw.hidden = true; hd.appendChild(allSw);
      var nb = el('button', 'tp-btn tp-pri', '+ חדש'); nb.type = 'button'; nb.addEventListener('click', function () { S.view = 'new'; render(); }); hd.appendChild(nb);
      var x = el('button', 'tp-btn tp-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'סגירת הפאנל'); x.addEventListener('click', function () { setOpen(false); }); hd.appendChild(x);
      panel.appendChild(hd);
      tabsBox = el('div', 'tp-tabs'); tabsBox.setAttribute('role', 'tablist'); panel.appendChild(tabsBox);
      body = el('div', 'tp-body'); panel.appendChild(body);
      document.body.appendChild(tab); document.body.appendChild(panel);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) setOpen(false); });
    }
    function setOpen(on) {
      S.open = on; try { sessionStorage.setItem('ishur_tp_open', on ? '1' : '0'); } catch (e) {}
      panel.hidden = !on; tab.hidden = on;
      if (on) { S.view = S.view === 'detail' && S.item ? 'detail' : 'list'; render(); refresh(); }
    }
    function badge() {
      var old = tab.querySelector('.tp-badge'); if (old) old.remove();
      var n = (S.counts && S.counts.badge) || 0;
      if (n) { var b = el('span', 'tp-badge', n > 9 ? '9+' : String(n)); b.setAttribute('aria-label', n + ' ממתינות לך'); tab.appendChild(b); }
    }
    function renderTabs() {
      tabsBox.textContent = '';
      var c = S.counts || {}, defs = S.all ? [['all', 'הכל']] : [['assigned', 'פתוחים אליי' + (c.assigned ? ' · ' + c.assigned : '')], ['opened', 'פתחתי' + (c.opened ? ' · ' + c.opened : '')]];
      defs.forEach(function (d) {
        var b = el('button', '', d[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', S.tab === d[0] ? 'true' : 'false');
        b.addEventListener('click', function () { S.tab = d[0]; S.view = 'list'; try { sessionStorage.setItem('ishur_tp_tab', d[0]); } catch (e) {} render(); });
        tabsBox.appendChild(b);
      });
      tabsBox.hidden = S.view !== 'list';
    }
    function rowsFor() {
      var me = S.me.email, rank = { open: 0, in_progress: 1, done: 2, closed: 3 };
      return S.items.filter(function (r) { return S.tab === 'all' ? true : S.tab === 'opened' ? r.opener === me : r.assignee === me; })
        .sort(function (a, b) { return (rank[a.status] - rank[b.status]) || String(b.updated_at).localeCompare(String(a.updated_at)); });
    }
    function render() {
      if (!panel) return;
      renderTabs(); badge(); body.textContent = '';
      if (S.view === 'new') return renderNew();
      if (S.view === 'detail' && S.item) return renderDetail();
      var rows = rowsFor();
      if (!rows.length) { body.appendChild(el('div', 'tp-empty', S.tab === 'opened' ? 'עוד לא פתחת משימות.' : 'אין משימות פתוחות אלייך.')); return; }
      rows.forEach(function (r) {
        var b = el('button', 'tp-row' + (r.status === 'closed' ? ' closed' : '')); b.type = 'button';
        var top = el('div', 'tp-m');
        top.appendChild(el('span', 'tp-chip', S.types[r.type] || r.type));
        top.appendChild(el('span', 'tp-chip s-' + r.status, S.sh[r.status] || r.status));
        if (r.source === 'whatsapp') top.appendChild(el('span', 'tp-chip', 'וואטסאפ'));
        b.appendChild(top); b.appendChild(el('b', '', r.title));
        b.appendChild(el('div', 'tp-m', [r.ev, nameOf(r.opener) + ' ← ' + nameOf(r.assignee), when(r.updated_at), r.n ? r.n + ' תגובות' : ''].filter(Boolean).join(' · ')));
        b.addEventListener('click', function () { openItem(r.id); });
        body.appendChild(b);
      });
    }
    function openItem(id) {
      S.view = 'detail'; S.item = null; body.textContent = ''; body.appendChild(el('div', 'tp-empty', 'טוען…'));
      api({ op: 'get', id: id }).then(function (j) {
        if (!j || !j.ok) { S.view = 'list'; render(); return; }
        S.item = j.item; render();
      });
    }
    function renderDetail() {
      var it = S.item, d = el('div', 'tp-d');
      var back = el('button', 'tp-btn', '→ חזרה לרשימה'); back.type = 'button'; back.addEventListener('click', function () { S.view = 'list'; S.item = null; try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} render(); }); d.appendChild(back);
      var chips = el('div', 'tp-m'); chips.style.marginTop = '.6rem';
      chips.appendChild(el('span', 'tp-chip', S.types[it.type] || it.type)); chips.appendChild(el('span', 'tp-chip s-' + it.status, S.sh[it.status] || it.status));
      if (it.source === 'whatsapp') chips.appendChild(el('span', 'tp-chip', 'מהוואטסאפ'));
      d.appendChild(chips); d.appendChild(el('h3', '', it.title));
      d.appendChild(el('div', 'tp-m', ['פתח/ה: ' + nameOf(it.opener), 'אחראי/ת: ' + nameOf(it.assignee), when(it.created_at)].join(' · ')));
      if (it.event && it.event.name) d.appendChild(el('div', 'tp-m', 'אירוע: ' + it.event.name + (it.event.date ? ' · ' + it.event.date : '')));
      if (it.text) d.appendChild(el('div', 'tp-text', it.text));
      var mv = moves(it);
      if (mv.length) {
        var acts = el('div', 'tp-acts');
        mv.forEach(function (m) { var b = el('button', 'tp-btn' + (m[0] === 'done' || m[0] === 'closed' ? ' tp-pri' : ''), m[1]); b.type = 'button'; b.addEventListener('click', function () { send({ action: 'status', id: it.id, to: m[0], text: ta.value.trim() }, b); }); acts.appendChild(b); });
        d.appendChild(acts);
      }
      (it.comments || []).forEach(function (c) { var w = el('div', 'tp-c'); w.appendChild(el('div', 'tp-m', nameOf(c.by) + ' · ' + when(c.at))); w.appendChild(el('p', '', c.text)); d.appendChild(w); });
      (it.history || []).slice(1).forEach(function (h) { d.appendChild(el('div', 'tp-m', '· ' + nameOf(h.by) + ' העביר/ה ל' + (S.sh[h.to] || h.to) + ' · ' + when(h.at))); });
      var ta = el('textarea'); ta.placeholder = 'תגובה…'; ta.setAttribute('aria-label', 'תגובה'); ta.style.marginTop = '.7rem'; d.appendChild(ta);
      var msg = el('div', 'tp-msg'); d.appendChild(msg);
      var sb = el('button', 'tp-btn tp-pri', 'שליחת תגובה'); sb.type = 'button'; sb.addEventListener('click', function () { if (!ta.value.trim()) { ta.focus(); return; } send({ action: 'comment', id: it.id, text: ta.value.trim() }, sb); }); d.appendChild(sb);
      body.appendChild(d);
      function send(req, btn) {
        if (S.busy) return; S.busy = true; btn.disabled = true; msg.textContent = '';
        api(req).then(function (j) {
          S.busy = false; btn.disabled = false;
          if (!j || !j.ok) { msg.textContent = j && j.error === 'opener-only' ? 'רק מי שפתח/ה את המשימה סוגר/ת אותה.' : 'לא נשמר, נסו שוב.'; return; }
          take(j); S.item = j.item; render();
        });
      }
    }
    function renderNew() {
      var f = el('div', 'tp-f'), pick = { type: 'issue', event: null };
      f.appendChild(el('label', '', 'סוג'));
      var seg = el('div', 'tp-seg');
      [['issue', 'באג / תקלה'], ['request', 'בקשת לקוח']].forEach(function (t) {
        var b = el('button', 'tp-btn', t[1]); b.type = 'button'; b.setAttribute('aria-pressed', t[0] === pick.type ? 'true' : 'false');
        b.addEventListener('click', function () { pick.type = t[0]; [].forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); });
        seg.appendChild(b);
      });
      f.appendChild(seg);
      f.appendChild(el('label', '', 'לקוח / אירוע (לא חובה)'));
      var evIn = el('input'); evIn.setAttribute('list', 'tp-evs'); evIn.placeholder = 'הקלדת שם…'; evIn.setAttribute('aria-label', 'לקוח או אירוע');
      var dl = el('datalist'); dl.id = 'tp-evs'; f.appendChild(evIn); f.appendChild(dl);
      var fillEv = function () { dl.textContent = ''; (S.events || []).forEach(function (e) { var o = el('option'); o.value = e.name + (e.date ? ' · ' + e.date : ''); dl.appendChild(o); }); };
      if (S.events) fillEv(); else api({ op: 'events' }).then(function (j) { S.events = (j && j.events) || []; fillEv(); });
      f.appendChild(el('label', '', 'כותרת'));
      var ti = el('input'); ti.maxLength = 120; ti.setAttribute('aria-label', 'כותרת'); f.appendChild(ti);
      f.appendChild(el('label', '', 'פירוט'));
      var tx = el('textarea'); tx.setAttribute('aria-label', 'פירוט'); f.appendChild(tx);
      f.appendChild(el('label', '', 'למי'));
      var as = el('select'); as.setAttribute('aria-label', 'אחראי/ת');
      S.team.forEach(function (t) { var o = el('option', '', t.name + (t.email === S.me.email ? ' (אני)' : '')); o.value = t.email; as.appendChild(o); });
      var others = S.team.filter(function (t) { return t.email !== S.me.email; }), other = others.filter(function (t) { return (t.roles || []).indexOf('dev') > -1; })[0] || others[0]; if (other) as.value = other.email;   /* a bug goes to the developer by default */
      f.appendChild(as);
      var msg = el('div', 'tp-msg'); f.appendChild(msg);
      var acts = el('div', 'tp-acts');
      var ok = el('button', 'tp-btn tp-pri', 'פתיחת משימה'); ok.type = 'button';
      var cancel = el('button', 'tp-btn', 'ביטול'); cancel.type = 'button'; cancel.addEventListener('click', function () { S.view = 'list'; render(); });
      ok.addEventListener('click', function () {
        if (ti.value.trim().length < 2) { msg.textContent = 'חסרה כותרת.'; ti.focus(); return; }
        var v = evIn.value.trim(), ev = null;
        (S.events || []).forEach(function (e) { if (!ev && v && (e.name + (e.date ? ' · ' + e.date : '')) === v) ev = e; });
        if (!ev && v) ev = { t8: '', name: v.slice(0, 80), date: '' };
        if (S.busy) return; S.busy = true; ok.disabled = true;
        api({ action: 'create', type: pick.type, title: ti.value.trim(), text: tx.value.trim(), assignee: as.value, event: ev }).then(function (j) {
          S.busy = false; ok.disabled = false;
          if (!j || !j.ok) { msg.textContent = 'לא נשמר, נסו שוב.'; return; }
          take(j); S.tab = 'opened'; S.item = j.item; S.view = 'detail'; render();
        });
      });
      acts.appendChild(ok); acts.appendChild(cancel); f.appendChild(acts);
      body.appendChild(f); ti.focus();
    }
    /* a write answers with the item and the counts: merge it in, no re-list */
    function take(j) {
      if (j.counts) S.counts = j.counts;
      if (j.item) {
        var s = { id: j.item.id, type: j.item.type, title: j.item.title, opener: j.item.opener, assignee: j.item.assignee, status: j.item.status, ev: j.item.event ? j.item.event.name : '', n: (j.item.comments || []).length, updated_at: j.item.updated_at, source: j.item.source || '' };
        S.items = S.items.filter(function (r) { return r.id !== s.id; }).concat([s]);
      }
    }
    function refresh() {
      return api({ op: 'list', all: S.all }).then(function (j) {
        if (!j || !j.ok) return;
        S.items = j.items || []; S.counts = j.counts || {};
        if (S.view === 'list') render(); else badge();
      });
    }

    function boot() {
      api({ op: 'me' }).then(function (j) {
        if (!j || !j.ok || !j.me) return;   /* no person → nothing hidden, no panel */
        S.me = j.me; S.team = j.team || []; S.items = j.items || []; S.counts = j.counts || {}; S.types = j.types || {}; S.sh = j.status_he || {};
        try { applyRoles(j); } catch (e) {}
        mount();
        if (S.me.lead) allSw.hidden = false;
        if (S.tab === 'all') S.tab = 'assigned';
        tab.hidden = false; badge();
        var m = location.hash.match(/team=([A-Za-z0-9]+)/);
        if (m) { setOpen(true); openItem(m[1]); } else if (S.open) setOpen(true);
        setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, 180000);
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  } catch (e) {}
})();
