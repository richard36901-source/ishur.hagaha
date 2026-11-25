/* ==========================================================================
   Team panel (25/11/2026) — loaded by both admin bars (assets/adminbar.js,
   next/assets/adminbar.js), so it is on every back-office page.

   1. Roles: hides the menu links the signed-in person's roles may not open, and
      covers a page they may not open with a calm "no access" card. Nothing is
      hidden when there is no Google session or the call fails (no lock-out).
   2. משימות צוות: a panel fixed on the LEFT, collapsible to a slim tab with a
      badge. Bugs / client requests, a thread, open → in progress → done → closed
      (closed only by whoever opened it). Everything goes through POST /api/team.
   3. Files (26/11): 📎 / drag-and-drop / paste on a new item and on every comment;
      shown in place (thumbnails + lightbox, our audio player, video, PDF, CSV/Excel
      as a table, text) with a download button. /api/team-upload, /api/team-file.
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
      /* 26/11 files */
      '.tp-tx{white-space:pre-wrap;overflow-wrap:anywhere}.tp-tx a{color:var(--tp-pine)}.tp-cp{font-size:.86rem;margin:.1rem 0 0}' +
      '.tp-sm{min-height:30px;font-size:.76rem;padding:0 .55rem}' +
      '.tp-att{margin:.35rem 0 0;border:1px dashed transparent;border-radius:8px;padding:.1rem}.tp-att.tp-drop{border-color:var(--tp-pine);background:var(--tp-chip)}' +
      '.tp-attrow{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}' +
      '.tp-chips{display:flex;flex-direction:column;gap:.3rem;margin-top:.35rem}' +
      '.tp-up,.tp-file{background:var(--tp-card);border:1px solid var(--tp-line);border-radius:8px;padding:.4rem .5rem;font-size:.8rem}' +
      '.tp-up{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}.tp-up.err{border-color:var(--tp-warn)}.tp-up.err .tp-m{color:var(--tp-warn)}' +
      '.tp-fh{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}' +
      '.tp-ext{flex:none;font:700 .62rem/1 Heebo,system-ui,sans-serif;letter-spacing:.02em;color:var(--tp-ink2);background:var(--tp-chip);border-radius:6px;padding:.35rem .3rem;min-width:2.6rem;text-align:center;direction:ltr}' +
      '.tp-fn{flex:1;min-width:0;display:flex;flex-direction:column}.tp-fn b{font-weight:600;font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.tp-bar{flex-basis:100%;height:3px;background:var(--tp-chip);border-radius:2px;overflow:hidden}.tp-bar i{display:block;height:100%;background:var(--tp-pine);width:0;transition:width .2s}' +
      '.tp-files{display:flex;flex-direction:column;gap:.35rem;margin:.4rem 0 .1rem;white-space:normal}' +
      '.tp-thumbs{display:flex;flex-wrap:wrap;gap:.35rem}' +
      '.tp-thumb{padding:0;border:1px solid var(--tp-line);border-radius:8px;background:var(--tp-chip);width:96px;height:96px;overflow:hidden;cursor:zoom-in;margin:.3rem .3rem 0 0}' +
      '.tp-thumb img{width:100%;height:100%;object-fit:cover;display:block}.tp-thumb:focus-visible{outline:2px solid var(--tp-gold);outline-offset:2px}' +
      '.tp-pv:empty{display:none}.tp-pv{margin-top:.4rem}' +
      '.tp-tbl{overflow:auto;max-height:260px;border:1px solid var(--tp-line);border-radius:6px}.tp-tbl table{border-collapse:collapse;font-size:.72rem;min-width:100%}' +
      '.tp-tbl th,.tp-tbl td{border-bottom:1px solid var(--tp-line);border-inline-start:1px solid var(--tp-line);padding:.2rem .4rem;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;text-align:start}' +
      '.tp-tbl th{position:sticky;top:0;background:var(--tp-chip);font-weight:600}' +
      '.tp-pre{margin:0;font:inherit;max-height:220px;overflow:auto;white-space:pre-wrap;font-size:.74rem;background:var(--tp-chip);border-radius:6px;padding:.45rem}' +
      '.tp-pdf{width:100%;height:420px;border:1px solid var(--tp-line);border-radius:6px;background:#fff;display:block;margin-bottom:.25rem}' +
      '.tp-vid{width:100%;max-height:260px;border-radius:6px;background:#000;display:block}.tp-aud{width:100%;margin-top:.3rem}' +
      '.tp{--card:var(--tp-card);--line:var(--tp-line);--ink:var(--tp-ink);--ink3:var(--tp-ink3);--ok:var(--tp-pine)}' +   /* rec-player follows the panel's colours */
      '.tp-lb [hidden],.tp-d [hidden],.tp-f [hidden]{display:none!important}' +
      '.tp-del{color:var(--tp-warn)}.tp-gone{font-style:italic}' +
      '.tp-lb{position:fixed;inset:0;z-index:90;background:rgba(10,14,12,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6rem;padding:16px;direction:rtl;font-family:Heebo,system-ui,sans-serif}' +
      '.tp-lb img{max-width:100%;max-height:calc(100vh - 110px);object-fit:contain;border-radius:6px;background:#fff}' +
      '.tp-lb-bar{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;justify-content:center;max-width:100%}.tp-lb-cap{color:#E8EBE7;font-size:.8rem;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.tp-lb .tp-btn{background:#1A201C;color:#E8EBE7;border-color:#3A443D}' +
      '@media (max-width:640px){.tp-pdf{height:60vh}.tp-lb-cap{flex-basis:100%;max-width:100%;text-align:center}}' +
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
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open && !document.querySelector('.tp-lb')) setOpen(false); });
      ensureRec();
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
      Promise.all([api({ op: 'get', id: id }), recWait()]).then(function (a) {
        var j = a[0];
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
      if (it.text || (it.files || []).length) { var op = richText('tp-text', it.text); if ((it.files || []).length) op.appendChild(filesBox(it.files)); d.appendChild(op); }
      var mv = moves(it);
      if (mv.length) {
        var acts = el('div', 'tp-acts');
        mv.forEach(function (m) { var b = el('button', 'tp-btn' + (m[0] === 'done' || m[0] === 'closed' ? ' tp-pri' : ''), m[1]); b.type = 'button'; b.addEventListener('click', function () { send({ action: 'status', id: it.id, to: m[0], text: ta.value.trim() }, b); }); acts.appendChild(b); });
        d.appendChild(acts);
      }
      (it.comments || []).forEach(function (c) {
        var w = el('div', 'tp-c'); w.appendChild(el('div', 'tp-m', nameOf(c.by) + ' · ' + when(c.at)));
        if (c.text) w.appendChild(richText('tp-cp', c.text));
        if (c.files && c.files.length) w.appendChild(filesBox(c.files));
        d.appendChild(w);
      });
      (it.history || []).slice(1).forEach(function (h) { d.appendChild(el('div', 'tp-m', '· ' + nameOf(h.by) + (h.file ? ' · ' + (h.note || 'קובץ נמחק') : ' העביר/ה ל' + (S.sh[h.to] || h.to)) + ' · ' + when(h.at))); });
      var ta = el('textarea'); ta.placeholder = 'תגובה…'; ta.setAttribute('aria-label', 'תגובה'); ta.style.marginTop = '.7rem'; d.appendChild(ta);
      var cmp = composer(it.id, ta, true); d.appendChild(cmp.el);
      var msg = el('div', 'tp-msg'); d.appendChild(msg);
      if (S.flash) { msg.textContent = S.flash; S.flash = ''; }
      var sb = el('button', 'tp-btn tp-pri', 'שליחת תגובה'); sb.type = 'button';
      cmp.onchange(function () { sb.textContent = cmp.busy() ? 'מעלה קבצים…' : 'שליחת תגובה'; });
      sb.addEventListener('click', function () {
        if (cmp.busy()) { msg.textContent = 'רגע, הקבצים עוד עולים.'; return; }
        var keys = cmp.keys();
        if (!ta.value.trim() && !keys.length) { ta.focus(); return; }
        send({ action: 'comment', id: it.id, text: ta.value.trim(), files: keys }, sb);
      });
      d.appendChild(sb);
      body.appendChild(d);
      function send(req, btn) {
        if (S.busy) return; S.busy = true; btn.disabled = true; msg.textContent = '';
        api(req).then(function (j) {
          S.busy = false; btn.disabled = false;
          if (!j || !j.ok) { msg.textContent = j && j.error === 'opener-only' ? 'רק מי שפתח/ה את המשימה סוגר/ת אותה.' : (j && ERRS[j.error]) || 'לא נשמר, נסו שוב.'; return; }
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
      var cmpN = composer('', tx, false); f.appendChild(cmpN.el);
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
          if (!j || !j.ok) { S.busy = false; ok.disabled = false; msg.textContent = 'לא נשמר, נסו שוב.'; return; }
          take(j); S.tab = 'opened'; S.item = j.item;
          var finish = function () { S.busy = false; ok.disabled = false; S.view = 'detail'; render(); };
          if (!cmpN.count()) return finish();
          /* the item exists now: upload against it, then ONE write attaches what arrived */
          S.busy = true; ok.disabled = true; msg.textContent = 'המשימה נפתחה, מעלה קבצים…';
          cmpN.uploadTo(j.item.id).then(function () {
            var keys = cmpN.keys(), bad = cmpN.failed();
            if (bad) S.flash = bad === 1 ? 'קובץ אחד לא עלה — אפשר לצרף אותו שוב בתגובה.' : bad + ' קבצים לא עלו — אפשר לצרף אותם שוב בתגובה.';
            if (!keys.length) return finish();
            return api({ action: 'attach', id: j.item.id, files: keys }).then(function (a) {
              if (a && a.ok) { take(a); S.item = a.item; } else S.flash = 'הקבצים עלו אבל לא צורפו — נסו לצרף אותם בתגובה.';
              finish();
            });
          });
        });
      });
      acts.appendChild(ok); acts.appendChild(cancel); f.appendChild(acts);
      body.appendChild(f); ti.focus();
    }
    /* ── 3. files (26/11): attach (📎 / drag / paste), upload, show in place ──
       Upload: POST /api/team-upload?id&name (raw bytes, the session in a header) → a key; the key is
       attached by ONE /api/team write (comment {files} or attach). Read: GET /api/team-file?k= with the
       session in a header → a blob: URL, so no key or session ever sits in a link. */
    var FT = { jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', heic: 'image', heif: 'image',
      mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', webm: 'video', mp4: 'video', m4v: 'video', mov: 'video',
      pdf: 'pdf', csv: 'csv', xlsx: 'excel', xls: 'excel', docx: 'doc', doc: 'doc', txt: 'text', zip: 'zip' };
    var MAXB = 25 * 1024 * 1024;
    var SHEETJS = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';   /* the same file guestlist.js uses */
    var ERRS = { 'too-big': 'הקובץ גדול מדי — עד 25MB לקובץ.', 'bad-type': 'סוג קובץ שלא נתמך.', 'empty': 'הקובץ ריק.', 'not-yours': 'אין הרשאה.', 'too-many': 'עד 10 קבצים בהודעה.', 'bad-file': 'אחד הקבצים לא נמצא, צרפו אותו שוב.', 'no-file': 'הקובץ כבר נמחק.' };
    var blobs = {};   /* key → Promise<{url, blob}> */
    var recIds = {}, recN = 0;
    function extOf(n) { var m = /\.([A-Za-z0-9]{1,5})$/.exec(String(n || '')); return m ? m[1].toLowerCase() : ''; }
    function kindOf(n, t) { var e = extOf(n); if (e === 'webm' && /^audio/.test(t || '')) return 'audio'; return FT[e] || ''; }
    function size(b) { b = Number(b) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : b >= 1024 ? Math.round(b / 1024) + 'KB' : b + 'B'; }
    function fileBlob(key) {
      if (!blobs[key]) blobs[key] = fetch(API + '/api/team-file?k=' + encodeURIComponent(key), { headers: { 'x-ishur-session': k } })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
        .then(function (b) { return { url: URL.createObjectURL(b), blob: b }; })
        .catch(function (e) { delete blobs[key]; throw e; });
      return blobs[key];
    }
    function download(f, btn) {
      if (btn) btn.disabled = true;
      fileBlob(f.key).then(function (x) { var a = el('a'); a.href = x.url; a.download = f.name || 'file'; document.body.appendChild(a); a.click(); a.remove(); })
        .catch(function () { if (btn) btn.textContent = 'לא זמין'; })
        .then(function () { if (btn) btn.disabled = false; });
    }
    /* our audio player (assets/rec-player.js): loaded once; a thread waits for it at most 1.5s, else the browser's own player */
    function ensureRec() {
      if (ensureRec.p) return ensureRec.p;
      ensureRec.p = new Promise(function (ok) {
        if (window.IshurRec) return ok();
        var src = (document.querySelector('script[data-teampanel]') || {}).src || '/assets/teampanel.js';
        var s = el('script'); s.src = src.replace(/teampanel\.js.*$/, 'rec-player.js?v=2'); s.async = true; s.onload = s.onerror = function () { ok(); }; document.head.appendChild(s);
      });
      return ensureRec.p;
    }
    function recWait() { return Promise.race([ensureRec(), new Promise(function (ok) { setTimeout(ok, 1500); })]); }
    function recReady() { return window.IshurRec && window.IshurRec.addLoader; }
    function loadSheetJs() {
      if (window.XLSX) return Promise.resolve(window.XLSX);
      if (loadSheetJs.p) return loadSheetJs.p;
      loadSheetJs.p = new Promise(function (ok, no) { var s = el('script'); s.src = SHEETJS; s.async = true; s.onload = function () { window.XLSX ? ok(window.XLSX) : no(); }; s.onerror = function () { loadSheetJs.p = null; no(); }; document.head.appendChild(s); });
      return loadSheetJs.p;
    }
    /* CSV: UTF-8, else Windows-1255 (Hebrew Excel); the delimiter is guessed from the first line */
    function parseCsv(buf, max) {
      var t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { try { t = new TextDecoder('windows-1255').decode(buf); } catch (e2) { t = new TextDecoder().decode(buf); } }
      t = t.replace(/^﻿/, '');
      var first = t.split('\n')[0], d = [',', ';', '\t'].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
      var rows = [], row = [], cell = '', q = false, i = 0;
      for (; i < t.length && rows.length < max; i++) {
        var c = t[i];
        if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
        else if (c === '"') q = true;
        else if (c === d) { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
        else cell += c;
      }
      if ((cell || row.length) && rows.length < max) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
      return rows;
    }
    function table(rows, note) {
      var w = el('div', 'tp-tbl'), tb = el('table'), cols = 0;
      rows.forEach(function (r) { cols = Math.max(cols, r.length); });
      cols = Math.min(cols, 30);
      rows.forEach(function (r, ri) {
        var tr = el('tr');
        for (var ci = 0; ci < cols; ci++) tr.appendChild(el(ri ? 'td' : 'th', '', r[ci] == null ? '' : String(r[ci]).slice(0, 200)));
        tb.appendChild(tr);
      });
      w.appendChild(tb);
      var out = el('div'); out.appendChild(w); if (note) out.appendChild(el('div', 'tp-m', note)); return out;
    }
    function preview(f, box) {
      box.textContent = ''; box.appendChild(el('div', 'tp-m', 'טוען תצוגה…'));
      var fail = function () { box.textContent = ''; box.appendChild(el('div', 'tp-m', 'אין תצוגה לקובץ הזה — אפשר להוריד אותו.')); };
      fileBlob(f.key).then(function (x) {
        if (f.kind === 'csv' || f.kind === 'text') return x.blob.arrayBuffer().then(function (buf) {
          box.textContent = '';
          if (f.kind === 'text') { var t = new TextDecoder().decode(buf.slice(0, 4000)); box.appendChild(el('pre', 'tp-pre', t + (buf.byteLength > 4000 ? '\n…' : ''))); return; }
          var rows = parseCsv(buf, 51); box.appendChild(table(rows, rows.length > 50 ? 'מוצגות 50 השורות הראשונות' : ''));
        });
        if (f.kind === 'excel') return Promise.all([x.blob.arrayBuffer(), loadSheetJs()]).then(function (a) {
          var wb = a[1].read(new Uint8Array(a[0]), { type: 'array', sheetRows: 51 });
          var name = wb.SheetNames[0], rows = a[1].utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
          box.textContent = '';
          box.appendChild(table(rows.slice(0, 51), [wb.SheetNames.length > 1 ? 'גיליון "' + name + '" (1 מתוך ' + wb.SheetNames.length + ')' : '', rows.length > 50 ? 'מוצגות 50 השורות הראשונות' : ''].filter(Boolean).join(' · ')));
        });
        if (f.kind === 'pdf') {
          box.textContent = '';
          var fr = el('iframe', 'tp-pdf'); fr.src = x.url; fr.title = f.name; box.appendChild(fr);
          var a = el('a', 'tp-m', 'פתיחה בחלון חדש'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener'; box.appendChild(a);
          return;
        }
        if (f.kind === 'video') {
          box.textContent = '';
          var v = el('video', 'tp-vid'); v.controls = true; v.playsInline = true; v.preload = 'metadata'; v.src = x.url;
          v.addEventListener('error', fail); box.appendChild(v); return;
        }
      }).catch(fail);
    }
    var LBL = { image: 'IMG', audio: 'AUDIO', video: 'VIDEO', pdf: 'PDF', csv: 'CSV', excel: 'XLS', doc: 'DOC', text: 'TXT', zip: 'ZIP' };
    function canDelete(f) { return S.me && (f.by === S.me.email || (S.me.roles || []).indexOf('admin') > -1); }
    function fileCard(f, onDel) {
      var c = el('div', 'tp-file'), top = el('div', 'tp-fh');
      top.appendChild(el('span', 'tp-ext', (extOf(f.name) || LBL[f.kind] || 'FILE').toUpperCase().slice(0, 4)));
      var nm = el('span', 'tp-fn'); nm.appendChild(el('b', '', f.name)); nm.appendChild(el('span', 'tp-m', size(f.size) + (f.by && S.me && f.by !== S.me.email ? ' · ' + nameOf(f.by) : ''))); top.appendChild(nm);
      var box = el('div', 'tp-pv');
      var big = f.size > 3 * 1048576;
      if (f.kind === 'pdf' || f.kind === 'video' || ((f.kind === 'csv' || f.kind === 'excel' || f.kind === 'text') && big)) {
        var pb = el('button', 'tp-btn tp-sm', f.kind === 'video' ? 'הצגה' : 'תצוגה'); pb.type = 'button';
        pb.addEventListener('click', function () { if (box.childNodes.length) { box.textContent = ''; pb.textContent = f.kind === 'video' ? 'הצגה' : 'תצוגה'; return; } pb.textContent = 'הסתרה'; preview(f, box); });
        top.appendChild(pb);
      }
      var db = el('button', 'tp-btn tp-sm', 'הורדה'); db.type = 'button'; db.setAttribute('aria-label', 'הורדת ' + f.name); db.addEventListener('click', function () { download(f, db); }); top.appendChild(db);
      if (onDel) top.appendChild(onDel);
      c.appendChild(top);
      if (f.kind === 'audio') {
        var ab = el('div');
        if (regRec()) { var id = 'tfile' + (++recN); recIds[id] = f.key; ab.innerHTML = window.IshurRec.html({ id: id, name: f.name, via: 'team' }); }
        else {   /* a page that loaded an older rec-player: the browser's player, fetched on the first press */
          var pb2 = el('button', 'tp-btn tp-sm', 'ניגון'); pb2.type = 'button';
          pb2.addEventListener('click', function () { pb2.disabled = true; fileBlob(f.key).then(function (x) { var au = el('audio', 'tp-aud'); au.controls = true; au.src = x.url; pb2.replaceWith(au); au.play().catch(function () {}); }).catch(function () { pb2.textContent = 'לא זמין'; }); });
          ab.appendChild(pb2);
        }
        c.appendChild(ab);
      }
      if ((f.kind === 'csv' || f.kind === 'excel' || f.kind === 'text') && !big) preview(f, box);
      c.appendChild(box);
      return c;
    }
    function delBtn(f) {
      if (!canDelete(f) || !S.item) return null;
      var b = el('button', 'tp-btn tp-sm tp-del', 'מחיקה'); b.type = 'button'; b.setAttribute('aria-label', 'מחיקת ' + f.name);
      var armed = 0;
      b.addEventListener('click', function () {
        if (!armed) { armed = setTimeout(function () { armed = 0; b.textContent = 'מחיקה'; }, 4000); b.textContent = 'בטוח? למחוק'; return; }
        clearTimeout(armed); b.disabled = true;
        api({ action: 'file-delete', id: S.item.id, key: f.key }).then(function (j) {
          if (!j || !j.ok) { b.disabled = false; b.textContent = ERRS[j && j.error] || 'לא נמחק'; return; }
          take(j); S.item = j.item; render();
        });
      });
      return b;
    }
    /* the attachments of one message: images as a strip of thumbnails (→ lightbox), the rest as cards */
    function filesBox(files) {
      var w = el('div', 'tp-files'), imgs = [], strip = el('div', 'tp-thumbs');
      (files || []).forEach(function (f) {
        if (f.deleted) { w.appendChild(el('div', 'tp-m tp-gone', 'הקובץ "' + f.name + '" נמחק' + (f.del_by ? ' ע"י ' + nameOf(f.del_by) : ''))); return; }
        if (f.kind === 'image') {
          var i = imgs.length; imgs.push({ f: f });
          var t = el('button', 'tp-thumb'); t.type = 'button'; t.setAttribute('aria-label', 'הגדלת ' + f.name);
          var im = el('img'); im.alt = f.name; t.appendChild(im);
          fileBlob(f.key).then(function (x) { im.src = x.url; imgs[i].url = x.url; }).catch(function () { t.replaceWith(fileCard(f, delBtn(f))); });
          im.addEventListener('error', function () { imgs[i].bad = true; if (t.parentNode) t.replaceWith(fileCard(f, delBtn(f))); });   /* HEIC where the browser cannot draw it */
          t.addEventListener('click', function () { lightbox(imgs.filter(function (x) { return !x.bad; }), imgs[i]); });
          strip.appendChild(t);
          return;
        }
        w.appendChild(fileCard(f, delBtn(f)));
      });
      if (strip.childNodes.length) w.insertBefore(strip, w.firstChild);
      return w;
    }
    function lightbox(list, cur) {
      var idx = Math.max(0, list.indexOf(cur));
      var o = el('div', 'tp-lb'); o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'תמונה');
      var img = el('img'), bar = el('div', 'tp-lb-bar'), cap = el('span', 'tp-lb-cap');
      var x = el('button', 'tp-btn', 'סגירה'), dl = el('button', 'tp-btn', 'הורדה'), pv = el('button', 'tp-btn', '→'), nx = el('button', 'tp-btn', '←');
      [x, dl, pv, nx].forEach(function (b) { b.type = 'button'; });
      pv.setAttribute('aria-label', 'הקודמת'); nx.setAttribute('aria-label', 'הבאה');
      function show() { var c = list[idx]; img.src = c.url || ''; img.alt = c.f ? c.f.name : ''; cap.textContent = (c.f ? c.f.name : c.url) + (list.length > 1 ? ' · ' + (idx + 1) + '/' + list.length : ''); pv.hidden = nx.hidden = list.length < 2; dl.hidden = !c.f; }
      function close() { document.removeEventListener('keydown', key, true); o.remove(); }
      function key(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'ArrowLeft' && list.length > 1) { idx = (idx + 1) % list.length; show(); } else if (e.key === 'ArrowRight' && list.length > 1) { idx = (idx - 1 + list.length) % list.length; show(); } }
      x.addEventListener('click', close); dl.addEventListener('click', function () { if (list[idx].f) download(list[idx].f, dl); });
      pv.addEventListener('click', function () { idx = (idx - 1 + list.length) % list.length; show(); }); nx.addEventListener('click', function () { idx = (idx + 1) % list.length; show(); });
      o.addEventListener('click', function (e) { if (e.target === o) close(); });
      bar.appendChild(cap); bar.appendChild(pv); bar.appendChild(nx); bar.appendChild(dl); bar.appendChild(x);
      o.appendChild(img); o.appendChild(bar); document.body.appendChild(o);
      document.addEventListener('keydown', key, true); show(); x.focus();
    }
    /* text with its links made clickable; a link to an image or a sound file is previewed under the text */
    var URL_RE = /https?:\/\/[^\s<>"']+/g;
    function richText(cls, text) {
      var box = el('div', cls), p = el('div', 'tp-tx'), last = 0, m, pre = [];
      text = String(text || ''); URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(text))) {
        var u = m[0].replace(/[).,;:!?־]+$/, '');
        if (m.index > last) p.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = el('a', '', u); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; p.appendChild(a);
        last = m.index + u.length; URL_RE.lastIndex = last;
        if (/^https:/.test(u)) pre.push(u);
      }
      if (last < text.length) p.appendChild(document.createTextNode(text.slice(last)));
      box.appendChild(p);
      var pics = [];
      pre.slice(0, 4).forEach(function (u) {
        var path = u.split(/[?#]/)[0];
        if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
          var c = { url: u }; pics.push(c);
          var t = el('button', 'tp-thumb'); t.type = 'button'; t.setAttribute('aria-label', 'הגדלת התמונה');
          var im = el('img'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.src = u; im.addEventListener('error', function () { t.remove(); });
          t.appendChild(im); t.addEventListener('click', function () { lightbox(pics, c); }); box.appendChild(t);
        } else if (/\.(mp3|m4a|wav|ogg|oga|opus)$/i.test(path)) {
          var au = el('audio', 'tp-aud'); au.controls = true; au.preload = 'none'; au.src = u; box.appendChild(au);
        }
      });
      return box;
    }
    /* the attach row: 📎, drag-and-drop, paste. immediate=true uploads as soon as a file is added (the item exists). */
    function composer(itemId, ta, immediate) {
      var st = { id: itemId, list: [] }, root = el('div', 'tp-att');
      var row = el('div', 'tp-attrow');
      var pick = el('button', 'tp-btn tp-sm', '📎 צירוף קובץ'); pick.type = 'button';
      var inp = el('input'); inp.type = 'file'; inp.multiple = true; inp.hidden = true;
      inp.accept = Object.keys(FT).map(function (e) { return '.' + e; }).join(',') + ',image/*,audio/*,video/*';
      pick.addEventListener('click', function () { inp.click(); });
      inp.addEventListener('change', function () { add([].slice.call(inp.files || [])); inp.value = ''; });
      row.appendChild(pick); row.appendChild(el('span', 'tp-m', 'אפשר גם לגרור לכאן או להדביק צילום מסך')); row.appendChild(inp);
      var chips = el('div', 'tp-chips');
      root.appendChild(row); root.appendChild(chips);
      [root, ta].forEach(function (z) {
        z.addEventListener('dragover', function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') > -1) { e.preventDefault(); root.classList.add('tp-drop'); } });
        z.addEventListener('dragleave', function () { root.classList.remove('tp-drop'); });
        z.addEventListener('drop', function (e) { if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return; e.preventDefault(); root.classList.remove('tp-drop'); add([].slice.call(e.dataTransfer.files)); });
      });
      ta.addEventListener('paste', function (e) {
        var fs = [].slice.call((e.clipboardData && e.clipboardData.files) || []);
        if (!fs.length) return;
        e.preventDefault();
        var d = new Date(), pad = function (n) { return ('0' + n).slice(-2); };
        add(fs.map(function (f, i) {
          if (!/^image\//.test(f.type) || (f.name && f.name !== 'image.png')) return f;
          var nm = 'צילום מסך ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + (i ? '-' + i : '') + '.' + (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          try { return new File([f], nm, { type: f.type }); } catch (x) { f.__name = nm; return f; }
        }));
      });
      function add(fs) {
        fs.forEach(function (f) {
          var name = f.__name || f.name || 'file', x = { file: f, name: name, kind: kindOf(name, f.type), state: 'wait', pct: 0, key: '', err: '' };
          if (st.list.filter(function (y) { return y.state !== 'err'; }).length >= 10) { x.state = 'err'; x.err = ERRS['too-many']; }
          else if (!x.kind) { x.state = 'err'; x.err = 'סוג קובץ שלא נתמך (' + (extOf(name) || 'ללא סיומת') + ').'; }
          else if (f.size > MAXB) { x.state = 'err'; x.err = 'גדול מדי (' + size(f.size) + ') — עד 25MB לקובץ.'; }
          else if (!f.size) { x.state = 'err'; x.err = ERRS.empty; }
          st.list.push(x);
        });
        paint(); if (immediate) pump();
      }
      function paint() {
        chips.textContent = '';
        st.list.forEach(function (x) {
          var c = el('div', 'tp-up' + (x.state === 'err' ? ' err' : ''));
          c.appendChild(el('span', 'tp-ext', (extOf(x.name) || '?').toUpperCase().slice(0, 4)));
          var n = el('span', 'tp-fn'); n.appendChild(el('b', '', x.name));
          n.appendChild(el('span', 'tp-m', x.state === 'err' ? x.err : x.state === 'up' ? 'מעלה… ' + x.pct + '%' : x.state === 'done' ? 'עלה · ' + size(x.file.size) : size(x.file.size)));
          c.appendChild(n);
          if (x.state === 'up') { var bar = el('span', 'tp-bar'); var fill = el('i'); fill.style.width = x.pct + '%'; bar.appendChild(fill); c.appendChild(bar); }
          var rm = el('button', 'tp-btn tp-x tp-sm', '×'); rm.type = 'button'; rm.setAttribute('aria-label', 'הסרת ' + x.name);
          rm.addEventListener('click', function () { if (x.xhr) x.xhr.abort(); st.list.splice(st.list.indexOf(x), 1); paint(); if (st.onchange) st.onchange(); });
          c.appendChild(rm); chips.appendChild(c);
        });
        if (st.onchange) st.onchange();
      }
      function up(x) {
        return new Promise(function (done) {
          x.state = 'up'; x.pct = 0; paint();
          var r = new XMLHttpRequest(); x.xhr = r;
          r.open('POST', API + '/api/team-upload?id=' + encodeURIComponent(st.id) + '&name=' + encodeURIComponent(x.name) + (x.file.type ? '&hint=' + encodeURIComponent(x.file.type.split('/')[0]) : ''));
          r.setRequestHeader('x-ishur-session', k); r.setRequestHeader('Content-Type', 'application/octet-stream');
          r.upload.onprogress = function (e) { if (e.lengthComputable) { x.pct = Math.round(e.loaded / e.total * 100); var m = chips.children[st.list.indexOf(x)]; var i = m && m.querySelector('.tp-bar i'); if (i) i.style.width = x.pct + '%'; var t = m && m.querySelector('.tp-fn .tp-m'); if (t) t.textContent = 'מעלה… ' + x.pct + '%'; } };
          r.onload = function () { var j = null; try { j = JSON.parse(r.responseText); } catch (e) {} if (j && j.ok && j.file) { x.state = 'done'; x.key = j.file.key; } else { x.state = 'err'; x.err = (j && (j.he || ERRS[j.error])) || 'לא עלה, נסו שוב.'; } x.xhr = null; paint(); done(); };
          r.onerror = r.onabort = function () { if (x.state === 'up') { x.state = 'err'; x.err = 'לא עלה, נסו שוב.'; } x.xhr = null; paint(); done(); };
          r.send(x.file);
        });
      }
      var running = 0;
      function pump() {
        return new Promise(function (all) {
          (function next() {
            var w = st.list.filter(function (x) { return x.state === 'wait'; });
            if (!w.length && !running) return all();
            while (running < 2 && w.length) { var x = w.shift(); running++; up(x).then(function () { running--; next(); }); }
          })();
        });
      }
      return {
        el: root,
        busy: function () { return st.list.some(function (x) { return x.state === 'up' || (immediate && x.state === 'wait'); }); },
        keys: function () { return st.list.filter(function (x) { return x.state === 'done'; }).map(function (x) { return x.key; }); },
        failed: function () { return st.list.filter(function (x) { return x.state === 'err'; }).length; },
        count: function () { return st.list.filter(function (x) { return x.state !== 'err'; }).length; },
        uploadTo: function (id) { st.id = id; return pump(); },
        onchange: function (fn) { st.onchange = fn; }
      };
    }
    function regRec() {
      if (!regRec.done && recReady()) { window.IshurRec.addLoader('team', function (id) { return fileBlob(recIds[id]).then(function (x) { return x.blob; }); }); window.IshurRec.bind(document); regRec.done = true; }
      return regRec.done;
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
