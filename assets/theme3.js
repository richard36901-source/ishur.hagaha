/* 26/11 Richard: one appearance choice for the whole site — לפי המכשיר → בהיר → כהה, a quiet line icon (no emoji, no frame),
   kept in localStorage 'ishur_theme' ('light' | 'dark' | absent = by device) and honoured by the site, the board,
   the personal area and the upload page. Pages whose CSS keys on html[data-theme=dark] only get the attribute when dark. */
(function () {
  if (window.IshurTheme) return;
  var R = document.documentElement;
  var I = {
    system: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z"/></svg>'
  };
  var HE = { system: 'לפי המכשיר', light: 'בהיר', dark: 'כהה' };
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function mode() { var t = ''; try { t = localStorage.getItem('ishur_theme') || ''; } catch (e) {} return t === 'light' || t === 'dark' ? t : 'system'; }
  function isDark(m) { return m === 'dark' || (m === 'system' && !!(mq && mq.matches)); }
  /* explicit=true: the page understands data-theme="light" too (the marketing site) */
  function apply(explicit) {
    var m = mode();
    if (explicit) { if (m === 'system') R.removeAttribute('data-theme'); else R.setAttribute('data-theme', m); }
    else if (isDark(m)) R.setAttribute('data-theme', 'dark'); else R.removeAttribute('data-theme');
  }
  function set(m) { try { if (m === 'system') localStorage.removeItem('ishur_theme'); else localStorage.setItem('ishur_theme', m); } catch (e) {} }
  function bind(btn, explicit) {
    if (!btn) return;
    function paint() { var m = mode(); btn.innerHTML = I[m]; btn.setAttribute('aria-label', 'מצב תצוגה: ' + HE[m]); btn.title = 'מצב תצוגה: ' + HE[m]; }
    btn.addEventListener('click', function () { var m = mode(); set(m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system'); apply(explicit); paint(); try { document.dispatchEvent(new CustomEvent('ishur:theme')); } catch (e) {} });
    if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (mode() === 'system') { apply(explicit); paint(); } });
    paint();
  }
  window.IshurTheme = { mode: mode, apply: apply, bind: bind, icons: I };
})();
