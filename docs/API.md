# Harness backend — HTTP + SSE API (v0.1.0)

This is the complete contract between the Harness backend (`server/`) and its clients (web UI in `public/`,
Electron shell in `electron/`). Examples were captured from the real server running against the fake
backends (`npm run dev:fake`); ids/timestamps/byte counts will differ on your machine.

Contents

1. [Running the server](#1-running-the-server)
2. [Conventions](#2-conventions) — security, JSON, errors, ids, SSE framing
3. [Data model](#3-data-model) — Chat, Message tree, Summary, ContextUsage, ContextPlan, Memory, Attachment, Image, Settings, …
4. [Chat generation stream (SSE)](#4-chat-generation-stream-sse) — every event type
5. [Routes](#5-routes)
   - [System & events](#51-system--events) · [Settings & presets](#52-settings--presets) · [Providers](#53-providers) · [Models](#54-models)
   - [Chats](#55-chats) · [Messages & generation](#56-messages--generation) · [Summary / compaction](#57-summary--compaction) · [Export / import / search](#58-export-import-search)
   - [Memories](#59-memories) · [Attachments](#510-attachments) · [Images](#511-image-generation)
6. [Global event bus (`GET /api/events`)](#6-global-event-bus)
7. [UI integration notes](#7-ui-integration-notes)
8. [Fake backends for development](#8-fake-backends-for-development)
9. [Changes in the hardening pass (for UI authors)](#9-changes-in-the-hardening-pass)

---

## 1. Running the server

```bash
npm start                      # node server/index.mjs — http://127.0.0.1:4747
node server/index.mjs --port 4747 --data-dir /path/to/data --open
npm run dev:fake               # real server + fake Ollama / Draw Things / ComfyUI / llama.cpp (no models needed)
npm run dev:fake -- --ram 8    # same, pretending the machine has 8 GB RAM
npm test                       # node --test
```

Programmatic (Electron main process):

```js
import { startServer } from './server/index.mjs';
const { port, url, close } = await startServer({ port: 4747, dataDir, openBrowser: false });
// load `url` in a BrowserWindow; call `await close()` on quit (also stops an app-spawned `ollama serve`)
```

* Binds **127.0.0.1 only**. If the port is busy it tries the next 10 ports, then any free port — always use the returned `url`.
* Data dir: `HARNESS_DATA_DIR`, else `~/Library/Application Support/Harness` (macOS), `%APPDATA%\Harness` (Windows), `$XDG_DATA_HOME/harness` or `~/.local/share/harness`.
* Environment: `HARNESS_PORT`, `HARNESS_DATA_DIR`, `HARNESS_OPEN=1`, `HARNESS_LOG_LEVEL` (`debug|info|warn|error|silent`),
  `HARNESS_ALLOWED_ORIGINS` (comma-separated extra allowed Origins, e.g. `app://harness` for a custom Electron protocol),
  `OLLAMA_HOST` (default Ollama URL), `HARNESS_OLLAMA_BIN` (path to the `ollama` binary), `HARNESS_NO_OLLAMA_AUTOSTART=1`,
  `HARNESS_TOTALMEM_BYTES` (simulate a different RAM size).
* Static files are served from `public/` (`GET /` → `public/index.html`; extension-less unknown paths fall back to `index.html` for SPA routing).
* Zero runtime dependencies; Node ≥ 20.
* **One server per data directory.** `startServer()` takes a lock file `<dataDir>/harness.lock` (`{ pid, url, port, startedAt, hostname, dataDir }`, written with the final URL once listening, removed on `close()`/exit). A second start on the same data dir rejects with an error whose `code` is `"HARNESS_ALREADY_RUNNING"` and whose `url`/`pid` name the running instance; the CLI then prints `Harness is already running at <url> (same data folder).`, opens it with `--open`, and exits 0. A lock left by a dead process (or a non-answering URL after a 60 s grace) is taken over; a lock from another host is never stolen. `electron/lib/instance.cjs` reads the same file to attach to a running CLI server.

## 2. Conventions

### Security
* Every request's `Host` must be `localhost`, `127.0.0.1` or `[::1]` (any port) → otherwise `403 forbidden` (DNS-rebinding protection).
* If an `Origin` header is present it must be the server's **own** origin (`http://localhost|127.0.0.1|[::1]:<this port>`), or be listed in `settings.security.allowedOrigins` or `HARNESS_ALLOWED_ORIGINS`; other localhost ports, `Origin: null` and other sites → `403`. Requests with `Sec-Fetch-Site: cross-site` and no Origin → `403`.
* Listed extra origins (e.g. a Vite dev server: `PATCH /api/settings {"security":{"allowedOrigins":["http://localhost:5173"]}}`) get CORS headers (`Access-Control-Allow-Origin: <origin>`, preflight `OPTIONS` → `204`). The same-origin UI needs nothing special.
* Every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. HTML pages carry exactly `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
* A path with malformed percent-encoding (e.g. `/api/chats/%E0%A4%A`) → `400 bad_request` (never a crash).
* JSON endpoints require `Content-Type: application/json` (→ `415` otherwise). Uploads (`POST /api/attachments`) take the raw file body.

### JSON, ids, time
* All bodies are JSON objects; all timestamps are ISO-8601 UTC strings; sizes are bytes; token counts are integers.
* Ids are opaque, time-sortable strings with a type prefix: `chat_…`, `msg_…`, `sum_…`, `mem_…`, `att_…`, `img_…`, `imgjob_…`, `gen_…`, `call_…`, `preset_…`, `prov_…`, `imgprov_…`, `pull_…`.
* **ModelRef** — models are always addressed as `{ "providerId": "ollama", "model": "nemotron-3.5-bolt:e4b" }`.
  `providerId` may be omitted on input (resolved to the first provider listing that model, else `ollama`). Model names can contain `/` and `:`, so routes take them as query parameters.

### Errors
Every error response has this shape (HTTP status ≥ 400):

```json
{ "error": { "code": "not_found", "message": "Chat not found" } }
```

Optional `details` object. Common codes:

| HTTP | code | meaning |
|---|---|---|
| 400 | `bad_request`, `bad_json`, `bad_parent`, `attachment_not_found`, `attachment_unusable`, `nothing_to_compact`, `not_chat_model`, `unsupported`, `not_multimodal`, `workflow_invalid` (ComfyUI rejected the workflow; the message names the failing nodes) | invalid input |
| 403 | `forbidden` (host/origin), `read_only` (built-in preset) | |
| 404 | `not_found`, `model_not_found`, `provider_not_found`, `image_provider_not_found`, `no_summary`, `not_installed` | |
| 405 / 413 / 415 | `method_not_allowed` / `payload_too_large` / `unsupported_media_type` | |
| 409 | `chat_busy` (a generation, image job, compaction or extraction is already running in that chat), `message_deleted` (the message to answer was deleted meanwhile), `memory_protected`, `name_taken`, `no_model` (no chat model available), `image_disabled` | |
| 422 | `secret_detected` (memory looks like a password/key — resend with `allowSecret: true`), `no_model_blob` | |
| 500 | `internal_error`, `start_timeout` | |
| 502 | `provider_error` (backend returned an error), `model_load_failed` (Ollama's runner crashed while loading the model — `details.nextSteps`, see 5.4) | |
| 503 | `connection_failed` (backend not reachable: "Cannot reach X at URL (ECONNREFUSED)"), `registry_unreachable` (a pull could not reach the model registry: offline), `no_image_provider`, `image_provider_unreachable` | |
| 504 | `timeout` ("Timed out waiting for X to respond (…) after N s" — only Harness's own deadlines; backend calls have no hidden client timeout) | |

`details` may contain `providerId` and, for `model_load_failed`, `nextSteps: [{ action, label, method?, path?, body?, model? }]` with `action` ∈ `create_text_only_copy` (call `method path` with `body`) · `use_smaller_file` (`model`) · `retry`.

Streaming endpoints validate first: **setup errors are returned as normal JSON errors before any SSE bytes** (e.g. unknown model → `404 model_not_found`, Ollama down → `503 connection_failed`, a second send while the chat is busy → `409 chat_busy`, the anchor message deleted meanwhile → `409 message_deleted`). Once the stream has started, failures arrive as an `error` event. Only one operation runs per chat: the busy check and the reservation happen synchronously, so two concurrent sends can never both start.

### SSE framing
Streaming endpoints are `POST` requests that respond with `Content-Type: text/event-stream` (read them with `fetch()` + a stream reader; `EventSource` cannot POST). Only `GET /api/events` is a plain GET stream (works with `EventSource`). Frames:

```
: harness stream

id: 1
event: token
data: {"type":"token","messageId":"msg_0mwin8llr0166b1e45c","delta":"You sai"}

: ping
```

* Each event has `event: <type>` **and** the same `type` inside the JSON, so a client may parse `data:` lines only.
* `id:` is a per-stream sequence number. Comment lines (`: ping`) are heartbeats every 15 s — ignore them.
* **Aborting:** closing the HTTP connection (e.g. `AbortController.abort()`, or a page reload) aborts the generation/pull/image job; the partial assistant message is stored with `status: "aborted"` (its text so far is kept). `POST /api/chats/:id/stop` does the same without closing the stream (you then receive `done` with `reason: "aborted"`).
* **`done` / `error` mean "you can send again":** the chat's reservation is released and the turn is written to disk *before* either is sent, so a send issued from the `done` handler is accepted.

## 3. Data model

### 3.1 Chat

`ChatSummary` (list items, `chat` objects inside events):

```json
{
  "id": "chat_0mwin8lli00a2ed553e",
  "title": "Hello My Name Is",
  "titleSource": "auto",
  "createdAt": "2026-11-16T02:27:48.438Z",
  "updatedAt": "2026-11-16T02:27:48.549Z",
  "pinned": false,
  "archived": false,
  "incognito": false,
  "messageCount": 8,
  "preview": "Tool calculate returned: 17*23 = 391",
  "model": { "providerId": "ollama", "model": "nemotron-3.5-bolt:e4b" },
  "generating": false
}
```

* `titleSource`: `null` (untitled) → `"provisional"` (first words of the first message, set immediately) → `"auto"` (LLM-generated in the background after the first reply) or `"user"` (renamed; never auto-replaced).
* `model`: the chat's model override if set, else the model of the last assistant message on the active path, else `null`.
* `generating` (list only): a generation or chat-linked image job is running.
* `titleSource` may also be `"import"`: the title came with an imported chat. Auto-titling only ever runs for `null`/`"provisional"` titles, once (`"auto"`, `"user"` and `"import"` titles are never replaced; `POST /api/chats/:id/title` regenerates on request).

`ChatDetail` (`GET /api/chats/:id`, `POST /api/chats`, `PATCH`):

```json
{
  "chat": {
    "...ChatSummary fields": "",
    "settings": { "presetId": "default" },
    "activeLeafId": "msg_0mwin8lo600dfc1897e",
    "summary": null,
    "generating": null
  },
  "messages": [ /* every Message in the tree (all branches), oldest first, each with childIds + siblingIds */ ],
  "path": [ "msg_…", "msg_…" ]
}
```

* `path`: ids of the **active branch**, root → leaf. Render `path.map(id => byId[id])`.
* `chat.summary`: the active rolling **Summary** for this branch (or `null`) — see 3.3.
* `chat.generating`: `{ generationId, assistantMessageId, startedAt }` while a turn is running, else `null`. A generation is tied to the HTTP stream that started it: reloading the page closes that stream and aborts the turn (the partial reply is kept with `status: "aborted"`), so after a reload this is normally `null`. It is non-null only while another window or tab is still streaming that chat.
* `chat.settings`: per-chat overrides, see **ChatSettings** (3.9).

### 3.2 Message (tree node)

Messages form a tree via `parentId` (`null` for roots). Editing or regenerating creates **siblings**; nothing is overwritten. Common fields:

| field | type | notes |
|---|---|---|
| `id`, `parentId` | string / string\|null | |
| `role` | `"user" \| "assistant" \| "tool"` | |
| `content` | string | user text / assistant answer (reasoning removed) / tool result text |
| `status` | `"complete" \| "streaming" \| "aborted" \| "error" \| "running"` | `running` only for tool messages mid-call; `streaming` is never persisted across restarts (becomes `aborted`) |
| `createdAt`, `updatedAt?` | string | |
| `childIds`, `siblingIds` | string[] | API-only, computed. `siblingIds` includes the message itself, ordered oldest → newest: show "‹ 2/3 ›" with `siblingIds.indexOf(id)` |
| `kind?` | `"image_request" \| "image_result"` | messages created by chat-linked image generation (5.11) |

User messages: `attachments: [{ id, name, kind, mime, size }]` (AttachmentRef), `editedFrom?` (id of the message this edit branched from), `imageRequest?` (for `kind: "image_request"`).

Assistant messages:

| field | notes |
|---|---|
| `reasoning` | streamed thinking text (Ollama `thinking` field, `reasoning_content`, or inline `<think>` tags). Never re-sent to the model |
| `model` | ModelRef that produced it (`{providerId, model, kind:"image"}` for image results) |
| `toolCalls?` | `[{ id, name, arguments }]` — present on an assistant step that called tools; its tool results follow as children |
| `usage?` | last backend call: `{ promptTokens, cachedPromptTokens, completionTokens, totalMs, loadMs, promptMs, evalMs }` (any may be `null`; `cachedPromptTokens` = prompt tokens Ollama ≥ 0.40 reused from its prompt cache — `promptTokens` is still the full prompt) |
| `stats?` | whole turn: `{ durationMs, iterations, toolCalls, promptTokens, completionTokens, tokensPerSecond, loadMs }` |
| `context?` | **ContextUsage** at request time (+ `summaryId`, + `actual: {promptTokens, completionTokens, used}` from the backend) |
| `retrieval?` | `{ memoryIds, pinnedMemoryIds, documentChunks, recallChunkIds }` — what was injected |
| `finishReason?` | `"length" \| "tool_limit" \| "aborted"` (absent = normal stop) |
| `error?`, `errorCode?`, `nextSteps?` | when `status: "error"` (`nextSteps` as in §2 Errors, e.g. after `model_load_failed`) |
| `fallback?` | `"image"` \| `"tool_summary"` — the model's final answer after tool results was empty and Harness wrote the text: for `generate_image` a short line ("Here is the image of “…”."; the image is the answer), for other tools a neutral summary of the results ("Tool results — calculate: 3*3 = 9") after one retry without tools also came back empty |
| `edited?`, `editedFrom?` | hand-edited assistant message (created as a sibling) |
| `images?` | `ImageRef[]` (only `kind: "image_result"`) |

Tool messages: `toolCallId`, `toolName`, `content` (what the model saw), `isError`, `data?` (structured result for the UI, e.g. `{value: 391}` for `calculate`), `images?: ImageRef[]` (from `generate_image`), `durationMs`.

**A turn** = user message → assistant step(s). With tools it is a chain: `user → assistant(toolCalls) → tool → tool → assistant(final)`. Render the assistant/tool chain under one bubble; `regenerate` on any message of the chain regenerates the whole turn.

### 3.3 Summary (auto-compaction)

```json
{
  "id": "sum_0mwin8qel004e98230c",
  "upToMessageId": "msg_0mwin8ln202a77e9b7d",
  "previousSummaryId": null,
  "content": "## Goals\n- …\n## Key facts & context\n- …\n## Decisions\n- …\n## User preferences\n- …\n## Code & artifacts\n- …\n## Open threads\n- …",
  "tokens": 70,
  "messagesCovered": 4,
  "method": "single",
  "model": "nemotron-3.5-bolt:e4b",
  "editedByUser": false,
  "createdAt": "2026-11-16T02:27:54.669Z",
  "updatedAt": "2026-11-16T02:27:54.669Z"
}
```

* The summary replaces everything on the path **up to and including `upToMessageId`** in what is sent to the model. Stored messages are never deleted — render them normally and show a divider after `upToMessageId` ("12 earlier messages summarized — view/edit summary").
* A summary is valid for every branch passing through `upToMessageId`; the server picks the deepest one on the active path.
* Automatic compaction only runs when it makes the prompt smaller: if the span it could evict is shorter than `maxSummaryTokens` (e.g. the newest message alone fills the window) it is skipped and hard truncation keeps the request within the window; `POST /compact` always runs.
* Incremental: each new summary = previous summary + newly evicted span (`previousSummaryId` links them). `method`: `single`, `map-reduce` (span larger than the summarizer's context), `manual`… `editedByUser` after `PUT /summary`.

### 3.4 ContextUsage (token accounting)

Sent in `context` events, stored on assistant messages, returned by `GET /api/chats/:id/context`:

```json
{
  "numCtx": 65536, "budget": 57344, "replyReserve": 8192, "compactAt": 43008,
  "used": 1049, "percent": 1.6,
  "breakdown": { "system": 84, "tools": 954, "memories": 0, "summary": 0, "documents": 0, "recall": 0, "history": 11 },
  "estimated": true, "calibration": 1.0068
}
```

* `numCtx` = context window sent to the backend; `replyReserve` tokens are kept free for the answer; `budget = numCtx - replyReserve` is the prompt budget; auto-compaction triggers when `used > compactAt`.
* `used` = sum of `breakdown` (estimated prompt tokens). `calibration` is the per-model factor learned from real `prompt_eval_count` / `usage.prompt_tokens` (1.0 until the first sample). After the call, the real count arrives in `stats.promptTokens` and on the message as `context.actual`.
* Context meter suggestion: bar of `numCtx`, segments from `breakdown`, a hatched `replyReserve` tail, a tick at `compactAt`.

### 3.5 ContextPlan (RAM-aware context window)

From `GET /api/models/context`, `GET /api/models/info`, the `start` event (`contextPlan`), `GET /api/chats/:id/context` (`plan`):

```json
{
  "numCtx": 65536, "mode": "auto",
  "modelMax": 65536, "modelMaxSource": "override", "advertisedMax": 131072,
  "limitedBy": "model", "fits": true, "fitMax": 333400,
  "memory": {
    "totalBytes": 17179869184, "budgetBytes": 11338713661, "budgetFraction": 0.66, "osReserveBytes": 5841155522, "ramTier": "medium",
    "modelBytes": 7908810112, "overheadBytes": 505699759,
    "kvBytesPerToken": 8704, "kvFixedBytes": 22282240, "kvCacheType": "q8_0", "kvCacheTypeSource": "managed", "kvSource": "metadata+swa",
    "kvMaxBytes": 592707584, "contextCheap": true, "pressure": null,
    "kvLayers": { "full": 4, "slidingWindow": 20, "window": 512 },
    "kvBytes": 592707584, "otherModelsBytes": 0, "estimatedTotalBytes": 9007217455,
    "basis": "estimate", "measurement": null
  },
  "alternatives": { "max": { "numCtx": 65536, "estimatedTotalBytes": 9007217455, "fits": true, "overBudgetBytes": 0 }, "fitMax": 65536 },
  "warnings": [],
  "explanation": "64K of 64K context (model max); est. 8.4 GB of 16.0 GB RAM (safe budget 10.6 GB).",
  "providerId": "ollama", "model": "nemotron-3.5-bolt:e4b",
  "contextNote": "Nemotron 3.5 Bolt E4B is trained for 64K tokens; its metadata advertises 128K."
}
```

* `mode`: `auto` (largest that safely fits), `max` (model max regardless of RAM), `manual` (explicit number), `server` (OpenAI-compatible servers: fixed at load time, e.g. llama-server `-c`).
* `limitedBy`: `model` | `memory` | `user` | `setting` (`context.maxAuto`) | `low_ram_cap` (`context.lowRamCap`, ≤ 8 GB machines only) | `memory_pressure` (loading at a larger window made macOS swap, see below) | `loaded` (auto mode keeps the window the model is loaded with, see `pendingNumCtx`) | `server`.
* `pendingNumCtx` (number \| `null`): auto mode never **grows** the window of a model that is loaded right now — that would reload it mid-conversation. A larger window found later (e.g. by measuring) waits for the next cold load (unload, keep-alive expiry, an image job, an app restart) and is reported here; `numCtx` stays the loaded window and the explanation says `"… the window the model is loaded with; it will use 16K next time the model loads …"`. Shrinking applies at the next turn as before; explicit modes are never held back.
* `modelMaxSource`: `override` (built-in table — e.g. Nemotron 3.5 Bolt E4B is 64K although metadata says 128K) | `metadata` | `catalog` | `unknown`.
* `ramTier`: `low` (≤ 8 GB), `medium` (≤ 16 GB), `high`.
* `warnings[]`: `{code, message}` — `model_exceeds_budget`, `exceeds_budget`, `clamped_to_model_max`, `context_unknown` (an OpenAI-compatible server that did not report its loaded context: 8K assumed), and from real measurements (below) `measured_exceeds_budget`, `cpu_offload`, `memory_pressure`, `model_too_big` (+ `smallerModel`: the next smaller recommended file, or absent).
* KV cache model: per-token cost of the layers with full attention plus a fixed cost for sliding-window layers (window + 512 cells, as llama.cpp allocates); layers that share KV (`shared_kv_layers`) hold none; gemma4 sliding layers use their own `key_length_swa`/`value_length_swa`. For Nemotron 3.5 Bolt E4B this reproduces llama.cpp's own log exactly: 4 global layers → 8,704 B/token at q8_0 (34 MiB at 4K, 136 MiB at 16K) plus a constant 21.25 MiB for 20 sliding-window layers — context is cheap for this model, the file size decides. `memory.kvMaxBytes` = KV cost of the full window; `contextCheap` = that is < ¼ of the model file (the explanation then says so).
* `memory.kvCacheTypeSource`: `setting` (`context.kvCacheType`), `managed` (the value Harness gave the Ollama it started), `assumed` (an Ollama Harness did not start: its environment is invisible, so `f16` is assumed to stay on the safe side, and the explanation says so).
* Show `explanation` verbatim; it always says what limited the window and, when RAM-limited, what `max` would cost. 8 GB examples:
  * `"The model alone (7.4 GB) exceeds the safe memory budget (4.8 GB) on this 8 GB Mac; using the minimum 2K context. A smaller quantization is strongly recommended."`
  * `"16K of 64K context — capped for responsiveness on this 8 GB Mac (RAM alone would allow ~64K; raise context.lowRamCap or use max mode for more); est. 4.0 GB of 8.0 GB RAM (safe budget 4.8 GB). Context is cheap for this model (the full 64K needs only ~565 MB of KV cache); the model file (3.4 GB) is what decides whether it fits."`
  * `"16K of 64K context — capped for responsiveness on this 8 GB Mac (RAM alone would allow ~26K; …). KV cache precision unknown (this Ollama was not started by Harness): assuming f16 to be safe — set context.kvCacheType if you know it."`

**Self-correction from real memory use (`memory.basis`, `memory.measurement`, `memory.pressure`).** After each turn's first model call Harness measures what the model really occupies — what the Mac experiences, not what Ollama reports:

* **Resident size** = RSS of the Ollama runner process serving the model (`llama-server`, or `ollama runner` in older versions; macOS `ps`, matched by the model's weights blob). Ollama's `/api/ps` `size` is *not* the footprint (it excludes the weights: Nemotron reports a flat ~90 MB while its runner holds ~4.3 GB); when no runner can be attributed, the sample is `model file + ps size` (`source: "ps"`; a ps size ≥ the file already includes the weights, e.g. CPU mode).
* **Memory pressure**: when the request (re)loaded the model, swap in use (`vm.swapusage`) and compressor pages (`vm_stat`) are compared before and after. Growth (≥ 256 MB swap or ≥ 512 MB compressed; the kernel pressure level alone is not trusted — it stayed "normal" with 0.66 GB in swap) is the "this does not fit" signal. Such samples are never used as a size (RSS under-reports while macOS swaps).
* Only for a **local** Ollama on **macOS**; elsewhere (and for remote backends) plans stay estimate-only. Measuring never blocks a turn (it runs alongside; its notices arrive before `done`). Samples are stored per model build (digest + file size) and KV precision in `measurements.json`; samples written by older versions (ps size taken as the total) are dropped.

Using the samples:
* The fixed part is never below the model file (`fixedBytes ≥ modelBytes`; `measurement.flooredToWeights: true` when the measured resident size was smaller, e.g. weights not all paged in right after the load, or already evicted under pressure — the explanation then says so). A resident size below the weights is a sign of under-sampling or pressure, never a smaller footprint.
* 1 clean measurement → the fixed part (weights + overhead) is corrected, bytes/token stays estimated (`method: "offset"`); clean measurements at ≥ 2 contexts ≥ 1K apart → bytes/token is fitted too (`"linear"`, or `"linear-clamped"` when the fit was limited to ¼–4× the estimate). Repeated readings at one context use the median; implausible readings (< 0.4× or > 3× the estimate, below half the weights, tiny contexts) and pressured readings are ignored and counted in `rejected`. A re-pulled/different build or another KV precision starts from the estimate again.
* `memory.basis`: `"estimate" | "measured"`. When `"measured"`, `estimatedTotalBytes` is the measurement-corrected figure and the `explanation` says so (`"… measured-corrected 4.6 GB of 8.0 GB RAM … Memory use is calibrated from 1 measurement of this model (last: 4.9 GB at 14K)."`).
* `memory.measurement` (or `null` when there are no samples):
  ```json
  { "method": "offset", "samples": 1, "distinctContexts": 1, "rejected": 0,
    "fixedBytes": 3179830784, "perTokenBytes": 147456, "estimatedFixedBytes": 2843435456, "estimatedPerTokenBytes": 147456,
    "gpuCapBytes": null,
    "latest": { "numCtx": 14336, "totalBytes": 5293760000, "vramBytes": 5293760000, "at": "2026-11-16T02:49:05.813Z", "cpuSplit": false } }
  ```
  `method` is `"none"` (and `fixedBytes`/`perTokenBytes` are `null`) when every sample was rejected. `gpuCapBytes`: the GPU-resident size observed while part of the model ran on the CPU (Ollama `size_vram < size`); auto mode then keeps the model within it.
* `memory.pressure` (or `null`): `{ numCtx, swapDeltaBytes, compressedDeltaBytes, level, swapUsedBytes, compressedBytes, signal: true }` — the smallest context at which a load made macOS swap, unless a later clean load at that context or more cleared it.
* **Auto mode** never repeats an over-commit: if the latest measurement was over the safe budget or partly on the CPU, the next plan comes down to what fits per the corrected estimate (`"Measured 4.9 GB at 14K (over the safe budget of 4.8 GB); auto mode reduced the window to 12K using that measurement. …"`). If a load made macOS swap, the next plan cuts that window **in one step** by what the swap + compressor growth allows at the per-token cost (at least one notch; the minimum 2K when the growth exceeds the whole window's KV cost) — one reload, not repeated halving (`limitedBy: "memory_pressure"`, `"Loading this model at 40K made macOS swap (+708 MB swap, +1.1 GB compressed); auto mode reduced the window to 28K. …"`); if even the minimum 2K did, the plan stays at 2K with `model_too_big`: `"This model file (3.9 GB) is too big for this 8 GB Mac: even the minimum 2K context made macOS swap (…). Use a smaller file: hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q2_K_XL (3.5 GB as a text-only copy)."`.
* **Explicit modes** (`max`, a number) are never changed; instead `warnings` get `measured_exceeds_budget` (`"Measured 4.9 GB for this model at 16K — over the safe memory budget of 4.8 GB on this 8 GB Mac; expect swapping. About 8K would fit: lower the context or switch to auto."`), `cpu_offload` (`"Ollama placed only 3.6 GB of 3.8 GB on the GPU at 16K (5% runs on the CPU), …"`) and/or `memory_pressure` (`"Loading this model at 16K made macOS swap (…). Your context setting was kept: lower it or switch to auto."`).
* A corrected plan only takes effect at the **start of the next turn** (changing `num_ctx` makes Ollama reload the model); every call within a turn — including the tool loop and auto-compaction — uses that turn's `num_ctx`, and background title / memory-extraction calls use the `num_ctx` the model is currently loaded with.
* Disable with `settings.context.useMeasurements: false`; inspect/reset with `GET`/`DELETE /api/models/measurements`.

### 3.6 Memory

```json
{
  "id": "mem_0mwin8qez0066331880",
  "content": "The user prefers metric units.",
  "category": "preference",
  "pinned": true,
  "origin": "manual",
  "source": null,
  "createdAt": "2026-11-16T02:27:54.683Z",
  "updatedAt": "2026-11-16T02:27:54.683Z",
  "lastUsedAt": null,
  "useCount": 0
}
```

`category`: `fact | preference | project | instruction | other`. `origin`: `auto` (background extraction), `manual` (API/UI), `tool` (the model's `remember` tool), `restore` (from a backup). `source`: `{chatId, messageId}` or `null`. Pinned memories are always included in the system prompt; others are retrieved per turn.

* `needsReview?: true` — saved by the `remember` tool during a turn whose context contained untrusted text (a fetched page, a document, an attached file, recalled chats). Such memories are **not** used in prompts or searches until the user confirms them (`PATCH {needsReview:false}`, or pins/edits them). Show them with a "confirm / delete" affordance.
* Secrets (passwords, API keys/tokens, card numbers, private keys, SSNs …) are never saved by `auto`/`tool`/`restore` (the tool answers "Not saved: that looks like a password…"); a manual save is refused with `422 secret_detected` unless the request says `allowSecret: true`.
* Memories the user wrote or pinned are never overwritten or merged by `auto`/`tool` (`action: "unchanged", reason: "protected"`; a direct non-manual edit → `409 memory_protected`).
* De-duplication only merges near-identical statements (same text, a refinement that adds ≤ 3 words, or a paraphrase with cosine ≥ 0.97 and ≥ 80 % word overlap) — "meeting with John" and "meeting with Sarah" stay separate.

### 3.7 Attachment

```json
{
  "id": "att_0mwin8qf700f49c457c", "name": "notes.md", "mime": "text/markdown", "size": 35,
  "kind": "text", "status": "ready", "error": null, "warnings": [],
  "chatId": "chat_0mwin8lli00a2ed553e", "createdAt": "2026-11-16T02:27:54.693Z", "sha1": "c905d8…",
  "width": null, "height": null, "pages": null, "source": "plain",
  "tokens": 10, "chars": 35, "chunks": 1,
  "url": "/api/attachments/att_0mwin8qf700f49c457c/content"
}
```

* `kind`: `image` (png/jpeg/webp/gif → sent to vision models; `width`/`height` set) · `text` (text/code files and PDFs with extractable text; `source`: `plain|pdf`, `pages` for PDFs) · `binary` (unsupported → `status: "error"`, `error` explains; cannot be sent).
* Text attachments up to the inline limit (25 % of the context window, ≤ 32K tokens) are inlined into the message as `<file name="…">…</file>`; larger ones are chunked (`chunks`) and only relevant excerpts are retrieved per turn (document RAG).
* PDF: text extraction only (no OCR); encrypted/scanned PDFs → `binary` with an explanatory `error`. PDFs and files > 256 KB are extracted in a worker thread with memory and output limits and a 30 s deadline; a file that exceeds them is stored as `binary` with `error: "Could not extract text from this file (…)."` (the upload itself still succeeds, `201`).
* `GET /api/attachments/:id/content` serves raster images (png/jpeg/webp/gif) inline (sandboxed); everything else — HTML, SVG, PDF, text — is sent as a download (`application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''…`, `Content-Security-Policy: default-src 'none'; sandbox`). Use `/text` to show text.

### 3.8 Images

**ImageRecord** (gallery item):

```json
{
  "id": "img_0mwin8qwy00a1e4f6e9", "file": "img_0mwin8qwy00a1e4f6e9.png", "mime": "image/png", "bytes": 201696,
  "width": 576, "height": 384, "createdAt": "2026-11-16T02:27:55.332Z",
  "prompt": "a lighthouse at dusk, oil painting", "negativePrompt": "blurry", "seed": 42,
  "params": { "width": 576, "height": 384, "steps": 2, "cfg": 1, "sampler": null, "count": 1, "denoise": null },
  "model": "sd_turbo.safetensors [a1b2c3]", "providerId": "a1111", "providerKind": "a1111", "family": "sd-turbo",
  "chatId": null, "messageId": null, "toolCallId": null, "source": "user", "jobId": "imgjob_0mwin8qg1004d891bbc",
  "initImage": null,
  "url": "/api/images/img_0mwin8qwy00a1e4f6e9/file"
}
```

`source`: `user` (direct API) | `tool` (`generate_image` called by the chat model). `messageId`: the message that stores the image (tool message, or `image_result` assistant message). `initImage`: `{kind: "attachment"|"image", id}` for img2img.

**ImageRef** (stored on messages): `{ id, url, width, height, mime, prompt, seed, model, providerId }`.

**ImageJob**: `{ id, status, createdAt, finishedAt?, providerId, providerKind, chatId, messageId, toolCallId, source, prompt, progress (0..1), images: [imageId], warnings: [{code,message}], error, params, family: {id,label,fewStep,approxBytes,comfy}, memory }`
— `status`: `queued | starting | unloading | unloaded | generating | saving | done | error | aborted`;
`memory`: `{ unload, reason, loadedBytes, imageModelBytes, totalBytes, mode, unloaded: [model], confirmed? }` where `reason` ∈ `nothing_loaded | setting_never | setting_always | low_ram | insufficient_ram | fits`. `loadedBytes` is the **resident** size of the loaded chat models (measured, else model file + ps size — never Ollama's ps `size` alone, which excludes the weights). `confirmed`: Ollama's `/api/ps` really stopped listing the unloaded models before generation started (`false` = it did not within 20 s; generation went ahead).

### 3.9 Settings

`GET /api/settings` returns `{ settings, defaults }`. Defaults (exact):

```json
{
  "version": 1,
  "defaultModel": null,
  "defaultPresetId": "default",
  "systemPrompt": null,
  "params": { "temperature": null, "top_p": null, "top_k": null, "min_p": null, "repeat_penalty": null, "seed": null, "num_predict": null, "stop": null },
  "keepAlive": "30m",
  "context": { "mode": "auto", "maxAuto": null, "lowRamCap": 16384, "kvCacheType": "auto", "memoryFraction": null, "replyReserve": "auto", "useMeasurements": true },
  "reasoning": { "think": "auto" },
  "compaction": { "enabled": true, "threshold": 0.75, "target": 0.45, "keepRecentFraction": 0.25, "minKeepMessages": 2, "maxSummaryTokens": "auto", "model": null },
  "memory": { "enabled": true, "autoExtract": true, "model": null, "topK": 6, "maxTokens": "auto", "minSimilarity": 0.5, "placement": "turn", "extractDelayMs": 4000 },
  "recall": { "enabled": true, "autoInject": true, "topK": 3, "maxTokens": "auto", "minSimilarity": 0.6 },
  "embeddings": { "model": "auto" },
  "documents": { "topK": 6, "maxTokens": "auto", "inlineMaxTokens": "auto", "chunkTokens": 400, "maxHistoryImages": 4 },
  "tools": {
    "enabled": true, "maxIterations": 6,
    "builtin": { "remember": true, "recall": true, "get_current_time": true, "calculate": true, "fetch_url": false, "generate_image": true },
    "fetchUrl": { "allowPrivateNetwork": false, "maxChars": 20000 }
  },
  "titles": { "auto": true, "model": null },
  "providers": {
    "autodetect": true,
    "builtin": {
      "ollama": { "enabled": true, "baseUrl": null },
      "llamacpp": { "enabled": true, "baseUrl": "http://127.0.0.1:8080" },
      "lmstudio": { "enabled": true, "baseUrl": "http://127.0.0.1:1234" }
    },
    "custom": []
  },
  "ollama": { "autoStart": true, "stopOnExit": true, "binaryPath": null, "flashAttention": true, "kvCacheType": "q8_0", "numParallel": 1, "maxLoadedModels": "auto", "noCloud": true, "promptCacheMiB": "auto", "extraEnv": {} },
  "image": {
    "enabled": true, "providerId": null, "model": null,
    "defaults": { "width": null, "height": null, "steps": null, "cfg": null, "sampler": null, "negativePrompt": "", "count": 1 },
    "unloadChatModel": "auto", "reloadAfter": "lazy", "feedbackToModel": false, "comfyWorkflow": null, "timeoutSec": 600, "autodetect": true,
    "builtin": { "a1111": { "enabled": true, "baseUrl": "http://127.0.0.1:7860" }, "comfyui": { "enabled": true, "baseUrl": "http://127.0.0.1:8188" } },
    "custom": []
  },
  "security": { "allowedOrigins": [] },
  "ui": { "theme": "system" }
}
```

`settings.json` is validated when it is loaded: invalid or unknown branches (hand edits, older versions, a tampered file) are dropped — the rest is kept and the cleaned file is written back. Provider entries need `id`, `kind` and `baseUrl`.

| key | values | meaning |
|---|---|---|
| `defaultModel` | ModelRef \| null | `null` = auto: first installed recommended model (Nemotron 3.5 Bolt first), else newest |
| `defaultPresetId`, `systemPrompt` | string \| null | `systemPrompt: null` = use the preset's prompt |
| `params.*` | number \| null (`stop`: string[]) | sampling; `null` = don't send (Modelfile / server default, else per-model suggestion). Precedence: model profile suggestion < global `params` < preset `params` < chat `params` |
| `keepAlive` | a Go duration (`"30m"`, `"1h30m"`, `"-1m"`), a number of seconds (`-1` = forever, `0` = unload), or a numeric string (`"-1"`, `"30"`, `"0"`) | Ollama `keep_alive` for every request. Ollama rejects unit-less strings other than `"0"` (HTTP 400 "time: missing unit in duration"), so numeric strings are sent as numbers. Anything else → `400` |
| `context.mode` | `"auto" \| "max" \| integer ≥ 512` | see ContextPlan |
| `context.maxAuto` | int \| null | cap for auto mode |
| `context.lowRamCap` | int \| null | cap for auto mode on ≤ 8 GB machines (prompt processing of very long contexts is slow there); `null` disables |
| `context.useMeasurements` | bool | correct the RAM estimate from real Ollama `/api/ps` measurements of each model (see 3.5) |
| `context.kvCacheType` | `auto \| f16 \| q8_0 \| q4_0` | KV precision assumed in the RAM estimate; `auto` = what Harness gave the Ollama it started (`ollama.kvCacheType`, default `q8_0`), else `f16` (an Ollama Harness did not start: its settings are invisible — set this if you know them) |
| `context.memoryFraction` | 0.1–1 \| null | override the safe RAM budget fraction |
| `context.replyReserve` | int \| `"auto"` | auto = 15 % of the window (384–8192) |
| `reasoning.think` | `auto \| on \| off \| low \| medium \| high` | Ollama `think`. `on`/`low`/`medium`/`high` = think when the model has the `thinking` capability; `auto` (default) and `off` = no thinking. Ollama turns thinking **on** when `think` is omitted, so every request sends it explicitly (`false` unless enabled; internal title/summary/extraction calls always `false`) |
| `compaction.threshold` / `target` / `keepRecentFraction` | fractions of the prompt budget | compact when `used > threshold·budget`, aim for `target·budget`, keep at most `keepRecentFraction·budget` verbatim (≥ `minKeepMessages`) |
| `compaction.maxSummaryTokens` | int \| `"auto"` | auto = 12 % of the window (192–3000) |
| `compaction.model`, `memory.model`, `titles.model` | ModelRef \| null | `null` = the chat model itself (default; no second LLM is ever loaded) |
| `memory.placement` | `turn \| system` | where retrieved (non-pinned) memories go: an ephemeral `<context>` block on the latest user message (keeps Ollama's prompt cache valid) or the system prompt |
| `memory.maxTokens`, `recall.maxTokens`, `documents.maxTokens` | int \| `"auto"` | auto = 5 % (96–1500) / 4 % (≤ 800) / 20 % (256–16000) of the window |
| `memory.minSimilarity`, `recall.minSimilarity` | 0–1 | cosine threshold when embeddings are available |
| `embeddings.model` | `"auto" \| "off" \| ModelRef` | auto = first installed embedding model (embeddinggemma, nomic-embed-text, …); **on ≤ 8 GB auto = off (BM25 only)** — set a ModelRef to opt in |
| `documents.inlineMaxTokens` | int \| `"auto"` | auto = 25 % of the window (512–32000) |
| `documents.maxHistoryImages` | int | only the last N image-bearing user messages re-send their images |
| `tools.builtin.*` | bool | per-tool enable flags (`fetch_url` is the only tool that touches the network; off by default) |
| `tools.fetchUrl.allowPrivateNetwork` | bool | allow `fetch_url` to reach localhost/LAN |
| `providers.builtin.ollama.baseUrl` | URL \| null | `null` = `$OLLAMA_HOST` or `http://127.0.0.1:11434` |
| `providers.autodetect` | bool | probe llama.cpp/MLX (`:8080`) and LM Studio (`:1234`); only running ones are listed |
| `ollama.*` | | how Harness launches `ollama serve` itself: `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1` on ≤ 8 GB (`maxLoadedModels: "auto"`), `OLLAMA_NO_CLOUD=1` (`noCloud`), and `LLAMA_ARG_CACHE_RAM` — the runner's host-RAM prompt cache cap in MiB (`promptCacheMiB`: `"auto"` = 512 on ≤ 8 GB, 2048 on ≤ 16 GB, unset above (runner default 8192); a number; `null` = unset). `extraEnv` adds `OLLAMA_*` (or `LLAMA_ARG_CACHE_RAM`) variables. None of this applies to an Ollama Harness did not start — `GET /api/system` → `ollama.protections` says so |
| `image.unloadChatModel` | `auto \| always \| never` | unload Ollama models before generating an image; auto = always on ≤ 8 GB, else when loaded models + image model > 70 % of RAM |
| `image.reloadAfter` | `lazy \| eager` | lazy = reload on the next chat request (forced on ≤ 8 GB) |
| `image.feedbackToModel` | bool | after `generate_image`, show the image to a vision-capable chat model |
| `image.comfyWorkflow` | object \| null | ComfyUI API-format workflow with `{{prompt}} {{negative_prompt}} {{seed}} {{steps}} {{cfg}} {{width}} {{height}} {{count}} {{model}} {{sampler}} {{scheduler}} {{denoise}} {{image}}` placeholders (whole-string numeric placeholders become numbers) |
| `security.allowedOrigins` | origin strings (≤ 20) | extra browser origins allowed to call the API with CORS (e.g. `http://localhost:5173`); the app's own origin is always allowed |
| `ui` | any object < 64 KB | free-form pass-through for the UI (theme, font size, …) |

**ChatSettings** (`chat.settings`, all optional): `model`, `presetId`, `systemPrompt`, `params`, `keepAlive`, `context: {mode}`, `reasoning: {think}`, `tools: {enabled, builtin}`, `compaction: {enabled}`, `memory: {enabled}`, `recall: {enabled}`. Incognito is the chat-level flag `incognito` (no memory read/write, no recall indexing, excluded from recall).

### 3.10 Preset

```json
{ "id": "default", "name": "Assistant", "description": "Helpful, accurate general assistant.", "systemPrompt": "You are Harness, …", "params": {}, "builtin": true }
```

Built-ins: `default` (Assistant), `concise`, `coder`, `writer`, `tutor`. User presets also have `icon`, `createdAt`, `updatedAt`. Preset `params` accept only the sampling keys of `settings.params` (`num_ctx`, `keep_alive` and unknown keys → `400`; stored presets are cleaned on load) — the context window and keep-alive are always Harness's.

### 3.11 ModelInfo (`GET /api/models/info`)

```json
{
  "model": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL", "displayName": "NVIDIA-Nemotron-3.5-Bolt-E4B", "providerId": "ollama",
  "sizeBytes": 5211422720, "digest": "sha256:…", "family": "gemma4", "parameterSize": "7.52B", "quantization": "Q3_K_M",
  "capabilities": ["tools", "completion", "vision", "audio"],
  "contextLength": 65536, "contextLengthSource": "override", "advertisedContextLength": 131072,
  "contextNote": "Nemotron 3.5 Bolt E4B is trained for 64K tokens; its metadata advertises 128K.",
  "modelfileParameters": { "stop": ["<bos>", "<|turn>", "<turn|>", "<|turn>user"] },
  "metadataSampling": { "temperature": 1, "top_k": 64, "top_p": 0.95 },
  "profile": { "id": "nemotron-bolt", "family": "gemma4", "sampling": { "temperature": 1, "top_p": 0.95, "top_k": 64 }, "imageTokens": 280, "swa": { "globalEvery": 6, "window": 512 }, "notes": "…" },
  "serverContext": null,
  "arch": { "name": "gemma4", "blockCount": 42, "embeddingLength": 2560, "headCount": 8, "headCountKv": 2, "keyLength": 512, "valueLength": 512, "keyLengthSwa": 256, "valueLengthSwa": 256, "slidingWindow": 512, "slidingWindowPattern": null, "sharedKvLayers": 18, "parameterCount": 7518069290 },
  "blobs": ["<64-hex weights digest>", "<64-hex projector digest>"], "hasProjector": true, "templateTrivial": false
}
```

`capabilities` ⊂ `completion, tools, thinking, vision, audio, embedding` (from Ollama `/api/show`; inferred for OpenAI-compatible servers). `serverContext` = context fixed by an OpenAI-compatible server. `metadataSampling` = the model file's own `general.sampling.*` suggestions (sent when neither the Modelfile, the user nor a preset sets a value; they beat the family profile). `blobs` = the Modelfile's `FROM` layers (first = weights; more = vision/audio projector, draft model); `hasProjector` = ≥ 2 layers or `vision`/`audio` capability. Note that the as-pulled Nemotron GGUF lists no `thinking` capability (Harness then never sends `think: true`); its text-only copy does.

## 4. Chat generation stream (SSE)

Produced by `POST /api/chats/:id/messages`, `…/messages/:mid/regenerate`, `…/messages/:mid/edit` (user messages). Typical orders:

```
plain:      start > [retrieval] > [compaction(started) > compaction(completed|failed)] > [notice…] > context > reasoning… > token… > stats > done
with tools: start > context > stats > message(assistant w/ toolCalls) > tool_call > [memory | image_* …] > tool_result > message(new assistant) > context > [model_status…] > token… > stats > done
failure:    start > … > error            (exactly one of done / error ends every stream)
```

| event | payload | when |
|---|---|---|
| `start` | `generationId, chatId, userMessage` (Message or `null` for regenerate), `assistantMessage` (placeholder, `status:"streaming"`), `model: {providerId, model, displayName, capabilities}`, `contextPlan` | first |
| `retrieval` | `pinnedMemories: [{id, content}]`, `memories: [{id, content, score}]`, `documents: [{attachmentId, name, part, of, score}]`, `recall: [{chatId, chatTitle, date, score}]` | when anything was injected ("used 2 memories · 3 excerpts") |
| `compaction` | `status: "started"` + `messages, tokens, keptMessages, usedBefore, threshold` · `"completed"` + `summary` (Summary), `messages, calls, usedBefore, usedAfter` · `"failed"` + `error, fallback: "truncate"` | auto-summarizer ran ("Summarizing earlier messages…") |
| `notice` | `code, message` (+ details). Codes: `context_truncated` (`droppedMessages, truncatedMessages`), `tools_unsupported`, `thinking_unsupported` (only when thinking was requested), `pinned_memories_large`, ContextPlan warning codes (`model_exceeds_budget`, `exceeds_budget`, `measured_exceeds_budget`, `cpu_offload`, `memory_pressure`, `model_too_big`, … — each **once per chat and model**: they stay in `start.contextPlan.warnings` on every turn, show those persistently), and after the turn's first model call, when the measured footprint is bad: `measured_exceeds_budget` (`measuredBytes, budgetBytes, numCtx, nextNumCtx`) / `cpu_offload` (`totalBytes, vramBytes, cpuBytes, numCtx, nextNumCtx`) / `memory_pressure` (`numCtx, nextNumCtx, pressure`: "Loading X at 16K made macOS swap (+658 MB swap, +1.0 GB compressed). From the next message the context window will be 8K …") / `model_too_big` (`numCtx, smallerModel, pressure`) — not repeated when the turn's plan already carried that warning; always before `done` | non-fatal info for a toast |
| `context` | ContextUsage + `summaryId`, `messageId`, and on the first one `contextPlan: {numCtx, limitedBy, explanation}` | before each model call |
| `model_status` | `phase: "waiting"` + `reason: "image_job"\|"model_in_use", message` (≤ 8 GB: an image job holds the RAM; abortable) · `phase: "loading"` + `reason: "not_loaded"\|"context_change", model, numCtx, message` ("Loading qwen3:4b…" / "Reloading qwen3:4b with a 4K context…"), or + `models, reason: "reload_after_image", message`, and while it lasts `phase: "loading"` + `elapsedMs, message` · `phase: "evaluating"` + `elapsedMs, promptTokens, message` ("Reading the prompt (~3020 tokens)… 6 s"; after 1.5 s without output, then every 5 s) · `phase: "ready"` + `reason: "loaded"\|"prompt_read"\|"ram_available"`, `elapsedMs` (output started / RAM granted; plain `ready` after an image reload) · `phase: "loaded"` + `model, loadMs` (after the call: Ollama's real `load_duration`) | honest progress before the first token: Ollama sends nothing until then. A warm model with a short prompt emits none. Additive — ignore unknown phases |
| `reasoning` | `messageId, delta` | thinking text |
| `token` | `messageId, delta` | answer text |
| `stats` | `messageId, iteration, promptTokens, cachedPromptTokens, completionTokens, tokensPerSecond, promptTokensPerSecond, promptMs, evalMs, loadMs, totalMs, contextUsed, numCtx` | after each model call (real backend numbers; `cachedPromptTokens`: how much of the prompt Ollama's prompt cache reused — "3015 of 3023 tokens reused" — or `null`) |
| `message` | `message` (Message) | an assistant step finished with tool calls, or a new assistant step started after tool results |
| `tool_call` | `messageId` (assistant), `toolMessageId` (tool message that will hold the result), `toolCall: {id, name, arguments}` | before a tool runs |
| `tool_result` | `message` (tool Message), `toolCallId, name, content, isError, data, images: ImageRef[], durationMs` | after a tool ran |
| `memory` | `action: "added"\|"updated"\|"unchanged", memory, origin: "tool"` (`memory.needsReview: true` when the turn contained untrusted text) | `remember` tool saved something |
| `image_job` · `image_status` · `image_progress` · `image` · `image_done` · `image_error` | as in 5.11, plus `toolCallId, messageId` (assistant that called the tool), `toolMessageId` | `generate_image` tool running — render the image inline in the assistant turn |
| `done` | `generationId, reason: "stop"\|"length"\|"aborted"\|"tool_limit"`, `message` (final assistant Message; `fallback` set when Harness wrote it, see 3.2), `createdMessageIds`, `chat` (ChatSummary), `context`, `stats` | last — the chat is already free and the turn saved |
| `error` | `code, message, messageId, generationId`, `nextSteps?` (e.g. `model_load_failed`: "… could not be loaded: Ollama's model runner stopped while starting it (llama-server process has terminated: signal: abort trap). This happens when the image/audio part of a model (its projector) cannot start on this Mac's GPU. Next step: create a text-only copy …") | last (assistant message stored with `status:"error"`, `errorCode`, `nextSteps`) |

Captured example (`send_basic`, abridged):

```
event: start
data: {"type":"start","generationId":"gen_0mwin8llr003212e1a2","chatId":"chat_0mwin8lli00a2ed553e","userMessage":{"id":"msg_0mwin8llp007a853b49","parentId":null,"role":"user","content":"Hello! My name is Ada.","attachments":[],"createdAt":"2026-11-16T02:27:48.445Z","status":"complete"},"assistantMessage":{"id":"msg_0mwin8llr0166b1e45c","parentId":"msg_0mwin8llp007a853b49","role":"assistant","content":"","reasoning":"","status":"streaming","model":{"providerId":"ollama","model":"nemotron-3.5-bolt:e4b"},"createdAt":"2026-11-16T02:27:48.447Z"},"model":{"providerId":"ollama","model":"nemotron-3.5-bolt:e4b","displayName":"NVIDIA Nemotron 3.5 Bolt E4B","capabilities":["completion","tools","thinking","vision"]},"contextPlan":{ …ContextPlan… }}

event: context
data: {"type":"context","numCtx":65536,"budget":57344,"replyReserve":8192,"compactAt":43008,"used":1049,"percent":1.6,"breakdown":{"system":84,"tools":954,"memories":0,"summary":0,"documents":0,"recall":0,"history":11},"estimated":true,"calibration":1,"summaryId":null,"messageId":"msg_0mwin8llr0166b1e45c","contextPlan":{"numCtx":65536,"limitedBy":"model","explanation":"64K of 64K context (model max); est. 7.9 GB of 15.7 GB RAM (safe budget 11.7 GB)."}}

event: reasoning
data: {"type":"reasoning","messageId":"msg_0mwin8llr0166b1e45c","delta":"Thinking "}

event: token
data: {"type":"token","messageId":"msg_0mwin8llr0166b1e45c","delta":"You sai"}

event: stats
data: {"type":"stats","messageId":"msg_0mwin8llr0166b1e45c","iteration":0,"promptTokens":1045,"completionTokens":20,"tokensPerSecond":266.7,"promptTokensPerSecond":26125,"promptMs":40,"evalMs":75,"loadMs":5,"totalMs":120,"contextUsed":1065,"numCtx":65536}

event: done
data: {"type":"done","generationId":"gen_0mwin8llr003212e1a2","reason":"stop","message":{"id":"msg_0mwin8llr0166b1e45c", …,"content":"You said: Hello! My name is Ada.","reasoning":"Thinking about: Hello! My name is Ada.","status":"complete", …},"createdMessageIds":["msg_0mwin8llr0166b1e45c"],"chat":{ …ChatSummary… },"context":{ …ContextUsage…, "actual":{"promptTokens":1045,"completionTokens":20,"used":1065}},"stats":{"durationMs":43,"iterations":1,"toolCalls":0,"promptTokens":1045,"completionTokens":20,"tokensPerSecond":266.7,"loadMs":5}}
```

Tool example (`calculate 17*23`, abridged):

```
event: message
data: {"type":"message","message":{"id":"msg_0mwin8lo002edfa257f","role":"assistant","content":"","status":"complete","toolCalls":[{"id":"call_0mwin8lo5003288446d","name":"calculate","arguments":{"expression":"17*23"}}], …}}

event: tool_call
data: {"type":"tool_call","messageId":"msg_0mwin8lo002edfa257f","toolMessageId":"msg_0mwin8lo501bb04ba0b","toolCall":{"id":"call_0mwin8lo5003288446d","name":"calculate","arguments":{"expression":"17*23"}}}

event: tool_result
data: {"type":"tool_result","message":{"id":"msg_0mwin8lo501bb04ba0b","parentId":"msg_0mwin8lo002edfa257f","role":"tool","toolCallId":"call_0mwin8lo5003288446d","toolName":"calculate","content":"17*23 = 391","status":"complete","isError":false,"data":{"value":391},"durationMs":1, …},"toolCallId":"call_0mwin8lo5003288446d","name":"calculate","content":"17*23 = 391","isError":false,"data":{"value":391},"images":[],"durationMs":1}

event: message
data: {"type":"message","message":{"id":"msg_0mwin8lo600dfc1897e","parentId":"msg_0mwin8lo501bb04ba0b","role":"assistant","content":"","status":"streaming", …}}

event: token
data: {"type":"token","messageId":"msg_0mwin8lo600dfc1897e","delta":"Tool ca"}
```

Image-tool example (`draw a red fox curled up in the snow`, abridged — note `messageId` = assistant step, `toolMessageId` = tool message that stores the image):

```
event: tool_call
data: {"type":"tool_call","messageId":"msg_0mwin8r99004d37cc38","toolMessageId":"msg_0mwin8r9g002f71c194","toolCall":{"id":"call_0mwin8r9f00ce81e93d","name":"generate_image","arguments":{"prompt":"a red fox curled up in the snow","aspect":"square"}}}

event: image_status
data: {"type":"image_status","jobId":"imgjob_0mwin8r9g01e02e197b","phase":"generating","message":"Generating 1 image (512×512, 2 steps)…","toolCallId":"call_0mwin8r9f00ce81e93d","messageId":"msg_0mwin8r99004d37cc38","toolMessageId":"msg_0mwin8r9g002f71c194"}

event: image
data: {"type":"image","jobId":"imgjob_0mwin8r9g01e02e197b","image":{ …ImageRecord…, "url":"/api/images/img_0mwin8rq7004d73fdbf/file"},"index":0,"toolCallId":"call_0mwin8r9f00ce81e93d","messageId":"msg_0mwin8r99004d37cc38","toolMessageId":"msg_0mwin8r9g002f71c194"}

event: tool_result
data: {"type":"tool_result","message":{ …tool Message with "images":[ImageRef]… },"toolCallId":"call_0mwin8r9f00ce81e93d","name":"generate_image","content":"Generated 1 image (512×512, seed 1705184204, model sd_turbo.safetensors [a1b2c3]). It is now shown to the user.","isError":false,"data":{"jobId":"imgjob_0mwin8r9g01e02e197b","imageIds":["img_0mwin8rq7004d73fdbf"]},"images":[{"id":"img_0mwin8rq7004d73fdbf","url":"/api/images/img_0mwin8rq7004d73fdbf/file","width":512,"height":512,"mime":"image/png","prompt":"a red fox curled up in the snow","seed":1705184204,"model":"sd_turbo.safetensors [a1b2c3]","providerId":"a1111"}],"durationMs":605}
```

On an 8 GB Mac the same stream additionally contains `image_status` phases `unloading` → `unloaded` before `generating`, and `model_status` `loading` → `ready` before the final answer tokens.

**Tools and untrusted text.** Text from fetched pages, attached files and documents, and recalled chats reaches the model inside `<untrusted_data source="…">` / `<file …>` blocks (closing tags inside are neutralised) with an instruction never to follow instructions found there. `fetch_url` opens only URLs the user wrote in this conversation (`tool_result.data.blocked: "not_user_supplied"` otherwise) and never private/loopback/link-local addresses (also via IPv4-mapped IPv6, NAT64, DNS answers — the vetted address is the one connected to), unless `tools.fetchUrl.allowPrivateNetwork`. An empty final answer after tool results is not an error: see `fallback` (3.2).

## 5. Routes

Notation: `→ 200 {…}` is the JSON response. All bodies are JSON unless stated.

### 5.1 System & events

| | |
|---|---|
| `GET /api/health` | → `{ "ok": true, "name": "harness", "version": "0.1.0" }` |
| `GET /api/system[?refresh=1]` | → system info (below) |
| `GET /api/events` | SSE stream of background events (section 6) |

`GET /api/system` →

```json
{
  "app": { "name": "harness", "version": "0.1.0", "node": "v22.23.4", "pid": 3484, "dataDir": "/…/Harness", "startedAt": "…", "uptimeSec": 3, "url": "http://127.0.0.1:4747" },
  "machine": { "platform": "darwin", "arch": "arm64", "release": "…", "chip": "Apple M1", "cpus": 8, "appleSilicon": true,
               "totalMemBytes": 8589934592, "freeMemBytes": 123, "ramTier": "low",
               "memoryBudget": { "budgetBytes": 5100273664, "fraction": 0.594, "osReserveBytes": 3489660928, "tier": "low", "source": "apple-silicon" } },
  "providers": [ /* ProviderStatus (5.3); the Ollama entry also has "process" */ ],
  "loadedModels": [ { "providerId": "ollama", "model": "nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl", "name": "…", "sizeBytes": 94371840, "vramBytes": 94371840, "expiresAt": "…", "contextLength": 16384, "digest": "…",
                      "residentBytes": 4617089843, "residentBasis": "measured" } ],
  "ollama": { "installed": true, "binaryPath": "/opt/homebrew/bin/ollama", "managed": true, "pid": 4711,
              "env": { "OLLAMA_HOST": "127.0.0.1:11434", "OLLAMA_NUM_PARALLEL": "1", "OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_MAX_LOADED_MODELS": "1", "OLLAMA_NO_CLOUD": "1", "LLAMA_ARG_CACHE_RAM": "512" },
              "recommendedEnv": { "…": "the same, as Harness would start it now" },
              "lastError": null, "logTail": [],
              "protections": { "inEffect": true, "env": { "…": "…" }, "wanted": { "…": "…" },
                               "message": "Harness started this Ollama with: flash attention (OLLAMA_FLASH_ATTENTION=1), q8_0 KV cache (OLLAMA_KV_CACHE_TYPE=q8_0), one model in memory at a time (OLLAMA_MAX_LOADED_MODELS=1), no cloud features (OLLAMA_NO_CLOUD=1), prompt cache capped at 512 MiB (LLAMA_ARG_CACHE_RAM=512)." } },
  "imageProviders": [ /* ImageProviderStatus (5.11) */ ],
  "embeddings": { /* GET /api/embeddings/status */ },
  "modelState": { "unloadedForImage": false, "models": [], "since": null },
  "background": { "running": null, "pending": [ { "key": "memory:chat_…", "label": "memory_extraction", "dueInMs": 0, "blockedBy": "foreground_generation" } ] },
  "generations": [ { "chatId": "chat_…", "generationId": "gen_…", "assistantMessageId": "msg_…", "startedAt": "…" } ],
  "imageJobs": { "active": 0, "recent": [ /* ImageJob */ ] }
}
```

`background.pending[].blockedBy`: `foreground_generation | image_job | model_unloaded_for_image | null`. `ollama.managed`: Harness spawned `ollama serve` itself (`env` = the variables it used).

* `loadedModels[].sizeBytes`/`vramBytes` are Ollama's `/api/ps` `size`/`size_vram`, which on current Ollama **exclude the weights** — show `residentBytes` instead (`residentBasis`: `measured` = the latest real measurement at this context, `file+ps` = model file + ps size, `ps` = ps size only, when the file size is unknown).
* `ollama.protections`: `{ inEffect, env, wanted, message, external? }`. `inEffect: false` + `external: true` = an Ollama Harness did not start is in use, so none of `wanted` applies: `"This Ollama was not started by Harness, so its memory protections are not in effect (…). To get them, quit the other Ollama (menu bar → Quit Ollama, or stop `ollama serve`) and restart Harness so it starts its own."`; with Ollama not running: `"Ollama is not running; when Harness starts it, it applies: …"`.

### 5.2 Settings & presets

| | |
|---|---|
| `GET /api/settings` | → `{ settings, defaults }` |
| `PATCH /api/settings` | body: partial Settings (deep-merged; arrays replace) → `{ settings }`; invalid → `400 bad_request` with the offending path, e.g. `"context.mode must be 'auto', 'max' or an integer token count >= 512"`; unknown keys → `"Unknown setting nope"` |
| `POST /api/settings/reset` | → `{ settings }` (defaults) |
| `GET /api/presets` | → `{ presets: Preset[] }` (built-ins first) |
| `POST /api/presets` | `{ name, systemPrompt, description?, params?, icon? }` → `201 { preset }` |
| `PATCH /api/presets/:id` | partial → `{ preset }`; built-ins → `403 read_only` |
| `DELETE /api/presets/:id` | → `{ ok: true }` |

### 5.3 Providers

**ProviderStatus**:

```json
{ "id": "llamacpp", "kind": "openai", "name": "llama.cpp / MLX (8080)", "baseUrl": "http://127.0.0.1:8080", "builtin": true, "autodetected": true,
  "flavor": "llamacpp", "status": "running", "version": null, "error": null,
  "capabilities": { "setContext": false, "pull": false, "delete": false, "unload": false, "embeddings": true } }
```

`kind`: `ollama | openai`. `status`: `running | unreachable` (auto-detected servers are only listed while running; Ollama is always listed). `flavor` (openai): `llamacpp | lmstudio | generic`. Built-in ids: `ollama`, `llamacpp` (port 8080 — llama-server or MLX-LM), `lmstudio` (1234).

| | |
|---|---|
| `GET /api/providers[?refresh=1]` | → `{ providers: ProviderStatus[] }` |
| `POST /api/providers/refresh` | re-probe → `{ providers }` |
| `POST /api/providers` | `{ name, kind: "openai"\|"ollama", baseUrl, apiKey?, enabled? }` (a trailing `/v1` is fine) → `201 { provider }` |
| `PATCH /api/providers/:id` | built-ins: `{ baseUrl?, enabled? }`; custom: `{ name?, baseUrl?, apiKey?, enabled?, kind? }` → `{ providers }` |
| `DELETE /api/providers/:id` | custom only → `{ ok: true }` |
| `POST /api/providers/ollama/start` | spawn `ollama serve` if installed and not running → `{ started: true, managed: true, pid, version, env }` or `{ started: false, alreadyRunning: true, … }`; not installed → `404 not_installed`; timeout → `500 start_timeout` (`details.logTail`) |
| `POST /api/providers/ollama/stop` | stops only an Ollama that Harness started → `{ stopped: true\|false }` |

Harness auto-starts an installed-but-stopped Ollama at boot (`settings.ollama.autoStart`) and stops it on exit (`stopOnExit`).

### 5.4 Models

| | |
|---|---|
| `GET /api/models[?refresh=1][&details=1]` | → `{ models: ModelListItem[], defaultModel: ModelRef\|null }` |
| `GET /api/models/info?model=…[&providerId=…][&refresh=1]` | → `{ info: ModelInfo, contextPlan, budgets, suggestedParams }` |
| `GET /api/models/context?model=…[&providerId=…][&mode=auto\|max\|<n>]` | → `{ contextPlan, budgets }` — use to preview "what would max cost?" |
| `GET /api/models/recommended` | → curated list with fit estimates for this machine (below) |
| `POST /api/models/pull` | `{ model, providerId? }` → **SSE** (below) |
| `DELETE /api/models?model=…[&providerId=…]` | → `{ ok: true }` |
| `POST /api/models/load` | `{ model, providerId? }` preload with the planned `num_ctx` → `{ ok: true, numCtx }`; the runner crashed while loading → `502 model_load_failed` with `details.nextSteps` |
| `POST /api/models/unload` | `{ model, providerId? }` (`keep_alive: 0`) → `{ ok: true }` |
| `GET /api/models/loaded` | → `{ models: [{providerId, model, name, sizeBytes, vramBytes, expiresAt, contextLength, digest, residentBytes, residentBasis}], modelState }` (see 5.1: show `residentBytes`) |
| `GET /api/models/measurements?model=…[&providerId=…]` | memory measurements of a model → `{ providerId, model, kvCacheType, stale, samples: [Sample], validSamples, loadedNumCtx, measurement, basis }` (`stale`: recorded for a different build; `loadedNumCtx`: the `num_ctx` it is currently loaded with, or `null`). Sample: `{ numCtx, sentNumCtx, reportedContext, totalBytes, source: "rss"\|"ps", rssBytes, psSizeBytes, psVramBytes, vramBytes, cpuBytes, pressure: {swapDeltaBytes, compressedDeltaBytes, level, swapUsedBytes, compressedBytes, signal}\|null, loaded, kvCacheType, at }` (`loaded`: that request (re)loaded the model; `pressure` only then) |
| `GET /api/models/text-only` | text-only copies Harness created → `{ copies: [{ key, source, digest, templateSource, createdAt }] }` |
| `POST /api/models/text-only` | `{ model, providerId?, name? }` — make a **text-only copy** of an installed multimodal Ollama model (same weights blob, no vision/audio projector: ~1 GB less RAM, no download, ~2 s) → `201 { model, providerId, source, created: true, digest, template: "modelfile"\|"none", capabilities, sizeBytes, sourceSizeBytes, note }`; already there → `200 {… created: false}`. Default name `<repo>-text:<tag>` in lower case (`hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL` → `nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl`). `400 not_multimodal` (already text-only), `409 name_taken`, `422 no_model_blob`. Deleting the original afterwards frees the projector's disk space; the copy keeps the weights |
| `DELETE /api/models/text-only?model=…[&providerId=…]` | delete a copy Harness created → `{ ok: true }`; any other model → `404` |
| `DELETE /api/models/measurements?model=…[&providerId=…]` | forget them (plans go back to the estimate) → `{ ok: true, removed }` |
| `GET /api/embeddings/status` | → EmbeddingsStatus (below) |

ModelListItem: `{ providerId, providerName, model, name, sizeBytes, digest, modifiedAt, family, families, parameterSize, quantization, format, embedding, loaded }` + with `details=1`: `capabilities`, `contextLength`.

`budgets` (derived from `numCtx`, all fractions of the window): `{ numCtx, replyReserve, input, compactAt, compactTarget, keepRecentTokens, maxSummaryTokens, memories, recall, documents, inlineFileMax }`.

`suggestedParams`: the profile sampling values that would be sent (keys already set in the Modelfile are left to Ollama).

`GET /api/models/recommended` → (8 GB machine, abridged)

```json
{
  "machine": { "totalMemBytes": 8589934592, "ramTier": "low", "budgetBytes": 5100273664, "kvCacheType": "q8_0" },
  "models": [
    {
      "id": "nemotron-3.5-bolt-e4b", "name": "NVIDIA Nemotron 3.5 Bolt E4B",
      "description": "Fast Gemma-4-based model tuned for multi-turn tool use. Real context 64K.",
      "tags": ["recommended", "tools", "thinking", "fast"], "contextLength": 65536, "family": "gemma4",
      "textOnly": { "supported": true, "recommendedOnLowRam": true },
      "variants": [
        { "model": "nemotron-3.5-bolt:e4b", "label": "Official (vision + audio + draft model)", "approxSizeBytes": 7908810112,
          "modelLayerBytes": 6180446208, "projectorBytes": 991551808, "draftBytes": 736812096, "textOnlyBytes": 6180446208,
          "note": "7.9 GB download: the model plus a vision/audio projector and a speculative-decoding draft model. Not usable on 8 GB.",
          "installed": false, "providerId": null, "notForThisMachine": true,
          "estimate": { "numCtx": 2048, "estimatedTotalBytes": …, "fits": false, "limitedBy": "memory", "explanation": "7.9 GB download: … Not usable on 8 GB. As a text-only copy (…): The model alone (5.8 GB) exceeds …", "basis": "text_only_copy" },
          "textOnly": { "model": "nemotron-3.5-bolt-text:e4b", "approxSizeBytes": 6180446208, "installed": false, "recommended": true, "estimate": { … } },
          "asPulledEstimate": { … } },
        { "model": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL", "label": "UD-Q3_K_XL (GGUF)", "approxSizeBytes": 5211422720,
          "modelLayerBytes": 4219469824, "projectorBytes": 991952896, "textOnlyBytes": 4219469824, "lowRam": "largest_realistic",
          "note": "Largest that is realistic on 8 GB, as a text-only copy (4.0 GB): runs, but leaves almost nothing for macOS and other apps.",
          "installed": true, "providerId": "ollama",
          "estimate": { "numCtx": 16384, "fits": true, "limitedBy": "low_ram_cap", "basis": "text_only_copy", "explanation": "Largest that is realistic on 8 GB, as a text-only copy (4.0 GB): … As a text-only copy (no image/audio input, 3.9 GB): 16K of 64K context — capped for responsiveness …" },
          "textOnly": { "model": "nvidia-nemotron-3.5-bolt-e4b-text:ud-q3_k_xl", "approxSizeBytes": 4219469824, "installed": false, "recommended": true, "estimate": { … } },
          "asPulledEstimate": { "numCtx": 2048, "fits": false, … } },
        { "model": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-IQ3_XXS", "label": "UD-IQ3_XXS (GGUF)", "lowRam": "comfortable", "…": "…" }
      ],
      "avoid": [ { "model": "nemotron-3.5-bolt:latest", "reason": "A different, 22 GB model — not the E4B." }, { "model": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q3_K_XL", "reason": "Alias without \"UD-\": …" } ],
      "suggestedVariant": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-IQ3_XXS",
      "largestRealisticVariant": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL",
      "suggestTextOnly": true,
      "lowRamNote": "On an 8 GB Mac use a text-only copy. UD-Q3_K_XL (4.0 GB) is the largest that is realistic: it runs, but leaves almost nothing for macOS and an app window (measured ≈4.3 GB resident at 2–4K context on a 7 GB Mac that was already swapping). UD-IQ3_XXS or UD-Q2_K_XL (≈3.5 GB) are the comfortable choice, with a small quality trade-off.",
      "installed": true, "fitsThisMachine": true
    }
  ],
  "embedding": [ { "id": "embeddinggemma", "name": "EmbeddingGemma 300M", "model": "embeddinggemma", "approxSizeBytes": 620000000, "description": "…", "installed": false } ],
  "note": "Sizes are download sizes as pulled; the fit estimate uses architecture hints until the model is installed, then real measurements."
}
```

* Nemotron variants are the real files: the official tag (7.9 GB incl. projector and draft model) and the Hugging Face `UD-*` quants (layer sizes from the registry; each also pulls a 946 MiB projector). `Q3_K_M`/`Q4_K_M` do not exist, and the non-`UD-` aliases (`Q3_K_XL` …) do not download — they are in `avoid`, never offered; pulling an avoided tag adds a `warning` to the pull's `start` event.
* `estimate` describes **the recommended way to run that file on this machine**: on ≤ 8 GB that is its text-only copy (`estimate.basis: "text_only_copy"`, the as-pulled numbers in `asPulledEstimate`). `textOnly` (per variant): the copy's name/size, whether it is installed, whether it is recommended here, and its own estimate. `lowRam`: `largest_realistic` | `comfortable`. `notForThisMachine`: needs more RAM than this machine has. `installed` is also true when the recommended text-only copy is installed.
* `suggestedVariant`: on ≤ 8 GB with `lowRamNote` the comfortable choice (`largestRealisticVariant` = the biggest that is realistic; `suggestTextOnly: true` → after pulling, `POST /api/models/text-only {model}`); otherwise the largest variant that fits with ≥ 8K context (else ≥ 4K, else the smallest). Pull it with `POST /api/models/pull {"model": suggestedVariant}`.
* The automatic default chat model (`settings.defaultModel: null`, `GET /api/models` → `defaultModel`) is the installed model that best fits: catalog order (on ≤ 8 GB a text-only copy before its original), then other installed models; the first whose plan fits the safe budget. Only when nothing fits is a non-fitting one used — its plan then carries `model_exceeds_budget`.

Pull stream events: `start {pullId, providerId, model, warning?: {code: "not_recommended", message}}` → `progress {pullId, status, digest, total, completed, percent}` (many; `percent` is `null` for steps without byte counts, e.g. `"pulling manifest"`, `"verifying sha256 digest"`) → `done {pullId, providerId, model, status: "success"}` or `error {pullId, code, message}`: `model_not_found` (`pull model manifest: file does not exist`, or `file does not exist` at the end of a Hugging Face pull), `registry_unreachable` (offline / DNS / TLS: "Could not download X: Ollama cannot reach the model registry …"), `aborted`. Closing the connection cancels the pull.

EmbeddingsStatus:

```json
{ "enabled": true, "available": true, "providerId": "ollama", "model": "embeddinggemma:latest", "reason": null, "retrieval": "hybrid",
  "candidates": [ { "providerId": "ollama", "model": "embeddinggemma:latest", "sizeBytes": 620000000 } ],
  "suggestion": null, "lowRamNote": null, "lastError": null }
```

`reason` when disabled: `disabled | none_installed | low_ram_opt_in | provider_not_found`. `retrieval`: `hybrid` (embeddings + BM25) | `bm25`. `suggestion`: a model to offer pulling when none is installed. On ≤ 8 GB `lowRamNote` explains why embeddings are opt-in.

### 5.5 Chats

| | |
|---|---|
| `GET /api/chats[?archived=false\|true\|all][&q=title][&limit=200][&offset=0]` | → `{ total, chats: ChatSummary[] }` — pinned first, then most recently updated |
| `POST /api/chats` | `{ title?: string\|null, settings?: ChatSettings, incognito?: bool }` (body optional) → `201 ChatDetail` |
| `GET /api/chats/:id` | → ChatDetail |
| `PATCH /api/chats/:id` | `{ title?, pinned?, archived?, incognito?, settings? }` → ChatDetail. `settings` is deep-merged into the overrides; a `null` value removes that override (e.g. `{"settings":{"model":null}}`); `"settings": null` clears all. Setting `title` sets `titleSource:"user"` |
| `DELETE /api/chats/:id[?deleteMemories=true]` | stops any generation and pending title/memory/recall work, deletes the chat, its recall index, and the attachments and images only this chat uses (files shared with a fork stay, now owned by the fork); with `deleteMemories=true` also the memories extracted from it → `{ ok: true, removed: { attachments, images, memories } }`. A save that was in flight can never bring a deleted chat back |
| `POST /api/chats/:id/title` | regenerate the title now → `{ title, chat }` |
| `POST /api/chats/:id/fork` | `{ messageId? }` (default active leaf) → `201 ChatDetail` of a new chat containing the path up to that message (summaries carried over) |
| `GET /api/chats/:id/context[?draft=text]` | context-meter preview for the active path (+ an optional draft message, incl. retrieval) → `{ context: ContextUsage + {needsCompaction, summaryId, truncation}, plan: ContextPlan, model: ModelRef }` |

### 5.6 Messages & generation

| | |
|---|---|
| `POST /api/chats/:id/messages` | `{ content, attachments?: [attachmentId], parentId?, model?: ModelRef }` → **SSE** (section 4). `parentId` defaults to the active leaf (`null` = new root). `model` overrides the chat model for this turn only |
| `POST /api/chats/:id/messages/:mid/regenerate` | `{ model? }` → **SSE**. `:mid` may be any message of the turn (assistant, tool, or the user message); a new assistant sibling is created under the turn's user message. On an **image turn** (`kind: "image_request"`/`"image_result"`) it makes a new image instead (new random seed unless the request fixed one): the stream is the image stream of 5.11 plus `start` and a chat-style `done {generationId, reason, createdMessageIds, message, userMessage, chat, job, images}` |
| `POST /api/chats/:id/messages/:mid/edit` | user message: `{ content, attachments?, model?, generate?: true }` → **SSE** (a new sibling user message, `editedFrom: mid`, then a reply). With `generate: false` → `{ message, path }`. Assistant message: `{ content }` → `{ message, path }` (sibling with `edited: true`, no generation) |
| `DELETE /api/chats/:id/messages/:mid` | deletes the message **and its subtree** → `{ deleted: [ids], activeLeafId, path }` (summaries anchored in the subtree are dropped); `409 chat_busy` while the chat is generating |
| `POST /api/chats/:id/branch` | `{ messageId }` — switch branches: the active leaf becomes the deepest descendant of `messageId`, following the branch last viewed there → `{ activeLeafId, path, summary }` |
| `POST /api/chats/:id/stop` | → `{ stopped: true\|false }` (also stops chat-linked image jobs) |

Sibling navigation: for a message with `siblingIds.length > 1`, "next" = `POST /branch {messageId: siblingIds[i+1]}`, then re-fetch or use the returned `path`.

Only one generation per chat at a time (`409 chat_busy`); different chats can generate concurrently (Ollama serializes them unless `OLLAMA_NUM_PARALLEL > 1`).

### 5.7 Summary / compaction

| | |
|---|---|
| `GET /api/chats/:id/summary` | → `{ summary: Summary\|null, history: Summary[] (on the active path, oldest first), compactedMessageCount, enabled, lastError }` |
| `PUT /api/chats/:id/summary` | `{ content }` edit the active summary → `{ summary }` (`editedByUser: true`); none yet → `404 no_summary` |
| `DELETE /api/chats/:id/summary` | remove the active summary (the previous one, if any, becomes active) → `{ removed, summary }` |
| `POST /api/chats/:id/compact` | `{ keepRecentMessages? }` "compact now": summarize everything except a minimal recent tail → `{ summary, messagesSummarized, tokensBefore, keptMessages }`; `400 nothing_to_compact`; `409 chat_busy`. Synchronous (may take a while: show a spinner) |

Per-chat on/off: `PATCH /api/chats/:id {"settings":{"compaction":{"enabled":false}}}` (then the summary is ignored and only hard truncation applies).

### 5.8 Export, import, search

| | |
|---|---|
| `GET /api/chats/:id/export?format=markdown` | `text/markdown` download (active branch; tool calls/results quoted; images as `![prompt](/api/images/…/file)`; summary in a `<details>` block) |
| `GET /api/chats/:id/export?format=json[&embedImages=1]` | `{ format: "harness.chat", version: 1, exportedAt, chat: <full chat incl. all branches and summaries>, images?: {id: ImageRecord + base64} }` |
| `POST /api/chats/import` | body: a `harness.chat` export, a `harness.backup`, or `{ title?, messages: [{role, content}] }` (OpenAI style) → `201 { chats: ChatSummary[], skipped?: {chats} }`. Every chat and message gets a **new id** (references between them are remapped); the content is validated and repaired (non-string content coerced, unknown roles/fields dropped, orphans re-parented, cycles broken; unrepairable chats are skipped and counted). An imported title is kept (`titleSource: "import"`). A `harness.backup` here restores its chats **with their attachments and images** and answers `{ chats, ignored: ["memories","presets","settings"], restored, skipped }` — use `POST /api/restore` for the rest. Limit 512 MB |
| `GET /api/search?q=…[&limit=50]` | full-text over all messages (all branches) and titles; every term must match → `{ query, results: [{ chatId, chatTitle, messageId, role, snippet, highlights: [[start,end]], createdAt, onActivePath }] }` (`highlights` index into `snippet`; `messageId: null` for title-only hits). To open a hit off the active branch: `POST /branch {messageId}` |
| `GET /api/export` | full backup download: `{ format: "harness.backup", version: 2, exportedAt, settings, presets, memories, chats, attachments: [AttachmentRecord + base64], images: [ImageRecord + base64] }` |
| `POST /api/restore[?settings=skip\|safe\|full][&chats=][&attachments=][&images=][&memories=][&presets=]` | body: a `harness.backup` (v1 or v2). Restores everything selected (each flag defaults to `true`; `settings` defaults to `skip`) → `201 { restored: { chats, attachments, images, memories, presets, settings: "skipped"\|"safe"\|"full" }, skipped: { chats, attachments, images, memories, presets }, warnings: [string], chats: [chatId] }`. Nothing is overwritten: chats, attachments and images get new ids (message references follow), memories already present are skipped (restored ones have `origin: "restore"`), identical presets are skipped. `settings=safe` takes only harmless preferences — never providers, allowed origins, the Ollama binary/environment, image backends or network tools (`fetch_url`); `full` takes everything (only for your own backup) |

### 5.9 Memories

| | |
|---|---|
| `GET /api/memories[?q=][&category=][&pinned=true\|false][&limit=500][&offset=0]` | → `{ total, memories: Memory[], enabled, categories }` (pinned first, then most recently updated) |
| `POST /api/memories` | `{ content, category?, pinned?, dedupe?: true, allowSecret?: false }` → `201 { action: "added"\|"updated"\|"unchanged", memory, reason? }` — near-duplicates (see 3.6) update the existing memory. Content that looks like a secret → `422 secret_detected` ("… looks like a password …") unless `allowSecret: true` |
| `PATCH /api/memories/:id` | `{ content?, category?, pinned?, needsReview?: false, allowSecret? }` → `{ memory }` — `needsReview: false` (or any manual edit / pin) confirms a memory held for review; a new `content` that looks like a secret → `422 secret_detected` unless `allowSecret: true` |
| `DELETE /api/memories/:id` | → `{ ok: true }` |
| `DELETE /api/memories?confirm=true` | delete all → `{ deleted: n }` (without `confirm` → 400) |
| `POST /api/memories/search` | `{ query, k?: 10, minSimilarity? }` → `{ results: [{ memory, score, semantic: number\|null, lexical }], retrieval: "hybrid"\|"bm25", embeddingModel }` — a "what would be recalled?" tester |
| `POST /api/memories/extract` | `{ chatId, full?: false }` run extraction now (else it runs ~4 s after each turn in the background) → `{ added: Memory[], updated: Memory[], skipped: string[] }` |

Global on/off: `settings.memory.enabled`; per chat: `chat.settings.memory.enabled` or `incognito`. Secrets (API keys, passwords) are never stored automatically (3.6). Memories with `needsReview: true` are listed (show them for confirmation) but never used in prompts or `POST /api/memories/search` until confirmed. `POST /api/memories/extract` → `409 chat_busy` while the chat generates.

### 5.10 Attachments

| | |
|---|---|
| `POST /api/attachments?name=<filename>[&chatId=…]` | **raw file body** (`Content-Type` = the file's MIME type; `X-Filename` header also accepted, percent-encoded or plain). Max 50 MB → `201 { attachment }` |
| `GET /api/attachments/:id` | → `{ attachment }` |
| `GET /api/attachments/:id/content` | the original bytes: raster images inline (use as `<img src>`), anything else as a sandboxed download (3.7) |
| `GET /api/attachments/:id/text[?maxChars=200000]` | → `{ attachmentId, text, truncated, chars }` (text/PDF only) |
| `DELETE /api/attachments/:id` | → `{ ok: true }` |

Upload first, then send `attachments: [id, …]` (max 20) with the message. Upload example:

```js
await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}&chatId=${chatId}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
```

Images are only sent to models with the `vision` capability; otherwise the model sees `[Image attached: name (this model cannot see images)]`.

### 5.11 Image generation

**ImageProviderStatus**: `{ id, kind: "a1111"|"comfyui"|"openai", name, baseUrl, builtin, autodetected, status: "running"|"unreachable", version, currentModel, error, capabilities: {img2img, progress, models, negativePrompt, seed, steps, cfg, sampler} }`.
Built-ins (auto-detected, listed only while running): `a1111` — "Draw Things / A1111 (7860)" (Draw Things' HTTP API server, AUTOMATIC1111 `--api`, Forge); `comfyui` — "ComfyUI (8188)". OpenAI-compatible image servers (LocalAI, mflux-style) are added as custom providers.

| | |
|---|---|
| `GET /api/images/providers[?refresh=1]` | → `{ providers: ImageProviderStatus[], enabled }` |
| `POST /api/images/providers` | `{ name, kind, baseUrl, apiKey?, enabled?, workflow? }` (`workflow`: ComfyUI API workflow for this provider) → `201 { provider }` |
| `PATCH /api/images/providers/:id` | built-ins `{ baseUrl?, enabled? }`; custom `{ name?, baseUrl?, apiKey?, enabled?, workflow? }` → `{ providers }` |
| `DELETE /api/images/providers/:id` | custom only → `{ ok: true }` |
| `GET /api/images/models[?providerId=]` | → `{ providerId, models: [{ id, name, current }] }` (A1111: `/sdapi/v1/sd-models`; ComfyUI: checkpoints) |
| `GET /api/images/defaults[?model=][&aspect=]` | resolved defaults for this machine → `{ params: {negativePrompt, width, height, steps, cfg, count, sampler, scheduler, model, denoise}, family, warnings, aspects, families }` |
| `POST /api/images/generate` | ImageRequest (below) → **SSE** (default) or JSON with `"stream": false` |
| `GET /api/images/jobs` | → `{ jobs: ImageJob[] }` (latest 50) |
| `POST /api/images/jobs/:id/cancel` | → `{ job }` (also interrupts the backend) |
| `GET /api/images[?chatId=][&source=user\|tool][&q=prompt][&limit=100][&offset=0]` | gallery → `{ total, images: ImageRecord[] }` (newest first) |
| `GET /api/images/:id` | → `{ image }` |
| `GET /api/images/:id/file[?download=1]` | image bytes (immutable cache headers) |
| `DELETE /api/images/:id` | → `{ ok: true }` (message refs stay; their URL then 404s) |

**ImageRequest**:

```json
{
  "prompt": "a lighthouse at dusk, oil painting",
  "negativePrompt": "blurry",
  "aspect": "landscape",
  "width": null, "height": null, "size": "768x512",
  "steps": null, "cfg": null, "seed": 42, "count": 1, "sampler": null, "scheduler": null,
  "model": null, "providerId": null,
  "initImage": { "attachmentId": "att_…" },
  "denoise": 0.6,
  "chatId": null, "parentId": null,
  "stream": true
}
```

Only `prompt` is required. `aspect` ∈ `square | portrait | landscape | wide | tall` (sizes derived from the model family's native resolution, ≤ 512 px class on ≤ 8 GB). `seed` `-1`/omitted = random (the actual seed is always returned). `model`/`providerId` default to `settings.image.*`, then the provider's current model / first reachable provider. `initImage` (`{attachmentId}` or `{imageId}`) → img2img with `denoise` strength (A1111 & ComfyUI). Defaults per family: SD-Turbo 2 steps/cfg 1, SDXL-Turbo 4/1, Lightning/Hyper/LCM 6/1.5, FLUX schnell 4/1, FLUX dev 20/3.5, SD3 28/4.5, SDXL 25/6, SD1.5 25/7. Heavy settings produce `warnings` (never blocked): `large_size_low_ram`, `heavy_model_low_ram`, `batch_low_ram`, `large_size`, `large_batch`, `steps_high_for_family`, `steps_high`, `img2img_unsupported`.

With `chatId`: a user message `{kind:"image_request", content: prompt, imageRequest}` and an assistant message `{kind:"image_result", images:[ImageRef]}` are added to that chat (child of `parentId`, default active leaf); the stream starts with two `message` events, and `done` includes `message`, `userMessage`, `chat`.

Image SSE events (direct generation; the same events appear inside chat streams for the `generate_image` tool):

| event | payload |
|---|---|
| `message` | `message` — only with `chatId` (the two new messages) |
| `image_job` | `job` (ImageJob, `status: "queued"`) |
| `image_status` | `jobId, phase` + phase data: `queued` (`reason: "model_in_use"\|"image_job", message` — ≤ 8 GB or `unloadChatModel: "always"`: waits until no chat turn / background model work holds the RAM; abortable) · `starting` (`params, family, warnings, providerId`) · `unloading` (`models, reason, message`) · `unloaded` (`models, confirmed`, + `message` when Ollama did not confirm in time) · `generating` (`message`) · `saving` |
| `image_progress` | `jobId, progress (0..1), step, steps, etaSeconds` (A1111 progress polling; ComfyUI WebSocket; none for OpenAI-images) |
| `image` | `jobId, image: ImageRecord, index` (one per image) |
| `image_done` | `jobId, job, images: ImageRecord[], chatModelUnloaded: bool, reload: "lazy"\|"eager"\|null` |
| `image_error` | `jobId, code ("aborted"\|…), message, job` |
| `done` | `{ job, images, message?, userMessage?, chat? }` — direct stream only |
| `error` | `{ code, message, messageId? }` — direct stream only (`code: "aborted"` when cancelled, `timeout` after `image.timeoutSec`: "Timed out after 600 s waiting for Draw Things to finish the image (image.timeoutSec)", `workflow_invalid` for a rejected ComfyUI workflow) |

`"stream": false` → `200 { job, images, message?, userMessage?, chat? }`.

With `chatId`, the chat is reserved like a chat turn (`409 chat_busy` while it generates), released and saved before `done`. `count > 1` on ComfyUI runs one prompt per image with seeds `seed, seed+1, …`. On failure or timeout the backend job is interrupted.

RAM coordination: on ≤ 8 GB machines (or `image.unloadChatModel: "always"`) the chat model and a diffusion model are never resident together: chat turns and background model work hold an "llm" lease, image jobs an "image" lease; each waits for the other, visibly (`model_status: waiting` / `image_status: queued`), FIFO and abortable. Before generating, Harness may unload Ollama models (`image_status: unloading/unloaded`) and waits until `/api/ps` really stops listing them. The chat model reloads on the next chat request (`model_status: loading → ready` in that chat stream) — or right away with `reloadAfter: "eager"` (not on ≤ 8 GB; progress then appears as `model.status` bus events). Background LLM work (memory extraction, titles, recall embeddings) waits while a job runs or the chat model is unloaded.

`generate_image` tool: offered to the chat model only when image generation is enabled, `tools.builtin.generate_image` is on, and a provider is reachable. Arguments `{ prompt, negative_prompt?, aspect?, seed? }`. The model receives only a one-line confirmation (never image bytes), unless `image.feedbackToModel` is on and the chat model has vision.

## 6. Global event bus

`GET /api/events` (SSE, `EventSource`-compatible). First event `hello {version, time}`; every payload also has `ts`. Subscribe once per window to keep sidebars, badges and background status in sync.

| event | payload |
|---|---|
| `chat.created` / `chat.updated` | `{ chat: ChatSummary }` (`chat.updated` fires when the auto title arrives, on rename/pin/archive) |
| `chat.deleted` | `{ chatId }` |
| `chat.compacted` | `{ chatId, summary }` |
| `generation.started` / `generation.finished` | `{ chatId, generationId, assistantMessageId? }` |
| `memory.added` / `memory.updated` / `memory.deleted` | `{ memory }` |
| `memory.cleared` | `{ count }` |
| `memory.extracted` | `{ chatId, added: Memory[], updated: Memory[] }` — toast "Remembered: …" |
| `settings.updated` | `{ settings }` |
| `presets.updated` | `{}` |
| `providers.status` | `{ providerId, ok }` (a provider came up / went down) |
| `ollama.status` | `{ managed, running, version?, pid?, exitCode?, signal? }` |
| `model.pull` | `{ pullId, providerId, model, status, digest?, total?, completed?, percent?, error? }` (throttled progress; `status`: `started`, Ollama status text, `success`, `error`, `aborted`) |
| `model.deleted` | `{ providerId, model }` |
| `model.status` | `{ phase: "unloaded"\|"loading"\|"ready", models, reason? }` |
| `model.measured` | `{ providerId, model, sample: Sample }` (5.4: `source`, `totalBytes`, `pressure`, …) |
| `models.changed` | `{ providerId, model, reason: "text_only_copy" }` — a model was created; refresh the model list |
| `attachment.indexed` | `{ attachmentId, embedded }` |
| `image.job` · `image.status` · `image.progress` · `image.done` · `image.error` | same payloads as the image SSE events (from any source, incl. the tool) |
| `image.added` / `image.deleted` | `{ image }` / `{ imageId }` |
| `image.providers.status` | `{ providerId, ok }` |

## 7. UI integration notes

* **Rendering a chat**: `GET /api/chats/:id` → index `messages` by id → render `path`. Group each user message with the assistant/tool chain that follows it. Show reasoning collapsed ("Thought for …"). Tool calls: compact cards from `toolCalls` + the matching tool message (`toolCallId`).
* **Streaming**: create the assistant bubble from `start.assistantMessage`; append `token`/`reasoning` deltas by `messageId`; tool loops create new assistant steps (`message` events) — keep them in the same bubble. Replace with `done.message` at the end. On `error`, show `message` with a Retry button (`regenerate`).
* **Branching**: "‹ i/n ›" from `siblingIds`; edit = `POST …/edit` (user) — never mutate in place; regenerate = `POST …/regenerate`, optionally with another `model`.
* **Context meter**: from the latest `context` event or `GET /api/chats/:id/context?draft=` while typing (debounce). Explain the window with `contextPlan.explanation`; the model picker can show `GET /api/models/context?mode=max` to say what max would cost.
* **Compaction UX**: on `compaction {status:"started"}` show "Summarizing earlier messages…"; afterwards draw a divider after `chat.summary.upToMessageId` with view/edit (`GET/PUT /summary`) and a "Compact now" action.
* **Memory UX**: list/edit/pin under settings; toast on `memory` (tool) and `memory.extracted` (bus); a per-chat incognito toggle (`PATCH {incognito:true}`).
* **Images**: in chat, render `image` events inline at the tool call (`toolCallId`), then the final text. Show `image_status.message` and `image_progress` (progress bar) and, on 8 GB, the unload/reload phases ("Unloading chat model… Generating… Reloading…"). Gallery: `GET /api/images`; image detail shows prompt/seed/params with "Use as init image" (`initImage: {imageId}`) and "Reuse seed".
* **First run**: if `GET /api/models` is empty, offer `GET /api/models/recommended` (`suggestedVariant`) + `POST /api/models/pull`; if Ollama is `unreachable` and `system.ollama.installed`, offer `POST /api/providers/ollama/start`; if not installed, link to ollama.com. If `GET /api/embeddings/status` has a `suggestion`, offer to pull it (not on 8 GB).
* **Electron**: load `url` from `startServer()`; if you serve the UI from a custom protocol, add it to `HARNESS_ALLOWED_ORIGINS`. Call `close()` on quit. The shipped shell (`electron/`) does exactly that over `http://127.0.0.1:<port>`; its preload API (`window.harnessDesktop`), `<html>` classes, menu actions and lock-down rules are documented in [`docs/DESKTOP.md`](DESKTOP.md).

## 8. Fake backends for development

`npm run dev:fake` starts the real server on 4747 plus fakes (on their real default ports when free): Ollama 11434, Draw Things/A1111 7860, ComfyUI 8188, llama.cpp-style OpenAI server 8080 (chat, embeddings, `/v1/images/generations`). Options: `--ram 8` (simulate 8 GB), `--delay <ms per token chunk>`, `--step <ms per diffusion step>`, `--port`, `--data <dir>`, `--fresh`, `--open`. Each fake can also run alone: `node test/fake-ollama.mjs --port 11434`, `node test/fake-a1111.mjs --port 7860 [--drawthings true]`, `node test/fake-comfyui.mjs --port 8188`, `node test/fake-openai.mjs --port 8080`.

Fake Ollama models: `nemotron-3.5-bolt:e4b` (official tag: tools, thinking, vision, audio; 7.9 GB = model + projector + draft; metadata says 128K → Harness uses 64K), `hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL` (as pulled: tools, completion, vision, audio — no thinking; 4024 MiB + 946 MiB projector; real gemma4 metadata; `show.template` is the GGUF jinja template, the Modelfile carries the Go template), `qwen3:4b` (thinking), `gemma3:4b` (vision), `deepseek-r1:1.5b` (inline `<think>` tags), `gemma2:2b` (no tools), `embeddinggemma:latest`. Pullable: `llama3.2:3b`, `nomic-embed-text`.

The fake follows real Ollama 0.40: unit-less `keep_alive` strings other than `"0"` → 400; `think` omitted on a thinking model = thinking on (a small `num_predict` then yields empty content); tool calls carry `id` + `function.index`; history `tool_calls[].function.arguments` must be objects (a string → 400); `prompt_eval_cached_count` for a repeated prompt prefix; `/api/ps` `size` excludes the weights (KV + buffers) while `fake.runners()` reports the resident size for the fake memory probe (`test/fake-memory-probe.mjs`); `/api/create` with `files` (and 400 for a jinja `template`); `fake.failLoad(name)` → HTTP 500 `llama-server process has terminated: signal: abort trap` (loads with `options.num_gpu: 0`); `fake.headerDelayMs` delays the response headers like a long prompt evaluation.

Trigger phrases (fake chat model; tools must be offered): `calculate <expr>`, `what time is it`, `please remember that <fact>`, `draw <subject>` / `generate an image of <subject>`, `fetch <url>`, `recall <query>`, `loop forever` (iteration cap), `use tool <name> {json}`, `long answer <N>` (N words, good for abort/scroll testing), `my name is <Name>` / `I prefer …` / `I live in …` / `I'm working on …` (memory extraction), `silent after tools` (empty final answer after tool results while tools are offered) / `always silent after tools` (also empty when asked again without tools). Otherwise it answers `You said: <your message>`.

## 9. Changes in the hardening pass

Everything below is additive unless marked **behaviour**. Documented shapes did not change.

* **behaviour — security:** cross-port localhost origins are no longer allowed by default (add them to `settings.security.allowedOrigins`); CSP / `nosniff` / `no-referrer` headers; non-image attachments are downloads (3.7); `fetch_url` only opens links the user wrote and never private addresses (4); imported/backup content is validated and re-identified (5.8); a single server per data dir (1).
* **behaviour — chat turns:** one operation per chat, reserved synchronously (`409 chat_busy` as JSON before any SSE; `409 message_deleted`); `done`/`error` are sent after the chat is released and saved (send again right away); a disconnect aborts and keeps the partial reply; an empty answer after tool results gets `fallback` text (3.2); `reasoning.think: "auto"` now means no thinking and `think` is always sent.
* New error codes and `details.nextSteps` (2): `model_load_failed`, `registry_unreachable`, `workflow_invalid`, `secret_detected`, `memory_protected`, `message_deleted`, `not_multimodal`, `name_taken`, `no_model_blob`.
* SSE: `model_status` phases `waiting`, `loading` (with `reason`/`elapsedMs`), `evaluating`, `ready` (with `reason`), `loaded`; `image_status` phase `queued`, `unloaded.confirmed`; notices `memory_pressure`, `model_too_big`; `stats.cachedPromptTokens`; `error.nextSteps` (4).
* Memory sizing: measurements are the runner's RSS + swap growth on macOS (3.5); the measured fixed part never goes below the model file (`measurement.flooredToWeights`); auto mode never grows a loaded model's window (`limitedBy: "loaded"`, `pendingNumCtx`); a swap-inducing window is cut in one step; plan-warning notices are sent once per chat; new plan fields `limitedBy: "memory_pressure"`, `memory.{kvCacheTypeSource, kvMaxBytes, contextCheap, pressure}`, warnings `memory_pressure`, `model_too_big` (`smallerModel`); `loadedModels[].residentBytes` (5.1); old `measurements.json` samples are discarded once.
* Models: `POST/GET/DELETE /api/models/text-only`; recommended-list fields `textOnly`, `lowRam`, `note`, `modelLayerBytes`, `projectorBytes`, `draftBytes`, `textOnlyBytes`, `asPulledEstimate`, `notForThisMachine`, `avoid`, `largestRealisticVariant`, `suggestTextOnly`, `lowRamNote` (5.4); real Nemotron files (no `Q3_K_M`/`Q4_K_M`); the automatic default model is the installed one that fits; pull `start.warning`.
* Settings: `security.allowedOrigins`, `ollama.noCloud`, `ollama.promptCacheMiB`; `keepAlive` validation; `context.kvCacheType: "auto"` no longer reads Harness's own `OLLAMA_KV_CACHE_TYPE`; preset params limited to sampling keys; `settings.json` cleaned on load.
* System: `ollama.protections`, `ollama.env` incl. `OLLAMA_NO_CLOUD` / `LLAMA_ARG_CACHE_RAM` (5.1).
* Memories: `needsReview`, `allowSecret`, `origin: "restore"`, protected manual/pinned memories, stricter dedupe (3.6, 5.9).
* Chats: `titleSource: "import"`; `DELETE /api/chats/:id?deleteMemories=true` → `removed`; regenerate on an image turn makes a new image; backup v2 with files + `POST /api/restore` (5.8).
* Images: ComfyUI `count` = one prompt per image; resident-size unload decisions; RAM lease on 8 GB; timeouts/failures interrupt the backend.
