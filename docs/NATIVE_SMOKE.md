# Packaged desktop smoke verification

Run `pnpm install --frozen-lockfile` then `bash scripts/native-smoke.sh` on a Mac with a graphical login session. The script builds the production frontend, retains file-size measurements, and packages a debug app with the real WKWebView, production frontend assets, real command router and bundled CLI. It never installs into Applications. `--skip-build` reruns an existing smoke bundle.

The `native-smoke` Cargo feature and `VITE_NATIVE_SMOKE=1` build flag are test-only. The smoke bundle has a separate identifier (`dev.jona.mosaic.native-smoke`); it refuses startup without a marked temporary fixture and isolated settings/cache roots. Ordinary builds contain no smoke command routes or reachable smoke frontend code. Never distribute this bundle or enable the feature in the release workflow. Release signing/build separation remains unchanged.

The journey opens a temporary vault through native IPC, uses the editor store to save a note, starts the bundled CLI as an MCP server, observes an MCP-only marker path through the filesystem watcher (so a delayed editor-save event cannot satisfy the check), rejects a stale-hash write, creates a planner task, loads the actual image viewer and verifies a 206/eight-byte PDF range response in WKWebView, then restarts the bundle and verifies persisted note/planner content. This is a native integration journey, not synthetic keyboard/mouse coverage. Browser tests remain responsible for interaction details.

`target/native-smoke` retains phase reports, native stdout/stderr, runner/architecture information, build logs and frontend sizes. Window-only screenshots are attempted using the smoke process ID; missing Screen Recording permission or blank captures are recorded explicitly in environment.json. The harness never captures other windows or the desktop. Viewer checks use bounded waits and stage reports; no detached image decode promise can leave a phase waiting indefinitely. Failure reports are uploaded even when the process times out. The runner terminates only its own launched process and removes only its own temporary fixture.

Updater tests use fixture Ed25519 keys to reject unsigned/modified/wrong-key manifests, and execute the exact production install-helper script with a disposable Applications tree. A deliberately refused launch exercises the real atomic exchange and rollback, leaving the original fixture app and note untouched. No network release, production signing key, live application, or actual LaunchServices registration is involved in these updater fixtures.

## Platform and integration matrix

| Boundary | Automated lane | Remaining manual check |
| --- | --- | --- |
| Apple Silicon, macOS 15 | Packaged debug native IPC journey and update fixtures | Release-optimized universal bundle and normal first-launch approval |
| Intel | Not established by ARM runner | Run smoke script on Intel; test universal release launch |
| macOS 12 minimum | Not established by macOS 15 runner | Run on supported Intel/Apple Silicon macOS 12 devices |
| Screenshot capture | Window-only capture attempted | Grant recording permission if host refuses; inspect diagnostics |
| Planner corruption/recovery (02) | Adapter fixtures in PR 02 | Run native failure/recovery journey after 02 integration |
| Session asset revocation (03/06) | Protocol/security fixtures in PR 06 | Extend native journey to old-URL rejection and HTML relative assets after integration |

The asset journey calls the application `fileUrl` helper rather than hardcoding a protocol, so it exercises the session protocol when merged with 06. The integrated baseline offers partial planner availability, covered by adapter tests; the native corruption/recovery cases still require the scenarios in the matrix. Session/asset revocation is not yet in this main baseline, so this branch does not claim those later integrations pass. Add their native scenarios when composing the branches. CLI/MCP and ordinary UI coverage continue independently.

## Local reference validation

On Apple Silicon macOS 26.5.2, the packaged first-launch and restart reports passed, including the real MCP/watcher conflict and PDF viewer. Signature fixtures and failed-launch rollback passed; the complete 551-test UI suite and strict Clippy with the smoke feature passed. Window captures were black on this host, so they are retained as diagnostics and are **not** claimed as visual verification. Run on an unlocked graphical host for useful screenshots.
