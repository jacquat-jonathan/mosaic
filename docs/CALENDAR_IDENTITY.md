# Calendar subscription identity

Calendar subscription metadata now uses the vault ID in `.mosaic/vault.json`, as history and rules do. Subscription IDs, Keychain account references, and cache filenames remain unchanged; migration never reads or copies calendar URLs.

## Move, copy and recovery behavior

- A move or rename keeps the ID and subscriptions. The identity file retains previous locations for delayed migrations, even when history or another service confirms the move first.
- A copy while the original still exists receives a fresh ID and an empty calendar collection. Previous-location migration history is cleared. Subscriptions must be explicitly added to the copy; mutable metadata and credentials are not shared implicitly.
- A vault without an identity receives one through the existing identity mechanism. Its current path can claim an unclaimed legacy record once. A later replacement vault at an already claimed path gets an empty collection.
- A damaged or unreadable identity produces an error, without replacing it or falling back to path-based calendar writes. An alias resolving to the same canonical root uses the same identity.
- If the original no longer exists, existing identity semantics treat the remaining folder as a move, not a copy. Losing/removing the identity file does not automatically reclaim subscriptions assigned to its former ID.

## Migration transaction

The calendar store keeps `vaults` as immutable legacy rollback data, `vault_ids` as the active collections, and `migrated_paths` as one-time ownership claims. The settings cross-process lock covers reading, candidate comparison, claiming, and persistence. Current and recorded previous paths are considered together; unequal legacy records fail the entire transaction with a generic conflict error. No record is merged automatically. Resolve the conflicting legacy records in a backed-up settings file before retrying.

An empty active collection is a completed migration marker. Removing the last subscription therefore cannot resurrect legacy entries. Repeated reads do not rewrite settings once migrated. A failed write leaves migration retryable; previous locations remain in the identity file. Legacy metadata is retained for inspection/rollback, but running an older app after migration is not synchronized with the new active collection. In particular, deleted/replaced Keychain credentials are not recoverable merely by rolling back metadata.

Moves completed by older versions before this location history existed cannot always be inferred. If neither the current path nor a recorded previous location matches legacy metadata, Mosaic starts an empty active collection rather than guessing another vault's ownership.

## Remaining path-keyed state

| State | Current behavior |
| --- | --- |
| Recent/last vault in `Settings` | Paths are locators for opening folders, not durable calendar identity. |
| UI workspace layouts in `ui/src/state/workspace.ts` | Remain keyed by root; layouts may reset after a move. Separate future migration. |
| Legacy rules, bookmarks and Tessera settings | Compatibility records remain path-keyed; active `VaultState` files are already keyed by vault ID. |
| Search/index cache | Root-based derived state is disposable and rebuildable. |
| Open documents and in-flight file operations | Root remains an explicit operation destination; replacing it with an ID would not resolve filesystem access. |

The recorded previous paths are local identity metadata, not secrets, but they can reveal former folder names when sharing a vault. They contain no calendar URLs or Keychain values.
