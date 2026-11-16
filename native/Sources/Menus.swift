// The native menu bar and Dock menu: the same 15 page actions and accelerators as the Electron shell
// (electron/lib/menu.cjs), plus the standard macOS items, which AppKit and WKWebView implement themselves.
import AppKit

struct PageCommand {
    let action: String
    let title: String
    let key: String
    let mods: NSEvent.ModifierFlags
}

enum Menus {
    static let commands: [String: PageCommand] = {
        let list = [
            PageCommand(action: "new-chat", title: "New Chat", key: "n", mods: [.command]),
            PageCommand(action: "open-settings", title: "Settings…", key: ",", mods: [.command]),
            PageCommand(action: "toggle-sidebar", title: "Toggle Sidebar", key: "s", mods: [.control, .command]),
            PageCommand(action: "toggle-inspector", title: "Toggle Inspector", key: "i", mods: [.option, .command]),
            PageCommand(action: "search-chats", title: "Search Chats…", key: "f", mods: [.command]),
            PageCommand(action: "command-palette", title: "Command Palette…", key: "k", mods: [.command]),
            PageCommand(action: "open-models", title: "Models", key: "1", mods: [.command]),
            PageCommand(action: "open-images", title: "Images", key: "2", mods: [.command]),
            PageCommand(action: "open-memory", title: "Memory", key: "3", mods: [.command]),
            PageCommand(action: "focus-composer", title: "Focus Message Box", key: "l", mods: [.command]),
            PageCommand(action: "stop-generation", title: "Stop Generating", key: ".", mods: [.command]),
            PageCommand(action: "export-chat", title: "Export Chat…", key: "e", mods: [.shift, .command]),
            PageCommand(action: "import-chat", title: "Import Chat…", key: "o", mods: [.command]),
            PageCommand(action: "show-shortcuts", title: "Keyboard Shortcuts", key: "/", mods: [.command]),
            PageCommand(action: "lock", title: "Lock Harness", key: "l", mods: [.control, .command]),
        ]
        var d: [String: PageCommand] = [:]
        for c in list { d[c.action] = c }
        return d
    }()

    /// `target` receives pageAction(_:) (representedObject = action), showDataFolder(_:), showLogFile(_:),
    /// showAbout(_:), zoomIn(_:), zoomOut(_:), actualSize(_:), reloadPage(_:).
    static func buildMainMenu(target: AnyObject) -> NSMenu {
        let main = NSMenu()
        func cmd(_ action: String) -> NSMenuItem {
            let c = commands[action]!
            let item = NSMenuItem(title: c.title, action: Selector(("pageAction:")), keyEquivalent: c.key)
            item.keyEquivalentModifierMask = c.mods
            item.representedObject = action
            item.target = target
            item.identifier = NSUserInterfaceItemIdentifier("action:\(action)")
            return item
        }
        func item(_ title: String, _ sel: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], target t: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: Selector((sel)), keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = t
            return i
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            for i in items { m.addItem(i) }
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = m
            main.addItem(holder)
            return m
        }
        let sep = { NSMenuItem.separator() }

        // Harness
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        _ = submenu("Harness", [
            item("About Harness", "showAbout:", "", [], target: target),
            sep(),
            cmd("open-settings"),
            cmd("lock"),
            sep(),
            services,
            sep(),
            item("Hide Harness", "hide:", "h"),
            item("Hide Others", "hideOtherApplications:", "h", [.option, .command]),
            item("Show All", "unhideAllApplications:", "", []),
            sep(),
            item("Quit Harness", "terminate:", "q"),
        ])
        // File
        _ = submenu("File", [
            cmd("new-chat"),
            sep(),
            cmd("import-chat"),
            cmd("export-chat"),
            sep(),
            item("Show Data Folder in Finder", "showDataFolder:", "", [], target: target),
            sep(),
            item("Close Window", "performClose:", "w"),
        ])
        // Edit (standard selectors: the web view implements them)
        let speech = NSMenuItem(title: "Speech", action: nil, keyEquivalent: "")
        let speechMenu = NSMenu(title: "Speech")
        speechMenu.addItem(item("Start Speaking", "startSpeaking:", "", []))
        speechMenu.addItem(item("Stop Speaking", "stopSpeaking:", "", []))
        speech.submenu = speechMenu
        let spelling = NSMenuItem(title: "Spelling and Grammar", action: nil, keyEquivalent: "")
        let spellingMenu = NSMenu(title: "Spelling and Grammar")
        spellingMenu.addItem(item("Show Spelling and Grammar", "showGuessPanel:", ":"))
        spellingMenu.addItem(item("Check Document Now", "checkSpelling:", ";"))
        spellingMenu.addItem(sep())
        spellingMenu.addItem(item("Check Spelling While Typing", "toggleContinuousSpellChecking:", "", []))
        spellingMenu.addItem(item("Check Grammar With Spelling", "toggleGrammarChecking:", "", []))
        spelling.submenu = spellingMenu
        _ = submenu("Edit", [
            item("Undo", "undo:", "z"),
            item("Redo", "redo:", "z", [.shift, .command]),
            sep(),
            item("Cut", "cut:", "x"),
            item("Copy", "copy:", "c"),
            item("Paste", "paste:", "v"),
            item("Paste and Match Style", "pasteAsPlainText:", "v", [.option, .shift, .command]),
            item("Delete", "delete:", "", []),
            item("Select All", "selectAll:", "a"),
            sep(),
            cmd("search-chats"),
            sep(),
            spelling,
            speech,
        ])
        // View
        let zoomEq = item("Zoom In", "zoomIn:", "=", [.command], target: target)
        zoomEq.isHidden = true
        zoomEq.allowsKeyEquivalentWhenHidden = true
        _ = submenu("View", [
            cmd("command-palette"),
            sep(),
            cmd("toggle-sidebar"),
            cmd("toggle-inspector"),
            sep(),
            cmd("open-models"),
            cmd("open-images"),
            cmd("open-memory"),
            sep(),
            item("Reload", "reloadPage:", "r", [.command], target: target),
            sep(),
            item("Actual Size", "actualSize:", "0", [.command], target: target),
            item("Zoom In", "zoomIn:", "+", [.command], target: target),
            zoomEq,
            item("Zoom Out", "zoomOut:", "-", [.command], target: target),
            sep(),
            item("Enter Full Screen", "toggleFullScreen:", "f", [.control, .command]),
        ])
        // Chat
        _ = submenu("Chat", [cmd("focus-composer"), cmd("stop-generation")])
        // Window
        let windowMenu = submenu("Window", [
            item("Minimize", "performMiniaturize:", "m"),
            item("Zoom", "performZoom:", "", []),
            sep(),
            item("Bring All to Front", "arrangeInFront:", "", []),
        ])
        NSApp.windowsMenu = windowMenu
        // Help (AppKit adds the menu search field)
        let helpMenu = submenu("Help", [
            cmd("show-shortcuts"),
            sep(),
            item("Show Log File", "showLogFile:", "", [], target: target),
            item("Show Data Folder in Finder", "showDataFolder:", "", [], target: target),
        ])
        NSApp.helpMenu = helpMenu
        return main
    }

    static func buildDockMenu(target: AnyObject) -> NSMenu {
        let m = NSMenu()
        for action in ["new-chat", "lock"] {
            let c = commands[action]!
            let i = NSMenuItem(title: c.title, action: Selector(("pageAction:")), keyEquivalent: "")
            i.representedObject = action
            i.target = target
            m.addItem(i)
        }
        return m
    }

    /// Every menu item that sends a page action (self-test and coverage checks).
    static func actionItems(in menu: NSMenu) -> [String: NSMenuItem] {
        var out: [String: NSMenuItem] = [:]
        func walk(_ m: NSMenu) {
            for i in m.items {
                if let a = i.representedObject as? String, i.action == Selector(("pageAction:")) { out[a] = i }
                if let s = i.submenu { walk(s) }
            }
        }
        walk(menu)
        return out
    }
}
