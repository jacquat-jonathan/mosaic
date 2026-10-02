import { expect, test } from "vitest";
import { parseTiming, tickStep, timingSvg } from "./timing";

const text = "**Door controller**\nDoor: Closed@0 Open@5 Closed@12\nAlarm: Off@0 On@10 Off@15\ntime: 0..20 s";

test("parses lanes, the title and the time axis", () => {
  const d = parseTiming(text);
  expect(d.title).toBe("Door controller");
  expect(d.lanes.map((l) => l.name)).toEqual(["Door", "Alarm"]);
  expect(d.lanes[0].changes).toEqual([
    { state: "Closed", at: 0 },
    { state: "Open", at: 5 },
    { state: "Closed", at: 12 },
  ]);
  expect([d.start, d.end, d.unit]).toEqual([0, 20, "s"]);
  // Without a time line, the axis runs a little past the last change.
  expect(parseTiming("A: x@0 y@10").end).toBe(12);
});

test("draws a step line per lane, one level per state", () => {
  const svg = timingSvg(text, 0, 0, 600, 300, { stroke: "#000", fg: "#111", muted: "#666", grid: "#ddd" });
  expect(svg.match(/<path /g)).toHaveLength(2);
  expect(svg).toContain(">Door controller<");
  expect(svg).toContain(">20 s<");
  expect([tickStep(20), tickStep(1), tickStep(120)]).toEqual([5, 0.2, 50]);
});
