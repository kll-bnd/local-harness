// Paths, the small config files, the log file and the argument checks shared by the native shell.
import AppKit
import Foundation

// MARK: - Paths

struct Paths {
    let dataDir: URL
    var desktopConfig: URL { dataDir.appendingPathComponent("desktop.json") }
    var launchConfig: URL { dataDir.appendingPathComponent("launch.json") }
    var nativeDir: URL { dataDir.appendingPathComponent("native", isDirectory: true) }
    var windowState: URL { nativeDir.appendingPathComponent("window-state.json") }
    var instanceLock: URL { nativeDir.appendingPathComponent("app.lock") }
    var logsDir: URL { dataDir.appendingPathComponent("logs", isDirectory: true) }
    var logFile: URL { logsDir.appendingPathComponent("harness.log") }

    /// Same rule as the backend's defaultDataDir(): HARNESS_DATA_DIR, else ~/Library/Application Support/Harness.
    static func resolveDataDir(override: String?) -> URL {
        if let o = override, !o.isEmpty { return URL(fileURLWithPath: (o as NSString).expandingTildeInPath).standardizedFileURL }
        if let e = ProcessInfo.processInfo.environment["HARNESS_DATA_DIR"], !e.isEmpty {
            return URL(fileURLWithPath: (e as NSString).expandingTildeInPath).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Harness", isDirectory: true)
    }
}

// MARK: - desktop.json (shared with the Electron shell)

let menuActions: [String] = [
    "new-chat", "open-settings", "toggle-sidebar", "toggle-inspector", "search-chats", "command-palette",
    "open-models", "open-images", "open-memory", "focus-composer", "stop-generation", "export-chat",
    "import-chat", "show-shortcuts", "lock",
]

struct DesktopConfig {
    static let defaultShortcut = "CommandOrControl+Shift+Space"
    var globalShortcut: String? = DesktopConfig.defaultShortcut
    var hideOnClose = true
    var warnings: [String] = []

    static func load(_ file: URL, env: [String: String] = ProcessInfo.processInfo.environment) -> DesktopConfig {
        var c = DesktopConfig()
        if let data = try? Data(contentsOf: file) {
            if let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                if raw.keys.contains("globalShortcut") {
                    let v = raw["globalShortcut"]
                    if v is NSNull || (v as? Bool) == false || (v as? String) == "" { c.globalShortcut = nil }
                    else if let s = v as? String, validAccelerator(s) { c.globalShortcut = s }
                    else { c.warnings.append("globalShortcut is not a valid accelerator (e.g. \"CommandOrControl+Shift+Space\"); using the default") }
                }
                if let h = raw["hideOnClose"] {
                    if let n = h as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { c.hideOnClose = n.boolValue }
                    else { c.warnings.append("hideOnClose must be true or false") }
                }
            } else {
                c.warnings.append("desktop.json is not a JSON object; using defaults")
            }
        } else if !FileManager.default.fileExists(atPath: file.path) {
            // First run: write the defaults so the file is discoverable (same content as the Electron shell writes).
            let text = "{\n  \"globalShortcut\": \"\(defaultShortcut)\",\n  \"port\": 4747,\n  \"hideOnClose\": true\n}\n"
            try? text.write(to: file, atomically: true, encoding: .utf8)
        }
        if let e = env["HARNESS_GLOBAL_SHORTCUT"] {
            if e.isEmpty { c.globalShortcut = nil } else if validAccelerator(e) { c.globalShortcut = e }
        }
        return c
    }

    static func validAccelerator(_ s: String) -> Bool {
        guard s.count <= 64, s.contains("+") else { return false }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-=[];',./\\`")
        return s.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

// MARK: - launch.json (written by the backend; read before it starts)

struct LaunchConfig {
    var encryption = "password"
    var offlineLock = true

    static func read(_ file: URL) -> LaunchConfig {
        var c = LaunchConfig()
        guard let d = try? Data(contentsOf: file), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return c }
        if let e = o["encryption"] as? String, ["password", "keychain", "off"].contains(e) { c.encryption = e }
        if let l = o["offlineLock"] as? Bool { c.offlineLock = l }
        return c
    }
}

// MARK: - Log file (<data>/logs/harness.log, like the Electron shell). Never request bodies, keys or passwords.

final class LogFile {
    private var handle: FileHandle?
    let url: URL
    private let queue = DispatchQueue(label: "local.harness.log")
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    init(_ url: URL, maxBytes: Int = 5 * 1024 * 1024) {
        self.url = url
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber, size.intValue > maxBytes {
            let old = url.path + ".1"
            try? fm.removeItem(atPath: old)
            try? fm.moveItem(atPath: url.path, toPath: old)
        }
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
    }

    /// A line from the app itself.
    func info(_ text: String) { raw("[native \(stamp.string(from: Date()))] \(text)") }

    /// A line as is (the backend's stderr lines carry their own "[harness <time>]" prefix).
    func raw(_ line: String) {
        if ProcessInfo.processInfo.environment["HARNESS_NATIVE_LOG_STDERR"] == "1" { FileHandle.standardError.write(Data((line + "\n").utf8)) }
        queue.async { [weak self] in try? self?.handle?.write(contentsOf: Data((line + "\n").utf8)) }
    }
}

// MARK: - Checks for what the page asks the app to do (mirror electron/lib/security.cjs)

enum Checks {
    static let maxUrlLength = 8192

    /// An http(s) URL with a host: the only thing that may go to the user's browser.
    static func externalHttpUrl(_ s: String) -> URL? {
        guard !s.isEmpty, s.count <= maxUrlLength, let u = URL(string: s), let scheme = u.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = u.host, !host.isEmpty else { return nil }
        return u
    }

    static func isAppUrl(_ u: URL?) -> Bool {
        guard let u = u else { return false }
        return u.scheme?.lowercased() == "harness" && u.host?.lowercased() == "app"
    }

    /// `p` (absolute, or relative to `dataDir`) if it exists and resolves (symlinks included) inside `dataDir`.
    static func insideDataDir(_ p: String, dataDir: URL) -> URL? {
        guard !p.isEmpty, p.count <= 4096, !p.contains("\u{0}") else { return nil }
        let root = dataDir.resolvingSymlinksInPath().standardizedFileURL
        let candidate = p.hasPrefix("/") ? URL(fileURLWithPath: p) : root.appendingPathComponent(p)
        guard FileManager.default.fileExists(atPath: candidate.path) else { return nil }
        let real = candidate.resolvingSymlinksInPath().standardizedFileURL
        let r = root.path.hasSuffix("/") ? String(root.path.dropLast()) : root.path
        if real.path == r || real.path.hasPrefix(r + "/") { return real }
        return nil
    }

    /// Dock badge text: "" clears; strings lose control characters, are trimmed and cut to 12 characters.
    static func badge(_ v: Any?) -> String? {
        guard let v = v, !(v is NSNull) else { return "" }
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? nil : "" }
            let d = n.doubleValue
            if !d.isFinite || d <= 0 { return "" }
            return d > 99999 ? "99999+" : String(Int(d.rounded(.down)))
        }
        guard let s = v as? String else { return nil }
        var kept = String.UnicodeScalarView()
        for u in s.unicodeScalars where !(u.value <= 0x1f || (0x7f...0x9f).contains(u.value)) { kept.append(u) }
        let cleaned = String(kept).trimmingCharacters(in: .whitespacesAndNewlines)
        var out = String.UnicodeScalarView()
        for u in cleaned.unicodeScalars.prefix(12) { out.append(u) }
        return String(out)
    }
}

// MARK: - JSON helpers

func jsonString(_ v: Any) -> String {
    guard JSONSerialization.isValidJSONObject([v]), let d = try? JSONSerialization.data(withJSONObject: [v], options: []) else { return "null" }
    let s = String(decoding: d, as: UTF8.self)
    return String(s.dropFirst().dropLast())
}

func readPackageVersion(_ appRoot: URL) -> String {
    guard let d = try? Data(contentsOf: appRoot.appendingPathComponent("package.json")),
          let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let v = o["version"] as? String else { return "0.0.0" }
    return v
}
