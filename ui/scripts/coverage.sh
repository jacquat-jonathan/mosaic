#!/usr/bin/env bash
# Run the complete local coverage gate, or one stage for parallel CI jobs.
# Usage: coverage.sh [all|unit|e2e|report] [test-runner arguments...]
set -euo pipefail
cd "$(dirname "$0")/.."

stage="${1:-all}"
if [[ "$#" -gt 0 ]]; then shift; fi
case "$stage" in
  all|unit|e2e)
    rm -rf coverage .nyc_output
    mkdir -p .nyc_output
    ;;
  report) rm -rf coverage ;;
  *) echo "Usage: coverage.sh [all|unit|e2e|report] [test-runner arguments...]" >&2; exit 2 ;;
esac

# Canonical Babel instrumentation is CPU-heavy. A single worker avoids fork-startup starvation on
# smaller CI runners; relaxed coverage-only timeouts account for instrumented module evaluation.
if [[ "$stage" == "all" || "$stage" == "unit" ]]; then
  VITE_COVERAGE=true pnpm exec vitest run \
    --maxWorkers=1 \
    --no-file-parallelism \
    --testTimeout=120000 \
    --hookTimeout=120000 \
    --teardownTimeout=120000 \
    "$@"
fi
if [[ "$stage" == "all" || "$stage" == "e2e" ]]; then
  VITE_COVERAGE=true pnpm e2e "$@"
fi
if [[ "$stage" == "unit" || "$stage" == "e2e" ]]; then exit 0; fi

for layer in unit e2e; do
  if ! compgen -G ".nyc_output/$layer-*.json" >/dev/null; then
    echo "Missing $layer coverage maps in .nyc_output; both test layers are required" >&2
    exit 1
  fi
done

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
