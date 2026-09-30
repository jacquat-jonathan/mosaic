//! The single operation set every front end (Tauri app, CLI, MCP server) maps onto. It keeps the
//! vault and its index consistent: every write re-indexes the touched files.

use crate::error::{Error, Result};
use crate::index::{Backlink, Index, OutLink, SearchHit, SyncStats, TagCount};
use crate::kind::FileKind;
use crate::links::{FileSet, markdown_url_for, wiki_text_for};
use crate::parse::{self, Heading, LinkKind};
use crate::vault::{Entry, FileContent, Vault, Written, normalize};
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, MutexGuard};

pub struct Workspace {
    pub vault: Vault,
    index: Mutex<Index>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Renamed {
    pub path: String,
    /// Other files whose links were rewritten to follow the move.
    pub updated_links_in: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Outline {
    pub path: String,
    pub kind: FileKind,
    pub title: String,
    pub frontmatter: Option<String>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub headings: Vec<Heading>,
    pub links: Vec<OutLink>,
    pub backlinks: Vec<Backlink>,
    pub size: u64,
    pub hash: String,
}

impl Workspace {
    pub fn new(vault: Vault, index: Index) -> Self {
        Workspace {
            vault,
            index: Mutex::new(index),
        }
    }

    /// Opens a vault with its index in the default cache location (in memory if that fails).
    pub fn open(root: impl AsRef<std::path::Path>) -> Result<Self> {
        let vault = Vault::open(root)?;
        let index = Index::open_for(&vault).or_else(|_| Index::in_memory())?;
        Ok(Self::new(vault, index))
    }

    pub fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn sync(&self, progress: impl FnMut(usize, usize)) -> Result<SyncStats> {
        self.index().sync(&self.vault, progress)
    }

    /// Re-indexes a path after a change made outside this API (file watcher).
    pub fn refresh(&self, path: &str) -> Result<()> {
        self.index().update_path(&self.vault, path)
    }

    fn reindex(&self, path: &str) {
        // Index errors never fail a successful file operation; the next sync repairs them.
        let _ = self.index().update_path(&self.vault, path);
    }

    pub fn list(&self, dir: &str, recursive: bool) -> Result<Vec<Entry>> {
        self.vault.list(dir, recursive)
    }

    pub fn read(&self, path: &str) -> Result<FileContent> {
        self.vault.read(path)
    }

    pub fn create(&self, path: &str, content: &str) -> Result<Written> {
        let w = self.vault.create(path, content)?;
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn write(&self, path: &str, content: &str, expected_hash: Option<&str>) -> Result<Written> {
        let w = self.vault.write(path, content, expected_hash)?;
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn append(&self, path: &str, content: &str) -> Result<Written> {
        let w = self.vault.append(path, content)?;
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn patch(
        &self,
        path: &str,
        find: &str,
        replace: &str,
        expected_hash: Option<&str>,
    ) -> Result<Written> {
        let w = self.vault.patch(path, find, replace, expected_hash)?;
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn copy(&self, from: &str, to: &str) -> Result<Written> {
        let w = self.vault.copy(from, to)?;
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn mkdir(&self, path: &str) -> Result<()> {
        self.vault.mkdir(path)
    }

    pub fn delete(&self, path: &str) -> Result<()> {
        let norm = normalize(path)?;
        self.vault.delete(&norm)?;
        self.reindex(&norm);
        Ok(())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        self.index().search(query, limit)
    }

    pub fn backlinks(&self, path: &str) -> Result<Vec<Backlink>> {
        self.index().backlinks(&normalize(path)?)
    }

    pub fn tags(&self) -> Result<Vec<TagCount>> {
        self.index().tags()
    }

    pub fn paths_with_tag(&self, tag: &str) -> Result<Vec<String>> {
        self.index().paths_with_tag(tag)
    }

    pub fn aliases(&self) -> Result<Vec<(String, String)>> {
        self.index().aliases()
    }

    /// Cheap structural overview of a file — what an AI should read before deciding to load it all.
    pub fn outline(&self, path: &str) -> Result<Outline> {
        let file = self.vault.read(path)?;
        let (title, fm, aliases, tags, headings) = match (&file.content, file.kind) {
            (Some(text), FileKind::Markdown) => {
                let p = parse::parse(text);
                (
                    parse::title(&p, &file.path),
                    p.frontmatter,
                    p.aliases,
                    p.tags,
                    p.headings,
                )
            }
            _ => (
                crate::links::file_name(&file.path).to_string(),
                None,
                vec![],
                vec![],
                vec![],
            ),
        };
        let index = self.index();
        Ok(Outline {
            links: index.outlinks(&file.path)?,
            backlinks: index.backlinks(&file.path)?,
            path: file.path,
            kind: file.kind,
            size: file.size,
            hash: file.hash,
            title,
            frontmatter: fm,
            aliases,
            tags,
            headings,
        })
    }

    /// Moves or renames a file or folder. With `update_links`, every link pointing at a moved file
    /// (and relative Markdown links inside moved notes) is rewritten, as Obsidian does.
    pub fn rename(&self, from: &str, to: &str, update_links: bool) -> Result<Renamed> {
        let from = normalize(from)?;
        let to_n = normalize(to)?;
        let src_entry = self.vault.stat(&from)?;
        let moved: Vec<String> = if src_entry.is_dir {
            self.vault
                .list(&from, true)?
                .into_iter()
                .filter(|e| !e.is_dir)
                .map(|e| e.path)
                .collect()
        } else {
            vec![from.clone()]
        };
        let map_path = |p: &str| -> String {
            if p == from {
                to_n.clone()
            } else if let Some(rest) = p.strip_prefix(&format!("{from}/")) {
                format!("{to_n}/{rest}")
            } else {
                p.to_string()
            }
        };

        // Gather what needs rewriting before anything moves.
        let (old_set, sources, all_paths) = if update_links {
            let index = self.index();
            let old_set = index.file_set()?;
            let mut sources: BTreeSet<String> = BTreeSet::new();
            for p in &moved {
                for b in index.backlinks(p)? {
                    sources.insert(b.source);
                }
                if p.to_lowercase().ends_with(".md") {
                    sources.insert(p.clone());
                }
            }
            let all_paths: Vec<String> = self
                .vault
                .list("", true)?
                .into_iter()
                .filter(|e| !e.is_dir)
                .map(|e| e.path)
                .collect();
            (Some(old_set), sources, all_paths)
        } else {
            (None, BTreeSet::new(), vec![])
        };

        let out = self.vault.rename(&from, &to_n)?;
        let mut updated = Vec::new();

        if let Some(old_set) = old_set {
            let moved_map: HashMap<String, String> =
                moved.iter().map(|p| (p.clone(), map_path(p))).collect();
            let new_paths: Vec<String> = all_paths.iter().map(|p| map_path(p)).collect();
            let new_set = FileSet::new(new_paths.iter().map(String::as_str), std::iter::empty());
            for old_src in &sources {
                let new_src = map_path(old_src);
                let src_moved = moved_map.contains_key(old_src);
                if self.rewrite_links(
                    &old_set, &new_set, old_src, &new_src, src_moved, &moved_map, &map_path,
                )? {
                    updated.push(new_src);
                }
            }
        }

        self.reindex(&from);
        self.reindex(&out);
        for p in &updated {
            self.reindex(p);
        }
        Ok(Renamed {
            path: out,
            updated_links_in: updated,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn rewrite_links(
        &self,
        old_set: &FileSet,
        new_set: &FileSet,
        old_src: &str,
        new_src: &str,
        src_moved: bool,
        moved: &HashMap<String, String>,
        map_path: &dyn Fn(&str) -> String,
    ) -> Result<bool> {
        let file = match self.vault.read(new_src) {
            Ok(f) => f,
            Err(Error::NotFound(_)) | Err(Error::NotText(_)) => return Ok(false),
            Err(e) => return Err(e),
        };
        let Some(text) = file.content else {
            return Ok(false);
        };
        let new_text = match file.kind {
            FileKind::Markdown => {
                let parsed = parse::parse(&text);
                let mut edits: Vec<((usize, usize), String)> = Vec::new();
                for l in &parsed.links {
                    let markdown = l.kind == LinkKind::Markdown;
                    let Some(target) = old_set.resolve(&l.target, Some(old_src), markdown) else {
                        continue;
                    };
                    let target_moved = moved.contains_key(&target);
                    // Relative Markdown links in a moved note break even if their target stayed put.
                    if !target_moved && !(src_moved && markdown) {
                        continue;
                    }
                    let new_target = map_path(&target);
                    let replacement = if markdown {
                        markdown_url_for(&new_target, new_src)
                    } else {
                        let current = new_set.resolve(&l.target, Some(new_src), false);
                        if current.as_deref() == Some(new_target.as_str()) {
                            continue; // still resolves: leave the user's text alone
                        }
                        wiki_text_for(new_set, &new_target, Some(new_src))
                    };
                    edits.push((l.target_range, replacement));
                }
                if edits.is_empty() {
                    return Ok(false);
                }
                let mut t = text.clone();
                edits.sort_by_key(|e| std::cmp::Reverse(e.0.0));
                for ((s, e), r) in edits {
                    t.replace_range(s..e, &r);
                }
                t
            }
            FileKind::Canvas => {
                let mut t = text.clone();
                for (old, new) in moved {
                    let old_json = serde_json::to_string(old).unwrap_or_default();
                    let new_json = serde_json::to_string(new).unwrap_or_default();
                    let re = Regex::new(&format!(r#"("file"\s*:\s*){}"#, regex::escape(&old_json)))
                        .expect("valid regex");
                    t = re
                        .replace_all(&t, |c: &regex::Captures| format!("{}{}", &c[1], new_json))
                        .into_owned();
                }
                if t == text {
                    return Ok(false);
                }
                t
            }
            _ => return Ok(false),
        };
        self.vault.write(new_src, &new_text, Some(&file.hash))?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::tests::fixture;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let (d, v) = fixture();
        let w = Workspace::new(v, Index::in_memory().unwrap());
        w.sync(|_, _| {}).unwrap();
        (d, w)
    }

    fn text(w: &Workspace, p: &str) -> String {
        w.read(p).unwrap().content.unwrap()
    }

    #[test]
    fn writes_are_indexed_immediately() {
        let (_d, w) = ws();
        w.create("New.md", "Links to [[Ideas]] about #zebra")
            .unwrap();
        assert_eq!(w.search("zebra", 5).unwrap()[0].path, "New.md");
        assert!(
            w.backlinks("Ideas.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "New.md")
        );
        w.patch("New.md", "zebra", "okapi", None).unwrap();
        assert!(w.search("zebra", 5).unwrap().is_empty());
    }

    #[test]
    fn renaming_a_note_updates_links_everywhere() {
        let (_d, w) = ws();
        let r = w
            .rename("Ideas.md", "Thoughts/Brainstorm.md", true)
            .unwrap();
        assert_eq!(r.path, "Thoughts/Brainstorm.md");
        let home = text(&w, "Home.md");
        assert!(
            home.contains("[[Brainstorm]] and [[Brainstorm#Later]]"),
            "{home}"
        );
        let plan = text(&w, "Projects/Mosaic/Plan.md");
        assert!(plan.contains("[[Brainstorm^later-block]]"), "{plan}");
        assert!(
            plan.contains("[Ideas](../../Thoughts/Brainstorm.md)"),
            "{plan}"
        );
        let canvas = text(&w, "Board.canvas");
        assert!(
            canvas.contains("\"file\":\"Thoughts/Brainstorm.md\""),
            "{canvas}"
        );
        assert!(r.updated_links_in.contains(&"Home.md".to_string()));
        assert!(
            w.backlinks("Thoughts/Brainstorm.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "Home.md")
        );
    }

    #[test]
    fn moving_a_note_fixes_its_own_relative_markdown_links() {
        let (_d, w) = ws();
        w.rename("Projects/Mosaic/Plan.md", "Plan.md", true)
            .unwrap();
        let plan = text(&w, "Plan.md");
        assert!(plan.contains("[Ideas](Ideas.md)"), "{plan}");
        // Home linked with the full path; it now resolves by name.
        assert!(text(&w, "Home.md").contains("[[Plan|the plan]]"));
    }

    #[test]
    fn renaming_a_folder_updates_links_into_it() {
        let (_d, w) = ws();
        w.rename("Projects", "Work", true).unwrap();
        // Only one "Plan" exists, so the shortest form is used (Obsidian's default).
        assert!(text(&w, "Home.md").contains("[[Plan|the plan]]"));
        assert!(
            w.backlinks("Work/Mosaic/Plan.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "Home.md")
        );
        assert!(
            w.backlinks("Ideas.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "Work/Mosaic/Plan.md")
        );
    }

    #[test]
    fn unrelated_files_and_frontmatter_are_untouched() {
        let (_d, w) = ws();
        let before = text(&w, "Daily/2026-09-30.md");
        w.rename("Ideas.md", "Ideas2.md", true).unwrap();
        assert_eq!(text(&w, "Daily/2026-09-30.md"), before);
        assert!(text(&w, "Home.md").starts_with(
            "---\naliases: [Start, Index]\ntags: [hub]\ncustom_key: keep me exactly\n---"
        ));
    }

    #[test]
    fn outline_summarises_a_note() {
        let (_d, w) = ws();
        let o = w.outline("Home.md").unwrap();
        assert_eq!(o.title, "Home");
        assert_eq!(o.aliases, vec!["Start", "Index"]);
        assert!(
            o.links
                .iter()
                .any(|l| l.resolved.as_deref() == Some("Ideas.md"))
        );
        assert!(o.backlinks.iter().any(|b| b.source == "Ideas.md"));
    }
}
