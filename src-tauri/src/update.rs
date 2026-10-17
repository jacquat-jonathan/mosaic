//! Settings › About & updates: signed public release packages, downloaded on an explicit click.
//! Installations exchange complete bundles after the app quits and retain the old app for
//! recovery. (The source updater that pulled and rebuilt a checkout was removed in 0.21.)

use mosaic_core::Error;
use serde::Serialize;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, Error>;
mod binary;

/// Short commit this app was built from (empty if git wasn't available at build time).
const COMMIT: &str = env!("MOSAIC_COMMIT");

#[derive(Default)]
pub struct UpdateState {
    running: AtomicBool,
    /// Set by "Cancel"; the download stops at its next chunk.
    cancelled: AtomicBool,
    /// A verified download waiting for "Restart to finish".
    built: Mutex<Option<PathBuf>>,
    staging: Mutex<Option<tempfile::TempDir>>,
    download_manifest: Mutex<Option<binary::Manifest>>,
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

#[derive(Serialize, specta::Type)]
pub struct UpdateStatus {
    version: &'static str,
    commit: &'static str,
    /// The installed `.app` this process runs from; `None` for a development build.
    app_path: Option<String>,
    running: bool,
    ready_to_install: bool,
    /// Why the last "Restart to finish" couldn't install the new build (cleared by the next success).
    last_install_error: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, specta::Type)]
pub struct Release {
    version: String,
    date: String,
    /// The release's top-level bullet points from CHANGELOG.md (from the signed manifest).
    notes: Vec<String>,
}

#[derive(Serialize, Debug, specta::Type)]
pub struct UpdateCheck {
    /// The newest signed release, if one could be found.
    latest_version: Option<String>,
    /// That release, when it's newer than this app.
    releases: Vec<Release>,
    update_available: bool,
}

#[derive(Serialize, Clone)]
struct UpdateDone {
    ok: bool,
    cancelled: bool,
    error: Option<String>,
}

const CANCELLED: &str = "Update cancelled.";

/// `major.minor.patch`, ignoring any pre-release or build suffix.
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(v)
}

/// The `.app` bundle this process runs from, if it runs from one.
fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

#[tauri::command(async)]
#[specta::specta]
pub fn update_status(state: State<UpdateState>) -> UpdateStatus {
    UpdateStatus {
        version: env!("CARGO_PKG_VERSION"),
        commit: COMMIT,
        app_path: running_bundle().map(|p| p.display().to_string()),
        running: state.running.load(Ordering::SeqCst),
        ready_to_install: state.built.lock().expect("update lock").is_some(),
        last_install_error: install_error_file()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    }
}

/// Written by the install helper when swapping in a new build fails; removed when one succeeds.
fn install_error_file() -> Option<PathBuf> {
    mosaic_core::settings::app_support_dir().map(|d| d.join("update-error.txt"))
}

/// Everything the install helper does is appended here, so a failed swap can be diagnosed.
fn install_log_file() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Logs/Mosaic/update.log")
}

/// Asks GitHub for the newest signed release (only when the person clicks Check).
#[tauri::command]
#[specta::specta]
pub async fn check_updates() -> CmdResult<UpdateCheck> {
    binary::check().await
}

/// Downloads and verifies the newest release in the background, streaming progress as
/// `update-log` events and ending with `update-done`. It's installed by `finish_update`.
#[tauri::command(async)]
#[specta::specta]
pub fn start_update(app: AppHandle, state: State<UpdateState>) -> CmdResult<()> {
    if running_bundle().is_none() {
        return Err(invalid(
            "This is a development build; it can't replace itself. Use pnpm dev or scripts/install.sh.",
        ));
    }
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(invalid("An update is already running."));
    }
    *state.built.lock().expect("update lock") = None;
    *state.staging.lock().expect("update lock") = None;
    *state.download_manifest.lock().expect("update lock") = None;
    state.cancelled.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let result = tauri::async_runtime::block_on(binary::download(&app));
        let st = app.state::<UpdateState>();
        let cancelled = st.cancelled.load(Ordering::SeqCst);
        let done = match result {
            Ok(built) if !cancelled => {
                *st.built.lock().expect("update lock") = Some(built);
                UpdateDone {
                    ok: true,
                    cancelled: false,
                    error: None,
                }
            }
            Ok(_) => UpdateDone {
                ok: false,
                cancelled: true,
                error: Some(CANCELLED.into()),
            },
            Err(e) => UpdateDone {
                ok: false,
                cancelled,
                error: Some(if cancelled { CANCELLED.into() } else { e }),
            },
        };
        st.running.store(false, Ordering::SeqCst);
        let _ = app.emit("update-done", done);
    });
    Ok(())
}

/// Stops a running download. The installed app is only replaced by "Restart to finish", so
/// stopping at any point is safe.
#[tauri::command(async)]
#[specta::specta]
pub fn cancel_update(app: AppHandle, state: State<UpdateState>) -> CmdResult<()> {
    if state.running.load(Ordering::SeqCst) {
        state.cancelled.store(true, Ordering::SeqCst);
        let _ = app.emit("update-log", "Cancelling…");
    }
    Ok(())
}

/// Quits, then a detached helper waits for this process to exit, swaps in the new build and reopens it.
#[tauri::command(async)]
#[specta::specta]
pub fn finish_update(app: AppHandle, state: State<UpdateState>) -> CmdResult<()> {
    let built = state
        .built
        .lock()
        .expect("update lock")
        .clone()
        .ok_or_else(|| invalid("There's no finished build to install."))?;
    let dest = running_bundle().ok_or_else(|| invalid("This is a development build."))?;
    if dest.starts_with("/Volumes") {
        return Err(invalid(
            "Drag Mosaic from the disk image to Applications before updating.",
        ));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| invalid("Invalid app location"))?;
    if parent.file_name().is_none_or(|n| n != "Applications") {
        return Err(invalid(
            "Move Mosaic into /Applications or your own Applications folder before updating.",
        ));
    }
    let stage = tempfile::Builder::new().prefix(".mosaic-install-").tempdir_in(parent).map_err(|_| invalid("Applications isn't writable. Move Mosaic to your own Applications folder or install the download manually."))?;
    let staged = stage.path().join("Mosaic.app");
    let result = Command::new("/usr/bin/ditto")
        .arg(&built)
        .arg(&staged)
        .status()
        .map_err(|e| invalid(e.to_string()))?;
    if !result.success() {
        return Err(invalid(
            "Couldn't stage the app. The installed version is unchanged.",
        ));
    }
    if let Some(manifest) = state
        .download_manifest
        .lock()
        .expect("update lock")
        .as_ref()
    {
        binary::validate_bundle(&staged, Some(&manifest.version)).map_err(invalid)?;
    }
    let backup = stage.path().join("Previous.app");
    let helper = stage.path().join("mosaic-update-helper");
    std::fs::copy(staged.join("Contents/MacOS/mosaic"), &helper).map_err(|source| Error::Io {
        path: helper.display().to_string(),
        source,
    })?;
    if !Command::new(&helper)
        .args(["swap-apps", "--help"])
        .output()
        .map_err(|e| invalid(e.to_string()))?
        .status
        .success()
    {
        return Err(invalid(
            "This package doesn't support safe application exchange; install it manually.",
        ));
    }
    let error_file = install_error_file().ok_or_else(|| invalid("HOME isn't set."))?;
    // An atomic exchange keeps the installed path present throughout. Retain the old bundle;
    // restore it if LaunchServices refuses to open the replacement. Every step is logged.
    let script = r#"pid=$1 src=$2 dest=$3 log=$4 err=$5 backup=$6 helper=$7
mkdir -p "$(dirname "$log")" "$(dirname "$err")"
exec >>"$log" 2>&1
echo "== $(date): installing $src into $dest"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
fail() { echo "FAILED: $1"; printf '%s\n' "Couldn't install the new build ($1). Details in $log" >"$err"; }
if ! "$helper" swap-apps "$src" "$dest"; then
  fail "exchanging the apps; installed app unchanged"
else
  rm -f "$err"
  if ! mv "$src" "$backup"; then backup=$src; fi
  echo "installed; previous version retained at $backup"
fi
if ! open "$dest"; then
  fail "launching the update; restoring the previous app"
  if [ -d "$backup" ]; then "$helper" swap-apps "$backup" "$dest" && open "$dest"; fi
fi"#;
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("mosaic-update")
        .arg(std::process::id().to_string())
        .arg(&staged)
        .arg(&dest)
        .arg(install_log_file())
        .arg(&error_file)
        .arg(&backup)
        .arg(&helper)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| Error::Io {
            path: dest.display().to_string(),
            source: e,
        })?;
    // The helper owns this unique directory after the app exits; retain the old bundle for recovery.
    let _ = stage.keep();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_version("v1.10.3"), Some((1, 10, 3)));
        assert_eq!(parse_version("1.0.0-beta.1"), Some((1, 0, 0)));
        assert_eq!(parse_version("1.0"), None);
        assert_eq!(parse_version("1.0.0.0"), None);
        assert_eq!(parse_version("Unreleased"), None);
    }
}
