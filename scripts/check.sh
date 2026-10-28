#!/usr/bin/env bash
# Run every check that must pass before a milestone commit.
set -euo pipefail
cd "$(dirname "$0")/.."

# CI runs these suites as independent jobs. Keep this wrapper as the one-command local gate.
bash scripts/check-rust.sh
bash scripts/check-ui.sh
