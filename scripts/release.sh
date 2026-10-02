#!/usr/bin/env bash
# Cuts a release: bumps the version, turns CHANGELOG.md's "Unreleased" section into this release,
# commits and tags it. Nothing is pushed; the script prints the command to do it.
# Usage: scripts/release.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: scripts/release.sh <major.minor.patch>" >&2; exit 2; }
current="$(sed -n '/^\[workspace.package\]/,/^\[/s/^version = "\(.*\)"/\1/p' Cargo.toml)"

newer() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]; }
newer "$version" "$current" || { echo "$version isn't newer than the current version $current." >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Commit or stash your changes first." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && { echo "Tag v$version already exists." >&2; exit 1; }

# The Unreleased section must say what changed: at least one bullet before the next heading.
notes="$(awk '/^## Unreleased/{on=1; next} /^## /{on=0} on && /^- /' CHANGELOG.md)"
[[ -n "$notes" ]] || { echo "CHANGELOG.md has nothing under \"## Unreleased\". Describe the changes first." >&2; exit 1; }

today="$(date +%Y-%m-%d)"
perl -0pi -e "s/^## Unreleased\n/## Unreleased\n\n## $version — $today\n/m" CHANGELOG.md
# Keep a blank line before every release heading, however the notes were added.
perl -0pi -e 's/([^\n])\n(## )/$1\n\n$2/g' CHANGELOG.md
perl -0pi -e "s/(\[workspace\.package\]\n(?:[^\[].*\n)*?)version = \"[^\"]*\"/\${1}version = \"$version\"/" Cargo.toml
perl -pi -e "s/^  \"version\": \"[^\"]*\",/  \"version\": \"$version\",/" src-tauri/tauri.conf.json
cargo update --workspace --offline --quiet # refreshes Cargo.lock with the new version

git add CHANGELOG.md Cargo.toml Cargo.lock src-tauri/tauri.conf.json
git commit -q -m "Release $version"
git tag -a "v$version" -m "Mosaic $version"$'\n\n'"$notes"
echo "Released $version (was $current). Publish it with: git push --follow-tags"
