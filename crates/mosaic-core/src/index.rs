//! Incremental SQLite index of a vault: files, links, tags and full text (FTS5). It lives in
//! `~/Library/Caches/mosaic/<vault-hash>/index.db`, never inside the vault, and can always be rebuilt
//! from the files.

use crate::error::{Error, Result};
use crate::kind::FileKind;
use crate::links::{FileSet, link_key};
use crate::parse::{self, LinkKind, Parsed};
use crate::vault::{Entry, Vault, hash_bytes};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Text files above this size are listed but their content isn't indexed.
const MAX_INDEXED_BYTES: u64 = 2 * 1024 * 1024;
/// Bump when the tables or what's extracted from files change: the index is then rebuilt from scratch.
/// 2: Excalidraw text only, canvas backlink context, chart data files as embeds.
const SCHEMA_VERSION: i64 = 2;

pub struct Index {
    conn: Connection,
    /// Cached file set, with the database's `data_version` it was read at (another connection's
    /// commit changes it, so a reader notices the writer's changes).
    files: RwLock<Option<(i64, Arc<FileSet>)>>,
    /// The database file, when not in memory (lets the workspace open a read-only twin).
    path: Option<PathBuf>,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
pub struct SyncStats {
    pub indexed: usize,
    pub removed: usize,
    pub unchanged: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// Matching excerpt; matched terms are wrapped in `**`.
    pub snippet: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Backlink {
    pub source: String,
    pub line: usize,
    /// The source line containing the link.
    pub context: String,
    pub embed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutLink {
    pub target: String,
    /// Vault path the link resolves to, or `None` if the note doesn't exist yet.
    pub resolved: Option<String>,
    pub line: usize,
    pub embed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

/// Retries an operation that SQLite refused because another process holds the database (up to ~5 s).
pub(crate) fn retry_busy<T>(mut f: impl FnMut() -> rusqlite::Result<T>) -> rusqlite::Result<T> {
    let mut tries = 0;
    loop {
        match f() {
            Err(rusqlite::Error::SqliteFailure(e, _))
                if tries < 50
                    && matches!(
                        e.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) =>
            {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            r => return r,
        }
    }
}

fn sql_err(e: rusqlite::Error) -> Error {
    Error::Io {
        path: "index".into(),
        source: std::io::Error::other(e.to_string()),
    }
}

pub fn default_db_path(vault_root: &Path) -> Option<PathBuf> {
    let hash = hash_bytes(vault_root.to_string_lossy().as_bytes());
    Some(
        crate::settings::cache_dir()?
            .join(&hash[..16])
            .join("index.db"),
    )
}

/// Content extracted from a file for the index.
struct Extracted {
    title: String,
    body: String,
    parsed: Parsed,
    /// Backlink context for each of `parsed.links`, for files without meaningful lines (canvases,
    /// drawings). Empty: the context is the source line the link is on.
    contexts: Vec<String>,
}

fn extract(path: &str, kind: FileKind, text: &str) -> Extracted {
    match kind {
        FileKind::Markdown => {
            let parsed = parse::parse(text);
            Extracted {
                title: parse::title(&parsed, path),
                body: parsed.body.clone(),
                parsed,
                contexts: Vec::new(),
            }
        }
        FileKind::Canvas => extract_canvas(path, text),
        FileKind::Excalidraw => extract_excalidraw(path, text),
        FileKind::Json if path.to_lowercase().ends_with(".vl.json") => {
            extract_vega_lite(path, text)
        }
        _ => Extracted {
            title: crate::links::file_name(path).to_string(),
            body: text.to_string(),
            parsed: Parsed::default(),
            contexts: Vec::new(),
        },
    }
}

/// An embed found outside Markdown (a canvas file card, a chart's data file).
fn embed_link(kind: LinkKind, target: &str, heading: Option<String>, line: usize) -> parse::Link {
    parse::Link {
        kind,
        target: target.to_string(),
        heading,
        block: None,
        alias: None,
        embed: true,
        line,
        target_range: (0, 0),
    }
}

/// Excalidraw: only the text of text elements is searchable (not the JSON around it). An element's
/// `link` (e.g. `[[Note]]`, as Obsidian's Excalidraw plugin writes) counts as a link from the drawing.
fn extract_excalidraw(path: &str, text: &str) -> Extracted {
    let mut body = String::new();
    let mut parsed = Parsed::default();
    let mut contexts = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        let elements = v.get("elements").and_then(|e| e.as_array());
        for el in elements.into_iter().flatten() {
            if el.get("isDeleted").and_then(|d| d.as_bool()) == Some(true) {
                continue;
            }
            let label = el
                .get("originalText")
                .or_else(|| el.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if el.get("type").and_then(|t| t.as_str()) == Some("text") && !label.is_empty() {
                body.push_str(label);
                body.push('\n');
            }
            if let Some(link) = el.get("link").and_then(|l| l.as_str()) {
                let context = if label.is_empty() {
                    "Linked element"
                } else {
                    label
                };
                for mut l in parse::parse(link).links {
                    l.line = 0;
                    parsed.links.push(l);
                    contexts.push(one_line(context));
                }
            }
        }
    }
    let name = crate::links::file_name(path);
    Extracted {
        title: name.strip_suffix(".excalidraw").unwrap_or(name).to_string(),
        body,
        parsed,
        contexts,
    }
}

/// Vega-Lite chart: every local `data.url` (top level or in layers, concats…) embeds that file,
/// resolved like a Markdown link (relative to the chart first). Remote URLs are ignored.
fn extract_vega_lite(path: &str, text: &str) -> Extracted {
    fn walk(v: &serde_json::Value, urls: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(map) => {
                if let Some(url) = map
                    .get("data")
                    .and_then(|d| d.get("url"))
                    .and_then(|u| u.as_str())
                    && !url.contains("://")
                    && !url.starts_with("data:")
                    && !urls.iter().any(|u| u == url)
                {
                    urls.push(url.to_string());
                }
                map.values().for_each(|c| walk(c, urls));
            }
            serde_json::Value::Array(items) => items.iter().for_each(|c| walk(c, urls)),
            _ => {}
        }
    }
    let mut parsed = Parsed::default();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        let mut urls = Vec::new();
        walk(&v, &mut urls);
        for url in urls {
            let quoted = serde_json::to_string(&url).unwrap_or_default();
            let line = text
                .lines()
                .position(|l| l.contains(&quoted))
                .map_or(0, |i| i + 1);
            parsed
                .links
                .push(embed_link(LinkKind::Markdown, &url, None, line));
        }
    }
    Extracted {
        title: crate::links::file_name(path).to_string(),
        body: text.to_string(),
        parsed,
        contexts: Vec::new(),
    }
}

/// Collapses a card's text to one trimmed line, short enough for the Backlinks panel.
fn one_line(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match joined.char_indices().nth(200) {
        Some((i, _)) => format!("{}…", &joined[..i]),
        None => joined,
    }
}

/// JSON Canvas: text nodes are searchable text (and can hold links); file nodes link to their file.
fn extract_canvas(path: &str, text: &str) -> Extracted {
    let mut body = String::new();
    let mut parsed = Parsed::default();
    let mut contexts = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        for node in v
            .get("nodes")
            .and_then(|n| n.as_array())
            .into_iter()
            .flatten()
        {
            match node.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = node.get("text").and_then(|t| t.as_str()) {
                        let inner = parse::parse(t);
                        let card_lines: Vec<&str> = t.lines().collect();
                        for mut l in inner.links {
                            // The card line holding the link; the card's first line if it's unknown.
                            let at = l.line.max(1) - 1;
                            let line = card_lines
                                .get(at)
                                .or(card_lines.first())
                                .copied()
                                .unwrap_or("");
                            contexts.push(one_line(line));
                            l.line = 0;
                            parsed.links.push(l);
                        }
                        parsed.tags.extend(inner.tags);
                        body.push_str(t);
                        body.push('\n');
                    }
                }
                Some("file") => {
                    if let Some(f) = node.get("file").and_then(|t| t.as_str()) {
                        let heading = node
                            .get("subpath")
                            .and_then(|s| s.as_str())
                            .map(|s| s.trim_start_matches('#').to_string());
                        parsed.links.push(embed_link(LinkKind::Wiki, f, heading, 0));
                        contexts.push("File card".to_string());
                    }
                }
                Some("group") => {
                    if let Some(l) = node.get("label").and_then(|t| t.as_str()) {
                        body.push_str(l);
                        body.push('\n');
                    }
                }
                Some("link") => {
                    if let Some(u) = node.get("url").and_then(|t| t.as_str()) {
                        body.push_str(u);
                        body.push('\n');
                    }
                }
                _ => {}
            }
        }
    }
    let name = crate::links::file_name(path);
    Extracted {
        title: name.strip_suffix(".canvas").unwrap_or(name).to_string(),
        body,
        parsed,
        contexts,
    }
}

/// Builds an FTS5 query: every term must match (prefix match), quoted phrases stay phrases.
fn fts_query(q: &str) -> Option<String> {
    let mut parts = Vec::new();
    let mut rest = q.trim();
    while !rest.is_empty() {
        if let Some(stripped) = rest.strip_prefix('"') {
            let end = stripped.find('"').unwrap_or(stripped.len());
            let phrase = stripped[..end].replace('"', "");
            if !phrase.trim().is_empty() {
                parts.push(format!("\"{}\"", phrase.trim()));
            }
            rest = stripped.get(end + 1..).unwrap_or("").trim_start();
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let term: String = rest[..end]
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c > '\u{7f}')
                .collect();
            for piece in term.split('-').filter(|s| !s.is_empty()) {
                parts.push(format!("\"{piece}\"*"));
            }
            rest = rest[end..].trim_start();
        }
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

impl Index {
    /// Opens (creating if needed) the index for a vault at its default cache location.
    pub fn open_for(vault: &Vault) -> Result<Self> {
        let db = default_db_path(vault.root())
            .ok_or_else(|| Error::Invalid("HOME is not set".into()))?;
        Self::open_at(&db)
    }

    pub fn open_at(db: &Path) -> Result<Self> {
        if let Some(dir) = db.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::io(dir.display().to_string(), e))?;
        }
        let conn = Connection::open(db).map_err(sql_err)?;
        let mut index = Self::init(conn)?;
        index.path = Some(db.to_path_buf());
        Ok(index)
    }

    /// A second, read-only connection to the same database. With WAL it reads the last committed
    /// state while a sync is writing, so search and backlinks don't wait for a long sync.
    /// `None` for an in-memory index.
    pub fn open_reader(&self) -> Option<Self> {
        let path = self.path.as_ref()?;
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).ok()?;
        Some(Index {
            conn,
            files: RwLock::new(None),
            path: Some(path.clone()),
        })
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory().map_err(sql_err)?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(sql_err)?;
        // Switching to WAL needs the file to itself for a moment: wait while another process has it.
        retry_busy(|| conn.pragma_update(None, "journal_mode", "WAL")).map_err(sql_err)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(sql_err)?;
        // Check and create the schema in one IMMEDIATE transaction, so the app and the CLI opening
        // a new (or outdated) index at the same moment can't drop each other's tables.
        // (The busy timeout covers BEGIN IMMEDIATE: it waits for the other process.)
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(sql_err)?;
        if version != SCHEMA_VERSION {
            tx.execute_batch(
                "DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS fts_paths;",
            )
            .map_err(sql_err)?;
        }
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
                hash TEXT, title TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]');
             CREATE TABLE IF NOT EXISTS links (
                src TEXT NOT NULL, target TEXT NOT NULL, key TEXT NOT NULL, heading TEXT, alias TEXT,
                embed INTEGER NOT NULL, markdown INTEGER NOT NULL, line INTEGER NOT NULL, context TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS links_key ON links(key);
             CREATE INDEX IF NOT EXISTS links_src ON links(src);
             CREATE TABLE IF NOT EXISTS tags (path TEXT NOT NULL, tag TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag COLLATE NOCASE);
             CREATE INDEX IF NOT EXISTS tags_path ON tags(path);
             CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path, title, body, tokenize = 'unicode61 remove_diacritics 2');
             CREATE TABLE IF NOT EXISTS fts_paths (rowid INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);",
        )
        .map_err(sql_err)?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(Index {
            conn,
            files: RwLock::new(None),
            path: None,
        })
    }

    fn invalidate(&self) {
        *self.files.write().expect("fileset lock") = None;
    }

    /// Every indexed path plus aliases, for link resolution.
    pub fn file_set(&self) -> Result<Arc<FileSet>> {
        let version: i64 = self
            .conn
            .pragma_query_value(None, "data_version", |r| r.get(0))
            .map_err(sql_err)?;
        if let Some((v, fs)) = self.files.read().expect("fileset lock").as_ref()
            && *v == version
        {
            return Ok(fs.clone());
        }
        let mut stmt = self
            .conn
            .prepare_cached("SELECT path, aliases FROM files")
            .map_err(sql_err)?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(sql_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_err)?;
        let mut aliases = Vec::new();
        for (path, json) in &rows {
            for a in serde_json::from_str::<Vec<String>>(json).unwrap_or_default() {
                aliases.push((a, path.clone()));
            }
        }
        let fs = Arc::new(FileSet::new(
            rows.iter().map(|(p, _)| p.as_str()),
            aliases.iter().map(|(a, p)| (a.as_str(), p.as_str())),
        ));
        *self.files.write().expect("fileset lock") = Some((version, fs.clone()));
        Ok(fs)
    }

    /// Brings the index in line with the vault: re-indexes new or changed files (by mtime and size)
    /// and forgets deleted ones. `progress(done, total)` is called periodically.
    pub fn sync(
        &mut self,
        vault: &Vault,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<SyncStats> {
        let entries: Vec<Entry> = vault
            .list("", true)?
            .into_iter()
            .filter(|e| !e.is_dir)
            .collect();
        let known: HashMap<String, (u64, u64)> = {
            let mut stmt = self
                .conn
                .prepare("SELECT path, mtime, size FROM files")
                .map_err(sql_err)?;
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64),
                ))
            })
            .map_err(sql_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_err)?
        };
        let mut stats = SyncStats::default();
        let present: HashSet<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        let total = entries.len();
        // IMMEDIATE: take the write lock up front. A deferred transaction that later upgrades gets
        // "database is locked" at once (no busy wait) when another process wrote in between.
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        for (i, e) in entries.iter().enumerate() {
            if known.get(&e.path) == Some(&(e.mtime, e.size)) {
                stats.unchanged += 1;
            } else {
                Self::index_entry(&tx, vault, e)?;
                stats.indexed += 1;
            }
            if i % 250 == 0 {
                progress(i, total);
            }
        }
        for path in known.keys().filter(|p| !present.contains(p.as_str())) {
            Self::delete_rows(&tx, path)?;
            stats.removed += 1;
        }
        tx.commit().map_err(sql_err)?;
        progress(total, total);
        self.invalidate();
        Ok(stats)
    }

    /// Re-indexes one path after a change (or forgets it if it no longer exists).
    pub fn update_path(&mut self, vault: &Vault, path: &str) -> Result<()> {
        // IMMEDIATE: take the write lock up front. A deferred transaction that later upgrades gets
        // "database is locked" at once (no busy wait) when another process wrote in between.
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        match vault.stat(path) {
            Ok(e) if e.is_dir => {
                for child in vault.list(path, true)?.into_iter().filter(|c| !c.is_dir) {
                    Self::index_entry(&tx, vault, &child)?;
                }
            }
            Ok(e) => Self::index_entry(&tx, vault, &e)?,
            Err(Error::NotFound(_)) | Err(Error::InvalidPath(_)) => {
                Self::delete_rows(&tx, path)?;
                // A folder: forget everything under it.
                let like = format!("{}/%", path.replace('%', "\\%").replace('_', "\\_"));
                let children: Vec<String> = {
                    let mut stmt = tx
                        .prepare("SELECT path FROM files WHERE path LIKE ?1 ESCAPE '\\'")
                        .map_err(sql_err)?;
                    stmt.query_map([like], |r| r.get(0))
                        .map_err(sql_err)?
                        .collect::<std::result::Result<_, _>>()
                        .map_err(sql_err)?
                };
                for c in children {
                    Self::delete_rows(&tx, &c)?;
                }
            }
            Err(e) => return Err(e),
        }
        tx.commit().map_err(sql_err)?;
        self.invalidate();
        Ok(())
    }

    fn delete_rows(tx: &rusqlite::Transaction, path: &str) -> Result<()> {
        for sql in [
            "DELETE FROM files WHERE path = ?1",
            "DELETE FROM links WHERE src = ?1",
            "DELETE FROM tags WHERE path = ?1",
            "DELETE FROM fts WHERE rowid = (SELECT rowid FROM fts_paths WHERE path = ?1)",
            "DELETE FROM fts_paths WHERE path = ?1",
        ] {
            tx.execute(sql, [path]).map_err(sql_err)?;
        }
        Ok(())
    }

    fn index_entry(tx: &rusqlite::Transaction, vault: &Vault, e: &Entry) -> Result<()> {
        Self::delete_rows(tx, &e.path)?;
        let kind = e.kind.unwrap_or(FileKind::Other);
        let text = if kind.is_text() && e.size <= MAX_INDEXED_BYTES {
            vault
                .read_bytes(&e.path)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
        } else {
            None
        };
        let name = crate::links::file_name(&e.path).to_string();
        let ex = match &text {
            Some(t) => extract(&e.path, kind, t),
            None => Extracted {
                title: name.clone(),
                body: String::new(),
                parsed: Parsed::default(),
                contexts: Vec::new(),
            },
        };
        let hash = text.as_ref().map(|t| hash_bytes(t.as_bytes()));
        tx.execute(
            "INSERT INTO files (path, kind, size, mtime, hash, title, aliases) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                e.path,
                serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
                e.size as i64,
                e.mtime as i64,
                hash,
                ex.title,
                serde_json::to_string(&ex.parsed.aliases).unwrap_or_else(|_| "[]".into()),
            ],
        )
        .map_err(sql_err)?;
        let lines: Vec<&str> = text
            .as_deref()
            .map(|t| t.lines().collect())
            .unwrap_or_default();
        for (i, l) in ex.parsed.links.iter().enumerate() {
            let context = match ex.contexts.get(i) {
                Some(c) => c.as_str(),
                None if l.line > 0 => lines.get(l.line - 1).copied().unwrap_or(""),
                None => "",
            };
            tx.execute(
                "INSERT INTO links (src, target, key, heading, alias, embed, markdown, line, context) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    e.path,
                    l.target,
                    link_key(&l.target),
                    l.heading,
                    l.alias,
                    l.embed,
                    l.kind == LinkKind::Markdown,
                    l.line as i64,
                    context.trim(),
                ],
            )
            .map_err(sql_err)?;
        }
        for t in &ex.parsed.tags {
            tx.execute(
                "INSERT INTO tags (path, tag) VALUES (?1, ?2)",
                params![e.path, t],
            )
            .map_err(sql_err)?;
        }
        let searchable_path = e.path.replace(['/', '.', '-', '_'], " ");
        tx.execute(
            "INSERT INTO fts (path, title, body) VALUES (?1, ?2, ?3)",
            params![searchable_path, ex.title, ex.body],
        )
        .map_err(sql_err)?;
        // The FTS path column is tokenized for matching; map its rowid back to the real path.
        tx.execute(
            "INSERT INTO fts_paths (rowid, path) VALUES (?1, ?2)",
            params![tx.last_insert_rowid(), e.path],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Full-text search over path, title and content. Supports `tag:name` and `path:folder` filters.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let mut terms = Vec::new();
        let mut tag_filter: Option<String> = None;
        let mut path_filter: Option<String> = None;
        for word in query.split_whitespace() {
            if let Some(t) = word.strip_prefix("tag:") {
                tag_filter = Some(t.trim_start_matches('#').to_lowercase());
            } else if let Some(p) = word.strip_prefix("path:") {
                path_filter = Some(p.trim_matches('/').to_lowercase());
            } else {
                terms.push(word);
            }
        }
        let text_query = fts_query(&terms.join(" "));
        let mut hits = Vec::new();
        if let Some(q) = text_query {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT p.path, f.title, snippet(fts, 2, '**', '**', '…', 14), bm25(fts, 4.0, 8.0, 1.0)
                     FROM fts JOIN fts_paths p ON p.rowid = fts.rowid JOIN files f ON f.path = p.path
                     WHERE fts MATCH ?1 ORDER BY bm25(fts, 4.0, 8.0, 1.0) LIMIT ?2",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![q, (limit * 4).max(50) as i64], |r| {
                    Ok(SearchHit {
                        path: r.get(0)?,
                        title: r.get(1)?,
                        snippet: r.get(2)?,
                        score: -r.get::<_, f64>(3)?,
                    })
                })
                .map_err(sql_err)?;
            for h in rows {
                hits.push(h.map_err(sql_err)?);
            }
        } else if tag_filter.is_some() || path_filter.is_some() {
            let mut stmt = self
                .conn
                .prepare_cached("SELECT path, title FROM files ORDER BY path")
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(SearchHit {
                        path: r.get(0)?,
                        title: r.get(1)?,
                        snippet: String::new(),
                        score: 0.0,
                    })
                })
                .map_err(sql_err)?;
            for h in rows {
                hits.push(h.map_err(sql_err)?);
            }
        }
        if let Some(p) = &path_filter {
            hits.retain(|h| {
                let lower = h.path.to_lowercase();
                lower == *p || lower.starts_with(&format!("{p}/"))
            });
        }
        if let Some(t) = &tag_filter {
            let tagged: HashSet<String> = self.paths_with_tag(t)?.into_iter().collect();
            hits.retain(|h| tagged.contains(&h.path));
        }
        hits.truncate(limit);
        Ok(hits)
    }

    /// Paths carrying `tag` or any nested tag under it (`area` matches `area/work`).
    pub fn paths_with_tag(&self, tag: &str) -> Result<Vec<String>> {
        let tag = tag.trim_start_matches('#');
        let mut stmt = self
            .conn
            .prepare_cached("SELECT DISTINCT path FROM tags WHERE tag = ?1 COLLATE NOCASE OR tag LIKE ?2 ESCAPE '\\' ORDER BY path")
            .map_err(sql_err)?;
        let like = format!("{}/%", tag.replace('%', "\\%").replace('_', "\\_"));
        stmt.query_map(params![tag, like], |r| r.get(0))
            .map_err(sql_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_err)
    }

    /// Notes that link to (or embed) `path`.
    pub fn backlinks(&self, path: &str) -> Result<Vec<Backlink>> {
        let files = self.file_set()?;
        let mut keys = vec![link_key(path)];
        let aliases: Option<String> = self
            .conn
            .query_row("SELECT aliases FROM files WHERE path = ?1", [path], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql_err)?;
        keys.extend(
            serde_json::from_str::<Vec<String>>(&aliases.unwrap_or_default())
                .unwrap_or_default()
                .iter()
                .map(|a| a.to_lowercase()),
        );
        let mut out = Vec::new();
        let mut stmt = self
            .conn
            .prepare_cached("SELECT src, target, embed, markdown, line, context FROM links WHERE key = ?1 ORDER BY src, line")
            .map_err(sql_err)?;
        for key in keys {
            let rows = stmt
                .query_map([key], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, bool>(2)?,
                        r.get::<_, bool>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                })
                .map_err(sql_err)?;
            for row in rows {
                let (src, target, embed, markdown, line, context) = row.map_err(sql_err)?;
                if files.resolve(&target, Some(&src), markdown).as_deref() == Some(path) {
                    let b = Backlink {
                        source: src,
                        line: line as usize,
                        context,
                        embed,
                    };
                    if !out.contains(&b) {
                        out.push(b);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Links going out of `path`, resolved.
    pub fn outlinks(&self, path: &str) -> Result<Vec<OutLink>> {
        let files = self.file_set()?;
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT target, embed, markdown, line FROM links WHERE src = ?1 ORDER BY line",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([path], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (target, embed, markdown, line) = row.map_err(sql_err)?;
            out.push(OutLink {
                resolved: files.resolve(&target, Some(path), markdown),
                target,
                line: line as usize,
                embed,
            });
        }
        Ok(out)
    }

    pub fn tags(&self) -> Result<Vec<TagCount>> {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT tag, COUNT(DISTINCT path) FROM tags GROUP BY lower(tag) ORDER BY 2 DESC, 1",
            )
            .map_err(sql_err)?;
        stmt.query_map([], |r| {
            Ok(TagCount {
                tag: r.get(0)?,
                count: r.get::<_, i64>(1)? as usize,
            })
        })
        .map_err(sql_err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(sql_err)
    }

    /// Hash of the last indexed content of `path` (used to recognise the app's own writes).
    pub fn hash_of(&self, path: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT hash FROM files WHERE path = ?1", [path], |r| {
                r.get(0)
            })
            .optional()
            .map(|h| h.flatten())
            .map_err(sql_err)
    }

    /// Aliases of every note, for link completion in the UI.
    pub fn aliases(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT path, aliases FROM files WHERE aliases != '[]'")
            .map_err(sql_err)?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(sql_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_err)?;
        Ok(rows
            .into_iter()
            .flat_map(|(p, json)| {
                serde_json::from_str::<Vec<String>>(&json)
                    .unwrap_or_default()
                    .into_iter()
                    .map(move |a| (a, p.clone()))
            })
            .collect())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    /// Copies `fixtures/vault` into a temp dir so tests can modify it.
    pub(crate) fn fixture() -> (tempfile::TempDir, Vault) {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vault");
        let dir = tempfile::tempdir().unwrap();
        copy_dir(&src, dir.path());
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    fn copy_dir(from: &Path, to: &Path) {
        for e in fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            let dest = to.join(e.file_name());
            if e.file_type().unwrap().is_dir() {
                fs::create_dir_all(&dest).unwrap();
                copy_dir(&e.path(), &dest);
            } else {
                fs::copy(e.path(), dest).unwrap();
            }
        }
    }

    fn synced() -> (tempfile::TempDir, Vault, Index) {
        let (d, v) = fixture();
        let mut idx = Index::in_memory().unwrap();
        idx.sync(&v, |_, _| {}).unwrap();
        (d, v, idx)
    }

    #[test]
    fn sync_is_incremental_and_ignores_obsidian_folder() {
        let (_d, v) = fixture();
        let mut idx = Index::in_memory().unwrap();
        let first = idx.sync(&v, |_, _| {}).unwrap();
        assert_eq!(first.indexed, 7);
        let again = idx.sync(&v, |_, _| {}).unwrap();
        assert_eq!(
            again,
            SyncStats {
                indexed: 0,
                removed: 0,
                unchanged: 7
            }
        );
        assert!(!idx.file_set().unwrap().contains(".obsidian/app.json"));
    }

    #[test]
    fn search_finds_content_titles_and_paths() {
        let (_d, _v, idx) = synced();
        let hits = idx.search("graph view", 10).unwrap();
        assert_eq!(hits[0].path, "Ideas.md");
        assert!(hits[0].snippet.contains("**"));
        assert_eq!(
            idx.search("plan", 10).unwrap()[0].path,
            "Projects/Mosaic/Plan.md"
        );
        assert!(
            idx.search("diagram", 10)
                .unwrap()
                .iter()
                .any(|h| h.path == "Attachments/diagram.png")
        );
        assert!(
            idx.search("\"not a link inside code\"", 10)
                .unwrap()
                .iter()
                .any(|h| h.path == "Home.md")
        );
        assert_eq!(
            idx.search("worked tag:journal", 10).unwrap()[0].path,
            "Daily/2026-09-30.md"
        );
        assert!(
            idx.search("tag:area", 10)
                .unwrap()
                .iter()
                .any(|h| h.path == "Home.md")
        );
        assert!(idx.search("hello path:Daily", 10).unwrap().is_empty());
        assert!(idx.search("", 10).unwrap().is_empty());
    }

    #[test]
    fn backlinks_follow_obsidian_resolution() {
        let (_d, _v, idx) = synced();
        let ideas: Vec<_> = idx
            .backlinks("Ideas.md")
            .unwrap()
            .into_iter()
            .map(|b| b.source)
            .collect();
        assert!(ideas.contains(&"Home.md".to_string()));
        assert!(
            ideas.contains(&"Projects/Mosaic/Plan.md".to_string()),
            "markdown + block links count"
        );
        assert!(
            ideas.contains(&"Board.canvas".to_string()),
            "canvas file nodes count"
        );
        let home: Vec<_> = idx
            .backlinks("Home.md")
            .unwrap()
            .into_iter()
            .map(|b| (b.source, b.line))
            .collect();
        assert!(
            home.contains(&("Ideas.md".to_string(), 3)),
            "via name and alias: {home:?}"
        );
        assert!(
            home.contains(&("Projects/Mosaic/Plan.md".to_string(), 3)),
            "case-insensitive"
        );
        let img = idx.backlinks("Attachments/diagram.png").unwrap();
        assert!(img[0].embed);
        let out = idx.outlinks("Home.md").unwrap();
        assert!(
            out.iter()
                .any(|l| l.target == "Does not exist" && l.resolved.is_none())
        );
    }

    #[test]
    fn tags_are_counted_with_frontmatter() {
        let (_d, _v, idx) = synced();
        let tags = idx.tags().unwrap();
        assert!(tags.iter().any(|t| t.tag == "hub" && t.count == 1));
        assert!(tags.iter().any(|t| t.tag == "journal"));
        assert!(!tags.iter().any(|t| t.tag == "notatag"));
    }

    #[test]
    fn update_path_tracks_changes_and_deletions() {
        let (d, v, mut idx) = synced();
        v.write("Ideas.md", "# Ideas\n\nNow about zebras.\n", None)
            .unwrap();
        idx.update_path(&v, "Ideas.md").unwrap();
        assert_eq!(idx.search("zebras", 5).unwrap()[0].path, "Ideas.md");
        fs::remove_dir_all(d.path().join("Projects")).unwrap();
        idx.update_path(&v, "Projects").unwrap();
        assert!(!idx.file_set().unwrap().contains("Projects/Mosaic/Plan.md"));
        assert!(
            idx.search("plan", 5)
                .unwrap()
                .iter()
                .all(|h| !h.path.starts_with("Projects/"))
        );
    }

    /// Run with `cargo test --release -p mosaic-core -- --ignored bench`.
    #[test]
    #[ignore]
    fn bench_search_5000_notes_under_one_second() {
        let dir = tempfile::tempdir().unwrap();
        let words = [
            "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
            "juliet",
        ];
        for i in 0..5000 {
            let folder = dir.path().join(format!("f{}", i % 50));
            fs::create_dir_all(&folder).unwrap();
            let mut body = format!(
                "# Note {i}\n\nLinks to [[Note {}]] and #tag{}\n",
                (i * 7) % 5000,
                i % 20
            );
            for j in 0..60 {
                body.push_str(words[(i + j * 3) % words.len()]);
                body.push(' ');
            }
            fs::write(folder.join(format!("Note {i}.md")), body).unwrap();
        }
        let v = Vault::open(dir.path()).unwrap();
        let mut idx = Index::open_at(&dir.path().join("../idx-bench.db")).unwrap();
        let t = std::time::Instant::now();
        idx.sync(&v, |_, _| {}).unwrap();
        eprintln!("initial index of 5000 notes: {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let hits = idx.search("charlie golf", 50).unwrap();
        let took = t.elapsed();
        eprintln!("search: {took:?}, {} hits", hits.len());
        assert!(!hits.is_empty());
        assert!(took < std::time::Duration::from_secs(1));
        let t = std::time::Instant::now();
        let b = idx.backlinks("f0/Note 0.md").unwrap();
        eprintln!("backlinks: {:?} ({} hits)", t.elapsed(), b.len());
        let _ = fs::remove_file(dir.path().join("../idx-bench.db"));
    }

    /// A temporary vault holding exactly `files`, indexed.
    fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Index) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let path = dir.path().join(p);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, c).unwrap();
        }
        let v = Vault::open(dir.path()).unwrap();
        let mut idx = Index::in_memory().unwrap();
        idx.sync(&v, |_, _| {}).unwrap();
        (dir, idx)
    }

    #[test]
    fn excalidraw_indexes_only_its_text() {
        let drawing = r#"{"type":"excalidraw","elements":[
            {"type":"rectangle","id":"r1","link":"[[Plan]]"},
            {"type":"text","id":"t1","text":"Merge\nconflict","originalText":"Merge conflict"},
            {"type":"text","id":"t2","text":"gone","isDeleted":true}
        ]}"#;
        let (_d, idx) = vault_with(&[("Layers.excalidraw", drawing), ("Plan.md", "# Plan")]);
        let hits = idx.search("conflict", 5).unwrap();
        assert_eq!(hits[0].path, "Layers.excalidraw");
        assert_eq!(hits[0].title, "Layers");
        assert!(
            !hits[0].snippet.contains("originalText"),
            "{}",
            hits[0].snippet
        );
        assert!(
            idx.search("gone", 5).unwrap().is_empty(),
            "deleted elements are skipped"
        );
        assert!(
            idx.search("rectangle", 5).unwrap().is_empty(),
            "JSON keys aren't indexed"
        );
        let b = idx.backlinks("Plan.md").unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(
            (b[0].source.as_str(), b[0].context.as_str()),
            ("Layers.excalidraw", "Linked element")
        );
    }

    #[test]
    fn canvas_backlinks_carry_the_card_text() {
        let canvas = r##"{"nodes":[
            {"id":"a","type":"text","text":"# Roadmap\nNext: see [[Plan]] for   details","x":0,"y":0,"width":10,"height":10},
            {"id":"b","type":"file","file":"Plan.md","x":0,"y":0,"width":10,"height":10}
        ],"edges":[]}"##;
        let (_d, idx) = vault_with(&[("Board.canvas", canvas), ("Plan.md", "# Plan")]);
        let mut contexts: Vec<String> = idx
            .backlinks("Plan.md")
            .unwrap()
            .into_iter()
            .map(|b| b.context)
            .collect();
        contexts.sort();
        assert_eq!(contexts, ["File card", "Next: see [[Plan]] for details"]);
    }

    #[test]
    fn chart_data_files_are_embeds() {
        let chart = "{\n  \"layer\": [\n    {\"data\": {\"url\": \"code-size.csv\"}, \"mark\": \"bar\"},\n    {\"data\": {\"url\": \"https://example.com/remote.csv\"}}\n  ]\n}\n";
        let (_d, idx) = vault_with(&[
            ("Charts/Code size.vl.json", chart),
            ("Charts/code-size.csv", "a,b\n1,2\n"),
            ("Other/code-size.csv", "a,b\n"),
        ]);
        let b = idx.backlinks("Charts/code-size.csv").unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(
            (b[0].source.as_str(), b[0].line, b[0].embed),
            ("Charts/Code size.vl.json", 3, true)
        );
        assert!(b[0].context.contains("code-size.csv"));
        assert!(
            idx.backlinks("Other/code-size.csv").unwrap().is_empty(),
            "resolved relative to the chart"
        );
    }

    #[test]
    fn one_line_collapses_and_shortens() {
        assert_eq!(one_line("  a\n\n b  "), "a b");
        let long = "x".repeat(300);
        assert_eq!(one_line(&long).chars().count(), 201);
    }

    /// The app and the CLI index the same vault at once (two connections to one database, as two
    /// processes have): neither may fail with "database is locked", and both see the same result.
    /// Run with `scripts/bench.sh`.
    #[test]
    #[ignore]
    fn bench_two_indexers_share_one_vault() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5000 {
            let folder = dir.path().join(format!("f{}", i % 50));
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join(format!("Note {i}.md")),
                format!(
                    "# Note {i}\n\nLinks to [[Note {}]] #t{}\n",
                    (i * 7) % 5000,
                    i % 20
                ),
            )
            .unwrap();
        }
        let db = dir.path().join("../shared-index.db");
        let t = std::time::Instant::now();
        let handles: Vec<_> = (0..2)
            .map(|n| {
                let root = dir.path().to_path_buf();
                let db = db.clone();
                std::thread::spawn(move || {
                    let v = Vault::open(&root).unwrap();
                    let mut idx = Index::open_at(&db).unwrap();
                    idx.sync(&v, |_, _| {}).unwrap();
                    // Then both keep changing notes and re-syncing, like an agent and the app.
                    for round in 0..20 {
                        let p = root.join(format!("f{n}/Note {n}.md"));
                        fs::write(&p, format!("# Note {n}\n\nround {round} by indexer {n}"))
                            .unwrap();
                        idx.sync(&v, |_, _| {}).unwrap();
                        assert!(!idx.search("round", 10).unwrap().is_empty());
                    }
                    idx.file_set().unwrap().contains("f0/Note 0.md")
                })
            })
            .collect();
        for h in handles {
            assert!(h.join().expect("an indexer failed (database locked?)"));
        }
        eprintln!(
            "two indexers, 5000 notes, 20 concurrent edit+sync rounds each: {:?}",
            t.elapsed()
        );
        let check = Index::open_at(&db).unwrap();
        assert_eq!(
            check.search("round", 10).unwrap().len(),
            2,
            "both indexers' last edits are in the shared index"
        );
        let _ = fs::remove_file(&db);
    }
}
