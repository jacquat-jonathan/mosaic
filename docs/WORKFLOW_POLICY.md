# Workflow ownership

`mosaic-core::workflow` owns run-cause labels and requests, schedule eligibility, event queue and
chain suppression, retry decisions, transcript aggregation, and the completed-run transition. It
has no dependency on Tauri, a process executable, filesystem storage, or network access.

`src-tauri/src/tessera.rs` owns the desktop lifecycle, watcher-origin bookkeeping, running-agent
reservation mutex, Claude discovery/launch and stream collection, and Tauri notifications. It
implements the small `RunHost` effect boundary: persist an attempt, run a process, publish a
transcript, and wait. Core orchestration invokes those effects in that order; tests supply a fake
host. Wall/monotonic time is passed to schedule/queue/completion decisions explicitly. No generic
service container or framework is required.

`VaultState::update_tessera` remains the persistence boundary introduced by atomic-state work.
The adapter applies `CompletedRun` only to the matching run inside that transaction. It never
replaces a previously read ledger. A failed process can retry at most twice, with one- and
two-second delays, only for transient errors before any successful write or review proposal.

Queue behavior remains unchanged: paused or busy jobs stay queued, the oldest eligible job runs,
a host reservation race puts the job back at the front, chain depth and a 20-run ceiling suppress
loops, and repeated agent/event/path entries are suppressed for 30 minutes after chain activity.
The 100-job cap also consumes the rejected event's deduplication key, matching existing behavior.
Manual and test invocations continue to bypass automatic pause/queue policy.

Run `cargo test -p mosaic-core workflow` for deterministic policy fixtures: no AppHandle, Claude,
network, or real waits. Desktop tests retain adapter-specific rename/origin behavior and generated
IPC freshness. Command names, serialized status fields, and `tessera-changed` events are unchanged.
Calendar Keychain/network adapters and workflow stream transport remain desktop-owned; further
extraction should follow a concrete test need instead of moving platform effects into core.
