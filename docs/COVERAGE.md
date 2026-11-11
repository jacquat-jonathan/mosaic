# Coverage policy and CI feedback

`coverage-policy.json` is the authoritative source for every floor. Changes to that policy
require an explicit review; reporting scripts do not create new percentage gates.

| Command | Measured scope | Required floor |
| --- | --- | --- |
| `pnpm coverage` | Rust workspace plus merged UI unit/browser execution | Rust 70% lines; UI 70% each lines/statements/branches/functions |
| `MOSAIC_COVERAGE=1 bash scripts/check-rust.sh` | Rust workspace | 70% lines |
| `pnpm --dir ui coverage` or `coverage report` | Combined canonical Istanbul unit and browser maps | 70% each metric; missing either input layer fails |
| `pnpm --dir ui coverage unit` | Collect unit/component maps, plus JUnit diagnostics | Tests must pass; collection alone is not the merged percentage gate |
| `pnpm --dir ui coverage e2e ...` | Collect browser maps | Tests must pass; a shard without the coverage flow can have no maps |
| `pnpm --dir ui exec vitest run --coverage` | Direct all-source unit-only Istanbul report | 29% lines/statements, 25% branches, 24% functions |
| Ordinary `pnpm --dir ui test` / `e2e` / Rust tests | Correctness without coverage instrumentation | Tests must pass; no coverage percentage is asserted |

The lower direct-Vitest floors are an existing unit-only baseline, not a substitute for the
merged 70% gate. `MOSAIC_UI_COVERAGE_MIN` can raise all merged floors for a local experiment,
but cannot lower any policy floor. Generated bindings and tests retain their existing exclusions;
no production source or future native-smoke harness is newly excluded in this change.

## Review actual evidence

Rust and merged UI coverage produce `*-feedback.json` and Markdown beside their LCOV files.
CI appends that Markdown to the job summary and retains it with coverage artifacts. The report
shows measured executable-line counts by domain, changed executable lines and uncovered line
numbers. It lists changed files with no coverage data separately; they are never counted as
covered. Non-executable changed lines and empty domains are N/A, not 100%.

CI compares PRs against the event's exact base SHA; main pushes compare the previous SHA.
Manual dispatch/local runs without `COVERAGE_BASE_SHA` still report domains and explicitly omit
the diff comparison. For a local comparison:

```sh
COVERAGE_BASE_SHA=origin/main pnpm --dir ui coverage
python3 scripts/coverage-report.py coverage/rust.lcov --label Rust \
  --base origin/main --output coverage/rust-feedback
```

Domain prefixes live with the policy. They are diagnostic groupings, not independent gates.
Prioritize uncovered persistence, planner, IPC and failure paths rather than adding tests that
only repeat implementation. The JSON contains all uncovered lines; the summary deliberately
caps displayed filenames/line numbers. LCOV paths must resolve inside the checkout; malformed
or empty data fails reporting rather than producing a misleading percentage.

Unit failures retain `ui-unit-test-results` (JUnit). Browser failures retain their existing
per-shard trace, video and screenshot artifacts. The final **CI feedback** summary links failed
jobs/steps, so an aggregate coverage failure can be traced to its failed input. It does not
relax the required **Rust** or **UI coverage** checks, and no retries were added.

## Timing baseline and honest comparisons

[The recorded baseline](ci-timing-baseline.md) and its [raw evidence](ci-timing-baseline.json)
come from successful run 42266372502 at source `8768b4b`, attempt 1. All seven sampled jobs
had cache-hit evidence: Rust 124 seconds, UI checks 165 seconds, browser shards 567–750 seconds,
and merge/report 65 seconds. They are observed warm job durations, not predictions or a
measurement of queue time. No test retry was observed in those retained logs.

A cold-run baseline is **not yet observed**; the collector records cold only when cache-miss
log evidence exists, mixed when both exist, and unknown when logs lack evidence or expired.
It never labels a first attempt cold or a rerun warm. Run attempt and observed Playwright retry
lines are retained separately; neither is a statistical flake rate. Future **CI feedback** artifacts
retain runner labels, source SHA, job/step durations, results and cache evidence for 30 days:

```sh
python3 scripts/ci-feedback.py --repo jacquat-jonathan/mosaic \
  --run RUN_ID --output coverage/ci-feedback
```

The repository already split fast UI checks and four E2E shards before this implementation.
There is no measured before/after speedup from this reporting change, so no new execution split
or speed claim is made. Collect comparable warm and cold distributions before changing worker
counts or adding lanes. Diagnose trace evidence before increasing retries.

## Integration with other architecture PRs

Keep the native-smoke lane from 09, exact toolchain setup from 12, and release preflight from 13
when combining workflow edits. Do not drop the merged UI dependency gate. If a test-only harness
is later excluded, document its separate native execution evidence and limit the exclusion to
that harness; do not exclude production adapters or lower the current floors.
