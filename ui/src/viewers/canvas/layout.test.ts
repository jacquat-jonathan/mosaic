import { expect, test } from "vitest";
import { autoLayout } from "./layout";

const box = (id: string, x = 0, y = 0) => ({ id, x, y, width: 100, height: 50 });

test("top-down: each connection goes down a rank, keeping the selection's corner", () => {
  const pos = autoLayout([box("a", 500, 300), box("b", 0, 0), box("c", 900, 900)], [{ from: "a", to: "b" }, { from: "b", to: "c" }], "TB");
  const [a, b, c] = ["a", "b", "c"].map((id) => pos.get(id)!);
  expect(a.y).toBeLessThan(b.y);
  expect(b.y).toBeLessThan(c.y);
  expect(Math.min(a.x, b.x, c.x)).toBe(0);
  expect(Math.min(a.y, b.y, c.y)).toBe(0);
});

test("left-right ranks go across", () => {
  const pos = autoLayout([box("a"), box("b")], [{ from: "a", to: "b" }], "LR");
  expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
  expect(pos.get("a")!.y).toBe(pos.get("b")!.y);
});

test("connections to cards outside the selection are ignored", () => {
  const pos = autoLayout([box("a"), box("b")], [{ from: "a", to: "zzz" }], "TB");
  expect(pos.size).toBe(2);
});
