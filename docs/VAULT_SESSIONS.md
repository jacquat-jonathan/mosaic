# Vault activation boundaries

Every desktop activation has a `VaultSession`: the persistent `.mosaic/vault.json`
identity (when available), canonical root, and a process-local generation encoded
as a string. Reopening the same root allocates a new generation. A vault with an
unreadable identity still opens notes; its root and generation isolate that session.
The desktop stores the workspace and token together under one lock.

`index-progress`, `vault-changed`, `history-changed`, and `planner-changed` carry
the producing activation's token. The UI filters them before invoking subscribers.
Watcher callbacks retain their original token, and callbacks that schedule workflow
work check that their workspace is still active. Obsolete index scans stop between
batches without marking the index synchronized; another activation can reconcile it.

Settings and update notifications are app-wide. Workflow notifications are app-wide
invalidations (background runs can finish after switching vaults), not workspace
payloads; their consumers refetch the active vault and guard the result. Chat stream
messages are routed by run ID. These events must not directly apply vault data.

UI activation requests are serialized through native activation and complete UI
restoration, so a later failed open leaves both sides on the last successful vault. Async store work captures the activation object through
`vaultOperation`, then checks it after awaits before applying results or launching
follow-up work. Root equality alone is insufficient: A → B → A and same-root
reconnects must discard old results. Workspace saves retain their captured root and
expected hash; reconnects preserve dirty buffers while invalidating old acknowledgements.

The browser mock emits the same session fields as the native host. Legacy test
fixtures without a token are accepted only while their active fixture has no token.
New event fixtures should always include one.

Regression tests cover stale file/history/planner events, refresh and proposal reads,
same-root reconnect and saves, generation changes, and cancellation/resumption of
background indexing. Index cancellation is cooperative between batches; the initial
filesystem walk and an in-progress batch are allowed to finish.

Session identity is not a secret or an authorization capability. Asset access must
validate a separate revocable capability and canonical paths; these event tokens
alone must never grant filesystem access.
