#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-all}"
case "$mode" in all|rust|node) ;; *) echo 'Expected all, rust or node' >&2; exit 2 ;; esac
expect() {
  if [[ "$2" != "$3" ]]; then
    echo "$1 version mismatch: expected $2, found $3. See docs/BUILD_INPUTS.md." >&2
    exit 1
  fi
}
if [[ "$mode" != node ]]; then
  version="$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)"
  expect Rust "$version" "$(rustc --version | awk '{print $2}')"
  expect Cargo "$version" "$(cargo --version | awk '{print $2}')"
fi
if [[ "$mode" != rust ]]; then
  expect Node "v$(cat .nvmrc)" "$(node --version)"
  version="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
  expect pnpm "$version" "$(pnpm --version)"
fi
