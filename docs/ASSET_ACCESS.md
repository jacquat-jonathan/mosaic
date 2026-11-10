# Asset access lifetime

Mosaic serves local viewer resources through `mosaic-asset`, not Tauri's growing
filesystem allowlist. Each activation creates a random capability independent of
its public vault identity/generation. Native URL requests include the expected
generation; every protocol read checks the current capability. Switching vaults,
including reopening the same vault, replaces the capability and deletes that
activation's temporary HTML preview directory. Old URLs then return 403.

Allowed consumers are Markdown/canvas images, image and PDF viewers, HTML preview
resources (CSS, fonts, scripts, media and local data), and generated HTML previews.
URLs retain directory separators so relative resources resolve within the grant.
The main app and sandboxed previews have separate origins. HTML sandbox and CSP
remain in force; permission for external network resources remains separate.
Raw vault resources carry a restrictive document CSP and sandbox response header.
If a script-enabled preview navigates to raw HTML or SVG, it cannot shed the
preview policy to gain script or network access. Raw document navigation is inert;
interactive HTML is rendered only through the sanitized preview path, whose CSP
contains the separately approved permissions. Resource reads (CSS, images, PDF,
fonts and scripts) remain governed by the embedding preview's policy.

Capabilities stay in transient viewer URLs; they are never saved in app settings or logs.
URLs do not expose the absolute vault root.

Every successful and failed response is `no-store`, suppresses referrers, and
uses `nosniff`. GET and HEAD are supported; single byte ranges support PDF.js and
media. Invalid, unsatisfiable and multipart ranges return 416. Capability checking
and reads hold a shared guard: activation waits for already-authorized reads to
finish, then revokes the old grant. Bytes already rendered or copied into memory
cannot be recalled; revocation prevents subsequent reads.

On macOS, the vault root and each requested component are opened relative to
pinned directory descriptors with `O_NOFOLLOW`. This avoids canonicalize/open
symlink races. Traversal, empty components, backslashes, NULs, hidden components,
malformed encoding, non-regular files and all symbolic links are rejected. This
intentionally also rejects in-vault symlink assets; ordinary note operations keep
their existing symlink policy. A missing root at activation fails closed. An already-open root remains pinned to
the original directory if it is renamed; it never follows a replacement directory
or symlink at the former path. Other platforms
fail closed until equivalent handle-relative implementations are supplied.

A revocable protocol was chosen over webview recreation because recreation would
also replace editor state, subscriptions and dirty buffers, while still requiring
careful prevention of cached old loads. The protocol keeps the established UI
lifecycle and isolates authorization in one module (`assets.rs`). The built-in
asset protocol is disabled and has no allow grants. Preview files are content
addressed in a private temporary directory, never in the vault or persistent
cache. A process crash may leave OS temporary files; normal replacement/exit
removes the owned directory.

Tests cover A-to-B and same-root revocation, stale URL issuance, preview revocation,
PDF ranges/headers, encoded filenames, traversal and symlink replacement, and HTML
CSP/network permission behavior. Packaged WKWebView image/PDF/HTML resource reads
remain part of native smoke verification (architecture improvement 09).
