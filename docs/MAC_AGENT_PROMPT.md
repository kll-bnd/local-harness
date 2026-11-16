# Prompt for an AI agent setting Harness up on the Mac

Paste everything below the line into the agent that has a terminal on the MacBook.

---

You are installing **Harness 0.2**, a local chat app for open-source models, on this Mac: an Apple Silicon (M1)
MacBook with **8 GB of RAM** — or upgrading it, if Harness 0.1 is already here. The owner wants to chat with
**NVIDIA Nemotron 3.5 Bolt E4B** and have that model ask a local image model (**Draw Things**) for pictures
during a chat. Get it running, check it honestly, and report back what works and what doesn't.

Repository: `https://github.com/kll-bnd/local-harness` (branch `claude/relaxed-allen-beh7bm`). Read
`README.md` first; it is accurate and short. `docs/NATIVE.md`, `docs/LIVE_CHECK.md` and `docs/API.md` (§10 for
the 0.2 security model) have the detail if you need it.

## Ground rules

- Everything stays on this machine. Do not expose Harness beyond `127.0.0.1`, and do not send the owner's
  chats, memories or files anywhere.
- **The Harness password belongs to the owner. Never choose, suggest, type, store or repeat it.** Harness
  asks for it in its own window on first start; tell the owner it is coming and let them type it there. When a
  command-line step needs it (`npm run get-model`, `npm run doctor -- --unlock`), the tool prompts in the
  terminal without echo — hand the keyboard to the owner. Never pass it as an argument, an environment
  variable, through `--password-stdin` from a file you wrote, or in any message.
- **The recovery key** (`HRK1-…`) is shown once in the Harness window. Tell the owner to write it down or put
  it in their password manager. Do not read it off the screen, ask them to paste it, take or keep a screenshot
  of it, or let it appear in any log, file or chat — including this conversation and your report.
- Ask the owner before installing software or downloading anything large, and say what and why. Never pipe a
  download into a shell.
- Harness blocks internet access by default. A model download asks the owner's password to allow it for
  that download only; leave it blocked otherwise. Do not turn the blocker off.
- Do not start Ollama yourself (`ollama serve`, the Ollama menu-bar app, `brew services`). **Harness must
  start Ollama**, because only then does it apply the memory settings an 8 GB Mac needs and run Ollama in the
  macOS sandbox. If another Ollama is already running, quit it first (menu bar → Quit Ollama;
  `brew services stop ollama`).
- Do not use the model tags `nemotron-3.5-bolt:e4b` (7.9 GB, does not fit), any `:latest`, or tags without
  the `UD-` prefix. Use the tag Harness names.
- Never delete, move or edit anything in `~/Library/Application Support/Harness` (the owner's chats and the
  key files `vault.json`, `vault.json.bak`, `vault-seq.json` and `launch.json` live there; Harness notices and
  reports edits to them), and never touch the `local.harness` items in the login Keychain. If Harness or `npm run doctor`
  reports a **damaged key store** (`vault_corrupt` / `vault_missing`), stop and tell the owner: the fix is
  restoring `vault.json` from a backup of that folder. Never set up a new password over existing data.
- Run only what this prompt names. The scripts under `scripts/ci/`, `native/test/` and `native/ci/` are for the
  project's test machines, not for this Mac. `npm test` is safe (temporary folders and a stand-in Keychain), but
  you only need it if you change code.
- Do not change the code unless a check below fails and you have found the cause. If you do, keep the
  change small, run `npm test`, and tell the owner what and why.

## How the pieces fit (read this once)

Harness can be opened in three ways that share one data folder and one password: the **native app**
(recommended; it has no local web address at all), the browser (`npm start -- --open`) and the Electron app.
Only one of them can have the folder open at a time. The command-line tools (`npm run doctor`,
`npm run get-model`) talk to Harness over its local address, so they work with the browser way — **while the
native app is open they can only tell you that it is open.** That is why the steps below check everything
through the browser first and switch to the native app at the end.

## Steps

1. **Get the code and look at the machine.**
   ```bash
   git clone https://github.com/kll-bnd/local-harness.git harness && cd harness
   sw_vers; uname -m; sysctl -n hw.memsize; node -v; which ollama brew; xcode-select -p
   ```
   If Harness 0.1 is already installed, use its folder instead: quit Harness (and its app) first, then
   `cd` there and `git pull`. Its chats and the downloaded model stay; the first 0.2 start encrypts the chats
   (step 3). Needs: Apple Silicon, Node.js 20 or newer, Ollama installed (not running), about 10 GB of free disk
   for a first install. Missing pieces: `brew install node ollama` (ask first). For the native app also Apple's
   Command Line Tools (`xcode-select --install`, ask first).

2. **Check the setup.** No password needed:
   ```bash
   npm run doctor
   ```
   It lists what is installed, the model it recommends for this Mac and whether that model is already here.

3. **First start — the owner chooses the password.**
   ```bash
   npm start -- --open
   ```
   The browser shows Harness's setup screen. Step back: the owner types the password and saves the recovery
   key. On an upgrade the screen says the existing chats will be encrypted and shows a progress bar; if it is
   interrupted, opening Harness again continues it. Leave this terminal running for steps 4–6.

4. **The model** (in a second terminal) — only if step 2 said the recommended model is missing. It asks the
   owner's password (no echo), asks before allowing internet access for the download, downloads the
   recommended Nemotron file (about 4.5 GB), makes the **text-only copy** an 8 GB Mac should use, blocks
   internet again and prints the blocker's state:
   ```bash
   npm run get-model
   ```
   If it answers that Harness is running but locked, the owner unlocks it in the browser window first (the
   tools check the password themselves and send it only to a Harness that proves it holds the owner's data
   key; they never unlock a Harness they did not start). If it says the program at that address *could not
   prove* that, stop and tell the owner — the password was not sent.

   On 8 GB the comfortable file is `UD-IQ3_XXS`. `UD-Q3_K_XL` is better quality but borderline on 8 GB; only
   switch to it if the owner asks and memory stays healthy:
   `npm run get-model -- --model hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL`.

5. **Draw Things (image generation).** This needs the owner: install **Draw Things** from the Mac App
   Store, download a small model in it (Stable Diffusion 1.5 class is the safe choice on 8 GB; SDXL Turbo is
   tight), switch on **Settings → API Server** (HTTP, port 7860), and keep a project open. Check it:
   ```bash
   curl -s http://127.0.0.1:7860/sdapi/v1/options | head -c 300
   ```

6. **Verify the 0.2 claims** while the Harness from step 3 is still running:
   - `npm run doctor` should show: *Harness 0.2.0 is running*; *Data protection: password*; *Internet blocker:
     nothing Harness sends can leave this Mac*, with the self-test lines of the running Harness (the `os` lines
     should read `blocked`: the Ollama that Harness started runs inside the macOS sandbox); and the Ollama
     memory protections **in effect**. If it says the Ollama in use was not started by Harness, or that no
     macOS sandbox is in force, report that line exactly. `npm run doctor -- --unlock` (the owner types the
     password) adds the loaded model's real memory use.
   - The live check runs its own throw-away Harness with its own throw-away password — it never touches or
     needs the owner's data or password:
     ```bash
     npm run live-check -- --allow-images --allow-internet --markdown ~/Desktop/harness-live-check.md
     ```
     (`--allow-internet` lets that throw-away Harness read the online model catalogue for a moment; it downloads
     no model. Do not add `--allow-pull`.) `e2e.vault_error` proves a damaged key store is reported and never
     overwritten; the `e2e.lock.*` checks prove that locking closes the data, unloads the model and leaves no
     readable chat text on disk; `e2e.blocker.*` that downloads, the catalogue and `fetch_url` are refused
     while blocked (`e2e.blocker.sandboxed_ollama`: even a pull sent straight to an Ollama that Harness
     started); `a1111.*` that Draw Things really answers the way Harness expects. Every failing check names the
     Harness file and line that depends on it.

7. **Switch to the native app** — how the owner will use it from now on. Stop the Harness from step 3
   (Ctrl+C in its terminal), then (ask first: the build downloads the official Node.js runtime once, about
   30 MB, and replaces an older `/Applications/Harness.app`):
   ```bash
   scripts/build-native.sh --install && open -a Harness
   ```
   The owner types the password in the app's window. Then, in the app:
   - **Settings → Privacy & security → "Check that nothing can get out"**: it should answer *Nothing got out*,
     and the line above the button should say that macOS keeps the Ollama Harness started in a sandbox.
   - **Lock Harness** (⌃⌘L): the lock screen appears and the owner's password opens it again.
   - If a notice says *Harness's security settings were changed from outside*, show it to the owner as it is:
     it means a start-up file was edited while Harness was closed and Harness ignored the edit.
   - Send a short message; then, with Tools on, ask *"Draw me a red fox in the snow."* Expected on 8 GB: the
     first reply takes 10–60 s while the model loads; for the picture the app says it is unloading the chat
     model, generating, then reloading on the next message.
   - **Models** shows the installed model and lets the owner browse the Ollama library and Hugging Face
     (it asks the password to allow internet access first).

   If the Command Line Tools are not available, the browser way from step 3 (or `Harness.command`) is a
   complete way to use Harness; say so in your report.

## What is already known, and what is not

Checked on a real Apple Silicon Mac in CI (GitHub's runner: "Apple M1 (Virtual)", 7 GB RAM, macOS 26, real
Ollama 0.40.13, real Nemotron 3.5 Bolt E4B `UD-Q3_K_XL` as a text-only copy) for **0.1**: the app builds, signs
and runs; `get-model` works end to end; chat, tool calling, thinking on/off, titles, memory extraction and the
memory measurement work; the model called the image tool for the fox prompt and the unload → generate → reload
sequence ran. The README's status paragraph lists what the same runner has verified for 0.2.

**Not tested on real hardware, so check these and report:**
- **Draw Things.** Harness's client was written from community descriptions of its API and tested only
  against a stand-in. If generation fails, the live-check report's `a1111.*` checks say where.
- **Memory on a real 8 GB machine.** Watch Activity Monitor → Memory → Swap Used during the first few
  messages.
- **Speed.** Unknown on a real M1 (the test machine's graphics are virtual and slow). Report tokens per second
  from the message footer.
- **The window itself.** Nobody has looked at the native app's window: title-bar spacing around the traffic
  lights, the Dock icon, dark mode, ⌘⇧Space showing and hiding the window.
- **Locking on real sleep and screen lock** (the tests post the same system notifications instead).

## Report back

Tell the owner: which model file is installed and whether it is the text-only copy; the output of
`npm run doctor` from step 6; the summary lines of the live check and the path of its Markdown report; what the
in-app check said; whether the fox picture appeared; tokens per second and whether swap stayed low; which way of
opening Harness you left them with; and anything you changed, with the reason. If something failed, include the
last 50 lines of `~/Library/Application Support/Harness/logs/harness.log` (it never contains message text or
passwords). Never include the password or the recovery key.
