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
  note "Tip: let Harness start Ollama itself (it does so automatically) — it then turns on memory-saving"
  note "settings (flash attention, 8-bit context cache) that let a bigger context window fit."
  note "If the Ollama menu-bar app is already running, Harness uses that one as it is."
fi

# ------------------------------------------------------------------------------------------------
step "5. A chat model sized for this Mac"
if [ -z "$OLLAMA" ]; then
  warn "Skipped: needs Ollama."
else
  REC_FILE="$(mktemp "${TMPDIR:-/tmp}/harness-setup.XXXXXX")"
  MODEL="$(node scripts/doctor.mjs --recommended-model 2>"$REC_FILE" || true)"
  REC_INFO="$(cat "$REC_FILE" 2>/dev/null || true)"; rm -f "$REC_FILE"
  if [ -z "$MODEL" ]; then
    warn "Could not work out a recommendation (see: npm run doctor). You can pick a model later in the app."
  else
    say "  Harness recommends: ${B}$MODEL${N}"
    [ -n "$REC_INFO" ] && note "$REC_INFO"
    STARTED_PID=""
    if ! curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
      note "Starting Ollama temporarily to check the installed models (stopped again at the end of this step)."
      "$OLLAMA" serve >"${TMPDIR:-/tmp}/harness-setup-ollama.log" 2>&1 &
      STARTED_PID=$!
      for _ in $(seq 1 30); do curl -fsS -m 1 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
    fi
    if "$OLLAMA" list 2>/dev/null | awk 'NR>1 {print $1}' | grep -Fxq "$MODEL"; then
      ok "$MODEL is already downloaded"
    elif ask "Download it now with Ollama (several GB; you can also do this later in the app)?" y; then
      if "$OLLAMA" pull "$MODEL"; then ok "Downloaded $MODEL"; else bad "Download failed — try again later, or use Models → Download in Harness."; fi
    fi
    if [ -n "$STARTED_PID" ]; then kill "$STARTED_PID" 2>/dev/null || true; wait "$STARTED_PID" 2>/dev/null || true; fi
  fi
fi

# ------------------------------------------------------------------------------------------------
step "6. Image generation with Draw Things (optional)"
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
step "7. Desktop app (optional — the browser version needs none of this)"
if [ -f node_modules/electron/path.txt ]; then
  ok "Desktop app tooling already installed (node_modules)"
elif ask "Install the desktop app tooling with npm (Electron + electron-builder, a few hundred MB)?" y; then
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

if [ -f node_modules/electron/path.txt ]; then
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
say "Check everything at any time with:  npm run doctor"
