import { EditorView, WidgetType } from "@codemirror/view";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderMath } from "./render";
import { PropertiesEditor } from "./PropertiesEditor";
import { isDark } from "../theme";
import type { EditorContext } from "./context";

import { blockRenderers, showRenderError as showError } from "./blocks";
import { diagramKind } from "../diagrams/mermaidToCanvas";

/** Moves the cursor to `pos` so the source is revealed for editing. */
function revealOnClick(dom: HTMLElement, view: EditorView, pos: () => number) {
  dom.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("a, input, button, .cm-link, .cm-wikilink")) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos() } });
    view.focus();
  });
}

/** The last drawing that rendered without error, per block being edited (`path:line`). */
const lastGood = new Map<string, string>();

export class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly source: string,
    readonly ctx: EditorContext,
    // Diagrams bake the theme into their SVG, so a theme change must produce an unequal widget.
    readonly dark = isDark(),
    /** Set while the block's source is being edited: this is the live preview under it. */
    readonly previewKey?: string,
  ) {
    super();
  }
  eq(o: RenderedBlockWidget) {
    return o.lang === this.lang && o.source === this.source && o.dark === this.dark && o.previewKey === this.previewKey;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = `cm-rendered-block cm-lang-${this.lang}${this.previewKey ? " cm-block-preview" : ""}`;
    const r = blockRenderers.get(this.lang);
    const key = this.previewKey;
    const failed = (e: unknown) => {
      const good = key && lastGood.get(key);
      if (!good) return showError(el, e);
      // Keep the last good drawing, with the error under it, instead of a blank box while typing.
      el.innerHTML = good;
      const note = document.createElement("div");
      note.className = "cm-render-error";
      note.textContent = e instanceof Error ? e.message : String(e);
      el.appendChild(note);
    };
    const succeeded = () => {
      if (key) lastGood.set(key, el.innerHTML);
      // Added after rendering: the renderer replaces the block's content when the drawing arrives.
      else this.addOpenAsDiagram(el);
    };
    try {
      const out = r?.(this.source, el, this.ctx);
      if (out instanceof Promise) out.then(succeeded, failed);
      else succeeded();
    } catch (e) {
      failed(e);
    }
    if (key) return el;
    revealOnClick(el, view, () => view.posAtDOM(el));
    return el;
  }
  /** "Open as diagram" on a rendered Mermaid flowchart or state diagram. */
  private addOpenAsDiagram(el: HTMLElement) {
    if (this.lang !== "mermaid" || !this.ctx.openAsDiagram || !diagramKind(this.source)) return;
    const open = document.createElement("button");
    open.className = "block-action";
    open.textContent = "Open as diagram";
    open.title = "Make an editable canvas from this diagram, next to the note";
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      this.ctx.openAsDiagram!(this.source);
    });
    el.appendChild(open);
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

/** `![[Diagram.canvas]]` in a note: the canvas drawn as a picture; click it to open the canvas. */
export class CanvasEmbedWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly target: string,
    readonly ctx: EditorContext,
    readonly dark = isDark(),
  ) {
    super();
  }
  eq(o: CanvasEmbedWidget) {
    return o.path === this.path && o.dark === this.dark;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-embed-canvas";
    el.title = `Open ${this.target}`;
    el.dataset.target = this.target;
    void Promise.all([this.ctx.readText(this.path), import("../viewers/canvas/jsonCanvas"), import("../diagrams/canvasToSvg")]).then(
      ([text, { parseCanvas }, { canvasToSvg }]) => {
        // Our own SVG with every label escaped, so it's safe to insert.
        el.innerHTML = canvasToSvg(parseCanvas(text), this.dark);
      },
      (e) => showError(el, e),
    );
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.ctx.openLink(this.target, e.metaKey);
    });
    return el;
  }
  get estimatedHeight() {
    return 240;
  }
  ignoreEvent() {
    return true;
  }
}

export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** The note's frontmatter as an editable form (PropertiesEditor); "Edit as YAML" shows the source. */
export class PropertiesWidget extends WidgetType {
  private roots = new WeakMap<HTMLElement, Root>();
  constructor(
    readonly yaml: string,
    /** Where the frontmatter block ends (it starts at 0, and the closing --- has no line break). */
    readonly end: number,
  ) {
    super();
  }
  eq(o: PropertiesWidget) {
    return o.yaml === this.yaml && o.end === this.end;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    const root = createRoot(el);
    this.roots.set(el, root);
    const onChange = (yaml: string) => {
      const block = yaml.trim() ? `---\n${yaml.endsWith("\n") ? yaml : `${yaml}\n`}---` : "";
      view.dispatch({ changes: { from: 0, to: this.end, insert: block } });
    };
    const onEditSource = () => {
      view.dispatch({ selection: { anchor: 4 } });
      view.focus();
    };
    root.render(createElement(PropertiesEditor, { yaml: this.yaml, onChange, onEditSource }));
    return el;
  }
  destroy(dom: HTMLElement) {
    const root = this.roots.get(dom);
    // Unmount after the current render, as React requires.
    if (root) queueMicrotask(() => root.unmount());
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

/** Hosts a React component inside the editor (PDF pages, canvases…). */
export class ReactWidget extends WidgetType {
  private roots = new WeakMap<HTMLElement, Root>();
  constructor(
    readonly key: string,
    readonly render: () => ReactElement,
    readonly className: string,
  ) {
    super();
  }
  eq(o: ReactWidget) {
    return o.key === this.key;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = this.className;
    const root = createRoot(el);
    root.render(this.render());
    this.roots.set(el, root);
    revealOnClick(el, view, () => view.posAtDOM(el));
    return el;
  }
  destroy(dom: HTMLElement) {
    const root = this.roots.get(dom);
    if (root) setTimeout(() => root.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

export { createElement };
