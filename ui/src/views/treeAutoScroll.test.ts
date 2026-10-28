import { describe, expect, it } from "vitest";
import { treeAutoScrollStep } from "./treeAutoScroll";

describe("file tree drag auto-scroll", () => {
  it("scrolls up and down progressively inside the edge zones", () => {
    expect(treeAutoScrollStep(100, 100, 500)).toBe(-14);
    expect(treeAutoScrollStep(124, 100, 500)).toBe(-7);
    expect(treeAutoScrollStep(476, 100, 500)).toBe(7);
    expect(treeAutoScrollStep(500, 100, 500)).toBe(14);
  });

  it("does not scroll away from the edges", () => {
    expect(treeAutoScrollStep(148, 100, 500)).toBe(0);
    expect(treeAutoScrollStep(300, 100, 500)).toBe(0);
    expect(treeAutoScrollStep(452, 100, 500)).toBe(0);
  });

  it("stays bounded for pointers beyond the container and for short trees", () => {
    expect(treeAutoScrollStep(-100, 100, 500)).toBe(-14);
    expect(treeAutoScrollStep(900, 100, 500)).toBe(14);
    expect(treeAutoScrollStep(115, 100, 130)).toBe(0);
    expect(treeAutoScrollStep(100, 100, 100)).toBe(0);
  });
});
