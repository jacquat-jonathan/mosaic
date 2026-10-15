//! A vault's identity, kept in the vault as `.mosaic/vault.json`, so data Mosaic keeps outside the
//! vault (its undo history and pending proposals) follows the folder when it's moved or renamed.
//!
//! The file also records where the vault was when the id was last confirmed. If the vault is
//! somewhere else now, it was either moved (the old place is gone, or holds another vault): it
//! keeps its id; or copied (the old place still holds a vault with this id): the copy gets a new
//! id, so the two never share a history.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE: &str = ".mosaic/vault.json";

#[derive(Serialize, Deserialize)]
struct Stored {
    id: String,
    /// The vault folder when the id was last confirmed.
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VaultIdentity {
    pub id: String,
    /// Where the vault was before, when it was moved since it was last opened.
    pub moved_from: Option<PathBuf>,
}

fn read(root: &Path) -> Result<Option<Stored>> {
    let path = root.join(FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| {
            Error::Invalid(format!(
                "{FILE} can't be read ({e}); fix or remove it to start a new undo history"
            ))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::io(path.display().to_string(), e)),
    }
}

/// Writes the file. With `first`, only if there's none yet: when two processes open a new vault
/// at once, one id wins and both use it.
fn write(root: &Path, id: &str, first: bool) -> Result<()> {
    let path = root.join(FILE);
    let dir = path.parent().expect("a folder");
    std::fs::create_dir_all(dir).map_err(|e| Error::io(dir.display().to_string(), e))?;
    let json = serde_json::to_vec_pretty(&Stored {
        id: id.to_string(),
        root: root.to_path_buf(),
    })
    .map_err(|e| Error::Invalid(e.to_string()))?;
    // Written whole, then renamed: a half-written file would orphan the history.
    let tmp = dir.join(format!(".vault.json.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, json).map_err(|e| Error::io(tmp.display().to_string(), e))?;
    let done = if first {
        // A hard link fails if the file exists, unlike a rename.
        match std::fs::hard_link(&tmp, &path) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            other => other,
        }
    } else {
        std::fs::rename(&tmp, &path)
    };
    let _ = std::fs::remove_file(&tmp);
    done.map_err(|e| Error::io(path.display().to_string(), e))
}

/// The id of the vault at `root` (canonical), creating it on first use. Never overwrites a file it
/// can't parse: that is reported, so the history isn't silently replaced.
pub fn identify(root: &Path) -> Result<VaultIdentity> {
    let Some(stored) = read(root)? else {
        write(root, &uuid::Uuid::new_v4().to_string(), true)?;
        let id = read(root)?
            .ok_or_else(|| Error::Invalid(format!("{FILE} disappeared")))?
            .id;
        return Ok(VaultIdentity {
            id,
            moved_from: None,
        });
    };
    if stored.root == root {
        return Ok(VaultIdentity {
            id: stored.id,
            moved_from: None,
        });
    }
    let original_still_there = std::fs::canonicalize(&stored.root)
        .ok()
        .filter(|old| old != root)
        .and_then(|old| read(&old).ok().flatten())
        .is_some_and(|other| other.id == stored.id);
    if original_still_there {
        let id = uuid::Uuid::new_v4().to_string();
        write(root, &id, false)?;
        Ok(VaultIdentity {
            id,
            moved_from: None,
        })
    } else {
        write(root, &stored.id, false)?;
        Ok(VaultIdentity {
            id: stored.id,
            moved_from: Some(stored.root),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(parent: &Path, name: &str) -> PathBuf {
        let p = parent.join(name);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(p).unwrap()
    }

    #[test]
    fn an_id_is_kept_across_opens_and_moves_and_a_copy_gets_its_own() {
        let d = tempfile::tempdir().unwrap();
        let a = folder(d.path(), "A");
        let first = identify(&a).unwrap();
        assert_eq!(identify(&a).unwrap(), first);

        // Copied (Finder duplicate): the original is still there with the same id.
        let copy = folder(d.path(), "A copy");
        std::fs::create_dir_all(copy.join(".mosaic")).unwrap();
        std::fs::copy(a.join(FILE), copy.join(FILE)).unwrap();
        let copied = identify(&copy).unwrap();
        assert_ne!(copied.id, first.id);
        assert_eq!(identify(&copy).unwrap().id, copied.id);
        assert_eq!(identify(&a).unwrap().id, first.id);

        // Moved: the original place is gone.
        let moved = d.path().join("B");
        std::fs::rename(&a, &moved).unwrap();
        let moved = std::fs::canonicalize(moved).unwrap();
        let after = identify(&moved).unwrap();
        assert_eq!(after.id, first.id);
        assert_eq!(after.moved_from.as_deref(), Some(a.as_path()));
        assert_eq!(identify(&moved).unwrap().moved_from, None);
    }

    #[test]
    fn processes_opening_a_new_vault_at_once_agree_on_its_id() {
        let d = tempfile::tempdir().unwrap();
        let a = folder(d.path(), "A");
        let ids: Vec<String> = (0..8)
            .map(|_| {
                let a = a.clone();
                std::thread::spawn(move || identify(&a).unwrap().id)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]), "{ids:?}");
    }

    #[test]
    fn a_damaged_file_is_reported_not_replaced() {
        let d = tempfile::tempdir().unwrap();
        let a = folder(d.path(), "A");
        std::fs::create_dir_all(a.join(".mosaic")).unwrap();
        std::fs::write(a.join(FILE), "{ half").unwrap();
        assert!(identify(&a).is_err());
        assert_eq!(std::fs::read_to_string(a.join(FILE)).unwrap(), "{ half");
    }
}
