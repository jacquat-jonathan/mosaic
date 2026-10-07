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
    /// Scheduler state and run history, per vault; kept outside the vault like other app state.
    pub tessera: BTreeMap<PathBuf, TesseraSettings>,
    /// Settings a newer Mosaic wrote that this version doesn't know: kept so saving doesn't drop them.
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TesseraSettings {
    pub paused: bool,
    pub paused_agents: Vec<String>,
    /// Maximum number of agent-to-agent event steps after the root event.
    pub max_chain_depth: u8,
    /// Last scheduler check, Unix seconds. Used to run one missed occurrence on startup.
    pub last_checked: i64,
    pub runs: Vec<AgentRun>,
}

impl Default for TesseraSettings {
    fn default() -> Self {
        Self {
            paused: false,
            paused_agents: Vec::new(),
            max_chain_depth: 3,
            last_checked: 0,
            runs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub id: u64,
    pub agent: String,
    pub title: String,
    pub started: i64,
    pub finished: Option<i64>,
    pub late: bool,
    /// Human-readable cause: Manual, a schedule, or an event.
    #[serde(default)]
    pub trigger: Option<String>,
    /// Note that caused an event run.
    #[serde(default)]
    pub trigger_path: Option<String>,
    /// Shared by all runs caused by one root event.
    #[serde(default)]
    pub chain_id: Option<String>,
    #[serde(default)]
    pub chain_depth: Option<u8>,
    /// Claude model actually requested; absent means Claude Code's default.
    #[serde(default)]
    pub model: Option<String>,
    /// Process attempts made for this run (one plus automatic retries).
    #[serde(default = "one_attempt")]
    pub attempts: u8,
    pub status: String,
    pub answer: String,
    pub error: Option<String>,
    pub proposals: usize,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub changed_paths: Vec<String>,
    #[serde(default)]
    pub proposal_ids: Vec<i64>,
}

fn one_attempt() -> u8 {
    1
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
#[serde(from = "RawRule", into = "RawRule")]
pub struct AgentRule {
    /// Vault-relative folder (or file) path.
    pub path: String,
    pub access: Access,
    /// The access as written, when it's one this version doesn't know (a newer Mosaic added it).
    /// Such a rule is enforced as read-only and saved back unchanged.
    pub written_as: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct RawRule {
    path: String,
    access: String,
}

impl From<RawRule> for AgentRule {
    fn from(r: RawRule) -> Self {
        let known = serde_json::from_value(serde_json::Value::String(r.access.clone())).ok();
        AgentRule {
            path: r.path,
            access: known.unwrap_or(Access::ReadOnly),
            written_as: known.is_none().then_some(r.access),
        }
    }
}

impl From<AgentRule> for RawRule {
    fn from(r: AgentRule) -> Self {
        let access = r.written_as.unwrap_or_else(|| {
            serde_json::to_value(r.access)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default()
        });
        RawRule {
            path: r.path,
            access,
        }
    }
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

    pub fn tessera(&self, root: &Path) -> TesseraSettings {
        self.tessera.get(root).cloned().unwrap_or_default()
    }

    pub fn set_tessera(&mut self, root: &Path, value: TesseraSettings) {
        self.tessera.insert(root.to_path_buf(), value);
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
    #[test]
    fn old_run_history_gains_empty_detail_fields() {
        let run: super::AgentRun = serde_json::from_str(r#"{"id":1,"agent":"review","title":"Review","started":1,"finished":2,"late":false,"status":"done","answer":"OK","error":null,"proposals":1,"changes":["Edited note"]}"#).unwrap();
        assert!(run.proposal_ids.is_empty());
        assert!(run.changed_paths.is_empty());
        assert_eq!(run.changes, vec!["Edited note"]);
        assert_eq!(run.attempts, 1);
        assert_eq!(run.trigger, None);
        assert_eq!(TesseraSettings::default().max_chain_depth, 3);
    }

    use super::*;

    #[test]
    fn settings_from_a_newer_version_load_fail_closed_and_survive_a_save() {
        // A newer Mosaic added an access kind and a setting this version doesn't know. Loading must
        // keep every other rule (not fall back to no rules at all), enforce the unknown one as
        // read-only, and write both back unchanged.
        let json = r#"{
            "bookmarks": { "/v": ["A.md"] },
            "agent_rules": { "/v": [
                { "path": "Private", "access": "hidden" },
                { "path": "Drafts", "access": "approve-twice" }
            ] },
            "future_setting": { "on": true }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        let rules = s.agent_rules(Path::new("/v"));
        assert_eq!(access_for(&rules, "Private/x.md"), Some(Access::Hidden));
        assert_eq!(access_for(&rules, "Drafts/x.md"), Some(Access::ReadOnly));
        assert_eq!(s.bookmarks[Path::new("/v")], ["A.md"]);

        let saved: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(saved["agent_rules"]["/v"][1]["access"], "approve-twice");
        assert_eq!(saved["agent_rules"]["/v"][0]["access"], "hidden");
        assert_eq!(saved["future_setting"]["on"], true);
    }

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
