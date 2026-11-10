//! Revocable asset access, separate from public vault-session identity.
use crate::{AppState, CmdResult};
use mosaic_core::Error;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::RwLock;
use tauri::State;
use tauri::http::{Request, Response, StatusCode};

#[derive(Default)]
pub(crate) struct AssetState(RwLock<Option<ActiveAssets>>);

struct ActiveAssets {
    generation: String,
    capability: String,
    root: File,
    previews: tempfile::TempDir,
}

impl AssetState {
    /// Replacing the guard revokes all previous URLs, including same-root reactivation.
    /// A failure leaves assets unavailable rather than retaining the old grant.
    pub(crate) fn activate(&self, root: &Path, generation: &str) {
        let next = (|| -> std::io::Result<ActiveAssets> {
            Ok(ActiveAssets {
                generation: generation.into(),
                capability: uuid::Uuid::new_v4().simple().to_string(),
                root: open_root(root)?,
                previews: tempfile::Builder::new()
                    .prefix("mosaic-preview-")
                    .tempdir()?,
            })
        })()
        .ok();
        *self.0.write().expect("asset lock poisoned") = next;
    }

    fn with_active<T>(
        &self,
        generation: &str,
        f: impl FnOnce(&ActiveAssets) -> CmdResult<T>,
    ) -> CmdResult<T> {
        let guard = self.0.read().expect("asset lock poisoned");
        let active = guard
            .as_ref()
            .filter(|a| a.generation == generation)
            .ok_or_else(|| Error::Invalid("Asset session is no longer active".into()))?;
        f(active)
    }

    fn file_path(&self, path: &str, generation: &str) -> CmdResult<String> {
        validate_path(path).map_err(|_| Error::InvalidPath(path.into()))?;
        self.with_active(generation, |active| {
            // Check now for useful viewer feedback; every actual read checks again.
            open_beneath(&active.root, path).map_err(|_| {
                Error::InvalidPath("Asset is unavailable or uses a symbolic link".into())
            })?;
            Ok(format!("{}/vault/{path}", active.capability))
        })
    }

    pub(crate) fn preview_path(&self, html: &str, generation: &str) -> CmdResult<String> {
        self.with_active(generation, |active| {
            let path = crate::html_preview::write_document(active.previews.path(), html)?;
            Ok(format!(
                "{}/preview/{}",
                active.capability,
                path.file_name().unwrap().to_string_lossy()
            ))
        })
    }

    pub(crate) fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        // Hold the grant through the read. Activation waits for in-flight reads to finish, then
        // no request can use the old capability. No-store prevents a later HTTP-cache bypass.
        let guard = self.0.read().expect("asset lock poisoned");
        let Some(active) = guard.as_ref() else {
            return response(StatusCode::FORBIDDEN, Vec::new());
        };
        match serve(active, &request) {
            Ok(result) => result,
            Err(status) => response(status, Vec::new()),
        }
    }
}

#[tauri::command(async)]
#[specta::specta]
pub(crate) fn asset_path(
    state: State<AppState>,
    path: String,
    generation: String,
) -> CmdResult<String> {
    state.assets.file_path(&path, &generation)
}

fn response(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("Pragma", "no-cache")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        // Images/PDF fetches and sandboxed HTML use app-distinct origins. Authorization is the
        // unguessable capability, not Origin; never accept credentials on this protocol.
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges",
        )
        .body(body)
        .expect("constant response headers")
}

fn validate_path(path: &str) -> Result<(), StatusCode> {
    if path.is_empty()
        || path.contains(['\\', '\0'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

/// Anchor the canonical vault root without following a swapped symlink in any ancestor.
#[cfg(unix)]
fn open_root(root: &Path) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    if !root.is_absolute() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut dir = File::open("/")?;
    for part in root.components() {
        let part = match part {
            std::path::Component::RootDir => continue,
            std::path::Component::Normal(part) => part,
            _ => return Err(std::io::ErrorKind::InvalidInput.into()),
        };
        let name = std::ffi::CString::new(part.as_bytes())
            .map_err(|_| std::io::ErrorKind::InvalidInput)?;
        // SAFETY: live directory descriptor and NUL-terminated component; own each returned fd once.
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        dir = unsafe { File::from_raw_fd(fd) };
    }
    Ok(dir)
}

#[cfg(not(unix))]
fn open_root(_root: &Path) -> std::io::Result<File> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// Open every component relative to an already-open directory, refusing symlinks at every step.
/// Unlike canonicalize-then-open this cannot race a directory swap into an external symlink.
#[cfg(unix)]
fn open_beneath(root: &File, path: &str) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    validate_path(path).map_err(|_| std::io::Error::from(std::io::ErrorKind::PermissionDenied))?;
    let mut dir = root.try_clone()?;
    let parts: Vec<_> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        let name = std::ffi::CString::new(*part).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
        if index + 1 < parts.len() {
            flags |= libc::O_DIRECTORY;
        }
        // SAFETY: dir and CString live through openat; the successful owned fd is wrapped once.
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        dir = unsafe { File::from_raw_fd(fd) };
    }
    if !dir.metadata()?.is_file() {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(dir)
}

#[cfg(not(unix))]
fn open_beneath(_root: &File, _path: &str) -> std::io::Result<File> {
    // Mosaic ships on macOS. Fail closed until a handle-relative Windows implementation exists.
    Err(std::io::ErrorKind::Unsupported.into())
}

fn decoded_path(encoded: &str) -> Result<String, StatusCode> {
    let bytes = encoded.as_bytes();
    for (i, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
        {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| StatusCode::BAD_REQUEST)
}

fn serve(
    active: &ActiveAssets,
    request: &Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, StatusCode> {
    if request.method() != "GET" && request.method() != "HEAD" {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let decoded = decoded_path(request.uri().path())?;
    let mut parts = decoded.trim_start_matches('/').splitn(3, '/');
    if parts.next() != Some(active.capability.as_str()) {
        return Err(StatusCode::FORBIDDEN);
    }
    let kind = parts.next().ok_or(StatusCode::FORBIDDEN)?;
    let path = parts.next().ok_or(StatusCode::FORBIDDEN)?;
    validate_path(path)?;
    let root = match kind {
        "vault" => active.root.try_clone(),
        "preview" if !path.contains('/') => File::open(active.previews.path()),
        _ => return Err(StatusCode::FORBIDDEN),
    }
    .map_err(|_| StatusCode::FORBIDDEN)?;
    let mut file = open_beneath(&root, path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::FORBIDDEN
        }
    })?;
    let len = file
        .metadata()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .len();
    let mut magic = vec![0; len.min(8192) as usize];
    file.read_exact(&mut magic)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mime = tauri::utils::mime_type::MimeType::parse(&magic, path);
    let mut range_headers = request.headers().get_all("range").iter();
    let range = range_headers.next().map(|h| {
        // Repeated headers represent multiple ranges just like a comma-separated value.
        if range_headers.next().is_some() {
            return None;
        }
        h.to_str().ok().and_then(|s| byte_range(s, len))
    });
    if range == Some(None) {
        let mut out = response(StatusCode::RANGE_NOT_SATISFIABLE, Vec::new());
        out.headers_mut()
            .insert("Content-Range", format!("bytes */{len}").parse().unwrap());
        return Ok(out);
    }
    let (start, count) = range.flatten().unwrap_or((0, len));
    let mut body = Vec::new();
    if request.method() != "HEAD" {
        file.seek(SeekFrom::Start(start))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        file.take(count)
            .read_to_end(&mut body)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if body.len() as u64 != count {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
    }
    let mut out = response(
        if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        body,
    );
    let headers = out.headers_mut();
    if kind == "vault" {
        // A script-enabled preview can navigate its own frame to a raw HTML/SVG asset.
        // Do not let that discard the preview's network/script policy. This policy applies
        // when the response becomes a document; image/PDF/CSS/script subresource consumers
        // retain the embedding document's policy. Executable HTML goes through /preview/
        // with the separately constructed, permission-specific CSP.
        headers.insert(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data: mosaic-asset: http://mosaic-asset.localhost; media-src mosaic-asset: http://mosaic-asset.localhost; font-src data: mosaic-asset: http://mosaic-asset.localhost; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox"
                .parse()
                .unwrap(),
        );
    }
    headers.insert(
        "Content-Type",
        mime.parse()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    headers.insert("Content-Length", count.to_string().parse().unwrap());
    headers.insert("Accept-Ranges", "bytes".parse().unwrap());
    if range.is_some() {
        headers.insert(
            "Content-Range",
            format!("bytes {start}-{}/{len}", start + count - 1)
                .parse()
                .unwrap(),
        );
    }
    Ok(out)
}

/// Single ranges suffice for PDF.js/media. Reject multipart rather than returning an incorrect body.
fn byte_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if len == 0
        || !start.bytes().all(|b| b.is_ascii_digit())
        || !end.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    if start.is_empty() {
        let count = end.parse::<u64>().ok()?.min(len);
        return (count > 0).then_some((len - count, count));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().ok()?.min(len - 1)
    };
    if start >= len || end < start {
        return None;
    }
    Some((start, end - start + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn request(path: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().uri(format!("mosaic-asset://localhost/{path}"));
        if let Some(range) = range {
            builder = builder.header("Range", range);
        }
        builder.body(Vec::new()).unwrap()
    }

    #[test]
    fn switching_and_reopening_revoke_assets_and_previews() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fs::write(a.path().join("image.svg"), "<svg>A</svg>").unwrap();
        fs::write(b.path().join("image.svg"), "<svg>B</svg>").unwrap();
        let state = AssetState::default();
        state.activate(&a.path().canonicalize().unwrap(), "1");
        let old = state.file_path("image.svg", "1").unwrap();
        let preview = state.preview_path("<h1>A</h1>", "1").unwrap();
        assert_eq!(state.respond(request(&old, None)).body(), b"<svg>A</svg>");
        assert_eq!(state.respond(request(&preview, None)).status(), 200);
        state.activate(&b.path().canonicalize().unwrap(), "2");
        assert_eq!(state.respond(request(&old, None)).status(), 403);
        assert_eq!(state.respond(request(&preview, None)).status(), 403);
        assert!(state.file_path("image.svg", "1").is_err());
        assert!(state.preview_path("stale", "1").is_err());
        let new = state.file_path("image.svg", "2").unwrap();
        assert_eq!(state.respond(request(&new, None)).body(), b"<svg>B</svg>");
        state.activate(&b.path().canonicalize().unwrap(), "3");
        assert_eq!(state.respond(request(&new, None)).status(), 403);
        assert_ne!(new, state.file_path("image.svg", "3").unwrap());
    }

    #[test]
    fn ranges_head_encoding_and_content_headers() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("space # %.pdf"), b"%PDF-123456789").unwrap();
        let state = AssetState::default();
        state.activate(&dir.path().canonicalize().unwrap(), "1");
        let path = state
            .file_path("space # %.pdf", "1")
            .unwrap()
            .replace(' ', "%20")
            .replace('#', "%23")
            .replace("%.pdf", "%25.pdf");
        let whole = state.respond(request(&path, None));
        assert_eq!(whole.status(), 200);
        assert_eq!(whole.headers()["Content-Type"], "application/pdf");
        assert_eq!(whole.headers()["Cache-Control"], "no-store");
        assert_eq!(whole.headers()["Referrer-Policy"], "no-referrer");
        let part = state.respond(request(&path, Some("bytes=5-8")));
        assert_eq!(part.status(), 206);
        assert_eq!(part.body(), b"1234");
        assert_eq!(part.headers()["Content-Range"], "bytes 5-8/14");
        assert_eq!(
            state.respond(request(&path, Some("bytes=-3"))).body(),
            b"789"
        );
        assert_eq!(
            state.respond(request(&path, Some("bytes=11-"))).body(),
            b"789"
        );
        for range in [
            "bytes=99-",
            "bytes=5-2",
            "bytes=0-1,3-4",
            "bytes=-0",
            "bytes=a-b",
        ] {
            let out = state.respond(request(&path, Some(range)));
            assert_eq!(out.status(), 416, "{range}");
            assert_eq!(out.headers()["Content-Range"], "bytes */14");
        }
        let mut head = request(&path, None);
        *head.method_mut() = tauri::http::Method::HEAD;
        let out = state.respond(head);
        assert!(out.body().is_empty());
        assert_eq!(out.headers()["Content-Length"], "14");
        let mut post = request(&path, None);
        *post.method_mut() = tauri::http::Method::POST;
        assert_eq!(state.respond(post).status(), 405);
    }

    #[test]
    fn raw_document_navigation_cannot_discard_preview_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let html = "<script>fetch('https://unapproved.example/')</script>";
        fs::write(dir.path().join("page.html"), html).unwrap();
        fs::write(
            dir.path().join("image.svg"),
            "<svg><script>fetch('https://unapproved.example/')</script></svg>",
        )
        .unwrap();
        // The policy is independent of MIME/extension, including a misnamed document.
        fs::write(dir.path().join("disguised.txt"), html).unwrap();
        let state = AssetState::default();
        state.activate(&dir.path().canonicalize().unwrap(), "1");
        for name in ["page.html", "image.svg", "disguised.txt"] {
            let path = state.file_path(name, "1").unwrap();
            for range in [None, Some("bytes=0-9")] {
                let response = state.respond(request(&path, range));
                let csp = response.headers()["Content-Security-Policy"]
                    .to_str()
                    .unwrap();
                assert!(csp.contains("script-src 'none'"));
                assert!(csp.contains("connect-src 'none'"));
                assert!(csp.ends_with("sandbox"));
                assert!(!csp.contains("https:"));
            }
        }
        let preview = state.preview_path("<meta http-equiv=Content-Security-Policy content=\"script-src data:; connect-src https://approved.example\">", "1").unwrap();
        let response = state.respond(request(&preview, None));
        assert!(!response.headers().contains_key("Content-Security-Policy"));
        assert!(String::from_utf8_lossy(response.body()).contains("https://approved.example"));
    }

    #[test]
    fn empty_files_overflow_and_repeated_ranges_fail_safely() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("empty.pdf"), []).unwrap();
        fs::write(dir.path().join("data.pdf"), b"%PDF-1234").unwrap();
        let state = AssetState::default();
        state.activate(&dir.path().canonicalize().unwrap(), "1");
        let empty = state.file_path("empty.pdf", "1").unwrap();
        let out = state.respond(request(&empty, None));
        assert_eq!(out.status(), 200);
        assert_eq!(out.headers()["Content-Length"], "0");
        assert_eq!(
            state.respond(request(&empty, Some("bytes=0-"))).status(),
            416
        );
        let path = state.file_path("data.pdf", "1").unwrap();
        for range in [
            "bytes=+0-1",
            "bytes=0-+1",
            "bytes=-+1",
            "bytes=-",
            "bytes=18446744073709551616-",
        ] {
            assert_eq!(
                state.respond(request(&path, Some(range))).status(),
                416,
                "{range}"
            );
        }
        let mut repeated = request(&path, Some("bytes=0-1"));
        repeated
            .headers_mut()
            .append("Range", "bytes=2-3".parse().unwrap());
        assert_eq!(state.respond(repeated).status(), 416);
    }

    #[test]
    fn activation_waits_for_authorized_reads_then_removes_old_previews() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = Arc::new(AssetState::default());
        state.activate(&root, "1");
        let old = state.preview_path("<p>old</p>", "1").unwrap();
        let grant = state.0.read().unwrap();
        let preview_dir = grant.as_ref().unwrap().previews.path().to_owned();
        let barrier = Arc::new(Barrier::new(2));
        let worker = {
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                state.activate(&root, "2");
            })
        };
        barrier.wait();
        // A response already authorized under this grant may finish; replacement cannot
        // destroy its preview while that read guard remains held.
        assert_eq!(
            serve(grant.as_ref().unwrap(), &request(&old, None))
                .unwrap()
                .status(),
            200
        );
        assert!(preview_dir.exists());
        drop(grant);
        worker.join().unwrap();
        assert!(!preview_dir.exists());
        assert_eq!(state.respond(request(&old, None)).status(), 403);
    }

    #[test]
    fn traversal_private_paths_malformed_encoding_and_symlinks_are_refused() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "private").unwrap();
        fs::write(dir.path().join("ok.txt"), "ok").unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested/a.css"), "body{}").unwrap();
        symlink(outside.path(), dir.path().join("escape")).unwrap();
        symlink(dir.path().join("ok.txt"), dir.path().join("internal.txt")).unwrap();
        let state = AssetState::default();
        state.activate(&dir.path().canonicalize().unwrap(), "1");
        let prefix = state
            .file_path("ok.txt", "1")
            .unwrap()
            .trim_end_matches("ok.txt")
            .to_owned();
        for path in [
            "../secret.txt",
            "%2e%2e/secret.txt",
            "nested/%2e%2e/ok.txt",
            "escape/secret.txt",
            "internal.txt",
            ".mosaic/vault.json",
            "nested%5c..%5cok.txt",
            "%00",
            "nested//a.css",
        ] {
            assert_eq!(
                state
                    .respond(request(&format!("{prefix}{path}"), None))
                    .status(),
                403,
                "{path}"
            );
        }
        for path in ["%", "%0", "%GG", "%FF"] {
            assert_eq!(
                state
                    .respond(request(&format!("{prefix}{path}"), None))
                    .status(),
                400
            );
        }
        let nested = format!("{prefix}nested/a.css");
        assert_eq!(state.respond(request(&nested, None)).status(), 200);
        // Directory replacement after URL creation cannot escape the pinned root.
        fs::remove_file(dir.path().join("nested/a.css")).unwrap();
        fs::remove_dir(dir.path().join("nested")).unwrap();
        symlink(outside.path(), dir.path().join("nested")).unwrap();
        assert_eq!(state.respond(request(&nested, None)).status(), 403);
    }

    #[test]
    fn failed_activation_revokes_previous_grant() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        let state = AssetState::default();
        state.activate(&dir.path().canonicalize().unwrap(), "1");
        let old = state.file_path("a.txt", "1").unwrap();
        state.activate(&dir.path().join("missing"), "2");
        assert_eq!(state.respond(request(&old, None)).status(), 403);
    }
}
