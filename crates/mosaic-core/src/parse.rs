//! Extracts Obsidian-flavoured structure from a Markdown note: frontmatter, links, embeds, tags,
//! headings and block ids. Code (fenced, indented-by-fence and inline) is skipped. Byte ranges are
//! kept so links can be rewritten in place when their target moves.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Wiki,
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Link {
    pub kind: LinkKind,
    /// Target as written (without #heading, ^block, |alias; URL-decoded for Markdown links).
    pub target: String,
    pub heading: Option<String>,
    pub block: Option<String>,
    pub alias: Option<String>,
    pub embed: bool,
    /// 1-based line number.
    pub line: usize,
    /// Byte range of the target text inside the file (what to replace when the target moves).
    #[serde(skip)]
    pub target_range: (usize, usize),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: usize,
}

/// A checkbox list item: `- [ ] text`. Subtasks are checkboxes indented under another one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Task {
    /// 1-based line number.
    pub line: usize,
    /// The character between the brackets: ' ' open, 'x' done, '>' moved, '-' cancelled, …
    pub mark: char,
    /// The text after the checkbox.
    pub text: String,
    /// How many tasks it's nested under (0 = top level).
    pub depth: usize,
    /// Line of the task it's nested under.
    pub parent: Option<usize>,
    /// `📅 2026-10-05` in the text (the Obsidian Tasks plugin's due date).
    pub due: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Parsed {
    /// Raw YAML between the `---` fences, if any.
    pub frontmatter: Option<String>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub links: Vec<Link>,
    pub headings: Vec<Heading>,
    pub block_ids: Vec<String>,
    pub tasks: Vec<Task>,
    /// Body text without frontmatter (for full-text search).
    #[serde(skip)]
    pub body: String,
}

static FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A---[ \t]*\r?\n((?s:.*?))\r?\n---[ \t]*(?:\r?\n|\z)").unwrap());
static WIKI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(!?)\[\[([^\[\]\n]+?)\]\]").unwrap());
static MD_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s()]+)(?:\s+"[^"\n]*")?\s*\)"#).unwrap()
});
static TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[\s(,])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)").unwrap()
});
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(#{1,6})[ \t]+(.+?)[ \t#]*$").unwrap());
static BLOCK_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s\^([A-Za-z0-9-]+)\s*$").unwrap());
static TASK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[(.)\](?:[ \t]+(.*))?$").unwrap()
});
static TASK_DUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"📅\s*(\d{4}-\d{2}-\d{2})").unwrap());
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{0,3}(`{3,}|~{3,})").unwrap());

pub fn split_wiki_inner(inner: &str) -> (String, Option<String>, Option<String>, Option<String>) {
    let (rest, alias) = match inner.split_once('|') {
        Some((a, b)) => (a, Some(b.trim().to_string()).filter(|s| !s.is_empty())),
        None => (inner, None),
    };
    let (rest, block) = match rest.split_once('^') {
        Some((a, b)) => (a, Some(b.trim().to_string()).filter(|s| !s.is_empty())),
        None => (rest, None),
    };
    let (target, heading) = match rest.split_once('#') {
        Some((a, b)) => (a, Some(b.trim().to_string()).filter(|s| !s.is_empty())),
        None => (rest, None),
    };
    (target.trim().to_string(), heading, block, alias)
}

fn is_external(url: &str) -> bool {
    let bytes = url.as_bytes();
    match url.find(':') {
        Some(i) if i > 1 => bytes[..i]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(b)),
        _ => false,
    }
}

/// Minimal percent-decoding for Markdown link targets (`My%20Note.md`).
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = |b: u8| (b as char).to_digit(16).unwrap() as u8;
            out.push(hex(bytes[i + 1]) * 16 + hex(bytes[i + 2]));
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Replaces inline code spans with spaces (same length) so offsets stay valid.
fn blank_inline_code(line: &str) -> String {
    let mut out: Vec<u8> = line.as_bytes().to_vec();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let mut n = 0;
            while i + n < bytes.len() && bytes[i + n] == b'`' {
                n += 1;
            }
            let fence = &line[i..i + n];
            if let Some(end) = line[i + n..].find(fence) {
                let close = i + n + end + n;
                for b in out.iter_mut().take(close).skip(i) {
                    if *b != b'\n' {
                        *b = b' ';
                    }
                }
                i = close;
                continue;
            }
            i += n;
        } else {
            i += 1;
        }
    }
    // Only ASCII bytes were replaced by ASCII spaces inside complete code spans, but a span may contain
    // multi-byte characters; replacing each of their bytes with a space still yields valid UTF-8.
    String::from_utf8(out).unwrap_or_else(|_| line.to_string())
}

fn yaml_strings(v: &serde_norway::Value) -> Vec<String> {
    match v {
        serde_norway::Value::String(s) => s
            .split(',')
            .map(|p| p.trim().trim_start_matches('#').to_string())
            .filter(|p| !p.is_empty())
            .collect(),
        serde_norway::Value::Sequence(items) => items
            .iter()
            .filter_map(|i| match i {
                serde_norway::Value::String(s) => {
                    Some(s.trim().trim_start_matches('#').to_string())
                }
                serde_norway::Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

pub fn frontmatter_span(text: &str) -> Option<(usize, String)> {
    FRONTMATTER
        .captures(text)
        .map(|c| (c.get(0).unwrap().end(), c[1].to_string()))
}

/// `line` with its checkbox set to `mark`, if it's a task line whose text is `text`.
pub fn with_task_mark(line: &str, text: &str, mark: char) -> Option<String> {
    let c = TASK.captures(line)?;
    let raw = c.get(3).map_or("", |m| m.as_str()).trim();
    if raw != text.trim() && crate::task_board::label(raw) != text.trim() {
        return None;
    }
    let m = c.get(2)?;
    Some(format!("{}{mark}{}", &line[..m.start()], &line[m.end()..]))
}

/// Replace only a task's text, retaining the exact marker, spacing and trailing whitespace.
pub fn with_task_text(line: &str, text: &str) -> Option<String> {
    let c = TASK.captures(line)?;
    if let Some(body) = c.get(3) {
        let end = body.start() + body.as_str().trim_end().len();
        Some(format!("{}{}{}", &line[..body.start()], text, &line[end..]))
    } else {
        Some(format!("{line} {text}"))
    }
}

/// The #tags in one line of text (e.g. a task's).
pub fn tags_in(text: &str) -> Vec<String> {
    TAG.captures_iter(text).map(|c| c[1].to_string()).collect()
}

pub fn parse(text: &str) -> Parsed {
    let mut p = Parsed::default();
    let mut body_start = 0;
    if let Some((end, yaml)) = frontmatter_span(text) {
        body_start = end;
        if let Ok(serde_norway::Value::Mapping(map)) =
            serde_norway::from_str::<serde_norway::Value>(&yaml)
        {
            for (k, v) in &map {
                match k.as_str() {
                    Some("aliases") | Some("alias") => p.aliases.extend(yaml_strings(v)),
                    Some("tags") | Some("tag") => p.tags.extend(yaml_strings(v)),
                    _ => {}
                }
            }
        }
        p.frontmatter = Some(yaml);
    }
    p.body = text[body_start..].to_string();

    let body_line_offset = text[..body_start].matches('\n').count();
    let mut offset = body_start;
    let mut fence: Option<String> = None;
    // Open list items above the current line, as (indent width, task line): a task's parent is
    // the nearest one indented less.
    let mut task_stack: Vec<(usize, usize)> = Vec::new();
    for (i, raw_line) in text[body_start..].split_inclusive('\n').enumerate() {
        let line_no = body_line_offset + i + 1;
        let line_start = offset;
        offset += raw_line.len();
        let line = raw_line.trim_end_matches(['\n', '\r']);

        if let Some(m) = FENCE.captures(line) {
            let marker = &m[1];
            match &fence {
                None => {
                    fence = Some(marker.to_string());
                    continue;
                }
                Some(open) if marker.starts_with(&open[..1]) && marker.len() >= open.len() => {
                    fence = None;
                    continue;
                }
                _ => {}
            }
        }
        if fence.is_some() {
            continue;
        }

        if let Some(h) = HEADING.captures(line) {
            p.headings.push(Heading {
                level: h[1].len() as u8,
                text: h[2].to_string(),
                line: line_no,
            });
        }
        if let Some(b) = BLOCK_ID.captures(line) {
            p.block_ids.push(b[1].to_string());
        }
        if let Some(t) = TASK.captures(line) {
            let indent: usize = t[1].chars().map(|c| if c == '\t' { 4 } else { 1 }).sum();
            while task_stack.last().is_some_and(|(w, _)| *w >= indent) {
                task_stack.pop();
            }
            let text = t.get(3).map_or("", |m| m.as_str()).trim().to_string();
            p.tasks.push(Task {
                line: line_no,
                mark: t[2].chars().next().unwrap_or(' '),
                due: TASK_DUE.captures(&text).map(|d| d[1].to_string()),
                text,
                depth: task_stack.len(),
                parent: task_stack.last().map(|(_, l)| *l),
            });
            task_stack.push((indent, line_no));
        } else if !line.starts_with([' ', '\t']) && !line.trim().is_empty() {
            // Unindented text ends the list.
            task_stack.clear();
        }

        let scan = blank_inline_code(line);
        let mut taken: Vec<(usize, usize)> = Vec::new();
        for c in WIKI.captures_iter(&scan) {
            let whole = c.get(0).unwrap();
            let inner = c.get(2).unwrap();
            let (target, heading, block, alias) = split_wiki_inner(inner.as_str());
            let target_len = inner.as_str().find(['#', '^', '|']).unwrap_or(inner.len());
            taken.push((whole.start(), whole.end()));
            p.links.push(Link {
                kind: LinkKind::Wiki,
                target,
                heading,
                block,
                alias,
                embed: &c[1] == "!",
                line: line_no,
                target_range: (
                    line_start + inner.start(),
                    line_start + inner.start() + target_len,
                ),
            });
        }
        for c in MD_LINK.captures_iter(&scan) {
            let whole = c.get(0).unwrap();
            if taken
                .iter()
                .any(|(s, e)| whole.start() < *e && whole.end() > *s)
            {
                continue;
            }
            let url_m = c.get(3).unwrap();
            let url = url_m.as_str().trim_start_matches('<').trim_end_matches('>');
            if is_external(url) || url.starts_with('#') {
                continue;
            }
            let (path_part, heading) = match url.split_once('#') {
                Some((a, b)) => (a, Some(percent_decode(b))),
                None => (url, None),
            };
            let angle = usize::from(url_m.as_str().starts_with('<'));
            taken.push((whole.start(), whole.end()));
            p.links.push(Link {
                kind: LinkKind::Markdown,
                target: percent_decode(path_part),
                heading,
                block: None,
                alias: Some(c[2].to_string()).filter(|s| !s.is_empty()),
                embed: &c[1] == "!",
                line: line_no,
                target_range: (
                    line_start + url_m.start() + angle,
                    line_start + url_m.start() + angle + path_part.len(),
                ),
            });
        }
        // "# Heading" has a space after '#', so heading markers never match the tag pattern.
        for c in TAG.captures_iter(&scan) {
            let m = c.get(1).unwrap();
            if !taken.iter().any(|(s, e)| m.start() < *e && m.end() > *s) {
                p.tags.push(m.as_str().to_string());
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    p.tags.retain(|t| seen.insert(t.to_lowercase()));
    p
}

/// First H1, else the file name without extension.
pub fn title(parsed: &Parsed, path: &str) -> String {
    parsed
        .headings
        .iter()
        .find(|h| h.level == 1)
        .map(|h| h.text.clone())
        .unwrap_or_else(|| {
            let name = path.rsplit('/').next().unwrap_or(path);
            name.strip_suffix(".md").unwrap_or(name).to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_with_subtasks_marks_and_due_dates() {
        let p = parse(
            "# Day\n- [ ] Write report 📅 2026-10-05\n    - [x] Outline\n    - [ ] Draft\n\t\t- [>] Deep\n- [-] Cancelled\n\nText\n  - [ ] after text\n1. [ ] numbered\n- [ ]\n```\n- [ ] in code\n```\n- plain item\n",
        );
        let t: Vec<(usize, char, &str, usize, Option<usize>)> = p
            .tasks
            .iter()
            .map(|t| (t.line, t.mark, t.text.as_str(), t.depth, t.parent))
            .collect();
        assert_eq!(
            t,
            [
                (2, ' ', "Write report 📅 2026-10-05", 0, None),
                (3, 'x', "Outline", 1, Some(2)),
                (4, ' ', "Draft", 1, Some(2)),
                (5, '>', "Deep", 2, Some(4)),
                (6, '-', "Cancelled", 0, None),
                (9, ' ', "after text", 0, None),
                (10, ' ', "numbered", 0, None),
                (11, ' ', "", 0, None),
            ]
        );
        assert_eq!(p.tasks[0].due.as_deref(), Some("2026-10-05"));
        assert_eq!(p.tasks[1].due, None);
    }

    const HOME: &str = "---\naliases: [Start, Index]\ntags: [hub]\ncustom_key: keep me\n---\n# Home\n\nSee [[Projects/Mosaic/Plan|the plan]], [[Ideas]] and [[Ideas#Later]].\nEmbedded: ![[diagram.png]]\n\n```\n[[not a link]] #notatag\n```\n\nInline `[[nope]]` and [md](../Other%20Note.md#Sec) and [web](https://x.y) #hub #area/work\nEnd ^blk-1\n";

    #[test]
    fn parses_frontmatter_links_tags_headings() {
        let p = parse(HOME);
        assert_eq!(p.aliases, vec!["Start", "Index"]);
        assert_eq!(p.tags, vec!["hub", "area/work"]);
        let targets: Vec<_> = p
            .links
            .iter()
            .map(|l| (l.target.as_str(), l.embed))
            .collect();
        assert_eq!(
            targets,
            vec![
                ("Projects/Mosaic/Plan", false),
                ("Ideas", false),
                ("Ideas", false),
                ("diagram.png", true),
                ("../Other Note.md", false),
            ]
        );
        assert_eq!(p.links[0].alias.as_deref(), Some("the plan"));
        assert_eq!(p.links[2].heading.as_deref(), Some("Later"));
        assert_eq!(p.links[4].heading.as_deref(), Some("Sec"));
        assert_eq!(p.links[0].line, 8);
        assert_eq!(
            p.headings,
            vec![Heading {
                level: 1,
                text: "Home".into(),
                line: 6
            }]
        );
        assert_eq!(p.block_ids, vec!["blk-1"]);
        assert_eq!(title(&p, "Home.md"), "Home");
    }

    #[test]
    fn target_ranges_point_at_the_target_text() {
        let p = parse(HOME);
        for l in &p.links {
            let raw = &HOME[l.target_range.0..l.target_range.1];
            assert_eq!(percent_decode(raw), l.target, "range for {l:?}");
        }
    }

    #[test]
    fn heading_markers_are_not_tags() {
        let p = parse("# Title\n## Sub #real\n#solo\n");
        assert_eq!(p.tags, vec!["real", "solo"]);
    }

    #[test]
    fn numbers_only_is_not_a_tag() {
        assert!(parse("issue #123 and #a1").tags == vec!["a1"]);
    }
}
