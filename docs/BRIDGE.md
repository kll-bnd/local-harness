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

- `{ "op": "hello", "protocol": 1, "app": { "name": "Harness", "version": "0.2.0", "kind": "native" }, "dataKey": "<base64 of 32 random bytes>" }`
  must be the first frame. `dataKey` is the key that encrypts the data directory, kept by the app in the
  macOS Keychain; `null` means "no key from the app" (the backend then uses its own key source, or runs
  unencrypted if encryption is switched off).
- `{ "op": "ping" }` → the backend answers with an event `{ "type": "pong" }`.
- `{ "op": "shutdown" }` → the backend finishes or aborts what is running, saves, stops a managed Ollama
  and exits 0.

### Events (`EVENT`)

- `{ "type": "ready", "protocol": 1, "version": "0.2.0", "encryption": { "enabled": true }, "offlineLock": true }`
  once the data directory is open and requests will be answered. Requests sent before `ready` are queued.
- `{ "type": "progress", "what": "encrypting", "done": 12, "total": 340 }` during a one-off migration at
  start-up, so the app can show something better than a frozen window.
- `{ "type": "fatal", "code": "wrong_key" | "data_dir_locked" | "…", "message": "…", "url": null }` when the
  backend cannot start; it exits non-zero right after. For `data_dir_locked`, `url` is the address of the
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
{ "version": 1, "offlineLock": true, "offlineLockSuspendedUntil": null, "encryption": "keychain" }
```

- `offlineLock`: start the backend inside the offline-lock sandbox.
- `offlineLockSuspendedUntil`: ISO time until which the user has allowed the network (to download a
  model). While it is in the future the launcher starts the backend *without* the sandbox; the backend
  re-locks itself when the time passes and asks for a restart.
- `encryption`: `"keychain"` (key from the macOS Keychain) or `"off"`.

A missing file means the defaults shown above.

## Offline lock (the OS sandbox)

`server/security/offline-lock.sb` is a `sandbox-exec` profile that allows everything except network
traffic to anything other than this computer, and blocks DNS lookups. A launcher applies it like this:

```
HARNESS_SANDBOXED=1 /usr/bin/sandbox-exec -f <repo>/server/security/offline-lock.sb node server/index.mjs --bridge
```

Children inherit the sandbox, so the Ollama server and the model runner that the backend starts are
confined as well. The backend additionally refuses non-local destinations in its own code while the lock
is on, which also covers launch modes that cannot use the sandbox.

To be confirmed on a real Mac by the native-app work (and recorded here once known): that
`sandbox-exec` and this profile syntax work on current macOS; that a real Ollama under the sandbox still
loads a model on the GPU and answers on loopback; that a model download and any request to a public host
fail; and that name lookups are blocked rather than forwarded by the system resolver.
