// Renders the switcher in both modes (?mode=overlay, ?mode=popup).
// Tab titles and URLs are untrusted, so they only ever reach the DOM as textContent or attributes.
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    audible: {
      label: 'Playing audio',
      path: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    },
    pinned: {
      label: 'Pinned',
      path: 'M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z',
    },
  };
  const SCROLL_MARGIN_PX = 12;

  const isPopup = new URLSearchParams(location.search).get('mode') === 'popup';
  const backdrop = document.getElementById('backdrop');
  const panel = document.getElementById('panel');

  let currentSessionId = null;
  let cards = [];
  let selectedCard = null;

  document.documentElement.dataset.mode = isPopup ? 'popup' : 'overlay';

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return undefined; // Worker restarting or context gone; the caller treats this as "no answer".
    }
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  function firstLetter(item) {
    const source = (item.title || '').trim() || hostnameOf(item.url) || '?';
    return Array.from(source)[0].toUpperCase();
  }

  function makeLetter(item, sizeClass) {
    const letter = document.createElement('span');
    letter.className = `icon letter ${sizeClass}`;
    letter.textContent = firstLetter(item);
    return letter;
  }

  function makeIcon(item, sizeClass) {
    // Internal pages (helium://, chrome://) have no site favicon, so skip straight to the letter.
    if (!/^https?:/i.test(item.url || '')) return makeLetter(item, sizeClass);
    const img = document.createElement('img');
    img.className = `icon ${sizeClass}`;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(makeLetter(item, sizeClass)), { once: true });
    // The browser's own favicon cache, so opening the switcher never contacts the site.
    const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
    favicon.searchParams.set('pageUrl', item.url);
    favicon.searchParams.set('size', '64');
    img.src = favicon.href;
    return img;
  }

  function makeThumb(item) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (!/^data:image\//i.test(item.thumbnail || '')) {
      thumb.append(makeIcon(item, 'icon-lg'));
      return thumb;
    }
    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(makeIcon(item, 'icon-lg')), { once: true });
    img.src = item.thumbnail;
    thumb.append(img);
    return thumb;
  }

  function makeIndicator({ label, path }) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'indicator');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    const shape = document.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  }

  function makeCard(item) {
    const label = item.title || item.url || 'Untitled';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = label;

    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.append(makeIcon(item, 'icon-sm'), title);

    if (item.audible || item.pinned) {
      const indicators = document.createElement('span');
      indicators.className = 'indicators';
      if (item.audible) indicators.append(makeIndicator(ICONS.audible));
      if (item.pinned) indicators.append(makeIndicator(ICONS.pinned));
      caption.append(indicators);
    }

    const card = document.createElement('div');
    card.className = 'card';
    card.title = label;
    card.dataset.tabId = String(item.tabId);
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', 'false');
    card.append(makeThumb(item), caption);
    return card;
  }

  // Scrolls only the panel. scrollIntoView could also try to scroll the host page's ancestors.
  function keepInView(card) {
    const view = panel.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    if (box.top < view.top + SCROLL_MARGIN_PX) {
      panel.scrollTop -= view.top + SCROLL_MARGIN_PX - box.top;
    } else if (box.bottom > view.bottom - SCROLL_MARGIN_PX) {
      panel.scrollTop += box.bottom - (view.bottom - SCROLL_MARGIN_PX);
    }
  }

  function select(index) {
    if (selectedCard) {
      selectedCard.classList.remove('selected');
      selectedCard.setAttribute('aria-selected', 'false');
    }
    selectedCard = cards[Math.min(Math.max(index, 0), cards.length - 1)] || null;
    if (!selectedCard) return;
    selectedCard.classList.add('selected');
    selectedCard.setAttribute('aria-selected', 'true');
    keepInView(selectedCard);
  }

  function render(session) {
    currentSessionId = session.sessionId;
    const items = Array.isArray(session.items) ? session.items : [];
    cards = items.map(makeCard);
    selectedCard = null;
    if (cards.length > 0) {
      panel.replaceChildren(...cards);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No loaded tabs';
      panel.replaceChildren(empty);
    }
    backdrop.hidden = false; // Before select(), because a hidden card has no geometry to scroll to.
    select(session.selectedIndex);
  }

  // A null reply means the session ended while this page loaded. A popup just closes. An overlay
  // normally gets hts:hide from the worker, but if that was lost (say, a worker restart) a
  // transparent iframe would swallow every click on the page, so it asks to be removed.
  async function dismissOrphan() {
    if (isPopup) {
      window.close();
      return;
    }
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'hts:hide', sessionId: null }, { frameId: 0 });
    } catch {
      // No content script to reach, so there is no overlay left to remove either.
    }
  }

  function onRuntimeMessage(message) {
    if (!message) return;
    switch (message.type) {
      case 'hts:render':
        // With no session yet, the first render is adopted; it may beat the get-session reply.
        if (currentSessionId === null || message.sessionId === currentSessionId) render(message);
        break;
      case 'hts:update':
        if (message.sessionId === currentSessionId) select(message.selectedIndex);
        break;
      case 'hts:close':
        if (isPopup && message.sessionId === currentSessionId) window.close();
        break;
    }
  }

  // Overlay mode gets these too: a click inside the iframe can move focus away from the host page.
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Control') send({ type: 'hts:ctrl-up' });
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    send({ type: 'hts:cancel' });
  }, true);

  // Keeps focus in the host page's input, so it is still there after the overlay goes away.
  document.addEventListener('mousedown', (event) => event.preventDefault());

  document.addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (card) {
      send({ type: 'hts:select', sessionId: currentSessionId, tabId: Number(card.dataset.tabId) });
    } else if (!panel.contains(event.target)) {
      send({ type: 'hts:cancel' });
    }
  });

  // Listen first, then ask, so a render sent during the request is not missed.
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  send({ type: 'hts:get-session' }).then((session) => {
    if (currentSessionId !== null) return; // A render already arrived and is at least as new.
    if (session) render(session);
    else dismissOrphan();
  });
})();
