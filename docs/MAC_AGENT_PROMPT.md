# Prompt for an AI agent setting Harness up on the Mac

Paste everything below the line into the agent that has a terminal on the MacBook.

---

You are setting up and launching **Harness**, a local chat app for open-source models, on this Mac: an
Apple Silicon (M1) MacBook with **8 GB of RAM**. The owner wants to chat with **NVIDIA Nemotron 3.5 Bolt
E4B** and have that model ask a local image model (**Draw Things**) for pictures during a chat. Get it
running, check it honestly, and report back what works and what doesn't.

Repository: `https://github.com/kll-bnd/local-harness` (branch `claude/relaxed-allen-beh7bm`). Read
`README.md` first; it is accurate and short. `docs/DESKTOP.md`, `docs/LIVE_CHECK.md` and `docs/API.md` have
the detail if you need it.

## Ground rules

- Everything stays on this machine. Do not expose the server beyond `127.0.0.1`, and do not send the
  owner's chats, memories or files anywhere.
- Ask the owner before installing software or downloading multi-gigabyte files, and say what and why.
  Never pipe a download into a shell.
- Do not start Ollama yourself (`ollama serve`, the Ollama menu-bar app, `brew services`). **Harness must
  start Ollama**, because only then does it apply the memory settings an 8 GB Mac needs. If another Ollama
  is already running, quit it first (menu bar → Quit Ollama; `brew services stop ollama`).
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
   Missing pieces: `brew install node ollama` (ask first). `./scripts/setup-macos.sh` does all of steps 1–3
   interactively and asks before each install; use it if the owner prefers, otherwise continue by hand.

2. **Check the setup.**
   ```bash
   npm run doctor
   ```
   It lists what is installed, the model it recommends for this Mac, and how to fix anything missing.

3. **Get the model.** This downloads the recommended Nemotron file (about 4.5 GB) through Harness and
   makes the **text-only copy** that an 8 GB Mac should use (same model, about 1 GB less memory, cannot read
   attached images but can still request generated ones):
   ```bash
   npm run get-model -- --yes
   ```
   On 8 GB the comfortable file is `UD-IQ3_XXS`. `UD-Q3_K_XL` is better quality but borderline on 8 GB; only
   switch to it if the owner asks and memory stays healthy:
   `npm run get-model -- --yes --model hf.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF:UD-Q3_K_XL`.

4. **Launch it.** Either is fine; the first needs nothing installed:
   ```bash
   npm start -- --open                # opens http://127.0.0.1:4747 in the browser
   ```
   or build the Mac app (downloads Electron, a few hundred MB):
   ```bash
   npm install && npm run dist
   ditto dist/mac-arm64/Harness.app /Applications/Harness.app && open -a Harness
   ```
   Then run `npm run doctor` again: it should say the memory protections are **in effect**.

5. **Draw Things (image generation).** This needs the owner: install **Draw Things** from the Mac App
   Store, download a small model in it (Stable Diffusion 1.5 class is the safe choice on 8 GB; SDXL Turbo is
   tight), switch on **Settings → API Server** (HTTP, port 7860), and keep a project open. Check it:
   ```bash
   curl -s http://127.0.0.1:7860/sdapi/v1/options | head -c 300
   ```
   Harness detects it automatically (sidebar shows "Draw Things ready").

6. **Verify against the real programs.** With Harness running (so Ollama is up):
   ```bash
   npm run live-check -- --allow-images --markdown ~/Desktop/harness-live-check.md
   ```
   This tests what Harness assumes about the real Ollama and the real Draw Things. Every failing check names
   the file and line in Harness that depends on it and says what would need to change.

7. **Try it as the owner would**, in the app: send a short message; then ask *"Draw me a red fox in the
   snow."* with Tools on. Expected on 8 GB: the first reply takes 10–60 s while the model loads; for the
   picture the app says it is unloading the chat model, generating, then reloading on the next message.

## What is already known, and what is not

Checked on a real Apple Silicon Mac in CI (7 GB RAM, real Ollama 0.40.13, real Nemotron 3.5 Bolt E4B
`UD-Q3_K_XL` text-only copy): the app builds, signs and runs; `get-model` works end to end; chat, tool
calling, thinking on/off, titles, memory extraction and the memory measurement work; the model called the
image tool for the fox prompt and the unload → generate → reload sequence ran.

**Never tested on real hardware, so check these and report:**
- **Draw Things.** Harness's client was written from community descriptions of its API and tested only
  against a stand-in. This is the most likely thing to need a fix. If generation fails, the live-check
  report's `a1111.*` checks say where; the client is `server/image/a1111.mjs`, its stand-in is
  `test/fake-a1111.mjs`, its tests are in `test/images.test.mjs`.
- **Memory on a real 8 GB machine.** Watch Activity Monitor → Memory → Swap Used during the first few
  messages. If Harness warns that the model is too big or the Mac is swapping, use the smaller file it names.
- **Speed.** Unknown on a real M1 (the CI machine's virtual GPU managed 1–3 tokens per second, which says
  nothing about real hardware). Report tokens per second from the message footer.
- **The window itself** (if you built the app): title-bar spacing around the traffic lights, the icon in
  the Dock, ⌘⇧Space showing and hiding the window.

## Report back

Tell the owner: which model file is installed and whether it is the text-only copy; the output of
`npm run doctor`; the summary lines of the live check and the path of its Markdown report; whether the fox
picture appeared; tokens per second and whether swap stayed low; and anything you changed, with the reason.
If something failed, include the last 50 lines of `~/Library/Application Support/Harness/logs/harness.log`.
