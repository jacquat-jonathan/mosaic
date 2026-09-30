#!/usr/bin/env bash
# Builds the `mosaic` CLI/MCP binary and places it where Tauri bundles sidecars
# (src-tauri/binaries/mosaic-<target-triple>). Usage: prepare-sidecar.sh [debug|release|universal]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
profile="${1:-release}"
mkdir -p src-tauri/binaries
host="$(rustc -vV | sed -n 's/^host: //p')"
case "$profile" in
  debug)
    cargo build -p mosaic-cli
    cp target/debug/mosaic "src-tauri/binaries/mosaic-$host" ;;
  release)
    cargo build --release -p mosaic-cli
    cp target/release/mosaic "src-tauri/binaries/mosaic-$host" ;;
  universal)
    # Tauri builds each architecture separately (needs per-triple sidecars), then merges them.
    for t in aarch64-apple-darwin x86_64-apple-darwin; do
      cargo build --release -p mosaic-cli --target "$t"
      cp "target/$t/release/mosaic" "src-tauri/binaries/mosaic-$t"
    done
    lipo -create -output src-tauri/binaries/mosaic-universal-apple-darwin \
      target/aarch64-apple-darwin/release/mosaic target/x86_64-apple-darwin/release/mosaic ;;
  *) echo "unknown profile $profile" >&2; exit 1 ;;
esac
