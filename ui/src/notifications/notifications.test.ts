import { afterEach, describe, expect, test } from "vitest";
import type { AgentRun, PlannerTask, Proposal } from "../ipc/types";
import {
  deriveNotifications,
  notificationLabel,
  registerNotificationSource,
  type NotificationSnapshot,
} from "./registry";
import { registerBuiltInSources } from "./sources";

registerBuiltInSources();
const now = new Date(2026, 10, 5, 12, 0, 0);
const sec = now.getTime() / 1000;
const run = (o: Partial<AgentRun>): AgentRun => ({
  id: 1,
  agent: "digest",
  title: "Digest",
  started: sec - 120,
  finished: sec - 60,
  late: false,
  status: "done",
  answer: "",
  error: null,
  proposals: 0,
  ...o,
});
const task = (o: Partial<PlannerTask>): PlannerTask => ({
  id: "t1",
  epic_id: null,
  parent_id: null,
  title: "Write report",
  description: "",
  status: "new",
  due_date: "2026-11-06",
  estimate_minutes: null,
  position: 0,
  revision: 1,
  created_at: "",
  updated_at: "",
  completed_at: null,
  archived_at: null,
  trashed_at: null,
  ...o,
});
const proposal = (o: Partial<Proposal>): Proposal =>
  ({
    id: 7,
    path: "Notes/Plan.md",
    action: "edited",
    status: "pending",
    actor: "claude-code",
    updated: now.getTime() - 5000,
    ...o,
  }) as Proposal;
const snap = (o: Partial<NotificationSnapshot>): NotificationSnapshot => ({
  now,
  proposals: [],
  runs: [],
  tasks: [],
  ...o,
});
const kinds = (s: NotificationSnapshot) => deriveNotifications(s).map((n) => n.id);

describe("built-in sources", () => {
  test("a pending proposal needs review; decided ones don't", () => {
    expect(kinds(snap({ proposals: [proposal({}), proposal({ id: 8, status: "accepted" })] }))).toEqual([
      `review-needed:7:${now.getTime() - 5000}`,
    ]);
    const [n] = deriveNotifications(snap({ proposals: [proposal({})] }));
    expect(n.title).toBe("Plan needs review");
    expect(n.detail).toBe("claude-code edited this note.");
    expect(n.target).toEqual({ view: "activity" });
  });
  test("finished and failed runs are separate types and link to the run", () => {
    const out = deriveNotifications(
      snap({
        runs: [
          run({ id: 1 }),
          run({ id: 2, status: "failed", error: "boom" }),
          run({ id: 3, status: "running", finished: null }),
        ],
      }),
    );
    expect(out.map((n) => n.id).sort()).toEqual(["workflow-failed:2", "workflow-finished:1"]);
    const failed = out.find((n) => n.kind === "workflow-failed")!;
    expect(failed).toMatchObject({ severity: "error", detail: "boom", target: { view: "run", id: "2" } });
  });
  test("old runs age out", () => {
    const old = sec - 8 * 86_400;
    expect(
      kinds(
        snap({
          runs: [
            run({ started: old - 5, finished: old }),
            run({ id: 2, status: "failed", started: old - 5, finished: old }),
          ],
        }),
      ),
    ).toEqual([]);
  });
  test("tasks due within two days or overdue notify; later, done, archived and trashed ones don't", () => {
    const out = deriveNotifications(
      snap({
        tasks: [
          task({ id: "soon", due_date: "2026-11-07" }),
          task({ id: "today", due_date: "2026-11-05" }),
          task({ id: "late", due_date: "2026-11-01" }),
          task({ id: "far", due_date: "2026-11-08" }),
          task({ id: "done", status: "done" }),
          task({ id: "arch", archived_at: "x" }),
          task({ id: "trash", trashed_at: "x" }),
          task({ id: "none", due_date: null }),
        ],
      }),
    );
    expect(out.map((n) => n.id).sort()).toEqual([
      "task-due-soon:late:2026-11-01",
      "task-due-soon:soon:2026-11-07",
      "task-due-soon:today:2026-11-05",
    ]);
    expect(out.find((n) => n.id.includes("late"))).toMatchObject({
      severity: "error",
      title: "Write report is overdue",
    });
    expect(out.find((n) => n.id.includes("today"))?.title).toBe("Write report is due today");
  });
  test("rescheduling a task yields a new id so it can notify again", () => {
    const a = kinds(snap({ tasks: [task({ due_date: "2026-11-06" })] }));
    const b = kinds(snap({ tasks: [task({ due_date: "2026-11-07" })] }));
    expect(a).not.toEqual(b);
  });
});

describe("registry", () => {
  const offs: (() => void)[] = [];
  afterEach(() => offs.splice(0).forEach((off) => off()));
  test("a registered source contributes notifications and a label", () => {
    offs.push(
      registerNotificationSource({
        kind: "custom",
        label: "Custom thing",
        derive: () => [
          { id: "custom:1", kind: "custom", severity: "info", title: "Hello", at: 1, target: { view: "tasks" } },
        ],
      }),
    );
    expect(kinds(snap({}))).toContain("custom:1");
    expect(notificationLabel("custom")).toBe("Custom thing");
    expect(notificationLabel("unknown")).toBe("unknown");
  });
  test("a throwing source is skipped and unregistering removes it", () => {
    offs.push(
      registerNotificationSource({
        kind: "bad",
        label: "Bad",
        derive: () => {
          throw new Error("nope");
        },
      }),
    );
    const off = registerNotificationSource({
      kind: "good",
      label: "Good",
      derive: () => [{ id: "good:1", kind: "good", severity: "info", title: "ok", at: 1, target: { view: "tasks" } }],
    });
    expect(kinds(snap({ proposals: [proposal({})] }))).toContain("good:1");
    expect(kinds(snap({ proposals: [proposal({})] }))).toContain(`review-needed:7:${now.getTime() - 5000}`);
    off();
    expect(kinds(snap({}))).not.toContain("good:1");
  });
  test("newest first", () => {
    const out = deriveNotifications(
      snap({ runs: [run({ id: 1, finished: sec - 500 }), run({ id: 2, finished: sec - 10 })] }),
    );
    expect(out.map((n) => n.id)).toEqual(["workflow-finished:2", "workflow-finished:1"]);
  });
});
