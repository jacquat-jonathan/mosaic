# Repository instructions

## Release work

Before preparing, tagging, publishing, or recovering a Mosaic release, read
[docs/RELEASING.md](docs/RELEASING.md). Follow it together with `scripts/release.sh`
and `.github/workflows/release.yml`; report and resolve any disagreement before acting.

- Start a release branch from updated `origin/main` after verifying that the intended
  changes are merged. Follow an explicitly requested branch name or scope.
- Use `scripts/release.sh` for a new version when cutting a release is authorized.
  It creates both the `Release <version>` commit and its local annotated tag.
- Push the preparation branch without tags. After the PR is merged and checks pass,
  verify that the tagged release commit is in `origin/main` before publishing the tag.
  Preserve that commit through the PR merge; never substitute the PR merge commit
  or whatever happens to be the latest `main` commit.
- A preparation request alone does not authorize publishing, merging a PR, or
  replacing a remote tag. Apply authorization already given in the conversation;
  do not ask again for an action the user has already authorized.
- Inspect failed logs and publication state before selecting a recovery path.
  Source changes need a new release commit. Replacing an unpublished remote tag
  requires explicit authorization and the runbook's lease and verification checks.
  Published tags and downloadable assets are immutable; use a new patch release.
- Report the branch, release commit, tag target, validation, PR/run links, and any
  remaining maintainer step. Distinguish local preparation from publication.

## Documentation

`docs/RELEASING.md` is the current release procedure. `docs/PUBLISHING.md` is a
historical bootstrap guide with key-rotation background. `docs/AGENTS.md` is the
vault-user guide shipped with Mosaic; keep repository development instructions here.
