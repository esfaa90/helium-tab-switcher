# Helium Tab Switcher: shared contract

Every part of the extension builds against this file. If it needs to change, report that
to the orchestrator instead of silently diverging.

## Behaviour
- Hold Ctrl, tap the cycle key to move, release Ctrl to switch. A quick tap goes to the previous tab.
- Lists **loaded tabs only**, in the **session's window only**, most recently used first.
- Loaded means `!tab.discarded && tab.status !== 'unloaded'`. Frozen tabs still count as loaded.
- Esc cancels. Clicking a card switches to it. Clicking the backdrop cancels.

## File ownership
| Path | Owner |
|---|---|
| `manifest.json`, `src/background.js`, `src/lib/mru.js`, `src/lib/session.js`, `src/lib/thumbs.js` | Core |
| `src/content/content.js`, `src/switcher/switcher.html`, `.css`, `.js` | UI |
| `ahk/helium-tab-switcher.ahk`, `README.md` | Hotkey |
| `tests/**` | Tests |

Only edit files you own. Plain JS with no build step and no npm dependencies.
Do not run `git add`, `git commit` or `git push`.

## Commands (`chrome.commands`)
| Name | Suggested key | Meaning |
|---|---|---|
| `cycle-next` | Ctrl+Period | Start a session, or select the next card |
| `cycle-prev` | Ctrl+Comma | Start a session, or select the previous card |
| `commit` | Ctrl+Shift+Period | Switch to the selected tab |
| `cancel` | Ctrl+Shift+Comma | Close without switching |

AutoHotkey maps real Ctrl+Tab and Ctrl+Shift+Tab to the first two. It sends `commit` when Ctrl is
physically released, and `cancel` on Esc during a session. This is how release is detected when
focus is in the address bar, where content scripts see no key events.

## Messages (all carry a `type`)
### To the service worker, via `chrome.runtime.sendMessage`
- `{type:'hts:ctrl-up'}`: Ctrl released. Commits if a session is open, otherwise ignored.
- `{type:'hts:cancel'}`: Esc pressed. Cancels if a session is open, otherwise ignored.
- `{type:'hts:select', sessionId, tabId}`: a card was clicked. Commit to that tab.
- `{type:'hts:get-session'}`: replies with the `hts:render` payload, or `null` if no session is open.

### From the service worker to the content script, via `chrome.tabs.sendMessage(tabId, msg, {frameId:0})`
- `{type:'hts:show', sessionId}`: insert the overlay iframe. Reply `{ok:true}`.
  A rejected send means no content script is present, so the worker opens the popup fallback.
- `{type:'hts:hide', sessionId}`: remove the overlay iframe.

### From the service worker to the switcher page, via `chrome.runtime.sendMessage`
- `{type:'hts:render', sessionId, selectedIndex, items}`
- `{type:'hts:update', sessionId, selectedIndex}`
- `{type:'hts:close', sessionId}`: in popup mode, the page closes itself.

Item shape: `{tabId, title, url, favIconUrl, thumbnail, pinned, audible}`, where `thumbnail` is a
data URL or `null`. Tab data only goes through runtime messaging to the extension page and never
into the host page's DOM. The switcher page ignores messages whose `sessionId` is not its current one.

## UI surfaces
A single page, `src/switcher/switcher.html`, serves both modes via `?mode=overlay` or `?mode=popup`.

- **Overlay:** the content script (top frame only) adds a fixed, full-viewport, transparent iframe of
  this page inside a closed shadow root. The iframe must not take focus, so key events keep going to
  the host page.
- **Popup:** for pages with no content script (`helium://`, Web Store). A small centred popup window
  via `chrome.windows.create({type:'popup'})`. It has focus, so the page itself handles keyup/keydown.
- The page calls `hts:get-session` on load, because `hts:render` may fire before it is listening.

## Content script
Runs at `document_start` in **all frames**. Keeps two capture-phase listeners on `window`:
- `keyup` of Control: send `hts:ctrl-up`. It is stateless, so a quick tap still commits even if the
  key is released before the overlay appears.
- `keydown` of Escape: send `hts:cancel`. Call `preventDefault` only in the top frame while the overlay is showing.

Only the top frame handles `hts:show` and `hts:hide`. Guard against "Extension context invalidated"
errors after a reload.

## Service worker rules
- Register listeners synchronously at top level. Run all command and message handling through one
  promise queue so a fast `cycle-next` then `commit` cannot interleave.
- Persist MRU data in `chrome.storage.session`, because the worker can be killed at any time.
- A session is pinned to the window it started in. Later commands use that window even if the fallback popup has focus.
- Do not show UI for the first 120 ms of a session. A quick tap should commit with nothing flashing on screen.
- Inject the content script into existing tabs on install or update, ignoring failures.
- Closing a tab during a session removes its item and re-renders. If the selected item is gone, clamp the index.
- If focus leaves the browser (`WINDOW_ID_NONE`) or moves to an unrelated window, cancel the session.
- Thumbnails: capture with `chrome.tabs.captureVisibleTab` about 300 ms after activation and on
  `status: complete` for the active tab. Skip while a session is open, so the overlay is never captured.
  Handle the capture rate limit quietly. Downscale to 320 px wide JPEG with `OffscreenCanvas`, keep them
  in `chrome.storage.session`, evict least recently used to stay under 8 MB, delete when a tab closes.
- Permissions: `tabs`, `storage`, `scripting`, `favicon` (the browser favicon cache, so no site is contacted), and host permission `<all_urls>`. Nothing else, no network calls.
- `web_accessible_resources`: `src/switcher/switcher.html`, `.css` and `.js` with `use_dynamic_url: true`.

## Pure logic (no `chrome.*`, ES modules, tested with `node --test`)
`src/lib/mru.js`
- `touch(order, tabId)`: new array with `tabId` at the front.
- `remove(order, tabId)`: new array without `tabId`.
- `isLoaded(tab)`: the loaded rule above.
- `orderTabs(tabs, order)`: loaded tabs only. Tabs in `order` come first, in that order. The rest
  follow by `lastAccessed` descending. Does not mutate its inputs.

`src/lib/session.js`
- `createSession(id, windowId, items, direction)`: `direction` is `'next'` or `'prev'`. Starts at
  index 1 for next and the last index for prev, or 0 when there is only one item. Returns
  `{id, windowId, items, selectedIndex}`.
- `step(session, direction)`: new session with the index moved, wrapping at both ends.
- `removeItem(session, tabId)`: new session without that item, index clamped. If an item before the
  selection was removed, the selection stays on the same tab.
- `selectedTabId(session)`: the selected tab's id, or `null` if there are no items.
