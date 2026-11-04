// Service worker: all chrome.* wiring. Pure logic lives in lib/mru.js and lib/session.js.
import { touch, remove, isLoaded, orderTabs } from './lib/mru.js';
import { createSession, step, removeItem, selectedTabId } from './lib/session.js';
import {
  captureThumbnail,
  storeThumbnail,
  deleteThumbnail,
  getThumbnails,
} from './lib/thumbs.js';

const UI_DELAY_MS = 120;
const SHOW_TIMEOUT_MS = 300;
const FOCUS_RECHECK_MS = 100;
const CAPTURE_DELAY_MS = 300;
// captureVisibleTab allows 2 calls per second, so stay just under that.
const CAPTURE_MIN_INTERVAL_MS = 550;
const POPUP_WIDTH = 860;
const POPUP_HEIGHT = 560;
const POPUP_PATH = 'src/switcher/switcher.html?mode=popup';
const STATE_KEYS = ['order', 'session', 'ui', 'popupWindowId'];

// ---------------------------------------------------------------------------
// Queue and state
// ---------------------------------------------------------------------------

// Every handler runs here, so a fast cycle-next then commit cannot interleave across awaits.
let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(task).catch((err) => {
    console.warn('hts: handler failed', err);
  });
  queueTail = run;
  return run;
}

// The worker can be killed at any time, so state lives in storage.session and this is a cache.
// Session items never hold thumbnails; they are attached when a payload is built.
// popupWindowId outlives the session: window ids are not reused, and a late activation event
// from a closing popup must still be recognised and kept out of the MRU.
let statePromise = null;
function getState() {
  statePromise ??= chrome.storage.session.get(STATE_KEYS).then((stored) => ({
    order: stored.order ?? [],
    session: stored.session ?? null,
    ui: stored.ui ?? null, // {originTabId, shown, mode: 'overlay'|'popup'|null}
    popupWindowId: stored.popupWindowId ?? null,
  }));
  return statePromise;
}

async function saveState() {
  const { order, session, ui, popupWindowId } = await getState();
  await chrome.storage.session.set({ order, session, ui, popupWindowId });
}

// ---------------------------------------------------------------------------
// Messaging helpers (fire and forget, so a stuck page cannot stall the queue)
// ---------------------------------------------------------------------------

function notifyPage(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // No page listening is normal.
}

function sendHide(tabId, sessionId) {
  chrome.tabs.sendMessage(tabId, { type: 'hts:hide', sessionId }, { frameId: 0 }).catch(() => {});
}

async function buildRenderPayload(state) {
  const { session } = state;
  const thumbnails = await getThumbnails(session.items.map((item) => item.tabId));
  return {
    type: 'hts:render',
    sessionId: session.id,
    selectedIndex: session.selectedIndex,
    items: session.items.map((item) => ({
      ...item,
      thumbnail: thumbnails.get(item.tabId) ?? null,
    })),
  };
}

async function broadcastRender(state) {
  notifyPage(await buildRenderPayload(state));
}

// ---------------------------------------------------------------------------
// Session UI
// ---------------------------------------------------------------------------

let showTimer = null;

function scheduleShow(sessionId) {
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    showTimer = null;
    enqueue(() => showUi(sessionId));
  }, UI_DELAY_MS);
}

function clearShowTimer() {
  clearTimeout(showTimer);
  showTimer = null;
}

// A hung page must not block the queue, so a slow reply counts as "no content script".
async function tryShowOverlay(tabId, sessionId) {
  const timeout = new Promise((resolve) => setTimeout(resolve, SHOW_TIMEOUT_MS, null));
  try {
    const send = chrome.tabs.sendMessage(tabId, { type: 'hts:show', sessionId }, { frameId: 0 });
    const reply = await Promise.race([send, timeout]);
    return reply?.ok === true;
  } catch {
    return false;
  }
}

async function openPopup(windowId) {
  const url = chrome.runtime.getURL(POPUP_PATH);
  const base = { url, type: 'popup', focused: true, width: POPUP_WIDTH, height: POPUP_HEIGHT };
  try {
    const origin = await chrome.windows.get(windowId);
    return await chrome.windows.create({
      ...base,
      left: Math.round(origin.left + (origin.width - POPUP_WIDTH) / 2),
      top: Math.round(origin.top + (origin.height - POPUP_HEIGHT) / 2),
    });
  } catch {
    // The browser rejects bounds that are mostly off screen, so let it place the window.
    return chrome.windows.create(base);
  }
}

async function activeTabId(windowId) {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  return tab?.id ?? null;
}

async function showUi(sessionId) {
  const state = await getState();
  const { session, ui } = state;
  if (session?.id !== sessionId || ui.shown) return;

  const tabId = ui.originTabId ?? (await activeTabId(session.windowId));
  const overlayOk = tabId !== null && (await tryShowOverlay(tabId, sessionId));
  if (overlayOk) {
    ui.originTabId = tabId; // endSession hides the overlay in this tab, so it must be recorded.
    ui.mode = 'overlay';
  } else {
    // Recorded before focus events are handled (they queue behind this task), so the
    // popup taking focus is never mistaken for focus leaving the browser.
    const popup = await openPopup(session.windowId);
    state.popupWindowId = popup.id;
    ui.mode = 'popup';
  }
  ui.shown = true;
  await saveState();
  await broadcastRender(state);
}

/** Clears the session and tears down its UI. */
async function endSession({ refocus }) {
  const state = await getState();
  const { session, ui } = state;
  if (!session) return;

  clearShowTimer();
  state.session = null;
  state.ui = null;

  // Before the save: if saving failed first, the hide would be skipped and the invisible
  // overlay would keep blocking clicks on the page.
  if (ui.shown) {
    notifyPage({ type: 'hts:close', sessionId: session.id });
    if (ui.originTabId !== null) sendHide(ui.originTabId, session.id);
  }
  await saveState();

  if (ui.mode === 'popup') {
    await chrome.windows.remove(state.popupWindowId).catch(() => {}); // It may have closed itself.
    if (refocus) await chrome.windows.update(session.windowId, { focused: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Session actions
// ---------------------------------------------------------------------------

function toItem(tab) {
  return {
    tabId: tab.id,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    favIconUrl: tab.favIconUrl ?? '',
    thumbnail: null,
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
  };
}

async function startSession(direction) {
  const state = await getState();
  // Normal windows only: this is what keeps the fallback popup out of every listing.
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const active = tabs.find((tab) => tab.active);

  // The active tab must be item 0 even if no activation was seen for it (fresh install),
  // otherwise a quick tap would not land on the previous tab.
  if (active) state.order = touch(state.order, active.id);
  const items = orderTabs(tabs, state.order).map(toItem);

  state.session = createSession(crypto.randomUUID(), win.id, items, direction);
  state.ui = { originTabId: active?.id ?? null, shown: false, mode: null };
  await saveState();
  scheduleShow(state.session.id);
}

async function cycle(direction) {
  const state = await getState();
  if (!state.session) {
    await startSession(direction);
    return;
  }
  state.session = step(state.session, direction);
  await saveState();
  if (state.ui.shown) {
    notifyPage({
      type: 'hts:update',
      sessionId: state.session.id,
      selectedIndex: state.session.selectedIndex,
    });
  } else if (showTimer === null) {
    scheduleShow(state.session.id); // The worker died before the first timer fired.
  }
}

async function commit(tabIdOverride) {
  const state = await getState();
  if (!state.session) return;
  const target = tabIdOverride ?? selectedTabId(state.session);

  // Close the popup first, so its closing cannot steal focus back from the target window.
  await endSession({ refocus: false });
  if (target === null) return;

  state.order = touch(state.order, target);
  await saveState();
  try {
    const tab = await chrome.tabs.update(target, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    console.debug('hts: commit target is gone', err); // Closed between select and commit.
  }
}

async function handleCommand(command) {
  if (command === 'cycle-next') await cycle('next');
  else if (command === 'cycle-prev') await cycle('prev');
  else if (command === 'commit') await commit();
  else if (command === 'cancel') await endSession({ refocus: true });
}

async function handleSelect({ sessionId, tabId }) {
  const { session } = await getState();
  if (session?.id !== sessionId) return;
  if (session.items.some((item) => item.tabId === tabId)) await commit(tabId);
}

async function getSessionPayload() {
  const state = await getState();
  return state.session ? buildRenderPayload(state) : null;
}

// ---------------------------------------------------------------------------
// Tab and window events
// ---------------------------------------------------------------------------

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function handleActivated({ tabId, windowId }) {
  const state = await getState();
  if (windowId === state.popupWindowId) return;

  state.order = touch(state.order, tabId);
  await saveState();
  scheduleCapture(tabId, windowId, CAPTURE_DELAY_MS);

  const { session, ui } = state;
  if (session?.windowId !== windowId || tabId === ui.originTabId) return;

  if (ui.originTabId !== null && (await tabExists(ui.originTabId))) {
    // The user switched tabs another way (tab strip, Ctrl+1), so the overlay is out of sight.
    await endSession({ refocus: false });
    return;
  }
  // The origin tab was closed and the browser picked a successor: keep going from there.
  ui.originTabId = tabId;
  await saveState();
  if (ui.shown && ui.mode === 'overlay') {
    ui.shown = false;
    await showUi(session.id);
  }
}

async function handleRemoved(tabId, { windowId, isWindowClosing }) {
  const state = await getState();
  state.order = remove(state.order, tabId);
  await saveState();
  await deleteThumbnail(tabId);

  const { session, ui } = state;
  if (session?.windowId !== windowId) return;
  if (isWindowClosing) {
    await endSession({ refocus: false });
    return;
  }

  if (ui.originTabId === tabId) ui.originTabId = null;
  state.session = removeItem(session, tabId);
  if (state.session.items.length === 0) {
    await endSession({ refocus: false });
    return;
  }
  await saveState();
  if (ui.shown) await broadcastRender(state);
}

async function handleWindowRemoved(windowId) {
  const { session, ui, popupWindowId } = await getState();
  if (!session) return;
  // Checking the mode matters: a late event from the previous session's popup must not
  // cancel a new session. The user closing the current popup is a cancel.
  if (ui.mode === 'popup' && windowId === popupWindowId) await endSession({ refocus: true });
  else if (windowId === session.windowId) await endSession({ refocus: false });
}

function isSessionWindow(state, windowId) {
  return (
    windowId === state.session.windowId ||
    (state.ui.mode === 'popup' && windowId === state.popupWindowId)
  );
}

async function handleFocusChanged(windowId) {
  const state = await getState();
  if (!state.session || isSessionWindow(state, windowId)) return;

  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    await endSession({ refocus: false });
    return;
  }
  // WINDOW_ID_NONE can fire briefly while focus moves between browser windows (such as into
  // the popup), so confirm it after a moment, outside the queue so commits are not delayed.
  const sessionId = state.session.id;
  setTimeout(() => enqueue(() => recheckFocus(sessionId)), FOCUS_RECHECK_MS);
}

async function recheckFocus(sessionId) {
  const state = await getState();
  if (state.session?.id !== sessionId) return;
  const windows = await chrome.windows.getAll();
  const focused = windows.find((win) => win.focused);
  if (!focused || !isSessionWindow(state, focused.id)) await endSession({ refocus: false });
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const captureTimers = new Map(); // windowId -> timer, so only the latest request per window runs.
let lastCaptureAt = 0;

function scheduleCapture(tabId, windowId, delay) {
  clearTimeout(captureTimers.get(windowId));
  captureTimers.set(windowId, setTimeout(() => runCapture(tabId, windowId), delay));
}

/** Capture only while no session is open and the tab is still the visible one. */
async function canCapture(tabId, windowId) {
  const state = await getState();
  if (state.session || windowId === state.popupWindowId) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab?.active && tab.windowId === windowId && isLoaded(tab));
}

async function runCapture(tabId, windowId) {
  captureTimers.delete(windowId);
  const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    scheduleCapture(tabId, windowId, wait);
    return;
  }
  if (!(await enqueue(() => canCapture(tabId, windowId)))) return;

  // Outside the queue: capture and downscale are slow and must not delay a commit.
  lastCaptureAt = Date.now();
  const dataUrl = await captureThumbnail(windowId);
  if (!dataUrl) return;

  // Re-checked: a session may have started, or the tab changed, while capturing.
  await enqueue(async () => {
    if (await canCapture(tabId, windowId)) await storeThumbnail(tabId, dataUrl);
  });
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function injectIntoExistingTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => !tab.discarded)
      .map((tab) =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['src/content/content.js'],
          injectImmediately: true,
        }),
      ),
  );
}

// ---------------------------------------------------------------------------
// Listeners: registered synchronously at top level so a woken worker gets its event.
// ---------------------------------------------------------------------------

// Tab data is for the extension page only. The overlay's URL has a random host because of
// use_dynamic_url, so check the scheme rather than comparing with runtime.getURL().
function fromExtensionPage(sender) {
  return String(sender.url ?? '').startsWith('chrome-extension://');
}

chrome.commands.onCommand.addListener((command) => {
  enqueue(() => handleCommand(command));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'hts:ctrl-up':
      enqueue(() => commit());
      return false;
    case 'hts:cancel':
      enqueue(async () => {
        const hadSession = Boolean((await getState()).session);
        await endSession({ refocus: true });
        // An overlay outliving its session must still be dismissible, or the page stays unclickable.
        if (!hadSession && sender.tab) sendHide(sender.tab.id, null);
      });
      return false;
    case 'hts:select':
      if (fromExtensionPage(sender)) enqueue(() => handleSelect(message));
      return false;
    case 'hts:get-session':
      if (!fromExtensionPage(sender)) {
        sendResponse(null);
        return false;
      }
      enqueue(getSessionPayload).then((payload) => sendResponse(payload ?? null));
      return true; // Keeps the channel open for the async reply.
    default:
      return false;
  }
});

chrome.tabs.onActivated.addListener((info) => {
  enqueue(() => handleActivated(info));
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  enqueue(() => handleRemoved(tabId, info));
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.active) {
    scheduleCapture(tabId, tab.windowId, CAPTURE_DELAY_MS);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  enqueue(() => handleFocusChanged(windowId));
});

chrome.windows.onRemoved.addListener((windowId) => {
  enqueue(() => handleWindowRemoved(windowId));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    // Outside the queue: a slow tab here must not hold up commands.
    injectIntoExistingTabs().catch((err) => console.debug('hts: inject failed', err));
  }
});
