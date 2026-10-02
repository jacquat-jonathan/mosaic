import { describe, expect, it } from "vitest";
import { rangeBetween, remapPath, topLevel, useVault } from "./vault";
import { canMoveInto } from "../actions";
import { reorder } from "../views/BookmarksPanel";

describe("tree selection", () => {
  const order = ["A", "A/x.md", "A/y.md", "B.md", "C.md"];

  it("selects a range in either direction", () => {
    expect(rangeBetween(order, "A/x.md", "B.md")).toEqual(["A/x.md", "A/y.md", "B.md"]);
    expect(rangeBetween(order, "C.md", "A/y.md")).toEqual(["A/y.md", "B.md", "C.md"]);
  });

  it("falls back to the clicked item without a visible anchor", () => {
    expect(rangeBetween(order, null, "B.md")).toEqual(["B.md"]);
    expect(rangeBetween(order, "Gone.md", "B.md")).toEqual(["B.md"]);
  });

  it("moves a folder once, not also its selected contents", () => {
    expect(topLevel(["A", "A/x.md", "B.md", "A/sub/z.md"])).toEqual(["A", "B.md"]);
    expect(topLevel(["AB/x.md", "A"])).toEqual(["AB/x.md", "A"]);
  });
});

describe("moves and bookmarks", () => {
  it("remaps paths through a rename or folder move", () => {
    expect(remapPath("A/x.md", "A", "Z/A")).toBe("Z/A/x.md");
    expect(remapPath("A", "A", "B")).toBe("B");
    expect(remapPath("AB/x.md", "A", "B")).toBe("AB/x.md");
  });

  it("refuses moves that go nowhere or into the item itself", () => {
    expect(canMoveInto("A/x.md", "A")).toBe(false);
    expect(canMoveInto("A", "A/sub")).toBe(false);
    expect(canMoveInto("A", "A")).toBe(false);
    expect(canMoveInto("A/x.md", "")).toBe(true);
    expect(canMoveInto("A", "B")).toBe(true);
  });

  it("reorders bookmarks", () => {
    expect(reorder(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
    expect(reorder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(reorder(["a", "b", "c"], 0, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("keyboard selection", () => {
  const order = ["A", "A/x.md", "A/y.md", "B.md", "C.md"];
  const v = () => useVault.getState();
  const selected = () => [...v().selected].sort();

  it("⇧↓ and ⇧↑ grow and shrink the selection from the anchor", () => {
    v().select("A/x.md", "single");
    v().step(1, true, order);
    v().step(1, true, order);
    expect(selected()).toEqual(["A/x.md", "A/y.md", "B.md"]);
    v().step(-1, true, order);
    expect(selected()).toEqual(["A/x.md", "A/y.md"]);
    // Past the anchor, it grows the other way.
    v().step(-1, true, order);
    v().step(-1, true, order);
    expect(selected()).toEqual(["A", "A/x.md"]);
  });

  it("a plain arrow moves a single selection from the cursor", () => {
    v().select("A/x.md", "single");
    v().step(1, true, order);
    v().step(1, false, order);
    expect(selected()).toEqual(["B.md"]);
    v().step(1, false, order);
    v().step(1, false, order);
    expect(selected()).toEqual(["C.md"]); // stops at the end
  });

  it("⇧-click then ⇧-arrow continues from where the click ended", () => {
    v().select("A", "single");
    v().select("A/y.md", "range", order);
    v().step(1, true, order);
    expect(selected()).toEqual(["A", "A/x.md", "A/y.md", "B.md"]);
  });
});
