//! Obsidian-compatible link resolution. Mirrors `ui/src/links.ts`; keep the two in sync.
//!
//! Rules: case-insensitive; `.md` optional for notes; an exact vault path wins, then a file in the
//! source note's folder, then the shortest path (ties alphabetical). Markdown links try the path
//! relative to the source first. Aliases from frontmatter resolve as a last resort.

use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct FileSet {
    by_lower_path: HashMap<String, String>,
    /// Lower-case file name → paths with that name.
    by_name: HashMap<String, Vec<String>>,
    aliases: HashMap<String, String>,
}

pub fn parent(path: &str) -> &str {
    path.rfind('/').map(|i| &path[..i]).unwrap_or("")
}

pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Lookup key for a link target or a path: lower-case last segment without `.md`.
pub fn link_key(target: &str) -> String {
    let name = file_name(target).to_lowercase();
    name.strip_suffix(".md").map(str::to_string).unwrap_or(name)
}

/// Joins `rel` (which may contain `..` and `.`) onto `dir`; `None` if it climbs above the root.
pub fn join_relative(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

impl FileSet {
    pub fn new<'a>(
        paths: impl IntoIterator<Item = &'a str>,
        aliases: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        let mut fs = FileSet::default();
        for p in paths {
            fs.by_lower_path.insert(p.to_lowercase(), p.to_string());
            fs.by_name
                .entry(file_name(p).to_lowercase())
                .or_default()
                .push(p.to_string());
        }
        for list in fs.by_name.values_mut() {
            list.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
        }
        for (alias, path) in aliases {
            fs.aliases
                .entry(alias.to_lowercase())
                .or_insert_with(|| path.to_string());
        }
        fs
    }

    pub fn contains(&self, path: &str) -> bool {
        self.by_lower_path.contains_key(&path.to_lowercase())
    }

    fn lookup(&self, name: &str, from_dir: &str) -> Option<String> {
        if let Some(p) = self.by_lower_path.get(name) {
            return Some(p.clone());
        }
        let candidates = self.by_name.get(file_name(name))?;
        let suffix = format!("/{name}");
        let matches: Vec<&String> = candidates
            .iter()
            .filter(|p| p.to_lowercase().ends_with(&suffix))
            .collect();
        let from_dir = from_dir.to_lowercase();
        matches
            .iter()
            .find(|p| parent(p).to_lowercase() == from_dir)
            .or_else(|| matches.first())
            .map(|p| (*p).clone())
    }

    /// Resolves a link target written in `from` (a vault path), or `None` if unresolved.
    pub fn resolve(&self, target: &str, from: Option<&str>, markdown: bool) -> Option<String> {
        let from_dir = from.map(parent).unwrap_or("");
        let mut t = target.trim().replace('\\', "/");
        if t.is_empty() {
            return from.map(str::to_string);
        }
        if let Some(stripped) = t.strip_prefix("./") {
            t = stripped.to_string();
        }
        if t.starts_with('/') {
            t = t.trim_start_matches('/').to_string();
        } else if markdown || t.starts_with("../") {
            if let Some(rel) = join_relative(from_dir, &t) {
                let lower = rel.to_lowercase();
                for name in candidates(&lower) {
                    if let Some(p) = self.by_lower_path.get(&name) {
                        return Some(p.clone());
                    }
                }
            }
            if t.starts_with("../") {
                return None;
            }
        }
        let lower = t.to_lowercase();
        for name in candidates(&lower) {
            if let Some(p) = self.lookup(&name, from_dir) {
                return Some(p);
            }
        }
        if !lower.contains('/') {
            return self.aliases.get(&lower).cloned();
        }
        None
    }
}

fn candidates(lower: &str) -> Vec<String> {
    if lower.ends_with(".md") {
        vec![lower.to_string()]
    } else {
        vec![format!("{lower}.md"), lower.to_string()]
    }
}

/// Link text to write for `path` from `from`: the shortest form that resolves back to it.
pub fn wiki_text_for(files: &FileSet, path: &str, from: Option<&str>) -> String {
    let is_note = path.to_lowercase().ends_with(".md");
    let strip = |s: &str| {
        if is_note {
            s[..s.len() - 3].to_string()
        } else {
            s.to_string()
        }
    };
    let short = strip(file_name(path));
    if files.resolve(&short, from, false).as_deref() == Some(path) {
        short
    } else {
        strip(path)
    }
}

/// Relative Markdown link URL from `from`'s folder to `path`, with spaces encoded.
pub fn markdown_url_for(path: &str, from: &str) -> String {
    let from_parts: Vec<&str> = parent(from).split('/').filter(|s| !s.is_empty()).collect();
    let to_parts: Vec<&str> = path.split('/').collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut segs: Vec<String> = vec!["..".to_string(); from_parts.len() - common];
    segs.extend(to_parts[common..].iter().map(|s| s.to_string()));
    segs.join("/").replace('%', "%25").replace(' ', "%20")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Cases shared with `ui/src/links.test.ts`.
    fn shared() -> (FileSet, Value) {
        let cases: Value =
            serde_json::from_str(include_str!("../../../fixtures/links.json")).unwrap();
        let files: Vec<&str> = cases["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap())
            .collect();
        let aliases: Vec<(&str, &str)> = cases["aliases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| (a[0].as_str().unwrap(), a[1].as_str().unwrap()))
            .collect();
        (FileSet::new(files, aliases), cases)
    }

    #[test]
    fn resolves_the_shared_cases() {
        let (f, cases) = shared();
        for c in cases["resolve"].as_array().unwrap() {
            let got = f.resolve(
                c["target"].as_str().unwrap(),
                c["from"].as_str(),
                c["markdown"].as_bool().unwrap_or(false),
            );
            assert_eq!(got.as_deref(), c["expected"].as_str(), "{}: {c}", c["why"]);
        }
    }

    #[test]
    fn writes_the_shared_link_texts() {
        let (f, cases) = shared();
        for c in cases["linkText"].as_array().unwrap() {
            let got = wiki_text_for(&f, c["path"].as_str().unwrap(), c["from"].as_str());
            assert_eq!(got, c["expected"].as_str().unwrap(), "{}: {c}", c["why"]);
        }
    }

    #[test]
    fn writes_relative_markdown_urls() {
        assert_eq!(
            markdown_url_for("Ideas.md", "Projects/Mosaic/Plan.md"),
            "../../Ideas.md"
        );
        assert_eq!(
            markdown_url_for("Projects/My Note.md", "Projects/a.md"),
            "My%20Note.md"
        );
    }
}
