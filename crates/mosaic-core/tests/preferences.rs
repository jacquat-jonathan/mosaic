use mosaic_core::{Workspace, history::Source, settings::Settings};
use serde_json::json;

/// An isolated process keeps preferences tests away from the person's real settings and other tests.
#[test]
fn vault_preferences_are_scoped_preserved_and_used_by_the_core() {
    if std::env::var_os("MOSAIC_PREFERENCES_TEST_CHILD").is_none() {
        let settings = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "vault_preferences_are_scoped_preserved_and_used_by_the_core",
                "--nocapture",
            ])
            .env("MOSAIC_PREFERENCES_TEST_CHILD", "1")
            .env("MOSAIC_SETTINGS_DIR", settings.path())
            .env("MOSAIC_CACHE_DIR", settings.path().join("cache"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let wa = Workspace::open(a.path()).unwrap();
    let wb = Workspace::open(b.path()).unwrap();
    wa.create("Agents/Old.md", "Old agent").unwrap();
    wa.create(
        "People/Review/SKILL.md",
        "---\nname: review\ncustom: preserved\n---\nReview notes\n",
    )
    .unwrap();
    wa.set_vault_preferences(json!({"agents_folder":"People","daily_folder":"Journal","daily_format":"DD-MM-YYYY","future":{"keep":true},"folder_colors":{"People":"purple"}})).unwrap();
    assert_eq!(wa.agents().unwrap().len(), 1);
    assert_eq!(wa.agents().unwrap()[0].name, "review");
    assert!(wa.read("Agents/Old.md").is_ok());
    assert_eq!(wb.vault_preferences().unwrap().agents_folder, "Agents");
    wa.mirror_agents().unwrap();
    assert!(a.path().join(".claude/skills/review/SKILL.md").exists());
    wa.create("Journal/07-10-2026.md", "# 2026-10-07\n- [ ] Carry me\n")
        .unwrap();
    assert_eq!(
        wa.days("2026-10-07", "2026-10-08", "2026-10-08")
            .unwrap()
            .days[0]
            .note
            .as_deref(),
        Some("Journal/07-10-2026.md")
    );
    let carried = wa.carry_over("2026-10-08", None, None).unwrap();
    assert_eq!(carried.to, "Journal/08-10-2026.md");
    assert_eq!(carried.moved, 1);
    wa.create("Legacy/2026-10-08.md", "Legacy daily\n").unwrap();
    assert!(wa.days("2026-10-08", "2026-10-08", "2026-10-08").is_err());
    assert!(wa.carry_over("2026-10-08", None, None).is_err());
    wa.rename("People", "Staff", true).unwrap();
    assert_eq!(wa.vault_preferences().unwrap().agents_folder, "Staff");
    assert_eq!(
        wa.vault_preferences().unwrap().folder_colors["Staff"],
        "purple"
    );
    wa.set_vault_preferences(json!({"link_style":"markdown"}))
        .unwrap();
    assert_eq!(
        Workspace::open(a.path())
            .unwrap()
            .vault_preferences()
            .unwrap()
            .agents_folder,
        "Staff"
    );
    assert_eq!(
        wa.vault_preferences().unwrap().other["future"],
        json!({"keep":true})
    );
    assert!(
        wa.set_vault_preferences(json!({"agents_folder":"../escape"}))
            .is_err()
    );
    assert!(
        Workspace::open(a.path())
            .unwrap()
            .with_source(Source::Cli)
            .set_vault_preferences(json!({"daily_folder":"X"}))
            .is_err()
    );
    let mut settings = Settings::try_load().unwrap();
    settings.vault_preferences.get_mut(wa.vault.root()).unwrap()["version"] = json!(99);
    settings.save().unwrap();
    assert!(wa.vault_preferences().is_err());
    assert!(wa.set_vault_preferences(json!({"version":1})).is_err());
    assert_eq!(
        Settings::try_load().unwrap().vault_preferences[wa.vault.root()]["version"],
        99
    );
}
