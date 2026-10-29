// ```query blocks in notes: the notes matching a structured query (crates/mosaic-core/src/query.rs),
// as a table that refreshes when the vault changes. Same language as `mosaic query` and the agents'
// `query` tool. Task queries (`task:open`) list checkbox tasks instead, which can be ticked here.

import { api, onVaultChanged } from "../ipc/api";
import { editorScope } from "./designSystemDom";
import { useVault } from "../state/vault";
import "./queryControls.css";
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
    if (column === "workflow") return t.status === "done" ? "done" : (t.workflow ?? "new");
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
  const v = prop(row.props as Record<string, unknown>, column);
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((i) => (typeof i === "object" ? JSON.stringify(i) : String(i))).join(", ");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Whether a query lists tasks (`task:…`) rather than notes. */
export const isTaskQuery = (query: string) => /(^|\s)-?task:/.test(query);

// Same link markup as wikilinks, so clicks open the note in the editor and in canvas cards.
const noteLink = (row: QueryRow) =>
  `<button type="button" class="mds-button mds-button--quiet cm-wikilink md-wikilink query-note-link" data-target="${esc(row.path.replace(/\.md$/i, ""))}" title="${esc(row.path)}">${esc(row.title)}</button>`;

function taskCell(row: QueryRow): string {
  const t = row.task!;
  // Moved and cancelled tasks are closed on purpose: shown, not tickable from here.
  const tickable = t.status === "open" || t.status === "done";
  const box = `<input type="checkbox" class="query-task-box"${t.status === "done" ? " checked" : ""}${tickable ? "" : " disabled"} data-path="${esc(row.path)}" data-line="${t.line}" data-text="${esc(t.text)}" aria-label="${t.status === "done" ? "Done" : "Not done"}: ${esc(t.text)}">`;
  const mark = t.status === "moved" ? `<span class="query-task-mark" title="Moved">→</span>` : "";
  return `<td class="query-task status-${t.status}" style="padding-left:${t.depth * 18}px">${box}${mark}<span class="query-task-text">${esc(t.text) || "&nbsp;"}</span></td>`;
}

export interface QuerySort {
  column: string;
  descending: boolean;
}

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
  const lines = source
    .split("\n")
    .map((line) =>
      line.trim().startsWith("//") ? line : line.replace(/(^|\s)sort:-?[^\s]+/g, "$1").replace(/[ \t]+$/g, ""),
    );
  if (next) {
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--)
      if (lines[i].trim() && !lines[i].trim().startsWith("//")) {
        at = i;
        break;
      }
    if (at < 0) lines.unshift(`sort:${next}`);
    else lines[at] = `${lines[at]} sort:${next}`.trim();
  }
  return lines.join("\n");
}

const sortHead = (label: string, column: string, sort: QuerySort | null) => {
  const active = sort?.column === column;
  const arrow = active ? (sort.descending ? " ↓" : " ↑") : "";
  const next = !active ? "ascending" : sort.descending ? "source order" : "descending";
  return `<th><button type="button" class="mds-button mds-button--quiet query-sort${active ? " active" : ""}" data-query-sort="${esc(column)}" aria-label="Sort by ${esc(label)}, ${next}">${esc(label)}${arrow}</button></th>`;
};

export function queryTable(
  r: QueryResult,
  tasks = r.rows.some((row) => row.task),
  sort: QuerySort | null = null,
): string {
  if (!r.rows.length)
    return `<div class="query-empty" role="status">${tasks ? "No matching tasks." : "No matching notes."}</div>`;
  const head = tasks
    ? `<tr>${sortHead("Task", "text", sort)}${sortHead("Note", "title", sort)}${r.columns.map((c) => sortHead(c, c, sort)).join("")}</tr>`
    : `<tr>${sortHead("Note", "title", sort)}${r.columns.map((c) => sortHead(c, c, sort)).join("")}</tr>`;
  const body = r.rows
    .map((row) => {
      const cols = r.columns.map((c) => `<td>${esc(cell(row, c))}</td>`).join("");
      return row.task
        ? `<tr>${taskCell(row)}<td>${noteLink(row)}</td>${cols}</tr>`
        : `<tr><td>${noteLink(row)}</td>${cols}</tr>`;
    })
    .join("");
  const more =
    r.total > r.rows.length
      ? `<div class="query-more">${r.rows.length} of ${r.total} shown — add <code>limit:${Math.min(r.total, 1000)}</code> for all</div>`
      : "";
  return `<table class="query-table"><thead>${head}</thead><tbody>${body}</tbody></table>${more}`;
}

const sortFocus = new WeakMap<HTMLElement, { index: number; source: string; column: string }>();

/** Renders query results with readable controls and scoped read/write state. */
export async function renderQuery(
  source: string,
  el: HTMLElement,
  replaceSource?: (source: string) => void,
): Promise<void> {
  editorScope(el);
  el.classList.add("editor-query");
  const root = useVault.getState().vault?.root;
  let current = source,
    request = 0,
    disposed = false,
    reading = false;
  let readError: string | null = null,
    writeError: string | null = null;
  let off: (() => void) | undefined,
    pending: ReturnType<typeof setTimeout> | undefined,
    observer: MutationObserver | undefined;
  const saving = new Set<string>();
  const queryText = () =>
    current
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .join(" ");
  const active = () => !disposed && el.isConnected && useVault.getState().vault?.root === root;
  const key = (box: HTMLInputElement) => JSON.stringify([box.dataset.path, box.dataset.line, box.dataset.text]);
  const feedback = document.createElement("div"),
    results = document.createElement("div");
  feedback.className = "query-feedback";
  results.className = "query-results";
  el.replaceChildren(feedback, results);
  const status = () => {
    feedback.replaceChildren();
    el.setAttribute("aria-busy", String(reading || saving.size > 0));
    const notice = (text: string, error = false) => {
      const node = document.createElement("div");
      node.className = `mds-notice mds-notice--${error ? "error" : "neutral"}`;
      node.setAttribute("role", error ? "alert" : "status");
      node.textContent = text;
      feedback.append(node);
    };
    if (reading) notice("Loading query results…");
    if (saving.size) notice("Updating task…");
    if (readError) notice(`Couldn't load query results: ${readError}`, true);
    if (writeError) notice(writeError, true);
    if (readError || writeError) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "mds-button mds-button--secondary";
      retry.textContent = "Reload results";
      retry.disabled = reading;
      retry.addEventListener("click", () => {
        writeError = null;
        void refresh();
      });
      feedback.append(retry);
    }
    for (const button of results.querySelectorAll<HTMLButtonElement>("[data-query-sort]")) button.disabled = reading;
    for (const box of results.querySelectorAll<HTMLInputElement>(".query-task-box")) {
      const busy = saving.has(key(box));
      box.disabled = busy || box.closest(".status-moved,.status-cancelled") !== null;
      box.setAttribute("aria-busy", String(busy));
    }
  };
  const draw = (result: QueryResult) => {
    const focused = document.activeElement as HTMLElement | null;
    const inside = !!focused && results.contains(focused);
    const checkbox = focused?.matches(".query-task-box") ? key(focused as HTMLInputElement) : null;
    const sort = focused?.dataset.querySort;
    results.innerHTML = queryTable(result, isTaskQuery(queryText()), querySort(current));
    status();
    const host = el.closest<HTMLElement>(".cm-content"),
      intent = host && sortFocus.get(host);
    const index = host ? [...host.querySelectorAll(".editor-query")].indexOf(el) : -1;
    if (intent && intent.index === index && intent.source === queryText()) {
      sortFocus.delete(host!);
      if (document.activeElement === document.body || host!.contains(document.activeElement))
        [...results.querySelectorAll<HTMLButtonElement>("[data-query-sort]")]
          .find((button) => button.dataset.querySort === intent.column)
          ?.focus();
    } else if (inside) {
      const target = checkbox
        ? [...results.querySelectorAll<HTMLInputElement>(".query-task-box")].find((box) => key(box) === checkbox)
        : [...results.querySelectorAll<HTMLButtonElement>("[data-query-sort]")].find(
            (button) => button.dataset.querySort === sort,
          );
      (target ?? results.querySelector<HTMLElement>(".query-task-box:not(:disabled),[data-query-sort]"))?.focus();
    }
  };
  async function refresh(initial = false) {
    const ticket = ++request;
    reading = true;
    readError = null;
    status();
    try {
      const result = await api.query(queryText());
      if (!disposed && ticket === request && useVault.getState().vault?.root === root && (initial || el.isConnected)) {
        reading = false;
        draw(result);
      }
    } catch (cause) {
      if (!disposed && ticket === request && useVault.getState().vault?.root === root && (initial || el.isConnected)) {
        reading = false;
        readError = errorMessage(cause);
        status();
      }
    }
  }
  const sort = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-query-sort]");
    if (!button || !active() || reading) return;
    event.preventDefault();
    event.stopPropagation();
    current = sortQuery(current, button.dataset.querySort!);
    const host = el.closest<HTMLElement>(".cm-content");
    if (replaceSource && host && document.activeElement === button)
      sortFocus.set(host, {
        index: [...host.querySelectorAll(".editor-query")].indexOf(el),
        source: queryText(),
        column: button.dataset.querySort!,
      });
    replaceSource?.(current);
    if (active()) void refresh();
  };
  const change = async (event: Event) => {
    const box = event.target as HTMLInputElement;
    if (!box.classList.contains("query-task-box") || !active() || saving.has(key(box))) return;
    const id = key(box),
      wanted = box.checked,
      restoreFocus = document.activeElement === box;
    saving.add(id);
    writeError = null;
    status();
    try {
      await api.setTask(box.dataset.path!, Number(box.dataset.line), box.dataset.text!, wanted);
      if (active()) await refresh();
    } catch (cause) {
      if (active()) {
        box.checked = !wanted;
        box.title =
          (cause as { code?: string }).code === "conflict"
            ? "The note changed: this task isn't on that line any more. Reload the results."
            : errorMessage(cause);
        writeError = `Couldn't update this task: ${box.title}`;
        await refresh();
      }
    } finally {
      saving.delete(id);
      if (active()) {
        status();
        if (restoreFocus && (document.activeElement === document.body || el.contains(document.activeElement)))
          (
            [...results.querySelectorAll<HTMLInputElement>(".query-task-box:not(:disabled)")].find(
              (next) => key(next) === id,
            ) ?? results.querySelector<HTMLElement>(".query-task-box:not(:disabled),[data-query-sort]")
          )?.focus();
      }
    }
  };
  const dispose = () => {
    disposed = true;
    request++;
    clearTimeout(pending);
    off?.();
    observer?.disconnect();
    el.removeEventListener("click", sort);
    el.removeEventListener("change", change);
  };
  await refresh(true);
  if (!active()) return;
  el.addEventListener("click", sort);
  el.addEventListener("change", change);
  observer = new MutationObserver(() => {
    if (!active()) dispose();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  void onVaultChanged(() => {
    if (!active()) return dispose();
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (active()) void refresh();
    }, 300);
  }).then((unsubscribe) => {
    if (!active()) unsubscribe();
    else off = unsubscribe;
  });
}
