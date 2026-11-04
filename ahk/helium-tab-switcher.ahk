; Maps real Ctrl+Tab / Ctrl+Shift+Tab to the Helium Tab Switcher extension's commands
; and tells it when Ctrl is released. See docs/CONTRACT.md.
;
;   cycle-next  Ctrl+Period         commit  Ctrl+Shift+Period
;   cycle-prev  Ctrl+Comma          cancel  Ctrl+Shift+Comma

#Requires AutoHotkey v2.0
#SingleInstance Force
; GetKeyState(key, "P") only reports the true physical state when the hook is installed.
InstallKeybdHook()
; The hook would otherwise keep recent keypresses, which can include passwords, viewable in memory.
KeyHistory 0

; Real Google Chrome is also chrome.exe, so the process name alone can't identify Helium.
HELIUM_EXE := EnvGet("LOCALAPPDATA") "\imput\Helium\Application\chrome.exe"

; Holding Tab auto-repeats about 30 times a second, close to the default limit of 70 per 2 s.
; Without this, a long hold could trigger AutoHotkey's "too many hotkeys" dialog.
A_MaxHotkeysPerInterval := 200

; True from the first cycle key until Ctrl is released or Esc cancels.
sessionActive := false

IsHeliumActive() {
    ; WinGetProcessPath throws when there is no active window, or when access is denied.
    try
        return WinGetProcessPath("A") = HELIUM_EXE ; "=" is case-insensitive in v2.
    catch
        return false
}

Cycle(keys) {
    global sessionActive
    ; Set before sending, so a Ctrl release handled right after this always sees the flag.
    sessionActive := true
    Send keys
}

ReleaseStuckModifiers() {
    ; Only touches keys that are logically down but physically up, so a Shift the user is
    ; really holding stays held.
    for key in ["LCtrl", "RCtrl", "LShift", "RShift"]
        if GetKeyState(key) && !GetKeyState(key, "P")
            Send "{Blind}{" key " up}"
}

OnCtrlReleased(otherCtrl) {
    global sessionActive
    ; The flag is checked here and not with #HotIf: on a very fast tap, #HotIf could be
    ; evaluated before the Ctrl+Tab thread has run. Threads run in order, so this can't miss it.
    if !sessionActive || GetKeyState(otherCtrl, "P")
        return
    sessionActive := false
    ; If the user switched to another app mid-session, the extension has already cancelled, and
    ; this keystroke would land in that app. The fallback popup is also Helium, so it still passes.
    ; This throws when no window is active, such as while the popup takes focus. Sending anyway
    ; is safe there, and skipping it would leave the popup open.
    try {
        if WinGetProcessPath("A") != HELIUM_EXE
            return
    }
    ; The physical release has already passed through, so this presses Ctrl and Shift itself.
    Send "^+{vkBE}"
    ReleaseStuckModifiers()
}

#HotIf IsHeliumActive()
; Virtual-key codes, because "." and "," are on different keys on non-US layouts.
; A Send without {Blind} leaves Ctrl down (it is listed and already held). The browser sees no
; Ctrl release, and the session stays open.
^Tab::Cycle("^{vkBE}")
; Shift isn't listed, so Send lifts it for this keystroke and restores it afterwards if it is
; still physically held. The browser receives Ctrl+Comma, not Ctrl+Shift+Comma (cancel).
^+Tab::Cycle("^{vkBC}")
#HotIf

; "*" is needed because Shift may still be held when Ctrl is released after Ctrl+Shift+Tab.
; "~" lets the release reach applications. These stay active in every window, because the
; fallback popup may have focus. They do nothing unless the session flag is set.
~*LCtrl up::OnCtrlReleased("RCtrl")
~*RCtrl up::OnCtrlReleased("LCtrl")

; Also requires Helium, so a stale flag can't swallow Esc in other apps.
#HotIf sessionActive && IsHeliumActive()
; "*" is needed because Ctrl is held during a session, and a plain Esc hotkey wouldn't fire.
; It also stops Ctrl+Esc from opening the Start menu.
*Esc:: {
    global sessionActive
    ; Cleared first, so the later Ctrl release doesn't commit.
    sessionActive := false
    ; Ctrl stays down if it is still held; the Send restores the physical state afterwards.
    Send "^+{vkBC}"
}
#HotIf
