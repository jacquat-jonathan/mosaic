use crate::CmdResult;
use mosaic_core::Error;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_DOCUMENT_BYTES: usize = 20 * 1024 * 1024;

fn write_document(dir: &Path, html: &str) -> CmdResult<PathBuf> {
    if html.len() > MAX_DOCUMENT_BYTES {
        return Err(Error::Invalid("HTML preview is larger than 20 MiB".into()));
    }
    fs::create_dir_all(dir).map_err(|source| Error::Io {
        path: dir.display().to_string(),
        source,
    })?;
    let hash = Sha256::digest(html.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = dir.join(format!("{hash}.html"));
    if !path.exists() {
        fs::write(&path, html).map_err(|source| Error::Io {
            path: path.display().to_string(),
            source,
        })?;
    }
    Ok(path)
}

/// Publishes a sanitized preview on the asset origin. Unlike `srcdoc`, this gives WebKit a real,
/// app-distinct origin on which scripts and sibling vault resources can run inside the sandbox.
#[tauri::command(async)]
#[specta::specta]
pub(crate) fn html_preview_document(app: AppHandle, html: String) -> CmdResult<String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| Error::Invalid(format!("HTML preview cache unavailable: {error}")))?
        .join("html-preview");
    let path = write_document(&dir, &html)?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|error| Error::Invalid(format!("HTML preview cache unavailable: {error}")))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_are_content_addressed_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = write_document(dir.path(), "<h1>one</h1>").unwrap();
        let again = write_document(dir.path(), "<h1>one</h1>").unwrap();
        let other = write_document(dir.path(), "<h1>two</h1>").unwrap();
        assert_eq!(first, again);
        assert_ne!(first, other);
        assert_eq!(fs::read_to_string(first).unwrap(), "<h1>one</h1>");
    }

    #[test]
    fn oversized_documents_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let error = write_document(dir.path(), &"x".repeat(MAX_DOCUMENT_BYTES + 1)).unwrap_err();
        assert!(error.to_string().contains("larger than 20 MiB"));
    }
}
