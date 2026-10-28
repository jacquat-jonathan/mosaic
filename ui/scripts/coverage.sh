#!/usr/bin/env bash
# Run unit and browser tests through one Istanbul instrumentation pipeline, then
# merge their compatible coverage maps before applying the project-wide gate.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf coverage .nyc_output
mkdir -p .nyc_output

# Canonical Babel instrumentation is CPU-heavy. A single worker avoids fork-startup starvation on
# smaller CI runners; relaxed coverage-only timeouts account for instrumented module evaluation.
VITE_COVERAGE=true pnpm exec vitest run \
  --maxWorkers=1 \
  --no-file-parallelism \
  --testTimeout=120000 \
  --hookTimeout=120000 \
  --teardownTimeout=120000
VITE_COVERAGE=true pnpm e2e

pnpm exec nyc report \
  --temp-dir .nyc_output \
  --report-dir coverage \
  --reporter=text \
  --reporter=json \
  --reporter=json-summary \
  --reporter=lcov \
  --reporter=html

minimum="${MOSAIC_UI_COVERAGE_MIN:-70}"
pnpm exec nyc check-coverage \
  --temp-dir .nyc_output \
  --lines "$minimum" \
  --statements "$minimum" \
  --branches "$minimum" \
  --functions "$minimum"
