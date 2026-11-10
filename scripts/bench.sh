#!/usr/bin/env bash
# Existing correctness benchmarks. MOSAIC_PERF_REPORT=1 reports timing without the legacy 1s gate.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lockfiles.sh
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
# Search on 5,000 notes, and two indexers (the app and the CLI) sharing one vault.
printf "MOSAIC_PERF_RUST %s\n" "$(rustc --version)"
cargo test --locked --release -p mosaic-core -- --ignored bench --nocapture --test-threads=1
