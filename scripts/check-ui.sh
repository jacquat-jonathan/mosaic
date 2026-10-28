#!/usr/bin/env bash
# Run the UI checks used by CI.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --dir ui lint
pnpm --dir ui exec biome ci .
if [[ "${MOSAIC_COVERAGE:-0}" == "1" ]]; then
  pnpm --dir ui coverage
else
  pnpm --dir ui test
  # User workflows run in Chrome and WebKit against the dev server's mock vault. The coverage
  # command already runs these with source instrumentation and merges their execution.
  pnpm --dir ui e2e
fi
