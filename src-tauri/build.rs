use std::path::Path;
use std::process::Command;

fn main() {
    // Remember where and from which commit this app was built, for Settings › About & updates.
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent");
    println!("cargo:rustc-env=MOSAIC_SOURCE_DIR={}", repo.display());
    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(repo)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=MOSAIC_COMMIT={commit}");
    for p in [".git/HEAD", ".git/refs/heads", ".git/packed-refs"] {
        println!("cargo:rerun-if-changed={}", repo.join(p).display());
    }
    tauri_build::build()
}
