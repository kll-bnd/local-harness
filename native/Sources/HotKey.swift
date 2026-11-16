// The optional global shortcut (desktop.json "globalShortcut", Electron accelerator syntax), registered with
// Carbon's RegisterEventHotKey: system-wide, needs no Accessibility permission and sees no other keys.
import Carbon
import Foundation

final class GlobalHotKey {
    private var ref: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: () -> Void
    let accelerator: String

    init(accelerator: String, action: @escaping () -> Void) {
        self.accelerator = accelerator
        self.action = action
    }

    /// Returns nil on success, else a reason.
    func register() -> String? {
        guard let (code, mods) = GlobalHotKey.parse(accelerator) else { return "cannot parse \(accelerator)" }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        let st = InstallEventHandler(GetApplicationEventTarget(), { (_: EventHandlerCallRef?, _: EventRef?, user: UnsafeMutableRawPointer?) -> OSStatus in
            guard let user = user else { return noErr }
            let hk = Unmanaged<GlobalHotKey>.fromOpaque(user).takeUnretainedValue()
            DispatchQueue.main.async { hk.action() }
            return noErr
        }, 1, &spec, me, &handlerRef)
        if st != noErr { return "InstallEventHandler failed (\(st))" }
        let id = EventHotKeyID(signature: OSType(0x484E_4553), id: 1) // 'HNES'
        let r = RegisterEventHotKey(UInt32(code), UInt32(mods), id, GetApplicationEventTarget(), 0, &ref)
        if r != noErr {
            if let h = handlerRef { RemoveEventHandler(h); handlerRef = nil }
            return r == OSStatus(eventHotKeyExistsErr) ? "already used by another app" : "RegisterEventHotKey failed (\(r))"
        }
        return nil
    }

    func unregister() {
        if let r = ref { UnregisterEventHotKey(r); ref = nil }
        if let h = handlerRef { RemoveEventHandler(h); handlerRef = nil }
    }

    /// "CommandOrControl+Shift+Space" → (kVK_Space, cmdKey | shiftKey).
    static func parse(_ acc: String) -> (Int, Int)? {
        let parts = acc.split(separator: "+", omittingEmptySubsequences: false).map { String($0) }
        // "CommandOrControl++" style (Plus key) is written as "Plus" in Electron; an empty part is invalid.
        guard parts.count >= 2, !parts.contains(where: { $0.isEmpty }) else { return nil }
        var mods = 0
        for m in parts.dropLast() {
            switch m.lowercased() {
            case "command", "cmd", "commandorcontrol", "cmdorctrl", "super", "meta": mods |= cmdKey
            case "control", "ctrl": mods |= controlKey
            case "alt", "option", "altgr": mods |= optionKey
            case "shift": mods |= shiftKey
            default: return nil
            }
        }
        guard mods != 0, let code = keyCode(parts.last!) else { return nil }
        return (code, mods)
    }

    static func keyCode(_ k: String) -> Int? {
        let letters: [Character: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
            "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
            "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
            "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
            "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket, ";": kVK_ANSI_Semicolon,
            "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash, "\\": kVK_ANSI_Backslash, "`": kVK_ANSI_Grave,
        ]
        if k.count == 1, let c = k.lowercased().first, let code = letters[c] { return code }
        let named: [String: Int] = [
            "space": kVK_Space, "tab": kVK_Tab, "enter": kVK_Return, "return": kVK_Return, "escape": kVK_Escape, "esc": kVK_Escape,
            "backspace": kVK_Delete, "delete": kVK_ForwardDelete, "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow,
            "right": kVK_RightArrow, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown, "plus": kVK_ANSI_Equal,
            "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9,
            "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12, "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15, "f16": kVK_F16,
            "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19, "f20": kVK_F20,
        ]
        return named[k.lowercased()]
    }
}
