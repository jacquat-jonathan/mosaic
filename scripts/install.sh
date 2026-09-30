#!/usr/bin/env bash
# Builds Mosaic for this Mac and installs it into /Applications (plus the `mosaic` command in ~/.local/bin).
# Usage: scripts/install.sh [--universal]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

command -v cargo >/dev/null || { echo "Rust is required: https://rustup.rs" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required: corepack enable pnpm" >&2; exit 1; }

pnpm install --frozen-lockfile
if [[ "${1:-}" == "--universal" ]]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  MOSAIC_SIDECAR_PROFILE=universal pnpm tauri build --target universal-apple-darwin
  app="target/universal-apple-darwin/release/bundle/macos/Mosaic.app"
else
  pnpm tauri build
  app="target/release/bundle/macos/Mosaic.app"
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
