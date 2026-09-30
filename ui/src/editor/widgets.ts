import { EditorView, WidgetType } from "@codemirror/view";
import { parse as parseYaml } from "yaml";
import { renderMath } from "./render";
import type { EditorContext } from "./context";

/** Renderers for fenced code blocks by language (mermaid, math, and later vega-lite, dot…). */
export type BlockRenderer = (source: string, el: HTMLElement, ctx: EditorContext) => void | Promise<void>;
export const blockRenderers = new Map<string, BlockRenderer>();

export function registerBlockRenderer(langs: string[], r: BlockRenderer) {
  for (const l of langs) blockRenderers.set(l, r);
}

function showError(el: HTMLElement, err: unknown) {
  el.classList.add("cm-render-error");
  el.textContent = err instanceof Error ? err.message : String(err);
}

/** Moves the cursor to `pos` so the source is revealed for editing. */
function revealOnClick(dom: HTMLElement, view: EditorView, pos: () => number) {
  dom.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("a, input, button, .cm-link, .cm-wikilink")) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos() } });
    view.focus();
  });
}

export class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly source: string,
    readonly ctx: EditorContext,
  ) {
    super();
  }
  eq(o: RenderedBlockWidget) {
    return o.lang === this.lang && o.source === this.source;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = `cm-rendered-block cm-lang-${this.lang}`;
    const r = blockRenderers.get(this.lang);
    try {
      const out = r?.(this.source, el, this.ctx);
      if (out instanceof Promise) out.catch((e) => showError(el, e));
    } catch (e) {
      showError(el, e);
    }
    revealOnClick(el, view, () => view.posAtDOM(el));
    return el;
  }
  get estimatedHeight() {
    return 120;
  }
  ignoreEvent() {
    return true;
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.source === this.source && o.display === this.display;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math";
    el.innerHTML = renderMath(this.source, this.display);
    revealOnClick(el, view, () => view.posAtDOM(el) + (this.display ? 2 : 1));
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string,
    readonly resolved: boolean,
  ) {
    super();
  }
  eq(o: LinkWidget) {
    return o.label === this.label && o.target === this.target && o.resolved === this.resolved;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.resolved ? "cm-wikilink" : "cm-wikilink unresolved";
    el.textContent = this.label;
    el.dataset.target = this.target;
    el.title = this.resolved ? this.target : `${this.target} (not created yet — click to create)`;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly path: string | null,
    readonly alt: string,
    readonly width: number | null,
    readonly ctx: EditorContext,
    readonly remote: string | null = null,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.path === this.path && o.alt === this.alt && o.width === this.width && o.remote === this.remote;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed-image";
    if (this.remote) {
      wrap.classList.add("cm-embed-missing");
      wrap.textContent = `Remote image not loaded (offline mode): ${this.remote}`;
    } else if (!this.path) {
      wrap.classList.add("cm-embed-missing");
      wrap.textContent = `Missing file: ${this.alt}`;
    } else {
      const img = document.createElement("img");
      img.alt = this.alt;
      if (this.width) img.width = this.width;
      void this.ctx.fileUrl(this.path).then((u) => (img.src = u));
      wrap.appendChild(img);
    }
    revealOnClick(wrap, view, () => view.posAtDOM(wrap));
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly path: string | null,
    readonly target: string,
    readonly ctx: EditorContext,
  ) {
    super();
  }
  eq(o: NoteEmbedWidget) {
    return o.path === this.path && o.target === this.target;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-embed-note";
    const head = document.createElement("div");
    head.className = "cm-embed-note-title cm-wikilink" + (this.path ? "" : " unresolved");
    head.textContent = this.target;
    head.dataset.target = this.target;
    el.appendChild(head);
    const body = document.createElement("div");
    body.className = "cm-embed-note-body";
    el.appendChild(body);
    if (this.path) {
      void this.ctx.readText(this.path).then(
        (t) => (body.textContent = stripFrontmatter(t).split("\n").slice(0, 16).join("\n").trim()),
        (e) => showError(body, e),
      );
    } else {
      body.textContent = "This note doesn't exist yet.";
    }
    revealOnClick(el, view, () => view.posAtDOM(el));
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

export class PropertiesWidget extends WidgetType {
  constructor(readonly yaml: string) {
    super();
  }
  eq(o: PropertiesWidget) {
    return o.yaml === this.yaml;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-properties";
    let data: unknown;
    try {
      data = parseYaml(this.yaml);
    } catch (e) {
      showError(el, e);
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        const row = document.createElement("div");
        row.className = "cm-prop";
        const key = document.createElement("span");
        key.className = "cm-prop-key";
        key.textContent = k;
        const val = document.createElement("span");
        val.className = "cm-prop-value";
        const values = Array.isArray(v) ? v : [v];
        for (const item of values) {
          const pill = document.createElement("span");
          pill.className = Array.isArray(v) ? "cm-prop-pill" : "cm-prop-text";
          pill.textContent = item === null || item === undefined ? "" : typeof item === "object" ? JSON.stringify(item) : String(item);
          val.appendChild(pill);
        }
        row.append(key, val);
        el.appendChild(row);
      }
    } else if (!el.classList.contains("cm-render-error")) {
      el.textContent = "Properties";
    }
    revealOnClick(el, view, () => 4);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr";
    return el;
  }
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    const lines = this.source.split("\n").filter((l) => l.trim());
    const cells = (l: string) => splitRow(l);
    const align = cells(lines[1] ?? "").map((c) =>
      c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
    );
    const addRow = (parent: HTMLElement, l: string, tag: "th" | "td") => {
      const tr = document.createElement("tr");
      cells(l).forEach((c, i) => {
        const td = document.createElement(tag);
        td.textContent = c;
        td.style.textAlign = align[i] ?? "left";
        tr.appendChild(td);
      });
      parent.appendChild(tr);
    };
    const thead = document.createElement("thead");
    if (lines[0]) addRow(thead, lines[0], "th");
    const tbody = document.createElement("tbody");
    lines.slice(2).forEach((l) => addRow(tbody, l, "td"));
    table.append(thead, tbody);
    wrap.appendChild(table);
    revealOnClick(wrap, view, () => view.posAtDOM(wrap));
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
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
