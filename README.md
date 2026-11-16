# Harness

Harness is a private, local app for chatting with open-source language models on your Mac. It runs
the models through [Ollama](https://ollama.com) (or llama.cpp, LM Studio, MLX), sizes the context
window to your memory, summarizes long chats automatically, remembers facts about you across chats,
can use a few tools, and can make pictures through [Draw Things](https://drawthings.ai) or ComfyUI.
Everything stays on your computer.

Version 0.2 adds: **a password that opens Harness, with your chats, memories and files encrypted on disk**;
a built-in **internet blocker**, on by default, that never gets in the way of chatting; a browsable **model
catalogue** (the Ollama library and GGUF models on Hugging Face, filtered to what your Mac can run); and a
**native Mac app** that needs no local web server (see [Ways to run Harness](#ways-to-run-harness)).

Under the hood it is a small backend (plain Node.js, no dependencies) and a web UI, shown in the native app,
the Electron app or your web browser.

> **Status (0.2.0).** Harness 0.1 was verified on a real Mac in CI (GitHub's Apple Silicon runner, "Apple M1
> (Virtual)", 7 GB RAM, macOS 26, real Ollama 0.40.13): the backend tests, building and signing the Electron app,
> its end-to-end test from source and packaged, the UI tests in WebKit, the live check against real Ollama, and
> Nemotron 3.5 Bolt E4B (text-only `UD-Q3_K_XL`) chatting, calling tools, thinking on/off and JSON output.
> **The 0.2 features — password and encryption, locking, the internet blocker and its macOS sandbox, the
> catalogue and the native app — are built and tested on Linux against the contract, but have not yet run on
> a real Mac** (the CI runs that check them are pending). Never verified: a person using the window on a
> physical Mac, Gatekeeper on a physical machine, real speeds on a real M1, and Draw Things / ComfyUI /
> llama.cpp / LM Studio, which were only tested against fakes. See [If something doesn't work](#if-something-doesnt-work).

---

## Quick start (M1 MacBook with 8 GB)

You need about 10 GB of free disk space and an internet connection for the downloads (the model file is
about 4.5 GB).

1. **Get Harness.** In Terminal:

   ```bash
   git clone https://github.com/kll-bnd/local-harness.git harness
   cd harness
   ```

   (Or download the repository as a ZIP, unzip it, and `cd` into the folder.)

2. **Run the setup script.** It checks your Mac and *asks before installing anything*:

   ```bash
   ./scripts/setup-macos.sh
   ```

   It checks macOS and Apple Silicon, finds Homebrew (it will not install Homebrew for you — see
   [brew.sh](https://brew.sh) if you want it), installs Node.js and Ollama with Homebrew if you agree, opens
   Harness so **you choose your password** there ([first start](#first-start-your-password)), downloads **the
   model file Harness recommends for your Mac's memory** — asking your password to allow internet access for
   that download only — and, on an 8 GB Mac, makes the **text-only copy** of it ([why](#models-on-an-8-gb-mac)),
   explains how to switch on Draw Things' API server, and optionally builds the Electron app. Safe to run
   again at any time.

3. **Start Harness** — whichever you prefer ([details](#ways-to-run-harness)):
   * open **Harness** from Applications (if you built an app), or
   * double-click **`Harness.command`** in the folder (opens in your browser; close the Terminal
     window to stop it), or
   * in Terminal: `npm start -- --open`

4. **Type your password**, then start chatting: Harness picks the best installed model automatically. If you
   skipped the download, the setup page offers the recommended file and the text-only copy ("Download & set
   up"); it asks your password to allow internet access for the download.

### First start: your password

The first time Harness opens it asks you to **choose a password** (at least 8 characters). Harness never
stores it: it derives the key that unlocks your data from it each time you type it. It then shows a
**recovery key** (`HRK1-…`) **once**. Write it down or keep it in a password manager — not in a chat, a
plain-text note or a screenshot. If you forget the password, the recovery key lets you set a new one; **if
you lose both, nobody can open your data, not even you.** That is the point of the design, so take the
recovery-key step seriously.

After that Harness asks for the password whenever it opens, after 15 minutes without use (adjustable in
Settings), when you choose **Lock Harness** (⌃⌘L in the apps), and — in the apps — when the Mac sleeps or
its screen locks. Command-line tools that need your data (`npm run get-model`, `npm run doctor -- --unlock`)
ask for it in the terminal without showing it; they never choose a password for you.

Not sure something is set up right? Run **`npm run doctor`** — it lists what is installed and running,
what Harness recommends for this Mac, and how to fix anything missing.

### Doing it by hand

```bash
brew install node ollama    # Node.js 20+ and Ollama (or install both from their websites)
npm start -- --open         # Harness in your browser: choose your password there, save the recovery key
npm run get-model           # (in a second Terminal) asks your password, allows internet for the download,
                            # downloads the recommended file, makes the text-only copy on 8 GB, blocks again
```

**Let Harness start Ollama** — don't leave the Ollama menu-bar app or `brew services` running it. Only an
Ollama that Harness starts itself gets Harness's memory protections: flash attention, a q8_0 KV cache, one
model in memory at a time, a prompt cache capped at 512 MB on 8 GB Macs (Ollama's default allows up to
8 GB), and `OLLAMA_NO_CLOUD=1`. Harness starts Ollama when it launches and stops it when you quit;
`npm run doctor` tells you whether the protections are in effect.

## Ways to run Harness

### The native app (recommended)

<!-- NATIVE-APP-SECTION: placeholder, to be written from docs/NATIVE.md once the native app is reported working. -->
> **Placeholder.** Harness 0.2 includes a native macOS app that runs the backend with **no localhost server**
> (it talks to it over private pipes, `docs/BRIDGE.md`) and uses less memory than the Electron app. This
> section will say how to build and open it once it is ready; until then, use the Electron app or the browser.

### The Electron app

```bash
npm install         # Electron + electron-builder (developer tools only; a few hundred MB)
npm run app         # run the app straight from this folder
npm run dist        # build dist/mac-arm64/Harness.app and dist/Harness-0.2.0-arm64.dmg
```

Copy `Harness.app` to Applications (the setup script offers to). The build is **ad-hoc signed** on your
own Mac, which is what Apple Silicon requires to run it; because it was built locally it is not
quarantined and should open without Gatekeeper warnings. **Building it yourself is the supported route.**

A prebuilt `.dmg` is attached to each run of the **macOS verification** workflow (the repository's
**Actions** tab → a run → *Artifacts* → `Harness-mac-arm64`, kept for 7 days; you must be signed in to
GitHub). A downloaded copy is quarantined, and because it is only ad-hoc signed and not notarized macOS
will refuse to open it ("damaged" / "cannot be verified"). If you choose to use it anyway — and trust the
build — copy the app to Applications and clear the flag:
`xattr -dr com.apple.quarantine /Applications/Harness.app`. Details:
[docs/DESKTOP.md](docs/DESKTOP.md#packaging-electron-builder).

In the app: closing the window keeps Harness running in the Dock (⌘Q quits); **⌘⇧Space** shows or
hides it from any app (change or disable it in `desktop.json`, see [Your data](#your-data));
**⌃⌘L** locks Harness, and it locks itself when the Mac sleeps or the screen locks;
**⌘N** new chat, **⌘K** command palette, **⌘.** stop generating, **⌘,** settings, **⌘/** all shortcuts.
The Electron app runs Harness's backend inside the app and talks to it over `127.0.0.1`, like the browser.

### In your browser

`npm start -- --open`, or double-click `Harness.command`: the backend runs in Terminal (close the window
or press Ctrl+C to stop it) and your browser opens it. The browser keeps a session cookie for 12 hours or
until Harness locks; browsers share cookies between all `localhost` ports, so another local web server you
visit could see it — the apps avoid that.

---

## Models on an 8 GB Mac

NVIDIA **Nemotron 3.5 Bolt E4B** is the recommended chat model. Which file to use depends on your memory,
and `npm run doctor`, `npm run get-model` and the app all name the right one for *your* Mac:

| file | download | on 8 GB |
|---|---|---|
| `nemotron-3.5-bolt:e4b` (official) | 7.9 GB: 6.2 GB model + 1.0 GB vision/audio projector + 0.7 GB helper (draft) model | not usable |
| `hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q4_K_XL` | 4.8 GB model + 0.95 GB projector | too big |
| `…:UD-Q3_K_XL` | 4.0 GB model + 0.95 GB projector | the largest that is realistic, as a text-only copy: it runs, with almost nothing to spare |
| `…:UD-IQ3_XXS`, `…:UD-Q2_K_XL` | ≈3.5 GB model + 0.95 GB projector | **the comfortable choice** as a text-only copy (what Harness suggests), with a small quality loss |

Use the tags exactly as written: `…:Q3_K_M` / `…:Q4_K_M` do not exist, the aliases without `UD-` do not
download, and `nemotron-3.5-bolt:latest` is a different, much bigger model.

**The text-only copy.** Each file includes a ~1 GB vision/audio part. On 8 GB Harness recommends a
*text-only copy*: the same weights without that part, made in about 2 seconds without downloading anything
(`npm run get-model`, the setup page, or Models → "Make text-only copy"). The copy needs about 1 GB less
memory; it can't read images you attach, but it can still ask Draw Things to *generate* them. Afterwards you
can delete the original download to free ~1 GB of disk; the copy keeps the weights.

What was measured on a 7 GB Apple Silicon test machine: the text-only `UD-Q3_K_XL` copy loaded, answered,
followed a system prompt, called tools (asked "Draw me a red fox in the snow." it called `generate_image` with
`{"prompt":"a red fox in the snow"}`), thought or didn't on request, and produced JSON. Its process used
about **4.3 GB**, and that machine was already compressing and swapping memory. So on an 8 GB Mac
`UD-Q3_K_XL` is borderline — it runs, with almost nothing left for macOS and your apps — and `UD-IQ3_XXS`
is the comfortable choice. (That machine's virtual GPU managed 1–3 tokens/s; that says nothing about a real M1.)

Other models work too (anything Ollama can run); 2–4-billion-parameter models are comfortable on 8 GB.

### Finding other models: the catalogue

The **Models** screen browses three sources without typing anything: **This Mac** (installed models and
Harness's recommendations — works offline), the **Ollama library** (models Ollama itself packages; the
dependable source) and **Hugging Face** (GGUF repositories; the widest choice). Sort by trending, downloads,
likes or newest; filter by kind (chat, vision, embedding), size, publisher, and **"fits this Mac"**. A model's
page lists every file with its size and whether it fits, and recommends one; a single button downloads it
(and, on 8 GB, makes the text-only copy). Gated Hugging Face repositories are shown but not downloadable.

Browsing the online sources needs internet, so it asks you to **allow internet for 15 minutes** (your password
confirms). Harness sends those sites no account, cookie or identifying header, keeps what it fetched in
memory only, and never gives their text to the model. Everything you see there was written by strangers:
model cards are shown, not trusted.

---

## How memory works

"Memory" means two different things in Harness.

### 1. Your Mac's RAM and the context window

A model needs RAM for its **weights** (the model file) plus a **KV cache** that grows with the *context
window* — how many tokens it can see at once. Nemotron 3.5 Bolt E4B is trained for 64K tokens. On an 8 GB
Mac, macOS and your apps need about 3 GB, which leaves Harness a safe budget of roughly **4.8 GB**.

For this model the context is cheap and the **weights decide**: only 4 of its layers keep a full-length
cache, so at Harness's q8_0 cache precision the KV cache is about 34 MB at 4K tokens and 136 MB at 16K
(plus a constant ~21 MB) — figures that match llama.cpp's own log. The ~4 GB of weights is what decides
whether it fits, which is why the file choice and the text-only copy matter so much on 8 GB:

| on an 8 GB Mac | weights | context Harness uses |
|---|---|---|
| official `nemotron-3.5-bolt:e4b` | 6.2 GB (+ projector) | doesn't fit — use a smaller file |
| `UD-Q3_K_XL`, text-only copy | 4.0 GB | 16K (Harness's 8 GB cap), with very little RAM to spare |
| `UD-IQ3_XXS`, text-only copy | ≈3.5 GB | 16K, comfortably |

Harness works out **the largest window that fits the safe budget** for every model (from the file, the
architecture and the cache precision) and caps the automatic window at 16K on 8 GB Macs, because reading
a very long prompt is slow there. After a model has run, Harness **measures** what it really occupies
(the runner process's memory and whether macOS started swapping) and corrects its plan; if loading a
bigger window made the Mac swap, it backs off. The app shows the reasoning next to the model ("16K of 64K
context — capped for responsiveness…"). You can override the window per chat or in settings (`auto`, a
number, or `max`). For other models, with a full-length cache in every layer, the window does cost real
memory, and the same logic keeps it in budget.

The q8_0 cache and the other protections apply only when Harness starts Ollama itself (see
[above](#doing-it-by-hand)). For an Ollama started some other way Harness can't see its settings, assumes
the larger f16 cache, and says so.

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
`generate_image` tool; a text-only copy can do this too) or generate directly from the app's image screen.
The Draw Things connection has only been tested against a fake Draw Things so far.

**What is realistic on 8 GB:** Stable Diffusion 1.5-class models run comfortably. SDXL-Turbo-class
models work but are tight. Large models (SDXL base, FLUX, SD3) are not practical. To make room, Harness
**unloads the chat model** before each image and reloads it on your next message (that first reply
takes extra time), keeps image sizes in the ~512 px class, and warns about heavy settings
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

## Privacy and security

### What 0.2 protects, and what it doesn't

| situation | protected? |
|---|---|
| Someone gets your Mac, its disk or a copy of the data folder while Harness is **locked** or quit | **Yes.** Chats, memories, attachments, images, settings and indexes are encrypted (AES-256-GCM). The key is derived from your password (scrypt, 128 MiB per try, so guessing is slow) and exists only in Harness's memory while it is unlocked. |
| Other programs running as you, while Harness is **locked** | **Yes** — they can read the folder but not decrypt it. (Not in "Keychain" mode, below: any program running as you can ask the Keychain for the key.) |
| Other programs running as you, while Harness is **unlocked** | **No.** A malicious program running as you can read your screen, log what you type, use the browser's session cookie or tamper with Harness's files. Lock Harness when you step away; the apps lock on sleep and screen lock. |
| Other user accounts on the Mac | **Yes.** The data folder is `700`, every file `600`, and the local API answers only callers with a session (the password) — not other accounts' programs. |
| You forget the password **and** lose the recovery key | **The data is gone.** There is no back door, by design. |
| Harness reaching the internet | **Blocked by default** (below): Harness's own code refuses every non-local address, and the Ollama that Harness starts runs inside a macOS sandbox without network access. |
| An Ollama someone else started (menu-bar app, `brew services`), Draw Things, ComfyUI, LM Studio, your browser | **Not covered** by the blocker — they are separate programs. Harness tells you when the Ollama in use was not started by it. Draw Things may keep its own (unencrypted) copies of what it generates. |
| Model files in `~/.ollama/models` | Not encrypted (they contain no chats). |
| Old plain-text copies: Time Machine backups and data from before the upgrade to 0.2 | Harness cannot reach them. Turn on **FileVault** and use **encrypted backups** — they are still worth having. |

Choose in **Settings**: **password** (the default), **Keychain** (opens without asking on this
Mac; weaker, as above) or **off** (plain-text data; asks your password to confirm). Actions that lower the
protection — allowing internet, turning the blocker off, a full backup, restoring, a new recovery key,
changing the password or the mode — always ask your password again. After 3 wrong passwords Harness waits
1 s, then twice as long after each further miss (up to 5 minutes), even across restarts.

### The internet blocker

**"Block all internet access"** is on by default. Chat never needs the internet: installed models,
memory, summaries, documents, tools other than `fetch_url`, and image generation with Draw Things or
ComfyUI on this Mac all work normally while it is on. What it blocks: the online catalogue, model
downloads, the `fetch_url` tool (not even offered to the model) and chat or image servers on other
machines. Harness's code refuses them before even looking up the name; and the Ollama that Harness starts
runs inside a macOS sandbox (`sandbox-exec`) that allows only connections to this Mac, so not even a
download started directly against that Ollama gets out.

To download a model, **Allow internet for 15 minutes** (1–120; asks your password). A download still running
at the end keeps the window open until it finishes; then blocking resumes on its own, or at once with
**Block now**. `npm run get-model` does exactly that and prints the blocker's state at the end.
The self-test in **Settings** (or `npm run doctor`) runs the backend's self-test and says in one line
whether anything Harness sends can leave the Mac.

### Other privacy facts

* The Harness backend listens on **127.0.0.1 only** (the native app uses no network socket at all) and
  rejects requests from web pages on other sites and from programs without a session.
* **No telemetry, no accounts, no cloud.** The Ollama Harness starts runs with `OLLAMA_NO_CLOUD=1`.
* Logs never contain message text, prompts, memories, file names, passwords or keys. API answers are sent
  with `Cache-Control: no-store`, and the UI keeps drafts and preferences in the encrypted data folder,
  not in browser storage.
* The UI can only load content from Harness itself (a strict Content-Security-Policy; the apps also block
  every other request): a remote image in a model's answer is not loaded. In the apps, links open in your
  browser, and camera, microphone, location and notifications are denied.
* `fetch_url` (off by default) opens only links *you* wrote in the conversation, never local-network
  addresses, and only while internet access is allowed.

## Your data

Everything lives in one folder: **`~/Library/Application Support/Harness`** — the same one whether you
use the app, `npm start` or `Harness.command`. (In Finder: Go → Go to Folder…, or File → Show Data
Folder in Finder in the app.)

| | encrypted? |
|---|---|
| `chats/`, `memories.json`, `attachments/`, `images/`, `index/`, `settings.json`, `presets.json`, `calibration.json`, `model-copies.json`, the UI state, sessions | **encrypted** (same names, unreadable contents) |
| `vault.json` | plain, but holds only your data key *wrapped* under the password and the recovery key, plus the wrong-password counter |
| `launch.json` | plain: the protection mode and whether the blocker is on — what a launcher must know before the data opens |
| `measurements.json` | plain: measured model memory use |
| `harness.lock` | present while Harness runs (one Harness per data folder) |
| `api-token` | only in Keychain/off mode: lets the launchers open the window without a prompt |
| `desktop.json`, `Electron/` | Electron app: options (global shortcut, port, hide-on-close), window state, browser cache |
| `logs/harness.log` | the app's log (Help → Show Log File) — never message text |

Models are not in this folder: Ollama keeps them in `~/.ollama/models` (`ollama list`, `ollama rm`), and
Draw Things manages its own.

**Back up:** quit Harness, then copy the folder, e.g.
`ditto ~/Library/Application\ Support/Harness ~/Desktop/Harness-backup` — the copy stays encrypted and opens
only with your password or recovery key. Or make a backup file in **Settings** (asks your password):
either protected with a separate backup passphrase (recommended) or plain — a plain backup file contains all
your chats in readable form, so keep it on an encrypted disk. Backups restore into any Harness without
overwriting anything.

**Reset:** quit Harness and move the folder to the Trash. Harness starts fresh next time (and asks for a new
password). To keep your chats but reset only the settings, use the reset option in the app's settings.

To use a different folder, start Harness with `HARNESS_DATA_DIR=/path/to/folder`.

---

## Upgrading from 0.1

Your 0.1 data is plain text. On its first start 0.2 finds it and asks you to **choose a password**; it then
**encrypts your existing chats, memories and files in place** (with a progress bar), checking every file
before it replaces the plain one.

```bash
cd harness                    # your 0.1 folder
git pull
npm run doctor                # says "Unencrypted data from Harness 0.1 is waiting to be encrypted"
npm start -- --open           # or double-click Harness.command: choose a password, save the recovery key
# Electron app users, additionally:
npm install && npm run dist && ditto dist/mac-arm64/Harness.app /Applications/Harness.app
```

* **If it is interrupted** (power loss, quitting Harness, a crash): just open Harness and unlock — it continues
  where it stopped. A half-converted folder is read correctly at every point.
* Before upgrading you may copy the folder as a safety net (`ditto …`, above); that copy is **plain text** —
  delete it once 0.2 works. Older Time Machine backups also contain the plain 0.1 data, and on an SSD the
  replaced plain files may linger in free space until overwritten; **FileVault** makes both moot.
* `npm run get-model` and `npm run doctor -- --unlock` now ask your Harness password, and downloads need
  internet to be allowed (they ask). Drafts and UI preferences move from browser storage into the encrypted
  folder.

## If something doesn't work

1. Run **`npm run doctor`**. It works while Harness is locked and never needs your password: it reports
   whether Harness is running and locked, the protection mode, the internet blocker and its self-test, Ollama
   and its memory protections, the installed and recommended models, Draw Things and the other local servers,
   and how to fix each problem. `npm run doctor -- --unlock` also looks inside the running Harness.
2. Run **`npm run live-check`** (or `npm run doctor -- --live`). It tests what Harness assumes about your
   *real* Ollama (and Draw Things, ComfyUI, llama.cpp, LM Studio if they're running) and writes a Markdown
   report — `npm run live-check -- --markdown report.md`; `doctor --live` saves it to your Desktop. Details:
   [docs/LIVE_CHECK.md](docs/LIVE_CHECK.md).
3. If you report a problem, **paste that Markdown report** along with the doctor output and the log
   (`~/Library/Application Support/Harness/logs/harness.log`, or Help → Show Log File in the app).

| problem | what to do |
|---|---|
| Forgot the password | Unlock with the **recovery key** on the lock screen, then choose a new password (within 10 minutes). Without either, the data cannot be opened |
| "Wait … before trying again" | after 3 wrong passwords Harness waits 1 s, doubling up to 5 minutes; `npm run doctor` shows how long |
| "Internet access is blocked in Harness" | expected for downloads and the online catalogue: use the **Allow internet for 15 minutes** button (your password), or `npm run get-model`. Chat does not need it |
| "Harness has no password yet" from a command-line tool | open Harness once (the app, `Harness.command` or `npm start -- --open`) and choose the password there |
| Encrypting the 0.1 data was interrupted | open Harness and unlock; it resumes. `npm run doctor` shows the progress |
| "Ollama is not installed" / no models | `brew install ollama` (or the app from ollama.com), then `npm run get-model` or the app's setup page |
| "The model failed to load" | the runner crashed while loading. On the test machine the Nemotron file *as downloaded* crashed this way (`llama-server process has terminated`), because its virtual GPU lacks a feature the image/audio part needs; a real M1 most likely loads it, but it costs ~1 GB more RAM anyway. Use the button in the message (or `npm run get-model`) to make the **text-only copy** and use that |
| `npm run doctor` says the protections are not in effect | another Ollama is running (menu-bar app or `brew services`). Quit it (menu bar → Quit Ollama; `brew services stop ollama`), turn off its launch-at-login, then restart Harness |
| Replies are very slow, the Mac stutters | the model is too big for the RAM: use the text-only copy of `UD-IQ3_XXS`, quit memory-hungry apps. Activity Monitor → Memory → "Swap Used" should stay low |
| A download fails with "not found" | use the exact tag Harness names (with `UD-`); `hf.co/…` tags need a recent Ollama (`brew upgrade ollama`) |
| Image generation: "no image provider" | Draw Things must be running with its API Server on (HTTP, port 7860); test with `curl http://127.0.0.1:7860/sdapi/v1/options` |
| Image generation finishes but no image comes back | keep a **project open** in Draw Things (a known Draw Things issue with some models), and make sure a model is selected there |
| First reply after an image is slow | expected on 8 GB: the chat model was unloaded for the image and is loading again |
| Port 4747 is busy | Harness uses the next free port automatically; the app/launcher shows the URL. Or set `HARNESS_PORT` |
| "Harness is already running" | only one Harness runs per data folder; the app and `Harness.command` open the running one |
| The app shows an error at start | Help → Show Log File, or `~/Library/Application Support/Harness/logs/harness.log` |
| The Electron app won't open after downloading or copying it from another Mac | it is ad-hoc signed and not notarized: build it on this Mac (`npm run dist`), or see [The Electron app](#the-electron-app) for clearing the quarantine flag |
| `Harness.command` "cannot be verified" | right-click it → Open once, or run `./Harness.command` in Terminal |
| ⌘⇧Space does nothing | another app owns that shortcut; set `"globalShortcut"` in `desktop.json` (e.g. `"Alt+Command+H"`, or `null` to disable) and restart Harness |
| Start completely fresh | see [Reset](#your-data) |

### When a real backend disagrees

The Ollama client has been run against a real Ollama (0.40.13) on macOS; the Draw Things, ComfyUI,
llama.cpp and LM Studio clients were built from their documented APIs and tested only against fakes
(`test/fake-*.mjs`). If one of them fails with the real program, `npm run live-check` usually pinpoints the
mismatch (each failing check names the Harness code that depends on it). Then check the backend directly
(`curl http://127.0.0.1:11434/api/tags`, `curl http://127.0.0.1:7860/sdapi/v1/sd-models`), update it, and
report the difference with the live-check report. Fixing a mismatch means updating the client in
`server/providers/` or `server/image/` *and* its fake.

---

## Development

```bash
npm start                    # server + UI on http://127.0.0.1:4747 (no npm install needed)
npm run dev:fake             # real server + fake Ollama, Draw Things, ComfyUI, llama.cpp — no models needed
HARNESS_ENCRYPTION=off HARNESS_API_AUTH=0 HARNESS_OFFLINE_LOCK=0 npm start   # development opt-out (no password)
npm run dev:fake -- --ram 8  # …pretending the machine has 8 GB
npm test                     # backend, desktop-shell and tool unit tests (node --test)
npm run doctor               # environment check (--live, --json, --recommended-model, --version)
npm run get-model            # download the recommended model (+ text-only copy on 8 GB) through Harness
npm run live-check           # test Harness's assumptions against your real backends (docs/LIVE_CHECK.md)
npm install && npm run app   # the Electron shell
npm run test:e2e             # launches the real Electron app and smoke-tests it (uses Xvfb on Linux)
npm run icons                # regenerate build/icon.icns + icon.png from build/icon.svg
```

Requirements: Node.js 20+. The server has **no runtime dependencies**; Electron and electron-builder
are development dependencies used only for the Mac app.

* `server/` — backend (HTTP + SSE API, documented in [docs/API.md](docs/API.md))
* `public/` — web UI
* `electron/` — Electron app shell ([docs/DESKTOP.md](docs/DESKTOP.md)); `native/` — the native app ([docs/BRIDGE.md](docs/BRIDGE.md))
* `scripts/` — `setup-macos.sh`, `doctor.mjs`, `get-model.mjs`, `live-check.mjs`, `launch.mjs` (behind `Harness.command`), `dev-fake.mjs`, `make-icons.mjs`
* `test/` — tests and the fake backends
