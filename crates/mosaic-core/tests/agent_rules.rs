use mosaic_core::settings::{Access, AgentRule};
use mosaic_core::vault_state::VaultState;
use mosaic_core::{Error, Workspace, history::Source};

/// An isolated process keeps these tests away from the person's real settings and other tests.
#[test]
fn agents_get_the_vaults_rules_once_per_request_and_are_refused_when_they_cant_be_read() {
    if std::env::var_os("MOSAIC_AGENT_RULES_TEST_CHILD").is_none() {
        let settings = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agents_get_the_vaults_rules_once_per_request_and_are_refused_when_they_cant_be_read",
                "--nocapture",
            ])
            .env("MOSAIC_AGENT_RULES_TEST_CHILD", "1")
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
    let hide = |path: &str| AgentRule {
        path: path.into(),
        access: Access::Hidden,
        written_as: None,
    };
    let dir = tempfile::tempdir().unwrap();
    let app = Workspace::open(dir.path()).unwrap();
    app.create("Private/Salary.md", "s").unwrap();
    app.create("Public/Plan.md", "p").unwrap();
    let state = VaultState::open(app.vault.root()).unwrap();
    state.set_rules(vec![hide("Private")]).unwrap();

    let agent = Workspace::open(dir.path())
        .unwrap()
        .with_source(Source::Agent);
    assert!(matches!(
        agent.read("Private/Salary.md"),
        Err(Error::NotFound(_))
    ));
    assert!(agent.read("Public/Plan.md").is_ok());

    // During one request the rules it started with apply, even if the person edits them.
    {
        let request = agent.freeze_rules();
        assert!(request.read("Public/Plan.md").is_ok());
        state
            .set_rules(vec![hide("Private"), hide("Public")])
            .unwrap();
        assert!(request.read("Public/Plan.md").is_ok());
    }
    assert!(matches!(
        agent.read("Public/Plan.md"),
        Err(Error::NotFound(_))
    ));

    // Rules that can't be read pause agents instead of letting them see everything.
    let rules = std::path::Path::new(&std::env::var_os("MOSAIC_SETTINGS_DIR").unwrap())
        .join("vaults")
        .join(
            mosaic_core::vault_id::peek(app.vault.root())
                .unwrap()
                .unwrap()
                .id,
        )
        .join(mosaic_core::vault_state::RULES_FILE);
    std::fs::write(rules, "[{ half written").unwrap();
    assert!(matches!(
        agent.read("Private/Salary.md"),
        Err(Error::Denied(_))
    ));
    assert!(matches!(
        agent.read("Public/Plan.md"),
        Err(Error::Denied(_))
    ));
    assert!(app.read("Private/Salary.md").is_ok());
}
