// The bridge: the backend runs as a child process and the two talk in length-prefixed frames over the
// child's stdin/stdout (docs/BRIDGE.md). No socket of any kind is opened.
import Foundation

enum FrameType {
    static let reqHead: UInt8 = 0x01
    static let reqBody: UInt8 = 0x02
    static let reqEnd: UInt8 = 0x03
    static let cancel: UInt8 = 0x04
    static let control: UInt8 = 0x05
    static let resHead: UInt8 = 0x11
    static let resBody: UInt8 = 0x12
    static let resEnd: UInt8 = 0x13
    static let event: UInt8 = 0x15
}

let maxFramePayload = 1_048_576

struct Frame {
    let type: UInt8
    let stream: UInt32
    let payload: Data
}

/// Big-endian bytes of a 32-bit value (kept as plain statements: long integer expressions are slow to type-check).
func be32(_ v: UInt32) -> [UInt8] {
    let a = UInt8(truncatingIfNeeded: v >> 24)
    let b = UInt8(truncatingIfNeeded: v >> 16)
    let c = UInt8(truncatingIfNeeded: v >> 8)
    let d = UInt8(truncatingIfNeeded: v)
    return [a, b, c, d]
}

func readBE32(_ buf: [UInt8], _ i: Int) -> UInt32 {
    var v = UInt32(buf[i])
    v = (v << 8) | UInt32(buf[i + 1])
    v = (v << 8) | UInt32(buf[i + 2])
    v = (v << 8) | UInt32(buf[i + 3])
    return v
}

func encodeFrame(_ type: UInt8, _ stream: UInt32, _ payload: Data = Data()) -> Data {
    var d = Data(capacity: 9 + payload.count)
    d.append(contentsOf: be32(UInt32(5 + payload.count)))
    d.append(type)
    d.append(contentsOf: be32(stream))
    d.append(payload)
    return d
}

struct CorruptStream: Error {}

/// Incremental frame parser (used from one reading queue only).
final class FrameDecoder {
    private var buf = [UInt8]()
    private var pos = 0

    func feed(_ chunk: Data) throws -> [Frame] {
        buf.append(contentsOf: chunk)
        var out: [Frame] = []
        while buf.count - pos >= 4 {
            let n = Int(readBE32(buf, pos))
            if n < 5 || n > maxFramePayload + 5 { throw CorruptStream() }
            if buf.count - pos < 4 + n { break }
            let type = buf[pos + 4]
            let sid = readBE32(buf, pos + 5)
            let payload = n > 5 ? Data(buf[(pos + 9)..<(pos + 4 + n)]) : Data()
            out.append(Frame(type: type, stream: sid, payload: payload))
            pos += 4 + n
        }
        if pos > 0 && (pos == buf.count || pos > 4 * maxFramePayload) {
            buf.removeSubrange(0..<pos)
            pos = 0
        }
        return out
    }
}

/// Receives one response. All calls arrive on the main thread.
protocol BridgeSink: AnyObject {
    func bridgeHead(status: Int, headers: [String: String])
    func bridgeBody(_ data: Data)
    func bridgeEnd()
    func bridgeFail(_ reason: String)
}

enum RequestBody {
    case none
    case data(Data)
    case stream(InputStream)
}

/// One backend child process. Everything public is used from the main thread.
final class Backend {
    struct Spec {
        var executable: String
        var arguments: [String]
        var environment: [String: String]
        var directory: String
    }

    var onEvent: (([String: Any]) -> Void)?
    var onLogLine: ((String) -> Void)?
    /// (exit status, was the exit requested by us)
    var onExit: ((Int32, Bool) -> Void)?

    private(set) var pid: Int32 = 0
    private(set) var ready = false
    private(set) var running = false
    private var process: Process?
    private var stdinHandle: FileHandle?
    private let writeQueue = DispatchQueue(label: "local.harness.bridge.write")
    private var sinks: [UInt32: BridgeSink] = [:]
    private var nextId: UInt32 = 0
    private var waitingForReady: [() -> Void] = []
    private var stderrRest = Data()
    private var stopRequested = false
    private var exitStatus: Int32? = nil
    private var stdoutClosed = false
    private var finished = false
    private let cancelledLock = NSLock()
    private var cancelledUploads = Set<UInt32>()

    func start(_ spec: Spec, hello: [String: Any]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: spec.executable)
        p.arguments = spec.arguments
        p.environment = spec.environment
        p.currentDirectoryURL = URL(fileURLWithPath: spec.directory)
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe
        let decoder = FrameDecoder()
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let chunk = fh.availableData
            if chunk.isEmpty {
                fh.readabilityHandler = nil
                DispatchQueue.main.async { self?.stdoutEOF() }
                return
            }
            do {
                let frames = try decoder.feed(chunk)
                if !frames.isEmpty { DispatchQueue.main.async { self?.handle(frames) } }
            } catch {
                fh.readabilityHandler = nil
                DispatchQueue.main.async { self?.corrupt() }
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let chunk = fh.availableData
            if chunk.isEmpty { fh.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.stderrChunk(chunk) }
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            DispatchQueue.main.async { self?.processExited(status) }
        }
        try p.run()
        process = p
        pid = p.processIdentifier
        running = true
        stdinHandle = inPipe.fileHandleForWriting
        sendControl(hello)
    }

    // ------------------------------------------------------------------------------------- writing
    private func write(_ data: Data) {
        guard let fh = stdinHandle else { return }
        writeQueue.async {
            do { try fh.write(contentsOf: data) } catch { /* the child is gone; processExited reports it */ }
        }
    }

    func sendControl(_ message: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: message, options: []) else { return }
        write(encodeFrame(FrameType.control, 0, d))
    }

    private func allocateId() -> UInt32 {
        repeat {
            nextId = nextId == UInt32.max ? 1 : nextId + 1
        } while sinks[nextId] != nil
        return nextId
    }

    /// Start a request. Returns the stream id (for cancel). The sink gets head/body/end or fail.
    @discardableResult
    func request(method: String, path: String, headers: [String: String], body: RequestBody, sink: BridgeSink) -> UInt32 {
        let id = allocateId()
        sinks[id] = sink
        let send = { [weak self] in
            guard let self = self, self.sinks[id] != nil else { return }
            self.sendRequest(id: id, method: method, path: path, headers: headers, body: body)
        }
        if ready { send() } else { waitingForReady.append(send) }
        return id
    }

    private func sendRequest(id: UInt32, method: String, path: String, headers: [String: String], body: RequestBody) {
        guard let fh = stdinHandle else { return }
        let head = (try? JSONSerialization.data(withJSONObject: ["method": method, "path": path, "headers": headers], options: [])) ?? Data("{}".utf8)
        let isCancelled: () -> Bool = { [cancelledLock] in
            cancelledLock.lock(); defer { cancelledLock.unlock() }
            return self.cancelledUploads.contains(id)
        }
        writeQueue.async {
            do {
                try fh.write(contentsOf: encodeFrame(FrameType.reqHead, id, head))
                switch body {
                case .none:
                    break
                case .data(let d):
                    var off = 0
                    while off < d.count {
                        if isCancelled() { return }
                        let end = min(off + maxFramePayload, d.count)
                        try fh.write(contentsOf: encodeFrame(FrameType.reqBody, id, d.subdata(in: off..<end)))
                        off = end
                    }
                case .stream(let s):
                    s.open()
                    defer { s.close() }
                    var buf = [UInt8](repeating: 0, count: 256 * 1024)
                    while true {
                        if isCancelled() { return }
                        let n = s.read(&buf, maxLength: buf.count)
                        if n <= 0 { break }
                        try fh.write(contentsOf: encodeFrame(FrameType.reqBody, id, Data(buf[0..<n])))
                    }
                }
                try fh.write(contentsOf: encodeFrame(FrameType.reqEnd, id))
            } catch { /* child gone */ }
        }
    }

    /// The page (or the app) no longer wants this response.
    func cancel(_ id: UInt32) {
        guard sinks.removeValue(forKey: id) != nil else { return }
        cancelledLock.lock(); cancelledUploads.insert(id); cancelledLock.unlock()
        if running && ready { write(encodeFrame(FrameType.cancel, id)) }
        writeQueue.async { [weak self] in
            guard let self = self else { return }
            self.cancelledLock.lock(); self.cancelledUploads.remove(id); self.cancelledLock.unlock()
        }
    }

    // ------------------------------------------------------------------------------------- reading
    private func handle(_ frames: [Frame]) {
        for f in frames {
            switch f.type {
            case FrameType.resHead:
                guard let sink = sinks[f.stream] else { continue }
                let o = (try? JSONSerialization.jsonObject(with: f.payload)) as? [String: Any] ?? [:]
                let status = (o["status"] as? Int) ?? 500
                var headers: [String: String] = [:]
                for (k, v) in (o["headers"] as? [String: Any]) ?? [:] {
                    if let s = v as? String { headers[k.lowercased()] = s } else if let n = v as? NSNumber { headers[k.lowercased()] = n.stringValue }
                }
                sink.bridgeHead(status: status, headers: headers)
            case FrameType.resBody:
                sinks[f.stream]?.bridgeBody(f.payload)
            case FrameType.resEnd:
                if let sink = sinks.removeValue(forKey: f.stream) { sink.bridgeEnd() }
            case FrameType.event:
                guard let o = (try? JSONSerialization.jsonObject(with: f.payload)) as? [String: Any] else { continue }
                if (o["type"] as? String) == "ready" {
                    ready = true
                    let queued = waitingForReady
                    waitingForReady.removeAll()
                    queued.forEach { $0() }
                }
                onEvent?(o)
            default:
                onLogLine?("[native] ignoring unknown frame type \(f.type)")
            }
        }
    }

    private func stderrChunk(_ chunk: Data) {
        stderrRest.append(chunk)
        while let nl = stderrRest.firstIndex(of: 0x0a) {
            let line = String(decoding: stderrRest[stderrRest.startIndex..<nl], as: UTF8.self)
            stderrRest.removeSubrange(stderrRest.startIndex...nl)
            if !line.isEmpty { onLogLine?(line) }
        }
        if stderrRest.count > 64 * 1024 { onLogLine?(String(decoding: stderrRest, as: UTF8.self)); stderrRest.removeAll() }
    }

    private func corrupt() {
        onLogLine?("[native] the backend sent a corrupt frame stream; stopping it")
        process?.terminate()
    }

    private func stdoutEOF() {
        stdoutClosed = true
        finishIfDone()
    }

    private func processExited(_ status: Int32) {
        exitStatus = status
        // stdout may still hold frames: give the reader a moment to drain before reporting.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.stdoutClosed = true
            self?.finishIfDone()
        }
        finishIfDone()
    }

    private func finishIfDone() {
        guard !finished, stdoutClosed, let status = exitStatus else { return }
        finished = true
        running = false
        ready = false
        stdinHandle = nil
        let open = sinks
        sinks.removeAll()
        waitingForReady.removeAll()
        for (_, s) in open { s.bridgeFail("The Harness backend stopped.") }
        if !stderrRest.isEmpty { onLogLine?(String(decoding: stderrRest, as: UTF8.self)); stderrRest.removeAll() }
        onExit?(status, stopRequested)
    }

    /// Ask the backend to shut down; force it after `timeout` seconds.
    func stop(timeout: TimeInterval = 10, completion: (() -> Void)? = nil) {
        guard running, let p = process else { completion?(); return }
        stopRequested = true
        let previous = onExit
        onExit = { status, requested in
            previous?(status, requested)
            completion?()
        }
        sendControl(["op": "shutdown"])
        // Closing stdin is the backend's second signal (end of file = the app is gone).
        let fh = stdinHandle
        writeQueue.async { try? fh?.close() }
        let pid = p.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self = self, self.running, self.pid == pid else { return }
            self.onLogLine?("[native] the backend did not stop within \(Int(timeout)) s; terminating it")
            p.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                if self.running && self.pid == pid { kill(pid, SIGKILL) }
            }
        }
    }

    /// Synchronous last resort while the app is terminating.
    func killNow() {
        guard running, let p = process else { return }
        p.terminate()
    }
}
