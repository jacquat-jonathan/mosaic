//! Structured queries over the index: notes by tag, folder, frontmatter field, date and links, in a
//! small text language shared by the CLI (`mosaic query`), the MCP `query` tool and ```query blocks
//! in notes:
//!
//! ```text
//! tag:project status=active due<today+7 links-to:"Mosaic Architecture" sort:-due limit:20
//! ```
//!
//! - `tag:a|b`, `folder:Projects`, `kind:canvas`, `links-to:Note`, `linked-from:Note`, `has:field`;
//!   a leading `-` negates any of them (`-tag:done`, `-has:due`).
//! - `field=value`, `!=`, `>`, `>=`, `<`, `<=`, `~` (contains). Fields are frontmatter properties
//!   plus `title`, `name`, `path`, `folder`, `kind`, `tags` and `modified`. `a|b` matches either value;
//!   a list property matches when any item does. Numbers compare as numbers, dates (`2026-10-02`,
//!   `today`, `today-7`) by day, other text alphabetically and ignoring case.
//! - `sort:field` (or `sort:-field`, descending), `limit:N`, `show:a,b` (columns to display).
//! - Other words are full-text search terms, as in `search`.

use crate::error::{Error, Result};
use crate::index::{Index, NoteMeta};
use chrono::{Local, TimeZone};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const DEFAULT_LIMIT: usize = 100;
pub const MAX_LIMIT: usize = 1000;

static RESERVED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(-?)(tag|folder|path|kind|links-to|linked-from|has|sort|limit|show):(.*)$")
        .expect("valid")
});
static COMPARISON: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([\p{L}\p{N}_][\p{L}\p{N}_.\-]*)(!=|>=|<=|=|>|<|~)(.*)$").expect("valid")
});
static RELATIVE_DAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?i)today(?:([+-])(\d+))?$").expect("valid"));
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("valid"));

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    Contains,
}

#[derive(Debug, Clone, PartialEq)]
enum Filter {
    Tag(Vec<String>),
    Folder(Vec<String>),
    Kind(Vec<String>),
    LinksTo(String),
    LinkedFrom(String),
    Has(String),
    Compare(String, Op, Vec<String>),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Query {
    /// (filter, negated)
    filters: Vec<(Filter, bool)>,
    text: Vec<String>,
    /// (field, descending)
    sort: Vec<(String, bool)>,
    limit: Option<usize>,
    show: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryRow {
    pub path: String,
    pub title: String,
    /// Milliseconds since the Unix epoch.
    pub modified: u64,
    pub tags: Vec<String>,
    /// The note's frontmatter.
    pub props: Value,
}

impl QueryRow {
    /// A column's value as plain text (lists joined with ", "; empty when missing).
    pub fn cell(&self, column: &str) -> String {
        match column {
            "title" => self.title.clone(),
            "path" => self.path.clone(),
            "modified" => local_time(self.modified).replace('T', " "),
            "tags" => self.tags.join(", "),
            _ => match prop(&self.props, column) {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|i| i.as_str().map_or_else(|| i.to_string(), str::to_string))
                    .collect::<Vec<_>>()
                    .join(", "),
                Some(v) => v.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    /// Fields worth showing next to each note: `show:`, or the fields the query filters and sorts on.
    pub columns: Vec<String>,
    pub rows: Vec<QueryRow>,
    /// Matches before `limit`.
    pub total: usize,
}

/// Splits on spaces outside double quotes; quotes are kept.
fn tokens(q: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in q.chars() {
        if c == '"' {
            quoted = !quoted;
        }
        if c.is_whitespace() && !quoted {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn unquote(s: &str) -> String {
    s.replace('"', "")
}

/// `today`, `today+3`, `today-7` → a local date; anything else unchanged.
fn resolve_value(v: &str) -> String {
    match RELATIVE_DAY.captures(v) {
        Some(c) => {
            let n: i64 = c.get(2).map_or(0, |m| m.as_str().parse().unwrap_or(0));
            let days = if c.get(1).map(|m| m.as_str()) == Some("-") {
                -n
            } else {
                n
            };
            (Local::now().date_naive() + chrono::Duration::days(days))
                .format("%Y-%m-%d")
                .to_string()
        }
        None => v.to_string(),
    }
}

fn values(v: &str) -> Vec<String> {
    unquote(v)
        .split('|')
        .map(|s| resolve_value(s.trim()))
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn parse(q: &str) -> Result<Query> {
    let mut query = Query::default();
    for tok in tokens(q) {
        if let Some(c) = RESERVED.captures(&tok) {
            let neg = &c[1] == "-";
            let (key, raw) = (&c[2], &c[3]);
            let vals = values(raw);
            let one = || -> Result<String> {
                vals.first()
                    .cloned()
                    .ok_or_else(|| Error::Invalid(format!("{key}: needs a value")))
            };
            let filter = match key {
                "tag" => Filter::Tag(
                    vals.iter()
                        .map(|t| t.trim_start_matches('#').to_lowercase())
                        .collect(),
                ),
                "folder" | "path" => Filter::Folder(
                    vals.iter()
                        .map(|f| f.trim_matches('/').to_lowercase())
                        .collect(),
                ),
                "kind" => Filter::Kind(vals.iter().map(|k| k.to_lowercase()).collect()),
                "links-to" => Filter::LinksTo(one()?),
                "linked-from" => Filter::LinkedFrom(one()?),
                "has" => Filter::Has(one()?),
                "sort" => {
                    for f in unquote(raw).split(',').filter(|f| !f.is_empty()) {
                        match f.strip_prefix('-') {
                            Some(f) => query.sort.push((f.to_string(), true)),
                            None => query.sort.push((f.to_string(), false)),
                        }
                    }
                    continue;
                }
                "limit" => {
                    let n: usize = raw.parse().map_err(|_| {
                        Error::Invalid(format!("limit: expected a number, got {raw:?}"))
                    })?;
                    query.limit = Some(n.min(MAX_LIMIT));
                    continue;
                }
                _ => {
                    query.show.extend(
                        unquote(raw)
                            .split(',')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty()),
                    );
                    continue;
                }
            };
            if vals.is_empty() {
                return Err(Error::Invalid(format!("{key}: needs a value")));
            }
            query.filters.push((filter, neg));
        } else if let Some(c) = COMPARISON.captures(&tok) {
            let op = match &c[2] {
                "=" => Op::Eq,
                "!=" => Op::Ne,
                ">" => Op::Gt,
                ">=" => Op::Ge,
                "<" => Op::Lt,
                "<=" => Op::Le,
                _ => Op::Contains,
            };
            let vals = values(&c[3]);
            if vals.is_empty() {
                return Err(Error::Invalid(format!(
                    "{tok}: needs a value after {}",
                    &c[2]
                )));
            }
            query
                .filters
                .push((Filter::Compare(c[1].to_string(), op, vals), false));
        } else {
            query.text.push(tok);
        }
    }
    Ok(query)
}

/// One value of a field, for comparing and sorting.
#[derive(Debug, Clone)]
enum Scalar {
    Num(f64),
    Text(String),
}

impl Scalar {
    fn text(&self) -> String {
        match self {
            Scalar::Num(n) => n.to_string(),
            Scalar::Text(s) => s.clone(),
        }
    }
}

fn scalars(v: &Value, out: &mut Vec<Scalar>) {
    match v {
        Value::Null => {}
        Value::Bool(b) => out.push(Scalar::Text(b.to_string())),
        Value::Number(n) => out.push(Scalar::Num(n.as_f64().unwrap_or(0.0))),
        Value::String(s) if s.trim().is_empty() => {}
        Value::String(s) => out.push(Scalar::Text(s.clone())),
        Value::Array(items) => items.iter().for_each(|i| scalars(i, out)),
        Value::Object(_) => out.push(Scalar::Text(v.to_string())),
    }
}

fn local_time(ms: u64) -> String {
    Local
        .timestamp_millis_opt(ms as i64)
        .single()
        .map(|t| t.format("%Y-%m-%dT%H:%M").to_string())
        .unwrap_or_default()
}

/// A frontmatter property (exact name first, then ignoring case).
pub fn prop<'a>(props: &'a Value, name: &str) -> Option<&'a Value> {
    let map = props.as_object()?;
    map.get(name).or_else(|| {
        map.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v)
    })
}

fn field(n: &NoteMeta, name: &str) -> Vec<Scalar> {
    let text = |s: &str| vec![Scalar::Text(s.to_string())];
    match name {
        "title" => text(&n.title),
        "path" => text(&n.path),
        "name" => text(
            crate::links::file_name(&n.path)
                .rsplit_once('.')
                .map_or(crate::links::file_name(&n.path), |(stem, _)| stem),
        ),
        "folder" => text(n.path.rsplit_once('/').map_or("", |(f, _)| f)),
        "kind" => text(&n.kind),
        "modified" => text(&local_time(n.mtime)),
        "tags" => n.tags.iter().map(|t| Scalar::Text(t.clone())).collect(),
        _ => {
            let mut out = Vec::new();
            if let Some(v) = prop(&n.props, name) {
                scalars(v, &mut out);
            }
            out
        }
    }
}

fn number(s: &Scalar) -> Option<f64> {
    match s {
        Scalar::Num(n) => Some(*n),
        Scalar::Text(t) => t.trim().parse().ok(),
    }
}

#[derive(PartialEq)]
enum Kind {
    Num,
    Date,
    Text,
}

fn kind(s: &str) -> Kind {
    if s.trim().parse::<f64>().is_ok() {
        Kind::Num
    } else if s.len() >= 10 && s.is_char_boundary(10) && DATE.is_match(&s[..10]) {
        Kind::Date
    } else {
        Kind::Text
    }
}

/// Orders a value against a query value: numbers as numbers, dates by day, text ignoring case.
/// `None` when they can't be compared (a date against a word like `tomorow`, a number against text),
/// so a typo matches nothing instead of everything.
fn order(v: &Scalar, target: &str) -> Option<Ordering> {
    let mut a = v.text().to_lowercase();
    if kind(&a) != kind(target) {
        return None;
    }
    if let (Some(a), Ok(b)) = (number(v), target.trim().parse::<f64>()) {
        return a.partial_cmp(&b);
    }
    if DATE.is_match(target) && a.len() > 10 {
        a.truncate(10);
    }
    Some(a.as_str().cmp(target.to_lowercase().as_str()))
}

fn compare(vals: &[Scalar], op: Op, targets: &[String]) -> bool {
    let any =
        |f: &dyn Fn(&Scalar, &str) -> bool| vals.iter().any(|v| targets.iter().any(|t| f(v, t)));
    let is = |want: &'static [Ordering]| {
        any(&move |v, t| order(v, t).is_some_and(|o| want.contains(&o)))
    };
    match op {
        Op::Eq => is(&[Ordering::Equal]),
        Op::Ne => !is(&[Ordering::Equal]),
        Op::Gt => is(&[Ordering::Greater]),
        Op::Ge => is(&[Ordering::Greater, Ordering::Equal]),
        Op::Lt => is(&[Ordering::Less]),
        Op::Le => is(&[Ordering::Less, Ordering::Equal]),
        Op::Contains => any(&|v, t| v.text().to_lowercase().contains(&t.to_lowercase())),
    }
}

fn sort_key_cmp(a: &[Scalar], b: &[Scalar]) -> Ordering {
    match (a.first(), b.first()) {
        (None, None) => Ordering::Equal,
        // Notes without the field go last.
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => match (number(x), number(y)) {
            (Some(p), Some(q)) => p.partial_cmp(&q).unwrap_or(Ordering::Equal),
            _ => x.text().to_lowercase().cmp(&y.text().to_lowercase()),
        },
    }
}

impl Query {
    /// The fields to show: `show:`, else the ones filtered and sorted on (except title and path).
    fn columns(&self) -> Vec<String> {
        let mut cols: Vec<String> = if self.show.is_empty() {
            self.filters
                .iter()
                .filter_map(|(f, _)| match f {
                    Filter::Compare(name, ..) | Filter::Has(name) => Some(name.clone()),
                    _ => None,
                })
                .chain(self.sort.iter().map(|(f, _)| f.clone()))
                .filter(|f| f != "title" && f != "path")
                .collect()
        } else {
            self.show.clone()
        };
        let mut seen = HashSet::new();
        cols.retain(|c| seen.insert(c.to_lowercase()));
        cols
    }

    /// Runs the query; `visible` drops paths the caller may not see (agents' hidden folders).
    pub fn run(&self, index: &Index, visible: impl Fn(&str) -> bool) -> Result<QueryResult> {
        let mut notes: Vec<NoteMeta> = index
            .notes_meta()?
            .into_iter()
            .filter(|n| visible(&n.path))
            .collect();
        // Full-text terms narrow the set and give the default order (best match first).
        let mut rank: Option<Vec<String>> = None;
        if !self.text.is_empty() {
            let hits = index.search(&self.text.join(" "), 100_000)?;
            rank = Some(hits.into_iter().map(|h| h.path).collect());
        }
        let files = index.file_set()?;
        let resolve = |target: &str| -> Result<String> {
            files
                .resolve(&unquote(target), None, false)
                .ok_or_else(|| Error::NotFound(format!("no note named {target:?}")))
        };
        for (f, neg) in &self.filters {
            let keep: Box<dyn Fn(&NoteMeta) -> bool> = match f {
                Filter::Tag(tags) => Box::new(move |n: &NoteMeta| {
                    n.tags.iter().any(|t| {
                        let t = t.to_lowercase();
                        tags.iter()
                            .any(|w| t == *w || t.starts_with(&format!("{w}/")))
                    })
                }),
                Filter::Folder(folders) => Box::new(move |n: &NoteMeta| {
                    let p = n.path.to_lowercase();
                    folders
                        .iter()
                        .any(|f| f.is_empty() || p.starts_with(&format!("{f}/")))
                }),
                Filter::Kind(kinds) => Box::new(move |n: &NoteMeta| kinds.contains(&n.kind)),
                Filter::LinksTo(target) => {
                    let to = resolve(target)?;
                    let sources: HashSet<String> = index
                        .backlinks(&to)?
                        .into_iter()
                        .map(|b| b.source)
                        .collect();
                    Box::new(move |n: &NoteMeta| sources.contains(&n.path))
                }
                Filter::LinkedFrom(target) => {
                    let from = resolve(target)?;
                    let targets: HashSet<String> = index
                        .outlinks(&from)?
                        .into_iter()
                        .filter_map(|l| l.resolved)
                        .collect();
                    Box::new(move |n: &NoteMeta| targets.contains(&n.path))
                }
                Filter::Has(name) => Box::new(move |n: &NoteMeta| !field(n, name).is_empty()),
                Filter::Compare(name, op, targets) => {
                    Box::new(move |n: &NoteMeta| compare(&field(n, name), *op, targets))
                }
            };
            notes.retain(|n| keep(n) != *neg);
        }
        if let Some(rank) = &rank {
            let pos: std::collections::HashMap<&str, usize> = rank
                .iter()
                .enumerate()
                .map(|(i, p)| (p.as_str(), i))
                .collect();
            notes.retain(|n| pos.contains_key(n.path.as_str()));
            if self.sort.is_empty() {
                notes.sort_by_key(|n| pos[n.path.as_str()]);
            }
        }
        if !self.sort.is_empty() {
            notes.sort_by(|a, b| {
                for (name, desc) in &self.sort {
                    let o = if name == "modified" {
                        let o = a.mtime.cmp(&b.mtime);
                        if *desc { o.reverse() } else { o }
                    } else {
                        let (fa, fb) = (field(a, name), field(b, name));
                        match (fa.is_empty(), fb.is_empty()) {
                            // Notes without the field go last, in either direction.
                            (true, false) => Ordering::Greater,
                            (false, true) => Ordering::Less,
                            _ if *desc => sort_key_cmp(&fa, &fb).reverse(),
                            _ => sort_key_cmp(&fa, &fb),
                        }
                    };
                    if o != Ordering::Equal {
                        return o;
                    }
                }
                a.path.cmp(&b.path)
            });
        }
        let total = notes.len();
        notes.truncate(self.limit.unwrap_or(DEFAULT_LIMIT));
        Ok(QueryResult {
            columns: self.columns(),
            rows: notes
                .into_iter()
                .map(|n| QueryRow {
                    path: n.path,
                    title: n.title,
                    modified: n.mtime,
                    tags: n.tags,
                    props: n.props,
                })
                .collect(),
            total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    fn vault(files: &[(&str, &str)]) -> (tempfile::TempDir, Index) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let full = dir.path().join(p);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, c).unwrap();
        }
        let v = Vault::open(dir.path()).unwrap();
        let mut idx = Index::in_memory().unwrap();
        idx.sync(&v, |_, _| {}).unwrap();
        (dir, idx)
    }

    fn paths(q: &str, idx: &Index) -> Vec<String> {
        parse(q)
            .unwrap()
            .run(idx, |_| true)
            .unwrap()
            .rows
            .into_iter()
            .map(|r| r.path)
            .collect()
    }

    fn sample() -> (tempfile::TempDir, Index) {
        vault(&[
            (
                "Projects/Mosaic.md",
                "---\nstatus: active\npriority: 2\ndue: 2026-10-20\ntags: [project, app]\n---\nSee [[Plan]].\n",
            ),
            (
                "Projects/Garden.md",
                "---\nstatus: paused\npriority: 10\ndue: 2026-09-01\ntags: [project]\n---\nTomatoes. [[Plan]]\n",
            ),
            (
                "Projects/Old.md",
                "---\nstatus: done\ntags: [project/archive]\n---\nNothing.\n",
            ),
            ("Plan.md", "# Plan\nLinks to [[Mosaic]].\n"),
            (
                "Inbox/Idea.md",
                "---\nstatus: \"in progress\"\nowners: [Anna, Ben]\n---\nA tomato idea.\n",
            ),
        ])
    }

    #[test]
    fn filters_by_tag_folder_fields_and_links() {
        let (_d, idx) = sample();
        assert_eq!(
            paths("tag:project", &idx),
            [
                "Projects/Garden.md",
                "Projects/Mosaic.md",
                "Projects/Old.md"
            ]
        );
        assert_eq!(
            paths("tag:project -tag:project/archive status!=paused", &idx),
            ["Projects/Mosaic.md"]
        );
        assert_eq!(
            paths("status=active|paused sort:-priority", &idx),
            ["Projects/Garden.md", "Projects/Mosaic.md"]
        );
        // Without the field: last, ascending or descending.
        assert_eq!(
            paths("folder:Projects sort:-priority", &idx),
            [
                "Projects/Garden.md",
                "Projects/Mosaic.md",
                "Projects/Old.md"
            ]
        );
        assert_eq!(
            paths("folder:Projects sort:priority", &idx),
            [
                "Projects/Mosaic.md",
                "Projects/Garden.md",
                "Projects/Old.md"
            ]
        );
        assert_eq!(paths("priority>5", &idx), ["Projects/Garden.md"]);
        assert_eq!(paths("due<2026-10-01", &idx), ["Projects/Garden.md"]);
        assert_eq!(paths(r#"status="in progress""#, &idx), ["Inbox/Idea.md"]);
        assert_eq!(paths("owners=ben", &idx), ["Inbox/Idea.md"]);
        assert_eq!(
            paths("links-to:Plan", &idx),
            ["Projects/Garden.md", "Projects/Mosaic.md"]
        );
        assert_eq!(paths("linked-from:Plan", &idx), ["Projects/Mosaic.md"]);
        assert_eq!(paths("folder:Projects -has:due", &idx), ["Projects/Old.md"]);
        let mut found = paths("tomato", &idx);
        found.sort();
        assert_eq!(found, ["Inbox/Idea.md", "Projects/Garden.md"]);
        assert_eq!(
            paths("tomato folder:Projects", &idx),
            ["Projects/Garden.md"]
        );
        assert_eq!(paths("modified>=today", &idx).len(), 5);
        assert_eq!(paths("modified<today", &idx).len(), 0);
        assert_eq!(paths("title~pla", &idx), ["Plan.md"]);
        // A word that isn't a date or number (a typo) matches nothing, not every dated note.
        assert!(paths("due<=tomorow", &idx).is_empty());
        assert!(paths("priority>high", &idx).is_empty());
        assert_eq!(paths("tag:project priority!=high", &idx).len(), 3);
    }

    #[test]
    fn columns_limit_and_errors() {
        let (_d, idx) = sample();
        let r = parse("tag:project status!=done sort:due limit:1")
            .unwrap()
            .run(&idx, |_| true)
            .unwrap();
        assert_eq!(r.columns, ["status", "due"]);
        assert_eq!((r.rows.len(), r.total), (1, 2));
        assert_eq!(r.rows[0].path, "Projects/Garden.md");
        assert_eq!(r.rows[0].props["priority"], 10);
        let r = parse("show:status,owners has:status")
            .unwrap()
            .run(&idx, |p| !p.starts_with("Inbox/"))
            .unwrap();
        assert_eq!(
            (r.columns.as_slice(), r.total),
            (["status", "owners"].map(String::from).as_slice(), 3)
        );
        assert!(matches!(parse("limit:many"), Err(Error::Invalid(_))));
        assert!(matches!(parse("status="), Err(Error::Invalid(_))));
        assert!(matches!(
            parse("links-to:Nowhere").unwrap().run(&idx, |_| true),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn relative_days() {
        let today = Local::now().date_naive();
        assert_eq!(resolve_value("today"), today.format("%Y-%m-%d").to_string());
        assert_eq!(
            resolve_value("today-7"),
            (today - chrono::Duration::days(7))
                .format("%Y-%m-%d")
                .to_string()
        );
        assert_eq!(resolve_value("tomorrow"), "tomorrow");
    }
}
