//! Settings › About & updates. Mosaic is built from source, so it updates the same way: pull the source
//! checkout it was built from, rebuild it with `scripts/install.sh --build-only`, then (after the app
//! quits) swap the new bundle in and reopen it. The network is used only when the user clicks.

use mosaic_core::Error;
use mosaic_core::settings::Settings;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, Error>;

/// Short commit this app was built from (empty if git wasn't available at build time).
const COMMIT: &str = env!("MOSAIC_COMMIT");
/// The source checkout this app was built from: the default update source.
const BUILT_FROM: &str = env!("MOSAIC_SOURCE_DIR");
/// GUI apps start with a minimal PATH; build tools usually live here.
const EXTRA_PATH: &str = "/opt/homebrew/bin:/opt/homebrew/opt/rustup/bin:/usr/local/bin";

#[derive(Default)]
pub struct UpdateState {
    running: AtomicBool,
    /// A finished build waiting for "Restart to finish".
    built: Mutex<Option<PathBuf>>,
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

#[derive(Serialize)]
pub struct UpdateStatus {
    version: &'static str,
    commit: &'static str,
    source_dir: String,
    /// Why the source folder can't be used, if it can't.
    source_problem: Option<String>,
    /// The installed `.app` this process runs from; `None` for a development build.
    app_path: Option<String>,
    running: bool,
    ready_to_install: bool,
    /// Why the last "Restart to finish" couldn't install the new build (cleared by the next success).
    last_install_error: Option<String>,
}

#[derive(Serialize)]
pub struct CommitInfo {
    hash: String,
    subject: String,
}

#[derive(Serialize)]
pub struct UpdateCheck {
    branch: String,
    upstream: String,
    /// Commits on the upstream branch that the source checkout doesn't have yet (newest first).
    behind: Vec<CommitInfo>,
    /// Local commits not on the upstream branch.
    ahead: usize,
    source_head: String,
    /// The installed app wasn't built from the checkout's current commit.
    installed_outdated: bool,
    /// Uncommitted changes to tracked files (a pull may refuse to run).
    dirty: bool,
}

#[derive(Serialize, Clone)]
struct UpdateDone {
    ok: bool,
    error: Option<String>,
}

fn source_dir() -> PathBuf {
    Settings::load()
        .update_source
        .unwrap_or_else(|| PathBuf::from(BUILT_FROM))
}

fn source_problem(dir: &Path) -> Option<String> {
    if !dir.is_dir() {
        return Some(format!("{} doesn't exist.", dir.display()));
    }
    if !dir.join("scripts/install.sh").is_file() || !dir.join(".git").exists() {
        return Some(format!(
            "{} isn't a Mosaic source checkout (no .git or scripts/install.sh).",
            dir.display()
        ));
    }
    None
}

fn usable_source() -> CmdResult<PathBuf> {
    let dir = source_dir();
    match source_problem(&dir) {
        Some(p) => Err(invalid(p)),
        None => Ok(dir),
    }
}

/// The `.app` bundle this process runs from, if it runs from one.
fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

fn is_universal() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    Command::new("lipo")
        .arg("-archs")
        .arg(exe)
        .output()
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains("x86_64") && s.contains("arm64")
        })
        .unwrap_or(false)
}

fn path_env() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    format!("{EXTRA_PATH}:{home}/.cargo/bin:{current}")
}

/// Runs git in `dir` and returns its trimmed stdout, or its stderr as the error.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("couldn't run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub fn update_status(state: State<UpdateState>) -> UpdateStatus {
    let dir = source_dir();
    UpdateStatus {
        version: env!("CARGO_PKG_VERSION"),
        commit: COMMIT,
        source_problem: source_problem(&dir),
        source_dir: dir.display().to_string(),
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

/// Sets the source checkout to update from; `None` goes back to where the app was built.
#[tauri::command]
pub fn set_update_source(
    state: State<UpdateState>,
    path: Option<String>,
) -> CmdResult<UpdateStatus> {
    let mut settings = Settings::load();
    settings.update_source = path.map(PathBuf::from);
    settings.save().map_err(|e| Error::Io {
        path: "settings.json".into(),
        source: e,
    })?;
    Ok(update_status(state))
}

/// Fetches the upstream branch and reports what's new. Async so the network wait doesn't block the UI.
#[tauri::command]
pub async fn check_updates() -> CmdResult<UpdateCheck> {
    tauri::async_runtime::spawn_blocking(check)
        .await
        .map_err(|e| invalid(e.to_string()))?
}

fn check() -> CmdResult<UpdateCheck> {
    let dir = usable_source()?;
    let branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(invalid)?;
    if branch == "HEAD" {
        return Err(invalid(
            "The source folder isn't on a branch (detached HEAD). Check out a branch first.",
        ));
    }
    let fallback = format!("origin/{branch}");
    let upstream = git(&dir, &["rev-parse", "--abbrev-ref", "@{u}"])
        .or_else(|_| git(&dir, &["rev-parse", "--verify", "--quiet", &fallback]).map(|_| fallback))
        .map_err(|_| {
            invalid(format!(
                "Branch “{branch}” has nothing to update from. Push it once with: git push -u origin {branch}"
            ))
        })?;
    let remote = upstream.split('/').next().unwrap_or("origin");
    git(&dir, &["fetch", "--quiet", remote])
        .map_err(|e| invalid(format!("Couldn't fetch from {remote}: {e}")))?;
    let range = format!("HEAD..{upstream}");
    let behind = git(&dir, &["log", "--format=%h%x09%s", &range])
        .map_err(invalid)?
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(h, s)| CommitInfo {
            hash: h.to_string(),
            subject: s.to_string(),
        })
        .collect();
    let ahead = git(&dir, &["rev-list", "--count", &format!("{upstream}..HEAD")])
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    let head = git(&dir, &["rev-parse", "HEAD"]).map_err(invalid)?;
    let installed = git(
        &dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{COMMIT}^{{commit}}"),
        ],
    );
    let dirty = !git(&dir, &["status", "--porcelain", "--untracked-files=no"])
        .map_err(invalid)?
        .is_empty();
    Ok(UpdateCheck {
        installed_outdated: COMMIT.is_empty() || installed.map_or(true, |c| c != head),
        source_head: head.chars().take(7).collect(),
        branch,
        upstream,
        behind,
        ahead,
        dirty,
    })
}

/// Pulls and rebuilds in the background, streaming output as `update-log` events and ending with
/// `update-done`. The new build is installed by `finish_update`.
#[tauri::command]
pub fn start_update(app: AppHandle, state: State<UpdateState>) -> CmdResult<()> {
    if running_bundle().is_none() {
        return Err(invalid(
            "This is a development build; it can't replace itself. Use pnpm dev or scripts/install.sh.",
        ));
    }
    let dir = usable_source()?;
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(invalid("An update is already running."));
    }
    *state.built.lock().expect("update lock") = None;
    let universal = is_universal();
    std::thread::spawn(move || {
        let result = run_update(&app, &dir, universal);
        let st = app.state::<UpdateState>();
        let done = match result {
            Ok(built) => {
                *st.built.lock().expect("update lock") = Some(built);
                UpdateDone {
                    ok: true,
                    error: None,
                }
            }
            Err(e) => UpdateDone {
                ok: false,
                error: Some(e),
            },
        };
        st.running.store(false, Ordering::SeqCst);
        let _ = app.emit("update-done", done);
    });
    Ok(())
}

fn run_update(app: &AppHandle, dir: &Path, universal: bool) -> Result<PathBuf, String> {
    run_logged(app, dir, "git pull --ff-only")?;
    let script = if universal {
        "scripts/install.sh --build-only --universal"
    } else {
        "scripts/install.sh --build-only"
    };
    let built = run_logged(app, dir, script)?
        .ok_or("The build finished but didn't report where the app is.")?;
    if !built.join("Contents/MacOS").is_dir() {
        return Err(format!(
            "The build output {} isn't an app.",
            built.display()
        ));
    }
    Ok(built)
}

/// Runs `script` in a login shell (so the user's PATH applies), streaming each output line to the UI.
/// Returns the `BUILT_APP=` path if the script printed one.
fn run_logged(app: &AppHandle, dir: &Path, script: &str) -> Result<Option<PathBuf>, String> {
    let _ = app.emit("update-log", format!("$ {script}"));
    let mut child = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(format!("{script} 2>&1"))
        .current_dir(dir)
        .env("PATH", path_env())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start {script}: {e}"))?;
    let mut built = None;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(p) = line.strip_prefix("BUILT_APP=") {
                built = Some(PathBuf::from(p.trim()));
            }
            let _ = app.emit("update-log", line);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(built)
    } else {
        Err(format!(
            "“{script}” failed (exit code {}). See the log above.",
            status.code().unwrap_or(-1)
        ))
    }
}

/// Quits, then a detached helper waits for this process to exit, swaps in the new build and reopens it.
#[tauri::command]
pub fn finish_update(app: AppHandle, state: State<UpdateState>) -> CmdResult<()> {
    let built = state
        .built
        .lock()
        .expect("update lock")
        .clone()
        .ok_or_else(|| invalid("There's no finished build to install."))?;
    let dest = running_bundle().ok_or_else(|| invalid("This is a development build."))?;
    let error_file = install_error_file().ok_or_else(|| invalid("HOME isn't set."))?;
    // Copy first, then swap, so a failed step never leaves the user without an app: the old bundle
    // is moved aside and put back if the new one can't take its place. Every step is logged.
    let script = r#"pid=$1 src=$2 dest=$3 log=$4 err=$5
mkdir -p "$(dirname "$log")" "$(dirname "$err")"
exec >>"$log" 2>&1
echo "== $(date): installing $src into $dest"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
fail() { echo "FAILED: $1"; printf '%s\n' "Couldn't install the new build ($1). Details in $log" >"$err"; }
rm -rf "$dest.new" "$dest.old"
if ! ditto "$src" "$dest.new"; then
  fail "copying it next to the app"; rm -rf "$dest.new"
elif ! mv "$dest" "$dest.old"; then
  fail "moving the old app aside"; rm -rf "$dest.new"
elif ! mv "$dest.new" "$dest"; then
  fail "moving the new app in place"; mv "$dest.old" "$dest"
else
  rm -rf "$dest.old" "$err"
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null
  echo "installed"
fi
open "$dest""#;
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("mosaic-update")
        .arg(std::process::id().to_string())
        .arg(&built)
        .arg(&dest)
        .arg(install_log_file())
        .arg(&error_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| Error::Io {
            path: dest.display().to_string(),
            source: e,
        })?;
    app.exit(0);
    Ok(())
}
