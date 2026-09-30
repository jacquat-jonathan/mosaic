//! Tauri front end: every command is a thin mapping onto `mosaic_core::Workspace`.

use mosaic_core::api::{Outline, Renamed};
use mosaic_core::index::{Backlink, SearchHit, TagCount};
use mosaic_core::settings::Settings;
use mosaic_core::{Entry, Error, FileContent, Workspace, Written};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, Error>;

#[derive(Default)]
struct AppState {
    ws: RwLock<Option<Arc<Workspace>>>,
    watcher: Mutex<Option<mosaic_core::watch::Watcher>>,
}

impl AppState {
    fn get(&self) -> CmdResult<Arc<Workspace>> {
        self.ws
            .read()
            .expect("workspace lock poisoned")
            .clone()
            .ok_or_else(|| Error::Invalid("no vault is open".into()))
    }
}

#[derive(Serialize, Clone)]
struct VaultInfo {
    root: String,
    name: String,
}

#[derive(Serialize, Clone)]
struct IndexProgress {
    done: usize,
    total: usize,
    finished: bool,
}

fn info(ws: &Workspace) -> VaultInfo {
    let root = ws.vault.root();
    VaultInfo {
        root: root.display().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

#[tauri::command]
fn open_vault(app: AppHandle, state: State<AppState>, path: String) -> CmdResult<VaultInfo> {
    let ws = Arc::new(Workspace::open(&path)?);
    let _ = app
        .asset_protocol_scope()
        .allow_directory(ws.vault.root(), true);
    let mut settings = Settings::load();
    settings.remember_vault(ws.vault.root().to_path_buf());
    let _ = settings.save();
    let out = info(&ws);
    *state.ws.write().expect("workspace lock poisoned") = Some(ws.clone());

    // External changes (AI, CLI, other editors) are pushed to the UI as they happen.
    let events = app.clone();
    let watcher = mosaic_core::watch::watch(ws.clone(), move |changes| {
        let _ = events.emit("vault-changed", changes);
    })
    .ok();
    *state.watcher.lock().expect("watcher lock poisoned") = watcher;

    // Index in the background; the UI shows progress and search uses the last consistent index.
    std::thread::spawn(move || {
        let emit = |done, total, finished| {
            let _ = app.emit(
                "index-progress",
                IndexProgress {
                    done,
                    total,
                    finished,
                },
            );
        };
        let _ = ws.sync(|done, total| emit(done, total, false));
        emit(0, 0, true);
    });
    Ok(out)
}

#[tauri::command]
fn current_vault(state: State<AppState>) -> Option<VaultInfo> {
    state.get().ok().map(|ws| info(&ws))
}

#[tauri::command]
fn last_vault() -> Option<PathBuf> {
    Settings::load().last_vault.filter(|p| p.is_dir())
}

#[tauri::command]
fn list_dir(state: State<AppState>, dir: String, recursive: bool) -> CmdResult<Vec<Entry>> {
    state.get()?.list(&dir, recursive)
}

#[tauri::command]
fn read_file(state: State<AppState>, path: String) -> CmdResult<FileContent> {
    state.get()?.read(&path)
}

#[tauri::command]
fn create_file(state: State<AppState>, path: String, content: String) -> CmdResult<Written> {
    state.get()?.create(&path, &content)
}

#[tauri::command]
fn write_file(
    state: State<AppState>,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> CmdResult<Written> {
    state
        .get()?
        .write(&path, &content, expected_hash.as_deref())
}

#[tauri::command]
fn make_dir(state: State<AppState>, path: String) -> CmdResult<()> {
    state.get()?.mkdir(&path)
}

#[tauri::command]
fn rename_path(state: State<AppState>, from: String, to: String) -> CmdResult<Renamed> {
    state.get()?.rename(&from, &to, true)
}

#[tauri::command]
fn delete_path(state: State<AppState>, path: String) -> CmdResult<()> {
    state.get()?.delete(&path)
}

#[tauri::command]
fn absolute_path(state: State<AppState>, path: String) -> CmdResult<String> {
    Ok(state.get()?.vault.resolve(&path)?.display().to_string())
}

#[tauri::command]
fn search(
    state: State<AppState>,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<SearchHit>> {
    state.get()?.search(&query, limit.unwrap_or(50))
}

#[tauri::command]
fn backlinks(state: State<AppState>, path: String) -> CmdResult<Vec<Backlink>> {
    state.get()?.backlinks(&path)
}

#[tauri::command]
fn tags(state: State<AppState>) -> CmdResult<Vec<TagCount>> {
    state.get()?.tags()
}

#[tauri::command]
fn aliases(state: State<AppState>) -> CmdResult<Vec<(String, String)>> {
    state.get()?.aliases()
}

#[tauri::command]
fn outline(state: State<AppState>, path: String) -> CmdResult<Outline> {
    state.get()?.outline(&path)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            search,
            backlinks,
            tags,
            aliases,
            outline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mosaic");
}
