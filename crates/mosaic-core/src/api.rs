//! The single operation set every front end (Tauri app, CLI, MCP server) maps onto. It keeps the
//! vault and its index consistent: every write re-indexes the touched files.

use crate::error::{Error, Result};
use crate::history::{Action, History, Source, Version};
use crate::index::{Backlink, Index, OutLink, SearchHit, SyncStats, TagCount};
use crate::kind::FileKind;
use crate::links::{FileSet, markdown_url_for, wiki_text_for};
use crate::parse::{self, Heading, LinkKind};
use crate::settings::{Access, AgentRule, SETTINGS_FILE, Settings, access_for};
use crate::vault::{Entry, FileContent, Vault, Written, normalize};
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, MutexGuard};

pub struct Workspace {
    pub vault: Vault,
    index: Mutex<Index>,
    /// A read-only connection to the same index for queries, so a long sync doesn't block search.
    /// `None` for an in-memory index (tests), where queries use `index`.
    reader: Option<Mutex<Index>>,
    /// Versions of every file changed through this workspace (see `history`).
    history: Mutex<History>,
    /// Who changes files through this workspace: the app, the CLI or an agent.
    source: Source,
    /// The agent's name (MCP client), once known.
    actor: Mutex<Option<String>>,
    /// Folder rules for agents given directly instead of read from the settings (tests).
    fixed_rules: Option<Vec<AgentRule>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Renamed {
    pub path: String,
    /// Other files whose links were rewritten to follow the move.
    pub updated_links_in: Vec<String>,
}

/// A note that mentions another note's title or alias without linking to it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Mention {
    pub source: String,
    /// 1-based line number.
    pub line: usize,
    /// The line, for display.
    pub context: String,
    /// The words as written in the note (e.g. "the plan" for a note called "The Plan").
    pub text: String,
}

/// The mentions of `name` in `text` that aren't already links: (line number, byte offset in the
/// line, matched text). Frontmatter, code and existing links don't count; matches are whole words.
pub fn find_mentions(text: &str, name: &str) -> Vec<(usize, usize, String)> {
    let mask = Regex::new(r"\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|`[^`]*`|https?://\S+")
        .expect("valid regex");
    let word = Regex::new(&format!(
        r"(?i)(^|[^\p{{L}}\p{{N}}_])({})($|[^\p{{L}}\p{{N}}_])",
        regex::escape(name)
    ))
    .expect("valid regex");
    let mut out = Vec::new();
    let mut in_front = text.starts_with("---\n") || text.starts_with("---\r\n");
    let mut in_code = false;
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        if in_front {
            if i > 0 && t == "---" {
                in_front = false;
            }
            continue;
        }
        if t.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        // Blank out links and code, keeping positions, so matches inside them are ignored.
        let masked = mask.replace_all(line, |c: &regex::Captures| " ".repeat(c[0].len()));
        if let Some(m) = word.captures(&masked) {
            let g = m.get(2).expect("group 2");
            out.push((i + 1, g.start(), line[g.start()..g.end()].to_string()));
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Bookmark {
    pub path: String,
    /// False when the file or folder was deleted or moved outside Mosaic.
    pub exists: bool,
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
    /// A workspace with in-memory history (tests and previews); `open` keeps history on disk.
    pub fn new(vault: Vault, index: Index) -> Self {
        let history = History::in_memory().expect("in-memory history");
        Self::with_history(vault, index, history)
    }

    fn with_history(vault: Vault, index: Index, history: History) -> Self {
        let reader = index.open_reader().map(Mutex::new);
        Workspace {
            vault,
            reader,
            index: Mutex::new(index),
            history: Mutex::new(history),
            source: Source::App,
            actor: Mutex::new(None),
            fixed_rules: None,
        }
    }

    /// A workspace whose index lives in `db` (tests that need a file-backed index).
    pub fn with_index_file(vault: Vault, db: &std::path::Path) -> Result<Self> {
        Ok(Self::with_history(
            vault,
            Index::open_at(db)?,
            History::in_memory()?,
        ))
    }

    /// A workspace whose history lives in `db` (tests where the app and an agent share one history).
    pub fn with_history_file(vault: Vault, index: Index, db: &std::path::Path) -> Self {
        let history = History::open_at(db).expect("history database");
        Self::with_history(vault, index, history)
    }

    /// Uses these folder rules for agents instead of the ones in the settings (tests).
    pub fn with_agent_rules(mut self, rules: Vec<AgentRule>) -> Self {
        self.fixed_rules = Some(rules);
        self
    }

    /// Opens a vault with its index and history in the default cache location (in memory if that fails).
    pub fn open(root: impl AsRef<std::path::Path>) -> Result<Self> {
        let vault = Vault::open(root)?;
        let index = Index::open_for(&vault).or_else(|_| Index::in_memory())?;
        let history = History::open_for(vault.root()).or_else(|_| History::in_memory())?;
        Ok(Self::with_history(vault, index, history))
    }

    /// Who changes files through this workspace (recorded in the history). The app is the default.
    pub fn with_source(mut self, source: Source) -> Self {
        self.source = source;
        self
    }

    /// The agent's name, shown in the AI activity log (e.g. the MCP client "claude-code").
    pub fn set_actor(&self, name: &str) {
        *self.actor.lock().unwrap_or_else(|p| p.into_inner()) = Some(name.to_string());
    }

    /// The index for queries: the read-only connection when there is one.
    fn reading(&self) -> MutexGuard<'_, Index> {
        match &self.reader {
            Some(r) => r.lock().unwrap_or_else(|p| p.into_inner()),
            None => self.index(),
        }
    }

    pub(crate) fn hist(&self) -> MutexGuard<'_, History> {
        self.history.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn source(&self) -> Source {
        self.source.clone()
    }

    pub(crate) fn actor(&self) -> Option<String> {
        self.actor.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The vault's folder rules for agents (Settings › AI). They never apply to the app.
    pub(crate) fn rules(&self) -> Vec<AgentRule> {
        if self.source == Source::App {
            Vec::new()
        } else if let Some(rules) = &self.fixed_rules {
            rules.clone()
        } else {
            Settings::load().agent_rules(self.vault.root())
        }
    }

    fn visible(rules: &[AgentRule], path: &str) -> bool {
        access_for(rules, path) != Some(Access::Hidden)
    }

    /// A hidden path reads as "not found", so agents can't tell it exists.
    fn check_read(&self, path: &str) -> Result<()> {
        let norm = normalize(path)?;
        if Self::visible(&self.rules(), &norm) {
            Ok(())
        } else {
            Err(Error::NotFound(norm))
        }
    }

    /// Refuses changes to read-only or hidden paths — for a folder, to anything inside it too.
    fn check_write(&self, path: &str) -> Result<()> {
        let norm = normalize(path)?;
        let rules = self.rules();
        match access_for(&rules, &norm) {
            Some(Access::Hidden) => return Err(Error::NotFound(norm)),
            Some(Access::ReadOnly) => return Err(read_only(&norm)),
            Some(Access::Review) | None => {}
        }
        if let Some(r) = rules.iter().find(|r| {
            r.path.starts_with(&format!("{norm}/")) || (norm.is_empty() && !r.path.is_empty())
        }) {
            return Err(match r.access {
                Access::ReadOnly => read_only(&r.path),
                Access::Hidden => {
                    Error::Denied(format!("{norm} contains folders agents can't change"))
                }
                Access::Review => Error::Denied(format!(
                    "{norm} contains {}, where the person reviews your changes; change files there one by one",
                    r.path
                )),
            });
        }
        Ok(())
    }

    /// Current text and hash of a file, if it exists and is text.
    pub(crate) fn text_of(&self, path: &str) -> Option<(String, String)> {
        let f = self.vault.read(path).ok()?;
        Some((f.content?, f.hash))
    }

    /// Before a change: keeps the file's current content in the history if it isn't there yet.
    /// Returns whether the file existed. History problems never fail the change itself.
    pub(crate) fn keep_before(&self, path: &str) -> bool {
        let Ok(norm) = normalize(path) else {
            return false;
        };
        match self.text_of(&norm) {
            Some((text, hash)) => {
                let _ = self.hist().keep_before(&norm, &text, &hash, &self.source);
                true
            }
            None => self.vault.stat(&norm).is_ok(),
        }
    }

    /// After a change: records the file's new content.
    fn record(&self, path: &str, action: Action) {
        if let Some((text, hash)) = self.text_of(path) {
            let _ = self.hist().record(
                path,
                Some(&text),
                &hash,
                &self.source,
                self.actor().as_deref(),
                action,
                None,
            );
        }
    }

    /// Refuse malformed canvases, drawings, charts and JSON on write, with an error saying what's
    /// wrong. For agent front ends (CLI, MCP); the app saves half-typed files while someone edits.
    pub fn validating(mut self) -> Self {
        self.vault.set_validate(true);
        self
    }

    pub fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn sync(&self, progress: impl FnMut(usize, usize)) -> Result<SyncStats> {
        self.index().sync(&self.vault, progress)
    }

    /// Re-indexes a path after a change made outside this API (file watcher). A change by another
    /// program is kept in the history, so it can be compared with or restored later.
    pub fn refresh(&self, path: &str) -> Result<()> {
        if let Some((text, hash)) = self.text_of(path) {
            let _ = self
                .hist()
                .keep_before(path, &text, &hash, &Source::External);
        }
        self.index().update_path(&self.vault, path)
    }

    pub(crate) fn reindex(&self, path: &str) {
        // Index errors never fail a successful file operation; the next sync repairs them.
        let _ = self.index().update_path(&self.vault, path);
    }

    pub fn list(&self, dir: &str, recursive: bool) -> Result<Vec<Entry>> {
        self.check_read(dir)?;
        let rules = self.rules();
        let mut entries = self.vault.list(dir, recursive)?;
        entries.retain(|e| Self::visible(&rules, &e.path));
        Ok(entries)
    }

    pub fn read(&self, path: &str) -> Result<FileContent> {
        self.check_read(path)?;
        let norm = normalize(path)?;
        if self.in_review(&norm)
            && let Some(f) = self.read_in_review(&norm)?
        {
            return Ok(f);
        }
        self.vault.read(path)
    }

    pub fn create(&self, path: &str, content: &str) -> Result<Written> {
        self.check_write(path)?;
        let norm = normalize(path)?;
        if self.in_review(&norm) {
            return self.propose_create(&norm, content);
        }
        let w = self.vault.create(path, content)?;
        self.record(&w.path, Action::Created);
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn write(&self, path: &str, content: &str, expected_hash: Option<&str>) -> Result<Written> {
        self.check_write(path)?;
        let norm = normalize(path)?;
        if self.in_review(&norm) {
            return self.propose_write(&norm, content, expected_hash);
        }
        let existed = self.keep_before(path);
        let w = self.vault.write(path, content, expected_hash)?;
        self.record(
            &w.path,
            if existed {
                Action::Edited
            } else {
                Action::Created
            },
        );
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn append(&self, path: &str, content: &str) -> Result<Written> {
        self.check_write(path)?;
        let norm = normalize(path)?;
        if self.in_review(&norm) {
            return self.propose_append(&norm, content);
        }
        let existed = self.keep_before(path);
        let w = self.vault.append(path, content)?;
        self.record(
            &w.path,
            if existed {
                Action::Edited
            } else {
                Action::Created
            },
        );
        self.reindex(&w.path);
        Ok(w)
    }

    /// Ticks (`done`) or unticks the task on `line` (1-based) of a note, from a task query. Refused
    /// with `conflict` when that line no longer holds the task `text` (the note changed since).
    pub fn set_task(&self, path: &str, line: usize, text: &str, done: bool) -> Result<Written> {
        let norm = normalize(path)?;
        let (content, hash) = self
            .text_of(&norm)
            .ok_or_else(|| Error::NotFound(norm.clone()))?;
        let mut lines: Vec<&str> = content.split_inclusive('\n').collect();
        let conflict = || Error::Conflict {
            path: norm.clone(),
            current_hash: hash.clone(),
        };
        let raw = *lines.get(line.wrapping_sub(1)).ok_or_else(conflict)?;
        let body = raw.trim_end_matches(['\n', '\r']);
        let updated = crate::parse::with_task_mark(body, text, if done { 'x' } else { ' ' })
            .ok_or_else(conflict)?;
        let new_line = format!("{updated}{}", &raw[body.len()..]);
        lines[line - 1] = &new_line;
        self.write(&norm, &lines.concat(), Some(&hash))
    }

    pub fn patch(
        &self,
        path: &str,
        find: &str,
        replace: &str,
        expected_hash: Option<&str>,
    ) -> Result<Written> {
        self.check_write(path)?;
        let norm = normalize(path)?;
        if self.in_review(&norm) {
            return self.propose_patch(&norm, find, replace, expected_hash);
        }
        self.keep_before(path);
        let w = self.vault.patch(path, find, replace, expected_hash)?;
        self.record(&w.path, Action::Edited);
        self.reindex(&w.path);
        Ok(w)
    }

    pub fn copy(&self, from: &str, to: &str) -> Result<Written> {
        self.check_read(from)?;
        self.check_write(to)?;
        let to_n = normalize(to)?;
        if self.in_review(&to_n) {
            let text = self.read(from)?.content.ok_or_else(|| {
                Error::Denied(format!(
                    "{to_n}: a binary file can't be proposed for review; ask the person to copy it"
                ))
            })?;
            return self.propose_create(&to_n, &text);
        }
        let w = self.vault.copy(from, to)?;
        self.record(&w.path, Action::Created);
        self.reindex(&w.path);
        Ok(w)
    }

    /// Adds a file from outside the vault. When `path` is taken, " 1", " 2"… is added before the
    /// extension (like Finder), so nothing is ever overwritten.
    pub fn import(&self, path: &str, bytes: &[u8]) -> Result<Written> {
        self.check_write(path)?;
        self.refuse_in_review(path, "adding a binary file")?;
        let name_start = path.rfind('/').map_or(0, |i| i + 1);
        let (stem, ext) = match path[name_start..].rfind('.') {
            Some(i) if i > 0 => path.split_at(name_start + i),
            _ => (path, ""),
        };
        for n in 0.. {
            let candidate = if n == 0 {
                path.to_string()
            } else {
                format!("{stem} {n}{ext}")
            };
            match self.vault.create_bytes(&candidate, bytes) {
                Err(Error::AlreadyExists(_)) => continue,
                r => {
                    let w = r?;
                    self.record(&w.path, Action::Created);
                    self.reindex(&w.path);
                    return Ok(w);
                }
            }
        }
        unreachable!()
    }

    pub fn mkdir(&self, path: &str) -> Result<()> {
        self.check_write(path)?;
        self.vault.mkdir(path)
    }

    /// Moves a file or folder to the Trash. Under review, proposes the deletion instead and
    /// returns the proposal's id.
    pub fn delete(&self, path: &str) -> Result<Option<i64>> {
        self.check_write(path)?;
        let norm = normalize(path)?;
        if self.in_review(&norm) {
            return self.propose_delete(&norm);
        }
        // Keep what's deleted (every text file, for a folder), so the deletion can be undone.
        let files: Vec<String> = match self.vault.stat(&norm) {
            Ok(e) if e.is_dir => self
                .vault
                .list(&norm, true)?
                .into_iter()
                .filter(|e| !e.is_dir)
                .map(|e| e.path)
                .collect(),
            _ => vec![norm.clone()],
        };
        let kept: Vec<(String, String, String)> = files
            .into_iter()
            .filter_map(|p| self.text_of(&p).map(|(t, h)| (p, t, h)))
            .collect();
        self.vault.delete(&norm)?;
        let actor = self.actor();
        for (p, text, hash) in kept {
            let _ = self.hist().record(
                &p,
                Some(&text),
                &hash,
                &self.source,
                actor.as_deref(),
                Action::Deleted,
                None,
            );
        }
        self.reindex(&norm);
        Ok(None)
    }

    /// Moves several files and folders into `folder` (created if missing), keeping their names;
    /// links follow each move. Every destination is checked first, so nothing moves if one is taken.
    pub fn move_into(&self, paths: &[String], folder: &str) -> Result<Vec<Renamed>> {
        let folder = normalize(folder)?;
        let mut moves = Vec::new();
        for p in paths {
            let from = normalize(p)?;
            self.check_write(&from)?;
            self.vault.stat(&from)?;
            if folder == from || folder.starts_with(&format!("{from}/")) {
                return Err(Error::InvalidPath(format!("can't move {from} into itself")));
            }
            let name = crate::links::file_name(&from);
            let to = if folder.is_empty() {
                name.to_string()
            } else {
                format!("{folder}/{name}")
            };
            if to == from {
                continue;
            }
            self.check_write(&to)?;
            if self.vault.stat(&to).is_ok() {
                return Err(Error::AlreadyExists(to));
            }
            moves.push((from, to));
        }
        if !folder.is_empty() && self.vault.stat(&folder).is_err() {
            self.mkdir(&folder)?;
        }
        moves
            .into_iter()
            .map(|(from, to)| self.rename(&from, &to, true))
            .collect()
    }

    /// Versions of a file, newest first (see `crate::history`).
    pub fn history(&self, path: &str, limit: usize) -> Result<Vec<Version>> {
        self.check_read(path)?;
        self.hist().list(&normalize(path)?, limit)
    }

    /// The content of one version.
    pub fn version_content(&self, id: i64) -> Result<String> {
        if let Some(v) = self.hist().get(id)? {
            self.check_read(&v.path)?;
        }
        self.hist()
            .content(id)?
            .ok_or_else(|| Error::NotFound(format!("version {id}")))
    }

    /// Changes made by agents and the command line, newest first.
    pub fn activity(&self, limit: usize) -> Result<Vec<Version>> {
        let rules = self.rules();
        let mut list = self.hist().activity(limit)?;
        list.retain(|v| Self::visible(&rules, &v.path));
        Ok(list)
    }

    /// Puts a file back to one of its versions (recreating it if it was deleted). With
    /// `expected_hash`, refuses if the file changed since it was read.
    pub fn restore(&self, path: &str, id: i64, expected_hash: Option<&str>) -> Result<Written> {
        self.check_write(path)?;
        let norm = normalize(path)?;
        let content = self.version_content(id)?;
        if self.in_review(&norm) {
            return self.propose_write(&norm, &content, expected_hash);
        }
        let existed = self.keep_before(&norm);
        let w = if existed {
            self.vault.write(&norm, &content, expected_hash)?
        } else {
            self.vault.create(&norm, &content)?
        };
        self.record(&w.path, Action::Restored);
        self.reindex(&w.path);
        Ok(w)
    }

    /// Undoes one change from the activity log: an edit goes back to the version before it, a
    /// created file goes to the Trash, a deleted file comes back, a rename is reversed. Refuses
    /// (`conflict`) when the file changed again since. Returns the file's path afterwards.
    pub fn undo(&self, id: i64) -> Result<String> {
        let path = self.undo_change(id)?;
        // An accepted proposal that this undoes: tell the agent (list_proposals shows "undone").
        let _ = self.hist().proposal_undone(id);
        Ok(path)
    }

    fn undo_change(&self, id: i64) -> Result<String> {
        let v = self
            .hist()
            .get(id)?
            .ok_or_else(|| Error::NotFound(format!("change {id}")))?;
        let current = self.text_of(&v.path).map(|(_, h)| h);
        let unchanged = || match &current {
            Some(h) if *h == v.hash => Ok(()),
            Some(h) => Err(Error::Conflict {
                path: v.path.clone(),
                current_hash: h.clone(),
            }),
            None => Err(Error::NotFound(v.path.clone())),
        };
        match v.action.as_str() {
            "edited" | "restored" => {
                unchanged()?;
                let prev = self.hist().previous(id)?.ok_or_else(|| {
                    Error::Invalid(format!("{} has no earlier version to go back to", v.path))
                })?;
                self.restore(&v.path, prev.id, current.as_deref())?;
                Ok(v.path)
            }
            "created" => {
                unchanged()?;
                self.delete(&v.path)?;
                Ok(v.path)
            }
            "deleted" => {
                if self.vault.stat(&v.path).is_ok() {
                    return Err(Error::AlreadyExists(v.path));
                }
                self.restore(&v.path, id, None)?;
                Ok(v.path)
            }
            "renamed" => {
                let from = v
                    .from_path
                    .clone()
                    .ok_or_else(|| Error::Invalid("this rename has no origin".into()))?;
                Ok(self.rename(&v.path, &from, true)?.path)
            }
            other => Err(Error::Invalid(format!(
                "a change of type “{other}” can't be undone"
            ))),
        }
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let rules = self.rules();
        if rules.is_empty() {
            return self.reading().search(query, limit);
        }
        // Ask for more, so hidden hits don't leave the agent with a short list.
        let mut hits = self.reading().search(query, limit + 100)?;
        hits.retain(|h| Self::visible(&rules, &h.path));
        hits.truncate(limit);
        Ok(hits)
    }

    /// Notes matching a structured query (see `crate::query` for the language). Agents only see
    /// what their folder rules let them see.
    pub fn query(&self, query: &str) -> Result<crate::query::QueryResult> {
        let q = crate::query::parse(query)?;
        let rules = self.rules();
        q.run(&self.reading(), |p| Self::visible(&rules, p))
    }

    pub fn backlinks(&self, path: &str) -> Result<Vec<Backlink>> {
        self.check_read(path)?;
        let rules = self.rules();
        let mut list = self.reading().backlinks(&normalize(path)?)?;
        list.retain(|b| Self::visible(&rules, &b.source));
        Ok(list)
    }

    /// Tags with counts. With hidden folders, only notes agents can see are counted.
    pub fn tags(&self) -> Result<Vec<TagCount>> {
        let rules = self.rules();
        let all = self.reading().tags()?;
        if !rules.iter().any(|r| r.access == Access::Hidden) {
            return Ok(all);
        }
        let mut out = Vec::new();
        for t in all {
            let count = self.paths_with_tag(&t.tag)?.len();
            if count > 0 {
                out.push(TagCount { tag: t.tag, count });
            }
        }
        Ok(out)
    }

    pub fn paths_with_tag(&self, tag: &str) -> Result<Vec<String>> {
        let rules = self.rules();
        let mut paths = self.reading().paths_with_tag(tag)?;
        paths.retain(|p| Self::visible(&rules, p));
        Ok(paths)
    }

    pub fn aliases(&self) -> Result<Vec<(String, String)>> {
        self.reading().aliases()
    }

    /// Notes that mention `path`'s title or aliases without linking to it (at most `limit` notes).
    pub fn unlinked_mentions(&self, path: &str, limit: usize) -> Result<Vec<Mention>> {
        let norm = normalize(path)?;
        self.check_read(&norm)?;
        let name = crate::links::file_name(&norm);
        let mut names = vec![name.strip_suffix(".md").unwrap_or(name).to_string()];
        if let Some(text) = self.text_of(&norm).map(|(t, _)| t) {
            names.extend(parse::parse(&text).aliases);
        }
        names.retain(|n| n.chars().count() >= 3);
        let linking: BTreeSet<String> = self
            .backlinks(&norm)?
            .into_iter()
            .map(|b| b.source)
            .collect();
        let rules = self.rules();
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        for n in &names {
            // The index narrows it down; each candidate is then checked line by line.
            let hits = self
                .reading()
                .search(&format!("\"{}\"", n.replace('"', " ")), 200)?;
            for h in hits {
                if out.len() >= limit {
                    break;
                }
                if h.path == norm
                    || linking.contains(&h.path)
                    || !h.path.to_lowercase().ends_with(".md")
                    || !Self::visible(&rules, &h.path)
                    || !seen.insert(h.path.clone())
                {
                    continue;
                }
                let Some((text, _)) = self.text_of(&h.path) else {
                    continue;
                };
                let lines: Vec<&str> = text.lines().collect();
                for (line, _, matched) in find_mentions(&text, n).into_iter().take(3) {
                    out.push(Mention {
                        source: h.path.clone(),
                        line,
                        context: lines[line - 1].trim().to_string(),
                        text: matched,
                    });
                }
            }
        }
        Ok(out)
    }

    /// Turns one unlinked mention into a link to `target`: the first unlinked occurrence of `text`
    /// on `line` of `source` becomes `[[Target]]`, or `[[Target|text]]` when the words differ.
    pub fn link_mention(
        &self,
        source: &str,
        line: usize,
        text: &str,
        target: &str,
    ) -> Result<Written> {
        let file = self.read(source)?;
        let content = file
            .content
            .ok_or_else(|| Error::NotText(source.to_string()))?;
        let found = find_mentions(&content, text)
            .into_iter()
            .find(|(l, _, _)| *l == line);
        let Some((_, at, matched)) = found else {
            return Err(Error::Invalid(format!(
                "“{text}” isn't on line {line} of {source} any more"
            )));
        };
        let files = self.reading().file_set()?;
        let link_text = wiki_text_for(&files, &normalize(target)?, Some(&file.path));
        let link = if link_text == matched {
            format!("[[{matched}]]")
        } else {
            format!("[[{link_text}|{matched}]]")
        };
        // Replace exactly that occurrence: the line's start plus the match's offset in it.
        let start: usize = content
            .split_inclusive('\n')
            .take(line - 1)
            .map(str::len)
            .sum::<usize>()
            + at;
        let mut out = content.clone();
        out.replace_range(start..start + matched.len(), &link);
        self.write(&file.path, &out, Some(&file.hash))
    }

    /// Cheap structural overview of a file — what an AI should read before deciding to load it all.
    pub fn outline(&self, path: &str) -> Result<Outline> {
        self.check_read(path)?;
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
        let rules = self.rules();
        let index = self.reading();
        let mut backlinks = index.backlinks(&file.path)?;
        backlinks.retain(|b| Self::visible(&rules, &b.source));
        Ok(Outline {
            links: index.outlinks(&file.path)?,
            backlinks,
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
        self.check_write(from)?;
        self.check_write(to)?;
        self.refuse_in_review(from, "moving it")?;
        self.refuse_in_review(to, "moving a file there")?;
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
        let (old_set, sources, all_paths, aliases) = if update_links {
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
            // Links are rewritten in other notes; an agent may not change read-only ones that way.
            let rules = self.rules();
            let blocked: Vec<&String> = sources
                .iter()
                .filter(|p| access_for(&rules, p).is_some())
                .collect();
            if !blocked.is_empty() {
                let shown: Vec<&str> = blocked
                    .iter()
                    .filter(|p| Self::visible(&rules, p))
                    .map(|p| p.as_str())
                    .collect();
                return Err(Error::Denied(format!(
                    "moving {from} would change links in notes agents can't change directly{}",
                    if shown.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", shown.join(", "))
                    }
                )));
            }
            let aliases = index.aliases()?;
            (Some(old_set), sources, all_paths, aliases)
        } else {
            (None, BTreeSet::new(), vec![], vec![])
        };

        let out = self.vault.rename(&from, &to_n)?;
        let _ = self
            .hist()
            .renamed(&from, &out, &self.source, self.actor().as_deref());
        let mut updated = Vec::new();

        if let Some(old_set) = old_set {
            let moved_map: HashMap<String, String> =
                moved.iter().map(|p| (p.clone(), map_path(p))).collect();
            let new_paths: Vec<String> = all_paths.iter().map(|p| map_path(p)).collect();
            // Aliases follow their notes, so alias links ([[Start]] for Home.md) still resolve and stay.
            let new_aliases: Vec<(String, String)> = aliases
                .iter()
                .map(|(a, p)| (a.clone(), map_path(p)))
                .collect();
            let new_set = FileSet::new(
                new_paths.iter().map(String::as_str),
                new_aliases.iter().map(|(a, p)| (a.as_str(), p.as_str())),
            );
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
        // Bookmarks follow the move too. They are secondary: a failure here doesn't undo the rename.
        let root = self.vault.root();
        let _ = Settings::update(|s| s.remap_bookmarks(root, &from, &out));
        Ok(Renamed {
            path: out,
            updated_links_in: updated,
        })
    }

    /// The vault's bookmarks, in the user's order. They live in the app's settings, not in the vault.
    pub fn bookmarks(&self) -> Vec<Bookmark> {
        Settings::load()
            .bookmarks(self.vault.root())
            .into_iter()
            .map(|path| Bookmark {
                // A saved search (`search:<query>`) always "exists".
                exists: path.starts_with("search:") || self.vault.stat(&path).is_ok(),
                path,
            })
            .collect()
    }

    /// Bookmarks an existing file or folder (at the end of the list; no-op if already there).
    /// Bookmarks a file or folder, or a search when `path` is `search:<query>`.
    pub fn add_bookmark(&self, path: &str) -> Result<Vec<Bookmark>> {
        let path = match path.strip_prefix("search:") {
            Some(q) if !q.trim().is_empty() => format!("search:{}", q.trim()),
            _ => self.vault.stat(path)?.path,
        };
        if path.is_empty() {
            return Err(Error::InvalidPath("cannot bookmark the vault root".into()));
        }
        let root = self.vault.root();
        Settings::update(|s| {
            let mut list = s.bookmarks(root);
            if list.contains(&path) {
                return false;
            }
            list.push(path.clone());
            s.set_bookmarks(root, list);
            true
        })
        .map_err(settings_error)?;
        Ok(self.bookmarks())
    }

    /// Removes a bookmark (also one whose file no longer exists).
    pub fn remove_bookmark(&self, path: &str) -> Result<Vec<Bookmark>> {
        let path = normalize(path)?;
        let root = self.vault.root();
        let mut found = false;
        Settings::update(|s| {
            let mut list = s.bookmarks(root);
            list.retain(|p| p != &path);
            found = list.len() < s.bookmarks(root).len();
            if found {
                s.set_bookmarks(root, list);
            }
            found
        })
        .map_err(settings_error)?;
        if !found {
            return Err(Error::Invalid(format!("{path} isn't bookmarked")));
        }
        Ok(self.bookmarks())
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
        let _ = self
            .hist()
            .keep_before(new_src, &text, &file.hash, &self.source);
        self.vault.write(new_src, &new_text, Some(&file.hash))?;
        self.record(new_src, Action::Edited);
        Ok(true)
    }
}

fn read_only(path: &str) -> Error {
    Error::Denied(format!(
        "{path} is read-only for agents (set by the person using Mosaic, in Settings › AI)"
    ))
}

fn settings_error(e: std::io::Error) -> Error {
    Error::io(SETTINGS_FILE, e)
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
    fn ticking_a_task_from_a_query() {
        let (d, w) = ws();
        w.create("Day.md", "# Day\r\n- [ ] Write\r\n    - [ ] Sub\r\n")
            .unwrap();
        w.set_task("Day.md", 3, "Sub", true).unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join("Day.md")).unwrap(),
            "# Day\r\n- [ ] Write\r\n    - [x] Sub\r\n"
        );
        w.set_task("Day.md", 3, "Sub", false).unwrap();
        // The line moved or holds another task: refused, nothing written.
        assert!(matches!(
            w.set_task("Day.md", 2, "Sub", true),
            Err(Error::Conflict { .. })
        ));
        assert!(matches!(
            w.set_task("Day.md", 9, "Sub", true),
            Err(Error::Conflict { .. })
        ));
        assert!(
            std::fs::read_to_string(d.path().join("Day.md"))
                .unwrap()
                .contains("- [ ] Sub")
        );
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
    fn import_never_overwrites_and_numbers_like_finder() {
        let (_d, w) = ws();
        let png = [0x89, b'P', b'N', b'G', 0];
        assert_eq!(w.import("img/a.png", &png).unwrap().path, "img/a.png");
        assert_eq!(w.import("img/a.png", &png).unwrap().path, "img/a 1.png");
        assert_eq!(w.import("img/a.png", &png).unwrap().path, "img/a 2.png");
        assert_eq!(w.import("Ideas.md", b"x").unwrap().path, "Ideas 1.md");
        assert_eq!(w.import("v1.0/README", b"x").unwrap().path, "v1.0/README");
        assert_eq!(w.import("v1.0/README", b"x").unwrap().path, "v1.0/README 1");
        assert_eq!(w.import(".env", b"x").unwrap_err().code(), "invalid_path");
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

    #[test]
    fn renaming_a_folder_updates_file_cards_of_a_canvas_inside_it() {
        let (_d, w) = ws();
        w.create("Test/Plan.md", "# Plan").unwrap();
        let canvas = r#"{"nodes":[{"id":"a","type":"file","file":"Test/Plan.md","x":0,"y":0,"width":10,"height":10}],"edges":[]}"#;
        w.create("Test/Map.canvas", canvas).unwrap();
        let r = w.rename("Test", "Documentation", true).unwrap();
        assert!(
            r.updated_links_in
                .contains(&"Documentation/Map.canvas".to_string()),
            "{r:?}"
        );
        assert!(text(&w, "Documentation/Map.canvas").contains(r#""file":"Documentation/Plan.md""#));
    }

    fn agent_ws() -> (tempfile::TempDir, Workspace) {
        let (d, v) = fixture();
        let w = Workspace::new(v, Index::in_memory().unwrap()).with_source(Source::Agent);
        w.set_actor("claude-code");
        w.sync(|_, _| {}).unwrap();
        (d, w)
    }

    #[test]
    fn agent_edits_are_logged_and_undone() {
        let (_d, w) = agent_ws();
        let before = text(&w, "Ideas.md");
        w.patch("Ideas.md", "Ideas", "Thoughts", None).unwrap();
        let act = w.activity(10).unwrap();
        assert_eq!(
            (
                act[0].path.as_str(),
                act[0].action.as_str(),
                act[0].actor.as_deref()
            ),
            ("Ideas.md", "edited", Some("claude-code"))
        );
        // The version before the agent's edit is kept.
        let hist = w.history("Ideas.md", 10).unwrap();
        assert_eq!(
            hist.iter().map(|v| v.action.as_str()).collect::<Vec<_>>(),
            ["edited", "before"]
        );
        w.undo(act[0].id).unwrap();
        assert_eq!(text(&w, "Ideas.md"), before);
    }

    #[test]
    fn undo_refuses_when_the_file_changed_since() {
        let (_d, w) = agent_ws();
        w.append("Ideas.md", "agent line").unwrap();
        let id = w.activity(1).unwrap()[0].id;
        w.append("Ideas.md", "human line").unwrap();
        assert!(matches!(w.undo(id), Err(Error::Conflict { .. })));
    }

    #[test]
    fn undo_reverses_create_delete_and_rename() {
        let (_d, w) = agent_ws();
        w.create("New.md", "hello").unwrap();
        let created = w.activity(1).unwrap()[0].id;
        w.undo(created).unwrap();
        assert!(w.read("New.md").is_err());

        let home = text(&w, "Home.md");
        w.delete("Home.md").unwrap();
        let deleted = w.activity(1).unwrap()[0].id;
        w.undo(deleted).unwrap();
        assert_eq!(text(&w, "Home.md"), home);

        w.rename("Ideas.md", "Archive/Ideas.md", true).unwrap();
        let moved = w
            .activity(10)
            .unwrap()
            .into_iter()
            .find(|v| v.action == "renamed")
            .unwrap()
            .id;
        w.undo(moved).unwrap();
        assert!(w.read("Ideas.md").is_ok());
        assert!(w.read("Archive/Ideas.md").is_err());
    }

    #[test]
    fn external_changes_are_kept_and_restorable() {
        let (d, w) = ws();
        std::fs::write(d.path().join("Ideas.md"), "changed in another editor").unwrap();
        w.refresh("Ideas.md").unwrap();
        let hist = w.history("Ideas.md", 10).unwrap();
        assert_eq!(
            (hist[0].source.as_str(), hist[0].action.as_str()),
            ("external", "before")
        );
        w.write("Ideas.md", "mine", None).unwrap();
        w.restore("Ideas.md", hist[0].id, None).unwrap();
        assert_eq!(text(&w, "Ideas.md"), "changed in another editor");
        assert_eq!(w.history("Ideas.md", 1).unwrap()[0].action, "restored");
    }

    #[test]
    fn search_does_not_wait_for_a_long_sync() {
        let (d, v) = fixture();
        let w =
            std::sync::Arc::new(Workspace::with_index_file(v, &d.path().join(".idx.db")).unwrap());
        w.sync(|_, _| {}).unwrap();
        // Hold the writer, as a long sync does, and search from another thread.
        let writer = w.index();
        let (tx, rx) = std::sync::mpsc::channel();
        let w2 = w.clone();
        std::thread::spawn(move || tx.send(w2.search("ideas", 5).map(|h| h.len())).unwrap());
        let found = rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("search waited for the writer");
        assert!(found.unwrap() > 0);
        drop(writer);
        // The reader sees the writer's later changes.
        w.create("Zebra.md", "zebra stripes").unwrap();
        assert_eq!(w.search("zebra", 5).unwrap()[0].path, "Zebra.md");
        assert!(
            w.backlinks("Ideas.md")
                .unwrap()
                .iter()
                .all(|b| !b.source.is_empty())
        );
    }

    #[test]
    fn alias_links_stay_when_their_note_moves() {
        let (_d, w) = ws();
        w.create("Note.md", "---\naliases: [Start]\n---\n# Note")
            .unwrap();
        w.create("Other.md", "See [[Start]] and [[Note]]").unwrap();
        w.rename("Note.md", "Archive/Note.md", true).unwrap();
        let other = text(&w, "Other.md");
        assert!(other.contains("[[Start]]"), "alias link kept: {other}");
    }

    #[test]
    fn finds_unlinked_mentions_and_links_them() {
        assert_eq!(
            find_mentions(
                "---\ntitle: Plan\n---\nThe plan is ready.\n[[Plan]] and `plan` and planning\nsee [x](Plan.md) then Plan",
                "Plan"
            ),
            vec![(4, 4, "plan".to_string()), (6, 22, "Plan".to_string())]
        );
        let (_d, w) = ws();
        w.create("Roadmap.md", "# Roadmap").unwrap();
        w.create(
            "Notes.md",
            "Talked about the roadmap today.\nAlready linked elsewhere: no.",
        )
        .unwrap();
        w.create("Linked.md", "See [[Roadmap]], the roadmap.")
            .unwrap();
        let m = w.unlinked_mentions("Roadmap.md", 10).unwrap();
        assert_eq!(m.len(), 1, "a note that already links isn't listed: {m:?}");
        assert_eq!(
            (m[0].source.as_str(), m[0].line, m[0].text.as_str()),
            ("Notes.md", 1, "roadmap")
        );
        w.link_mention("Notes.md", 1, "roadmap", "Roadmap.md")
            .unwrap();
        assert!(text(&w, "Notes.md").starts_with("Talked about the [[Roadmap|roadmap]] today."));
        assert!(w.unlinked_mentions("Roadmap.md", 10).unwrap().is_empty());
    }
}
