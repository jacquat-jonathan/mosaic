import { type CompletionContext, type CompletionResult, type Completion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

export const insertions = [
  { label: "Heading 1", detail: "Large heading", text: "# ", cursor: 2 },
  { label: "Heading 2", detail: "Section heading", text: "## ", cursor: 3 },
  { label: "Heading 3", detail: "Small heading", text: "### ", cursor: 4 },
  { label: "Table", detail: "Two columns", text: "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n", cursor: 2 },
  { label: "Task list", detail: "Checkbox task", text: "- [ ] ", cursor: 6 },
  { label: "Bullet list", detail: "Unordered list", text: "- ", cursor: 2 },
  { label: "Numbered list", detail: "Ordered list", text: "1. ", cursor: 3 },
  { label: "Quote", detail: "Block quote", text: "> ", cursor: 2 },
  { label: "Divider", detail: "Horizontal rule", text: "---\n\n", cursor: 5 },
  { label: "Code block", detail: "Fenced code", text: "```\n\n```\n", cursor: 4 },
  { label: "Mermaid diagram", detail: "Flowchart", text: "```mermaid\nflowchart TD\n  A --> B\n```\n", cursor: 24 },
  { label: "Query", detail: "Live task table", text: "```query\ntask:open\n```\n", cursor: 9 },
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
    if (!close || ctx.pos <= close.index + close[0].length) return null;
  }
  for (let node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); node; node = node.parent!) {
    if (["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock"].includes(node.name)) return null;
  }
  const slash = line.from + before.indexOf("/");
  return {
    from: slash + 1,
    validFor: /^[\w -]*$/,
    options: insertions.map(item => ({
      label: item.label, detail: item.detail, type: "text",
      apply(view: EditorView, _completion: Completion, _from: number, to: number) {
        view.dispatch({ changes: { from: slash, to, insert: item.text }, selection: { anchor: slash + item.cursor }, userEvent: "input.complete" });
      },
    })),
  };
}
