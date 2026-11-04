# Helium Tab Switcher

A Manifest V3 extension for Helium that adds an Alt+Tab style tab switcher. Hold Ctrl, tap a key to
move through the list, and release Ctrl to switch. A quick tap goes to the previous tab.

It lists loaded tabs only, in the current window, most recently used first. Esc cancels. You can also
click a card to switch to it, or click the backdrop to cancel.

An optional AutoHotkey v2 script maps real Ctrl+Tab and Ctrl+Shift+Tab to the extension, because
extensions can't bind those keys themselves.

## Load the extension

1. Open `helium://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked and select this folder (the one containing `manifest.json`).

## Check the shortcuts

Open `helium://extensions/shortcuts`. These four should be set. Suggested keys aren't always applied,
for example when another extension already uses them, so set any that are missing by hand.

| Command | Key | What it does |
|---|---|---|
| `cycle-next` | Ctrl+Period | Open the switcher, or select the next card |
| `cycle-prev` | Ctrl+Comma | Open the switcher, or select the previous card |
| `commit` | Ctrl+Shift+Period | Switch to the selected tab |
| `cancel` | Ctrl+Shift+Comma | Close without switching |

The AutoHotkey script sends exactly these keys. If you change them, edit the script to match.

## Run the AutoHotkey script

Requires [AutoHotkey v2](https://www.autohotkey.com/). Double-click `ahk/helium-tab-switcher.ahk`, or run:

```
"C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe" ahk\helium-tab-switcher.ahk
```

To start it at login, press Win+R, enter `shell:startup`, and put a shortcut to the script in that folder.

The script only remaps Ctrl+Tab when Helium is the active window. It identifies Helium by its full path,
`%LOCALAPPDATA%\imput\Helium\Application\chrome.exe`, so Google Chrome isn't affected. If Helium is
installed elsewhere, change `HELIUM_EXE` at the top of the script.

## Without the script

Hold Ctrl and tap `.` to go forward or `,` to go back, then release Ctrl to switch.

## Known limitations

- A thumbnail appears only after the tab has been visited with the extension running.
- Extensions can't draw on restricted pages such as `helium://` pages and the Web Store, so a small popup
  window appears there instead of the overlay.
- Without the script, the release of Ctrl isn't detected while focus is in the address bar, and neither
  is Esc. Press Ctrl+Shift+Period to switch or Ctrl+Shift+Comma to cancel.

## Privacy

To show thumbnails, the extension takes a screenshot of every page you visit, including sensitive ones
such as banking sites, and any of them can appear in the switcher. Screenshots are kept only in session
memory (`chrome.storage.session`) and are gone when the tab or the browser closes. The extension makes no
network calls.

It asks for access to all sites (`<all_urls>`) because capturing a tab needs it, and because the overlay
and the Ctrl release detection have to run on every page. Pages only ever send the extension Ctrl and Esc
presses; nothing else you type is read.
