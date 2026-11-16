// Self-test mode (CI): `Harness --self-test <dir> --self-test-script <file.js> [--data-dir <dir>]`.
// The script runs inside the real page and drives the real app through window.native(op, args); results go to
// <dir>/results.json and the process ids the outside driver needs to <dir>/state.json. Inert unless started with
// --self-test: no dialogs then, links and Finder reveals are recorded instead of opened, downloads land in <dir>.
import AppKit
import Carbon
import CryptoKit
import WebKit

final class SelfTest: NSObject, WKScriptMessageHandler {
    unowned let app: AppController
    let dir: URL
    let downloadsDir: URL
    let showWindow: Bool
    private let script: String?
    private var openPanelFiles: [URL]
    private var results: [String: Any] = [:]
    private var lists: [String: [Any]] = [:]
    private var stash: [String: Any] = [:]
    private var events: [[String: Any]] = []
    private var downloadWaiters: [(Int, WKWebView)] = []
    private var pageLoads = 0

    init(app: AppController, dir: URL, options: LaunchOptions) {
        self.app = app
        self.dir = dir
        downloadsDir = dir.appendingPathComponent("downloads", isDirectory: true)
        showWindow = true // key events, focus and full screen need a real, visible window
        script = options.selfTestScript.flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }
        openPanelFiles = options.openPanelFiles.map { URL(fileURLWithPath: $0) }
        super.init()
        try? FileManager.default.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
        if let prev = try? Data(contentsOf: dir.appendingPathComponent("stash.json")), let o = (try? JSONSerialization.jsonObject(with: prev)) as? [String: Any] {
            stash = o // a second launch of the same test continues where the first stopped
        }
        results["pid"] = Int(getpid())
        results["launch"] = (stash["launches"] as? Int ?? 0) + 1
        stash["launches"] = results["launch"]
        writeState()
    }

    private static let prelude = """
    (function () {
      var mh = window.webkit.messageHandlers.harnessSelfTest;
      var seq = 0, waiting = new Map();
      window.__harnessSelfTestReply = function (id, v) { var r = waiting.get(id); if (r) { waiting.delete(id); r(v); } };
      window.native = function (op, args) {
        return new Promise(function (resolve) { var id = ++seq; waiting.set(id, resolve); mh.postMessage(Object.assign({ op: op, id: id }, args || {})); });
      };
    })();

    """

    func configure(_ ucc: WKUserContentController) {
        ucc.add(self, name: "harnessSelfTest")
        if let s = script {
            ucc.addUserScript(WKUserScript(source: SelfTest.prelude + s, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
    }

    // MARK: records

    func record(_ key: String, _ value: Any) { results[key] = value; writeState() }
    func recordList(_ key: String, _ value: Any) { lists[key, default: []].append(value) }

    func backendStarted(_ b: Backend) {
        results["backendPid"] = Int(b.pid)
        recordList("backendPids", Int(b.pid))
        writeState()
    }

    func backendEvent(_ ev: [String: Any]) {
        var e = ev
        e.removeValue(forKey: "dataKey") // never into a file
        e["t"] = Int(Date().timeIntervalSince1970 * 1000)
        events.append(e)
        if events.count > 300 { events.removeFirst(100) }
    }

    func pageLoaded() {
        pageLoads += 1
        results["pageLoads"] = pageLoads
        if let wv = app.mainWindow?.webView, wv.responds(to: NSSelectorFromString("_webProcessIdentifier")),
           let pid = wv.value(forKey: "_webProcessIdentifier") as? NSNumber {
            results["webContentPid"] = pid.intValue
        }
        writeState()
    }

    func takeOpenPanelFiles() -> [URL]? {
        guard !openPanelFiles.isEmpty else { return nil }
        recordList("openPanel", openPanelFiles.map { $0.lastPathComponent })
        return openPanelFiles
    }

    func downloadFinished(_ url: URL?, error: String?) {
        var info: [String: Any] = ["name": url?.lastPathComponent ?? NSNull(), "error": error ?? NSNull()]
        if let u = url, let d = try? Data(contentsOf: u) { info["size"] = d.count; info["sha256"] = SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
        recordList("downloads", info)
        let waiters = downloadWaiters
        downloadWaiters.removeAll()
        for (id, wv) in waiters { reply(wv, id, info) }
    }

    func willQuit() {
        results["quitAt"] = Int(Date().timeIntervalSince1970 * 1000)
        writeResults()
    }

    func finish(status: String) {
        results["status"] = status
        writeResults()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    private func writeState() {
        var s: [String: Any] = [:]
        for k in ["pid", "backendPid", "webContentPid", "pageLoads", "status", "launch", "locked"] { if let v = results[k] { s[k] = v } }
        write(s, "state.json")
    }

    private func writeResults() {
        var all = results
        all["lists"] = lists
        all["events"] = events
        all["stash"] = stash
        write(all, "results.json")
        write(stash, "stash.json")
        writeState()
    }

    private func write(_ o: [String: Any], _ name: String) {
        guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? d.write(to: dir.appendingPathComponent(name), options: .atomic)
    }

    // MARK: page → native

    private func reply(_ wv: WKWebView, _ id: Int, _ value: Any) {
        wv.evaluateJavaScript("window.__harnessSelfTestReply && window.__harnessSelfTestReply(\(id), \(jsonString(value)))", completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let wv = message.webView, message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "harness",
              let b = message.body as? [String: Any], let op = b["op"] as? String, let id = (b["id"] as? NSNumber)?.intValue else { return }
        let r: ([String: Any]) -> Void = { [weak self] v in self?.reply(wv, id, v) }
        let w = app.mainWindow
        switch op {
        case "state":
            r(state())
        case "menu":
            let action = (b["action"] as? String) ?? ""
            guard let menu = NSApp.mainMenu, let item = Menus.actionItems(in: menu)[action], let parent = item.menu else { r(["ok": false]); return }
            parent.performActionForItem(at: parent.index(of: item))
            r(["ok": true, "key": item.keyEquivalent, "mods": Int(item.keyEquivalentModifierMask.rawValue)])
        case "menuItems":
            guard let menu = NSApp.mainMenu else { r([:]); return }
            var out: [String: Any] = [:]
            for (a, item) in Menus.actionItems(in: menu) {
                var mods: [String] = []
                let m = item.keyEquivalentModifierMask
                if m.contains(.control) { mods.append("ctrl") }
                if m.contains(.option) { mods.append("alt") }
                if m.contains(.shift) { mods.append("shift") }
                if m.contains(.command) { mods.append("cmd") }
                out[a] = (mods + [item.keyEquivalent]).joined(separator: "+")
            }
            var titles: [String] = []
            for top in menu.items { titles.append(top.submenu?.title ?? top.title) }
            r(["actions": out, "menus": titles, "dock": Menus.buildDockMenu(target: app).items.map { $0.title }])
        case "key":
            let key = (b["key"] as? String) ?? ""
            let mods = (b["mods"] as? [String]) ?? ["cmd"]
            var flags: NSEvent.ModifierFlags = []
            if mods.contains("cmd") { flags.insert(.command) }
            if mods.contains("ctrl") { flags.insert(.control) }
            if mods.contains("alt") { flags.insert(.option) }
            if mods.contains("shift") { flags.insert(.shift) }
            let code = UInt16(GlobalHotKey.keyCode(key) ?? 0)
            guard let win = w?.window else { r(["ok": false]); return }
            for t in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: t, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber,
                                            context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: code) { NSApp.sendEvent(e) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { r(["ok": true]) }
        case "click":
            guard let win = w?.window, let cv = win.contentView else { r(["ok": false]); return }
            let p = NSPoint(x: (b["x"] as? Double) ?? 10, y: cv.bounds.height - ((b["y"] as? Double) ?? 10))
            for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let e = NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber,
                                              context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { win.sendEvent(e) }
            }
            r(["ok": true])
        case "lock":
            app.lockNow("self-test")
            r(["ok": true])
        case "sleep":
            NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: NSWorkspace.shared)
            r(["ok": true])
        case "screenLock":
            DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("com.apple.screenIsLocked"), object: nil, userInfo: nil, deliverImmediately: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { r(["ok": true]) }
        case "fullscreen":
            guard let win = w?.window else { r(["ok": false]); return }
            let on = (b["on"] as? Bool) ?? true
            if win.styleMask.contains(.fullScreen) != on { win.toggleFullScreen(nil) }
            waitUntil(8) { win.styleMask.contains(.fullScreen) == on } then: { ok in r(["ok": ok, "fullscreen": win.styleMask.contains(.fullScreen)]) }
        case "closeWindow":
            guard let win = w?.window else { r(["ok": false]); return }
            win.performClose(nil)
            waitUntil(8) { !win.isVisible } then: { _ in r(["visible": win.isVisible, "appRunning": true]) }
        case "reopen":
            _ = app.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
            waitUntil(5) { w?.window.isVisible == true } then: { _ in r(["visible": w?.window.isVisible ?? false]) }
        case "hotkey":
            app.toggleWindow()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { r(["visible": w?.isVisible ?? false, "active": NSApp.isActive, "hidden": NSApp.isHidden]) }
        case "unhide":
            NSApp.unhide(nil)
            w?.show()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { r(["visible": w?.isVisible ?? false]) }
        case "restartBackend":
            app.restartBackend()
            r(["ok": true])
        case "download":
            let path = (b["path"] as? String) ?? "/"
            guard let u = URL(string: "harness://app" + path) else { r(["ok": false]); return }
            downloadWaiters.append((id, wv))
            app.downloadAppUrl(u, suggestedName: b["name"] as? String)
        case "awaitDownload":
            downloadWaiters.append((id, wv))
        case "keychain":
            DispatchQueue.global().async {
                let exists = DataKeyStore.exists()
                var fp: Any = NSNull()
                if exists, case .found(let k) = DataKeyStore.read() { fp = DataKeyStore.fingerprint(k) }
                DispatchQueue.main.async { r(["exists": exists, "fingerprint": fp]) }
            }
        case "stash":
            if let k = b["key"] as? String { stash[k] = b["value"] ?? NSNull() }
            write(stash, "stash.json")
            r(["ok": true])
        case "stashAll":
            r(stash)
        case "result":
            if let k = b["key"] as? String { results["page." + k] = b["value"] ?? NSNull() }
            writeResults()
            r(["ok": true])
        case "finish":
            r(["ok": true])
            finish(status: (b["status"] as? String) ?? "done")
        default:
            r(["error": "unknown op \(op)"])
        }
    }

    private func waitUntil(_ seconds: Double, _ cond: @escaping () -> Bool, then: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(seconds)
        func tick() {
            if cond() { then(true); return }
            if Date() > deadline { then(false); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { tick() }
        }
        tick()
    }

    private func state() -> [String: Any] {
        var s: [String: Any] = [:]
        s["pid"] = Int(getpid())
        s["backendPid"] = app.backend.map { Int($0.pid) } ?? NSNull()
        s["backendRunning"] = app.backend?.running ?? false
        s["locked"] = app.locked
        var ready = app.lastReady
        ready.removeValue(forKey: "dataKey")
        s["ready"] = ready
        s["events"] = app.eventLog
        if let menu = NSApp.mainMenu, let lockItem = Menus.actionItems(in: menu)["lock"] { s["lockMenuEnabled"] = app.validateMenuItem(lockItem) }
        s["badge"] = NSApp.dockTile.badgeLabel ?? ""
        if let w = app.mainWindow {
            s["windowVisible"] = w.isVisible
            s["windowKey"] = w.window.isKeyWindow
            s["fullscreen"] = w.window.styleMask.contains(.fullScreen)
            s["url"] = w.webView?.url?.absoluteString ?? NSNull()
            s["titlebarHeight"] = Double(w.window.frame.height - w.window.contentLayoutRect.height)
            s["pageZoom"] = Double(w.webView?.pageZoom ?? 0)
        }
        s["hotKey"] = app.hotKeyStatus
        s["activityHeld"] = app.activityHeld
        s["busyCount"] = app.busyCount
        s["secureInput"] = IsSecureEventInputEnabled()
        s["appActive"] = NSApp.isActive
        s["appearance"] = NSApp.effectiveAppearance.name.rawValue
        var rec = results
        rec["lists"] = lists
        s["records"] = rec
        return s
    }
}
