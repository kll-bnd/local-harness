// Harness, the native macOS app (AppKit + WKWebView). See docs/NATIVE.md.
import AppKit

let launchOptions = LaunchOptions.parse(CommandLine.arguments)
let application = NSApplication.shared
let controller = AppController(options: launchOptions)
application.delegate = controller
application.setActivationPolicy(.regular)
application.run()
