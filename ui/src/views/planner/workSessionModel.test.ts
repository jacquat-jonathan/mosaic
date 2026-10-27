import { expect, test } from "vitest";
import type { PlannerWorkSession } from "../../ipc/types";
import { workSessionDraft, workSessionError, workSessionUpdate } from "./workSessionModel";

const session = (overrides: Partial<PlannerWorkSession> = {}): PlannerWorkSession => ({
  id: "session-1",
  task_id: "task-1",
  all_day: false,
  start_value: "2026-10-27T08:07:00Z",
  end_value: "2026-10-27T09:43:00Z",
  timezone: "Europe/Zurich",
  state: "planned",
  revision: 3,
  created_at: "",
  updated_at: "",
  ...overrides,
});

test("work-session editing preserves exact non-quarter-hour values", () => {
  const original = session(),
    draft = workSessionDraft(original);
  expect(draft).toMatchObject({ day: "2026-10-27", startTime: "09:07", endTime: "10:43" });
  expect(workSessionError(draft, original.timezone)).toBeNull();
  expect(workSessionUpdate(original, draft)).toMatchObject({
    expected_revision: 3,
    start_value: "2026-10-27T08:07:00.000Z",
    end_value: "2026-10-27T09:43:00.000Z",
  });
});

test("all-day work sessions use an exclusive next-day end", () => {
  const original = session({ all_day: true, start_value: "2026-10-27", end_value: "2026-10-28" }),
    draft = workSessionDraft(original);
  expect(workSessionUpdate(original, draft)).toMatchObject({
    all_day: true,
    start_value: "2026-10-27",
    end_value: "2026-10-28",
  });
});

test("work sessions reject reversed exact times", () => {
  expect(workSessionError({ day: "2026-10-27", startTime: "10:01", endTime: "10:00", allDay: false }, "UTC")).toBe(
    "End time must be after start time.",
  );
});
