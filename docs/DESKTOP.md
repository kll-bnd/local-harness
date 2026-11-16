# Harness desktop shell (macOS)

The desktop app is a thin Electron shell around the same zero-dependency backend that `npm start`
runs. It starts the backend **in-process** (`startServer()` from `server/index.mjs`), shows its URL in
one locked-down window, adds the native macOS bits (menu bar, Dock, title bar, global shortcut) and
stops the backend cleanly on quit. The UI is the web UI in `public/`, unchanged.

```
electron/
  main.cjs            wiring only (Electron APIs); all decisions live in lib/
  preload.cjs         sandboxed preload: <html> classes + window.harnessDesktop
  lib/paths.cjs       data-dir resolution (mirrors server/app.mjs defaultDataDir)
  lib/config.cjs      menu action list, defaults, <data>/desktop.json
  lib/security.cjs    URL/navigation/permission/IPC-argument validation
  lib/menu.cjs        application, Dock and context menu templates
  lib/window-state.cjs  window size/position persistence
  lib/activity.cjs    App Nap guard
  lib/instance.cjs    "is Harness already running for this data dir?"
  lib/logfile.cjs     console → <data>/logs/harness.log
  test/               unit tests (npm test) and the end-to-end smoke test (npm run test:e2e)
build/                icon.svg (source), icon.icns, icon.png (generated: npm run icons)
scripts/              setup-macos.sh, doctor.mjs, launch.mjs (Harness.command), make-icons.mjs
```

Electron and electron-builder are **devDependencies**. The backend has no runtime dependencies, so
`npm start` keeps working without `npm install`.

## Running

| | |
|---|---|
| `npm run app` | run the desktop app from the source tree (needs `npm install`) |
| `npm run dist` | build `dist/mac-arm64/Harness.app` and `dist/Harness-<version>-arm64.dmg` (on an Apple Silicon Mac) |
| `npm run dist:app` | build only the `.app` (skips the DMG step) |
| `npm run test:e2e` | launch the real app against a throw-away data dir and smoke-test it |

Environment overrides: `HARNESS_DATA_DIR`, `HARNESS_PORT`, `HARNESS_GLOBAL_SHORTCUT` (`""` disables),
plus everything the backend reads (`docs/API.md` §1).

**`<data dir>/desktop.json`** (created with defaults on first launch):

```json
{ "globalShortcut": "CommandOrControl+Shift+Space", "port": 4747, "hideOnClose": true }
```

`globalShortcut` uses [Electron accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator); `null` or `""` turns it off.
⌘⇧Space was chosen because it is not a macOS system shortcut (Spotlight ⌘Space, Finder search ⌥⌘Space,
input sources ⌃Space/⌃⌥Space, Character Viewer ⌃⌘Space) and types no character. If another app already
owns it, registration fails, a line is logged and the app carries on. Restart Harness after editing the file.

## One data directory

The app uses exactly the backend's default data dir, `~/Library/Application Support/Harness`
(`HARNESS_DATA_DIR` overrides it for every launcher). Electron's `userData` is set to that directory,
and Chromium's own storage (localStorage, caches) goes to its `Electron/` sub-folder. `lib/paths.cjs`
duplicates `defaultDataDir()` because Electron needs the path synchronously before `ready`; a unit test
keeps the two identical on macOS, Linux and Windows.

Never two writers: the app takes Electron's single-instance lock for the data dir (a second launch just
focuses the window), and before starting its own backend it probes ports 4747–4757 for a Harness that
serves **the same data dir** (e.g. started with `npm start` or `Harness.command`). If it finds one, the
window uses that server and leaves it running on quit. `Harness.command` does the same check in reverse.

## Contract with the web UI

### `<html>` classes (added by the preload before the page's scripts run, re-added if the page overwrites `className`)

| class | when |
|---|---|
| `desktop` | always inside the app |
| `desktop-mac` | on macOS |
| `desktop-fullscreen` | while the window is in macOS full-screen (traffic lights hidden) |

On macOS the window uses `titleBarStyle: 'hiddenInset'`: there is no title bar, the traffic lights sit at
the top-left, and the UI reserves ~80×40 px there (`html.desktop-mac:not(.desktop-fullscreen)`) and
provides its own `-webkit-app-region: drag` area.

### `window.harnessDesktop` (absent in a normal browser — feature-detect it)

| member | |
|---|---|
| `platform` | `process.platform` (`"darwin"` on a Mac) |
| `appVersion` | Harness version (`package.json`) |
| `onMenuAction(cb)` | `cb(action)` for each native menu command (table below). Returns an unsubscribe function. Actions sent before the first subscriber (e.g. Dock → New Chat at launch) are delivered on subscribe (if < 10 s old). Throws `TypeError` if `cb` is not a function |
| `openExternal(url)` | open an `http:`/`https:` URL in the default browser → `Promise<boolean>` (`false` = rejected) |
| `showInFolder(path)` | reveal a file/folder in Finder → `Promise<boolean>`. Absolute, or relative to the data dir; must exist and resolve (symlinks included) **inside the data dir** |
| `setBadge(text)` | Dock badge: string (≤ 12 chars, control characters removed) or positive number; `''`/`null`/`0` clears → `Promise<boolean>` |

The object is frozen; arguments are type-checked in the preload and validated again in the main
process, which also checks that the call comes from the app window on the server's origin.

### Menu actions

| action | menu | accelerator (macOS) |
|---|---|---|
| `new-chat` | File → New Chat (also Dock menu) | ⌘N |
| `import-chat` | File → Import Chat… | ⌘O |
| `export-chat` | File → Export Chat… | ⇧⌘E |
| `open-settings` | Harness → Settings… | ⌘, |
| `search-chats` | Edit → Search Chats… | ⌘F |
| `command-palette` | View → Command Palette… | ⌘K |
| `toggle-sidebar` | View → Toggle Sidebar | ⌃⌘S |
| `toggle-inspector` | View → Toggle Inspector | ⌥⌘I |
| `open-models` | View → Models | ⌘1 |
| `open-images` | View → Images | ⌘2 |
| `open-memory` | View → Memory | ⌘3 |
| `focus-composer` | Chat → Focus Message Box | ⌘L |
| `stop-generation` | Chat → Stop Generating | ⌘. |
| `show-shortcuts` | Help → Keyboard Shortcuts | ⌘/ |

Menu accelerators fire before the page sees the key, so the page should not also bind these keys
when `html.desktop` is set. Everything else is the standard role-based macOS menu: About, Services,
Hide/Hide Others/Show All, Quit; Undo/Redo/Cut/Copy/Paste/Paste and Match Style/Delete/Select All,
Speech; Reload, Actual Size/Zoom In (⌘+ and ⌘=)/Zoom Out, Enter Full Screen (⌃⌘F); Window
(Minimize, Zoom, Bring All to Front); Help (with macOS's menu search). Developer Tools are under
View with ⌥⌘J (⌥⌘I is the Inspector). File and Help also have "Show Data Folder in Finder" and
"Show Log File". On Linux (development only) Settings and Quit move into File and ⌃⇧S toggles the sidebar.

### What the page can and cannot do

* **Navigation** stays on the local server origin (`http://127.0.0.1:<port>`). Clicking an `http(s)`
  link that leaves it — or any `target=_blank` / `window.open` http(s) link, including server URLs such
  as an image file — opens the default browser. No child windows are ever created; other schemes
  (`file:`, `javascript:`, `data:`, custom) are refused. `<webview>` is disabled.
* **Network**: the window may only load from the local server. Requests to any other origin (remote
  images in model output, fonts, CDNs, other localhost ports) are cancelled and logged. All backends
  (Ollama, Draw Things, …) are reached through the Harness API.
* **Permissions** are denied except `clipboard-sanitized-write` (`navigator.clipboard.writeText`) and
  `fullscreen` (element full-screen). No camera, microphone, location, notifications, HID/USB/serial.
* **No Node.js** in the page: `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity` on.
* **Context menu**: Electron shows none by default, so the app provides a standard one (spelling
  suggestions, Look Up, Cut/Copy/Paste/Select All, Open/Copy Link, Copy Image). If the page handles
  `contextmenu` and calls `preventDefault()`, the native menu is not shown.
* **Theme**: `settings.ui.theme` (`light`/`dark`/anything else = system) is mirrored into
  `nativeTheme.themeSource`, so `prefers-color-scheme`, scrollbars, form controls and native menus match.
  The window background before the page paints is `#fafafa` (light) / `#1c1c1e` (dark) — keep the UI's
  `--bg` in line to avoid a flash.
* **Downloads** (`/api/chats/:id/export`, `/api/export`, image downloads) use Chromium's normal download
  handling (a Save dialog).

## Lifecycle and Mac niceties

* **Close vs quit** (macOS): closing the window hides it (leaving full-screen first); the app keeps
  running in the Dock and ⌘Q quits. Clicking the Dock icon or pressing the global shortcut brings the
  window back. `"hideOnClose": false` in `desktop.json` makes ⌘W close the window instead (the app
  still stays in the Dock, per macOS convention; on other platforms closing the window quits).
* **Window size/position** is saved to `<data>/Electron/window-state.json` and restored, clamped to the
  displays that exist now (a window from an unplugged monitor comes back to the main screen).
* **App Nap**: while a chat generation or image job is running, the app holds a
  `powerSaveBlocker('prevent-app-suspension')`, released as soon as the backend is idle (the blocker is
  started by backend events and released by a 2 s poll that runs only while busy). It does not keep the
  display awake.
* **Quit** (⌘Q, Dock → Quit, `SIGINT`/`SIGTERM` in `npm run app`): the app waits (≤ 10 s) for
  `server.close()`, which aborts running generations, flushes chats/indexes and stops an Ollama that
  Harness itself started (`settings.ollama.stopOnExit`).
* **Startup errors**: if the data folder is unusable or the server fails to start, a dialog explains the
  error and offers "Show Log File"; the app then exits with status 1.
* **Renderer crash**: a dialog offers to reload the window (the data lives in the backend).
* **Logs**: the backend's console output is copied to `<data>/logs/harness.log` (rotated to
  `harness.log.1` at 5 MB). Help → Show Log File.

## Packaging (electron-builder)

Config: the `build` key in `package.json`. Highlights:

* `mac.target`: `dmg` for **arm64** only (the `.app` is produced in `dist/mac-arm64/` on the way).
* `files` is an allow-list: `package.json`, `server/`, `public/`, `electron/` minus `electron/test/`.
  Tests, fakes, `scripts/`, `docs/`, `build/`, dev data (`.harness-dev`) and `node_modules` are not
  packaged (there are no runtime dependencies). Packed into `app.asar` (the backend reads its static
  files and `package.json` through Electron's asar support; verified with the packaged Linux build).
* `publish: null`: no auto-update metadata, no network publishing.
* **Signing — ad-hoc.** Apple Silicon refuses to run unsigned code, so the app must be signed at least
  ad-hoc. `mac.identity: "-"` does that without a Developer ID: in electron-builder 26.18
  (`app-builder-lib/out/mac/MacTargetHelper.js`, `findSigningIdentity`) a `"-"` qualifier that matches no
  keychain certificate becomes `new Identity("-")`, which is passed to `@electron/osx-sign` → `codesign
  --sign -`. (`identity: null` would *skip* signing — not what we want.) If you do have a
  "Developer ID Application" certificate whose name contains "-", electron-builder may pick it instead,
  which is also fine. `hardenedRuntime: false` (only needed for notarization; avoids library-validation
  failures with ad-hoc signatures) and `notarize: false`.
* **Gatekeeper**: macOS only checks apps that carry the `com.apple.quarantine` attribute, which is set
  by browsers/AirDrop/Mail on downloaded files — not on files your own build creates. A Harness.app built
  on the same Mac therefore opens normally. A copy sent to another Mac is quarantined and, being ad-hoc
  signed and not notarized, is blocked ("cannot be opened"/"is damaged"). Only for a build you made
  yourself: System Settings → Privacy & Security → "Open Anyway", or `xattr -dr com.apple.quarantine
  /Applications/Harness.app`. Each build has a new ad-hoc identity; Harness asks for no macOS privacy
  permissions, so that does not cause prompts.
* **Icon**: `build/icon.svg` is the source. `npm run icons` runs electron-builder's own icon tool
  (`icons@1.2.3` toolset, `app-builder-lib/out/toolsets/icons.js` → `icon-tool.js`, resvg + libvips WASM)
  to write `build/icon.icns` (entries ic04/ic05 ARGB 16/32 px; ic07–ic14 PNG 32–1024 px) and copies the
  1024 px PNG to `build/icon.png`. Both are committed, and `mac.icon` points at the `.icns`, so electron-builder
  uses it as-is (`resolveIcon` returns an existing `.icns` without converting) and `npm run dist` needs no
  icon conversion on the Mac.
* **Downloads during `npm run dist`** (first time, then cached under `~/Library/Caches/`): the Electron
  `darwin-arm64` zip (checksum-pinned by the `electron` package) and electron-builder's `dmgbuild` bundle
  (checksum-pinned in `dmg-builder`). `npm run dist:app` skips the DMG and its download.

## Verification status

Developed on Linux (no Mac available). **Verified there:**

* `npm test` — unit tests for everything that does not need a display: data-dir parity with the
  backend, `desktop.json` validation, URL/navigation/window-open decisions, `showInFolder` path
  containment (incl. symlinks), badge sanitising, permission allow-list, menu template (every action
  exactly once, no duplicate/clobbered accelerators, standard roles present), context menu, window-state
  clamping, App Nap guard, running-instance detection, the preload contract (in a VM), and packaging
  guards (no runtime deps; allow-listed files; ad-hoc identity).
* `npm run test:e2e` — the real Electron 44 app under Xvfb: window loads the server URL; preload
  classes and `harnessDesktop` present; no Node in the page; a native menu click reaches
  `onMenuAction`; external/`file:` navigation and `window.open` blocked (http(s) routed to the
  browser hook); IPC argument validation; remote requests from the page cancelled; permissions denied;
  `ui.theme` → `nativeTheme`; App Nap blocker held exactly during a (fake-model) generation; quit closes
  the server (port closed, clean-shutdown lines in the log, window state saved); attaching to an
  already-running CLI server and leaving it running; an unusable data dir exits with status 1.
  The same suite passes against the packaged Linux build (`electron-builder --linux dir`, asar).
* `electron-builder --linux dir` — config and file allow-list (inspected `app.asar`).
* `bash -n` and `shellcheck` on `scripts/setup-macos.sh` and `Harness.command`; the setup script's
  flow with stubbed macOS tools.

**Not verified (needs a Mac):** the arm64 `.app`/`.dmg` build itself, the ad-hoc signature
(`codesign -dv` should show `Signature=adhoc`), Gatekeeper behaviour, `.icns` rendering in Finder/Dock,
the `hiddenInset` title bar and traffic-light spacing, macOS full-screen transitions, hide-on-close and
Dock reopen, Dock badge and Dock menu, the global shortcut on macOS, App Nap actually being prevented,
the system spell checker/Look Up in the context menu, and `setup-macos.sh` on real macOS bash 3.2.

Quick checks on the Mac after `npm run dist`:

```bash
codesign -dv dist/mac-arm64/Harness.app 2>&1 | grep -E 'Signature|Identifier'   # Signature=adhoc
codesign --verify --deep --strict dist/mac-arm64/Harness.app && echo signature-ok
open dist/mac-arm64/Harness.app
```
