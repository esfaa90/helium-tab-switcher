// Helium Tab Switcher content script. Classic script, runs at document_start in all frames.
// Every frame reports Ctrl release and Esc; only the top frame hosts the overlay.
(() => {
  'use strict';

  const INSTANCE_KEY = '__heliumTabSwitcherTeardown';
  const OVERLAY_PATH = 'src/switcher/switcher.html';
  const MAX_Z_INDEX = '2147483647';
  // Must equal the color-scheme in switcher.css, or Chromium paints the iframe opaque white.
  const COLOR_SCHEME = 'dark';

  const SHARED_STYLES = [
    ['all', 'initial'],
    ['display', 'block'],
    ['position', 'fixed'],
    ['inset', '0'],
    ['width', '100%'],
    ['height', '100%'],
    ['max-width', 'none'],
    ['max-height', 'none'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
    ['overflow', 'hidden'],
    ['background', 'transparent'],
    ['pointer-events', 'auto'],
    ['z-index', MAX_Z_INDEX],
    ['color-scheme', COLOR_SCHEME],
  ];

  const isTopFrame = window === window.top;
  let host = null;
  let shownSessionId = null;
  let rootObserver = null;

  // A re-injection after an update finds the earlier instance here and retires it,
  // so there are never two sets of listeners sending duplicate messages.
  if (typeof window[INSTANCE_KEY] === 'function') window[INSTANCE_KEY]();
  window[INSTANCE_KEY] = teardown;

  function isContextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function send(message) {
    if (!isContextAlive()) {
      teardown();
      return;
    }
    try {
      chrome.runtime.sendMessage(message).catch((err) => {
        // Other failures (worker restarting, no receiver) are harmless: the worker ignores
        // these messages when no session is open anyway.
        if (String(err && err.message).includes('Extension context invalidated')) teardown();
      });
    } catch {
      teardown();
    }
  }

  function onKeyUp(event) {
    if (event.isTrusted && event.key === 'Control') send({ type: 'hts:ctrl-up' });
  }

  function onKeyDown(event) {
    if (!event.isTrusted || event.key !== 'Escape') return;
    if (isTopFrame && host) event.preventDefault();
    send({ type: 'hts:cancel' });
  }

  // Inline !important beats any host page rule, and CSSOM writes are not blocked by a page's CSP.
  function applyStyles(element) {
    for (const [name, value] of SHARED_STYLES) element.style.setProperty(name, value, 'important');
  }

  function buildHost() {
    // Explicit namespace, because attachShadow would throw on a non-HTML element in an XML document.
    const element = document.createElementNS('http://www.w3.org/1999/xhtml', 'hts-overlay');
    applyStyles(element);

    const iframe = document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe');
    iframe.tabIndex = -1;
    iframe.title = 'Tab switcher';
    applyStyles(iframe);
    iframe.src = chrome.runtime.getURL(OVERLAY_PATH) + '?mode=overlay';

    element.attachShadow({ mode: 'closed' }).appendChild(iframe);
    return element;
  }

  function mount(element) {
    document.documentElement.appendChild(element);
    // z-index cannot beat a modal dialog or a fullscreen element, but the top layer can.
    // A manual popover with no autofocus inside does not move focus.
    try {
      element.popover = 'manual';
      element.showPopover();
    } catch {
      // No top layer available; the z-index still covers ordinary pages.
    }
  }

  function showOverlay(sessionId) {
    if (host && shownSessionId === sessionId) return;
    hideOverlay();

    const element = buildHost();
    host = element;
    shownSessionId = sessionId;

    if (document.documentElement) {
      mount(element);
      return;
    }
    // At document_start the root element may not be parsed yet.
    rootObserver = new MutationObserver(() => {
      if (!document.documentElement) return;
      rootObserver.disconnect();
      rootObserver = null;
      mount(element);
    });
    rootObserver.observe(document, { childList: true });
  }

  function hideOverlay() {
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }
    if (host) host.remove();
    host = null;
    shownSessionId = null;
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message) return;
    if (message.type === 'hts:show') {
      showOverlay(message.sessionId);
      sendResponse({ ok: true });
    } else if (message.type === 'hts:hide') {
      // Removes whatever is showing, whatever its sessionId: a stuck full-viewport iframe
      // would block the page, which is far worse than a closed overlay.
      hideOverlay();
      sendResponse({ ok: true });
    }
  }

  function teardown() {
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('keydown', onKeyDown, true);
    if (isTopFrame) {
      window.removeEventListener('pagehide', hideOverlay, true);
      try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      } catch {
        // The context is already gone, and its listener with it.
      }
    }
    hideOverlay();
    if (window[INSTANCE_KEY] === teardown) delete window[INSTANCE_KEY];
  }

  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('keydown', onKeyDown, true);
  if (isTopFrame) {
    // A page restored from the back/forward cache would otherwise come back with a dead overlay.
    window.addEventListener('pagehide', hideOverlay, true);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }
})();
