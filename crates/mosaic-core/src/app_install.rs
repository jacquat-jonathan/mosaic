//! Narrow, macOS-only application exchange used by the detached updater helper, never by MCP.
use crate::{Error, Result};
use std::path::Path;

pub fn swap_apps(staged: &Path, installed: &Path) -> Result<()> {
    let parent = installed
        .parent()
        .ok_or_else(|| Error::Invalid("Invalid installed app path".into()))?;
    let stage = staged
        .parent()
        .ok_or_else(|| Error::Invalid("Invalid staged app path".into()))?;
    if parent.file_name().is_none_or(|n| n != "Applications")
        || stage.parent() != Some(parent)
        || stage
            .file_name()
            .is_none_or(|n| !n.to_string_lossy().starts_with(".mosaic-install-"))
        || staged.extension().is_none_or(|e| e != "app")
        || installed.extension().is_none_or(|e| e != "app")
    {
        return Err(Error::Invalid(
            "Only a staged Mosaic app beside an Applications installation can be exchanged".into(),
        ));
    }
    for path in [staged, installed, stage, parent] {
        if std::fs::symlink_metadata(path)
            .map_err(|e| Error::io(path.display().to_string(), e))?
            .file_type()
            .is_symlink()
        {
            return Err(Error::Invalid(
                "Application exchange paths cannot be symbolic links".into(),
            ));
        }
    }
    for path in [staged, installed] {
        let output = std::process::Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
            .arg(path.join("Contents/Info.plist"))
            .output()
            .map_err(|e| Error::io(path.display().to_string(), e))?;
        if !output.status.success()
            || String::from_utf8_lossy(&output.stdout).trim() != crate::settings::APP_ID
        {
            return Err(Error::Invalid(
                "Refusing to exchange an unrelated app".into(),
            ));
        }
    }
    exchange(staged, installed)
}
#[cfg(target_os = "macos")]
fn exchange(a: &Path, b: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let a = std::ffi::CString::new(a.as_os_str().as_bytes())
        .map_err(|_| Error::Invalid("Invalid app path".into()))?;
    let b = std::ffi::CString::new(b.as_os_str().as_bytes())
        .map_err(|_| Error::Invalid("Invalid app path".into()))?;
    // Both complete bundles exist on the same volume. RENAME_SWAP exchanges them in one operation,
    // including rollback, so the installed path is never absent or partially copied.
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(Error::io(
            "application exchange",
            std::io::Error::last_os_error(),
        ))
    }
}
#[cfg(not(target_os = "macos"))]
fn exchange(_: &Path, _: &Path) -> Result<()> {
    Err(Error::Invalid("Application updates require macOS".into()))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn exchanges_and_rolls_back_complete_bundles_atomically() {
        let root = tempfile::tempdir().unwrap();
        let applications = root.path().join("Applications");
        let installed = applications.join("Mosaic.app");
        let staged = applications.join(".mosaic-install-test/Mosaic.app");
        for (path, contents) in [(&installed, "old"), (&staged, "new")] {
            std::fs::create_dir_all(path.join("Contents")).unwrap();
            std::fs::write(path.join("Contents/Info.plist"), "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>dev.jona.mosaic</string></dict></plist>").unwrap();
            std::fs::write(path.join("version"), contents).unwrap();
        }
        swap_apps(&staged, &installed).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("version")).unwrap(),
            "new"
        );
        swap_apps(&staged, &installed).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("version")).unwrap(),
            "old"
        );
        assert!(swap_apps(&staged, &root.path().join("Other.app")).is_err());
        std::fs::write(staged.join("Contents/Info.plist"), "bad bundle").unwrap();
        assert!(swap_apps(&staged, &installed).is_err());
        assert_eq!(
            std::fs::read_to_string(installed.join("version")).unwrap(),
            "old"
        );
    }
}
