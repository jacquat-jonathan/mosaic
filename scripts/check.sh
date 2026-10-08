#!/usr/bin/env bash
# Run every check that must pass before a milestone commit.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

cargo fmt --all --check
# The app's build copies the sidecar (src-tauri/binaries/mosaic-<host>) over target/debug/mosaic,
# which is the binary the CLI tests run. Refresh it before any workspace build so clean checkouts
# have the sidecar Tauri requires and the tests never use a stale CLI.
bash scripts/prepare-sidecar.sh debug
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --dir ui lint
pnpm --dir ui test
