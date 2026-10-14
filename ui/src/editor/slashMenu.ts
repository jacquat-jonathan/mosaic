import { type CompletionContext, type CompletionResult, type Completion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
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
}

export const insertions: Insertion[] = [
  { label: "Heading 1", detail: "Large heading", group: "Text", text: "# ", cursor: 2 },
  { label: "Heading 2", detail: "Section heading", group: "Text", text: "## ", cursor: 3 },
  { label: "Heading 3", detail: "Small heading", group: "Text", text: "### ", cursor: 4 },
  { label: "Bullet list", detail: "Unordered list", group: "Text", text: "- ", cursor: 2 },
  { label: "Numbered list", detail: "Ordered list", group: "Text", text: "1. ", cursor: 3 },
  { label: "Checkbox", detail: "Checklist item", group: "Text", text: "- [ ] ", cursor: 6 },
  { label: "Quote", detail: "Block quote", group: "Text", text: "> ", cursor: 2 },
  { label: "Callout", detail: "Highlighted note", group: "Text", text: "> [!note]\n> ", cursor: 12 },
  { label: "Divider", detail: "Horizontal rule", group: "Text", text: "---\n\n", cursor: 5 },
  { label: "Table", detail: "Two columns", group: "Blocks", text: "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n", cursor: 0, placeAfter: true },
  { label: "Code block", detail: "Fenced code", group: "Blocks", text: "```\n\n```\n", cursor: 4 },
  { label: "Math block", detail: "Display equation", group: "Blocks", text: "$$\n\n$$\n", cursor: 3 },
  { label: "Mermaid diagram", detail: "Flowchart", group: "Blocks", text: "```mermaid\nflowchart TD\n  A --> B\n```\n", cursor: 24 },
  { label: "Query", detail: "Live task table", group: "Blocks", text: "```query\ntask:open\n```\n", cursor: 9 },
  { label: "Wikilink", detail: "Link to a vault note", group: "Links & media", text: "[[Note]]", cursor: 6, select: [2, 6] },
  { label: "Web link", detail: "Link to a URL", group: "Links & media", text: "[Link text](https://example.com)", cursor: 10, select: [1, 10] },
  { label: "Embed file", detail: "Image, PDF, note or canvas", group: "Links & media", text: "![[File]]", cursor: 7, select: [3, 7] },
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
    const end = /^---\s*$/gm; end.lastIndex = 4;
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
    options: insertions.map(item => ({
      label: item.label, detail: item.detail, section: item.group, type: "text",
      apply(view: EditorView, _completion: Completion, _from: number, to: number) {
        const followingNewline = item.placeAfter && view.state.sliceDoc(to, to + 1) === "\n";
        const insert = item.placeAfter && !followingNewline ? `${item.text}\n` : item.text;
        const anchor = item.placeAfter ? slash + insert.length + (followingNewline ? 1 : 0) : slash + item.cursor;
        const selection = item.select
          ? { anchor: slash + item.select[0], head: slash + item.select[1] }
          : { anchor };
        view.dispatch({ changes: { from: slash, to, insert }, selection, userEvent: "input.complete" });
      },
    })),
  };
}
