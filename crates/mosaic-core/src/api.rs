//! The workspace services every front end (Tauri app, CLI, MCP server) maps onto. They share one
//! context so the vault, permissions, history and index stay consistent across every operation.

use crate::error::{Error, Result};
use crate::history::{Action, History, Source, Version};
use crate::index::{Backlink, Index, OutLink, SearchHit, SyncPlan, SyncStats, TagCount};
use crate::kind::FileKind;
use crate::links::{FileSet, markdown_url_for, wiki_text_for};
use crate::parse::{self, Heading, LinkKind};
use crate::planner::PlannerService;
use crate::settings::{Access, AgentRule, Settings, access_for, rule_covers};
use crate::vault::{Entry, FileContent, Vault, Written, normalize};
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::ops::Deref;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

pub struct Workspace {
    ctx: Arc<Context>,
    /// Vault file operations, history and rename/link-rewrite coordination.
    pub files: FileService,
    /// Backlinks, unlinked mentions and note outlines.
    pub links: LinkService,
    /// Epics, tasks, work sessions and calendar events (see `planner::PlannerService`).
    pub planner: PlannerService,
}

/// State shared by the workspace's services. `Workspace` dereferences to this context so existing
/// integrations that inspect `ws.vault` keep working while file and link operations move behind
/// their focused services.
pub struct Context {
    pub vault: Vault,
    /// Set once a full sync finished: only then does the index reflect the whole vault.
    synced: std::sync::atomic::AtomicBool,
    index: Mutex<Index>,
    /// A read-only connection to the same index for queries, so a long sync doesn't block search.
    /// `None` for an in-memory index (tests), where queries use `index`.
    reader: Option<Mutex<Index>>,
    /// Versions of every file changed through this workspace (see `history`).
    /// Opened on first use for `open` (from `history_root`), so reading notes creates nothing.
    history: OnceLock<Mutex<History>>,
    history_root: Option<std::path::PathBuf>,
    /// Why the history is only in memory this session, when it couldn't be opened on disk.
    history_problem: OnceLock<String>,
    /// Who changes files through this workspace: the app, the CLI or an agent.
    source: Mutex<Source>,
    /// The agent's name (MCP client), once known.
    actor: Mutex<Option<String>>,
    /// Folder rules for agents given directly instead of read from the settings (tests).
    fixed_rules: Mutex<Option<Vec<AgentRule>>>,
    /// While an agent operation runs (see `freeze_rules`), the rules it read first, so every check
    /// in that operation sees the same rules even if the person edits them meanwhile.
    frozen_rules: Mutex<FrozenRules>,
    /// Direct-write paths for one scheduled run; other writes become proposals.
    change_allowlist: Mutex<Option<Vec<String>>>,
}

#[derive(Clone)]
pub struct FileService {
    ctx: Arc<Context>,
}

#[derive(Clone)]
pub struct LinkService {
    ctx: Arc<Context>,
    files: FileService,
}

impl Deref for Workspace {
    type Target = Context;

    fn deref(&self) -> &Self::Target {
        &self.ctx
    }
}

impl Deref for FileService {
    type Target = Context;

    fn deref(&self) -> &Self::Target {
        &self.ctx
    }
}

impl Deref for LinkService {
    type Target = Context;

    fn deref(&self) -> &Self::Target {
        &self.ctx
    }
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Renamed {
    pub path: String,
    /// Other files whose links were rewritten to follow the move.
    pub updated_links_in: Vec<String>,
    /// Files whose links couldn't be rewritten, and why. The move itself happened; the app offers
    /// **Fix links** for it (`FileService::fix_links`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failed_links_in: Vec<FailedLink>,
    /// Set when the rename is waiting for review rather than applied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FailedLink {
    pub path: String,
    pub error: String,
}

/// A note that mentions another note's title or alias without linking to it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
        Self::assemble(vault, index, Some(history), None, None)
    }

    fn assemble(
        vault: Vault,
        index: Index,
        history: Option<History>,
        history_root: Option<std::path::PathBuf>,
        planner_root: Option<std::path::PathBuf>,
    ) -> Self {
        let reader = index.open_reader().map(Mutex::new);
        let history = history
            .map(Mutex::new)
            .map(OnceLock::from)
            .unwrap_or_default();
        let ctx = Arc::new(Context {
            vault,
            synced: Default::default(),
            reader,
            index: Mutex::new(index),
            history,
            history_root,
            history_problem: OnceLock::new(),
            source: Mutex::new(Source::App),
            actor: Mutex::new(None),
            fixed_rules: Mutex::new(None),
            frozen_rules: Mutex::default(),
            change_allowlist: Mutex::new(None),
        });
        let files = FileService { ctx: ctx.clone() };
        let links = LinkService {
            ctx: ctx.clone(),
            files: files.clone(),
        };
        Workspace {
            ctx,
            files,
            links,
            planner: PlannerService::new(planner_root),
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
    pub fn with_agent_rules(self, rules: Vec<AgentRule>) -> Self {
        *self.fixed_rules.lock().unwrap_or_else(|p| p.into_inner()) = Some(rules);
        self
    }

    /// Restricts this agent workspace to direct writes below these vault-relative paths.
    pub fn with_change_allowlist(self, paths: Vec<String>) -> Self {
        *self
            .change_allowlist
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(
            paths
                .into_iter()
                .filter_map(|p| normalize(p.trim_matches('/')).ok())
                .collect(),
        );
        self
    }

    /// Opens a vault with its index in Caches (in memory if that fails) and its history in
    /// Application Support (see `History::open_for`). If the history can't be opened, it's kept
    /// in memory and `history_warning` says why.
    pub fn open(root: impl AsRef<std::path::Path>) -> Result<Self> {
        let vault = Vault::open(root)?;
        let index = Index::open_for(&vault).or_else(|_| Index::in_memory())?;
        let root = vault.root().to_path_buf();
        Ok(Self::assemble(
            vault,
            index,
            None,
            Some(root.clone()),
            Some(root),
        ))
    }

    /// Why undo history and proposals won't outlast this session, if they won't. Opens the history
    /// now: the app asks when a vault opens, to show it.
    pub fn history_warning(&self) -> Option<String> {
        drop(self.hist());
        self.history_problem.get().cloned()
    }

    /// Who changes files through this workspace (recorded in the history). The app is the default.
    pub fn with_source(self, source: Source) -> Self {
        *self.source.lock().unwrap_or_else(|p| p.into_inner()) = source;
        self
    }
}

impl Context {
    pub(crate) fn change_allowed(&self, path: &str) -> bool {
        self.change_allowlist
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_none_or(|allowed| allowed.iter().any(|p| rule_covers(p, path)))
    }

    /// The agent's name, shown in the AI activity log (e.g. the MCP client "claude-code").
    pub fn set_actor(&self, name: &str) {
        *self.actor.lock().unwrap_or_else(|p| p.into_inner()) = Some(name.to_string());
    }

    /// The index for queries: the read-only connection when there is one.
    pub(crate) fn reading(&self) -> MutexGuard<'_, Index> {
        match &self.reader {
            Some(r) => r.lock().unwrap_or_else(|p| p.into_inner()),
            None => self.index(),
        }
    }

    pub(crate) fn hist(&self) -> MutexGuard<'_, History> {
        self.history
            .get_or_init(|| {
                let opened = match &self.history_root {
                    Some(root) => History::open_for(root),
                    None => History::in_memory(),
                };
                Mutex::new(opened.unwrap_or_else(|e| {
                    let _ = self.history_problem.set(format!(
                        "Undo history and AI proposals can't be saved for this vault, so changes from this session can't be undone after Mosaic quits: {e}"
                    ));
                    History::in_memory().expect("in-memory history")
                }))
            })
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn source(&self) -> Source {
        self.source
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub(crate) fn actor(&self) -> Option<String> {
        self.actor.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The vault's folder rules for agents (Settings › AI). They never apply to the app. When
    /// settings.json can't be read the rules are unknown, so agents are denied rather than let
    /// through as if there were none.
    pub(crate) fn rules(&self) -> Result<Vec<AgentRule>> {
        if self.source() == Source::App {
            return Ok(Vec::new());
        }
        if let Some(rules) = self
            .fixed_rules
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            return Ok(rules.clone());
        }
        let mut frozen = self.frozen_rules.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(rules) = &frozen.rules {
            return Ok(rules.clone());
        }
        let rules = crate::vault_state::rules_for(self.vault.root()).map_err(|_| {
            Error::Denied(
                "Mosaic's folder rules can't be read, so agent access is paused; ask the person to check Settings › AI".into(),
            )
        })?;
        if frozen.depth > 0 {
            frozen.rules = Some(rules.clone());
        }
        Ok(rules)
    }
}

impl Workspace {
    /// Reads the folder rules at most once until the guard is dropped: front ends hold one for
    /// each agent request (an MCP tool call, a CLI command), so all of its checks agree.
    pub fn freeze_rules(&self) -> RulesFrozen<&Self> {
        RulesFrozen::new(self)
    }

    /// `freeze_rules` for a shared workspace; the guard derefs to it.
    pub fn frozen(ws: std::sync::Arc<Self>) -> RulesFrozen<std::sync::Arc<Self>> {
        RulesFrozen::new(ws)
    }
}

impl Context {
    pub(crate) fn visible(rules: &[AgentRule], path: &str) -> bool {
        access_for(rules, path) != Some(Access::Hidden)
    }

    /// A hidden path reads as "not found", so agents can't tell it exists.
    pub(crate) fn check_read(&self, path: &str) -> Result<()> {
        let norm = normalize(path)?;
        if Context::visible(&self.rules()?, &self.vault.canonical_rel(&norm)?) {
            Ok(())
        } else {
            Err(Error::NotFound(norm))
        }
    }

    /// Refuses changes to read-only or hidden paths — for a folder, to anything inside it too.
    fn check_write(&self, path: &str) -> Result<()> {
        let norm = normalize(path)?;
        let rules = self.rules()?;
        // Rules are matched against the on-disk spelling: `private/x.md` opens `Private/x.md`.
        let real = self.vault.canonical_rel(&norm)?;
        match access_for(&rules, &real) {
            Some(Access::Hidden) => return Err(Error::NotFound(norm)),
            Some(Access::ReadOnly) => return Err(read_only(&norm)),
            Some(Access::Review) | None => {}
        }
        if let Some(r) = rules
            .iter()
            .find(|r| !rule_covers(&r.path, &real) && rule_covers(&real, &r.path))
        {
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
                let _ = self.hist().keep_before(&norm, &text, &hash, &self.source());
                true
            }
            None => self.vault.stat(&norm).is_ok(),
        }
    }

    /// After a change: records the file's new content.
    fn record(&self, path: &str, action: Action) {
        self.record_as(path, action, &self.source(), self.actor().as_deref());
    }

    /// Records a change using the identity that caused it. Review acceptance uses this to retain
    /// the proposing agent's attribution even though the app applies the change.
    fn record_as(&self, path: &str, action: Action, source: &Source, actor: Option<&str>) {
        if let Some((text, hash)) = self.text_of(path) {
            let _ = self
                .hist()
                .record(path, Some(&text), &hash, source, actor, action, None);
        }
    }

    pub fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn reindex(&self, path: &str) {
        // Index errors never fail a successful file operation; the next sync repairs them.
        let _ = self.index().update_path(&self.vault, path);
    }
}

impl Workspace {
    /// Refuse malformed canvases, drawings, charts and JSON on write, with an error saying what's
    /// wrong. For agent front ends (CLI, MCP); the app saves half-typed files while someone edits.
    pub fn validating(self) -> Self {
        self.vault.set_validate(true);
        self
    }

    /// Brings the index up to date with the disk. The vault is walked without the index lock, and
    /// files are indexed in batches that each take it briefly, so a write made meanwhile (an
    /// autosave) waits for one batch at most.
    pub fn sync(&self, mut progress: impl FnMut(usize, usize)) -> Result<SyncStats> {
        let known = self.index().known_files()?;
        let plan = SyncPlan::new(&self.vault, known)?;
        for batch in plan.batches() {
            progress(batch.done, plan.total);
            self.index()
                .apply_sync(&self.vault, batch.changed, batch.removed)?;
        }
        progress(plan.total, plan.total);
        self.synced
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(plan.stats)
    }

    /// For a watcher keeping the index current: tells other processes they needn't walk the
    /// vault themselves. Does nothing until the first full sync is done.
    pub fn heartbeat(&self) {
        if self.synced.load(std::sync::atomic::Ordering::Relaxed) {
            self.index().mark_watched();
        }
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
}

impl FileService {
    pub fn list(&self, dir: &str, recursive: bool) -> Result<Vec<Entry>> {
        self.check_read(dir)?;
        let rules = self.rules()?;
        let mut entries = self.vault.list(dir, recursive)?;
        entries.retain(|e| Context::visible(&rules, &e.path));
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
}

impl Workspace {
    pub fn vault_preferences(&self) -> Result<crate::preferences::VaultPreferences> {
        let raw = Settings::try_load()
            .map_err(|e| Error::io("settings.json", e))?
            .vault_preferences
            .get(self.vault.root())
            .cloned();
        let configured = raw.is_some();
        let mut preferences: crate::preferences::VaultPreferences = match raw {
            Some(raw) => serde_json::from_value(raw).map_err(|e| {
                Error::Invalid(format!("Repair vault preferences in Settings: {e}"))
            })?,
            None => Default::default(),
        };
        preferences.validate()?;
        preferences
            .other
            .entry("legacy_migrated".into())
            .or_insert(serde_json::Value::Bool(configured));
        Ok(preferences)
    }

    /// A partial update preserves both unrelated and unknown settings.
    pub fn set_vault_preferences(&self, patch: serde_json::Value) -> Result<()> {
        if self.source() != Source::App {
            return Err(Error::Denied(
                "Vault preferences are configured only in Settings".into(),
            ));
        }
        let patch = patch
            .as_object()
            .ok_or_else(|| Error::Invalid("Expected a preferences object".into()))?;
        let mut failure = None;
        Settings::update(|s| {
            match crate::preferences::VaultPreferences::patched(
                s.vault_preferences.get(self.vault.root()),
                patch,
            ) {
                Ok(value) => {
                    s.vault_preferences
                        .insert(self.vault.root().to_path_buf(), value);
                    true
                }
                Err(error) => {
                    failure = Some(error);
                    false
                }
            }
        })
        .map_err(|e| Error::io("settings.json", e))?;
        failure.map_or(Ok(()), Err)
    }

    pub fn template_config(&self) -> Result<crate::templates::TemplateConfig> {
        let settings = Settings::load();
        let config: crate::templates::TemplateConfig = match settings
            .templates
            .get(self.vault.root())
        {
            Some(raw) => serde_json::from_value(raw.clone()).map_err(|_| {
                Error::Invalid("Invalid template settings; repair in Settings › Templates".into())
            })?,
            None => Default::default(),
        };
        config.validate()?;
        Ok(config)
    }

    pub fn set_template_config(&self, config: crate::templates::TemplateConfig) -> Result<()> {
        if self.source() != Source::App {
            return Err(Error::Denied(
                "Template defaults are configured only in Settings".into(),
            ));
        }
        config.validate()?;
        let value = serde_json::to_value(config).map_err(|e| Error::Invalid(e.to_string()))?;
        Settings::update(|s| {
            s.templates.insert(self.vault.root().to_path_buf(), value);
            true
        })
        .map_err(|e| Error::io("settings.json", e))
    }

    pub fn list_templates(&self, path: Option<&str>) -> Result<crate::templates::TemplateList> {
        let config = self.template_config()?;
        let default = match path {
            Some(p) => {
                let p = crate::templates::note_path(p)?;
                self.check_read(&p)?;
                config.resolve(&p)
            }
            None => Default::default(),
        };
        if let Some(t) = &default.template {
            self.check_read(t)?;
        }
        let mut templates: Vec<_> = self
            .files
            .list("", true)?
            .into_iter()
            .filter(|e| {
                !e.is_dir
                    && e.path.to_lowercase().ends_with(".md")
                    && crate::templates::within(&e.path, &config.folder)
            })
            .map(|e| crate::templates::TemplateEntry {
                path: e.path,
                name: e.name,
            })
            .collect();
        templates.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(crate::templates::TemplateList { templates, default })
    }

    pub fn render_template(
        &self,
        request: &crate::templates::TemplateRequest,
    ) -> Result<crate::templates::TemplatePreview> {
        self.check_read(&request.path)?;
        crate::templates::render(self, &self.template_config()?, request)
    }

    pub fn create_note(
        &self,
        request: &crate::templates::TemplateRequest,
    ) -> Result<crate::templates::CreatedNote> {
        self.check_write(&request.path)?;
        let preview = self.render_template(request)?;
        let written = self.files.create(&preview.path, &preview.content)?;
        Ok(crate::templates::CreatedNote {
            written,
            template: preview.template,
            rule_folder: preview.rule_folder,
        })
    }
}

impl FileService {
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

    /// Change one task's workflow, preserving its list marker, nesting, dates and links.
    /// Both label and previous state must still match the task shown by the board.
    pub fn set_task_workflow(
        &self,
        path: &str,
        line: usize,
        text: &str,
        expected_state: &str,
        next: &str,
    ) -> Result<Written> {
        if !crate::task_board::STATES.contains(&next) {
            return Err(Error::Invalid(format!(
                "Unknown task workflow state: {next}"
            )));
        }
        self.check_read(path)?;
        let norm = normalize(path)?;
        let (content, hash) = self
            .text_of(&norm)
            .ok_or_else(|| Error::NotFound(norm.clone()))?;
        let conflict = || Error::Conflict {
            path: norm.clone(),
            current_hash: hash.clone(),
        };
        let task = crate::parse::parse(&content)
            .tasks
            .into_iter()
            .find(|t| t.line == line)
            .ok_or_else(conflict)?;
        if !matches!(task.mark, ' ' | 'x' | 'X')
            || crate::task_board::label(&task.text) != text
            || crate::task_board::state(&task.text, task.mark) != expected_state
        {
            return Err(conflict());
        }
        let mut lines: Vec<&str> = content.split_inclusive('\n').collect();
        let raw = lines[line - 1];
        let body = raw.trim_end_matches(['\n', '\r']);
        let marked =
            crate::parse::with_task_mark(body, &task.text, if next == "done" { 'x' } else { ' ' })
                .ok_or_else(conflict)?;
        let annotated = crate::task_board::annotate(&task.text, next);
        let updated = crate::parse::with_task_text(&marked, &annotated).ok_or_else(conflict)?;
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
            return match self.read(from)?.content {
                Some(text) => self.propose_create(&to_n, &text),
                None => self.propose_binary_create(&to_n, &self.vault.read_bytes(from)?),
            };
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
            if self.in_review(&normalize(&candidate)?) {
                match self.propose_binary_create(&candidate, bytes) {
                    Err(Error::AlreadyExists(_)) => continue,
                    r => return r,
                }
            }
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
                &self.source(),
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
        let rules = self.rules()?;
        let mut list = self.hist().activity(limit)?;
        list.retain(|v| Context::visible(&rules, &v.path));
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
}

impl Workspace {
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let rules = self.rules()?;
        if rules.is_empty() {
            return self.reading().search(query, limit);
        }
        // Ask for more, so hidden hits don't leave the agent with a short list.
        let mut hits = self.reading().search(query, limit + 100)?;
        hits.retain(|h| Context::visible(&rules, &h.path));
        hits.truncate(limit);
        Ok(hits)
    }

    /// Notes matching a structured query (see `crate::query` for the language). Agents only see
    /// what their folder rules let them see.
    pub fn query(&self, query: &str) -> Result<crate::query::QueryResult> {
        let q = crate::query::parse(query)?;
        let rules = self.rules()?;
        q.run(&self.reading(), |p| Context::visible(&rules, p))
    }
}

impl LinkService {
    pub fn backlinks(&self, path: &str) -> Result<Vec<Backlink>> {
        self.check_read(path)?;
        let rules = self.rules()?;
        let mut list = self.reading().backlinks(&normalize(path)?)?;
        list.retain(|b| Context::visible(&rules, &b.source));
        Ok(list)
    }
}

impl Workspace {
    /// Tags with counts. With hidden folders, only notes agents can see are counted.
    pub fn tags(&self) -> Result<Vec<TagCount>> {
        let rules = self.rules()?;
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
        let rules = self.rules()?;
        let mut paths = self.reading().paths_with_tag(tag)?;
        paths.retain(|p| Context::visible(&rules, p));
        Ok(paths)
    }

    pub fn aliases(&self) -> Result<Vec<(String, String)>> {
        self.reading().aliases()
    }
}

impl LinkService {
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
        let rules = self.rules()?;
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
                    || !Context::visible(&rules, &h.path)
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
        let file = self.files.read(source)?;
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
        self.files.write(&file.path, &out, Some(&file.hash))
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
        let rules = self.rules()?;
        let index = self.reading();
        let mut backlinks = index.backlinks(&file.path)?;
        backlinks.retain(|b| Context::visible(&rules, &b.source));
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
}

impl FileService {
    /// Moves or renames a file or folder. With `update_links`, every link pointing at a moved file
    /// (and relative Markdown links inside moved notes) is rewritten, as Obsidian does.
    pub fn rename(&self, from: &str, to: &str, update_links: bool) -> Result<Renamed> {
        self.check_write(from)?;
        self.check_write(to)?;
        let from = normalize(from)?;
        let to_n = normalize(to)?;
        if self.in_review(&from) || self.in_review(&to_n) {
            return self.propose_rename(&from, &to_n, update_links);
        }
        let actor = self.actor();
        self.rename_direct(&from, &to_n, update_links, &self.source(), actor.as_deref())
            .map(|(renamed, _)| renamed)
    }

    /// Applies an already-authorized rename. The returned history id is the rename marker used by
    /// review mode to connect the accepted proposal to Undo.
    pub(crate) fn rename_direct(
        &self,
        from: &str,
        to_n: &str,
        update_links: bool,
        source: &Source,
        actor: Option<&str>,
    ) -> Result<(Renamed, Option<i64>)> {
        let src_entry = self.vault.stat(from)?;
        let moved: Vec<String> = if src_entry.is_dir {
            self.vault
                .list(from, true)?
                .into_iter()
                .filter(|e| !e.is_dir)
                .map(|e| e.path)
                .collect()
        } else {
            vec![from.to_string()]
        };
        let map_path = |p: &str| -> String {
            if p == from {
                to_n.to_string()
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
            let rules = self.rules()?;
            let blocked: Vec<&String> = sources
                .iter()
                .filter(|p| access_for(&rules, p).is_some())
                .collect();
            if !blocked.is_empty() {
                let shown: Vec<&str> = blocked
                    .iter()
                    .filter(|p| Context::visible(&rules, p))
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

        // Journaled first: if a link rewrite fails or Mosaic stops half-way, the move is known and
        // its links can be fixed later. Without a history the move still happens, unjournaled.
        let sources: Vec<String> = sources.into_iter().collect();
        let journal = (old_set.is_some() && !sources.is_empty())
            .then(|| self.hist().begin_rename(from, to_n, &sources).ok())
            .flatten();
        let out = self.vault.rename(from, to_n)?;
        if let Some(id) = journal
            && out != to_n
        {
            let _ = self.hist().moved_to(id, &out);
        }
        let version_id = self.hist().renamed(from, &out, source, actor).ok();
        let (mut updated, mut failed) = (Vec::new(), Vec::new());

        if let Some(old_set) = old_set {
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
            (updated, failed) = self.rewrite_sources(
                &old_set, &new_set, &sources, &moved, &map_path, source, actor,
            );
        }
        if let Some(id) = journal
            && failed.is_empty()
        {
            let _ = self.hist().finish_rename(id);
        }

        self.reindex(from);
        self.reindex(&out);
        for p in &updated {
            self.reindex(p);
        }
        // Bookmarks follow the move too. They are secondary: a failure here doesn't undo the rename.
        let root = self.vault.root();
        let _ = crate::vault_state::update_bookmarks_for(root, |list| {
            crate::vault_state::remap_bookmarks(list, from, &out)
        });
        let _ = Settings::update(|s| {
            let mut changed = false;
            if let Some(raw) = s.vault_preferences.get_mut(root)
                && let Ok(mut config) =
                    serde_json::from_value::<crate::preferences::VaultPreferences>(raw.clone())
            {
                let old = config.clone();
                config.remap(from, &out);
                if config != old {
                    *raw = serde_json::to_value(config).expect("preferences");
                    changed = true;
                }
            }
            if let Some(raw) = s.templates.get_mut(root)
                && let Ok(mut config) =
                    serde_json::from_value::<crate::templates::TemplateConfig>(raw.clone())
            {
                let old = config.clone();
                config.remap(from, &out);
                if config != old {
                    *raw = serde_json::to_value(config).expect("template configuration");
                    changed = true;
                }
            }
            changed
        });
        Ok((
            Renamed {
                path: out,
                updated_links_in: updated,
                failed_links_in: failed,
                review: None,
            },
            version_id,
        ))
    }

    /// The vault's bookmarks, in the user's order. They live in the app's settings, not in the vault.
    pub fn bookmarks(&self) -> Vec<Bookmark> {
        crate::vault_state::bookmarks_for(self.vault.root())
            .unwrap_or_default()
            .into_iter()
            .map(|path| Bookmark {
                // Saved searches and structured queries always "exist".
                exists: path.starts_with("search:")
                    || path.starts_with("query:")
                    || self.vault.stat(&path).is_ok(),
                path,
            })
            .collect()
    }

    /// Bookmarks an existing file or folder (at the end of the list; no-op if already there).
    /// Bookmarks a file or folder, a search (`search:<query>`) or structured query (`query:<query>`).
    pub fn add_bookmark(&self, path: &str) -> Result<Vec<Bookmark>> {
        let path = if let Some(q) = path
            .strip_prefix("search:")
            .filter(|q| !q.trim().is_empty())
        {
            format!("search:{}", q.trim())
        } else if let Some(q) = path.strip_prefix("query:").filter(|q| !q.trim().is_empty()) {
            crate::query::parse(q.trim())?;
            format!("query:{}", q.trim())
        } else {
            self.vault.stat(path)?.path
        };
        if path.is_empty() {
            return Err(Error::InvalidPath("cannot bookmark the vault root".into()));
        }
        crate::vault_state::update_bookmarks_for(self.vault.root(), |list| {
            if list.contains(&path) {
                return false;
            }
            list.push(path.clone());
            true
        })?;
        Ok(self.bookmarks())
    }

    /// Removes a bookmark (also one whose file no longer exists).
    pub fn remove_bookmark(&self, path: &str) -> Result<Vec<Bookmark>> {
        let path = normalize(path)?;
        let mut found = false;
        crate::vault_state::update_bookmarks_for(self.vault.root(), |list| {
            let before = list.len();
            list.retain(|p| p != &path);
            found = list.len() < before;
            found
        })?;
        if !found {
            return Err(Error::Invalid(format!("{path} isn't bookmarked")));
        }
        Ok(self.bookmarks())
    }

    /// Rewrites links in each source note (by its path before the move). A note that can't be
    /// rewritten is reported and the others still are: the move has already happened.
    #[allow(clippy::too_many_arguments)]
    fn rewrite_sources(
        &self,
        old_set: &FileSet,
        new_set: &FileSet,
        sources: &[String],
        moved: &[String],
        map_path: &dyn Fn(&str) -> String,
        source: &Source,
        actor: Option<&str>,
    ) -> (Vec<String>, Vec<FailedLink>) {
        let moved_map: HashMap<String, String> =
            moved.iter().map(|p| (p.clone(), map_path(p))).collect();
        let (mut updated, mut failed) = (Vec::new(), Vec::new());
        for old_src in sources {
            let new_src = map_path(old_src);
            let src_moved = moved_map.contains_key(old_src);
            match self.rewrite_links(
                old_set, new_set, old_src, &new_src, src_moved, &moved_map, map_path, source, actor,
            ) {
                Ok(true) => updated.push(new_src),
                Ok(false) => {}
                Err(e) => failed.push(FailedLink {
                    path: new_src,
                    error: e.to_string(),
                }),
            }
        }
        (updated, failed)
    }

    /// Moves whose links didn't all get rewritten (some failed, or Mosaic stopped half-way).
    pub fn unfinished_renames(&self) -> Result<Vec<crate::history::UnfinishedRename>> {
        self.hist().unfinished_renames()
    }

    /// Finishes an interrupted move: rewrites links that still point at the old names. Notes
    /// already updated are left as they are, so this can be run again until nothing fails. A move
    /// that never happened is simply closed.
    pub fn fix_links(&self, id: i64) -> Result<Renamed> {
        let op = self
            .unfinished_renames()?
            .into_iter()
            .find(|op| op.id == id)
            .ok_or_else(|| Error::Invalid(format!("there is no unfinished move {id}")))?;
        let (from, to) = (op.from.as_str(), op.to.as_str());
        let done = |failed: Vec<FailedLink>, updated: Vec<String>, path: &str| {
            if failed.is_empty() {
                self.hist().finish_rename(id)?;
            }
            Ok(Renamed {
                path: path.to_string(),
                updated_links_in: updated,
                failed_links_in: failed,
                review: None,
            })
        };
        let Ok(dest) = self.vault.stat(to) else {
            // Stopped before the move itself: nothing points at a new name.
            return done(vec![], vec![], from);
        };
        let moved: Vec<String> = if dest.is_dir {
            self.vault
                .list(to, true)?
                .into_iter()
                .filter(|e| !e.is_dir)
                .map(|e| e.path)
                .collect()
        } else {
            vec![to.to_string()]
        };
        let swap = |p: &str, a: &str, b: &str| -> String {
            if p == a {
                b.to_string()
            } else if let Some(rest) = p.strip_prefix(&format!("{a}/")) {
                format!("{b}/{rest}")
            } else {
                p.to_string()
            }
        };
        // The vault as it was before the move, rebuilt from how it is now.
        let now: Vec<String> = self
            .vault
            .list("", true)?
            .into_iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.path)
            .collect();
        let aliases = self.index().aliases()?;
        let before: Vec<String> = now.iter().map(|p| swap(p, to, from)).collect();
        let aliases_before: Vec<(String, String)> = aliases
            .iter()
            .map(|(a, p)| (a.clone(), swap(p, to, from)))
            .collect();
        let old_set = FileSet::new(
            before.iter().map(String::as_str),
            aliases_before.iter().map(|(a, p)| (a.as_str(), p.as_str())),
        );
        let new_set = FileSet::new(
            now.iter().map(String::as_str),
            aliases.iter().map(|(a, p)| (a.as_str(), p.as_str())),
        );
        let moved_before: Vec<String> = moved.iter().map(|p| swap(p, to, from)).collect();
        let map_path = |p: &str| swap(p, from, to);
        let actor = self.actor();
        let (updated, failed) = self.rewrite_sources(
            &old_set,
            &new_set,
            &op.sources,
            &moved_before,
            &map_path,
            &self.source(),
            actor.as_deref(),
        );
        for p in &updated {
            self.reindex(p);
        }
        done(failed, updated, to)
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
        source: &Source,
        actor: Option<&str>,
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
        let _ = self.hist().keep_before(new_src, &text, &file.hash, source);
        self.vault.write(new_src, &new_text, Some(&file.hash))?;
        self.record_as(new_src, Action::Edited, source, actor);
        Ok(true)
    }
}

fn read_only(path: &str) -> Error {
    Error::Denied(format!(
        "{path} is read-only for agents (set by the person using Mosaic, in Settings › AI)"
    ))
}

#[derive(Default)]
struct FrozenRules {
    depth: usize,
    rules: Option<Vec<AgentRule>>,
}

/// See `Workspace::freeze_rules`. Requests may overlap; the rules are read again after the last ends.
pub struct RulesFrozen<W: std::ops::Deref<Target = Workspace>> {
    ws: W,
}

impl<W: std::ops::Deref<Target = Workspace>> RulesFrozen<W> {
    fn new(ws: W) -> Self {
        ws.frozen_rules
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .depth += 1;
        Self { ws }
    }
}

impl<W: std::ops::Deref<Target = Workspace>> std::ops::Deref for RulesFrozen<W> {
    type Target = Workspace;
    fn deref(&self) -> &Workspace {
        &self.ws
    }
}

impl<W: std::ops::Deref<Target = Workspace>> Drop for RulesFrozen<W> {
    fn drop(&mut self) {
        let mut frozen = self
            .ws
            .frozen_rules
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        frozen.depth -= 1;
        if frozen.depth == 0 {
            frozen.rules = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::tests::fixture;
    use std::time::Duration;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let (d, v) = fixture();
        let w = Workspace::new(v, Index::in_memory().unwrap());
        w.sync(|_, _| {}).unwrap();
        (d, w)
    }

    fn text(w: &Workspace, p: &str) -> String {
        w.files.read(p).unwrap().content.unwrap()
    }

    #[test]
    fn the_app_heartbeat_tells_other_processes_the_index_is_current() {
        let (d, v) = fixture();
        let db = d.path().join(".cache/index.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let w = Workspace::new(v, Index::open_at(&db).unwrap());
        let other = Index::open_at(&db).unwrap();
        // Not before the first full sync: the index may still be incomplete.
        w.heartbeat();
        assert!(!other.watched_within(Duration::from_secs(5)));
        w.sync(|_, _| {}).unwrap();
        w.heartbeat();
        assert!(other.watched_within(Duration::from_secs(5)));
        assert!(!other.watched_within(Duration::ZERO));
        // An in-memory index has no heartbeat to share.
        assert!(
            !Index::in_memory()
                .unwrap()
                .watched_within(Duration::from_secs(5))
        );
    }

    #[test]
    fn a_history_that_cant_open_is_reported_not_silently_lost() {
        let (d, _) = fixture();
        std::fs::create_dir_all(d.path().join(".mosaic")).unwrap();
        std::fs::write(d.path().join(".mosaic/vault.json"), "{ half").unwrap();
        let w = Workspace::open(d.path()).unwrap();
        let warning = w.history_warning().expect("a warning");
        assert!(warning.contains("vault.json"), "{warning}");
        // Notes still work, with history for this session only.
        w.files.write("Ideas.md", "changed", None).unwrap();
        assert!(!w.files.history("Ideas.md", 5).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(d.path().join(".mosaic/vault.json")).unwrap(),
            "{ half"
        );
    }

    #[test]
    fn sync_lets_writes_in_between_batches() {
        let (d, v) = fixture();
        for i in 0..600 {
            std::fs::write(d.path().join(format!("n{i}.md")), format!("# N{i}\n")).unwrap();
        }
        let w = Workspace::new(v, Index::in_memory().unwrap());
        let mut calls = 0;
        let stats = w
            .sync(|done, total| {
                calls += 1;
                assert!(done <= total);
                // Between batches the index is free, so an autosave doesn't wait for the whole walk.
                assert!(w.index.try_lock().is_ok(), "index locked during progress");
            })
            .unwrap();
        assert!(calls >= 3, "{calls} progress calls");
        assert!(stats.indexed >= 600);
        assert_eq!(w.search("N599", 5).unwrap()[0].path, "n599.md");
        // Files that disappear while it runs aren't indexed as ghosts.
        std::fs::write(d.path().join("gone.md"), "x").unwrap();
        let again = w
            .sync(|_, _| std::fs::remove_file(d.path().join("gone.md")).unwrap_or(()))
            .unwrap();
        assert_eq!(again.unchanged, stats.indexed);
        assert!(
            w.search("x", 5)
                .unwrap()
                .iter()
                .all(|h| h.path != "gone.md")
        );
    }

    #[test]
    fn board_states_preserve_tasks_and_reject_stale_cards() {
        let (_d, w) = ws();
        w.files.create("Board.md", "# Board\r\n1. [ ] Ship [[Plan]] 📅 2026-10-10 ^ship\r\n\t- [ ] Review #urgent  \r\n- [>] Moved\r\n```\n- [ ] Fake\n```\n").unwrap();
        w.files
            .set_task_workflow(
                "Board.md",
                2,
                "Ship [[Plan]] 📅 2026-10-10 ^ship",
                "new",
                "in-progress",
            )
            .unwrap();
        assert!(text(&w, "Board.md").contains(
            "1. [ ] Ship [[Plan]] 📅 2026-10-10 <!-- mosaic:state=in-progress --> ^ship\r\n"
        ));
        assert!(matches!(
            w.files.set_task_workflow(
                "Board.md",
                2,
                "Ship [[Plan]] 📅 2026-10-10 ^ship",
                "new",
                "blocked"
            ),
            Err(Error::Conflict { .. })
        ));
        w.files
            .set_task_workflow("Board.md", 3, "Review #urgent", "new", "done")
            .unwrap();
        assert!(text(&w, "Board.md").contains("\t- [x] Review #urgent  \r\n"));
        let result = w.query("task:all workflow=done").unwrap();
        assert_eq!(result.rows.len(), 1);
        let task = result.rows[0].task.as_ref().unwrap();
        assert_eq!(task.text, "Review #urgent");
        assert_eq!(task.parent, Some(2));
        w.files
            .set_task("Board.md", 3, "Review #urgent", false)
            .unwrap();
        assert!(text(&w, "Board.md").contains("\t- [ ] Review #urgent  \r\n"));
        assert!(
            w.files
                .set_task_workflow("Board.md", 4, "Moved", "new", "blocked")
                .is_err()
        );
        assert!(
            w.files
                .set_task_workflow("Board.md", 6, "Fake", "new", "blocked")
                .is_err()
        );
        assert!(
            w.files
                .set_task_workflow("Board.md", 2, "Changed label", "in-progress", "done")
                .is_err()
        );
        assert!(
            w.files
                .set_task_workflow(
                    "Board.md",
                    2,
                    "Ship [[Plan]] 📅 2026-10-10 ^ship",
                    "in-progress",
                    "unknown"
                )
                .is_err()
        );
        w.files
            .set_task_workflow(
                "Board.md",
                2,
                "Ship [[Plan]] 📅 2026-10-10 ^ship",
                "in-progress",
                "new",
            )
            .unwrap();
        assert!(!text(&w, "Board.md").contains("mosaic:state="));
    }

    #[test]
    fn ticking_a_task_from_a_query() {
        let (d, w) = ws();
        w.files
            .create("Day.md", "# Day\r\n- [ ] Write\r\n    - [ ] Sub\r\n")
            .unwrap();
        w.files.set_task("Day.md", 3, "Sub", true).unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join("Day.md")).unwrap(),
            "# Day\r\n- [ ] Write\r\n    - [x] Sub\r\n"
        );
        w.files.set_task("Day.md", 3, "Sub", false).unwrap();
        // The line moved or holds another task: refused, nothing written.
        assert!(matches!(
            w.files.set_task("Day.md", 2, "Sub", true),
            Err(Error::Conflict { .. })
        ));
        assert!(matches!(
            w.files.set_task("Day.md", 9, "Sub", true),
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
        w.files
            .create("New.md", "Links to [[Ideas]] about #zebra")
            .unwrap();
        assert_eq!(w.search("zebra", 5).unwrap()[0].path, "New.md");
        assert!(
            w.links
                .backlinks("Ideas.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "New.md")
        );
        w.files.patch("New.md", "zebra", "okapi", None).unwrap();
        assert!(w.search("zebra", 5).unwrap().is_empty());
    }

    #[test]
    fn import_never_overwrites_and_numbers_like_finder() {
        let (_d, w) = ws();
        let png = [0x89, b'P', b'N', b'G', 0];
        assert_eq!(w.files.import("img/a.png", &png).unwrap().path, "img/a.png");
        assert_eq!(
            w.files.import("img/a.png", &png).unwrap().path,
            "img/a 1.png"
        );
        assert_eq!(
            w.files.import("img/a.png", &png).unwrap().path,
            "img/a 2.png"
        );
        assert_eq!(w.files.import("Ideas.md", b"x").unwrap().path, "Ideas 1.md");
        assert_eq!(
            w.files.import("v1.0/README", b"x").unwrap().path,
            "v1.0/README"
        );
        assert_eq!(
            w.files.import("v1.0/README", b"x").unwrap().path,
            "v1.0/README 1"
        );
        assert_eq!(
            w.files.import(".env", b"x").unwrap_err().code(),
            "invalid_path"
        );
    }

    #[test]
    fn renaming_a_note_updates_links_everywhere() {
        let (_d, w) = ws();
        let r = w
            .files
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
            w.links
                .backlinks("Thoughts/Brainstorm.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "Home.md")
        );
    }

    #[test]
    fn moving_a_note_fixes_its_own_relative_markdown_links() {
        let (_d, w) = ws();
        w.files
            .rename("Projects/Mosaic/Plan.md", "Plan.md", true)
            .unwrap();
        let plan = text(&w, "Plan.md");
        assert!(plan.contains("[Ideas](Ideas.md)"), "{plan}");
        // Home linked with the full path; it now resolves by name.
        assert!(text(&w, "Home.md").contains("[[Plan|the plan]]"));
    }

    #[test]
    fn renaming_a_folder_updates_links_into_it() {
        let (_d, w) = ws();
        w.files.rename("Projects", "Work", true).unwrap();
        // Only one "Plan" exists, so the shortest form is used (Obsidian's default).
        assert!(text(&w, "Home.md").contains("[[Plan|the plan]]"));
        assert!(
            w.links
                .backlinks("Work/Mosaic/Plan.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "Home.md")
        );
        assert!(
            w.links
                .backlinks("Ideas.md")
                .unwrap()
                .iter()
                .any(|b| b.source == "Work/Mosaic/Plan.md")
        );
    }

    #[test]
    fn unrelated_files_and_frontmatter_are_untouched() {
        let (_d, w) = ws();
        let before = text(&w, "Daily/2026-09-30.md");
        w.files.rename("Ideas.md", "Ideas2.md", true).unwrap();
        assert_eq!(text(&w, "Daily/2026-09-30.md"), before);
        assert!(text(&w, "Home.md").starts_with(
            "---\naliases: [Start, Index]\ntags: [hub]\ncustom_key: keep me exactly\n---"
        ));
    }

    #[test]
    fn outline_summarises_a_note() {
        let (_d, w) = ws();
        let o = w.links.outline("Home.md").unwrap();
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
        w.files.create("Test/Plan.md", "# Plan").unwrap();
        let canvas = r#"{"nodes":[{"id":"a","type":"file","file":"Test/Plan.md","x":0,"y":0,"width":10,"height":10}],"edges":[]}"#;
        w.files.create("Test/Map.canvas", canvas).unwrap();
        let r = w.files.rename("Test", "Documentation", true).unwrap();
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
        w.files
            .patch("Ideas.md", "Ideas", "Thoughts", None)
            .unwrap();
        let act = w.files.activity(10).unwrap();
        assert_eq!(
            (
                act[0].path.as_str(),
                act[0].action.as_str(),
                act[0].actor.as_deref()
            ),
            ("Ideas.md", "edited", Some("claude-code"))
        );
        // The version before the agent's edit is kept.
        let hist = w.files.history("Ideas.md", 10).unwrap();
        assert_eq!(
            hist.iter().map(|v| v.action.as_str()).collect::<Vec<_>>(),
            ["edited", "before"]
        );
        w.files.undo(act[0].id).unwrap();
        assert_eq!(text(&w, "Ideas.md"), before);
    }

    #[test]
    fn undo_refuses_when_the_file_changed_since() {
        let (_d, w) = agent_ws();
        w.files.append("Ideas.md", "agent line").unwrap();
        let id = w.files.activity(1).unwrap()[0].id;
        w.files.append("Ideas.md", "human line").unwrap();
        assert!(matches!(w.files.undo(id), Err(Error::Conflict { .. })));
    }

    #[test]
    fn undo_reverses_create_delete_and_rename() {
        let (_d, w) = agent_ws();
        w.files.create("New.md", "hello").unwrap();
        let created = w.files.activity(1).unwrap()[0].id;
        w.files.undo(created).unwrap();
        assert!(w.files.read("New.md").is_err());

        let home = text(&w, "Home.md");
        w.files.delete("Home.md").unwrap();
        let deleted = w.files.activity(1).unwrap()[0].id;
        w.files.undo(deleted).unwrap();
        assert_eq!(text(&w, "Home.md"), home);

        w.files
            .rename("Ideas.md", "Archive/Ideas.md", true)
            .unwrap();
        let moved = w
            .files
            .activity(10)
            .unwrap()
            .into_iter()
            .find(|v| v.action == "renamed")
            .unwrap()
            .id;
        w.files.undo(moved).unwrap();
        assert!(w.files.read("Ideas.md").is_ok());
        assert!(w.files.read("Archive/Ideas.md").is_err());
    }

    #[test]
    fn external_changes_are_kept_and_restorable() {
        let (d, w) = ws();
        std::fs::write(d.path().join("Ideas.md"), "changed in another editor").unwrap();
        w.refresh("Ideas.md").unwrap();
        let hist = w.files.history("Ideas.md", 10).unwrap();
        assert_eq!(
            (hist[0].source.as_str(), hist[0].action.as_str()),
            ("external", "before")
        );
        w.files.write("Ideas.md", "mine", None).unwrap();
        w.files.restore("Ideas.md", hist[0].id, None).unwrap();
        assert_eq!(text(&w, "Ideas.md"), "changed in another editor");
        assert_eq!(
            w.files.history("Ideas.md", 1).unwrap()[0].action,
            "restored"
        );
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
        w.files.create("Zebra.md", "zebra stripes").unwrap();
        assert_eq!(w.search("zebra", 5).unwrap()[0].path, "Zebra.md");
        assert!(
            w.links
                .backlinks("Ideas.md")
                .unwrap()
                .iter()
                .all(|b| !b.source.is_empty())
        );
    }

    #[test]
    fn alias_links_stay_when_their_note_moves() {
        let (_d, w) = ws();
        w.files
            .create("Note.md", "---\naliases: [Start]\n---\n# Note")
            .unwrap();
        w.files
            .create("Other.md", "See [[Start]] and [[Note]]")
            .unwrap();
        w.files.rename("Note.md", "Archive/Note.md", true).unwrap();
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
        w.files.create("Roadmap.md", "# Roadmap").unwrap();
        w.files
            .create(
                "Notes.md",
                "Talked about the roadmap today.\nAlready linked elsewhere: no.",
            )
            .unwrap();
        w.files
            .create("Linked.md", "See [[Roadmap]], the roadmap.")
            .unwrap();
        let m = w.links.unlinked_mentions("Roadmap.md", 10).unwrap();
        assert_eq!(m.len(), 1, "a note that already links isn't listed: {m:?}");
        assert_eq!(
            (m[0].source.as_str(), m[0].line, m[0].text.as_str()),
            ("Notes.md", 1, "roadmap")
        );
        w.links
            .link_mention("Notes.md", 1, "roadmap", "Roadmap.md")
            .unwrap();
        assert!(text(&w, "Notes.md").starts_with("Talked about the [[Roadmap|roadmap]] today."));
        assert!(
            w.links
                .unlinked_mentions("Roadmap.md", 10)
                .unwrap()
                .is_empty()
        );
    }

    /// A vault where three notes link to `A.md`, with its history in a file so a restart sees it.
    fn linked_vault() -> (tempfile::TempDir, std::path::PathBuf, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in [
            ("A.md", "# A"),
            ("Notes/One.md", "See [[A]]."),
            ("Locked/Two.md", "See [[A]]."),
            ("Notes/Three.md", "See [[A]]."),
        ] {
            let full = dir.path().join(p);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, c).unwrap();
        }
        let db = dir.path().join(".history-test.db");
        let w = Workspace::with_history_file(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
            &db,
        );
        w.sync(|_, _| {}).unwrap();
        (dir, db, w)
    }

    fn lock(dir: &std::path::Path, locked: bool) {
        use std::os::unix::fs::PermissionsExt;
        let mode = if locked { 0o555 } else { 0o755 };
        std::fs::set_permissions(dir.join("Locked"), std::fs::Permissions::from_mode(mode))
            .unwrap();
    }

    #[test]
    fn a_link_that_cant_be_rewritten_is_reported_and_can_be_fixed_later() {
        let (d, _db, w) = linked_vault();
        lock(d.path(), true);
        let renamed = w.files.rename("A.md", "B.md", true);
        lock(d.path(), false);

        // The move happened and the other notes followed; the failure is reported, not an error.
        let renamed = renamed.unwrap();
        assert_eq!(renamed.path, "B.md");
        assert_eq!(
            renamed.updated_links_in,
            vec!["Notes/One.md", "Notes/Three.md"]
        );
        assert_eq!(renamed.failed_links_in.len(), 1);
        assert_eq!(renamed.failed_links_in[0].path, "Locked/Two.md");
        assert_eq!(text(&w, "Locked/Two.md"), "See [[A]].");

        let open = w.files.unfinished_renames().unwrap();
        assert_eq!(
            (open.len(), open[0].from.as_str(), open[0].to.as_str()),
            (1, "A.md", "B.md")
        );
        let fixed = w.files.fix_links(open[0].id).unwrap();
        assert_eq!(fixed.updated_links_in, vec!["Locked/Two.md"]);
        assert!(fixed.failed_links_in.is_empty());
        assert_eq!(text(&w, "Locked/Two.md"), "See [[B]].");
        assert_eq!(text(&w, "Notes/One.md"), "See [[B]].");
        assert!(w.files.unfinished_renames().unwrap().is_empty());
        assert!(w.files.fix_links(open[0].id).is_err());
    }

    #[test]
    fn a_move_interrupted_before_its_links_is_finished_after_a_restart() {
        let (d, db, w) = linked_vault();
        // Mosaic stopped right after moving the file: journaled, moved, no link rewritten.
        let sources = ["Locked/Two.md", "Notes/One.md", "Notes/Three.md"].map(String::from);
        w.hist().begin_rename("A.md", "B.md", &sources).unwrap();
        w.vault.rename("A.md", "B.md").unwrap();
        drop(w);

        let w = Workspace::with_history_file(
            Vault::open(d.path()).unwrap(),
            Index::in_memory().unwrap(),
            &db,
        );
        w.sync(|_, _| {}).unwrap();
        let open = w.files.unfinished_renames().unwrap();
        assert_eq!(open.len(), 1);
        let fixed = w.files.fix_links(open[0].id).unwrap();
        assert_eq!(fixed.updated_links_in.len(), 3);
        for p in sources {
            assert_eq!(text(&w, &p), "See [[B]].");
        }
        assert!(w.files.unfinished_renames().unwrap().is_empty());
    }

    #[test]
    fn a_move_interrupted_before_the_move_is_just_closed() {
        let (_d, _db, w) = linked_vault();
        let id = w
            .hist()
            .begin_rename("A.md", "B.md", &["Notes/One.md".to_string()])
            .unwrap();
        let fixed = w.files.fix_links(id).unwrap();
        assert_eq!(fixed.path, "A.md");
        assert!(fixed.updated_links_in.is_empty());
        assert_eq!(text(&w, "Notes/One.md"), "See [[A]].");
        assert!(w.files.unfinished_renames().unwrap().is_empty());
    }

    #[test]
    fn a_complete_move_leaves_nothing_to_fix() {
        let (_d, _db, w) = linked_vault();
        let renamed = w.files.rename("A.md", "B.md", true).unwrap();
        assert_eq!(renamed.updated_links_in.len(), 3);
        assert!(renamed.failed_links_in.is_empty());
        assert!(w.files.unfinished_renames().unwrap().is_empty());
    }
}
