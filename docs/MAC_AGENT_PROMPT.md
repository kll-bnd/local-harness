# Prompt for an AI agent setting Harness up on the Mac

Paste everything below the line into the agent that has a terminal on the MacBook.

---

You are setting up and launching **Harness 0.2**, a local chat app for open-source models, on this Mac: an
Apple Silicon (M1) MacBook with **8 GB of RAM**. The owner wants to chat with **NVIDIA Nemotron 3.5 Bolt
E4B** and have that model ask a local image model (**Draw Things**) for pictures during a chat. Get it
running, check it honestly, and report back what works and what doesn't.

Repository: `https://github.com/kll-bnd/local-harness` (branch `claude/relaxed-allen-beh7bm`). Read
`README.md` first; it is accurate and short. `docs/DESKTOP.md`, `docs/LIVE_CHECK.md` and `docs/API.md` (§10
for the 0.2 security model) have the detail if you need it.

## Ground rules

- Everything stays on this machine. Do not expose the server beyond `127.0.0.1`, and do not send the
  owner's chats, memories or files anywhere.
- **The Harness password belongs to the owner. Never choose, suggest, type, store or repeat it.** Harness
  asks for it in its own window on first start; tell the owner it is coming and let them type it there. When a
  command-line step needs it (`npm run get-model`, `npm run doctor -- --unlock`), the tool prompts in the
  terminal without echo — hand the keyboard to the owner. Never pass it as an argument, an environment
  variable, through `--password-stdin` from a file you wrote, or in any message.
- **The recovery key** (`HRK1-…`) is shown once in the Harness window. Tell the owner to write it down or put
  it in their password manager. Do not read it off the screen, ask them to paste it, take or keep a screenshot
  of it, or let it appear in any log, file or chat — including this conversation and your report.
- Ask the owner before installing software or downloading multi-gigabyte files, and say what and why.
  Never pipe a download into a shell.
- Harness blocks internet access by default. A model download asks the owner's password to allow it for
  that download only; leave it blocked otherwise. Do not turn the blocker off.
- Do not start Ollama yourself (`ollama serve`, the Ollama menu-bar app, `brew services`). **Harness must
  start Ollama**, because only then does it apply the memory settings an 8 GB Mac needs and run Ollama in the
  macOS sandbox. If another Ollama is already running, quit it first (menu bar → Quit Ollama;
  `brew services stop ollama`).
- Do not use the model tags `nemotron-3.5-bolt:e4b` (7.9 GB, does not fit), any `:latest`, or tags without
  the `UD-` prefix. Use the tag Harness names.
- Do not change the code unless a check below fails and you have found the cause. If you do, keep the
  change small and run `npm test` before telling the owner about it.

## Steps

1. **Get the code and look at the machine.**
   ```bash
   git clone https://github.com/kll-bnd/local-harness.git harness && cd harness
   sw_vers; uname -m; sysctl -n hw.memsize; node -v; which ollama brew
   ```
   Needs: Apple Silicon, Node.js 20 or newer, Ollama installed (not running), about 10 GB of free disk.
   Missing pieces: `brew install node ollama` (ask first). `./scripts/setup-macos.sh` does steps 1–4
   interactively, asks before each install and lets the owner type the password; use it if the owner prefers.
   If Harness 0.1 was installed before: `git pull` in the existing folder instead — its data is encrypted on
   the first start (README → "Upgrading from 0.1").

2. **Check the setup.** No password needed:
   ```bash
   npm run doctor
   ```

3. **First start — the owner chooses the password.**
   ```bash
   npm start -- --open
   ```
   The browser shows Harness's setup screen. Step back: the owner types the password and saves the recovery
   key. Leave this running (or use the app, step 5) for the next step.

4. **Get the model** (in a second terminal). It asks the owner's password (no echo), asks before allowing
   internet access for the download, downloads the recommended Nemotron file (about 4.5 GB), makes the
   **text-only copy** an 8 GB Mac should use, blocks internet again and prints the blocker's state:
   ```bash
   npm run get-model
   ```
   On 8 GB the comfortable file is `UD-IQ3_XXS`. `UD-Q3_K_XL` is better quality but borderline on 8 GB; only
   switch to it if the owner asks and memory stays healthy:
   `npm run get-model -- --model hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL`.

5. **Launch it as the owner will use it.** The browser (step 3) works. The Electron app is optional
   (downloads Electron, a few hundred MB): `npm install && npm run dist`, then
   `ditto dist/mac-arm64/Harness.app /Applications/Harness.app && open -a Harness`. If `docs/NATIVE.md` exists,
   the native app is the recommended way — follow that file.

6. **Draw Things (image generation).** This needs the owner: install **Draw Things** from the Mac App
   Store, download a small model in it (Stable Diffusion 1.5 class is the safe choice on 8 GB; SDXL Turbo is
   tight), switch on **Settings → API Server** (HTTP, port 7860), and keep a project open. Check it:
   ```bash
   curl -s http://127.0.0.1:7860/sdapi/v1/options | head -c 300
   ```

7. **Verify the 0.2 claims.**
   - `npm run doctor` (no password) should show: *Data protection: password*; *Internet blocker: nothing Harness
     sends can leave this Mac* with the self-test lines; the Ollama memory protections **in effect** (while
     Harness runs and has started Ollama). `npm run doctor -- --unlock` (the owner types the password) adds the
     loaded model's real memory use and runs the self-test inside the running Harness.
   - The live check runs its own throw-away Harness with its own throw-away password — it never touches or
     needs the owner's data or password:
     ```bash
     npm run live-check -- --allow-images --allow-internet --markdown ~/Desktop/harness-live-check.md
     ```
     The `e2e.lock.*` checks prove that locking closes the data, unloads the model and leaves no readable
     chat text on disk; `e2e.blocker.*` that downloads, the catalogue and `fetch_url` are refused while blocked
     (`e2e.blocker.sandboxed_ollama`: even a pull sent straight to the Ollama Harness started); `e2e.catalog.*`
     that the model catalogue still parses the live sites. Every failing check names the Harness file and line
     that depends on it.
   - In the app: **Lock Harness** (⌃⌘L) → the lock screen appears and the owner's password opens it again.

8. **Try it as the owner would**, in the app: send a short message; then ask *"Draw me a red fox in the
   snow."* with Tools on. Expected on 8 GB: the first reply takes 10–60 s while the model loads; for the
   picture the app says it is unloading the chat model, generating, then reloading on the next message.

## What is already known, and what is not

Checked on a real Apple Silicon Mac in CI for **0.1** (7 GB RAM, real Ollama 0.40.13, real Nemotron 3.5 Bolt
E4B `UD-Q3_K_XL` text-only copy): the app builds, signs and runs; `get-model` works end to end; chat, tool
calling, thinking on/off, titles, memory extraction and the memory measurement work; the model called the
image tool for the fox prompt and the unload → generate → reload sequence ran.

**Not yet tested on real hardware, so check these and report:**
- **Everything new in 0.2**: the setup and lock screens, encryption of an upgraded 0.1 folder, locking on
  sleep/screen lock, the internet blocker and the sandboxed Ollama, the catalogue, the native app.
- **Draw Things.** Harness's client was written from community descriptions of its API and tested only
  against a stand-in. If generation fails, the live-check report's `a1111.*` checks say where.
- **Memory on a real 8 GB machine.** Watch Activity Monitor → Memory → Swap Used during the first few
  messages.
- **Speed.** Unknown on a real M1. Report tokens per second from the message footer.
- **The window itself** (if you built an app): title-bar spacing around the traffic lights, the Dock icon,
  ⌘⇧Space showing and hiding the window.

## Report back

Tell the owner: which model file is installed and whether it is the text-only copy; the output of
`npm run doctor`; the summary lines of the live check and the path of its Markdown report; whether the fox
picture appeared; tokens per second and whether swap stayed low; and anything you changed, with the reason.
If something failed, include the last 50 lines of `~/Library/Application Support/Harness/logs/harness.log`
(it never contains message text or passwords). Never include the password or the recovery key.
