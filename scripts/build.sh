#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lockfiles.sh
bash scripts/check-toolchain.sh all
pnpm exec tauri build "$@" -- --locked
