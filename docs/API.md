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

## 2. Conventions

### Security
* Every request's `Host` must be `localhost`, `127.0.0.1` or `[::1]` (any port) → otherwise `403 forbidden` (DNS-rebinding protection).
* If an `Origin` header is present it must be an `http(s)://localhost|127.0.0.1|[::1]:<any port>` origin or listed in `HARNESS_ALLOWED_ORIGINS`; `Origin: null` and other sites → `403`. Requests with `Sec-Fetch-Site: cross-site` and no Origin → `403`.
* Allowed cross-port localhost origins (e.g. a Vite dev server on `:5173`) get CORS headers (`Access-Control-Allow-Origin: <origin>`, preflight `OPTIONS` → `204`). The same-origin UI needs nothing special.
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
| 400 | `bad_request`, `bad_json`, `bad_parent`, `attachment_not_found`, `attachment_unusable`, `nothing_to_compact`, `not_chat_model`, `unsupported` | invalid input |
| 403 | `forbidden` (host/origin), `read_only` (built-in preset) | |
| 404 | `not_found`, `model_not_found`, `provider_not_found`, `image_provider_not_found`, `no_summary`, `not_installed` | |
| 405 / 413 / 415 | `method_not_allowed` / `payload_too_large` / `unsupported_media_type` | |
| 409 | `chat_busy` (a generation is already running in that chat), `no_model` (no chat model available), `image_disabled` | |
| 500 | `internal_error`, `start_timeout` | |
| 502 | `provider_error` (backend returned an error) | |
| 503 | `connection_failed` (backend not running), `no_image_provider`, `image_provider_unreachable` | |
| 504 | `timeout` | |

Streaming endpoints validate first: **setup errors are returned as normal JSON errors before any SSE bytes** (e.g. unknown model → `404 model_not_found`, Ollama down → `503 connection_failed`). Once the stream has started, failures arrive as an `error` event.

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
* **Aborting:** closing the HTTP connection (e.g. `AbortController.abort()`) aborts the generation/pull/image job; the partial assistant message is stored with `status: "aborted"`. `POST /api/chats/:id/stop` does the same without closing the stream (you then receive `done` with `reason: "aborted"`).

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
* `chat.generating`: `{ generationId, assistantMessageId, startedAt }` while a turn is running, else `null` (lets a reloaded UI show "still generating").
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
| `usage?` | last backend call: `{ promptTokens, completionTokens, totalMs, loadMs, promptMs, evalMs }` (any may be `null`) |
| `stats?` | whole turn: `{ durationMs, iterations, toolCalls, promptTokens, completionTokens, tokensPerSecond, loadMs }` |
| `context?` | **ContextUsage** at request time (+ `summaryId`, + `actual: {promptTokens, completionTokens, used}` from the backend) |
| `retrieval?` | `{ memoryIds, pinnedMemoryIds, documentChunks, recallChunkIds }` — what was injected |
| `finishReason?` | `"length" \| "tool_limit" \| "aborted"` (absent = normal stop) |
| `error?`, `errorCode?` | when `status: "error"` |
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
  "limitedBy": "model", "fits": true, "fitMax": 350213,
  "memory": {
    "totalBytes": 16869146624, "budgetBytes": 12574179328, "budgetFraction": 0.745, "osReserveBytes": 4294967296, "ramTier": "medium",
    "modelBytes": 6442450944, "overheadBytes": 461708984,
    "kvBytesPerToken": 14336, "kvFixedBytes": 29360128, "kvCacheType": "f16", "kvSource": "metadata+swa",
    "kvLayers": { "full": 7, "slidingWindow": 28, "window": 512 },
    "kvBytes": 968884224, "otherModelsBytes": 620000000, "estimatedTotalBytes": 8493044152,
    "basis": "estimate", "measurement": null
  },
  "alternatives": { "max": { "numCtx": 65536, "estimatedTotalBytes": 8493044152, "fits": true, "overBudgetBytes": 0 }, "fitMax": 65536 },
  "warnings": [],
  "explanation": "64K of 64K context (model max); est. 7.9 GB of 15.7 GB RAM (safe budget 11.7 GB).",
  "providerId": "ollama", "model": "nemotron-3.5-bolt:e4b",
  "contextNote": "Nemotron 3.5 Bolt E4B is trained for 64K tokens; its metadata advertises 128K."
}
```

* `mode`: `auto` (largest that safely fits), `max` (model max regardless of RAM), `manual` (explicit number), `server` (OpenAI-compatible servers: fixed at load time, e.g. llama-server `-c`).
* `limitedBy`: `model` | `memory` | `user` | `setting` (`context.maxAuto`) | `low_ram_cap` (`context.lowRamCap`, ≤ 8 GB machines only) | `server`.
* `modelMaxSource`: `override` (built-in table — e.g. Nemotron 3.5 Bolt E4B is 64K although metadata says 128K) | `metadata` | `catalog` | `unknown`.
* `ramTier`: `low` (≤ 8 GB), `medium` (≤ 16 GB), `high`.
* `warnings[]`: `{code, message}` — `model_exceeds_budget`, `exceeds_budget`, `clamped_to_model_max`, `context_unknown`, and from real measurements (below) `measured_exceeds_budget`, `cpu_offload`.
* Show `explanation` verbatim; it always says what limited the window and, when RAM-limited, what `max` would cost. 8 GB examples:
  * `"The model alone (6.0 GB) exceeds the safe memory budget (4.8 GB) on this 8 GB Mac; using the minimum 2K context. A smaller quantization is strongly recommended."`
  * `"4K of 64K context — limited by RAM; est. 4.7 GB of 8.0 GB RAM (safe budget 4.8 GB). Max mode (64K) would need ~5.6 GB and would likely swap."`
  * `"16K of 64K context — capped for responsiveness on this 8 GB Mac (RAM would allow ~52K; raise context.lowRamCap or use max mode for more); …"`

**Self-correction from real memory use (`memory.basis`, `memory.measurement` — optional fields).** After each turn's first model call, Harness reads Ollama `GET /api/ps` for the chat model (`size` = total resident bytes, `size_vram` = bytes on the GPU, `context_length` when the Ollama version reports it, else the `num_ctx` we sent) and stores the sample per model build (digest + file size) and KV-cache precision (`measurements.json` in the data dir). Later plans for that model use the measurements instead of the architecture guess:

* 1 measurement → the fixed part (weights + overhead) is corrected, bytes/token stays estimated (`method: "offset"`); measurements at ≥ 2 contexts ≥ 1K apart → bytes/token is fitted too (`"linear"`, or `"linear-clamped"` when the fit was limited to ¼–4× the estimate). Repeated readings at one context use the median; implausible readings (< 0.4× or > 3× the estimate, below half the weights, tiny contexts) are ignored and counted in `rejected`. A re-pulled/different build or another KV precision starts from the estimate again.
* `memory.basis`: `"estimate" | "measured"`. When `"measured"`, `estimatedTotalBytes` is the measurement-corrected figure and the `explanation` says so (`"… measured-corrected 4.6 GB of 8.0 GB RAM … Memory use is calibrated from 1 measurement of this model (last: 4.9 GB at 14K)."`).
* `memory.measurement` (or `null` when there are no samples):
  ```json
  { "method": "offset", "samples": 1, "distinctContexts": 1, "rejected": 0,
    "fixedBytes": 3179830784, "perTokenBytes": 147456, "estimatedFixedBytes": 2843435456, "estimatedPerTokenBytes": 147456,
    "gpuCapBytes": null,
    "latest": { "numCtx": 14336, "totalBytes": 5293760000, "vramBytes": 5293760000, "at": "2026-11-16T02:49:05.813Z", "cpuSplit": false } }
  ```
  `method` is `"none"` (and `fixedBytes`/`perTokenBytes` are `null`) when every sample was rejected. `gpuCapBytes`: the GPU-resident size observed while the model was split between GPU and CPU (`size_vram < size`); auto mode then keeps the model within it.
* **Auto mode** never repeats an over-commit: if the latest measurement was over the safe budget or partly on the CPU, the next plan comes down to what fits per the corrected estimate, and the `explanation` starts with e.g. `"Measured 4.9 GB at 14K (over the safe budget of 4.8 GB); auto mode reduced the window to 12K using that measurement. 12K of 40K context — limited by RAM; …"`.
* **Explicit modes** (`max`, a number) are never changed; instead `warnings` get `measured_exceeds_budget` (`"Measured 4.9 GB for this model at 16K — over the safe memory budget of 4.8 GB on this 8 GB Mac; expect swapping. About 8K would fit: lower the context or switch to auto."`) and/or `cpu_offload` (`"Ollama placed only 3.6 GB of 3.8 GB on the GPU at 16K (5% runs on the CPU), which makes generation much slower. Use a smaller context window (about 8K fits on the GPU) or a smaller quantization."`).
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

`category`: `fact | preference | project | instruction | other`. `origin`: `auto` (background extraction), `manual` (API/UI), `tool` (the model's `remember` tool). `source`: `{chatId, messageId}` or `null`. Pinned memories are always included in the system prompt; others are retrieved per turn.

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
* PDF: text extraction only (no OCR); encrypted/scanned PDFs → `binary` with an explanatory `error`.

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
`memory`: `{ unload, reason, loadedBytes, imageModelBytes, totalBytes, mode, unloaded: [model] }` where `reason` ∈ `nothing_loaded | setting_never | setting_always | low_ram | insufficient_ram | fits`.

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
  "ollama": { "autoStart": true, "stopOnExit": true, "binaryPath": null, "flashAttention": true, "kvCacheType": "q8_0", "numParallel": 1, "maxLoadedModels": "auto", "extraEnv": {} },
  "image": {
    "enabled": true, "providerId": null, "model": null,
    "defaults": { "width": null, "height": null, "steps": null, "cfg": null, "sampler": null, "negativePrompt": "", "count": 1 },
    "unloadChatModel": "auto", "reloadAfter": "lazy", "feedbackToModel": false, "comfyWorkflow": null, "timeoutSec": 600, "autodetect": true,
    "builtin": { "a1111": { "enabled": true, "baseUrl": "http://127.0.0.1:7860" }, "comfyui": { "enabled": true, "baseUrl": "http://127.0.0.1:8188" } },
    "custom": []
  },
  "ui": { "theme": "system" }
}
```

| key | values | meaning |
|---|---|---|
| `defaultModel` | ModelRef \| null | `null` = auto: first installed recommended model (Nemotron 3.5 Bolt first), else newest |
| `defaultPresetId`, `systemPrompt` | string \| null | `systemPrompt: null` = use the preset's prompt |
| `params.*` | number \| null (`stop`: string[]) | sampling; `null` = don't send (Modelfile / server default, else per-model suggestion). Precedence: model profile suggestion < global `params` < preset `params` < chat `params` |
| `keepAlive` | `"30m"`, `"-1"` (forever), `"0"`, number (s) | Ollama `keep_alive` for every request |
| `context.mode` | `"auto" \| "max" \| integer ≥ 512` | see ContextPlan |
| `context.maxAuto` | int \| null | cap for auto mode |
| `context.lowRamCap` | int \| null | cap for auto mode on ≤ 8 GB machines (prompt processing of very long contexts is slow there); `null` disables |
| `context.useMeasurements` | bool | correct the RAM estimate from real Ollama `/api/ps` measurements of each model (see 3.5) |
| `context.kvCacheType` | `auto \| f16 \| q8_0 \| q4_0` | KV precision assumed in the RAM estimate; `auto` = `q8_0` if Harness spawned Ollama, else `$OLLAMA_KV_CACHE_TYPE`, else `f16` |
| `context.memoryFraction` | 0.1–1 \| null | override the safe RAM budget fraction |
| `context.replyReserve` | int \| `"auto"` | auto = 15 % of the window (384–8192) |
| `reasoning.think` | `auto \| on \| off \| low \| medium \| high` | Ollama `think`; `auto`/`on` = think when the model has the `thinking` capability |
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
| `ollama.*` | | how Harness launches `ollama serve` itself: `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, and `OLLAMA_MAX_LOADED_MODELS=1` on ≤ 8 GB (`maxLoadedModels: "auto"`); `extraEnv` adds `OLLAMA_*` variables |
| `image.unloadChatModel` | `auto \| always \| never` | unload Ollama models before generating an image; auto = always on ≤ 8 GB, else when loaded models + image model > 70 % of RAM |
| `image.reloadAfter` | `lazy \| eager` | lazy = reload on the next chat request (forced on ≤ 8 GB) |
| `image.feedbackToModel` | bool | after `generate_image`, show the image to a vision-capable chat model |
| `image.comfyWorkflow` | object \| null | ComfyUI API-format workflow with `{{prompt}} {{negative_prompt}} {{seed}} {{steps}} {{cfg}} {{width}} {{height}} {{count}} {{model}} {{sampler}} {{scheduler}} {{denoise}} {{image}}` placeholders (whole-string numeric placeholders become numbers) |
| `ui` | any object < 64 KB | free-form pass-through for the UI (theme, font size, …) |

**ChatSettings** (`chat.settings`, all optional): `model`, `presetId`, `systemPrompt`, `params`, `keepAlive`, `context: {mode}`, `reasoning: {think}`, `tools: {enabled, builtin}`, `compaction: {enabled}`, `memory: {enabled}`, `recall: {enabled}`. Incognito is the chat-level flag `incognito` (no memory read/write, no recall indexing, excluded from recall).

### 3.10 Preset

```json
{ "id": "default", "name": "Assistant", "description": "Helpful, accurate general assistant.", "systemPrompt": "You are Harness, …", "params": {}, "builtin": true }
```

Built-ins: `default` (Assistant), `concise`, `coder`, `writer`, `tutor`. User presets also have `icon`, `createdAt`, `updatedAt`.

### 3.11 ModelInfo (`GET /api/models/info`)

```json
{
  "model": "nemotron-3.5-bolt:e4b", "displayName": "NVIDIA Nemotron 3.5 Bolt E4B", "providerId": "ollama",
  "sizeBytes": 6442450944, "digest": "sha256:…", "family": "gemma4", "parameterSize": "7.9B", "quantization": "Q4_K_M",
  "capabilities": ["completion", "tools", "thinking", "vision"],
  "contextLength": 65536, "contextLengthSource": "override", "advertisedContextLength": 131072,
  "contextNote": "Nemotron 3.5 Bolt E4B is trained for 64K tokens; its metadata advertises 128K.",
  "modelfileParameters": { "temperature": 1, "top_k": 64, "top_p": 0.95, "stop": ["<end_of_turn>"] },
  "profile": { "id": "nemotron-bolt", "family": "gemma4", "sampling": { "temperature": 0.6, "top_p": 0.95, "top_k": 64 }, "imageTokens": 280, "swa": { "globalEvery": 5, "window": 512 }, "notes": "…" },
  "serverContext": null,
  "arch": { "name": "gemma4", "blockCount": 35, "embeddingLength": 2048, "headCount": 8, "headCountKv": 2, "keyLength": 256, "valueLength": 256, "slidingWindow": 512, "slidingWindowPattern": null, "sharedKvLayers": null, "parameterCount": 7900000000 }
}
```

`capabilities` ⊂ `completion, tools, thinking, vision, embedding` (from Ollama `/api/show`; inferred for OpenAI-compatible servers). `serverContext` = context fixed by an OpenAI-compatible server.

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
| `notice` | `code, message` (+ details). Codes: `context_truncated` (`droppedMessages, truncatedMessages`), `tools_unsupported`, `thinking_unsupported`, `pinned_memories_large`, ContextPlan warning codes (`model_exceeds_budget`, `exceeds_budget`, `measured_exceeds_budget`, `cpu_offload`, …), and right after the first model call of a turn, when the model's measured footprint is bad: `measured_exceeds_budget` (`measuredBytes, budgetBytes, numCtx, nextNumCtx`) / `cpu_offload` (`totalBytes, vramBytes, numCtx, nextNumCtx`) — not repeated when the turn's plan already carried that warning | non-fatal info for a toast |
| `context` | ContextUsage + `summaryId`, `messageId`, and on the first one `contextPlan: {numCtx, limitedBy, explanation}` | before each model call |
| `model_status` | `phase: "loading"` + `models, reason: "reload_after_image", message` · `phase: "ready"` | the chat model is being reloaded after an image job unloaded it |
| `reasoning` | `messageId, delta` | thinking text |
| `token` | `messageId, delta` | answer text |
| `stats` | `messageId, iteration, promptTokens, completionTokens, tokensPerSecond, promptTokensPerSecond, promptMs, evalMs, loadMs, totalMs, contextUsed, numCtx` | after each model call (real backend numbers) |
| `message` | `message` (Message) | an assistant step finished with tool calls, or a new assistant step started after tool results |
| `tool_call` | `messageId` (assistant), `toolMessageId` (tool message that will hold the result), `toolCall: {id, name, arguments}` | before a tool runs |
| `tool_result` | `message` (tool Message), `toolCallId, name, content, isError, data, images: ImageRef[], durationMs` | after a tool ran |
| `memory` | `action: "added"\|"updated"\|"unchanged", memory, origin: "tool"` | `remember` tool saved something |
| `image_job` · `image_status` · `image_progress` · `image` · `image_done` · `image_error` | as in 5.11, plus `toolCallId, messageId` (assistant that called the tool), `toolMessageId` | `generate_image` tool running — render the image inline in the assistant turn |
| `done` | `generationId, reason: "stop"\|"length"\|"aborted"\|"tool_limit"`, `message` (final assistant Message), `createdMessageIds`, `chat` (ChatSummary), `context`, `stats` | last |
| `error` | `code, message, messageId, generationId` | last (assistant message stored with `status:"error"`) |

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
  "loadedModels": [ { "providerId": "ollama", "model": "nemotron-3.5-bolt:e4b", "name": "…", "sizeBytes": 6.9e9, "vramBytes": 6.4e9, "expiresAt": "…", "contextLength": 16384, "digest": "…" } ],
  "ollama": { "installed": true, "binaryPath": "/opt/homebrew/bin/ollama", "managed": false, "pid": null, "env": null,
              "recommendedEnv": { "OLLAMA_HOST": "127.0.0.1:11434", "OLLAMA_NUM_PARALLEL": "1", "OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_MAX_LOADED_MODELS": "1" },
              "lastError": null, "logTail": [] },
  "imageProviders": [ /* ImageProviderStatus (5.11) */ ],
  "embeddings": { /* GET /api/embeddings/status */ },
  "modelState": { "unloadedForImage": false, "models": [], "since": null },
  "background": { "running": null, "pending": [ { "key": "memory:chat_…", "label": "memory_extraction", "dueInMs": 0, "blockedBy": "foreground_generation" } ] },
  "generations": [ { "chatId": "chat_…", "generationId": "gen_…", "assistantMessageId": "msg_…", "startedAt": "…" } ],
  "imageJobs": { "active": 0, "recent": [ /* ImageJob */ ] }
}
```

`background.pending[].blockedBy`: `foreground_generation | image_job | model_unloaded_for_image | null`. `ollama.managed`: Harness spawned `ollama serve` itself (`env` = the variables it used).

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
| `POST /api/models/load` | `{ model, providerId? }` preload with the planned `num_ctx` → `{ ok: true, numCtx }` |
| `POST /api/models/unload` | `{ model, providerId? }` (`keep_alive: 0`) → `{ ok: true }` |
| `GET /api/models/loaded` | → `{ models: [{providerId, model, name, sizeBytes, vramBytes, expiresAt, contextLength, digest}], modelState }` |
| `GET /api/models/measurements?model=…[&providerId=…]` | memory measurements of a model → `{ providerId, model, kvCacheType, stale, samples: [{numCtx, sentNumCtx, reportedContext, totalBytes, vramBytes, kvCacheType, at}], validSamples, loadedNumCtx, measurement, basis }` (`stale`: recorded for a different build; `loadedNumCtx`: the `num_ctx` it is currently loaded with, or `null`) |
| `DELETE /api/models/measurements?model=…[&providerId=…]` | forget them (plans go back to the estimate) → `{ ok: true, removed }` |
| `GET /api/embeddings/status` | → EmbeddingsStatus (below) |

ModelListItem: `{ providerId, providerName, model, name, sizeBytes, digest, modifiedAt, family, families, parameterSize, quantization, format, embedding, loaded }` + with `details=1`: `capabilities`, `contextLength`.

`budgets` (derived from `numCtx`, all fractions of the window): `{ numCtx, replyReserve, input, compactAt, compactTarget, keepRecentTokens, maxSummaryTokens, memories, recall, documents, inlineFileMax }`.

`suggestedParams`: the profile sampling values that would be sent (keys already set in the Modelfile are left to Ollama).

`GET /api/models/recommended` →

```json
{
  "machine": { "totalMemBytes": 8589934592, "ramTier": "low", "budgetBytes": 5100273664, "kvCacheType": "f16" },
  "models": [
    {
      "id": "nemotron-3.5-bolt-e4b", "name": "NVIDIA Nemotron 3.5 Bolt E4B",
      "description": "Fast ~4B-effective-parameter model tuned for multi-turn tool use. Real context 64K.",
      "tags": ["recommended", "tools", "thinking", "fast"], "contextLength": 65536, "family": "gemma4",
      "variants": [
        { "model": "nemotron-3.5-bolt:e4b", "label": "Default quant", "approxSizeBytes": 6442450944, "installed": false, "providerId": null,
          "estimate": { "numCtx": 2048, "estimatedTotalBytes": 6962880184, "fits": false, "limitedBy": "memory", "explanation": "The model alone (6.0 GB) exceeds the safe memory budget (4.8 GB) on this 8 GB Mac; …" } },
        { "model": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q4_K_M", "label": "Q4_K_M (GGUF)", "approxSizeBytes": 4600000000, "installed": false, "providerId": null, "estimate": { … } },
        { "model": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q3_K_M", "label": "Q3_K_M (GGUF, low RAM)", "approxSizeBytes": 3900000000, "installed": false, "providerId": null, "estimate": { … } }
      ],
      "suggestedVariant": "hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q3_K_M",
      "installed": false, "fitsThisMachine": true
    }
  ],
  "embedding": [ { "id": "embeddinggemma", "name": "EmbeddingGemma 300M", "model": "embeddinggemma", "approxSizeBytes": 620000000, "description": "…", "installed": false } ],
  "note": "Sizes are approximate and the fit estimate uses architecture hints until the model is installed."
}
```

`suggestedVariant` = largest variant that fits with ≥ 8K context (else ≥ 4K, else the smallest). Pull it with `POST /api/models/pull {"model": suggestedVariant}`.

Pull stream events: `start {pullId, providerId, model}` → `progress {pullId, status, digest, total, completed, percent}` (many; `percent` is `null` for steps without byte counts, e.g. `"pulling manifest"`, `"verifying sha256 digest"`) → `done {pullId, providerId, model, status: "success"}` or `error {pullId, code, message}` (e.g. `"pull model manifest: file does not exist"`). Closing the connection cancels the pull.

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
| `DELETE /api/chats/:id` | stops any generation, deletes the chat, its attachments and its recall index → `{ ok: true }` |
| `POST /api/chats/:id/title` | regenerate the title now → `{ title, chat }` |
| `POST /api/chats/:id/fork` | `{ messageId? }` (default active leaf) → `201 ChatDetail` of a new chat containing the path up to that message (summaries carried over) |
| `GET /api/chats/:id/context[?draft=text]` | context-meter preview for the active path (+ an optional draft message, incl. retrieval) → `{ context: ContextUsage + {needsCompaction, summaryId, truncation}, plan: ContextPlan, model: ModelRef }` |

### 5.6 Messages & generation

| | |
|---|---|
| `POST /api/chats/:id/messages` | `{ content, attachments?: [attachmentId], parentId?, model?: ModelRef }` → **SSE** (section 4). `parentId` defaults to the active leaf (`null` = new root). `model` overrides the chat model for this turn only |
| `POST /api/chats/:id/messages/:mid/regenerate` | `{ model? }` → **SSE**. `:mid` may be any message of the turn (assistant, tool, or the user message); a new assistant sibling is created under the turn's user message |
| `POST /api/chats/:id/messages/:mid/edit` | user message: `{ content, attachments?, model?, generate?: true }` → **SSE** (a new sibling user message, `editedFrom: mid`, then a reply). With `generate: false` → `{ message, path }`. Assistant message: `{ content }` → `{ message, path }` (sibling with `edited: true`, no generation) |
| `DELETE /api/chats/:id/messages/:mid` | deletes the message **and its subtree** → `{ deleted: [ids], activeLeafId, path }` (summaries anchored in the subtree are dropped) |
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
| `POST /api/chats/import` | body: a `harness.chat` export, a `harness.backup`, or `{ title?, messages: [{role, content}] }` (OpenAI style) → `201 { chats: ChatSummary[] }` (ids that already exist are regenerated). Limit 100 MB |
| `GET /api/search?q=…[&limit=50]` | full-text over all messages (all branches) and titles; every term must match → `{ query, results: [{ chatId, chatTitle, messageId, role, snippet, highlights: [[start,end]], createdAt, onActivePath }] }` (`highlights` index into `snippet`; `messageId: null` for title-only hits). To open a hit off the active branch: `POST /branch {messageId}` |
| `GET /api/export` | full backup download: `{ format: "harness.backup", version: 1, exportedAt, settings, presets, memories, chats }` |

### 5.9 Memories

| | |
|---|---|
| `GET /api/memories[?q=][&category=][&pinned=true\|false][&limit=500][&offset=0]` | → `{ total, memories: Memory[], enabled, categories }` (pinned first, then most recently updated) |
| `POST /api/memories` | `{ content, category?, pinned?, dedupe?: true }` → `201 { action: "added"\|"updated"\|"unchanged", memory }` — near-duplicates update the existing memory |
| `PATCH /api/memories/:id` | `{ content?, category?, pinned? }` → `{ memory }` |
| `DELETE /api/memories/:id` | → `{ ok: true }` |
| `DELETE /api/memories?confirm=true` | delete all → `{ deleted: n }` (without `confirm` → 400) |
| `POST /api/memories/search` | `{ query, k?: 10, minSimilarity? }` → `{ results: [{ memory, score, semantic: number\|null, lexical }], retrieval: "hybrid"\|"bm25", embeddingModel }` — a "what would be recalled?" tester |
| `POST /api/memories/extract` | `{ chatId, full?: false }` run extraction now (else it runs ~4 s after each turn in the background) → `{ added: Memory[], updated: Memory[], skipped: string[] }` |

Global on/off: `settings.memory.enabled`; per chat: `chat.settings.memory.enabled` or `incognito`. Secrets (API keys, passwords) are never stored.

### 5.10 Attachments

| | |
|---|---|
| `POST /api/attachments?name=<filename>[&chatId=…]` | **raw file body** (`Content-Type` = the file's MIME type; `X-Filename` header also accepted). Max 50 MB → `201 { attachment }` |
| `GET /api/attachments/:id` | → `{ attachment }` |
| `GET /api/attachments/:id/content` | the original bytes (use as `<img src>` for previews) |
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
| `image_status` | `jobId, phase` + phase data: `starting` (`params, family, warnings, providerId`) · `unloading` (`models, reason, message`) · `unloaded` (`models`) · `generating` (`message`) · `saving` |
| `image_progress` | `jobId, progress (0..1), step, steps, etaSeconds` (A1111 progress polling; ComfyUI WebSocket; none for OpenAI-images) |
| `image` | `jobId, image: ImageRecord, index` (one per image) |
| `image_done` | `jobId, job, images: ImageRecord[], chatModelUnloaded: bool, reload: "lazy"\|"eager"\|null` |
| `image_error` | `jobId, code ("aborted"\|…), message, job` |
| `done` | `{ job, images, message?, userMessage?, chat? }` — direct stream only |
| `error` | `{ code, message, messageId? }` — direct stream only (`code: "aborted"` when cancelled) |

`"stream": false` → `200 { job, images, message?, userMessage?, chat? }`.

RAM coordination: before generating, Harness may unload Ollama models (`image_status: unloading/unloaded`). The chat model reloads on the next chat request (`model_status: loading → ready` in that chat stream) — or right away with `reloadAfter: "eager"` (not on ≤ 8 GB; progress then appears as `model.status` bus events). Background LLM work (memory extraction, titles, recall embeddings) waits while a job runs or the chat model is unloaded.

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
| `model.measured` | `{ providerId, model, sample: {numCtx, sentNumCtx, reportedContext, totalBytes, vramBytes, kvCacheType, at} }` |
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

Fake Ollama models: `nemotron-3.5-bolt:e4b` (tools, thinking, vision; metadata says 128K → Harness uses 64K), `hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:Q4_K_M`, `qwen3:4b` (thinking), `gemma3:4b` (vision), `deepseek-r1:1.5b` (inline `<think>` tags), `gemma2:2b` (no tools), `embeddinggemma:latest`. Pullable: `llama3.2:3b`, `nomic-embed-text`.

Trigger phrases (fake chat model; tools must be offered): `calculate <expr>`, `what time is it`, `please remember that <fact>`, `draw <subject>` / `generate an image of <subject>`, `fetch <url>`, `recall <query>`, `loop forever` (iteration cap), `use tool <name> {json}`, `long answer <N>` (N words, good for abort/scroll testing), `my name is <Name>` / `I prefer …` / `I live in …` / `I'm working on …` (memory extraction). Otherwise it answers `You said: <your message>`.
