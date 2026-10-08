//! Explicit-click downloads. HTTPS is transport; an embedded Ed25519 key is the trust root.
use super::*;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::time::Duration;

const REPO: &str = "jacquat-jonathan/mosaic";
const PUBLIC_KEY: &str = include_str!("../../release-public-key.hex");
const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
#[derive(Debug, Clone, Deserialize)]
pub(super) struct Manifest {
    pub version: String,
    pub bundle_id: String,
    pub minimum_macos: String,
    pub architectures: Vec<String>,
    pub archive: String,
    pub sha256: String,
    pub size: u64,
    pub date: String,
    pub notes: Vec<String>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

fn decode_hex<const N: usize>(text: &str) -> Result<[u8; N], String> {
    let text = text.trim();
    if text.len() != N * 2 {
        return Err("Invalid release key or checksum".into());
    }
    let mut out = [0; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2).ok_or("Invalid hex")?, 16)
            .map_err(|_| "Invalid hex")?;
    }
    Ok(out)
}
fn verified_manifest(bytes: &[u8], signature: &[u8], key: &str) -> Result<Manifest, String> {
    let key = VerifyingKey::from_bytes(&decode_hex(key)?)
        .map_err(|_| "Invalid release verification key")?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| "Invalid release signature")?;
    let signature = Signature::from_slice(&raw).map_err(|_| "Invalid release signature")?;
    key.verify_strict(bytes, &signature)
        .map_err(|_| "Release signature verification failed. Nothing was installed.")?;
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid signed manifest: {e}"))?;
    if parse_version(&manifest.version).is_none()
        || manifest.version.contains(['-', '+'])
        || manifest.bundle_id != mosaic_core::settings::APP_ID
        || manifest.archive != format!("Mosaic-{}-universal.tar.gz", manifest.version)
        || manifest.size == 0
        || manifest.size > MAX_ARCHIVE
        || !manifest.architectures.iter().any(|a| a == "arm64")
        || !manifest.architectures.iter().any(|a| a == "x86_64")
    {
        return Err("Incompatible release manifest. Nothing was installed.".into());
    }
    decode_hex::<32>(&manifest.sha256)?;
    Ok(manifest)
}
fn https(url: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("/usr/bin/curl")
        .args([
            "--fail",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "--max-filesize",
            "1048576",
            "--silent",
            "--show-error",
            "--user-agent",
            "Mosaic",
            url,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Couldn't reach GitHub (offline, rate-limited, or unavailable). Try again later. {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > 1048576 {
        return Err("Release metadata is too large".into());
    }
    Ok(output.stdout)
}
fn asset_url(release: &GithubRelease, name: &str) -> Result<String, String> {
    let expected = format!(
        "https://github.com/{REPO}/releases/download/{}/{name}",
        release.tag_name
    );
    release
        .assets
        .iter()
        .find(|a| a.name == name && a.browser_download_url == expected)
        .map(|a| a.browser_download_url.clone())
        .ok_or_else(|| format!("Missing release asset: {name}"))
}
fn latest() -> Result<Option<(Manifest, String)>, String> {
    let releases: Vec<GithubRelease> = serde_json::from_slice(&https(&format!(
        "https://api.github.com/repos/{REPO}/releases?per_page=30"
    ))?)
    .map_err(|e| e.to_string())?;
    let mut releases: Vec<_> = releases
        .into_iter()
        .filter(|r| {
            !r.draft
                && !r.prerelease
                && r.tag_name.starts_with('v')
                && !r.tag_name.contains(['-', '+'])
                && parse_version(&r.tag_name).is_some()
        })
        .collect();
    releases.sort_by_key(|r| std::cmp::Reverse(parse_version(&r.tag_name)));
    for release in releases {
        let version = &release.tag_name[1..];
        let archive = format!("Mosaic-{version}-universal.tar.gz");
        if [
            archive.clone(),
            format!("Mosaic-{version}-universal.dmg"),
            "manifest.json".into(),
            "manifest.sig".into(),
            "SHA256SUMS".into(),
        ]
        .iter()
        .any(|name| asset_url(&release, name).is_err())
        {
            continue;
        }
        let bytes = https(&asset_url(&release, "manifest.json")?)?;
        let signature = https(&asset_url(&release, "manifest.sig")?)?;
        let manifest = verified_manifest(&bytes, &signature, PUBLIC_KEY)?;
        if manifest.version != version {
            return Err("Release tag doesn't match its signed manifest".into());
        }
        let current = Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .map_err(|e| e.to_string())?;
        let current = String::from_utf8_lossy(&current.stdout);
        let mac_version = |v: &str| -> Option<(u32, u32)> {
            let mut parts = v.trim().split('.');
            Some((
                parts.next()?.parse().ok()?,
                parts.next().unwrap_or("0").parse().ok()?,
            ))
        };
        if mac_version(&current)
            .zip(mac_version(&manifest.minimum_macos))
            .is_none_or(|(current, required)| current < required)
        {
            return Err(format!(
                "Mosaic {version} requires macOS {} or later",
                manifest.minimum_macos
            ));
        }
        return Ok(Some((manifest, asset_url(&release, &archive)?)));
    }
    Ok(None)
}
pub(super) fn check() -> CmdResult<UpdateCheck> {
    let release = latest().map_err(invalid)?;
    let newer = release
        .as_ref()
        .is_some_and(|(m, _)| parse_version(&m.version) > parse_version(env!("CARGO_PKG_VERSION")));
    Ok(UpdateCheck {
        branch: "Releases".into(),
        upstream: "GitHub releases".into(),
        latest_version: release.as_ref().map(|(m, _)| m.version.clone()),
        releases: release
            .filter(|_| newer)
            .map(|(m, _)| {
                vec![Release {
                    version: m.version,
                    date: m.date,
                    notes: m.notes,
                }]
            })
            .unwrap_or_default(),
        behind: Vec::new(),
        ahead: 0,
        source_head: String::new(),
        installed_outdated: newer,
        dirty: false,
    })
}
fn checksum(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hash.finalize().iter().map(|v| format!("{v:02x}")).collect())
}
fn command_ok(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
fn plist(bundle: &Path, field: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", field, "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("Missing bundle field: {field}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
pub(super) fn validate_bundle(bundle: &Path, version: Option<&str>) -> Result<(), String> {
    if plist(bundle, "CFBundleIdentifier")? != mosaic_core::settings::APP_ID
        || version
            .is_some_and(|v| plist(bundle, "CFBundleShortVersionString").ok().as_deref() != Some(v))
    {
        return Err("Wrong update bundle identity or version".into());
    }
    command_ok(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle),
    )?;
    for name in ["mosaic-app", "mosaic"] {
        let executable = bundle.join("Contents/MacOS").join(name);
        let mut bytes = [0; 4096];
        let len = std::fs::File::open(&executable)
            .and_then(|mut f| f.read(&mut bytes))
            .map_err(|e| e.to_string())?;
        if !universal_macho(&bytes[..len]) {
            return Err(format!(
                "{name} is not a universal Intel/Apple Silicon executable"
            ));
        }
    }
    Ok(())
}
fn universal_macho(bytes: &[u8]) -> bool {
    if bytes.len() < 8 || bytes[..4] != [0xca, 0xfe, 0xba, 0xbe] {
        return false;
    }
    let count = u32::from_be_bytes(bytes[4..8].try_into().expect("four bytes")) as usize;
    if !(2..=10).contains(&count) || bytes.len() < 8 + count * 20 {
        return false;
    }
    let types: Vec<_> = (0..count)
        .map(|i| {
            u32::from_be_bytes(
                bytes[8 + i * 20..12 + i * 20]
                    .try_into()
                    .expect("four bytes"),
            )
        })
        .collect();
    types.contains(&0x01000007) && types.contains(&0x0100000c)
}
fn safe_archive(list: &str) -> bool {
    !list.is_empty()
        && list.lines().all(|line| {
            let path = Path::new(line);
            path.components().all(|c| {
                matches!(
                    c,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            }) && (line == "Mosaic.app" || line.starts_with("Mosaic.app/"))
        })
}
pub(super) fn download(app: &AppHandle) -> Result<PathBuf, String> {
    let (manifest, url) =
        latest()?.ok_or("No complete signed download release is available yet")?;
    if parse_version(&manifest.version) <= parse_version(env!("CARGO_PKG_VERSION")) {
        return Err("You're already up to date".into());
    }
    let stage = tempfile::Builder::new()
        .prefix("mosaic-update-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let archive = stage.path().join("update.tar.gz");
    let state = app.state::<UpdateState>();
    let _ = app.emit(
        "update-log",
        format!("Downloading Mosaic {}…", manifest.version),
    );
    let mut child = Command::new("/usr/bin/curl")
        .args([
            "--fail",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "10",
            "--max-time",
            "600",
            "--max-filesize",
            &manifest.size.to_string(),
            "--silent",
            "--show-error",
            "--output",
        ])
        .arg(&archive)
        .arg(url)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    *state.step.lock().expect("update lock") = Some(child.id());
    let mut last = 101;
    let result = loop {
        if state.cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            break Err(CANCELLED.into());
        }
        let size = archive.metadata().map(|m| m.len()).unwrap_or(0);
        if size > manifest.size {
            let _ = child.kill();
            let _ = child.wait();
            break Err("Download exceeds signed size".into());
        }
        let percent = size * 100 / manifest.size;
        if percent != last {
            last = percent;
            let _ = app.emit(
                "update-log",
                format!("Download {percent}% · {size} / {} bytes", manifest.size),
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err("Download failed; check your connection and try again".into())
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => break Err(e.to_string()),
        }
    };
    *state.step.lock().expect("update lock") = None;
    result?;
    if archive.metadata().map_err(|e| e.to_string())?.len() != manifest.size
        || checksum(&archive)? != manifest.sha256
    {
        return Err("Download checksum verification failed. Nothing was installed.".into());
    }
    let _ = app.emit("update-log", "Verifying signed package and universal app…");
    let listing = Command::new("/usr/bin/tar")
        .arg("-tzf")
        .arg(&archive)
        .output()
        .map_err(|e| e.to_string())?;
    if !listing.status.success() || !safe_archive(&String::from_utf8_lossy(&listing.stdout)) {
        return Err("Unsafe update archive".into());
    }
    command_ok(
        Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(stage.path()),
    )?;
    let bundle = stage.path().join("Mosaic.app");
    validate_bundle(&bundle, Some(&manifest.version))?;
    if state.cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    *state.download_manifest.lock().expect("update lock") = Some(manifest);
    *state.staging.lock().expect("update lock") = Some(stage);
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    #[test]
    fn rejects_unsigned_modified_and_wrong_key_manifests() {
        let signer = SigningKey::from_bytes(&[7; 32]);
        let key = signer
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        let bytes = br#"{"version":"0.18.0","bundle_id":"dev.jona.mosaic","minimum_macos":"12.0","architectures":["arm64","x86_64"],"archive":"Mosaic-0.18.0-universal.tar.gz","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":100,"date":"2026-10-08","notes":[]}"#;
        let signature =
            base64::engine::general_purpose::STANDARD.encode(signer.sign(bytes).to_bytes());
        assert!(verified_manifest(bytes, signature.as_bytes(), &key).is_ok());
        assert!(verified_manifest(b"{}", signature.as_bytes(), &key).is_err());
        assert!(verified_manifest(bytes, signature.as_bytes(), PUBLIC_KEY).is_err());
        assert!(verified_manifest(bytes, b"", &key).is_err());
    }
    #[test]
    fn refuses_archive_escape_and_non_universal_executables() {
        assert!(safe_archive(
            "Mosaic.app/\nMosaic.app/Contents/Info.plist\n"
        ));
        assert!(!safe_archive("Mosaic.app/../../vault\n"));
        assert!(!safe_archive("/Applications/Mosaic.app"));
        assert!(!universal_macho(&[0; 40]));
        assert!(!safe_archive(""));
    }
}
