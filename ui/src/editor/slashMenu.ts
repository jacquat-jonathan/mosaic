import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

interface Insertion {
  label: string;
  detail: string;
  group: string;
  text: string;
  cursor: number;
  select?: [number, number];
  /** Leave the Markdown block behind the caret so live preview renders it immediately. */
  placeAfter?: boolean;
  icon: string;
}

export const insertions: Insertion[] = [
  { label: "Heading 1", detail: "Largest section heading", group: "Basic", icon: "H1", text: "# ", cursor: 2 },
  { label: "Heading 2", detail: "Second-level section heading", group: "Basic", icon: "H2", text: "## ", cursor: 3 },
  { label: "Heading 3", detail: "Third-level section heading", group: "Basic", icon: "H3", text: "### ", cursor: 4 },
  { label: "Bullet list", detail: "Start an unordered list", group: "Basic", icon: "•", text: "- ", cursor: 2 },
  { label: "Numbered list", detail: "Start an ordered list", group: "Basic", icon: "1.", text: "1. ", cursor: 3 },
  { label: "Checkbox", detail: "Add a checklist item", group: "Basic", icon: "✓", text: "- [ ] ", cursor: 6 },
  { label: "Quote", detail: "Add a blockquote for emphasis", group: "Basic", icon: "❝", text: "> ", cursor: 2 },
  { label: "Callout", detail: "Add a highlighted note", group: "Basic", icon: "!", text: "> [!note]\n> ", cursor: 12 },
  { label: "Divider", detail: "Separate content with a rule", group: "Basic", icon: "—", text: "---\n\n", cursor: 5 },
  {
    label: "Table",
    detail: "Insert a two-column table",
    group: "Blocks",
    icon: "▦",
    text: "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n",
    cursor: 0,
    placeAfter: true,
  },
  {
    label: "Code block",
    detail: "Add a fenced code snippet",
    group: "Blocks",
    icon: "<>",
    text: "```\n\n```\n",
    cursor: 4,
  },
  {
    label: "Math block",
    detail: "Write a display equation",
    group: "Blocks",
    icon: "∑",
    text: "$$\n\n$$\n",
    cursor: 3,
  },
  {
    label: "Mermaid diagram",
    detail: "Create a flowchart block",
    group: "Blocks",
    icon: "◇",
    text: "```mermaid\nflowchart TD\n  A --> B\n```\n",
    cursor: 24,
  },
  {
    label: "Query",
    detail: "Insert a live vault query",
    group: "Blocks",
    icon: "?",
    text: "```query\ntask:open\n```\n",
    cursor: 9,
  },
  {
    label: "Wikilink",
    detail: "Link to another Mosaic file",
    group: "Links & media",
    icon: "[[",
    text: "[[Note]]",
    cursor: 6,
    select: [2, 6],
  },
  {
    label: "Web link",
    detail: "Link text to a web address",
    group: "Links & media",
    icon: "↗",
    text: "[Link text](https://example.com)",
    cursor: 10,
    select: [1, 10],
  },
  {
    label: "Embed file",
    detail: "Show an image, PDF, note or canvas",
    group: "Links & media",
    icon: "+",
    text: "![[File]]",
    cursor: 7,
    select: [3, 7],
  },
];

/** A slash at the start of an otherwise empty block opens the insertion menu. */
export function slashCompletion(ctx: CompletionContext): CompletionResult | null {
  if (ctx.state.readOnly || !ctx.state.selection.main.empty) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = ctx.state.sliceDoc(line.from, ctx.pos);
  const match = /^\s*\/([\w -]*)$/.exec(before);
  if (!match || ctx.state.sliceDoc(ctx.pos, line.to).trim()) return null;
  const doc = ctx.state.doc.toString();
  if (doc.startsWith("---\n") || doc.startsWith("---\r\n")) {
    const end = /^---\s*$/gm;
    end.lastIndex = 4;
    const close = end.exec(doc);
    if (close && ctx.pos <= close.index + close[0].length) return null;
    // A leading divider is also `---`; only unfinished YAML with properties blocks the menu.
    if (!close && /^[\w-]+\s*:/m.test(doc.slice(4, ctx.pos))) return null;
  }
  for (let node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); node; node = node.parent!) {
    if (["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock"].includes(node.name)) return null;
  }
  const slash = line.from + before.indexOf("/");
  return {
    from: slash + 1,
    validFor: /^[\w -]*$/,
    options: insertions.map((item) => ({
      label: item.label,
      detail: item.detail,
      section: item.group,
      type: `mosaic-slash:${item.icon}`,
      apply(view: EditorView, _completion: Completion, _from: number, to: number) {
        const followingNewline = item.placeAfter && view.state.sliceDoc(to, to + 1) === "\n";
        const insert = item.placeAfter && !followingNewline ? `${item.text}\n` : item.text;
        const anchor = item.placeAfter ? slash + insert.length + (followingNewline ? 1 : 0) : slash + item.cursor;
        const selection = item.select ? { anchor: slash + item.select[0], head: slash + item.select[1] } : { anchor };
        view.dispatch({ changes: { from: slash, to, insert }, selection, userEvent: "input.complete" });
      },
    })),
  };
}

export function slashIcon(type?: string): HTMLElement | null {
  if (!type?.startsWith("mosaic-slash:")) return null;
  const icon = document.createElement("span");
  icon.className = "cm-slash-icon";
  icon.textContent = type.slice("mosaic-slash:".length);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
