#!/usr/bin/env bash
# Build a real app bundle with an explicit test-only host. Never install or publish this artifact.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
mkdir -p target/native-smoke
if [[ "${1:-}" != --skip-build ]]; then
  pnpm --dir ui build 2>&1 | tee target/native-smoke/production-build.log
  node scripts/build-summary.mjs
  MOSAIC_SIDECAR_PROFILE=debug VITE_NATIVE_SMOKE=1 pnpm tauri build --debug --features native-smoke \
    --config '{"productName":"Mosaic Native Smoke","identifier":"dev.jona.mosaic.native-smoke"}' \
    2>&1 | tee target/native-smoke/bundle-build.log
fi
# No install.sh invocation, /Applications writes, signing secrets, or real update requests.
python3 scripts/native-smoke/run.py 'target/debug/bundle/macos/Mosaic Native Smoke.app' 2>&1 | tee target/native-smoke/journey.log
cargo test --locked -p mosaic-app update::binary::tests -- --skip finds_and_verifies_the_published_release 2>&1 | tee target/native-smoke/signature-fixtures.log
cargo test --locked -p mosaic-app update::native_smoke_tests -- --nocapture 2>&1 | tee target/native-smoke/update-fixtures.log
