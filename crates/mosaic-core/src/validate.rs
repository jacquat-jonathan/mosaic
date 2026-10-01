//! Checks structured files (canvases, drawings, charts, JSON) before they're written, so an agent learns
//! about a broken file immediately instead of a human finding it when it doesn't open. Only the CLI and
//! MCP server turn this on: the app saves half-typed JSON while someone is still editing it.

use crate::kind::FileKind;
use crate::{Error, Result};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

/// The diagram fields Mosaic adds to canvases (shapes, borders, line styles, arrowheads).
static FORMAT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("diagram_format.json")).expect("valid diagram_format.json")
});

/// Checks that an optional string field holds one of `allowed` (the keys of an object, or an array).
fn one_of(item: &Value, key: &str, allowed: &str, at: &str) -> std::result::Result<(), String> {
    let Some(v) = item.get(key) else {
        return Ok(());
    };
    let names: Vec<&str> = match &FORMAT[allowed] {
        Value::Object(m) => m.keys().map(String::as_str).collect(),
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    match v.as_str() {
        Some(s) if names.contains(&s) => Ok(()),
        _ => Err(format!(
            "{at}: \"{key}\" must be one of {}, not {v}",
            names.join(", ")
        )),
    }
}

/// `Ok` for files that aren't structured, or are well-formed; otherwise `Error::Invalid` saying what's wrong.
pub fn check(path: &str, content: &str) -> Result<()> {
    let lower = path.to_lowercase();
    let kind = FileKind::of(Path::new(path));
    let problem = match kind {
        FileKind::Canvas => json(content).and_then(|v| canvas(&v)),
        FileKind::Excalidraw => json(content).and_then(|v| excalidraw(&v)),
        FileKind::Json if lower.ends_with(".vl.json") => json(content).and_then(|v| match v {
            Value::Object(_) => Ok(()),
            _ => Err("a Vega-Lite spec must be a JSON object".into()),
        }),
        FileKind::Json => json(content).map(|_| ()),
        _ => Ok(()),
    };
    problem.map_err(|p| Error::Invalid(format!("{path} wasn't written: {p}")))
}

/// Checks that an optional field is a number within `min..=max`.
fn number_in(
    item: &Value,
    key: &str,
    min: f64,
    max: f64,
    at: &str,
) -> std::result::Result<(), String> {
    match item.get(key) {
        None => Ok(()),
        Some(v) if v.as_f64().is_some_and(|n| (min..=max).contains(&n)) => Ok(()),
        Some(v) => Err(format!(
            "{at}: \"{key}\" must be a number from {min} to {max}, not {v}"
        )),
    }
}

fn json(content: &str) -> std::result::Result<Value, String> {
    serde_json::from_str(content).map_err(|e| format!("invalid JSON ({e})"))
}

/// JSON Canvas 1.0: <https://jsoncanvas.org/spec/1.0/>. Unknown node types and extra fields are fine.
fn canvas(v: &Value) -> std::result::Result<(), String> {
    let obj = v.as_object().ok_or("a canvas must be a JSON object")?;
    let list = |key: &str| -> std::result::Result<&[Value], String> {
        match obj.get(key) {
            None => Ok(&[]),
            Some(Value::Array(a)) => Ok(a),
            Some(_) => Err(format!("\"{key}\" must be an array")),
        }
    };
    let mut ids = HashSet::new();
    for (i, node) in list("nodes")?.iter().enumerate() {
        let id = node.get("id").and_then(Value::as_str);
        let at = match id {
            Some(id) => format!("node \"{id}\""),
            None => format!("node {}", i + 1),
        };
        let id = id.ok_or_else(|| format!("{at} has no string \"id\""))?;
        if !ids.insert(id) {
            return Err(format!("{at}: the id is used twice"));
        }
        let ty = node
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{at} has no string \"type\""))?;
        for key in ["x", "y", "width", "height"] {
            if !node.get(key).is_some_and(Value::is_number) {
                return Err(format!("{at} needs a number \"{key}\""));
            }
        }
        let required = match ty {
            "text" => Some("text"),
            "file" => Some("file"),
            "link" => Some("url"),
            _ => None,
        };
        if let Some(key) = required
            && !node.get(key).is_some_and(Value::is_string)
        {
            return Err(format!("{at} is a {ty} card but has no string \"{key}\""));
        }
        one_of(node, "shape", "shapes", &at)?;
        one_of(node, "border", "borders", &at)?;
        one_of(node, "icon", "icons", &at)?;
    }
    for (i, edge) in list("edges")?.iter().enumerate() {
        let at = match edge.get("id").and_then(Value::as_str) {
            Some(id) => format!("edge \"{id}\""),
            None => return Err(format!("edge {} has no string \"id\"", i + 1)),
        };
        for key in ["fromNode", "toNode"] {
            let target = edge
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{at} has no string \"{key}\""))?;
            if !ids.contains(target) {
                return Err(format!(
                    "{at}: \"{key}\" points to \"{target}\", which isn't a node"
                ));
            }
        }
        one_of(edge, "line", "lines", &at)?;
        one_of(edge, "fromEnd", "ends", &at)?;
        one_of(edge, "toEnd", "ends", &at)?;
        number_in(edge, "fromOffset", 0.0, 1.0, &at)?;
        number_in(edge, "toOffset", 0.0, 1.0, &at)?;
        number_in(edge, "thickness", 0.5, 20.0, &at)?;
    }
    Ok(())
}

fn excalidraw(v: &Value) -> std::result::Result<(), String> {
    let obj = v.as_object().ok_or("a drawing must be a JSON object")?;
    match obj.get("elements") {
        None | Some(Value::Array(_)) => Ok(()),
        Some(_) => Err("\"elements\" must be an array".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problem(path: &str, content: &str) -> String {
        match check(path, content) {
            Err(Error::Invalid(m)) => m,
            other => panic!("expected invalid, got {other:?}"),
        }
    }

    const NODE: &str = r#""x":0,"y":0,"width":10,"height":10"#;

    #[test]
    fn accepts_good_files_and_ignores_others() {
        let canvas = format!(
            r#"{{"nodes":[{{"id":"a","type":"text","text":"hi",{NODE}}},{{"id":"b","type":"text","text":"DB","shape":"cylinder","border":"dashed",{NODE}}}],
                "edges":[{{"id":"e","fromNode":"a","toNode":"b","line":"dotted","toEnd":"triangle","fromEnd":"diamond-open","toLabel":"1..*"}}]}}"#
        );
        check("Board.canvas", &canvas).unwrap();
        check("Empty.canvas", "{}").unwrap();
        check("D.excalidraw", r#"{"type":"excalidraw","elements":[]}"#).unwrap();
        check("Chart.vl.json", r#"{"mark":"bar"}"#).unwrap();
        check("data.json", "[1, 2]").unwrap();
        check("Note.md", "{ not json").unwrap();
        check("graph.dot", "digraph {").unwrap();
    }

    #[test]
    fn says_what_is_wrong() {
        assert!(problem("Board.canvas", "{\"nodes\": [").contains("invalid JSON (EOF"));
        assert!(problem("Board.canvas", r#"{"nodes": {}}"#).contains("\"nodes\" must be an array"));
        let no_text = format!(r#"{{"nodes":[{{"id":"a","type":"text",{NODE}}}]}}"#);
        assert_eq!(
            problem("Board.canvas", &no_text),
            "Board.canvas wasn't written: node \"a\" is a text card but has no string \"text\""
        );
        let no_x = r#"{"nodes":[{"id":"a","type":"group","y":0,"width":1,"height":1}]}"#;
        assert!(problem("B.canvas", no_x).contains("node \"a\" needs a number \"x\""));
        let twice = format!(
            r#"{{"nodes":[{{"id":"a","type":"group",{NODE}}},{{"id":"a","type":"group",{NODE}}}]}}"#
        );
        assert!(problem("B.canvas", &twice).contains("used twice"));
        let dangling = format!(
            r#"{{"nodes":[{{"id":"a","type":"group",{NODE}}}],"edges":[{{"id":"e","fromNode":"a","toNode":"zz"}}]}}"#
        );
        assert!(problem("B.canvas", &dangling).contains("\"toNode\" points to \"zz\""));
        let bad_shape =
            format!(r#"{{"nodes":[{{"id":"a","type":"text","text":"","shape":"blob",{NODE}}}]}}"#);
        assert!(problem("B.canvas", &bad_shape).contains("\"shape\" must be one of"));
        let bad_end = format!(
            r#"{{"nodes":[{{"id":"a","type":"group",{NODE}}}],"edges":[{{"id":"e","fromNode":"a","toNode":"a","toEnd":"spear"}}]}}"#
        );
        assert!(problem("B.canvas", &bad_end).contains("\"toEnd\" must be one of"));
        let bad_offset = bad_end.replace(r#""toEnd":"spear""#, r#""toOffset":1.5"#);
        assert!(
            problem("B.canvas", &bad_offset).contains("\"toOffset\" must be a number from 0 to 1")
        );
        assert!(
            problem("D.excalidraw", r#"{"elements": 3}"#).contains("\"elements\" must be an array")
        );
        assert!(problem("C.vl.json", "[]").contains("must be a JSON object"));
        assert!(problem("x.json", "{,}").contains("invalid JSON"));
    }

    #[test]
    fn the_app_diagram_templates_are_valid() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/diagrams/templates");
        let mut seen = 0;
        let uml = std::fs::read_dir(dir.join("uml")).unwrap();
        for e in std::fs::read_dir(&dir).unwrap().chain(uml) {
            let path = e.unwrap().path();
            if path.is_dir() {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            check(&name, &std::fs::read_to_string(&path).unwrap()).unwrap();
            seen += 1;
        }
        assert!(
            seen >= 19,
            "expected the diagram templates in {}",
            dir.display()
        );
    }
}
