# Harness for Mac — the native app

A small AppKit + WKWebView app (Swift, no Electron, no Chromium) that runs Harness **without a localhost server**.
The backend runs as a child process in bridge mode (`node server/index.mjs --bridge`, `docs/BRIDGE.md`) and the two
talk over the child's stdin/stdout. The UI is the same web UI (`public/`), loaded from `harness://app/…`; every request
the page makes goes through a custom URL-scheme handler that turns it into bridge frames. **Neither the app nor the
backend opens a TCP port or a Unix socket.** Node.js is bundled, so nothing else needs to be installed for the app
itself (Ollama is still needed for chat, as before).

## Build and install

On an Apple Silicon Mac with the Xcode Command Line Tools (`xcode-select --install`; Xcode itself is not needed):

```bash
scripts/build-native.sh --install
```

That compiles the app with `swiftc` (no Xcode project, no Swift package), downloads the pinned official Node.js
24.22.2 arm64 runtime once (cached in `~/Library/Caches/Harness-build`, SHA-256 checked), assembles and ad-hoc
signs `dist/native/Harness.app`, zips it to `dist/native/Harness-<version>-arm64.zip`, and — with `--install` —
replaces `/Applications/Harness.app` (quit Harness first). Without `--install`, open `dist/native/Harness.app` or copy
it yourself (`rm -rf /Applications/Harness.app && ditto dist/native/Harness.app /Applications/Harness.app`).

| option | |
|---|---|
| `--system-node` | do not bundle Node.js; use the `node` on `PATH` at build time (recorded in Info.plist), then `/opt/homebrew/bin/node` |
| `--sign <identity>` | sign with a real code-signing identity instead of ad hoc (keeps the Keychain from asking again after a rebuild, see below) |
| `--no-zip` | skip the zip |

The real requirement turned out to be exactly the Command Line Tools: on the runner the build runs with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` (Swift 6.3.3, macOS 26 SDK), and the result is the bundle below.

## What is in the bundle

```
Harness.app/Contents/
  MacOS/Harness            the Swift app (AppKit, WebKit, Security, Carbon)
  MacOS/node               official Node.js arm64 binary, with the Node.js project's own signature
  Resources/app/           package.json, server/, public/ (tests removed)
  Resources/Harness.icns   build/icon.icns
  Resources/node-LICENSE.txt
```

Source: `native/Sources/*.swift` (`App.swift` lifecycle, backend, locks, App Nap; `Bridge.swift` frames and the child
process; `Scheme.swift` the `harness://` handler and downloads; `Window.swift` the window, navigation policy, panels;
`PageScript.swift` the page contract; `Menus.swift`; `Keychain.swift`; `HotKey.swift`; `Support.swift` paths and
config files; `SelfTest.swift`), `native/Info.plist`, `scripts/build-native.sh`. Tests and CI helpers:
`native/test/` (mock backend, bridge client, self-test scripts and driver), `native/ci/`, `native/probe/` (the
fact-finding probes whose results are recorded below).

## How it works

```
Harness.app (Swift)  ──stdin: frames──▶  node server/index.mjs --bridge   (backend, child process)
   │  ▲             ◀─stdout: frames──       └─ ollama serve  (started by the backend; under sandbox-exec
   │  │  stderr → <data>/logs/harness.log                       while internet access is blocked)
   ▼  │
WKWebView  harness://app/… ──WKURLSchemeHandler──▶ bridge request (REQ_HEAD/REQ_BODY/REQ_END, CANCEL)
```

* **Start-up.** The app reads `<data>/desktop.json` and `<data>/launch.json`, starts the backend with a sanitised
  environment (never the key), sends `hello` and waits for `ready`. In password mode (`launch.json` `encryption:
  "password"`, the default) `hello.dataKey` is `null` and the UI shows its lock screen; in keychain mode the app first
  reads the data key from the login Keychain (off the main thread, because that may show the system prompt) and
  sends it. `progress` events are shown in the window while a migration runs; no word from the backend for 60 s is a
  start-up error. The window is shown when the page has painted (or after 3 s), over a background of `#fafafa` /
  `#1c1c1e` with the web view's own background switched off, so there is no white flash.
* **Requests.** `harness://app/<path>` becomes a bridge request for `/<path>` with the method, the lower-cased
  headers and the body (sent in ≤ 1 MiB frames); the response head, every body chunk as it arrives, and the end are
  handed to WebKit as they come, so server-sent events stream. When WebKit stops a load (an aborted `fetch`, a
  navigation away) the app sends `CANCEL`, which the backend treats as a client disconnect. While the backend
  restarts, new requests wait and are sent to the new process.
* **`restart-required`.** The app stops the backend (`shutdown`, then end of stdin, then SIGTERM/SIGKILL after 10 s),
  re-reads `launch.json`, starts it again and reloads the page on the same URL, so the UI's hash route brings the
  user back to the same chat. An unexpected exit after a healthy run is restarted once the same way.
* **Fatal events.** `wrong_key` in keychain mode → start again without the key, so the password opens the data (the
  Keychain item is left alone; switching to keychain mode again replaces it). `data_dir_locked` → a dialog naming the
  other Harness. Anything else → a dialog with the message, the data folder and the log file (Quit / Show Log File).
* **`keychain-key`.** A key → stored as the Keychain item (added or updated); `null` → the item is deleted.
* **Quit** (⌘Q, Dock, SIGINT/SIGTERM): `shutdown`, wait for the backend to exit (≤ 10 s, then it is terminated), then
  the app exits. The backend stops the Ollama it started.

## Contract with the web UI

Exactly the one in `docs/DESKTOP.md` ("Contract with the web UI"), injected at document start into the main frame:

* `<html>` classes `desktop`, `desktop-mac`, `desktop-fullscreen` (re-added if the page overwrites `className`), plus
  `desktop-native` so the UI can tell the native app from the Electron shell if it ever needs to.
* `window.harnessDesktop = { platform: 'darwin', appVersion, onMenuAction(cb), openExternal(url), showInFolder(path),
  setBadge(text) }`, frozen, with the same argument checks in the page and again in the app (`openExternal`: http/https
  with a host only; `showInFolder`: must exist and resolve, symlinks included, inside the data folder; `setBadge`:
  ≤ 12 characters, control characters removed, numbers floored, `''`/`0` clears — and nothing but clearing while locked).
  Calls are accepted only from the app's own page (`harness://app`, main frame, the app's web view).
* **15 menu actions**: the 14 of DESKTOP.md plus `lock` (Harness → Lock Harness, ⌃⌘L — ⌃⌘Q is the system's Lock
  Screen), which also sends the bridge `lock` control message. Same accelerators; menu key equivalents are handled
  before the page sees the key (as in Electron). Standard Harness/File/Edit/View/Window/Help menus (About, Services,
  Hide, Quit; Undo/Redo/Cut/Copy/Paste/Paste and Match Style/Delete/Select All, Spelling, Speech; Reload, Actual
  Size/Zoom In (⌘+ and ⌘=)/Zoom Out, Enter Full Screen ⌃⌘F; Minimize/Zoom/Bring All to Front; Help with the menu
  search), "Show Data Folder in Finder" and "Show Log File". Dock menu: New Chat, Lock Harness. There are no Developer
  Tools in the native app.
* **Title bar.** Hidden-inset style (transparent title bar, full-size content, an empty compact toolbar that moves the
  traffic lights in), so the UI's 80×40 px reserve applies. WebKit has no `-webkit-app-region`: the page script asks
  the app to drag the window when a press starts inside `.titlebar` or `[data-app-region="drag"]` and not on
  `button, input, select, textarea, a, label, [role=button], [contenteditable], .no-drag, [data-app-region="no-drag"]`;
  a double click there zooms or minimises as System Settings says. Clicks in the title-bar zone reach the page
  (verified), so buttons there work.
* **Uploads.** WKWebView drops `Blob`/`File` request bodies for custom schemes (verified), so the page script wraps
  `fetch` to send a Blob/File body as its bytes (with its type as `content-type` if none was set). Strings,
  `ArrayBuffer` and typed arrays pass through untouched.
* **Downloads.** `<a download>` links to Harness's own files, `target=_blank` links to them (an attachment, an image)
  and responses marked `Content-Disposition: attachment` are fetched through the bridge and saved where the user
  picks in a Save panel (the response's file name, else the `download` attribute, else the URL's last part).
  `blob:`/`data:` downloads go through WebKit's own download with the same Save panel. WebKit's downloader cannot fetch
  custom-scheme URLs ("unsupported URL", verified), which is why the app does those itself.
* **File pickers, drag and drop, paste**: WebKit's own, with an `NSOpenPanel` for `<input type=file>`.
* **Theme**: `settings.ui.theme` (`light`/`dark`/other) sets the app's appearance once unlocked, so the page's
  `prefers-color-scheme` and the native parts match.

## Nothing from the web

* **Navigation policy**: the web view only ever shows `harness://app/…`. A link or `window.open` to http(s) opens the
  default browser (validated as above); every other scheme is refused and logged. No child windows are ever created.
* **Content rules** (`WKContentRuleList`): every load that is not `harness://app/…`, `data:` or `blob:` is blocked —
  remote images, fetches, WebSockets, fonts. The UI's own CSP blocks the same independently.
* **No website data on disk**: the web view uses a non-persistent data store. `localStorage` works but lives in
  memory only and is gone after quitting; anything that must survive belongs in `/api/ui-state` (encrypted by the
  backend). Safe Browsing lookups are off.
* **Permissions**: camera/microphone requests are denied; element full screen is allowed.
* **Passwords**: a focused `<input type=password>` turns on macOS secure event input (verified), so other apps cannot
  read the keystrokes; the app never logs request bodies, and the self-test never prints its throw-away password.

## Password, Keychain and locking

* **Password mode (default).** The app sends `dataKey: null` and creates nothing in the Keychain; the UI's lock
  screen talks to the backend's unlock route through the bridge. The password never leaves the two processes.
* **Keychain mode (opt-in, `launch.json` `"encryption": "keychain"`).** When the user switches to it, the backend sends
  `keychain-key`; the app stores the value as a generic password in the login Keychain (service `local.harness`,
  account `data-key`, label `Harness data key`, value = base64 of 32 bytes) with the Security framework and sends it as
  `hello.dataKey` at every later start. Leaving keychain mode (`keychain-key` with `null`) deletes the item. The key is
  never written to disk, logs, argv or the environment by the app.
* **What macOS does with an ad-hoc-signed app** (measured on the runner, `native/probe/KeychainProbe.swift`): the item's
  access list names the exact build that created it. The same build reads it silently; **a rebuilt app (new ad-hoc
  signature) cannot read it without the system prompt** ("Harness wants to use your confidential information stored
  in 'Harness data key' in your keychain", with the login password, Allow / Always Allow / Deny). Giving the ad-hoc
  signature an explicit designated requirement (`identifier "local.harness.app"`) does **not** help — the access list
  still checks the build. `/usr/bin/security find-generic-password` (what the backend's listener mode uses) also blocks
  on that prompt for an item the app created, and the app would be prompted for an item `security` created. The
  data-protection Keychain is not available to an ad-hoc app (`errSecMissingEntitlement`). So after every rebuild in
  keychain mode the user sees that prompt once ("Always Allow" ends it); signing with a stable identity
  (`--sign "<identity>"`, e.g. a self-made code-signing certificate from Keychain Access → Certificate Assistant)
  avoids it. If the user clicks Deny (or the item is missing), the app simply starts without the key and the lock
  screen asks for the password — nothing is created or overwritten. `wrong_key` is handled the same way.
* **Locking.** The app sends `{"op":"lock"}` when the Mac is about to sleep, when the screen is locked
  (`com.apple.screenIsLocked`) and from Harness → Lock Harness (⌃⌘L, also in the Dock menu). Idle locking is the
  backend's own (`settings.security.idleLockMinutes`). On `locked` the app disables Lock Harness, clears the Dock badge,
  stops holding off App Nap and closes its own event stream; on `unlocked` it reopens it. While locked the window,
  hide-on-close and the global shortcut keep working and the UI shows its lock screen.

## Offline lock (the OS sandbox around Ollama)

The backend itself is not sandboxed (that would make "allow internet for 15 minutes" restart the backend and lock the
data). The backend runs the `ollama serve` it starts under `/usr/bin/sandbox-exec -f server/security/offline-lock.sb`
while internet access is blocked, and restarts only Ollama when the user allows or blocks access. If `sandbox-exec`
is missing or Ollama misbehaves under it, it silently runs Ollama without it and reports `osEnforced: false`; the
backend's own code still refuses every non-local destination. The app only handles `restart-required` (rare now).

`server/security/offline-lock.sb` is owned here; the first draft let TCP and UDP to the internet through on
macOS 26 (`(allow network* (local ip "localhost:*"))` matches the machine's own addresses), and DNS went out through
mDNSResponder. The shipped profile, its measured behaviour and its limit are below ("Verified on the runner").

## Files

| file | |
|---|---|
| `<data>/desktop.json` | shared with the Electron shell: `globalShortcut` (Electron accelerator syntax, `null`/`""` off; default ⌘⇧Space), `hideOnClose` (default `true`); `port` is ignored (no port). `HARNESS_GLOBAL_SHORTCUT` overrides |
| `<data>/launch.json` | written by the backend; the app reads `encryption` |
| `<data>/native/window-state.json` | window frame, clamped to the screens that exist at launch |
| `<data>/native/app.lock` | one native Harness per data folder (a second launch activates the first) |
| `<data>/logs/harness.log` | the app's lines (`[native …]`) and the backend's stderr; rotated at 5 MB |

The data folder is `~/Library/Application Support/Harness` like every other launcher; `HARNESS_DATA_DIR` or
`--data-dir <dir>` overrides it.

## Window and lifecycle

Closing the window hides it (leaving full screen first) and Harness keeps running; the Dock icon or the global
shortcut brings it back; ⌘Q quits. With `"hideOnClose": false` the window and its web content process are released
on close (saves the WebContent process's memory) and recreated on reopen. The global shortcut uses Carbon's
`RegisterEventHotKey` (no Accessibility permission); if another app owns it, a line is logged. App Nap is held off
(`ProcessInfo.beginActivity(.userInitiatedAllowingIdleSystemSleep)`) only between the backend's `generation.started` /
`generation.finished` and image-job events on the app's own `GET /api/events` stream, and released on lock, on a lost
stream and when the backend stops. If the web content process dies, a dialog offers to reload. A second launch for
the same data folder brings the first window forward.

## Size and memory (measured on the runner, next to the Electron build)

| | native (`scripts/build-native.sh`) | Electron (`npm run dist:app`) |
|---|---|---|
| `Harness.app` on disk | **120 MB** (Node.js 117 MB, app binary 0.7 MB, `server/`+`public/` 2 MB) | 309 MB |
| download | 39 MB zip | 129 MB dmg |
| processes at idle | app, `node` backend, WebKit WebContent, WebKit Networking | main (with the backend in it), renderer, GPU and network helpers |
| resident memory (RSS), idle | **239 MB** (app 89, node 74, WebContent 56, Networking 20) | 418 MB (main 169, helpers 91 + 52, renderer 106) |
| physical footprint, idle | **93 MB** (app 21, node 31, WebContent 36, Networking 5) | 107 MB (main 50, helpers 20 + 8, renderer 29) |

Both measured 15–20 s after start on a fresh data folder, at the UI's first-run password screen, with
`ps -o rss` and macOS's `footprint` (`native/test/run-selftest.mjs`, `native/ci/electron-memory.mjs`); Ollama is the
same in both and not included. RSS counts shared system-framework pages once per process, so the footprint is the
better measure of what the app costs the Mac: the native app saves about 15 MB of footprint and ~180 MB of RSS at
idle, ~190 MB of disk, and Chromium entirely. Most of the remaining cost is the backend (the same Node.js process in
every mode) and the web content; the chat model (~4 GB) dwarfs both. After a few chats the backend grows (165 MB
footprint was measured mid-test with a model loaded), as it does in every mode.
