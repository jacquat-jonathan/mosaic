// UML timing diagrams: a `timing` shape's text lists lanes of states over a time axis, and this draws
// them as step lines (one level per state). Mirrored in crates/mosaic-core/src/timing.rs.
//
//   Door controller          ← a line that isn't a lane is the title
//   Door: Closed@0 Open@5 Closed@12
//   Alarm: Off@0 On@10 Off@15
//   time: 0..20 s            ← optional: axis range and unit

export interface Lane {
  name: string;
  /** In time order. */
  changes: { state: string; at: number }[];
}

export interface Timing {
  title: string;
  lanes: Lane[];
  start: number;
  end: number;
  unit: string;
}

const LANE = /^\s*([^:@]+?)\s*:\s*(.+@.+)$/;
const TIME = /^\s*time\s*:\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*(.*)$/i;

export function parseTiming(text: string): Timing {
  const lanes: Lane[] = [];
  const title: string[] = [];
  let range: [number, number] | null = null;
  let unit = "";
  for (const line of text.split("\n")) {
    const t = TIME.exec(line);
    if (t) {
      range = [Number(t[1]), Number(t[2])];
      unit = t[3].trim();
      continue;
    }
    const l = LANE.exec(line);
    if (l) {
      const changes = l[2]
        .trim()
        .split(/\s+/)
        .map((w) => /^(.*)@(-?[\d.]+)$/.exec(w))
        .filter((m): m is RegExpExecArray => !!m && m[1] !== "" && !Number.isNaN(Number(m[2])))
        .map((m) => ({ state: m[1].replace(/_/g, " "), at: Number(m[2]) }))
        .sort((a, b) => a.at - b.at);
      if (changes.length) lanes.push({ name: l[1].replace(/[*_`]/g, ""), changes });
      continue;
    }
    const plain = line.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
    if (plain) title.push(plain);
  }
  const times = lanes.flatMap((l) => l.changes.map((c) => c.at));
  const lo = times.length ? Math.min(...times) : 0;
  const hi = times.length ? Math.max(...times) : 10;
  const [start, end] = range && range[1] > range[0] ? range : [lo, hi + Math.max(1, (hi - lo) * 0.2)];
  return { title: title.join(" "), lanes, start, end, unit };
}

/** A round step giving about five ticks. */
export function tickStep(range: number): number {
  const raw = range / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999) ?? 10 * mag;
}

export interface TimingColors {
  stroke: string;
  fg: string;
  muted: string;
  grid: string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const num = (v: number) => String(Math.round(v * 1000) / 1000);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The diagram as SVG elements inside the box at x, y (w × h). */
export function timingSvg(text: string, x: number, y: number, w: number, h: number, c: TimingColors): string {
  const d = parseTiming(text);
  const out: string[] = [];
  let top = y + 8;
  if (d.title) {
    out.push(`<text x="${r1(x + 10)}" y="${r1(top + 13)}" font-size="13" font-weight="600" fill="${c.fg}">${esc(d.title)}</text>`);
    top += 24;
  }
  const axisH = 26;
  const labelW = Math.min(150, w * 0.3);
  const plotX = x + labelW;
  const plotW = Math.max(10, x + w - 14 - plotX);
  const bottom = y + h - axisH;
  const tx = (t: number) => plotX + ((Math.min(Math.max(t, d.start), d.end) - d.start) / (d.end - d.start)) * plotW;
  // Axis with ticks and faint guide lines.
  const step = tickStep(d.end - d.start);
  out.push(`<line x1="${r1(plotX)}" y1="${r1(bottom)}" x2="${r1(plotX + plotW)}" y2="${r1(bottom)}" stroke="${c.muted}" stroke-width="1"/>`);
  for (let k = Math.ceil(d.start / step - 1e-9); k <= Math.floor(d.end / step + 1e-9); k++) {
    const t = k * step;
    const px = r1(tx(t));
    out.push(`<line x1="${px}" y1="${r1(top)}" x2="${px}" y2="${r1(bottom + 4)}" stroke="${c.grid}" stroke-width="1" stroke-dasharray="3 4"/>`);
    out.push(`<text x="${px}" y="${r1(bottom + 18)}" text-anchor="middle" font-size="11" fill="${c.muted}">${esc(num(t) + (d.unit ? ` ${d.unit}` : ""))}</text>`);
  }
  const laneH = d.lanes.length ? (bottom - top) / d.lanes.length : 0;
  d.lanes.forEach((lane, i) => {
    const lt = top + i * laneH;
    if (i > 0) out.push(`<line x1="${r1(x)}" y1="${r1(lt)}" x2="${r1(x + w)}" y2="${r1(lt)}" stroke="${c.grid}" stroke-width="1"/>`);
    out.push(`<text x="${r1(x + 10)}" y="${r1(lt + 16)}" font-size="13" font-weight="600" fill="${c.fg}">${esc(lane.name)}</text>`);
    // One level per state, in order of first appearance, top to bottom.
    const states = [...new Set(lane.changes.map((ch) => ch.state))];
    const hi = lt + 26;
    const lo = lt + laneH - 10;
    const level = (s: string) => {
      const k = states.indexOf(s);
      return states.length === 1 ? (hi + lo) / 2 : hi + ((lo - hi) * k) / (states.length - 1);
    };
    for (const s of states) {
      out.push(`<text x="${r1(plotX - 8)}" y="${r1(level(s) + 4)}" text-anchor="end" font-size="11" fill="${c.muted}">${esc(s)}</text>`);
    }
    const pts: string[] = [];
    lane.changes.forEach((ch, k) => {
      const from = tx(ch.at);
      const to = k + 1 < lane.changes.length ? tx(lane.changes[k + 1].at) : plotX + plotW;
      const ly = level(ch.state);
      pts.push(`${pts.length ? "L" : "M"}${r1(from)},${r1(ly)}`, `L${r1(to)},${r1(ly)}`);
    });
    out.push(`<path d="${pts.join(" ")}" fill="none" stroke="${c.stroke}" stroke-width="2" stroke-linejoin="round"/>`);
  });
  if (!d.lanes.length) out.push(`<text x="${r1(x + w / 2)}" y="${r1((top + bottom) / 2)}" text-anchor="middle" font-size="12" fill="${c.muted}">Lane: State@0 Other@5</text>`);
  return out.join("");
}
