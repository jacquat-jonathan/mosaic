// ```query blocks in notes: the notes matching a structured query (crates/mosaic-core/src/query.rs),
// as a table that refreshes when the vault changes. Same language as `mosaic query` and the agents'
// `query` tool. Task queries (`task:open`) list checkbox tasks instead, which can be ticked here.

import { api, onVaultChanged } from "../ipc/api";
import { errorMessage, type QueryResult, type QueryRow } from "../ipc/types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const prop = (props: Record<string, unknown>, name: string) =>
  name in props ? props[name] : Object.entries(props).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** A column's value as text, like the CLI shows it. */
export function cell(row: QueryRow, column: string): string {
  const t = row.task;
  if (t) {
    if (column === "text") return t.text;
    if (column === "status") return t.status;
    if (column === "workflow") return t.status === "done" ? "done" : t.workflow ?? "new";
    if (column === "line") return String(t.line);
    if (column === "due" && t.due) return t.due;
  }
  if (column === "title") return row.title;
  if (column === "path") return row.path;
  if (column === "tags") return row.tags.map((t) => `#${t}`).join(" ");
  if (column === "modified") {
    const d = new Date(row.modified);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const v = prop(row.props, column);
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((i) => (typeof i === "object" ? JSON.stringify(i) : String(i))).join(", ");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Whether a query lists tasks (`task:…`) rather than notes. */
export const isTaskQuery = (query: string) => /(^|\s)-?task:/.test(query);

// Same link markup as wikilinks, so clicks open the note in the editor and in canvas cards.
const noteLink = (row: QueryRow) =>
  `<span class="cm-wikilink md-wikilink" data-target="${esc(row.path.replace(/\.md$/i, ""))}" title="${esc(row.path)}">${esc(row.title)}</span>`;

function taskCell(row: QueryRow): string {
  const t = row.task!;
  // Moved and cancelled tasks are closed on purpose: shown, not tickable from here.
  const tickable = t.status === "open" || t.status === "done";
  const box = `<input type="checkbox" class="query-task-box"${t.status === "done" ? " checked" : ""}${tickable ? "" : " disabled"} data-path="${esc(row.path)}" data-line="${t.line}" data-text="${esc(t.text)}" aria-label="${t.status === "done" ? "Done" : "Not done"}: ${esc(t.text)}">`;
  const mark = t.status === "moved" ? `<span class="query-task-mark" title="Moved">→</span>` : "";
  return `<td class="query-task status-${t.status}" style="padding-left:${t.depth * 18}px">${box}${mark}<span class="query-task-text">${esc(t.text) || "&nbsp;"}</span></td>`;
}

export interface QuerySort { column: string; descending: boolean }

/** The first sort directive in a query, used to mark the active table header. */
export function querySort(source: string): QuerySort | null {
  for (const line of source.split("\n")) {
    if (line.trim().startsWith("//")) continue;
    const m = /(?:^|\s)sort:(-?)([^\s]+)/.exec(line);
    if (m) return { column: m[2], descending: m[1] === "-" };
  }
  return null;
}

/** Click cycle for a header: ascending → descending → source order. Other sorts are replaced. */
export function sortQuery(source: string, column: string): string {
  const current = querySort(source);
  const next = current?.column !== column ? column : current.descending ? null : `-${column}`;
  const lines = source.split("\n").map((line) =>
    line.trim().startsWith("//") ? line : line.replace(/(^|\s)sort:-?[^\s]+/g, "$1").replace(/[ \t]+$/g, ""),
  );
  if (next) {
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() && !lines[i].trim().startsWith("//")) { at = i; break; }
    if (at < 0) lines.unshift(`sort:${next}`);
    else lines[at] = `${lines[at]} sort:${next}`.trim();
  }
  return lines.join("\n");
}

const sortHead = (label: string, column: string, sort: QuerySort | null) => {
  const active = sort?.column === column;
  const arrow = active ? (sort.descending ? " ↓" : " ↑") : "";
  const next = !active ? "ascending" : sort.descending ? "source order" : "descending";
  return `<th><button class="query-sort${active ? " active" : ""}" data-query-sort="${esc(column)}" aria-label="Sort by ${esc(label)}, ${next}">${esc(label)}${arrow}</button></th>`;
};

export function queryTable(r: QueryResult, tasks = r.rows.some((row) => row.task), sort: QuerySort | null = null): string {
  if (!r.rows.length) return `<div class="query-empty">${tasks ? "No matching tasks." : "No matching notes."}</div>`;
  const head = tasks
    ? `<tr>${sortHead("Task", "text", sort)}${sortHead("Note", "title", sort)}${r.columns.map((c) => sortHead(c, c, sort)).join("")}</tr>`
    : `<tr>${sortHead("Note", "title", sort)}${r.columns.map((c) => sortHead(c, c, sort)).join("")}</tr>`;
  const body = r.rows
    .map((row) => {
      const cols = r.columns.map((c) => `<td>${esc(cell(row, c))}</td>`).join("");
      return row.task ? `<tr>${taskCell(row)}<td>${noteLink(row)}</td>${cols}</tr>` : `<tr><td>${noteLink(row)}</td>${cols}</tr>`;
    })
    .join("");
  const more = r.total > r.rows.length ? `<div class="query-more">${r.rows.length} of ${r.total} shown — add <code>limit:${Math.min(r.total, 1000)}</code> for all</div>` : "";
  return `<table class="query-table"><thead>${head}</thead><tbody>${body}</tbody></table>${more}`;
}

/** Renders the query into `el`, and again whenever files change while `el` is on screen. */
export async function renderQuery(source: string, el: HTMLElement, replaceSource?: (source: string) => void): Promise<void> {
  let current = source;
  const queryText = () => current.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join(" ");
  const tasks = isTaskQuery(queryText());
  const draw = (r: QueryResult) => (el.innerHTML = queryTable(r, tasks, querySort(current)));
  draw(await api.query(queryText()));
  el.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>("[data-query-sort]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    current = sortQuery(current, button.dataset.querySort!);
    replaceSource?.(current);
    void api.query(queryText()).then((r) => el.isConnected && draw(r));
  });
  // Ticking a task writes its note; the vault change then redraws the table.
  el.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.classList.contains("query-task-box")) return;
    const { path, line, text } = box.dataset;
    api.setTask(path!, Number(line), text!, box.checked).catch((err) => {
      box.checked = !box.checked;
      const conflict = (err as { code?: string }).code === "conflict";
      box.title = conflict ? "The note changed: this task isn't on that line any more. The table refreshes in a moment." : errorMessage(err);
      void api.query(queryText()).then((r) => el.isConnected && draw(r), () => {});
    });
  });
  let off: (() => void) | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  void onVaultChanged(() => {
    if (!el.isConnected) return off?.();
    clearTimeout(pending);
    pending = setTimeout(() => {
      api.query(queryText()).then((r) => el.isConnected && draw(r), () => {});
    }, 300);
  }).then((f) => (off = f));
}
