// ```query blocks in notes: the notes matching a structured query (crates/mosaic-core/src/query.rs),
// as a table that refreshes when the vault changes. Same language as `mosaic query` and the agents'
// `query` tool.

import { api, onVaultChanged } from "../ipc/api";
import type { QueryResult, QueryRow } from "../ipc/types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const prop = (props: Record<string, unknown>, name: string) =>
  name in props ? props[name] : Object.entries(props).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** A column's value as text, like the CLI shows it. */
export function cell(row: QueryRow, column: string): string {
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

export function queryTable(r: QueryResult): string {
  if (!r.rows.length) return `<div class="query-empty">No matching notes.</div>`;
  const head = `<tr><th>Note</th>${r.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const body = r.rows
    .map((row) => {
      // Same link markup as wikilinks, so clicks open the note in the editor and in canvas cards.
      const link = `<span class="cm-wikilink md-wikilink" data-target="${esc(row.path.replace(/\.md$/i, ""))}" title="${esc(row.path)}">${esc(row.title)}</span>`;
      return `<tr><td>${link}</td>${r.columns.map((c) => `<td>${esc(cell(row, c))}</td>`).join("")}</tr>`;
    })
    .join("");
  const more = r.total > r.rows.length ? `<div class="query-more">${r.rows.length} of ${r.total} shown — add <code>limit:${Math.min(r.total, 1000)}</code> for all</div>` : "";
  return `<table class="query-table"><thead>${head}</thead><tbody>${body}</tbody></table>${more}`;
}

/** Renders the query into `el`, and again whenever files change while `el` is on screen. */
export async function renderQuery(source: string, el: HTMLElement): Promise<void> {
  const query = source.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join(" ");
  el.innerHTML = queryTable(await api.query(query));
  let off: (() => void) | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  void onVaultChanged(() => {
    if (!el.isConnected) return off?.();
    clearTimeout(pending);
    pending = setTimeout(() => {
      api.query(query).then((r) => el.isConnected && (el.innerHTML = queryTable(r)), () => {});
    }, 300);
  }).then((f) => (off = f));
}
