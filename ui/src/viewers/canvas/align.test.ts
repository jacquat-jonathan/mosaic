import { expect, test } from "vitest";
import { align } from "./align";

const other = { x: 100, y: 100, width: 200, height: 100 };

test("snaps left edges and centres within the threshold", () => {
  expect(align({ x: 104, y: 400, width: 200, height: 50 }, [other])).toEqual({ x: 100, y: 400, guideX: 100, guideY: undefined });
  // Centre 198 → 200 (the other card's centre).
  expect(align({ x: 148, y: 400, width: 100, height: 50 }, [other])).toMatchObject({ x: 150, guideX: 200 });
});

test("snaps vertically too, independently", () => {
  expect(align({ x: 600, y: 197, width: 80, height: 40 }, [other])).toMatchObject({ x: 600, y: 200, guideY: 200 });
});

test("leaves the card alone when nothing is close", () => {
  expect(align({ x: 500, y: 500, width: 80, height: 40 }, [other])).toEqual({ x: 500, y: 500, guideX: undefined, guideY: undefined });
});

test("picks the closest line", () => {
  const near = { x: 0, y: 0, width: 10, height: 10 };
  expect(align({ x: 103, y: 600, width: 10, height: 10 }, [other, { ...near, x: 101 }])).toMatchObject({ x: 101, guideX: 101 });
});
