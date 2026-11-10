# Behavioral contracts

`fixtures/contract.json` is executable specification shared by the Rust core and browser mock.
Every scenario runs against a new temporary vault/history database in Rust and an empty, reset
mock in TypeScript. Sample browser notes, planner IDs, proposals, versions, preferences, and
previous scenarios cannot satisfy a later assertion.

## Fixture format

A scenario supplies `files`, optional agent `rules`, and ordered `steps`. Commands use Tauri wire
names and camelCase outer arguments. Domain input objects retain their generated snake_case fields.

- `expect` recursively matches selected fields; arrays must have exactly the expected length.
- `result` matches the entire returned value; `error` requires the stable error code.
- `save: name` captures an immutable successful result. `$saved.name.field` and `$last.field`
  resolve recursively in objects and arrays, with numeric array indices supported.
- `$proposal` identifies the last `agent_proposes` result. Missing references fail the runner.
- Failed operations preserve `$last`; fixtures then assert that data was not changed.
- `actor: agent` exercises source-specific read/write rules. The mock helper deliberately rejects
  other agent commands; it is not an alternate agent backend. UI commands retain person privileges.
- `external_directory` replaces an already-indexed file with a directory in Rust. The mock marks
  that indexed record unreadable. This deterministic fault represents partial rename/link failure;
  it does not pretend to exercise OS permissions or filesystem watching.

Add a scenario and corresponding command support to **both** runners in the same change. Never
skip an unknown command or infer success from a missing field. Use fixed timestamps where date
formatting matters and avoid comparing nondeterministic IDs/times across implementations.

## Coverage matrix

| Boundary | Shared/core/mock coverage | Tauri adapter coverage | Native boundary |
| --- | --- | --- | --- |
| File writes | Current hash, conflict preserves data, duplicate create | Generated handler dispatch, camelCase `expectedHash`, serialized error/current hash | Packaged editing/restart smoke |
| Rename | Link rewrite, old path absent, partial failure retains completed move | Error shape covered by common serialization | OS permissions and crash recovery remain core integration tests |
| Review | Accept/reject, conflict, explicit force, repeated decision | Ordinary command routing uses generated handler | Cross-process history notifications require native smoke |
| Planner | Nested stale revision, completion guard, reopen/archive/trash/restore, visibility | Actual `PlannerChanged` through Tauri emitter | Real planner command/event journey belongs to packaged smoke |
| Templates | Preview hash conflict, no file created on conflict, refreshed create | Nested request dispatched through real generated handlers | UI selection remains browser coverage |
| Source rules | Hidden read, read-only write, person override | Not forced through a UI command that deliberately runs as person | CLI/MCP permission tests remain authoritative |
| Query | Nested tags, negation, AND filtering, zero limit, empty result | `query_notes` registered in test dispatcher | Broader query parser properties remain core tests |
| Import | Binary/null text content, collision suffix, invalid traversal | Raw bytes, percent-encoded Unicode header, malformed/missing headers, JSON-body rejection, exact stored bytes | Finder drag/drop remains native/manual |
| Events | Shared `fixtures/events.json` verifies actual mock history/vault/planner emissions | Actual progress/changes/planner structs serialized through Tauri emitter | Transport ordering/lifecycle and WKWebView belong to native smoke/session regressions |

The corpus currently has 14 scenarios. It is risk-focused, not a claim of complete command coverage.
Index progress is not simulated by the in-memory mock; its fixture also typechecks against the UI
consumer. Session/health envelope changes must update `events.json` and both sides' assertions.

## Layers and commands

```sh
cargo test -p mosaic-core --test contract
cargo test -p mosaic-app contract_tests
pnpm --dir ui exec vitest run src/ipc/contract.test.ts src/ipc/events.contract.test.ts
cargo test -p mosaic-app bindings_are_current
```

`src-tauri/src/contract_tests.rs` uses Tauri's test runtime to dispatch the **production generated
command handlers** with `InvokeRequest`, and validates real serialized responses. It does not call
the core dispatcher used by `contract.rs`. Event tests use the real Tauri emitter and listeners.
The test runtime avoids starting a macOS webview; these tests prove argument routing and wire shape,
not the installed WKWebView, asset protocol, watcher timing, or bundle contents. The packaged desktop
smoke lane (architecture improvement 09) covers that distinct boundary.

The `tauri/test` feature is enabled only as a development dependency. These tests introduce no new
production command or alternate IPC endpoint. Existing generated-binding freshness remains required.
