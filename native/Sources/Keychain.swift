// The Keychain wrap of the data key (keychain mode only; docs/API.md 10.1): a generic password in the login
// Keychain, service "local.harness", account "data-key", label "Harness data key", value = base64 of 32 bytes.
// The value only ever travels to the backend in the bridge `hello` frame: never to disk, logs, argv or env.
import CryptoKit
import Foundation
import Security

enum DataKeyStore {
    static let service = "local.harness"
    static let label = "Harness data key"
    /// Set once at start-up from the data folder (accountFor). Items are scoped to their data folder, exactly as the
    /// backend names them (server/security/keychain.mjs keychainAccountFor, docs/BRIDGE.md `keychain-key`).
    static var account = "data-key"

    /// `data-key` for the default data folder (~/Library/Application Support/Harness, what the real user has),
    /// `data-key-<first 16 hex digits of SHA-256 of the folder's real path>` for any other folder, so a test or a
    /// second installation can never read, replace or delete the real user's item.
    static func accountFor(dataDir: URL) -> String {
        let real = realPath(dataDir.path)
        if real == realPath(defaultDataDir()) { return "data-key" }
        let hex = SHA256.hash(data: Data(real.utf8)).map { String(format: "%02x", $0) }.joined()
        return "data-key-" + String(hex.prefix(16))
    }

    /// The default data folder the way the backend computes it (os.homedir() reads $HOME first).
    static func defaultDataDir() -> String {
        let home = ProcessInfo.processInfo.environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        return (home as NSString).appendingPathComponent("Library/Application Support/Harness")
    }

    /// realpath(3), like Node's fs.realpathSync: /var/folders/… → /private/var/folders/… (Foundation's
    /// resolvingSymlinksInPath strips /private instead, which would give a different account name).
    static func realPath(_ p: String) -> String {
        guard let r = realpath(p, nil) else { return (p as NSString).standardizingPath }
        defer { free(r) }
        return String(cString: r)
    }

    enum ReadResult {
        case found(String)
        case notFound
        /// The user denied access, cancelled the prompt, or the item's access list does not name this build.
        case denied(OSStatus)
        case failed(OSStatus)
    }

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// Does the item exist? Reads attributes only, which never shows a prompt.
    static func exists() -> Bool {
        var q = base
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess
    }

    /// Read the key. May show the system's Keychain prompt (e.g. after Harness was rebuilt with a new ad-hoc
    /// signature), so call it off the main thread.
    static func read() -> ReadResult {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let s = SecItemCopyMatching(q as CFDictionary, &out)
        switch s {
        case errSecSuccess:
            guard let d = out as? Data, let text = String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  valid(text) else { return .failed(errSecDecode) }
            return .found(text)
        case errSecItemNotFound:
            return .notFound
        case errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed, errSecNoAccessForItem:
            return .denied(s)
        default:
            return .failed(s)
        }
    }

    /// Store (or replace) the key sent by the backend's `keychain-key` event.
    static func store(_ base64: String) -> OSStatus {
        guard valid(base64) else { return errSecParam }
        let value = Data(base64.utf8)
        var add = base
        add[kSecAttrLabel as String] = label
        add[kSecValueData as String] = value
        var s = SecItemAdd(add as CFDictionary, nil)
        if s == errSecDuplicateItem {
            s = SecItemUpdate(base as CFDictionary, [kSecValueData as String: value, kSecAttrLabel as String: label] as CFDictionary)
        }
        return s
    }

    static func delete() -> OSStatus {
        let s = SecItemDelete(base as CFDictionary)
        return s == errSecItemNotFound ? errSecSuccess : s
    }

    static func valid(_ base64: String) -> Bool {
        guard let d = Data(base64Encoded: base64) else { return false }
        return d.count == 32
    }

    /// For the self-test only: a short fingerprint that proves "same key" without revealing it.
    static func fingerprint(_ base64: String) -> String {
        let digest = SHA256.hash(data: Data(base64.utf8))
        return digest.prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    static func message(_ s: OSStatus) -> String {
        (SecCopyErrorMessageString(s, nil) as String?) ?? "OSStatus \(s)"
    }
}
