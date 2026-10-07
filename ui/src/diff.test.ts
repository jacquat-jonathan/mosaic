import { expect, test } from "vitest";
import { acceptHunks, reviewHunks } from "./diff";

test("accepts line changes one hunk at a time", () => {
  const current = "one\nold\nmiddle\nremove\nend\n";
  const proposed = "one\nnew\nmiddle\nend\nextra\n";
  const lines = reviewHunks(current, proposed);
  expect([...new Set(lines.flatMap(l => l.hunk == null ? [] : [l.hunk]))]).toEqual([0, 1, 2]);
  expect(acceptHunks(current, proposed, new Set([0]))).toBe("one\nnew\nmiddle\nremove\nend\n");
  expect(acceptHunks(current, proposed, new Set([1, 2]))).toBe("one\nold\nmiddle\nend\nextra\n");
});
