# Harness

Harness is a private, local app for chatting with open-source language models on your Mac. It runs
the models through [Ollama](https://ollama.com) (or llama.cpp, LM Studio, MLX), sizes the context
window to your memory, summarizes long chats automatically, remembers facts about you across chats,
can use a few tools, and can make pictures through [Draw Things](https://drawthings.ai) or ComfyUI.
Everything stays on your computer.

It is two pieces: a small local server (plain Node.js, no dependencies) and a web UI. You use it either
as a **Mac app** (a thin Electron window around the same server) or in **your web browser**.

> **Status.** The Ollama client was checked against Ollama's published API reference; the Draw Things
> and ComfyUI clients were built from their community-documented APIs. All three were developed and
> tested against **fake** servers that imitate them, not against the real programs. If a real backend
> behaves differently, see [When a real backend disagrees](#when-a-real-backend-disagrees).

---

## Quick start (M1 MacBook with 8 GB)

You need about 10 GB of free disk space and an internet connection for the downloads.

1. **Get Harness.** In Terminal:

   ```bash
   git clone <repository-url> harness
   cd harness
   ```

   (Or download the repository as a ZIP, unzip it, and `cd` into the folder.)

2. **Run the setup script.** It checks your Mac and *asks before installing anything*:

   ```bash
   ./scripts/setup-macos.sh
   ```

   It checks macOS and Apple Silicon, finds Homebrew (it will not install Homebrew for you — see
   [brew.sh](https://brew.sh) if you want it), installs Node.js and Ollama with Homebrew if you agree,
   offers to download **the model Harness recommends for your Mac's memory**, explains how to switch on
   Draw Things' API server, and optionally builds the Mac app and copies it to Applications.
   Safe to run again at any time.

3. **Start Harness** — whichever you prefer:
   * open **Harness** from Applications (if you built the app), or
   * double-click **`Harness.command`** in the folder (opens in your browser; close the Terminal
     window to stop it), or
   * in Terminal: `npm start -- --open`

4. In Harness, pick the model and start chatting. If you skipped the download, the app offers the
   recommended model on first run.

Not sure something is set up right? Run **`npm run doctor`** — it lists what is installed and running,
what Harness recommends for this Mac, and how to fix anything missing.

### Doing it by hand

```bash
brew install node ollama            # Node.js 20+ and Ollama (or install both from their websites)
npm run doctor                      # shows the recommended model for this Mac, e.g. a Q3_K_M file
ollama pull <the model it names>    # optional — the app can download it too
npm start -- --open                 # Harness in your browser at http://127.0.0.1:4747
```

You do not need to start Ollama yourself: Harness starts it when needed and stops it again when you quit.

### The Mac app

```bash
npm install         # Electron + electron-builder (developer tools only; a few hundred MB)
npm run app         # run the app straight from this folder
npm run dist        # build dist/mac-arm64/Harness.app and dist/Harness-0.1.0-arm64.dmg
```

Copy `Harness.app` to Applications (the setup script offers to). The build is **ad-hoc signed** on your
own Mac, which is what Apple Silicon requires to run it; because it was built locally it opens without
Gatekeeper warnings. It is not notarized, so a copy sent to *another* Mac would be blocked — build it
there instead. Details: [docs/DESKTOP.md](docs/DESKTOP.md#packaging-electron-builder).

In the app: closing the window keeps Harness running in the Dock (⌘Q quits); **⌘⇧Space** shows or
hides it from any app (change or disable it in `desktop.json`, see [Your data](#your-data));
**⌘N** new chat, **⌘K** command palette, **⌘.** stop generating, **⌘,** settings, **⌘/** all shortcuts.

---

## Models on an 8 GB Mac

NVIDIA **Nemotron 3.5 Bolt E4B** is the recommended chat model. Its standard Ollama tag,
`nemotron-3.5-bolt:e4b`, is about 6 GB — more than an 8 GB Mac can hold next to macOS. Harness
therefore recommends a smaller quantization of the same model from
`hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF` for your machine. Use whatever **`npm run doctor`**
or the app's model list names as recommended; the list also shows, for every file, how big a context
window it would get on your Mac.

Other models work too (anything Ollama can run). Small ones (2–4 billion parameters) are the
comfortable range on 8 GB.

---

## How memory works

"Memory" means two different things in Harness.

### 1. The context window (working memory, in your Mac's RAM)

A model can only "see" a limited number of tokens at once — its *context window*. Nemotron 3.5 Bolt
E4B is trained for 64K tokens. But every token in the window needs space in the model's *KV cache* in
RAM, on top of the model file itself. On an 8 GB Mac, macOS and your other apps need about 3 GB, which
leaves Harness a safe budget of roughly **4.8 GB** for the model *and* its context. A 64K window
does not fit in that: for example, Harness estimates ~5.6 GB for the Q4_K_M file at 64K, which would
push the Mac into swap and make everything crawl.

So for every model Harness works out **the largest window that fits the safe budget** (from the model
file size, its architecture and the cache precision) and uses that. On 8 GB Macs it also caps the
automatic window at 16K, because reading a very long prompt is slow on that hardware. Typical results on
8 GB (estimates; the app shows the real ones for your Mac):

| model file | context Harness uses |
|---|---|
| `nemotron-3.5-bolt:e4b` (≈6 GB) | 2K — the model alone exceeds the budget; use a smaller file |
| `…GGUF:Q4_K_M` (≈4.3 GB) | ≈4K — limited by RAM |
| `…GGUF:Q3_K_M` (≈3.9 GB) | 16K — the 8 GB cap (RAM would allow more) |

The app explains the choice next to the model ("16K of 64K context — capped for responsiveness…").
You can override it per chat or in settings (`auto`, a number, or `max` = the model's full window
regardless of RAM — expect swapping). When Harness starts Ollama itself it also turns on Ollama's
flash attention and 8-bit KV cache, which roughly halves the cache's size, so a larger window fits.
If the Ollama menu-bar app is already running, Harness uses it as it is (with Ollama's defaults);
quit it and let Harness start Ollama if you want those savings.

The context meter in a chat shows how full the window is and what is using it (system prompt, tools,
memories, summary, documents, history).

### 2. Keeping long chats going: the auto-summarizer

When a chat fills about 75% of the window, Harness summarizes the older messages — using the same
chat model, so no second model is loaded — into a structured summary (goals, key facts, decisions,
your preferences, code and artifacts, open threads). The summary replaces those messages in what the
model sees; the most recent messages are kept word for word. Nothing is deleted: the chat still shows
every message, with a divider where the summary starts. You can read and edit the summary, compact
manually ("Compact now"), or turn it off for a chat. Summaries are incremental: the next one builds on
the previous one.

### 3. Long-term memory (across chats)

After each reply, Harness quietly extracts lasting facts ("prefers metric units", "is working on a
thesis about…") and stores them as **memories**. Relevant memories are added to later chats
automatically; **pinned** memories are always included. The model can also save one when you say
"remember that…" (the `remember` tool) and can search your memories and past chats (`recall`). You can
view, edit, pin and delete memories in the app. Secrets such as passwords and API keys are not stored.
An **incognito** chat neither reads nor writes memories and is left out of recall.

On 8 GB Macs, memory search uses keyword matching (BM25) only, because a separate embedding model would
compete for RAM; you can opt in to an embedding model (e.g. `embeddinggemma`) in settings.

---

## Making images with Draw Things

[Draw Things](https://drawthings.ai) is a free Mac app (Mac App Store) that runs Stable Diffusion-class
models on Apple Silicon. Harness talks to its HTTP API, which speaks the AUTOMATIC1111 API on port 7860.

1. Install **Draw Things** from the Mac App Store and open it.
2. In Draw Things, download a model and **select it there** — Harness generates with the model that is
   currently selected in Draw Things.
3. Open Draw Things' **Settings** and turn on **API Server** (also labelled *HTTP Server*): protocol
   **HTTP** (not gRPC), port **7860**. Keep Draw Things running.
4. Check it from Terminal: `curl http://127.0.0.1:7860/sdapi/v1/options` prints its settings when the
   server is on. Harness detects it automatically (`npm run doctor` shows it too).

Then ask for a picture in a chat ("draw a lighthouse at dusk" — the chat model calls Harness's
`generate_image` tool) or generate directly from the app's image screen.

**What is realistic on 8 GB:** Stable Diffusion 1.5-class models run comfortably. SDXL-Turbo-class
models work but are tight. Large models (SDXL base, FLUX, SD3) are not practical. To make room, Harness
**unloads the chat model** before each image and reloads it on your next message (that first reply
takes a few extra seconds), keeps image sizes in the ~512 px class, and warns about heavy settings
instead of blocking them. Draw Things' own memory use is outside Harness's control: close other apps
if generation is slow.

---

## Other backends

Harness auto-detects these when they are running on their default ports (nothing to configure):

| backend | how to run it | notes |
|---|---|---|
| **llama.cpp** | `llama-server -m model.gguf -c 8192 --port 8080` | the context size is fixed by `-c`; Harness reads it |
| **MLX** | `mlx_lm.server --model <mlx-model> --port 8080` | OpenAI-compatible, like llama.cpp |
| **LM Studio** | start its local server (port 1234) | models are loaded in LM Studio |
| **ComfyUI** (images) | `python main.py` (port 8188) | Harness ships a default workflow; you can supply your own API-format workflow in settings |
| **AUTOMATIC1111 / Forge** (images) | start with `--api` (port 7860) | same API as Draw Things |

Any other OpenAI-compatible chat server (or image server such as LocalAI) can be added in settings
under providers with its URL. Context sizing, unloading and pulling models are Ollama features; with the
other servers you manage those in the server itself.

---

## Privacy

* The Harness server listens on **127.0.0.1 only** — other devices on your network cannot reach it —
  and rejects requests from web pages on other sites.
* **No telemetry, no accounts, no cloud.** Harness itself contacts no outside server.
* The only outbound internet access is:
  * **model downloads**, which Ollama performs when you pull a model (from Ollama's registry or Hugging
    Face for `hf.co/…` models), and
  * the optional **`fetch_url` tool**, which lets the model read a web page you point it at. It is
    **off by default** and cannot reach your local network unless you allow that.
* Harness's other connections are to programs on your own Mac: Ollama (11434), and — if running —
  Draw Things/AUTOMATIC1111 (7860), ComfyUI (8188), llama.cpp/MLX (8080), LM Studio (1234).
* In the Mac app, the window can only load content from the local Harness server: images or scripts
  from the internet (for example a remote image in a model's answer) are blocked, links open in your
  browser, and camera, microphone, location and notifications are denied.
* Draw Things, Ollama and your browser have their own privacy policies.

## Your data

Everything lives in one folder: **`~/Library/Application Support/Harness`** — the same one whether you
use the app, `npm start` or `Harness.command`. (In Finder: Go → Go to Folder…, or File → Show Data
Folder in Finder in the app.)

| | |
|---|---|
| `settings.json` | your settings |
| `chats/` | conversations (all branches and summaries) |
| `attachments/`, `images/` | files you attached; generated pictures |
| `memories.json`, `presets.json` | long-term memories; your presets |
| `index/`, `calibration.json` | search indexes; learned token counts |
| `desktop.json` | Mac-app options: global shortcut, port, hide-on-close |
| `logs/harness.log` | the Mac app's log (Help → Show Log File) |
| `Electron/` | the Mac app's window state and browser cache |

Models are not in this folder: Ollama keeps them in `~/.ollama/models` (`ollama list`, `ollama rm`), and
Draw Things manages its own.

**Back up:** quit Harness, then copy the folder, e.g.
`ditto ~/Library/Application\ Support/Harness ~/Desktop/Harness-backup`. (The JSON backup export —
`http://127.0.0.1:4747/api/export` — contains chats, memories, presets and settings, but not image and
attachment files.)

**Reset:** quit Harness and move the folder to the Trash. Harness starts fresh next time. To keep your
chats but reset only the settings, use the reset option in the app's settings (API:
`POST /api/settings/reset`).

To use a different folder, start Harness with `HARNESS_DATA_DIR=/path/to/folder`.

---

## Troubleshooting

Start with **`npm run doctor`**.

| problem | what to do |
|---|---|
| "Ollama is not installed" / no models | `brew install ollama` (or the app from ollama.com), then download the recommended model in the app or with `ollama pull …` |
| Replies are very slow, the Mac stutters | the model or context is too big: use the recommended (smaller) model file, keep the context on `auto`, quit memory-hungry apps. Activity Monitor → Memory → "Swap Used" should stay low |
| "model_not_found" / pull fails | check the exact tag; `hf.co/…` tags need a reasonably recent Ollama (`brew upgrade ollama`) |
| Image generation: "no image provider" | Draw Things must be running with its API Server on (HTTP, port 7860); test with `curl http://127.0.0.1:7860/sdapi/v1/options` |
| Image generation finishes but no image comes back | keep a **project open** in Draw Things (a known Draw Things issue with some models), and make sure a model is selected there |
| First reply after an image is slow | expected on 8 GB: the chat model was unloaded for the image and is loading again |
| Port 4747 is busy | Harness uses the next free port automatically; the app/launcher shows the URL. Or set `HARNESS_PORT` |
| The app shows an error at start | Help → Show Log File, or `~/Library/Application Support/Harness/logs/harness.log` |
| The Mac app won't open after copying it from another Mac | it is ad-hoc signed and not notarized; build it on this Mac (`npm run dist`) — see docs/DESKTOP.md |
| `Harness.command` "cannot be verified" | right-click it → Open once, or run `./Harness.command` in Terminal |
| ⌘⇧Space does nothing | another app owns that shortcut; set `"globalShortcut"` in `desktop.json` (e.g. `"Alt+Command+H"`, or `null` to disable) and restart Harness |
| Start completely fresh | see [Reset](#your-data) |

### When a real backend disagrees

The integrations were written against Ollama's API reference and community descriptions of the Draw
Things and ComfyUI APIs, and tested against fakes (`test/fake-*.mjs`). If something fails with the real
program:

1. Look at `logs/harness.log` (Mac app) or the Terminal output for the request that failed, and at the
   backend's own log (Ollama: `~/.ollama/logs/server.log`).
2. Check the backend directly — e.g. `curl http://127.0.0.1:11434/api/tags`,
   `curl http://127.0.0.1:7860/sdapi/v1/sd-models`.
3. Update Ollama / Draw Things; then report the difference (request, response, versions). The fakes in
   `test/` encode exactly what Harness expects, so fixing a mismatch means updating the client in
   `server/providers/` or `server/image/` *and* its fake.

---

## Development

```bash
npm start                    # server + UI on http://127.0.0.1:4747 (no npm install needed)
npm run dev:fake             # real server + fake Ollama, Draw Things, ComfyUI, llama.cpp — no models needed
npm run dev:fake -- --ram 8  # …pretending the machine has 8 GB
npm test                     # backend + desktop-shell unit tests (node --test)
npm run doctor               # environment check (--json, --recommended-model, --version)
npm install && npm run app   # the Electron shell
npm run test:e2e             # launches the real Electron app and smoke-tests it (uses Xvfb on Linux)
npm run icons                # regenerate build/icon.icns + icon.png from build/icon.svg
```

Requirements: Node.js 20+. The server has **no runtime dependencies**; Electron and electron-builder
are development dependencies used only for the Mac app.

* `server/` — backend (HTTP + SSE API, documented in [docs/API.md](docs/API.md))
* `public/` — web UI
* `electron/` — Mac app shell ([docs/DESKTOP.md](docs/DESKTOP.md))
* `scripts/` — `setup-macos.sh`, `doctor.mjs`, `launch.mjs` (behind `Harness.command`), `dev-fake.mjs`, `make-icons.mjs`
* `test/` — tests and the fake backends
