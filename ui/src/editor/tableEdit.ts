// Markdown (GFM) tables as a small model the table editor changes: cells, column alignment, rows and
// columns added or removed. Written back with aligned pipes so the source stays readable.

export type Align = "left" | "center" | "right" | null;

export interface TableModel {
  header: string[];
  align: Align[];
  rows: string[][];
}

/** Splits a GFM table row into trimmed cells, honouring escaped pipes. */
export function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < l.length; i++) {
    if (l[i] === "\\" && l[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (l[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += l[i];
  }
  out.push(cur.trim());
  return out;
}

const alignOf = (c: string): Align => {
  const s = c.trim();
  const l = s.startsWith(":");
  const r = s.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
};

export function parseTable(source: string): TableModel {
  const lines = source.split("\n").filter((l) => l.trim());
  const header = splitRow(lines[0] ?? "");
  const width = header.length;
  const fit = (cells: string[]) => [...cells.slice(0, width), ...Array(Math.max(0, width - cells.length)).fill("")];
  const rule = splitRow(lines[1] ?? "");
  return {
    header,
    align: header.map((_, i) => alignOf(rule[i] ?? "")),
    rows: lines.slice(2).map((l) => fit(splitRow(l))),
  };
}

/** A cell's text as Markdown: pipes escaped, line breaks turned into spaces. */
const cellSource = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

export function formatTable(t: TableModel): string {
  const cols = t.header.length;
  const all = [t.header, ...t.rows].map((r) => r.map(cellSource));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...all.map((r) => [...(r[c] ?? "")].length)));
  const pad = (s: string, c: number) => {
    const extra = widths[c] - [...s].length;
    if (t.align[c] === "right") return " ".repeat(extra) + s;
    if (t.align[c] === "center") return " ".repeat(Math.floor(extra / 2)) + s + " ".repeat(Math.ceil(extra / 2));
    return s + " ".repeat(extra);
  };
  const row = (r: string[]) => `| ${r.map((s, c) => pad(s, c)).join(" | ")} |`;
  const rule = widths.map((w, c) => {
    const a = t.align[c];
    const dashes = "-".repeat(w);
    if (a === "center") return `:${dashes.slice(2)}:`;
    if (a === "right") return `${dashes.slice(1)}:`;
    if (a === "left") return `:${dashes.slice(1)}`;
    return dashes;
  });
  return [row(all[0]), `| ${rule.join(" | ")} |`, ...all.slice(1).map(row)].join("\n");
}

const clone = (t: TableModel): TableModel => ({ header: [...t.header], align: [...t.align], rows: t.rows.map((r) => [...r]) });

/** Inserts an empty body row at `at` (0 = first body row). */
export function insertRow(t: TableModel, at: number): TableModel {
  const n = clone(t);
  n.rows.splice(Math.max(0, Math.min(at, n.rows.length)), 0, Array(n.header.length).fill(""));
  return n;
}

export function deleteRow(t: TableModel, at: number): TableModel {
  const n = clone(t);
  n.rows.splice(at, 1);
  return n;
}

/** Inserts an empty column at `at`. */
export function insertColumn(t: TableModel, at: number): TableModel {
  const n = clone(t);
  const i = Math.max(0, Math.min(at, n.header.length));
  n.header.splice(i, 0, "");
  n.align.splice(i, 0, null);
  n.rows.forEach((r) => r.splice(i, 0, ""));
  return n;
}

/** Removes a column; the last one stays (a table needs one). */
export function deleteColumn(t: TableModel, at: number): TableModel {
  if (t.header.length <= 1) return t;
  const n = clone(t);
  n.header.splice(at, 1);
  n.align.splice(at, 1);
  n.rows.forEach((r) => r.splice(at, 1));
  return n;
}

export function setAlign(t: TableModel, col: number, align: Align): TableModel {
  const n = clone(t);
  n.align[col] = align;
  return n;
}

/** Sets one cell; row -1 is the header. */
export function setCell(t: TableModel, row: number, col: number, text: string): TableModel {
  const n = clone(t);
  if (row < 0) n.header[col] = text;
  else n.rows[row][col] = text;
  return n;
}
