import { useMemo, useState } from "react";
import Papa from "papaparse";
import { Plus } from "lucide-react";
import { useWorkspace, type Buffer } from "../state/workspace";
import { useUi } from "../state/ui";
import { CodeEditor } from "./CodeEditor";
import { Segmented, Toolbar } from "./Toolbar";

const MAX_ROWS_SHOWN = 2000;

export interface CsvDoc {
  rows: string[][];
  delimiter: string;
  newline: "\n" | "\r\n";
  bom: boolean;
  trailingNewline: boolean;
}

/** Counts of each candidate delimiter outside quotes, per line, for the first lines. */
export function detectDelimiter(text: string): string {
  const candidates = [",", ";", "\t", "|"];
  const lines: Record<string, number>[] = [];
  let counts: Record<string, number> = {};
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < 20; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "\n") {
      lines.push(counts);
      counts = {};
    } else if (!quoted && candidates.includes(ch)) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  if (Object.keys(counts).length) lines.push(counts);
  let best = ",";
  let bestScore = 0;
  for (const d of candidates) {
    const first = lines[0]?.[d] ?? 0;
    if (!first) continue;
    const consistent = lines.filter((l) => (l[d] ?? 0) === first).length;
    const score = consistent * 100 + first;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsv(text: string, path: string): CsvDoc {
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const res = Papa.parse<string[]>(body, {
    delimiter: path.toLowerCase().endsWith(".tsv") ? "\t" : detectDelimiter(body),
    newline,
    skipEmptyLines: false,
  });
  const rows = res.data;
  const trailingNewline = body.endsWith("\n");
  if (trailingNewline && rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return { rows, delimiter: res.meta.delimiter || ",", newline, bom, trailingNewline };
}

export function serializeCsv(doc: CsvDoc): string {
  const text = Papa.unparse(doc.rows, { delimiter: doc.delimiter, newline: doc.newline });
  return (doc.bom ? "﻿" : "") + text + (doc.trailingNewline ? doc.newline : "");
}

/** Editable table. The file is only rewritten when a cell actually changes. */
export function CsvEditor({ buffer }: { buffer: Buffer }) {
  const [mode, setMode] = useState<"table" | "source">("table");
  const doc = useMemo(() => parseCsv(buffer.content ?? "", buffer.path), [buffer.content, buffer.path]);
  const width = Math.max(1, ...doc.rows.map((r) => r.length));

  const commit = (rows: string[][]) => useWorkspace.getState().edit(buffer.path, serializeCsv({ ...doc, rows }));
  const setCell = (r: number, c: number, value: string) => {
    if ((doc.rows[r]?.[c] ?? "") === value) return;
    const rows = doc.rows.map((row) => [...row]);
    while (rows[r].length <= c) rows[r].push("");
    rows[r][c] = value;
    commit(rows);
  };
  const addRow = (at: number) => {
    const rows = doc.rows.map((row) => [...row]);
    rows.splice(at, 0, Array(width).fill(""));
    commit(rows);
  };
  const addColumn = () => commit(doc.rows.map((row, i) => [...row, ...Array(width - row.length).fill(""), i === 0 ? `column ${width + 1}` : ""]));
  const deleteRow = (r: number) => commit(doc.rows.filter((_, i) => i !== r));
  const deleteColumn = (c: number) => commit(doc.rows.map((row) => row.filter((_, i) => i !== c)));

  const rowMenu = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    useUi.getState().showMenu(e.clientX, e.clientY, [
      { label: "Insert row above", action: () => addRow(r) },
      { label: "Insert row below", action: () => addRow(r + 1) },
      { label: "", separator: true },
      { label: "Delete row", danger: true, action: () => deleteRow(r) },
      { label: "Delete column", danger: true, action: () => deleteColumn(c) },
    ]);
  };

  const shown = doc.rows.slice(0, MAX_ROWS_SHOWN);
  return (
    <div className="viewer">
      <Toolbar>
        <Segmented<"table" | "source"> value={mode} onChange={setMode} options={[{ value: "table", label: "Table" }, { value: "source", label: "Source" }]} />
        <span className="toolbar-meta">
          {Math.max(0, doc.rows.length - 1)} rows · {width} columns · delimiter “{doc.delimiter === "\t" ? "tab" : doc.delimiter}”
        </span>
        <span className="spacer" />
        {mode === "table" && (
          <>
            <button onClick={() => addRow(doc.rows.length)}><Plus size={14} /> Row</button>
            <button onClick={addColumn}><Plus size={14} /> Column</button>
          </>
        )}
      </Toolbar>
      {mode === "source" ? (
        <CodeEditor buffer={buffer} />
      ) : (
        <div className="csv-scroll">
          <table className="csv">
            <tbody>
              {shown.map((row, r) => (
                <tr key={r} className={r === 0 ? "csv-head" : undefined}>
                  <td className="csv-rownum">{r === 0 ? "" : r}</td>
                  {Array.from({ length: width }, (_, c) => (
                    <td key={c} onContextMenu={(e) => rowMenu(e, r, c)}>
                      <div
                        className="csv-cell"
                        contentEditable
                        suppressContentEditableWarning
                        spellCheck={false}
                        onBlur={(e) => setCell(r, c, e.currentTarget.innerText.replace(/\n$/, ""))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).blur();
                          }
                          if (e.key === "Escape") {
                            e.currentTarget.innerText = row[c] ?? "";
                            (e.currentTarget as HTMLElement).blur();
                          }
                        }}
                      >
                        {row[c] ?? ""}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {doc.rows.length > MAX_ROWS_SHOWN && (
            <p className="panel-meta">Showing the first {MAX_ROWS_SHOWN} rows. Use Source to see everything.</p>
          )}
        </div>
      )}
    </div>
  );
}
