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
  label `Harness data key`, value = base64 of 32 bytes) with the Security framework and sends it as `hello.dataKey`
  at every later start. The account is scoped to the data folder exactly as the backend names it: `data-key` for the
  default folder (`~/Library/Application Support/Harness`, what a real user has), `data-key-<first 16 hex digits of
  SHA-256 of the folder's real path>` for any other folder (the real path as `realpath(3)` gives it, e.g.
  `/private/var/…`), so a test or a second installation never touches the user's item. In bridge mode the backend
  decides and the app executes: when the user leaves keychain mode the backend sends `keychain-key` with `null` only
  if the item holds this data's key (the key the app sent in `hello` or received in this session), and the app then
  deletes it; an item with a key that does not open this data is left alone. The key is never written to disk, logs,
  argv or the environment by the app.
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
| resident memory (RSS), idle | **240 MB** (app 90, node 74, WebContent 56, Networking 20) | 417 MB (main 170, helpers 89 + 52, renderer 106) |
| physical footprint, idle | **92 MB** (app 22, node 31, WebContent 34, Networking 5) | 106 MB (main 50, helpers 20 + 8, renderer 28) |

Both measured 15–20 s after start on a fresh data folder, at the UI's first-run password screen, with
`ps -o rss` and macOS's `footprint` (`native/test/run-selftest.mjs`, `native/ci/electron-memory.mjs`); Ollama is the
same in both and not included. RSS counts shared system-framework pages once per process, so the footprint is the
better measure of what the app costs the Mac: the native app saves about 14 MB of footprint and ~180 MB of RSS at
idle, ~190 MB of disk, and Chromium entirely. Most of the remaining cost is the backend (the same Node.js process in
every mode) and the web content; the chat model (~4 GB) dwarfs both. After a few chats the backend grows (165 MB
footprint was measured mid-test with a model loaded), as it does in every mode.

## Verified on the runner

GitHub's Apple Silicon runner (macOS 26.7.2, "Apple M1 (Virtual)", 3 cores, 7 GB), the `native` job of
`.github/workflows/macos.yml`, which builds the app with the Command Line Tools only and then drives **the built
`Harness.app`** in self-test mode (`native/test/run-selftest.mjs` + `native/test/selftest-*.js` running inside the
real page, `native/Sources/SelfTest.swift` on the native side).

* **Build**: `scripts/build-native.sh` with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` (Swift 6.3.3): ~50 s,
  2 compiler warnings; Node.js 24.22.2 downloaded and SHA-256-verified; `codesign --verify --deep --strict` passes
  (app ad hoc + hardened runtime, `node` keeps the Node.js project's Developer ID signature).
* **Transport, against the mock backend** (`native/test/mock-backend.mjs`, 34 checks, two launches on one data folder):
  UI from `harness://app/` (a secure context); the page contract (classes, frozen `harnessDesktop`, `TypeError` on a
  bad callback, classes re-added after `className` is overwritten); JSON round trip; a streamed reply arriving in 6
  pieces at 0/294/595/896/1199/1499 ms; 5 MB `ArrayBuffer`, 5 MB `Blob` and 50 MB `File` uploads intact (byte pattern
  checked by the backend; 50 MB in ~0.4 s); a 20 MB file chosen through the open panel and uploaded intact; an image
  shown; an aborted `fetch` reaching the backend as `CANCEL`; all 15 accelerators and the Dock menu; every menu action
  reaching the page; ⌘N/⌘K/⌃⌘S handled by the menu before the page sees the key; links and `target=_blank` to http(s)
  going to the browser hook while the page stays, `file:`/`javascript:`/`data:` refused; remote image, fetch and
  WebSocket blocked; `showInFolder` and `setBadge` validation; the `desktop-fullscreen` class; hide on close and Dock
  reopen; ⌘⇧Space registered and the toggle; a click in the title-bar zone reaching the page; secure event input on a
  focused password field; a `Content-Disposition` download and a `blob:` download saved; sleep, screen lock and Lock
  Harness each sending `lock`, with the menu item disabled, the badge cleared and 423 answers while locked;
  `restart-required` → new backend process, page reloaded on the same `#/chat/…` route; a `keychain-key` stored and
  read again **by the next launch** and sent in `hello` (the backend saw the same key); `keychain-key: null` deleting
  it; the window frame restored at the next launch; a clean quit both times, no process left behind. Neither the app
  nor the backend held any socket (`lsof`: no TCP, no UDP, no Unix socket).
* **Against the real backend** (`node server/index.mjs --bridge`, password mode, fresh data folder, real Ollama with
  `qwen3:0.6b`, three launches; 20 checks + 3 clean quits, run against the final 0.2 backend): `ready.locked`, every data route 423 until setup; setup
  with a throw-away password (never printed), recovery key returned; a real chat streaming through the bridge (13
  pieces over 16 s); App Nap held during the stream and released after it and after Stop; a PNG uploaded as a `File` and shown from
  `harness://app/api/attachments/…/content`; a chat export saved through the bridge; **the chat's marker string not
  found in any file of the data folder**; with internet blocked `GET /api/network` reports `osEnforced: true,
  osScope: "ollama"`, a pull through Harness is refused (403 `offline_lock`) and a pull sent straight to the sandboxed
  Ollama fails (`lookup registry.ollama.ai: no such host`); "allow" restarts Ollama without the sandbox and the same
  pull succeeds, "block" puts it back in the sandbox and the pull fails again — without a backend restart; `lock`
  makes every route 423 and Ollama holds no model; a wrong password → 401 `wrong_password`; unlock → the chat is still
  there and answers again; sleep and screen lock lock it; keychain mode → the next launch opens without the password
  (`ready.locked: false`) with the same Keychain item (account `data-key-<16 hex>` for this non-default folder);
  leaving keychain mode deletes the item; a valid but wrong key in the Keychain → `fatal: wrong_key` → the app starts
  the backend again without the key → locked → the password opens it, and leaving keychain mode then leaves that
  foreign item alone. On the **default** data folder (a separate step, run first on the fresh runner): the account is
  `data-key`, the next launch opens from the Keychain, leaving keychain mode deletes the item. No listening socket in the app or the backend at any point; the backend's only TCP socket is its client
  connection to Ollama on 127.0.0.1:11434, and only Ollama listens (on 127.0.0.1).
* **Offline-lock profile**: see `docs/BRIDGE.md` ("Offline lock") for the measured blocks and their limit. The
  backend's own `POST /api/network/test` under the lock reported the code layer blocking huggingface.co,
  ollama.com and registry.ollama.ai before any name lookup and the OS layer refusing a direct TCP connection to
  1.1.1.1:443 with `EPERM`.
* The last full run: workflow run 43829649835 (commit 3ce3e9e, the final code): mock 34/34, real backend 23/23,
  default-folder Keychain 5/5, idle 2/2 — "RESULT: all checks passed". The job fails when a check fails: run
  43828511347 (commit 587d9cf, before the backend's Keychain fix) ended with "RESULT: FAILED" and the two failing
  checks printed last.

## Not verified

* **Nobody has looked at the window with their eyes.** Everything above was checked by the self-test in a GUI session
  on the runner, not by a person: the title-bar look and traffic-light spacing, the icon in Finder and the Dock, the
  absence of a white flash, the context menu, the Save/Open panels (the self-test bypasses them), dark mode.
* Dragging the window by the UI's title bar (the page → app path is in place; a synthetic click cannot start a real
  drag), and double-click to zoom.
* The real Keychain prompt after a rebuild (only its cause was measured, by reading without UI) and what "Always
  Allow" does next.
* That App Nap is actually prevented (the activity assertion is taken and released at the right times; its effect
  is not measured). Real sleep and real screen locking (the self-test posts the same notifications).
* The global shortcut pressed on a real keyboard (registration and the toggle are tested separately).
* File drag-and-drop and pasting a file into the page (WebKit's own behaviour; not driven).
* Gatekeeper with a downloaded copy (an ad-hoc app copied from another Mac is quarantined, see `docs/DESKTOP.md`).
* `data_dir_locked` and the start-up error dialogs (only their self-test path), and `restart-required` from the real
  backend (it is rare now; the same code path was exercised with the mock).
* A physical M1 with 8 GB: real speeds and memory pressure.

## What real WKWebView, Keychain and sandbox behaviour turned out to be

Found with the probes in `native/probe/` on macOS 26.7.2 before the app was built on them:

| expected / feared | measured | what the app does |
|---|---|---|
| POST bodies may be missing for custom schemes | strings, `ArrayBuffer`, typed arrays (50 MB) arrive in `httpBody`; **`Blob`/`File` bodies arrive as nothing** (no body, no stream) | page-script `fetch` shim sends Blob/File bytes; UI asked to send `ArrayBuffer` |
| streaming may be buffered | `didReceive(data)` chunks reach `fetch` readers and `EventSource` as they are sent | nothing special |
| custom scheme may not be a secure context | `isSecureContext`, `crypto.subtle`, `randomUUID`, `navigator.clipboard` all available; the UI's CSP `'self'` matches `harness://app` | nothing special |
| cancel may not reach the handler | an aborted `fetch` calls `webView(_:stop:)` within ~100 ms | sends `CANCEL` |
| WebKit downloads would work | `WKDownload` fails with "unsupported URL" for custom schemes (`blob:` works) | own bridge download + Save panel |
| — | `statusText` is wrong for custom-scheme responses (423 → "Bad Request") | UI told not to rely on it |
| — | content-rule regexes reject disjunctions (`^(data\|blob):`) | one rule per scheme |
| title-bar area might swallow clicks | clicks at y = 12 px reach the page under the transparent title bar | drag only on the UI's title-bar elements |
| key equivalents go to the menu | the page sees ⌘K first, the menu fires only if the page does not take it | the web view offers key equivalents to the menu first |
| the first `fetch` of a GET stream URL that the previous page also streamed stalled once per navigation | the second identical request and `EventSource` work | nothing needed by the UI (its only GET stream is `EventSource`) |
| — | `NSApp.terminate` called inside a main-queue block waits for the backend in a nested run loop that cannot run main-queue blocks — a hang | quitting from GCD goes through a run-loop perform |
| Keychain in CI might need a UI | the login Keychain works non-interactively; same build reads silently; **a rebuilt build cannot** (needs the prompt), an explicit designated requirement does not change that; data-protection Keychain refused | documented; `--sign` for a stable identity |
| draft sandbox profile blocks the network | it blocked only DNS; TCP/UDP to the internet went through | profile rewritten and re-measured (BRIDGE.md) |

## Self-test and CI

* `node native/test/bridge-client.mjs <backend script> <data dir>` checks any bridge backend without the app (also on
  Linux).
* `node native/test/run-selftest.mjs --app dist/native/Harness.app --label mock --script native/test/selftest-mock.js
  --backend native/test/mock-backend.mjs --launches 2 --files <file>` and `--label real --script
  native/test/selftest-real.js --launches 3` (needs Ollama with `qwen3:0.6b`) run the self-tests on a Mac; each prints
  `selftest| …` lines. The self-test mode is inert unless the app is started with `--self-test <dir>`; the
  `--backend` override is honoured only then.
* In CI the job's last step (`native/ci/summary.mjs`) prints the key facts and then every failing check with its
  details, and fails the job when any check failed or a self-test did not finish. `--data default` (the real default
  folder, wiped before and after) is accepted only with `CI=true` and `--allow-default-data`.
* `native/ci/sandbox-ollama.mjs`, `native/ci/sb-variants.mjs`, `native/ci/net-probe.mjs` prove the offline-lock
  profile; `native/ci/electron-memory.mjs` measures the Electron build; `native/probe/` holds the first fact-finding
  probes (scheme handler, Keychain) and the draft profile they were compared with.
