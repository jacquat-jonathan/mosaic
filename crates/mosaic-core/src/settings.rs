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
    /// The Mosaic source checkout that Settings › Update pulls and rebuilds. `None` = where the app was built.
    pub update_source: Option<PathBuf>,
    /// Folders agents (MCP, CLI) may only read, or can't see at all, per vault root.
    pub agent_rules: BTreeMap<PathBuf, Vec<AgentRule>>,
}

/// What agents may do in a folder (and everything inside it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    /// Agents can read and search it, but not change anything.
    ReadOnly,
    /// Agents can't see it: it's left out of listings and search, and reading it says "not found".
    Hidden,
    /// Agents' changes become proposals that the person accepts or rejects in the app.
    Review,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRule {
    /// Vault-relative folder (or file) path.
    pub path: String,
    pub access: Access,
}

/// The strictest rule covering `path` (a rule on a folder covers everything inside it): hidden,
/// then read-only, then review.
pub fn access_for(rules: &[AgentRule], path: &str) -> Option<Access> {
    let covered = |r: &&AgentRule| {
        r.path.is_empty() || path == r.path || path.starts_with(&format!("{}/", r.path))
    };
    let found: Vec<Access> = rules.iter().filter(covered).map(|r| r.access).collect();
    [Access::Hidden, Access::ReadOnly, Access::Review]
        .into_iter()
        .find(|a| found.contains(a))
}

/// Where settings.json lives. `MOSAIC_SETTINGS_DIR` overrides it (used by tests).
pub fn app_support_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MOSAIC_SETTINGS_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(APP_ID),
    )
}

/// Where search indexes live. `MOSAIC_CACHE_DIR` overrides it (used by tests).
pub const SETTINGS_FILE: &str = "settings.json";

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
            .and_then(|d| std::fs::read(d.join(SETTINGS_FILE)).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let dir = app_support_dir().ok_or_else(|| std::io::Error::other("HOME not set"))?;
        std::fs::create_dir_all(&dir)?;
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        // Atomic: the app and agents (CLI/MCP) both write this file, and a half-written one would
        // load as defaults and lose every setting on the next save.
        let mut tmp = tempfile::NamedTempFile::new_in(&dir)?;
        std::io::Write::write_all(&mut tmp, &json)?;
        tmp.persist(dir.join(SETTINGS_FILE)).map_err(|e| e.error)?;
        Ok(())
    }

    /// Loads, applies `change`, and saves only if something changed.
    pub fn update(change: impl FnOnce(&mut Settings) -> bool) -> std::io::Result<()> {
        let mut s = Settings::load();
        if change(&mut s) { s.save() } else { Ok(()) }
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

    pub fn agent_rules(&self, root: &Path) -> Vec<AgentRule> {
        self.agent_rules.get(root).cloned().unwrap_or_default()
    }

    pub fn set_agent_rules(&mut self, root: &Path, rules: Vec<AgentRule>) {
        if rules.is_empty() {
            self.agent_rules.remove(root);
        } else {
            self.agent_rules.insert(root.to_path_buf(), rules);
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

impl Settings {
    /// Makes a vault's bookmarks follow a move of `from` to `to` (also inside a moved folder).
    /// Returns whether anything changed.
    pub fn remap_bookmarks(&mut self, root: &Path, from: &str, to: &str) -> bool {
        let Some(list) = self.bookmarks.get_mut(root) else {
            return false;
        };
        let mut changed = false;
        for p in list.iter_mut() {
            let mapped = if p == from {
                Some(to.to_string())
            } else {
                p.strip_prefix(&format!("{from}/"))
                    .map(|rest| format!("{to}/{rest}"))
            };
            if let Some(m) = mapped {
                *p = m;
                changed = true;
            }
        }
        changed
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
        s.set_bookmarks(
            a,
            vec!["Notes/x.md".into(), "Notes".into(), "Notes2/y.md".into()],
        );
        assert!(s.remap_bookmarks(a, "Notes", "Archive/Notes"));
        assert_eq!(
            s.bookmarks(a),
            vec!["Archive/Notes/x.md", "Archive/Notes", "Notes2/y.md"]
        );
        assert!(!s.remap_bookmarks(a, "Missing.md", "Other.md"));
        assert!(!s.remap_bookmarks(Path::new("/b"), "x.md", "z.md"));
        s.set_bookmarks(a, vec![]);
        assert!(!s.bookmarks.contains_key(a));
    }
}
