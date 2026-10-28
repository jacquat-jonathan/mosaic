#!/usr/bin/env bash
# Run the Rust checks used by CI.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

cargo fmt --all --check
# The app's build copies the sidecar (src-tauri/binaries/mosaic-<host>) over target/debug/mosaic,
# which is the binary the CLI tests run. Refresh it before any workspace build so clean checkouts
# have the sidecar Tauri requires and the tests never use a stale CLI.
bash scripts/prepare-sidecar.sh debug
cargo clippy --workspace --all-targets -- -D warnings
if [[ "${MOSAIC_COVERAGE:-0}" == "1" ]]; then
  mkdir -p coverage
  cargo llvm-cov --workspace --lcov --output-path coverage/rust.lcov --fail-under-lines 70
  cargo llvm-cov report --workspace --summary-only | tail -1
else
  cargo test --workspace
fi
