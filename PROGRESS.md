# Progress

Every item starts as failing and is ticked only with test evidence.

Evidence commands:
- Unit: `node --test`
- Browser: `node tests/e2e/helium-e2e.mjs <folder for screenshots>`. It runs a headless Helium with a
  temp profile and fires the extension commands directly, so it does not press real shortcuts.

- [x] Extension loads in Helium (MV3) and all four shortcuts are registered (browser)
- [x] Tab list contains loaded tabs only (no discarded or unloaded tabs) (browser: discarded; unit: unloaded)
- [ ] Tabs are ordered by most recent use and the order survives a service worker restart (order passes in browser; restart not tested in a browser)
- [x] Selection steps forward and back and wraps at both ends (unit)
- [ ] Quick tap switches to the previous tab with no overlay flash (switch passes in browser; no flash needs checking by eye)
- [ ] Hold Ctrl and tap to cycle, release to switch (normal web page) (needs real keys; simulated Ctrl keyup passes)
- [x] Esc cancels, clicking a card switches, clicking the backdrop cancels (browser)
- [ ] Popup fallback works on restricted pages (`helium://`) (opens and closes on `chrome://version` in browser; switching from it not tested)
- [ ] Thumbnails appear for visited tabs and the overlay is never captured (appear in screenshot; "never captured" not proven)
- [ ] AutoHotkey script: real Ctrl+Tab and Ctrl+Shift+Tab work in Helium (syntax check only, never run)
- [ ] AutoHotkey script: release commits when focus is in the address bar (never run)
- [ ] AutoHotkey script: real Chrome is unaffected (never run)
