//! Routes a connection around other cards: an orthogonal path found by A* on a coarse grid, preferring
//! few turns. Mirrors `ui/src/diagrams/route.ts` (same steps, margins and costs), so the agents'
//! `render` tool draws routed connections like the editor.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

pub type Pt = (f64, f64);
/// x, y, width, height.
pub type Rect = (f64, f64, f64, f64);

const STEP: f64 = 10.0;
const MARGIN: f64 = 12.0;
const STUB: f64 = 18.0;
const TURN_COST: i64 = 6;
const MAX_VISITS: usize = 40_000;
const DIRS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Points of an orthogonal path from `a` (leaving in direction `da`) to `b` (arriving from `db`)
/// that avoids `obstacles`; a simple elbow when no path is found quickly.
pub fn route_around(a: Pt, da: Pt, b: Pt, db: Pt, obstacles: &[Rect]) -> Vec<Pt> {
    let s = (a.0 + da.0 * STUB, a.1 + da.1 * STUB);
    let e = (b.0 + db.0 * STUB, b.1 + db.1 * STUB);
    let blocked: Vec<(f64, f64, f64, f64)> = obstacles
        .iter()
        .map(|&(x, y, w, h)| (x - MARGIN, y - MARGIN, x + w + MARGIN, y + h + MARGIN))
        .collect();
    let xs = [s.0, e.0]
        .into_iter()
        .chain(blocked.iter().flat_map(|o| [o.0, o.2]));
    let ys = [s.1, e.1]
        .into_iter()
        .chain(blocked.iter().flat_map(|o| [o.1, o.3]));
    let (min_x, max_x) = xs.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
        (lo.min(v), hi.max(v))
    });
    let (min_y, max_y) = ys.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
        (lo.min(v), hi.max(v))
    });
    let (min_x, min_y) = (min_x - 60.0, min_y - 60.0);
    let cols = ((max_x + 60.0 - min_x) / STEP).ceil() as i64 + 1;
    let rows = ((max_y + 60.0 - min_y) / STEP).ceil() as i64 + 1;
    let cell = |p: Pt| {
        (
            ((p.0 - min_x) / STEP).round() as i64,
            ((p.1 - min_y) / STEP).round() as i64,
        )
    };
    let free = |c: i64, r: i64| {
        let (x, y) = (min_x + c as f64 * STEP, min_y + r as f64 * STEP);
        c >= 0
            && r >= 0
            && c < cols
            && r < rows
            && !blocked
                .iter()
                .any(|o| x > o.0 && x < o.2 && y > o.1 && y < o.3)
    };
    let (start, goal) = (cell(s), cell(e));
    let key = |c: i64, r: i64, d: usize| ((r * cols + c) * 4) as usize + d;
    let h = |c: i64, r: i64| (c - goal.0).abs() + (r - goal.1).abs();
    let sd = DIRS
        .iter()
        .position(|&(dx, dy)| dx as f64 == da.0.signum() && dy as f64 == da.1.signum())
        .unwrap_or(0);
    let mut best: HashMap<usize, i64> = HashMap::new();
    let mut prev: HashMap<usize, usize> = HashMap::new();
    let mut open = BinaryHeap::new();
    let sk = key(start.0, start.1, sd);
    best.insert(sk, 0);
    open.push(Reverse((h(start.0, start.1), 0i64, start.0, start.1, sd)));
    let mut found = None;
    let mut visits = 0;
    while let Some(Reverse((_, g, c, r, d))) = open.pop() {
        visits += 1;
        if visits > MAX_VISITS {
            break;
        }
        if (c, r) == goal {
            found = Some(key(c, r, d));
            break;
        }
        if g > *best.get(&key(c, r, d)).unwrap_or(&i64::MAX) {
            continue;
        }
        for (nd, &(dx, dy)) in DIRS.iter().enumerate() {
            let (nc, nr) = (c + dx, r + dy);
            if !free(nc, nr) && (nc, nr) != goal {
                continue;
            }
            let ng = g + 1 + if nd == d { 0 } else { TURN_COST };
            let k = key(nc, nr, nd);
            if ng < *best.get(&k).unwrap_or(&i64::MAX) {
                best.insert(k, ng);
                prev.insert(k, key(c, r, d));
                open.push(Reverse((ng + h(nc, nr), ng, nc, nr, nd)));
            }
        }
    }
    let Some(mut k) = found else {
        return simplify(&[a, s, (e.0, s.1), e, b]);
    };
    let mut cells = Vec::new();
    loop {
        let idx = (k / 4) as i64;
        cells.push((
            min_x + (idx % cols) as f64 * STEP,
            min_y + (idx / cols) as f64 * STEP,
        ));
        match prev.get(&k) {
            Some(&p) => k = p,
            None => break,
        }
    }
    cells.reverse();
    // Move the first and last straight runs onto the exact stub points (off the grid), so the path
    // meets the cards squarely without a small jog.
    let last = cells.len() - 1;
    snap_run(&mut cells, 0, 1, s);
    snap_run(&mut cells, last, -1, e);
    let mut pts = vec![a];
    pts.extend(square_up(&cells));
    pts.push(b);
    simplify(&pts)
}

fn snap_run(cells: &mut [Pt], from: usize, step: isize, p: Pt) {
    let g = cells[from];
    if let Some(&next) = from.checked_add_signed(step).and_then(|i| cells.get(i)) {
        let horizontal = next.1 == g.1;
        let mut i = from as isize;
        while i >= 0 && (i as usize) < cells.len() {
            let c = &mut cells[i as usize];
            if (horizontal && c.1 != g.1) || (!horizontal && c.0 != g.0) {
                break;
            }
            if horizontal {
                c.1 = p.1;
            } else {
                c.0 = p.0;
            }
            i += step;
        }
    }
    cells[from] = p;
}

/// Grid snapping can leave a slightly diagonal first or last segment: make it orthogonal.
fn square_up(pts: &[Pt]) -> Vec<Pt> {
    let mut out = vec![pts[0]];
    for &q in &pts[1..] {
        let p = *out.last().expect("not empty");
        if p.0 != q.0 && p.1 != q.1 {
            out.push((q.0, p.1));
        }
        out.push(q);
    }
    out
}

/// Drops repeated points and points in the middle of a straight run.
pub fn simplify(pts: &[Pt]) -> Vec<Pt> {
    let mut out: Vec<Pt> = Vec::new();
    for &p in pts {
        if out.last() == Some(&p) {
            continue;
        }
        if out.len() >= 2 {
            let (a, b) = (out[out.len() - 2], out[out.len() - 1]);
            if (a.0 == b.0 && b.0 == p.0) || (a.1 == b.1 && b.1 == p.1) {
                out.pop();
            }
        }
        out.push(p);
    }
    out
}

/// An SVG path through `pts` with rounded corners.
pub fn rounded_path(pts: &[Pt], radius: f64) -> String {
    if pts.len() < 2 {
        return String::new();
    }
    let mut d = format!("M{},{}", pts[0].0, pts[0].1);
    for i in 1..pts.len() - 1 {
        let (p, c, n) = (pts[i - 1], pts[i], pts[i + 1]);
        let r = radius
            .min((c.0 - p.0).hypot(c.1 - p.1) / 2.0)
            .min((n.0 - c.0).hypot(n.1 - c.1) / 2.0);
        let sign = |v: f64| {
            if v > 0.0 {
                1.0
            } else if v < 0.0 {
                -1.0
            } else {
                0.0
            }
        };
        let (in_x, in_y) = (c.0 - sign(c.0 - p.0) * r, c.1 - sign(c.1 - p.1) * r);
        let (out_x, out_y) = (c.0 + sign(n.0 - c.0) * r, c.1 + sign(n.1 - c.1) * r);
        d += &format!(" L{in_x},{in_y} Q{},{} {out_x},{out_y}", c.0, c.1);
    }
    let last = pts[pts.len() - 1];
    d + &format!(" L{},{}", last.0, last.1)
}

/// The point halfway along a polyline.
pub fn midpoint(pts: &[Pt]) -> Pt {
    let lengths: Vec<f64> = pts
        .windows(2)
        .map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1))
        .collect();
    let mut left = lengths.iter().sum::<f64>() / 2.0;
    for (i, &len) in lengths.iter().enumerate() {
        if left <= len {
            let t = if len > 0.0 { left / len } else { 0.0 };
            return (
                pts[i].0 + (pts[i + 1].0 - pts[i].0) * t,
                pts[i].1 + (pts[i + 1].1 - pts[i].1) * t,
            );
        }
        left -= len;
    }
    *pts.last().expect("not empty")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crosses(pts: &[Pt], (x, y, w, h): Rect) -> bool {
        pts.windows(2).any(|s| {
            (0..=20).any(|i| {
                let t = i as f64 / 20.0;
                let (px, py) = (
                    s[0].0 + (s[1].0 - s[0].0) * t,
                    s[0].1 + (s[1].1 - s[0].1) * t,
                );
                px > x && px < x + w && py > y && py < y + h
            })
        })
    }

    #[test]
    fn goes_around_a_card_in_the_way() {
        let wall = (150.0, -100.0, 100.0, 300.0);
        let pts = route_around((0.0, 50.0), (1.0, 0.0), (400.0, 50.0), (-1.0, 0.0), &[wall]);
        assert!(!crosses(&pts, wall), "{pts:?}");
        assert!(
            pts.windows(2).all(|w| w[0].0 == w[1].0 || w[0].1 == w[1].1),
            "orthogonal: {pts:?}"
        );
        assert_eq!((pts[0], *pts.last().unwrap()), ((0.0, 50.0), (400.0, 50.0)));
    }

    #[test]
    fn a_clear_line_stays_straight_and_helpers_match_the_ui() {
        assert_eq!(
            route_around((0.0, 0.0), (1.0, 0.0), (300.0, 0.0), (-1.0, 0.0), &[]),
            vec![(0.0, 0.0), (300.0, 0.0)]
        );
        assert_eq!(
            rounded_path(&[(0.0, 0.0), (20.0, 0.0), (20.0, 20.0)], 8.0),
            "M0,0 L12,0 Q20,0 20,8 L20,20"
        );
        assert_eq!(
            midpoint(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]),
            (10.0, 0.0)
        );
    }
}
