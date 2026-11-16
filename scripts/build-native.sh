#!/bin/bash
# Build the native macOS app (AppKit + WKWebView, no Electron, no localhost server):
#   dist/native/Harness.app  and  dist/native/Harness-<version>-arm64.zip
#
#   scripts/build-native.sh [--system-node] [--sign <identity>] [--install] [--no-zip]
#
#   --system-node   do not bundle Node.js; the app uses the node found now (and /opt/homebrew/bin/node)
#   --sign <id>     sign with this code-signing identity instead of ad hoc ("-"); a stable identity keeps the
#                   Keychain from asking again after every rebuild (keychain mode only)
#   --install       copy the result to /Applications/Harness.app (replacing an existing Harness.app)
#   --no-zip        skip the zip
#
# Needs: macOS on Apple Silicon and the Xcode Command Line Tools (xcode-select --install); no Xcode project,
# no Node.js (unless --system-node), no npm install. Downloads the pinned official Node.js runtime once (cached in
# ~/Library/Caches/Harness-build) and checks its SHA-256. See docs/NATIVE.md.
set -euo pipefail

NODE_VERSION=24.22.2
# From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
NODE_SHA256=1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115
NODE_TARBALL=node-v$NODE_VERSION-darwin-arm64.tar.xz

SYSTEM_NODE=0
SIGN=-
INSTALL=0
ZIP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --system-node) SYSTEM_NODE=1 ;;
    --sign) SIGN="${2:?--sign needs an identity}"; shift ;;
    --install) INSTALL=1 ;;
    --no-zip) ZIP=0 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/.."
ROOT=$PWD
say() { printf '==> %s\n' "$*"; }
die() { printf 'build-native: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this builds a macOS app; run it on a Mac"
[ "$(uname -m)" = arm64 ] || say "note: this Mac is $(uname -m); the app is built for Apple Silicon (arm64)"
xcrun --find swiftc > /dev/null 2>&1 || die "no Swift compiler: install the Xcode Command Line Tools with: xcode-select --install"

VERSION=$(sed -n 's/^  "version": "\([^"]*\)",*$/\1/p' package.json | head -n 1)
[ -n "$VERSION" ] || die "cannot read the version from package.json"

OUT=$ROOT/dist/native
APP=$OUT/Harness.app
C=$APP/Contents
rm -rf "$APP"
mkdir -p "$C/MacOS" "$C/Resources/app"

say "Compiling Harness $VERSION ($(xcrun swiftc --version 2>&1 | head -n 1 | sed 's/^.*\(Swift version [0-9.]*\).*$/\1/'))"
xcrun swiftc -O -swift-version 5 -target arm64-apple-macos12.0 -o "$C/MacOS/Harness" native/Sources/*.swift \
  -framework AppKit -framework WebKit -framework Security -framework Carbon

say "Assembling the bundle"
sed "s/__VERSION__/$VERSION/g" native/Info.plist > "$C/Info.plist"
cp build/icon.icns "$C/Resources/Harness.icns"
cp package.json "$C/Resources/app/package.json"
for d in server public; do ditto "$d" "$C/Resources/app/$d"; done
find "$C/Resources/app" \( -name '*.test.mjs' -o -name '.DS_Store' \) -delete

if [ "$SYSTEM_NODE" = 1 ]; then
  NODE_BIN=$(command -v node || true)
  [ -n "$NODE_BIN" ] || die "--system-node: no node on PATH (install it, e.g. brew install node)"
  say "Using the system Node.js: $NODE_BIN ($("$NODE_BIN" -v))"
  plutil -insert HarnessNodePath -string "$NODE_BIN" "$C/Info.plist"
else
  CACHE=$HOME/Library/Caches/Harness-build
  mkdir -p "$CACHE"
  if [ ! -f "$CACHE/$NODE_TARBALL" ]; then
    say "Downloading Node.js $NODE_VERSION (official arm64 build)"
    curl -fL --retry 3 --proto '=https' -o "$CACHE/$NODE_TARBALL.part" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL"
    mv "$CACHE/$NODE_TARBALL.part" "$CACHE/$NODE_TARBALL"
  fi
  GOT=$(shasum -a 256 "$CACHE/$NODE_TARBALL" | awk '{print $1}')
  if [ "$GOT" != "$NODE_SHA256" ]; then
    rm -f "$CACHE/$NODE_TARBALL"
    die "Node.js download has the wrong SHA-256 ($GOT); deleted it. Run the script again."
  fi
  say "Node.js $NODE_VERSION verified (SHA-256 $NODE_SHA256)"
  TMP=$(mktemp -d)
  tar -xJf "$CACHE/$NODE_TARBALL" -C "$TMP" "node-v$NODE_VERSION-darwin-arm64/bin/node" "node-v$NODE_VERSION-darwin-arm64/LICENSE"
  # Keep the Node.js project's own signature on the binary.
  cp "$TMP/node-v$NODE_VERSION-darwin-arm64/bin/node" "$C/MacOS/node"
  cp "$TMP/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$C/Resources/node-LICENSE.txt"
  rm -rf "$TMP"
fi

say "Signing ($( [ "$SIGN" = - ] && echo 'ad hoc' || echo "$SIGN" ))"
codesign --force --sign "$SIGN" --identifier local.harness.app --options runtime --timestamp=none "$APP"
codesign --verify --deep --strict "$APP" || die "the signature does not verify"

if [ "$ZIP" = 1 ]; then
  ZIPFILE=$OUT/Harness-$VERSION-arm64.zip
  rm -f "$ZIPFILE"
  ditto -c -k --keepParent "$APP" "$ZIPFILE"
fi

say "Built $APP ($(du -sh "$APP" | awk '{print $1}'))${ZIPFILE:+ and $ZIPFILE ($(du -sh "$ZIPFILE" | awk '{print $1}'))}"

if [ "$INSTALL" = 1 ]; then
  if pgrep -x Harness > /dev/null 2>&1; then die "Harness is running: quit it (⌘Q), then run with --install again"; fi
  if [ -e /Applications/Harness.app ]; then say "Replacing /Applications/Harness.app"; rm -rf /Applications/Harness.app; fi
  ditto "$APP" /Applications/Harness.app
  say "Installed /Applications/Harness.app — open it from Launchpad, Spotlight or the Applications folder"
fi
