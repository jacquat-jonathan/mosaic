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
//! - Other words are full-text search terms, as in `search`. Uppercase `OR` separates groups;
//!   terms inside a group are ANDed, so `tag:work status=active OR tag:idea priority>2` matches
//!   either complete group.
//! - `task:open` (or `done`, `moved`, `cancelled`, `all`; `a|b` for several) lists checkbox tasks
//!   instead of notes. Every filter then applies per task: the task's own fields (`text`, `status`,
//!   `due` from a `📅 2026-10-05` on its line, `line`) come first, the rest from its note (so a task
//!   in a `due:` note has that due date unless it sets its own). `tag:` matches #tags in the task
//!   or the note's frontmatter tags; other words must all appear in the task's text.

use crate::error::{Error, Result};
use crate::index::{Index, NoteMeta, TaskMeta};
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
    Regex::new(r"^(-?)(tag|folder|path|kind|links-to|linked-from|has|sort|limit|show|task):(.*)$")
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
    groups: Vec<QueryGroup>,
    /// (field, descending)
    sort: Vec<(String, bool)>,
    limit: Option<usize>,
    show: Vec<String>,
    /// `task:`: list tasks with these statuses instead of notes.
    tasks: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct QueryGroup {
    /// (filter, negated)
    filters: Vec<(Filter, bool)>,
    text: Vec<String>,
}

type Keep<'a> = Box<dyn Fn(&NoteMeta, Option<&TaskMeta>) -> bool + 'a>;
type GroupKeeps<'a> = Vec<Vec<(Keep<'a>, bool)>>;

const TASK_STATUSES: [&str; 4] = ["open", "done", "moved", "cancelled"];

/// A task's status from its checkbox mark: `[x]` done, `[>]` moved (to another day), `[-]`
/// cancelled, anything else (`[ ]`, `[/]` in progress, …) open.
pub fn task_status(mark: char) -> &'static str {
    match mark {
        'x' | 'X' => "done",
        '>' => "moved",
        '-' => "cancelled",
        _ => "open",
    }
}

/// A task row's own fields.
#[derive(Debug, Clone, Serialize)]
pub struct TaskRow {
    pub workflow: String,
    /// 1-based line in the note.
    pub line: usize,
    /// "open", "done", "moved" or "cancelled".
    pub status: &'static str,
    /// The checkbox character as written.
    pub mark: char,
    pub text: String,
    pub depth: usize,
    /// Line of the task it's nested under.
    pub parent: Option<usize>,
    /// Its own due date (`📅`), if it has one.
    pub due: Option<String>,
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
    /// Set for task queries (`task:`): the row is this task, in the note above.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskRow>,
}

impl QueryRow {
    /// A column's value as plain text (lists joined with ", "; empty when missing).
    pub fn cell(&self, column: &str) -> String {
        if let Some(t) = &self.task {
            match column {
                "text" => return t.text.clone(),
                "status" => return t.status.to_string(),
                "line" => return t.line.to_string(),
                "due" if t.due.is_some() => return t.due.clone().unwrap_or_default(),
                _ => {}
            }
        }
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
    let mut query = Query {
        groups: vec![QueryGroup::default()],
        ..Query::default()
    };
    for tok in tokens(q) {
        if tok == "OR" {
            let current = query.groups.last().expect("one query group");
            if current.filters.is_empty() && current.text.is_empty() {
                return Err(Error::Invalid("OR needs a query group before it".into()));
            }
            query.groups.push(QueryGroup::default());
            continue;
        }
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
                "task" => {
                    let mut wanted: Vec<String> = Vec::new();
                    for v in vals.iter().map(|v| v.to_lowercase()) {
                        match v.as_str() {
                            "all" | "any" => wanted.extend(TASK_STATUSES.map(String::from)),
                            s if TASK_STATUSES.contains(&s) => wanted.push(v),
                            _ => {
                                return Err(Error::Invalid(format!(
                                    "task:{v}: expected open, done, moved, cancelled or all"
                                )));
                            }
                        }
                    }
                    if wanted.is_empty() {
                        wanted.push("open".into());
                    }
                    if neg {
                        wanted = TASK_STATUSES
                            .iter()
                            .filter(|s| !wanted.iter().any(|w| w == *s))
                            .map(|s| s.to_string())
                            .collect();
                    }
                    query.tasks = Some(wanted);
                    continue;
                }
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
            query.groups.last_mut().unwrap().filters.push((filter, neg));
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
                .groups
                .last_mut()
                .unwrap()
                .filters
                .push((Filter::Compare(c[1].to_string(), op, vals), false));
        } else {
            query.groups.last_mut().unwrap().text.push(tok);
        }
    }
    if query.groups.len() > 1 {
        let last = query.groups.last().unwrap();
        if last.filters.is_empty() && last.text.is_empty() {
            return Err(Error::Invalid("OR needs a query group after it".into()));
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

/// A field of a task: its own (`text`, `status`, `line`, `due` when it has one), else its note's.
fn task_field(n: &NoteMeta, t: &TaskMeta, name: &str) -> Vec<Scalar> {
    match name {
        "text" => vec![Scalar::Text(crate::task_board::label(&t.text))],
        "workflow" => vec![Scalar::Text(
            crate::task_board::state(&t.text, t.mark).into(),
        )],
        "status" => vec![Scalar::Text(task_status(t.mark).into())],
        "line" => vec![Scalar::Num(t.line as f64)],
        "due" if t.due.is_some() => vec![Scalar::Text(t.due.clone().unwrap_or_default())],
        _ => field(n, name),
    }
}

fn subject_field(n: &NoteMeta, t: Option<&TaskMeta>, name: &str) -> Vec<Scalar> {
    match t {
        Some(t) => task_field(n, t, name),
        None => field(n, name),
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
            self.groups
                .iter()
                .flat_map(|g| g.filters.iter())
                .filter_map(|(f, _)| match f {
                    Filter::Compare(name, ..) | Filter::Has(name) => Some(name.clone()),
                    _ => None,
                })
                .chain(self.sort.iter().map(|(f, _)| f.clone()))
                .filter(|f| f != "title" && f != "path")
                .filter(|f| self.tasks.is_none() || (f != "text" && f != "status"))
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
        let files = index.file_set()?;
        let resolve = |target: &str| -> Result<String> {
            files
                .resolve(&unquote(target), None, false)
                .ok_or_else(|| Error::NotFound(format!("no note named {target:?}")))
        };
        // Each filter checks a note, or a task in it (task queries).
        let mut group_keeps: GroupKeeps<'_> = Vec::new();
        for group in &self.groups {
            let mut keeps: Vec<(Keep, bool)> = Vec::new();
            for (f, neg) in &group.filters {
                let keep: Keep = match f {
                    Filter::Tag(tags) => Box::new(move |n: &NoteMeta, t: Option<&TaskMeta>| {
                        // A task has its own #tags and its note's frontmatter tags; a #tag written
                        // next to another task in the note isn't one of them.
                        let found = match t {
                            Some(t) => {
                                let mut v = crate::parse::tags_in(&t.text);
                                for key in ["tags", "tag"] {
                                    let mut out = Vec::new();
                                    if let Some(p) = prop(&n.props, key) {
                                        scalars(p, &mut out);
                                    }
                                    v.extend(
                                        out.iter()
                                            .map(|s| s.text().trim_start_matches('#').to_string()),
                                    );
                                }
                                v
                            }
                            None => n.tags.clone(),
                        };
                        found.iter().any(|t| {
                            let t = t.to_lowercase();
                            tags.iter()
                                .any(|w| t == *w || t.starts_with(&format!("{w}/")))
                        })
                    }),
                    Filter::Folder(folders) => Box::new(move |n: &NoteMeta, _| {
                        let p = n.path.to_lowercase();
                        folders
                            .iter()
                            .any(|f| f.is_empty() || p.starts_with(&format!("{f}/")))
                    }),
                    Filter::Kind(kinds) => Box::new(move |n: &NoteMeta, _| kinds.contains(&n.kind)),
                    Filter::LinksTo(target) => {
                        let to = resolve(target)?;
                        let sources: HashSet<String> = index
                            .backlinks(&to)?
                            .into_iter()
                            .map(|b| b.source)
                            .collect();
                        Box::new(move |n: &NoteMeta, _| sources.contains(&n.path))
                    }
                    Filter::LinkedFrom(target) => {
                        let from = resolve(target)?;
                        let targets: HashSet<String> = index
                            .outlinks(&from)?
                            .into_iter()
                            .filter_map(|l| l.resolved)
                            .collect();
                        Box::new(move |n: &NoteMeta, _| targets.contains(&n.path))
                    }
                    Filter::Has(name) => Box::new(move |n: &NoteMeta, t: Option<&TaskMeta>| {
                        !subject_field(n, t, name).is_empty()
                    }),
                    Filter::Compare(name, op, targets) => {
                        Box::new(move |n: &NoteMeta, t: Option<&TaskMeta>| {
                            compare(&subject_field(n, t, name), *op, targets)
                        })
                    }
                };
                keeps.push((keep, *neg));
            }
            group_keeps.push(keeps);
        }
        if let Some(statuses) = &self.tasks {
            return self.run_tasks(index, notes, statuses, &group_keeps);
        }
        // Full-text terms narrow their OR group and give the default order (best match first).
        let text_hits: Vec<Option<std::collections::HashMap<String, usize>>> = self
            .groups
            .iter()
            .map(|g| {
                if g.text.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(
                        index
                            .search(&g.text.join(" "), 100_000)?
                            .into_iter()
                            .enumerate()
                            .map(|(i, h)| (h.path, i))
                            .collect(),
                    ))
                }
            })
            .collect::<Result<_>>()?;
        let matches_group = |n: &NoteMeta, i: usize| {
            group_keeps[i].iter().all(|(k, neg)| k(n, None) != *neg)
                && text_hits[i]
                    .as_ref()
                    .is_none_or(|hits| hits.contains_key(&n.path))
        };
        notes.retain(|n| (0..self.groups.len()).any(|i| matches_group(n, i)));
        if self.sort.is_empty() && text_hits.iter().any(Option::is_some) {
            notes.sort_by_key(|n| {
                (0..self.groups.len())
                    .filter(|i| matches_group(n, *i))
                    .filter_map(|i| text_hits[i].as_ref().and_then(|h| h.get(&n.path)).copied())
                    .min()
                    .unwrap_or(usize::MAX)
            });
        }
        if !self.sort.is_empty() {
            notes.sort_by(|a, b| {
                self.order(a, None, b, None)
                    .then_with(|| a.path.cmp(&b.path))
            });
        }
        let total = notes.len();
        notes.truncate(self.limit.unwrap_or(DEFAULT_LIMIT));
        Ok(QueryResult {
            columns: self.columns(),
            rows: notes.into_iter().map(|n| row_of(n, None)).collect(),
            total,
        })
    }

    /// `task:` queries: the tasks of the notes, each checked against every filter.
    fn run_tasks(
        &self,
        index: &Index,
        notes: Vec<NoteMeta>,
        statuses: &[String],
        group_keeps: &GroupKeeps<'_>,
    ) -> Result<QueryResult> {
        let by_path: std::collections::HashMap<String, NoteMeta> =
            notes.into_iter().map(|n| (n.path.clone(), n)).collect();
        let words: Vec<Vec<String>> = self
            .groups
            .iter()
            .map(|g| g.text.iter().map(|w| unquote(w).to_lowercase()).collect())
            .collect();
        let mut found: Vec<(&NoteMeta, TaskMeta)> = index
            .tasks()?
            .into_iter()
            .filter_map(|t| Some((by_path.get(&t.path)?, t)))
            .filter(|(_, t)| statuses.iter().any(|s| s == task_status(t.mark)))
            .filter(|(n, t)| {
                let text = crate::task_board::label(&t.text).to_lowercase();
                group_keeps.iter().zip(&words).any(|(keeps, words)| {
                    keeps.iter().all(|(k, neg)| k(n, Some(t)) != *neg)
                        && words.iter().all(|w| text.contains(w.as_str()))
                })
            })
            .collect();
        // Index order (by note, then line) unless sorted.
        if !self.sort.is_empty() {
            found.sort_by(|(na, ta), (nb, tb)| {
                self.order(na, Some(ta), nb, Some(tb))
                    .then_with(|| (&ta.path, ta.line).cmp(&(&tb.path, tb.line)))
            });
        }
        let total = found.len();
        found.truncate(self.limit.unwrap_or(DEFAULT_LIMIT));
        Ok(QueryResult {
            columns: self.columns(),
            rows: found
                .into_iter()
                .map(|(n, t)| row_of(n.clone(), Some(t)))
                .collect(),
            total,
        })
    }

    /// Compares two notes (or tasks) by the `sort:` fields.
    fn order(
        &self,
        a: &NoteMeta,
        ta: Option<&TaskMeta>,
        b: &NoteMeta,
        tb: Option<&TaskMeta>,
    ) -> Ordering {
        for (name, desc) in &self.sort {
            let o = if name == "modified" {
                let o = a.mtime.cmp(&b.mtime);
                if *desc { o.reverse() } else { o }
            } else {
                let (fa, fb) = (subject_field(a, ta, name), subject_field(b, tb, name));
                match (fa.is_empty(), fb.is_empty()) {
                    // Without the field: last, in either direction.
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
        Ordering::Equal
    }
}

fn row_of(n: NoteMeta, t: Option<TaskMeta>) -> QueryRow {
    QueryRow {
        path: n.path,
        title: n.title,
        modified: n.mtime,
        tags: n.tags,
        props: n.props,
        task: t.map(|t| TaskRow {
            line: t.line,
            status: task_status(t.mark),
            mark: t.mark,
            workflow: crate::task_board::state(&t.text, t.mark).into(),
            text: crate::task_board::label(&t.text),
            depth: t.depth,
            parent: t.parent,
            due: t.due,
        }),
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
        assert_eq!(
            paths("status=active OR owners=ben", &idx),
            ["Inbox/Idea.md", "Projects/Mosaic.md"]
        );
        assert_eq!(
            paths("tag:project status=paused OR tomato folder:Inbox", &idx),
            ["Inbox/Idea.md", "Projects/Garden.md"]
        );
        assert!(parse("OR tag:project").is_err());
        assert!(parse("tag:project OR").is_err());
    }

    fn tasks(q: &str, idx: &Index) -> Vec<String> {
        parse(q)
            .unwrap()
            .run(idx, |_| true)
            .unwrap()
            .rows
            .into_iter()
            .map(|r| {
                let t = r.task.expect("a task row");
                format!("{}:{} {}", r.path, t.line, t.text)
            })
            .collect()
    }

    #[test]
    fn task_queries() {
        let (_d, idx) = vault(&[
            (
                "Daily/2026-10-02.md",
                "# Fri\n- [x] Standup\n- [>] Write report\n- [ ] Call Anna #urgent 📅 2026-10-05\n",
            ),
            (
                "Daily/2026-10-03.md",
                "# Sat\n- [ ] Write report\n    - [x] Outline\n    - [ ] Draft\n- [-] Gym\n",
            ),
            (
                "Projects/Site.md",
                "---\ndue: 2026-10-20\ntags: [project]\n---\n- [ ] Wireframes\n- [ ] Copy 📅 2026-10-04\n",
            ),
            ("Plain.md", "No tasks here.\n"),
        ]);
        assert_eq!(
            tasks("task:open folder:Daily", &idx),
            [
                "Daily/2026-10-02.md:4 Call Anna #urgent 📅 2026-10-05",
                "Daily/2026-10-03.md:2 Write report",
                "Daily/2026-10-03.md:4 Draft",
            ]
        );
        assert_eq!(
            tasks("task:done|moved", &idx),
            [
                "Daily/2026-10-02.md:2 Standup",
                "Daily/2026-10-02.md:3 Write report",
                "Daily/2026-10-03.md:3 Outline",
            ]
        );
        assert_eq!(tasks("-task:open folder:Daily", &idx).len(), 4);
        // A task's own date first, else its note's.
        assert_eq!(
            tasks("task:open due<=2026-10-05 sort:due", &idx),
            [
                "Projects/Site.md:6 Copy 📅 2026-10-04",
                "Daily/2026-10-02.md:4 Call Anna #urgent 📅 2026-10-05",
            ]
        );
        assert_eq!(
            tasks("task:open tag:project -has:nothing sort:-due", &idx),
            [
                "Projects/Site.md:5 Wireframes",
                "Projects/Site.md:6 Copy 📅 2026-10-04",
            ]
        );
        // Tags written in the task, and words in its text.
        assert_eq!(
            tasks("task:all tag:urgent", &idx),
            ["Daily/2026-10-02.md:4 Call Anna #urgent 📅 2026-10-05"]
        );
        assert_eq!(tasks("task:all report", &idx).len(), 2);
        assert_eq!(
            tasks("task:all text~gym", &idx),
            ["Daily/2026-10-03.md:5 Gym"]
        );
        assert_eq!(
            tasks("task:open tag:urgent OR task:open text~wire", &idx),
            [
                "Daily/2026-10-02.md:4 Call Anna #urgent 📅 2026-10-05",
                "Projects/Site.md:5 Wireframes",
            ]
        );
        // Subtasks know their parent.
        let r = parse("task:all folder:Daily name=2026-10-03")
            .unwrap()
            .run(&idx, |_| true)
            .unwrap();
        let draft = r.rows[2].task.as_ref().unwrap();
        assert_eq!(
            (draft.text.as_str(), draft.depth, draft.parent, draft.status),
            ("Draft", 1, Some(2), "open")
        );
        assert_eq!(r.rows[2].cell("status"), "open");
        // Hidden notes' tasks stay hidden; a bad status is an error.
        let hidden = parse("task:all")
            .unwrap()
            .run(&idx, |p| !p.starts_with("Daily/"))
            .unwrap();
        assert_eq!(hidden.total, 2);
        assert!(parse("task:later").is_err());
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
