/* 25/11/2026 track-board · what the client board remembers per device:
     · which sections are folded (key ishur_board_closed = JSON list of section ids)
     · that the "צריך לבחור מתי לשלוח" popup was shown (once per event + set of rounds) and that the client chose
       "להגדיר" (the date control then pulses until the date is set)
   localStorage may be missing or throw (private mode, blocked storage, in-app browsers): every read and write is in
   try/catch and an in-memory copy keeps the page consistent for this visit. */
(function () {
  var mem = {};
  function get(k) { try { var v = window.localStorage.getItem(k); if (v != null) return v; } catch (e) {} return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }
  function set(k, v) { mem[k] = v; try { window.localStorage.setItem(k, v); } catch (e) {} }
  var SEC_KEY = 'ishur_board_closed';
  function closedList() { try { var a = JSON.parse(get(SEC_KEY) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : []; } catch (e) { return []; } }
  function setClosed(id, on) { var a = closedList().filter(function (x) { return x !== id; }); if (on) a.push(id); set(SEC_KEY, JSON.stringify(a)); return a; }
  function isClosed(id) { return closedList().indexOf(id) >= 0; }
  function pickKey(token, keys) { return 'ishur_pick:' + (token || 'demo') + ':' + (keys || []).join(','); }
  /* true once: the first time for this event + set of rounds on this device (or this visit, without storage) */
  function pickShouldShow(token, keys) { if (!keys || !keys.length) return false; var k = pickKey(token, keys); if (get(k)) return false; set(k, '1'); return true; }
  function pickPulse(token, keys) { return !!get(pickKey(token, keys) + ':pulse'); }
  function setPickPulse(token, keys) { set(pickKey(token, keys) + ':pulse', '1'); }
  window.IshurBoardPrefs = { get: get, set: set, closedList: closedList, setClosed: setClosed, isClosed: isClosed, pickShouldShow: pickShouldShow, pickPulse: pickPulse, setPickPulse: setPickPulse };
})();
