//! Tauri front end: every command is a thin mapping onto `mosaic_core::Workspace`.

mod update;

use mosaic_core::api::{Mention, Outline, Renamed};
use mosaic_core::history::Version;
use mosaic_core::index::{Backlink, SearchHit, TagCount};
use mosaic_core::settings::{AgentRule, Settings};
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
    settings_watcher: Mutex<Option<mosaic_core::watch::Watcher>>,
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
    activate(app, &state, Workspace::open(&path)?)
}

/// Creates `<parent>/<name>` as a new, empty vault folder. The UI then opens it with `open_vault`.
#[tauri::command]
fn create_vault(parent: String, name: String) -> CmdResult<VaultInfo> {
    let vault = mosaic_core::Vault::create_new(&parent, &name)?;
    let root = vault.root();
    Ok(VaultInfo {
        root: root.display().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

/// Makes `ws` the open vault: remembers it, starts the watcher and indexes in the background.
fn activate(app: AppHandle, state: &AppState, ws: Workspace) -> CmdResult<VaultInfo> {
    let ws = Arc::new(ws);
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

#[derive(Serialize)]
struct RecentVault {
    root: String,
    name: String,
    /// False when the folder is gone (deleted, or on an unplugged disk).
    exists: bool,
}

#[tauri::command]
fn recent_vaults() -> Vec<RecentVault> {
    Settings::load()
        .recent_vaults
        .into_iter()
        .map(|p| RecentVault {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            exists: p.is_dir(),
            root: p.display().to_string(),
        })
        .collect()
}

#[tauri::command]
fn forget_vault(path: String) -> CmdResult<()> {
    let mut settings = Settings::load();
    settings.forget_vault(std::path::Path::new(&path));
    settings.save().map_err(|e| Error::Io { path, source: e })
}

#[tauri::command]
fn get_bookmarks(state: State<AppState>) -> CmdResult<Vec<String>> {
    Ok(Settings::load().bookmarks(state.get()?.vault.root()))
}

#[tauri::command]
fn get_agent_rules(state: State<AppState>) -> CmdResult<Vec<AgentRule>> {
    Ok(Settings::load().agent_rules(state.get()?.vault.root()))
}

#[tauri::command]
fn set_agent_rules(state: State<AppState>, rules: Vec<AgentRule>) -> CmdResult<()> {
    let ws = state.get()?;
    let mut settings = Settings::load();
    settings.set_agent_rules(ws.vault.root(), rules);
    settings.save().map_err(|e| Error::Io {
        path: "settings.json".into(),
        source: e,
    })
}

#[tauri::command]
fn set_bookmarks(state: State<AppState>, paths: Vec<String>) -> CmdResult<()> {
    let ws = state.get()?;
    let mut settings = Settings::load();
    settings.set_bookmarks(ws.vault.root(), paths);
    settings.save().map_err(|e| Error::Io {
        path: "settings.json".into(),
        source: e,
    })
}

#[tauri::command]
fn copy_path(state: State<AppState>, from: String, to: String) -> CmdResult<Written> {
    state.get()?.copy(&from, &to)
}

/// Adds a file dropped from Finder. The bytes come as the raw request body (no JSON round trip for
/// large images); the vault path comes URI-encoded in the `x-path` header.
#[tauri::command]
fn import_file(state: State<AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<Written> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Invalid("import_file expects raw bytes".into()));
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .and_then(percent_decode)
        .ok_or_else(|| Error::Invalid("import_file needs an x-path header".into()))?;
    state.get()?.import(&path, bytes)
}

/// Undoes JavaScript's `encodeURIComponent`.
fn percent_decode(s: &str) -> Option<String> {
    let mut out = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hex = [bytes.next()?, bytes.next()?];
            out.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
        } else {
            out.push(b);
        }
    }
    String::from_utf8(out).ok()
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

/// Opens the macOS print dialog for the window ("Save as PDF" is in it). The UI shows only the
/// print preview when printing, through print CSS.
#[tauri::command]
fn print_window(window: tauri::WebviewWindow) -> CmdResult<()> {
    window
        .print()
        .map_err(|e| Error::Invalid(format!("couldn't print: {e}")))
}

#[tauri::command]
fn unlinked_mentions(state: State<AppState>, path: String) -> CmdResult<Vec<Mention>> {
    state.get()?.unlinked_mentions(&path, 30)
}

#[tauri::command]
fn link_mention(
    state: State<AppState>,
    source: String,
    line: usize,
    text: String,
    target: String,
) -> CmdResult<Written> {
    state.get()?.link_mention(&source, line, &text, &target)
}

#[tauri::command]
fn file_history(state: State<AppState>, path: String) -> CmdResult<Vec<Version>> {
    state.get()?.history(&path, 50)
}

#[tauri::command]
fn version_content(state: State<AppState>, id: i64) -> CmdResult<String> {
    state.get()?.version_content(id)
}

#[tauri::command]
fn restore_version(
    state: State<AppState>,
    path: String,
    id: i64,
    expected_hash: Option<String>,
) -> CmdResult<Written> {
    state.get()?.restore(&path, id, expected_hash.as_deref())
}

#[tauri::command]
fn ai_activity(state: State<AppState>, limit: Option<usize>) -> CmdResult<Vec<Version>> {
    state.get()?.activity(limit.unwrap_or(200))
}

#[tauri::command]
fn undo_change(state: State<AppState>, id: i64) -> CmdResult<String> {
    state.get()?.undo(id)
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

#[derive(Serialize)]
struct CliInfo {
    /// The `mosaic` binary shipped inside the app.
    path: Option<String>,
    /// Where `install_cli` links it (on the user's PATH).
    link: String,
    installed: bool,
}

fn bundled_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("mosaic");
    p.is_file().then_some(p)
}

fn cli_link() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/bin/mosaic")
}

#[tauri::command]
fn cli_info() -> CliInfo {
    let path = bundled_cli();
    let link = cli_link();
    let installed = match (&path, std::fs::read_link(&link)) {
        (Some(p), Ok(target)) => &target == p,
        _ => false,
    };
    CliInfo {
        path: path.map(|p| p.display().to_string()),
        link: link.display().to_string(),
        installed,
    }
}

/// Symlinks the bundled CLI into ~/.local/bin (no admin rights needed).
#[tauri::command]
fn install_cli() -> CmdResult<CliInfo> {
    let src = bundled_cli()
        .ok_or_else(|| Error::Invalid("the mosaic command isn't bundled in this build".into()))?;
    let link = cli_link();
    let io = |e| Error::Io {
        path: link.display().to_string(),
        source: e,
    };
    std::fs::create_dir_all(link.parent().expect("link has a parent")).map_err(io)?;
    if std::fs::symlink_metadata(&link).is_ok() {
        std::fs::remove_file(&link).map_err(io)?;
    }
    std::os::unix::fs::symlink(&src, &link).map_err(io)?;
    Ok(cli_info())
}

/// WebKit's "check spelling while typing" is off unless this default is set, and it's read once,
/// before the first web view exists. With it on, each editor's `spellcheck` attribute (Settings ›
/// Spellcheck) decides. WebKit only checks words as they're typed, never text already there.
#[cfg(target_os = "macos")]
fn enable_webkit_spellcheck() {
    use objc2_foundation::{NSUserDefaults, ns_string};
    NSUserDefaults::standardUserDefaults()
        .setBool_forKey(true, ns_string!("WebContinuousSpellCheckingEnabled"));
}

pub fn run() {
    #[cfg(target_os = "macos")]
    enable_webkit_spellcheck();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(update::UpdateState::default())
        .setup(|app| {
            // Agents change bookmarks through the CLI/MCP, which write settings.json directly.
            let handle = app.handle().clone();
            let watcher = mosaic_core::watch::watch_settings(move || {
                let _ = handle.emit("settings-changed", ());
            })
            .ok();
            *app.state::<AppState>()
                .settings_watcher
                .lock()
                .expect("watcher lock poisoned") = watcher;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            create_vault,
            recent_vaults,
            forget_vault,
            get_bookmarks,
            set_bookmarks,
            copy_path,
            import_file,
            current_vault,
            last_vault,
            list_dir,
            read_file,
            create_file,
            write_file,
            make_dir,
            rename_path,
            delete_path,
            file_history,
            unlinked_mentions,
            print_window,
            link_mention,
            get_agent_rules,
            set_agent_rules,
            version_content,
            restore_version,
            ai_activity,
            undo_change,
            absolute_path,
            search,
            backlinks,
            tags,
            aliases,
            outline,
            cli_info,
            install_cli,
            update::update_status,
            update::set_update_source,
            update::check_updates,
            update::start_update,
            update::cancel_update,
            update::finish_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mosaic");
}
