import { expect, test } from "vitest";
import { addDays, counts, monthGrid, progress, startOfWeek, weekRange } from "./calendar";
import { dayStamp } from "../daily";
import type { DayTask } from "../ipc/types";

test("weeks start on Monday and a month shows 6 weeks", () => {
  expect(dayStamp(startOfWeek(new Date(2026, 9, 4)))).toBe("2026-09-28"); // a Sunday
  expect(dayStamp(startOfWeek(new Date(2026, 9, 5)))).toBe("2026-10-05"); // a Monday
  const w = weekRange(new Date(2026, 9, 7));
  expect([dayStamp(w.from), dayStamp(w.to)]).toEqual(["2026-10-05", "2026-10-11"]);
  const m = monthGrid(new Date(2026, 9, 20));
  expect([dayStamp(m.from), dayStamp(m.to)]).toEqual(["2026-09-28", "2026-11-08"]);
  // Across the end of daylight saving time (25 October 2026 in Europe).
  expect(dayStamp(addDays(new Date(2026, 9, 24), 2))).toBe("2026-10-26");
});

const task = (line: number, status: DayTask["status"], parent: number | null = null): DayTask => ({
  path: "D.md", line, status, mark: status === "done" ? "x" : " ", text: `t${line}`, depth: parent ? 1 : 0, parent, due: null, daily: true,
});

test("subtask progress and day counts", () => {
  const tasks = [task(1, "open"), task(2, "done", 1), task(3, "open", 1), task(4, "done", 3), task(5, "moved", 1), task(6, "done")];
  const p = progress(tasks);
  expect(p.get("D.md:1")).toEqual({ done: 2, total: 3 });
  expect(p.get("D.md:3")).toEqual({ done: 1, total: 1 });
  expect(p.has("D.md:6")).toBe(false);
  expect(counts(tasks)).toEqual({ open: 2, done: 3 });
});
