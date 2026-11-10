# Dependency maintenance and audit triage

Owner: **@jacquat-jonathan**, the repository maintainer. This is the default assignee for every audit finding and failed scanner run until explicitly reassigned in its tracking issue or PR.

Dependabot checks Actions, the Cargo workspace and the pnpm workspace weekly. Compatible minor/patch updates are grouped per ecosystem; major upgrades remain separately reviewable. No auto-merge is enabled. Existing Rust, UI, browser and combined coverage checks remain required. Inspect changes to build scripts, lifecycle scripts, overrides and lockfiles as part of dependency review.

The **Dependency audit** workflow scans committed lockfiles weekly, on demand and on dependency PRs. It uses pinned cargo-audit 0.22.2 and the pinned pnpm. Both scanners run even if one fails; raw JSON, stderr and exit statuses are retained for 90 days and linked by the job summary. Nonzero scanner exits fail the job, including network/database errors. A scanner failure is an unknown result, not an empty report. Scans include development dependencies. This adds reporting; branch protection is a repository setting and must separately require the new job if desired.

## Dispositions

The owner reviews each failed run within two working days. For each advisory, record the advisory ID, affected direct/transitive dependency and version, reachable shipped/development use, owner, chosen disposition and evidence in a tracking issue or dependency PR. Link that record from the repair PR. Recheck critical/high findings immediately and before a release.

- **Fix:** upgrade/remove the dependency or its parent, remove obsolete overrides, rerun both audits and the ordinary checks. Link the passing run and close the finding.
- **Not affected:** document the platform/feature/reachability evidence and the upstream advisory. This is a review judgment, not permission to silently suppress the scanner.
- **Temporarily accepted:** document why no safe fix exists, mitigation, named approving maintainer and an expiry no later than 30 days. Revisit at expiry and every release. The audit remains visibly failing; this PR introduces no ignore list or blanket success override.
- **Scanner failure:** repair connectivity/tool/database failure and rerun. Never classify it as “not affected.”

The remediation below records the measured disposition of the initial vulnerability findings. Current `pnpm-workspace.yaml` overrides contain their existing dependency rationale; future changes should link their advisory/repair records. Audits detect known advisories only and do not establish that dependencies are safe.

For a local run, install the pinned scanner with `cargo install cargo-audit --locked --version 0.22.2`, select repository toolchains, and run `bash scripts/audit-dependencies.sh`. See [cargo-audit documentation](https://docs.rs/cargo-audit/0.22.2/cargo_audit/) and [build inputs](BUILD_INPUTS.md).

## Initial measured baseline and remediation

The implementation scan of source `00c2220` used RustSec database commit `d9cb059f3217db87aeccd190b81eaffe8cc29cb9` (database timestamp 9 November 2026). `pnpm audit` found zero advisories. Cargo audit exited **1** with six vulnerability records; it also reported maintenance/unsoundness/yanked warnings. This records the original failing scan, not the result after remediation.

[The baseline record](dependency-audit-baseline.json) lists every advisory, version, patched range, dependency paths, CVSS vector when supplied, owner and disposition. The JSON scanner does not emit numeric severity scores; do not interpret a missing vector as low severity. The macOS dependency graph was checked with `cargo tree --locked --offline --target aarch64-apple-darwin -i <crate>`. Presence in the graph is not proof that every advisory's vulnerable feature is enabled.

| Advisory | Dependency | Owner | Disposition |
| --- | --- | --- | --- |
| RUSTSEC-2026-0459 | libsqlite3-sys 0.38.2, through rusqlite in core | @jacquat-jonathan | Fixed by rusqlite 0.41.1 / libsqlite3-sys 0.39.1; planner/history/WAL behavior is covered by workspace tests. |
| RUSTSEC-2026-0457 | rmcp 3.5.0 in CLI | @jacquat-jonathan | Fixed by rmcp 3.9.0; the CLI continues using its existing stdio server features. |
| RUSTSEC-2026-0462 | rmcp 3.5.0 in CLI | @jacquat-jonathan | Fixed by rmcp 3.9.0; no HTTP-client feature added. |
| RUSTSEC-2026-0461 | rmcp 3.5.0 in CLI | @jacquat-jonathan | Fixed by rmcp 3.9.0; no HTTP-server feature added. |
| RUSTSEC-2026-0382 | rustls-webpki 0.103.15 via reqwest in desktop | @jacquat-jonathan | Fixed by rustls-webpki 0.103.16 in the existing TLS dependency graph. |
| RUSTSEC-2026-0381 | webpki-roots 1.0.9 via reqwest in desktop | @jacquat-jonathan | Fixed by webpki-roots 1.0.10 in the existing TLS dependency graph. |

The targeted remediation updates only the SQLite wrapper/bundled engine, MCP SDK/macros, and the two TLS packages. The 10 November 2026 resolution scan used RustSec commit `28d73fc95e5972af3403225a217def57dcaba3c4`: both scanners exited **0**, with zero Rust vulnerability records and zero pnpm advisories. The baseline JSON retains the original findings and records patched versions, scanner/database identity and the tested Cargo.lock SHA-256. No finding is accepted or suppressed.

Cargo audit still reports informational maintenance/unsoundness/yanked warnings listed in the baseline; a zero exit is not a claim that those warnings are resolved or that all dependency risks are absent. Existing Check workflow coverage/behavior gates remain unchanged. Dependency upgrades are a separate remediation commit in this PR so their manifest/lockfile changes and validation remain reviewable.
