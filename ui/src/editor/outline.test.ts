import { expect, test } from "vitest";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { outlineNumber } from "./outline";

/** The outline number of every ordered list mark in `md`, in order (null = shown as written). */
function numbers(md: string): (string | null)[] {
  const out: (string | null)[] = [];
  markdownLanguage.parser.parse(md).iterate({
    enter: (n) => {
      if (n.name === "ListMark" && /\d/.test(md.slice(n.from, n.to))) out.push(outlineNumber(n.node as SyntaxNode, (a, b) => md.slice(a, b)));
    },
  });
  return out;
}

test("nested ordered lists number as an outline", () => {
  expect(numbers("1. One\n2. Two\n   1. Sub\n   1. Sub\n      1. Deep\n3. Three\n")).toEqual([null, null, "2.1.", "2.2.", "2.2.1.", null]);
});

test("a list's first number counts, and bullets break the chain", () => {
  expect(numbers("4. Four\n   1. Sub\n")).toEqual([null, "4.1."]);
  expect(numbers("- Bullet\n  1. Sub\n  2. Sub\n")).toEqual([null, null]);
});
