// Stands in for chrome.* so preview.html can run switcher.js unchanged in a normal browser.
// Loaded only by preview.html.
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const svgUrl = (body, w, h) =>
    'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`);

  const fakeThumb = (hue) => svgUrl(
    `<rect width="320" height="200" fill="hsl(${hue} 45% 92%)"/>` +
    `<rect width="320" height="28" fill="hsl(${hue} 55% 40%)"/>` +
    `<rect x="16" y="48" width="180" height="12" fill="hsl(${hue} 20% 55%)"/>` +
    `<rect x="16" y="72" width="288" height="8" fill="hsl(${hue} 15% 75%)"/>` +
    `<rect x="16" y="90" width="260" height="8" fill="hsl(${hue} 15% 75%)"/>` +
    `<rect x="16" y="120" width="130" height="64" fill="hsl(${hue} 40% 70%)"/>`, 320, 200);

  const fakeFavicon = (hue) =>
    svgUrl(`<circle cx="8" cy="8" r="8" fill="hsl(${hue} 70% 50%)"/>`, 16, 16);

  // Each sample exercises one branch of the card rendering.
  const samples = [
    { title: 'Inbox (3) - Mail', thumbnail: true, favicon: true },
    { title: 'Now playing: a very long video title that has to be truncated to a single line', thumbnail: true, favicon: true, audible: true },
    { title: 'Pinned docs', thumbnail: true, favicon: true, pinned: true },
    { title: 'No thumbnail, large favicon', favicon: true },
    { title: 'No thumbnail, favicon fails to load', faviconUrl: 'https://invalid.invalid/favicon.ico' },
    { title: 'missing favicon, thumbnail present', thumbnail: true },
    { title: '<img src=x onerror=alert(1)> untrusted title stays text', audible: true, pinned: true },
    { title: '', url: 'https://example.com/empty-title' },
  ];

  const count = Number(params.get('tabs')) || samples.length;
  const items = Array.from({ length: count }, (_, i) => {
    const sample = samples[i % samples.length];
    const hue = (i * 47) % 360;
    return {
      tabId: 100 + i,
      title: sample.title,
      url: sample.url || `https://example.com/${i}`,
      favIconUrl: sample.faviconUrl || (sample.favicon ? fakeFavicon(hue) : undefined),
      thumbnail: sample.thumbnail ? fakeThumb(hue) : null,
      pinned: Boolean(sample.pinned),
      audible: Boolean(sample.audible),
    };
  });

  const sessionId = 'preview-session';
  let selectedIndex = Math.min(1, items.length - 1);
  const listeners = [];
  const emit = (message) => listeners.forEach((listener) => listener(message));

  globalThis.chrome = {
    runtime: {
      // No favicon cache outside the extension: this URL fails, so cards show the letter fallback.
      getURL: (path) => new URL(`.${path}`, location.href).href,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      async sendMessage(message) {
        console.log('[preview] sent', message);
        if (message.type !== 'hts:get-session') return undefined;
        return params.get('session') === 'none' ? null : { type: 'hts:render', sessionId, selectedIndex, items };
      },
    },
    tabs: {
      getCurrent: async () => ({ id: 1 }),
      sendMessage: async (...args) => console.log('[preview] tabs.sendMessage', ...args),
    },
  };

  window.addEventListener('keydown', (event) => {
    if (event.key !== '.' && event.key !== ',') return;
    const delta = event.key === '.' ? 1 : -1;
    selectedIndex = (selectedIndex + delta + items.length) % items.length;
    emit({ type: 'hts:update', sessionId, selectedIndex });
  });

  // Something busy behind the transparent page, to judge the backdrop and the panel.
  document.documentElement.style.background = 'linear-gradient(135deg, #f7f3e8 0 50%, #1f4e79 50% 100%)';
})();
