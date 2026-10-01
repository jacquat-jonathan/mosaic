#!/usr/bin/env bash
# Run every check that must pass before a milestone commit.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
# The app's build copies the sidecar (src-tauri/binaries/mosaic-<host>) over target/debug/mosaic,
# which is the binary the CLI tests run. Refresh it first so they never test a stale CLI.
bash scripts/prepare-sidecar.sh debug
cargo test --workspace
pnpm --dir ui lint
pnpm --dir ui test
