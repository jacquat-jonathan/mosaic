import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { blockAt, blockRanges, insertionAfter, moveBlock, siblingsOf, stepGap } from "./blockRanges";

const state = (doc: string) => EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) });
const blocksOf = (doc: string) => blockRanges(state(doc));
const texts = (doc: string) => blocksOf(doc).map((b) => doc.slice(b.from, b.to));

/** Moves the block starting with `start` to before the sibling starting with `before` (null: the end). */
function move(doc: string, start: string, before: string | null) {
  const blocks = blocksOf(doc);
  const source = blocks.find((b) => doc.slice(b.from).startsWith(start))!;
  const { units } = siblingsOf(blocks, source);
  const gap = before === null ? units.length : units.findIndex((u) => doc.slice(u.from).startsWith(before));
  return moveBlock(doc, blocks, source, gap)?.text ?? null;
}

describe("blocks", () => {
  test("top-level blocks, list items with their children, a table with its widths comment", () => {
    const doc = [
      "---",
      "title: x",
      "---",
      "# Title",
      "",
      "Para one",
      "still one",
      "",
      "- a",
      "  - a1",
      "- b",
      "",
      "<!-- widths 50 50 -->",
      "| x | y |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```js",
      "code",
      "```",
      "",
    ].join("\n");
    expect(texts(doc)).toEqual([
      "# Title",
      "Para one\nstill one",
      "- a\n  - a1",
      "  - a1",
      "- b",
      "<!-- widths 50 50 -->\n| x | y |\n| - | - |\n| 1 | 2 |",
      "```js\ncode\n```",
    ]);
    const blocks = blocksOf(doc);
    expect(blocks[2].group).toBe(blocks[4].group);
    expect(blocks[3].group).not.toBe(blocks[2].group);
    expect(blockAt(blocks, doc.indexOf("a1"))?.to).toBe(blocks[3].to);
    expect(blockAt(blocks, doc.indexOf("| 1"))?.kind).toBe("Table");
  });
});

describe("moving a block", () => {
  test("a paragraph moves and keeps one blank line around it", () => {
    expect(move("A\n\nB\n\nC\n", "A", null)).toBe("B\n\nC\n\nA\n");
    expect(move("A\n\nB\n\nC\n", "C", "A")).toBe("C\n\nA\n\nB\n");
    expect(move("A\n\nB\n\nC", "B", "A")).toBe("B\n\nA\n\nC");
  });

  test("a single newline next to the moved block becomes a blank line, so nothing merges", () => {
    expect(move("# H\nPara\n\nOther\n", "Other", "Para")).toBe("# H\n\nOther\n\nPara\n");
  });

  test("moving onto its own place is not a move", () => {
    expect(move("A\n\nB\n", "A", "A")).toBeNull();
    expect(move("A\n\nB\n", "A", "B")).toBeNull();
  });

  test("a heading moves with its section and only to where a section can start", () => {
    const doc = "# One\n\nText one\n\n## Sub\n\nSub text\n\n# Two\n\nText two\n";
    expect(move(doc, "# One", null)).toBe("# Two\n\nText two\n\n# One\n\nText one\n\n## Sub\n\nSub text\n");
    expect(move(doc, "# Two", "Text one")).toBeNull();
    expect(move(doc, "# Two", "## Sub")).toBe("# One\n\nText one\n\n# Two\n\nText two\n\n## Sub\n\nSub text\n");
  });

  test("sibling numbered sections keep their numbering", () => {
    const doc = "## 1. First\n\nA\n\n## 2. Second\n\nB\n";
    expect(move(doc, "## 2.", "## 1.")).toBe("## 1. Second\n\nB\n\n## 2. First\n\nA\n");
  });

  test("a list item moves with its children among its own items; tight lists stay tight", () => {
    const doc = "- a\n  - a1\n- b\n- c\n";
    expect(move(doc, "- a", null)).toBe("- b\n- c\n- a\n  - a1\n");
    expect(move(doc, "- c", "- a")).toBe("- c\n- a\n  - a1\n- b\n");
  });

  test("a loose list stays loose", () => {
    expect(move("- a\n\n- b\n\n- c\n", "- c", "- a")).toBe("- c\n\n- a\n\n- b\n");
  });

  test("an ordered list keeps its numbers in place", () => {
    expect(move("3. a\n4. b\n5. c\n", "5. c", "3. a")).toBe("3. c\n4. a\n5. b\n");
    expect(move("1) a\n2) b\n", "1) a", null)).toBe("1) b\n2) a\n");
  });

  test("stepping skips places a section can't go", () => {
    const doc = "# One\n\nText\n\n# Two\n\nMore\n";
    const blocks = blocksOf(doc);
    const two = blocks.find((b) => doc.slice(b.from).startsWith("# Two"))!;
    const siblings = siblingsOf(blocks, two);
    expect(stepGap(siblings, -1)).toBe(0);
    expect(stepGap(siblings, 1)).toBeNull();
  });
});

describe("the + beside a block", () => {
  const insert = (doc: string, start: string) => {
    const s = state(doc);
    const blocks = blockRanges(s);
    const block = blocks.find((b) => doc.slice(b.from).startsWith(start))!;
    const ins = insertionAfter(s.doc, blocks, block);
    return { text: doc.slice(0, ins.from) + ins.insert + doc.slice(ins.from), ins };
  };

  test("a new paragraph with a slash, separated by blank lines", () => {
    expect(insert("A\n\nB\n", "A").text).toBe("A\n\n/\n\nB\n");
    expect(insert("A\n", "A").text).toBe("A\n\n/\n");
    expect(insert("A", "A").text).toBe("A\n\n/");
    expect(insert("# H\nBody\n", "# H").text).toBe("# H\n\n/\n\nBody\n");
    const { text, ins } = insert("A\n\nB\n", "A");
    expect(text.slice(ins.caret - 1, ins.caret)).toBe("/");
  });

  test("a sibling item with the list's own marker, after the item's children", () => {
    expect(insert("* a\n  * a1\n* b\n", "* a").text).toBe("* a\n  * a1\n* \n* b\n");
    expect(insert("1. a\n2. b\n", "1. a").text).toBe("1. a\n2. \n2. b\n");
    expect(insert("- [x] done\n", "- [x]").text).toBe("- [x] done\n- [ ] \n");
    expect(insert("- a\n  - a1\n", "  - a1").text).toBe("- a\n  - a1\n  - \n");
  });
});
