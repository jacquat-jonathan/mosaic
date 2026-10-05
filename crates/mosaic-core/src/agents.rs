//! Agents defined in the vault: files in `Agents/` that tell Claude how to act, so the person can
//! start one from the app's chat, a schedule, or any Claude Code session connected to Mosaic.
//!
//! An agent is either a note, `Agents/Weekly review.md`, or a Claude Code skill folder,
//! `Agents/Weekly review/SKILL.md` (which may hold other files the skill uses). Both have the same
//! shape: `name` and `description` in the frontmatter (the name defaults to the file or folder name,
//! the description to the first line of text), the instructions below. Mosaic's own fields:
//! `schedule` (when it runs on its own) and `may-change` (folders it may write without review).
//!
//! So Claude treats them as agents rather than documents, they're published as MCP prompts (slash
//! commands in Claude Code) and mirrored into the vault's `.claude/skills/`, where Claude Code
//! started in the vault finds them as skills: a note agent as a generated `SKILL.md`, a skill folder
//! as a link to it. A manifest lists what Mosaic made there, so it never touches other skills.

use crate::api::Workspace;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

/// The vault folder agents live in.
pub const AGENTS_DIR: &str = "Agents";
const SKILLS_DIR: &str = ".claude/skills";
const MANIFEST: &str = ".claude/skills/.mosaic-agents.json";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Agent {
    /// Lowercase with hyphens (`weekly-review`): the slash command and skill name.
    pub name: String,
    /// The file or folder name, for showing (`Weekly review`).
    pub title: String,
    pub description: String,
    /// The note, or the skill folder's `SKILL.md`.
    pub path: String,
    /// True for a skill folder (`Agents/X/SKILL.md`).
    pub skill_folder: bool,
    pub schedule: Option<String>,
    /// Folders it may change without review.
    pub may_change: Vec<String>,
    /// The body: what the agent does.
    pub instructions: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct MirrorReport {
    /// Skills written or updated in `.claude/skills/`.
    pub written: Vec<String>,
    /// Mirrored skills removed (their agent is gone).
    pub removed: Vec<String>,
    /// Agents left out: a name another agent already uses, or a skill Mosaic didn't make.
    pub skipped: Vec<String>,
}

/// `Weekly review!` → `weekly-review` (letters, digits and hyphens, at most 64).
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    out.chars().take(64).collect()
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Front {
    name: Option<String>,
    description: Option<String>,
    schedule: Option<String>,
    #[serde(rename = "may-change", alias = "may_change")]
    may_change: Option<serde_norway::Value>,
}

fn strings(v: &serde_norway::Value) -> Vec<String> {
    match v {
        serde_norway::Value::String(s) => vec![s.clone()],
        serde_norway::Value::Sequence(items) => items
            .iter()
            .filter_map(|i| i.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// Reads an agent from its file's text.
pub fn parse_agent(path: &str, title: &str, skill_folder: bool, text: &str) -> Agent {
    let (front, body) = match crate::parse::frontmatter_span(text) {
        Some((end, yaml)) => (
            serde_norway::from_str::<Front>(&yaml).unwrap_or_default(),
            &text[end..],
        ),
        None => (Front::default(), text),
    };
    let instructions = body.trim().to_string();
    let description = front
        .description
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| {
            instructions
                .lines()
                .map(|l| l.trim().trim_start_matches('#').trim())
                .find(|l| !l.is_empty())
                .unwrap_or(title)
                .to_string()
        });
    Agent {
        name: slug(front.name.as_deref().unwrap_or(title)),
        title: title.to_string(),
        description,
        path: path.to_string(),
        skill_folder,
        schedule: front.schedule.filter(|s| !s.trim().is_empty()),
        may_change: front
            .may_change
            .as_ref()
            .map(strings)
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.trim_matches('/').to_string())
            .collect(),
        instructions,
    }
}

/// The text an agent starts with, in a chat, a scheduled run or an MCP prompt.
pub fn agent_prompt(a: &Agent, request: Option<&str>) -> String {
    let mut out = format!(
        "Act as the agent \"{}\", defined in the Mosaic vault at `{}`. Follow its instructions below; they come from the person who owns the vault.\n",
        a.title, a.path
    );
    if !a.may_change.is_empty() {
        out.push_str(&format!(
            "It may change files in: {}. Anything else you change is proposed to the person for review.\n",
            a.may_change.join(", ")
        ));
    }
    out.push_str("\n---\n\n");
    out.push_str(&a.instructions);
    out.push('\n');
    if let Some(r) = request.map(str::trim).filter(|r| !r.is_empty()) {
        out.push_str(&format!("\n---\n\nThe person adds: {r}\n"));
    }
    out
}

impl Workspace {
    /// The vault's agents, by name. Two with the same name: the first (by path) wins.
    pub fn agents(&self) -> Result<Vec<Agent>> {
        let entries = match self.list(AGENTS_DIR, true) {
            Ok(e) => e,
            Err(Error::NotFound(_)) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let prefix = format!("{AGENTS_DIR}/");
        let mut found = Vec::new();
        for e in entries.iter().filter(|e| !e.is_dir) {
            let rest = &e.path[prefix.len()..];
            let parts: Vec<&str> = rest.split('/').collect();
            let (title, skill_folder) = match parts.as_slice() {
                [file] if file.to_lowercase().ends_with(".md") => {
                    (file[..file.len() - 3].to_string(), false)
                }
                [folder, file] if file.eq_ignore_ascii_case("SKILL.md") => {
                    (folder.to_string(), true)
                }
                _ => continue,
            };
            let Some(text) = self.read(&e.path)?.content else {
                continue;
            };
            found.push(parse_agent(&e.path, &title, skill_folder, &text));
        }
        found.sort_by(|a, b| a.path.cmp(&b.path));
        let mut seen = BTreeSet::new();
        found.retain(|a| !a.name.is_empty() && seen.insert(a.name.clone()));
        Ok(found)
    }

    /// One agent by name (or title, ignoring case).
    pub fn agent(&self, name: &str) -> Result<Agent> {
        let want = slug(name);
        self.agents()?
            .into_iter()
            .find(|a| a.name == want)
            .ok_or_else(|| Error::NotFound(format!("no agent named {name:?} in {AGENTS_DIR}/")))
    }

    /// Writes the agents into the vault's `.claude/skills/` (and removes the ones Mosaic made for
    /// agents that are gone), so Claude Code started in the vault knows them as skills.
    pub fn mirror_agents(&self) -> Result<MirrorReport> {
        let root = self.vault.root().to_path_buf();
        let io = |e: std::io::Error| Error::Io {
            path: SKILLS_DIR.into(),
            source: e,
        };
        let manifest_path = root.join(MANIFEST);
        let made: BTreeSet<String> = std::fs::read(&manifest_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let agents = self.agents()?;
        let mut report = MirrorReport::default();
        let mut now = BTreeSet::new();
        for a in &agents {
            let dir = root.join(SKILLS_DIR).join(&a.name);
            // Never overwrite a skill the person (or another tool) put there.
            if (dir.exists() || dir.is_symlink()) && !made.contains(&a.name) {
                report.skipped.push(a.name.clone());
                continue;
            }
            now.insert(a.name.clone());
            if a.skill_folder {
                // The whole folder, so files the skill refers to resolve: a relative link to it.
                let target =
                    Path::new("../..").join(Path::new(&a.path).parent().unwrap_or(Path::new("")));
                if std::fs::read_link(&dir).ok().as_deref() == Some(target.as_path()) {
                    continue;
                }
                remove(&dir).map_err(io)?;
                std::fs::create_dir_all(root.join(SKILLS_DIR)).map_err(io)?;
                std::os::unix::fs::symlink(&target, &dir).map_err(io)?;
            } else {
                let text = format!(
                    "---\nname: {}\ndescription: {}\n---\n\n<!-- Made by Mosaic from {}. Edit that note; this file is rewritten. -->\n\n{}\n",
                    a.name,
                    serde_json::to_string(&a.description).unwrap_or_default(),
                    a.path,
                    a.instructions
                );
                let file = dir.join("SKILL.md");
                if dir.is_symlink() {
                    remove(&dir).map_err(io)?;
                }
                if std::fs::read_to_string(&file).ok().as_deref() == Some(text.as_str()) {
                    continue;
                }
                std::fs::create_dir_all(&dir).map_err(io)?;
                std::fs::write(&file, text).map_err(io)?;
            }
            report.written.push(a.name.clone());
        }
        for gone in made.difference(&now) {
            remove(&root.join(SKILLS_DIR).join(gone)).map_err(io)?;
            report.removed.push(gone.clone());
        }
        if !now.is_empty() || !made.is_empty() {
            std::fs::create_dir_all(root.join(SKILLS_DIR)).map_err(io)?;
            std::fs::write(
                &manifest_path,
                serde_json::to_vec_pretty(&now).unwrap_or_default(),
            )
            .map_err(io)?;
        }
        Ok(report)
    }
}

/// Removes a mirrored skill: a link, or a folder Mosaic wrote.
fn remove(p: &Path) -> std::io::Result<()> {
    if p.is_symlink() || p.is_file() {
        std::fs::remove_file(p)
    } else if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;
    use crate::vault::Vault;

    fn ws(files: &[(&str, &str)]) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let full = dir.path().join(p);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, c).unwrap();
        }
        let w = Workspace::with_history_file(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
            &dir.path().join(".history-test.db"),
        );
        (dir, w)
    }

    #[test]
    fn agents_from_notes_and_skill_folders() {
        let (_d, w) = ws(&[
            (
                "Agents/Weekly review.md",
                "---\ndescription: Sum up the week\nschedule: fri 17:00\nmay-change: [Daily/, Reviews]\n---\n# Weekly review\n\nRead this week's daily notes.\n",
            ),
            (
                "Agents/Inbox triage/SKILL.md",
                "---\nname: triage\n---\nSort meeting notes into projects.\n",
            ),
            ("Agents/Inbox triage/reference.md", "Not an agent"),
            ("Agents/Deep/Nested/x.md", "Not an agent"),
            ("Agents/weekly-review.md", "A duplicate name"),
            ("Notes/Other.md", "Not in Agents"),
        ]);
        let a = w.agents().unwrap();
        let names: Vec<&str> = a.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["triage", "weekly-review"]);
        let wr = &a[1];
        assert_eq!(
            (
                wr.title.as_str(),
                wr.description.as_str(),
                wr.schedule.as_deref(),
                wr.skill_folder
            ),
            ("Weekly review", "Sum up the week", Some("fri 17:00"), false)
        );
        assert_eq!(wr.may_change, ["Daily", "Reviews"]);
        assert_eq!(a[0].description, "Sort meeting notes into projects.");
        assert!(a[0].skill_folder);
        assert_eq!(
            w.agent("Weekly Review").unwrap().path,
            "Agents/Weekly review.md"
        );
        assert!(w.agent("nope").is_err());
        let p = agent_prompt(wr, Some("focus on project Site"));
        assert!(
            p.contains("\"Weekly review\"")
                && p.contains("Read this week's daily notes.")
                && p.contains("may change files in: Daily, Reviews")
                && p.ends_with("focus on project Site\n")
        );
        // No Agents folder: no agents.
        let (_e, empty) = ws(&[("A.md", "")]);
        assert!(empty.agents().unwrap().is_empty());
    }

    #[test]
    fn mirror_writes_links_and_cleans_only_its_own() {
        let (d, w) = ws(&[
            ("Agents/Weekly review.md", "Read the daily notes.\n"),
            (
                "Agents/Triage/SKILL.md",
                "---\ndescription: Sort notes\n---\nSort.\n",
            ),
            (".claude/skills/mine/SKILL.md", "A skill the person wrote"),
            ("Agents/Mine.md", "Clashes with the person's skill"),
        ]);
        let r = w.mirror_agents().unwrap();
        assert_eq!(r.written, ["triage", "weekly-review"]);
        assert_eq!(r.skipped, ["mine"]);
        let skills = d.path().join(".claude/skills");
        let note = std::fs::read_to_string(skills.join("weekly-review/SKILL.md")).unwrap();
        assert!(
            note.starts_with(
                "---\nname: weekly-review\ndescription: \"Read the daily notes.\"\n---"
            )
        );
        assert!(note.contains("Agents/Weekly review.md"));
        assert_eq!(
            std::fs::read_to_string(skills.join("triage/SKILL.md")).unwrap(),
            "---\ndescription: Sort notes\n---\nSort.\n"
        );
        assert!(skills.join("triage").is_symlink());
        // Unchanged: nothing rewritten.
        assert!(w.mirror_agents().unwrap().written.is_empty());
        // An agent removed: its mirror goes, the person's own skill stays.
        std::fs::remove_file(d.path().join("Agents/Weekly review.md")).unwrap();
        let r = w.mirror_agents().unwrap();
        assert_eq!(r.removed, ["weekly-review"]);
        assert!(!skills.join("weekly-review").exists());
        assert!(skills.join("mine/SKILL.md").exists());
        assert!(d.path().join("Agents/Triage/SKILL.md").exists());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Weekly review!"), "weekly-review");
        assert_eq!(slug("  Été — résumé  "), "été-résumé");
        assert_eq!(slug("--"), "");
    }
}
