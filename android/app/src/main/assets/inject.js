// Injected at document-start into the FreeView page and the YouTube embed
// iframe (see MainActivity.ORIGINS). Two jobs:
//  1. Make the page always look visible, so the YouTube player never pauses
//     itself when the app goes to the background or the screen turns off.
//  2. Report play/pause/title to the app (for the notification) and accept
//     play/pause commands from it.
(function () {
  if (window.__fvInjected) return;
  window.__fvInjected = true;

  // ── 1. Always visible ────────────────────────────────────────────────────
  function constGetter(proto, prop, value) {
    try {
      Object.defineProperty(proto, prop, { configurable: true, get: function () { return value; } });
    } catch (e) { /* ignore */ }
  }
  constGetter(Document.prototype, 'hidden', false);
  constGetter(Document.prototype, 'webkitHidden', false);
  constGetter(Document.prototype, 'visibilityState', 'visible');
  constGetter(Document.prototype, 'webkitVisibilityState', 'visible');
  try { Document.prototype.hasFocus = function () { return true; }; } catch (e) { /* ignore */ }

  // Swallow page-level lifecycle events before any page script sees them.
  // Only events targeted at the window/document are blocked, so element
  // blur/focus events (e.g. on inputs) keep working.
  function swallow(e) {
    if (e.target === window || e.target === document) e.stopImmediatePropagation();
  }
  ['visibilitychange', 'webkitvisibilitychange', 'pagehide', 'freeze', 'blur'].forEach(function (t) {
    window.addEventListener(t, swallow, true);
    document.addEventListener(t, swallow, true);
  });

  // ── 2. Bridge to the app ─────────────────────────────────────────────────
  var bridge = window.FreeViewNative;
  if (!bridge) return;

  function send(obj) {
    try { bridge.postMessage(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  var isTop = window.top === window;

  if (isTop) {
    // FreeView page: report the page title (used as the notification title).
    var lastTitle = '';
    var reportTitle = function () {
      var t = (document.title || '').replace(/\s+[–-]\s+FreeView$/, '');
      if (t && t !== lastTitle) { lastTitle = t; send({ type: 'title', title: t }); }
    };
    setInterval(reportTitle, 1000);
    // Leaving the watch page / Shorts viewer stops the player.
    window.addEventListener('hashchange', function () {
      if (!/^#(watch|shorts)\?/.test(location.hash)) send({ type: 'state', state: 'stopped' });
    });
    return;
  }

  // YouTube player frame: report playback state, obey commands.
  function video() { return document.querySelector('video'); }

  ['playing', 'pause', 'ended'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      if (!(e.target instanceof HTMLMediaElement)) return;
      send({ type: 'state', state: t === 'playing' ? 'playing' : (t === 'ended' ? 'ended' : 'paused') });
    }, true);
  });

  bridge.onmessage = function (ev) {
    var v = video();
    if (!v) return;
    if (ev.data === 'play') {
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* ignore */ });
    } else if (ev.data === 'pause') {
      v.pause();
    }
  };
})();
