# Bridge mode: Harness without a localhost server

In its normal mode the Harness backend listens on `127.0.0.1` and the UI talks to it over HTTP. In
**bridge mode** the backend opens **no listening socket of any kind** (no TCP port, no Unix socket). A
native app starts the backend as a child process and exchanges framed messages with it over the child's
standard input and output. Those pipes belong to the two processes; nothing else on the machine can
connect to them.

This document is the contract between the backend (`server/`) and a native shell (`native/`). Both sides
are built against it, so change it only together with both.

## Starting the backend

```
node server/index.mjs --bridge [--data-dir <dir>]
```

- `stdin`: frames from the app. `stdout`: frames to the app. `stderr`: human-readable log lines.
- In bridge mode the backend never writes anything except frames to `stdout` (all logging goes to
  `stderr` and the log file).
- The backend exits with status 0 after a `shutdown` control message or when `stdin` reaches end of file
  (the app died); it must then stop any Ollama it started and release the data-directory lock.
- Environment: `HARNESS_SANDBOXED=1` tells the backend it was started inside the offline-lock sandbox (see
  below), so it does not try to wrap its own children again.

## Frames

Every frame, in both directions:

| bytes | meaning |
|---|---|
| 4 | `N`: unsigned big-endian length of everything that follows |
| 1 | frame type |
| 4 | stream id, unsigned big-endian (0 for control and event frames) |
| N − 5 | payload |

A payload is at most 1,048,576 bytes; larger bodies are split over several body frames. A receiver that
reads a length above 1,048,581 treats the stream as corrupt and stops.

### App → backend

| type | name | payload |
|---|---|---|
| `0x01` | `REQ_HEAD` | UTF-8 JSON `{ "method": "POST", "path": "/api/chats/abc/messages?x=1", "headers": { "content-type": "application/json" } }`. The app picks the stream id: non-zero, unique among streams that are still open |
| `0x02` | `REQ_BODY` | raw bytes of the request body (zero or more frames) |
| `0x03` | `REQ_END` | empty: the request is complete |
| `0x04` | `CANCEL` | empty: the app no longer wants this response. The backend treats it exactly like an HTTP client disconnecting (a running chat generation is aborted and the partial reply kept) and sends nothing more for the stream |
| `0x05` | `CONTROL` | stream id 0, UTF-8 JSON, see below |

### Backend → app

| type | name | payload |
|---|---|---|
| `0x11` | `RES_HEAD` | UTF-8 JSON `{ "status": 200, "headers": { "content-type": "text/event-stream" } }`. Header names are lower-case; each value is one string |
| `0x12` | `RES_BODY` | raw bytes of the response body, in order, as soon as they are produced (server-sent event streams must not be buffered) |
| `0x13` | `RES_END` | empty: the response is complete. Every stream that was not cancelled ends with exactly one `RES_END`; if the backend fails before it could answer, it first sends a `RES_HEAD` with status 500 and a JSON error body |
| `0x15` | `EVENT` | stream id 0, UTF-8 JSON, see below |

### Control messages (`CONTROL`)

- `{ "op": "hello", "protocol": 1, "app": { "name": "Harness", "version": "0.2.0", "kind": "native" }, "dataKey": null }`
  must be the first frame. `dataKey` is `null` in the default **password** mode: the data stays locked
  until the user types their Harness password into the lock screen that the UI shows (see "Locking"
  below). Only when `launch.json` says `"encryption": "keychain"` does the app send the key it keeps in
  the macOS Keychain here, as base64 of 32 random bytes, and the data opens without a prompt.
- `{ "op": "lock" }`: lock now. The app sends it when the Mac goes to sleep, the screen is locked, the
  user picks "Lock Harness", or the app has been idle for the configured time while hidden. The backend
  aborts what is running, unloads models it started, closes the data and forgets the key.
- `{ "op": "ping" }` → the backend answers with an event `{ "type": "pong" }`.
- `{ "op": "shutdown" }` → the backend finishes or aborts what is running, saves, stops a managed Ollama
  and exits 0.

### Events (`EVENT`)

- `{ "type": "ready", "protocol": 1, "version": "0.2.0", "locked": true, "state": "needs_setup", "encryption": { "mode": "password" }, "offlineLock": true }`
  once requests will be answered (`state` is the security state of `GET /api/security`: `needs_setup`, `locked`,
  `migrating`, `unlocked` or `error`). Requests sent before `ready` are queued. `locked: true` means the UI can
  load and will show its lock screen; everything except the lock routes answers with HTTP status 423
  until the password has been accepted.
- `{ "type": "locked" }` and `{ "type": "unlocked" }` whenever that state changes, so the app can enable
  or disable menu items, clear a Dock badge and stop holding off App Nap.
- `{ "type": "progress", "what": "encrypting", "done": 12, "total": 340 }` during a one-off migration at
  start-up, so the app can show something better than a frozen window. `what` is `"encrypting"`,
  `"decrypting"` or `"reencrypting"`; the same progress is in `GET /api/security` → `migration`.
- `{ "type": "keychain-key", "dataKey": "<base64 of 32 bytes>" | null }` when the user switches to keychain
  mode (store this value in the login Keychain, service `local.harness`, account `data-key` — for a data folder
  other than the default one, account `data-key-<first 16 hex digits of SHA-256 of the folder's real path>`, the
  name the listener-mode backend uses for it — and send it as `hello.dataKey` from then on) or leaves it (`null`:
  delete the item). Sent only after the backend has
  written `launch.json`.
- `{ "type": "fatal", "code": "wrong_key" | "data_dir_locked" | "…", "message": "…", "url": null }` when the
  backend cannot start; it exits non-zero right after. Codes: `wrong_key` (keychain mode: the key in
  `hello` does not open the data — the app should fall back to the password: start again with
  `dataKey: null`), `data_dir_locked`, `bad_hello` (first frame missing or invalid), `startup_failed`. For `data_dir_locked`, `url` is the address of the
  instance that holds the lock when that instance has one.
- `{ "type": "restart-required", "reason": "offline_lock" | "…" }`: the app should shut the backend down
  and start it again (re-reading `launch.json`, below), then reload the UI.
- `{ "type": "pong" }`.

## How requests are treated

A bridge request goes through the same router and handlers as an HTTP request, with the same validation
of paths, parameters and bodies. Because no network is involved, the `Host`/`Origin` checks and the API
password that guard the HTTP listener do not apply to bridge requests. Static files of the UI are served
through the bridge too (`GET /`, `/js/…`, `/css/…`), with the same security headers.

In the native app the UI is loaded from the custom address `harness://app/…`; the app maps
`harness://app/<path>` to a bridge request for `/<path>`. The UI only ever uses relative URLs.

## `launch.json`: what a launcher must know before the backend runs

Some decisions have to be made before the backend process exists (whether to start it inside the
sandbox), so they cannot live in the encrypted data. The backend keeps this small, non-sensitive,
plain-text file in the data directory, and every launcher (native app, Electron shell, `Harness.command`,
`npm start`) reads it before starting the backend:

```json
{ "version": 1, "offlineLock": true, "offlineLockSuspendedUntil": null, "encryption": "password" }
```

- `offlineLock`: start the backend inside the offline-lock sandbox.
- `offlineLockSuspendedUntil`: ISO time until which the user has allowed the network (to download a
  model). While it is in the future the launcher starts the backend *without* the sandbox; the backend
  re-locks itself when the time passes and asks for a restart.
- `encryption`: `"password"` (the default: the user types a password to open Harness; the key is derived
  from it and never stored), `"keychain"` (the key is kept in the macOS Keychain and Harness opens without
  asking; a convenience the user can choose, weaker because other programs running as the user can ask
  the Keychain for it), or `"off"`.

A missing file means the defaults shown above.

`launch.json` is **a hint for launchers; the backend never lowers protection because of it.** Anyone who can
write the data folder can edit it, so once a key store exists the backend takes the mode, the blocker and an
allow window only from its security record, which is sealed under the data key (docs/API.md §10.2): until the
first unlock it runs locked in an encrypted mode with the blocker on, whatever this file says, and after it the
backend rewrites the file to match the record (a value that claimed less protection is reported in
`GET /api/security` → `tamper`). A launcher that follows a tampered file can only start the backend outside the
sandbox or offer the Keychain; the backend blocks in code and asks for the password all the same. Keep reading
it before every start (the backend may have rewritten it), and do not write it yourself.

## Locking

In password mode the backend starts locked. The UI is served as usual and shows a lock screen; it sends
the password to the backend's unlock route over the bridge (it never leaves the two processes), and the
backend derives the key, opens the data and sends the `unlocked` event. The password is asked again for
actions that lower protection: allowing the network, exporting data or the recovery key, changing the
password, switching encryption off. The native app has nothing to implement for this beyond the `lock`
control message, the `locked`/`unlocked` events and a "Lock Harness" menu item.

## Offline lock (the OS sandbox)

`server/security/offline-lock.sb` is a `sandbox-exec` profile that allows everything except network
traffic to anything other than this computer, and blocks DNS lookups. A launcher applies it like this:

```
HARNESS_SANDBOXED=1 /usr/bin/sandbox-exec -f <repo>/server/security/offline-lock.sb node server/index.mjs --bridge
```

Children inherit the sandbox, so the Ollama server and the model runner that the backend starts are
confined as well. The backend additionally refuses non-local destinations in its own code while the lock
is on, which also covers launch modes that cannot use the sandbox.

Without the launcher's sandbox, the backend confines only the `ollama serve` it starts itself (it runs it
under `sandbox-exec` while internet access is blocked and restarts it when the user allows or blocks
access). Recommended for the native app: do **not** sandbox the backend itself. Allowing internet access
in a sandboxed backend needs a backend restart (`restart-required`), and in password mode that restart
locks the data, so the user has to type the password again right after typing it to allow access. The
backend reports what is enforced in `GET /api/security` → `offlineLock.osScope` (`"backend"`, `"ollama"`
or `"none"`).

Confirmed on a real Mac (GitHub's Apple Silicon runner: macOS 26.7.2, "Apple M1 (Virtual)", Ollama 0.40.13;
the `native` job of `.github/workflows/macos.yml`, `native/ci/sandbox-ollama.mjs` and `native/ci/sb-variants.mjs`):

* `/usr/bin/sandbox-exec` exists on macOS 26 and accepts the profile.
* The first draft of the profile did **not** confine anything but DNS: `(allow network* (local ip "localhost:*"))`
  matches the machine's own addresses, so TCP and UDP to the internet went through. The shipped profile allows
  outbound traffic only to a loopback peer (`remote ip "localhost:*"`), listening via `network-inbound (local ip
  "localhost:*")`, Unix-domain sockets, and closes mDNSResponder's socket.
* With it, a real `ollama serve` started the way the backend starts it (`sandbox-exec -f offline-lock.sb ollama serve`,
  `OLLAMA_HOST=127.0.0.1:11434`) loads `qwen3:0.6b` **on the GPU** (Metal "Apple Paravirtual device", 100 % of the
  model in VRAM — the same as without the sandbox) and answers chats on 127.0.0.1. A model pull fails (`lookup
  registry.ollama.ai: no such host`); from a process under the same profile a TCP connection to 1.1.1.1:443 and to a
  public IPv6 address fails with `EPERM`, `getaddrinfo` of a public name fails (`ENOTFOUND`), a direct UDP DNS query to
  the configured name server is refused, and an HTTPS fetch fails — while 127.0.0.1, ::1, local listening sockets and
  Unix sockets keep working. Without the sandbox the same pull, connection, lookups and fetch all succeed.
* Name lookups are **blocked, not forwarded** by the system resolver: `getaddrinfo` reaches mDNSResponder over
  `/private/var/run/mDNSResponder`, which the profile closes (the `mach-lookup` denies alone did not stop it).
* Limit: the sandbox checks when a socket binds or listens, not each accepted connection, so a confined program that
  listens on all interfaces can be reached from the local network (measured). Harness's Ollama listens on 127.0.0.1
  only, where the kernel refuses other peers.
