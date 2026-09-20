/* EnotDesk Hub — лоадер чат-виджета.
 * Одна строка на сайт:  <script src="…/widget.js" data-server="https://hub.example"></script>
 * Создаёт пузырь + iframe /w на origin хаба (iframe изолирован от сайта);
 * обмен с окном чата — только postMessage (open/close/height).
 * Без зависимостей; все стили инлайн ниже. */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var origin;
  try { origin = new URL(script.src).origin; } catch (e) { return; }
  var dataServer = script.getAttribute('data-server');
  if (dataServer) {
    try { origin = new URL(dataServer, location.href).origin; } catch (e) { /* остаёмся на src */ }
  }

  var css = document.createElement('style');
  css.textContent =
    '.enot-w-btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;' +
    'border:none;background:#35E0C4;color:#05231D;cursor:pointer;z-index:2147483000;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:0}' +
    '.enot-w-btn:hover{filter:brightness(1.08)}' +
    '.enot-w-frame{position:fixed;right:20px;bottom:88px;width:360px;height:520px;max-height:calc(100vh - 110px);' +
    'border:none;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.4);z-index:2147483000;background:#070D17;' +
    'color-scheme:dark;display:none}' +
    '.enot-w-frame.enot-open{display:block}' +
    '@media (max-width:480px){' +
    '.enot-w-frame.enot-open{right:0;bottom:0;left:0;top:0;width:100vw;height:100vh;max-height:none;border-radius:0}' +
    '.enot-w-btn{right:12px;bottom:12px}}';
  document.head.appendChild(css);

  var frame = document.createElement('iframe');
  frame.className = 'enot-w-frame';
  frame.src = origin + '/w';
  frame.title = 'EnotDesk Chat';
  frame.setAttribute('allow', 'clipboard-write');

  var btn = document.createElement('button');
  btn.className = 'enot-w-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'EnotDesk Chat');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.6A.7.7 0 0 1 3.7 19l.3-3.2A2.5 2.5 0 0 1 4 13.5v-8Z" fill="currentColor"/></svg>';

  var open = false;
  function setOpen(next) {
    open = next;
    frame.classList.toggle('enot-open', open);
    btn.setAttribute('aria-expanded', String(open));
    postTo({ ns: 'enotdesk-w', type: open ? 'open' : 'close' });
  }
  function postTo(msg) {
    try { frame.contentWindow.postMessage(msg, origin); } catch (e) { /* iframe ещё не готов */ }
  }
  btn.addEventListener('click', function () { setOpen(!open); });

  window.addEventListener('message', function (e) {
    if (e.origin !== origin) return;
    var d = e.data;
    if (!d || d.ns !== 'enotdesk-w') return;
    if (d.type === 'height' && open && typeof d.h === 'number') {
      // высота от страницы чата: в разумных пределах, не выше вьюпорта
      var h = Math.max(240, Math.min(d.h, window.innerHeight - 110));
      frame.style.height = h + 'px';
    }
  });

  document.body.appendChild(frame);
  document.body.appendChild(btn);
})();
