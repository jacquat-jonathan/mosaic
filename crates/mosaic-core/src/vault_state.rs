//! Per-vault state Mosaic keeps outside the vault, next to its history in Application Support,
//! under the vault's id (see `vault_id`): `vaults/<id>/rules.json` (agents' folder rules),
//! `bookmarks.json` and `tessera-state.json` (the scheduler's bookkeeping, rewritten every 30 s).
//! Kept apart from settings.json, a scheduler write can never touch the rules, and all three follow
//! a vault that is moved or renamed.
//!
//! Mosaic 0.20 and earlier kept them in settings.json under the vault's path. They are copied here
//! the first time the vault is used with an id and left in settings.json, so going back to 0.20
//! still finds them. `rules.json` is written last: once it exists, the copy is done.

use crate::error::{Error, Result};
use crate::settings::{AgentRule, Settings, TesseraSettings, app_support_dir};
use crate::vault_id;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const RULES_FILE: &str = "rules.json";
pub const BOOKMARKS_FILE: &str = "bookmarks.json";
pub const TESSERA_FILE: &str = "tessera-state.json";

#[derive(Debug, Clone)]
pub struct VaultState {
    dir: PathBuf,
}

impl VaultState {
    /// The vault's state, giving the vault an id (`.mosaic/vault.json`) if it has none yet.
    pub fn open(root: &Path) -> Result<Self> {
        Self::open_in(root, &support()?)
    }

    /// Like `open`, but never writes into the vault (agent reads): `None` when the vault has no id
    /// yet, in which case settings.json still holds its state.
    pub fn peek(root: &Path) -> Result<Option<Self>> {
        Self::peek_in(root, &support()?)
    }

    /// `open` with the Application Support folder given (tests).
    pub fn open_in(root: &Path, support: &Path) -> Result<Self> {
        let vault = vault_id::identify(root)?;
        Self::at(support, root, &vault.id, vault.moved_from.as_deref())
    }

    /// `peek` with the Application Support folder given (tests).
    pub fn peek_in(root: &Path, support: &Path) -> Result<Option<Self>> {
        match vault_id::peek(root)? {
            Some(vault) => {
                Self::at(support, root, &vault.id, vault.moved_from.as_deref()).map(Some)
            }
            None => Ok(None),
        }
    }

    fn at(support: &Path, root: &Path, id: &str, moved_from: Option<&Path>) -> Result<Self> {
        let state = Self::in_dir(support.join("vaults").join(id))?;
        state.migrate(support, root, moved_from)?;
        Ok(state)
    }

    /// State kept in `dir` (tests).
    pub fn in_dir(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir).map_err(|e| Error::io(dir.display().to_string(), e))?;
        Ok(Self { dir })
    }

    /// Copies this vault's entries out of settings.json once. If settings.json can't be read, nothing
    /// is copied and the error is returned, so agents are refused rather than run without rules.
    fn migrate(&self, support: &Path, root: &Path, moved_from: Option<&Path>) -> Result<()> {
        if self.dir.join(RULES_FILE).exists() {
            return Ok(());
        }
        self.locked(|| {
            if self.dir.join(RULES_FILE).exists() {
                return Ok(());
            }
            let settings = Settings::try_load_in(support).map_err(|e| unreadable_settings(&e))?;
            let pick = |key: &dyn Fn(&Path) -> bool| {
                std::iter::once(root)
                    .chain(moved_from)
                    .find(|r| key(r))
                    .map(Path::to_path_buf)
            };
            if let Some(r) = pick(&|r| settings.tessera.contains_key(r)) {
                self.write(TESSERA_FILE, &settings.tessera[&r])?;
            }
            let bookmarks = pick(&|r| settings.bookmarks.contains_key(r))
                .map(|r| settings.bookmarks[&r].clone())
                .unwrap_or_default();
            self.write(BOOKMARKS_FILE, &bookmarks)?;
            let rules = pick(&|r| settings.agent_rules.contains_key(r))
                .map(|r| settings.agent_rules[&r].clone())
                .unwrap_or_default();
            self.write(RULES_FILE, &rules)
        })
    }

    /// Agents' folder rules. A file that can't be read is an error, never "no rules".
    pub fn rules(&self) -> Result<Vec<AgentRule>> {
        Ok(self.read(RULES_FILE)?.unwrap_or_default())
    }

    /// Replaces the rules (an empty list is written too, so old ones are never copied back).
    pub fn set_rules(&self, mut rules: Vec<AgentRule>) -> Result<()> {
        for r in &mut rules {
            r.path = r.path.nfc().collect();
        }
        self.locked(|| self.write(RULES_FILE, &rules))
    }

    pub fn bookmarks(&self) -> Result<Vec<String>> {
        Ok(self.read(BOOKMARKS_FILE)?.unwrap_or_default())
    }

    /// Applies `change` to the bookmarks and saves them, without duplicates, if it returns true.
    pub fn update_bookmarks(&self, change: impl FnOnce(&mut Vec<String>) -> bool) -> Result<()> {
        self.locked(|| {
            let mut list = self.bookmarks()?;
            if !change(&mut list) {
                return Ok(());
            }
            let mut seen = std::collections::HashSet::new();
            list.retain(|p| seen.insert(p.clone()));
            self.write(BOOKMARKS_FILE, &list)
        })
    }

    /// The scheduler's state; a missing or unreadable file starts from the defaults.
    pub fn tessera(&self) -> TesseraSettings {
        self.read(TESSERA_FILE).ok().flatten().unwrap_or_default()
    }

    pub fn set_tessera(&self, value: &TesseraSettings) -> Result<()> {
        self.locked(|| self.write(TESSERA_FILE, value))
    }

    fn read<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let path = self.dir.join(name);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| Error::Invalid(format!("{} can't be read: {e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::io(path.display().to_string(), e)),
        }
    }

    /// Written whole, then renamed over the old file: a half-written file is never seen.
    fn write<T: Serialize + ?Sized>(&self, name: &str, value: &T) -> Result<()> {
        let io = |e: std::io::Error| Error::io(self.dir.join(name).display().to_string(), e);
        let json = serde_json::to_vec_pretty(value).map_err(|e| Error::Invalid(e.to_string()))?;
        let mut tmp = tempfile::NamedTempFile::new_in(&self.dir).map_err(io)?;
        std::io::Write::write_all(&mut tmp, &json).map_err(io)?;
        tmp.persist(self.dir.join(name)).map_err(|e| io(e.error))?;
        Ok(())
    }

    /// Serializes read-modify-write between the app, the CLI and MCP servers.
    fn locked<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let path = self.dir.join("state.lock");
        let io = |e: std::io::Error| Error::io(path.display().to_string(), e);
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(io)?;
        lock.lock().map_err(io)?;
        f()
    }
}

fn support() -> Result<PathBuf> {
    app_support_dir().ok_or_else(|| Error::Invalid("HOME is not set".into()))
}

fn unreadable_settings(e: &std::io::Error) -> Error {
    Error::Invalid(format!("Mosaic's settings can't be read ({e})"))
}

/// The folder rules agents get for the vault at `root`: from its state, or from settings.json while
/// the vault has no id yet. Never writes into the vault.
pub fn rules_for(root: &Path) -> Result<Vec<AgentRule>> {
    match VaultState::peek(root)? {
        Some(state) => state.rules(),
        None => Settings::try_load()
            .map(|s| s.agent_rules(root))
            .map_err(|e| unreadable_settings(&e)),
    }
}

/// The vault's bookmarks, read the same way as `rules_for`.
pub fn bookmarks_for(root: &Path) -> Result<Vec<String>> {
    match VaultState::peek(root)? {
        Some(state) => state.bookmarks(),
        None => Ok(Settings::load().bookmarks(root)),
    }
}

/// Changes the vault's bookmarks where they are kept (see `rules_for`).
pub fn update_bookmarks_for(
    root: &Path,
    change: impl FnOnce(&mut Vec<String>) -> bool,
) -> Result<()> {
    match VaultState::peek(root)? {
        Some(state) => state.update_bookmarks(change),
        None => Settings::update(|s| {
            let mut list = s.bookmarks(root);
            let changed = change(&mut list);
            if changed {
                s.set_bookmarks(root, list);
            }
            changed
        })
        .map_err(|e| unreadable_settings(&e)),
    }
}

/// Makes bookmarks follow a move of `from` to `to` (also inside a moved folder). Returns whether
/// anything changed.
pub fn remap_bookmarks(list: &mut [String], from: &str, to: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Access, AgentRun};

    fn folder(parent: &Path, name: &str) -> PathBuf {
        let p = parent.join(name);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(p).unwrap()
    }

    fn rule(path: &str, access: Access) -> AgentRule {
        AgentRule {
            path: path.into(),
            access,
            written_as: None,
        }
    }

    /// settings.json as Mosaic 0.20 wrote it for the vault at `root`.
    fn old_settings(support: &Path, root: &Path) -> Vec<u8> {
        let mut s = Settings::default();
        s.set_agent_rules(root, vec![rule("Private", Access::Hidden)]);
        s.set_bookmarks(root, vec!["A.md".into()]);
        s.set_tessera(
            root,
            TesseraSettings {
                last_checked: 42,
                ..Default::default()
            },
        );
        let json = serde_json::to_vec_pretty(&s).unwrap();
        std::fs::write(support.join("settings.json"), &json).unwrap();
        json
    }

    #[test]
    fn a_vaults_state_moves_out_of_settings_json_once_and_stays_there_for_a_downgrade() {
        let d = tempfile::tempdir().unwrap();
        let (support, root) = (folder(d.path(), "support"), folder(d.path(), "Vault"));
        let before = old_settings(&support, &root);

        let state = VaultState::open_in(&root, &support).unwrap();
        assert_eq!(
            state.rules().unwrap(),
            vec![rule("Private", Access::Hidden)]
        );
        assert_eq!(state.bookmarks().unwrap(), vec!["A.md"]);
        assert_eq!(state.tessera().last_checked, 42);
        assert_eq!(
            std::fs::read(support.join("settings.json")).unwrap(),
            before
        );

        // Clearing every rule is kept: the old ones are never copied back.
        state.set_rules(vec![]).unwrap();
        let again = VaultState::open_in(&root, &support).unwrap();
        assert!(again.rules().unwrap().is_empty());
    }

    #[test]
    fn a_moved_vault_finds_its_state_under_its_old_path() {
        let d = tempfile::tempdir().unwrap();
        let support = folder(d.path(), "support");
        let old = folder(d.path(), "Old");
        crate::vault_id::identify(&old).unwrap();
        old_settings(&support, &old);
        std::fs::rename(&old, d.path().join("New")).unwrap();
        let new = std::fs::canonicalize(d.path().join("New")).unwrap();

        // An agent read migrates without writing into the vault.
        let before = std::fs::read(new.join(crate::vault_id::FILE)).unwrap();
        let state = VaultState::peek_in(&new, &support).unwrap().unwrap();
        assert_eq!(
            state.rules().unwrap(),
            vec![rule("Private", Access::Hidden)]
        );
        assert_eq!(
            std::fs::read(new.join(crate::vault_id::FILE)).unwrap(),
            before
        );
    }

    #[test]
    fn a_vault_without_an_id_is_left_alone() {
        let d = tempfile::tempdir().unwrap();
        let (support, root) = (folder(d.path(), "support"), folder(d.path(), "Vault"));
        assert!(VaultState::peek_in(&root, &support).unwrap().is_none());
        assert!(!root.join(".mosaic").exists());
        assert!(!support.join("vaults").exists());
    }

    #[test]
    fn unreadable_rules_or_settings_are_errors_never_no_rules() {
        let d = tempfile::tempdir().unwrap();
        let (support, root) = (folder(d.path(), "support"), folder(d.path(), "Vault"));
        std::fs::write(support.join("settings.json"), "{ half written").unwrap();
        assert!(VaultState::open_in(&root, &support).is_err());
        let id = crate::vault_id::peek(&root).unwrap().unwrap().id;
        assert!(!support.join("vaults").join(&id).join(RULES_FILE).exists());

        std::fs::write(support.join("settings.json"), "{}").unwrap();
        let state = VaultState::open_in(&root, &support).unwrap();
        std::fs::write(support.join("vaults").join(&id).join(RULES_FILE), "[{").unwrap();
        assert!(state.rules().is_err());
    }

    #[test]
    fn scheduler_writes_never_touch_settings_json_or_the_rules() {
        let d = tempfile::tempdir().unwrap();
        let (support, root) = (folder(d.path(), "support"), folder(d.path(), "Vault"));
        let before = old_settings(&support, &root);
        let state = VaultState::open_in(&root, &support).unwrap();
        let rules = std::fs::read(state.dir.join(RULES_FILE)).unwrap();
        let mut t = state.tessera();
        t.last_checked = 99;
        t.runs.push(AgentRun {
            id: 1,
            agent: "a".into(),
            title: "A".into(),
            started: 1,
            finished: None,
            late: false,
            trigger: None,
            trigger_path: None,
            chain_id: None,
            chain_depth: None,
            model: None,
            attempts: 1,
            status: "running".into(),
            answer: String::new(),
            error: None,
            proposals: 0,
            changes: vec![],
            changed_paths: vec![],
            proposal_ids: vec![],
        });
        state.set_tessera(&t).unwrap();
        assert_eq!(state.tessera().last_checked, 99);
        assert_eq!(
            std::fs::read(support.join("settings.json")).unwrap(),
            before
        );
        assert_eq!(std::fs::read(state.dir.join(RULES_FILE)).unwrap(), rules);
    }

    #[test]
    fn bookmarks_stay_unique_and_follow_moves() {
        let d = tempfile::tempdir().unwrap();
        let state = VaultState::in_dir(d.path().join("v")).unwrap();
        state
            .update_bookmarks(|l| {
                *l = vec![
                    "Notes/x.md".into(),
                    "Notes".into(),
                    "Notes2/y.md".into(),
                    "Notes".into(),
                ];
                true
            })
            .unwrap();
        assert_eq!(
            state.bookmarks().unwrap(),
            vec!["Notes/x.md", "Notes", "Notes2/y.md"]
        );
        state
            .update_bookmarks(|l| remap_bookmarks(l, "Notes", "Archive/Notes"))
            .unwrap();
        assert_eq!(
            state.bookmarks().unwrap(),
            vec!["Archive/Notes/x.md", "Archive/Notes", "Notes2/y.md"]
        );
        let mut list = state.bookmarks().unwrap();
        assert!(!remap_bookmarks(&mut list, "Missing.md", "Other.md"));
    }
}
