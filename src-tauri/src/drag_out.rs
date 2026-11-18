//! Dragging items from the file tree out to Finder or the desktop copies them there.
//!
//! The tree's HTML5 drag is already a native drag session in WKWebView: its pasteboard is
//! `NSPasteboardNameDrag` and the web view is the dragging source. Outside the app WebKit only
//! ever offers `NSDragOperationCopy` (`WebViewImpl::dragSourceOperationMask`: "context ==
//! NSDraggingContextOutsideApplication ... ? NSDragOperationCopy"), whatever the page's
//! `effectAllowed` says. So Finder can only copy, never move or trash, the vault's files.
//!
//! What Finder lacks is the files themselves: the pasteboard only has WebKit's data. When the drag
//! leaves the window the UI calls [`drag_out_attach`], which adds a `public.file-url` per item to
//! that pasteboard, keeping WebKit's own data. When it comes back, [`drag_out_detach`] restores
//! WebKit's data as it was, so the app's own drop targets see the drag they always saw. The UI
//! queues these calls in order and ends with [`drag_out_end`].
//!
//! A new drag starting replaces the pasteboard, which changes its `changeCount`: state left over
//! from an earlier drag is then never written back.
//!
//! Only macOS does anything; elsewhere the commands check their arguments and return.

use crate::{AppState, CmdResult};
use mosaic_core::Error;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_encode};
use std::path::Path;
use tauri::State;

#[cfg(any(target_os = "macos", test))]
/// One pasteboard item: its (type, data) pairs in the order they were written.
pub(crate) type Item = Vec<(String, Vec<u8>)>;

#[cfg(any(target_os = "macos", test))]
/// The pasteboard type Finder copies files from.
pub(crate) const FILE_URL_TYPE: &str = "public.file-url";

/// Everything but RFC 3986 unreserved characters and `/` is escaped in a file URL's path.
const URL_PATH: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// `file://` URL for an absolute path; a folder's ends in `/`, as `NSURL` writes it.
pub(crate) fn file_url(abs: &Path, is_dir: bool) -> String {
    let mut url = String::from("file://");
    url.extend(percent_encode(abs.as_os_str().as_encoded_bytes(), URL_PATH));
    if is_dir && !url.ends_with('/') {
        url.push('/');
    }
    url
}

/// File URLs for vault-relative paths, in order and without duplicates. Every path must exist in
/// the vault: anything that escapes it (`..`, symlinks out) or names the vault itself is refused.
pub(crate) fn file_urls(
    root: &Path,
    paths: &[String],
    resolve: impl Fn(&str) -> CmdResult<std::path::PathBuf>,
) -> CmdResult<Vec<String>> {
    let mut urls: Vec<String> = Vec::new();
    for path in paths {
        let abs = resolve(path)?;
        if abs == root || !abs.starts_with(root) {
            return Err(Error::InvalidPath(path.clone()));
        }
        let meta = std::fs::symlink_metadata(&abs).map_err(|_| Error::NotFound(path.clone()))?;
        let url = file_url(&abs, meta.is_dir());
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    Ok(urls)
}

#[cfg(any(target_os = "macos", test))]
/// The pasteboard's items with one file URL added per path: the first URLs go on WebKit's items
/// (whose own data stays, in its order), any others become items of their own. A file URL already
/// on an item is replaced, so attaching twice can't stack them.
pub(crate) fn with_file_urls(items: &[Item], urls: &[String]) -> Vec<Item> {
    let count = items.len().max(urls.len());
    (0..count)
        .map(|i| {
            let mut item: Item = items
                .get(i)
                .map(|pairs| {
                    pairs
                        .iter()
                        .filter(|(t, _)| t != FILE_URL_TYPE)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            if let Some(url) = urls.get(i) {
                item.push((FILE_URL_TYPE.to_owned(), url.as_bytes().to_vec()));
            }
            item
        })
        .filter(|item| !item.is_empty())
        .collect()
}

/// Adds the dragged items' files to the drag that just left the window.
#[tauri::command(async)]
#[specta::specta]
pub(crate) fn drag_out_attach(state: State<AppState>, paths: Vec<String>) -> CmdResult<()> {
    let ws = state.get()?;
    let urls = file_urls(ws.vault.root(), &paths, |p| ws.vault.resolve(p))?;
    if urls.is_empty() {
        return Ok(());
    }
    platform::attach(&urls);
    Ok(())
}

/// Restores WebKit's drag data as the drag comes back into the window. `false` when the drag
/// pasteboard now belongs to another drag (this one ended without the UI hearing of it).
#[tauri::command(async)]
#[specta::specta]
pub(crate) fn drag_out_detach() -> bool {
    platform::detach()
}

/// The tree drag ended: forgets the saved data without touching the pasteboard, which Finder may
/// still be reading.
#[tauri::command(async)]
#[specta::specta]
pub(crate) fn drag_out_end() {
    platform::end();
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Item, with_file_urls};
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardNameDrag, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSInteger, NSString};
    use std::sync::Mutex;

    /// WebKit's own data, saved while the files are attached, and the pasteboard's `changeCount`
    /// once they were.
    struct Attached {
        saved: Vec<Item>,
        change_count: NSInteger,
    }

    static ATTACHED: Mutex<Option<Attached>> = Mutex::new(None);

    fn drag_pasteboard() -> Retained<NSPasteboard> {
        // SAFETY: an AppKit constant, valid for the whole process.
        NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag })
    }

    /// Every item's types and data, in order. A type whose data can't be read is left out.
    fn read(pb: &NSPasteboard) -> Vec<Item> {
        let Some(items) = pb.pasteboardItems() else {
            return Vec::new();
        };
        items
            .iter()
            .map(|item| {
                item.types()
                    .iter()
                    .filter_map(|ty| Some((ty.to_string(), item.dataForType(&ty)?.to_vec())))
                    .collect()
            })
            .collect()
    }

    fn write(pb: &NSPasteboard, items: &[Item]) {
        pb.clearContents();
        let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = items
            .iter()
            .map(|pairs| {
                let item = NSPasteboardItem::new();
                for (ty, data) in pairs {
                    item.setData_forType(&NSData::with_bytes(data), &NSString::from_str(ty));
                }
                ProtocolObject::from_retained(item)
            })
            .collect();
        pb.writeObjects(&NSArray::from_retained_slice(&objects));
    }

    fn lock() -> std::sync::MutexGuard<'static, Option<Attached>> {
        ATTACHED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn attach(urls: &[String]) {
        autoreleasepool(|_| {
            let pb = drag_pasteboard();
            let mut attached = lock();
            let saved = match attached.take() {
                // Still this drag's pasteboard, already with files: refresh them over WebKit's data.
                Some(a) if a.change_count == pb.changeCount() => a.saved,
                _ => read(&pb),
            };
            write(&pb, &with_file_urls(&saved, urls));
            *attached = Some(Attached {
                saved,
                change_count: pb.changeCount(),
            });
        });
    }

    pub(super) fn detach() -> bool {
        autoreleasepool(|_| {
            let Some(a) = lock().take() else { return true };
            let pb = drag_pasteboard();
            if pb.changeCount() != a.change_count {
                return false;
            }
            write(&pb, &a.saved);
            true
        })
    }

    pub(super) fn end() {
        lock().take();
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub(super) fn attach(_urls: &[String]) {}
    pub(super) fn detach() -> bool {
        true
    }
    pub(super) fn end() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn item(pairs: &[(&str, &str)]) -> Item {
        pairs
            .iter()
            .map(|(t, d)| (t.to_string(), d.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn file_urls_escape_the_path_and_mark_folders() {
        assert_eq!(
            file_url(Path::new("/Users/me/Vault/a b.md"), false),
            "file:///Users/me/Vault/a%20b.md"
        );
        assert_eq!(file_url(Path::new("/V/Notes"), true), "file:///V/Notes/");
        assert_eq!(file_url(Path::new("/V/Notes/"), true), "file:///V/Notes/");
        assert_eq!(
            file_url(Path::new("/V/#1 50%?.md"), false),
            "file:///V/%231%2050%25%3F.md"
        );
        assert_eq!(
            file_url(Path::new("/V/Café ü.md"), false),
            "file:///V/Caf%C3%A9%20%C3%BC.md"
        );
    }

    #[test]
    fn file_urls_resolve_vault_items_and_refuse_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("Notes")).unwrap();
        std::fs::write(root.join("Notes/a.md"), "a").unwrap();
        let vault = mosaic_core::Vault::open(&root).unwrap();
        let resolve = |p: &str| -> CmdResult<PathBuf> { vault.resolve(p) };
        let paths = |ps: &[&str]| ps.iter().map(|p| p.to_string()).collect::<Vec<_>>();

        let urls = file_urls(
            &root,
            &paths(&["Notes/a.md", "Notes", "Notes/a.md"]),
            resolve,
        )
        .unwrap();
        assert_eq!(
            urls,
            [
                file_url(&root.join("Notes/a.md"), false),
                file_url(&root.join("Notes"), true)
            ]
        );
        assert!(file_urls(&root, &paths(&["../outside.md"]), resolve).is_err());
        assert!(file_urls(&root, &paths(&["Notes/missing.md"]), resolve).is_err());
        assert!(file_urls(&root, &paths(&[""]), resolve).is_err());
    }

    #[test]
    fn file_urls_go_on_webkits_items_and_keep_its_data_in_order() {
        let webkit = vec![item(&[
            ("com.apple.WebKit.custom-pasteboard-data", "x"),
            ("public.utf8-plain-text", "[[a]]"),
        ])];
        let urls = vec!["file:///V/a.md".to_owned(), "file:///V/b/".to_owned()];
        assert_eq!(
            with_file_urls(&webkit, &urls),
            vec![
                item(&[
                    ("com.apple.WebKit.custom-pasteboard-data", "x"),
                    ("public.utf8-plain-text", "[[a]]"),
                    (FILE_URL_TYPE, "file:///V/a.md"),
                ]),
                item(&[(FILE_URL_TYPE, "file:///V/b/")]),
            ]
        );
    }

    #[test]
    fn attaching_again_replaces_the_file_urls() {
        let webkit = vec![item(&[("public.utf8-plain-text", "t")])];
        let once = with_file_urls(&webkit, &["file:///V/a.md".to_owned()]);
        assert_eq!(
            with_file_urls(&once, &["file:///V/b.md".to_owned()]),
            with_file_urls(&webkit, &["file:///V/b.md".to_owned()])
        );
        assert_eq!(with_file_urls(&webkit, &[]), webkit);
        assert!(with_file_urls(&[], &[]).is_empty());
    }
}
