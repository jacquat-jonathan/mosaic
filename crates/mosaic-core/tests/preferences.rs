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
    wa.files.create("Agents/Old.md", "Old agent").unwrap();
    wa.files
        .create(
            "People/Review/SKILL.md",
            "---\nname: review\ncustom: preserved\n---\nReview notes\n",
        )
        .unwrap();
    assert!(!wa.vault_preferences().unwrap().daily_notes_enabled);
    assert!(!wa.vault_preferences().unwrap().allow_html_scripts);
    assert!(!wa.vault_preferences().unwrap().allow_html_internet);
    wa.set_vault_preferences(json!({"daily_notes_enabled":true,"agents_folder":"People","daily_folder":"Journal","daily_format":"DD-MM-YYYY","allow_html_scripts":true,"allow_html_internet":true,"future":{"keep":true},"folder_colors":{"People":"purple"}})).unwrap();
    assert!(wa.vault_preferences().unwrap().daily_notes_enabled);
    assert!(!wb.vault_preferences().unwrap().daily_notes_enabled);
    assert!(wa.vault_preferences().unwrap().allow_html_scripts);
    assert!(wa.vault_preferences().unwrap().allow_html_internet);
    assert!(!wb.vault_preferences().unwrap().allow_html_internet);
    assert_eq!(wa.agents().unwrap().len(), 1);
    assert_eq!(wa.agents().unwrap()[0].name, "review");
    assert!(wa.files.read("Agents/Old.md").is_ok());
    assert_eq!(wb.vault_preferences().unwrap().agents_folder, "Agents");
    wa.mirror_agents().unwrap();
    assert!(a.path().join(".claude/skills/review/SKILL.md").exists());
    wa.files
        .create("Journal/07-10-2026.md", "# 2026-10-07\n- [ ] Carry me\n")
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
    wa.files
        .create("Legacy/2026-10-08.md", "Legacy daily\n")
        .unwrap();
    assert!(wa.days("2026-10-08", "2026-10-08", "2026-10-08").is_err());
    assert!(wa.carry_over("2026-10-08", None, None).is_err());
    wa.files.rename("People", "Staff", true).unwrap();
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

/// Runs `test` in a child process with its own settings folder (see above).
fn isolated(name: &str) -> bool {
    if std::env::var_os("MOSAIC_PREFERENCES_TEST_CHILD").is_some() {
        return true;
    }
    let settings = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
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
    false
}

fn hidden(path: &str) -> mosaic_core::settings::AgentRule {
    mosaic_core::settings::AgentRule {
        path: path.into(),
        access: mosaic_core::settings::Access::Hidden,
        written_as: None,
    }
}

#[test]
fn agents_change_vault_preferences_with_scope_revision_and_app_rules() {
    if !isolated("agents_change_vault_preferences_with_scope_revision_and_app_rules") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let app = Workspace::open(dir.path()).unwrap();
    app.set_vault_preferences(json!({"folder_colors":{"Private":"red","Projects":"green"}}))
        .unwrap();
    let agent = || {
        Workspace::open(dir.path())
            .unwrap()
            .with_source(Source::Agent)
            .with_agent_rules(vec![hidden("Private")])
    };
    let a = agent();
    let read = a.revised_vault_preferences().unwrap();
    // A hidden folder's color isn't shown, so its name doesn't leak.
    assert_eq!(read.value.folder_colors.len(), 1);
    assert_eq!(read.value.folder_colors["Projects"], "green");

    // Under an allowlist without `settings:`, refused before anything changes.
    let restricted = agent().with_change_allowlist(vec!["Daily".into(), "planner:".into()]);
    let e = restricted
        .change_vault_preferences(json!({"link_style":"markdown"}), &read.revision)
        .unwrap_err();
    assert_eq!(e.code(), "denied");
    assert!(e.to_string().contains("`settings:`"));
    assert_eq!(app.vault_preferences().unwrap().link_style, "wiki");

    // With it (or with no allowlist), applied; folder colors merge per folder.
    let allowed = agent().with_change_allowlist(vec!["Daily".into(), "Settings:".into()]);
    let changed = allowed
        .change_vault_preferences(
            json!({"link_style":"markdown","folder_colors":{"Projects":null,"Areas":"blue"}}),
            &read.revision,
        )
        .unwrap();
    assert_ne!(changed.revision, read.revision);
    let stored = app.vault_preferences().unwrap();
    assert_eq!(stored.link_style, "markdown");
    assert_eq!(
        stored.folder_colors,
        [("Areas", "blue"), ("Private", "red")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    );
    assert_eq!(changed.value.folder_colors.len(), 1);

    // A revision read before the change is stale.
    let e = a
        .change_vault_preferences(json!({"link_style":"wiki"}), &read.revision)
        .unwrap_err();
    assert_eq!(e.code(), "conflict");
    assert_eq!(app.vault_preferences().unwrap().link_style, "markdown");
    let now = a.revised_vault_preferences().unwrap().revision;
    assert_eq!(now, changed.revision);

    // The app's validation, and the preferences agents can't set.
    for (patch, code) in [
        (json!({"folder_colors":{"Areas":"pink"}}), "invalid"),
        (json!({"daily_format":"MM/DD"}), "invalid"),
        (json!({"daily_folder":"../outside"}), "invalid_path"),
        (json!({"agents_folder":"Daily"}), "invalid"),
        (json!({"allow_html_scripts":true}), "invalid"),
        (json!({"allow_html_internet":true}), "invalid"),
        (json!({"future":1}), "invalid"),
        (json!({}), "invalid"),
        (json!({"folder_colors":{"Private":null}}), "not_found"),
        (json!({"daily_folder":"Private/Days"}), "not_found"),
    ] {
        let e = a.change_vault_preferences(patch.clone(), &now).unwrap_err();
        assert_eq!(e.code(), code, "{patch}: {e}");
    }
    let stored = app.vault_preferences().unwrap();
    assert_eq!(stored.agents_folder, "Agents");
    assert!(!stored.allow_html_scripts);
    assert_eq!(stored.folder_colors["Private"], "red");
    assert_eq!(a.revised_vault_preferences().unwrap().revision, now);
}

#[test]
fn agents_change_template_defaults_and_read_but_never_write_folder_rules() {
    if !isolated("agents_change_template_defaults_and_read_but_never_write_folder_rules") {
        return;
    }
    use mosaic_core::templates::{TemplateConfig, TemplateRule};
    let dir = tempfile::tempdir().unwrap();
    let app = Workspace::open(dir.path()).unwrap();
    let rule = |folder: &str, template: Option<&str>| TemplateRule {
        folder: folder.into(),
        template: template.map(str::to_string),
    };
    app.set_template_config(TemplateConfig {
        rules: vec![
            rule("Meetings", Some("Templates/Meeting.md")),
            rule("Private", Some("Templates/Secret.md")),
        ],
        ..Default::default()
    })
    .unwrap();
    let agent = || {
        Workspace::open(dir.path())
            .unwrap()
            .with_source(Source::Agent)
            .with_agent_rules(vec![
                hidden("Private"),
                hidden("Templates/Secret.md"),
                mosaic_core::settings::AgentRule {
                    path: "Archive".into(),
                    access: mosaic_core::settings::Access::ReadOnly,
                    written_as: None,
                },
                mosaic_core::settings::AgentRule {
                    path: "Private/Notes".into(),
                    access: mosaic_core::settings::Access::ReadOnly,
                    written_as: None,
                },
            ])
    };
    let a = agent();
    let read = a.revised_template_config().unwrap();
    assert_eq!(
        read.value.rules,
        vec![rule("Meetings", Some("Templates/Meeting.md"))]
    );

    let wanted = TemplateConfig {
        rules: vec![
            rule("Projects", Some("Templates/Project.md")),
            rule("Inbox", None),
        ],
        ..Default::default()
    };
    let e = agent()
        .with_change_allowlist(vec!["Daily".into()])
        .change_template_config(wanted.clone(), &read.revision)
        .unwrap_err();
    assert_eq!(e.code(), "denied");
    assert!(e.to_string().contains("`settings:`"));

    let changed = agent()
        .with_change_allowlist(vec!["settings:".into()])
        .change_template_config(wanted.clone(), &read.revision)
        .unwrap();
    assert_eq!(changed.value.rules, wanted.rules);
    // The rule the agent can't see is kept.
    let stored = app.template_config().unwrap();
    assert_eq!(stored.rules.len(), 3);
    assert!(
        stored
            .rules
            .contains(&rule("Private", Some("Templates/Secret.md")))
    );

    assert_eq!(
        a.change_template_config(wanted.clone(), &read.revision)
            .unwrap_err()
            .code(),
        "conflict"
    );
    let now = changed.revision;
    for (config, code) in [
        (
            TemplateConfig {
                rules: vec![rule("Projects", Some("Elsewhere/Project.md"))],
                ..Default::default()
            },
            "invalid",
        ),
        (
            TemplateConfig {
                rules: vec![rule("A", None), rule("a", None)],
                ..Default::default()
            },
            "invalid",
        ),
        (
            TemplateConfig {
                folder: String::new(),
                ..Default::default()
            },
            "invalid_path",
        ),
        (
            TemplateConfig {
                rules: vec![rule("Private/Sub", None)],
                ..Default::default()
            },
            "not_found",
        ),
    ] {
        let e = a.change_template_config(config, &now).unwrap_err();
        assert_eq!(e.code(), code, "{e}");
    }
    assert_eq!(a.revised_template_config().unwrap().revision, now);

    // Folder rules: readable, minus the ones that would name a hidden folder.
    let view = a.agent_rules_view().unwrap();
    let paths: Vec<&str> = view.rules.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths, ["Archive"]);
    assert_eq!(view.hidden_rules, 3);
}
