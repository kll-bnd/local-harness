#!/bin/bash
# Double-click this file in Finder to run Harness in your web browser (no desktop app needed).
# Terminal opens, Harness starts and your browser opens it. Close the Terminal window or press
# Ctrl+C to stop Harness. If Harness is already running, this just opens it.
# Your password is typed in the browser window (Harness's own lock or first-start screen), never here.
#
# First time: macOS may say it cannot verify the file. Right-click it → Open, or run it once from
# Terminal:  ./Harness.command
set -euo pipefail
cd "$(dirname "$0")"

# Finder-launched shells may not have Homebrew on PATH.
for dir in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Harness needs Node.js 20 or newer, which was not found."
  echo "Install it with:  brew install node     (or run scripts/setup-macos.sh)"
  read -r -p "Press Return to close." _ || true
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "Harness needs Node.js 20 or newer; this Mac has $(node -v)."
  echo "Update it with:  brew upgrade node"
  read -r -p "Press Return to close." _ || true
  exit 1
fi

exec node scripts/launch.mjs "$@"
