// The one window: a WKWebView that may show nothing but harness://app/…, with the macOS niceties.
import AppKit
import WebKit

/// Menu key equivalents win over the page, as in the Electron shell ("menu accelerators fire before the page
/// sees the key"); everything else goes to the web view as usual.
final class HarnessWebView: WKWebView {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let menu = NSApp.mainMenu, menu.performKeyEquivalent(with: event) { return true }
        return super.performKeyEquivalent(with: event)
    }
}

let windowBackground = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0.10980, green: 0.10980, blue: 0.11765, alpha: 1) // #1c1c1e
        : NSColor(srgbRed: 0.98039, green: 0.98039, blue: 0.98039, alpha: 1) // #fafafa
}

final class MainWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    unowned let app: AppController
    let window: NSWindow
    private(set) var webView: HarnessWebView?
    private(set) var pageLoaded = false
    private var queuedActions: [String] = []
    private var shownOnce = false
    private var saveTimer: Timer?
    private var overlay: NSTextField?
    var lastMouseDown: NSEvent?
    private var hideAfterFullScreen = false
    private(set) var fullScreenTransition = false
    private var downloadNames: [ObjectIdentifier: URL] = [:]

    init(app: AppController) {
        self.app = app
        let frame = WindowState.initialFrame(app.paths.windowState)
        window = NSWindow(contentRect: frame.rect, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.title = "Harness"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        // Electron's "hiddenInset": an empty toolbar pushes the traffic lights down and in.
        let toolbar = NSToolbar(identifier: "local.harness.titlebar")
        toolbar.showsBaselineSeparator = false
        window.toolbar = toolbar
        window.toolbarStyle = .unifiedCompact
        window.minSize = NSSize(width: WindowState.minWidth, height: WindowState.minHeight)
        window.backgroundColor = windowBackground
        window.collectionBehavior = [.fullScreenPrimary]
        window.tabbingMode = .disallowed
        window.delegate = self
        if frame.zoomed { window.zoom(nil) }
        makeWebView()
    }

    // MARK: web view

    private func makeWebView() {
        let cfg = WKWebViewConfiguration()
        // Nothing of the page is kept on disk: the backend keeps UI state (encrypted) instead.
        cfg.websiteDataStore = .nonPersistent()
        cfg.setURLSchemeHandler(app.scheme, forURLScheme: "harness")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true // window.open reaches createWebViewWith (which never opens a window)
        cfg.preferences.isFraudulentWebsiteWarningEnabled = false
        if #available(macOS 12.3, *) { cfg.preferences.isElementFullscreenEnabled = true }
        cfg.mediaTypesRequiringUserActionForPlayback = .all
        cfg.applicationNameForUserAgent = "Harness/\(app.appVersion)"
        let ucc = cfg.userContentController
        let initJSON = jsonString(["appVersion": app.appVersion, "actions": menuActions, "fullscreen": window.styleMask.contains(.fullScreen)] as [String: Any])
        ucc.addUserScript(WKUserScript(source: PageScript.source(initJSON: initJSON), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(app.pageMessages, name: "harnessDesktop")
        if let rules = app.contentRules { ucc.add(rules) }
        app.selfTest?.configure(ucc)

        let wv = HarnessWebView(frame: window.contentView?.bounds ?? .zero, configuration: cfg)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        if wv.responds(to: NSSelectorFromString("setDrawsBackground:")) { wv.setValue(false, forKey: "drawsBackground") }
        if #available(macOS 12.0, *) { wv.underPageBackgroundColor = windowBackground }
        window.contentView?.addSubview(wv)
        webView = wv
        pageLoaded = false
    }

    /// The web view and its WebContent process are released while the window is closed with hideOnClose off.
    private func dropWebView() {
        guard let wv = webView else { return }
        wv.stopLoading()
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.configuration.userContentController.removeAllScriptMessageHandlers()
        wv.removeFromSuperview()
        webView = nil
        pageLoaded = false
    }

    func load() {
        if webView == nil { makeWebView() }
        pageLoaded = false
        webView?.load(URLRequest(url: URL(string: "harness://app/")!))
        // Show the window when the page has painted, or after 3 s whatever happens (never an invisible app).
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.showFirstTime() }
    }

    /// Reload the current page (same chat: the UI's router lives in the URL hash).
    func reload() {
        guard let wv = webView else { load(); return }
        pageLoaded = false
        if let u = wv.url, Checks.isAppUrl(u) { wv.load(URLRequest(url: u)) } else { load() }
    }

    private func showFirstTime() {
        guard !shownOnce else { return }
        shownOnce = true
        if app.selfTest == nil || app.selfTest?.showWindow == true {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            window.orderFront(nil)
        }
    }

    func show() {
        if webView == nil { load() }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    var isVisible: Bool { window.isVisible && !window.isMiniaturized }

    // MARK: page messages

    func sendMenuAction(_ action: String) {
        guard menuActions.contains(action) else { return }
        show()
        if pageLoaded { evaluate("window.__harnessNative && window.__harnessNative.menuAction(\(jsonString(action)))") }
        else { queuedActions.append(action) }
    }

    func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func sendFullscreen(_ on: Bool? = nil) {
        let v = on ?? window.styleMask.contains(.fullScreen)
        evaluate("window.__harnessNative && window.__harnessNative.fullscreen(\(v ? "true" : "false"))")
    }

    func setProgress(_ text: String?) {
        guard let text = text else { overlay?.removeFromSuperview(); overlay = nil; return }
        if overlay == nil, let cv = window.contentView {
            let f = NSTextField(labelWithString: "")
            f.font = .systemFont(ofSize: 13)
            f.textColor = .secondaryLabelColor
            f.alignment = .center
            f.translatesAutoresizingMaskIntoConstraints = false
            cv.addSubview(f)
            NSLayoutConstraint.activate([f.centerXAnchor.constraint(equalTo: cv.centerXAnchor), f.centerYAnchor.constraint(equalTo: cv.centerYAnchor)])
            overlay = f
        }
        overlay?.stringValue = text
        showFirstTime()
    }

    // MARK: title-bar drag (the page reports a press on its title bar)

    func dragWindow() {
        guard let e = lastMouseDown, e.window === window, ProcessInfo.processInfo.systemUptime - e.timestamp < 1.0,
              NSEvent.pressedMouseButtons & 1 == 1 else { return }
        window.performDrag(with: e)
    }

    func titlebarDoubleClick() {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        default: window.zoom(nil)
        }
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        saveStateNow()
        if app.quitting { return true }
        if app.config.hideOnClose {
            // macOS convention: closing keeps Harness running; the Dock icon or the global shortcut brings it back.
            if window.styleMask.contains(.fullScreen) {
                hideAfterFullScreen = true
                window.toggleFullScreen(nil)
            } else {
                window.orderOut(nil)
            }
            app.selfTest?.record("windowHidden", true)
            return false
        }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        if !app.quitting && !app.config.hideOnClose { dropWebView() }
    }

    // The class changes as the transition starts (the traffic lights go away then) and is confirmed at its end.
    func windowWillEnterFullScreen(_ notification: Notification) { fullScreenTransition = true; sendFullscreen(true) }
    func windowWillExitFullScreen(_ notification: Notification) { fullScreenTransition = true; sendFullscreen(false) }
    func windowDidEnterFullScreen(_ notification: Notification) { fullScreenTransition = false; sendFullscreen() }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) { fullScreenTransition = false; sendFullscreen() }
    func windowDidFailToExitFullScreen(_ window: NSWindow) { fullScreenTransition = false; sendFullscreen() }

    func windowDidExitFullScreen(_ notification: Notification) {
        fullScreenTransition = false
        sendFullscreen()
        if hideAfterFullScreen { hideAfterFullScreen = false; window.orderOut(nil) }
    }

    func windowDidMove(_ notification: Notification) { scheduleSave() }
    func windowDidResize(_ notification: Notification) { scheduleSave() }

    private func scheduleSave() {
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in self?.saveStateNow() }
    }

    func saveStateNow() {
        saveTimer?.invalidate()
        if window.styleMask.contains(.fullScreen) || window.isMiniaturized { return }
        WindowState.save(window, to: app.paths.windowState)
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if navigationAction.shouldPerformDownload {
            // WebKit downloads blob:/data: itself; Harness's own files go through the bridge (WKDownload
            // reports "unsupported URL" for custom schemes).
            if url?.scheme == "blob" || url?.scheme == "data" { decisionHandler(.download); return }
            decisionHandler(.cancel)
            if Checks.isAppUrl(url), let u = url { app.downloadAppUrl(u, suggestedName: nil) }
            return
        }
        if Checks.isAppUrl(url) { decisionHandler(.allow); return }
        if url?.absoluteString == "about:blank" && navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true
        if isMain, let s = url?.absoluteString, Checks.externalHttpUrl(s) != nil {
            _ = app.openExternal(s)
        } else {
            app.blocked("navigation", url?.absoluteString ?? "?")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        var attachment = false
        if let r = navigationResponse.response as? HTTPURLResponse,
           let cd = r.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().hasPrefix("attachment") { attachment = true }
        if attachment || !navigationResponse.canShowMIMEType {
            decisionHandler(.cancel)
            if let u = navigationResponse.response.url, Checks.isAppUrl(u) { app.downloadAppUrl(u, suggestedName: nil) }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        sendFullscreen()
        let queued = queuedActions
        queuedActions.removeAll()
        for a in queued { evaluate("window.__harnessNative && window.__harnessNative.menuAction(\(jsonString(a)))") }
        setProgress(nil)
        showFirstTime()
        app.pageDidLoad()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        app.log.info("page load failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.domain == WKErrorDomain && e.code == 102 { return } // frame load interrupted (a download or a cancelled navigation)
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        app.log.info("page load failed: \(e.domain) \(e.code)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        app.log.info("the web content process stopped")
        app.selfTest?.record("webContentTerminated", true)
        if app.quitting { return }
        if app.selfTest != nil { reload(); return }
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "The Harness window stopped unexpectedly."
        a.informativeText = "Your chats are safe — they are kept by Harness's backend. Reload the window?"
        a.addButton(withTitle: "Reload")
        a.addButton(withTitle: "Quit")
        if a.runModal() == .alertFirstButtonReturn { reload() } else { NSApp.terminate(nil) }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // No child windows, ever. http(s) goes to the browser; Harness's own files (an attachment, an image) are saved.
        let url = navigationAction.request.url
        if let s = url?.absoluteString, Checks.externalHttpUrl(s) != nil { _ = app.openExternal(s) }
        else if Checks.isAppUrl(url), let u = url { app.downloadAppUrl(u, suggestedName: nil) }
        else { app.blocked("window.open", url?.absoluteString ?? "?") }
        return nil
    }

    /// Where to save a download: a Save panel (a sheet on the window when it is visible).
    func chooseDestination(_ name: String, _ choose: @escaping (URL?) -> Void) {
        if let dir = app.selfTest?.downloadsDir {
            let dest = dir.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: dest)
            choose(dest)
            return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        let done: (NSApplication.ModalResponse) -> Void = { r in
            guard r == .OK, let url = panel.url else { choose(nil); return }
            try? FileManager.default.removeItem(at: url) // the panel has already asked whether to replace it
            choose(url)
        }
        if window.isVisible { panel.beginSheetModal(for: window, completionHandler: done) } else { panel.begin(completionHandler: done) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        if let files = app.selfTest?.takeOpenPanelFiles() { completionHandler(files); return }
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = parameters.allowsDirectories
        p.canChooseFiles = true
        p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        if app.selfTest != nil { completionHandler(); return }
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        if app.selfTest != nil { completionHandler(true); return }
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    // MARK: WKDownloadDelegate (exports, backups, attachments: always through a Save panel)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let key = ObjectIdentifier(download)
        chooseDestination(WindowState.safeFileName(suggestedFilename)) { [weak self] url in
            if let u = url { self?.downloadNames[key] = u }
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let dest = downloadNames.removeValue(forKey: ObjectIdentifier(download))
        app.selfTest?.downloadFinished(dest, error: nil)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let dest = downloadNames.removeValue(forKey: ObjectIdentifier(download))
        app.log.info("download failed: \((error as NSError).domain) \((error as NSError).code)")
        app.selfTest?.downloadFinished(dest, error: error.localizedDescription)
    }
}

// MARK: - Window size and position (<data>/native/window-state.json)

enum WindowState {
    static let minWidth: CGFloat = 720
    static let minHeight: CGFloat = 480
    static let defaultSize = NSSize(width: 1200, height: 800)

    /// The saved frame when it is still usable on the screens that exist now, else centred on the main screen.
    static func initialFrame(_ file: URL) -> (rect: NSRect, zoomed: Bool) {
        let main = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        func centred(_ size: NSSize) -> NSRect {
            let w = max(minWidth, min(size.width, main.width)), h = max(minHeight, min(size.height, main.height))
            return NSRect(x: main.minX + (main.width - w) / 2, y: main.minY + (main.height - h) / 2, width: w, height: h)
        }
        guard let d = try? Data(contentsOf: file), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let wn = o["width"] as? NSNumber, let hn = o["height"] as? NSNumber else {
            return (centred(defaultSize), false)
        }
        let w = CGFloat(wn.doubleValue), h = CGFloat(hn.doubleValue)
        guard w > 0, h > 0, w < 100000, h < 100000 else { return (centred(defaultSize), false) }
        let zoomed = (o["zoomed"] as? Bool) ?? false
        guard let xn = o["x"] as? NSNumber, let yn = o["y"] as? NSNumber else { return (centred(NSSize(width: w, height: h)), zoomed) }
        let x = CGFloat(xn.doubleValue), y = CGFloat(yn.doubleValue)
        let rect = NSRect(x: x, y: y, width: w, height: h)
        var best: (area: CGFloat, screen: NSRect)? = nil
        for s in NSScreen.screens {
            let i = rect.intersection(s.visibleFrame)
            if i.isNull || i.width < 120 || i.height < 60 { continue }
            let a: CGFloat = i.width * i.height
            if let b = best, b.area >= a { continue }
            best = (a, s.visibleFrame)
        }
        guard let area = best?.screen else { return (centred(NSSize(width: w, height: h)), zoomed) }
        let cw = max(minWidth, min(w, area.width)), ch = max(minHeight, min(h, area.height))
        let cx = min(max(x, area.minX), area.maxX - cw), cy = min(max(y, area.minY), area.maxY - ch)
        return (NSRect(x: cx, y: cy, width: cw, height: ch), zoomed)
    }

    static func save(_ window: NSWindow, to file: URL) {
        let f = window.frame
        let o: [String: Any] = ["x": Int(f.minX), "y": Int(f.minY), "width": Int(f.width), "height": Int(f.height), "zoomed": window.isZoomed]
        guard let d = try? JSONSerialization.data(withJSONObject: o) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? d.write(to: file, options: .atomic)
    }

    static func safeFileName(_ s: String) -> String {
        var name = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.isEmpty { name = "download" }
        return String(name.prefix(200))
    }
}
