# Mosaic release runbook

This is the current procedure for preparing, publishing, and recovering releases.
It describes [release.sh](../scripts/release.sh), the [release workflow](../.github/workflows/release.yml),
and the [check workflow](../.github/workflows/check.yml). Update this document whenever
those behaviors change. The older [PUBLISHING.md](PUBLISHING.md) records the 0.18.0
bootstrap and key-rotation background; its old version numbers, key paths, and
one-time handoff instructions are not the normal release procedure.

## Rules that keep a release reproducible

- A tag `vX.Y.Z` must be annotated and point to the exact commit named `Release X.Y.Z`.
  The commit must contain all intended code and matching version metadata. A tag
  annotation such as `Mosaic X.Y.Z` does not rename the underlying commit.
- Prepare from updated `origin/main`, after the intended changes have merged.
  The repository's `dev` integration policy still applies to development batches;
  release preparation does not pull unmerged feature branches into a release.
- Preserve the release commit when merging its PR. Publish its tag only after that
  commit is reachable from `origin/main` and the relevant CI checks are green.
- A branch push and a tag push are separate steps. Pushing the release tag starts
  the build and can ultimately publish downloads. Keep it local until publication
  is authorized. Do not merge PRs or replace remote tags outside the user's scope.
- Published release tags and downloadable assets are immutable. Ship a new patch
  version for changes. Reusing a failed, unpublished version is an explicit exception
  described below, never an automatic response to CI failure.

The workflow currently has no [`run-name`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#run-name): its Actions title comes from the tagged
commit message. Tagging `Release X.Y.Z` produces the familiar **Release X.Y.Z** run
title. The workflow itself is **Universal macOS release**, and the downloadable
GitHub release title is **Mosaic X.Y.Z**. These are separate names.

## 1. Establish scope and prerequisites

Read the user's existing instructions before acting. Distinguish preparing files,
cutting a local release commit/tag, pushing a branch/PR, merging, and publishing.
Use authorization already given; this document does not grant publication permission.
If only file preparation is requested, stop before the script's commit/tag step.

Use macOS, Node 24+, pnpm 12, stable Rust with rustfmt/clippy, and the dependencies
described in the [development guide](../README.md#develop). Local browser checks need
Chrome and Playwright WebKit. The release workflow installs both Rust macOS targets
and builds Intel plus Apple Silicon binaries; a local universal build is optional.

For GitHub writes, verify the account has access to `jacquat-jonathan/mosaic`:

```sh
gh auth status --hostname github.com
```

Git SSH access and GitHub CLI access are independent. If the work-managed account
rejects PR or release writes and the personal account is already configured, use
`gh auth switch --hostname github.com --user jacquat-jonathan` for the operation.
Record the previous active account and restore it afterward. Do not print tokens.

The protected GitHub environment `release` must hold `MOSAIC_RELEASE_PRIVATE_KEY`;
its reviewer approves the signing job. The key must match one of the public keys in
[`release-public-key.hex`](../src-tauri/release-public-key.hex). Use that file as the
source of truth, rather than copying a historical key or private-key path from a guide.
Never replace a signing key merely to get a failed job to pass.

## 2. Prepare the release branch and notes

Commands below assume Bash or zsh at the repository root. Replace `X.Y.Z` with the
agreed new version, which must be newer than `[workspace.package].version`.

```sh
release_version=X.Y.Z
release_tag="v$release_version"
release_repo=jacquat-jonathan/mosaic
git fetch origin
git status --short --branch
git switch -c "release/$release_version" origin/main
```

Start with a clean tree; preserve unrelated work instead of resetting or stashing
it without agreement. If the release branch or tag already exists locally or remotely,
inspect it and resume its actual state rather than creating a second preparation.
Verify the intended feature and fix commits are merged into `origin/main`.

Review everything since the last **published** release. Consolidate `## Unreleased`
in `CHANGELOG.md` into concise user-facing bullets, remove stale claims, and explicitly
mention removals or migration requirements. Each bullet must occupy one physical
line: both the release script and packager currently extract only lines starting
with `- `. Wrapped continuation lines are omitted from generated notes.

Commit note edits before cutting the release: `release.sh` requires tracked files
to be clean. Install dependencies and run the local gate on the intended source:

```sh
pnpm install --frozen-lockfile
pnpm --dir ui exec playwright install webkit
bash scripts/check.sh
```

The gate checks Rust formatting, Clippy and tests, TypeScript, Biome, Vitest, and
Chrome/WebKit workflows. Browser workflows use the mock vault, not a packaged app.
PR/main CI additionally enforces Rust/UI coverage through `MOSAIC_COVERAGE=1`.
Report failures and environmental limitations accurately; do not silently skip checks.
The local Rust checks warm the Cargo cache needed by the script's offline lock update.

## 3. Cut and inspect the local release

When cutting the release is authorized, use the script instead of manually bumping
versions and later tagging a different commit:

```sh
bash scripts/release.sh "$release_version"
release_commit="$(git rev-parse "$release_tag^{commit}")"
test "$(git cat-file -t "$release_tag")" = tag
test "$(git show -s --format=%s "$release_commit")" = "Release $release_version"
git show --stat "$release_commit"
git show --no-patch "$release_tag"
git status --short
```

The script updates four files, commits `Release X.Y.Z`, and creates an annotated tag
on that commit. Verify all of the following:

- `Cargo.toml` workspace version and `src-tauri/tauri.conf.json` version are `X.Y.Z`.
- The `mosaic-app`, `mosaic-cli`, and `mosaic-core` entries in `Cargo.lock` match.
- `CHANGELOG.md` has one dated `## X.Y.Z — YYYY-MM-DD` section with complete notes
  and an empty `## Unreleased` section. Use the maintainer's local release date.
- The release commit contains only the intended metadata changes, the tag annotation
  contains the notes, and the working tree is clean.

The script does not run tests or push anything. It points back to this runbook
for publication; use the separate branch and tag pushes below.
If it fails partway through, inspect the tree, commit, and tag before retrying;
do not rerun it blindly against an already bumped version.

## 4. Push and merge the release PR

Push only the branch, overriding any global `push.followTags` setting:

```sh
git -c push.followTags=false push -u origin "release/$release_version"
gh pr create --repo "$release_repo" --base main --head "release/$release_version" \
  --title "Release $release_version" --body-file /absolute/path/to/release-pr.md
```

Write that PR body file first with the final release scope and actual validation.
If a PR already exists, update it rather than creating another one. The handoff must
include the PR URL, release commit SHA, tag target, checks, and remaining steps.

Wait for **Rust** and **UI** to pass. When merge is authorized, use **Create a merge
commit** to preserve the tagged release commit; do not squash or rebase the release
PR. Merging creates a separate merge commit on `main`; keep the tag on the original
`Release X.Y.Z` commit. Do not recreate it at `HEAD` or `origin/main`.

If someone already squashed/rebased the PR, stop before publishing the tag. Identify
and verify the resulting `Release X.Y.Z` commit on `main`, including its tree and
validation, then repair only the unpublished local tag under the authorized scope.
Do not substitute a merge commit just to make an ancestry check pass.

After merge, refresh and verify:

```sh
git fetch origin
test "$(git rev-parse "$release_tag^{commit}")" = "$release_commit"
test "$(git show -s --format=%s "$release_commit")" = "Release $release_version"
git merge-base --is-ancestor "$release_commit" origin/main
gh run list --repo "$release_repo" --workflow check.yml --branch main --limit 5
```

Confirm the main check for the relevant merge is green. If the shell was restarted,
restore `release_version`, `release_tag`, `release_repo`, and the recorded release
commit SHA; never reconstruct the SHA from the latest `main` tip.

## 5. Publish the tag and approve signing

After the checks above and publication authorization:

```sh
git push origin "refs/tags/$release_tag"
gh run list --repo "$release_repo" --workflow release.yml --branch "$release_tag" \
  --json databaseId,headSha,status,conclusion,url
```

Choose the new run for the expected `release_commit`. Its `build` job tests the
exact tagged source, builds the universal app and CLI, verifies the bundle, and
packages the unsigned DMG, updater archive, manifest, and checksums. The `build`
job has no release key and cannot publish.

When **Review deployments** appears in the run, the maintainer approves the
`release` environment. The `sign` job verifies that the tag matches the version,
checks hashes and the trusted signing key, signs the manifest, creates a draft,
uploads all assets, and publishes it. Do not run publication on `main`: the signing
job deliberately requires `refs/tags/vX.Y.Z`.

## 6. Verify completion

```sh
gh release view "$release_tag" --repo "$release_repo" \
  --json name,tagName,isDraft,isPrerelease,publishedAt,assets,url
git ls-remote origin "refs/tags/$release_tag" "refs/tags/$release_tag^{}"
```

Check that the release workflow succeeded, the release is public and not a
prerelease, its title is `Mosaic X.Y.Z`, and the remote tag still resolves to the
recorded release commit. There must be five uploaded release assets (GitHub's
automatic source-code downloads are additional):

| Asset | Purpose |
| --- | --- |
| `Mosaic-X.Y.Z-universal.dmg` | Manual installation |
| `Mosaic-X.Y.Z-universal.tar.gz` | In-app updater archive |
| `manifest.json` | Version, notes, archive hash/size, bundle and platform metadata |
| `manifest.sig` | Signature of the exact manifest bytes |
| `SHA256SUMS` | DMG and archive checksums |

Verify downloaded DMG/archive checksums against `SHA256SUMS`, and manifest version,
archive name/hash/size, and notes against the intended release. Perform the
[installation check](../README.md#install-on-a-mac) in a test vault: version, bundled CLI,
note editing, and persistence after restart. From an older supported app, check
About & updates and the download/restart flow with notes and settings preserved.
Follow the README's app-specific macOS first-launch instructions; the app is
ad-hoc signed, not Apple-notarized. Report manual checks that remain outstanding.

A pushed tag, a green PR, an unsigned artifact, and a draft release each represent
intermediate states. Report publication complete only after the public release
and its full signed asset set are verified.

## Failed-release recovery

### Diagnose before changing refs or rerunning

Record the tag, peeled commit SHA, failed run/attempt/job, and error. Inspect both
the failed logs and release state with an account that can see drafts:

```sh
git ls-remote origin "refs/tags/$release_tag" "refs/tags/$release_tag^{}"
gh run view RUN_ID --repo "$release_repo" --log-failed
gh release view "$release_tag" --repo "$release_repo" \
  --json isDraft,isPrerelease,publishedAt,assets,url
```

Only a genuine `release not found` response with correct access establishes that
no draft/release exists. Authentication or network errors do not. Inspect active
attempts too; an older attempt must not publish a different build during recovery.

| Observed state | Recovery |
| --- | --- |
| Preparation/PR fails before any remote tag push | Fix the preparation and refresh its local release snapshot before publishing. |
| Transient runner/network failure; source unchanged; no draft/publication | Rerun the same tag/run after addressing the cause. |
| Signing/environment configuration failure; source unchanged; no draft | Fix the environment or restore the already trusted key, then rerun. |
| Failing test or build needs source changes | Merge the fix and cut a new patch release by default. |
| Existing draft for the unchanged tag | Repair the complete signed asset set and finish the draft. |
| Already published, even if defective | Keep its tag/assets immutable; ship a new patch release. |
| Request to reuse a failed, unpublished version | Use the explicitly authorized exception below. |

### Rerun unchanged source

For a transient or configuration failure with no existing draft/publication:

```sh
gh run rerun RUN_ID --repo "$release_repo" --failed
```

To start a fresh run of the same tag if needed:

```sh
gh workflow run release.yml --repo "$release_repo" --ref "$release_tag"
```

A [rerun uses the original source revision](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
Fixes merged into `main` do not enter
an existing run, and rerunning a workflow does not rename its commit or run title.
Changing workflow code also requires a new source revision; it is not an environment fix.

### Preparation fails before a remote tag exists

Keep the same version while fixing its preparation PR. Verify that no remote tag
exists and no release run has started. Commit the fix, then append a fresh
`Release X.Y.Z` snapshot containing it (an empty commit is appropriate if release
metadata needs no change). Recreate only the local annotated tag on that snapshot,
including its complete release notes. The commit/annotation commands in the
unpublished-version exception below apply; skip its remote-tag replacement steps.

Revalidate the PR, preserve the new release commit when merging, and use the normal
first tag push. Do not push a stale local tag that predates the fix. If a remote
tag already exists, use the recovery paths for pushed tags instead.

### Source changes after a tag push: prefer a new patch version

Reproduce the logged failure, fix it on a branch from current `origin/main`, and
merge its PR after the required checks pass. Include deterministic regression
coverage where appropriate (for example, seed and query date fixtures using the
same clock in every test).

Then follow the normal process for the next patch version, including a new
`Release X.Y.Z` commit and tag. Carry forward the unpublished version's user-facing
notes so the public notes cover everything since the last published release.
Leave the failed tag/run as history. If a draft is being abandoned, handle that
draft explicitly; do not delete a published release or reuse its version.

### Exception: reuse a failed, unpublished version

This requires explicit authorization to replace the remote tag. Before doing so,
verify that no public release or draft exists, stop all older attempts for that
tag, and record the current remote **tag object** (not its peeled commit):

```sh
old_tag_object="$(git ls-remote origin "refs/tags/$release_tag" | awk '{print $1}')"
test -n "$old_tag_object"
```

After the fix is merged and green, create `release/X.Y.Z-recovery` from updated
`origin/main`. The version is already bumped: **do not rerun `release.sh` with the
same version**, since it correctly rejects that. Check all three lockfile versions,
both version declarations, and the complete dated notes. Update release metadata
if needed, then create a new dedicated release commit containing the fixed source:

```sh
git add CHANGELOG.md Cargo.toml Cargo.lock src-tauri/tauri.conf.json
git commit --allow-empty -m "Release $release_version"
recovery_commit="$(git rev-parse HEAD)"
```

The empty-commit option is intentional when the metadata is already correct: it
names a new release snapshot without rewriting the merged fix or branch history.
Push this recovery branch **without tags**, open its PR, wait for checks, and merge
with a merge commit as in step 4. Refresh and verify the recorded recovery commit:

```sh
git fetch origin
git merge-base --is-ancestor "$recovery_commit" origin/main
test "$(git show -s --format=%s "$recovery_commit")" = "Release $release_version"
release_notes="$(git show "$recovery_commit:CHANGELOG.md" | awk -v version="$release_version" '
  index($0, "## " version " — ") == 1 { on=1; next }
  /^## / { on=0 }
  on && /^- / { print }
')"
test -n "$release_notes"
git tag --force --annotate "$release_tag" "$recovery_commit" \
  -m "Mosaic $release_version" -m "$release_notes"
git push --force-with-lease="refs/tags/$release_tag:$old_tag_object" \
  origin "refs/tags/$release_tag"
```

Repeat the no-draft/no-publication and inactive-attempt checks immediately before
that push. The lease rejects a concurrent tag change; investigate instead of retrying
with unrestricted force. Confirm the new remote peeled SHA is `recovery_commit`,
record it as `release_commit`, and monitor the new run through steps 5–6. Replacing
the tag must include the fix **and** preserve the `Release X.Y.Z` commit title;
tagging the fix's PR merge commit repeats the 0.27.0 naming mistake.

### Repair an existing draft

The workflow currently invokes `gh release create` before publishing. If that
command created a draft and then failed during upload, rerunning it unchanged can
fail because the draft already exists. Keep the tag fixed and the release in draft
while repairing it; inspect the existing assets before replacing anything.

Recover one complete signed asset set from the exact tagged source/build. The
`release-assets` Actions artifact is **unsigned** and lacks `manifest.sig`; it must
not be published directly. If a maintainer has the existing trusted private key,
they can download that build artifact and sign it from an isolated clean checkout
of the exact release tag:

```sh
release_asset_dir="$(mktemp -d)"
gh run download RUN_ID --repo "$release_repo" --name release-assets --dir "$release_asset_dir"
MOSAIC_RELEASE_KEY_FILE=/absolute/protected/path/to/existing-key.pem \
  node scripts/sign-release.mjs "$release_asset_dir"
```

Verify the downloaded run's commit and version first. Never generate a replacement
key or print/export the GitHub signing secret. If the current key is available
only in the protected environment, prepare a reviewed workflow repair to complete
the draft there, or choose a new patch version; do not bypass the signing boundary.

For an authorized draft repair, upload all five files from that single verified
set, rather than mixing assets from separate builds:

```sh
gh release upload "$release_tag" --repo "$release_repo" --clobber \
  "$release_asset_dir/Mosaic-$release_version-universal.dmg" \
  "$release_asset_dir/Mosaic-$release_version-universal.tar.gz" \
  "$release_asset_dir/manifest.json" "$release_asset_dir/manifest.sig" \
  "$release_asset_dir/SHA256SUMS"
```

`--clobber` deletes each conflicting draft asset before uploading its replacement;
retain the complete signed local set and keep the release in draft if an upload
fails. Recheck tag identity, all five downloaded assets, checksums, manifest and
signature, title, and release notes. When publication is authorized and those
checks pass, finish the draft:

```sh
gh release edit "$release_tag" --repo "$release_repo" --verify-tag \
  --title "Mosaic $release_version" --notes-file "$release_asset_dir/release-notes.md" \
  --prerelease=false --draft=false
```

Apply step 6 again. Never use this draft-repair procedure to overwrite a published
asset set.
