//! User-invoked, unencrypted recovery bundles. No live store is copied as raw SQLite bytes.
//! Restore only creates a new vault; source identities, caches and credentials are never imported.
use crate::{Error, Result, settings::Settings};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use unicode_normalization::UnicodeNormalization;

const FORMAT: u32 = 1;
const PRIVATE_FILES: &[&str] = &[
    "history.db",
    "rules.json",
    "bookmarks.json",
    "tessera-state.json",
];

#[derive(Debug, Clone, Copy, Default)]
pub struct BackupOptions {
    /// Include private undo/proposal history, rules, bookmarks, workflow transcripts and vault settings.
    pub include_private_state: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub mosaic_version: String,
    pub created: String,
    pub encrypted: bool,
    pub private_state: bool,
    pub planner_schema: Option<i64>,
    pub calendar_reconnect_count: usize,
    pub warnings: Vec<String>,
    pub files: Vec<Entry>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PortableSettings {
    templates: Option<serde_json::Value>,
    preferences: Option<serde_json::Value>,
}
#[derive(Debug, Serialize)]
pub struct RestorePreview {
    pub destination: PathBuf,
    pub can_restore: bool,
    pub conflicts: Vec<String>,
    pub files: usize,
    pub bytes: u64,
    pub private_state: bool,
    pub calendar_reconnect_count: usize,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct Restored {
    pub destination: PathBuf,
    pub vault_id: String,
    pub calendar_reconnect_count: usize,
    pub warnings: Vec<String>,
}
fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
fn io(path: &Path, e: std::io::Error) -> Error {
    Error::io(path.display().to_string(), e)
}
fn sql(e: rusqlite::Error) -> Error {
    invalid(format!("backup database: {e}"))
}
fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| io(path, e))
}
// Open each component relative to a pinned directory, never following a link swapped in
// after metadata validation. All restored bytes are read through this descriptor.
fn open_bundle_file(root: &Path, relative: &str) -> Result<fs::File> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    };
    let mut current = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|e| io(root, e))?;
    let parts: Vec<_> = Path::new(relative).components().collect();
    for (i, component) in parts.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(invalid("invalid bundle path"));
        };
        let name =
            std::ffi::CString::new(name.as_bytes()).map_err(|_| invalid("invalid bundle path"))?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if i + 1 == parts.len() {
                0
            } else {
                libc::O_DIRECTORY
            };
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io(&root.join(relative), std::io::Error::last_os_error()));
        }
        current = unsafe { fs::File::from_raw_fd(fd) };
    }
    if !current.metadata().map_err(|e| io(root, e))?.is_file() {
        return Err(invalid("backup input is not a regular file"));
    }
    Ok(current)
}
fn verified_input(root: &Path, entry: &Entry) -> Result<fs::File> {
    let mut file = open_bundle_file(root, &entry.path)?;
    if hash_input(&mut file)? != (entry.bytes, entry.sha256.clone()) {
        return Err(invalid(format!("backup checksum mismatch: {}", entry.path)));
    }
    file.rewind().map_err(|e| io(root, e))?;
    Ok(file)
}
fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    fs::write(path, bytes).map_err(|e| io(path, e))
}
fn json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec_pretty(value).map_err(|e| invalid(e.to_string()))
}
fn canonical(path: &Path) -> Result<PathBuf> {
    fs::canonicalize(path).map_err(|e| io(path, e))
}
fn target(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| invalid("destination must name a new directory"))?;
    Ok(canonical(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .join(name))
}
fn regular(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| io(path, e))?;
    if !meta.is_file() {
        return Err(invalid(
            "backup inputs must be regular files, not links or devices",
        ));
    }
    Ok(())
}
fn hash(path: &Path) -> Result<(u64, String)> {
    regular(path)?;
    let mut file = fs::File::open(path).map_err(|e| io(path, e))?;
    hash_input(&mut file)
}
fn hash_input(file: &mut fs::File) -> Result<(u64, String)> {
    let mut digest = Sha256::new();
    let mut count = 0;
    let mut buf = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| io(Path::new("backup input"), e))?;
        if n == 0 {
            break;
        }
        count += n as u64;
        digest.update(&buf[..n]);
    }
    Ok((
        count,
        digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    ))
}
fn snapshot(source: &Path, destination: &Path) -> Result<i64> {
    regular(source)?;
    let source = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(sql)?;
    source.busy_timeout(Duration::from_secs(5)).map_err(sql)?;
    let mut dest = Connection::open(destination).map_err(sql)?;
    let backup = Backup::new(&source, &mut dest).map_err(sql)?;
    // Bounded: do not spin forever if the live database is busy or changes continuously.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        match backup.step(128).map_err(sql)? {
            rusqlite::backup::StepResult::Done => break,
            _ if std::time::Instant::now() >= deadline => {
                return Err(invalid(
                    "database snapshot timed out; retry when writers are idle",
                ));
            }
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    drop(backup);
    check_db(&dest)
}
fn check_db(conn: &Connection) -> Result<i64> {
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(sql)?;
    if result != "ok" {
        return Err(invalid("backup database failed its integrity check"));
    }
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sql)
}
fn check_planner(path: &Path) -> Result<i64> {
    regular(path)?;
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql)?;
    let version = check_db(&conn)?;
    if !(0..=crate::planner::SCHEMA_VERSION).contains(&version) {
        return Err(invalid(format!(
            "planner schema {version} is unsupported; use a compatible Mosaic version"
        )));
    }
    Ok(version)
}
fn copy_contents(source: &Path, dest: &Path, root: &Path) -> Result<()> {
    for item in fs::read_dir(source).map_err(|e| io(source, e))? {
        let item = item.map_err(|e| io(source, e))?;
        let path = item.path();
        let rel = path.strip_prefix(root).unwrap();
        if rel.components().next().is_some_and(|c| {
            c.as_os_str().to_str().is_some_and(|s| {
                s.eq_ignore_ascii_case(".mosaic") || s.eq_ignore_ascii_case(".git")
            })
        }) {
            continue;
        }
        let kind = item.file_type().map_err(|e| io(&path, e))?;
        if kind.is_dir() {
            fs::create_dir_all(dest.join(rel)).map_err(|e| io(&path, e))?;
            copy_contents(&path, dest, root)?;
        } else {
            regular(&path)?;
            let mut input = open_bundle_file(
                root,
                rel.to_str()
                    .ok_or_else(|| invalid("backup paths must be UTF-8"))?,
            )?;
            let mut output = fs::File::create(dest.join(rel)).map_err(|e| io(&path, e))?;
            std::io::copy(&mut input, &mut output).map_err(|e| io(&path, e))?;
        }
    }
    Ok(())
}
fn inventory(root: &Path, dir: &Path, entries: &mut Vec<Entry>) -> Result<()> {
    for item in fs::read_dir(dir).map_err(|e| io(dir, e))? {
        let item = item.map_err(|e| io(dir, e))?;
        let path = item.path();
        if item.file_type().map_err(|e| io(&path, e))?.is_dir() {
            inventory(root, &path, entries)?;
        } else {
            let (bytes, sha256) = hash(&path)?;
            let path = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .ok_or_else(|| invalid("backup paths must be UTF-8"))?
                .to_string();
            if path.contains('\\') {
                return Err(invalid("backslash filenames are not portable backup paths"));
            }
            entries.push(Entry {
                path,
                bytes,
                sha256,
            });
        }
    }
    Ok(())
}
fn publish(stage: &Path, destination: &Path) -> Result<()> {
    // Never replace even an empty directory created concurrently after preflight.
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(stage.as_os_str().as_bytes())
        .map_err(|_| invalid("invalid destination"))?;
    let to = std::ffi::CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| invalid("invalid destination"))?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let result = -1;
    if result != 0 {
        return Err(io(destination, std::io::Error::last_os_error()));
    }
    Ok(())
}
/// Creates a complete directory bundle at a previously nonexistent path. Does not activate or
/// modify the source vault. SQLite snapshots are consistent individually, not one transaction
/// spanning notes and databases; pause writers for a single application-level recovery point.
pub fn create(
    root: &Path,
    destination: &Path,
    support: &Path,
    options: BackupOptions,
) -> Result<Manifest> {
    let root = canonical(root)?;
    let destination = target(destination)?;
    if destination.starts_with(&root) {
        return Err(invalid(
            "backup destination must be outside the source vault",
        ));
    }
    if destination.try_exists().map_err(|e| io(&destination, e))? {
        return Err(invalid("backup destination already exists"));
    }
    let stage = tempfile::Builder::new()
        .prefix(".mosaic-backup-")
        .tempdir_in(destination.parent().unwrap())
        .map_err(|e| io(&destination, e))?;
    let content = stage.path().join("content");
    fs::create_dir(&content).map_err(|e| io(&content, e))?;
    copy_contents(&root, &content, &root)?;
    let mut manifest=Manifest { format:FORMAT,mosaic_version:crate::VERSION.into(),created:chrono::Utc::now().to_rfc3339(),encrypted:false,private_state:options.include_private_state,planner_schema:None,calendar_reconnect_count:0,warnings:vec!["Unencrypted: protect this bundle like the original notes. Pause writers for a common recovery point across notes and databases.".into()],files:vec![] };
    let planner = root.join(".mosaic/planner.sqlite3");
    if planner.try_exists().map_err(|e| io(&planner, e))? {
        let dest = stage.path().join("planner.sqlite3");
        snapshot(&planner, &dest)?;
        manifest.planner_schema = Some(check_planner(&dest)?);
    }
    let settings = Settings::try_load_in(support).map_err(|e| io(support, e))?;
    let identity = crate::vault_id::peek(&root)?;
    let subscriptions = settings.other.get("calendar_subscriptions");
    let calendars = identity
        .as_ref()
        .and_then(|id| subscriptions?.get("vault_ids")?.get(&id.id))
        .or_else(|| subscriptions?.get("vaults")?.get(root.to_str()?));
    manifest.calendar_reconnect_count = calendars.and_then(|v| v.as_array()).map_or(0, Vec::len);
    if manifest.calendar_reconnect_count > 0 {
        manifest.warnings.push("Calendar subscriptions require reconnection: feed URLs, credentials, references and caches are excluded.".into());
    }
    if options.include_private_state {
        let private = stage.path().join("private");
        fs::create_dir(&private).map_err(|e| io(&private, e))?;
        if let Some(identity) = &identity {
            uuid::Uuid::parse_str(&identity.id).map_err(|_| invalid("invalid vault identity"))?;
            let state = support.join("vaults").join(&identity.id);
            for name in PRIVATE_FILES {
                let from = state.join(name);
                if from.try_exists().map_err(|e| io(&from, e))? {
                    if *name == "history.db" {
                        if snapshot(&from, &private.join(name))? != 0 {
                            return Err(invalid("unsupported history schema"));
                        }
                    } else {
                        let mut bytes = Vec::new();
                        open_bundle_file(&state, name)?
                            .read_to_end(&mut bytes)
                            .map_err(|e| io(&from, e))?;
                        let _: serde_json::Value = serde_json::from_slice(&bytes)
                            .map_err(|e| invalid(format!("invalid private state: {e}")))?;
                        write(&private.join(name), &bytes)?;
                    }
                }
            }
            if !state.exists() {
                manifest.warnings.push("No Application Support state found for this vault; only available content/settings were captured.".into());
            }
        } else {
            manifest.warnings.push(
                "No existing vault identity: external history was not inferred or migrated.".into(),
            );
        }
        let portable = PortableSettings {
            templates: settings.templates.get(&root).cloned(),
            preferences: settings.vault_preferences.get(&root).cloned(),
        };
        write(&private.join("settings.json"), &json(&portable)?)?;
    }
    inventory(stage.path(), stage.path(), &mut manifest.files)?;
    manifest.files.sort_by(|a, b| a.path.cmp(&b.path));
    write(&stage.path().join("manifest.json"), &json(&manifest)?)?;
    validate(stage.path())?;
    publish(stage.path(), &destination)?;
    Ok(manifest)
}
fn allowed(path: &str, private: bool) -> bool {
    let p = Path::new(path);
    if path.contains('\\')
        || path
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == "..")
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return false;
    }
    if let Some(rest) = path.strip_prefix("content/") {
        return !rest.is_empty()
            && !rest.split('/').next().is_some_and(|s| {
                s.eq_ignore_ascii_case(".mosaic") || s.eq_ignore_ascii_case(".git")
            });
    }
    path == "planner.sqlite3"
        || (private
            && path
                .strip_prefix("private/")
                .is_some_and(|p| PRIVATE_FILES.contains(&p) || p == "settings.json"))
}
fn validate(bundle: &Path) -> Result<Manifest> {
    let mut bytes = Vec::new();
    open_bundle_file(bundle, "manifest.json")?
        .read_to_end(&mut bytes)
        .map_err(|e| io(bundle, e))?;
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|e| invalid(format!("invalid backup manifest: {e}")))?;
    if manifest.format != FORMAT || manifest.encrypted {
        return Err(invalid("unsupported backup format or encryption"));
    }
    let mut paths = BTreeSet::new();
    let mut portable_paths = BTreeSet::new();
    // SQLite must never read undeclared WAL/journal sidecars from the input bundle.
    let checked_databases = tempfile::tempdir().map_err(|e| io(bundle, e))?;
    let checked_root = canonical(checked_databases.path())?;
    for entry in &manifest.files {
        if !allowed(&entry.path, manifest.private_state)
            || !paths.insert(entry.path.clone())
            || !portable_paths.insert(entry.path.nfc().collect::<String>().to_lowercase())
        {
            return Err(invalid("invalid or duplicate backup path"));
        }
        let mut file = verified_input(bundle, entry)?;
        if entry.path == "planner.sqlite3" || entry.path == "private/history.db" {
            let target = checked_root.join(Path::new(&entry.path).file_name().unwrap());
            let mut output = fs::File::create(&target).map_err(|e| io(&target, e))?;
            std::io::copy(&mut file, &mut output).map_err(|e| io(&target, e))?;
            if hash(&target)? != (entry.bytes, entry.sha256.clone()) {
                return Err(invalid("bundle changed during validation"));
            }
        }
    }
    if paths.contains("planner.sqlite3") {
        if Some(check_planner(&checked_root.join("planner.sqlite3"))?) != manifest.planner_schema {
            return Err(invalid("planner schema does not match manifest"));
        }
    } else if manifest.planner_schema.is_some() {
        return Err(invalid("planner snapshot missing"));
    }
    if paths.contains("private/history.db") {
        let c = Connection::open_with_flags(
            checked_root.join("history.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(sql)?;
        if check_db(&c)? != 0 {
            return Err(invalid("unsupported history schema"));
        }
    }
    Ok(manifest)
}
pub fn preview(bundle: &Path, destination: &Path) -> Result<RestorePreview> {
    let bundle = canonical(bundle)?;
    let manifest = validate(&bundle)?;
    let destination = target(destination)?;
    let mut conflicts = vec![];
    if fs::symlink_metadata(&destination).is_ok() {
        conflicts.push("Destination already exists; restore never merges or overwrites.".into());
    }
    if destination.starts_with(&bundle) {
        conflicts.push("Destination is inside the backup bundle.".into());
    }
    Ok(RestorePreview {
        destination,
        can_restore: conflicts.is_empty(),
        conflicts,
        files: manifest.files.len(),
        bytes: manifest.files.iter().map(|f| f.bytes).sum(),
        private_state: manifest.private_state,
        calendar_reconnect_count: manifest.calendar_reconnect_count,
        warnings: manifest.warnings,
    })
}
/// Validates everything before mutation and publishes a fresh identity only after staged recovery
/// succeeds. Private data must be opted into again at restore, even if the bundle contains it.
pub fn restore(
    bundle: &Path,
    destination: &Path,
    support: &Path,
    include_private_state: bool,
) -> Result<Restored> {
    restore_staged(bundle, destination, support, include_private_state, || {
        Ok(())
    })
}

fn restore_staged(
    bundle: &Path,
    destination: &Path,
    support: &Path,
    include_private_state: bool,
    before_publish: impl FnOnce() -> Result<()>,
) -> Result<Restored> {
    let bundle = canonical(bundle)?;
    let manifest = validate(&bundle)?;
    let plan = preview(&bundle, destination)?;
    if !plan.can_restore {
        return Err(invalid(plan.conflicts.join(" ")));
    }
    let dest = plan.destination;
    let stage = tempfile::Builder::new()
        .prefix(".mosaic-restore-")
        .tempdir_in(dest.parent().unwrap())
        .map_err(|e| io(&dest, e))?;
    let id = uuid::Uuid::new_v4().to_string();
    let state_parent = support.join("vaults");
    let private = include_private_state && manifest.private_state;
    let state_stage = if private {
        fs::create_dir_all(&state_parent).map_err(|e| io(&state_parent, e))?;
        Some(
            tempfile::Builder::new()
                .prefix(".restore-")
                .tempdir_in(&state_parent)
                .map_err(|e| io(&state_parent, e))?,
        )
    } else {
        None
    };
    let mut portable = PortableSettings::default();
    for entry in &manifest.files {
        // Recheck while copying: a modified bundle must not bypass preview validation.
        let mut input = verified_input(&bundle, entry)?;
        let target = if let Some(path) = entry.path.strip_prefix("content/") {
            Some(stage.path().join(path))
        } else if entry.path == "planner.sqlite3" {
            Some(stage.path().join(".mosaic/planner.sqlite3"))
        } else if private && entry.path == "private/settings.json" {
            let mut bytes = Vec::new();
            input.read_to_end(&mut bytes).map_err(|e| io(&bundle, e))?;
            if (
                bytes.len() as u64,
                Sha256::digest(&bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>(),
            ) != (entry.bytes, entry.sha256.clone())
            {
                return Err(invalid("bundle changed during restore"));
            }
            portable = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
            None
        } else if private {
            Some(
                state_stage
                    .as_ref()
                    .unwrap()
                    .path()
                    .join(entry.path.strip_prefix("private/").unwrap()),
            )
        } else {
            None
        };
        if let Some(target) = target {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| io(&target, e))?;
            std::io::copy(&mut input, &mut output).map_err(|e| io(&target, e))?;
            output.sync_all().map_err(|e| io(&target, e))?;
            if hash(&target)? != (entry.bytes, entry.sha256.clone()) {
                return Err(invalid("bundle changed during restore"));
            }
        }
    }
    if let Some(state) = &state_stage {
        // The presence of rules.json is the legacy-migration completion marker. Preserve
        // restored bookmarks even when the source support directory lacked that marker.
        if !state.path().join("rules.json").exists() {
            write(&state.path().join("rules.json"), b"[]")?;
        }
        let workflow = state.path().join("tessera-state.json");
        if workflow.exists() {
            let mut value: crate::settings::TesseraSettings =
                serde_json::from_slice(&read(&workflow)?).map_err(|e| invalid(e.to_string()))?;
            value.paused = true;
            for run in &mut value.runs {
                if run.finished.is_none() {
                    run.status = "interrupted".into();
                    run.finished = Some(chrono::Utc::now().timestamp());
                }
            }
            write(&workflow, &json(&value)?)?;
        }
    }
    write(
        &stage.path().join(crate::vault_id::FILE),
        &json(&serde_json::json!({"id":id,"root":dest}))?,
    )?;
    // Migrations and a complete derived-index rebuild happen in isolation before publication.
    if manifest.planner_schema.is_some() {
        drop(crate::planner::PlannerStore::open(stage.path())?);
    }
    let ws = crate::Workspace::new(
        crate::Vault::open(stage.path())?,
        crate::index::Index::in_memory()?,
    );
    ws.sync(|_, _| {})?;
    drop(ws);
    before_publish()?;
    let state_dest = state_parent.join(&id);
    if let Some(state) = &state_stage {
        publish(state.path(), &state_dest)?;
    }
    if let Err(e) = publish(stage.path(), &dest) {
        if private {
            let _ = fs::remove_dir_all(&state_dest);
        }
        return Err(e);
    }
    if private {
        let result = Settings::try_update_in(support, |s| {
            if s.templates.contains_key(&dest) || s.vault_preferences.contains_key(&dest) {
                return Err(std::io::Error::other(
                    "destination already has app settings; refusing overwrite",
                ));
            }
            if let Some(v) = portable.templates {
                s.templates.insert(dest.clone(), v);
            }
            if let Some(v) = portable.preferences {
                s.vault_preferences.insert(dest.clone(), v);
            }
            Ok(((), true))
        });
        if let Err(e) = result {
            let _ = fs::remove_dir_all(&dest);
            let _ = fs::remove_dir_all(&state_dest);
            return Err(io(support, e));
        }
    }
    let mut warnings = manifest.warnings;
    if manifest.private_state && !private {
        warnings.push("Private state was not restored (requires --include-private-state).".into());
    }
    Ok(Restored {
        destination: dest,
        vault_id: id,
        calendar_reconnect_count: manifest.calendar_reconnect_count,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        history::{Action, History, Source},
        planner::{CreateTask, PlannerStore, TaskStatus},
        vault_state::VaultState,
    };
    fn folder(root: &Path, name: &str) -> PathBuf {
        let p = root.join(name);
        fs::create_dir_all(&p).unwrap();
        canonical(&p).unwrap()
    }
    fn fixture(root: &Path) -> (PathBuf, PathBuf) {
        let vault = folder(root, "vault");
        let support = folder(root, "support");
        fs::write(vault.join("Note.md"), "# Recovered needle\n").unwrap();
        (vault, support)
    }
    #[test]
    fn restore_drill_recovers_live_sqlite_notes_and_selected_private_state_without_source_mutation()
    {
        let temp = tempfile::tempdir().unwrap();
        let (vault, support) = fixture(temp.path());
        let id = crate::vault_id::identify(&vault).unwrap().id;
        let mut planner = PlannerStore::open(&vault).unwrap();
        let task = planner
            .create_task(CreateTask {
                title: "Recover me".into(),
                description: String::new(),
                epic_id: None,
                parent_id: None,
                status: TaskStatus::New,
                due_date: None,
                estimate_minutes: None,
            })
            .unwrap();
        let history = History::open_in(&vault, &support, None).unwrap();
        history
            .record(
                "Note.md",
                Some("prior content"),
                "hash",
                &Source::Cli,
                None,
                Action::Edited,
                None,
            )
            .unwrap();
        let state = VaultState::open_in(&vault, &support).unwrap();
        state
            .update_bookmarks(|b| {
                b.push("Note.md".into());
                true
            })
            .unwrap();
        state
            .update_tessera(|t| {
                t.paused = false;
            })
            .unwrap();
        Settings::try_update_in(&support,|s|{s.templates.insert(vault.clone(),serde_json::json!({"folder":"Templates"}));s.vault_preferences.insert(vault.clone(),serde_json::json!({"daily_folder":"Journal"}));s.other.insert("calendar_subscriptions".into(),serde_json::json!({"vault_ids":{id.clone():[{"id":"secret-keychain-ref","url":"https://private.example"}]}}));Ok(((),true))}).unwrap();
        let original_identity = read(&vault.join(crate::vault_id::FILE)).unwrap();
        let original_settings = read(&support.join("settings.json")).unwrap();
        let bundle = temp.path().join("bundle");
        let manifest = create(
            &vault,
            &bundle,
            &support,
            BackupOptions {
                include_private_state: true,
            },
        )
        .unwrap();
        assert_eq!(manifest.calendar_reconnect_count, 1);
        assert!(
            !String::from_utf8(read(&bundle.join("manifest.json")).unwrap())
                .unwrap()
                .contains("secret-keychain-ref")
        );
        assert!(!bundle.join("content/.mosaic").exists());
        let dest = temp.path().join("restored");
        let preview = preview(&bundle, &dest).unwrap();
        assert!(preview.can_restore);
        assert!(!dest.exists());
        let restored = restore(&bundle, &dest, &support, true).unwrap();
        let dest = restored.destination.clone();
        assert_ne!(id, restored.vault_id);
        assert_eq!(
            read(&vault.join(crate::vault_id::FILE)).unwrap(),
            original_identity
        );
        assert_eq!(
            read(&dest.join("Note.md")).unwrap(),
            read(&vault.join("Note.md")).unwrap()
        );
        let recovered = PlannerStore::open(&dest).unwrap();
        assert_eq!(
            recovered
                .list_tasks(false, false)
                .unwrap()
                .into_iter()
                .find(|t| t.id == task.id)
                .unwrap()
                .title,
            "Recover me"
        );
        let h = History::open_in(&dest, &support, None).unwrap();
        assert_eq!(h.list("Note.md", 5).unwrap().len(), 1);
        let state = VaultState::open_in(&dest, &support).unwrap();
        assert_eq!(state.bookmarks().unwrap(), vec!["Note.md"]);
        assert!(state.tessera().unwrap().paused);
        let settings = Settings::try_load_in(&support).unwrap();
        assert_eq!(settings.vault_preferences[&dest]["daily_folder"], "Journal");
        let before: Settings = serde_json::from_slice(&original_settings).unwrap();
        assert_eq!(settings.templates[&vault], before.templates[&vault]);
        let ws = crate::Workspace::new(
            crate::Vault::open(&dest).unwrap(),
            crate::index::Index::in_memory().unwrap(),
        );
        ws.sync(|_, _| {}).unwrap();
        assert_eq!(ws.search("needle", 10).unwrap().len(), 1);
        assert!(restore(&bundle, &dest, &support, true).is_err());
    }
    #[test]
    fn default_excludes_private_state_and_restore_requires_second_opt_in() {
        let temp = tempfile::tempdir().unwrap();
        let (vault, support) = fixture(temp.path());
        VaultState::open_in(&vault, &support)
            .unwrap()
            .update_bookmarks(|b| {
                b.push("Note.md".into());
                true
            })
            .unwrap();
        let bundle = temp.path().join("public");
        let manifest = create(&vault, &bundle, &support, BackupOptions::default()).unwrap();
        assert!(!manifest.private_state);
        assert!(!bundle.join("private").exists());
        let bundle = temp.path().join("private");
        create(
            &vault,
            &bundle,
            &support,
            BackupOptions {
                include_private_state: true,
            },
        )
        .unwrap();
        let dest = temp.path().join("restored");
        let r = restore(&bundle, &dest, &support, false).unwrap();
        assert!(!support.join("vaults").join(r.vault_id).exists());
    }
    #[test]
    fn corrupt_or_traversing_bundle_and_newer_formats_never_publish() {
        for path in [
            "content/.MOSAIC/evil",
            "content/./a",
            "content//a",
            "content/a/../b",
            "private/../rules.json",
        ] {
            assert!(!allowed(path, true));
        }

        let temp = tempfile::tempdir().unwrap();
        let (vault, support) = fixture(temp.path());
        let bundle = temp.path().join("bundle");
        let original = create(&vault, &bundle, &support, BackupOptions::default()).unwrap();
        let dest = temp.path().join("restored");
        write(&bundle.join("content/Note.md"), b"tampered").unwrap();
        assert!(restore(&bundle, &dest, &support, false).is_err());
        assert!(!dest.exists());
        write(
            &bundle.join("content/Note.md"),
            &read(&vault.join("Note.md")).unwrap(),
        )
        .unwrap();
        let mut m = original.clone();
        m.files[0].path = "content/../../escape".into();
        write(&bundle.join("manifest.json"), &json(&m).unwrap()).unwrap();
        assert!(preview(&bundle, &dest).is_err());
        let mut m = original;
        m.format = FORMAT + 1;
        write(&bundle.join("manifest.json"), &json(&m).unwrap()).unwrap();
        assert!(restore(&bundle, &dest, &support, false).is_err());
        assert!(!dest.exists());
    }
    #[test]
    fn newer_planner_rejected_older_planner_migrates_only_in_restore() {
        let temp = tempfile::tempdir().unwrap();
        let (vault, support) = fixture(temp.path());
        fs::create_dir(vault.join(".mosaic")).unwrap();
        let path = vault.join(".mosaic/planner.sqlite3");
        let c = Connection::open(&path).unwrap();
        c.pragma_update(None, "user_version", 999).unwrap();
        let bundle = temp.path().join("bundle");
        assert!(create(&vault, &bundle, &support, BackupOptions::default()).is_err());
        assert!(!bundle.exists());
        c.pragma_update(None, "user_version", 0).unwrap();
        drop(c);
        let manifest = create(&vault, &bundle, &support, BackupOptions::default()).unwrap();
        assert_eq!(manifest.planner_schema, Some(0));
        let dest = temp.path().join("restore");
        restore(&bundle, &dest, &support, false).unwrap();
        assert_eq!(check_planner(&path).unwrap(), 0);
        assert_eq!(
            check_planner(&dest.join(".mosaic/planner.sqlite3")).unwrap(),
            crate::planner::SCHEMA_VERSION
        );
    }
    #[test]
    fn no_support_move_copy_and_failed_private_install_preserve_originals() {
        let temp = tempfile::tempdir().unwrap();
        let (vault, support) = fixture(temp.path());
        let original_id = crate::vault_id::identify(&vault).unwrap().id;
        let bundle = temp.path().join("bundle");
        let manifest = create(
            &vault,
            &bundle,
            &support,
            BackupOptions {
                include_private_state: true,
            },
        )
        .unwrap();
        assert!(
            manifest
                .warnings
                .iter()
                .any(|w| w.contains("No Application Support"))
        );
        let moved = temp.path().join("moved");
        fs::rename(&vault, &moved).unwrap();
        assert_eq!(crate::vault_id::identify(&moved).unwrap().id, original_id);
        let destination = temp.path().join("copy");
        let copy = restore(&bundle, &destination, &support, true).unwrap();
        assert_ne!(copy.vault_id, original_id);
        let failed = temp.path().join("failed");
        write(&support.join("settings.json"), b"{broken").unwrap();
        assert!(restore(&bundle, &failed, &support, true).is_err());
        assert!(!failed.exists());
        assert!(destination.join("Note.md").exists());
        assert!(moved.join("Note.md").exists());
        let aborted = temp.path().join("aborted");
        assert!(
            restore_staged(&bundle, &aborted, &support, true, || Err(invalid(
                "injected interruption before publication"
            )))
            .is_err()
        );
        assert!(!aborted.exists());
        assert!(read(&moved.join("Note.md")).is_ok());
        // A process interrupted before publication can leave staging directories, never a final vault.
        let interrupted = temp.path().join(".mosaic-restore-interrupted");
        fs::create_dir(&interrupted).unwrap();
        write(&interrupted.join("partial"), b"partial").unwrap();
        assert!(preview(&bundle, &failed).unwrap().can_restore);
    }
    #[test]
    fn pinned_bundle_read_cannot_follow_replaced_components() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = folder(temp.path(), "bundle");
        let content = folder(&root, "content");
        write(&content.join("note"), b"original").unwrap();
        let mut pinned = open_bundle_file(&root, "content/note").unwrap();
        let elsewhere = folder(temp.path(), "elsewhere");
        write(&elsewhere.join("note"), b"outside").unwrap();
        fs::rename(&content, root.join("old-content")).unwrap();
        symlink(&elsewhere, &content).unwrap();
        assert!(open_bundle_file(&root, "content/note").is_err());
        let mut bytes = Vec::new();
        pinned.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original");
    }
    #[test]
    fn undeclared_sqlite_wal_cannot_change_validation() {
        let temp = tempfile::tempdir().unwrap();
        let (vault, support) = fixture(temp.path());
        fs::create_dir(vault.join(".mosaic")).unwrap();
        drop(Connection::open(vault.join(".mosaic/planner.sqlite3")).unwrap());
        let bundle = temp.path().join("bundle");
        let mut manifest = create(&vault, &bundle, &support, BackupOptions::default()).unwrap();
        let path = bundle.join("planner.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .unwrap();
        let entry = manifest
            .files
            .iter_mut()
            .find(|e| e.path == "planner.sqlite3")
            .unwrap();
        (entry.bytes, entry.sha256) = hash(&path).unwrap();
        write(&bundle.join("manifest.json"), &json(&manifest).unwrap()).unwrap();
        connection.pragma_update(None, "user_version", 999).unwrap();
        assert!(check_planner(&path).is_err());
        let restored = temp.path().join("restored");
        assert!(preview(&bundle, &restored).unwrap().can_restore);
        restore(&bundle, &restored, &support, false).unwrap();
        assert_eq!(
            check_planner(&restored.join(".mosaic/planner.sqlite3")).unwrap(),
            crate::planner::SCHEMA_VERSION
        );
    }
    #[test]
    fn symlink_bundles_and_source_links_are_refused_and_publication_never_replaces() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let (vault, support) = fixture(temp.path());
        symlink("Note.md", vault.join("link.md")).unwrap();
        let bundle = temp.path().join("bundle");
        assert!(create(&vault, &bundle, &support, BackupOptions::default()).is_err());
        assert!(!bundle.exists());
        fs::remove_file(vault.join("link.md")).unwrap();
        let external = folder(temp.path(), "external-planner");
        drop(Connection::open(external.join("planner.sqlite3")).unwrap());
        symlink(&external, vault.join(".mosaic")).unwrap();
        assert!(create(&vault, &bundle, &support, BackupOptions::default()).is_err());
        assert!(!bundle.exists());
        fs::remove_file(vault.join(".mosaic")).unwrap();
        create(&vault, &bundle, &support, BackupOptions::default()).unwrap();
        fs::remove_file(bundle.join("content/Note.md")).unwrap();
        symlink(vault.join("Note.md"), bundle.join("content/Note.md")).unwrap();
        assert!(preview(&bundle, &temp.path().join("dest")).is_err());
        let a = folder(temp.path(), "a");
        let b = folder(temp.path(), "b");
        assert!(publish(&a, &b).is_err());
        assert!(a.exists());
        assert!(b.exists());
    }
}
