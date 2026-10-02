//! A canvas drawn as a standalone SVG, for agents (the `render` tool lets them see what they drew)
//! and the command line. It mirrors the editor's static renderer (`ui/src/diagrams/canvasToSvg.ts`):
//! both read how to draw each shape and icon from `diagram_format.json`.

use crate::error::{Error, Result};
use crate::validate::FORMAT;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt::Write;

struct Theme {
    bg: &'static str,
    fg: &'static str,
    muted: &'static str,
    stroke: &'static str,
    card: &'static str,
}

const LIGHT: Theme = Theme {
    bg: "#ffffff",
    fg: "#1f2328",
    muted: "#6b7080",
    stroke: "#8a8f9c",
    card: "#d0d4dc",
};
const DARK: Theme = Theme {
    bg: "#1e1f24",
    fg: "#e6e7ea",
    muted: "#9a9fad",
    stroke: "#8a8f9c",
    card: "#3a3d45",
};

const FONT: f64 = 14.0;
const LINE: f64 = 19.0;
const PAD: f64 = 40.0;
/// The family names resvg finds on macOS; browsers fall back along the list.
const FONT_FAMILY: &str = "Helvetica Neue, Helvetica, Arial, sans-serif";

/// Preset colours "1"–"6" (red, orange, yellow, green, cyan, purple), or "#rrggbb".
fn color_of(c: Option<&str>) -> Option<String> {
    match c? {
        "1" => Some("#e5484d".into()),
        "2" => Some("#f76b15".into()),
        "3" => Some("#e2b400".into()),
        "4" => Some("#30a46c".into()),
        "5" => Some("#05a2c2".into()),
        "6" => Some("#8e4ec6".into()),
        h if h.starts_with('#') => Some(h.to_string()),
        _ => None,
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn dash(style: Option<&str>, width: f64) -> Option<String> {
    match style? {
        "dashed" => Some(format!("{} {}", width * 4.0, width * 3.0)),
        "dotted" => Some(format!("{} {}", width, width * 2.0)),
        _ => None,
    }
}

/// Markdown → plain lines: headings, emphasis, links, tags and list markers removed.
pub fn plain_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_code = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            if !in_code {
                out.push("[diagram]".to_string());
            }
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let mut l = line.trim().to_string();
        while l.starts_with('#') {
            l.remove(0);
        }
        let l = l.trim_start();
        let l = if let Some(rest) = l
            .strip_prefix("- ")
            .or(l.strip_prefix("* "))
            .or(l.strip_prefix("+ "))
        {
            format!("• {rest}")
        } else {
            l.to_string()
        };
        out.push(strip_inline(&l));
    }
    out
}

/// Removes wikilink brackets (keeping the alias), Markdown links (keeping the text), HTML tags and
/// emphasis markers.
fn strip_inline(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("[[") {
        out.push_str(&rest[..i]);
        if out.ends_with('!') {
            out.pop();
        }
        let after = &rest[i + 2..];
        match after.find("]]") {
            Some(j) => {
                let inner = &after[..j];
                out.push_str(inner.split_once('|').map_or(inner, |(_, alias)| alias));
                rest = &after[j + 2..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    let out = strip_tags(&out.replace("~~", ""));
    // [text](url) → text
    let mut s = String::new();
    let mut chars = out.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' | '_' | '`' => {}
            ']' if chars.peek() == Some(&'(') => {
                for n in chars.by_ref() {
                    if n == ')' {
                        break;
                    }
                }
            }
            '[' => {}
            _ => s.push(c),
        }
    }
    s.trim().to_string()
}

/// HTML tags people write in notes are removed; other `<words>` (like `<hash>`) are kept.
fn strip_tags(s: &str) -> String {
    const TAGS: &[&str] = &[
        "a", "b", "br", "code", "div", "em", "font", "i", "kbd", "mark", "p", "s", "small", "span",
        "strong", "sub", "sup", "u",
    ];
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let name: String = after
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        match after.find('>') {
            Some(j) if TAGS.contains(&name.to_lowercase().as_str()) => rest = &after[j + 1..],
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out + rest
}

/// Word-wraps to roughly `width` pixels (about 7.2 px per character at 14 px).
fn wrap(lines: &[String], width: f64) -> Vec<String> {
    let max = ((width / 7.2).floor() as usize).max(4);
    let mut out = Vec::new();
    for line in lines {
        if line.chars().count() <= max {
            out.push(line.clone());
            continue;
        }
        let mut cur = String::new();
        for word in line.split(' ') {
            if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > max {
                out.push(std::mem::take(&mut cur));
            }
            if !cur.is_empty() {
                cur.push(' ');
            }
            cur.push_str(word);
        }
        if !cur.is_empty() {
            out.push(cur);
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn text_block(
    lines: &[String],
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    fg: &str,
    centred: bool,
    bold_first: bool,
) -> String {
    let fit = (((h - 8.0) / LINE).floor() as usize).max(1);
    let wrapped = wrap(lines, w - 16.0);
    let n = wrapped.len();
    let shown: Vec<&String> = wrapped
        .iter()
        .enumerate()
        .filter(|(i, l)| !l.is_empty() || (*i > 0 && *i + 1 < n))
        .map(|(_, l)| l)
        .take(fit)
        .collect();
    let top = if centred {
        y + h / 2.0 - shown.len() as f64 * LINE / 2.0 + LINE * 0.72
    } else {
        y + 8.0 + LINE * 0.72
    };
    let (tx, anchor) = if centred {
        (x + w / 2.0, " text-anchor=\"middle\"")
    } else {
        (x + 10.0, "")
    };
    let mut out = String::new();
    for (i, l) in shown.iter().enumerate() {
        let weight = if bold_first && i == 0 {
            " font-weight=\"600\""
        } else {
            ""
        };
        let _ = write!(
            out,
            r#"<text x="{tx:.1}" y="{:.1}"{anchor} font-size="{FONT}" fill="{fg}"{weight}>{}</text>"#,
            top + i as f64 * LINE,
            esc(l)
        );
    }
    out
}

fn num(n: &Value, key: &str) -> f64 {
    n.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn str_of<'a>(n: &'a Value, key: &str) -> Option<&'a str> {
    n.get(key).and_then(Value::as_str)
}

struct Node<'a> {
    v: &'a Value,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl<'a> Node<'a> {
    fn new(v: &'a Value) -> Self {
        Node {
            v,
            x: num(v, "x"),
            y: num(v, "y"),
            w: num(v, "width"),
            h: num(v, "height"),
        }
    }
    fn shape(&self) -> Option<(&'a str, &'a Value)> {
        let name = str_of(self.v, "shape")?;
        Some((name, FORMAT["shapes"].get(name)?.get("draw")?))
    }
    fn behind(&self) -> bool {
        str_of(self.v, "type") == Some("group")
            || self.shape().is_some_and(|(_, d)| d["behind"] == true)
    }
}

/// A card's icon centred near the top, and the height it takes.
fn icon_svg(n: &Node, color: &str) -> (String, f64) {
    let Some(inner) = str_of(n.v, "icon")
        .and_then(|i| FORMAT["icons"].get(i))
        .and_then(Value::as_str)
    else {
        return (String::new(), 0.0);
    };
    (
        format!(
            r#"<svg x="{}" y="{}" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">{inner}</svg>"#,
            n.x + n.w / 2.0 - 17.0,
            n.y + 10.0
        ),
        48.0,
    )
}

fn shape_svg(n: &Node, name: &str, draw: &Value, t: &Theme) -> String {
    let (x, y, w, h) = (n.x, n.y, n.w, n.h);
    let color = color_of(str_of(n.v, "color"));
    let border = str_of(n.v, "border");
    let stroke = if border == Some("none") {
        "transparent".to_string()
    } else {
        color.clone().unwrap_or_else(|| t.stroke.into())
    };
    let fill = color
        .as_ref()
        .map_or_else(|| t.bg.to_string(), |c| format!("{c}24"));
    let da = dash(border, 2.0)
        .map(|d| format!(r#" stroke-dasharray="{d}""#))
        .unwrap_or_default();
    let sw = format!(r#"stroke="{stroke}" stroke-width="2"{da}"#);
    let mut body = String::new();
    match draw.get("special").and_then(Value::as_str) {
        Some("final") => {
            let r = w.min(h) / 2.0;
            let (cx, cy) = (x + w / 2.0, y + h / 2.0);
            let _ = write!(
                body,
                r#"<circle cx="{cx}" cy="{cy}" r="{}" fill="{}" {sw}/><circle cx="{cx}" cy="{cy}" r="{}" fill="{stroke}"/>"#,
                r - 1.0,
                t.bg,
                r * 0.58
            );
        }
        Some("actor") => {
            let s = (w / 40.0).min(h * 0.72 / 64.0);
            let _ = write!(
                body,
                r#"<g transform="translate({},{y}) scale({s})" fill="none" stroke="{stroke}" stroke-width="{}" stroke-linecap="round"><circle cx="20" cy="10" r="8" fill="{fill}"/><path d="M20,18 L20,42 M6,28 L34,28 M20,42 L8,62 M20,42 L32,62"/></g>"#,
                x + w / 2.0 - 20.0 * s,
                2.5 / s
            );
        }
        Some("timing") => {
            let _ = write!(
                body,
                r#"<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" {sw}/>"#
            );
        }
        Some("lifeline") => {
            let _ = write!(
                body,
                r#"<rect x="{x}" y="{y}" width="{w}" height="44" fill="{fill}" {sw}/><line x1="{cx}" y1="{}" x2="{cx}" y2="{}" stroke="{stroke}" stroke-width="1.5" stroke-dasharray="6 5"/>"#,
                y + 44.0,
                y + h,
                cx = x + w / 2.0
            );
        }
        _ => {
            let solid = draw["solid"] == true;
            let f = if solid {
                stroke.clone()
            } else if draw["hollow"] == true {
                "none".into()
            } else {
                fill.clone()
            };
            if draw["ellipse"] == true {
                let _ = write!(
                    body,
                    r#"<ellipse cx="{}" cy="{}" rx="{}" ry="{}" fill="{f}" {sw}/>"#,
                    x + w / 2.0,
                    y + h / 2.0,
                    w / 2.0,
                    h / 2.0
                );
            } else if let Some(r) = draw.get("rect") {
                let r = if r == "pill" {
                    h / 2.0
                } else {
                    r.as_f64().unwrap_or(0.0)
                };
                let _ = write!(
                    body,
                    r#"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{f}" {sw}/>"#
                );
            } else if let Some(path) = draw.get("path").and_then(Value::as_str) {
                let _ = write!(
                    body,
                    r#"<g transform="translate({x},{y}) scale({},{})"><path d="{path}" fill="{fill}" {sw} vector-effect="non-scaling-stroke"/>"#,
                    w / 100.0,
                    h / 100.0
                );
                if let Some(extra) = draw.get("extra").and_then(Value::as_str) {
                    let _ = write!(
                        body,
                        r#"<path d="{extra}" fill="none" {sw} vector-effect="non-scaling-stroke"/>"#
                    );
                }
                body.push_str("</g>");
            }
            if let Some(decor) = draw.get("decor").and_then(Value::as_str) {
                let _ = write!(
                    body,
                    r#"<g transform="translate({},{})" fill="{fill}" stroke="{stroke}" stroke-width="1.4">{decor}</g>"#,
                    x + w - 26.0,
                    y + 6.0
                );
            }
        }
    }
    if draw["label"] == false {
        return body;
    }
    let text = str_of(n.v, "text").unwrap_or("");
    if draw.get("special").and_then(Value::as_str) == Some("timing") {
        let c = crate::timing::Colors {
            stroke: color.as_deref().unwrap_or(t.fg),
            fg: t.fg,
            muted: t.muted,
            grid: t.card,
        };
        return body + &crate::timing::svg(text, x, y, w, h, &c);
    }
    let lines = plain_lines(text);
    let fg = t.fg;
    let (icon, icon_h) = icon_svg(n, color.as_deref().unwrap_or(t.fg));
    if !icon.is_empty() {
        return body + &icon + &text_block(&lines, x, y + icon_h, w, h - icon_h, fg, true, false);
    }
    if draw["compartments"] == true {
        // Name (centred, bold), then members, divided by lines.
        let parts: Vec<Vec<String>> = split_compartments(text)
            .iter()
            .map(|p| plain_lines(p.trim()))
            .collect();
        let mut cy = y;
        for (i, p) in parts.iter().enumerate() {
            let len = p.len() as f64;
            let ph = if i == 0 {
                (len * LINE + 12.0).max(34.0)
            } else if i + 1 == parts.len() {
                y + h - cy
            } else {
                (len * LINE + 10.0).max(LINE + 10.0)
            };
            if i > 0 {
                let _ = write!(
                    body,
                    r#"<line x1="{x}" y1="{cy}" x2="{}" y2="{cy}" stroke="{stroke}" stroke-width="2"/>"#,
                    x + w
                );
            }
            body += &text_block(p, x, cy, w, ph, fg, i == 0, i == 0);
            cy += ph;
        }
        return body;
    }
    if draw["behind"] == true {
        let label = lines
            .iter()
            .filter(|l| !l.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        let tw = (w * 0.8).min(label.chars().count() as f64 * 7.4 + 28.0);
        let _ = write!(
            body,
            r#"<path d="M{x},{y} H{} V{} L{},{} H{x} Z" fill="{}" stroke="{stroke}" stroke-width="2"/><text x="{}" y="{}" font-size="13" font-weight="600" fill="{fg}">{}</text>"#,
            x + tw,
            y + 16.0,
            x + tw - 10.0,
            y + 26.0,
            t.bg,
            x + 8.0,
            y + 18.0,
            esc(&label)
        );
        return body;
    }
    match draw.get("special").and_then(Value::as_str) {
        Some("lifeline") => body + &text_block(&lines, x, y, w, 44.0, fg, true, false),
        Some("actor") => body + &text_block(&lines, x, y + h * 0.72, w, h * 0.28, fg, true, false),
        _ => {
            let inset = draw.get("inset").and_then(Value::as_f64).unwrap_or(0.0);
            let _ = name;
            body + &text_block(
                &lines,
                x + w * inset,
                y,
                w * (1.0 - 2.0 * inset),
                h,
                fg,
                true,
                false,
            )
        }
    }
}

fn split_compartments(text: &str) -> Vec<String> {
    let mut parts = vec![String::new()];
    for line in text.lines() {
        let t = line.trim();
        if t.len() >= 3 && t.chars().all(|c| c == '-') {
            parts.push(String::new());
        } else {
            let last = parts.last_mut().expect("at least one part");
            if !last.is_empty() {
                last.push('\n');
            }
            last.push_str(line);
        }
    }
    parts
}

fn card_svg(n: &Node, t: &Theme) -> String {
    let (x, y, w, h) = (n.x, n.y, n.w, n.h);
    let color = color_of(str_of(n.v, "color"));
    let frame = format!(
        r#"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{}" stroke="{}" stroke-width="2"/>"#,
        color
            .as_ref()
            .map_or_else(|| t.bg.to_string(), |c| format!("{c}14")),
        color.clone().unwrap_or_else(|| t.card.into())
    );
    match str_of(n.v, "type") {
        Some("file") => {
            let file = str_of(n.v, "file").unwrap_or("");
            let name = file.rsplit('/').next().unwrap_or(file);
            let name = name.strip_suffix(".md").unwrap_or(name);
            format!(
                r#"{frame}<text x="{}" y="{}" font-size="13" font-weight="600" fill="{}">{}</text><text x="{}" y="{}" font-size="12" fill="{}">{}</text>"#,
                x + 10.0,
                y + 22.0,
                t.fg,
                esc(name),
                x + 10.0,
                y + 42.0,
                t.muted,
                esc(file)
            )
        }
        Some("link") => {
            frame
                + &text_block(
                    &[str_of(n.v, "url").unwrap_or("").to_string()],
                    x,
                    y,
                    w,
                    h,
                    t.muted,
                    true,
                    false,
                )
        }
        _ => {
            let text = str_of(n.v, "text").unwrap_or("");
            let heading = text.trim_start().starts_with('#');
            let (icon, icon_h) = icon_svg(n, color.as_deref().unwrap_or(t.fg));
            frame
                + &icon
                + &text_block(
                    &plain_lines(text),
                    x,
                    y + icon_h,
                    w,
                    h - icon_h,
                    t.fg,
                    false,
                    heading,
                )
        }
    }
}

fn group_svg(n: &Node, t: &Theme) -> String {
    let color = color_of(str_of(n.v, "color"));
    let stroke = color.clone().unwrap_or_else(|| t.stroke.into());
    let mut out = format!(
        r#"<rect x="{}" y="{}" width="{}" height="{}" rx="12" fill="{}" stroke="{stroke}" stroke-width="2" stroke-dasharray="6 4"/>"#,
        n.x,
        n.y,
        n.w,
        n.h,
        color
            .as_ref()
            .map_or_else(|| "none".to_string(), |c| format!("{c}14"))
    );
    if let Some(label) = str_of(n.v, "label").filter(|l| !l.is_empty()) {
        let _ = write!(
            out,
            r#"<text x="{}" y="{}" font-size="14" font-weight="600" fill="{stroke}">{}</text>"#,
            n.x + 4.0,
            n.y - 8.0,
            esc(label)
        );
    }
    out
}

/// A point on a side (lifelines: on their line), and the side's outward direction.
fn anchor(n: &Node, side: &str, offset: f64) -> (f64, f64, f64, f64) {
    let lifeline = str_of(n.v, "shape") == Some("lifeline");
    match side {
        "top" => (n.x + n.w * offset, n.y, 0.0, -1.0),
        "bottom" => (n.x + n.w * offset, n.y + n.h, 0.0, 1.0),
        "left" => (
            if lifeline { n.x + n.w / 2.0 } else { n.x },
            n.y + n.h * offset,
            -1.0,
            0.0,
        ),
        _ => (
            if lifeline { n.x + n.w / 2.0 } else { n.x + n.w },
            n.y + n.h * offset,
            1.0,
            0.0,
        ),
    }
}

fn best_sides(a: &Node, b: &Node) -> (&'static str, &'static str) {
    let dx = b.x + b.w / 2.0 - (a.x + a.w / 2.0);
    let dy = b.y + b.h / 2.0 - (a.y + a.h / 2.0);
    if dx.abs() > dy.abs() {
        if dx > 0.0 {
            ("right", "left")
        } else {
            ("left", "right")
        }
    } else if dy > 0.0 {
        ("bottom", "top")
    } else {
        ("top", "bottom")
    }
}

fn marker_def(end: &str, color: &str, id: &str, bg: &str) -> String {
    let shape = match end {
        "arrow" => format!(r#"<path d="M2,3 L18,10 L2,17 Z" fill="{color}"/>"#),
        "triangle" => format!(
            r#"<path d="M2,3 L18,10 L2,17 Z" fill="{bg}" stroke="{color}" stroke-width="1.6" stroke-linejoin="round"/>"#
        ),
        "open" => format!(
            r#"<path d="M3,3 L18,10 L3,17" fill="none" stroke="{color}" stroke-width="1.8" stroke-linejoin="round"/>"#
        ),
        "diamond" => format!(r#"<path d="M1,10 L10,4 L19,10 L10,16 Z" fill="{color}"/>"#),
        "diamond-open" => format!(
            r#"<path d="M1,10 L10,4 L19,10 L10,16 Z" fill="{bg}" stroke="{color}" stroke-width="1.6" stroke-linejoin="round"/>"#
        ),
        "circle" => format!(
            r#"<circle cx="11" cy="10" r="6" fill="{bg}" stroke="{color}" stroke-width="1.6"/>"#
        ),
        _ => String::new(),
    };
    let ref_x = match end {
        "diamond" | "diamond-open" => 19,
        "circle" => 17,
        _ => 18,
    };
    format!(
        r#"<marker id="{id}" viewBox="0 0 20 20" refX="{ref_x}" refY="10" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">{shape}</marker>"#
    )
}

fn edge_svg(
    e: &Value,
    nodes: &BTreeMap<&str, Node>,
    t: &Theme,
    markers: &mut BTreeMap<String, String>,
    obstacles: &[crate::route::Rect],
) -> String {
    let (Some(a), Some(b)) = (
        str_of(e, "fromNode").and_then(|id| nodes.get(id)),
        str_of(e, "toNode").and_then(|id| nodes.get(id)),
    ) else {
        return String::new();
    };
    let (fs, ts) = best_sides(a, b);
    let (px, py, pdx, pdy) = anchor(
        a,
        str_of(e, "fromSide").unwrap_or(fs),
        e.get("fromOffset").and_then(Value::as_f64).unwrap_or(0.5),
    );
    let (qx, qy, qdx, qdy) = anchor(
        b,
        str_of(e, "toSide").unwrap_or(ts),
        e.get("toOffset").and_then(Value::as_f64).unwrap_or(0.5),
    );
    let d = ((qx - px).hypot(qy - py) * 0.3).max(24.0);
    let (c1x, c1y, c2x, c2y) = (px + pdx * d, py + pdy * d, qx + qdx * d, qy + qdy * d);
    let color = color_of(str_of(e, "color")).unwrap_or_else(|| t.stroke.into());
    let width = e.get("thickness").and_then(Value::as_f64).unwrap_or(2.0);
    fn known(s: Option<&str>) -> Option<&str> {
        s.filter(|s| {
            FORMAT["ends"]
                .as_object()
                .is_some_and(|m| m.contains_key(*s))
        })
    }
    let to_end = known(str_of(e, "toEnd")).unwrap_or("arrow");
    let from_end = known(str_of(e, "fromEnd")).unwrap_or("none");
    let mut marker = |end: &str| -> String {
        if end == "none" {
            return String::new();
        }
        let id = format!("m-{end}-{}", color.trim_start_matches('#'));
        markers
            .entry(id.clone())
            .or_insert_with(|| marker_def(end, &color, &id, t.bg));
        format!("url(#{id})")
    };
    let ms = marker(from_end);
    let me = marker(to_end);
    // Curved (default), straight, or around the other cards.
    let (path_d, (mx, my)) = match str_of(e, "route") {
        Some("straight") => (
            format!("M{px},{py} L{qx},{qy}"),
            ((px + qx) / 2.0, (py + qy) / 2.0),
        ),
        Some("orthogonal") => {
            let pts =
                crate::route::route_around((px, py), (pdx, pdy), (qx, qy), (qdx, qdy), obstacles);
            (
                crate::route::rounded_path(&pts, 8.0),
                crate::route::midpoint(&pts),
            )
        }
        _ => (
            format!("M{px},{py} C{c1x},{c1y} {c2x},{c2y} {qx},{qy}"),
            (
                (px + 3.0 * c1x + 3.0 * c2x + qx) / 8.0,
                (py + 3.0 * c1y + 3.0 * c2y + qy) / 8.0,
            ),
        ),
    };
    let mut out =
        format!(r#"<path d="{path_d}" fill="none" stroke="{color}" stroke-width="{width}""#);
    if let Some(da) = dash(str_of(e, "line"), width) {
        let _ = write!(out, r#" stroke-dasharray="{da}""#);
    }
    if !ms.is_empty() {
        let _ = write!(out, r#" marker-start="{ms}""#);
    }
    if !me.is_empty() {
        let _ = write!(out, r#" marker-end="{me}""#);
    }
    out.push_str("/>");
    let label = |text: &str, x: f64, y: f64, size: f64, fill: &str| {
        let w = text.chars().count() as f64 * size * 0.56 + 10.0;
        format!(
            r#"<rect x="{}" y="{}" width="{w}" height="{}" rx="4" fill="{}"/><text x="{x}" y="{}" text-anchor="middle" font-size="{size}" fill="{fill}">{}</text>"#,
            x - w / 2.0,
            y - size * 0.8,
            size * 1.5,
            t.bg,
            y + size * 0.35,
            esc(text)
        )
    };
    if let Some(l) = str_of(e, "label").filter(|l| !l.is_empty()) {
        out += &label(l, mx, my, 13.0, t.fg);
    }
    let near = |x: f64, y: f64, dx: f64, dy: f64, beside: f64| {
        if dx != 0.0 {
            (x + dx * 20.0, y + beside)
        } else {
            (x + beside * 1.6, y + dy * 20.0)
        }
    };
    if let Some(l) = str_of(e, "fromLabel").filter(|l| !l.is_empty()) {
        let (x, y) = near(px, py, pdx, pdy, -12.0);
        out += &label(l, x, y, 12.0, t.muted);
    }
    if let Some(l) = str_of(e, "toLabel").filter(|l| !l.is_empty()) {
        let (x, y) = near(qx, qy, qdx, qdy, 12.0);
        out += &label(l, x, y, 12.0, t.muted);
    }
    out
}

/// Draws a JSON Canvas document as a standalone SVG (light or dark theme).
pub fn canvas_to_svg(canvas_json: &str, dark: bool) -> Result<String> {
    let doc: Value = serde_json::from_str(canvas_json)
        .map_err(|e| Error::Invalid(format!("invalid JSON ({e})")))?;
    let t = if dark { &DARK } else { &LIGHT };
    let empty = Vec::new();
    let raw_nodes = doc.get("nodes").and_then(Value::as_array).unwrap_or(&empty);
    let raw_edges = doc.get("edges").and_then(Value::as_array).unwrap_or(&empty);
    if raw_nodes.is_empty() {
        return Ok(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60" font-family="{FONT_FAMILY}"><rect width="200" height="60" fill="{}"/><text x="100" y="35" text-anchor="middle" font-size="13" fill="{}">Empty diagram</text></svg>"#,
            t.bg, t.muted
        ));
    }
    let list: Vec<Node> = raw_nodes.iter().map(Node::new).collect();
    let min_x = list.iter().map(|n| n.x).fold(f64::INFINITY, f64::min) - PAD;
    let min_y = list.iter().map(|n| n.y).fold(f64::INFINITY, f64::min) - PAD;
    let max_x = list
        .iter()
        .map(|n| n.x + n.w)
        .fold(f64::NEG_INFINITY, f64::max)
        + PAD;
    let max_y = list
        .iter()
        .map(|n| n.y + n.h)
        .fold(f64::NEG_INFINITY, f64::max)
        + PAD;
    let (w, h) = (max_x - min_x, max_y - min_y);
    let by_id: BTreeMap<&str, Node> = raw_nodes
        .iter()
        .filter_map(|v| Some((str_of(v, "id")?, Node::new(v))))
        .collect();
    let mut markers = BTreeMap::new();
    let mut parts = String::new();
    for n in list.iter().filter(|n| n.behind()) {
        if str_of(n.v, "type") == Some("group") {
            parts += &group_svg(n, t);
        } else if let Some((name, draw)) = n.shape() {
            parts += &shape_svg(n, name, draw, t);
        }
    }
    // Cards a routed connection steps around (not groups and frames, which connections cross).
    let obstacles: Vec<crate::route::Rect> = list
        .iter()
        .filter(|n| !n.behind())
        .map(|n| (n.x, n.y, n.w, n.h))
        .collect();
    for e in raw_edges {
        parts += &edge_svg(e, &by_id, t, &mut markers, &obstacles);
    }
    for n in list.iter().filter(|n| !n.behind()) {
        match (str_of(n.v, "type"), n.shape()) {
            (Some("text"), Some((name, draw))) => parts += &shape_svg(n, name, draw, t),
            _ => parts += &card_svg(n, t),
        }
    }
    Ok(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{min_x} {min_y} {w} {h}" font-family="{FONT_FAMILY}"><defs>{}</defs><rect x="{min_x}" y="{min_y}" width="{w}" height="{h}" fill="{}"/>{parts}</svg>"#,
        markers.values().cloned().collect::<String>(),
        t.bg
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_lose_markdown_but_keep_their_words() {
        assert_eq!(
            plain_lines("# Title\n**bold** and [[Note|alias]]\n- item <b>x</b>"),
            ["Title", "bold and alias", "• item x"]
        );
        assert_eq!(plain_lines("a [link](http://x) b"), ["a link b"]);
        assert_eq!(
            plain_lines("`~/Library/Caches/mosaic/<hash>/` and ~~old~~"),
            ["~/Library/Caches/mosaic/<hash>/ and old"]
        );
    }

    #[test]
    fn draws_shapes_connections_and_escaped_labels() {
        let doc = r#"{"nodes":[
            {"id":"g","type":"group","x":-20,"y":-20,"width":500,"height":200,"label":"Team"},
            {"id":"a","type":"text","x":0,"y":0,"width":160,"height":80,"text":"A < B & C","shape":"diamond"},
            {"id":"b","type":"text","x":300,"y":0,"width":160,"height":80,"text":"DB","shape":"cylinder","icon":"database"}],
            "edges":[{"id":"e","fromNode":"a","toNode":"b","toEnd":"triangle","label":"uses","line":"dashed"}]}"#;
        let svg = canvas_to_svg(doc, false).unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("A &lt; B &amp; C"));
        assert!(svg.contains(r#"marker-end="url(#m-triangle-8a8f9c)""#));
        assert!(svg.contains("stroke-dasharray"));
        assert!(svg.contains(">Team<") && svg.contains(">uses<"));
        assert!(
            svg.contains(r#"viewBox="0 0 24 24""#),
            "the database icon is drawn"
        );
        assert!(svg.contains(r#"viewBox="-60 -60 580 280""#));
    }

    #[test]
    fn every_template_renders() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../ui/src/diagrams/templates");
        let uml = std::fs::read_dir(dir.join("uml")).unwrap();
        for e in std::fs::read_dir(&dir).unwrap().chain(uml) {
            let path = e.unwrap().path();
            if path.is_file() {
                let svg = canvas_to_svg(&std::fs::read_to_string(&path).unwrap(), false).unwrap();
                assert!(svg.ends_with("</svg>"), "{}", path.display());
            }
        }
    }
}
