//! Property tests for the paths and folder rules that keep agents out of hidden folders: random
//! spellings (case, NFC/NFD, `.`, doubled slashes, `..`) must never reach a file a rule protects.

use mosaic_core::history::Source;
use mosaic_core::index::Index;
use mosaic_core::settings::{Access, AgentRule, access_for};
use mosaic_core::vault::normalize;
use mosaic_core::{Vault, Workspace};
use proptest::prelude::*;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

const CAFE_NFC: &str = "Caf\u{e9}";
const CAFE_NFD: &str = "Cafe\u{301}";

fn segment() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("Private".to_string()),
        Just("Notes".to_string()),
        Just(CAFE_NFC.to_string()),
        Just(CAFE_NFD.to_string()),
        Just("a b".to_string()),
        Just(".".to_string()),
        Just("..".to_string()),
        Just("".to_string()),
        Just(".git".to_string()),
        "[A-Za-z]{1,6}",
    ]
}

/// The same name, spelled differently: random upper/lower case, NFC or NFD.
fn respell(name: &str, flips: &[bool], nfd: bool) -> String {
    let cased: String = name
        .chars()
        .zip(flips.iter().cycle())
        .map(|(c, flip)| {
            if *flip {
                c.to_uppercase().collect::<String>()
            } else {
                c.to_lowercase().collect()
            }
        })
        .collect();
    if nfd {
        cased.nfd().collect()
    } else {
        cased.nfc().collect()
    }
}

fn access() -> impl Strategy<Value = Access> {
    prop_oneof![
        Just(Access::Hidden),
        Just(Access::ReadOnly),
        Just(Access::Review)
    ]
}

fn rules() -> impl Strategy<Value = Vec<AgentRule>> {
    prop::collection::vec(
        (prop::collection::vec(segment(), 1..3), access()).prop_map(|(parts, access)| AgentRule {
            path: parts.join("/"),
            access,
            written_as: None,
        }),
        0..4,
    )
}

/// The strictest covering rule, computed independently of `access_for`.
fn expected(rules: &[AgentRule], path: &str) -> Option<Access> {
    let key = |s: &str| {
        s.nfc()
            .collect::<String>()
            .to_lowercase()
            .nfc()
            .collect::<String>()
    };
    let p = key(path);
    let covering: Vec<Access> = rules
        .iter()
        .filter(|r| {
            let r = key(&r.path);
            r.is_empty() || p == r || p.starts_with(&format!("{r}/"))
        })
        .map(|r| r.access)
        .collect();
    [Access::Hidden, Access::ReadOnly, Access::Review]
        .into_iter()
        .find(|a| covering.contains(a))
}

proptest! {
    #[test]
    fn normalized_paths_are_plain_relative_and_stable(parts in prop::collection::vec(segment(), 0..6), lead in prop::bool::ANY) {
        let raw = format!("{}{}", if lead { "/" } else { "" }, parts.join("/"));
        let absolute = raw.trim().starts_with('/');
        match normalize(&raw) {
            Ok(norm) => {
                prop_assert!(!absolute);
                prop_assert!(norm.split('/').all(|s| norm.is_empty() || (!s.is_empty() && !s.starts_with('.'))));
                prop_assert_eq!(normalize(&norm).unwrap(), norm);
            }
            Err(_) => prop_assert!(absolute || parts.iter().any(|p| p.starts_with('.') && p != ".")),
        }
    }

    #[test]
    fn the_strictest_covering_rule_applies_however_the_path_is_spelled(
        rules in rules(),
        parts in prop::collection::vec(segment(), 1..4),
        flips in prop::collection::vec(prop::bool::ANY, 1..8),
        nfd in prop::bool::ANY,
    ) {
        let path = parts.join("/");
        let other = respell(&path, &flips, nfd);
        prop_assert_eq!(access_for(&rules, &path), expected(&rules, &path));
        prop_assert_eq!(access_for(&rules, &other), access_for(&rules, &path));
    }
}

/// A vault with a hidden and a read-only folder, shared by every case (only read by agents).
fn vault() -> &'static (tempfile::TempDir, Workspace) {
    static VAULT: OnceLock<(tempfile::TempDir, Workspace)> = OnceLock::new();
    VAULT.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in [
            ("Private/Salary.md", "secret"),
            (&format!("{CAFE_NFC}/Menu.md") as &str, "menu"),
            ("Notes/Plan.md", "plan"),
        ] {
            let file = dir.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        let ws = Workspace::new(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
        )
        .with_source(Source::Agent)
        .with_agent_rules(vec![
            AgentRule {
                path: "private".into(),
                access: Access::Hidden,
                written_as: None,
            },
            AgentRule {
                path: CAFE_NFD.to_lowercase(),
                access: Access::ReadOnly,
                written_as: None,
            },
        ]);
        (dir, ws)
    })
}

proptest! {
    #[test]
    fn no_spelling_of_a_protected_path_reads_hidden_files_or_writes_read_only_ones(
        target in 0usize..3,
        flips in prop::collection::vec(prop::bool::ANY, 1..8),
        nfd in prop::bool::ANY,
        dots in prop::collection::vec(prop::bool::ANY, 2),
    ) {
        let (dir, ws) = vault();
        let (folder, file) = [("Private", "Salary.md"), (CAFE_NFC, "Menu.md"), ("Notes", "Plan.md")][target];
        let mut path = respell(folder, &flips, nfd);
        if dots[0] { path = format!("./{path}"); }
        path.push_str(if dots[1] { "//" } else { "/" });
        path.push_str(&respell(file, &flips, nfd));

        let read = ws.files.read(&path);
        if target == 0 {
            prop_assert!(read.is_err(), "{path} read a hidden file");
        }
        if target == 1 {
            prop_assert!(ws.files.write(&path, "changed", None).is_err(), "{path} wrote a read-only file");
            prop_assert!(ws.files.append(&path, "changed").is_err());
        }
        prop_assert_eq!(std::fs::read_to_string(dir.path().join("Private/Salary.md")).unwrap(), "secret");
        prop_assert_eq!(std::fs::read_to_string(dir.path().join(format!("{CAFE_NFC}/Menu.md"))).unwrap(), "menu");
    }
}
