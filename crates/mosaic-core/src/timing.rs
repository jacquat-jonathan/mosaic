//! UML timing diagrams: a `timing` shape's text lists lanes of states over a time axis
//! (`Door: Closed@0 Open@5 Closed@12`, optional `time: 0..20 s`, other lines are the title), drawn as
//! step lines with one level per state. Mirrors `ui/src/diagrams/timing.ts`.

use regex::Regex;
use std::fmt::Write;
use std::sync::LazyLock;

static LANE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([^:@]+?)\s*:\s*(.+@.+)$").expect("valid"));
static TIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*time\s*:\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*(.*)$").expect("valid")
});
static CHANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*)@(-?[\d.]+)$").expect("valid"));
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*_`]").expect("valid"));

pub struct Lane {
    pub name: String,
    /// (state, time), in time order.
    pub changes: Vec<(String, f64)>,
}

pub struct Timing {
    pub title: String,
    pub lanes: Vec<Lane>,
    pub start: f64,
    pub end: f64,
    pub unit: String,
}

pub fn parse(text: &str) -> Timing {
    let mut lanes = Vec::new();
    let mut title: Vec<String> = Vec::new();
    let mut range = None;
    let mut unit = String::new();
    for line in text.split('\n') {
        if let Some(t) = TIME.captures(line) {
            range = Some((
                t[1].parse().unwrap_or(f64::NAN),
                t[2].parse().unwrap_or(f64::NAN),
            ));
            unit = t[3].trim().to_string();
            continue;
        }
        if let Some(l) = LANE.captures(line) {
            let mut changes: Vec<(String, f64)> = l[2]
                .split_whitespace()
                .filter_map(|w| {
                    let m = CHANGE.captures(w)?;
                    let at: f64 = m[2].parse().ok()?;
                    (!m[1].is_empty()).then(|| (m[1].replace('_', " "), at))
                })
                .collect();
            changes.sort_by(|a, b| a.1.total_cmp(&b.1));
            if !changes.is_empty() {
                lanes.push(Lane {
                    name: MARKS.replace_all(&l[1], "").into_owned(),
                    changes,
                });
            }
            continue;
        }
        let plain = MARKS
            .replace_all(line.trim_start_matches('#').trim_start(), "")
            .trim()
            .to_string();
        if !plain.is_empty() {
            title.push(plain);
        }
    }
    let times: Vec<f64> = lanes
        .iter()
        .flat_map(|l| l.changes.iter().map(|c| c.1))
        .collect();
    let lo = times.iter().copied().reduce(f64::min).unwrap_or(0.0);
    let hi = times.iter().copied().reduce(f64::max).unwrap_or(10.0);
    let (start, end) = match range {
        Some((a, b)) if b > a => (a, b),
        _ => (lo, hi + 1f64.max((hi - lo) * 0.2)),
    };
    Timing {
        title: title.join(" "),
        lanes,
        start,
        end,
        unit,
    }
}

/// A round step giving about five ticks.
pub fn tick_step(range: f64) -> f64 {
    let raw = range / 5.0;
    let mag = 10f64.powf(raw.log10().floor());
    [1.0, 2.0, 5.0, 10.0]
        .iter()
        .map(|m| m * mag)
        .find(|s| *s >= raw * 0.999)
        .unwrap_or(10.0 * mag)
}

pub struct Colors<'a> {
    pub stroke: &'a str,
    pub fg: &'a str,
    pub muted: &'a str,
    pub grid: &'a str,
}

fn r1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The diagram as SVG elements inside the box at x, y (w × h).
pub fn svg(text: &str, x: f64, y: f64, w: f64, h: f64, c: &Colors) -> String {
    let d = parse(text);
    let mut out = String::new();
    let mut top = y + 8.0;
    if !d.title.is_empty() {
        let _ = write!(
            out,
            r#"<text x="{}" y="{}" font-size="13" font-weight="600" fill="{}">{}</text>"#,
            r1(x + 10.0),
            r1(top + 13.0),
            c.fg,
            esc(&d.title)
        );
        top += 24.0;
    }
    let axis_h = 26.0;
    let label_w = 150f64.min(w * 0.3);
    let plot_x = x + label_w;
    let plot_w = 10f64.max(x + w - 14.0 - plot_x);
    let bottom = y + h - axis_h;
    let tx = |t: f64| plot_x + ((t.max(d.start).min(d.end) - d.start) / (d.end - d.start)) * plot_w;
    let step = tick_step(d.end - d.start);
    let _ = write!(
        out,
        r#"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="{}" stroke-width="1"/>"#,
        r1(plot_x),
        r1(bottom),
        r1(plot_x + plot_w),
        r1(bottom),
        c.muted
    );
    let first = (d.start / step - 1e-9).ceil() as i64;
    let last = (d.end / step + 1e-9).floor() as i64;
    for k in first..=last {
        let t = k as f64 * step;
        let px = r1(tx(t));
        let label = (t * 1000.0).round() / 1000.0;
        let unit = if d.unit.is_empty() {
            String::new()
        } else {
            format!(" {}", d.unit)
        };
        let _ = write!(
            out,
            r#"<line x1="{px}" y1="{}" x2="{px}" y2="{}" stroke="{}" stroke-width="1" stroke-dasharray="3 4"/><text x="{px}" y="{}" text-anchor="middle" font-size="11" fill="{}">{}</text>"#,
            r1(top),
            r1(bottom + 4.0),
            c.grid,
            r1(bottom + 18.0),
            c.muted,
            esc(&format!("{label}{unit}"))
        );
    }
    let lane_h = if d.lanes.is_empty() {
        0.0
    } else {
        (bottom - top) / d.lanes.len() as f64
    };
    for (i, lane) in d.lanes.iter().enumerate() {
        let lt = top + i as f64 * lane_h;
        if i > 0 {
            let _ = write!(
                out,
                r#"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="{}" stroke-width="1"/>"#,
                r1(x),
                r1(lt),
                r1(x + w),
                r1(lt),
                c.grid
            );
        }
        let _ = write!(
            out,
            r#"<text x="{}" y="{}" font-size="13" font-weight="600" fill="{}">{}</text>"#,
            r1(x + 10.0),
            r1(lt + 16.0),
            c.fg,
            esc(&lane.name)
        );
        // One level per state, in order of first appearance, top to bottom.
        let mut states: Vec<&str> = Vec::new();
        for (s, _) in &lane.changes {
            if !states.contains(&s.as_str()) {
                states.push(s);
            }
        }
        let (hi, lo) = (lt + 26.0, lt + lane_h - 10.0);
        let level = |s: &str| {
            let k = states.iter().position(|x| *x == s).unwrap_or(0) as f64;
            if states.len() == 1 {
                (hi + lo) / 2.0
            } else {
                hi + (lo - hi) * k / (states.len() - 1) as f64
            }
        };
        for s in &states {
            let _ = write!(
                out,
                r#"<text x="{}" y="{}" text-anchor="end" font-size="11" fill="{}">{}</text>"#,
                r1(plot_x - 8.0),
                r1(level(s) + 4.0),
                c.muted,
                esc(s)
            );
        }
        let mut pts: Vec<String> = Vec::new();
        for (k, (state, at)) in lane.changes.iter().enumerate() {
            let from = tx(*at);
            let to = lane.changes.get(k + 1).map_or(plot_x + plot_w, |n| tx(n.1));
            let ly = level(state);
            let m = if pts.is_empty() { "M" } else { "L" };
            pts.push(format!("{m}{},{}", r1(from), r1(ly)));
            pts.push(format!("L{},{}", r1(to), r1(ly)));
        }
        let _ = write!(
            out,
            r#"<path d="{}" fill="none" stroke="{}" stroke-width="2" stroke-linejoin="round"/>"#,
            pts.join(" "),
            c.stroke
        );
    }
    if d.lanes.is_empty() {
        let _ = write!(
            out,
            r#"<text x="{}" y="{}" text-anchor="middle" font-size="12" fill="{}">Lane: State@0 Other@5</text>"#,
            r1(x + w / 2.0),
            r1((top + bottom) / 2.0),
            c.muted
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "**Door controller**\nDoor: Closed@0 Open@5 Closed@12\nAlarm: Off@0 On@10 Off@15\ntime: 0..20 s";

    #[test]
    fn parses_lanes_title_and_axis() {
        let d = parse(TEXT);
        assert_eq!(d.title, "Door controller");
        assert_eq!(d.lanes.len(), 2);
        assert_eq!(d.lanes[0].changes[1], ("Open".to_string(), 5.0));
        assert_eq!((d.start, d.end, d.unit.as_str()), (0.0, 20.0, "s"));
        assert_eq!(parse("A: x@0 y@10").end, 12.0);
        assert_eq!(
            [tick_step(20.0), tick_step(1.0), tick_step(120.0)],
            [5.0, 0.2, 50.0]
        );
    }

    #[test]
    fn draws_like_the_editor() {
        let c = Colors {
            stroke: "#000",
            fg: "#111",
            muted: "#666",
            grid: "#ddd",
        };
        let s = svg(TEXT, 0.0, 0.0, 600.0, 300.0, &c);
        assert_eq!(s.matches("<path ").count(), 2);
        assert!(s.contains(">Door controller<") && s.contains(">20 s<"));
    }
}
