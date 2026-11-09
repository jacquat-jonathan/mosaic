#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lockfiles.sh
bash scripts/check-toolchain.sh all
[[ "$(cargo audit --version | awk '{print $NF}')" == '0.22.2' ]] || { echo 'Install cargo-audit 0.22.2 with --locked' >&2; exit 1; }
mkdir -p target/dependency-audit
rust_status=0
node_status=0
cargo audit --json > target/dependency-audit/rust.json 2> target/dependency-audit/rust.stderr || rust_status=$?
pnpm audit --json > target/dependency-audit/node.json 2> target/dependency-audit/node.stderr || node_status=$?
printf 'Rust scanner exit: %s\nNode scanner exit: %s\n' "$rust_status" "$node_status" | tee target/dependency-audit/status.txt
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '### Dependency audit'
    echo
    cat target/dependency-audit/status.txt
    echo
    echo 'Owner: @jacquat-jonathan. Nonzero means findings or a scanner failure, never a clean scan.'
    echo 'Download dependency-audit for full JSON/stderr. Triage and dispositions: docs/DEPENDENCIES.md.'
  } >> "$GITHUB_STEP_SUMMARY"
fi
[[ "$rust_status" == 0 && "$node_status" == 0 ]]
