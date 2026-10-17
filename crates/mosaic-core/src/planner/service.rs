//! The planner as its own service on the workspace (`ws.planner`): it owns its store and lock, so
//! note operations never touch it and it can't reach into theirs. The store opens on first use, so
//! a damaged or newer planner never stops notes from working, and a vault that never used it gets
//! no `.mosaic/` folder.

use super::PlannerStore;
use crate::error::{Error, Result};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

pub struct PlannerService {
    store: OnceLock<std::result::Result<Mutex<PlannerStore>, String>>,
    /// The vault whose `.mosaic/planner.sqlite3` this is; `None`: in memory (tests).
    root: Option<PathBuf>,
}

impl PlannerService {
    pub(crate) fn new(root: Option<PathBuf>) -> Self {
        Self {
            store: OnceLock::new(),
            root,
        }
    }

    /// Opens the store now rather than on first use: the app does, so a damaged database is
    /// reported when the vault opens, where it can offer to restore the last backup.
    pub fn open(&self) -> Result<()> {
        self.store().map(drop)
    }

    /// The planner's store, opened the first time it's needed.
    pub(crate) fn store(&self) -> Result<MutexGuard<'_, PlannerStore>> {
        let store = self.store.get_or_init(|| {
            match &self.root {
                Some(root) => PlannerStore::open(root),
                None => PlannerStore::in_memory(),
            }
            .map(Mutex::new)
            .map_err(|e| e.to_string())
        });
        match store {
            Ok(m) => Ok(m.lock().unwrap_or_else(|p| p.into_inner())),
            Err(e) => Err(Error::Invalid(format!("the planner is unavailable: {e}"))),
        }
    }
}
