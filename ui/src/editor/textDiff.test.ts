import { expect, test } from "vitest";
import { textChanges, type TextChange } from "./textDiff";

function apply(a: string, changes: TextChange[]) {
  let out = "";
  let at = 0;
  for (const c of changes) {
    expect(c.from).toBeGreaterThanOrEqual(at);
    out += a.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + a.slice(at);
}

const cases: [string, string, string][] = [
  ["identical", "a\nb\n", "a\nb\n"],
  ["empty to text", "", "hello\n"],
  ["text to empty", "hello\n", ""],
  ["one word", "# Title\n\nSome text here.\n", "# Title\n\nSome other text here.\n"],
  ["edits far apart", "a\nb\nc\nd\ne\nf\n", "A\nb\nc\nd\ne\nF\n"],
  ["line inserted", "a\nb\nc\n", "a\nb\nnew\nc\n"],
  ["line removed", "a\nb\nc\n", "a\nc\n"],
  ["no trailing newline", "a\nb", "a\nb\nc"],
  ["emoji", "x 😀 y\n", "x 😃 y\n"],
  ["moved line", "1\n2\n3\n4\n", "2\n3\n1\n4\n"],
];

test.each(cases)("%s: the changes turn the old text into the new one", (_, a, b) => {
  expect(apply(a, textChanges(a, b))).toBe(b);
});

test("separate edits stay separate and touch only what changed", () => {
  const a = "first line\nmiddle\nmiddle\nmiddle\nlast line\n";
  const b = "First line\nmiddle\nmiddle\nmiddle\nlast line!\n";
  expect(textChanges(a, b)).toEqual([
    { from: 0, to: 1, insert: "F" },
    { from: a.length - 1, to: a.length - 1, insert: "!" },
  ]);
});

test("identical text needs no changes", () => {
  expect(textChanges("same\n", "same\n")).toEqual([]);
});

test("a surrogate pair is never split", () => {
  const [change] = textChanges("😀", "😃");
  expect(change).toEqual({ from: 0, to: 2, insert: "😃" });
});

test("a huge rewrite still produces a correct (single) change", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join("");
  const b = Array.from({ length: 3000 }, (_, i) => `row ${i}\n`).join("");
  expect(apply(a, textChanges(a, b))).toBe(b);
});

test("an edit inside a line changes only the words that changed", () => {
  const a = "- item mine\n";
  const b = "- the item mine, theirs\n";
  const changes = textChanges(a, b);
  expect(apply(a, changes)).toBe(b);
  // " mine" (positions 6–11) is untouched.
  expect(changes.every((c) => c.to <= 6 || c.from >= 11)).toBe(true);
});
