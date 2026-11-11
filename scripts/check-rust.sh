#!/usr/bin/env bash
# Run the Rust checks used by CI.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lockfiles.sh
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

bash scripts/check-toolchain.sh rust
cargo fmt --all --check
# The app's build copies the sidecar (src-tauri/binaries/mosaic-<host>) over target/debug/mosaic,
# which is the binary the CLI tests run. Refresh it before any workspace build so clean checkouts
# have the sidecar Tauri requires and the tests never use a stale CLI.
bash scripts/prepare-sidecar.sh debug
cargo clippy --locked --workspace --all-targets -- -D warnings
if [[ "${MOSAIC_COVERAGE:-0}" == "1" ]]; then
  mkdir -p coverage
  minimum="$(python3 scripts/coverage-policy.py rust lines)"
  rust_coverage_status=0
  # Rust tests don't bundle an app. Otherwise Tauri can copy its uninstrumented sidecar over
  # llvm-cov's CLI binary, making subprocess coverage depend on build order and the cache.
  TAURI_CONFIG='{"bundle":{"externalBin":[]}}' \
    cargo llvm-cov --workspace --locked --lcov --output-path coverage/rust.lcov --fail-under-lines "$minimum" || rust_coverage_status=$?
  cargo llvm-cov report --workspace --summary-only | tail -1
  if [[ -s coverage/rust.lcov ]]; then
    python3 scripts/coverage-report.py coverage/rust.lcov --label Rust --output coverage/rust-feedback
  fi
  exit "$rust_coverage_status"
else
  cargo test --locked --workspace
fi
