//! Tauri front end: every command is a thin mapping onto `mosaic_core`.

use mosaic_core::settings::Settings;
use mosaic_core::{Entry, Error, FileContent, Vault, Written};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::{Manager, State};

type CmdResult<T> = Result<T, Error>;

#[derive(Default)]
struct AppState {
    vault: RwLock<Option<Vault>>,
}

impl AppState {
    fn with<T>(&self, f: impl FnOnce(&Vault) -> CmdResult<T>) -> CmdResult<T> {
        let guard = self.vault.read().expect("vault lock poisoned");
        let vault = guard
            .as_ref()
            .ok_or_else(|| Error::Invalid("no vault is open".into()))?;
        f(vault)
    }
}

#[derive(Serialize)]
struct VaultInfo {
    root: String,
    name: String,
}

fn info(v: &Vault) -> VaultInfo {
    VaultInfo {
        root: v.root().display().to_string(),
        name: v
            .root()
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

#[tauri::command]
fn open_vault(app: tauri::AppHandle, state: State<AppState>, path: String) -> CmdResult<VaultInfo> {
    let vault = Vault::open(&path)?;
    let _ = app
        .asset_protocol_scope()
        .allow_directory(vault.root(), true);
    let mut settings = Settings::load();
    settings.remember_vault(vault.root().to_path_buf());
    let _ = settings.save();
    let out = info(&vault);
    *state.vault.write().expect("vault lock poisoned") = Some(vault);
    Ok(out)
}

#[tauri::command]
fn current_vault(state: State<AppState>) -> Option<VaultInfo> {
    state.vault.read().ok()?.as_ref().map(info)
}

#[tauri::command]
fn last_vault() -> Option<PathBuf> {
    Settings::load().last_vault.filter(|p| p.is_dir())
}

#[tauri::command]
fn list_dir(state: State<AppState>, dir: String, recursive: bool) -> CmdResult<Vec<Entry>> {
    state.with(|v| v.list(&dir, recursive))
}

#[tauri::command]
fn read_file(state: State<AppState>, path: String) -> CmdResult<FileContent> {
    state.with(|v| v.read(&path))
}

#[tauri::command]
fn create_file(state: State<AppState>, path: String, content: String) -> CmdResult<Written> {
    state.with(|v| v.create(&path, &content))
}

#[tauri::command]
fn write_file(
    state: State<AppState>,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> CmdResult<Written> {
    state.with(|v| v.write(&path, &content, expected_hash.as_deref()))
}

#[tauri::command]
fn make_dir(state: State<AppState>, path: String) -> CmdResult<()> {
    state.with(|v| v.mkdir(&path))
}

#[tauri::command]
fn rename_path(state: State<AppState>, from: String, to: String) -> CmdResult<String> {
    state.with(|v| v.rename(&from, &to))
}

#[tauri::command]
fn delete_path(state: State<AppState>, path: String) -> CmdResult<()> {
    state.with(|v| v.delete(&path))
}

#[tauri::command]
fn absolute_path(state: State<AppState>, path: String) -> CmdResult<String> {
    state.with(|v| Ok(v.resolve(&path)?.display().to_string()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            current_vault,
            last_vault,
            list_dir,
            read_file,
            create_file,
            write_file,
            make_dir,
            rename_path,
            delete_path,
            absolute_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mosaic");
}
