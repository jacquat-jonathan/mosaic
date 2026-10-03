// Outline numbers for nested ordered lists ("2.1."), shown by the live preview in place of the
// Markdown's own numbers.

import type { SyntaxNode } from "@lezer/common";

/**
 * The outline number of an ordered list item nested in other ordered list items ("2.1.", "2.1.3."),
 * from its ListMark node; null at the top level or under a bullet list, where the number shows as
 * written. Numbers count like Markdown renders them: the list's first number, then +1 per item.
 */
export function outlineNumber(mark: SyntaxNode, text: (from: number, to: number) => string): string | null {
  const parts: number[] = [];
  let item = mark.parent;
  while (item?.name === "ListItem" && item.parent?.name === "OrderedList") {
    const list = item.parent;
    const first = list.getChild("ListItem")?.getChild("ListMark");
    const start = first ? parseInt(text(first.from, first.to), 10) || 1 : 1;
    let index = 0;
    for (let c = list.firstChild; c && c.from < item.from; c = c.nextSibling) if (c.name === "ListItem") index++;
    parts.unshift(start + index);
    item = list.parent;
  }
  return parts.length > 1 ? `${parts.join(".")}.` : null;
}
