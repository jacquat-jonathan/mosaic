import { expect, test } from "vitest";
import { midpoint, roundedPath, routeAround, simplify, type Box, type Pt } from "./route";

const crosses = (pts: Pt[], o: Box) =>
  pts.slice(1).some((q, i) => {
    const p = pts[i];
    // Sample each segment.
    for (let t = 0; t <= 1; t += 0.05) {
      const x = p.x + (q.x - p.x) * t;
      const y = p.y + (q.y - p.y) * t;
      if (x > o.x && x < o.x + o.width && y > o.y && y < o.y + o.height) return true;
    }
    return false;
  });

test("goes around a card in the way, with only straight segments", () => {
  const wall: Box = { x: 150, y: -100, width: 100, height: 300 };
  const pts = routeAround({ x: 0, y: 50 }, { x: 1, y: 0 }, { x: 400, y: 50 }, { x: -1, y: 0 }, [wall]);
  expect(crosses(pts, wall)).toBe(false);
  for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
  expect(pts[0]).toEqual({ x: 0, y: 50 });
  expect(pts[pts.length - 1]).toEqual({ x: 400, y: 50 });
});

test("a clear line stays straight", () => {
  const pts = routeAround({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 300, y: 0 }, { x: -1, y: 0 }, []);
  expect(pts).toEqual([
    { x: 0, y: 0 },
    { x: 300, y: 0 },
  ]);
});

test("helpers: simplify, rounded corners, midpoint", () => {
  expect(simplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }])).toEqual([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
  ]);
  expect(roundedPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }])).toBe("M0,0 L12,0 Q20,0 20,8 L20,20");
  expect(midpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual({ x: 10, y: 0 });
});
