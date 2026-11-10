# Portable backup and recovery

`mosaic backup` creates an **unencrypted directory bundle**, verifies it, and restores into a
**new location only**. It does not merge into or overwrite an existing vault. This is a manual,
bounded recovery flow, not a scheduled backup/retention service. No release or Keychain key is needed.

```sh
mosaic --vault /path/to/vault backup create /backup/Mosaic-2026-11-09
mosaic backup restore /backup/Mosaic-2026-11-09 /path/to/recovered-vault
# Inspect the dry-run report first. Explicitly apply to create the new vault:
mosaic backup restore /backup/Mosaic-2026-11-09 /path/to/recovered-vault --apply
```

The bundle destination's parent must already exist, and the bundle must be outside the source vault.
The restore destination's parent must exist too. `--json` returns the manifest or preview as JSON.
A restore preview verifies every declared file's checksum and database integrity and reports existing
filesystem destinations as conflicts. Apply checks again. Never open the destination until apply
returns successfully. Keep an untouched backup until you have inspected the recovered vault.

## Choose private state explicitly

Add `--include-private-state` to **both** create and restore to preserve private history/settings:

```sh
mosaic --vault /path/to/vault backup create /backup/full --include-private-state
mosaic backup restore /backup/full /path/to/recovered --apply --include-private-state
```

This can include deleted note versions, proposals, private workflow answers/transcripts, bookmarks,
and agents' access rules. The flag is not encryption. Store the bundle on encrypted storage with
appropriate access controls, or encrypt it using your normal backup tooling before transferring it.
Mosaic does not export passwords, feed URLs, or Keychain references. Notes/history themselves can
contain secrets written by their author; there is no content redaction. Bundles initially have a
private staging-directory mode; preserve that protection when copying them elsewhere.

| Persistence | Default bundle | With private state | Restore behavior |
| --- | --- | --- | --- |
| Notes, attachments, vault folders and hidden content such as `.obsidian` | Included | Included | New vault content |
| `.mosaic/planner.sqlite3` | Consistent SQLite backup snapshot | Same | Integrity checked; supported older schemas migrate in staging |
| Undo history and proposals (`history.db`) | Excluded | SQLite backup snapshot | New vault's independent history |
| Agent rules, bookmarks, scheduler state/transcripts | Excluded | Known per-vault JSON files | Restored under fresh identity; workflows paused, unfinished runs marked interrupted |
| Vault preferences and template configuration | Excluded | Only this vault's entries | Installed for destination without changing source/global settings |
| Calendar subscriptions | Count/reconnection notice only | Same | Re-add subscriptions explicitly; credentials and feed URLs excluded |
| Search indexes, calendar caches, SQLite journal/SHM files | Excluded | Excluded | Derived index rebuilt in memory during validation and rebuilt normally on open |
| Source vault ID, old planner migration backup, unknown `.mosaic` files, Git metadata | Excluded | Excluded | Fresh identity, no accidental history sharing |
| Global app settings, recent-vault list, UI layout, installed agents/tools | Excluded | Excluded | Keep destination machine settings |

Absent Application Support state produces a warning, not invented history. Legacy external state
that has never been migrated into the per-vault identity location is not silently imported by backup;
open it with Mosaic first if that state is needed. Moving the original vault preserves its identity;
restoring always behaves as a **copy**, even when the original no longer exists.

## Consistency and recovery limits

Each SQLite database uses SQLite's backup API, including committed WAL data. Busy snapshots have a
30-second deadline. Notes, planner, history and settings are not one cross-store transaction: pause
editing, agents and external writers for a common recovery point. Symlink assets, non-UTF-8/backslash filenames, nonportable case-colliding paths and special files
are refused rather than followed outside the chosen vault. Empty content folders are currently not
represented in the manifest and are not recreated unless they contain a file.

A bundle has a versioned `manifest.json`, Mosaic version, privacy selection, planner schema, file
sizes and SHA-256 hashes. Unknown formats, newer planner schemas, traversal paths, symlinks, duplicate
entries, missing files and checksum mismatches are rejected. Bundle reads pin no-follow file descriptors; database validation uses only checksummed main-file bytes in private staging, never undeclared WAL sidecars. Checksums detect corruption, not the
identity of a backup's author: restore only bundles you trust. There is no automatic execution of
restored workflows; resume them explicitly after reviewing their agents and access rules.

Restore first validates and copies into private sibling staging directories, migrates the staged
planner and rebuilds its derived index. Publication refuses even an empty destination created during
the operation. Failure before publication leaves no destination. Ordinary later failures roll back
newly created vault/state; originals and the bundle remain untouched. A process/machine crash can
leave `.mosaic-restore-*` or `.restore-*` staging directories, or a new vault/state after publication
but before the final settings write. Do not treat an interrupted command as a successful restore;
inspect that new destination and restore again into another new location. Mosaic never deletes an
existing destination to retry. App metadata and the vault are on potentially different filesystems,
so final publication is not a single filesystem transaction across both stores.

## Restore drill

After a successful restore, open the recovered vault, read several notes and attachments, verify
planner tasks, inspect selected undo history and bookmarks, and run a search. Reconnect calendars.
Compare original files before removing any old data. Tests exercise a live planner/history snapshot,
notes, opt-in settings, independent identity, index rebuild, dry-run, older/newer schemas, corruption,
missing support, refused existing destinations and failures without modifying originals. Retention
and in-place recovery are deliberately outside this first version.
