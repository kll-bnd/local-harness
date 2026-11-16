// The application: starts the backend in bridge mode, owns the window, menus, Dock, global shortcut, App Nap
// guard, Keychain key and the lock triggers. docs/NATIVE.md describes the behaviour; docs/BRIDGE.md the protocol.
import AppKit
import WebKit

struct LaunchOptions {
    var dataDir: String?
    var selfTestDir: String?
    var selfTestScript: String?
    var backendScript: String?
    var openPanelFiles: [String] = []
    var showWindow = false

    static func parse(_ argv: [String]) -> LaunchOptions {
        var o = LaunchOptions()
        var i = 1
        func next() -> String? { i += 1; return i < argv.count ? argv[i] : nil }
        while i < argv.count {
            switch argv[i] {
            case "--data-dir": o.dataDir = next()
            case "--self-test": o.selfTestDir = next()
            case "--self-test-script": o.selfTestScript = next()
            case "--backend": o.backendScript = next()
            case "--open-panel-files": o.openPanelFiles = (next() ?? "").split(separator: ",").map(String.init)
            case "--show-window": o.showWindow = true
            default: break // e.g. -NSDocumentRevisionsDebugMode added by Xcode or LaunchServices
            }
            i += 1
        }
        return o
    }
}

final class AppController: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    let options: LaunchOptions
    let paths: Paths
    let appRoot: URL
    let appVersion: String
    var config = DesktopConfig()
    var log: LogFile!
    let transport = Transport()
    lazy var scheme = SchemeHandler(transport: transport)
    lazy var pageMessages = PageMessages(app: self)
    var contentRules: WKContentRuleList?
    var selfTest: SelfTest?
    var mainWindow: MainWindow?

    private(set) var backend: Backend?
    private(set) var quitting = false
    private var shutdownDone = false
    private(set) var locked = true
    private(set) var everReady = false
    private(set) var lastReady: [String: Any] = [:]
    private var restarting = false
    private var pendingFatal: [String: Any]?
    private var keychainFailedThisRun = false
    private var sentKeychainKey = false
    private var startedAt = Date()
    private var startupWatchdog: DispatchWorkItem?
    private var hotKey: GlobalHotKey?
    private(set) var hotKeyStatus = "off"
    private var instanceLockFD: Int32 = -1
    private var eventsSink: EventStreamSink?
    private var busy = Set<String>()
    private var activityToken: NSObjectProtocol?
    private var downloads: [ObjectIdentifier: BridgeDownload] = [:]
    private var signalSources: [DispatchSourceSignal] = []
    private(set) var eventLog: [String] = []

    init(options: LaunchOptions) {
        self.options = options
        paths = Paths(dataDir: Paths.resolveDataDir(override: options.dataDir))
        appRoot = AppController.locateAppRoot()
        appVersion = readPackageVersion(appRoot)
        super.init()
    }

    /// Contents/Resources/app in the bundle; the repository when run from a build directory next to it.
    static func locateAppRoot() -> URL {
        let res = Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")
        let bundled = res.appendingPathComponent("app")
        if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("server/index.mjs").path) { return bundled }
        if let env = ProcessInfo.processInfo.environment["HARNESS_APP_ROOT"] { return URL(fileURLWithPath: env) }
        return bundled
    }

    // MARK: - start-up

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { AppController.quitSoon() }
            src.resume()
            signalSources.append(src)
        }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: paths.dataDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try fm.createDirectory(at: paths.nativeDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            guard fm.isWritableFile(atPath: paths.dataDir.path) else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES)) }
        } catch {
            startupError("Harness cannot use its data folder.", detail: "\(paths.dataDir.path)\n\n\(error.localizedDescription)", code: "data_dir")
            return
        }
        log = LogFile(paths.logFile)
        if !takeInstanceLock() { return }
        DataKeyStore.account = DataKeyStore.accountFor(dataDir: paths.dataDir)
        if let dir = options.selfTestDir { selfTest = SelfTest(app: self, dir: URL(fileURLWithPath: dir), options: options) }
        config = DesktopConfig.load(paths.desktopConfig)
        for w in config.warnings { log.info("desktop.json: \(w)") }
        log.info("Harness \(appVersion) (native) starting; data: \(paths.dataDir.path)")

        NSApp.mainMenu = Menus.buildMainMenu(target: self)
        registerLockTriggers()
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] e in
            if let w = self?.mainWindow, e.window === w.window { w.lastMouseDown = e }
            return e
        }
        compileContentRules { [weak self] in
            guard let self = self else { return }
            self.mainWindow = MainWindow(app: self)
            self.startBackend()
            self.registerHotKey()
        }
    }

    /// One native Harness per data folder (a second launch shows the first one's window and quits).
    private func takeInstanceLock() -> Bool {
        let fd = open(paths.instanceLock.path, O_RDWR | O_CREAT, 0o600)
        if fd < 0 { return true }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            var buf = [UInt8](repeating: 0, count: 32)
            let n = read(fd, &buf, 31)
            close(fd)
            if n > 0, let pid = Int32(String(decoding: buf[0..<n], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
               let other = NSRunningApplication(processIdentifier: pid) {
                other.activate(options: [])
            }
            log.info("another Harness window app uses this data folder; showing it instead")
            NSApp.terminate(nil)
            shutdownDone = true
            return false
        }
        ftruncate(fd, 0)
        let s = "\(getpid())\n"
        _ = s.withCString { write(fd, $0, strlen($0)) }
        instanceLockFD = fd
        return true
    }

    /// Nothing from the web: block every load that is not harness://app/… (data: and blob: stay allowed for
    /// images the page makes itself). The navigation policy and the UI's CSP enforce the same independently.
    private func compileContentRules(_ then: @escaping () -> Void) {
        let rules = """
        [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^harness://app/"},"action":{"type":"ignore-previous-rules"}},
         {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
         {"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]
        """
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "local.harness.only-app", encodedContentRuleList: rules) { [weak self] list, err in
            if let e = err { self?.log.info("content rules did not compile: \(e.localizedDescription)") }
            self?.contentRules = list
            self?.selfTest?.record("contentRules", list != nil)
            then()
        }
    }

    // MARK: - backend

    private func nodeExecutable() -> String? {
        let fm = FileManager.default
        var candidates: [String] = []
        if let e = ProcessInfo.processInfo.environment["HARNESS_NODE"], !e.isEmpty { candidates.append(e) }
        if let exe = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("node").path { candidates.append(exe) }
        // A --system-node build records the node it was built with.
        if let p = Bundle.main.object(forInfoDictionaryKey: "HarnessNodePath") as? String { candidates.append(p) }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }

    func startBackend() {
        let launch = LaunchConfig.read(paths.launchConfig)
        let useKeychain = launch.encryption == "keychain" && !keychainFailedThisRun
        log.info("launch.json: encryption=\(launch.encryption) offlineLock=\(launch.offlineLock)")
        if !useKeychain { spawnBackend(dataKey: nil); return }
        // May show the system Keychain prompt (e.g. after a rebuild): never on the main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            let r = DataKeyStore.read()
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                switch r {
                case .found(let key):
                    self.selfTest?.record("keychainRead", "found")
                    self.spawnBackend(dataKey: key)
                case .notFound:
                    self.log.info("keychain mode, but there is no Harness data key in the Keychain: the password opens Harness")
                    self.selfTest?.record("keychainRead", "notFound")
                    self.spawnBackend(dataKey: nil)
                case .denied(let s), .failed(let s):
                    self.log.info("the Keychain did not give Harness its data key (\(DataKeyStore.message(s))): the password opens Harness")
                    self.selfTest?.record("keychainRead", "denied:\(s)")
                    self.spawnBackend(dataKey: nil)
                }
            }
        }
    }

    private func spawnBackend(dataKey: String?) {
        guard let node = nodeExecutable() else {
            startupError("Harness could not find its Node.js runtime.", detail: "This build expects Node.js inside Harness.app or at /opt/homebrew/bin/node. Build Harness again with scripts/build-native.sh.", code: "no_node")
            return
        }
        let script = options.backendScript.flatMap { selfTest != nil ? $0 : nil } ?? appRoot.appendingPathComponent("server/index.mjs").path
        var env = ProcessInfo.processInfo.environment
        let path = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", path].joined(separator: ":")
        env.removeValue(forKey: "HARNESS_SANDBOXED") // the backend itself is never sandboxed (BRIDGE.md); it confines Ollama
        env.removeValue(forKey: "NODE_OPTIONS")
        env.removeValue(forKey: "HARNESS_NATIVE_LOG_STDERR")
        let spec = Backend.Spec(executable: node, arguments: [script, "--bridge", "--data-dir", paths.dataDir.path], environment: env, directory: appRoot.path)
        let hello: [String: Any] = [
            "op": "hello", "protocol": 1,
            "app": ["name": "Harness", "version": appVersion, "kind": "native"],
            "dataKey": dataKey.map { $0 as Any } ?? NSNull(),
        ]
        sentKeychainKey = dataKey != nil
        let b = Backend()
        b.onLogLine = { [weak self] line in self?.log.raw(line) }
        b.onEvent = { [weak self, weak b] ev in if let b = b { self?.backendEvent(ev, from: b) } }
        b.onExit = { [weak self, weak b] status, requested in if let b = b { self?.backendExited(b, status: status, requested: requested) } }
        do {
            try b.start(spec, hello: hello)
        } catch {
            startupError("Harness could not start its backend.", detail: error.localizedDescription, code: "spawn_failed")
            return
        }
        backend = b
        startedAt = Date()
        transport.attach(b)
        log.info("backend started (pid \(b.pid), node \(node))")
        selfTest?.backendStarted(b)
        armWatchdog()
    }

    /// No word from a starting backend for 60 s (progress events reset the timer): explain instead of waiting forever.
    private func armWatchdog() {
        startupWatchdog?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, let b = self.backend, b.running, !b.ready else { return }
            self.log.info("the backend did not become ready within 60 s")
            self.pendingFatal = ["code": "startup_timeout", "message": "The backend did not finish starting within a minute."]
            b.stop(timeout: 5)
        }
        startupWatchdog = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: w)
    }

    private func backendEvent(_ ev: [String: Any], from b: Backend) {
        guard b === backend else { return }
        let type = (ev["type"] as? String) ?? "?"
        eventLog.append(type)
        if eventLog.count > 200 { eventLog.removeFirst(50) }
        selfTest?.backendEvent(ev)
        switch type {
        case "ready":
            startupWatchdog?.cancel()
            lastReady = ev
            locked = (ev["locked"] as? Bool) ?? false
            log.info("backend ready (locked: \(locked))")
            mainWindow?.setProgress(nil)
            if everReady { mainWindow?.reload() } else { mainWindow?.load() }
            everReady = true
            restarting = false
            lockStateChanged()
        case "locked":
            locked = true
            lockStateChanged()
        case "unlocked":
            locked = false
            lockStateChanged()
        case "progress":
            armWatchdog()
            let what = (ev["what"] as? String) ?? "encrypting"
            let label = what == "decrypting" ? "Decrypting your data…" : what == "reencrypting" ? "Re-encrypting your data…" : "Encrypting your data…"
            let done = (ev["done"] as? NSNumber)?.intValue ?? 0, total = (ev["total"] as? NSNumber)?.intValue ?? 0
            if !b.ready { mainWindow?.setProgress(total > 0 ? "\(label) \(done) of \(total)" : label) }
        case "fatal":
            pendingFatal = ev
            log.info("backend fatal: \((ev["code"] as? String) ?? "?")")
        case "restart-required":
            log.info("backend asks for a restart (\((ev["reason"] as? String) ?? "?"))")
            restartBackend()
        case "keychain-key":
            keychainKey(ev["dataKey"])
        default:
            break
        }
    }

    func restartBackend() {
        guard let b = backend, !restarting, !quitting else { return }
        restarting = true
        stopEventStream()
        b.stop(timeout: 10)
    }

    private func backendExited(_ b: Backend, status: Int32, requested: Bool) {
        guard b === backend else { return }
        startupWatchdog?.cancel()
        transport.detach()
        backend = nil
        stopEventStream()
        busy.removeAll()
        updateActivity()
        log.info("backend exited (status \(status))")
        selfTest?.record("backendExit", Int(status))
        if quitting { finishQuit(); return }
        let fatal = pendingFatal
        pendingFatal = nil
        if let f = fatal {
            let code = (f["code"] as? String) ?? "startup_failed"
            if code == "wrong_key" && sentKeychainKey {
                // Keychain mode, but the key does not open the data: fall back to the password (BRIDGE.md).
                keychainFailedThisRun = true
                log.info("the Keychain key does not open this data folder; starting again so the password can open it")
                startBackend()
                return
            }
            if code == "data_dir_locked" {
                startupError("Harness is already running for this data folder.",
                             detail: "Another Harness (started with npm start, Harness.command or the Electron app) is using \(paths.dataDir.path)\((f["url"] as? String).map { " at \($0)" } ?? ""). Quit it, then open Harness again.",
                             code: code)
                return
            }
            startupError("Harness could not start.", detail: (f["message"] as? String) ?? code, code: code)
            return
        }
        if restarting { restarting = false; startBackend(); return }
        if everReady && Date().timeIntervalSince(startedAt) > 20 {
            // An unexpected exit after a healthy run: start again once (the page reloads when it is ready).
            log.info("the backend stopped unexpectedly; starting it again")
            startBackend()
            return
        }
        startupError("Harness could not start its backend.", detail: "The backend exited with status \(status).", code: "exited")
    }

    // MARK: - lock state, Keychain events

    private func lockStateChanged() {
        if locked {
            NSApp.dockTile.badgeLabel = nil
            busy.removeAll()
            updateActivity()
            stopEventStream()
        } else {
            startEventStream()
            fetchTheme()
        }
        selfTest?.record("locked", locked)
    }

    func lockNow(_ why: String) {
        guard let b = backend, b.running else { return }
        log.info("locking (\(why))")
        b.sendControl(["op": "lock"])
    }

    private func registerLockTriggers() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            self?.lockNow("the Mac is going to sleep")
        }
        DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            self?.lockNow("the screen was locked")
        }
    }

    private func keychainKey(_ v: Any?) {
        if let key = v as? String {
            let s = DataKeyStore.store(key)
            log.info(s == errSecSuccess ? "stored the data key in the Keychain (keychain mode on)" : "could not store the data key in the Keychain: \(DataKeyStore.message(s))")
            selfTest?.record("keychainStore", Int(s))
        } else {
            let s = DataKeyStore.delete()
            log.info(s == errSecSuccess ? "removed the data key from the Keychain (keychain mode off)" : "could not remove the Keychain item: \(DataKeyStore.message(s))")
            selfTest?.record("keychainDelete", Int(s))
        }
    }

    // MARK: - the app's own event stream (App Nap guard, theme)

    private func startEventStream() {
        guard eventsSink == nil, backend?.running == true, !locked else { return }
        let sink = EventStreamSink { [weak self] type, data in self?.busEvent(type, data) } ended: { [weak self] in
            guard let self = self else { return }
            self.eventsSink = nil
            self.busy.removeAll()
            self.updateActivity()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startEventStream() }
        }
        eventsSink = sink
        transport.send("GET", "/api/events", ["accept": "text/event-stream"], .none, sink)
    }

    private func stopEventStream() {
        if let s = eventsSink { eventsSink = nil; s.ended = nil; transport.cancel(s) }
    }

    private func busEvent(_ type: String, _ data: [String: Any]) {
        switch type {
        case "generation.started":
            busy.insert("g:" + ((data["generationId"] as? String) ?? (data["chatId"] as? String) ?? "?"))
        case "generation.finished":
            busy.remove("g:" + ((data["generationId"] as? String) ?? (data["chatId"] as? String) ?? "?"))
        case "image.job", "image_job":
            if let id = (data["job"] as? [String: Any])?["id"] as? String ?? data["jobId"] as? String { busy.insert("i:" + id) }
        case "image.done", "image.error", "image_done", "image_error":
            if let id = data["jobId"] as? String ?? (data["job"] as? [String: Any])?["id"] as? String { busy.remove("i:" + id) }
        case "settings.updated":
            applyTheme((data["settings"] as? [String: Any]))
        case "locked":
            locked = true
            lockStateChanged()
        default:
            return
        }
        updateActivity()
    }

    /// App Nap is held off only while a generation or an image job runs (like Electron's powerSaveBlocker).
    private func updateActivity() {
        if !busy.isEmpty && activityToken == nil {
            activityToken = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Harness is generating a reply")
        } else if busy.isEmpty, let t = activityToken {
            ProcessInfo.processInfo.endActivity(t)
            activityToken = nil
        }
    }
    var activityHeld: Bool { activityToken != nil }
    var busyCount: Int { busy.count }

    private func fetchTheme() {
        let sink = CollectSink { [weak self] status, body in
            guard status == 200, let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return }
            self?.applyTheme(o["settings"] as? [String: Any])
        }
        transport.send("GET", "/api/settings", ["accept": "application/json"], .none, sink)
    }

    /// settings.ui.theme light/dark/other → the app's appearance, so the page's prefers-color-scheme and native UI match.
    private func applyTheme(_ settings: [String: Any]?) {
        let t = (settings?["ui"] as? [String: Any])?["theme"] as? String
        NSApp.appearance = t == "light" ? NSAppearance(named: .aqua) : t == "dark" ? NSAppearance(named: .darkAqua) : nil
    }

    // MARK: - page hooks

    func pageDidLoad() { selfTest?.pageLoaded() }

    @discardableResult
    func openExternal(_ s: String) -> Bool {
        guard let url = Checks.externalHttpUrl(s) else { log.info("refused to open a non-http(s) link"); return false }
        if let st = selfTest { st.recordList("openExternal", url.absoluteString); return true }
        NSWorkspace.shared.open(url)
        return true
    }

    func showInFolder(_ p: String) -> Bool {
        guard let url = Checks.insideDataDir(p, dataDir: paths.dataDir) else { return false }
        if let st = selfTest { st.recordList("showInFolder", url.path); return true }
        NSWorkspace.shared.activateFileViewerSelecting([url])
        return true
    }

    func setBadge(_ v: Any?) -> Bool {
        guard let s = Checks.badge(v) else { return false }
        if locked && !s.isEmpty { return false }
        NSApp.dockTile.badgeLabel = s.isEmpty ? nil : s
        return true
    }

    func blocked(_ what: String, _ url: String) {
        log.info("blocked \(what) to \(url.prefix(120))")
        selfTest?.recordList("blocked", "\(what) \(url.prefix(200))")
    }

    func downloadAppUrl(_ url: URL, suggestedName: String?) {
        guard let head = SchemeHandler.bridgeHead(URLRequest(url: url)) else { return }
        let fallback = (suggestedName?.isEmpty == false ? suggestedName! : url.lastPathComponent)
        var key: ObjectIdentifier?
        let d = BridgeDownload(fallbackName: fallback, destination: { [weak self] name, choose in
            guard let w = self?.mainWindow else { choose(nil); return }
            w.chooseDestination(name, choose)
        }, finished: { [weak self] dest, err in
            guard let self = self else { return }
            if let k = key { self.downloads.removeValue(forKey: k) }
            if let e = err { self.log.info("download failed: \(e)") }
            self.selfTest?.downloadFinished(dest, error: err)
        })
        key = ObjectIdentifier(d)
        downloads[key!] = d
        transport.send("GET", head.path, ["accept": "*/*"], .none, d)
    }

    // MARK: - menu actions

    @objc func pageAction(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        performPageAction(action)
    }

    func performPageAction(_ action: String) {
        guard menuActions.contains(action) else { return }
        if action == "lock" { lockNow("Lock Harness") }
        mainWindow?.sendMenuAction(action)
        selfTest?.recordList("menuSent", action)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == Selector(("pageAction:")), (item.representedObject as? String) == "lock" { return backend?.running == true && !locked }
        return true
    }

    @objc func showAbout(_ sender: Any?) {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Harness", .applicationVersion: appVersion, .version: "native",
            .credits: NSAttributedString(string: "Chat with open-source models on your own Mac."),
        ])
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func showDataFolder(_ sender: Any?) { NSWorkspace.shared.open(paths.dataDir) }

    @objc func showLogFile(_ sender: Any?) {
        if FileManager.default.fileExists(atPath: paths.logFile.path) { NSWorkspace.shared.activateFileViewerSelecting([paths.logFile]) }
        else { showDataFolder(sender) }
    }

    @objc func reloadPage(_ sender: Any?) { mainWindow?.reload() }

    private let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]
    @objc func zoomIn(_ sender: Any?) { zoom(by: 1) }
    @objc func zoomOut(_ sender: Any?) { zoom(by: -1) }
    @objc func actualSize(_ sender: Any?) { mainWindow?.webView?.pageZoom = 1.0 }
    private func zoom(by step: Int) {
        guard let wv = mainWindow?.webView else { return }
        let cur = wv.pageZoom
        let i = zoomSteps.firstIndex { abs($0 - cur) < 0.01 } ?? zoomSteps.firstIndex { $0 >= cur } ?? 5
        wv.pageZoom = zoomSteps[max(0, min(zoomSteps.count - 1, i + step))]
    }

    // MARK: - Dock, reopen, global shortcut

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? { Menus.buildDockMenu(target: self) }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow?.show()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func registerHotKey() {
        guard let acc = config.globalShortcut else { hotKeyStatus = "off"; return }
        let hk = GlobalHotKey(accelerator: acc) { [weak self] in self?.toggleWindow() }
        if let why = hk.register() {
            hotKeyStatus = "failed: \(why)"
            log.info("global shortcut \(acc) not registered (\(why)); change it in \(paths.desktopConfig.path)")
        } else {
            hotKey = hk
            hotKeyStatus = "registered \(acc)"
        }
    }

    func toggleWindow() {
        guard let w = mainWindow else { return }
        if w.isVisible && NSApp.isActive && w.window.isKeyWindow { NSApp.hide(nil); return }
        w.show()
    }

    // MARK: - quitting

    /// Quit from a GCD block. NSApp.terminate run inside a main-queue block would wait for the backend in a nested
    /// run loop that cannot run the other main-queue blocks (the backend's exit notice among them): measured as a
    /// hang on the runner. A run-loop perform is not a GCD block, so the wait works.
    static func quitSoon() {
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if shutdownDone { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        mainWindow?.saveStateNow()
        hotKey?.unregister()
        stopEventStream()
        selfTest?.willQuit()
        guard let b = backend, b.running else { shutdownDone = true; return .terminateNow }
        log.info("stopping the backend…")
        b.stop(timeout: 10)
        // backendExited → finishQuit
        return .terminateLater
    }

    private func finishQuit() {
        guard !shutdownDone else { return }
        shutdownDone = true
        log.info("bye")
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        backend?.killNow()
        if instanceLockFD >= 0 { flock(instanceLockFD, LOCK_UN); close(instanceLockFD) }
    }

    // MARK: - errors

    func startupError(_ message: String, detail: String, code: String) {
        log?.info("startup error (\(code)): \(message)")
        if let st = selfTest {
            st.record("startupError", code)
            st.finish(status: "startup_error:\(code)")
            return
        }
        let a = NSAlert()
        a.alertStyle = .critical
        a.messageText = message
        a.informativeText = "\(detail)\n\nData folder: \(paths.dataDir.path)\nLog file: \(paths.logFile.path)"
        a.addButton(withTitle: "Quit")
        a.addButton(withTitle: "Show Log File")
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertSecondButtonReturn { showLogFile(nil) }
        quitting = true
        if let b = backend, b.running { b.stop(timeout: 5) { exit(1) } } else { exit(1) }
    }
}

// MARK: - messages from the page (window.harnessDesktop)

final class PageMessages: NSObject, WKScriptMessageHandler {
    unowned let app: AppController
    init(app: AppController) { self.app = app }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the app's own page, in the main frame of the app's window.
        guard let wv = message.webView, wv === app.mainWindow?.webView, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "harness", message.frameInfo.securityOrigin.host == "app",
              let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        let id = (body["id"] as? NSNumber)?.intValue
        var result = false
        switch op {
        case "openExternal": result = app.openExternal((body["arg"] as? String) ?? "")
        case "showInFolder": result = app.showInFolder((body["arg"] as? String) ?? "")
        case "setBadge": result = app.setBadge(body["arg"])
        case "dragWindow": app.mainWindow?.dragWindow(); return
        case "titlebarDoubleClick": app.mainWindow?.titlebarDoubleClick(); return
        case "download":
            if let a = body["arg"] as? [String: Any], let s = a["url"] as? String, s.count <= Checks.maxUrlLength, let u = URL(string: s), Checks.isAppUrl(u) {
                let name = (a["name"] as? String).map { String($0.prefix(255)) }
                app.downloadAppUrl(u, suggestedName: name)
            }
            return
        default: break
        }
        if let id = id { wv.evaluateJavaScript("window.__harnessNative && window.__harnessNative.reply(\(id), \(result ? "true" : "false"))", completionHandler: nil) }
    }
}

// MARK: - small sinks

/// Collects a whole (small) response.
final class CollectSink: TransportSink {
    private var status = 0
    private var body = Data()
    private let done: (Int, Data) -> Void
    init(_ done: @escaping (Int, Data) -> Void) { self.done = done }
    override func bridgeHead(status: Int, headers: [String: String]) { self.status = status }
    override func bridgeBody(_ data: Data) { if body.count < 4 * 1024 * 1024 { body.append(data) } }
    override func bridgeEnd() { done(status, body) }
    override func bridgeFail(_ reason: String) { done(0, Data()) }
}

/// Parses a server-sent event stream (the backend's GET /api/events).
final class EventStreamSink: TransportSink {
    private var buf = Data()
    private var ok = false
    private let onEvent: (String, [String: Any]) -> Void
    var ended: (() -> Void)?

    init(_ onEvent: @escaping (String, [String: Any]) -> Void, ended: @escaping () -> Void) {
        self.onEvent = onEvent
        self.ended = ended
    }

    override func bridgeHead(status: Int, headers: [String: String]) { ok = status == 200 }

    override func bridgeBody(_ data: Data) {
        guard ok else { return }
        buf.append(data)
        while let r = buf.range(of: Data("\n\n".utf8)) {
            let block = String(decoding: buf[buf.startIndex..<r.lowerBound], as: UTF8.self)
            buf.removeSubrange(buf.startIndex..<r.upperBound)
            var type = "message"
            var lines: [String] = []
            for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
                let l = line.hasSuffix("\r") ? String(line.dropLast()) : String(line)
                if l.hasPrefix("event:") { type = l.dropFirst(6).trimmingCharacters(in: .whitespaces) }
                else if l.hasPrefix("data:") { lines.append(String(l.dropFirst(5)).trimmingCharacters(in: CharacterSet(charactersIn: " "))) }
            }
            if lines.isEmpty { continue }
            let obj = (try? JSONSerialization.jsonObject(with: Data(lines.joined(separator: "\n").utf8))) as? [String: Any] ?? [:]
            onEvent((obj["type"] as? String) ?? type, obj)
        }
        if buf.count > 1024 * 1024 { buf.removeAll() }
    }

    override func bridgeEnd() { ended?() }
    override func bridgeFail(_ reason: String) { ended?() }
}
