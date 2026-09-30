//! User settings shared by the app and the CLI (e.g. the last opened vault), stored outside any vault in
//! `~/Library/Application Support/dev.jona.mosaic/settings.json`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const APP_ID: &str = "dev.jona.mosaic";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub last_vault: Option<PathBuf>,
    pub recent_vaults: Vec<PathBuf>,
    /// Bookmarked vault-relative paths, per vault root. Kept here so the vault holds only user content.
    pub bookmarks: BTreeMap<PathBuf, Vec<String>>,
}

pub fn app_support_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(APP_ID),
    )
}

/// Where search indexes live. `MOSAIC_CACHE_DIR` overrides it (used by tests).
pub fn cache_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MOSAIC_CACHE_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Caches/mosaic"))
}

impl Settings {
    pub fn load() -> Self {
        app_support_dir()
            .and_then(|d| std::fs::read(d.join("settings.json")).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let dir = app_support_dir().ok_or_else(|| std::io::Error::other("HOME not set"))?;
        std::fs::create_dir_all(&dir)?;
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(dir.join("settings.json"), json)
    }

    /// Records a vault as the most recently opened one.
    pub fn remember_vault(&mut self, root: PathBuf) {
        self.recent_vaults.retain(|p| p != &root);
        self.recent_vaults.insert(0, root.clone());
        self.recent_vaults.truncate(10);
        self.last_vault = Some(root);
    }

    /// Drops a vault from the recent list (its folder is left untouched).
    pub fn forget_vault(&mut self, root: &Path) {
        self.recent_vaults.retain(|p| p != root);
        if self.last_vault.as_deref() == Some(root) {
            self.last_vault = None;
        }
    }

    pub fn bookmarks(&self, root: &Path) -> Vec<String> {
        self.bookmarks.get(root).cloned().unwrap_or_default()
    }

    /// Replaces a vault's bookmarks, keeping their order and dropping duplicates.
    pub fn set_bookmarks(&mut self, root: &Path, paths: Vec<String>) {
        let mut seen = std::collections::HashSet::new();
        let paths: Vec<String> = paths
            .into_iter()
            .filter(|p| seen.insert(p.clone()))
            .collect();
        if paths.is_empty() {
            self.bookmarks.remove(root);
        } else {
            self.bookmarks.insert(root.to_path_buf(), paths);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_vaults_are_ordered_capped_and_forgettable() {
        let mut s = Settings::default();
        for i in 0..12 {
            s.remember_vault(PathBuf::from(format!("/v{i}")));
        }
        s.remember_vault(PathBuf::from("/v5"));
        assert_eq!(s.recent_vaults.len(), 10);
        assert_eq!(s.recent_vaults[0], PathBuf::from("/v5"));
        assert_eq!(
            s.recent_vaults
                .iter()
                .filter(|p| p.as_path() == Path::new("/v5"))
                .count(),
            1
        );
        s.forget_vault(Path::new("/v5"));
        assert!(!s.recent_vaults.contains(&PathBuf::from("/v5")));
        assert_eq!(s.last_vault, None);
    }

    #[test]
    fn bookmarks_are_per_vault_and_deduplicated() {
        let mut s = Settings::default();
        let a = Path::new("/a");
        s.set_bookmarks(a, vec!["x.md".into(), "y.md".into(), "x.md".into()]);
        assert_eq!(s.bookmarks(a), vec!["x.md", "y.md"]);
        assert!(s.bookmarks(Path::new("/b")).is_empty());
        s.set_bookmarks(a, vec![]);
        assert!(!s.bookmarks.contains_key(a));
    }
}
