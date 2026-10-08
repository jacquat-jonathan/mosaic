# Publish Mosaic 0.18.0 from your personal computer

The implementation and annotated `v0.18.0` tag are already pushed to
[jacquat-jonathan/mosaic](https://github.com/jacquat-jonathan/mosaic).
You do **not** need to push again, create another version, or join the Apple Developer Program.
The remaining step is to publish the downloadable assets using your personal GitHub account.

This computer's `personal_github` SSH key successfully pushed the code as `jacquat-jonathan`.
SSH authentication cannot upload GitHub Release assets or configure Actions secrets.
The GitHub CLI here uses the work account, which has no write access to the repository.

## 1. Bring the release-signing key to your personal computer safely

There are two different keys: your **GitHub SSH key** authenticates Git pushes; Mosaic's
**release-signing key** authenticates updates downloaded by the app. They are not interchangeable.

The generated release-signing private key is on this computer at:

```text
/Users/jonathan.jacquat/Developer/mosaic/target/release-signing/private.pem
```

It is permission-protected and Git-ignored: cloning the repository will **not** copy it.
Transfer this file using a secure method allowed by your organization's policy, and keep a
protected backup outside a disposable build directory. Do not transfer the work computer's
GitHub credentials, paste private keys into chat/email/issues, or commit a key to Git.

On your personal Mac, save the transferred file in a protected location of your choice and run:

```sh
chmod 600 "/absolute/path/to/mosaic-release-private.pem"
```

Replace that example path in the commands below with its actual location.
Do not generate a different signing key: the pushed app embeds the matching public key:

```text
39a9c21d9eb4f2f45081ee5cfd3b557143e5e296ca4d15d33412065e02c351e8
```

If secure transfer is unavailable or the key is lost, stop and arrange a new bootstrap/release
plan. A different key requires rebuilding the app with its matching public key; it is not a
drop-in replacement for this tag. Do not rewrite the already-pushed tag.

## 2. Sign GitHub CLI into your personal account

Install [GitHub CLI](https://cli.github.com/) if needed. On a Mac with Homebrew:

```sh
brew install gh
gh auth login --hostname github.com --git-protocol https --web
gh auth status --hostname github.com
```

Complete browser authentication yourself as **jacquat-jonathan**, not the work account.
If both accounts are already configured, switch with:

```sh
gh auth switch --hostname github.com --user jacquat-jonathan
```

Check repository permissions:

```sh
gh api repos/jacquat-jonathan/mosaic --jq '.permissions'
```

`push` must be true for publishing, and repository admin access is needed to manage its secret.
No GitHub token is embedded in Mosaic. See the official [login instructions](https://cli.github.com/manual/gh_auth_login).

## 3. Configure the protected signing secret once

```sh
gh secret set MOSAIC_RELEASE_PRIVATE_KEY \
  --repo jacquat-jonathan/mosaic \
  < "/absolute/path/to/mosaic-release-private.pem"
gh secret list --repo jacquat-jonathan/mosaic
```

This sends the PEM to the repository's encrypted Actions secret, without printing it or placing
it in a command argument. Check that the secret name appears; never print its value.
The build checks that this key matches the embedded public key before packaging.
See [GitHub CLI secret setup](https://cli.github.com/manual/gh_secret_set).

## 4. Run the existing release workflow on the tag

Open the repository's [Actions page](https://github.com/jacquat-jonathan/mosaic/actions).
If GitHub says Actions or this workflow is disabled, enable it for this repository first.
No release workflow run was visible when the tag was pushed; its execution is not yet verified.

```sh
gh workflow run release.yml --repo jacquat-jonathan/mosaic --ref v0.18.0
gh run list --repo jacquat-jonathan/mosaic --workflow release.yml --limit 3
```

Use the run ID shown by the second command:

```sh
gh run watch RUN_ID --repo jacquat-jonathan/mosaic --exit-status
```

Run on **v0.18.0**, not `main`: publication intentionally checks that the Git ref is the release
tag. The [workflow dispatch command supports tag refs](https://cli.github.com/manual/gh_workflow_run).
The runner tests, builds the universal app, signs the update manifest, uploads a draft release
and publishes it only after all assets have uploaded. You need no local Rust/Node/pnpm build tools
for this route. A missing/wrong signing key must fail the job; do not disable that check.

If it fails, inspect the failed step before retrying. If a draft release already exists, check its
assets and repair that draft instead of deleting a published release or rewriting the tag.

## 5. Confirm the public download and first launch

```sh
gh release view v0.18.0 --repo jacquat-jonathan/mosaic --web
```

The published release must contain all five assets:

- `Mosaic-0.18.0-universal.dmg`
- `Mosaic-0.18.0-universal.tar.gz`
- `manifest.json`
- `manifest.sig`
- `SHA256SUMS`

Use an ordinary browser, ideally on a clean Mac/user account, to download the DMG and test:

1. Open the DMG, drag Mosaic to Applications and launch it there; choose a test notes folder.
2. If macOS cannot verify the developer, follow the app-specific **System Settings → Privacy &
   Security → Open Anyway** process described in the repository README. Stop on a malware or
   damaged-app warning. Do not disable Gatekeeper or remove quarantine; managed Macs may forbid an exception.
3. Verify the app shows 0.18.0, opens notes and remembers settings after restart. AI is optional;
   test CLI/MCP setup from Connections separately if you use it.
4. Check About & updates without a source checkout or developer tools. With no newer release,
   it should not offer to reinstall 0.18.0. Older 0.17-and-earlier installations need this one
   manual install to acquire the binary updater.

A real binary version-to-version update needs a **later published release**. Test download,
Cancel, Restart to finish, unchanged notes/settings and the preserved CLI/MCP path then; restart
MCP clients to load the new executable. That acceptance check and clean-Mac Gatekeeper testing
remain open, not completed by the local bundle-swap tests.

## What's already verified

- Implementation commit `40777d5`, release commit `9f3a1d8` and annotated tag `v0.18.0` are pushed.
- The version-bumped gate passed 120 Rust tests and 156 UI tests; two optional benchmarks are ignored.
- Production UI, universal native build, ad-hoc signing and matching bundled CLI passed.
- Signed DMG/archive/manifest/checksums were generated locally in `target/releases/v0.18.0`.
- Browser checks covered workflow creation/editing, discard safety, live appearance/reset/search
  and a 700×600 layout. Complete local bundles exchanged and rolled back in an isolated
  Applications directory. The real installed app was not replaced.

See `Ideation/Done.md` and `Ideation/Next steps.md` in the vault for milestone status.
