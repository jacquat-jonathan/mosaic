#!/usr/bin/env bash
# Produce complete all-source coverage reports for Rust and the browser UI.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! cargo llvm-cov --version >/dev/null 2>&1; then
  echo "cargo-llvm-cov is required: cargo install cargo-llvm-cov --locked --version 0.9.1" >&2
  exit 1
fi

mkdir -p coverage
rust_coverage_status=0
# Don't let app bundling overwrite llvm-cov's instrumented CLI during the workspace build.
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' \
  cargo llvm-cov --workspace --lcov --output-path coverage/rust.lcov --fail-under-lines 70 || rust_coverage_status=$?
cargo llvm-cov report --workspace --summary-only | tail -1
if [[ "$rust_coverage_status" != "0" ]]; then
  exit "$rust_coverage_status"
fi
pnpm --dir ui coverage

echo "Rust LCOV: coverage/rust.lcov"
echo "UI LCOV and HTML data: ui/coverage/"
