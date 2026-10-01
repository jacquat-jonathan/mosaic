//! File-level access to a vault folder. Every path crossing this boundary is vault-relative,
//! `/`-separated and validated; nothing outside the root (or inside hidden folders such as
//! `.obsidian/`) can be read or written.

use crate::error::{Error, Result};
use crate::kind::FileKind;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub kind: Option<FileKind>,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub mtime: u64,
    pub hash: String,
    /// `None` for binary kinds (images, PDF, unknown).
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Written {
    pub path: String,
    pub hash: String,
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Validates a vault-relative path and returns it in canonical `a/b/c.md` form ("" is the root).
pub fn normalize(rel: &str) -> Result<String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.starts_with('/') {
        return Err(Error::InvalidPath(format!(
            "{rel} (must be relative to the vault)"
        )));
    }
    let mut parts = Vec::new();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(Error::InvalidPath(format!("{rel} (.. is not allowed)"))),
            p if p.starts_with('.') => {
                return Err(Error::InvalidPath(format!(
                    "{rel} (hidden paths are not part of the vault)"
                )));
            }
            p => parts.push(p),
        }
    }
    Ok(parts.join("/"))
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

impl Vault {
    /// Creates `<parent>/<name>` as a new, empty vault folder and opens it. The folder must not exist.
    pub fn create_new(parent: impl AsRef<Path>, name: &str) -> Result<Self> {
        let name = name.trim();
        if name.is_empty() || name.contains('/') || name.starts_with('.') {
            return Err(Error::InvalidPath(format!("invalid vault name: {name:?}")));
        }
        let parent = parent.as_ref();
        if !parent.is_dir() {
            return Err(Error::NotFound(parent.display().to_string()));
        }
        let root = parent.join(name);
        fs::create_dir(&root).map_err(|e| Error::io(root.display().to_string(), e))?;
        Self::open(root)
    }

    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let shown = root.as_ref().display().to_string();
        let root = fs::canonicalize(root.as_ref()).map_err(|e| Error::io(&shown, e))?;
        if !root.is_dir() {
            return Err(Error::InvalidPath(format!("{shown} is not a folder")));
        }
        Ok(Vault { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Absolute path for a vault-relative one, refusing anything that escapes the root
    /// (including through symlinks).
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let norm = normalize(rel)?;
        let abs = self.root.join(&norm);
        // Canonicalize the deepest existing ancestor: catches symlinks pointing outside.
        let mut probe = abs.as_path();
        loop {
            if let Ok(real) = fs::canonicalize(probe) {
                if !real.starts_with(&self.root) {
                    return Err(Error::InvalidPath(format!(
                        "{norm} (resolves outside the vault)"
                    )));
                }
                break;
            }
            match probe.parent() {
                Some(p) => probe = p,
                None => break,
            }
        }
        Ok(abs)
    }

    /// Vault-relative form of an absolute path inside the root, if it is part of the vault.
    pub fn relative(&self, abs: &Path) -> Option<String> {
        let rel = abs.strip_prefix(&self.root).ok()?;
        let mut parts = Vec::new();
        for c in rel.components() {
            match c {
                Component::Normal(s) => {
                    let s = s.to_str()?;
                    if is_hidden(s) {
                        return None;
                    }
                    parts.push(s);
                }
                _ => return None,
            }
        }
        Some(parts.join("/"))
    }

    fn entry(&self, rel: String, abs: &Path) -> Option<Entry> {
        let meta = fs::metadata(abs).ok()?; // follows symlinks
        if fs::symlink_metadata(abs).ok()?.file_type().is_symlink() {
            let real = fs::canonicalize(abs).ok()?;
            if !real.starts_with(&self.root) {
                return None;
            }
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        Some(Entry {
            kind: (!meta.is_dir()).then(|| FileKind::of(abs)),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: mtime_ms(&meta),
            name,
            path: rel,
        })
    }

    /// Lists a folder: folders first, then files, each sorted case-insensitively.
    pub fn list(&self, dir: &str, recursive: bool) -> Result<Vec<Entry>> {
        let norm = normalize(dir)?;
        let abs = self.resolve(&norm)?;
        let mut out = Vec::new();
        self.list_into(&norm, &abs, recursive, &mut out, 0)?;
        Ok(out)
    }

    fn list_into(
        &self,
        rel: &str,
        abs: &Path,
        recursive: bool,
        out: &mut Vec<Entry>,
        depth: usize,
    ) -> Result<()> {
        let rd = fs::read_dir(abs).map_err(|e| Error::io(rel, e))?;
        let mut entries: Vec<Entry> = rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                if is_hidden(&name) {
                    return None;
                }
                let child_rel = if rel.is_empty() {
                    name
                } else {
                    format!("{rel}/{name}")
                };
                self.entry(child_rel, &e.path())
            })
            .collect();
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        for e in entries {
            let recurse = recursive && e.is_dir && depth < 64;
            let child_rel = e.path.clone();
            out.push(e);
            if recurse {
                let child_abs = self.root.join(&child_rel);
                self.list_into(&child_rel, &child_abs, true, out, depth + 1)?;
            }
        }
        Ok(())
    }

    pub fn stat(&self, rel: &str) -> Result<Entry> {
        let norm = normalize(rel)?;
        let abs = self.resolve(&norm)?;
        self.entry(norm.clone(), &abs).ok_or(Error::NotFound(norm))
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.resolve(rel).map(|p| p.exists()).unwrap_or(false)
    }

    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        let norm = normalize(rel)?;
        let abs = self.resolve(&norm)?;
        if abs.is_dir() {
            return Err(Error::Invalid(format!("{norm} is a folder")));
        }
        fs::read(&abs).map_err(|e| Error::io(norm, e))
    }

    pub fn read(&self, rel: &str) -> Result<FileContent> {
        let norm = normalize(rel)?;
        let bytes = self.read_bytes(&norm)?;
        let abs = self.resolve(&norm)?;
        let meta = fs::metadata(&abs).map_err(|e| Error::io(&norm, e))?;
        let kind = FileKind::of(&abs);
        let content = if kind.is_text() {
            Some(String::from_utf8(bytes.clone()).map_err(|_| Error::NotText(norm.clone()))?)
        } else {
            None
        };
        Ok(FileContent {
            hash: hash_bytes(&bytes),
            size: meta.len(),
            mtime: mtime_ms(&meta),
            path: norm,
            kind,
            content,
        })
    }

    /// Current content hash, or `None` when the file doesn't exist.
    pub fn hash_of(&self, rel: &str) -> Result<Option<String>> {
        match self.read_bytes(rel) {
            Ok(b) => Ok(Some(hash_bytes(&b))),
            Err(Error::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn require_text_kind(norm: &str) -> Result<()> {
        if FileKind::of(Path::new(norm)).is_text() {
            Ok(())
        } else {
            Err(Error::NotText(norm.to_string()))
        }
    }

    /// Writes via a temp file in the same folder plus rename, so readers never see a half-written file.
    fn atomic_write(&self, norm: &str, abs: &Path, bytes: &[u8], no_clobber: bool) -> Result<()> {
        let dir = abs
            .parent()
            .ok_or_else(|| Error::InvalidPath(norm.to_string()))?;
        fs::create_dir_all(dir).map_err(|e| Error::io(norm, e))?;
        let mut tmp = tempfile::Builder::new()
            .prefix(".mosaic-")
            .suffix(".tmp")
            .tempfile_in(dir)
            .map_err(|e| Error::io(norm, e))?;
        tmp.write_all(bytes).map_err(|e| Error::io(norm, e))?;
        tmp.as_file().sync_all().map_err(|e| Error::io(norm, e))?;
        if let Ok(meta) = fs::metadata(abs) {
            let _ = fs::set_permissions(tmp.path(), meta.permissions());
        }
        let res = if no_clobber {
            tmp.persist_noclobber(abs).map(|_| ())
        } else {
            tmp.persist(abs).map(|_| ())
        };
        res.map_err(|e| Error::io(norm, e.error))
    }

    /// Creates a new file; fails if it already exists.
    pub fn create(&self, rel: &str, content: &str) -> Result<Written> {
        let norm = normalize(rel)?;
        if norm.is_empty() {
            return Err(Error::InvalidPath("empty path".into()));
        }
        Self::require_text_kind(&norm)?;
        let abs = self.resolve(&norm)?;
        if abs.exists() {
            return Err(Error::AlreadyExists(norm));
        }
        self.atomic_write(&norm, &abs, content.as_bytes(), true)?;
        Ok(Written {
            hash: hash_bytes(content.as_bytes()),
            path: norm,
        })
    }

    /// Creates a file from raw bytes, of any kind (e.g. an image dropped from Finder). Never overwrites.
    pub fn create_bytes(&self, rel: &str, bytes: &[u8]) -> Result<Written> {
        let norm = normalize(rel)?;
        if norm.is_empty() {
            return Err(Error::InvalidPath("empty path".into()));
        }
        let abs = self.resolve(&norm)?;
        if abs.exists() {
            return Err(Error::AlreadyExists(norm));
        }
        self.atomic_write(&norm, &abs, bytes, true)?;
        Ok(Written {
            hash: hash_bytes(bytes),
            path: norm,
        })
    }

    /// Replaces a file's content (creating it if missing). With `expected_hash`, refuses to
    /// overwrite a file that changed since it was read.
    pub fn write(&self, rel: &str, content: &str, expected_hash: Option<&str>) -> Result<Written> {
        let norm = normalize(rel)?;
        if norm.is_empty() {
            return Err(Error::InvalidPath("empty path".into()));
        }
        Self::require_text_kind(&norm)?;
        let abs = self.resolve(&norm)?;
        if abs.is_dir() {
            return Err(Error::Invalid(format!("{norm} is a folder")));
        }
        if let Some(expected) = expected_hash {
            let current = self
                .hash_of(&norm)?
                .ok_or_else(|| Error::NotFound(norm.clone()))?;
            if current != expected {
                return Err(Error::Conflict {
                    path: norm,
                    current_hash: current,
                });
            }
        }
        self.atomic_write(&norm, &abs, content.as_bytes(), false)?;
        Ok(Written {
            hash: hash_bytes(content.as_bytes()),
            path: norm,
        })
    }

    /// Appends text, starting on a new line if the file doesn't end with one. Creates the file if missing.
    pub fn append(&self, rel: &str, content: &str) -> Result<Written> {
        let norm = normalize(rel)?;
        let current = match self.read(&norm) {
            Ok(f) => f.content.unwrap_or_default(),
            Err(Error::NotFound(_)) => String::new(),
            Err(e) => return Err(e),
        };
        let mut next = current;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(content);
        self.write(&norm, &next, None)
    }

    /// Replaces exactly one occurrence of `find`.
    pub fn patch(
        &self,
        rel: &str,
        find: &str,
        replace: &str,
        expected_hash: Option<&str>,
    ) -> Result<Written> {
        let norm = normalize(rel)?;
        let file = self.read(&norm)?;
        let text = file.content.ok_or_else(|| Error::NotText(norm.clone()))?;
        if let Some(expected) = expected_hash
            && expected != file.hash
        {
            return Err(Error::Conflict {
                path: norm,
                current_hash: file.hash,
            });
        }
        if find.is_empty() {
            return Err(Error::Invalid("find text is empty".into()));
        }
        match text.matches(find).count() {
            1 => self.write(&norm, &text.replacen(find, replace, 1), Some(&file.hash)),
            0 => Err(Error::Invalid(format!(
                "text to replace not found in {norm}"
            ))),
            n => Err(Error::Invalid(format!(
                "text to replace occurs {n} times in {norm}; include more context so it is unique"
            ))),
        }
    }

    pub fn mkdir(&self, rel: &str) -> Result<()> {
        let norm = normalize(rel)?;
        let abs = self.resolve(&norm)?;
        if abs.is_file() {
            return Err(Error::AlreadyExists(norm));
        }
        fs::create_dir_all(&abs).map_err(|e| Error::io(norm, e))
    }

    /// Moves or renames a file or folder. The target must not exist.
    pub fn rename(&self, from: &str, to: &str) -> Result<String> {
        let from_n = normalize(from)?;
        let to_n = normalize(to)?;
        if from_n.is_empty() || to_n.is_empty() {
            return Err(Error::InvalidPath("cannot rename the vault root".into()));
        }
        if to_n == from_n || to_n.starts_with(&format!("{from_n}/")) {
            return Err(Error::InvalidPath(format!(
                "cannot move {from_n} into itself"
            )));
        }
        let src = self.resolve(&from_n)?;
        let dst = self.resolve(&to_n)?;
        if !src.exists() {
            return Err(Error::NotFound(from_n));
        }
        // Allow case-only renames on case-insensitive volumes.
        let case_only = from_n.to_lowercase() == to_n.to_lowercase();
        if dst.exists() && !case_only {
            return Err(Error::AlreadyExists(to_n));
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io(&to_n, e))?;
        }
        fs::rename(&src, &dst).map_err(|e| Error::io(&from_n, e))?;
        Ok(to_n)
    }

    /// Copies a file (text or binary) to a new path; fails if the target exists. Folders aren't copied.
    pub fn copy(&self, from: &str, to: &str) -> Result<Written> {
        let from_n = normalize(from)?;
        let to_n = normalize(to)?;
        if to_n.is_empty() {
            return Err(Error::InvalidPath("empty path".into()));
        }
        let bytes = self.read_bytes(&from_n)?;
        let dst = self.resolve(&to_n)?;
        if dst.exists() {
            return Err(Error::AlreadyExists(to_n));
        }
        self.atomic_write(&to_n, &dst, &bytes, true)?;
        Ok(Written {
            hash: hash_bytes(&bytes),
            path: to_n,
        })
    }

    /// Moves a file or folder to the macOS Trash (never deletes permanently).
    pub fn delete(&self, rel: &str) -> Result<()> {
        let norm = normalize(rel)?;
        if norm.is_empty() {
            return Err(Error::InvalidPath("cannot delete the vault root".into()));
        }
        let abs = self.resolve(&norm)?;
        if fs::symlink_metadata(&abs).is_err() {
            return Err(Error::NotFound(norm));
        }
        trash::delete(&abs).map_err(|e| Error::Io {
            path: norm,
            source: std::io::Error::other(e.to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    #[test]
    fn normalize_rules() {
        assert_eq!(normalize("a//b/./c.md").unwrap(), "a/b/c.md");
        assert_eq!(normalize("").unwrap(), "");
        assert!(normalize("../x").is_err());
        assert!(normalize("/etc/passwd").is_err());
        assert!(normalize(".obsidian/app.json").is_err());
        assert!(normalize("a/.git/config").is_err());
    }

    #[test]
    fn create_read_write_roundtrip() {
        let (_d, v) = vault();
        let w = v.create("notes/a.md", "# A\n").unwrap();
        assert_eq!(w.path, "notes/a.md");
        assert!(matches!(
            v.create("notes/a.md", "x"),
            Err(Error::AlreadyExists(_))
        ));
        let f = v.read("notes/a.md").unwrap();
        assert_eq!(f.content.as_deref(), Some("# A\n"));
        assert_eq!(f.hash, w.hash);
        let w2 = v.write("notes/a.md", "# B\n", Some(&w.hash)).unwrap();
        assert!(matches!(
            v.write("notes/a.md", "# C\n", Some(&w.hash)),
            Err(Error::Conflict { .. })
        ));
        assert_eq!(v.read("notes/a.md").unwrap().hash, w2.hash);
    }

    #[test]
    fn copy_files_but_never_overwrite() {
        let (_d, v) = vault();
        v.create("a.md", "# A\n").unwrap();
        let w = v.copy("a.md", "sub/a 1.md").unwrap();
        assert_eq!(v.read("sub/a 1.md").unwrap().hash, w.hash);
        assert!(matches!(
            v.copy("a.md", "sub/a 1.md"),
            Err(Error::AlreadyExists(_))
        ));
        assert!(matches!(
            v.copy("missing.md", "b.md"),
            Err(Error::NotFound(_))
        ));
        assert!(v.copy("sub", "sub2").is_err());
        assert!(v.copy("a.md", "../out.md").is_err());
    }

    #[test]
    fn create_new_vault_folder() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::create_new(dir.path(), "Notes").unwrap();
        assert!(v.root().ends_with("Notes"));
        assert!(matches!(
            Vault::create_new(dir.path(), "Notes"),
            Err(Error::AlreadyExists(_))
        ));
        assert!(Vault::create_new(dir.path(), "a/b").is_err());
        assert!(Vault::create_new(dir.path(), ".hidden").is_err());
        assert!(Vault::create_new(dir.path(), "  ").is_err());
    }

    #[test]
    fn append_and_patch() {
        let (_d, v) = vault();
        v.append("log.md", "one").unwrap();
        v.append("log.md", "two\n").unwrap();
        assert_eq!(v.read("log.md").unwrap().content.unwrap(), "one\ntwo\n");
        v.patch("log.md", "two", "2", None).unwrap();
        assert_eq!(v.read("log.md").unwrap().content.unwrap(), "one\n2\n");
        assert!(v.patch("log.md", "zzz", "y", None).is_err());
        v.write("dup.md", "a a", None).unwrap();
        assert!(v.patch("dup.md", "a", "b", None).is_err());
    }

    #[test]
    fn binary_and_non_utf8() {
        let (d, v) = vault();
        fs::write(d.path().join("img.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
        let f = v.read("img.png").unwrap();
        assert!(f.content.is_none());
        assert!(matches!(
            v.write("img.png", "x", None),
            Err(Error::NotText(_))
        ));
        fs::write(d.path().join("bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(v.read("bad.md"), Err(Error::NotText(_))));
    }

    #[test]
    fn list_hides_dotfiles_and_sorts() {
        let (d, v) = vault();
        fs::create_dir_all(d.path().join(".obsidian")).unwrap();
        fs::write(d.path().join(".obsidian/app.json"), "{}").unwrap();
        fs::write(d.path().join(".DS_Store"), "").unwrap();
        v.create("b.md", "").unwrap();
        v.create("A.md", "").unwrap();
        v.create("z/inner.md", "").unwrap();
        let top: Vec<_> = v
            .list("", false)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert_eq!(top, vec!["z", "A.md", "b.md"]);
        let all: Vec<_> = v
            .list("", true)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert_eq!(all, vec!["z", "z/inner.md", "A.md", "b.md"]);
    }

    #[test]
    fn symlink_escape_is_refused() {
        let (d, v) = vault();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).unwrap();
        assert!(matches!(
            v.read("link/secret.md"),
            Err(Error::InvalidPath(_))
        ));
        assert!(v.list("", false).unwrap().iter().all(|e| e.path != "link"));
    }

    #[test]
    fn rename_and_mkdir() {
        let (_d, v) = vault();
        v.create("a.md", "x").unwrap();
        v.create("b.md", "y").unwrap();
        assert!(matches!(
            v.rename("a.md", "b.md"),
            Err(Error::AlreadyExists(_))
        ));
        v.rename("a.md", "sub/c.md").unwrap();
        assert!(v.exists("sub/c.md") && !v.exists("a.md"));
        assert!(v.rename("sub", "sub/deeper").is_err());
        v.rename("b.md", "B.md").unwrap();
        v.mkdir("x/y").unwrap();
        assert!(v.stat("x/y").unwrap().is_dir);
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let (d, v) = vault();
        v.write("a.md", "one", None).unwrap();
        v.write("a.md", "two", None).unwrap();
        let names: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1);
    }
}
