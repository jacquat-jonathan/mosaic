# Build inputs

The repository records the tool versions used for development and CI:

| Tool | Source of truth | Setup |
| --- | --- | --- |
| Rust/Cargo | `rust-toolchain.toml` | Install rustup; invoking Cargo in this checkout selects the exact channel and components. |
| Node | `.nvmrc` | `nvm install && nvm use` (or install that exact version with your preferred manager). |
| pnpm | root `package.json` `packageManager` | `corepack enable pnpm`; Corepack and pnpm/action-setup consume this version. |

Run `bash scripts/check-toolchain.sh` before building. The current pins are the installed versions exercised by the architecture work, not a claim that they are the latest releases. Upgrade pins together in a dedicated PR, run the existing checks and production bundle build, and record results. The maintainer reviews tool pins monthly; dependency PRs arrive weekly.

CI reads these files, rather than repeating version numbers in workflows. Both the release build and signing job use the same Node pin; signing still installs no project dependencies and never runs the built app. The signing key and publication procedure are unchanged.

## Lockfiles

The pnpm lockfile also records pnpm’s own package-manager dependency and integrity hashes; that tool-only lock section was generated when adding `packageManager`. Future pin updates must update that section intentionally.

Use `pnpm install --frozen-lockfile`. Build/test/Clippy/coverage/benchmark Cargo commands use `--locked`; Tauri builds forward it to Cargo. Build/check entry points also fail if either lockfile changes, including when the underlying command fails. This detects accidental tool writes but does not restore or discard the change. Inspect it and perform dependency updates separately.

`cargo update` in `scripts/release.sh` is an intentional exception: release preparation changes workspace versions and must refresh the lockfile. It retains its offline mode and existing authorization rules. Do not add `--locked` to an intentional dependency/version update.

`node --test scripts/build-inputs.test.mjs` exercises real stale-lock rejection in a disposable Cargo project, lockfile mutation detection, and artifact metadata integrity. It needs Node and Cargo but downloads no dependencies.

## Build records

After packaging, the release build writes `target/build-inputs.json` and uploads the **build-inputs** workflow artifact for 90 days. The job summary includes the source SHA, dirty flag, actual compiler/Cargo/Node/pnpm versions and artifact SHA-256 digests. The full JSON additionally contains lockfile hashes, pins, host architecture and Rust compiler/host details. It collects no environment variables or credentials. A missing tool, unreadable input or unsupported/symlink artifact fails recording.

The record is outside `release-assets`; the existing five public, signed-release assets stay unchanged. It is diagnostic build metadata, not a signature or provenance attestation, and does not promise bit-for-bit reproduction or verify the tool binaries. Runner image, SDK and platform differences may still affect bytes; workflow logs retain the runner image details.

When integrating the native-smoke or performance PRs, preserve their jobs and make their setup read the same pin files. Forward `--locked` through their Cargo/Tauri commands as well. Do not remove those lanes while resolving workflow conflicts.
