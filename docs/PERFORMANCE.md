# Performance measurements

The `Performance report` workflow runs weekly or manually on macOS 15. It does not run in the release workflow or gate merges. Correctness failures fail the reporting job; noisy timing regressions are signals in its summary, not permission to skip correctness checks. It retains raw samples, logs, browser failure traces, source identity, tools, runner details and production chunk sizes for 90 days.

Run from the repository root with the documented development tools and installed Chrome:

```sh
pnpm install --frozen-lockfile
node --test scripts/performance/report.test.mjs
node scripts/performance/report.mjs core target/performance
pnpm --dir ui exec playwright test --config playwright.perf.config.ts
node scripts/performance/report.mjs build
node scripts/performance/report.mjs report target/performance
node scripts/performance/report.mjs compare path/to/baseline/report.json target/performance/report.json
```

`MOSAIC_PERF_SAMPLES` chooses 5–30 independent core repetitions (default five). Browser fixtures use five repetitions after setup. Use an isolated `CARGO_TARGET_DIR` when other worktrees are being tested. Compilation, fixture generation and initial browser setup are excluded from timings. Core runs serialize the benchmark tests to avoid timing one workload against another. They use release optimization and fresh temporary vault/database directories; no real vault or desktop app is opened. `scripts/bench.sh` remains usable on its own, with its historical one-second search assertion. The reporter sets `MOSAIC_PERF_REPORT=1` to collect that timing without imposing the historical wall-clock gate.

## What is measured

| Measurement | Fixture and correctness requirement |
|---|---|
| Cold index | Empty database, 5,000 notes in 50 folders, deterministic text and links; search returns results. Cold means database-empty, not an OS cache flush. |
| Warm index | Same unchanged vault/database after the cold sync. |
| Search | 20 queries per repetition over the same 5,000-note database; result count remains stable. |
| Burst index | Change 100 notes then sync; all 100 changed notes must be searchable. |
| Concurrent indexers | Two independent SQLite connections, 20 edit/sync rounds each; both final edits must survive. This models app/CLI contention but is not a two-process desktop measurement. |
| External edit to screen | Headless Chrome + Vite + mock IPC, 1,000-note fixture; externally changed text must appear in the real editor. Includes event debounce, rendering and driver-observation overhead. |
| Burst to screen | 50 mock writes/events, then updated editor text; same 1,000-note fixture. |
| Vault switch | Await full mock vault activation and visible tree; files remain in the mock backend. No native disk/IPC cost is claimed. |
| Bundle | Actual production JS/CSS files, per-chunk bytes/gzip bytes plus totals. Gzip is a consistent comparison measure, not the desktop's delivery transport. |

`fixture.json` versions the workloads. Each collection stage records source/workload identity; final reporting refuses mixed or stale core, browser, and production-build stages. The core collector records the Rust version from the benchmark shell, and build metadata records the actual Node/pnpm versions. Every report stores raw values and count/min/median/p95/max, fixture parameters, benchmark source hashes, source commit and dirty diff hash, OS/CPU/memory/image and exact Rust/Node/pnpm/Chrome versions. A dirty local report is calibration evidence only, not an immutable shipping-commit claim. The initial local report in `docs/performance/local-baseline.json` was collected with the hardened reporter and serialized core workloads. It is dirty-worktree calibration evidence, requiring explicit `--allow-dirty` for comparisons; CI will establish its own clean reference. Other architecture work could be running; it establishes an executable baseline, not a promised end-user latency.

## Budgets and comparisons

The comparator refuses different fixture/runner/tool/workload fingerprints and records missing metrics instead of silently passing them. Workload fingerprints include only the marked core benchmark bodies plus browser/harness files, so changing application code does not invalidate an otherwise comparable experiment. Raw sample counts and reported statistics are validated before comparison. Dirty reports require an explicit `--allow-dirty` opt-in for local calibration; scheduled CI never uses it. Timing signals require at least five samples in each report. A provisional signal is a median **or p95** increase over 25% and over 5 ms (bundle bytes: over 25% and 1 KiB). These are investigation triggers, not calibrated product SLAs. Small differences below those absolute margins are not meaningful on shared runners. `--strict` is available for a deliberately controlled experiment and also rejects missing/new metrics or insufficient samples; CI does not use it. Regression tests prove a doubled latency produces a signal, noise does not, incompatible runs are rejected, and dropped metrics are visible.

The workflow compares against the last successful main reference run only when fingerprints match. A changed runner image or tool version starts a separate baseline; comparison failure is visible without invalidating the new measurements. Download an older compatible artifact for longer-term comparison. Before introducing blocking budgets, retain at least ten compatible reference runs, inspect variance/outliers, choose per-metric thresholds from those distributions, and review the policy change. Do not optimize viewer loading or refresh traversal based on one run. No production optimization is included here because no bottleneck has been established.

When integrating build-input improvement 12, make this workflow consume its shared tool pins too; the report already captures actual tool versions and rejects cross-version comparisons. Packaged startup/OS timings belong to improvement 09's native harness and need a separate profile; the browser fixture must never be relabelled as WKWebView.
