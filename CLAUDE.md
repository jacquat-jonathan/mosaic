# Claude Code workflow

Repository development instructions live in [AGENTS.md](AGENTS.md); follow them too.

## Model routing

- Every repo search goes to Haiku: use the `search` subagent to map the repo and the
  `grep` subagent to find call sites. Do not search the repo directly in the main thread.
- Every test run goes to Haiku: use the `tests` subagent. Do not run the suite directly.
- Call the `reviewer` subagent (Opus) at these points, passing it the plan or diff:
  1. Before a plan locks, to review the plan.
  2. After the same error occurs twice.
  3. Before declaring work done, to review the final diff.
- The reviewer's reply is `APPROVE` or `REJECT`. On `REJECT`, address the listed problems
  and call it again before proceeding.

## Claude Code cloud sessions

Cloud sessions run on Linux as `root`; CI and the app target macOS. The environment's setup
script has installed the pinned Rust, Node and pnpm, Tauri's Linux libraries and the
dependencies.

- Put the pinned Node first on `PATH` before any `node` or `pnpm` command; the image's
  default Node is a different version and `scripts/check-toolchain.sh` rejects it:
  `export PATH=/opt/node-mosaic/bin:$PATH`.
- `scripts/check-rust.sh` fails here at its Clippy step: `cargo clippy --workspace` fails on
  Linux in `src-tauri/src/calendar_subscriptions.rs` (`Command` and `SERVICE` are only used
  by the macOS-only code). Run `cargo fmt --all --check`, then Clippy with
  `-p mosaic-core -p mosaic-cli`, then `cargo test --locked --workspace --no-fail-fast`,
  and leave `src-tauri`'s Clippy to CI.
- Three tests fail only because the session is `root`, which ignores file permissions:
  `inaccessible_planner_does_not_block_notes`,
  `a_link_that_cant_be_rewritten_is_reported_and_can_be_fixed_later` and
  `inaccessible_metadata_is_not_treated_as_a_deleted_note`. Any other failure is real.
- E2E: the `chrome` project needs Google Chrome, which is not available. For WebKit, run
  `pnpm --dir ui exec playwright install --with-deps webkit` once, then run only the specs
  the change touches with `--project=webkit`. About 17 of ~200 specs fail on Linux WebKit
  even on `main`, so compare with `main` before blaming a change; CI is the real gate.
- The desktop app cannot be launched or packaged here. UI work can be seen with
  `pnpm --dir ui dev` (in-memory mock vault) and a headless browser.
