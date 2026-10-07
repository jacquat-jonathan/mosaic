//! Portable task workflow annotations. Checkbox completion remains authoritative.
use regex::Regex;
use std::sync::LazyLock;

pub const STATES: [&str; 5] = ["new", "blocked", "in-progress", "in-qa", "done"];
static ANNOTATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\s*<!--\s*mosaic:state=(new|blocked|in-progress|in-qa|done)\s*-->").unwrap()
});

pub fn label(text: &str) -> String {
    ANNOTATION.replace_all(text, "").trim().to_string()
}

pub fn state(text: &str, mark: char) -> &str {
    if matches!(mark, 'x' | 'X') {
        return "done";
    }
    ANNOTATION
        .captures(text)
        .and_then(|c| c.get(1))
        .map_or("new", |m| {
            if m.as_str() == "done" {
                "new"
            } else {
                m.as_str()
            }
        })
}

pub fn annotate(text: &str, next: &str) -> String {
    let clean = label(text);
    if matches!(next, "new" | "done") {
        return clean;
    }
    // Keep an Obsidian block ID at the end of the task line.
    if let Some((body, id)) = clean.rsplit_once(" ^")
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return format!("{body} <!-- mosaic:state={next} --> ^{id}");
    }
    format!("{clean} <!-- mosaic:state={next} -->")
}
