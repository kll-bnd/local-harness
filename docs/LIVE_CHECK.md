# Live conformance check

`scripts/live-check.mjs` runs next to the **real** backends (Ollama, llama.cpp `llama-server` / LM Studio / MLX,
Draw Things / AUTOMATIC1111 / Forge, ComfyUI, OpenAI-style image servers) and reports, check by check, which
assumptions the Harness code makes about their APIs hold. Zero npm dependencies, Node ≥ 20 (22 recommended).

> **Status.** Run against a **real Ollama 0.40.13 on macOS** (GitHub's Apple Silicon runner, "Apple M1 (Virtual)",
> 7 GB RAM, macOS 26): 47 of the 53 Ollama/environment checks passed, 3 were skipped for lack of an embedding model,
> and the 1 failure was a genuine Harness bug, since fixed. It has **not** been run against llama.cpp, LM Studio,
> MLX, Draw Things, AUTOMATIC1111 or ComfyUI: those checks have only met the fakes (`test/fake-*.mjs`) and
> deliberately deviant copies of them (`test/live-check.test.mjs`). A check that FAILs against one of those can be
> wrong itself: read its `actual` excerpt before changing `server/`.

## Running it

```sh
node scripts/live-check.mjs                                  # safe default: auto-detect, read-only probes + tiny chats
node scripts/live-check.mjs --allow-pull --allow-images \
     --json live-check.json --markdown live-check.md          # everything, with reports
node scripts/live-check.mjs --timeout-scale 3                # slow / swapping 8 GB machine
node scripts/live-check.mjs --only ollama,e2e --model qwen3:0.6b
node scripts/live-check.mjs --list                           # every check id with the assumption it tests
node scripts/live-check.mjs --help                           # all options
```

Good model set for an 8 GB Mac (all small): `qwen3:0.6b` (tools + thinking), `gemma3:270m` (no tools or thinking:
gives the "does not support …" error texts) and `all-minilm` (embeddings). The checker picks models from what is
installed (via `/api/show` capabilities) and prints which one it took for what and why. Override that with
`--model`, `--tool-model`, `--think-model`, `--plain-model` and `--embed-model`.

Backends are found on their default ports (Ollama `OLLAMA_HOST` or 11434, llama.cpp/MLX 8080, LM Studio 1234,
Draw Things/A1111 7860, ComfyUI 8188). `--no-detect` plus `--ollama-url`, `--llamacpp-url`, `--lmstudio-url`,
`--openai-url` (repeatable), `--a1111-url`, `--comfyui-url` and `--openai-images-url` restrict it to the URLs you give.

## What it checks

Two layers, labelled in every line of the output:

- **[raw]**: probes that talk straight to each backend and assert the request/response shapes the provider code
  relies on: NDJSON/SSE framing, token counts and units, `prompt_eval_count` with a warm cache, `num_ctx` → `/api/ps`
  size and `context_length`, every `keep_alive` form the settings allow, unload latency, thinking and tools (and the
  exact error texts Harness matches on to retry), structured output with Harness's real `MEMORY_SCHEMA`, embeddings,
  pull progress, abort mid-stream, the context sources of OpenAI-compatible servers, A1111 field names, grid
  handling and seeds, the ComfyUI default workflow, WebSocket progress, history and validation errors.
- **[e2e]**: starts the real Harness server in-process (`startServer`, free port, temp data dir, no Ollama
  auto-start) wired to the same backends, then drives product flows over HTTP/SSE: chat stream, the context plan
  (printed with its explanation), measurements after the first turn, token calibration over three turns, reasoning,
  a tool turn, forced and automatic compaction (1K window), memory extraction, embeddings-based memory search,
  OpenAI-compatible chat, pull/delete through Harness, direct image generation, and the `generate_image` tool with
  the unload → generate → reload sequence (forced with `image.unloadChatModel: "always"`).

Each check has an id, the assumption it tests, the Harness code that depends on it (`file:line (function)`,
resolved at run time from code anchors, so it follows edits to `server/`), a status, and on WARN/FAIL the expected
value, a redacted excerpt of the real answer and a one-line fix. SKIPs say what would be needed to run them.

| status | meaning |
|---|---|
| PASS | the assumption holds |
| WARN | Harness copes but degrades (wrong numbers, missing progress, unhelpful error), the result is model behaviour, or the check could not verify the assumption |
| FAIL | the assumption does not hold and something in Harness breaks or computes wrong results |
| SKIP | not run; `needs` says what would make it run |

Exit code: **0** no FAIL, **1** at least one FAIL, **2** no backend reachable.

Also printed: OS/chip/memory/swap, Node, Ollama version, `OLLAMA_*` visible to this process and (macOS) to
`launchctl`, and what is listening on the default ports.

## Harness 0.2: password, locking, the internet blocker, the catalogue

The e2e layer runs Harness with its **real 0.2 defaults** (password mode, internet blocked). On its fresh
temporary data dir it sets up a **throw-away password** through `POST /api/security/setup`, exactly like the
setup screen, asking for its session as a bearer token (`"session": "token"`, which Harness refuses to any request
that looks like a browser page); the password lives only in the checker's memory, and the recovery key is checked
for its shape and discarded. Every report redacts passwords, recovery keys, session tokens/cookies and launch codes. The
backends found on this Mac are then wired in with `PATCH /api/settings`. Downloads in the e2e layer
(`e2e.pull_delete`) open the internet window with that password and block again right after.

| check | what it proves |
|---|---|
| `e2e.setup`, `e2e.auth_required`, `e2e.wrong_password` | first start, the session, 401 without one, no bearer token for a request with an `Origin` (403 `token_refused`) or without `"session": "token"`, the wrong-password answer and its retry delay |
| `e2e.vault_error` | a throw-away Harness whose key store (and its `.bak` copy) is damaged, then missing: state `error` (`vault_corrupt` / `vault_missing`), setup 409, data routes 503, never `needs_setup` |
| `e2e.blocker.default` | a fresh install blocks internet access; the backend's self-test (`POST /api/network/test`) reports blocked, and answers without a session |
| `e2e.blocker.catalog`, `e2e.blocker.pull`, `e2e.blocker.fetch_url` | while blocked: the online catalogue and pulls answer `403 offline_lock`; `fetch_url` is not offered (a tool model is asked to use it) |
| `e2e.blocker.allow` | allowing needs the password (403 / 401 without / with a wrong one); with `--allow-internet` the window really opens |
| `e2e.catalog.huggingface`, `e2e.catalog.ollama` | **only with `--allow-internet`, while the window is open**, through the real `/api/catalog` routes: the Hugging Face adapter (a list page with fit badges; the Nemotron repository's files) and the Ollama adapter (`ollama.com/search`: official library models only, a second "load more" page without repeats; one model's tags). These are the checks most likely to break when a site changes: a FAIL names the adapter's file:line and includes the response excerpt |
| `e2e.blocker.reblock` | blocking again takes effect at once |
| `e2e.blocker.sandboxed_ollama` | macOS with Ollama installed: a second throw-away Harness starts its **own** Ollama on a spare port while blocked; it must run in the sandbox (`osScope: "ollama"`), a pull sent **straight to that Ollama** must fail, and the self-test's OS probe must be blocked |
| `e2e.lock.routes`, `e2e.lock.models_unloaded`, `e2e.lock.marker_not_on_disk`, `e2e.lock.unlock_again` | after a memory, a chat title and a chat turn containing a unique marker, `POST /api/security/lock`: data routes → 423, Ollama no longer holds the chat model, **the marker is not findable in any file of the data dir** (UTF-8, UTF-16 or base64), and unlocking again makes it readable through the API |

Against a backend without `/api/security` (0.1) these checks SKIP. They have not yet been run on a real Mac.

## Side effects

The default run is safe and fairly quick: no pulls, no deletes, no image generation. It does load the models it
picked (Ollama may evict others for them), sends tiny chats (`num_predict` ≤ 400, `num_ctx` 2048/4096, plus the
Harness plan's own context in the e2e layer), changes their `keep_alive` and unloads at the end whatever it loaded
(`--no-unload` keeps them). Pulling a non-existent model name contacts the Ollama registry. Image interrupts are
only POSTed during the checker's own jobs.

- `--allow-pull` pulls `--pull-model` (default `all-minilm:22m`, ~46 MB) if it is not installed, and deletes it
  again at the end. A model that was installed before the run is never re-pulled or deleted.
- `--allow-images` generates a handful of tiny images (from 64×64, 1–2 steps; one 30–40-step job that is
  interrupted).
- `--allow-internet` lets the in-process Harness open its internet window (5 minutes, password-confirmed) to
  read a few pages of huggingface.co and ollama.com through its catalogue; it blocks again right after.

## Reports

- `--json FILE`: everything, including **raw captured samples of each real response shape** (`samples`, long
  arrays and base64 shortened). Use them to correct `test/fake-*.mjs`.
- `--markdown FILE`: summary, environment, picks, every FAIL/WARN with details, and a table of all checks, ready
  to paste into an issue.

Home-directory paths, user names in paths and anything that looks like a key or token are redacted everywhere.

## CI (GitHub Actions, macOS runner)

```yaml
- run: node scripts/live-check.mjs --allow-pull --allow-internet --timeout-scale 3 --json "$RUNNER_TEMP/live-check.json" --markdown "$RUNNER_TEMP/live-check.md"
- if: always()
  run: cat "$RUNNER_TEMP/live-check.md" >> "$GITHUB_STEP_SUMMARY"
```

## Maintaining it

`test/live-check.test.mjs` runs it against the fakes (it must exit 0) and against proxies that change one behaviour
at a time (string tool arguments, `prompt_eval_count` missing on a cached repeat, no `context_length`, flat
`/api/ps` size, rejected keep_alive, a different thinking error text, A1111 grid placement, options 404, no usage
in OpenAI streams…), and asserts that exactly those checks flip (and that a slow unload is reported but passes,
because Harness waits for `/api/ps`). When `server/` changes an assumption,
update the matching check. When a source anchor no longer matches, `env.harness_sources` WARNs and names the entry
to fix in the `SRC` table. An assumption Harness has deliberately dropped keeps its anchor in `SRC` and is listed in
`RETIRED_ANCHORS` (today: `measureTotal`, "/api/ps size is the whole footprint" — Harness now measures the runner
process): it is expected not to resolve, so the checks take their "no longer assumed" branch without a warning.
