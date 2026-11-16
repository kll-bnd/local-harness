#!/bin/bash
# Harness setup for macOS (Apple Silicon). Safe to re-run: every step checks first and asks before
# installing anything. Nothing is downloaded and piped into a shell.
#
#   ./scripts/setup-macos.sh          interactive
#   ./scripts/setup-macos.sh --yes    accept every offer (unattended)
#
# Written for the bash 3.2 that ships with macOS.
set -euo pipefail

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
REPO="$(pwd)"

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; D=; G=; Y=; R=; N=; fi
step() { printf '\n%s== %s ==%s\n' "$B" "$1" "$N"; }
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
note() { printf '    %s%s%s\n' "$D" "$*" "$N"; }

# ask "Question" [default y|n] → returns 0 for yes. Without a terminal (and without --yes) the answer is "no".
ask() {
  local q="$1" def="${2:-y}" hint ans
  if [ "$ASSUME_YES" = 1 ]; then printf '  %s → yes (--yes)\n' "$q"; return 0; fi
  if [ ! -t 0 ]; then printf '  %s → skipped (not interactive)\n' "$q"; return 1; fi
  if [ "$def" = y ]; then hint="Y/n"; else hint="y/N"; fi
  read -r -p "  $q [$hint] " ans || ans=""
  [ -z "$ans" ] && ans="$def"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

version_ge() { # version_ge 14.2 12 → true when $1 >= $2 (numeric, dot-separated)
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 0
}

say "${B}Harness setup${N} — checks this Mac and offers to install what Harness needs."
say "Nothing is installed without asking. You can stop at any time with Ctrl+C and re-run later."

# ------------------------------------------------------------------------------------------------
step "1. This Mac"
if [ "$(uname -s)" != "Darwin" ]; then
  bad "This script is for macOS. On other systems: install Node.js 20+ and Ollama, then run: npm start -- --open"
  exit 1
fi
MACOS="$(sw_vers -productVersion)"
ARM64="$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)"
TRANSLATED="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
MEM_BYTES="$(sysctl -n hw.memsize)"
MEM_GB=$(( (MEM_BYTES + 536870912) / 1073741824 ))
CHIP="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown chip")"
say "  macOS $MACOS, $CHIP, ${MEM_GB} GB memory"
if [ "$ARM64" = 1 ]; then ok "Apple Silicon"; else warn "Not Apple Silicon — Harness works, but local models will be slow."; fi
if [ "$TRANSLATED" = 1 ]; then
  warn "This Terminal runs under Rosetta (Intel mode). Quit it, turn off \"Open using Rosetta\" in Terminal's Get Info, and run this again."
  ask "Continue anyway?" n || exit 1
fi
if version_ge "$MACOS" 12; then ok "macOS $MACOS is supported by the desktop app (needs 12+)"; else bad "The desktop app needs macOS 12 or newer. The browser version (npm start) may still work."; fi
if [ "$MEM_GB" -le 8 ]; then
  note "8 GB Mac: Harness automatically picks a smaller model file, keeps the context window modest,"
  note "and unloads the chat model while an image is generated. Close other heavy apps for best results."
fi

# ------------------------------------------------------------------------------------------------
step "2. Homebrew (package manager)"
BREW=""
if command -v brew >/dev/null 2>&1; then BREW="$(command -v brew)";
elif [ -x /opt/homebrew/bin/brew ]; then BREW=/opt/homebrew/bin/brew;
elif [ -x /usr/local/bin/brew ]; then BREW=/usr/local/bin/brew; fi
if [ -n "$BREW" ]; then
  eval "$("$BREW" shellenv)"
  ok "Homebrew found at $BREW"
else
  warn "Homebrew is not installed."
  note "This script does not install Homebrew for you (its installer is a script you download and run)."
  note "Either install it yourself from https://brew.sh (copy the one-line command shown there), then re-run this,"
  note "or install the pieces by hand: Node.js from https://nodejs.org (LTS .pkg) and Ollama from https://ollama.com/download."
  note "Continuing: the remaining steps only check, and tell you what is missing."
fi

# ------------------------------------------------------------------------------------------------
step "3. Node.js 20 or newer (runs Harness)"
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if node_ok; then
  ok "Node.js $(node -v)"
else
  if command -v node >/dev/null 2>&1; then warn "Node.js $(node -v) is too old."; else warn "Node.js is not installed."; fi
  if [ -n "$BREW" ] && ask "Install the current Node.js with Homebrew (brew install node)?" y; then
    if "$BREW" list --formula node >/dev/null 2>&1; then "$BREW" upgrade node || true; else "$BREW" install node; fi
    hash -r
  fi
  if node_ok; then ok "Node.js $(node -v)"; else bad "Node.js 20+ is required. Install it (https://nodejs.org) and run this script again."; exit 1; fi
fi

# ------------------------------------------------------------------------------------------------
step "4. Ollama (runs the chat models)"
OLLAMA=""
if command -v ollama >/dev/null 2>&1; then OLLAMA="$(command -v ollama)";
elif [ -x /Applications/Ollama.app/Contents/Resources/ollama ]; then OLLAMA=/Applications/Ollama.app/Contents/Resources/ollama; fi
if [ -n "$OLLAMA" ]; then
  ok "Ollama found: $OLLAMA ($("$OLLAMA" --version 2>/dev/null | tail -n 1 || true))"
else
  warn "Ollama is not installed."
  if [ -n "$BREW" ] && ask "Install Ollama with Homebrew (brew install ollama)?" y; then
    "$BREW" install ollama
    hash -r
    OLLAMA="$(command -v ollama || true)"
  else
    note "You can also download the Ollama app from https://ollama.com/download and run this script again."
  fi
  [ -n "$OLLAMA" ] && ok "Ollama installed: $OLLAMA"
fi
if [ -n "$OLLAMA" ]; then
  note "Let Harness start Ollama (it does so by itself when it launches). Only then does it apply its memory"
  note "protections: flash attention, a q8_0 context cache, one model at a time, a capped prompt cache, no cloud."
  note "An Ollama started any other way (the menu-bar app, brew services) is used as it is, without them."
  if pgrep -x Ollama >/dev/null 2>&1; then
    warn "The Ollama menu-bar app is running. Quit it (menu bar → Quit Ollama) and turn off its \"launch at login\"."
  fi
  if [ -n "$BREW" ] && "$BREW" services list 2>/dev/null | awk '$1 == "ollama" {print $2}' | grep -qx started; then
    warn "Ollama runs as a Homebrew service."
    if ask "Stop the service (brew services stop ollama) so Harness can start Ollama with its protections?" y; then
      "$BREW" services stop ollama || true
    fi
  fi
fi

# ------------------------------------------------------------------------------------------------
step "5. Your Harness password"
LAUNCHER_PID=""
stop_launcher() {
  if [ -n "$LAUNCHER_PID" ]; then
    kill -TERM "$LAUNCHER_PID" 2>/dev/null || true
    wait "$LAUNCHER_PID" 2>/dev/null || true
    LAUNCHER_PID=""
  fi
}
trap stop_launcher EXIT
STATE="$(node scripts/doctor.mjs --state 2>/dev/null || echo unknown)"
case "$STATE" in
  needs_setup|not_running:needs_setup)
    say "  Harness keeps your chats encrypted. You open it with a password that only you know; Harness"
    say "  never stores it. This script does not choose or type it for you: Harness asks for it in its own"
    say "  window, and then shows a ${B}recovery key${N} once. Write the key down or keep it in a password manager —"
    say "  not in a chat, a note synced in plain text, or a screenshot. Without the password AND the recovery"
    say "  key nobody can open the data, not even you."
    if [ ! -t 0 ]; then
      note "Skipped (not interactive): open Harness (Harness.command or npm start -- --open) to choose the password."
    elif ask "Open Harness in your browser now to choose your password?" y; then
      if [ "$STATE" = "needs_setup" ]; then
        node scripts/launch.mjs >/dev/null 2>&1 || true
      else
        node scripts/launch.mjs >"${TMPDIR:-/tmp}/harness-setup-launch.log" 2>&1 &
        LAUNCHER_PID=$!
      fi
      say "  A browser window opens with Harness. Choose your password there and save the recovery key."
      while :; do
        read -r -p "  Press Return here when you have done that (or type s to skip): " ans || ans="s"
        case "$ans" in [Ss]*) break ;; esac
        STATE="$(node scripts/doctor.mjs --state 2>/dev/null || echo unknown)"
        case "$STATE" in
          needs_setup|not_running:needs_setup) warn "Harness still has no password. Finish the setup in the browser window." ;;
          *) ok "Your Harness password is set."; break ;;
        esac
      done
    fi
    ;;
  app:needs_setup)
    say "  Harness is open in the Harness app and is waiting for you to choose its password. Choose it in the"
    say "  app's window and save the ${B}recovery key${N} it then shows once (write it down or keep it in a password"
    say "  manager — not in a chat, a plain-text note or a screenshot). This script does not choose or type it."
    if [ ! -t 0 ]; then
      note "Skipped (not interactive): choose the password in the app's window."
    else
      while :; do
        read -r -p "  Press Return here when you have done that (or type s to skip): " ans || ans="s"
        case "$ans" in [Ss]*) break ;; esac
        STATE="$(node scripts/doctor.mjs --state 2>/dev/null || echo unknown)"
        case "$STATE" in
          needs_setup|not_running:needs_setup|app:needs_setup) warn "Harness still has no password. Finish the setup in the app's window." ;;
          *) ok "Your Harness password is set."; break ;;
        esac
      done
    fi
    ;;
  migrating)
    ok "Harness is encrypting your existing data (from Harness 0.1); it continues while it runs." ;;
  error|not_running:error)
    bad "Harness's key store (vault.json) is damaged. Your data is still encrypted and nothing was changed."
    note "Quit Harness and restore vault.json from a backup of the data folder, then run this again."
    note "Do NOT choose a new password: it cannot open the existing data. Details: npm run doctor"
    exit 1 ;;
  unknown|not_running:unknown)
    warn "Could not ask Harness about its state (see: npm run doctor)." ;;
  *)
    ok "A Harness password is set." ;;
esac

# ------------------------------------------------------------------------------------------------
step "6. A chat model sized for this Mac"
if [ -z "$OLLAMA" ]; then
  warn "Skipped: needs Ollama."
else
  say "  Harness asks its own backend which file fits this Mac's memory, downloads it through Harness"
  say "  (which starts Ollama itself, with its protections) and — on an 8 GB Mac — makes a text-only copy"
  say "  that needs ~1 GB less memory. You can also do this later in the app (Models screen) or with:"
  say "  npm run get-model"
  say "  Harness blocks internet access by default. The download asks for your Harness password to allow it"
  say "  for this download only, blocks it again right after, and shows the blocker's state at the end."
  STATE="$(node scripts/doctor.mjs --state 2>/dev/null || echo unknown)"
  case "$STATE" in
    needs_setup|not_running:needs_setup|app:needs_setup)
      note "Skipped: choose your Harness password first (step 5), then run: npm run get-model" ;;
    app:*)
      note "Harness is open in the Harness app, which has no local address this script could use (by design)."
      note "Download the model in the app instead: Models → the recommended model → \"Download and set up\"."
      note "(Or quit the app with ⌘Q and run: npm run get-model)" ;;
    *)
      GET_MODEL_ARGS=""
      [ "$ASSUME_YES" = 1 ] && GET_MODEL_ARGS="--yes"
      if [ -t 0 ]; then
        # shellcheck disable=SC2086
        if ! node scripts/get-model.mjs $GET_MODEL_ARGS; then
          warn "The model step did not finish — run it again later with: npm run get-model"
        fi
      else
        note "Skipped (not interactive: it needs your Harness password). Run: npm run get-model"
      fi
      ;;
  esac
fi
stop_launcher

# ------------------------------------------------------------------------------------------------
step "7. Image generation with Draw Things (optional)"
if curl -fsS -m 2 http://127.0.0.1:7860/sdapi/v1/options >/dev/null 2>&1; then
  ok "An image server is answering on port 7860 (Draw Things or AUTOMATIC1111) — Harness will find it."
else
  say "  Harness can create images through ${B}Draw Things${N}, a free Mac app:"
  note "1. Install \"Draw Things\" from the Mac App Store."
  note "2. Open it and download a model in Draw Things itself. On an 8 GB Mac, a Stable Diffusion 1.5-class"
  note "   model is the comfortable choice; SDXL Turbo-class models work but are tight on memory."
  note "3. In Draw Things, open Settings and turn on \"API Server\" (also shown as \"HTTP Server\"):"
  note "   protocol HTTP (not gRPC), port 7860. Leave Draw Things running while you use Harness."
  note "4. Check it: curl http://127.0.0.1:7860/sdapi/v1/options   (prints its settings when it works)"
  note "Harness generates with the model currently selected in Draw Things."
fi

# ------------------------------------------------------------------------------------------------
step "8. The Harness app (optional — the browser version needs none of this)"
say "  The ${B}native app${N} (recommended) runs Harness without a local web server, so nothing else on this Mac"
say "  can connect to it. It is built here, from this folder, with Apple's Command Line Tools; the build"
say "  downloads the official Node.js runtime once (about 30 MB, checksum-verified) and takes about a minute."
NATIVE_INSTALLED=0
HAVE_SWIFT=0
if xcrun --find swiftc >/dev/null 2>&1; then HAVE_SWIFT=1; fi
if [ "$HAVE_SWIFT" = 0 ]; then
  note "Not possible yet: it needs Apple's Command Line Tools. Install them with:  xcode-select --install"
  note "and then run:  scripts/build-native.sh --install"
elif pgrep -x Harness >/dev/null 2>&1; then
  warn "Harness is running. Quit it (⌘Q), then run:  scripts/build-native.sh --install"
elif ask "Build the native Harness app and put it in /Applications (replacing an older Harness.app)?" y; then
  if scripts/build-native.sh --install; then
    NATIVE_INSTALLED=1
    ok "Installed /Applications/Harness.app (built on this Mac, so it opens without Gatekeeper prompts)"
  else
    warn "The native app did not build — see the messages above and docs/NATIVE.md."
  fi
fi

say ""
say "  The ${B}Electron app${N} is the alternative: the same features, a few hundred MB of developer tooling, and it"
say "  talks to Harness over 127.0.0.1 like the browser does."
if [ "$NATIVE_INSTALLED" = 1 ]; then
  note "Skipped: the native app is installed. (To build it anyway: npm install && npm run dist)"
elif [ -f node_modules/electron/path.txt ]; then
  ok "Electron tooling already installed (node_modules)"
elif ask "Install the Electron tooling with npm (Electron + electron-builder, a few hundred MB)?" "$([ "$HAVE_SWIFT" = 1 ] && echo n || echo y)"; then
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

if [ "$NATIVE_INSTALLED" = 0 ] && [ -f node_modules/electron/path.txt ]; then
  APP="$REPO/dist/mac-arm64/Harness.app"
  if [ -d "$APP" ]; then ok "Already built: $APP"; fi
  if ask "Build Harness.app now (npm run dist, takes a few minutes)?" "$([ -d "$APP" ] && echo n || echo y)"; then
    npm run dist
  fi
  if [ -d "$APP" ]; then
    if pgrep -x Harness >/dev/null 2>&1; then
      warn "Harness is running; quit it before copying a new version to Applications."
    elif ask "Copy Harness.app to /Applications?" y; then
      if [ -d /Applications/Harness.app ]; then rm -rf /Applications/Harness.app; fi
      ditto "$APP" /Applications/Harness.app
      ok "Installed /Applications/Harness.app"
      note "Built on this Mac, so it opens without Gatekeeper prompts. It is ad-hoc signed only:"
      note "copied to another Mac it would be blocked (see README → Gatekeeper)."
    fi
  fi
fi

# ------------------------------------------------------------------------------------------------
step "Done"
say "Start Harness in one of these ways:"
[ -d /Applications/Harness.app ] && say "  • open Harness from Applications (or Spotlight)"
say "  • double-click Harness.command in this folder (opens in your browser)"
say "  • or in Terminal:  cd \"$REPO\" && npm start -- --open"
say ""
say "Harness asks for your password when it opens and locks itself after 15 idle minutes, when the Mac"
say "sleeps (Mac app) or when you choose Lock Harness (⌃⌘L). Internet access stays blocked unless you allow it."
say ""
say "Check everything at any time with:  npm run doctor"
