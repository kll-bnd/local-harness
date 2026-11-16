// Fact-finding probe (CI only): what does WKWebView's custom-scheme handler really do on this macOS?
// Serves a test page from harness://app/, records what the handler receives, writes JSON results.
//   SchemeProbe --root <dir with probe.html/probe.js> --out <results.json>
import AppKit
import Carbon
import WebKit

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let root = URL(fileURLWithPath: arg("--root") ?? ".")
let outPath = arg("--out") ?? "/tmp/scheme-probe.json"

var native: [String: Any] = [:]
var requests: [[String: Any]] = []
var policy: [String] = []

func pattern(_ i: Int) -> UInt8 { UInt8(truncatingIfNeeded: i &* 31 &+ 7) }

func checkPattern(_ d: Data) -> Bool {
    var ok = true
    d.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
        for i in 0..<p.count where p[i] != pattern(i) { ok = false; break }
    }
    return ok
}

func readStream(_ s: InputStream) -> Data {
    s.open()
    defer { s.close() }
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 65536)
    while true {
        let n = s.read(&buf, maxLength: buf.count)
        if n <= 0 { break }
        out.append(buf, count: n)
    }
    return out
}

final class Handler: NSObject, WKURLSchemeHandler {
    var stopped = Set<ObjectIdentifier>()
    var foreverStopAt: Double? = nil
    var foreverStarted: Double? = nil
    let t0 = Date()

    func now() -> Double { Date().timeIntervalSince(t0) * 1000 }

    func respond(_ task: WKURLSchemeTask, _ status: Int, _ type: String, _ body: Data, extra: [String: String] = [:]) {
        var h = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-store"]
        for (k, v) in extra { h[k] = v }
        let r = HTTPURLResponse(url: task.request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: h)!
        task.didReceive(r)
        task.didReceive(body)
        task.didFinish()
    }

    func json(_ task: WKURLSchemeTask, _ obj: Any, status: Int = 200) {
        let d = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{}".utf8)
        respond(task, status, "application/json; charset=utf-8", d)
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let req = task.request
        guard let url = req.url else { return }
        let path = url.path
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func qi(_ n: String, _ d: Int) -> Int { Int(q.first(where: { $0.name == n })?.value ?? "") ?? d }
        var body: Data? = req.httpBody
        var source = body != nil ? "httpBody" : "none"
        if body == nil, let s = req.httpBodyStream { body = readStream(s); source = "httpBodyStream" }
        var rec: [String: Any] = ["t": Int(now()), "method": req.httpMethod ?? "?", "path": path, "bodySource": source, "bodyLength": body?.count ?? -1, "mainThread": Thread.isMainThread]
        if let h = req.allHTTPHeaderFields { rec["headers"] = h }
        requests.append(rec)

        switch path {
        case "/", "/probe.html", "/probe-csp.html":
            let name = path == "/probe-csp.html" ? "probe-csp.html" : "probe.html"
            let d = (try? Data(contentsOf: root.appendingPathComponent(name))) ?? Data()
            respond(task, 200, "text/html; charset=utf-8", d)
        case "/probe.js":
            let d = (try? Data(contentsOf: root.appendingPathComponent("probe.js"))) ?? Data()
            respond(task, 200, "text/javascript; charset=utf-8", d)
        case "/echo":
            var o: [String: Any] = ["method": req.httpMethod ?? "?", "bodySource": source, "bodyLength": body?.count ?? -1]
            if let b = body { o["intact"] = checkPattern(b); if b.count < 10000 { o["bodyText"] = String(decoding: b, as: UTF8.self) } }
            o["headers"] = req.allHTTPHeaderFields ?? [:]
            json(task, o)
        case "/status":
            let s = qi("code", 423)
            json(task, ["error": ["code": "locked", "message": "Locked"]], status: s)
        case "/image.png":
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 3, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            let png = rep.representation(using: .png, properties: [:]) ?? Data()
            respond(task, 200, "image/png", png)
        case "/big":
            let n = qi("mb", 20) * 1024 * 1024
            var d = Data(count: n)
            d.withUnsafeMutableBytes { (p: UnsafeMutableRawBufferPointer) in for i in 0..<n { p[i] = pattern(i) } }
            respond(task, 200, "application/octet-stream", d)
        case "/download":
            respond(task, 200, "text/plain", Data("downloaded".utf8), extra: ["Content-Disposition": "attachment; filename=\"x.txt\""])
        case "/stream", "/events", "/forever":
            let n = path == "/forever" ? 100000 : qi("n", 8)
            let ms = path == "/forever" ? 100 : qi("ms", 250)
            let id = ObjectIdentifier(task)
            if path == "/forever" { foreverStarted = now() }
            let r = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream", "Cache-Control": "no-store"])!
            task.didReceive(r)
            var i = 0
            func tick() {
                if self.stopped.contains(id) { return }
                if i >= n { task.didFinish(); return }
                let line = "event: tick\ndata: {\"type\":\"tick\",\"i\":\(i),\"t\":\(Int(self.now()))}\n\n"
                task.didReceive(Data(line.utf8))
                i += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { tick() }
            }
            tick()
        case "/cancel-status":
            json(task, ["foreverStarted": foreverStarted ?? -1, "stopAt": foreverStopAt ?? -1, "stopCalls": (native["stopCalls"] as? Int) ?? 0])
        case "/done":
            if let b = body, let o = try? JSONSerialization.jsonObject(with: b) { native["pageViaPost"] = (o as? [String: Any])?.count ?? 0 }
            json(task, ["ok": true])
        default:
            json(task, ["error": "not found", "path": path], status: 404)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
        native["stopCalls"] = ((native["stopCalls"] as? Int) ?? 0) + 1
        let p = task.request.url?.path ?? "?"
        if p == "/forever" { foreverStopAt = now() }
        var l = (native["stopPaths"] as? [String]) ?? []
        l.append(p)
        native["stopPaths"] = l
    }
}

final class Nav: NSObject, WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url?.absoluteString ?? "?"
        var dl = false
        if #available(macOS 11.3, *) { dl = action.shouldPerformDownload }
        policy.append("action \(u) main=\(action.targetFrame?.isMainFrame ?? false) download=\(dl) type=\(action.navigationType.rawValue)")
        if dl { decisionHandler(.download); return }
        if u.hasPrefix("harness://app/") || u == "about:blank" { decisionHandler(.allow) } else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        policy.append("response \(response.response.url?.absoluteString ?? "?") canShow=\(response.canShowMIMEType)")
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        policy.append("createWebView \(action.request.url?.absoluteString ?? "?")")
        if let u = action.request.url, u.scheme == "harness" {
            webView.startDownload(using: URLRequest(url: u)) { d in d.delegate = downloads; policy.append("startDownload started") }
        }
        return nil
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        policy.append("didBecomeDownload(action) \(navigationAction.request.url?.absoluteString ?? "?")")
        download.delegate = downloads
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        policy.append("didBecomeDownload(response)")
        download.delegate = downloads
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { policy.append("didFinish \(webView.url?.absoluteString ?? "?")") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { policy.append("didFail \(error.localizedDescription)") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { policy.append("didFailProvisional \(error.localizedDescription)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { policy.append("webContentTerminated") }
}

final class Downloads: NSObject, WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = URL(fileURLWithPath: "/tmp/probe/dl")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(UUID().uuidString + "-" + suggestedFilename)
        policy.append("download decide \(suggestedFilename) type=\(response.mimeType ?? "?") url=\(response.url?.absoluteString.prefix(40) ?? "?")")
        completionHandler(dest)
    }
    func downloadDidFinish(_ download: WKDownload) {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: "/tmp/probe/dl")) ?? []
        var sizes: [String] = []
        for f in files { let a = try? FileManager.default.attributesOfItem(atPath: "/tmp/probe/dl/" + f); sizes.append("\(f.suffix(12))=\((a?[.size] as? NSNumber)?.intValue ?? -1)") }
        policy.append("download finished: \(sizes.joined(separator: " "))")
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        policy.append("download failed: \(error.localizedDescription)")
    }
}
let downloads = Downloads()

final class Msg: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        native["messageOrigin"] = "\(message.frameInfo.securityOrigin.protocol)://\(message.frameInfo.securityOrigin.host)"
        if let b = message.body as? [String: Any], let kind = b["kind"] as? String {
            if kind == "phase1" || kind == "phase2" {
                native[kind] = b["results"] ?? [:]
                if kind == "phase2" { DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { finish("done") } }
            } else if kind == "cmd" {
                runCommand(b, message.webView)
            } else {
                var l = (native["notes"] as? [Any]) ?? []
                l.append(b)
                native["notes"] = l
            }
        }
    }
}

var menuFired: [String] = []
final class MenuTarget: NSObject {
    @objc func fire(_ sender: NSMenuItem) { menuFired.append(sender.title) }
}
let menuTarget = MenuTarget()

func runCommand(_ b: [String: Any], _ wv: WKWebView?) {
    let id = (b["id"] as? Int) ?? 0
    let op = (b["op"] as? String) ?? ""
    func reply(_ v: Any) {
        let d = (try? JSONSerialization.data(withJSONObject: ["v": v])) ?? Data("{}".utf8)
        wv?.evaluateJavaScript("window.__probeReply(\(id), \(String(decoding: d, as: UTF8.self)).v)", completionHandler: nil)
    }
    let w = window!
    switch op {
    case "click":
        let x = (b["x"] as? Double) ?? 200, yTop = (b["y"] as? Double) ?? 12
        let h = w.contentView!.bounds.height
        let p = NSPoint(x: x, y: h - yTop)
        for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { w.sendEvent(e) }
        }
        reply(["sent": true, "key": w.isKeyWindow, "titlebarH": w.frame.height - w.contentLayoutRect.height])
    case "key":
        let chars = (b["chars"] as? String) ?? "k"
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: 40) {
            NSApp.sendEvent(e)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { reply(["menuFired": menuFired]) }
    case "secure":
        reply(["secureInput": IsSecureEventInputEnabled(), "key": w.isKeyWindow, "active": NSApp.isActive, "firstResponder": String(describing: type(of: w.firstResponder as Any))])
    default:
        reply("unknown")
    }
}

func finish(_ why: String) {
    native["finish"] = why
    native["requests"] = requests
    native["policy"] = policy
    let d = (try? JSONSerialization.data(withJSONObject: native, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    try? d.write(to: URL(fileURLWithPath: outPath))
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let handler = Handler()
let nav = Nav()
let msg = Msg()
var window: NSWindow!
var web: WKWebView!

func start(rules: WKContentRuleList?) {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent()
    cfg.setURLSchemeHandler(handler, forURLScheme: "harness")
    cfg.userContentController.add(msg, name: "probe")
    if let r = rules { cfg.userContentController.add(r) }
    window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 900, height: 600), styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    let tb = NSToolbar(identifier: "probe")
    tb.showsBaselineSeparator = false
    window.toolbar = tb
    window.toolbarStyle = .unifiedCompact
    let main = NSMenu()
    let appItem = NSMenuItem(); main.addItem(appItem)
    let appMenu = NSMenu(); appItem.submenu = appMenu
    let k = NSMenuItem(title: "Palette", action: #selector(MenuTarget.fire(_:)), keyEquivalent: "k"); k.target = menuTarget; appMenu.addItem(k)
    NSApp.mainMenu = main
    web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
    web.autoresizingMask = [.width, .height]
    web.navigationDelegate = nav
    web.uiDelegate = nav
    window.contentView!.addSubview(web)
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    web.load(URLRequest(url: URL(string: "harness://app/probe.html")!))
}

let rulesJSON = """
[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
 {"trigger":{"url-filter":"^harness://app/"},"action":{"type":"ignore-previous-rules"}},
 {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
 {"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]
"""
WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "probe-block", encodedContentRuleList: rulesJSON) { list, err in
    native["ruleListCompiled"] = list != nil
    if let e = err { native["ruleListError"] = e.localizedDescription }
    start(rules: list)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 150) { finish("timeout") }
app.run()
