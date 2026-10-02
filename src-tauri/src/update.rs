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
    /// Set by "Cancel"; the running step is killed and no further step starts.
    cancelled: AtomicBool,
    /// Process group of the step running now, so "Cancel" can stop it and everything it started.
    step: Mutex<Option<u32>>,
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

#[derive(Serialize, Debug)]
pub struct CommitInfo {
    hash: String,
    subject: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Release {
    version: String,
    date: String,
    /// The release's top-level bullet points from CHANGELOG.md.
    notes: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct UpdateCheck {
    branch: String,
    upstream: String,
    /// The version on the upstream branch (from its `Cargo.toml`), if it could be read.
    latest_version: Option<String>,
    /// Releases in the upstream CHANGELOG.md newer than this app (newest first).
    releases: Vec<Release>,
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

/// The `[workspace.package]` version in a `Cargo.toml`.
fn workspace_version(cargo_toml: &str) -> Option<String> {
    let mut in_section = false;
    for line in cargo_toml.lines().map(str::trim) {
        if line.starts_with('[') {
            in_section = line == "[workspace.package]";
        } else if in_section && let Some(v) = line.strip_prefix("version") {
            let v = v.trim_start().strip_prefix('=')?.trim().trim_matches('"');
            return Some(v.to_string());
        }
    }
    None
}

/// Releases in a CHANGELOG.md newer than `installed`, newest first. Headings look like
/// `## 0.2.0 — 2026-10-01`; `## Unreleased` and anything that isn't a version are skipped.
fn releases_since(changelog: &str, installed: &str) -> Vec<Release> {
    let Some(installed) = parse_version(installed) else {
        return Vec::new();
    };
    let mut out: Vec<(_, Release)> = Vec::new();
    let mut current: Option<usize> = None;
    for line in changelog.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            current = None;
            let mut words = heading.splitn(2, char::is_whitespace);
            let version = words.next().unwrap_or("").trim_matches(['[', ']']);
            if let Some(v) = parse_version(version).filter(|v| *v > installed) {
                let date = words
                    .next()
                    .unwrap_or("")
                    .trim_start_matches(['—', '-', ' '])
                    .trim();
                out.push((
                    v,
                    Release {
                        version: version.to_string(),
                        date: date.to_string(),
                        notes: Vec::new(),
                    },
                ));
                current = Some(out.len() - 1);
            }
        } else if let (Some(i), Some(note)) = (current, line.strip_prefix("- ")) {
            out[i].1.notes.push(note.trim().to_string());
        }
    }
    out.sort_by_key(|(v, _)| std::cmp::Reverse(*v));
    out.into_iter().map(|(_, r)| r).collect()
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
    check_in(&usable_source()?, COMMIT, env!("CARGO_PKG_VERSION"))
}

/// What's new upstream for the checkout in `dir`, for an app built from `installed_commit` as `installed_version`.
fn check_in(dir: &Path, installed_commit: &str, installed_version: &str) -> CmdResult<UpdateCheck> {
    let dir = dir.to_path_buf();
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
            &format!("{installed_commit}^{{commit}}"),
        ],
    );
    let dirty = !git(&dir, &["status", "--porcelain", "--untracked-files=no"])
        .map_err(invalid)?
        .is_empty();
    let latest_version = git(&dir, &["show", &format!("{upstream}:Cargo.toml")])
        .ok()
        .and_then(|t| workspace_version(&t));
    let releases = git(&dir, &["show", &format!("{upstream}:CHANGELOG.md")])
        .map(|t| releases_since(&t, installed_version))
        .unwrap_or_default();
    Ok(UpdateCheck {
        latest_version,
        releases,
        installed_outdated: installed_commit.is_empty() || installed.map_or(true, |c| c != head),
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
    state.cancelled.store(false, Ordering::SeqCst);
    let universal = is_universal();
    std::thread::spawn(move || {
        let result = run_update(&app, &dir, universal);
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

/// Stops a running update: kills the current step's whole process group (zsh, pnpm, cargo, rustc…).
/// The installed app is only replaced by "Restart to finish", so stopping at any point is safe.
#[tauri::command]
pub fn cancel_update(app: AppHandle, state: State<UpdateState>) -> CmdResult<()> {
    if !state.running.load(Ordering::SeqCst) {
        return Ok(());
    }
    state.cancelled.store(true, Ordering::SeqCst);
    if let Some(pgid) = *state.step.lock().expect("update lock") {
        let _ = app.emit("update-log", "Cancelling…");
        let _ = Command::new("kill")
            .args(["-TERM", "--", &format!("-{pgid}")])
            .status();
    }
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
        .process_group(0)
        .spawn()
        .map_err(|e| format!("couldn't start {script}: {e}"))?;
    let state = app.state::<UpdateState>();
    *state.step.lock().expect("update lock") = Some(child.id());
    // "Cancel" may have come in before this step was registered.
    if state.cancelled.load(Ordering::SeqCst) {
        let _ = child.kill();
    }
    let mut built = None;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(p) = line.strip_prefix("BUILT_APP=") {
                built = Some(PathBuf::from(p.trim()));
            }
            let _ = app.emit("update-log", line);
        }
    }
    let status = child.wait().map_err(|e| e.to_string());
    *state.step.lock().expect("update lock") = None;
    if state.cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    let status = status?;
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

    #[test]
    fn reads_the_workspace_version() {
        let toml = "[workspace]\nmembers = []\n\n[workspace.package]\nedition = \"2024\"\nversion = \"0.3.1\"\n\n[workspace.dependencies]\nversion = \"9\"\n";
        assert_eq!(workspace_version(toml).as_deref(), Some("0.3.1"));
        assert_eq!(workspace_version("[package]\nversion = \"1.0.0\"\n"), None);
    }

    #[test]
    fn lists_releases_newer_than_installed() {
        let log = "# Changelog\n\n## Unreleased\n\n- Not out yet\n\n## 0.10.0 — 2026-11-02\n\n- Diagrams\n  - nested detail\n- Graph view\n\n## 0.2.0 — 2026-10-01\n\n- Versions\n\n## 0.1.0 — 2026-09-30\n\n- First\n";
        let got = releases_since(log, "0.1.0");
        assert_eq!(
            got,
            vec![
                Release {
                    version: "0.10.0".into(),
                    date: "2026-11-02".into(),
                    notes: vec!["Diagrams".into(), "Graph view".into()],
                },
                Release {
                    version: "0.2.0".into(),
                    date: "2026-10-01".into(),
                    notes: vec!["Versions".into()],
                },
            ]
        );
        assert!(releases_since(log, "0.10.0").is_empty());
        assert!(releases_since(log, "").is_empty());
    }

    /// A git command in `dir` with a fixed identity (tests don't depend on the user's git config).
    fn g(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn release(dir: &Path, version: &str, notes: &str) {
        std::fs::write(
            dir.join("Cargo.toml"),
            format!("[workspace.package]\nversion = \"{version}\"\n"),
        )
        .unwrap();
        let old = std::fs::read_to_string(dir.join("CHANGELOG.md"))
            .unwrap_or_else(|_| "# Changelog\n".into());
        let new = old.replacen(
            "# Changelog\n",
            &format!("# Changelog\n\n## {version} — 2026-10-02\n\n- {notes}\n"),
            1,
        );
        std::fs::write(dir.join("CHANGELOG.md"), new).unwrap();
        g(dir, &["add", "-A"]);
        g(dir, &["commit", "-qm", &format!("Release {version}")]);
    }

    #[test]
    fn check_lists_new_releases_commits_and_local_state() {
        let tmp = tempfile::tempdir().unwrap();
        let (origin, dev, source) = (
            tmp.path().join("origin.git"),
            tmp.path().join("dev"),
            tmp.path().join("source"),
        );
        g(
            tmp.path(),
            &["init", "-q", "--bare", origin.to_str().unwrap()],
        );
        g(
            tmp.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                dev.to_str().unwrap(),
            ],
        );
        release(&dev, "0.1.0", "First");
        g(&dev, &["push", "-q", "origin", "HEAD:main"]);
        g(
            tmp.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                source.to_str().unwrap(),
            ],
        );
        let installed = g(&source, &["rev-parse", "--short", "HEAD"]);

        let up_to_date = check_in(&source, &installed, "0.1.0").unwrap();
        assert!(up_to_date.behind.is_empty() && up_to_date.releases.is_empty());
        assert!(!up_to_date.installed_outdated && !up_to_date.dirty && up_to_date.ahead == 0);

        // A new release upstream.
        release(&dev, "0.2.0", "Versions");
        g(&dev, &["push", "-q", "origin", "HEAD:main"]);
        let news = check_in(&source, &installed, "0.1.0").unwrap();
        assert_eq!(news.upstream, "origin/main");
        assert_eq!(news.behind.len(), 1);
        assert_eq!(news.behind[0].subject, "Release 0.2.0");
        assert_eq!(news.latest_version.as_deref(), Some("0.2.0"));
        assert_eq!(
            news.releases
                .iter()
                .map(|r| r.version.as_str())
                .collect::<Vec<_>>(),
            ["0.2.0"]
        );

        // Local state: uncommitted changes, then a local commit, and an app built from an older commit.
        std::fs::write(source.join("CHANGELOG.md"), "edited").unwrap();
        assert!(check_in(&source, &installed, "0.1.0").unwrap().dirty);
        g(&source, &["commit", "-qam", "local"]);
        let local = check_in(&source, &installed, "0.1.0").unwrap();
        assert_eq!(local.ahead, 1);
        assert!(
            local.installed_outdated,
            "the checkout moved past the installed commit"
        );
    }

    #[test]
    fn check_explains_a_detached_head_and_a_missing_upstream() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        g(&repo, &["init", "-q"]);
        release(&repo, "0.1.0", "First");
        let e = check_in(&repo, "", "0.1.0").unwrap_err().to_string();
        assert!(e.contains("nothing to update from"), "{e}");
        let head = g(&repo, &["rev-parse", "HEAD"]);
        g(&repo, &["checkout", "-q", &head]);
        let e = check_in(&repo, "", "0.1.0").unwrap_err().to_string();
        assert!(e.contains("detached HEAD"), "{e}");
    }

    #[test]
    fn the_repo_changelog_parses() {
        let log = include_str!("../../CHANGELOG.md");
        let all = releases_since(log, "0.0.0");
        assert!(!all.is_empty(), "CHANGELOG.md has no release sections");
        assert!(
            all.iter().all(|r| !r.notes.is_empty()),
            "a release has no notes"
        );
        assert!(
            all.iter().any(|r| r.version == env!("CARGO_PKG_VERSION")),
            "the current version isn't in CHANGELOG.md"
        );
    }
}
