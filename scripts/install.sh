#!/usr/bin/env bash
# Builds Mosaic for this Mac and installs it into /Applications (plus the `mosaic` command in ~/.local/bin).
# Usage: scripts/install.sh [--universal] [--build-only]
#   --build-only  build but don't install; prints BUILT_APP=<path> (used by Settings › Update in the app,
#                 which installs the new build itself after it quits).
set -euo pipefail
cd "$(dirname "$0")/.."

universal=0
build_only=0
for arg in "$@"; do
  case "$arg" in
    --universal) universal=1 ;;
    --build-only) build_only=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$HOME/.volta/bin:$HOME/Library/pnpm:$PATH"

# Settings › Update runs this in a non-interactive login shell, which doesn't read ~/.zshrc — where
# nvm is usually set up. Load nvm ourselves, then fall back to pnpm shims made by corepack.
if ! command -v pnpm >/dev/null; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    set +u
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh" >/dev/null
    set -u
  fi
fi
if ! command -v pnpm >/dev/null && command -v corepack >/dev/null; then
  shims="$(mktemp -d)"
  corepack enable --install-directory "$shims" pnpm
  export PATH="$shims:$PATH"
fi

command -v cargo >/dev/null || { echo "Rust is required: https://rustup.rs" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required: corepack enable pnpm" >&2; exit 1; }

pnpm install --frozen-lockfile
if [[ $universal == 1 ]]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  MOSAIC_SIDECAR_PROFILE=universal pnpm tauri build --target universal-apple-darwin
  app="target/universal-apple-darwin/release/bundle/macos/Mosaic.app"
else
  pnpm tauri build
  app="target/release/bundle/macos/Mosaic.app"
fi

if [[ $build_only == 1 ]]; then
  echo "BUILT_APP=$PWD/$app"
  exit 0
fi

# Quit a running copy, then replace it.
osascript -e 'tell application "Mosaic" to quit' >/dev/null 2>&1 || true
rm -rf /Applications/Mosaic.app
ditto "$app" /Applications/Mosaic.app
# Self-built apps carry no quarantine flag, but clear it in case the folder came from a download.
xattr -dr com.apple.quarantine /Applications/Mosaic.app 2>/dev/null || true

mkdir -p "$HOME/.local/bin"
ln -sf /Applications/Mosaic.app/Contents/MacOS/mosaic "$HOME/.local/bin/mosaic"

echo "Installed /Applications/Mosaic.app and ~/.local/bin/mosaic"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to use the mosaic command." ;; esac
