//! User settings shared by the app and the CLI (e.g. the last opened vault), stored outside any vault in
//! `~/Library/Application Support/dev.jona.mosaic/settings.json`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const APP_ID: &str = "dev.jona.mosaic";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub last_vault: Option<PathBuf>,
    pub recent_vaults: Vec<PathBuf>,
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
}
