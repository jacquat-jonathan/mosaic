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

- Do not prepare a release here: a cloud session cannot push the release tag, so releases are
  done from a local Claude Code session. If asked for one, say so before doing anything
  (see [docs/RELEASING.md](docs/RELEASING.md)).
- Put the pinned Node first on `PATH` before any `node` or `pnpm` command; the image's
  default Node is a different version and `scripts/check-toolchain.sh` rejects it:
  `export PATH=/opt/node-mosaic/bin:$PATH`.
- Before `cargo` builds of the app, run `bash scripts/prepare-sidecar.sh debug` once: Tauri needs the
  CLI sidecar in `src-tauri/binaries`. Then `cargo fmt --all --check`,
  `cargo clippy --locked --workspace --all-targets -- -D warnings` (clean on Linux) and
  `cargo test --locked --workspace --no-fail-fast`.
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
