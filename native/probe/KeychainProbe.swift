// Fact-finding probe (CI only): how does the login Keychain treat an ad-hoc-signed binary?
//   KeychainProbe create|attrs|read|read-noui|create-dp|delete
import Foundation
import Security

let service = "local.harness.probe"
let account = "data-key"
let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "read"
let variant = "VARIANT_A"

func out(_ s: String) { print("keychain-probe \(variant) \(mode): \(s)") }
func errText(_ s: OSStatus) -> String { (SecCopyErrorMessageString(s, nil) as String?) ?? "?" }

var base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch mode {
case "create", "create-dp":
    var key = Data(count: 32)
    let r = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    var q = base
    q[kSecAttrLabel as String] = "Harness probe key"
    q[kSecValueData as String] = key.base64EncodedData()
    if mode == "create-dp" { q[kSecUseDataProtectionKeychain as String] = true; q[kSecAttrService as String] = service + ".dp" }
    let s = SecItemAdd(q as CFDictionary, nil)
    out("random=\(r) SecItemAdd=\(s) \(errText(s))")
case "attrs":
    SecKeychainSetUserInteractionAllowed(false)
    var q = base
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var res: CFTypeRef?
    let s = SecItemCopyMatching(q as CFDictionary, &res)
    let label = (res as? [String: Any])?[kSecAttrLabel as String] as? String ?? "-"
    out("SecItemCopyMatching(attrs)=\(s) \(errText(s)) label=\(label)")
case "read", "read-noui":
    if mode == "read-noui" { SecKeychainSetUserInteractionAllowed(false) }
    var q = base
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var res: CFTypeRef?
    let t = Date()
    let s = SecItemCopyMatching(q as CFDictionary, &res)
    let len = (res as? Data).flatMap { Data(base64Encoded: $0) }?.count ?? -1
    out("SecItemCopyMatching(data)=\(s) \(errText(s)) keyBytes=\(len) ms=\(Int(Date().timeIntervalSince(t) * 1000))")
case "delete":
    let s = SecItemDelete(base as CFDictionary)
    out("SecItemDelete=\(s) \(errText(s))")
default:
    out("unknown mode")
}
