// harness://app/<path> → a bridge request for /<path>. Every load of the page goes through here: the UI's files,
// API calls, server-sent event streams, images and attachments. Nothing else can be loaded (see Window.swift).
import AppKit
import WebKit

/// Routes requests to the backend that is running now, and parks them while it restarts.
final class Transport {
    private(set) var backend: Backend?
    private var parked: [(method: String, path: String, headers: [String: String], body: RequestBody, sink: TransportSink)] = []

    func attach(_ b: Backend) {
        backend = b
        let p = parked
        parked.removeAll()
        for r in p where !r.sink.isCancelled { send(r.method, r.path, r.headers, r.body, r.sink) }
    }

    func detach() { backend = nil }

    func send(_ method: String, _ path: String, _ headers: [String: String], _ body: RequestBody, _ sink: TransportSink) {
        if let b = backend, b.running {
            sink.backend = b
            sink.streamId = b.request(method: method, path: path, headers: headers, body: body, sink: sink)
        } else {
            parked.append((method, path, headers, body, sink))
        }
    }

    func cancel(_ sink: TransportSink) {
        sink.isCancelled = true
        if let b = sink.backend, let id = sink.streamId { b.cancel(id) }
        parked.removeAll { $0.sink === sink }
    }
}

class TransportSink: BridgeSink {
    weak var backend: Backend?
    var streamId: UInt32?
    var isCancelled = false
    func bridgeHead(status: Int, headers: [String: String]) {}
    func bridgeBody(_ data: Data) {}
    func bridgeEnd() {}
    func bridgeFail(_ reason: String) {}
}

/// One page load answered from the bridge.
final class SchemeTaskSink: TransportSink {
    let task: WKURLSchemeTask
    private var gotHead = false
    private var done = false
    private let onDone: (SchemeTaskSink) -> Void

    init(task: WKURLSchemeTask, onDone: @escaping (SchemeTaskSink) -> Void) {
        self.task = task
        self.onDone = onDone
    }

    override func bridgeHead(status: Int, headers: [String: String]) {
        guard !isCancelled, !done, !gotHead, let url = task.request.url else { return }
        var h: [String: String] = [:]
        for (k, v) in headers where k != "set-cookie" { h[k] = v }
        guard let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: h) else { return }
        gotHead = true
        task.didReceive(r)
    }

    override func bridgeBody(_ data: Data) {
        guard !isCancelled, !done, gotHead, !data.isEmpty else { return }
        task.didReceive(data)
    }

    override func bridgeEnd() {
        guard !isCancelled, !done else { return }
        if !gotHead { bridgeHead(status: 502, headers: ["content-type": "application/json"]) }
        done = true
        task.didFinish()
        onDone(self)
    }

    override func bridgeFail(_ reason: String) {
        guard !isCancelled, !done else { return }
        done = true
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost,
                                      userInfo: [NSLocalizedDescriptionKey: reason]))
        onDone(self)
    }

    func failNow(status: Int, _ message: String) {
        bridgeHead(status: status, headers: ["content-type": "application/json; charset=utf-8", "cache-control": "no-store"])
        bridgeBody(Data(jsonString(["error": ["code": "native", "message": message]]).utf8))
        bridgeEnd()
    }
}

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    unowned let transport: Transport
    private var live: [ObjectIdentifier: SchemeTaskSink] = [:]
    var onRequest: ((String, String) -> Void)?

    init(transport: Transport) { self.transport = transport }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        let sink = SchemeTaskSink(task: urlSchemeTask) { [weak self] _ in self?.live.removeValue(forKey: key) }
        live[key] = sink
        let req = urlSchemeTask.request
        guard let url = req.url, Checks.isAppUrl(url), let head = SchemeHandler.bridgeHead(req) else {
            sink.failNow(status: 404, "Not found")
            return
        }
        onRequest?(head.method, head.path)
        var body: RequestBody = .none
        if let d = req.httpBody { body = .data(d) } else if let s = req.httpBodyStream { body = .stream(s) }
        transport.send(head.method, head.path, head.headers, body, sink)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // The page no longer wants it (fetch aborted, navigation away): the backend treats it as a disconnect.
        if let sink = live.removeValue(forKey: ObjectIdentifier(urlSchemeTask)) { transport.cancel(sink) }
    }

    /// harness://app/a/b?x=1 → ("GET", "/a/b?x=1", lower-cased headers).
    static func bridgeHead(_ req: URLRequest) -> (method: String, path: String, headers: [String: String])? {
        guard let url = req.url, let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var path = comps.percentEncodedPath
        if path.isEmpty { path = "/" }
        if let q = comps.percentEncodedQuery { path += "?" + q }
        var headers: [String: String] = [:]
        for (k, v) in req.allHTTPHeaderFields ?? [:] { headers[k.lowercased()] = v }
        return ((req.httpMethod ?? "GET").uppercased(), path, headers)
    }
}

/// A download of one of Harness's own files (exports, backups, attachments) through the bridge into a file the user
/// picked. WKDownload cannot fetch custom-scheme URLs ("unsupported URL" on macOS 26), so the app does it itself.
final class BridgeDownload: TransportSink {
    private let destination: (String, @escaping (URL?) -> Void) -> Void
    private let finished: (URL?, String?) -> Void
    private let fallbackName: String
    private var file: FileHandle?
    private var url: URL?
    private var buffered = Data()
    private var waitingForDestination = false
    private var ended = false
    private var failed: String?
    private var status = 0

    /// `destination(suggestedName, choose)` asks where to save (a Save panel); `finished(url, error)` reports.
    init(fallbackName: String, destination: @escaping (String, @escaping (URL?) -> Void) -> Void, finished: @escaping (URL?, String?) -> Void) {
        self.fallbackName = fallbackName
        self.destination = destination
        self.finished = finished
    }

    override func bridgeHead(status: Int, headers: [String: String]) {
        self.status = status
        guard (200..<300).contains(status) else { return }
        let name = BridgeDownload.filename(fromDisposition: headers["content-disposition"]) ?? fallbackName
        waitingForDestination = true
        destination(WindowState.safeFileName(name)) { [weak self] chosen in self?.destinationChosen(chosen) }
    }

    private func destinationChosen(_ chosen: URL?) {
        waitingForDestination = false
        guard let dest = chosen else { cancelSelf(); finished(nil, nil); return }
        FileManager.default.createFile(atPath: dest.path, contents: nil, attributes: [.posixPermissions: 0o600])
        guard let fh = try? FileHandle(forWritingTo: dest) else { cancelSelf(); finished(nil, "Cannot write \(dest.lastPathComponent)"); return }
        file = fh
        url = dest
        if !buffered.isEmpty { try? fh.write(contentsOf: buffered); buffered.removeAll() }
        if ended { complete() }
    }

    private func cancelSelf() {
        if let b = backend, let id = streamId { b.cancel(id) }
        isCancelled = true
    }

    override func bridgeBody(_ data: Data) {
        guard (200..<300).contains(status) else { return }
        if let fh = file { try? fh.write(contentsOf: data) } else { buffered.append(data) }
    }

    override func bridgeEnd() {
        ended = true
        if !(200..<300).contains(status) { finished(nil, "The download failed (HTTP \(status))."); return }
        if !waitingForDestination { complete() }
    }

    override func bridgeFail(_ reason: String) {
        try? file?.close()
        if let u = url { try? FileManager.default.removeItem(at: u) }
        finished(nil, reason)
    }

    private func complete() {
        try? file?.close()
        file = nil
        finished(url, nil)
    }

    /// `attachment; filename*=UTF-8''a%20b.md` or `filename="a.md"`.
    static func filename(fromDisposition cd: String?) -> String? {
        guard let cd = cd else { return nil }
        for part in cd.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            if part.lowercased().hasPrefix("filename*=") {
                var v = String(part.dropFirst("filename*=".count))
                if let r = v.range(of: "''") { v = String(v[r.upperBound...]) }
                if let d = v.removingPercentEncoding, !d.isEmpty { return d }
            }
        }
        for part in cd.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }) where part.lowercased().hasPrefix("filename=") {
            let v = String(part.dropFirst("filename=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            if !v.isEmpty { return v }
        }
        return nil
    }
}
