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
    /// Who changes the planner through this service, stamped on every activity entry.
    context: Mutex<(String, Option<String>)>,
}

impl PlannerService {
    pub(crate) fn new(root: Option<PathBuf>) -> Self {
        Self {
            store: OnceLock::new(),
            root,
            context: Mutex::new(("app".into(), None)),
        }
    }

    /// Opens the store now rather than on first use: the app does, so a damaged database is
    /// reported when the vault opens, where it can offer to restore the last backup.
    pub fn open(&self) -> Result<()> {
        self.store().map(drop)
    }

    /// Who acts through this service: `source` is `app`, `cli` or `agent`; `actor` the agent's name.
    pub(crate) fn set_actor_context(&self, source: Option<&str>, actor: Option<&str>) {
        let mut context = self.context.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(source) = source {
            context.0 = source.to_string();
        }
        if let Some(actor) = actor {
            context.1 = Some(actor.to_string());
        }
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
            Ok(m) => {
                let guard = m.lock().unwrap_or_else(|p| p.into_inner());
                let (source, actor) = self
                    .context
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                guard.set_activity_context(&source, actor.as_deref())?;
                Ok(guard)
            }
            Err(e) => Err(Error::Invalid(format!("the planner is unavailable: {e}"))),
        }
    }
}
