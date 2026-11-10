# Search index health and recovery

Notes remain the source of truth. A failed derived-index update never undoes or
fails a successful note write. Search may be incomplete until reconciliation.

`Workspace::index_health()` exposes `healthy`, `rebuilding`, or `degraded`, watcher
availability, and the latest diagnostic (`problem`, stable `error_code`, timestamp).
Diagnostics are local to the running workspace and omit paths, note contents and
raw OS messages. Repeated identical failures retain their timestamp.

The desktop monitor starts the watcher and scans the vault. Startup errors,
watcher errors/overflow, file refresh failures and failed scans invalidate index
freshness. It attempts reconciliation after 2, 4, and 8 seconds; after those three
retries it waits for **Rebuild search index** or a vault reconnect. Successful
recovery restores the automatic-retry budget for a later failure. Rebuild rereads
all files, including those whose modification time and size have not changed,
and removes absent entries. It does not reopen the vault or replace editor buffers.
Persistent database/storage failures remain degraded and are never reported as a
successful reindex.

The UI keeps a warning while degraded, clears it on recovery, and distinguishes a
failed scan from finished indexing. Existing progress and change notifications
remain available. This status covers the vault file watcher and search index;
planner and history database availability have their own boundaries.

## Cross-process freshness

The cache's `index.db.dirty` file is an atomic invalidation token. Each completed
scan remembers that token. The `index.db.watched` lease contains the scan's token,
so another process cannot reuse an old successful scan after an index failure.
A reader accepts freshness only when the tokens match and the heartbeat is recent.
If metadata cannot be read, freshness is unknown and readers perform their scan.
These files are disposable cache metadata, not vault content.

## Tests and integration

Core tests inject SQLite update failures, lost/overflowed watcher events, missing
roots, and errors during a scan; check durable note writes, cross-workspace leases,
recovery and full reindexing. Desktop tests check the retry schedule and manual
recovery following a failed watcher start. UI tests cover warning/rebuild behavior,
request serialization, stale-vault results and error reporting.

When combining with the vault-session change, retain its activation token on
`index-progress` and `vault-changed`, add it to `index-health`, and use its
cancellable scan inside the monitor. Keep the monitor's bounded recovery loop and
health/epoch validation around that scan. Neither a cancelled scan nor a failed
scan may mark the index current. The independent change already checks Workspace
identity before emitting callbacks and stops its monitor when replaced.
