#!/usr/bin/env bash
# Performance budgets from the spec (search < 1 s on 5,000 notes).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lockfiles.sh
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
# Search on 5,000 notes, and two indexers (the app and the CLI) sharing one vault.
cargo test --locked --release -p mosaic-core -- --ignored bench --nocapture
